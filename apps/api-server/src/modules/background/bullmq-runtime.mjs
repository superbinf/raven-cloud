import { Queue } from "bullmq";
import Redis from "ioredis";
import { databaseConfig } from "../../database.mjs";

export const QUEUE_NAMES = Object.freeze({
  scheduler: "scheduler",
  snapshot: "snapshot",
  io: "io",
  maintenance: "maintenance"
});

export const DEFAULT_JOB_OPTIONS = Object.freeze({
  attempts: 3,
  backoff: { type: "exponential", delay: 1_000 },
  removeOnComplete: { age: 7 * 86_400, count: 10_000 },
  removeOnFail: { age: 30 * 86_400, count: 10_000 }
});

export function redisConnectionOptions(url = process.env.REDIS_URL || "redis://127.0.0.1:6379") {
  const parsed = new URL(url);
  if (!['redis:', 'rediss:'].includes(parsed.protocol)) throw new Error("REDIS_URL 必须使用 redis:// 或 rediss://");
  const database = parsed.pathname && parsed.pathname !== "/" ? Number(parsed.pathname.slice(1)) : 0;
  if (!Number.isInteger(database) || database < 0) throw new Error("REDIS_URL 数据库编号不合法");
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 6379),
    username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    db: database,
    tls: parsed.protocol === "rediss:" ? {} : undefined,
    connectTimeout: 5_000,
    maxRetriesPerRequest: null,
    enableReadyCheck: true
  };
}

export function queuePrefix(schema = databaseConfig.schema) {
  const configured = String(process.env.SENTINEL_QUEUE_PREFIX || "sentinel").replace(/[^A-Za-z0-9_-]/g, "-");
  return `${configured}-${schema}`;
}

export function createBullmqRuntime({ connection = redisConnectionOptions(), prefix = queuePrefix() } = {}) {
  const producerConnection = { ...connection, maxRetriesPerRequest: 1 };
  const queues = Object.fromEntries(Object.entries(QUEUE_NAMES).map(([role, name]) => [role, new Queue(name, {
    connection: producerConnection,
    prefix,
    defaultJobOptions: DEFAULT_JOB_OPTIONS
  })]));

  function queue(role) {
    const value = queues[role];
    if (!value) throw new Error(`未知 BullMQ 队列角色：${role}`);
    return value;
  }

  async function add(role, taskIdentifier, payload = {}, options = {}) {
    return queue(role).add(taskIdentifier, payload, { ...DEFAULT_JOB_OPTIONS, ...options });
  }

  async function stats() {
    const totals = { pending: 0, running: 0, permanentlyFailed: 0, oldestWaitingMs: 0 };
    for (const value of Object.values(queues)) {
      const counts = await value.getJobCounts("wait", "active", "failed");
      totals.pending += Number(counts.wait || 0);
      totals.running += Number(counts.active || 0);
      totals.permanentlyFailed += Number(counts.failed || 0);
      const [oldest] = await value.getWaiting(0, 0, true);
      if (oldest?.timestamp) totals.oldestWaitingMs = Math.max(totals.oldestWaitingMs, Date.now() - Number(oldest.timestamp));
    }
    return totals;
  }

  async function cleanHistory() {
    const result = {};
    for (const [role, value] of Object.entries(queues)) {
      const completed = await value.clean(7 * 86_400_000, 10_000, "completed");
      const failed = await value.clean(30 * 86_400_000, 10_000, "failed");
      result[role] = { completed: completed.length, failed: failed.length };
    }
    return result;
  }

  async function ping() {
    const redis = new Redis({ ...producerConnection, retryStrategy: () => null });
    try { return await redis.ping(); }
    finally { await redis.quit(); }
  }

  return {
    connection,
    prefix,
    queues,
    queue,
    add,
    stats,
    cleanHistory,
    ping,
    obliterate: () => Promise.all(Object.values(queues).map((value) => value.obliterate({ force: true }))),
    close: () => Promise.allSettled(Object.values(queues).map((value) => value.close()))
  };
}
