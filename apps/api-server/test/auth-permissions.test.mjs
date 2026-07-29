import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createSecretCodec } from "../src/app/secret-codec.mjs";
import { generateTotpCode } from "../src/modules/auth/totp.mjs";
import { deriveCaptchaAnswer } from "@sentinel/auth-captcha";
import { standaloneWordReport } from "./support/dark-web-docx.mjs";
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

test("账号角色、细粒度权限与会话撤销形成闭环", async (t) => {
  const dataDir = await mkdtemp(join(os.tmpdir(), "sentinel-auth-test-"));
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const databaseUrl = process.env.DATABASE_URL || "postgresql://sentinel:sentinel-local-password@127.0.0.1:5432/sentinel";
  const schema = `sentinel_test_auth_${process.pid}_${port}`;
  const child = spawn(process.execPath, [join(apiRoot, "src/server.mjs")], {
    cwd: join(apiRoot, "../.."),
    env: { ...process.env, PORT: String(port), DATABASE_URL: databaseUrl, SENTINEL_DB_SCHEMA: schema, SENTINEL_DATA_DIR: dataDir, SENTINEL_SECRET: "auth-test-secret", SENTINEL_ADMIN_ACCOUNT: "operator", SENTINEL_ADMIN_PASSWORD: "Admin-Test#2026", SENTINEL_PORTAL_ACCOUNT: "analyst", SENTINEL_PORTAL_PASSWORD: "Portal-Test#2026" },
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

  const targetTenants = new Map([["OBJ-CHANGAN", "TENANT-CHANGAN"]]);
  const request = async (path, { token, tenantId: requestedTenantId, ...options } = {}) => {
    const headers = new Headers(options.headers);
    if (token) headers.set("Authorization", `Bearer ${token}`);
    let bodyTenantId = ""; let bodyTargetId = "";
    if (options.body instanceof FormData) bodyTargetId = String(options.body.get("targetId") || "");
    else if (typeof options.body === "string") {
      try { const parsed = JSON.parse(options.body); bodyTenantId = String(parsed.tenantId || ""); bodyTargetId = String(parsed.targetId || ""); } catch {}
    }
    const queryTenantId = new URL(path, baseUrl).searchParams.get("tenant_id") || "";
    const tenantId = requestedTenantId === null ? "" : requestedTenantId || queryTenantId || bodyTenantId || targetTenants.get(bodyTargetId) || "TENANT-CHANGAN";
    if (token && tenantId) headers.set("X-Sentinel-Tenant-Id", tenantId);
    if (options.body && !(options.body instanceof FormData)) headers.set("Content-Type", "application/json");
    const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
    const contentType = response.headers.get("content-type") || "";
    const body = contentType.includes("json") ? await response.json() : null;
    return { status: response.status, body };
  };
  const login = (account, password) => loginWithCaptcha(request, { account, password, secret: "auth-test-secret" });

  assert.equal((await request("/api/auth/login", { method: "POST", body: JSON.stringify({ account: "operator", password: "Admin-Test#2026" }) })).status, 400);
  const oneShotChallenge = await request("/api/auth/captcha");
  const oneShotBody = JSON.stringify({ account: "operator", password: "Admin-Test#2026", captchaId: oneShotChallenge.body.captchaId, captchaCode: deriveCaptchaAnswer("auth-test-secret", oneShotChallenge.body.captchaId) });
  const oneShotStatuses = await Promise.all([
    request("/api/auth/login", { method: "POST", body: oneShotBody }),
    request("/api/auth/login", { method: "POST", body: oneShotBody })
  ]).then((responses) => responses.map((response) => response.status).sort());
  assert.deepEqual(oneShotStatuses, [200, 400]);
  assert.equal((await request("/api/auth/login", { method: "POST", body: oneShotBody })).status, 400);

  const adminLogin = await login("operator", "Admin-Test#2026");
  const portalLogin = await login("analyst", "Portal-Test#2026");
  assert.equal(adminLogin.status, 200);
  assert.equal(portalLogin.status, 200);
  const admin = adminLogin.body.token;
  const portal = portalLogin.body.token;
  assert.ok(adminLogin.body.user.permissions.includes("accounts:manage"));
  assert.ok(portalLogin.body.user.permissions.includes("evidence:download"));
  assert.equal((await request("/api/users", { token: portal })).status, 403);
  assert.equal((await request("/api/users", { token: admin })).status, 200);

  const iconData = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#25c5d4" d="M2 2h20v20H2z"/></svg>').toString("base64")}`;
  assert.equal((await request("/api/fingerprint-icons", { token: portal, method: "POST", body: JSON.stringify({ fingerprintName: "RBAC Icon", source: "upload", iconData }) })).status, 403);
  assert.equal((await request("/api/fingerprint-icons/catalog/sync", { token: portal, method: "POST" })).status, 403);
  const iconCreated = await request("/api/fingerprint-icons", { token: admin, method: "POST", body: JSON.stringify({ fingerprintName: "RBAC Icon", aliases: ["rbac-icon"], source: "upload", iconData }) });
  assert.equal(iconCreated.status, 201, JSON.stringify(iconCreated.body));
  const lateScriptSvg = `<svg xmlns="http://www.w3.org/2000/svg"><desc>${"A".repeat(640)}</desc><script>alert(1)</script></svg>`;
  const lateScriptData = `data:image/svg+xml;base64,${Buffer.from(lateScriptSvg).toString("base64")}`;
  assert.equal((await request("/api/fingerprint-icons", { token: admin, method: "POST", body: JSON.stringify({ fingerprintName: "Unsafe SVG", source: "upload", iconData: lateScriptData }) })).status, 400);
  const disguisedSvg = `<!--${"A".repeat(5000)}-->${lateScriptSvg}`;
  const disguisedSvgData = `data:image/png;base64,${Buffer.from(disguisedSvg).toString("base64")}`;
  assert.equal((await request("/api/fingerprint-icons", { token: admin, method: "POST", body: JSON.stringify({ fingerprintName: "Disguised SVG", source: "upload", iconData: disguisedSvgData }) })).status, 400);
  const iconList = await request("/api/fingerprint-icons?query=rbac-icon", { token: admin });
  assert.equal(iconList.status, 200);
  assert.equal(iconList.body.total, 1);
  assert.equal(iconList.body.summary.managed, 1);
  assert.equal((await request("/api/fingerprint-icons/map", { token: portal })).body.entries.length, 1);
  const iconResponse = await fetch(`${baseUrl}${iconCreated.body.iconUrl}`);
  assert.equal(iconResponse.status, 200);
  assert.equal(iconResponse.headers.get("content-security-policy"), "default-src 'none'; style-src 'none'; script-src 'none'; img-src 'none'; object-src 'none'; sandbox");
  assert.equal(iconResponse.headers.get("cross-origin-resource-policy"), "same-origin");
  const servedIcon = Buffer.from(await iconResponse.arrayBuffer());
  assert.equal(iconCreated.body.iconSha256, createHash("sha256").update(servedIcon).digest("hex"));

  const iconDb = new pg.Client({ connectionString: databaseUrl });
  await iconDb.connect();
  await iconDb.query(`UPDATE "${schema}".fingerprint_icon_library SET icon_data=$1,media_type='image/svg+xml' WHERE id=$2`, [lateScriptData, iconCreated.body.id]);
  await iconDb.end();
  const historicalUnsafeIcon = await fetch(`${baseUrl}${iconCreated.body.iconUrl}`);
  assert.equal(historicalUnsafeIcon.status, 422);
  assert.doesNotMatch(await historicalUnsafeIcon.text(), /<script|alert\(1\)/i);
  assert.equal((await request(`/api/fingerprint-icons/${iconCreated.body.id}`, { token: admin, method: "PUT", body: JSON.stringify({ fingerprintName: "RBAC Icon", aliases: ["rbac-icon"], source: "upload", active: false }) })).status, 400);
  const iconUpdated = await request(`/api/fingerprint-icons/${iconCreated.body.id}`, { token: admin, method: "PUT", body: JSON.stringify({ fingerprintName: "RBAC Icon", aliases: ["rbac-icon"], source: "upload", iconData, active: false }) });
  assert.equal(iconUpdated.status, 200);
  assert.equal(iconUpdated.body.active, false);
  assert.equal((await request(`/api/fingerprint-icons/${iconCreated.body.id}`, { token: admin, method: "DELETE" })).status, 200);

  const viewerPassword = "Viewer-Test#2026";
  const viewerCreated = await request("/api/users", { token: admin, method: "POST", body: JSON.stringify({ account: "viewer.one", name: "只读访客", roleKey: "portal-viewer", password: viewerPassword }) });
  assert.equal(viewerCreated.status, 201);
  const mfaPassword = "Mfa-Viewer#2026";
  assert.equal((await request("/api/users", { token: admin, method: "POST", body: JSON.stringify({ account: "mfa.viewer", name: "动态码访客", roleKey: "portal-viewer", password: mfaPassword }) })).status, 201);
  const totpCodec = createSecretCodec("auth-test-secret");
  const viewerTotpSecret = "JBSWY3DPEHPK3PXP";
  const totpClient = new pg.Client({ connectionString: databaseUrl });
  await totpClient.connect();
  await totpClient.query(`UPDATE "${schema}".users SET totp_secret_enc=$1,totp_enabled=1 WHERE account=$2`, [totpCodec.encrypt(viewerTotpSecret), "mfa.viewer"]);
  await totpClient.end();
  const mfaLogin = await login("mfa.viewer", mfaPassword);
  assert.equal(mfaLogin.status, 202);
  assert.equal(mfaLogin.body.otpRequired, true);
  const mfaOtp = await request("/api/auth/login/otp", { method: "POST", body: JSON.stringify({ challengeId: mfaLogin.body.challengeId, code: generateTotpCode({ secret: viewerTotpSecret }) }) });
  assert.equal(mfaOtp.status, 200);
  assert.equal((await request("/api/auth/me", { token: mfaOtp.body.token })).status, 200);
  const viewerLogin = await login("viewer.one", viewerPassword);
  assert.equal(viewerLogin.status, 200);
  const viewer = viewerLogin.body.token;
  assert.equal((await request("/api/dark-web/events", { token: viewer })).status, 200);
  assert.equal((await request("/api/dark-web/events/missing/files/missing/preview", { token: viewer })).status, 404);
  assert.equal((await request("/api/dark-web/events/missing/files/missing/content", { token: viewer })).status, 403);
  assert.equal((await request("/api/ingestion/batches", { token: viewer })).status, 403);

  const operatorPassword = "Operator-Test#2026";
  assert.equal((await request("/api/users", { token: admin, method: "POST", body: JSON.stringify({ account: "data.operator", name: "数据运营", roleKey: "data-operator", password: operatorPassword }) })).status, 201);
  const dataOperator = (await login("data.operator", operatorPassword)).body.token;
  assert.equal((await request("/api/ingestion/batches", { token: dataOperator })).status, 200);
  assert.equal((await request("/api/users", { token: dataOperator })).status, 403);
  assert.equal((await request("/api/connections", { token: dataOperator })).status, 200);
  assert.equal((await request("/api/fingerprint-icons", { token: dataOperator })).status, 200);
  assert.equal((await request("/api/connections", { token: dataOperator, method: "POST", body: "{}" })).status, 403);
  assert.equal((await request("/api/targets", { token: dataOperator })).status, 200);
  assert.equal((await request("/api/ingestion/records?type=sensitive", { token: portal })).status, 403);
  assert.equal((await request("/api/ingestion/records/bulk-action", { token: portal, method: "POST", body: JSON.stringify({ type: "sensitive", action: "publish", ids: ["missing"] }) })).status, 403);
  assert.equal((await request("/api/ingestion/records/publish-all", { token: portal, method: "POST", body: JSON.stringify({ type: "sensitive", tenantId: "TENANT-CHANGAN" }) })).status, 403);

  const defaultWatchVuln = await request("/api/connections", { token: admin, method: "POST", body: JSON.stringify({ name: "默认自动发布 WatchVuln", category: "漏洞情报", providerType: "watchvuln", endpoint: "https://watchvuln.example/feed", method: "GET", targetId: "OBJ-CHANGAN", config: { pageSize: 100 } }) });
  assert.equal(defaultWatchVuln.status, 201, JSON.stringify(defaultWatchVuln.body));
  assert.equal(defaultWatchVuln.body.config.autoPublish, true);
  assert.equal((await request(`/api/connections/${defaultWatchVuln.body.id}`, { token: admin, method: "DELETE" })).status, 200);

  const defaultPolicies = await request("/api/tenant-publication-policies?tenant_id=TENANT-CHANGAN", { token: dataOperator });
  assert.equal(defaultPolicies.status, 200, JSON.stringify(defaultPolicies.body));
  assert.deepEqual(Object.fromEntries(defaultPolicies.body.map((item) => [item.module, item.mode])), {
    sensitive: "approval", asset: "approval", "dark-web": "approval", credentials: "auto", vulnerabilities: "auto"
  });

  const articleTarget = await request("/api/targets", { token: admin, method: "POST", body: JSON.stringify({ tenantId: "TENANT-CHANGAN", name: "通用威胁情报对象", targetType: "情报专题", owner: "测试员", domains: [], ips: [], keywords: ["威胁情报"] }) });
  assert.equal(articleTarget.status, 201);

  const wordForm = new FormData();
  wordForm.append("file", new Blob([await standaloneWordReport()], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }), "仅Word暗网情报.docx");
  wordForm.append("targetId", articleTarget.body.id);
  const wordUpload = await request("/api/ingestion/dark-web", { token: dataOperator, method: "POST", body: wordForm });
  assert.equal(wordUpload.status, 201, JSON.stringify(wordUpload.body));
  assert.equal(wordUpload.body.fileName, "仅Word暗网情报.docx");
  assert.equal(wordUpload.body.newRows, 1);
  assert.equal(wordUpload.body.targetId, articleTarget.body.id);
  assert.equal(wordUpload.body.sheets.length, 1);
  const missingTargetForm = new FormData();
  missingTargetForm.append("file", new Blob([await standaloneWordReport()], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }), "缺少客户.docx");
  const missingTargetUpload = await request("/api/ingestion/dark-web", { token: dataOperator, method: "POST", body: missingTargetForm });
  assert.equal(missingTargetUpload.status, 400);
  assert.match(missingTargetUpload.body.message, /监测对象/);
  const draftRecords = await request(`/api/ingestion/records?type=dark-web&query=${encodeURIComponent("仅 Word 暗网情报")}`, { token: dataOperator });
  assert.equal(draftRecords.status, 200);
  const uploadedWordDraft = draftRecords.body.data.find((item) => item.title === "仅 Word 暗网情报");
  assert.equal(uploadedWordDraft.isPublished, false);
  assert.equal(uploadedWordDraft.risk, "low");
  const editorRecord = await request(`/api/ingestion/records/dark-web/${encodeURIComponent(uploadedWordDraft.id)}`, { token: dataOperator });
  assert.equal(editorRecord.status, 200);
  assert.equal(editorRecord.body.id, uploadedWordDraft.id);
  assert.equal(editorRecord.body.articleMarkdown, uploadedWordDraft.articleMarkdown);
  assert.equal((await request(`/api/ingestion/records/dark-web/${encodeURIComponent(uploadedWordDraft.id)}`, { token: portal })).status, 403);
  const editorFilesPath = `/api/ingestion/records/dark-web/${encodeURIComponent(uploadedWordDraft.id)}/files`;
  assert.equal((await request(editorFilesPath, { token: portal })).status, 403);
  const attachmentForm = new FormData();
  attachmentForm.append("file", new Blob([JSON.stringify({ evidence: "attachment-crud" })], { type: "application/json" }), "补充证据.json");
  const attachmentUpload = await request(editorFilesPath, { token: dataOperator, method: "POST", body: attachmentForm });
  assert.equal(attachmentUpload.status, 201, JSON.stringify(attachmentUpload.body));
  assert.equal(attachmentUpload.body.kind, "attachment");
  assert.equal(attachmentUpload.body.name, "补充证据.json");
  const editorFiles = await request(editorFilesPath, { token: dataOperator });
  assert.equal(editorFiles.status, 200);
  assert.ok(editorFiles.body.some((file) => file.kind === "report"));
  assert.ok(editorFiles.body.some((file) => file.id === attachmentUpload.body.id));
  const duplicateAttachmentForm = new FormData();
  duplicateAttachmentForm.append("file", new Blob([JSON.stringify({ evidence: "attachment-crud" })], { type: "application/json" }), "重复证据.json");
  assert.equal((await request(editorFilesPath, { token: dataOperator, method: "POST", body: duplicateAttachmentForm })).status, 409);
  assert.equal((await request(`${editorFilesPath}/${encodeURIComponent(attachmentUpload.body.id)}`, { token: portal, method: "DELETE" })).status, 403);
  assert.equal((await request(`${editorFilesPath}/${encodeURIComponent(attachmentUpload.body.id)}`, { token: dataOperator, method: "DELETE" })).status, 200);
  assert.ok(!(await request(editorFilesPath, { token: dataOperator })).body.some((file) => file.id === attachmentUpload.body.id));
  const wordEventsBeforeReview = await request(`/api/dark-web/events?query=${encodeURIComponent("仅 Word 暗网情报")}`, { token: portal });
  assert.equal(wordEventsBeforeReview.status, 200);
  assert.ok(!wordEventsBeforeReview.body.data.some((item) => item.title === "仅 Word 暗网情报"));
  const largeArticle = `<h1>仅 Word 暗网情报</h1><p>${"A".repeat(1_100_000)}</p>`;
  const reviewedWordDraft = await request(`/api/ingestion/records/dark-web/${encodeURIComponent(uploadedWordDraft.id)}`, { token: dataOperator, method: "PUT", body: JSON.stringify({ ...uploadedWordDraft, articleMarkdown: largeArticle }) });
  assert.equal(reviewedWordDraft.status, 200);
  assert.equal(reviewedWordDraft.body.articleMarkdown.length, largeArticle.length);
  assert.equal((await request(`/api/ingestion/records/dark-web/${encodeURIComponent(uploadedWordDraft.id)}/publish`, { token: dataOperator, method: "POST" })).status, 200);
  const wordEvents = await request(`/api/dark-web/events?query=${encodeURIComponent("仅 Word 暗网情报")}`, { token: portal });
  assert.equal(wordEvents.status, 200);
  assert.ok(wordEvents.body.data.some((item) => item.title === "仅 Word 暗网情报"));
  const uploadedWordEvent = wordEvents.body.data.find((item) => item.title === "仅 Word 暗网情报");
  assert.equal(uploadedWordEvent.messageUrl, "报告原文未提供链接");
  assert.deepEqual(uploadedWordEvent.intelTags, ["数据泄露"]);
  assert.equal(uploadedWordEvent.risk, "low");
  assert.match(uploadedWordEvent.publishedAt, /^2026-07-21T00:00:00\.000Z$/);
  assert.equal((await request(`/api/ingestion/batches/${wordUpload.body.id}/archive`, { token: dataOperator })).status, 200);

  const ingestionFixtures = [
    { type: "sensitive", targetId: "OBJ-CHANGAN", title: "手工敏感信息 CRUD", category: "account-password", risk: "高", fields: { account: "crud@example.com", source: "测试" } },
    { type: "asset", targetId: "OBJ-CHANGAN", title: "crud.example.com", category: "subdomain", risk: "未标记", fields: { rootDomain: "example.com", subdomain: "crud.example.com" } },
    { type: "dark-web", targetId: "OBJ-CHANGAN", title: "手工暗网情报 CRUD", risk: "high", reportDate: "2026-07-20", sourceGroupName: "测试群组", sourceGroupId: "crud-group", sourceGroupUrl: "https://example.com/group", messageUrl: "https://example.com/message/crud", intelTags: ["数据泄露", "行业情报"], leakDataTypes: "测试数据", leakCount: "10", transactionCount: "1", transactionPrice: "1 BTC", publishedAt: "2026-07-20T08:00:00Z", publisherId: "crud-publisher", intelNote: "仅用于 CRUD 回归" }
  ];
  for (const fixture of ingestionFixtures) {
    const created = await request("/api/ingestion/records", { token: dataOperator, method: "POST", body: JSON.stringify(fixture) });
    assert.equal(created.status, 201);
    assert.equal(created.body.type, fixture.type);
    assert.equal(created.body.isPublished, false);
    if (fixture.type === "dark-web") assert.equal(created.body.risk, "high");
    const listed = await request(`/api/ingestion/records?type=${encodeURIComponent(fixture.type)}&query=CRUD`, { token: dataOperator });
    assert.equal(listed.status, 200);
    assert.ok(listed.body.data.some((item) => item.id === created.body.id));
    const detail = await request(`/api/ingestion/records/${fixture.type}/${encodeURIComponent(created.body.id)}`, { token: dataOperator });
    assert.equal(detail.status, 200);
    assert.equal(detail.body.id, created.body.id);
    const updated = await request(`/api/ingestion/records/${fixture.type}/${encodeURIComponent(created.body.id)}`, { token: dataOperator, method: "PUT", body: JSON.stringify({ ...fixture, title: `${fixture.title}（已更新）`, ...(fixture.type === "dark-web" ? { risk: "critical" } : {}) }) });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.title, `${fixture.title}（已更新）`);
    assert.equal(updated.body.isPublished, false);
    assert.ok(updated.body.reviewedAt);
    if (fixture.type === "dark-web") assert.equal(updated.body.risk, "critical");
    const published = await request(`/api/ingestion/records/${fixture.type}/${encodeURIComponent(created.body.id)}/publish`, { token: dataOperator, method: "POST" });
    assert.equal(published.status, 200, JSON.stringify(published.body));
    assert.equal(published.body.isPublished, true);
    const portalResult = await request(`/api/intelligence?query=${encodeURIComponent(`${fixture.title}（已更新）`)}`, { token: portal });
    assert.ok(portalResult.body.data.some((item) => item.id === created.body.id));
    assert.equal((await request(`/api/ingestion/records/${fixture.type}/${encodeURIComponent(created.body.id)}`, { token: dataOperator, method: "DELETE" })).status, 200);
    assert.equal((await request(`/api/ingestion/records/${fixture.type}/${encodeURIComponent(created.body.id)}`, { token: dataOperator })).status, 404);
    const afterDelete = await request(`/api/ingestion/records?type=${encodeURIComponent(fixture.type)}&query=${encodeURIComponent(fixture.title)}`, { token: dataOperator });
    assert.ok(!afterDelete.body.data.some((item) => item.id === created.body.id));
  }

  const createIngestionRecord = async (fixture) => {
    const created = await request("/api/ingestion/records", { token: dataOperator, method: "POST", body: JSON.stringify(fixture) });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    return created.body;
  };
  const sensitiveBulkA = await createIngestionRecord({ type: "sensitive", targetId: "OBJ-CHANGAN", title: "运营批量发布敏感 A", category: "account-password", risk: "高", fields: { account: "bulk-a@example.com" } });
  const sensitiveBulkB = await createIngestionRecord({ type: "sensitive", targetId: "OBJ-CHANGAN", title: "运营批量发布敏感 B", category: "account-password", risk: "中", fields: { account: "bulk-b@example.com" } });
  const ingestionDb = new pg.Client({ connectionString: databaseUrl });
  await ingestionDb.connect();
  await ingestionDb.query(`UPDATE "${schema}".sensitive_records SET reviewed_at=NULL WHERE id IN ($1,$2)`, [sensitiveBulkA.id, sensitiveBulkB.id]);
  const selectedPublish = await request("/api/ingestion/records/bulk-action", { token: dataOperator, method: "POST", body: JSON.stringify({ type: "sensitive", action: "publish", ids: [sensitiveBulkA.id] }) });
  assert.equal(selectedPublish.status, 200, JSON.stringify(selectedPublish.body));
  assert.equal(selectedPublish.body.matched, 1);
  assert.equal(selectedPublish.body.published, 1);
  const afterSelectedPublish = await request(`/api/ingestion/records?type=sensitive&query=${encodeURIComponent("运营批量发布敏感")}`, { token: dataOperator });
  assert.equal(afterSelectedPublish.body.data.find((item) => item.id === sensitiveBulkA.id).isPublished, true);
  assert.ok(afterSelectedPublish.body.data.find((item) => item.id === sensitiveBulkA.id).reviewedAt);
  assert.equal(afterSelectedPublish.body.data.find((item) => item.id === sensitiveBulkB.id).isPublished, false);
  const matchingPublish = await request("/api/ingestion/records/bulk-action", { token: dataOperator, method: "POST", body: JSON.stringify({ type: "sensitive", action: "publish", allMatching: true, tenantId: "TENANT-CHANGAN", query: "运营批量发布敏感", publication: "draft" }) });
  assert.equal(matchingPublish.status, 200, JSON.stringify(matchingPublish.body));
  assert.equal(matchingPublish.body.matched, 1);
  assert.equal(matchingPublish.body.published, 1);

  const darkBulk = await createIngestionRecord({ type: "dark-web", targetId: "OBJ-CHANGAN", title: "运营批量发布暗网", risk: "high", reportDate: "2026-07-26", sourceGroupName: "批量审核群组", messageUrl: "https://example.com/bulk-dark", intelTags: ["数据泄露"], leakDataTypes: "测试数据", publishedAt: "2026-07-26T08:00:00Z" });
  await ingestionDb.query(`UPDATE "${schema}".dark_web_events SET reviewed_at=NULL WHERE id=$1`, [darkBulk.id]);
  const darkPublish = await request("/api/ingestion/records/bulk-action", { token: dataOperator, method: "POST", body: JSON.stringify({ type: "dark-web", action: "publish", ids: [darkBulk.id] }) });
  assert.equal(darkPublish.status, 200, JSON.stringify(darkPublish.body));
  assert.equal(darkPublish.body.published, 1);
  const darkPublished = await request(`/api/ingestion/records?type=dark-web&query=${encodeURIComponent("运营批量发布暗网")}`, { token: dataOperator });
  assert.equal(darkPublished.body.data[0].isPublished, true);
  assert.ok(darkPublished.body.data[0].reviewedAt);

  assert.equal((await request("/api/edge/tenants", { token: admin, method: "POST", body: JSON.stringify({ id: "TENANT-INGESTION-SECOND", name: "运营发布隔离租户" }) })).status, 201);
  const secondTarget = await request("/api/targets", { token: admin, method: "POST", body: JSON.stringify({ tenantId: "TENANT-INGESTION-SECOND", name: "运营发布隔离对象", targetType: "企业", owner: "测试员", domains: [], ips: [], keywords: [] }) });
  assert.equal(secondTarget.status, 201, JSON.stringify(secondTarget.body));
  targetTenants.set(secondTarget.body.id, "TENANT-INGESTION-SECOND");
  assert.equal((await request("/api/targets?tenant_id=TENANT-INGESTION-SECOND", { token: dataOperator, tenantId: "TENANT-CHANGAN" })).status, 403);
  assert.equal((await request("/api/targets", { token: dataOperator, tenantId: null })).status, 400);
  const changanTargets = await request("/api/targets?tenant_id=TENANT-CHANGAN", { token: dataOperator });
  const secondTenantTargets = await request("/api/targets?tenant_id=TENANT-INGESTION-SECOND", { token: dataOperator });
  assert.equal(changanTargets.status, 200);
  assert.ok(changanTargets.body.length > 0);
  assert.ok(changanTargets.body.every((target) => target.tenantId === "TENANT-CHANGAN"));
  assert.deepEqual(secondTenantTargets.body.map((target) => target.id), [secondTarget.body.id]);
  const firstTenantAsset = await createIngestionRecord({ type: "asset", targetId: "OBJ-CHANGAN", title: "运营全部发布主租户资产", category: "subdomain", risk: "未标记", fields: { rootDomain: "main.example", subdomain: "bulk.main.example" } });
  const secondTenantAsset = await createIngestionRecord({ type: "asset", targetId: secondTarget.body.id, title: "运营全部发布隔离租户资产", category: "subdomain", risk: "未标记", fields: { rootDomain: "second.example", subdomain: "bulk.second.example" } });
  assert.equal((await request(`/api/ingestion/records/asset/${encodeURIComponent(secondTenantAsset.id)}`, { token: dataOperator, tenantId: "TENANT-CHANGAN" })).status, 404);
  const assetBatchId = "BATCH-ASSET-BULK-PUBLISH"; const assetReportId = "REPORT-ASSET-BULK-PUBLISH"; const now = new Date().toISOString();
  await ingestionDb.query(`INSERT INTO "${schema}".ingestion_batches (id,file_name,target_id,status,total_rows,new_rows,duplicate_rows,sheet_summary_json,created_at,ingestion_type,tenant_id) VALUES ($1,$2,$3,$4,1,1,0,'[]',$5,'asset',$6)`, [assetBatchId, "批量发布资产报告.html", "OBJ-CHANGAN", "待审核", now, "TENANT-CHANGAN"]);
  await ingestionDb.query(`UPDATE "${schema}".asset_records SET batch_id=$1,reviewed_at=NULL WHERE id=$2`, [assetBatchId, firstTenantAsset.id]);
  await ingestionDb.query(`UPDATE "${schema}".asset_records SET reviewed_at=NULL WHERE id=$1`, [secondTenantAsset.id]);
  await ingestionDb.query(`INSERT INTO "${schema}".asset_reports (id,target_id,file_name,file_path,data_path,size_bytes,dns_count,port_count,web_count,fingerprint_count,icon_count,created_at,tenant_id,is_published,batch_id) VALUES ($1,$2,$3,$4,NULL,1,1,0,0,0,0,$5,$6,FALSE,$7)`, [assetReportId, "OBJ-CHANGAN", "批量发布资产报告.html", "/tmp/bulk-asset-report.html", now, "TENANT-CHANGAN", assetBatchId]);
  const publishAllAssets = await request("/api/ingestion/records/publish-all", { token: dataOperator, method: "POST", body: JSON.stringify({ type: "asset", tenantId: "TENANT-CHANGAN" }) });
  assert.equal(publishAllAssets.status, 200, JSON.stringify(publishAllAssets.body));
  assert.ok(publishAllAssets.body.published >= 1);
  const firstAssetAfterPublish = await request(`/api/ingestion/records?type=asset&query=${encodeURIComponent(firstTenantAsset.title)}`, { token: dataOperator });
  const secondAssetAfterPublish = await request(`/api/ingestion/records?type=asset&query=${encodeURIComponent(secondTenantAsset.title)}`, { token: dataOperator, tenantId: "TENANT-INGESTION-SECOND" });
  assert.equal(firstAssetAfterPublish.body.data[0].isPublished, true);
  assert.ok(firstAssetAfterPublish.body.data[0].reviewedAt);
  assert.equal(secondAssetAfterPublish.body.data[0].isPublished, false);
  const publishedBatch = await ingestionDb.query(`SELECT status FROM "${schema}".ingestion_batches WHERE id=$1`, [assetBatchId]);
  const publishedReport = await ingestionDb.query(`SELECT is_published FROM "${schema}".asset_reports WHERE id=$1`, [assetReportId]);
  assert.equal(publishedBatch.rows[0].status, "已发布");
  assert.equal(publishedReport.rows[0].is_published, true);

  const deltaTarget = await request("/api/targets", { token: admin, method: "POST", body: JSON.stringify({ tenantId: "TENANT-INGESTION-SECOND", name: "资产差异测试对象", targetType: "企业", owner: "测试员", domains: [], ips: [], keywords: [] }) });
  const hashTwinTarget = await request("/api/targets", { token: admin, method: "POST", body: JSON.stringify({ tenantId: "TENANT-INGESTION-SECOND", name: "资产哈希隔离对象", targetType: "企业", owner: "测试员", domains: [], ips: [], keywords: [] }) });
  assert.equal(deltaTarget.status, 201, JSON.stringify(deltaTarget.body));
  assert.equal(hashTwinTarget.status, 201, JSON.stringify(hashTwinTarget.body));
  targetTenants.set(deltaTarget.body.id, "TENANT-INGESTION-SECOND");
  targetTenants.set(hashTwinTarget.body.id, "TENANT-INGESTION-SECOND");
  const assetHtmlForm = (targetId, websites, filename) => {
    const form = new FormData();
    form.append("file", new Blob([`<script>window.data=${JSON.stringify({ dns: [], ports: [], websites, products: { datasource: [] }, icons: [] })};</script>`], { type: "text/html" }), filename);
    form.append("targetId", targetId);
    return form;
  };
  const baselineWebsites = [
    { url: "https://asset-a.example.test", ip: "198.51.100.10", domain: "asset-a.example.test", port: 443, status_code: 200, alive: true, title: "资产 A" },
    { url: "https://asset-b.example.test", ip: "198.51.100.11", domain: "asset-b.example.test", port: 443, status_code: 200, alive: true, title: "资产 B" }
  ];
  const baselineImport = await request("/api/ingestion/assets-html", { token: dataOperator, method: "POST", body: assetHtmlForm(deltaTarget.body.id, baselineWebsites, "资产基线.html") });
  assert.equal(baselineImport.status, 201, JSON.stringify(baselineImport.body));
  assert.deepEqual([baselineImport.body.newRows, baselineImport.body.changedRows, baselineImport.body.missingRows, baselineImport.body.unchangedRows], [2, 0, 0, 0]);
  assert.deepEqual([baselineImport.body.aliveChangedRows, baselineImport.body.statusCodeChangedRows], [0, 0]);
  const twinImport = await request("/api/ingestion/assets-html", { token: dataOperator, method: "POST", body: assetHtmlForm(hashTwinTarget.body.id, [baselineWebsites[0]], "相同哈希另一对象.html") });
  assert.equal(twinImport.status, 201, JSON.stringify(twinImport.body));
  assert.equal(twinImport.body.newRows, 1);
  const publishBaseline = await request("/api/ingestion/records/bulk-action", { token: dataOperator, method: "POST", body: JSON.stringify({ type: "asset", action: "publish", allMatching: true, tenantId: "TENANT-INGESTION-SECOND", targetId: deltaTarget.body.id, publication: "draft" }) });
  assert.equal(publishBaseline.status, 200, JSON.stringify(publishBaseline.body));
  assert.equal(publishBaseline.body.published, 2);

  const metadataOnlyWebsites = baselineWebsites.map((item, index) => ({ ...item, title: `仅标题变化 ${index + 1}`, app_products: ["metadata-only"] }));
  const unchangedImport = await request("/api/ingestion/assets-html", { token: dataOperator, method: "POST", body: assetHtmlForm(deltaTarget.body.id, metadataOnlyWebsites, "资产非状态字段变化.html") });
  assert.equal(unchangedImport.status, 201, JSON.stringify(unchangedImport.body));
  assert.deepEqual([unchangedImport.body.newRows, unchangedImport.body.changedRows, unchangedImport.body.missingRows, unchangedImport.body.unchangedRows], [0, 0, 0, 2]);
  assert.deepEqual([unchangedImport.body.aliveChangedRows, unchangedImport.body.statusCodeChangedRows], [0, 0]);
  const unchangedRecords = await request(`/api/ingestion/records?type=asset&tenant_id=TENANT-INGESTION-SECOND&target_id=${encodeURIComponent(deltaTarget.body.id)}`, { token: dataOperator });
  const unchangedAsset = unchangedRecords.body.data.find((item) => item.fields.url === "https://asset-a.example.test");
  assert.equal(unchangedAsset.changeType, "unchanged");
  assert.equal(unchangedAsset.previousFields, undefined);

  const changedWebsites = [
    { ...baselineWebsites[0], status_code: 503, alive: false, title: "资产 A 暂不可用" },
    { url: "https://asset-c.example.test", ip: "198.51.100.12", domain: "asset-c.example.test", port: 443, status_code: 201, alive: true, title: "资产 C" }
  ];
  const changedImport = await request("/api/ingestion/assets-html", { token: dataOperator, method: "POST", body: assetHtmlForm(deltaTarget.body.id, changedWebsites, "资产更新.html") });
  assert.equal(changedImport.status, 201, JSON.stringify(changedImport.body));
  assert.deepEqual([changedImport.body.newRows, changedImport.body.changedRows, changedImport.body.missingRows, changedImport.body.unchangedRows], [1, 1, 1, 0]);
  assert.deepEqual([changedImport.body.aliveChangedRows, changedImport.body.statusCodeChangedRows], [1, 1]);
  const deltaRecords = await request(`/api/ingestion/records?type=asset&tenant_id=TENANT-INGESTION-SECOND&target_id=${encodeURIComponent(deltaTarget.body.id)}`, { token: dataOperator });
  const changedAsset = deltaRecords.body.data.find((item) => item.fields.url === "https://asset-a.example.test");
  const missingAsset = deltaRecords.body.data.find((item) => item.fields.url === "https://asset-b.example.test");
  const newAsset = deltaRecords.body.data.find((item) => item.fields.url === "https://asset-c.example.test");
  assert.equal(changedAsset.changeType, "changed");
  assert.equal(changedAsset.fields.statusCode, "503");
  assert.equal(changedAsset.previousFields.statusCode, "200");
  assert.equal(changedAsset.previouslyPublished, true);
  assert.equal(changedAsset.isPublished, false);
  assert.equal(missingAsset.changeType, "missing");
  assert.equal(missingAsset.presentInLatestBatch, false);
  assert.equal(missingAsset.previousFields.statusCode, "200");
  assert.equal(newAsset.changeType, "new");
  assert.equal(newAsset.isPublished, false);

  const liveAssetPreview = await request(`/api/assets/reports/latest/data?tenant_id=TENANT-INGESTION-SECOND&section=web&page=1&page_size=20&include_drafts=1`, { token: admin });
  assert.equal(liveAssetPreview.status, 200, JSON.stringify(liveAssetPreview.body));
  assert.equal(liveAssetPreview.body.total, 3);
  const previewChangedAsset = liveAssetPreview.body.data.find((item) => item.url === "https://asset-a.example.test");
  const previewMissingAsset = liveAssetPreview.body.data.find((item) => item.url === "https://asset-b.example.test");
  const previewNewAsset = liveAssetPreview.body.data.find((item) => item.url === "https://asset-c.example.test");
  assert.equal(previewChangedAsset._change_type, "changed");
  assert.equal(previewChangedAsset.status_code, "503");
  assert.equal(previewMissingAsset._change_type, "missing");
  assert.equal(previewNewAsset._change_type, "new");

  const changedAssetPreview = await request(`/api/assets/reports/latest/data?tenant_id=TENANT-INGESTION-SECOND&section=web&page=1&page_size=20&include_drafts=1&change_type=changed`, { token: admin });
  assert.equal(changedAssetPreview.status, 200, JSON.stringify(changedAssetPreview.body));
  assert.equal(changedAssetPreview.body.total, 1);
  assert.equal(changedAssetPreview.body.data[0]._change_type, "changed");
  assert.deepEqual(
    Object.fromEntries(changedAssetPreview.body.facets.changeTypes.map((item) => [item.label, item.count])),
    { changed: 1, missing: 1, new: 1 }
  );

  const sortedAssetPreview = await request(`/api/assets/reports/latest/data?tenant_id=TENANT-INGESTION-SECOND&section=web&page=1&page_size=20&include_drafts=1&sort=change_status&direction=desc`, { token: admin });
  assert.equal(sortedAssetPreview.status, 200, JSON.stringify(sortedAssetPreview.body));
  assert.deepEqual(sortedAssetPreview.body.data.map((item) => item._change_type), ["changed", "missing", "new"]);

  const publishedAssetPortal = await request(`/api/assets/reports/latest/data?tenant_id=TENANT-INGESTION-SECOND&section=web&page=1&page_size=20`, { token: admin });
  assert.equal(publishedAssetPortal.status, 200, JSON.stringify(publishedAssetPortal.body));
  assert.equal(publishedAssetPortal.body.total, 0);

  const publishChangedAsset = await request("/api/ingestion/records/bulk-action", { token: dataOperator, tenantId: "TENANT-INGESTION-SECOND", method: "POST", body: JSON.stringify({ type: "asset", action: "publish", ids: [changedAsset.id] }) });
  assert.equal(publishChangedAsset.status, 200, JSON.stringify(publishChangedAsset.body));
  const manualAssetEdit = await request(`/api/ingestion/records/asset/${encodeURIComponent(changedAsset.id)}`, { token: dataOperator, method: "PUT", body: JSON.stringify({ type: "asset", targetId: deltaTarget.body.id, title: "资产 A 人工复核", category: "web", risk: "高", fields: { ...changedAsset.fields, alive: "true", statusCode: "418" } }) });
  assert.equal(manualAssetEdit.status, 200, JSON.stringify(manualAssetEdit.body));
  assert.equal(manualAssetEdit.body.isPublished, false);
  assert.equal(manualAssetEdit.body.changeType, "changed");
  assert.equal(manualAssetEdit.body.previousFields.alive, "false");
  assert.equal(manualAssetEdit.body.fields.alive, "true");
  assert.equal(manualAssetEdit.body.previousFields.statusCode, "503");
  assert.equal(manualAssetEdit.body.previouslyPublished, true);
  const metadataOnlyManualEdit = await request(`/api/ingestion/records/asset/${encodeURIComponent(manualAssetEdit.body.id)}`, { token: dataOperator, method: "PUT", body: JSON.stringify({ type: "asset", targetId: deltaTarget.body.id, title: "资产 A 仅修改标题", category: "web", risk: "中", fields: { ...manualAssetEdit.body.fields, title: "仅更新展示标题" } }) });
  assert.equal(metadataOnlyManualEdit.status, 200, JSON.stringify(metadataOnlyManualEdit.body));
  assert.equal(metadataOnlyManualEdit.body.changeType, "changed");
  assert.equal(metadataOnlyManualEdit.body.previousFields.statusCode, "503");
  assert.equal(metadataOnlyManualEdit.body.fields.statusCode, "418");
  await ingestionDb.end();

  const vulnerabilityCsv = "CVE,漏洞标题,漏洞描述,风险等级,漏洞来源,披露时间,处置建议,参考链接,标签,状态\nCVE-2026-71001,批量导入测试漏洞一,用于回归测试,high,测试导入,2026-07-22,升级版本,https://example.com/71001,测试组件,待处置\nCVE-2026-71002,批量导入测试漏洞二,用于回归测试,medium,测试导入,2026-07-22,安装补丁,https://example.com/71002,测试组件,待处置\n";
  const approvalPolicies = await request("/api/tenant-publication-policies?tenant_id=TENANT-CHANGAN", { token: dataOperator, method: "PUT", body: JSON.stringify({ policies: [{ module: "vulnerabilities", mode: "approval" }] }) });
  assert.equal(approvalPolicies.status, 200, JSON.stringify(approvalPolicies.body));
  const vulnerabilityForm = () => {
    const form = new FormData();
    form.append("file", new Blob([vulnerabilityCsv], { type: "text/csv" }), "漏洞清单.csv");
    form.append("targetId", "OBJ-CHANGAN");
    return form;
  };
  assert.equal((await request("/api/vulnerabilities/import", { token: portal, method: "POST", body: vulnerabilityForm() })).status, 403);
  const vulnerabilityImport = await request("/api/vulnerabilities/import", { token: dataOperator, method: "POST", body: vulnerabilityForm() });
  assert.equal(vulnerabilityImport.status, 201, JSON.stringify(vulnerabilityImport.body));
  assert.equal(vulnerabilityImport.body.inserted, 2);
  const importedVulnerabilities = await request(`/api/vulnerabilities?query=${encodeURIComponent("批量导入测试")}`, { token: dataOperator });
  assert.equal(importedVulnerabilities.status, 200);
  assert.equal(importedVulnerabilities.body.total, 2);
  assert.ok(importedVulnerabilities.body.data.every((item) => !item.isPublished && !item.reviewedAt));
  assert.equal((await request(`/api/vulnerabilities?query=${encodeURIComponent("批量导入测试")}`, { token: portal })).body.total, 0);
  const [firstVulnerability, secondVulnerability] = importedVulnerabilities.body.data;
  const vulnerabilityUpdated = await request(`/api/vulnerabilities/${encodeURIComponent(firstVulnerability.id)}`, { token: dataOperator, method: "PUT", body: JSON.stringify({ ...firstVulnerability, title: "批量导入测试漏洞一（已编辑）" }) });
  assert.equal(vulnerabilityUpdated.status, 200, JSON.stringify(vulnerabilityUpdated.body));
  assert.equal(vulnerabilityUpdated.body.title, "批量导入测试漏洞一（已编辑）");
  assert.equal(vulnerabilityUpdated.body.manuallyManaged, true);
  assert.ok(vulnerabilityUpdated.body.reviewedAt);
  const vulnerabilityPublished = await request(`/api/vulnerabilities/${encodeURIComponent(firstVulnerability.id)}/publish`, { token: dataOperator, method: "POST" });
  assert.equal(vulnerabilityPublished.status, 200, JSON.stringify(vulnerabilityPublished.body));
  assert.equal(vulnerabilityPublished.body.isPublished, true);
  assert.equal((await request(`/api/vulnerabilities?query=${encodeURIComponent("批量导入测试漏洞一")}`, { token: portal })).body.total, 1);
  assert.equal((await request(`/api/vulnerabilities/${encodeURIComponent(firstVulnerability.id)}`, { token: portal, method: "DELETE" })).status, 403);
  assert.equal((await request(`/api/vulnerabilities/${encodeURIComponent(firstVulnerability.id)}`, { token: dataOperator, method: "DELETE" })).status, 200);
  const bulkDeleted = await request("/api/vulnerabilities/bulk-delete", { token: dataOperator, method: "POST", body: JSON.stringify({ ids: [secondVulnerability.id] }) });
  assert.equal(bulkDeleted.status, 200);
  assert.equal(bulkDeleted.body.deleted, 1);
  assert.equal((await request(`/api/vulnerabilities?query=${encodeURIComponent("批量导入测试")}`, { token: dataOperator })).body.total, 0);

  const nextViewerPassword = "Viewer-Reset#2026";
  assert.equal((await request("/api/users/viewer.one/reset-password", { token: admin, method: "POST", body: JSON.stringify({ password: nextViewerPassword }) })).status, 200);
  assert.equal((await request("/api/auth/me", { token: viewer })).status, 401);
  assert.equal((await login("viewer.one", viewerPassword)).status, 401);
  const nextViewer = await login("viewer.one", nextViewerPassword);
  assert.equal(nextViewer.status, 200);
  assert.equal((await request("/api/users/viewer.one", { token: admin, method: "PUT", body: JSON.stringify({ name: "只读访客", roleKey: "portal-viewer", enabled: false }) })).status, 200);
  assert.equal((await request("/api/auth/me", { token: nextViewer.body.token })).status, 401);

  assert.equal((await request("/api/users/operator", { token: admin, method: "PUT", body: JSON.stringify({ name: "平台管理员", roleKey: "operations-admin", enabled: true }) })).status, 400);
  assert.equal((await request("/api/users/operator", { token: admin, method: "PUT", body: JSON.stringify({ name: "平台管理员", roleKey: "platform-admin", enabled: false }) })).status, 400);

  assert.equal((await request("/api/users/operator", { token: admin, method: "DELETE" })).status, 400);
  assert.equal((await request("/api/users/viewer.one", { token: portal, method: "DELETE" })).status, 403);
  assert.equal((await request("/api/users/viewer.one", { token: admin })).status, 200);
  assert.equal((await request("/api/users/viewer.one", { token: admin, method: "DELETE" })).status, 200);
  assert.equal((await request("/api/users/viewer.one", { token: admin })).status, 404);

  const targetCreated = await request("/api/targets", { token: admin, method: "POST", body: JSON.stringify({ tenantId: "TENANT-CHANGAN", name: "CRUD 测试对象", targetType: "供应商", owner: "测试员", domains: ["crud.example"], ips: [], keywords: ["CRUD"] }) });
  assert.equal(targetCreated.status, 201);
  const targetId = targetCreated.body.id;
  assert.equal((await request(`/api/targets/${targetId}`, { token: admin })).body.name, "CRUD 测试对象");
  const targetUpdated = await request(`/api/targets/${targetId}`, { token: admin, method: "PUT", body: JSON.stringify({ ...targetCreated.body, name: "CRUD 测试对象（已更新）" }) });
  assert.equal(targetUpdated.status, 200);
  assert.equal(targetUpdated.body.name, "CRUD 测试对象（已更新）");

  const connectionCreated = await request("/api/connections", { token: admin, method: "POST", body: JSON.stringify({ name: "CRUD 测试接口", category: "其他", endpoint: "https://crud.example/api", method: "GET", targetId }) });
  assert.equal(connectionCreated.status, 201);
  const connectionId = connectionCreated.body.id;
  assert.equal((await request(`/api/connections/${connectionId}`, { token: admin })).body.name, "CRUD 测试接口");
  assert.equal((await request(`/api/targets/${targetId}`, { token: admin, method: "DELETE" })).status, 409);
  assert.equal((await request(`/api/connections/${connectionId}`, { token: portal, method: "DELETE" })).status, 403);
  assert.equal((await request(`/api/connections/${connectionId}`, { token: admin, method: "DELETE" })).status, 200);
  assert.equal((await request(`/api/connections/${connectionId}`, { token: admin })).status, 404);
  assert.equal((await request(`/api/targets/${targetId}`, { token: admin, method: "DELETE" })).status, 200);
  assert.equal((await request(`/api/targets/${targetId}`, { token: admin })).status, 404);
});
