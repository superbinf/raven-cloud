import { randomBytes } from "node:crypto";

export const COLLECTION_TASK = "execute_collection_job";

function id(prefix) {
  return `${prefix}-${randomBytes(8).toString("hex").toUpperCase()}`;
}

function messageOf(error) {
  return error?.name === "AbortError" ? "上游接口请求超时" : error instanceof Error ? error.message : String(error || "采集失败");
}

function permanentFailure(error) {
  const status = Number(error?.statusCode || 0);
  return status >= 400 && status < 500 && ![408, 425, 429].includes(status);
}

function nextScheduledAt(scheduledFor, intervalMinutes, now = Date.now()) {
  const intervalMs = Number(intervalMinutes) * 60_000;
  let next = new Date(scheduledFor).getTime() + intervalMs;
  if (!Number.isFinite(next)) next = now + intervalMs;
  if (next <= now) next += Math.ceil((now - next + 1) / intervalMs) * intervalMs;
  return new Date(next).toISOString();
}

export function parseCollectionRun(row) {
  if (!row) return row;
  const failed = ["失败", "重试中"].includes(row.status);
  return {
    id: row.id,
    jobId: row.job_id,
    connectionId: row.connection_id,
    triggerType: row.trigger_type,
    status: row.status,
    attempt: Number(row.attempt || 0),
    bullmqJobId: row.bullmq_job_id,
    scheduledFor: row.scheduled_for,
    requestedAt: row.requested_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    updatedAt: row.updated_at,
    message: failed ? "任务执行失败，请检查配置后重试" : row.message,
    result: !failed && row.result_json ? JSON.parse(row.result_json) : null
  };
}

