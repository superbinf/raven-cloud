import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
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
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    child.once("exit", resolve);
    child.kill("SIGTERM");
  });
}

async function waitForRun(request, jobId, expectedCount) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const response = await request(`/api/collection-runs?job_id=${jobId}`);
    if (response.body.length >= expectedCount && ["成功", "失败"].includes(response.body[0].status)) return response.body;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error("采集后台任务执行超时");
}

test("Hunter、WatchVuln 与凭据连接器可独立配置、全量分页入库并由持久化任务执行", async (t) => {
  const upstreamPort = await availablePort();
  let failuresRemaining = 0;
  let hunterRecord = { ip: "198.51.100.88", port: 443, protocol: "https", domain: "hunter.example.com", url: "https://hunter.example.com", alive: true, status_code: 200, title: "Hunter 初始标题" };
  const credentialPages = []; let credentialTransientFailure = true;
  const upstream = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === "/api/sub/list/") {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      assert.equal(JSON.parse(Buffer.concat(chunks).toString("utf8")).api_key, "credential-test-key");
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ code: 0, data: [{ id: 901, sub_type: "credential-leak", sub_category: "credential", user_permission_id: "permission-test", value: "credential.example.com", expire_time: "2027-12-31T23:59:59Z", count: 205 }] }));
    }
    if (url.pathname === "/api/sub/data/") {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      assert.equal(input.api_key, "credential-test-key");
      assert.equal(input.sub_id, 901);
      credentialPages.push(input.page);
      if (input.page === 2 && credentialTransientFailure) {
        credentialTransientFailure = false;
        res.writeHead(503, { "Content-Type": "text/html" });
        return res.end("<html><body>temporary unavailable</body></html>");
      }
      const allItems = Array.from({ length: 205 }, (_, index) => ({ _id: `credential-${index + 1}`, _source: { account: `user-${index + 1}`, domain: "credential.example.com", msg: { pwd: `password-${index + 1}` }, timestamp: `2026-07-21T00:${String(index % 60).padStart(2, "0")}:00Z`, source: "credential-test" } }));
      const offset = (input.page - 1) * input.page_size;
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ code: 0, data: allItems.slice(offset, offset + input.page_size) }));
    }
    if (url.pathname === "/api/v1/vulnerabilities") {
      const token = req.headers.authorization;
      assert.ok(["Bearer watchvuln-feed-test-token", "Bearer watchvuln-auto-publish-test-token"].includes(token));
      const draftItems = [
        { id: 1, key: "kev-CVE-2026-1001", title: "示例高危漏洞", description: "远程攻击者可利用该漏洞。", severity: "high", cve: "CVE-2026-1001", disclosure: "2026-07-20", solutions: "升级到安全版本", references: ["https://example.test/CVE-2026-1001"], tags: ["KEV", "POC公开"], githubSearch: [], source: "kev", pushed: true, createdAt: "2026-07-20T01:00:00Z", updatedAt: "2026-07-20T02:00:00Z" },
        { id: 2, key: "avd-CVE-2026-1002", title: "示例严重漏洞", description: "该漏洞已出现公开利用。", severity: "critical", cve: "CVE-2026-1002", disclosure: "2026-07-21", solutions: "应用厂商补丁", references: ["https://example.test/CVE-2026-1002"], tags: ["在野利用"], githubSearch: [], source: "avd", pushed: true, createdAt: "2026-07-21T01:00:00Z", updatedAt: "2026-07-21T02:00:00Z" }
      ];
      const autoPublishItems = [
        { id: 3, key: "ti-QVD-2026-2001", title: "重保2026示例漏洞", description: "TI 定向漏洞情报。", severity: "critical", cve: "CVE-2026-2001", disclosure: "2026-07-22", solutions: "立即安装安全补丁", references: ["https://example.test/QVD-2026-2001"], tags: ["重保2026"], githubSearch: [], source: "ti", pushed: false, createdAt: "2026-07-22T01:00:00Z", updatedAt: "2026-07-22T02:00:00Z" }
      ];
      const allItems = token === "Bearer watchvuln-auto-publish-test-token" ? autoPublishItems : draftItems;
      const offset = Number(url.searchParams.get("offset") || 0);
      const limit = Number(url.searchParams.get("limit") || 500);
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ source: "WatchVuln_Web", total: allItems.length, offset, limit, items: allItems.slice(offset, offset + limit) }));
    }
    assert.equal(url.pathname, "/openApi/search");
    assert.equal(url.searchParams.get("api-key"), "hunter-test-key");
    if (failuresRemaining > 0) {
      failuresRemaining -= 1;
      res.writeHead(503, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ message: "temporary upstream failure" }));
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ code: 200, data: { total: 1, arr: [hunterRecord] } }));
  });
  await new Promise((resolve) => upstream.listen(upstreamPort, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => upstream.close(resolve)));

  const dataDir = await mkdtemp(join(os.tmpdir(), "sentinel-connector-test-"));
  const port = await availablePort(); const baseUrl = `http://127.0.0.1:${port}`;
  const databaseUrl = process.env.DATABASE_URL || "postgresql://sentinel:sentinel-local-password@127.0.0.1:5432/sentinel";
  const schema = `sentinel_test_connector_${process.pid}_${port}`;
  const runtimeEnv = { ...process.env, PORT: String(port), DATABASE_URL: databaseUrl, SENTINEL_DB_SCHEMA: schema, SENTINEL_DATA_DIR: dataDir, SENTINEL_SECRET: "connector-test-secret", SENTINEL_CONNECTOR_ALLOWED_HOSTS: "127.0.0.1", SENTINEL_ADMIN_ACCOUNT: "operator", SENTINEL_ADMIN_PASSWORD: "Admin-Test#2026", SENTINEL_PORTAL_ACCOUNT: "analyst", SENTINEL_PORTAL_PASSWORD: "Portal-Test#2026" };
  const child = spawn(process.execPath, [join(apiRoot, "src/server.mjs")], {
    cwd: join(apiRoot, "../.."),
    env: runtimeEnv,
    stdio: ["ignore", "ignore", "pipe"]
  });
  let worker;
  let workerError = "";
  t.after(async () => {
    await stopChild(worker);
    await stopChild(child);
    const cleanup = new pg.Client({ connectionString: databaseUrl }); await cleanup.connect(); await cleanup.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await cleanup.end();
    await rm(dataDir, { recursive: true, force: true });
  });
  await waitForApi(baseUrl, child);
  worker = spawn(process.execPath, [join(apiRoot, "src/worker.mjs"), "--role=all"], { cwd: join(apiRoot, "../.."), env: runtimeEnv, stdio: ["ignore", "ignore", "pipe"] });
  worker.stderr.on("data", (chunk) => { workerError += chunk; });

  const request = async (path, token, options = {}) => {
    const headers = new Headers(options.headers); if (token) headers.set("Authorization", `Bearer ${token}`);
    if (token) {
      let bodyTenantId = "";
      if (typeof options.body === "string") { try { bodyTenantId = String(JSON.parse(options.body).tenantId || ""); } catch {} }
      headers.set("X-Sentinel-Tenant-Id", new URL(path, baseUrl).searchParams.get("tenant_id") || bodyTenantId || "TENANT-CHANGAN");
    }
    if (options.body) headers.set("Content-Type", "application/json");
    const response = await fetch(`${baseUrl}${path}`, { ...options, headers }); const body = await response.json(); return { status: response.status, body };
  };
  const login = await loginWithCaptcha((path, options = {}) => request(path, null, options), { account: "operator", password: "Admin-Test#2026", secret: "connector-test-secret" });
  const token = login.body.token;
  const providers = await request("/api/connector-providers", token);
  assert.ok(providers.body.some((item) => item.type === "hunter_asset" && item.supportsSync));
  assert.ok(providers.body.some((item) => item.type === "watchvuln" && item.supportsSync));
  const backgroundTasks = await request("/api/background-tasks", token);
  assert.equal(backgroundTasks.status, 200);
  assert.equal(backgroundTasks.body.timezone, "Asia/Shanghai");
  assert.equal(backgroundTasks.body.catalog.length, 8);
  const sessionCleanup = backgroundTasks.body.catalog.find((item) => item.identifier === "cleanup_expired_sessions");
  assert.equal(sessionCleanup.scheduleType, "interval");
  const configured = await request("/api/background-tasks/cleanup_expired_sessions/schedule", token, { method: "PUT", body: JSON.stringify({ enabled: true, scheduleType: "daily", hour: 8, minute: 30 }) });
  assert.equal(configured.status, 200, JSON.stringify(configured.body));
  assert.equal(configured.body.schedule, "每天 08:30");

  const approvalPolicies = await request("/api/tenant-publication-policies?tenant_id=TENANT-CHANGAN", token, { method: "PUT", body: JSON.stringify({ policies: [{ module: "vulnerabilities", mode: "approval" }] }) });
  assert.equal(approvalPolicies.status, 200, JSON.stringify(approvalPolicies.body));

  const connection = await request("/api/connections", token, { method: "POST", body: JSON.stringify({ name: "Hunter 测试", providerType: "hunter_asset", category: "互联网资产", endpoint: `http://127.0.0.1:${upstreamPort}`, method: "GET", apiKey: "hunter-test-key", targetId: "OBJ-CHANGAN", config: { query: "domain=\"example.com\"", pageSize: 20 } }) });
  assert.equal(connection.status, 201, JSON.stringify(connection.body));
  assert.equal(connection.body.providerType, "hunter_asset");
  assert.equal(connection.body.apiKeyConfigured, true);
  assert.equal(JSON.stringify(connection.body).includes("hunter-test-key"), false);

  const synced = await request(`/api/connections/${connection.body.id}/sync`, token, { method: "POST" });
  assert.equal(synced.status, 202, JSON.stringify(synced.body));
  const managedJobId = synced.body.run.jobId;
  let runs = await waitForRun((path) => request(path, token), managedJobId, 1);
  assert.equal(runs[0].status, "成功");
  assert.equal(runs[0].result.inserted, 1);
  assert.ok(new Date(runs[0].startedAt).getTime() - new Date(runs[0].requestedAt).getTime() < 5_000, "BullMQ 应在 5 秒内领取新任务");
  const hunterAssets = await request(`/api/ingestion/records?type=asset&query=${encodeURIComponent("hunter.example.com")}`, token);
  const hunterAsset = hunterAssets.body.data[0];
  assert.equal(hunterAsset.fields.alive, "true");
  assert.equal(hunterAsset.fields.statusCode, "200");
  assert.equal((await request("/api/ingestion/records/bulk-action", token, { method: "POST", body: JSON.stringify({ type: "asset", action: "publish", ids: [hunterAsset.id] }) })).status, 200);

  hunterRecord = { ...hunterRecord, title: "Hunter 仅元数据变化" };
  const metadataSync = await request(`/api/connections/${connection.body.id}/sync`, token, { method: "POST" });
  await waitForRun((path) => request(path, token), metadataSync.body.run.jobId, 1);
  const metadataAsset = (await request(`/api/ingestion/records?type=asset&query=${encodeURIComponent("hunter.example.com")}`, token)).body.data[0];
  assert.equal(metadataAsset.changeType, "unchanged");
  assert.equal(metadataAsset.isPublished, true);

  hunterRecord = { ...hunterRecord, alive: false, status_code: 503 };
  const stateSync = await request(`/api/connections/${connection.body.id}/sync`, token, { method: "POST" });
  await waitForRun((path) => request(path, token), stateSync.body.run.jobId, 1);
  const changedHunterAsset = (await request(`/api/ingestion/records?type=asset&query=${encodeURIComponent("hunter.example.com")}`, token)).body.data[0];
  assert.equal(changedHunterAsset.changeType, "changed");
  assert.equal(changedHunterAsset.isPublished, false);
  assert.equal(changedHunterAsset.previousFields.alive, "true");
  assert.equal(changedHunterAsset.previousFields.statusCode, "200");
  assert.equal(changedHunterAsset.fields.alive, "false");
  assert.equal(changedHunterAsset.fields.statusCode, "503");
  const health = await request("/health");
  assert.deepEqual(health.body, { ok: true, service: "sentinel-api-server" });

  const watchConnection = await request("/api/connections", token, { method: "POST", body: JSON.stringify({ name: "WatchVuln 测试", providerType: "watchvuln", category: "漏洞情报", endpoint: `http://127.0.0.1:${upstreamPort}`, method: "GET", apiKey: "watchvuln-feed-test-token", targetId: "OBJ-CHANGAN", config: { pageSize: 1, maxPages: 10, incremental: true, autoPublish: false } }) });
  assert.equal(watchConnection.status, 201, JSON.stringify(watchConnection.body));
  assert.equal(watchConnection.body.providerType, "watchvuln");
  const watchTest = await request(`/api/connections/${watchConnection.body.id}/test`, token, { method: "POST" });
  assert.equal(watchTest.status, 200, JSON.stringify(watchTest.body));
  assert.equal(watchTest.body.subscriptionCount, 2);
  const watchSync = await request(`/api/connections/${watchConnection.body.id}/sync`, token, { method: "POST" });
  assert.equal(watchSync.status, 202, JSON.stringify(watchSync.body));
  const watchRuns = await waitForRun((path) => request(path, token), watchSync.body.run.jobId, 1);
  assert.equal(watchRuns[0].status, "成功");
  assert.equal(watchRuns[0].result.inserted, 2);
  assert.equal(watchRuns[0].result.backfill, true);
  assert.equal(watchRuns[0].result.feedTotal, 2);
  const vulnerabilityIntelligence = await request(`/api/intelligence?type=${encodeURIComponent("漏洞情报")}`, token);
  assert.equal(vulnerabilityIntelligence.status, 200, JSON.stringify(vulnerabilityIntelligence.body));
  assert.equal(vulnerabilityIntelligence.body.total, 0, "连接器同步的数据在审核发布前不能进入情报前台");
  const draftVulnerabilities = await request("/api/vulnerabilities?page_size=10", token);
  assert.equal(draftVulnerabilities.body.total, 2);
  assert.ok(draftVulnerabilities.body.data.every((item) => !item.isPublished && !item.reviewedAt));
  const bulkPublished = await request("/api/vulnerabilities/publish-all", token, { method: "POST", body: JSON.stringify({ tenantId: "TENANT-CHANGAN" }) });
  assert.equal(bulkPublished.status, 200, JSON.stringify(bulkPublished.body));
  assert.equal(bulkPublished.body.published, 2);
  assert.equal(bulkPublished.body.publishedTotal, 2);
  assert.equal(bulkPublished.body.tenants, 1);
  const republished = await request("/api/vulnerabilities/publish-all", token, { method: "POST", body: JSON.stringify({ tenantId: "TENANT-CHANGAN" }) });
  assert.equal(republished.status, 200, JSON.stringify(republished.body));
  assert.equal(republished.body.published, 0);
  assert.equal(republished.body.publishedTotal, 2);
  const publishedVulnerabilityIntelligence = await request(`/api/intelligence?type=${encodeURIComponent("漏洞情报")}`, token);
  assert.equal(publishedVulnerabilityIntelligence.body.total, 2);
  assert.ok(publishedVulnerabilityIntelligence.body.data.some((item) => item.entities.includes("CVE-2026-1001")));
  assert.ok(publishedVulnerabilityIntelligence.body.data.every((item) => item.organization === "未关联资产"));

  const automaticPolicies = await request("/api/tenant-publication-policies?tenant_id=TENANT-CHANGAN", token, { method: "PUT", body: JSON.stringify({ policies: [{ module: "vulnerabilities", mode: "auto" }] }) });
  assert.equal(automaticPolicies.status, 200, JSON.stringify(automaticPolicies.body));

  const autoPublishConnection = await request("/api/connections", token, { method: "POST", body: JSON.stringify({ name: "WatchVuln 自动发布测试", providerType: "watchvuln", category: "漏洞情报", endpoint: `http://127.0.0.1:${upstreamPort}`, method: "GET", apiKey: "watchvuln-auto-publish-test-token", targetId: "OBJ-CHANGAN", config: { pageSize: 10, maxPages: 10, incremental: false } }) });
  assert.equal(autoPublishConnection.status, 201, JSON.stringify(autoPublishConnection.body));
  assert.equal(autoPublishConnection.body.config.autoPublish, true);
  const autoPublishSync = await request(`/api/connections/${autoPublishConnection.body.id}/sync`, token, { method: "POST" });
  assert.equal(autoPublishSync.status, 202, JSON.stringify(autoPublishSync.body));
  const autoPublishRuns = await waitForRun((path) => request(path, token), autoPublishSync.body.run.jobId, 1);
  assert.equal(autoPublishRuns[0].status, "成功");
  assert.equal(autoPublishRuns[0].result.status, "已发布");
  assert.equal(autoPublishRuns[0].result.autoPublished, 1);
  assert.ok(Array.isArray(autoPublishRuns[0].result.alerts.snapshots));
  const publishedAfterAutoSync = await request(`/api/intelligence?type=${encodeURIComponent("漏洞情报")}`, token);
  assert.equal(publishedAfterAutoSync.body.total, 3);
  assert.ok(publishedAfterAutoSync.body.data.some((item) => item.entities.includes("CVE-2026-2001")));
  const autoPublishedRecord = (await request("/api/vulnerabilities?query=CVE-2026-2001", token)).body.data[0];
  const editedAndPublished = await request(`/api/vulnerabilities/${encodeURIComponent(autoPublishedRecord.id)}`, token, { method: "PUT", body: JSON.stringify({
    cve: autoPublishedRecord.cve, title: "运营平台修订后的漏洞标题", summary: autoPublishedRecord.summary, risk: autoPublishedRecord.risk,
    source: autoPublishedRecord.source, disclosureAt: autoPublishedRecord.disclosureAt, solutions: autoPublishedRecord.solutions,
    references: autoPublishedRecord.references, tags: autoPublishedRecord.tags, status: autoPublishedRecord.status, publish: true
  }) });
  assert.equal(editedAndPublished.status, 200, JSON.stringify(editedAndPublished.body));
  assert.equal(editedAndPublished.body.isPublished, true);
  assert.equal(editedAndPublished.body.title, "运营平台修订后的漏洞标题");
  const manuallyCreated = await request("/api/vulnerabilities", token, { method: "POST", body: JSON.stringify({
    targetId: "OBJ-CHANGAN", cve: "CVE-2026-3001", title: "运营平台手工新增漏洞", summary: "人工补充的漏洞情报。", risk: "high",
    source: "手工维护", solutions: "升级到安全版本", references: [], tags: ["人工补充"], status: "待处置", publish: true
  }) });
  assert.equal(manuallyCreated.status, 201, JSON.stringify(manuallyCreated.body));
  assert.equal(manuallyCreated.body.isPublished, true);
  assert.equal(manuallyCreated.body.manuallyManaged, true);
  const bulkDraft = await request("/api/vulnerabilities", token, { method: "POST", body: JSON.stringify({
    targetId: "OBJ-CHANGAN", cve: "CVE-2026-3002", title: "批量操作待发布漏洞", risk: "medium", source: "批量操作测试", status: "待处置", publish: false
  }) });
  assert.equal(bulkDraft.status, 201, JSON.stringify(bulkDraft.body));
  assert.equal(bulkDraft.body.isPublished, false);
  const bulkFilteredPublish = await request("/api/vulnerabilities/bulk-action", token, { method: "POST", body: JSON.stringify({
    action: "publish", allMatching: true, tenantId: "TENANT-CHANGAN", source: "批量操作测试", publication: "draft"
  }) });
  assert.equal(bulkFilteredPublish.status, 200, JSON.stringify(bulkFilteredPublish.body));
  assert.equal(bulkFilteredPublish.body.matched, 1);
  assert.equal(bulkFilteredPublish.body.published, 1);
  const bulkFilteredDelete = await request("/api/vulnerabilities/bulk-action", token, { method: "POST", body: JSON.stringify({
    action: "delete", allMatching: true, tenantId: "TENANT-CHANGAN", source: "批量操作测试"
  }) });
  assert.equal(bulkFilteredDelete.status, 200, JSON.stringify(bulkFilteredDelete.body));
  assert.equal(bulkFilteredDelete.body.deleted, 1);

  const credentialConnection = await request("/api/connections", token, { method: "POST", body: JSON.stringify({ name: "凭据分页测试", providerType: "darkweb_subscription", category: "凭据泄露", endpoint: `http://127.0.0.1:${upstreamPort}`, method: "POST", apiKey: "credential-test-key", targetId: "OBJ-CHANGAN", config: { pageSize: 20, maxPages: 20 } }) });
  assert.equal(credentialConnection.status, 201, JSON.stringify(credentialConnection.body));
  const credentialSync = await request(`/api/connections/${credentialConnection.body.id}/sync`, token, { method: "POST" });
  assert.equal(credentialSync.status, 202, JSON.stringify(credentialSync.body));
  const credentialRuns = await waitForRun((path) => request(path, token), credentialSync.body.run.jobId, 1);
  assert.equal(credentialRuns[0].status, "成功", JSON.stringify(credentialRuns[0]));
  assert.equal(credentialRuns[0].result.records, 205);
  assert.deepEqual(credentialPages, [1, 2, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  const credentialSubscriptions = await request("/api/credentials/subscriptions", token);
  const storedCredentialSubscription = credentialSubscriptions.body.find((item) => item.targetId === "OBJ-CHANGAN" && item.value === "credential.example.com" && item.storedCount === 205);
  assert.ok(Number.isSafeInteger(storedCredentialSubscription?.id));
  assert.ok(storedCredentialSubscription.id >= 4_000_000_000_000_000);
  const credentialResults = await request(`/api/credentials/results?sub_id=${storedCredentialSubscription.id}&page=3&page_size=100`, token);
  assert.equal(credentialResults.status, 200, JSON.stringify(credentialResults.body));
  assert.equal(credentialResults.body.total, 205);
  assert.equal(credentialResults.body.data.length, 5);
  assert.equal(credentialResults.body.data[0].sequence, 201);

  const secondCredentialConnection = await request("/api/connections", token, { method: "POST", body: JSON.stringify({ name: "第二凭据数据源", providerType: "darkweb_subscription", category: "凭据泄露", endpoint: `http://127.0.0.1:${upstreamPort}`, method: "POST", apiKey: "credential-test-key", targetId: "OBJ-CHANGAN", config: { pageSize: 20, maxPages: 20 } }) });
  assert.equal(secondCredentialConnection.status, 201, JSON.stringify(secondCredentialConnection.body));
  const secondCredentialSync = await request(`/api/connections/${secondCredentialConnection.body.id}/sync`, token, { method: "POST" });
  assert.equal(secondCredentialSync.status, 202, JSON.stringify(secondCredentialSync.body));
  const secondCredentialRuns = await waitForRun((path) => request(path, token), secondCredentialSync.body.run.jobId, 1);
  assert.equal(secondCredentialRuns[0].status, "成功", JSON.stringify(secondCredentialRuns[0]));
  assert.equal(secondCredentialRuns[0].result.records, 205);
  const identityInspection = new pg.Client({ connectionString: databaseUrl });
  await identityInspection.connect();
  await identityInspection.query(`SET search_path TO "${schema}",public`);
  const isolatedSubscriptions = await identityInspection.query("SELECT COUNT(*)::int AS count,COUNT(DISTINCT source_connection_id)::int AS sources FROM credential_subscriptions WHERE tenant_id='TENANT-CHANGAN' AND upstream_id='901'");
  const isolatedRecords = await identityInspection.query("SELECT COUNT(*)::int AS count,COUNT(DISTINCT source_connection_id)::int AS sources FROM credential_records WHERE tenant_id='TENANT-CHANGAN' AND upstream_id='credential-1'");
  await identityInspection.end();
  assert.deepEqual(isolatedSubscriptions.rows[0], { count: 2, sources: 2 });
  assert.deepEqual(isolatedRecords.rows[0], { count: 2, sources: 2 });

  const job = await request("/api/collection-jobs", token, { method: "POST", body: JSON.stringify({ connectionId: connection.body.id, name: "Hunter 定时采集", intervalMinutes: 60, retryLimit: 1, enabled: false }) });
  assert.equal(job.status, 201, JSON.stringify(job.body));
  assert.equal(job.body.id, managedJobId);
  assert.equal(job.body.enabled, false);
  const updatedJob = await request(`/api/collection-jobs/${job.body.id}`, token, { method: "PUT", body: JSON.stringify({ name: "Hunter 五分钟采集", enabled: true, intervalMinutes: 5, timeoutSeconds: 30, retryLimit: 1 }) });
  assert.equal(updatedJob.status, 200, JSON.stringify(updatedJob.body));
  assert.equal(updatedJob.body.intervalMinutes, 5);
  assert.equal(updatedJob.body.enabled, true);
  assert.ok(new Date(updatedJob.body.nextRunAt).getTime() > Date.now());

  const run = await request(`/api/collection-jobs/${job.body.id}/run`, token, { method: "POST" });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  runs = await waitForRun((path) => request(path, token), job.body.id, 4);
  assert.equal(runs.length, 4);
  assert.equal(runs[0].status, "成功");
  assert.equal(runs[0].result.updated, 1);
  assert.ok(new Date(runs[0].startedAt).getTime() - new Date(runs[0].requestedAt).getTime() < 5_000, "持续运行的 Worker 不应依赖重启领取任务");

  const scheduledFor = new Date(Date.now() - 60_000).toISOString();
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  await client.query(`SET search_path TO "${schema}",public`);
  await client.query("UPDATE collection_jobs SET enabled=1,next_run_at=$1 WHERE id=$2", [scheduledFor, job.body.id]);
  const dispatchScheduled = await request("/api/background-tasks/dispatch_due_collection_jobs/run", token, { method: "POST" });
  assert.equal(dispatchScheduled.status, 202, JSON.stringify(dispatchScheduled.body));
  await client.end();
  try { runs = await waitForRun((path) => request(path, token), job.body.id, 5); }
  catch (error) { throw new Error(`${error.message}${workerError ? `\nWorker stderr:\n${workerError}` : ""}`); }
  assert.equal(runs[0].triggerType, "schedule");
  const scheduledJob = await request("/api/collection-jobs", token);
  assert.ok(new Date(scheduledJob.body.find((item) => item.id === job.body.id).nextRunAt).getTime() > Date.now());

  const maintenanceClient = new pg.Client({ connectionString: databaseUrl });
  await maintenanceClient.connect();
  await maintenanceClient.query(`SET search_path TO "${schema}",public`);
  await maintenanceClient.query("INSERT INTO sessions(token_hash,account,expires_at,created_at) VALUES('expired-test-session','operator','2000-01-01T00:00:00.000Z','2000-01-01T00:00:00.000Z')");
  const immediateMaintenance = await request("/api/background-tasks/cleanup_expired_sessions/run", token, { method: "POST" });
  assert.equal(immediateMaintenance.status, 202);
  assert.ok(immediateMaintenance.body.jobId);
  const sessionDeadline = Date.now() + 15_000;
  while (Date.now() < sessionDeadline) {
    const expired = await maintenanceClient.query("SELECT COUNT(*)::int AS count FROM sessions WHERE token_hash='expired-test-session'");
    if (expired.rows[0].count === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  assert.equal((await maintenanceClient.query("SELECT COUNT(*)::int AS count FROM sessions WHERE token_hash='expired-test-session'")).rows[0].count, 0);

  await maintenanceClient.query("UPDATE collection_runs SET updated_at='2000-01-01T00:00:00.000Z' WHERE id=ANY($1)", [runs.slice(1).map((item) => item.id)]);
  const cleanupHistory = await request("/api/background-tasks/cleanup_business_task_history/run", token, { method: "POST" });
  assert.equal(cleanupHistory.status, 202, JSON.stringify(cleanupHistory.body));
  const maintenanceDeadline = Date.now() + 15_000;
  while (Date.now() < maintenanceDeadline) {
    const history = await maintenanceClient.query("SELECT COUNT(*)::int AS count FROM collection_runs WHERE job_id=$1", [job.body.id]);
    if (history.rows[0].count === 1) break;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  assert.equal((await maintenanceClient.query("SELECT COUNT(*)::int AS count FROM collection_runs WHERE job_id=$1", [job.body.id])).rows[0].count, 1);
  await maintenanceClient.end();

  failuresRemaining = 1;
  const retried = await request(`/api/collection-jobs/${job.body.id}/run`, token, { method: "POST" });
  assert.equal(retried.status, 202);
  runs = await waitForRun((path) => request(path, token), job.body.id, 2);
  assert.equal(runs[0].status, "成功");
  assert.equal(runs[0].attempt, 2);
  const observedRuns = await request(`/api/background-runs?tenant_id=TENANT-CHANGAN&aggregate_id=${encodeURIComponent(runs[0].id)}`, token);
  assert.equal(observedRuns.status, 200, JSON.stringify(observedRuns.body));
  assert.equal(observedRuns.body.items.length, 1);
  assert.equal(observedRuns.body.items[0].tenantId, "TENANT-CHANGAN");
  assert.equal(observedRuns.body.items[0].state, "succeeded");
  assert.equal(observedRuns.body.items[0].attemptCount, 2);
  const runDetail = await request(`/api/background-runs/${encodeURIComponent(observedRuns.body.items[0].bullmqJobId)}`, token);
  assert.equal(runDetail.status, 200, JSON.stringify(runDetail.body));
  assert.equal(runDetail.body.attempts.length, 2);
  assert.equal(runDetail.body.attempts[0].state, "retrying");
  assert.equal(runDetail.body.attempts[0].willRetry, true);
  assert.deepEqual(runDetail.body.attempts[0].error, { message: "任务执行失败，请检查配置后重试" });
  assert.equal(runDetail.body.attempts[0].error.type, undefined);
  assert.equal(runDetail.body.attempts[0].error.upstreamStatus, undefined);
  assert.equal(runDetail.body.attempts[0].error.upstreamOrigin, undefined);
  assert.equal(runDetail.body.attempts[0].error.upstreamPath, undefined);
  assert.equal(runDetail.body.attempts[1].state, "succeeded");
  assert.equal(JSON.stringify(runDetail.body).includes("hunter-test-key"), false);
  const observedOverview = await request("/api/background-tasks", token);
  assert.ok(observedOverview.body.observability.lastHour.jobs > 0);
  assert.ok(observedOverview.body.observability.lastHour.retryAttempts > 0);
});
