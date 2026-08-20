import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { verifyAndDecryptSnapshot } from "@sentinel/distribution";
import pg from "pg";
import { loginWithCaptcha } from "./support/captcha.mjs";
import { readArticleImageFromDirectories } from "../src/article-images.mjs";
import { createSnapshotJobQueue, createSnapshotTaskList, SNAPSHOT_TASK } from "../src/modules/cloud-edge/job-queue.mjs";

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

test("快照契约错误立即终止且不进入重试", async () => {
  const events = [];
  const error = Object.assign(new Error("invalid snapshot"), { retryable: false });
  const repository = {
    getSnapshotJob: async () => ({ id: "SNAPJOB-PERMANENT", deploymentId: "EDGE-1", force: false, status: "queued" }),
    startSnapshotJob: async () => events.push("start"),
    completeSnapshotJob: async () => events.push("complete"),
    retrySnapshotJob: async () => events.push("retry"),
    failSnapshotJob: async () => events.push("failed")
  };
  const tasks = createSnapshotTaskList({ repository, service: { buildSnapshot: async () => { throw error; } } });
  await assert.rejects(tasks[SNAPSHOT_TASK]({ operationId: "SNAPJOB-PERMANENT" }, { attempt: 1, maxAttempts: 5 }), error);
  assert.deepEqual(events, ["start", "failed"]);
});

test("快照调度仅为达到部署配置周期的实例创建任务", async () => {
  const created = [];
  const outboxJobs = [];
  const repository = {
    async listDueSnapshotDeploymentIds(now) {
      assert.ok(Number.isFinite(Date.parse(now)));
      return ["EDGE-DUE"];
    },
    async getDeployment(id) { return { id, tenantId: "TENANT-CHANGAN" }; },
    async activeSnapshotJob() { return null; },
    async createSnapshotJob(row) { created.push(row); },
    async getSnapshotJob(id) { return { id, deploymentId: "EDGE-DUE", status: "queued" }; }
  };
  const queue = await createSnapshotJobQueue({
    db: { async transaction(callback) { return callback(); } },
    repository,
    outbox: { async enqueue(job) { outboxJobs.push(job); } }
  });

  await queue.enqueueEnabled();

  assert.equal(created.length, 1);
  assert.equal(created[0].deploymentId, "EDGE-DUE");
  assert.equal(created[0].triggerType, "schedule");
  assert.equal(outboxJobs.length, 1);
  assert.equal(outboxJobs[0].tenantId, "TENANT-CHANGAN");
  assert.equal(outboxJobs[0].payload.tenantId, "TENANT-CHANGAN");
});

