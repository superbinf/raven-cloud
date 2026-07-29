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

test("统一情报、真实看板和案件接口只聚合数据库记录", async (t) => {
  const dataDir = await mkdtemp(join(os.tmpdir(), "sentinel-aggregation-test-"));
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const databaseUrl = process.env.DATABASE_URL || "postgresql://sentinel:sentinel-local-password@127.0.0.1:5432/sentinel";
  const schema = `sentinel_test_aggregation_${process.pid}_${port}`;
  const child = spawn(process.execPath, [join(apiRoot, "src/server.mjs")], {
    cwd: join(apiRoot, "../.."),
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_URL: databaseUrl,
      SENTINEL_DB_SCHEMA: schema,
      SENTINEL_DATA_DIR: dataDir,
      SENTINEL_SECRET: "aggregation-test-secret",
      SENTINEL_ADMIN_ACCOUNT: "operator",
      SENTINEL_ADMIN_PASSWORD: "Admin-Test#2026",
      SENTINEL_PORTAL_ACCOUNT: "analyst",
      SENTINEL_PORTAL_PASSWORD: "Portal-Test#2026"
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

  const since = new Date().toISOString();
  const now = new Date(Date.now() + 10).toISOString();
  const database = new pg.Client({ connectionString: databaseUrl });
  await database.connect();
  await database.query(`SET search_path TO "${schema}", public`);
  const credentialSubscription = await database.query("SELECT id FROM credential_subscriptions ORDER BY id LIMIT 1");
  assert.equal(credentialSubscription.rowCount, 1);
  await database.query(`INSERT INTO credential_records
    (id,sub_id,url,system_name,account,password,leaked_at,source,raw_json,first_seen_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [
    "CRED-AGGREGATION-TEST", credentialSubscription.rows[0].id, "https://today.example.test/login", "今日测试系统",
    "today@example.test", "Today-Test#2026", now, "aggregation-test", "{}", now
  ]);
  await database.query(`INSERT INTO sensitive_records
    (id,category,target_id,title,risk,fields_json,record_hash,first_seen_at,last_seen_at,import_status,import_count,batch_id,status,tenant_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`, [
    "SENS-AGGREGATION-TEST", "source-code", "OBJ-CHANGAN", "真实源码泄露记录", "高",
    JSON.stringify({ name: "真实源码泄露记录", content: "公开仓库出现内部代码片段", channel: "代码托管平台" }),
    "aggregation-sensitive-hash", now, now, "新增", 1, null, "待处置", "TENANT-CHANGAN"
  ]);
  await database.query(`INSERT INTO asset_records
    (id,category,target_id,title,risk,fields_json,record_hash,first_seen_at,last_seen_at,import_status,import_count,batch_id,status,tenant_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`, [
    "ASSET-AGGREGATION-TEST", "server", "OBJ-CHANGAN", "198.51.100.27:8443", "中",
    JSON.stringify({ address: "198.51.100.27", port: "8443", protocol: "https", serviceType: "管理服务", geo: { province: "四川省", city: "成都市" } }),
    "aggregation-asset-hash", now, now, "新增", 1, null, "研判中", "TENANT-CHANGAN"
  ]);
  await database.query(`INSERT INTO ingestion_batches
    (id,file_name,target_id,status,total_rows,new_rows,duplicate_rows,sheet_summary_json,created_at,ingestion_type,tenant_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, ["BATCH-DARK-TEST", "真实暗网交付.zip", "OBJ-CHANGAN", "已发布", 1, 1, 0, "[]", now, "dark-web", "TENANT-CHANGAN"]);
  await database.query(`INSERT INTO dark_web_events
    (id,target_id,latest_batch_id,title,report_date,source_group_name,source_group_id,source_group_url,message_url,
     leak_data_types,leak_count,transaction_count,transaction_price,published_at,publisher_id,intel_note,event_hash,first_seen_at,last_seen_at,import_count,tenant_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`, [
    "DARK-AGGREGATION-TEST", "OBJ-CHANGAN", "BATCH-DARK-TEST", "真实暗网数据泄露事件", now.slice(0, 10),
    "示例威胁组织", "group-001", "https://example.invalid/group", "https://example.invalid/message",
    "客户资料、内部文档", "100", "1", "未知", now, "publisher-001", "报告确认存在真实交付事件。",
    "aggregation-dark-hash", now, now, 1, "TENANT-CHANGAN"
  ]);
  await database.end();

  const request = async (path, { token, ...options } = {}) => {
    const headers = new Headers(options.headers);
    if (token) headers.set("Authorization", `Bearer ${token}`);
    if (token) headers.set("X-Sentinel-Tenant-Id", new URL(path, baseUrl).searchParams.get("tenant_id") || "TENANT-CHANGAN");
    if (options.body) headers.set("Content-Type", "application/json");
    const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
    const body = await response.json();
    return { status: response.status, body };
  };
  const login = (account, password) => loginWithCaptcha(request, { account, password, secret: "aggregation-test-secret" });
  const admin = (await login("operator", "Admin-Test#2026")).body.token;
  const portal = (await login("analyst", "Portal-Test#2026")).body.token;

  assert.equal((await request("/api/intelligence")).status, 401);
  const intelligence = await request("/api/intelligence?page=1&page_size=20", { token: portal });
  assert.equal(intelligence.status, 200, JSON.stringify(intelligence.body));
  assert.equal(intelligence.body.total, 3);
  assert.ok(intelligence.body.data.some((item) => item.id === "SENS-AGGREGATION-TEST" && item.type === "敏感泄露" && item.risk === "high"));
  assert.ok(intelligence.body.data.some((item) => item.id === "ASSET-AGGREGATION-TEST" && item.type === "暴露面"));
  assert.ok(!JSON.stringify(intelligence.body).includes("DemoOnly!2026"));

  const withoutExposure = await request(`/api/intelligence?exclude_type=${encodeURIComponent("暴露面")}`, { token: portal });
  assert.equal(withoutExposure.status, 200);
  assert.ok(withoutExposure.body.total < intelligence.body.total);
  assert.ok(withoutExposure.body.data.every((item) => item.type !== "暴露面"));
  const exposureOnly = await request(`/api/intelligence?type=${encodeURIComponent("暴露面")}`, { token: portal });
  assert.equal(exposureOnly.status, 200);
  assert.ok(exposureOnly.body.data.every((item) => item.type === "暴露面"));

  const credentials = await request(`/api/intelligence?subtype=${encodeURIComponent("凭据泄露")}`, { token: portal });
  assert.equal(credentials.status, 200);
  assert.equal(credentials.body.total, 0);
  const subscriptions = await request(`/api/credentials/subscriptions?since=${encodeURIComponent(since)}`, { token: portal });
  assert.equal(subscriptions.status, 200);
  assert.equal(subscriptions.body.find((item) => item.id === credentialSubscription.rows[0].id).todayNewCount, 1);
  const todayCredentials = await request(`/api/credentials/results?sub_id=${credentialSubscription.rows[0].id}&page=1&page_size=10&since=${encodeURIComponent(since)}&today_only=1`, { token: portal });
  assert.equal(todayCredentials.body.total, 1);
  assert.equal(todayCredentials.body.allTotal >= 1, true);
  assert.equal(todayCredentials.body.todayNewCount, 1);
  assert.equal(todayCredentials.body.data[0].id, "CRED-AGGREGATION-TEST");
  const darkWeb = await request(`/api/intelligence?subtype=${encodeURIComponent("暗网情报")}`, { token: portal });
  assert.equal(darkWeb.body.total, 1);
  assert.equal(darkWeb.body.data[0].id, "DARK-AGGREGATION-TEST");
  const darkWebOverview = await request(`/api/intelligence?type=${encodeURIComponent("暗网情报")}&include_risk_counts=1`, { token: portal });
  assert.equal(darkWebOverview.body.total, 1);
  assert.deepEqual(darkWebOverview.body.riskCounts, { critical: 0, high: 0, medium: 0, low: 1, info: 0 });
  assert.ok(darkWebOverview.body.data.some((item) => item.id === "DARK-AGGREGATION-TEST"));
  const todaySourceCode = await request(`/api/intelligence?subtype=${encodeURIComponent("源码泄露")}&since=${encodeURIComponent(since)}&today_only=1`, { token: portal });
  assert.equal(todaySourceCode.body.total, 1);
  assert.equal(todaySourceCode.body.allTotal, 1);
  assert.equal(todaySourceCode.body.todayNewCount, 1);
  assert.equal(todaySourceCode.body.data[0].id, "SENS-AGGREGATION-TEST");
  const filtered = await request(`/api/intelligence?query=${encodeURIComponent("真实源码")}&risk=high`, { token: portal });
  assert.equal(filtered.body.total, 1);
  assert.equal(filtered.body.data[0].id, "SENS-AGGREGATION-TEST");
  const keyRisks = await request("/api/intelligence?risk=critical%2Chigh", { token: portal });
  assert.equal(keyRisks.status, 200);
  assert.ok(keyRisks.body.total > 0);
  assert.ok(keyRisks.body.data.every((item) => ["critical", "high"].includes(item.risk)));
  assert.equal((await request("/api/intelligence/not-found", { token: portal })).status, 404);

  const portalDashboard = await request(`/api/dashboard/portal?since=${encodeURIComponent(since)}`, { token: portal });
  assert.equal(portalDashboard.status, 200);
  assert.equal(portalDashboard.body.trendData.length, 7);
  assert.deepEqual(portalDashboard.body.riskCounts, { critical: 0, high: 1, medium: 1, low: 1, info: 0 });
  assert.ok(portalDashboard.body.metrics.every((metric) => !String(metric.value).includes(",")));
  assert.deepEqual(Object.fromEntries(portalDashboard.body.sourceDistribution.map((item) => [item.name, item.value])), {
    "暗网情报": 1,
    "互联网暴露面": 1,
    "敏感信息": 1,
    "账号凭据": 4
  });
  assert.ok(portalDashboard.body.sourceDistribution.every((item) => ["暗网情报", "互联网暴露面", "敏感信息", "账号凭据", "漏洞情报"].includes(item.name)));
  assert.deepEqual(portalDashboard.body.exposureData, [{ label: "服务器", value: 1 }]);
  assert.deepEqual(portalDashboard.body.regionDistribution, [{ name: "四川", value: 1, risk: "medium", coordinate: [104.07, 30.67] }]);
  assert.ok(portalDashboard.body.latest.some((item) => item.id === "SENS-AGGREGATION-TEST"));
  assert.equal(portalDashboard.body.criticalTotal, portalDashboard.body.critical.length);
  assert.ok(portalDashboard.body.critical.every((item) => item.subtype === "资产漏洞告警"));
  assert.ok(portalDashboard.body.latest.every((item) => !["漏洞情报", "暴露面", "仿冒网站"].includes(item.type)));
  assert.deepEqual(portalDashboard.body.todayNew, {
    darkWebIntelligence: 1,
    credentialLeaks: 1,
    accountPassword: 0,
    sourceCode: 1,
    documents: 0,
    assets: 1,
    phishing: 0,
    vulnerabilities: 0
  });
  assert.equal((await request("/api/edge/tenants", { token: admin, method: "POST", body: JSON.stringify({ id: "TENANT-WITHOUT-REGIONS", name: "无区域数据租户" }) })).status, 201);
  const emptyTenantDashboard = await request("/api/dashboard/portal?tenant_id=TENANT-WITHOUT-REGIONS&include_drafts=1", { token: admin });
  assert.equal(emptyTenantDashboard.status, 200);
  assert.deepEqual(emptyTenantDashboard.body.regionDistribution, []);
  assert.equal((await request("/api/dashboard/admin", { token: portal })).status, 403);

  const adminDashboard = await request("/api/dashboard/admin", { token: admin });
  assert.equal(adminDashboard.status, 200);
  assert.equal(adminDashboard.body.trendData.length, 7);
  assert.ok(adminDashboard.body.health.some((item) => item.name === "PostgreSQL 数据库" && item.status === "正常"));
});
