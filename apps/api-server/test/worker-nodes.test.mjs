import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { loginWithCaptcha } from "./support/captcha.mjs";

const apiRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    child.once("exit", resolve);
    child.kill("SIGTERM");
  });
}

async function waitForApi(baseUrl, child) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`API 提前退出：${child.exitCode}`);
    try { if ((await fetch(`${baseUrl}/health`)).ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error("API 启动超时");
}

async function waitForNode(request, nodeId, predicate, child) {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    if (child?.exitCode !== null) throw new Error(`Worker 提前退出：${child.exitCode}`);
    const response = await request("/api/worker-nodes");
    const node = response.body.find((item) => item.nodeId === nodeId);
    if (node && predicate(node)) return node;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Worker 节点状态等待超时：${nodeId}`);
}

test("Worker 节点可自动注册、排空、禁用、重新启用并安全清理离线记录", async (t) => {
  const dataDir = await mkdtemp(join(os.tmpdir(), "sentinel-worker-node-test-"));
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const databaseUrl = process.env.DATABASE_URL || "postgresql://sentinel:sentinel-local-password@127.0.0.1:5432/sentinel";
  const schema = `sentinel_test_worker_nodes_${process.pid}_${port}`;
  const nodeId = `worker-control-${process.pid}-${port}`;
  const runtimeEnv = {
    ...process.env,
    PORT: String(port),
    DATABASE_URL: databaseUrl,
    SENTINEL_DB_SCHEMA: schema,
    SENTINEL_DATA_DIR: dataDir,
    SENTINEL_SECRET: "worker-control-test-secret-2026",
    SENTINEL_ADMIN_ACCOUNT: "worker-admin",
    SENTINEL_ADMIN_PASSWORD: "Worker-Admin#2026",
    SENTINEL_PORTAL_ACCOUNT: "worker-viewer",
    SENTINEL_PORTAL_PASSWORD: "Worker-Viewer#2026",
    SENTINEL_WORKER_NODE_ID: nodeId,
    SENTINEL_WORKER_NODE_NAME: "Worker 控制测试节点"
  };
  const api = spawn(process.execPath, [join(apiRoot, "src/server.mjs")], {
    cwd: join(apiRoot, "../.."),
    env: runtimeEnv,
    stdio: ["ignore", "ignore", "pipe"]
  });
  let worker;
  let workerError = "";

  t.after(async () => {
    await stopChild(worker);
    await stopChild(api);
    const cleanup = new pg.Client({ connectionString: databaseUrl });
    await cleanup.connect();
    await cleanup.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await cleanup.end();
    await rm(dataDir, { recursive: true, force: true });
  });

  await waitForApi(baseUrl, api);
  const request = async (path, options = {}) => {
    const headers = new Headers(options.headers);
    if (options.token) headers.set("Authorization", `Bearer ${options.token}`);
    if (options.token) headers.set("X-Sentinel-Tenant-Id", "TENANT-CHANGAN");
    if (options.body) headers.set("Content-Type", "application/json");
    const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
    const body = await response.json();
    return { status: response.status, body };
  };
  const login = await loginWithCaptcha(request, {
    account: "worker-admin",
    password: "Worker-Admin#2026",
    secret: "worker-control-test-secret-2026"
  });
  assert.equal(login.status, 200);
  const token = login.body.token;
  const authorized = (path, options = {}) => request(path, { ...options, token });

  const preregistered = await authorized("/api/worker-nodes", {
    method: "POST",
    body: JSON.stringify({ nodeId: "worker-future-01", displayName: "预注册节点", description: "尚未部署" })
  });
  assert.equal(preregistered.status, 201, JSON.stringify(preregistered.body));
  assert.equal(preregistered.body.desiredState, "disabled");
  assert.equal(preregistered.body.runtimeState, "offline");

  worker = spawn(process.execPath, [join(apiRoot, "src/worker.mjs"), "--role=maintenance"], {
    cwd: join(apiRoot, "../.."),
    env: runtimeEnv,
    stdio: ["ignore", "ignore", "pipe"]
  });
  worker.stderr.on("data", (chunk) => { workerError += chunk; });

  let node;
  try {
    node = await waitForNode(authorized, nodeId, (item) => item.runtimeState === "active" && item.roles.includes("maintenance"), worker);
  } catch (error) {
    throw new Error(`${error.message}${workerError ? `\nWorker stderr:\n${workerError}` : ""}`);
  }
  assert.equal(node.healthy, true);
  assert.equal(node.instances[0].concurrency, 1);
  assert.equal(node.instances[0].appliedState, "active");

  assert.equal((await authorized(`/api/worker-nodes/${encodeURIComponent(nodeId)}`, {
    method: "PUT",
    body: JSON.stringify({ desiredState: "draining" })
  })).status, 200);
  node = await waitForNode(authorized, nodeId, (item) => item.runtimeState === "drained", worker);
  assert.equal(node.activeJobs, 0);
  assert.equal(node.instances[0].appliedState, "draining");

  assert.equal((await authorized(`/api/worker-nodes/${encodeURIComponent(nodeId)}`, {
    method: "PUT",
    body: JSON.stringify({ desiredState: "active" })
  })).status, 200);
  await waitForNode(authorized, nodeId, (item) => item.runtimeState === "active", worker);

  assert.equal((await authorized(`/api/worker-nodes/${encodeURIComponent(nodeId)}`, {
    method: "PUT",
    body: JSON.stringify({ desiredState: "disabled" })
  })).status, 200);
  await waitForNode(authorized, nodeId, (item) => item.runtimeState === "disabled", worker);
  assert.equal((await authorized(`/api/worker-nodes/${encodeURIComponent(nodeId)}`, { method: "DELETE" })).status, 409);

  await stopChild(worker);
  worker = undefined;
  assert.equal((await authorized(`/api/worker-nodes/${encodeURIComponent(nodeId)}`, { method: "DELETE" })).status, 200);
  assert.equal((await authorized("/api/worker-nodes/worker-future-01", { method: "DELETE" })).status, 200);

  const inspection = new pg.Client({ connectionString: databaseUrl });
  await inspection.connect();
  await inspection.query(`SET search_path TO "${schema}",public`);
  const audit = await inspection.query("SELECT tenant_id,action FROM audit_logs WHERE resource_type='worker-node' ORDER BY occurred_at");
  await inspection.end();
  assert.ok(audit.rows.length >= 6);
  assert.ok(audit.rows.every((row) => row.tenant_id === null));
});
