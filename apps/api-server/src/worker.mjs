import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "bullmq";
import { assertEncryptedHttpUrl } from "@sentinel/transport-security";
import { createSecretCodec } from "./app/secret-codec.mjs";
import { closeDatabase, db, migrate } from "./database.mjs";
import { createBullmqRuntime, QUEUE_NAMES } from "./modules/background/bullmq-runtime.mjs";
import { createMaintenanceTaskList } from "./modules/background/maintenance.mjs";
import { createBackgroundScheduleService } from "./modules/background/schedule-service.mjs";
import { createSchedulerTaskList, mergeTaskLists } from "./modules/background/task-registry.mjs";
import { createTaskOutbox } from "./modules/background/task-outbox.mjs";
import { createCloudEdgeModule } from "./modules/cloud-edge/index.mjs";
import { createSnapshotJobQueue, createSnapshotTaskList } from "./modules/cloud-edge/job-queue.mjs";
import { createCloudEdgeRepository } from "./modules/cloud-edge/repository.mjs";
import { createCollectionJobQueue } from "./modules/collection/job-queue.mjs";
import { createConnectorService } from "./modules/connectors/service.mjs";
import { createVulnerabilityAlertService } from "./modules/vulnerability-alerts/service.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const dataDir = process.env.SENTINEL_DATA_DIR || join(root, "../../.runtime/cloud-data");
const legacyDataDir = process.env.SENTINEL_LEGACY_DATA_DIR || "";
const masterSecret = process.env.SENTINEL_SECRET || "sentinel-local-development-secret";
const publicBaseUrl = assertEncryptedHttpUrl(process.env.SENTINEL_PUBLIC_BASE_URL || "http://127.0.0.1:8787", {
  label: "SENTINEL_PUBLIC_BASE_URL",
  allowLoopbackHttp: process.env.NODE_ENV !== "production"
}).toString().replace(/\/$/, "");
const roleArg = process.argv.find((value) => value.startsWith("--role="));
const role = roleArg?.slice("--role=".length) || process.env.SENTINEL_WORKER_ROLE || "all";
const allowedRoles = new Set(["all", "scheduler", "snapshot", "io", "maintenance"]);
if (!allowedRoles.has(role)) throw new Error(`未知后台角色：${role}`);
const workerHostName = hostname();
const workerNodeId = String(process.env.SENTINEL_WORKER_NODE_ID || workerHostName).trim();
if (!workerNodeId || workerNodeId.length > 100 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(workerNodeId)) {
  throw new Error("SENTINEL_WORKER_NODE_ID 只能包含字母、数字、点、下划线、冒号和连字符，且不能超过 100 个字符");
}
const workerNodeName = String(process.env.SENTINEL_WORKER_NODE_NAME || workerHostName).trim().slice(0, 120) || workerNodeId;

const { encrypt, decrypt } = createSecretCodec(masterSecret);
await migrate();
const runtime = createBullmqRuntime();
await runtime.ping();
const outbox = createTaskOutbox({ db, runtime });
const repository = createCloudEdgeRepository(db);
const snapshotJobs = await createSnapshotJobQueue({ db, repository, outbox });
const vulnerabilityAlerts = createVulnerabilityAlertService({ db });
async function publishVulnerabilityChanges(tenantId) {
  const alerts = await vulnerabilityAlerts.recompute({ tenantId });
  const deployments = (await repository.listDeployments()).filter((item) => item.enabled && item.tenantId === tenantId);
  const snapshots = [];
  for (const deployment of deployments) {
    const queued = await snapshotJobs.enqueue(deployment.id, { triggerType: "vulnerability_auto_publish" });
    snapshots.push({ deploymentId: deployment.id, jobId: queued.job.id, deduplicated: queued.deduplicated });
  }
  return { ...alerts, snapshots };
}
const connectorService = createConnectorService({
  db,
  decrypt,
  onVulnerabilitiesChanged: publishVulnerabilityChanges,
  onAssetsChanged: (tenantId) => vulnerabilityAlerts.recompute({ tenantId })
});
await vulnerabilityAlerts.ensureDefaultWatchGroups();
await vulnerabilityAlerts.recompute();
const collectionJobs = createCollectionJobQueue({ db, outbox, syncConnection: connectorService.syncConnection });
const scheduleService = createBackgroundScheduleService({ db, runtime });
const cloudEdge = createCloudEdgeModule({
  db,
  repository,
  dataDir,
  legacyDataDir,
  masterSecret,
  encryptSecret: encrypt,
  decryptSecret: decrypt,
  publicBaseUrl,
  readJson: async () => ({}),
  requirePermission: async () => false
});
const taskLists = {
  scheduler: createSchedulerTaskList({ snapshotJobs, collectionJobs }),
  snapshot: createSnapshotTaskList({ repository, service: cloudEdge.service }),
  io: collectionJobs.taskList,
  maintenance: createMaintenanceTaskList({
    db,
    localStorage: cloudEdge.localStorage,
    objectStorage: cloudEdge.objectStorage,
    queueCleanup: runtime.cleanHistory
  })
};
mergeTaskLists(...Object.values(taskLists));

