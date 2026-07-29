import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { deriveCaptchaAnswer } from "@sentinel/auth-captcha";

function envFile(path) {
  return readFile(path, "utf8").then((text) => Object.fromEntries(text.split(/\r?\n/u).map((line) => {
    const separator = line.indexOf("=");
    return separator > 0 ? [line.slice(0, separator), line.slice(separator + 1)] : null;
  }).filter(Boolean)));
}

const cloudEnvPath = process.env.SENTINEL_SMOKE_CLOUD_ENV;
const activationPath = process.env.SENTINEL_SMOKE_ACTIVATION_FILE;
const baseUrl = String(process.env.SENTINEL_SMOKE_CLOUD_URL || "https://127.0.0.1:8787").replace(/\/$/u, "");
if (!cloudEnvPath || !activationPath) throw new Error("缺少 SENTINEL_SMOKE_CLOUD_ENV 或 SENTINEL_SMOKE_ACTIVATION_FILE");
const cloudEnv = await envFile(cloudEnvPath);

async function request(path, { token, tenantId, raw = false, ...options } = {}) {
  const headers = new Headers(options.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (tenantId) headers.set("X-Sentinel-Tenant-Id", tenantId);
  if (options.body && !(options.body instanceof FormData) && typeof options.body === "string") headers.set("Content-Type", "application/json");
  const response = await fetch(path.startsWith("http") ? path : `${baseUrl}${path}`, { ...options, headers });
  if (raw) return { status: response.status, headers: response.headers, body: new Uint8Array(await response.arrayBuffer()) };
  const contentType = response.headers.get("content-type") || "";
  return { status: response.status, headers: response.headers, body: contentType.includes("json") ? await response.json() : await response.text() };
}

function expectStatus(result, status, label) {
  assert.equal(result.status, status, `${label}: ${JSON.stringify(result.body)}`);
  return result.body;
}

const captcha = expectStatus(await request("/api/auth/captcha"), 200, "获取 Cloud 验证码");
const login = expectStatus(await request("/api/auth/login", {
  method: "POST",
  body: JSON.stringify({
    account: cloudEnv.SENTINEL_ADMIN_ACCOUNT,
    password: cloudEnv.SENTINEL_ADMIN_PASSWORD,
    captchaId: captcha.captchaId,
    captchaCode: deriveCaptchaAnswer(cloudEnv.SENTINEL_SECRET, captcha.captchaId)
  })
}), 200, "Cloud 管理员登录");
const token = login.token;

expectStatus(await request("/api/targets", { token }), 400, "缺失租户上下文必须拒绝");
const primaryTenant = "TENANT-CHANGAN";
const suffix = Date.now().toString(36).toUpperCase();
const secondaryTenant = `TENANT-SMOKE-${suffix}`;
expectStatus(await request("/api/edge/tenants", {
  token,
  method: "POST",
  body: JSON.stringify({ id: secondaryTenant, name: `隔离验收客户 ${suffix}` })
}), 201, "创建隔离租户");

const createTarget = (tenantId, name, domain) => request("/api/targets", {
  token,
  tenantId,
  method: "POST",
  body: JSON.stringify({ tenantId, name, targetType: "企业", owner: "镜像验收", domains: [domain], ips: [], keywords: [name] })
});
const primaryTarget = expectStatus(await createTarget(primaryTenant, `Cloud-Edge 验收对象 ${suffix}`, "smoke.example.test"), 201, "创建主租户目标");
const secondaryTarget = expectStatus(await createTarget(secondaryTenant, `隔离对象 ${suffix}`, "isolated.example.test"), 201, "创建隔离租户目标");
expectStatus(await request(`/api/targets/${encodeURIComponent(primaryTarget.id)}`, { token, tenantId: secondaryTenant }), 404, "跨租户读取必须拒绝");
expectStatus(await request(`/api/targets/${encodeURIComponent(secondaryTarget.id)}`, {
  token,
  tenantId: primaryTenant,
  method: "PUT",
  body: JSON.stringify({ name: "越权修改", targetType: "企业", owner: "越权", domains: [], ips: [], keywords: [] })
}), 404, "跨租户写入必须拒绝");

const policies = expectStatus(await request(`/api/tenant-publication-policies?tenant_id=${primaryTenant}`, { token, tenantId: primaryTenant }), 200, "读取发布策略");
assert.deepEqual(Object.fromEntries(policies.map((item) => [item.module, item.mode])), {
  sensitive: "approval", asset: "approval", "dark-web": "approval", credentials: "auto", vulnerabilities: "auto"
});

const sensitive = expectStatus(await request("/api/ingestion/records", {
  token,
  tenantId: primaryTenant,
  method: "POST",
  body: JSON.stringify({ type: "sensitive", tenantId: primaryTenant, targetId: primaryTarget.id, title: `验收敏感文档 ${suffix}`, category: "documents", risk: "高", fields: { name: "验收资料.pdf", channel: "公开网盘", note: "镜像验收" } })
}), 201, "创建敏感信息");
assert.equal(sensitive.isPublished, false);

function assetForm(websites, filename) {
  const form = new FormData();
  form.append("file", new Blob([`<script>window.data=${JSON.stringify({ dns: [], ports: [], websites, products: { datasource: [] }, icons: [] })};</script>`], { type: "text/html" }), filename);
  form.append("targetId", primaryTarget.id);
  return form;
}
const baselineAssets = [
  { url: "https://asset-a.example.test", ip: "203.0.113.10", domain: "asset-a.example.test", port: 443, status_code: 200, alive: true, title: "资产 A", geo: "北京市", ipLocation: "北京市" },
  { url: "https://asset-b.example.test", ip: "203.0.113.11", domain: "asset-b.example.test", port: 443, status_code: 200, alive: true, title: "资产 B", geo: "上海市", ipLocation: "上海市" }
];
const baseline = expectStatus(await request("/api/ingestion/assets-html", { token, tenantId: primaryTenant, method: "POST", body: assetForm(baselineAssets, "资产基线.html") }), 201, "导入资产基线");
assert.deepEqual([baseline.newRows, baseline.changedRows, baseline.missingRows], [2, 0, 0]);
expectStatus(await request("/api/ingestion/records/publish-all", { token, tenantId: primaryTenant, method: "POST", body: JSON.stringify({ type: "asset", tenantId: primaryTenant }) }), 200, "发布资产基线");
const changedAssets = [
  { ...baselineAssets[0], status_code: 503, alive: false, title: "资产 A 暂不可用" },
  { url: "https://asset-c.example.test", ip: "203.0.113.12", domain: "asset-c.example.test", port: 443, status_code: 201, alive: true, title: "资产 C", geo: "广东省", ipLocation: "广东省深圳市" }
];
const delta = expectStatus(await request("/api/ingestion/assets-html", { token, tenantId: primaryTenant, method: "POST", body: assetForm(changedAssets, "资产更新.html") }), 201, "导入资产更新");
assert.deepEqual([delta.newRows, delta.changedRows, delta.missingRows, delta.aliveChangedRows, delta.statusCodeChangedRows], [1, 1, 1, 1, 1]);
const assetRecords = expectStatus(await request(`/api/ingestion/records?type=asset&target_id=${encodeURIComponent(primaryTarget.id)}`, { token, tenantId: primaryTenant }), 200, "读取资产差异");
assert.deepEqual(new Set(assetRecords.data.map((item) => item.changeType)), new Set(["new", "changed", "missing"]));

const png = await readFile(new URL("../../../docs/assets/sentinel-cloud-edge-architecture.png", import.meta.url));
const imageForm = new FormData();
imageForm.append("file", new Blob([png], { type: "image/png" }), "正文图片.png");
const image = expectStatus(await request("/api/ingestion/article-images", { token, tenantId: primaryTenant, method: "POST", body: imageForm }), 201, "上传正文图片");
const darkWeb = expectStatus(await request("/api/ingestion/records", {
  token,
  tenantId: primaryTenant,
  method: "POST",
  body: JSON.stringify({ type: "dark-web", tenantId: primaryTenant, targetId: primaryTarget.id, title: `验收暗网情报 ${suffix}`, risk: "high", reportDate: new Date().toISOString().slice(0, 10), sourceGroupName: "镜像验收", intelTags: ["数据泄露"], leakDataTypes: "账号信息", leakCount: "1", intelNote: "Cloud 全量预览与 Edge 发布版验收", articleMarkdown: `<p>正文图片同步验收</p><img src="${image.location}" alt="正文图片">` })
}), 201, "创建暗网情报");
assert.match(darkWeb.articleMarkdown, /\/api\/article-images\//u);

const vulnerability = expectStatus(await request("/api/vulnerabilities", {
  token,
  tenantId: primaryTenant,
  method: "POST",
  body: JSON.stringify({ tenantId: primaryTenant, targetId: primaryTarget.id, cve: "CVE-2026-99999", title: `验收漏洞 ${suffix}`, summary: "用于验证漏洞发布与快照同步", risk: "critical", source: "手工验收", solutions: "升级并验证", tags: ["重保"], publish: true })
}), 201, "创建并发布漏洞");
assert.equal(vulnerability.isPublished, true);

const subscriptionId = Number(String(Date.now()).slice(-8));
execFileSync("docker", ["exec", "sentinel-cloud-cloud-postgres-1", "psql", "-U", cloudEnv.POSTGRES_USER, "-d", cloudEnv.POSTGRES_DB, "-v", "ON_ERROR_STOP=1", "-c",
  `INSERT INTO credential_subscriptions (id,target_id,sub_type,sub_category,value,expire_time,count,tenant_id) VALUES (${subscriptionId},'${primaryTarget.id}','credential-leak','credential','smoke.example.test','2027-12-31T23:59:59Z',1,'${primaryTenant}')`], { stdio: "ignore" });
const credential = expectStatus(await request("/api/credentials/records", {
  token,
  tenantId: primaryTenant,
  method: "POST",
  body: JSON.stringify({ tenantId: primaryTenant, subId: subscriptionId, url: "https://sso.smoke.example.test", systemName: "验收统一认证", account: "smoke-user", password: "Masked-Smoke#2026", source: "暗网情报", leakedAt: new Date().toISOString() })
}), 201, "创建账号凭据");
assert.equal(credential.isPublished, true);

for (const type of ["sensitive", "asset", "dark-web"]) {
  expectStatus(await request("/api/ingestion/records/publish-all", { token, tenantId: primaryTenant, method: "POST", body: JSON.stringify({ type, tenantId: primaryTenant }) }), 200, `发布 ${type}`);
}

const preview = expectStatus(await request(`/api/tenant-portal-preview?tenant_id=${primaryTenant}`, { token, tenantId: primaryTenant }), 200, "Cloud Portal 全量预览");
assert.ok(preview.counts.sensitive.total >= 1 && preview.counts.asset.total >= 3 && preview.counts["dark-web"].total >= 1 && preview.counts.vulnerabilities.total >= 1 && preview.counts.credentials.total >= 1);
const isolatedPreview = expectStatus(await request(`/api/tenant-portal-preview?tenant_id=${secondaryTenant}`, { token, tenantId: secondaryTenant }), 200, "隔离租户 Portal 预览");
assert.deepEqual(Object.values(isolatedPreview.counts).map((item) => item.total), [0, 0, 0, 0, 0]);

const deploymentResult = expectStatus(await request("/api/edge/deployments", {
  token,
  method: "POST",
  body: JSON.stringify({ tenantId: primaryTenant, name: `本地验收地端 ${suffix}`, syncMode: "api_pull", pollIntervalSeconds: 3600 })
}), 201, "创建 Edge 部署");
assert.equal(deploymentResult.deployment.pollIntervalSeconds, 3600);

async function waitForSnapshotJob(id) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const job = expectStatus(await request(`/api/edge/snapshot-jobs/${id}`, { token }), 200, "查询快照任务");
    if (job.status === "succeeded") return job;
    if (job.status === "failed") throw new Error(`快照构建失败：${job.errorMessage || "未知错误"}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("等待快照构建超时");
}
await waitForSnapshotJob(deploymentResult.snapshotJob.id);
const latest = expectStatus(await request("/edge/v1/snapshots/latest", { headers: { Authorization: `Bearer ${deploymentResult.activationConfig.apiKey}` } }), 200, "读取最新快照描述");
const notModified = await request("/edge/v1/snapshots/latest", { headers: { Authorization: `Bearer ${deploymentResult.activationConfig.apiKey}`, "If-None-Match": latest.headers?.get?.("etag") || `\"snapshot-${latest.version}\"` } });
assert.equal(notModified.status, 304, "快照未变化时必须返回 304");

await writeFile(activationPath, JSON.stringify({
  cloudBaseUrl: baseUrl,
  apiKey: deploymentResult.activationConfig.apiKey,
  licenseKey: deploymentResult.license.licenseKey,
  deploymentId: deploymentResult.deployment.id,
  tenantId: primaryTenant,
  targetId: primaryTarget.id,
  articleImageLocation: image.location,
  expected: { sensitiveId: sensitive.id, darkWebId: darkWeb.id, vulnerabilityId: vulnerability.id, credentialId: credential.id, snapshotVersion: latest.version }
}, null, 2), { mode: 0o600 });

console.log(JSON.stringify({ ok: true, tenantId: primaryTenant, isolatedTenantId: secondaryTenant, targetId: primaryTarget.id, deploymentId: deploymentResult.deployment.id, snapshotVersion: latest.version, assetDelta: { new: delta.newRows, changed: delta.changedRows, missing: delta.missingRows, aliveChanged: delta.aliveChangedRows, statusCodeChanged: delta.statusCodeChangedRows }, previewCounts: preview.counts }, null, 2));