test("云端部署凭证、租户隔离和可配置 API 快照形成闭环", async (t) => {
  const dataDir = await mkdtemp(join(os.tmpdir(), "sentinel-cloud-edge-test-"));
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const databaseUrl = process.env.DATABASE_URL || "postgresql://sentinel:sentinel-local-password@127.0.0.1:5432/sentinel";
  const schema = `sentinel_test_cloud_edge_${process.pid}_${port}`;
  const legacyDataDir = join(dataDir, "legacy-data");
  const serviceEnv = {
    ...process.env,
    PORT: String(port), DATABASE_URL: databaseUrl, SENTINEL_DB_SCHEMA: schema, SENTINEL_DATA_DIR: dataDir,
    SENTINEL_PUBLIC_BASE_URL: baseUrl, SENTINEL_SECRET: "cloud-edge-master-secret-for-tests-2026",
    SENTINEL_ADMIN_ACCOUNT: "operator", SENTINEL_ADMIN_PASSWORD: "Admin-Test#2026",
    SENTINEL_PORTAL_ACCOUNT: "analyst", SENTINEL_PORTAL_PASSWORD: "Portal-Test#2026",
    SENTINEL_LEGACY_DATA_DIR: legacyDataDir
  };
  const child = spawn(process.execPath, [join(apiRoot, "src/server.mjs")], {
    cwd: join(apiRoot, "../.."),
    env: serviceEnv,
    stdio: ["ignore", "ignore", "pipe"]
  });
  const children = [child];
  let stderr = ""; child.stderr.on("data", (chunk) => { stderr += chunk; });
  t.after(async () => {
    await Promise.all(children.map((processChild) => {
      if (processChild.exitCode !== null) return Promise.resolve();
      processChild.kill("SIGTERM");
      return new Promise((resolve) => processChild.once("exit", resolve));
    }));
    const cleanup = new pg.Client({ connectionString: databaseUrl });
    await cleanup.connect(); await cleanup.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await cleanup.end();
    await rm(dataDir, { recursive: true, force: true });
  });
  await waitForApi(baseUrl, child);

  async function request(path, { token, apiKey, deploymentId, deploymentSecret, raw = false, ...options } = {}) {
    const headers = new Headers(options.headers);
    if (token) headers.set("Authorization", `Bearer ${token}`);
    if (deploymentSecret) headers.set("Authorization", `Bearer ${deploymentSecret}`);
    if (apiKey) headers.set("Authorization", `Bearer ${apiKey}`);
    if (deploymentId) headers.set("X-Edge-Deployment-Id", deploymentId);
    if (options.body && typeof options.body === "string") headers.set("Content-Type", "application/json");
    const response = await fetch(path.startsWith("http") ? path : `${baseUrl}${path}`, { ...options, headers });
    if (raw) return { status: response.status, headers: response.headers, body: new Uint8Array(await response.arrayBuffer()) };
    const contentType = response.headers.get("content-type") || "";
    return { status: response.status, headers: response.headers, body: contentType.includes("json") ? await response.json() : await response.text() };
  }

  async function waitForSnapshotJob(id) {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const result = await request(`/api/edge/snapshot-jobs/${id}`, { token: admin });
      if (["succeeded", "failed"].includes(result.body.status)) return result.body;
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    throw new Error(`等待快照任务超时：${id}\n${stderr}`);
  }

  async function waitForBackgroundRunNotice(id) {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const result = await request(`/api/background-runs?aggregate_id=${encodeURIComponent(id)}`, { token: admin });
      if (result.body.items?.[0]?.noticeMessage) return result.body.items[0];
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`等待任务告警超时：${id}`);
  }

  const login = await loginWithCaptcha(request, { account: "operator", password: "Admin-Test#2026", secret: "cloud-edge-master-secret-for-tests-2026" });
  assert.equal(login.status, 200, stderr);
  const admin = login.body.token;
  assert.equal((await request("/api/edge/deployments")).status, 401);
  assert.equal((await request("/api/edge/cloud-tls-certificate")).status, 401);
  const certificateWithoutTls = await request("/api/edge/cloud-tls-certificate", { token: admin });
  assert.equal(certificateWithoutTls.status, 409);
  assert.match(certificateWithoutTls.body.message, /未启用 TLS/u);
  assert.equal((await request("/api/edge/tenants", { token: admin })).status, 200);
  assert.equal((await request("/api/edge/tenants", { token: admin, method: "POST", body: JSON.stringify({ id: "TENANT-SECOND", name: "第二客户" }) })).status, 201);
  const database = new pg.Client({ connectionString: databaseUrl });
  await database.connect(); await database.query(`SET search_path TO "${schema}", public`);
  const now = new Date().toISOString();
  await database.query(`INSERT INTO monitoring_targets (id,name,target_type,owner,domains_json,ips_json,keywords_json,enabled,updated_at,tenant_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, ["OBJ-SECOND", "第二租户目标", "企业", "测试", "[]", "[]", "[]", 1, now, "TENANT-SECOND"]);
  const sensitive = (id, targetId, tenantId) => database.query(`INSERT INTO sensitive_records (id,category,target_id,title,risk,fields_json,record_hash,first_seen_at,last_seen_at,import_status,import_count,batch_id,status,tenant_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`, [id, "documents", targetId, id, "中", "{}", "same-record-hash-across-tenants", now, now, "新增", 1, null, "待处置", tenantId]);
  await sensitive("SENS-FIRST-TENANT", "OBJ-CHANGAN", "TENANT-CHANGAN");
  await sensitive("SENS-SECOND-TENANT", "OBJ-SECOND", "TENANT-SECOND");
  await database.query("UPDATE sensitive_records SET import_status='已发布' WHERE id='SENS-FIRST-TENANT'");
  await database.query(`INSERT INTO vulnerability_records
    (id,tenant_id,target_id,source_key,cve,title,summary,risk,source,source_created_at,source_updated_at,first_seen_at,last_seen_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, ["VULN-EDGE-TEST", "TENANT-CHANGAN", "OBJ-CHANGAN", "CVE-2026-EDGE", "CVE-2026-EDGE", "云地漏洞情报", "用于验证漏洞快照投影", "critical", "WatchVuln_Web", now, now, now, now]);
  await database.query(`INSERT INTO credential_subscriptions
    (id,target_id,sub_type,sub_category,value,expire_time,count,tenant_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [987654321, "OBJ-CHANGAN", "credential-leak", "credential", "timestamp.example", "1772429605000", 1, "TENANT-CHANGAN"]);
  await database.query(`INSERT INTO credential_records
    (id,sub_id,url,system_name,account,password,leaked_at,source,raw_json,tenant_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, ["CRED-EPOCH-TIMESTAMP", 987654321, "https://timestamp.example", "时间戳测试", "tester", "masked", "1772429605", "test", "{}", "TENANT-CHANGAN"]);
  const reportPath = join(dataDir, "reports", "REPORT-EDGE-FILE.html");
  const reportDataPath = join(dataDir, "reports", "REPORT-EDGE-FILE.json");
  const reportContent = Buffer.from(`<html><body>${"complete edge report ".repeat(320)}</body></html>`);
  await writeFile(reportPath, reportContent);
  await writeFile(reportDataPath, JSON.stringify({ websites: [], ports: [], dns: [], icons: [] }));
  await database.query(`INSERT INTO asset_reports (id,target_id,file_name,file_path,data_path,size_bytes,dns_count,port_count,web_count,fingerprint_count,icon_count,created_at,tenant_id)
    VALUES ($1,$2,$3,$4,$5,$6,0,0,0,0,0,$7,$8)`, ["REPORT-EDGE-FILE", "OBJ-CHANGAN", "complete-report.html", reportPath, reportDataPath, reportContent.length, now, "TENANT-CHANGAN"]);
  await database.query(`INSERT INTO fingerprint_icon_library
    (id,fingerprint_name,aliases_json,source,media_type,icon_data,icon_sha256,active,created_by,updated_by,created_at,updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, ["FICON-CN-WEAVER", "泛微协同办公", JSON.stringify(["泛微Ecology-v9"]), "domestic", "image/png", "data:image/png;base64,iVBORw0KGgo=", "7f365b385f1cc1b0ffb17d58e6088e1633141951f1579ea09960fc8368c4f475", true, "test", "test", now, now]);
  await database.end();

  const firstCreated = await request("/api/edge/deployments", { token: admin, method: "POST", body: JSON.stringify({ tenantId: "TENANT-CHANGAN", name: "长安地端", syncMode: "api_pull", pollIntervalSeconds: 300, enabledModules: ["overview", "dark-web", "vulnerabilities"] }) });
  const secondCreated = await request("/api/edge/deployments", { token: admin, method: "POST", body: JSON.stringify({ tenantId: "TENANT-SECOND", name: "第二地端", syncMode: "api_pull", pollIntervalSeconds: 300 }) });
  assert.equal(firstCreated.status, 201, JSON.stringify(firstCreated.body));
  assert.equal(secondCreated.status, 201, JSON.stringify(secondCreated.body));
  const first = firstCreated.body.deployment; const firstApiKey = firstCreated.body.activationConfig.apiKey;
  const firstAuthenticationSecret = firstApiKey.split(".").at(-2); const firstSnapshotSecret = firstApiKey.split(".").at(-1);
  const firstLicenseKey = firstCreated.body.license.licenseKey;
  const second = secondCreated.body.deployment; const secondApiKey = secondCreated.body.activationConfig.apiKey;
  const secondAuthenticationSecret = secondApiKey.split(".").at(-2); const secondSnapshotSecret = secondApiKey.split(".").at(-1);
  assert.equal(firstCreated.body.activationConfig.tenantId, undefined);
  assert.match(firstLicenseKey, /^sentinel-license-v1\./);
  const initialLicenseValidation = await request("/edge/v1/license/validate", { method: "POST", body: JSON.stringify({ licenseKey: firstLicenseKey }) });
  assert.equal(initialLicenseValidation.status, 200);
  assert.equal(initialLicenseValidation.body.valid, true);
  assert.equal(initialLicenseValidation.body.deploymentId, first.id);
  const deploymentJson = JSON.stringify((await request(`/api/edge/deployments/${first.id}`, { token: admin })).body);
  assert.equal(deploymentJson.includes(firstAuthenticationSecret), false);
  assert.equal(deploymentJson.includes(firstSnapshotSecret), false);

  const firstConfig = await request("/edge/v1/config", { apiKey: firstApiKey });
  assert.equal(firstConfig.status, 200);
  assert.equal(firstConfig.body.tenantId, "TENANT-CHANGAN");
  assert.equal(firstConfig.body.enabled, true);
  assert.deepEqual(firstConfig.body.enabledModules, ["overview", "dark-web", "vulnerabilities"]);
  assert.equal(firstConfig.body.license.status, "active");
  const updatedModules = await request(`/api/edge/deployments/${first.id}`, { token: admin, method: "PUT", body: JSON.stringify({ enabledModules: ["sensitive", "exposure"] }) });
  assert.equal(updatedModules.status, 200);
  assert.deepEqual(updatedModules.body.enabledModules, ["sensitive", "exposure"]);
  assert.deepEqual((await request("/edge/v1/config", { apiKey: firstApiKey })).body.enabledModules, ["sensitive", "exposure"]);
  assert.equal((await request(`/api/edge/deployments/${first.id}`, { token: admin, method: "PUT", body: JSON.stringify({ enabledModules: [] }) })).status, 400);
  const renewedExpiry = new Date(Date.now() + 500 * 86400_000).toISOString();
  const renewedLicense = await request(`/api/edge/deployments/${first.id}/license`, { token: admin, method: "PUT", body: JSON.stringify({ expiresAt: renewedExpiry }) });
  assert.equal(renewedLicense.status, 200);
  assert.equal((await request("/edge/v1/config", { apiKey: firstApiKey })).body.license.expiresAt, renewedExpiry);
  assert.equal((await request(`/api/edge/deployments/${first.id}/license`, { token: admin, method: "DELETE" })).status, 200);
  const revokedLicenseConfig = await request("/edge/v1/config", { apiKey: firstApiKey });
  assert.equal(revokedLicenseConfig.status, 200);
  assert.equal(revokedLicenseConfig.body.license.status, "revoked");
  assert.equal((await request("/edge/v1/snapshots/latest", { apiKey: firstApiKey })).status, 403);
  const reissuedLicense = await request(`/api/edge/deployments/${first.id}/license`, { token: admin, method: "POST", body: JSON.stringify({ expiresAt: renewedExpiry }) });
  assert.equal(reissuedLicense.status, 201);
  assert.equal((await request("/edge/v1/license/validate", { method: "POST", body: JSON.stringify({ licenseKey: reissuedLicense.body.license.licenseKey }) })).body.valid, true);
  assert.equal((await request("/edge/v1/config", { apiKey: firstApiKey })).status, 200);
  assert.equal((await request("/edge/v1/config", { apiKey: secondApiKey })).body.tenantId, "TENANT-SECOND");
  assert.equal((await request("/edge/v1/config", { deploymentId: second.id, deploymentSecret: firstAuthenticationSecret })).status, 401);

  const deduplicated = await request(`/api/edge/deployments/${first.id}/publish-snapshot`, { token: admin, method: "POST" });
  assert.equal(deduplicated.status, 202);
  assert.equal(deduplicated.body.deduplicated, true);
  assert.equal(deduplicated.body.job.id, firstCreated.body.snapshotJob.id);
  const unavailableSnapshot = await request("/edge/v1/snapshots/latest", { apiKey: firstApiKey });
  assert.equal(unavailableSnapshot.status, 500);
  assert.equal(unavailableSnapshot.body.code, "INTERNAL_ERROR");
  assert.equal(unavailableSnapshot.body.message, "服务暂时不可用，请稍后重试");

  const worker = spawn(process.execPath, [join(apiRoot, "src/worker.mjs")], {
    cwd: join(apiRoot, "../.."), env: serviceEnv, stdio: ["ignore", "ignore", "pipe"]
  });
  children.push(worker);
  worker.stderr.on("data", (chunk) => { stderr += chunk; });

  const firstInitialJob = await waitForSnapshotJob(firstCreated.body.snapshotJob.id);
  const secondInitialJob = await waitForSnapshotJob(secondCreated.body.snapshotJob.id);
  assert.equal(firstInitialJob.status, "succeeded", firstInitialJob.errorMessage);
  assert.equal(secondInitialJob.status, "succeeded", secondInitialJob.errorMessage);
  const firstPublished = await request(`/api/edge/deployments/${first.id}/status`, { token: admin });
  assert.equal(firstPublished.body.latestSnapshot.version, 1, JSON.stringify(firstPublished.body));
  const repeatedPublish = await request(`/api/edge/deployments/${first.id}/publish-snapshot`, { token: admin, method: "POST" });
  assert.equal(repeatedPublish.status, 202);
  const repeatedJob = await waitForSnapshotJob(repeatedPublish.body.job.id);
  assert.equal(repeatedJob.reused, true);
  assert.equal((await request(`/api/edge/deployments/${first.id}/status`, { token: admin })).body.latestSnapshot.version, firstPublished.body.latestSnapshot.version);
  const latestApi = await request("/edge/v1/snapshots/latest", { deploymentId: first.id, deploymentSecret: firstAuthenticationSecret });
  assert.equal(latestApi.body.mode, "api_pull");
  const manifest = await request(latestApi.body.manifestLocation, { deploymentId: first.id, deploymentSecret: firstAuthenticationSecret });
  const content = await request(latestApi.body.contentLocation, { deploymentId: first.id, deploymentSecret: firstAuthenticationSecret, raw: true });
  const decrypted = verifyAndDecryptSnapshot({ manifest: manifest.body, content: content.body, rootSecret: firstSnapshotSecret, expectedTenantId: "TENANT-CHANGAN", expectedDeploymentId: first.id });
  assert.equal(decrypted.tenant.id, "TENANT-CHANGAN");
  assert.ok(decrypted.monitoringTargets.length >= 1);
  assert.ok(decrypted.sensitiveRecords.some((record) => record.id === "SENS-FIRST-TENANT"));
  assert.equal(decrypted.sensitiveRecords.find((record) => record.id === "SENS-FIRST-TENANT")?.importStatus, "新增");
  assert.equal(decrypted.vulnerabilityRecords?.find((record) => record.id === "VULN-EDGE-TEST")?.cve, "CVE-2026-EDGE");
  assert.equal(decrypted.sensitiveRecords.some((record) => record.id === "SENS-SECOND-TENANT"), false);
  assert.equal(decrypted.credentialSubscriptions.find((record) => record.id === 987654321)?.expireTime, "2026-03-02T05:33:25.000Z");
  assert.equal(decrypted.credentialRecords.find((record) => record.id === "CRED-EPOCH-TIMESTAMP")?.leakedAt, "2026-03-02T05:33:25.000Z");
  assert.deepEqual(decrypted.fingerprintIcons?.find((record) => record.id === "FICON-CN-WEAVER")?.aliases, ["泛微Ecology-v9"]);
  assert.equal(decrypted.fileObjects.length, 2);
  const reportFile = decrypted.fileObjects.find((file) => file.id === "asset-report/REPORT-EDGE-FILE/content");
  const downloadedReport = await request(reportFile.contentLocation, { apiKey: firstApiKey, raw: true, headers: { "Accept-Encoding": "gzip" } });
  assert.equal(downloadedReport.status, 200);
  assert.equal(downloadedReport.headers.get("content-encoding"), "gzip");
  assert.deepEqual(Buffer.from(downloadedReport.body), reportContent);
  const etag = latestApi.headers.get("etag");
  assert.equal((await request("/edge/v1/snapshots/latest", { deploymentId: first.id, deploymentSecret: firstAuthenticationSecret, headers: { "If-None-Match": etag } })).status, 304);
  const changedDatabase = new pg.Client({ connectionString: databaseUrl });
  await changedDatabase.connect(); await changedDatabase.query(`SET search_path TO "${schema}", public`);
  await changedDatabase.query("UPDATE sensitive_records SET title='云端自动发布后的标题' WHERE id='SENS-FIRST-TENANT'");
  await changedDatabase.end();
  const automaticallyPublished = await request("/edge/v1/snapshots/latest", { deploymentId: first.id, deploymentSecret: firstAuthenticationSecret, headers: { "If-None-Match": etag } });
  assert.equal(automaticallyPublished.status, 304);
  const changedPublish = await request(`/api/edge/deployments/${first.id}/publish-snapshot`, { token: admin, method: "POST" });
  assert.equal(changedPublish.status, 202);
  assert.equal((await waitForSnapshotJob(changedPublish.body.job.id)).status, "succeeded");
  const newlyPublished = await request("/edge/v1/snapshots/latest", { deploymentId: first.id, deploymentSecret: firstAuthenticationSecret, headers: { "If-None-Match": etag } });
  assert.equal(newlyPublished.status, 200);
  assert.equal(newlyPublished.body.version, firstPublished.body.latestSnapshot.version + 1);
  const automaticManifest = await request(newlyPublished.body.manifestLocation, { apiKey: firstApiKey });
  const automaticContent = await request(newlyPublished.body.contentLocation, { apiKey: firstApiKey, raw: true });
  const automaticSnapshot = verifyAndDecryptSnapshot({ manifest: automaticManifest.body, content: automaticContent.body, rootSecret: firstSnapshotSecret, expectedTenantId: "TENANT-CHANGAN", expectedDeploymentId: first.id });
  assert.equal(automaticSnapshot.sensitiveRecords.find((record) => record.id === "SENS-FIRST-TENANT").title, "云端自动发布后的标题");

  const articleImage = Buffer.from("article-image-for-partial-snapshot-test");
  const articleImageName = `${createHash("sha256").update(articleImage).digest("hex")}.png`;
  const missingImageName = `${createHash("sha256").update("missing-image").digest("hex")}.png`;
  await mkdir(join(dataDir, "upload/images"), { recursive: true });
  await writeFile(join(dataDir, "upload/images", articleImageName), articleImage);
  const partialDatabase = new pg.Client({ connectionString: databaseUrl });
  await partialDatabase.connect(); await partialDatabase.query(`SET search_path TO "${schema}", public`);
  await partialDatabase.query(`INSERT INTO ingestion_batches
    (id,file_name,target_id,status,total_rows,new_rows,duplicate_rows,sheet_summary_json,created_at,ingestion_type,tenant_id)
    VALUES ($1,$2,$3,$4,0,0,0,$5,$6,$7,$8)`, ["BATCH-PARTIAL-SNAPSHOT", "partial.docx", "OBJ-CHANGAN", "已发布", "{}", now, "dark-web", "TENANT-CHANGAN"]);
  await partialDatabase.query(`INSERT INTO dark_web_events
    (id,target_id,latest_batch_id,title,risk,report_date,source_group_name,source_group_id,source_group_url,message_url,intel_tags,leak_data_types,leak_count,transaction_count,transaction_price,published_at,publisher_id,intel_note,article_markdown,is_published,reviewed_at,event_hash,first_seen_at,last_seen_at,import_count,tenant_id)
    VALUES ($1,$2,$3,$4,'high',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,TRUE,$19,$20,$21,$22,1,$23)`, ["DWE-PARTIAL-SNAPSHOT", "OBJ-CHANGAN", "BATCH-PARTIAL-SNAPSHOT", "完整的历史文章", now, "测试组织", "test-group", "https://example.test/group", "https://example.test/event", "数据泄露", "documents", "1", "0", "0", now, "test", "历史正文", `<p><img src=\"/api/article-images/${articleImageName}\"></p>`, now, "partial-snapshot-event", now, now, "TENANT-CHANGAN"]);
  const darkWebBlob = Buffer.from("legacy-dark-web-attachment-for-snapshot-test");
  const darkWebBlobSha256 = createHash("sha256").update(darkWebBlob).digest("hex");
  await mkdir(join(dataDir, "dark-web/blobs"), { recursive: true });
  await writeFile(join(dataDir, "dark-web/blobs", `${darkWebBlobSha256}.blob`), darkWebBlob);
  await partialDatabase.query(`INSERT INTO dark_web_blobs (sha256,stored_name,size_bytes,media_type,iv_b64,auth_tag_b64,created_at)
    VALUES ($1,$2,$3,$4,'','',$5)`, [darkWebBlobSha256, `${darkWebBlobSha256}.blob`, darkWebBlob.length, "application/octet-stream", now]);
  await partialDatabase.query(`INSERT INTO dark_web_files (id,batch_id,event_id,blob_sha256,kind,original_name,sheet_count,row_count,column_count,created_at)
    VALUES ($1,$2,$3,$4,$5,$6,0,0,0,$7)`, ["DWF-PARTIAL-SNAPSHOT", "BATCH-PARTIAL-SNAPSHOT", "DWE-PARTIAL-SNAPSHOT", darkWebBlobSha256, "attachment", "legacy-evidence.bin", now]);
  await partialDatabase.end();
  const completeArticlePublish = await request(`/api/edge/deployments/${first.id}/publish-snapshot`, { token: admin, method: "POST" });
  const completeArticleJob = await waitForSnapshotJob(completeArticlePublish.body.job.id);
  assert.equal(completeArticleJob.status, "succeeded", completeArticleJob.errorMessage);
  const completeArticleLatest = await request("/edge/v1/snapshots/latest", { deploymentId: first.id, deploymentSecret: firstAuthenticationSecret });
  const completeArticleManifest = await request(completeArticleLatest.body.manifestLocation, { apiKey: firstApiKey });
  const completeArticleContent = await request(completeArticleLatest.body.contentLocation, { apiKey: firstApiKey, raw: true });
  const completeArticleSnapshot = verifyAndDecryptSnapshot({ manifest: completeArticleManifest.body, content: completeArticleContent.body, rootSecret: firstSnapshotSecret, expectedTenantId: "TENANT-CHANGAN", expectedDeploymentId: first.id });
  assert.equal(completeArticleSnapshot.darkWebEvents.find((event) => event.id === "DWE-PARTIAL-SNAPSHOT").title, "完整的历史文章");
  assert.match(completeArticleSnapshot.darkWebEvents.find((event) => event.id === "DWE-PARTIAL-SNAPSHOT").articleMarkdown, new RegExp(articleImageName));

  await mkdir(join(legacyDataDir, "upload/images"), { recursive: true });
  await writeFile(join(legacyDataDir, "upload/images", articleImageName), articleImage);
  await rm(join(dataDir, "upload/images", articleImageName));
  await mkdir(join(legacyDataDir, "dark-web/blobs"), { recursive: true });
  await writeFile(join(legacyDataDir, "dark-web/blobs", `${darkWebBlobSha256}.blob`), darkWebBlob);
  await rm(join(dataDir, "dark-web/blobs", `${darkWebBlobSha256}.blob`));
  assert.equal(readArticleImageFromDirectories([join(dataDir, "upload/images"), join(legacyDataDir, "upload/images")], articleImageName)?.sha256, articleImageName.slice(0, 64));
  assert.equal((await request(`/edge/v1/files/${encodeURIComponent(`article-image/${articleImageName}`)}/content`, { apiKey: firstApiKey, raw: true })).status, 200);
  const attachmentFile = completeArticleSnapshot.fileObjects.find((file) => file.id === `dark-web/${darkWebBlobSha256}`);
  const downloadedAttachment = await request(attachmentFile.contentLocation, { apiKey: firstApiKey, raw: true });
  assert.equal(downloadedAttachment.status, 200);
  assert.deepEqual(Buffer.from(downloadedAttachment.body), darkWebBlob);
  const brokenArticleDatabase = new pg.Client({ connectionString: databaseUrl });
  await brokenArticleDatabase.connect(); await brokenArticleDatabase.query(`SET search_path TO "${schema}", public`);
  await brokenArticleDatabase.query("UPDATE dark_web_events SET title=$1,article_markdown=$2 WHERE id='DWE-PARTIAL-SNAPSHOT'", ["不完整的新文章", `<p><img src=\"/api/article-images/${missingImageName}\"></p>`]);
  await brokenArticleDatabase.query("UPDATE sensitive_records SET title='部分发布时仍应更新' WHERE id='SENS-FIRST-TENANT'");
  await brokenArticleDatabase.end();
  const partialPublish = await request(`/api/edge/deployments/${first.id}/publish-snapshot`, { token: admin, method: "POST" });
  const partialJob = await waitForSnapshotJob(partialPublish.body.job.id);
  assert.equal(partialJob.status, "succeeded", partialJob.errorMessage);
  assert.equal(partialJob.errorMessage, "快照已生成，但部分数据未能处理");
  const partialRun = await waitForBackgroundRunNotice(partialPublish.body.job.id);
  assert.equal(partialRun.noticeMessage, "任务已完成，但部分数据未能处理");
  const attentionRuns = await request("/api/background-runs?attention=true&limit=30", { token: admin });
  assert.ok(attentionRuns.body.items.some((item) => item.aggregateId === partialPublish.body.job.id));
  const partialRunDetail = await request(`/api/background-runs/${encodeURIComponent(partialRun.bullmqJobId)}`, { token: admin });
  assert.equal(partialRunDetail.body.noticeMessage, "任务已完成，但部分数据未能处理");
  const partialLatest = await request("/edge/v1/snapshots/latest", { deploymentId: first.id, deploymentSecret: firstAuthenticationSecret });
  const partialManifest = await request(partialLatest.body.manifestLocation, { apiKey: firstApiKey });
  const partialContent = await request(partialLatest.body.contentLocation, { apiKey: firstApiKey, raw: true });
  const partialSnapshot = verifyAndDecryptSnapshot({ manifest: partialManifest.body, content: partialContent.body, rootSecret: firstSnapshotSecret, expectedTenantId: "TENANT-CHANGAN", expectedDeploymentId: first.id });
  assert.equal(partialSnapshot.darkWebEvents.find((event) => event.id === "DWE-PARTIAL-SNAPSHOT").title, "完整的历史文章");
  assert.equal(partialSnapshot.sensitiveRecords.find((record) => record.id === "SENS-FIRST-TENANT").title, "部分发布时仍应更新");

  const latestObject = await request("/edge/v1/snapshots/latest", { deploymentId: second.id, deploymentSecret: secondAuthenticationSecret });
  assert.equal(latestObject.body.mode, "api_pull");
  const secondManifest = await request(latestObject.body.manifestLocation, { deploymentId: second.id, deploymentSecret: secondAuthenticationSecret });
  const secondContent = await request(latestObject.body.contentLocation, { deploymentId: second.id, deploymentSecret: secondAuthenticationSecret, raw: true });
  assert.equal(secondManifest.status, 200);
  assert.equal(secondContent.status, 200);
  const secondSnapshot = verifyAndDecryptSnapshot({ manifest: secondManifest.body, content: secondContent.body, rootSecret: secondSnapshotSecret, expectedTenantId: "TENANT-SECOND", expectedDeploymentId: second.id });
  assert.deepEqual(secondSnapshot.monitoringTargets.map((target) => target.id), ["OBJ-SECOND"]);
  assert.deepEqual(secondSnapshot.sensitiveRecords.map((record) => record.id), ["SENS-SECOND-TENANT"]);
  assert.deepEqual(secondSnapshot.vulnerabilityRecords, []);
  const switched = await request(`/api/edge/deployments/${first.id}`, { token: admin, method: "PUT", body: JSON.stringify({ syncMode: "object_storage_pull" }) });
  assert.equal(switched.status, 400);
  const switchedLatest = await request("/edge/v1/snapshots/latest", { deploymentId: first.id, deploymentSecret: firstAuthenticationSecret });
  assert.equal(switchedLatest.body.mode, "api_pull");
  assert.equal(switchedLatest.body.version, partialLatest.body.version);

  const reported = await request("/edge/v1/sync-status", { deploymentId: first.id, deploymentSecret: firstAuthenticationSecret, method: "POST", body: JSON.stringify({ protocolVersion: 1, tenantId: "TENANT-CHANGAN", deploymentId: first.id, status: "success", attemptedAt: new Date().toISOString(), appliedSnapshotVersion: firstPublished.body.latestSnapshot.version, message: null }) });
  assert.equal(reported.status, 200, JSON.stringify(reported.body));
  assert.equal(reported.body.lastAppliedSnapshotVersion, firstPublished.body.latestSnapshot.version);
  assert.equal((await request("/edge/v1/sync-status", { deploymentId: first.id, deploymentSecret: firstAuthenticationSecret, method: "POST", body: JSON.stringify({ protocolVersion: 1, tenantId: "TENANT-SECOND", deploymentId: first.id, status: "success", attemptedAt: new Date().toISOString(), appliedSnapshotVersion: 1, message: null }) })).status, 403);

  const rotated = await request(`/api/edge/deployments/${first.id}/rotate-activation`, { token: admin, method: "POST" });
  assert.equal(rotated.status, 200);
  assert.equal(rotated.body.snapshot, undefined);
  assert.equal((await request("/edge/v1/config", { deploymentId: first.id, deploymentSecret: firstAuthenticationSecret })).status, 401);
  const rotatedApiKey = rotated.body.activationConfig.apiKey;
  const rotatedAuthenticationSecret = rotatedApiKey.split(".").at(-2);
  const rotatedSnapshotSecret = rotatedApiKey.split(".").at(-1);
  assert.equal(rotatedSnapshotSecret, firstSnapshotSecret);
  assert.equal((await request("/edge/v1/config", { apiKey: rotatedApiKey })).status, 200);
  const rotatedLatest = await request("/edge/v1/snapshots/latest", { deploymentId: first.id, deploymentSecret: rotatedAuthenticationSecret });
  const rotatedManifest = await request(rotatedLatest.body.manifestLocation, { apiKey: rotatedApiKey });
  const rotatedContent = await request(rotatedLatest.body.contentLocation, { apiKey: rotatedApiKey, raw: true });
  assert.equal(verifyAndDecryptSnapshot({ manifest: rotatedManifest.body, content: rotatedContent.body, rootSecret: rotatedSnapshotSecret, expectedTenantId: "TENANT-CHANGAN", expectedDeploymentId: first.id }).version, partialLatest.body.version);
  assert.equal((await request(`/api/edge/deployments/${first.id}/openapi-key`, { token: admin, method: "DELETE" })).status, 200);
  assert.equal((await request("/edge/v1/config", { apiKey: rotatedApiKey })).status, 200);
  assert.equal((await request("/edge/v1/snapshots/latest", { apiKey: rotatedApiKey })).status, 401);
  const regenerated = await request(`/api/edge/deployments/${first.id}/openapi-key`, { token: admin, method: "POST" });
  assert.equal(regenerated.status, 200);
  const regeneratedApiKey = regenerated.body.activationConfig.apiKey;
  assert.equal((await request("/edge/v1/config", { apiKey: regeneratedApiKey })).status, 200);

  const deletePath = `/api/edge/deployments/${first.id}`;
  assert.equal((await request(deletePath, { token: admin, method: "DELETE", body: JSON.stringify({ confirmation: first.id }) })).status, 409);
  assert.equal((await request(deletePath, { token: admin, method: "PUT", body: JSON.stringify({ enabled: false }) })).status, 200);
  const disabledConfig = await request("/edge/v1/config", { apiKey: regeneratedApiKey });
  assert.equal(disabledConfig.status, 200);
  assert.equal(disabledConfig.body.enabled, false);
  assert.equal((await request("/edge/v1/snapshots/latest", { apiKey: regeneratedApiKey })).status, 401);
  assert.equal((await request(deletePath, { token: admin, method: "DELETE", body: JSON.stringify({ confirmation: "wrong-id" }) })).status, 400);
  const deleted = await request(deletePath, { token: admin, method: "DELETE", body: JSON.stringify({ confirmation: first.id }) });
  assert.equal(deleted.status, 200);
  assert.ok(deleted.body.deletedSnapshots >= partialLatest.body.version);
  assert.equal((await request(deletePath, { token: admin })).status, 404);
  assert.equal((await request("/edge/v1/config", { apiKey: rotatedApiKey })).status, 401);
  assert.equal((await request("/edge/v1/config", { apiKey: regeneratedApiKey })).status, 401);
  await assert.rejects(access(join(dataDir, "edge-snapshots", first.id)), /ENOENT/);
});