const concurrency = {
  scheduler: 1,
  snapshot: Math.max(1, Number(process.env.SENTINEL_SNAPSHOT_WORKER_CONCURRENCY || 1)),
  io: Math.max(1, Number(process.env.SENTINEL_COLLECTION_WORKER_CONCURRENCY || 4)),
  maintenance: 1
};
const selectedRoles = role === "all" ? Object.keys(taskLists) : [role];
const workers = [];
let stopOutbox = null;
let scheduleReconcileTimer = null;
let controlTimer = null;
let appliedNodeState = null;
let controlUpdate = Promise.resolve();

function aggregateContext(job) {
  if (job.data?.runId) return { type: "collection_run", id: String(job.data.runId) };
  if (job.data?.operationId) return { type: "snapshot_job", id: String(job.data.operationId) };
  if (job.data?.scheduleIdentifier) return { type: "background_schedule", id: String(job.data.scheduleIdentifier) };
  return { type: null, id: null };
}

function retryDelay(job, attempt) {
  const backoff = job.opts.backoff;
  if (typeof backoff === "number") return backoff;
  if (!backoff || typeof backoff !== "object") return 0;
  const delay = Math.max(0, Number(backoff.delay || 0));
  return backoff.type === "exponential" ? delay * (2 ** Math.max(0, attempt - 1)) : delay;
}

function errorObservability(error) {
  const status = Number(error?.statusCode || 0);
  return {
    errorType: String(error?.errorType || (error?.name === "AbortError" ? "timeout" : status === 401 || status === 403 ? "authentication" : status >= 500 ? "upstream_http" : status >= 400 ? "validation" : "internal")),
    errorCode: String(error?.errorCode || error?.code || error?.name || "TASK_ERROR").slice(0, 120),
    upstreamMethod: error?.upstreamMethod ? String(error.upstreamMethod).slice(0, 16) : null,
    upstreamStatus: Number.isInteger(Number(error?.upstreamStatus)) ? Number(error.upstreamStatus) : null,
    upstreamContentType: error?.upstreamContentType ? String(error.upstreamContentType).slice(0, 160) : null,
    upstreamOrigin: error?.upstreamOrigin ? String(error.upstreamOrigin).slice(0, 300) : null,
    upstreamPath: error?.upstreamPath ? String(error.upstreamPath).slice(0, 500) : null
  };
}

async function recordRunStart(queueRole, workerInstanceId, job, maxAttempts) {
  const now = new Date().toISOString();
  const aggregate = aggregateContext(job);
  const queuedAt = Number.isFinite(Number(job.timestamp)) ? new Date(Number(job.timestamp)).toISOString() : null;
  const queueLatencyMs = queuedAt ? Math.max(0, Date.now() - new Date(queuedAt).getTime()) : null;
  const result = await db.prepare(`INSERT INTO background_task_runs
    (bullmq_job_id,queue_role,task_identifier,trigger_type,status,attempt,started_at,
     aggregate_type,aggregate_id,tenant_id,worker_instance_id,max_attempts,queued_at,queue_latency_ms)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`).get(
    String(job.id), queueRole, job.name, String(job.data?.triggerType || "queued"), "running", Number(job.attemptsMade || 0) + 1, now,
    aggregate.type, aggregate.id, job.data?.tenantId ? String(job.data.tenantId) : null, workerInstanceId, maxAttempts, queuedAt, queueLatencyMs
  );
  return result.id;
}

