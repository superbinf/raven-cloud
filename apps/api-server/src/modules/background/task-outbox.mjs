import { createHash } from "node:crypto";

function bullJobId(jobKey) {
  return `outbox-${createHash("sha256").update(jobKey).digest("hex").slice(0, 32)}`;
}

export function createTaskOutbox({ db, runtime, logger = console }) {
  async function enqueue({ jobKey, role, taskIdentifier, payload = {}, maxAttempts = 3, aggregateType = null, aggregateId = null, tenantId = null }) {
    const now = new Date().toISOString();
    await db.prepare(`INSERT INTO background_task_outbox
      (job_key,queue_role,task_identifier,payload_json,max_attempts,aggregate_type,aggregate_id,tenant_id,status,available_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(job_key) DO NOTHING`)
      .run(jobKey, role, taskIdentifier, JSON.stringify(payload), maxAttempts, aggregateType, aggregateId, tenantId, "pending", now, now, now);
    return { jobKey };
  }

  async function attachAggregate(row, jobId, now) {
    if (row.aggregate_type === "collection_run") {
      await db.prepare("UPDATE collection_runs SET bullmq_job_id=?,updated_at=? WHERE id=?").run(jobId, now, row.aggregate_id);
    } else if (row.aggregate_type === "snapshot_job") {
      await db.prepare("UPDATE edge_snapshot_jobs SET bullmq_job_id=?,updated_at=? WHERE id=?").run(jobId, now, row.aggregate_id);
    }
  }

  async function dispatchPending(limit = 100) {
    const rows = await db.prepare(`SELECT * FROM background_task_outbox
      WHERE status='pending' AND available_at<=? ORDER BY id LIMIT ?`).all(new Date().toISOString(), limit);
    let published = 0;
    for (const row of rows) {
      const jobId = bullJobId(row.job_key);
      try {
        const job = await runtime.add(row.queue_role, row.task_identifier, JSON.parse(row.payload_json), {
          jobId,
          attempts: Number(row.max_attempts),
          backoff: { type: "exponential", delay: 1_000 }
        });
        const now = new Date().toISOString();
        await db.transaction(async () => {
          await db.prepare(`UPDATE background_task_outbox SET status='published',bullmq_job_id=?,published_at=?,updated_at=?,last_error=NULL
            WHERE id=? AND status='pending'`).run(String(job.id), now, now, row.id);
          await attachAggregate(row, String(job.id), now);
        });
        published += 1;
      } catch (error) {
        const now = new Date();
        const retryAt = new Date(now.getTime() + 2_000).toISOString();
        await db.prepare("UPDATE background_task_outbox SET available_at=?,updated_at=?,last_error=? WHERE id=? AND status='pending'")
          .run(retryAt, now.toISOString(), error instanceof Error ? error.message : String(error), row.id);
        logger.error?.(`BullMQ outbox 投递失败：${row.job_key}`, error);
      }
    }
    return published;
  }

  async function recoverMissing(limit = 100) {
    const rows = await db.prepare(`SELECT outbox.* FROM background_task_outbox outbox
      WHERE outbox.status='published' AND (
        (outbox.aggregate_type='collection_run' AND EXISTS (
          SELECT 1 FROM collection_runs run WHERE run.id=outbox.aggregate_id AND run.status IN ('排队中','运行中','重试中')
        )) OR
        (outbox.aggregate_type='snapshot_job' AND EXISTS (
          SELECT 1 FROM edge_snapshot_jobs job WHERE job.id=outbox.aggregate_id AND job.status IN ('queued','running','retrying')
        ))
      ) ORDER BY outbox.id LIMIT ?`).all(limit);
    let recovered = 0;
    for (const row of rows) {
      const queue = runtime.queue(row.queue_role);
      const jobId = row.bullmq_job_id || bullJobId(row.job_key);
      if (await queue.getJob(jobId)) continue;
      await runtime.add(row.queue_role, row.task_identifier, JSON.parse(row.payload_json), {
        jobId,
        attempts: Number(row.max_attempts),
        backoff: { type: "exponential", delay: 1_000 }
      });
      recovered += 1;
      logger.warn?.(`已恢复缺失的 BullMQ 任务：${row.job_key}`);
    }
    return recovered;
  }

  function startDispatcher({ intervalMs = 500 } = {}) {
    let active = true;
    let running = false;
    let ticks = 0;
    const tick = async () => {
      if (!active || running) return;
      running = true;
      try {
        await dispatchPending();
        if (ticks++ % 60 === 0) await recoverMissing();
      }
      catch (error) { logger.error?.("BullMQ outbox 扫描失败", error); }
      finally { running = false; }
    };
    void tick();
    const timer = setInterval(() => void tick(), intervalMs);
    timer.unref?.();
    return async () => {
      active = false;
      clearInterval(timer);
      while (running) await new Promise((resolve) => setTimeout(resolve, 10));
    };
  }

  return { enqueue, dispatchPending, recoverMissing, startDispatcher };
}
