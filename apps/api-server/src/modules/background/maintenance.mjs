export const MAINTENANCE_TASKS = Object.freeze({
  sessions: "cleanup_expired_sessions",
  snapshots: "cleanup_expired_snapshots",
  history: "cleanup_business_task_history",
  queueHistory: "cleanup_bullmq_history"
});

export function createMaintenanceTaskList({ db, localStorage, objectStorage, queueCleanup, logger = console }) {
  return {
    [MAINTENANCE_TASKS.sessions]: async () => {
      const result = await db.prepare("DELETE FROM sessions WHERE expires_at<=?").run(new Date().toISOString());
      logger.info?.(`已清理 ${result.changes} 个过期会话`);
    },
    [MAINTENANCE_TASKS.snapshots]: async () => {
      const now = new Date().toISOString();
      const candidates = await db.prepare(`SELECT snapshot.* FROM edge_snapshots snapshot
        WHERE snapshot.status='published' AND snapshot.expires_at IS NOT NULL AND snapshot.expires_at<=?
          AND snapshot.version<>(SELECT MAX(latest.version) FROM edge_snapshots latest WHERE latest.deployment_id=snapshot.deployment_id AND latest.status='published')
          AND snapshot.version<>COALESCE((SELECT deployment.last_applied_snapshot_version FROM edge_deployments deployment WHERE deployment.id=snapshot.deployment_id),-1)
          AND snapshot.version NOT IN (SELECT kept.version FROM edge_snapshots kept WHERE kept.deployment_id=snapshot.deployment_id AND kept.status='published' ORDER BY kept.version DESC LIMIT 2)`)
        .all(now);
      let expired = 0;
      for (const row of candidates) {
        const snapshot = { deploymentId: row.deployment_id, version: Number(row.version), contentPath: row.content_path, objectKey: row.object_key };
        if (row.object_key && objectStorage) await objectStorage.deleteSnapshot(snapshot);
        else if (localStorage) await localStorage.deleteSnapshot(snapshot);
        await db.prepare("UPDATE edge_snapshots SET status='expired',content_path=NULL,object_key=NULL WHERE id=? AND status='published'").run(row.id);
        expired += 1;
      }
      const staleCutoff = new Date(Date.now() - 24 * 86_400_000).toISOString();
      const stale = await db.prepare("SELECT * FROM edge_snapshots WHERE status IN ('building','failed') AND created_at<?").all(staleCutoff);
      for (const row of stale) {
        const snapshot = { deploymentId: row.deployment_id, version: Number(row.version), contentPath: row.content_path, objectKey: row.object_key };
        if (row.object_key && objectStorage) await objectStorage.deleteSnapshot(snapshot);
        else if (localStorage) await localStorage.deleteSnapshot(snapshot);
        await db.prepare("DELETE FROM edge_snapshots WHERE id=? AND status IN ('building','failed')").run(row.id);
      }
      logger.info?.(`已过期 ${expired} 个历史快照，清理 ${stale.length} 个残留快照`);
    },
    [MAINTENANCE_TASKS.history]: async () => {
      const now = Date.now();
      const successCutoff = new Date(now - 30 * 86_400_000).toISOString();
      const failureCutoff = new Date(now - 90 * 86_400_000).toISOString();
      const collection = await db.prepare(`DELETE FROM collection_runs current
        WHERE ((status='成功' AND updated_at<?) OR (status='失败' AND updated_at<?))
          AND EXISTS (SELECT 1 FROM collection_runs newer WHERE newer.job_id=current.job_id AND newer.updated_at>current.updated_at AND newer.status IN ('成功','失败'))`)
        .run(successCutoff, failureCutoff);
      const snapshots = await db.prepare(`DELETE FROM edge_snapshot_jobs current
        WHERE ((status='succeeded' AND updated_at<?) OR (status='failed' AND updated_at<?))
          AND EXISTS (SELECT 1 FROM edge_snapshot_jobs newer WHERE newer.deployment_id=current.deployment_id AND newer.updated_at>current.updated_at AND newer.status IN ('succeeded','failed'))`)
        .run(successCutoff, failureCutoff);
      const attempts = await db.prepare(`WITH latest AS (
          SELECT DISTINCT ON (bullmq_job_id) bullmq_job_id,status,will_retry,finished_at
          FROM background_task_runs ORDER BY bullmq_job_id,attempt DESC,id DESC
        ) DELETE FROM background_task_runs attempt USING latest
        WHERE attempt.bullmq_job_id=latest.bullmq_job_id AND (
          (latest.status='succeeded' AND latest.finished_at<?) OR
          (latest.status='failed' AND COALESCE(latest.will_retry,FALSE)=FALSE AND latest.finished_at<?)
        )`).run(successCutoff, failureCutoff);
      const outbox = await db.prepare(`DELETE FROM background_task_outbox outbox
        WHERE status='published' AND created_at<? AND NOT EXISTS (
          SELECT 1 FROM collection_runs run WHERE outbox.aggregate_type='collection_run' AND run.id=outbox.aggregate_id AND run.status IN ('排队中','运行中','重试中')
        ) AND NOT EXISTS (
          SELECT 1 FROM edge_snapshot_jobs job WHERE outbox.aggregate_type='snapshot_job' AND job.id=outbox.aggregate_id AND job.status IN ('queued','running','retrying')
        )`).run(failureCutoff);
      logger.info?.(`已清理 ${collection.changes + snapshots.changes} 条业务任务、${attempts.changes} 条执行尝试和 ${outbox.changes} 条 outbox 历史`);
    },
    [MAINTENANCE_TASKS.queueHistory]: async () => {
      const result = await queueCleanup?.();
      logger.info?.(`BullMQ 队列历史清理完成${result ? `：${JSON.stringify(result)}` : ""}`);
    }
  };
}