async function recordRunFinish(id, status, { error = null, noticeMessage = null, durationMs, willRetry = null, nextRetryAt = null } = {}) {
  const observed = error ? errorObservability(error) : {};
  await db.prepare(`UPDATE background_task_runs SET
    status=?,finished_at=?,error_message=?,notice_message=?,duration_ms=?,will_retry=?,next_retry_at=?,error_type=?,error_code=?,
    upstream_method=?,upstream_status=?,upstream_content_type=?,upstream_origin=?,upstream_path=? WHERE id=?`)
    .run(
      status, new Date().toISOString(), error ? (error instanceof Error ? error.message : String(error)) : null,
      noticeMessage, durationMs, willRetry, nextRetryAt, observed.errorType || null, observed.errorCode || null,
      observed.upstreamMethod || null, observed.upstreamStatus ?? null, observed.upstreamContentType || null,
      observed.upstreamOrigin || null, observed.upstreamPath || null, id
    );
}

async function ensureWorkerNode() {
  const now = new Date().toISOString();
  await db.prepare(`INSERT INTO worker_nodes
    (node_id,display_name,description,desired_state,registered_at,last_seen_at,updated_at)
    VALUES (?,?,'','active',?,?,?)
    ON CONFLICT(node_id) DO UPDATE SET last_seen_at=excluded.last_seen_at`)
    .run(workerNodeId, workerNodeName, now, now, now);
  return db.prepare("SELECT * FROM worker_nodes WHERE node_id=?").get(workerNodeId);
}

async function startSchedulerServices() {
  if (!selectedRoles.includes("scheduler")) return;
  if (!stopOutbox) {
    await scheduleService.reconcileAll();
    stopOutbox = outbox.startDispatcher();
  }
  if (!scheduleReconcileTimer) {
    scheduleReconcileTimer = setInterval(() => void scheduleService.reconcileAll().catch((error) => console.error("BullMQ 定时计划校准失败", error)), 30_000);
    scheduleReconcileTimer.unref?.();
  }
}

async function stopSchedulerServices() {
  if (scheduleReconcileTimer) {
    clearInterval(scheduleReconcileTimer);
    scheduleReconcileTimer = null;
  }
  if (stopOutbox) {
    const stop = stopOutbox;
    stopOutbox = null;
    await stop();
  }
}

async function applyWorkerNodeState(desiredState) {
  if (!["active", "draining", "disabled"].includes(desiredState)) throw new Error(`Worker 节点期望状态不合法：${desiredState}`);
  if (desiredState === "active") {
    for (const entry of workers) entry.worker.resume();
    await startSchedulerServices();
  } else {
    await stopSchedulerServices();
    await Promise.all(workers.map((entry) => entry.worker.pause(true)));
  }
  appliedNodeState = desiredState;
}

async function writeWorkerHeartbeat() {
  const node = await ensureWorkerNode();
  if (node.desired_state !== appliedNodeState) await applyWorkerNodeState(node.desired_state);
  const now = new Date().toISOString();
  await db.transaction(async () => {
    await db.prepare("UPDATE worker_nodes SET last_seen_at=? WHERE node_id=?").run(now, workerNodeId);
    for (const entry of workers) {
      await db.prepare(`INSERT INTO worker_instances
        (instance_id,node_id,role,process_id,host_name,concurrency,applied_state,active_jobs,started_at,last_heartbeat_at,status)
        VALUES (?,?,?,?,?,?,?,?,?,?,'running')
        ON CONFLICT(instance_id) DO UPDATE SET
          node_id=excluded.node_id,process_id=excluded.process_id,host_name=excluded.host_name,
          concurrency=excluded.concurrency,applied_state=excluded.applied_state,active_jobs=excluded.active_jobs,
          last_heartbeat_at=excluded.last_heartbeat_at,status='running',stopped_at=NULL`)
        .run(entry.instanceId, workerNodeId, entry.role, process.pid, workerHostName, concurrency[entry.role], appliedNodeState, entry.runtime.activeJobs, entry.startedAt, now);
    }
  });
}

function queueControlUpdate() {
  controlUpdate = controlUpdate
    .then(writeWorkerHeartbeat)
    .catch((error) => console.error(`Worker 节点控制同步失败（${workerNodeId}）`, error));
  return controlUpdate;
}

function startWorkerNodeControl() {
  void queueControlUpdate();
  controlTimer = setInterval(() => void queueControlUpdate(), 5_000);
  controlTimer.unref?.();
}

