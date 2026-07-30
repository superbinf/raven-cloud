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

async function waitForApi(baseUrl, child) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`API 提前退出：${child.exitCode}`);
    try { if ((await fetch(`${baseUrl}/health`)).ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error("API 启动超时");
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    child.once("exit", resolve);
    child.kill("SIGTERM");
  });
}

test("云端审计记录成功与失败操作、隔离审计域且不保存敏感请求体", async (t) => {
  const dataDir = await mkdtemp(join(os.tmpdir(), "sentinel-audit-test-"));
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const databaseUrl = process.env.DATABASE_URL || "postgresql://sentinel:sentinel-local-password@127.0.0.1:5432/sentinel";
  const schema = `sentinel_test_audit_${process.pid}_${port}`;
  const adminPassword = "Audit-Admin#2026";
  const portalPassword = "Audit-Portal#2026";
  const operationsPassword = "Audit-Operations#2026";
  const child = spawn(process.execPath, [join(apiRoot, "src/server.mjs")], {
    cwd: join(apiRoot, "../.."),
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_URL: databaseUrl,
      SENTINEL_DB_SCHEMA: schema,
      SENTINEL_DATA_DIR: dataDir,
      SENTINEL_SECRET: "audit-test-secret",
      SENTINEL_ADMIN_ACCOUNT: "audit-admin",
      SENTINEL_ADMIN_PASSWORD: adminPassword,
      SENTINEL_PORTAL_ACCOUNT: "audit-viewer",
      SENTINEL_PORTAL_PASSWORD: portalPassword
    },
    stdio: ["ignore", "ignore", "pipe"]
  });

  t.after(async () => {
    await stopChild(child);
    const cleanup = new pg.Client({ connectionString: databaseUrl });
    await cleanup.connect();
    await cleanup.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await cleanup.end();
    await rm(dataDir, { recursive: true, force: true });
  });
  await waitForApi(baseUrl, child);

  const request = async (path, { token, ...options } = {}) => {
    const headers = new Headers(options.headers);
    if (token) headers.set("Authorization", `Bearer ${token}`);
    if (token) {
      let bodyTenantId = "";
      if (typeof options.body === "string") { try { bodyTenantId = String(JSON.parse(options.body).tenantId || ""); } catch {} }
      headers.set("X-Sentinel-Tenant-Id", new URL(path, baseUrl).searchParams.get("tenant_id") || bodyTenantId || "TENANT-CHANGAN");
    }
    if (options.body && !(options.body instanceof FormData)) headers.set("Content-Type", "application/json");
    const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
    const body = await response.json().catch(() => null);
    return { status: response.status, body };
  };
  const login = (account, password) => loginWithCaptcha(request, { account, password, secret: "audit-test-secret" });

  const adminLogin = await login("audit-admin", adminPassword);
  assert.equal(adminLogin.status, 200);
  const failedLogin = await login("audit-admin", "Wrong-Password#2026");
  assert.equal(failedLogin.status, 401);
  const portalLogin = await login("audit-viewer", portalPassword);
  assert.equal(portalLogin.status, 200);
  const adminToken = adminLogin.body.token;
  const portalToken = portalLogin.body.token;
  const operationsCreated = await request("/api/users", { token: adminToken, method: "POST", body: JSON.stringify({ account: "audit-operations", name: "审计运营员", roleKey: "operations-admin", password: operationsPassword }) });
  assert.equal(operationsCreated.status, 201);
  const operationsLogin = await login("audit-operations", operationsPassword);
  assert.equal(operationsLogin.status, 200);
  const operationsToken = operationsLogin.body.token;
  assert.equal((await request("/api/audit-logs?context=operations", { token: operationsToken })).status, 200);
  assert.equal((await request("/api/audit-logs?context=management", { token: operationsToken })).status, 403);

  const created = await request("/api/targets", {
    token: adminToken,
    method: "POST",
    body: JSON.stringify({ tenantId: "TENANT-CHANGAN", name: "审计测试对象", targetType: "情报专题", owner: "审计测试", domains: ["audit.example"], ips: [], keywords: ["audit-keyword"] })
  });
  assert.equal(created.status, 201);
  const forbidden = await request("/api/targets", {
    token: portalToken,
    method: "POST",
    body: JSON.stringify({ tenantId: "TENANT-CHANGAN", name: "不应创建", targetType: "情报专题", owner: "", domains: [], ips: [], keywords: [] })
  });
  assert.equal(forbidden.status, 403);
  assert.equal((await request("/api/audit-logs?context=operations", { token: portalToken })).status, 403);

  let operations;
  let management;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    operations = await request("/api/audit-logs?context=operations&page_size=100", { token: adminToken });
    management = await request("/api/audit-logs?context=management&page_size=100", { token: adminToken });
    if (operations.body?.data?.length >= 3 && management.body?.data?.length >= 5) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  assert.equal(operations.status, 200);
  assert.equal(management.status, 200);
  assert.ok(operations.body.data.some((item) => item.action === "新增关键词与域名配置" && item.actorAccount === "audit-admin" && item.result === "success" && item.tenantId === "TENANT-CHANGAN"));
  assert.ok(operations.body.data.some((item) => item.action === "新增关键词与域名配置" && item.actorAccount === "audit-viewer" && item.result === "failed" && item.statusCode === 403 && item.tenantId === "TENANT-CHANGAN"));
  assert.ok(management.body.data.some((item) => item.action === "登录平台" && item.actorAccount === "audit-admin" && item.result === "success" && item.tenantId === null));
  assert.ok(management.body.data.some((item) => item.action === "登录平台" && item.actorAccount === "audit-admin" && item.result === "failed" && item.statusCode === 401));
  assert.ok(!management.body.data.some((item) => item.path === "/api/targets"));
  assert.ok(!operations.body.data.some((item) => item.path === "/api/auth/login"));

  const tenantOnly = await request("/api/audit-logs?context=operations&tenant_id=TENANT-CHANGAN&page_size=100", { token: adminToken });
  assert.equal(tenantOnly.status, 200);
  assert.ok(tenantOnly.body.data.length >= 2);
  assert.ok(tenantOnly.body.data.every((item) => item.tenantId === "TENANT-CHANGAN"));
  assert.equal((await request("/api/audit-logs?context=operations&tenant_id=TENANT-NOT-FOUND", { token: adminToken })).status, 404);

  const failedOnly = await request("/api/audit-logs?context=operations&result=failed&query=audit-viewer", { token: adminToken });
  assert.equal(failedOnly.status, 200);
  assert.ok(failedOnly.body.data.length >= 1);
  assert.ok(failedOnly.body.data.every((item) => item.result === "failed" && item.actorAccount === "audit-viewer"));

  const inspection = new pg.Client({ connectionString: databaseUrl });
  await inspection.connect();
  await inspection.query(`SET search_path TO "${schema}"`);
  const details = await inspection.query("SELECT tenant_id,detail_json FROM audit_logs");
  const scopedTargetAudits = await inspection.query("SELECT COUNT(*)::int AS count FROM audit_logs WHERE path='/api/targets' AND tenant_id='TENANT-CHANGAN'");
  await inspection.end();
  assert.equal(scopedTargetAudits.rows[0].count, 2);
  const storedDetails = JSON.stringify(details.rows);
  assert.ok(!storedDetails.includes(adminPassword));
  assert.ok(!storedDetails.includes(portalPassword));
  assert.ok(!storedDetails.includes(operationsPassword));
  assert.ok(!storedDetails.includes("Wrong-Password#2026"));
  assert.ok(!storedDetails.includes("audit-keyword"));
});