export function createCollectionJobQueue({ db, outbox, syncConnection }) {

  async function activeRun(jobId) {
    return parseCollectionRun(await db.prepare("SELECT * FROM collection_runs WHERE job_id=? AND status IN ('排队中','运行中','重试中') ORDER BY requested_at DESC LIMIT 1").get(jobId));
  }

  async function requestRun(jobId, { triggerType = "manual", scheduledFor = null } = {}) {
    try {
      return await db.transaction(async () => {
        const job = await db.prepare(`SELECT collection_jobs.*,api_connections.tenant_id
          FROM collection_jobs JOIN api_connections ON api_connections.id=collection_jobs.connection_id
          WHERE collection_jobs.id=? FOR UPDATE OF collection_jobs`).get(jobId);
        if (!job) return null;

        if (triggerType === "schedule") {
          const claimed = await db.prepare("UPDATE collection_jobs SET next_run_at=?,updated_at=? WHERE id=? AND enabled=1 AND next_run_at=?")
            .run(nextScheduledAt(scheduledFor, job.interval_minutes), new Date().toISOString(), job.id, scheduledFor);
          if (!claimed.changes) return { skipped: true };
        }

        const existing = await activeRun(job.id);
        if (existing) return { run: existing, deduplicated: true };

        const now = new Date().toISOString();
        const runId = id("RUN");
        await db.prepare(`INSERT INTO collection_runs
          (id,job_id,connection_id,trigger_type,status,attempt,scheduled_for,requested_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?)`)
          .run(runId, job.id, job.connection_id, triggerType, "排队中", 0, scheduledFor, now, now);
        await outbox.enqueue({
          jobKey: `${COLLECTION_TASK}:${runId}`,
          role: "io",
          taskIdentifier: COLLECTION_TASK,
          payload: { runId, triggerType, tenantId: job.tenant_id },
          maxAttempts: Number(job.retry_limit) + 1,
          aggregateType: "collection_run",
          aggregateId: runId,
          tenantId: job.tenant_id
        });
        return { run: parseCollectionRun(await db.prepare("SELECT * FROM collection_runs WHERE id=?").get(runId)), deduplicated: false };
      });
    } catch (error) {
      if (error?.code !== "23505") throw error;
      const existing = await activeRun(jobId);
      if (!existing) throw error;
      return { run: existing, deduplicated: true };
    }
  }

  async function requestConnectionSync(connectionId) {
    let job = await db.prepare("SELECT * FROM collection_jobs WHERE connection_id=?").get(connectionId);
    if (!job) {
      const connection = await db.prepare("SELECT id,name FROM api_connections WHERE id=?").get(connectionId);
      if (!connection) return null;
      const now = new Date().toISOString();
      try {
        await db.prepare(`INSERT INTO collection_jobs
          (id,connection_id,name,enabled,interval_minutes,timeout_seconds,retry_limit,next_run_at,last_status,created_at,updated_at,system_managed)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(id("JOB"), connection.id, `${connection.name} 手工采集`, 0, 60, 60, 2, null, "从未运行", now, now, 1);
      } catch (error) { if (error?.code !== "23505") throw error; }
      job = await db.prepare("SELECT * FROM collection_jobs WHERE connection_id=?").get(connectionId);
    }
    return requestRun(job.id, { triggerType: "manual" });
  }

  async function dispatchDue(limit = 50) {
    const due = await db.prepare("SELECT id,next_run_at FROM collection_jobs WHERE enabled=1 AND next_run_at IS NOT NULL AND next_run_at<=? ORDER BY next_run_at LIMIT ?")
      .all(new Date().toISOString(), limit);
    const results = [];
    for (const job of due) results.push(await requestRun(job.id, { triggerType: "schedule", scheduledFor: job.next_run_at }));
    return results.filter((result) => result && !result.skipped);
  }

  const taskList = {
    [COLLECTION_TASK]: async (payload, helpers) => {
      const runId = String(payload?.runId || "");
      const run = await db.prepare("SELECT * FROM collection_runs WHERE id=?").get(runId);
      if (!run || ["成功", "失败"].includes(run.status)) return;
      const attempt = Number(helpers.attempt || 1);
      const now = new Date().toISOString();
      const job = await db.prepare("SELECT * FROM collection_jobs WHERE id=?").get(run.job_id);
      const connection = await db.prepare("SELECT * FROM api_connections WHERE id=?").get(run.connection_id);
      if (!job || !connection) {
        await db.prepare("UPDATE collection_runs SET status='失败',attempt=?,finished_at=?,updated_at=?,message=? WHERE id=?")
          .run(attempt, now, now, "采集任务或连接器已删除", runId);
        return;
      }
      connection.timeout_ms = Number(job.timeout_seconds) * 1000;
      await db.prepare("UPDATE collection_runs SET status='运行中',attempt=?,started_at=COALESCE(started_at,?),updated_at=?,message=NULL WHERE id=?")
        .run(attempt, now, now, runId);
      try {
        await db.transaction(async () => {
          const result = await syncConnection(connection);
          const finishedAt = new Date().toISOString();
          await db.prepare("UPDATE collection_runs SET status='成功',attempt=?,finished_at=?,updated_at=?,message=?,result_json=? WHERE id=?")
            .run(attempt, finishedAt, finishedAt, result.message, JSON.stringify(result), runId);
          await db.prepare("UPDATE collection_jobs SET last_run_at=?,last_status='成功',last_message=?,updated_at=? WHERE id=?")
            .run(finishedAt, result.message, finishedAt, job.id);
          await db.prepare("UPDATE api_connections SET status='正常',success_rate=100,last_called='刚刚',last_test_message=?,last_test_at=?,last_sync_at=?,consecutive_failures=0 WHERE id=?")
            .run(result.message, finishedAt, finishedAt, connection.id);
        });
      } catch (error) {
        const failedAt = new Date().toISOString();
        const message = messageOf(error);
        const finalAttempt = attempt >= Number(helpers.maxAttempts || 1);
        if (permanentFailure(error) || finalAttempt) {
          await db.transaction(async () => {
            await db.prepare("UPDATE collection_runs SET status='失败',attempt=?,finished_at=?,updated_at=?,message=? WHERE id=?")
              .run(attempt, failedAt, failedAt, message, runId);
            await db.prepare("UPDATE collection_jobs SET last_run_at=?,last_status='失败',last_message=?,updated_at=? WHERE id=?")
              .run(failedAt, message, failedAt, job.id);
            await db.prepare("UPDATE api_connections SET status='异常',success_rate=0,last_called='刚刚',last_test_message=?,last_test_at=?,consecutive_failures=consecutive_failures+1 WHERE id=?")
              .run(message, failedAt, connection.id);
          });
          if (permanentFailure(error)) error.retryable = false;
        } else {
          await db.prepare("UPDATE collection_runs SET status='重试中',attempt=?,updated_at=?,message=? WHERE id=?")
            .run(attempt, failedAt, message, runId);
        }
        throw error;
      }
    }
  };

  return { taskList, requestRun, requestConnectionSync, dispatchDue, activeRun };
}