async function startWorker(queueRole) {
  const tasks = taskLists[queueRole];
  const workerInstanceId = `${workerNodeId}:${queueRole}:${randomUUID()}`;
  const runtimeState = { activeJobs: 0 };
  const startedAt = new Date().toISOString();
  const worker = new Worker(QUEUE_NAMES[queueRole], async (job) => {
    runtimeState.activeJobs += 1;
    const attempt = Number(job.attemptsMade || 0) + 1;
    const maxAttempts = Number(job.opts.attempts || 1);
    const startedAt = Date.now();
    const reference = job.data?.runId || job.data?.snapshotJobId || job.data?.scheduleIdentifier;
    const context = `${queueRole}/${job.name}/${job.id}; attempt=${attempt}/${maxAttempts}${reference ? `; reference=${reference}` : ""}`;
    let taskRunId = null;
    console.log(`BullMQ 任务开始（${context}）`);
    try {
      const handler = tasks[job.name];
      if (!handler) throw new Error(`队列 ${queueRole} 未注册任务：${job.name}`);
      if (job.data?.scheduleIdentifier && Number(job.attemptsMade || 0) === 0) {
        await scheduleService.recordTriggered(job.data.scheduleIdentifier);
      }
      taskRunId = await recordRunStart(queueRole, workerInstanceId, job, maxAttempts);
      const result = await handler(job.data, {
        job,
        attempt,
        maxAttempts
      });
      await recordRunFinish(taskRunId, "succeeded", {
        durationMs: Date.now() - startedAt,
        noticeMessage: typeof result?.warningMessage === "string" ? result.warningMessage : null
      });
      console.log(`BullMQ 任务完成（${context}; durationMs=${Date.now() - startedAt}）`);
      return result;
    } catch (error) {
      const willRetry = error?.retryable !== false && attempt < maxAttempts;
      if (!willRetry) job.discard();
      const delay = willRetry ? retryDelay(job, attempt) : 0;
      const nextRetryAt = willRetry ? new Date(Date.now() + delay).toISOString() : null;
      if (taskRunId !== null) await recordRunFinish(taskRunId, "failed", { error, durationMs: Date.now() - startedAt, willRetry, nextRetryAt });
      const message = error instanceof Error ? error.message : String(error);
      const duration = Date.now() - startedAt;
      if (willRetry) {
        console.warn(`BullMQ 任务尝试失败，将自动重试（${context}; durationMs=${duration}）：${message}`);
      } else {
        console.error(`BullMQ 任务最终失败（${context}; durationMs=${duration}）`, error);
      }
      throw error;
    } finally {
      runtimeState.activeJobs = Math.max(0, runtimeState.activeJobs - 1);
    }
  }, {
    connection: runtime.connection,
    prefix: runtime.prefix,
    concurrency: concurrency[queueRole],
    autorun: false
  });
  worker.on("error", (error) => console.error(`BullMQ Worker 错误（${queueRole}）`, error));
  worker.on("stalled", (jobId) => console.error(`BullMQ 任务停滞（${queueRole}/${jobId}）`));
  await worker.waitUntilReady();
  workers.push({ role: queueRole, worker, instanceId: workerInstanceId, runtime: runtimeState, startedAt });
}

const initialNode = await ensureWorkerNode();
for (const selectedRole of selectedRoles) await startWorker(selectedRole);
await applyWorkerNodeState(initialNode.desired_state);
await writeWorkerHeartbeat();
startWorkerNodeControl();

console.log(`Sentinel BullMQ worker started (node=${workerNodeId}; state=${appliedNodeState}; role=${role}; workers=${selectedRoles.join(",")}; prefix=${runtime.prefix})`);

let stopping = false;
async function shutdown(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  if (controlTimer) clearInterval(controlTimer);
  await controlUpdate;
  await stopSchedulerServices();
  await Promise.allSettled(workers.map(({ worker }) => worker.close()));
  const stoppedAt = new Date().toISOString();
  await Promise.allSettled(workers.map(({ instanceId }) => db.prepare("UPDATE worker_instances SET status='stopped',active_jobs=0,stopped_at=?,last_heartbeat_at=? WHERE instance_id=?")
    .run(stoppedAt, stoppedAt, instanceId)));
  await snapshotJobs.release();
  await runtime.close();
  await closeDatabase();
  process.exitCode = exitCode;
}

process.once("SIGINT", () => void shutdown(0));
process.once("SIGTERM", () => void shutdown(0));
