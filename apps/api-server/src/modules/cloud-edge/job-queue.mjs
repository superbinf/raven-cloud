import { randomBytes } from "node:crypto";

export const SNAPSHOT_TASK = "build_edge_snapshot";

function identifier() {
  return `SNAPJOB-${randomBytes(8).toString("hex").toUpperCase()}`;
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error || "快照生成失败");
}

function permanentFailure(error) {
  if (error?.retryable === false) return true;
  const status = Number(error?.statusCode || 0);
  return status >= 400 && status < 500;
}

export async function createSnapshotJobQueue({ db, repository, outbox, logger = console }) {

  async function enqueue(deploymentId, { force = false, triggerType = "manual" } = {}) {
    const now = new Date().toISOString();
    const deployment = await repository.getDeployment(deploymentId);
    if (!deployment) throw Object.assign(new Error("地端实例不存在"), { statusCode: 404, retryable: false });
    const existing = await repository.activeSnapshotJob(deploymentId);
    if (existing) {
      const job = force && !existing.force ? await repository.forceSnapshotJob(existing.id, now) : existing;
      return { job, deduplicated: true };
    }

    const operationId = identifier();
    try {
      await db.transaction(async () => {
        await repository.createSnapshotJob({ id: operationId, deploymentId, force, triggerType, requestedAt: now });
        await outbox.enqueue({
          jobKey: `${SNAPSHOT_TASK}:${operationId}`,
          role: "snapshot",
          taskIdentifier: SNAPSHOT_TASK,
          payload: { operationId, tenantId: deployment.tenantId },
          maxAttempts: 5,
          aggregateType: "snapshot_job",
          aggregateId: operationId,
          tenantId: deployment.tenantId
        });
      });
    } catch (error) {
      if (error?.code !== "23505") throw error;
      const active = await repository.activeSnapshotJob(deploymentId);
      if (!active) throw error;
      const job = force && !active.force ? await repository.forceSnapshotJob(active.id, now) : active;
      return { job, deduplicated: true };
    }

    return { job: await repository.getSnapshotJob(operationId), deduplicated: false };
  }

  async function enqueueEnabled() {
    const deploymentIds = await repository.listDueSnapshotDeploymentIds(new Date().toISOString());
    for (const deploymentId of deploymentIds) {
      try { await enqueue(deploymentId, { triggerType: "schedule" }); }
      catch (error) { logger.error(`无法调度地端快照 ${deploymentId}`, error); }
    }
  }

  return {
    enqueue,
    enqueueEnabled,
    release: async () => {}
  };
}

export function createSnapshotTaskList({ repository, service }) {
  return {
    [SNAPSHOT_TASK]: async (payload, helpers) => {
      const operationId = String(payload?.operationId || "");
      const operation = await repository.getSnapshotJob(operationId);
      if (!operation || ["succeeded", "failed"].includes(operation.status)) return;
      const attempt = Number(helpers.attempt || 1);
      await repository.startSnapshotJob(operationId, attempt, new Date().toISOString());
      try {
        const current = await repository.getSnapshotJob(operationId);
        const result = await service.buildSnapshot(current.deploymentId, { force: current.force, operationId });
        await repository.completeSnapshotJob(operationId, result, attempt, new Date().toISOString());
        return result;
      } catch (error) {
        const message = messageOf(error);
        const finalAttempt = attempt >= Number(helpers.maxAttempts || 1);
        if (permanentFailure(error) || finalAttempt) {
          await repository.failSnapshotJob(operationId, attempt, message, new Date().toISOString());
          if (permanentFailure(error) && error && typeof error === "object") error.retryable = false;
        } else {
          await repository.retrySnapshotJob(operationId, attempt, message, new Date().toISOString());
        }
        throw error;
      }
    }
  };
}
