import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import XLSX from "xlsx";
import { MAX_DARK_WEB_ARTICLE_CHARS } from "@sentinel/contracts";
import { createCaptchaService } from "@sentinel/auth-captcha";
import { assertEncryptedHttpUrl, assertSafeSvgIcon, createGuardedHttpClient, isSvgIconContent, resolveTlsServerConfig, svgIconResponseHeaders } from "@sentinel/transport-security";
import { closeDatabase, databaseInfo, db, migrate } from "./database.mjs";
import { createWorkbookPreview, createWordPreview, parseDarkWebUpload, assertSafeOoxml } from "./dark-web.mjs";
import { readDarkWebBlobFromDirectories, storePlainDarkWebBlob } from "./dark-web-storage.mjs";
import { ARTICLE_IMAGE_UPLOAD_MAX_BYTES, externalizeArticleImages, optimizeArticleImage, readArticleImage, readArticleImageFromDirectories, storeArticleImage } from "./article-images.mjs";
import { createSecretCodec } from "./app/secret-codec.mjs";
import { createPublicErrorResponse } from "./app/error-response.mjs";
import { cloudSwaggerHtml, createCloudOpenApiDocument } from "./app/openapi.mjs";
import { createStaticSiteHandler } from "./app/static-site.mjs";
import { createCloudEdgeModule } from "./modules/cloud-edge/index.mjs";
import { createSnapshotJobQueue } from "./modules/cloud-edge/job-queue.mjs";
import { createCloudEdgeRepository } from "./modules/cloud-edge/repository.mjs";
import { createConnectorService } from "./modules/connectors/service.mjs";
import { createVulnerabilityAlertService } from "./modules/vulnerability-alerts/service.mjs";
import { createCollectionJobQueue, parseCollectionRun } from "./modules/collection/job-queue.mjs";
import { BACKGROUND_TASK_CATALOG } from "./modules/background/task-registry.mjs";
import { createBackgroundScheduleService, describeSchedule } from "./modules/background/schedule-service.mjs";
import { createBullmqRuntime } from "./modules/background/bullmq-runtime.mjs";
import { createTaskOutbox } from "./modules/background/task-outbox.mjs";
import { ensureSimpleIconCatalog, syncSimpleIconCatalog } from "./fingerprint-icon-catalog.mjs";
import { syncDomesticFingerprintIconCatalog } from "./domestic-fingerprint-icon-catalog.mjs";
import { syncProviderIconCatalog } from "./provider-icon-catalog.mjs";
import { assetReportCounts, assetReportRowIsSince, assetReportTodayCounts, projectAssetReportData } from "./asset-report-projection.mjs";
import { aggregateAssetRegions } from "./asset-regions.mjs";
import { assetChangedFields } from "./asset-change.mjs";
import { createOtpAuthUri, createTotpSecret, verifyTotpCode } from "./modules/auth/totp.mjs";

// 主密钥解析：生产环境缺失或过弱时拒绝启动，杜绝静默使用公开开发密钥（加密接口密钥、TOTP、暗网密文及云地签名）。
function resolveMasterSecret(value, { nodeEnv, name, devFallback, minLength = 32 } = {}) {
  const secret = String(value || "");
  if (nodeEnv === "production") {
    if (secret.length < minLength) throw new Error(`生产环境必须配置强随机 ${name}（至少 ${minLength} 位），且不得使用开发默认值`);
    return secret;
  }
  if (secret) return secret;
  console.warn(`[security] 未设置 ${name}，开发环境回退为公开默认密钥；生产环境必须显式配置。`);
  return devFallback;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.SENTINEL_DATA_DIR || join(__dirname, "../../../.runtime/cloud-data");
const reportsDir = join(dataDir, "reports");
const darkWebBlobsDir = join(dataDir, "dark-web/blobs");
const articleImagesDir = join(dataDir, "upload/images");
const legacyDataDir = process.env.SENTINEL_LEGACY_DATA_DIR || "";
const darkWebBlobDirectories = [darkWebBlobsDir, legacyDataDir && join(legacyDataDir, "dark-web/blobs")].filter(Boolean);
const articleImageDirectories = [articleImagesDir, legacyDataDir && join(legacyDataDir, "upload/images")].filter(Boolean);
const ingestionFilesDir = join(dataDir, "ingestion/files");
const adminSite = createStaticSiteHandler(process.env.SENTINEL_ADMIN_DIST || "");
const fingerprintIconMaxBytes = 256 * 1024;
// favicon 采集出网客户端：DNS pinning + 内网防护（不放行任何内网/回环）+ 响应大小上限，重定向由调用方逐跳复检。
const faviconHttpClient = createGuardedHttpClient({ allowlist: [], allowLoopback: false, redirect: "manual", maxBytes: fingerprintIconMaxBytes });
mkdirSync(dataDir, { recursive: true });
mkdirSync(reportsDir, { recursive: true });
mkdirSync(darkWebBlobsDir, { recursive: true });
mkdirSync(articleImagesDir, { recursive: true });
mkdirSync(ingestionFilesDir, { recursive: true });
const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || "127.0.0.1";
const transportSecurity = resolveTlsServerConfig({
  nodeEnv: process.env.NODE_ENV,
  certificateFile: process.env.SENTINEL_TLS_CERT_FILE,
  privateKeyFile: process.env.SENTINEL_TLS_KEY_FILE,
  certificateAuthorityFile: process.env.SENTINEL_TLS_CA_FILE,
  readFile: readFileSync,
  variablePrefix: "SENTINEL_TLS"
});
const publicBaseUrl = assertEncryptedHttpUrl(
  process.env.SENTINEL_PUBLIC_BASE_URL || `${transportSecurity.protocol}://127.0.0.1:${port}`,
  { label: "SENTINEL_PUBLIC_BASE_URL", allowLoopbackHttp: process.env.NODE_ENV !== "production" }
).toString().replace(/\/$/, "");
const apiDocsEnabled = !["0", "false", "no", "off"].includes(String(process.env.SENTINEL_API_DOCS_ENABLED || "true").trim().toLowerCase());
const cloudOpenApiDocument = createCloudOpenApiDocument({ serverUrl: publicBaseUrl });
const secret = resolveMasterSecret(process.env.SENTINEL_SECRET, {
  nodeEnv: process.env.NODE_ENV,
  name: "SENTINEL_SECRET",
  devFallback: "sentinel-local-development-secret"
});
const { encryptionKey, encrypt, decrypt } = createSecretCodec(secret);
const captchaService = createCaptchaService({
  secret,
  repository: {
    async create({ tokenHash: challengeHash, answerHash, expiresAt }) {
      await db.prepare("DELETE FROM captcha_challenges WHERE expires_at<=NOW()").run();
      await db.prepare("INSERT INTO captcha_challenges(token_hash,answer_hash,expires_at) VALUES (?,?,?)").run(challengeHash, answerHash, expiresAt);
    },
    consume(challengeHash) {
      return db.prepare("DELETE FROM captcha_challenges WHERE token_hash=? AND expires_at>NOW() RETURNING answer_hash").get(challengeHash);
    }
  }
});
const vulnerabilityAlerts = createVulnerabilityAlertService({ db });
const connectorService = createConnectorService({
  db,
  decrypt,
  onVulnerabilitiesChanged: (tenantId) => vulnerabilityAlerts.recompute({ tenantId }),
  onAssetsChanged: (tenantId) => vulnerabilityAlerts.recompute({ tenantId })
});
const { providers: connectorProviders, assertEndpoint, testConnection, syncConnection } = connectorService;

const permissionLabels = {
  "portal:read": "查看情报前台", "evidence:download": "下载事件证据",
  "accounts:manage": "管理账号权限", "ingestion:manage": "管理数据录入",
  "targets:read": "查看监测对象", "targets:manage": "管理监测对象",
  "sources:read": "查看数据源", "sources:manage": "管理数据源",
  "operations:manage": "运营处置与状态管理"
};
const roleDefinitions = {
  "platform-admin": { key: "platform-admin", label: "平台管理员", description: "拥有前后台全部权限，负责账号、配置和运营管理。", workspace: "both", permissions: Object.keys(permissionLabels) },
  "operations-admin": { key: "operations-admin", label: "运营管理员", description: "负责日常录入、数据源、监测对象和运营处置，不管理平台账号。", workspace: "both", permissions: ["portal:read", "evidence:download", "ingestion:manage", "targets:read", "targets:manage", "sources:read", "sources:manage", "operations:manage"] },
  "data-operator": { key: "data-operator", label: "数据运营", description: "负责数据录入，并可查看监测对象和数据源配置。", workspace: "admin", permissions: ["ingestion:manage", "targets:read", "sources:read"] },
  "intelligence-analyst": { key: "intelligence-analyst", label: "情报分析师", description: "查看前台情报并下载授权证据文件。", workspace: "portal", permissions: ["portal:read", "evidence:download"] },
  "portal-viewer": { key: "portal-viewer", label: "前台访客", description: "只读查看前台情报，不允许下载原始证据。", workspace: "portal", permissions: ["portal:read"] }
};

await migrate();
await vulnerabilityAlerts.ensureDefaultWatchGroups();
await vulnerabilityAlerts.recompute();
const bullmq = createBullmqRuntime();
await bullmq.ping();
const taskOutbox = createTaskOutbox({ db, runtime: bullmq });

function normalizedHttpUrl(value) {
  try {
    const parsed = new URL(String(value || "").trim());
    if (!["http:", "https:"].includes(parsed.protocol)) return "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return "";
  }
}

function normalizedFingerprintName(value) {
  const name = String(value || "").trim().replace(/\s+/g, " ");
  if (!name || name.length > 160) throw Object.assign(new Error("指纹名称不能为空且不能超过 160 个字符"), { statusCode: 400 });
  return name;
}

function normalizedFingerprintAliases(value, canonicalName) {
  const values = Array.isArray(value) ? value : String(value || "").split(/[、,，;；|\n]+/);
  return [...new Set(values.map((item) => String(item).trim().replace(/\s+/g, " ")).filter((item) => item && item.toLowerCase() !== canonicalName.toLowerCase()))].slice(0, 40);
}

function isPrivateAddress(address) {
  const value = String(address || "").toLowerCase();
  return value === "::1" || value === "localhost" || value.startsWith("127.") || value.startsWith("10.") || value.startsWith("192.168.") || /^172\.(1[6-9]|2\d|3[0-1])\./.test(value) || value === "0.0.0.0" || value.startsWith("169.254.") || value.startsWith("fc") || value.startsWith("fd") || value.startsWith("fe80:");
}

async function assertPublicFaviconUrl(value) {
  const target = normalizedHttpUrl(value);
  if (!target) throw Object.assign(new Error("favicon 地址必须是 http 或 https URL"), { statusCode: 400 });
  const parsed = new URL(target);
  if (parsed.protocol !== "https:") throw Object.assign(new Error("favicon 地址必须使用 HTTPS"), { statusCode: 400 });
  if (isPrivateAddress(parsed.hostname) || parsed.hostname.endsWith(".local")) throw Object.assign(new Error("不允许请求内网或本机地址"), { statusCode: 400 });
  try {
    const resolved = await lookup(parsed.hostname);
    if (isPrivateAddress(resolved.address)) throw Object.assign(new Error("不允许请求解析到内网的地址"), { statusCode: 400 });
  } catch (error) {
    if (error?.statusCode) throw error;
    throw Object.assign(new Error("favicon 域名解析失败"), { statusCode: 400 });
  }
  return target;
}

function iconMediaType(buffer, contentType = "") {
  const header = String(contentType).split(";", 1)[0].trim().toLowerCase();
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (buffer.subarray(0, 6).toString("ascii") === "GIF89a" || buffer.subarray(0, 6).toString("ascii") === "GIF87a") return "image/gif";
  if (buffer.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return "image/jpeg";
  if (buffer.subarray(0, 4).equals(Buffer.from([0, 0, 1, 0]))) return "image/x-icon";
  if (header === "image/webp" && buffer.subarray(0, 4).toString("ascii") === "RIFF") return "image/webp";
  if (isSvgIconContent(buffer, header)) {
    assertSafeSvgIcon(buffer);
    return "image/svg+xml";
  }
  throw Object.assign(new Error("仅支持 PNG、ICO、SVG、WEBP、JPEG 或 GIF 图标"), { statusCode: 400 });
}

function parseIconDataUri(value) {
  const match = String(value || "").match(/^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i);
  if (!match) throw Object.assign(new Error("上传图标必须是 base64 data URL"), { statusCode: 400 });
  const buffer = Buffer.from(match[2].replace(/\s+/g, ""), "base64");
  if (!buffer.length || buffer.length > fingerprintIconMaxBytes) throw Object.assign(new Error("图标大小必须在 1B-256KB 之间"), { statusCode: 400 });
  const mediaType = iconMediaType(buffer, match[1]);
  return { buffer, mediaType, iconData: `data:${mediaType};base64,${buffer.toString("base64")}` };
}

async function fetchFaviconData(value) {
  const normalized = normalizedHttpUrl(value);
  if (!normalized) throw Object.assign(new Error("favicon 地址必须是 http 或 https URL"), { statusCode: 400 });
  const requested = new URL(normalized);
  if (!/\.(?:ico|png|svg|webp|jpe?g|gif|avif)$/i.test(requested.pathname)) requested.pathname = "/favicon.ico";
  let target = await assertPublicFaviconUrl(requested.toString());
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    let response;
    for (let redirect = 0; redirect <= 3; redirect += 1) {
      response = await faviconHttpClient(target, { signal: controller.signal, timeoutMs: 8000, headers: { Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8", "User-Agent": "Sentinel-Favicon-Collector/1.0" } });
      if (response.status < 300 || response.status >= 400) break;
      const location = response.headers.get("location");
      if (!location || redirect === 3) throw Object.assign(new Error("favicon 重定向次数过多"), { statusCode: 502 });
      target = await assertPublicFaviconUrl(new URL(location, target).toString());
    }
    if (!response.ok) throw Object.assign(new Error(`favicon 请求失败（HTTP ${response.status}）`), { statusCode: 502 });
    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength > fingerprintIconMaxBytes) throw Object.assign(new Error("favicon 响应超过 256KB 限制"), { statusCode: 413 });
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length || buffer.length > fingerprintIconMaxBytes) throw Object.assign(new Error("favicon 响应大小不合法"), { statusCode: 413 });
    const mediaType = iconMediaType(buffer, response.headers.get("content-type") || "");
    return { sourceUrl: target, buffer, mediaType, iconData: `data:${mediaType};base64,${buffer.toString("base64")}` };
  } catch (error) {
    if (error?.name === "AbortError") throw Object.assign(new Error("favicon 请求超时"), { statusCode: 504 });
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function parseFingerprintIcon(row) {
  return { id: row.id, fingerprintName: row.fingerprint_name, aliases: Array.isArray(row.aliases_json) ? row.aliases_json : parseJson(row.aliases_json, []), source: row.source, sourceUrl: row.source_url || "", mediaType: row.media_type, iconSha256: row.icon_sha256, iconUrl: `/api/fingerprint-icons/${encodeURIComponent(row.id)}/icon`, active: Boolean(row.active), createdBy: row.created_by || "", updatedBy: row.updated_by || "", createdAt: row.created_at, updatedAt: row.updated_at };
}

async function fingerprintIconValues(body, current, actor) {
  const fingerprintName = normalizedFingerprintName(body.fingerprintName ?? current?.fingerprint_name);
  const aliases = normalizedFingerprintAliases(body.aliases ?? current?.aliases_json, fingerprintName);
  const source = String(body.source || current?.source || "upload");
  if (!["upload", "favicon", "iconify", "simple-icons", "domestic", "provider", "custom"].includes(source)) throw Object.assign(new Error("图标来源不合法"), { statusCode: 400 });
  let icon = current ? { iconData: current.icon_data, mediaType: current.media_type, iconSha256: current.icon_sha256, sourceUrl: current.source_url || "" } : null;
  if (source === "favicon") {
    if (!body.sourceUrl && !current?.source_url) throw Object.assign(new Error("favicon 来源必须填写请求地址"), { statusCode: 400 });
    const fetched = await fetchFaviconData(body.sourceUrl || current.source_url);
    icon = { iconData: fetched.iconData, mediaType: fetched.mediaType, iconSha256: createHash("sha256").update(fetched.buffer).digest("hex"), sourceUrl: fetched.sourceUrl };
  } else if (body.iconData) {
    const uploaded = parseIconDataUri(body.iconData);
    icon = { iconData: uploaded.iconData, mediaType: uploaded.mediaType, iconSha256: createHash("sha256").update(uploaded.buffer).digest("hex"), sourceUrl: normalizedHttpUrl(body.sourceUrl || "") };
  }
  if (!icon?.iconData) throw Object.assign(new Error("请上传图标或填写 favicon 请求地址"), { statusCode: 400 });
  const iconBuffer = Buffer.from(String(icon.iconData).split(",", 2)[1] || "", "base64");
  if (isSvgIconContent(iconBuffer, icon.mediaType)) {
    const safeBuffer = assertSafeSvgIcon(iconBuffer);
    icon = {
      ...icon,
      mediaType: "image/svg+xml",
      iconData: `data:image/svg+xml;base64,${safeBuffer.toString("base64")}`,
      iconSha256: createHash("sha256").update(safeBuffer).digest("hex")
    };
  }
  return { fingerprintName, aliases, source, sourceUrl: icon.sourceUrl || normalizedHttpUrl(body.sourceUrl || ""), mediaType: icon.mediaType, iconData: icon.iconData, iconSha256: icon.iconSha256, actor: actor.account };
}

function storedPublicationDate(value, reportDate, fallback) {
  for (const candidate of [value, reportDate && `${reportDate}T00:00:00Z`, fallback]) {
    const parsed = new Date(candidate);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return new Date().toISOString();
}

function normalizeIntelTags(value, { required = false, fallback = [] } = {}) {
  const values = Array.isArray(value) ? value : String(value || "").split(/[、,，;；|/\n]+/);
  const tags = [...new Set(values.map((item) => String(item).trim()).filter(Boolean))];
  if (tags.length > 8) throw Object.assign(new Error("情报标签不能超过 8 个"), { statusCode: 400 });
  if (tags.some((tag) => tag.length > 40)) throw Object.assign(new Error("单个情报标签不能超过 40 个字符"), { statusCode: 400 });
  if (required && !tags.length) throw Object.assign(new Error("至少选择一个情报标签"), { statusCode: 400 });
  return tags.length ? tags : fallback;
}

function parseDarkWebFile(row) {
  return {
    id: row.id,
    kind: row.kind,
    name: row.original_name,
    sizeBytes: row.size_bytes,
    sha256: row.blob_sha256,
    mediaType: row.media_type,
    sheetCount: row.sheet_count,
    rowCount: row.row_count,
    columnCount: row.column_count
  };
}

function darkWebBlob(row) {
  return readDarkWebBlobFromDirectories(darkWebBlobDirectories, row, encryptionKey);
}

function download(res, value, name, mediaType) {
  const encoded = encodeURIComponent(name);
  res.writeHead(200, {
    "Content-Type": mediaType || "application/octet-stream",
    "Content-Length": value.length,
    "Content-Disposition": `attachment; filename*=UTF-8''${encoded}`,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  res.end(value);
}

function persistIngestionSource(batchId, filename, buffer) {
  const path = join(ingestionFilesDir, `${batchId}-${basename(filename)}`);
  writeFileSync(path, buffer, { flag: "wx", mode: 0o600 });
  return path;
}

function hashPassword(password, salt) { return scryptSync(password, salt, 64).toString("hex"); }
function roleFor(key) { return roleDefinitions[key] || null; }
function permissionsFor(user) { return roleFor(user.role_key)?.permissions || []; }
function parseUser(row) {
  const role = roleFor(row.role_key) || roleDefinitions["portal-viewer"];
  return {
    id: `USR-${createHash("sha256").update(row.account).digest("hex").slice(0, 10).toUpperCase()}`,
    account: row.account, name: row.name, role: role.label, roleKey: role.key,
    workspace: role.workspace, permissions: role.permissions,
    enabled: Boolean(row.enabled), status: row.enabled ? "正常" : "停用",
    totpEnabled: Boolean(row.totp_enabled),
    email: row.email || "", phone: row.phone || "", department: row.department || "",
    passwordChangedAt: row.password_changed_at || null,
    lastLoginAt: row.last_login_at || null,
    lastLogin: row.last_login_at ? row.last_login_at.replace("T", " ").slice(0, 16) : "尚未登录",
    createdAt: row.created_at || "", updatedAt: row.updated_at || ""
  };
}
async function readPasswordPolicy() {
  const row = await db.prepare("SELECT * FROM platform_password_policy WHERE id=1").get();
  return {
    minLength: Number(row?.min_length || 12), maxLength: Number(row?.max_length || 128),
    requireUppercase: row ? Boolean(row.require_uppercase) : true,
    requireLowercase: row ? Boolean(row.require_lowercase) : true,
    requireNumber: row ? Boolean(row.require_number) : true,
    requireSpecial: row ? Boolean(row.require_special) : true,
    historyCount: Number(row?.history_count || 0), updatedAt: row?.updated_at || ""
  };
}
async function assertPassword(password, account = "") {
  const policy = await readPasswordPolicy();
  if (typeof password !== "string" || password.length < policy.minLength || password.length > policy.maxLength) throw Object.assign(new Error(`密码长度必须为 ${policy.minLength}-${policy.maxLength} 位`), { statusCode: 400 });
  const missing = [];
  if (policy.requireUppercase && !/[A-Z]/.test(password)) missing.push("大写字母");
  if (policy.requireLowercase && !/[a-z]/.test(password)) missing.push("小写字母");
  if (policy.requireNumber && !/\d/.test(password)) missing.push("数字");
  if (policy.requireSpecial && !/[^A-Za-z0-9]/.test(password)) missing.push("特殊字符");
  if (missing.length) throw Object.assign(new Error(`密码必须包含：${missing.join("、")}`), { statusCode: 400 });
  return policy;
}
function assertAccount(account) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/.test(account)) throw Object.assign(new Error("账号需为 3-64 位字母、数字、点、下划线或横线"), { statusCode: 400 });
}
function tokenHash(value) { return createHash("sha256").update(value).digest("hex"); }
async function createLoginChallenge(account) {
  const challengeId = randomBytes(32).toString("base64url");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 5 * 60 * 1000).toISOString();
  await db.prepare("DELETE FROM auth_challenges WHERE expires_at<=? OR (account=? AND purpose='login')").run(now.toISOString(), account);
  await db.prepare("INSERT INTO auth_challenges(token_hash,account,purpose,details_json,expires_at,attempts,created_at) VALUES (?,?,?,?,?,?,?)").run(tokenHash(challengeId), account, "login", "{}", expiresAt, 0, now.toISOString());
  return { challengeId, expiresAt };
}
async function createTotpSetup(account) {
  const setupToken = randomBytes(32).toString("base64url");
  const secret = createTotpSecret();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 10 * 60 * 1000).toISOString();
  await db.prepare("DELETE FROM auth_challenges WHERE expires_at<=? OR (account=? AND purpose='totp_setup')").run(now.toISOString(), account);
  await db.prepare("INSERT INTO auth_challenges(token_hash,account,purpose,details_json,expires_at,attempts,created_at) VALUES (?,?,?,?,?,?,?)")
    .run(tokenHash(setupToken), account, "totp_setup", JSON.stringify({ totpSecretEnc: encrypt(secret) }), expiresAt, 0, now.toISOString());
  return { setupToken, expiresAt, secret, otpauthUri: createOtpAuthUri({ account, secret }) };
}
async function issueSession(user) {
  const token = randomBytes(32).toString("base64url");
  const now = new Date();
  const expires = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  await db.prepare("INSERT INTO sessions VALUES (?,?,?,?)").run(tokenHash(token), user.account, expires.toISOString(), now.toISOString());
  await db.prepare("UPDATE users SET last_login_at=?,updated_at=? WHERE account=?").run(now.toISOString(), now.toISOString(), user.account);
  const updated = await db.prepare("SELECT * FROM users WHERE account=?").get(user.account);
  return { token, expiresAt: expires.toISOString(), user: parseUser(updated), row: updated };
}
function decryptTotpSecret(user) {
  try { return user?.totp_secret_enc ? decrypt(user.totp_secret_enc) : ""; }
  catch { return ""; }
}
async function revokeUserAuth(account) {
  await db.prepare("DELETE FROM sessions WHERE account=?").run(account);
  await db.prepare("DELETE FROM auth_challenges WHERE account=?").run(account);
}
function passwordMatches(password, row) {
  if (!row?.password_salt || !row?.password_hash) return false;
  const expected = Buffer.from(row.password_hash, "hex");
  const actual = Buffer.from(hashPassword(password, row.password_salt), "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
async function rotateUserPassword(account, password, { preserveTokenHash = "" } = {}) {
  const current = await db.prepare("SELECT * FROM users WHERE account=?").get(account);
  if (!current) throw Object.assign(new Error("账号不存在"), { statusCode: 404 });
  const policy = await assertPassword(password, account);
  if (passwordMatches(password, current)) throw Object.assign(new Error("新密码不能与当前密码相同"), { statusCode: 400 });
  if (policy.historyCount) {
    const history = await db.prepare("SELECT password_salt,password_hash FROM password_history WHERE account=? ORDER BY changed_at DESC,id DESC LIMIT ?").all(account, policy.historyCount);
    if (history.some((row) => passwordMatches(password, row))) throw Object.assign(new Error(`不能使用最近 ${policy.historyCount} 次使用过的密码`), { statusCode: 400 });
  }
  const now = new Date().toISOString();
  const salt = randomBytes(16).toString("hex");
  await db.transaction(async () => {
    await db.prepare("INSERT INTO password_history (account,password_salt,password_hash,changed_at) VALUES (?,?,?,?)").run(account, current.password_salt, current.password_hash, now);
    await db.prepare("UPDATE users SET password_salt=?,password_hash=?,password_changed_at=?,updated_at=? WHERE account=?").run(salt, hashPassword(password, salt), now, now, account);
    await db.prepare("DELETE FROM password_history WHERE account=? AND id NOT IN (SELECT id FROM password_history WHERE account=? ORDER BY changed_at DESC,id DESC LIMIT ?)").run(account, account, Math.max(policy.historyCount, 1));
    if (preserveTokenHash) await db.prepare("DELETE FROM sessions WHERE account=? AND token_hash<>?").run(account, preserveTokenHash);
    else await db.prepare("DELETE FROM sessions WHERE account=?").run(account);
    await db.prepare("DELETE FROM auth_challenges WHERE account=?").run(account);
  });
  return now;
}
async function configuredUser(account, password, name, roleKey) {
  assertAccount(account);
  const role = roleFor(roleKey); const now = new Date().toISOString();
  const current = await db.prepare("SELECT * FROM users WHERE account=?").get(account);
  if (current) {
    if (current.role_key === roleKey && current.name === name && current.enabled) return;
    const roleChanged = current.role_key !== roleKey;
    await db.prepare("UPDATE users SET name=?,role=?,enabled=1,workspace=?,role_key=?,updated_at=? WHERE account=?")
      .run(name, role.label, role.workspace, role.key, now, account);
    if (roleChanged) await revokeUserAuth(account);
    return;
  }
  if (!password) return;
  await assertPassword(password, account);
  const salt = randomBytes(16).toString("hex");
  await db.prepare("INSERT INTO users (account,name,role,password_salt,password_hash,enabled,workspace,role_key,last_login_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run(account, name, role.label, salt, hashPassword(password, salt), 1, role.workspace, role.key, null, now, now);
  await db.prepare("UPDATE users SET password_changed_at=COALESCE(password_changed_at,?) WHERE account=?").run(now, account);
}

function stringifyField(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function flattenFields(source, original = {}) {
  const fields = {};
  for (const [key, value] of Object.entries(source || {})) {
    if (key === "msg" && value && typeof value === "object") {
      for (const [nestedKey, nestedValue] of Object.entries(value)) fields[nestedKey] = stringifyField(nestedValue);
    } else if (key === "original_other") {
      if (Array.isArray(original)) {
        if (original[0] !== undefined) fields.url = stringifyField(original[0]);
        original.slice(1).forEach((nestedValue, index) => { fields[`original_other_${index + 2}`] = stringifyField(nestedValue); });
      } else {
        for (const [nestedKey, nestedValue] of Object.entries(original || {})) fields[nestedKey] = stringifyField(nestedValue);
      }
    } else if (key !== "_index" && key !== "_type" && key !== "_score" && key !== "sort" && key !== "source") {
      fields[key] = stringifyField(value);
    }
  }
  return fields;
}

async function seedDemoData() {
  if ((await db.prepare("SELECT COUNT(*) AS count FROM monitoring_targets").get()).count === 0) {
    await db.prepare(`INSERT INTO tenants (id,name,status,created_at,updated_at) VALUES (?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,status='active',updated_at=excluded.updated_at`)
      .run("TENANT-CHANGAN", "重庆长安汽车股份有限公司", "active", "2026-07-18 08:42", "2026-07-18 08:42");
    await db.prepare(`INSERT INTO tenants (id,name,status,created_at,updated_at) VALUES (?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,status='active',updated_at=excluded.updated_at`)
      .run("TENANT-XINGHAI", "星海科技", "active", "2026-07-18 08:42", "2026-07-18 08:42");
    const insert = db.prepare("INSERT INTO monitoring_targets (id,name,target_type,owner,domains_json,ips_json,keywords_json,enabled,updated_at,tenant_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    await insert.run("OBJ-CHANGAN", "重庆长安汽车股份有限公司", "企业", "情报分析组", JSON.stringify(["changan.com.cn"]), JSON.stringify([]), JSON.stringify(["重庆长安汽车股份有限公司", "长安汽车", "CHANGAN"]), 1, "2026-07-18 12:00", "TENANT-CHANGAN");
    await insert.run("OBJ-001", "星海科技", "企业", "周宁", JSON.stringify(["example.com"]), JSON.stringify(["198.51.100.27"]), JSON.stringify(["星海科技", "Xinghai"]), 1, "2026-07-18 08:42", "TENANT-XINGHAI");
  }
  if ((await db.prepare("SELECT COUNT(*) AS count FROM api_connections").get()).count === 0) {
    await db.prepare(`INSERT INTO api_connections (id,name,category,provider_type,endpoint,method,auth_mode,api_key_enc,target_id,status,success_rate,quota,last_called,last_test_message,last_test_at,tenant_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run("API-04", "暗网凭据订阅 API", "凭据泄露", "darkweb_subscription", "https://darkweb.xxx", "POST", "API Key", encrypt("local-debug-key"), "OBJ-CHANGAN", "正常", 100, "sub/list + sub/data", "本地调试", "本地调试数据连接正常", "2026-07-18 12:00", "TENANT-CHANGAN");
  }
  if ((await db.prepare("SELECT COUNT(*) AS count FROM collection_jobs").get()).count === 0) {
    const connection = await db.prepare("SELECT id,name FROM api_connections ORDER BY id LIMIT 1").get();
    if (connection) { const now = new Date().toISOString(); await db.prepare("INSERT INTO collection_jobs (id,connection_id,name,enabled,interval_minutes,timeout_seconds,retry_limit,next_run_at,last_status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").run("JOB-DEFAULT", connection.id, `${connection.name} 定时采集`, 0, 60, 60, 2, null, "从未运行", now, now); }
  }
  if ((await db.prepare("SELECT COUNT(*) AS count FROM credential_subscriptions").get()).count === 0) {
    await db.prepare(`INSERT INTO credential_subscriptions (id,target_id,sub_type,sub_category,user_permission_id,value,expire_time,count,tenant_id)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(101, "OBJ-CHANGAN", "credential-leak", "credential", "changan-debug-permission", "changan.com.cn", "2027-12-31T23:59:59Z", 3, "TENANT-CHANGAN");
    const insert = db.prepare("INSERT INTO credential_records (id,sub_id,url,system_name,account,password,leaked_at,source,raw_json,first_seen_at,tenant_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)");
    await insert.run("changan-demo-001", 101, "https://sso.changan.com.cn/login", "长安汽车统一身份认证（测试数据）", "test.security@changan.com.cn", "DemoOnly!2026", "2026-07-18 10:26", "local-api-debug", null, "2026-07-18 10:26", "TENANT-CHANGAN");
    await insert.run("changan-demo-002", 101, "https://vpn.changan.com.cn/", "长安汽车 VPN（测试数据）", "demo.vpn@changan.com.cn", "Debug-VPN#2026", "2026-07-18 09:42", "local-api-debug", null, "2026-07-18 09:42", "TENANT-CHANGAN");
    await insert.run("changan-demo-003", 101, "https://mail.changan.com.cn/", "长安汽车邮件系统（测试数据）", "sample.mail@changan.com.cn", "Sample-Mail@2026", "2026-07-17 22:18", "local-api-debug", null, "2026-07-17 22:18", "TENANT-CHANGAN");
  }
}

async function seedDatabase() {
  const explicitDemoSeed = process.env.SENTINEL_SEED_DEMO_DATA;
  if (explicitDemoSeed === "1" || (explicitDemoSeed === undefined && process.env.NODE_ENV !== "production")) await seedDemoData();
  const noUsers = (await db.prepare("SELECT COUNT(*) AS count FROM users").get()).count === 0;
  const portalPassword = process.env.SENTINEL_PORTAL_PASSWORD || (noUsers && process.env.NODE_ENV !== "production" ? "Sentinel@2026" : "");
  await configuredUser(process.env.SENTINEL_PORTAL_ACCOUNT || "analyst", portalPassword, process.env.SENTINEL_PORTAL_NAME || "情报分析员", "intelligence-analyst");
  await configuredUser(process.env.SENTINEL_ADMIN_ACCOUNT || "operator", process.env.SENTINEL_ADMIN_PASSWORD || "", process.env.SENTINEL_ADMIN_NAME || "平台管理员", "platform-admin");
}
await seedDatabase();
if (databaseInfo.schema === "public" && process.env.SENTINEL_AUTO_SEED_FINGERPRINT_ICONS !== "0") {
  await ensureSimpleIconCatalog(db);
  const domesticIconCount = Number((await db.prepare("SELECT COUNT(*) AS count FROM fingerprint_icon_library WHERE source='domestic'").get()).count);
  if (!domesticIconCount) await syncDomesticFingerprintIconCatalog(db);
  const providerIconCount = Number((await db.prepare("SELECT COUNT(*) AS count FROM fingerprint_icon_library WHERE source='provider'").get()).count);
  if (!providerIconCount) await syncProviderIconCatalog(db);
}

async function migrateEmbeddedArticleImages() {
  const rows = await db.prepare("SELECT id,article_markdown FROM dark_web_events WHERE article_markdown LIKE '%data:image/%'").all();
  for (const row of rows) {
    const migrated = externalizeArticleImages(row.article_markdown, articleImagesDir);
    if (migrated.html !== row.article_markdown) await db.prepare("UPDATE dark_web_events SET article_markdown=? WHERE id=?").run(migrated.html, row.id);
  }
}
await migrateEmbeddedArticleImages();

function json(res, status, body) { res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify(body)); }
function articleImage(res, image) {
  res.writeHead(200, {
    "Content-Type": image.mediaType, "Content-Length": image.content.length, "Cache-Control": "private, max-age=86400, immutable",
    "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(image.name)}`, "X-Content-Type-Options": "nosniff", "X-Content-SHA256": image.sha256
  });
  res.end(image.content);
}
const defaultJsonBodyLimit = 1024 * 1024;
const articleJsonBodyLimit = 8 * 1024 * 1024;
async function readJson(req, maxSize = defaultJsonBodyLimit) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > maxSize) throw new Error(`请求体超过 ${Math.round(maxSize / 1024 / 1024)}MB 限制`); chunks.push(chunk); }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}
async function readBody(req, maxSize = 50 * 1024 * 1024) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > maxSize) throw Object.assign(new Error(`上传文件超过 ${Math.round(maxSize / 1024 / 1024)}MB 限制`), { statusCode: 413 }); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
function parseMultipart(body, contentType) {
  const boundaryMatch = String(contentType || "").match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!boundaryMatch) throw new Error("上传请求缺少 multipart boundary");
  const boundary = Buffer.from(`--${boundaryMatch[1] || boundaryMatch[2]}`);
  const parts = { fields: {}, file: null };
  let cursor = body.indexOf(boundary);
  while (cursor >= 0) {
    const partStart = cursor + boundary.length;
    if (body.slice(partStart, partStart + 2).toString() === "--") break;
    const headerStart = partStart + 2;
    const headerEnd = body.indexOf(Buffer.from("\r\n\r\n"), headerStart);
    if (headerEnd < 0) break;
    const headers = body.slice(headerStart, headerEnd).toString("utf8");
    const dataStart = headerEnd + 4;
    const nextBoundary = body.indexOf(boundary, dataStart);
    if (nextBoundary < 0) break;
    const dataEnd = Math.max(dataStart, nextBoundary - 2);
    const nameMatch = headers.match(/(?:^|;)\s*name="([^"]+)"/i);
    const filenameMatch = headers.match(/filename="([^"]*)"/i);
    const contentTypeMatch = headers.match(/(?:^|\r\n)Content-Type:\s*([^\r\n]+)/i);
    if (nameMatch) {
      const name = nameMatch[1];
      const filename = filenameMatch?.[1];
      if (filename !== undefined) parts.file = { filename, contentType: contentTypeMatch?.[1]?.trim().toLowerCase() || "", data: body.slice(dataStart, dataEnd) };
      else parts.fields[name] = body.slice(dataStart, dataEnd).toString("utf8");
    }
    cursor = nextBoundary;
  }
  return parts;
}
const DARK_WEB_ATTACHMENT_MAX_BYTES = 50 * 1024 * 1024;
const darkWebAttachmentMediaTypes = Object.freeze({
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xls": "application/vnd.ms-excel",
  ".csv": "text/csv; charset=utf-8",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".doc": "application/msword",
  ".pdf": "application/pdf",
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json",
  ".zip": "application/zip",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp"
});

async function normalizeDarkWebAttachment(file) {
  if (!file?.data?.length) throw Object.assign(new Error("请选择需要上传的证据文件"), { statusCode: 400 });
  if (file.data.length > DARK_WEB_ATTACHMENT_MAX_BYTES) throw Object.assign(new Error("单个证据文件不能超过 50 MB"), { statusCode: 413 });
  const name = basename(String(file.filename || "").replaceAll("\\", "/")).trim();
  const extension = name.slice(name.lastIndexOf(".")).toLowerCase();
  const mediaType = darkWebAttachmentMediaTypes[extension];
  if (!name || !mediaType) throw Object.assign(new Error("证据文件仅支持 Office、PDF、CSV、TXT、JSON、ZIP 和常用图片格式"), { statusCode: 400 });
  if ([".xlsx", ".docx"].includes(extension)) await assertSafeOoxml(file.data);
  let sheetCount = 0; let rowCount = 0; let columnCount = 0;
  if ([".xlsx", ".xls", ".csv"].includes(extension)) {
    let workbook;
    try { workbook = XLSX.read(file.data, { type: "buffer", dense: true }); }
    catch (cause) { throw Object.assign(new Error("表格证据文件损坏或格式不正确"), { statusCode: 400, cause }); }
    sheetCount = workbook.SheetNames.length;
    for (const sheetName of workbook.SheetNames) {
      const rangeText = workbook.Sheets[sheetName]?.["!ref"];
      if (!rangeText) continue;
      const range = XLSX.utils.decode_range(rangeText);
      rowCount += range.e.r - range.s.r + 1;
      columnCount = Math.max(columnCount, range.e.c - range.s.c + 1);
    }
  }
  return {
    name, buffer: file.data, mediaType,
    sha256: createHash("sha256").update(file.data).digest("hex"),
    sheetCount, rowCount, columnCount
  };
}

function removeStoredDarkWebBlob(storedName) {
  const safeName = basename(String(storedName || ""));
  if (!safeName || safeName !== storedName) return;
  for (const directory of darkWebBlobDirectories) {
    const path = join(directory, safeName);
    if (existsSync(path)) { try { unlinkSync(path); } catch {} }
  }
}
const sensitiveSheetCategories = { "账号口令": "account-password", "源码泄露": "source-code", "文档泄露": "documents", "仿冒网站": "phishing" };
const sensitiveCategoryLabels = { "account-password": "账号口令", "source-code": "源码泄露", documents: "文档泄露", phishing: "仿冒网站" };
const publicationPolicyDefaults = {
  sensitive: "approval",
  asset: "approval",
  "dark-web": "approval",
  credentials: "auto",
  vulnerabilities: "auto"
};
async function publicationModeFor(tenantId, module) {
  const fallback = publicationPolicyDefaults[module];
  if (!fallback) throw Object.assign(new Error("发布策略板块不合法"), { statusCode: 400 });
  const row = await db.prepare("SELECT mode FROM tenant_publication_policies WHERE tenant_id=? AND module=?").get(tenantId, module);
  return row?.mode === "auto" || row?.mode === "approval" ? row.mode : fallback;
}
async function autoPublishFor(tenantId, module) {
  return await publicationModeFor(tenantId, module) === "auto";
}
function importCell(value) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/\u00a0/g, " ").replace(/\r\n/g, "\n").trim();
}
function compactImportValue(value) { return importCell(value).replace(/\s+/g, " ").toLowerCase(); }
function findHeaderRow(rows, category) {
  const signatures = {
    "account-password": ["系统名称", "账号", "密码"],
    "source-code": ["源码名称", "泄漏内容", "泄漏渠道"],
    documents: ["文档名称", "泄漏内容", "泄漏渠道"],
    phishing: ["仿冒网站名称", "网站链接"]
  }[category];
  return rows.findIndex((row) => signatures.every((signature) => row.some((value) => importCell(value).includes(signature))));
}
function importRowFields(headers, row) {
  return Object.fromEntries(headers.map((header, index) => [header, importCell(row[index])]).filter(([header, value]) => header && value));
}
function fieldFrom(fields, ...names) {
  const entry = Object.entries(fields).find(([key]) => names.some((name) => key === name || key.includes(name)) && importCell(fields[key]));
  return entry ? importCell(entry[1]) : "";
}
function normalizeRisk(value) {
  const risk = importCell(value);
  return risk.startsWith("高") ? "高" : risk.startsWith("中") ? "中" : risk.startsWith("低") ? "低" : risk || "未标记";
}
function canonicalSensitiveRow(category, fields, sheetName) {
  const risk = normalizeRisk(fieldFrom(fields, "风险类型"));
  const note = fieldFrom(fields, "备注");
  let normalized;
  if (category === "account-password") {
    normalized = { sequence: fieldFrom(fields, "序号"), type: fieldFrom(fields, "类型"), systemName: fieldFrom(fields, "系统名称"), loginUrl: fieldFrom(fields, "登陆位置", "登录位置"), account: fieldFrom(fields, "账号"), password: fieldFrom(fields, "密码"), source: fieldFrom(fields, "信息来源"), risk, note };
  } else if (category === "source-code") {
    normalized = { sequence: fieldFrom(fields, "序号"), name: fieldFrom(fields, "源码名称"), content: fieldFrom(fields, "泄漏内容"), channel: fieldFrom(fields, "泄漏渠道"), risk, note };
  } else if (category === "documents") {
    normalized = { sequence: fieldFrom(fields, "序号"), name: fieldFrom(fields, "文档名称"), content: fieldFrom(fields, "泄漏内容"), channel: fieldFrom(fields, "泄漏渠道"), risk, note };
  } else {
    normalized = { sequence: fieldFrom(fields, "序号"), type: fieldFrom(fields, "仿冒网站类型"), name: fieldFrom(fields, "仿冒网站名称"), url: fieldFrom(fields, "网站链接"), risk, note };
  }
  const title = normalized.systemName || normalized.name || normalized.url || "未命名情报";
  const keyFields = category === "account-password"
    ? [normalized.systemName, normalized.loginUrl, normalized.account, normalized.password, normalized.source]
    : category === "phishing"
      ? [normalized.type, normalized.name, normalized.url]
      : [normalized.name, normalized.content, normalized.channel];
  const recordHash = createHash("sha256").update(`${category}|${keyFields.map(compactImportValue).join("|")}`).digest("hex");
  return { category, sheetName, title, risk, fields: normalized, recordHash };
}
async function importSensitiveWorkbook(buffer, filename, targetId) {
  const tenantId = await tenantIdForTarget(targetId);
  const autoPublish = await autoPublishFor(tenantId, "sensitive");
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: false, raw: false });
  const now = new Date().toISOString();
  const batchId = `BATCH-${now.replace(/\D/g, "").slice(0, 14)}-${randomBytes(3).toString("hex")}`;
  const summaries = []; let totalRows = 0; let newRows = 0; let duplicateRows = 0;
  const insertRecord = db.prepare("INSERT INTO sensitive_records (id,category,target_id,title,risk,fields_json,record_hash,first_seen_at,last_seen_at,import_status,import_count,batch_id,tenant_id,is_published,reviewed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  const updateRecord = db.prepare("UPDATE sensitive_records SET last_seen_at=?, import_status=?, import_count=import_count+1, batch_id=?, fields_json=?, risk=?, title=?, is_published=?, reviewed_at=? WHERE tenant_id=? AND record_hash=?");
  for (const sheetName of workbook.SheetNames) {
    const normalizedSheetName = sheetName.replace(/\s+/g, "");
    const category = sensitiveSheetCategories[sheetName] || Object.entries(sensitiveSheetCategories).find(([name]) => normalizedSheetName.includes(name))?.[1];
    if (!category) continue;
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: "", raw: false });
    const headerRowIndex = findHeaderRow(rows, category);
    const summary = { sheet: sheetName, category, label: sensitiveCategoryLabels[category], total: 0, newRows: 0, duplicateRows: 0, skippedRows: 0 };
    if (headerRowIndex < 0) { summaries.push(summary); continue; }
    const headers = rows[headerRowIndex].map(importCell);
    for (const row of rows.slice(headerRowIndex + 1)) {
      const fields = importRowFields(headers, row);
      if (!Object.keys(fields).length || !fieldFrom(fields, "序号") && !fieldFrom(fields, "名称", "系统名称", "文档名称", "源码名称", "仿冒网站名称")) { summary.skippedRows += 1; continue; }
      summary.total += 1; totalRows += 1;
      const record = canonicalSensitiveRow(category, fields, sheetName);
      const existing = await db.prepare("SELECT id FROM sensitive_records WHERE tenant_id=? AND record_hash=?").get(tenantId, record.recordHash);
      if (existing) {
        await updateRecord.run(now, "已存在", batchId, JSON.stringify(record.fields), record.risk, record.title, autoPublish, autoPublish ? now : null, tenantId, record.recordHash);
        summary.duplicateRows += 1; duplicateRows += 1;
      } else {
        const recordId = createHash("sha256").update(`${tenantId}|${record.recordHash}`).digest("hex").slice(0, 20);
        await insertRecord.run(`SENS-${record.category}-${recordId}`, record.category, targetId, record.title, record.risk, JSON.stringify(record.fields), record.recordHash, now, now, "新增", 1, batchId, tenantId, autoPublish, autoPublish ? now : null);
        summary.newRows += 1; newRows += 1;
      }
    }
    summaries.push(summary);
  }
  const sourceFilePath = persistIngestionSource(batchId, filename, buffer);
  const status = autoPublish ? "已发布" : "待审核";
  await db.prepare("INSERT INTO ingestion_batches (id,file_name,target_id,status,total_rows,new_rows,duplicate_rows,sheet_summary_json,created_at,ingestion_type,tenant_id,source_file_path) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run(batchId, filename, targetId, status, totalRows, newRows, duplicateRows, JSON.stringify(summaries), now, "sensitive", tenantId, sourceFilePath);
  return { id: batchId, type: "sensitive", fileName: filename, targetId: targetId || null, status, totalRows, newRows, duplicateRows, changedRows: 0, missingRows: 0, unchangedRows: duplicateRows, sheets: summaries, createdAt: now };
}
const assetSheetCategories = { "子域名资产": "subdomain", "服务器资产": "server", "Web资产": "web" };
const assetCategories = { ...assetSheetCategories, fingerprint: "fingerprint" };
const assetCategoryLabels = { subdomain: "DNS / 子域名", server: "端口 / 服务器", web: "Web资产", fingerprint: "指纹列表" };
function findAssetHeaderRow(rows, category) {
  const signatures = { subdomain: ["根域名", "子域名"], server: ["地址", "服务类型", "端口"], web: ["URL", "IP地址", "状态码"] }[category];
  return rows.findIndex((row) => signatures.every((signature) => row.some((value) => importCell(value).includes(signature))));
}
function canonicalAssetRow(category, fields, sheetName) {
  let normalized;
  if (category === "subdomain") {
    normalized = { sequence: fieldFrom(fields, "序号"), rootDomain: fieldFrom(fields, "根域名"), subdomain: fieldFrom(fields, "子域名"), ipAlias: fieldFrom(fields, "IP/别名") };
  } else if (category === "server") {
    const riskFlag = fieldFrom(fields, "风险标记");
    normalized = { sequence: fieldFrom(fields, "序号"), address: fieldFrom(fields, "地址"), serviceType: fieldFrom(fields, "服务类型"), protocol: fieldFrom(fields, "协议"), port: fieldFrom(fields, "端口"), riskFlag, note: fieldFrom(fields, "备注") };
  } else {
    const riskFlag = fieldFrom(fields, "风险标记");
    normalized = { sequence: fieldFrom(fields, "序号"), url: fieldFrom(fields, "URL"), ipAddress: fieldFrom(fields, "IP地址"), domain: fieldFrom(fields, "域名"), protocol: fieldFrom(fields, "协议"), port: fieldFrom(fields, "端口"), statusCode: fieldFrom(fields, "状态码"), title: fieldFrom(fields, "网站Title"), application: fieldFrom(fields, "应用/组件"), riskFlag, registrationUnit: fieldFrom(fields, "备案单位"), registrationNo: fieldFrom(fields, "备案号"), note: fieldFrom(fields, "备注") };
  }
  const keyFields = category === "subdomain"
    ? [normalized.rootDomain, normalized.subdomain, normalized.ipAlias]
    : category === "server"
      ? [normalized.address, normalized.protocol, normalized.port, normalized.serviceType]
      : [normalized.url, normalized.ipAddress, normalized.domain, normalized.protocol, normalized.port];
  const recordHash = createHash("sha256").update(`${category}|${keyFields.map(compactImportValue).join("|")}`).digest("hex");
  const title = normalized.subdomain || normalized.address || normalized.url || normalized.domain || "未命名资产";
  const risk = normalized.riskFlag && /(高危|风险|暴露|危险)/i.test(normalized.riskFlag) ? "高" : "未标记";
  return { category, sheetName, title, risk, fields: normalized, recordHash };
}

async function upsertAssetCandidate({ tenantId, targetId, batchId, now, record, autoPublish, baseline }) {
  const existing = await db.prepare("SELECT * FROM asset_records WHERE tenant_id=? AND target_id=? AND record_hash=?").get(tenantId, targetId, record.recordHash);
  if (!existing) {
    const recordId = createHash("sha256").update(`${tenantId}|${targetId}|${record.recordHash}`).digest("hex").slice(0, 20);
    const changeType = baseline ? "baseline" : "new";
    await db.prepare(`INSERT INTO asset_records
      (id,category,target_id,title,risk,fields_json,record_hash,first_seen_at,last_seen_at,import_status,import_count,batch_id,tenant_id,is_published,reviewed_at,change_type,previous_fields_json,present_in_latest_batch,previously_published,last_changed_at,missing_since)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,TRUE,FALSE,?,NULL)`)
      .run(`ASSET-${record.category}-${recordId}`, record.category, targetId, record.title, record.risk, JSON.stringify(record.fields), record.recordHash, now, now, baseline ? "基线" : "新增", 1, batchId, tenantId, autoPublish, autoPublish ? now : null, changeType, null, now);
    return { changeType, batchChangeType: changeType, changedFields: [] };
  }

  const currentFields = parseJson(existing.fields_json, {});
  const changedFields = assetChangedFields(currentFields, record.fields);
  const changed = changedFields.length > 0;
  const pendingChange = !existing.is_published && ["new", "changed", "reappeared", "missing"].includes(existing.change_type);
  if (!changed && existing.present_in_latest_batch && pendingChange) {
    await db.prepare("UPDATE asset_records SET last_seen_at=?,import_count=import_count+1,batch_id=? WHERE id=?").run(now, batchId, existing.id);
    return { changeType: existing.change_type, batchChangeType: "unchanged", changedFields: [] };
  }

  const reappeared = !existing.present_in_latest_batch;
  const changeType = reappeared ? "reappeared" : changed ? "changed" : "unchanged";
  const previouslyPublished = Boolean(existing.is_published || existing.previously_published);
  await db.prepare(`UPDATE asset_records SET
    last_seen_at=?,import_status=?,import_count=import_count+1,batch_id=?,fields_json=?,risk=?,title=?,
    is_published=?,reviewed_at=?,change_type=?,previous_fields_json=?,present_in_latest_batch=TRUE,
    previously_published=?,last_changed_at=?,missing_since=NULL
    WHERE id=?`)
    .run(
      now,
      changeType === "changed" ? "状态变化" : changeType === "reappeared" ? "重新出现" : "已存在",
      batchId,
      JSON.stringify(record.fields),
      record.risk,
      record.title,
      changeType === "unchanged" ? Boolean(existing.is_published) : autoPublish,
      changeType === "unchanged" ? existing.reviewed_at : autoPublish ? now : null,
      changeType,
      changeType === "unchanged" ? null : existing.fields_json,
      changeType === "unchanged" ? Boolean(existing.previously_published) : autoPublish ? false : previouslyPublished,
      changeType === "unchanged" ? existing.last_changed_at : now,
      existing.id
    );
  return { changeType, batchChangeType: changeType, changedFields };
}

async function markMissingAssetCandidates({ tenantId, targetId, batchId, now, seenHashes, autoPublish }) {
  const rows = await db.prepare("SELECT * FROM asset_records WHERE tenant_id=? AND target_id=? AND present_in_latest_batch=TRUE").all(tenantId, targetId);
  let missingRows = 0;
  for (const row of rows) {
    if (seenHashes.has(row.record_hash)) continue;
    const previousFields = row.previously_published && row.previous_fields_json ? row.previous_fields_json : row.fields_json;
    const previouslyPublished = Boolean(row.is_published || row.previously_published);
    await db.prepare(`UPDATE asset_records SET batch_id=?,import_status='已消失',change_type='missing',present_in_latest_batch=FALSE,
      is_published=?,reviewed_at=?,previously_published=?,previous_fields_json=?,last_changed_at=?,missing_since=? WHERE id=?`)
      .run(batchId, false, autoPublish ? now : null, autoPublish ? false : previouslyPublished, previousFields, now, now, row.id);
    missingRows += 1;
  }
  return missingRows;
}

async function importAssetWorkbook(buffer, filename, targetId) {
  const tenantId = await tenantIdForTarget(targetId);
  const autoPublish = await autoPublishFor(tenantId, "asset");
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: false, raw: false });
  const now = new Date().toISOString();
  const batchId = `BATCH-${now.replace(/\D/g, "").slice(0, 14)}-${randomBytes(3).toString("hex")}`;
  const baseline = Number((await db.prepare("SELECT COUNT(*) AS count FROM asset_records WHERE tenant_id=? AND target_id=?").get(tenantId, targetId)).count) === 0;
  const summaries = []; let totalRows = 0; let newRows = 0; let duplicateRows = 0; let changedRows = 0; let unchangedRows = 0; let aliveChangedRows = 0; let statusCodeChangedRows = 0;
  for (const sheetName of workbook.SheetNames) {
    const normalizedSheetName = sheetName.replace(/\s+/g, "");
    const category = assetSheetCategories[sheetName] || Object.entries(assetSheetCategories).find(([name]) => normalizedSheetName.includes(name))?.[1];
    if (!category) continue;
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: "", raw: false });
    const headerRowIndex = findAssetHeaderRow(rows, category);
    const summary = { sheet: sheetName, category, label: assetCategoryLabels[category], total: 0, newRows: 0, duplicateRows: 0, changedRows: 0, aliveChangedRows: 0, statusCodeChangedRows: 0, skippedRows: 0 };
    if (headerRowIndex < 0) { summaries.push(summary); continue; }
    const headers = rows[headerRowIndex].map(importCell);
    for (const row of rows.slice(headerRowIndex + 1)) {
      const fields = importRowFields(headers, row);
      if (!Object.keys(fields).length || (!fieldFrom(fields, "序号") && !fieldFrom(fields, "子域名", "地址", "URL"))) { summary.skippedRows += 1; continue; }
      summary.total += 1; totalRows += 1;
      const record = canonicalAssetRow(category, fields, sheetName);
      const result = await upsertAssetCandidate({ tenantId, targetId, batchId, now, record, autoPublish, baseline });
      if (result.changedFields.includes("alive")) { summary.aliveChangedRows += 1; aliveChangedRows += 1; }
      if (result.changedFields.includes("statusCode")) { summary.statusCodeChangedRows += 1; statusCodeChangedRows += 1; }
      if (["baseline", "new"].includes(result.batchChangeType)) { summary.newRows += 1; newRows += 1; }
      else if (["changed", "reappeared"].includes(result.batchChangeType)) { summary.changedRows += 1; changedRows += 1; }
      else { summary.duplicateRows += 1; duplicateRows += 1; unchangedRows += 1; }
    }
    summaries.push(summary);
  }
  const sourceFilePath = persistIngestionSource(batchId, filename, buffer);
  const status = autoPublish ? "已发布" : "待审核";
  await db.prepare("INSERT INTO ingestion_batches (id,file_name,target_id,status,total_rows,new_rows,duplicate_rows,changed_rows,missing_rows,unchanged_rows,sheet_summary_json,created_at,ingestion_type,tenant_id,source_file_path) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(batchId, filename, targetId, status, totalRows, newRows, duplicateRows, changedRows, 0, unchangedRows, JSON.stringify(summaries), now, "asset", tenantId, sourceFilePath);
  return { id: batchId, type: "asset", fileName: filename, targetId: targetId || null, status, totalRows, newRows, duplicateRows, changedRows, aliveChangedRows, statusCodeChangedRows, missingRows: 0, unchangedRows, sheets: summaries, createdAt: now };
}

function extractWindowData(html) {
  const assignment = /window\.data\s*=\s*/g.exec(html);
  if (!assignment) throw new Error("HTML 报告中未找到 window.data 数据对象");
  let start = assignment.index + assignment[0].length;
  while (/\s/.test(html[start] || "")) start += 1;
  if (html[start] !== "{") throw new Error("window.data 不是可识别的 JSON 对象");
  let depth = 0; let inString = false; let escaped = false;
  for (let index = start; index < html.length; index += 1) {
    const char = html[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}" && --depth === 0) {
      try { return JSON.parse(html.slice(start, index + 1)); }
      catch { throw new Error("HTML 报告中的 window.data JSON 解析失败"); }
    }
  }
  throw new Error("HTML 报告中的 window.data 对象不完整");
}

function stringList(value) {
  if (Array.isArray(value)) return value.map(stringifyField).filter(Boolean).join("、");
  return stringifyField(value);
}

function rootDomainFrom(hostname) {
  const parts = importCell(hostname).replace(/^https?:\/\//i, "").split(/[/:]/)[0].split(".").filter(Boolean);
  if (parts.length < 2) return parts.join(".");
  const secondLevelSuffixes = new Set(["com.cn", "net.cn", "org.cn", "gov.cn", "co.uk"]);
  const suffix = parts.slice(-2).join(".");
  return secondLevelSuffixes.has(suffix) && parts.length >= 3 ? parts.slice(-3).join(".") : suffix;
}

function canonicalHtmlAssetRows(data) {
  const rows = [];
  for (const item of Array.isArray(data.dns) ? data.dns : []) {
    const fields = {
      rootDomain: rootDomainFrom(item.subdomain), subdomain: stringifyField(item.subdomain),
      ipAlias: stringList([...(Array.isArray(item.ips) ? item.ips : []), ...(Array.isArray(item.cnames) ? item.cnames : [])]),
      ips: stringList(item.ips), cnames: stringList(item.cnames), companyPath: stringifyField(item.company_path),
      updatedAt: stringifyField(item.updated_at), dataSource: "HTML / DNS"
    };
    if (!fields.subdomain) continue;
    const recordHash = createHash("sha256").update(`subdomain|${[fields.rootDomain, fields.subdomain, fields.ipAlias].map(compactImportValue).join("|")}`).digest("hex");
    rows.push({ category: "subdomain", title: fields.subdomain, risk: "未标记", fields, recordHash });
  }
  for (const item of Array.isArray(data.ports) ? data.ports : []) {
    const fields = {
      address: stringifyField(item.ip), serviceType: stringifyField(item.service || item.product || item.protocol),
      protocol: stringifyField(item.protocol), port: stringifyField(item.port), alive: stringifyField(item.alive),
      banner: stringifyField(item.banner), companyPath: stringifyField(item.company_path),
      updatedAt: stringifyField(item.updated_at), riskFlag: stringifyField(item.risk), note: "", dataSource: "HTML / Ports"
    };
    if (!fields.address || !fields.port) continue;
    const recordHash = createHash("sha256").update(`server|${[fields.address, fields.protocol, fields.port, fields.serviceType].map(compactImportValue).join("|")}`).digest("hex");
    rows.push({ category: "server", title: `${fields.address}:${fields.port}`, risk: fields.riskFlag ? "高" : "未标记", fields, recordHash });
  }
  for (const item of Array.isArray(data.websites) ? data.websites : []) {
    let protocol = "";
    try { protocol = new URL(String(item.url || "")).protocol.replace(":", ""); } catch {}
    const fields = {
      url: stringifyField(item.url), ipAddress: stringifyField(item.ip), domain: stringifyField(item.domain),
      protocol, port: stringifyField(item.port), statusCode: stringifyField(item.status_code),
      title: stringifyField(item.title), application: stringList([...(Array.isArray(item.app_products) ? item.app_products : []), ...(Array.isArray(item.framework_products) ? item.framework_products : [])]),
      appProducts: stringList(item.app_products), frameworkProducts: stringList(item.framework_products),
      iconHashMd5: stringifyField(item.icon_hash_md5), certSubjectCn: stringifyField(item.cert_subject_cn),
      companyPath: stringifyField(item.company_path), discoveryChain: stringList(item.discovery_chain), geo: stringifyField(item.geo),
      ipLocation: stringifyField(item.ip_location), alive: stringifyField(item.alive), updatedAt: stringifyField(item.updated_at),
      riskFlag: stringifyField(item.risk), note: "", dataSource: "HTML / Websites"
    };
    if (!fields.url) continue;
    const recordHash = createHash("sha256").update(`web|${[fields.url, fields.ipAddress, fields.domain, fields.protocol, fields.port].map(compactImportValue).join("|")}`).digest("hex");
    rows.push({ category: "web", title: fields.title || fields.url, risk: fields.riskFlag ? "高" : "未标记", fields, recordHash });
  }
  const products = Array.isArray(data.products?.datasource) ? data.products.datasource : [];
  for (const item of products) {
    const fields = { fingerprintType: "产品指纹", name: stringifyField(item.key), productType: stringifyField(item.type), nameAndType: stringifyField(item.nameAndType), count: stringifyField(item.count), dataSource: "HTML / Products" };
    if (!fields.name) continue;
    const recordHash = createHash("sha256").update(`fingerprint|product|${compactImportValue(fields.nameAndType || fields.name)}`).digest("hex");
    rows.push({ category: "fingerprint", title: fields.name, risk: "未标记", fields, recordHash });
  }
  for (const item of Array.isArray(data.icons) ? data.icons : []) {
    const fields = { fingerprintType: "站点图标", name: stringifyField(item.md5) || "无 MD5 图标", iconHashMd5: stringifyField(item.md5), count: stringifyField(item.count), hasIconData: item.icon ? "是" : "否", dataSource: "HTML / Icons" };
    const recordHash = createHash("sha256").update(`fingerprint|icon|${compactImportValue(fields.iconHashMd5 || "empty")}`).digest("hex");
    rows.push({ category: "fingerprint", title: fields.name, risk: "未标记", fields, recordHash });
  }
  return rows;
}

async function importAssetHtml(buffer, filename, targetId) {
  const tenantId = await tenantIdForTarget(targetId);
  const autoPublish = await autoPublishFor(tenantId, "asset");
  const html = buffer.toString("utf8");
  const data = extractWindowData(html);
  const records = canonicalHtmlAssetRows(data);
  if (!records.length) throw new Error("HTML 报告未包含可识别的 DNS、端口、Web 或指纹数据");
  const now = new Date().toISOString();
  const batchId = `BATCH-${now.replace(/\D/g, "").slice(0, 14)}-${randomBytes(3).toString("hex")}`;
  const reportId = `REPORT-${now.replace(/\D/g, "").slice(0, 14)}-${randomBytes(4).toString("hex")}`;
  const reportPath = join(reportsDir, `${reportId}.html`);
  const dataPath = join(reportsDir, `${reportId}.json`);
  const summaries = Object.entries(assetCategoryLabels).map(([category, label]) => ({ sheet: `HTML/${category}`, category, label, total: 0, newRows: 0, duplicateRows: 0, changedRows: 0, aliveChangedRows: 0, statusCodeChangedRows: 0, skippedRows: 0 }));
  const baseline = Number((await db.prepare("SELECT COUNT(*) AS count FROM asset_records WHERE tenant_id=? AND target_id=?").get(tenantId, targetId)).count) === 0;
  const seenHashes = new Set();
  let newRows = 0; let duplicateRows = 0; let changedRows = 0; let unchangedRows = 0; let aliveChangedRows = 0; let statusCodeChangedRows = 0;
  for (const record of records) {
    const summary = summaries.find((item) => item.category === record.category);
    summary.total += 1;
    seenHashes.add(record.recordHash);
    const result = await upsertAssetCandidate({ tenantId, targetId, batchId, now, record, autoPublish, baseline });
    if (result.changedFields.includes("alive")) { summary.aliveChangedRows += 1; aliveChangedRows += 1; }
    if (result.changedFields.includes("statusCode")) { summary.statusCodeChangedRows += 1; statusCodeChangedRows += 1; }
    if (["baseline", "new"].includes(result.batchChangeType)) { summary.newRows += 1; newRows += 1; }
    else if (["changed", "reappeared"].includes(result.batchChangeType)) { summary.changedRows += 1; changedRows += 1; }
    else { summary.duplicateRows += 1; duplicateRows += 1; unchangedRows += 1; }
  }
  const missingRows = baseline ? 0 : await markMissingAssetCandidates({ tenantId, targetId, batchId, now, seenHashes, autoPublish });
  const status = autoPublish ? "已发布" : "待审核";
  await db.prepare("INSERT INTO ingestion_batches (id,file_name,target_id,status,total_rows,new_rows,duplicate_rows,changed_rows,missing_rows,unchanged_rows,sheet_summary_json,created_at,ingestion_type,tenant_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(batchId, filename, targetId, status, records.length, newRows, duplicateRows, changedRows, missingRows, unchangedRows, JSON.stringify(summaries), now, "asset", tenantId);
  const counts = Object.fromEntries(summaries.map((item) => [item.category, item.total]));
  await db.prepare("INSERT INTO asset_reports (id,target_id,file_name,file_path,data_path,size_bytes,dns_count,port_count,web_count,fingerprint_count,icon_count,created_at,tenant_id,is_published,batch_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(reportId, targetId, filename, reportPath, dataPath, buffer.length, counts.subdomain || 0, counts.server || 0, counts.web || 0, aggregateReportFingerprints(data).length, Array.isArray(data.icons) ? data.icons.length : 0, now, tenantId, autoPublish, batchId);
  writeFileSync(reportPath, buffer);
  writeFileSync(dataPath, JSON.stringify(data));
  return { id: batchId, type: "asset", reportId, fileName: filename, targetId: targetId || null, status, totalRows: records.length, newRows, duplicateRows, changedRows, aliveChangedRows, statusCodeChangedRows, missingRows, unchangedRows, sheets: summaries, createdAt: now };
}

async function importDarkWebPackage(buffer, filename, targetId) {
  const tenantId = await tenantIdForTarget(targetId);
  const autoPublish = await autoPublishFor(tenantId, "dark-web");
  const parsed = await parseDarkWebUpload(buffer, filename);
  const now = new Date().toISOString();
  const batchId = `BATCH-${now.replace(/\D/g, "").slice(0, 14)}-${randomBytes(3).toString("hex")}`;
  const createdBlobPaths = [];
  let newRows = 0;
  let duplicateRows = 0;
  const summaries = [];
  const ensureBlob = async (file) => {
    const existing = await db.prepare("SELECT * FROM dark_web_blobs WHERE sha256=?").get(file.sha256);
    if (existing) return existing;
    const stored = storePlainDarkWebBlob(darkWebBlobsDir, file);
    if (stored.created) createdBlobPaths.push(stored.storedPath);
    await db.prepare("INSERT INTO dark_web_blobs (sha256,stored_name,size_bytes,media_type,iv_b64,auth_tag_b64,created_at) VALUES (?,?,?,?,?,?,?)")
      .run(file.sha256, stored.storedName, file.buffer.length, file.mediaType, "", "", now);
    return db.prepare("SELECT * FROM dark_web_blobs WHERE sha256=?").get(file.sha256);
  };
  const linkFile = async (eventId, file, kind) => {
    const metrics = kind === "attachment" ? file : { sheetCount: 0, rowCount: 0, columnCount: 0 };
    await db.prepare("INSERT INTO dark_web_files (id,batch_id,event_id,blob_sha256,kind,original_name,sheet_count,row_count,column_count,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(`DWF-${randomBytes(8).toString("hex")}`, batchId, eventId, file.sha256, kind, file.name, metrics.sheetCount || 0, metrics.rowCount || 0, metrics.columnCount || 0, now);
  };
  try {
    await db.transaction(async () => {
      await db.prepare("INSERT INTO ingestion_batches (id,file_name,target_id,status,total_rows,new_rows,duplicate_rows,sheet_summary_json,created_at,ingestion_type,tenant_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
        .run(batchId, filename, targetId, autoPublish ? "已发布" : "待编辑", parsed.events.length, 0, 0, "[]", now, "dark-web", tenantId);
      await ensureBlob(parsed.archive);
      await ensureBlob(parsed.report);
      for (const attachment of parsed.attachments) await ensureBlob(attachment);
      await linkFile(null, parsed.archive, "archive");
      for (const event of parsed.events) {
        const messageUrl = String(event.messageUrl || "").trim();
        const intelTags = normalizeIntelTags(event.intelTags, { fallback: ["数据泄露"] });
        const normalizedMessageUrl = normalizedHttpUrl(messageUrl);
        const publishedAt = storedPublicationDate(event.publishedAt, event.reportDate || parsed.reportDate, now);
        const reportDate = event.reportDate || parsed.reportDate || publishedAt.slice(0, 10);
        const identity = normalizedMessageUrl
          ? `${targetId}|${normalizedMessageUrl}`
          : `${targetId}|${parsed.report.sha256}|${event.title}|${reportDate}|${messageUrl}`;
        const eventHash = createHash("sha256").update(identity).digest("hex");
        const existing = await db.prepare("SELECT id FROM dark_web_events WHERE tenant_id=? AND event_hash=?").get(tenantId, eventHash);
        const eventId = existing?.id || `DWE-${createHash("sha256").update(`${tenantId}|${eventHash}`).digest("hex").slice(0, 20)}`;
        if (existing) {
          duplicateRows += 1;
          await db.prepare(`UPDATE dark_web_events SET latest_batch_id=?,title=?,report_date=?,source_group_name=?,source_group_id=?,source_group_url=?,message_url=?,intel_tags=?,leak_data_types=?,leak_count=?,transaction_count=?,transaction_price=?,published_at=?,publisher_id=?,intel_note=?,article_markdown=?,is_published=?,reviewed_at=?,last_seen_at=?,import_count=import_count+1 WHERE id=?`)
            .run(batchId, event.title, reportDate, event.sourceGroupName || "", event.sourceGroupId || "", event.sourceGroupUrl || "", messageUrl, intelTags.join("、"), event.leakDataTypes || "", event.leakCount || "", event.transactionCount || "", event.transactionPrice || "", publishedAt, event.publisherId || "", event.intelNote || "", event.articleMarkdown || "", autoPublish, autoPublish ? now : null, now, eventId);
        } else {
          newRows += 1;
          await db.prepare(`INSERT INTO dark_web_events (id,target_id,latest_batch_id,title,report_date,source_group_name,source_group_id,source_group_url,message_url,intel_tags,leak_data_types,leak_count,transaction_count,transaction_price,published_at,publisher_id,intel_note,article_markdown,is_published,reviewed_at,event_hash,first_seen_at,last_seen_at,import_count,tenant_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
            .run(eventId, targetId, batchId, event.title, reportDate, event.sourceGroupName || "", event.sourceGroupId || "", event.sourceGroupUrl || "", messageUrl, intelTags.join("、"), event.leakDataTypes || "", event.leakCount || "", event.transactionCount || "", event.transactionPrice || "", publishedAt, event.publisherId || "", event.intelNote || "", event.articleMarkdown || "", autoPublish, autoPublish ? now : null, eventHash, now, now, 1, tenantId);
        }
        await linkFile(eventId, parsed.report, "report");
        for (const attachmentName of event.attachmentNames) {
          const attachment = parsed.attachments.find((item) => item.name === attachmentName);
          if (!attachment) throw new Error(`附件关联丢失：${attachmentName}`);
          await linkFile(eventId, attachment, "attachment");
        }
      }
      summaries.push({ sheet: parsed.report.name, category: "dark-web", label: "威胁情报", total: parsed.events.length, newRows, duplicateRows, skippedRows: 0 });
      for (const attachment of parsed.attachments) summaries.push({ sheet: attachment.name, category: "dark-web-attachment", label: `附件 · ${attachment.sheetCount} 个工作表 / ${attachment.rowCount} 行`, total: attachment.rowCount, newRows: 0, duplicateRows: 0, skippedRows: 0 });
      await db.prepare("UPDATE ingestion_batches SET new_rows=?,duplicate_rows=?,sheet_summary_json=? WHERE id=?").run(newRows, duplicateRows, JSON.stringify(summaries), batchId);
    });
  } catch (error) {
    for (const path of createdBlobPaths) { try { unlinkSync(path); } catch {} }
    throw error;
  }
  return { id: batchId, type: "dark-web", fileName: filename, targetId, status: autoPublish ? "已发布" : "待编辑", totalRows: parsed.events.length, newRows, duplicateRows, changedRows: 0, missingRows: 0, unchangedRows: duplicateRows, sheets: summaries, createdAt: now };
}

function parseAssetReport(row, counts = {}) {
  return { id: row.id, targetId: row.target_id, fileName: row.file_name, sizeBytes: row.size_bytes, dnsCount: counts.dnsCount ?? row.dns_count, portCount: counts.portCount ?? row.port_count, webCount: counts.webCount ?? row.web_count, fingerprintCount: counts.fingerprintCount ?? row.fingerprint_count, iconCount: counts.iconCount ?? row.icon_count ?? 0, createdAt: row.created_at, contentPath: `/api/assets/reports/${row.id}/content` };
}
function resolveReportPath(storedPath, reportId, extension) {
  if (storedPath && existsSync(storedPath)) return storedPath;
  return join(reportsDir, storedPath ? basename(storedPath) : `${reportId}.${extension}`);
}
async function normalizeReportCounts(row, data) {
  const fingerprintCount = aggregateReportFingerprints(data).length;
  const iconCount = Array.isArray(data.icons) ? data.icons.length : 0;
  row.fingerprint_count = fingerprintCount; row.icon_count = iconCount;
  await db.prepare("UPDATE asset_reports SET fingerprint_count=?,icon_count=? WHERE id=?").run(fingerprintCount, iconCount, row.id);
}
async function loadAssetReportData(row) {
  try {
    if (row.data_path) {
      const dataPath = resolveReportPath(row.data_path, row.id, "json");
      if (existsSync(dataPath)) {
        const data = JSON.parse(readFileSync(dataPath, "utf8"));
        if (dataPath !== row.data_path) await db.prepare("UPDATE asset_reports SET data_path=? WHERE id=?").run(dataPath, row.id);
        await normalizeReportCounts(row, data);
        return data;
      }
    }
    const reportPath = resolveReportPath(row.file_path, row.id, "html");
    const data = extractWindowData(readFileSync(reportPath, "utf8"));
    const dataPath = join(reportsDir, `${row.id}.json`);
    writeFileSync(dataPath, JSON.stringify(data));
    await normalizeReportCounts(row, data);
    await db.prepare("UPDATE asset_reports SET file_path=?,data_path=? WHERE id=?").run(reportPath, dataPath, row.id);
    return data;
  } catch { throw new Error("资产报告数据文件已丢失或无法解析"); }
}
async function loadProjectedAssetReport(row, since = "", includeDrafts = false) {
  const sourceData = await loadAssetReportData(row);
  const publicationClause = includeDrafts ? "" : " AND is_published=TRUE";
  const assetRows = row.target_id
    ? await db.prepare(`SELECT * FROM asset_records WHERE tenant_id=? AND target_id=?${publicationClause} ORDER BY id`).all(row.tenant_id, row.target_id)
    : await db.prepare(`SELECT * FROM asset_records WHERE tenant_id=?${publicationClause} ORDER BY id`).all(row.tenant_id);
  const visualAssets = { icons: Array.isArray(sourceData.icons) ? sourceData.icons : [] };
  const data = projectAssetReportData(visualAssets, assetRows);
  return { data, report: { ...parseAssetReport(row, assetReportCounts(data)), todayNewCounts: assetReportTodayCounts(data, since) } };
}
function aggregateReportFingerprints(data) {
  if (Array.isArray(data.fingerprints)) return data.fingerprints;
  const aggregated = new Map();
  for (const website of Array.isArray(data.websites) ? data.websites : []) {
    for (const [field, type] of [["app_products", "应用指纹"], ["framework_products", "信息指纹"]]) {
      for (const product of Array.isArray(website[field]) ? website[field] : []) {
        const name = typeof product === "string" ? product : stringifyField(product?.name || product?.product || product?.key);
        if (!name) continue;
        const key = `${type}|${name}`;
        const current = aggregated.get(key) || { key: name, nameAndType: name, type, count: 0 };
        current.count += 1; aggregated.set(key, current);
      }
    }
  }
  return [...aggregated.values()].sort((left, right) => right.count - left.count || left.key.localeCompare(right.key, "zh-CN"));
}
function reportRanking(values) {
  const counts = new Map();
  for (const value of values.map(stringifyField).filter(Boolean)) counts.set(value, (counts.get(value) || 0) + 1);
  return [...counts.entries()].map(([label, count]) => ({ label, count })).sort((left, right) => right.count - left.count || left.label.localeCompare(right.label, "zh-CN"));
}
function reportFacets(data, section = "web") {
  const websites = Array.isArray(data.websites) ? data.websites : [];
  const ports = Array.isArray(data.ports) ? data.ports : [];
  const dns = Array.isArray(data.dns) ? data.dns : [];
  const fingerprints = aggregateReportFingerprints(data);
  const components = [];
  for (const website of websites) for (const field of ["app_products", "framework_products"]) for (const product of Array.isArray(website[field]) ? website[field] : []) components.push(typeof product === "string" ? product : product?.name || "");
  const facetPorts = section === "ports" ? ports : websites;
  const facetAlive = section === "ports" ? ports : websites;
  const domainValues = section === "dns" ? dns.map((item) => item.subdomain) : websites.map((item) => item.domain);
  return {
    ports: section === "web" || section === "ports" ? reportRanking(facetPorts.map((item) => item.port)) : [],
    domains: section === "web" || section === "dns" ? reportRanking(domainValues.map(rootDomainFrom)) : [],
    protocols: section === "web" ? reportRanking(websites.map((item) => { try { return new URL(item.url).protocol.replace(":", ""); } catch { return ""; } })) : section === "ports" ? reportRanking(ports.map((item) => item.protocol)) : [],
    components: section === "web" ? reportRanking(components) : section === "fingerprints" ? fingerprints.map((item) => ({ label: item.nameAndType, count: item.count })) : [],
    alive: section === "web" || section === "ports" ? reportRanking(facetAlive.map((item) => item.alive)) : [],
    statusCodes: section === "web" ? reportRanking(websites.map((item) => item.status_code)) : [],
    changeTypes: reportRanking((reportSectionRows(data, section) || []).map((item) => item._change_type)),
    icons: section === "web" || section === "icons" ? (Array.isArray(data.icons) ? data.icons : []).filter((item) => item.md5).sort((left, right) => Number(right.count || 0) - Number(left.count || 0)) : []
  };
}
function reportSectionRows(data, section) {
  if (section === "web") return Array.isArray(data.websites) ? data.websites : [];
  if (section === "ports") return Array.isArray(data.ports) ? data.ports : [];
  if (section === "dns") return Array.isArray(data.dns) ? data.dns : [];
  if (section === "fingerprints") return aggregateReportFingerprints(data);
  if (section === "icons") return Array.isArray(data.icons) ? data.icons : [];
  return null;
}
function reportColumnKeys(rows) {
  const keys = [];
  for (const row of rows) for (const key of Object.keys(row || {})) if (!key.startsWith("_") && !keys.includes(key)) keys.push(key);
  return keys;
}
function parseTarget(row) { return { id: row.id, tenantId: row.tenant_id, name: row.name, targetType: row.target_type, owner: row.owner, domains: JSON.parse(row.domains_json), ips: JSON.parse(row.ips_json), keywords: JSON.parse(row.keywords_json), enabled: Boolean(row.enabled), updatedAt: row.updated_at }; }
function parseJson(value, fallback = {}) { try { return value ? JSON.parse(value) : fallback; } catch { return fallback; } }
function parseOptionalJson(value) { try { return value ? JSON.parse(value) : undefined; } catch { return undefined; } }
function parseConnection(row) { return { id: row.id, tenantId: row.tenant_id, name: row.name, category: row.category, providerType: row.provider_type, providerName: connectorProviders[row.provider_type]?.label || row.provider_type, endpoint: row.endpoint, method: row.method, authMode: row.auth_mode, apiKeyConfigured: Boolean(row.api_key_enc), apiKeyPreview: row.api_key_enc ? "已配置" : undefined, targetId: row.target_id, targetName: row.target_name, enabled: Boolean(row.enabled), config: parseJson(row.config_json), status: row.status, successRate: row.success_rate, quota: row.quota, lastCalled: row.last_called, lastTestMessage: row.status === "异常" ? "连接器检测失败，请检查配置后重试" : row.last_test_message, lastTestAt: row.last_test_at, lastSyncAt: row.last_sync_at, consecutiveFailures: row.consecutive_failures }; }
function parseVulnerabilityRecord(row) {
  return {
    id: row.id, targetId: row.target_id, targetName: row.target_name || "未关联监测对象", cve: row.cve,
    title: row.title, summary: row.summary, risk: row.risk, source: row.source, disclosureAt: row.disclosure_at,
    solutions: row.solutions, references: parseJson(row.references_json, []), tags: parseJson(row.tags_json, []),
    sourceCreatedAt: row.source_created_at, sourceUpdatedAt: row.source_updated_at,
    firstSeenAt: row.first_seen_at, lastSeenAt: row.last_seen_at, importCount: Number(row.import_count) || 0, status: row.status,
    manuallyManaged: Boolean(row.manually_managed), isPublished: Boolean(row.is_published), reviewedAt: row.reviewed_at || undefined
  };
}

function vulnerabilityTextList(value, name, { maxItems = 100, maxLength = 8192 } = {}) {
  const values = Array.isArray(value) ? value : String(value || "").split(/[\n,，;；]+/);
  const result = [...new Set(values.map((item) => managedText(item, name, { max: maxLength })).filter(Boolean))];
  if (result.length > maxItems) throw Object.assign(new Error(`${name}不能超过 ${maxItems} 项`), { statusCode: 400 });
  return result;
}

function vulnerabilityDate(value, name = "披露时间") {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) throw Object.assign(new Error(`${name}格式不合法`), { statusCode: 400 });
  return parsed.toISOString();
}

function managedVulnerabilityValues(body) {
  const risk = canonicalRisk(body.risk);
  return {
    cve: managedText(body.cve, "CVE/编号", { max: 128 }).toUpperCase(),
    title: managedText(body.title, "漏洞标题", { required: true, max: 4096 }),
    summary: managedText(body.summary, "漏洞描述", { max: 100_000 }),
    risk,
    source: managedText(body.source || "手工维护", "漏洞来源", { required: true, max: 1024 }),
    disclosureAt: vulnerabilityDate(body.disclosureAt),
    solutions: managedText(body.solutions, "处置建议", { max: 100_000 }),
    references: vulnerabilityTextList(body.references, "参考链接"),
    tags: vulnerabilityTextList(body.tags, "漏洞标签", { maxItems: 50, maxLength: 512 }),
    status: managedText(body.status || "待处置", "状态", { required: true, max: 128 })
  };
}

function vulnerabilityImportField(row, ...aliases) {
  const normalizedAliases = aliases.map((value) => String(value).replace(/[\s_-]+/g, "").toLowerCase());
  const entry = Object.entries(row).find(([key]) => normalizedAliases.includes(String(key).replace(/[\s_-]+/g, "").toLowerCase()));
  return entry ? entry[1] : "";
}

async function importVulnerabilityWorkbook(buffer, filename, targetId) {
  const tenantId = await tenantIdForTarget(targetId);
  const autoPublish = await autoPublishFor(tenantId, "vulnerabilities");
  let workbook;
  try {
    workbook = /\.csv$/i.test(filename) ? XLSX.read(buffer.toString("utf8"), { type: "string", cellDates: true }) : XLSX.read(buffer, { type: "buffer", cellDates: true });
  } catch { throw Object.assign(new Error("漏洞清单文件无法解析"), { statusCode: 400 }); }
  const now = new Date().toISOString();
  const imported = [];
  let skippedRows = 0;
  for (const sheetName of workbook.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: "", raw: false });
    for (const row of rows) {
      const cve = managedText(vulnerabilityImportField(row, "CVE", "漏洞编号", "编号"), "CVE/编号", { max: 128 }).toUpperCase();
      const title = managedText(vulnerabilityImportField(row, "漏洞标题", "标题", "title", "name") || cve, "漏洞标题", { max: 4096 });
      if (!title) { skippedRows += 1; continue; }
      const values = managedVulnerabilityValues({
        cve,
        title,
        summary: vulnerabilityImportField(row, "漏洞描述", "描述", "摘要", "summary", "description"),
        risk: vulnerabilityImportField(row, "风险等级", "风险", "严重程度", "risk", "severity"),
        source: vulnerabilityImportField(row, "漏洞来源", "来源", "source") || "手工导入",
        disclosureAt: vulnerabilityImportField(row, "披露时间", "公开时间", "发布时间", "disclosureAt", "disclosure"),
        solutions: vulnerabilityImportField(row, "处置建议", "解决方案", "修复建议", "solutions"),
        references: vulnerabilityImportField(row, "参考链接", "参考资料", "references"),
        tags: vulnerabilityImportField(row, "标签", "产品标签", "tags"),
        status: vulnerabilityImportField(row, "状态", "status") || "待处置"
      });
      const sourceKey = `manual:${createHash("sha256").update(`${values.cve}|${values.title}|${values.source}`).digest("hex")}`;
      imported.push({ ...values, sourceKey, raw: row });
    }
  }
  if (!imported.length) throw Object.assign(new Error("文件中没有可导入的漏洞记录，请至少提供“漏洞标题”或“CVE”列"), { statusCode: 400 });
  let inserted = 0; let updated = 0;
  await db.transaction(async () => {
    for (const record of imported) {
      await db.prepare("DELETE FROM vulnerability_suppressions WHERE tenant_id=? AND COALESCE(source_connection_id,'')='' AND source_key=?").run(tenantId, record.sourceKey);
      const current = await db.prepare("SELECT id FROM vulnerability_records WHERE tenant_id=? AND source_connection_id IS NULL AND source_key=?").get(tenantId, record.sourceKey);
      if (current) {
        await db.prepare(`UPDATE vulnerability_records SET target_id=?,cve=?,title=?,summary=?,risk=?,source=?,disclosure_at=?,solutions=?,references_json=?,tags_json=?,raw_json=?,source_updated_at=?,last_seen_at=?,import_count=import_count+1,status=?,manually_managed=TRUE,is_published=?,reviewed_at=? WHERE id=?`)
          .run(targetId, record.cve, record.title, record.summary, record.risk, record.source, record.disclosureAt, record.solutions, JSON.stringify(record.references), JSON.stringify(record.tags), JSON.stringify(record.raw), now, now, record.status, autoPublish, autoPublish ? now : null, current.id);
        updated += 1;
      } else {
        const id = `VULN-MANUAL-${createHash("sha256").update(`${tenantId}|${record.sourceKey}`).digest("hex").slice(0, 20)}`;
        await db.prepare(`INSERT INTO vulnerability_records (id,tenant_id,target_id,source_connection_id,source_key,cve,title,summary,risk,source,disclosure_at,solutions,references_json,tags_json,raw_json,source_created_at,source_updated_at,first_seen_at,last_seen_at,import_count,status,manually_managed,is_published,reviewed_at) VALUES (?,?,?,NULL,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,TRUE,?,?)`)
          .run(id, tenantId, targetId, record.sourceKey, record.cve, record.title, record.summary, record.risk, record.source, record.disclosureAt, record.solutions, JSON.stringify(record.references), JSON.stringify(record.tags), JSON.stringify(record.raw), now, now, now, now, 1, record.status, autoPublish, autoPublish ? now : null);
        inserted += 1;
      }
    }
  });
  return { fileName: filename, totalRows: imported.length + skippedRows, importedRows: imported.length, inserted, updated, skippedRows, status: autoPublish ? "已发布" : "待审核" };
}

async function suppressVulnerability(row) {
  const id = `VULN-SUPPRESS-${createHash("sha256").update(`${row.tenant_id}|${row.source_connection_id || ""}|${row.source_key}`).digest("hex").slice(0, 24)}`;
  await db.prepare(`INSERT INTO vulnerability_suppressions (id,tenant_id,source_connection_id,source_key,created_at) VALUES (?,?,?,?,?)
    ON CONFLICT DO NOTHING`)
    .run(id, row.tenant_id, row.source_connection_id, row.source_key, new Date().toISOString());
}
function parseVulnerabilityAlert(row) {
  const fields = parseJson(row.asset_fields_json, {});
  return {
    id: row.id, vulnerabilityId: row.vulnerability_id, vulnerabilityFirstSeenAt: row.vulnerability_first_seen_at,
    cve: row.vulnerability_cve, vulnerabilityTitle: row.vulnerability_title,
    risk: row.vulnerability_risk, source: row.vulnerability_source, disclosureAt: row.vulnerability_disclosure_at,
    watchGroupId: row.watch_group_id, watchGroupName: row.watch_group_name, watchItemId: row.watch_item_id, watchProduct: row.watch_product,
    assetRecordId: row.asset_record_id || null, assetTitle: row.asset_title || "", assetUrl: fields.url || "", assetIp: fields.ipAddress || "", assetPort: fields.port || "",
    targetId: row.target_id, targetName: row.target_name || "未关联监测对象", matchedProduct: row.matched_product, assetVersion: row.asset_version,
    confidence: row.confidence, matchType: row.match_type, evidence: parseJson(row.evidence_json, {}), status: row.status,
    firstMatchedAt: row.first_matched_at, lastMatchedAt: row.last_matched_at
  };
}
function vulnerabilityAlertAsIntelligence(alert) {
  const asset = alert.assetTitle || alert.assetUrl || alert.assetIp || "待确认资产";
  return {
    id: alert.id, title: [alert.cve, alert.vulnerabilityTitle].filter(Boolean).join(" · ") || "资产漏洞告警",
    summary: `${asset} 命中 ${alert.matchedProduct || alert.watchProduct || "重点监测指纹"}。`,
    type: "漏洞情报", subtype: "资产漏洞告警", risk: canonicalRisk(alert.risk), source: "资产漏洞告警",
    organization: alert.targetName || "未关联监测对象", observedAt: alert.firstMatchedAt || alert.lastMatchedAt,
    firstSeenAt: alert.firstMatchedAt || alert.lastMatchedAt, confidence: alert.confidence === "confirmed" ? 95 : alert.confidence === "suspected" ? 75 : 50,
    tags: uniqueStrings([alert.matchedProduct, asset]), entities: uniqueStrings([asset, alert.assetUrl || alert.assetIp, alert.matchedProduct]),
    detailPath: "/portal/modules/vulnerabilities/asset-alerts"
  };
}
async function tenantIdForTarget(targetId, expectedTenantId = "") {
  if (!targetId) throw Object.assign(new Error("必须选择监测对象以确定租户"), { statusCode: 400 });
  const target = expectedTenantId
    ? await db.prepare("SELECT tenant_id FROM monitoring_targets WHERE id=? AND tenant_id=?").get(targetId, expectedTenantId)
    : await db.prepare("SELECT tenant_id FROM monitoring_targets WHERE id=?").get(targetId);
  if (!target) throw Object.assign(new Error(expectedTenantId ? "当前租户下不存在该监测对象" : "监测对象不存在"), { statusCode: 400 });
  return target.tenant_id;
}

async function requireTenantContext(req, res, suppliedTenantId = "") {
  const rawHeader = req.headers["x-sentinel-tenant-id"];
  const headerValue = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
  const tenantId = managedText(headerValue, "当前运营租户", { required: true, max: 100 });
  const supplied = managedText(suppliedTenantId, "客户租户", { max: 100 });
  if (supplied && supplied !== tenantId) {
    json(res, 403, { message: "请求租户与当前运营租户不一致" });
    return null;
  }
  if (!await db.prepare("SELECT id FROM tenants WHERE id=? AND status<>'disabled'").get(tenantId)) {
    json(res, 404, { message: "当前运营租户不存在或已停用" });
    return null;
  }
  req.auditTenantId = tenantId;
  return tenantId;
}
async function parseDarkWebEvent(row) {
  const propagationCount = (await db.prepare(`SELECT COUNT(DISTINCT related.event_id) AS count FROM dark_web_files current JOIN dark_web_files related ON related.blob_sha256=current.blob_sha256 AND related.kind='attachment' WHERE current.event_id=? AND current.kind='attachment'`).get(row.id)).count;
  return {
    id: row.id, targetId: row.target_id, title: row.title, risk: canonicalRisk(row.risk || "low"), reportDate: row.report_date,
    sourceGroupName: row.source_group_name, sourceGroupId: row.source_group_id,
    sourceGroupUrl: row.source_group_url, messageUrl: row.message_url,
    intelTags: normalizeIntelTags(row.intel_tags, { fallback: ["数据泄露"] }),
    leakDataTypes: row.leak_data_types, leakCount: row.leak_count,
    transactionCount: row.transaction_count, transactionPrice: row.transaction_price,
    publishedAt: row.published_at, publisherId: row.publisher_id, intelNote: row.intel_note, articleMarkdown: row.article_markdown || "",
    firstSeenAt: row.first_seen_at, lastSeenAt: row.last_seen_at, importCount: row.import_count,
    repeatedPropagationCount: Math.max(0, propagationCount - 1)
  };
}

const managedIngestionTypes = ["sensitive", "asset", "dark-web"];

function managedText(value, name, { required = false, max = 500 } = {}) {
  const text = stringifyField(value).trim();
  if (required && !text) throw Object.assign(new Error(`${name}不能为空`), { statusCode: 400 });
  if (text.length > max) throw Object.assign(new Error(`${name}不能超过 ${max} 个字符`), { statusCode: 400 });
  return text;
}

function managedFields(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Object.assign(new Error("字段明细必须是 JSON 对象"), { statusCode: 400 });
  const entries = Object.entries(value);
  if (entries.length > 100) throw Object.assign(new Error("字段明细不能超过 100 项"), { statusCode: 400 });
  return Object.fromEntries(entries.map(([key, item]) => [managedText(key, "字段名", { required: true, max: 80 }), managedText(item, "字段值", { max: 4000 })]));
}

function managedOptionalDate(value, name, { dateOnly = false } = {}) {
  const text = managedText(value, name, { max: 40 });
  if (!text) return "";
  if (dateOnly) {
    const parsed = new Date(`${text}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) throw Object.assign(new Error(`${name}格式不合法`), { statusCode: 400 });
    return text;
  }
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) throw Object.assign(new Error(`${name}格式不合法`), { statusCode: 400 });
  return parsed.toISOString();
}

function parseManagedRelationalRecord(row, type) {
  return {
    id: row.id, type, targetId: row.target_id, title: row.title, category: row.category,
    risk: row.risk, fields: parseJson(row.fields_json),
    firstSeenAt: row.first_seen_at, lastSeenAt: row.last_seen_at,
    importCount: row.import_count, batchId: row.batch_id || undefined,
    isPublished: Boolean(row.is_published), reviewedAt: row.reviewed_at || undefined,
    changeType: type === "asset" ? row.change_type : undefined,
    previousFields: type === "asset" ? parseOptionalJson(row.previous_fields_json) : undefined,
    presentInLatestBatch: type === "asset" ? Boolean(row.present_in_latest_batch) : undefined,
    previouslyPublished: type === "asset" ? Boolean(row.previously_published) : undefined,
    lastChangedAt: type === "asset" ? row.last_changed_at || undefined : undefined,
    missingSince: type === "asset" ? row.missing_since || undefined : undefined
  };
}

async function publishAssetRecords(where, params, now) {
  return db.prepare(`UPDATE asset_records SET
    is_published=CASE WHEN change_type='missing' THEN FALSE ELSE TRUE END,
    reviewed_at=COALESCE(reviewed_at,?),last_seen_at=?,previously_published=FALSE
    WHERE ${where}`).run(now, now, ...params);
}

async function remainingManagedBatchRecords(table, batchColumn, batchId, type) {
  if (type === "asset") {
    return Number((await db.prepare(`SELECT COUNT(*) AS count FROM asset_records WHERE ${batchColumn}=? AND is_published=FALSE
      AND NOT (change_type='missing' AND reviewed_at IS NOT NULL AND previously_published=FALSE)`).get(batchId)).count);
  }
  return Number((await db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${batchColumn}=? AND is_published=FALSE`).get(batchId)).count);
}

function parseManagedDarkWebRecord(row) {
  return {
    id: row.id, type: "dark-web", targetId: row.target_id, title: row.title,
    risk: canonicalRisk(row.risk || "low"),
    reportDate: row.report_date, sourceGroupName: row.source_group_name,
    sourceGroupId: row.source_group_id, sourceGroupUrl: row.source_group_url,
    messageUrl: row.message_url, intelTags: normalizeIntelTags(row.intel_tags, { fallback: ["数据泄露"] }), leakDataTypes: row.leak_data_types,
    leakCount: row.leak_count, transactionCount: row.transaction_count,
    transactionPrice: row.transaction_price, publishedAt: row.published_at,
    publisherId: row.publisher_id, intelNote: row.intel_note, articleMarkdown: row.article_markdown || "",
    isPublished: Boolean(row.is_published), reviewedAt: row.reviewed_at || undefined,
    firstSeenAt: row.first_seen_at, lastSeenAt: row.last_seen_at,
    importCount: row.import_count, batchId: row.latest_batch_id
  };
}

function assertManagedType(value) {
  const type = String(value || "");
  if (!managedIngestionTypes.includes(type)) throw Object.assign(new Error("录入类型不合法"), { statusCode: 400 });
  return type;
}

function managedRecordValues(type, body) {
  const targetId = managedText(body.targetId, "监测对象", { required: true, max: 100 });
  const title = managedText(body.title, "标题", { required: true, max: 300 });
  if (type === "sensitive" || type === "asset") {
    const allowed = type === "sensitive" ? Object.values(sensitiveSheetCategories) : Object.values(assetCategories);
    const category = managedText(body.category, "分类", { required: true, max: 40 });
    if (!allowed.includes(category)) throw Object.assign(new Error("记录分类不合法"), { statusCode: 400 });
    return { targetId, title, category, risk: managedText(body.risk || "未标记", "风险等级", { max: 40 }), fields: managedFields(body.fields || {}) };
  }
  const requestedReportDate = managedOptionalDate(body.reportDate, "报告日期", { dateOnly: true });
  const requestedPublishedAt = managedOptionalDate(body.publishedAt, "发布时间");
  const publishedAt = requestedPublishedAt || storedPublicationDate("", requestedReportDate, new Date().toISOString());
  const risk = managedText(body.risk || "low", "风险等级", { max: 16 });
  if (!["critical", "high", "medium", "low"].includes(risk)) throw Object.assign(new Error("风险等级不合法"), { statusCode: 400 });
  return {
    targetId, title, risk,
    reportDate: requestedReportDate || publishedAt.slice(0, 10),
    sourceGroupName: managedText(body.sourceGroupName, "来源群组", { max: 200 }),
    sourceGroupId: managedText(body.sourceGroupId, "来源群组 ID", { max: 200 }),
    sourceGroupUrl: managedText(body.sourceGroupUrl, "来源群组链接", { max: 1000 }),
    messageUrl: managedText(body.messageUrl, "消息链接或原文说明", { max: 1000 }),
    intelTags: normalizeIntelTags(body.intelTags, { required: true }),
    leakDataTypes: managedText(body.leakDataTypes, "泄漏数据类型", { max: 500 }),
    leakCount: managedText(body.leakCount, "泄漏数量", { max: 100 }),
    transactionCount: managedText(body.transactionCount, "交易数量", { max: 100 }),
    transactionPrice: managedText(body.transactionPrice, "交易价格", { max: 100 }),
    publishedAt,
    publisherId: managedText(body.publisherId, "发布者 ID", { max: 200 }),
    intelNote: managedText(body.intelNote, "情报备注", { max: 4000 }),
    articleMarkdown: externalizeArticleImages(managedText(body.articleMarkdown, "文章正文", { max: MAX_DARK_WEB_ARTICLE_CHARS }), articleImagesDir).html
  };
}
function secureTextEqual(actual, expected) {
  const left = Buffer.from(String(actual || "")); const right = Buffer.from(String(expected || ""));
  return left.length > 0 && left.length === right.length && timingSafeEqual(left, right);
}
async function watchVulnConnectionForToken(req) {
  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const rows = await db.prepare("SELECT * FROM api_connections WHERE provider_type='watchvuln' AND enabled=1 AND api_key_enc IS NOT NULL ORDER BY id").all();
  return rows.find((row) => {
    try { return secureTextEqual(token, decrypt(row.api_key_enc)); } catch { return false; }
  }) || null;
}
async function authenticatedUser(req, res) {
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token) { json(res, 401, { message: "请先登录" }); return null; }
  const session = await db.prepare(`SELECT sessions.*,users.name,users.role,users.workspace,users.role_key,users.enabled,users.last_login_at,users.created_at,users.updated_at FROM sessions JOIN users ON users.account=sessions.account WHERE token_hash=? AND expires_at>? AND users.enabled=1`).get(tokenHash(token), new Date().toISOString());
  if (!session) { json(res, 401, { message: "登录已失效，请重新登录" }); return null; }
  req.auditUser = session;
  return session;
}
async function requireWorkspace(req, res, allowed) {
  const user = await authenticatedUser(req, res); if (!user) return null;
  const workspace = roleFor(user.role_key)?.workspace || user.workspace;
  if (!allowed.includes(workspace)) { json(res, 403, { message: "当前账号无权访问该工作区" }); return null; }
  return user;
}
async function requirePermission(req, res, permission) {
  const user = await authenticatedUser(req, res); if (!user) return null;
  if (!permissionsFor(user).includes(permission)) { json(res, 403, { message: `缺少权限：${permissionLabels[permission] || permission}` }); return null; }
  return user;
}
async function requireAnyPermission(req, res, permissions) {
  const user = await authenticatedUser(req, res); if (!user) return null;
  if (!permissions.some((permission) => permissionsFor(user).includes(permission))) { json(res, 403, { message: "当前账号无权查看漏洞清单" }); return null; }
  return user;
}
async function requireSession(req, res) { return requirePermission(req, res, "portal:read"); }
async function requireAdmin(req, res) { return requireWorkspace(req, res, ["admin", "both"]); }
function canPreviewDrafts(user, url) { return url.searchParams.get("include_drafts") === "1" && permissionsFor(user).includes("ingestion:manage"); }

function auditDescriptor(method, pathname) {
  const definitions = [
    [/^\/api\/auth\/(login(?:\/otp)?|logout)$/u, "management", "身份认证", 0, (match) => match[1] === "login/otp" ? "验证动态码" : match[1] === "login" ? "登录平台" : "退出登录"],
    [/^\/api\/profile(?:\/(change-password))?$/u, "management", "user", 1, (match) => match[1] ? "修改个人密码" : "更新个人信息"],
    [/^\/api\/password-policy$/u, "management", "user", 0, () => "更新密码策略"],
    [/^\/api\/users(?:\/([^/]+))?(?:\/(reset-password))?$/u, "management", "user", 1, (match) => match[2] ? "重置用户密码" : method === "POST" ? "创建用户" : method === "DELETE" ? "删除用户" : "更新用户"],
    [/^\/api\/targets(?:\/([^/]+))?$/u, "operations", "keyword-domain", 1, () => method === "POST" ? "新增关键词与域名配置" : method === "DELETE" ? "删除关键词与域名配置" : "更新关键词与域名配置"],
    [/^\/api\/connections(?:\/([^/]+))?(?:\/(test|sync))?$/u, "operations", "connection", 1, (match) => match[2] === "sync" ? "同步数据接口" : match[2] === "test" ? "测试数据接口" : method === "POST" ? "新增数据接口" : method === "DELETE" ? "删除数据接口" : "更新数据接口"],
    [/^\/api\/ingestion\/(sensitive-xlsx|assets-xlsx|assets-html|dark-web|dark-web-zip)$/u, "operations", "ingestion", 1, () => "导入业务数据"],
    [/^\/api\/ingestion\/records(?:\/([^/]+)\/([^/]+))?(?:\/(publish))?$/u, "operations", "ingestion-record", 2, (match) => match[3] ? "发布业务数据" : method === "POST" ? "新增业务数据" : method === "DELETE" ? "删除业务数据" : "更新业务数据"],
    [/^\/api\/vulnerabilities(?:\/([^/]+))?(?:\/(publish))?$/u, "operations", "vulnerability", 1, (match) => match[2] ? "发布漏洞情报" : pathname.endsWith("/import") ? "导入漏洞情报" : method === "DELETE" ? "删除漏洞情报" : "更新漏洞情报"],
    [/^\/api\/credentials\/records(?:\/([^/]+))?(?:\/(publish))?$/u, "operations", "credential", 1, (match) => match[2] ? "发布账号凭据" : method === "POST" ? "新增账号凭据" : method === "DELETE" ? "删除账号凭据" : "更新账号凭据"],
    [/^\/api\/edge\/deployments(?:\/([^/]+))?(?:\/(openapi-key|license|publish-snapshot|status))?$/u, "operations", "edge-deployment", 1, (match) => match[2] === "openapi-key" ? "管理 OpenAPI Key" : match[2] === "license" ? "管理许可证" : match[2] === "publish-snapshot" ? "发布地端快照" : method === "POST" ? "创建地端部署" : method === "DELETE" ? "删除地端部署" : "更新地端部署"],
    [/^\/api\/worker-nodes(?:\/([^/]+))?$/u, "operations", "worker-node", 1, () => method === "POST" ? "预注册 Worker 节点" : method === "DELETE" ? "清理 Worker 节点" : "更新 Worker 节点状态"],
    [/^\/api\/(background-tasks|collection-jobs|fingerprint-watch-groups|vulnerability-alerts)(?:\/([^/]+))?/u, "operations", "operations", 2, () => "执行运营配置"],
    [/^\/api\/fingerprint-icons(?:\/([^/]+))?/u, "operations", "fingerprint-icon", 1, () => pathname.endsWith("/catalog/sync") ? "更新指纹基础图标库" : method === "POST" ? "新增指纹图标" : method === "DELETE" ? "删除指纹图标" : "更新指纹图标"]
  ];
  for (const [pattern, context, resourceType, idIndex, actionFor] of definitions) {
    const match = pathname.match(pattern); if (match) return { context, resourceType, resourceId: decodeURIComponent(match[idIndex] || ""), action: actionFor(match) };
  }
  return { context: pathname.startsWith("/api/users") ? "management" : "operations", resourceType: "api", resourceId: "", action: "执行后台操作" };
}

function auditPathUsesTenant(pathname) {
  return /^\/api\/(targets|connections|ingestion|vulnerabilities|credentials|edge\/deployments|collection-jobs|tenant-publication-policies|fingerprint-watch-groups|vulnerability-alerts)(?:\/|$)/u.test(pathname);
}

async function writeAuditLog(req, res, url, requestId) {
  if (req.method === "GET" || req.method === "OPTIONS" || !url.pathname.startsWith("/api/")) return;
  const descriptor = auditDescriptor(req.method, url.pathname); const user = req.auditUser;
  const ipAddress = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim().slice(0, 100);
  const occurredAt = new Date().toISOString();
  const rawTenantHeader = req.headers["x-sentinel-tenant-id"];
  const tenantHeader = Array.isArray(rawTenantHeader) ? rawTenantHeader[0] : rawTenantHeader;
  const tenantCandidate = String(req.auditTenantId || (auditPathUsesTenant(url.pathname) ? tenantHeader || url.searchParams.get("tenant_id") : "") || "").trim();
  let tenantId = tenantCandidate && tenantCandidate.length <= 100 && /^[A-Za-z0-9._:-]+$/u.test(tenantCandidate) ? tenantCandidate : null;
  if (tenantId && !await db.prepare("SELECT id FROM tenants WHERE id=?").get(tenantId)) tenantId = null;
  await db.prepare(`INSERT INTO audit_logs (id,occurred_at,context,tenant_id,actor_account,actor_name,actor_role,action,resource_type,resource_id,method,path,status_code,result,ip_address,request_id,detail_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(`AUDIT-${occurredAt.replace(/\D/g, "").slice(0, 17)}-${randomBytes(5).toString("hex")}`, occurredAt, descriptor.context, tenantId, user?.account || req.auditAttemptedAccount || "anonymous", user?.name || "", user?.role || roleFor(user?.role_key)?.label || "", descriptor.action, descriptor.resourceType, descriptor.resourceId, req.method, url.pathname, res.statusCode, res.statusCode < 400 ? "success" : "failed", ipAddress, requestId, JSON.stringify({ queryKeys: [...url.searchParams.keys()] }));
}

function parseAuditLog(row) {
  return { id: row.id, occurredAt: row.occurred_at, context: row.context, tenantId: row.tenant_id || null, actorAccount: row.actor_account, actorName: row.actor_name, actorRole: row.actor_role, action: row.action, resourceType: row.resource_type, resourceId: row.resource_id, method: row.method, path: row.path, statusCode: Number(row.status_code), result: row.result, ipAddress: row.ip_address, requestId: row.request_id };
}

const intelligenceTypes = ["暗网情报", "敏感泄露", "仿冒网站", "暴露面", "漏洞情报"];

function safeJson(value, fallback = {}) {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

function uniqueStrings(values, limit = 8) {
  return [...new Set(values.flatMap((value) => Array.isArray(value) ? value : [value]).map((value) => stringifyField(value).trim()).filter(Boolean))].slice(0, limit);
}

function splitIntelValues(value) {
  return stringifyField(value).split(/[、,，;；|/\n]+/).map((item) => item.trim()).filter(Boolean);
}

function maskAccount(value) {
  const account = stringifyField(value).trim();
  if (!account) return "";
  const at = account.indexOf("@");
  if (at > 0) return `${account.slice(0, Math.min(2, at))}***${account.slice(at)}`;
  if (account.length <= 3) return `${account.slice(0, 1)}***`;
  return `${account.slice(0, 2)}***${account.slice(-1)}`;
}

function canonicalRisk(value) {
  const risk = stringifyField(value).toLowerCase();
  if (/(critical|严重|极高|致命)/.test(risk)) return "critical";
  if (/(high|高危|高风险|^高$)/.test(risk)) return "high";
  if (/(medium|中危|中风险|^中$)/.test(risk)) return "medium";
  if (/(low|低危|低风险|^低$)/.test(risk)) return "low";
  return "info";
}

function intelligenceUnionSql() {
  return `
    SELECT 'dark-web' AS record_kind,dark_web_events.id,dark_web_events.title,'暗网情报' AS type,'暗网情报' AS subtype,
      COALESCE(NULLIF(dark_web_events.risk,''),'low') AS canonical_risk,source_group_name AS source,
      COALESCE(monitoring_targets.name,'未关联监测对象') AS organization,published_at AS observed_at,dark_web_events.first_seen_at,
      intel_note AS summary_raw,NULL AS fields_json,concat_ws('、',NULLIF(intel_tags,''),NULLIF(leak_data_types,'')) AS tags_raw,intel_tags AS intel_tags_raw,
      source_group_id AS entity_one,message_url AS entity_two,publisher_id AS entity_three,dark_web_events.tenant_id,dark_web_events.is_published,dark_web_events.target_id
    FROM dark_web_events LEFT JOIN monitoring_targets ON monitoring_targets.id=dark_web_events.target_id
    UNION ALL
    SELECT 'sensitive',sensitive_records.id,sensitive_records.title,
      CASE WHEN sensitive_records.category='phishing' THEN '仿冒网站' ELSE '敏感泄露' END,
      CASE sensitive_records.category WHEN 'account-password' THEN '账号口令' WHEN 'source-code' THEN '源码泄露' WHEN 'documents' THEN '文档泄露' WHEN 'phishing' THEN '仿冒网站' ELSE sensitive_records.category END,
      CASE WHEN lower(sensitive_records.risk) LIKE '%critical%' OR sensitive_records.risk LIKE '%严重%' OR sensitive_records.risk LIKE '%极高%' THEN 'critical' WHEN lower(sensitive_records.risk) LIKE '%high%' OR sensitive_records.risk LIKE '%高%' THEN 'high' WHEN lower(sensitive_records.risk) LIKE '%medium%' OR sensitive_records.risk LIKE '%中%' THEN 'medium' WHEN lower(sensitive_records.risk) LIKE '%low%' OR sensitive_records.risk LIKE '%低%' THEN 'low' ELSE 'info' END,
      COALESCE(ingestion_batches.file_name,'人工录入'),
      COALESCE(monitoring_targets.name,'未关联监测对象'),sensitive_records.last_seen_at,sensitive_records.first_seen_at,'',sensitive_records.fields_json,
      sensitive_records.category,NULL,'','','',sensitive_records.tenant_id,sensitive_records.is_published,sensitive_records.target_id
    FROM sensitive_records
    LEFT JOIN monitoring_targets ON monitoring_targets.id=sensitive_records.target_id
    LEFT JOIN ingestion_batches ON ingestion_batches.id=sensitive_records.batch_id
    UNION ALL
    SELECT 'asset',asset_records.id,asset_records.title,'暴露面',
      CASE asset_records.category WHEN 'subdomain' THEN 'DNS / 子域名' WHEN 'server' THEN '端口 / 服务器' WHEN 'web' THEN 'Web资产' WHEN 'fingerprint' THEN '指纹列表' ELSE asset_records.category END,
      CASE WHEN lower(asset_records.risk) LIKE '%critical%' OR asset_records.risk LIKE '%严重%' OR asset_records.risk LIKE '%极高%' THEN 'critical' WHEN lower(asset_records.risk) LIKE '%high%' OR asset_records.risk LIKE '%高%' THEN 'high' WHEN lower(asset_records.risk) LIKE '%medium%' OR asset_records.risk LIKE '%中%' THEN 'medium' WHEN lower(asset_records.risk) LIKE '%low%' OR asset_records.risk LIKE '%低%' THEN 'low' ELSE 'info' END,
      COALESCE(ingestion_batches.file_name,'资产录入'),
      COALESCE(monitoring_targets.name,'未关联监测对象'),asset_records.last_seen_at,asset_records.first_seen_at,'',asset_records.fields_json,
      asset_records.category,NULL,'','','',asset_records.tenant_id,asset_records.is_published,asset_records.target_id
    FROM asset_records
    LEFT JOIN monitoring_targets ON monitoring_targets.id=asset_records.target_id
    LEFT JOIN ingestion_batches ON ingestion_batches.id=asset_records.batch_id
    UNION ALL
    SELECT 'vulnerability',vulnerability_records.id,vulnerability_records.title,'漏洞情报','漏洞情报',
      vulnerability_records.risk,vulnerability_records.source,
      COALESCE(linked_vulnerability_targets.organization,'未关联资产'),
      COALESCE(vulnerability_records.disclosure_at,vulnerability_records.source_updated_at),vulnerability_records.first_seen_at,
      vulnerability_records.summary,vulnerability_records.raw_json,vulnerability_records.tags_json,NULL,
      vulnerability_records.cve,'',vulnerability_records.solutions,vulnerability_records.tenant_id,vulnerability_records.is_published,vulnerability_records.target_id
    FROM vulnerability_records
    LEFT JOIN (
      SELECT alerts.vulnerability_id,string_agg(DISTINCT targets.name,' / ' ORDER BY targets.name) AS organization
      FROM vulnerability_alerts alerts
      JOIN asset_records assets ON assets.id=alerts.asset_record_id
      JOIN monitoring_targets targets ON targets.id=assets.target_id
      WHERE alerts.asset_record_id IS NOT NULL
      GROUP BY alerts.vulnerability_id
    ) linked_vulnerability_targets ON linked_vulnerability_targets.vulnerability_id=vulnerability_records.id`;
}

function intelligenceSummary(row, fields) {
  if (row.record_kind === "dark-web") return row.summary_raw || `${row.source} 发布了与 ${row.organization} 相关的数据泄漏信息。`;
  if (row.record_kind === "vulnerability") return row.summary_raw || `${row.entity_one || "未编号漏洞"} 存在新的高价值漏洞情报。`;
  if (row.record_kind === "sensitive") {
    if (row.tags_raw === "account-password") return `发现 ${fields.systemName || row.title} 相关账号口令记录。`;
    if (row.tags_raw === "source-code") return `发现 ${fields.name || row.title} 相关源码泄露记录${fields.channel ? `，渠道为 ${fields.channel}` : ""}。`;
    if (row.tags_raw === "documents") return `发现 ${fields.name || row.title} 相关文档泄露记录${fields.channel ? `，渠道为 ${fields.channel}` : ""}。`;
    return `发现 ${fields.name || row.title} 相关仿冒网站记录${fields.url ? `，地址为 ${fields.url}` : ""}。`;
  }
  return `发现互联网暴露面资产 ${row.title}，分类为 ${row.subtype}。`;
}

function parseIntelligenceRow(row) {
  const fields = safeJson(row.fields_json);
  let tags = splitIntelValues(row.tags_raw);
  let entities = [row.entity_one, row.entity_two, row.entity_three];
  if (row.record_kind === "sensitive") {
    tags = uniqueStrings([row.subtype, fields.type, fields.channel, fields.source, fields.dataSource]);
    entities = row.tags_raw === "account-password"
      ? [fields.systemName, fields.loginUrl, maskAccount(fields.account)]
      : [fields.name, fields.url, fields.channel];
  } else if (row.record_kind === "asset") {
    tags = uniqueStrings([row.subtype, fields.protocol, fields.application, fields.riskFlag, fields.dataSource]);
    entities = [fields.url, fields.subdomain, fields.address && fields.port ? `${fields.address}:${fields.port}` : fields.address, fields.domain, fields.ipAddress];
  } else if (row.record_kind === "vulnerability") {
    tags = uniqueStrings(["漏洞情报", fields.tags, row.entity_one]);
    entities = uniqueStrings([row.entity_one, fields.references, fields.githubSearch], 8);
  }
  return {
    id: row.id,
    title: row.title,
    summary: intelligenceSummary(row, fields),
    type: row.type,
    subtype: row.subtype,
    risk: canonicalRisk(row.canonical_risk),
    source: row.source || "未知来源",
    organization: row.organization,
    observedAt: row.observed_at,
    firstSeenAt: row.first_seen_at,
    confidence: null,
    tags: uniqueStrings(tags),
    intelTags: row.record_kind === "dark-web" ? normalizeIntelTags(row.intel_tags_raw, { fallback: ["数据泄露"] }) : undefined,
    entities: uniqueStrings(entities)
  };
}

function intelligenceBoardName(type) {
  if (type === "暗网情报") return "暗网情报";
  if (type === "敏感泄露") return "敏感信息";
  if (type === "漏洞情报") return "漏洞情报";
  if (type === "暴露面" || type === "仿冒网站") return "互联网暴露面";
  return null;
}

async function intelligenceQuery({ page = 1, pageSize = 20, query = "", type = "", excludeType = "", subtype = "", risk = "", id = "", includeRiskCounts = false, since = "", todayOnly = false, tenantId = "", includeDrafts = false } = {}) {
  const clauses = []; const params = [];
  if (tenantId) { clauses.push("tenant_id=?"); params.push(tenantId); }
  if (!includeDrafts) clauses.push("is_published=TRUE");
  if (id) { clauses.push("id=?"); params.push(id); }
  if (query) {
    clauses.push("(title ILIKE ? OR summary_raw ILIKE ? OR source ILIKE ? OR organization ILIKE ? OR tags_raw ILIKE ? OR entity_one ILIKE ? OR entity_two ILIKE ?)");
    params.push(...Array(7).fill(`%${query}%`));
  }
  if (type) { clauses.push("type=?"); params.push(type); }
  if (excludeType) { clauses.push("type<>?"); params.push(excludeType); }
  if (subtype) { clauses.push("subtype=?"); params.push(subtype); }
  const baseWhere = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const allTotal = Number((await db.prepare(`SELECT COUNT(*) AS count FROM (${intelligenceUnionSql()}) intelligence ${baseWhere}`).get(...params)).count);
  const todayClauses = [...clauses]; const todayParams = [...params];
  if (since) { todayClauses.push("first_seen_at>=?"); todayParams.push(since); }
  const todayWhere = todayClauses.length ? `WHERE ${todayClauses.join(" AND ")}` : "";
  const todayNewCount = since ? Number((await db.prepare(`SELECT COUNT(*) AS count FROM (${intelligenceUnionSql()}) intelligence ${todayWhere}`).get(...todayParams)).count) : 0;
  const activeClauses = todayOnly && since ? todayClauses : clauses;
  const activeParams = todayOnly && since ? todayParams : params;
  const activeWhere = activeClauses.length ? `WHERE ${activeClauses.join(" AND ")}` : "";
  const filteredClauses = [...activeClauses]; const filteredParams = [...activeParams];
  const risks = risk.split(",").filter(Boolean);
  if (risks.length) { filteredClauses.push(`canonical_risk IN (${risks.map(() => "?").join(",")})`); filteredParams.push(...risks); }
  const where = filteredClauses.length ? `WHERE ${filteredClauses.join(" AND ")}` : "";
  const total = (await db.prepare(`SELECT COUNT(*) AS count FROM (${intelligenceUnionSql()}) intelligence ${where}`).get(...filteredParams)).count;
  const rows = await db.prepare(`SELECT * FROM (${intelligenceUnionSql()}) intelligence ${where} ORDER BY observed_at DESC,id DESC LIMIT ? OFFSET ?`).all(...filteredParams, pageSize, (page - 1) * pageSize);
  const result = { page, pageSize, total, allTotal, todayNewCount, data: rows.map(parseIntelligenceRow) };
  if (!includeRiskCounts) return result;
  const countRows = await db.prepare(`SELECT canonical_risk AS risk,COUNT(*) AS count FROM (${intelligenceUnionSql()}) intelligence ${activeWhere} GROUP BY canonical_risk`).all(...activeParams);
  const riskCounts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  countRows.forEach((row) => { if (row.risk in riskCounts) riskCounts[row.risk] = Number(row.count) || 0; });
  return { ...result, riskCounts };
}

function lastSevenDays() {
  const result = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let offset = 6; offset >= 0; offset -= 1) {
    const date = new Date(today); date.setDate(today.getDate() - offset);
    result.push(`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`);
  }
  return result;
}

function localDateKey(value) {
  const text = stringifyField(value).trim();
  if (!text) return "";
  if (!/[zZ]$|[+-]\d\d:\d\d$/.test(text)) return text.slice(0, 10);
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return text.slice(0, 10);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

async function dashboardData(tenantId = "", includeDrafts = false) {
  const clauses = []; const params = [];
  if (tenantId) { clauses.push("tenant_id=?"); params.push(tenantId); }
  if (!includeDrafts) clauses.push("is_published=TRUE");
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = await db.prepare(`SELECT * FROM (${intelligenceUnionSql()}) intelligence ${where} ORDER BY observed_at DESC,id DESC`).all(...params);
  const items = rows.map(parseIntelligenceRow);
  const dates = lastSevenDays();
  const trendData = dates.map((date) => {
    const onDate = items.filter((item) => localDateKey(item.observedAt) === date);
    return { date: date.slice(5), critical: onDate.filter((item) => item.risk === "critical").length, high: onDate.filter((item) => item.risk === "high").length, medium: onDate.filter((item) => item.risk === "medium").length, total: onDate.length };
  });
  return { rows, items, dates, trendData };
}

async function todayNewCounts(since, tenantId = "", includeDrafts = false) {
  const empty = { darkWebIntelligence: 0, credentialLeaks: 0, accountPassword: 0, sourceCode: 0, documents: 0, assets: 0, phishing: 0, vulnerabilities: 0 };
  if (!since) return empty;
  const publication = includeDrafts ? "" : " AND is_published=TRUE";
  const tenant = tenantId ? " AND tenant_id=?" : "";
  const params = (category) => category ? [category, since, ...(tenantId ? [tenantId] : [])] : [since, ...(tenantId ? [tenantId] : [])];
  const credentialPublication = includeDrafts ? "" : " AND credential_records.is_published=TRUE";
  const credentialTenant = tenantId ? " AND credential_subscriptions.tenant_id=?" : "";
  const [darkWeb, credentials, accountPassword, sourceCode, documents, assets, phishing, vulnerabilities] = await Promise.all([
    db.prepare(`SELECT COUNT(*) AS count FROM dark_web_events WHERE first_seen_at>=?${publication}${tenant}`).get(...params()),
    db.prepare(`SELECT COUNT(*) AS count FROM credential_records JOIN credential_subscriptions ON credential_subscriptions.id=credential_records.sub_id WHERE credential_records.first_seen_at>=?${credentialPublication}${credentialTenant}`).get(since, ...(tenantId ? [tenantId] : [])),
    db.prepare(`SELECT COUNT(*) AS count FROM sensitive_records WHERE category=? AND first_seen_at>=?${publication}${tenant}`).get(...params("account-password")),
    db.prepare(`SELECT COUNT(*) AS count FROM sensitive_records WHERE category=? AND first_seen_at>=?${publication}${tenant}`).get(...params("source-code")),
    db.prepare(`SELECT COUNT(*) AS count FROM sensitive_records WHERE category=? AND first_seen_at>=?${publication}${tenant}`).get(...params("documents")),
    db.prepare(`SELECT COUNT(*) AS count FROM asset_records WHERE first_seen_at>=?${publication}${tenant}`).get(...params()),
    db.prepare(`SELECT COUNT(*) AS count FROM sensitive_records WHERE category=? AND first_seen_at>=?${publication}${tenant}`).get(...params("phishing")),
    db.prepare(`SELECT COUNT(*) AS count FROM vulnerability_records WHERE first_seen_at>=?${publication}${tenant}`).get(...params())
  ]);
  return { darkWebIntelligence: Number(darkWeb.count), credentialLeaks: Number(credentials.count), accountPassword: Number(accountPassword.count), sourceCode: Number(sourceCode.count), documents: Number(documents.count), assets: Number(assets.count), phishing: Number(phishing.count), vulnerabilities: Number(vulnerabilities.count) };
}

async function portalDashboard(since = "", tenantId = "", includeDrafts = false) {
  const { rows, items, dates, trendData } = await dashboardData(tenantId, includeDrafts);
  const today = dates.at(-1); const yesterday = dates.at(-2);
  const todayNew = await todayNewCounts(since, tenantId, includeDrafts);
  const todayCount = since ? Object.values(todayNew).reduce((sum, count) => sum + count, 0) : items.filter((item) => localDateKey(item.observedAt) === today).length;
  const yesterdayCount = items.filter((item) => localDateKey(item.observedAt) === yesterday).length;
  const criticalCount = items.filter((item) => item.risk === "critical").length;
  const highCount = items.filter((item) => item.risk === "high").length;
  const riskCounts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  items.forEach((item) => { if (item.risk in riskCounts) riskCounts[item.risk] += 1; });
  const publishedWhere = includeDrafts ? "TRUE" : "is_published=TRUE";
  const tenantAnd = tenantId ? " AND tenant_id=?" : "";
  const tenantParams = tenantId ? [tenantId] : [];
  const assetCount = (await db.prepare(`SELECT COUNT(*) AS count FROM asset_records WHERE ${publishedWhere}${tenantAnd}`).get(...tenantParams)).count;
  const affectedTargets = (await db.prepare(`SELECT COUNT(DISTINCT target_id) AS count FROM asset_records WHERE ${publishedWhere} AND target_id IS NOT NULL${tenantAnd}`).get(...tenantParams)).count;
  const normalSources = (await db.prepare(`SELECT COUNT(*) AS count FROM api_connections WHERE status='正常'${tenantAnd}`).get(...tenantParams)).count;
  const totalSources = (await db.prepare(`SELECT COUNT(*) AS count FROM api_connections WHERE TRUE${tenantAnd}`).get(...tenantParams)).count;
  const groupedSources = new Map();
  for (const item of items) {
    const board = intelligenceBoardName(item.type);
    if (board) groupedSources.set(board, (groupedSources.get(board) || 0) + 1);
  }
  const credentialPublishedWhere = includeDrafts ? "TRUE" : "credential_records.is_published=TRUE";
  const credentialTenantAnd = tenantId ? " AND credential_subscriptions.tenant_id=?" : "";
  const credentialCount = Number((await db.prepare(`SELECT COUNT(*) AS count FROM credential_records JOIN credential_subscriptions ON credential_subscriptions.id=credential_records.sub_id WHERE ${credentialPublishedWhere}${credentialTenantAnd}`).get(...tenantParams)).count);
  if (credentialCount) groupedSources.set("账号凭据", credentialCount);
  const sourceDistribution = [...groupedSources.entries()]
    .sort((left, right) => right[1] - left[1] || String(left[0]).localeCompare(String(right[0]), "zh-CN"))
    .slice(0, 5)
    .map(([name, value]) => ({ name, value }));
  const exposureLabels = { subdomain: "子域名", server: "服务器", web: "Web", fingerprint: "指纹" };
  const exposureCounts = await db.prepare(`SELECT category,COUNT(*) AS count FROM asset_records WHERE ${publishedWhere}${tenantAnd} GROUP BY category`).all(...tenantParams);
  const exposureData = exposureCounts.map((row) => ({ label: exposureLabels[row.category] || row.category, value: row.count }));
  const regionRows = await db.prepare(`SELECT fields_json,risk FROM asset_records WHERE ${publishedWhere}${tenantAnd}`).all(...tenantParams);
  const regionDistribution = aggregateAssetRegions(regionRows);
  const alertRows = await db.prepare(`SELECT a.*,v.cve AS vulnerability_cve,v.title AS vulnerability_title,v.risk AS vulnerability_risk,v.source AS vulnerability_source,v.disclosure_at AS vulnerability_disclosure_at,g.name AS watch_group_name,i.product_name AS watch_product,asset.title AS asset_title,asset.fields_json AS asset_fields_json,target.name AS target_name
    FROM vulnerability_alerts a JOIN vulnerability_records v ON v.id=a.vulnerability_id
    JOIN fingerprint_watch_groups g ON g.id=a.watch_group_id JOIN fingerprint_watch_items i ON i.id=a.watch_item_id
    LEFT JOIN asset_records asset ON asset.id=a.asset_record_id LEFT JOIN monitoring_targets target ON target.id=a.target_id
    WHERE ${includeDrafts ? "TRUE" : "v.is_published=TRUE AND asset.is_published=TRUE"} AND v.risk IN ('critical','high') AND a.asset_record_id IS NOT NULL${tenantId ? " AND v.tenant_id=?" : ""} ORDER BY a.first_matched_at DESC,a.id DESC`).all(...tenantParams);
  const criticalItems = alertRows.map(parseVulnerabilityAlert).map(vulnerabilityAlertAsIntelligence);
  return {
    metrics: [
      { label: "今日新增情报", value: String(todayCount), delta: `昨日 ${yesterdayCount} 条`, tone: "info" },
      { label: "高危风险", value: String(criticalCount + highCount), delta: `严重 ${criticalCount} 条`, tone: "critical" },
      { label: "受影响资产", value: String(assetCount), delta: `覆盖 ${affectedTargets} 个对象`, tone: "medium" },
      { label: "活跃数据源", value: String(normalSources), delta: `共 ${totalSources} 个数据源`, tone: "success" }
    ],
    riskCounts,
    trendData,
    sourceDistribution,
    exposureData,
    regionDistribution,
    criticalTotal: criticalItems.length,
    critical: criticalItems.slice(0, 20),
    latest: items.filter((item) => !["漏洞情报", "暴露面", "仿冒网站"].includes(item.type)).slice(0, 20),
    todayNew
  };
}

async function adminDashboard(tenantId = "") {
  const { items, trendData, dates } = await dashboardData(tenantId);
  const todayCount = items.filter((item) => localDateKey(item.observedAt) === dates.at(-1)).length;
  const tenantWhere = tenantId ? " WHERE tenant_id=?" : ""; const tenantAnd = tenantId ? " AND tenant_id=?" : ""; const tenantParams = tenantId ? [tenantId] : [];
  const totalConnections = (await db.prepare(`SELECT COUNT(*) AS count FROM api_connections${tenantWhere}`).get(...tenantParams)).count;
  const abnormalConnections = (await db.prepare(`SELECT COUNT(*) AS count FROM api_connections WHERE status='异常'${tenantAnd}`).get(...tenantParams)).count;
  const normalConnections = (await db.prepare(`SELECT COUNT(*) AS count FROM api_connections WHERE status='正常'${tenantAnd}`).get(...tenantParams)).count;
  const activeTargets = (await db.prepare(`SELECT COUNT(*) AS count FROM monitoring_targets WHERE enabled=1${tenantAnd}`).get(...tenantParams)).count;
  const latestBatch = await db.prepare(`SELECT created_at FROM ingestion_batches${tenantWhere} ORDER BY created_at DESC LIMIT 1`).get(...tenantParams);
  return {
    metrics: [
      { label: "今日入库", value: String(todayCount), note: latestBatch ? `最近批次 ${stringifyField(latestBatch.created_at).replace("T", " ").slice(0, 16)}` : "暂无录入批次", tone: "cyan" },
      { label: "异常接口", value: String(abnormalConnections), note: `共 ${totalConnections} 个接口`, tone: "red" },
      { label: "监测对象", value: String(activeTargets), note: "当前启用对象", tone: "purple" }
    ],
    trendData,
    health: [
      { name: "核心 API", status: "正常", tone: "success" },
      { name: "PostgreSQL 数据库", status: "正常", tone: "success" },
      { name: "数据源连接", status: `${normalConnections}/${totalConnections} 正常`, tone: abnormalConnections ? "danger" : totalConnections && normalConnections < totalConnections ? "warning" : "success" },
      { name: "证据文件存储", status: existsSync(darkWebBlobsDir) ? "正常" : "异常", tone: existsSync(darkWebBlobsDir) ? "success" : "danger" }
    ]
  };
}

function nextRunAt(intervalMinutes, from = Date.now()) { return new Date(from + Number(intervalMinutes) * 60_000).toISOString(); }
function parseCollectionJob(row) { return { id: row.id, connectionId: row.connection_id, connectionName: row.connection_name, providerType: row.provider_type, name: row.name, enabled: Boolean(row.enabled), intervalMinutes: row.interval_minutes, timeoutSeconds: row.timeout_seconds, retryLimit: row.retry_limit, nextRunAt: row.next_run_at, lastRunAt: row.last_run_at, lastStatus: row.last_status, lastMessage: row.last_status === "失败" ? "任务执行失败，请检查配置后重试" : row.last_message, updatedAt: row.updated_at }; }

function backgroundRunState(row) {
  if (row.status === "running") return "running";
  if (row.status === "succeeded") return "succeeded";
  return row.will_retry ? "retrying" : "failed";
}

function backgroundTaskLabel(identifier, row = {}) {
  return row.collection_job_name || BACKGROUND_TASK_CATALOG.find((task) => task.identifier === identifier || task.taskIdentifier === identifier)?.label || identifier;
}

function parseBackgroundRun(row) {
  if (!row) return row;
  const state = backgroundRunState(row);
  return {
    id: Number(row.id),
    bullmqJobId: row.bullmq_job_id,
    queueRole: row.queue_role,
    taskIdentifier: row.task_identifier,
    taskLabel: backgroundTaskLabel(row.task_identifier, row),
    triggerType: row.trigger_type,
    state,
    attempt: Number(row.attempt),
    attemptCount: Number(row.attempt_count || row.attempt),
    maxAttempts: Number(row.max_attempts || 1),
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    tenantId: row.tenant_id || null,
    collectionJobId: row.collection_job_id,
    connectionName: row.connection_name,
    businessStatus: row.business_status,
    businessMessage: ["failed", "retrying"].includes(state) ? "任务执行失败，请检查配置后重试" : row.business_message,
    noticeMessage: row.resolved_notice_message ? "任务已完成，但部分数据未能处理" : null,
    workerInstanceId: row.worker_instance_id,
    queuedAt: row.queued_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    queueLatencyMs: row.queue_latency_ms === null ? null : Number(row.queue_latency_ms),
    durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
    willRetry: row.will_retry,
    nextRetryAt: row.next_retry_at,
    error: row.error_message ? { message: "任务执行失败，请检查配置后重试" } : null
  };
}

const backgroundRunSelect = `SELECT r.*,cr.job_id AS collection_job_id,cr.status AS business_status,cr.message AS business_message,
  COALESCE(r.notice_message,CASE WHEN r.aggregate_type='snapshot_job' AND snapshot_jobs.status='succeeded' THEN snapshot_jobs.error_message END) AS resolved_notice_message,
  cj.name AS collection_job_name,connections.name AS connection_name
  FROM background_task_runs r
  LEFT JOIN collection_runs cr ON r.aggregate_type='collection_run' AND cr.id=r.aggregate_id
  LEFT JOIN collection_jobs cj ON cj.id=cr.job_id
  LEFT JOIN api_connections connections ON connections.id=cr.connection_id
  LEFT JOIN edge_snapshot_jobs snapshot_jobs ON r.aggregate_type='snapshot_job' AND snapshot_jobs.id=r.aggregate_id`;

const cloudEdgeRepository = createCloudEdgeRepository(db);
const snapshotJobs = await createSnapshotJobQueue({ db, repository: cloudEdgeRepository, outbox: taskOutbox });
async function enqueueVulnerabilitySnapshots(tenantIds, { force = false, triggerType = "vulnerability_change" } = {}) {
  const tenants = new Set((Array.isArray(tenantIds) ? tenantIds : [tenantIds]).filter(Boolean));
  if (!tenants.size) return [];
  const deployments = (await cloudEdgeRepository.listDeployments()).filter((item) => item.enabled && tenants.has(item.tenantId));
  const queued = [];
  for (const deployment of deployments) {
    try {
      const result = await snapshotJobs.enqueue(deployment.id, { force, triggerType });
      queued.push({ deploymentId: deployment.id, jobId: result.job.id, deduplicated: result.deduplicated });
    } catch (error) {
      console.error(`漏洞变更后无法调度地端快照 ${deployment.id}`, error);
    }
  }
  return queued;
}
const collectionJobs = createCollectionJobQueue({ db, outbox: taskOutbox, syncConnection });
const backgroundSchedules = createBackgroundScheduleService({ db, runtime: bullmq });
const cloudEdge = createCloudEdgeModule({
  db,
  repository: cloudEdgeRepository,
  snapshotJobs,
  dataDir,
  legacyDataDir,
  masterSecret: secret,
  encryptSecret: encrypt,
  decryptSecret: decrypt,
  publicBaseUrl,
  tlsCertificate: transportSecurity.serverOptions?.cert || null,
  readJson,
  requirePermission,
  async readFileObject({ tenantId, id }) {
    if (id.startsWith("article-image/")) {
      const name = id.slice("article-image/".length);
      const linked = await db.prepare("SELECT 1 FROM dark_web_events WHERE tenant_id=? AND is_published=TRUE AND article_markdown LIKE ? LIMIT 1").get(tenantId, `%/api/article-images/${name}%`);
      const image = linked ? readArticleImageFromDirectories(articleImageDirectories, name) : null;
      return image ? { content: image.content, name: image.name, mediaType: image.mediaType, sha256: image.sha256 } : null;
    }
    if (id.startsWith("dark-web/")) {
      const sha256 = id.slice("dark-web/".length);
      const row = await db.prepare(`SELECT dark_web_blobs.* FROM dark_web_blobs
        WHERE dark_web_blobs.sha256=? AND EXISTS (
          SELECT 1 FROM dark_web_files JOIN ingestion_batches ON ingestion_batches.id=dark_web_files.batch_id
          WHERE dark_web_files.blob_sha256=dark_web_blobs.sha256 AND ingestion_batches.tenant_id=?
        )`).get(sha256, tenantId);
      return row ? { content: darkWebBlob(row), name: row.stored_name.replace(/\.enc$/u, ""), mediaType: row.media_type, sha256: row.sha256 } : null;
    }
    const match = id.match(/^asset-report\/([^/]+)\/(content|structured-data)$/u);
    if (!match) {
      const batchMatch = id.match(/^ingestion-batch\/([^/]+)\/source$/u);
      if (!batchMatch) return null;
      const batch = await db.prepare("SELECT * FROM ingestion_batches WHERE id=? AND tenant_id=? AND status='已发布'").get(batchMatch[1], tenantId);
      if (!batch?.source_file_path) return null;
      const content = readFileSync(batch.source_file_path);
      return { content, name: basename(batch.file_name), mediaType: "application/octet-stream", sha256: createHash("sha256").update(content).digest("hex") };
    }
    const row = await db.prepare("SELECT * FROM asset_reports WHERE id=? AND tenant_id=? AND is_published=TRUE").get(match[1], tenantId);
    if (!row) return null;
    const path = match[2] === "content" ? row.file_path : row.data_path;
    if (!path) return null;
    const content = readFileSync(path);
    return {
      content,
      name: match[2] === "content" ? basename(row.file_name) : `${row.id}.json`,
      mediaType: match[2] === "content" ? "text/html; charset=utf-8" : "application/json",
      sha256: createHash("sha256").update(content).digest("hex")
    };
  }
});

async function workerHealth() {
  const rows = await db.prepare(`SELECT DISTINCT ON (role) role,instance_id,node_id,process_id,started_at,last_heartbeat_at,status,applied_state
    FROM worker_instances ORDER BY role,last_heartbeat_at DESC`).all();
  const staleBefore = Date.now() - 15_000;
  return rows.map((row) => ({
    role: row.role,
    instanceId: row.instance_id,
    nodeId: row.node_id,
    processId: Number(row.process_id),
    startedAt: row.started_at,
    lastHeartbeatAt: row.last_heartbeat_at,
    appliedState: row.applied_state,
    healthy: row.status === "running" && new Date(row.last_heartbeat_at).getTime() >= staleBefore
  }));
}

async function listWorkerNodes() {
  const rows = await db.prepare(`SELECT nodes.*,
    instances.instance_id,instances.role,instances.process_id,instances.host_name,instances.concurrency,
    instances.applied_state,instances.active_jobs,instances.started_at,instances.last_heartbeat_at,instances.stopped_at,
    instances.status AS instance_status
    FROM worker_nodes nodes
    LEFT JOIN worker_instances instances ON instances.node_id=nodes.node_id
    ORDER BY nodes.registered_at DESC,instances.role,instances.started_at DESC`).all();
  const staleBefore = Date.now() - 15_000;
  const nodes = new Map();
  for (const row of rows) {
    let node = nodes.get(row.node_id);
    if (!node) {
      node = {
        nodeId: row.node_id,
        displayName: row.display_name,
        description: row.description,
        desiredState: row.desired_state,
        registeredAt: row.registered_at,
        lastSeenAt: row.last_seen_at,
        updatedAt: row.updated_at,
        instances: []
      };
      nodes.set(row.node_id, node);
    }
    if (!row.instance_id) continue;
    node.instances.push({
      instanceId: row.instance_id,
      role: row.role,
      processId: Number(row.process_id),
      hostName: row.host_name || "",
      concurrency: Number(row.concurrency || 1),
      appliedState: row.applied_state,
      activeJobs: Number(row.active_jobs || 0),
      startedAt: row.started_at,
      lastHeartbeatAt: row.last_heartbeat_at,
      healthy: row.instance_status === "running" && new Date(row.last_heartbeat_at).getTime() >= staleBefore
    });
  }
  return [...nodes.values()].map((node) => {
    const healthyInstances = node.instances.filter((instance) => instance.healthy);
    const activeJobs = healthyInstances.reduce((total, instance) => total + instance.activeJobs, 0);
    const applied = healthyInstances.map((instance) => instance.appliedState);
    let runtimeState = "offline";
    if (healthyInstances.length > 0) {
      if (node.desiredState === "active") runtimeState = applied.every((state) => state === "active") ? "active" : "draining";
      else if (node.desiredState === "draining") runtimeState = applied.every((state) => state === "draining") && activeJobs === 0 ? "drained" : "draining";
      else runtimeState = applied.every((state) => state === "disabled") ? "disabled" : "draining";
    }
    return {
      ...node,
      runtimeState,
      healthy: healthyInstances.length > 0,
      activeJobs,
      roles: [...new Set(healthyInstances.map((instance) => instance.role))]
    };
  });
}

const corsOrigins = new Set([
  "http://127.0.0.1:5173", "http://127.0.0.1:5174", "http://127.0.0.1:5175", "http://127.0.0.1:5176",
  "http://localhost:5173", "http://localhost:5174", "http://localhost:5175", "http://localhost:5176",
  ...(process.env.SENTINEL_CORS_ORIGINS || "").split(",").map((value) => value.trim()).filter(Boolean)
]);

const requestHandler = async (req, res) => {
  const origin = req.headers.origin;
  if (corsOrigins.has(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Sentinel-Tenant-Id"); res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  if (transportSecurity.enabled) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  const url = new URL(req.url, `${transportSecurity.protocol}://${req.headers.host}`);
  const providedRequestId = String(req.headers["x-request-id"] || "");
  const auditRequestId = /^[A-Za-z0-9._:-]{1,128}$/.test(providedRequestId) ? providedRequestId : `REQ-${randomBytes(8).toString("hex")}`;
  res.setHeader("X-Request-Id", auditRequestId);
  res.once("finish", () => { void writeAuditLog(req, res, url, auditRequestId).catch((error) => console.error("写入审计日志失败", error)); });
  try {
    if (req.method === "GET" && url.pathname === "/openapi.json") {
      if (!apiDocsEnabled) return json(res, 404, { message: "接口不存在" });
      res.setHeader("Cache-Control", "no-store");
      return json(res, 200, cloudOpenApiDocument);
    }
    if (req.method === "GET" && url.pathname === "/docs") {
      if (!apiDocsEnabled) return json(res, 404, { message: "接口不存在" });
      const body = cloudSwaggerHtml();
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": Buffer.byteLength(body),
        "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'self'; img-src 'self' data: https://validator.swagger.io; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; connect-src 'self'",
        "X-Content-Type-Options": "nosniff"
      });
      res.end(body);
      return;
    }
    if (req.method === "GET" && url.pathname === "/health") {
      try { await db.prepare("SELECT 1 AS ok").get(); return json(res, 200, { ok: true, service: "sentinel-api-server" }); }
      catch { return json(res, 503, { ok: false, service: "sentinel-api-server" }); }
    }
    if (req.method === "POST" && url.pathname === "/api/integrations/watchvuln/sync") {
      const connection = await watchVulnConnectionForToken(req);
      if (!connection) return json(res, 401, { message: "WatchVuln 推送令牌无效或连接器未启用" });
      const body = await readJson(req);
      const queued = await collectionJobs.requestConnectionSync(connection.id);
      if (!queued) return json(res, 409, { message: "WatchVuln 连接器没有可用采集任务" });
      return json(res, 202, {
        ok: true,
        message: "运营平台已接收定向推送并排队同步",
        connectionId: connection.id,
        tag: String(body.tag || "").slice(0, 120),
        selectedCount: Math.max(0, Number(body.selectedCount || 0)),
        runId: queued.run?.id || null,
        deduplicated: Boolean(queued.deduplicated)
      });
    }
    const articleImageMatch = url.pathname.match(/^\/api\/article-images\/([^/]+)$/u);
    if (req.method === "GET" && articleImageMatch) {
      const image = readArticleImageFromDirectories(articleImageDirectories, decodeURIComponent(articleImageMatch[1]));
      return image ? articleImage(res, image) : json(res, 404, { message: "文章图片不存在" });
    }
    if (await cloudEdge.handle(req, res, url)) return;
    if (req.method === "GET" && url.pathname === "/api/audit-logs") {
      const context = String(url.searchParams.get("context") || "operations");
      if (!["operations", "management", "all"].includes(context)) return json(res, 400, { message: "审计域不合法" });
      if (!await requirePermission(req, res, context === "operations" ? "operations:manage" : "accounts:manage")) return;
      const page = Math.max(1, Math.floor(Number(url.searchParams.get("page") || 1)));
      const pageSize = Math.min(100, Math.max(1, Math.floor(Number(url.searchParams.get("page_size") || 50))));
      const query = String(url.searchParams.get("query") || "").trim().slice(0, 200);
      const resultFilter = String(url.searchParams.get("result") || "");
      const tenantFilter = managedText(url.searchParams.get("tenant_id"), "客户租户", { max: 100 });
      if (resultFilter && !["success", "failed"].includes(resultFilter)) return json(res, 400, { message: "审计结果不合法" });
      if (tenantFilter && !await db.prepare("SELECT id FROM tenants WHERE id=?").get(tenantFilter)) return json(res, 404, { message: "客户租户不存在" });
      const scopeClauses = []; const scopeParams = [];
      if (context !== "all") { scopeClauses.push("context=?"); scopeParams.push(context); }
      if (tenantFilter) { scopeClauses.push("tenant_id=?"); scopeParams.push(tenantFilter); }
      const clauses = [...scopeClauses]; const params = [...scopeParams];
      if (query) { clauses.push("(action ILIKE ? OR actor_account ILIKE ? OR actor_name ILIKE ? OR resource_type ILIKE ? OR resource_id ILIKE ? OR path ILIKE ?)"); params.push(...Array(6).fill(`%${query}%`)); }
      if (resultFilter) { clauses.push("result=?"); params.push(resultFilter); }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      const scopeWhere = scopeClauses.length ? `WHERE ${scopeClauses.join(" AND ")}` : "";
      const total = Number((await db.prepare(`SELECT COUNT(*) AS count FROM audit_logs ${where}`).get(...params)).count);
      const rows = await db.prepare(`SELECT * FROM audit_logs ${where} ORDER BY occurred_at DESC,id DESC LIMIT ? OFFSET ?`).all(...params, pageSize, (page - 1) * pageSize);
      const resultCounts = await db.prepare(`SELECT result,COUNT(*) AS count FROM audit_logs ${scopeWhere} GROUP BY result`).all(...scopeParams);
      return json(res, 200, { page, pageSize, total, resultCounts: Object.fromEntries(resultCounts.map((row) => [row.result, Number(row.count)])), data: rows.map(parseAuditLog) });
    }
    if (url.pathname === "/api/tenant-publication-policies") {
      if (!await requirePermission(req, res, "ingestion:manage")) return;
      const tenantId = await requireTenantContext(req, res, url.searchParams.get("tenant_id")); if (!tenantId) return;
      if (req.method === "GET") {
        const stored = await db.prepare("SELECT module,mode,updated_at FROM tenant_publication_policies WHERE tenant_id=?").all(tenantId);
        const byModule = new Map(stored.map((row) => [row.module, row]));
        return json(res, 200, Object.entries(publicationPolicyDefaults).map(([module, defaultMode]) => ({
          tenantId, module, mode: byModule.get(module)?.mode || defaultMode, updatedAt: byModule.get(module)?.updated_at || null
        })));
      }
      if (req.method === "PUT") {
        const body = await readJson(req);
        const values = Array.isArray(body.policies) ? body.policies : [];
        if (!values.length) return json(res, 400, { message: "请提交至少一个板块发布策略" });
        const now = new Date().toISOString();
        await db.transaction(async () => {
          for (const item of values) {
            const module = managedText(item?.module, "板块", { required: true, max: 40 });
            const mode = managedText(item?.mode, "发布模式", { required: true, max: 20 });
            if (!(module in publicationPolicyDefaults) || !["auto", "approval"].includes(mode)) throw Object.assign(new Error("发布策略配置不合法"), { statusCode: 400 });
            await db.prepare(`INSERT INTO tenant_publication_policies (tenant_id,module,mode,updated_at) VALUES (?,?,?,?)
              ON CONFLICT(tenant_id,module) DO UPDATE SET mode=excluded.mode,updated_at=excluded.updated_at`).run(tenantId, module, mode, now);
          }
        });
        const stored = await db.prepare("SELECT module,mode,updated_at FROM tenant_publication_policies WHERE tenant_id=? ORDER BY module").all(tenantId);
        return json(res, 200, stored.map((row) => ({ tenantId, module: row.module, mode: row.mode, updatedAt: row.updated_at })));
      }
      return json(res, 405, { message: "请求方法不支持" });
    }
    if (req.method === "GET" && url.pathname === "/api/tenant-portal-preview") {
      if (!await requirePermission(req, res, "ingestion:manage")) return;
      const tenantId = await requireTenantContext(req, res, url.searchParams.get("tenant_id")); if (!tenantId) return;
      const tenant = await db.prepare("SELECT id,name,status FROM tenants WHERE id=?").get(tenantId);
      if (!tenant) return json(res, 404, { message: "租户不存在" });
      const targets = await db.prepare("SELECT * FROM monitoring_targets WHERE tenant_id=? ORDER BY name").all(tenantId);
      const [sensitive, assets, darkWeb, vulnerabilities, credentials] = await Promise.all([
        db.prepare("SELECT * FROM sensitive_records WHERE tenant_id=? ORDER BY last_seen_at DESC LIMIT 200").all(tenantId),
        db.prepare("SELECT * FROM asset_records WHERE tenant_id=? ORDER BY last_seen_at DESC LIMIT 200").all(tenantId),
        db.prepare("SELECT * FROM dark_web_events WHERE tenant_id=? ORDER BY published_at DESC,last_seen_at DESC LIMIT 200").all(tenantId),
        db.prepare("SELECT * FROM vulnerability_records WHERE tenant_id=? ORDER BY last_seen_at DESC LIMIT 200").all(tenantId),
        db.prepare(`SELECT credential_records.*,credential_subscriptions.sub_category FROM credential_records
          JOIN credential_subscriptions ON credential_subscriptions.id=credential_records.sub_id
          WHERE credential_subscriptions.tenant_id=? ORDER BY credential_records.first_seen_at DESC LIMIT 200`).all(tenantId)
      ]);
      const countRows = await db.prepare(`SELECT 'sensitive' AS module,COUNT(*) AS total,COUNT(*) FILTER (WHERE is_published=FALSE) AS drafts FROM sensitive_records WHERE tenant_id=?
        UNION ALL SELECT 'asset',COUNT(*),COUNT(*) FILTER (WHERE is_published=FALSE) FROM asset_records WHERE tenant_id=?
        UNION ALL SELECT 'dark-web',COUNT(*),COUNT(*) FILTER (WHERE is_published=FALSE) FROM dark_web_events WHERE tenant_id=?
        UNION ALL SELECT 'vulnerabilities',COUNT(*),COUNT(*) FILTER (WHERE is_published=FALSE) FROM vulnerability_records WHERE tenant_id=?
        UNION ALL SELECT 'credentials',COUNT(*),COUNT(*) FILTER (WHERE credential_records.is_published=FALSE) FROM credential_records JOIN credential_subscriptions ON credential_subscriptions.id=credential_records.sub_id WHERE credential_subscriptions.tenant_id=?`)
        .all(tenantId, tenantId, tenantId, tenantId, tenantId);
      return json(res, 200, {
        tenant: { id: tenant.id, name: tenant.name, status: tenant.status }, generatedAt: new Date().toISOString(),
        counts: Object.fromEntries(countRows.map((row) => [row.module, { total: Number(row.total), drafts: Number(row.drafts) }])),
        targets: targets.map(parseTarget),
        sensitive: sensitive.map((row) => parseManagedRelationalRecord(row, "sensitive")),
        assets: assets.map((row) => parseManagedRelationalRecord(row, "asset")),
        darkWeb: darkWeb.map(parseManagedDarkWebRecord), vulnerabilities: vulnerabilities.map(parseVulnerabilityRecord),
        credentials: credentials.map((row, index) => ({ id: row.id, sequence: index + 1, subId: row.sub_id, subCategory: row.sub_category, url: row.url, systemName: row.system_name, account: row.account, password: row.password, leakedAt: row.leaked_at, firstSeenAt: row.first_seen_at, source: row.source, isPublished: Boolean(row.is_published), reviewedAt: row.reviewed_at || undefined }))
      });
    }
    if (req.method === "POST" && url.pathname === "/api/ingestion/article-images") {
      if (!await requirePermission(req, res, "ingestion:manage")) return;
      if (!await requireTenantContext(req, res)) return;
      const multipart = parseMultipart(await readBody(req, ARTICLE_IMAGE_UPLOAD_MAX_BYTES + 1024 * 1024), req.headers["content-type"]);
      if (!multipart.file) return json(res, 400, { message: "请选择文章图片" });
      const optimized = await optimizeArticleImage(multipart.file.data, multipart.file.contentType);
      const stored = storeArticleImage(articleImagesDir, optimized.content, optimized.mediaType);
      return json(res, 201, { location: stored.location, name: stored.name, mediaType: stored.mediaType, sizeBytes: stored.sizeBytes, originalSizeBytes: optimized.originalSizeBytes });
    }
    if (req.method === "POST" && url.pathname === "/api/ingestion/sensitive-xlsx") {
      if (!await requirePermission(req, res, "ingestion:manage")) return;
      const multipart = parseMultipart(await readBody(req), req.headers["content-type"]);
      if (!multipart.file || !/\.(xlsx|xls)$/i.test(multipart.file.filename || "")) return json(res, 400, { message: "请上传 .xlsx 或 .xls 文件" });
      const targetId = managedText(multipart.fields.targetId, "监测对象", { required: true, max: 100 });
      const tenantId = await requireTenantContext(req, res); if (!tenantId) return;
      await tenantIdForTarget(targetId, tenantId);
      const result = await importSensitiveWorkbook(multipart.file.data, multipart.file.filename, targetId);
      if (!result.sheets.length) return json(res, 400, { message: "未找到可识别的敏感信息工作表（账号口令、源码泄露、文档泄露、仿冒网站）" });
      return json(res, 201, result);
    }
    if (req.method === "POST" && url.pathname === "/api/ingestion/assets-xlsx") {
      if (!await requirePermission(req, res, "ingestion:manage")) return;
      const multipart = parseMultipart(await readBody(req), req.headers["content-type"]);
      if (!multipart.file || !/\.(xlsx|xls)$/i.test(multipart.file.filename || "")) return json(res, 400, { message: "请上传 .xlsx 或 .xls 文件" });
      const targetId = managedText(multipart.fields.targetId, "监测对象", { required: true, max: 100 });
      const tenantId = await requireTenantContext(req, res); if (!tenantId) return;
      await tenantIdForTarget(targetId, tenantId);
      const result = await importAssetWorkbook(multipart.file.data, multipart.file.filename, targetId);
      if (!result.sheets.length) return json(res, 400, { message: "未找到可识别的资产工作表（子域名资产、服务器资产、Web资产）" });
      return json(res, 201, result);
    }
    if (req.method === "POST" && url.pathname === "/api/ingestion/assets-html") {
      if (!await requirePermission(req, res, "ingestion:manage")) return;
      const multipart = parseMultipart(await readBody(req), req.headers["content-type"]);
      if (!multipart.file || !/\.(html?|HTML?)$/i.test(multipart.file.filename || "")) return json(res, 400, { message: "请上传 .html 或 .htm 文件" });
      const targetId = managedText(multipart.fields.targetId, "监测对象", { required: true, max: 100 });
      const tenantId = await requireTenantContext(req, res); if (!tenantId) return;
      await tenantIdForTarget(targetId, tenantId);
      const result = await importAssetHtml(multipart.file.data, multipart.file.filename, targetId);
      return json(res, 201, result);
    }
    if (req.method === "POST" && ["/api/ingestion/dark-web", "/api/ingestion/dark-web-zip"].includes(url.pathname)) {
      if (!await requirePermission(req, res, "ingestion:manage")) return;
      const multipart = parseMultipart(await readBody(req), req.headers["content-type"]);
      if (!multipart.file || !/\.(zip|docx)$/i.test(multipart.file.filename || "")) return json(res, 400, { message: "请上传 .zip 暗网交付包或 .docx Word 报告" });
      const targetId = managedText(multipart.fields.targetId, "监测对象", { required: true, max: 100 });
      const tenantId = await requireTenantContext(req, res); if (!tenantId) return;
      await tenantIdForTarget(targetId, tenantId);
      const result = await importDarkWebPackage(multipart.file.data, multipart.file.filename, targetId);
      return json(res, 201, result);
    }
    if (req.method === "GET" && url.pathname === "/api/ingestion/batches") {
      if (!await requirePermission(req, res, "ingestion:manage")) return;
      const type = String(url.searchParams.get("type") || "");
      if (type && !["sensitive", "asset", "dark-web"].includes(type)) return json(res, 400, { message: "录入类型不合法" });
      const tenantId = await requireTenantContext(req, res, url.searchParams.get("tenant_id")); if (!tenantId) return;
      const conditions = []; const params = [];
      if (type) { conditions.push("ingestion_type=?"); params.push(type); }
      conditions.push("tenant_id=?"); params.push(tenantId);
      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
      const rows = await db.prepare(`SELECT * FROM ingestion_batches ${where} ORDER BY created_at DESC LIMIT 50`).all(...params);
      return json(res, 200, rows.map((row) => {
        const sheets = JSON.parse(row.sheet_summary_json || "[]");
        return {
          id: row.id, type: row.ingestion_type, fileName: row.file_name, targetId: row.target_id, status: row.status,
          totalRows: row.total_rows, newRows: row.new_rows, duplicateRows: row.duplicate_rows, changedRows: row.changed_rows || 0,
          aliveChangedRows: sheets.reduce((sum, sheet) => sum + Number(sheet.aliveChangedRows || 0), 0),
          statusCodeChangedRows: sheets.reduce((sum, sheet) => sum + Number(sheet.statusCodeChangedRows || 0), 0),
          missingRows: row.missing_rows || 0, unchangedRows: row.unchanged_rows || 0, sheets, createdAt: row.created_at
        };
      }));
    }
    if (req.method === "GET" && url.pathname === "/api/ingestion/records") {
      if (!await requirePermission(req, res, "ingestion:manage")) return;
      const type = assertManagedType(url.searchParams.get("type"));
      const pageValue = Number(url.searchParams.get("page") || 1);
      const pageSizeValue = Number(url.searchParams.get("page_size") || 50);
      const page = Number.isFinite(pageValue) ? Math.max(1, Math.floor(pageValue)) : 1;
      const pageSize = Number.isFinite(pageSizeValue) ? Math.min(100, Math.max(1, Math.floor(pageSizeValue))) : 50;
      const query = managedText(url.searchParams.get("query"), "搜索词", { max: 200 });
      const targetId = managedText(url.searchParams.get("target_id"), "监测对象", { max: 100 });
      const tenantId = await requireTenantContext(req, res, url.searchParams.get("tenant_id")); if (!tenantId) return;
      const category = managedText(url.searchParams.get("category"), "分类", { max: 40 });
      const publication = managedText(url.searchParams.get("publication"), "发布状态", { max: 20 });
      const conditions = []; const params = [];
      if (targetId) { conditions.push("target_id=?"); params.push(targetId); }
      conditions.push("tenant_id=?"); params.push(tenantId);
      if (publication) {
        if (!['draft', 'published'].includes(publication)) return json(res, 400, { message: "发布状态不合法" });
        conditions.push("is_published=?"); params.push(publication === "published");
      }
      if (category) {
        if (type === "dark-web") return json(res, 400, { message: "暗网情报不支持分类筛选" });
        const allowed = type === "sensitive" ? Object.values(sensitiveSheetCategories) : Object.values(assetCategories);
        if (!allowed.includes(category)) return json(res, 400, { message: "记录分类不合法" });
        conditions.push("category=?"); params.push(category);
      }
      if (query) {
        if (type === "dark-web") conditions.push("(title ILIKE ? OR source_group_name ILIKE ? OR message_url ILIKE ? OR intel_tags ILIKE ? OR intel_note ILIKE ?)");
        else conditions.push("(title ILIKE ? OR fields_json ILIKE ?)");
        const pattern = `%${query}%`;
        params.push(...Array(type === "dark-web" ? 5 : 2).fill(pattern));
      }
      const table = type === "sensitive" ? "sensitive_records" : type === "asset" ? "asset_records" : "dark_web_events";
      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
      const total = (await db.prepare(`SELECT COUNT(*) AS count FROM ${table} ${where}`).get(...params)).count;
      const order = type === "dark-web" ? "published_at DESC,last_seen_at DESC,id DESC" : "last_seen_at DESC,id DESC";
      const rows = await db.prepare(`SELECT * FROM ${table} ${where} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...params, pageSize, (page - 1) * pageSize);
      return json(res, 200, { page, pageSize, total, data: rows.map((row) => type === "dark-web" ? parseManagedDarkWebRecord(row) : parseManagedRelationalRecord(row, type)) });
    }
    if (req.method === "POST" && url.pathname === "/api/ingestion/records") {
      if (!await requirePermission(req, res, "ingestion:manage")) return;
      const body = await readJson(req, articleJsonBodyLimit); const type = assertManagedType(body.type); const values = managedRecordValues(type, body);
      const tenantId = await requireTenantContext(req, res, body.tenantId); if (!tenantId) return;
      await tenantIdForTarget(values.targetId, tenantId); const now = new Date().toISOString();
      const id = `${type === "sensitive" ? "SENSITIVE" : type === "asset" ? "ASSET" : "DW"}-MANUAL-${randomBytes(8).toString("hex").toUpperCase()}`;
      const stableHash = createHash("sha256").update(`${tenantId}|manual|${id}`).digest("hex");
      if (type === "sensitive" || type === "asset") {
        const table = type === "sensitive" ? "sensitive_records" : "asset_records";
        await db.prepare(`INSERT INTO ${table} (id,category,target_id,title,risk,fields_json,record_hash,first_seen_at,last_seen_at,import_status,import_count,batch_id,tenant_id,is_published,reviewed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,FALSE,?)`)
          .run(id, values.category, values.targetId, values.title, values.risk, JSON.stringify(values.fields), stableHash, now, now, "新增", 1, null, tenantId, now);
        const row = await db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id);
        return json(res, 201, parseManagedRelationalRecord(row, type));
      }
      const batchId = `BATCH-MANUAL-${randomBytes(8).toString("hex").toUpperCase()}`;
      await db.transaction(async () => {
        const summary = [{ sheet: "手工录入", category: "dark-web", label: "暗网情报", total: 1, newRows: 1, duplicateRows: 0, skippedRows: 0 }];
        await db.prepare("INSERT INTO ingestion_batches (id,file_name,target_id,status,total_rows,new_rows,duplicate_rows,sheet_summary_json,created_at,ingestion_type,tenant_id,source_file_path) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
          .run(batchId, `手工录入 · ${values.title}`, values.targetId, "手工录入", 1, 1, 0, JSON.stringify(summary), now, type, tenantId, null);
        await db.prepare(`INSERT INTO dark_web_events (id,target_id,latest_batch_id,title,risk,report_date,source_group_name,source_group_id,source_group_url,message_url,intel_tags,leak_data_types,leak_count,transaction_count,transaction_price,published_at,publisher_id,intel_note,article_markdown,is_published,reviewed_at,event_hash,first_seen_at,last_seen_at,import_count,tenant_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(id, values.targetId, batchId, values.title, values.risk, values.reportDate, values.sourceGroupName, values.sourceGroupId, values.sourceGroupUrl, values.messageUrl, values.intelTags.join("、"), values.leakDataTypes, values.leakCount, values.transactionCount, values.transactionPrice, values.publishedAt, values.publisherId, values.intelNote, values.articleMarkdown, false, now, stableHash, now, now, 1, tenantId);
      });
      return json(res, 201, parseManagedDarkWebRecord(await db.prepare("SELECT * FROM dark_web_events WHERE id=?").get(id)));
    }
    if (req.method === "POST" && url.pathname === "/api/ingestion/records/bulk-action") {
      if (!await requirePermission(req, res, "ingestion:manage")) return;
      const body = await readJson(req); const type = assertManagedType(body.type);
      const tenantId = await requireTenantContext(req, res, body.tenantId); if (!tenantId) return;
      if (String(body.action || "") !== "publish") return json(res, 400, { message: "批量操作类型不合法" });
      const table = type === "sensitive" ? "sensitive_records" : type === "asset" ? "asset_records" : "dark_web_events";
      const batchColumn = type === "dark-web" ? "latest_batch_id" : "batch_id";
      const allMatching = body.allMatching === true; const conditions = ["tenant_id=?"]; const params = [tenantId];
      if (allMatching) {
        const query = managedText(body.query, "搜索词", { max: 200 });
        const targetId = managedText(body.targetId, "监测对象", { max: 100 });
        const category = managedText(body.category, "分类", { max: 40 });
        const publication = managedText(body.publication, "发布状态", { max: 20 });
        if (targetId) { conditions.push("target_id=?"); params.push(targetId); }
        if (publication) {
          if (!["draft", "published"].includes(publication)) return json(res, 400, { message: "发布状态不合法" });
          conditions.push("is_published=?"); params.push(publication === "published");
        }
        if (category) {
          if (type === "dark-web") return json(res, 400, { message: "暗网情报不支持分类筛选" });
          const allowed = type === "sensitive" ? Object.values(sensitiveSheetCategories) : Object.values(assetCategories);
          if (!allowed.includes(category)) return json(res, 400, { message: "记录分类不合法" });
          conditions.push("category=?"); params.push(category);
        }
        if (query) {
          conditions.push(type === "dark-web" ? "(title ILIKE ? OR source_group_name ILIKE ? OR message_url ILIKE ? OR intel_tags ILIKE ? OR intel_note ILIKE ?)" : "(title ILIKE ? OR fields_json ILIKE ?)");
          params.push(...Array(type === "dark-web" ? 5 : 2).fill(`%${query}%`));
        }
      } else {
        const ids = [...new Set((Array.isArray(body.ids) ? body.ids : []).map((id) => managedText(id, "记录 ID", { required: true, max: 160 })))];
        if (!ids.length) return json(res, 400, { message: "请选择需要发布的数据" });
        if (ids.length > 1000) return json(res, 400, { message: "单次最多发布 1000 条已勾选数据" });
        conditions.push(`id IN (${ids.map(() => "?").join(",")})`); params.push(...ids);
      }
      const where = conditions.length ? conditions.join(" AND ") : "TRUE";
      const rows = await db.prepare(`SELECT id,tenant_id,${batchColumn} AS batch_id,is_published FROM ${table} WHERE ${where}`).all(...params);
      if (rows.length > 20_000) return json(res, 400, { message: "单次最多发布 20000 条筛选结果，请缩小筛选范围" });
      const now = new Date().toISOString(); const unpublished = rows.filter((row) => !row.is_published).length;
      if (rows.length) {
        if (type === "asset") await publishAssetRecords(where, params, now);
        else await db.prepare(`UPDATE ${table} SET is_published=TRUE,reviewed_at=COALESCE(reviewed_at,?),last_seen_at=? WHERE ${where}`).run(now, now, ...params);
      }
      const batchIds = [...new Set(rows.map((row) => row.batch_id).filter(Boolean))];
      for (const batchId of batchIds) {
        const remaining = await remainingManagedBatchRecords(table, batchColumn, batchId, type);
        if (!remaining) {
          await db.prepare("UPDATE ingestion_batches SET status='已发布' WHERE id=?").run(batchId);
          if (type === "asset") await db.prepare("UPDATE asset_reports SET is_published=TRUE WHERE batch_id=?").run(batchId);
        }
      }
      const tenantIds = [...new Set(rows.map((row) => row.tenant_id).filter(Boolean))];
      if (type === "asset") for (const currentTenantId of tenantIds) await vulnerabilityAlerts.recompute({ tenantId: currentTenantId });
      return json(res, 200, { ok: true, action: "publish", matched: rows.length, published: unpublished, tenants: tenantIds.length });
    }
    if (req.method === "POST" && url.pathname === "/api/ingestion/records/publish-all") {
      if (!await requirePermission(req, res, "ingestion:manage")) return;
      const body = await readJson(req); const type = assertManagedType(body.type);
      const tenantId = await requireTenantContext(req, res, body.tenantId); if (!tenantId) return;
      const table = type === "sensitive" ? "sensitive_records" : type === "asset" ? "asset_records" : "dark_web_events";
      const batchColumn = type === "dark-web" ? "latest_batch_id" : "batch_id";
      const where = "is_published=FALSE AND tenant_id=?"; const params = [tenantId];
      const rows = await db.prepare(`SELECT id,tenant_id,${batchColumn} AS batch_id FROM ${table} WHERE ${where}`).all(...params);
      const now = new Date().toISOString();
      if (rows.length) {
        if (type === "asset") await publishAssetRecords(where, params, now);
        else await db.prepare(`UPDATE ${table} SET is_published=TRUE,reviewed_at=COALESCE(reviewed_at,?),last_seen_at=? WHERE ${where}`).run(now, now, ...params);
      }
      const batchIds = [...new Set(rows.map((row) => row.batch_id).filter(Boolean))];
      for (const batchId of batchIds) {
        const remaining = await remainingManagedBatchRecords(table, batchColumn, batchId, type);
        if (!remaining) {
          await db.prepare("UPDATE ingestion_batches SET status='已发布' WHERE id=?").run(batchId);
          if (type === "asset") await db.prepare("UPDATE asset_reports SET is_published=TRUE WHERE batch_id=?").run(batchId);
        }
      }
      const tenantIds = [...new Set(rows.map((row) => row.tenant_id).filter(Boolean))];
      if (type === "asset") for (const currentTenantId of tenantIds) await vulnerabilityAlerts.recompute({ tenantId: currentTenantId });
      const publishedTotal = Number((await db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE is_published=TRUE AND tenant_id=?`).get(tenantId)).count);
      return json(res, 200, { ok: true, published: rows.length, publishedTotal, tenants: tenantIds.length });
    }
    const managedDarkWebFilesMatch = url.pathname.match(/^\/api\/ingestion\/records\/dark-web\/([^/]+)\/files$/);
    if (managedDarkWebFilesMatch && req.method === "GET") {
      if (!await requirePermission(req, res, "ingestion:manage")) return;
      const tenantId = await requireTenantContext(req, res); if (!tenantId) return;
      const eventId = decodeURIComponent(managedDarkWebFilesMatch[1]);
      const event = await db.prepare("SELECT id,latest_batch_id FROM dark_web_events WHERE id=? AND tenant_id=?").get(eventId, tenantId);
      if (!event) return json(res, 404, { message: "暗网情报不存在" });
      const rows = await db.prepare(`SELECT dark_web_files.*,dark_web_blobs.size_bytes,dark_web_blobs.media_type
        FROM dark_web_files JOIN dark_web_blobs ON dark_web_blobs.sha256=dark_web_files.blob_sha256
        WHERE dark_web_files.event_id=? AND dark_web_files.batch_id=? AND dark_web_files.kind IN ('report','attachment')
        ORDER BY CASE dark_web_files.kind WHEN 'report' THEN 0 ELSE 1 END,dark_web_files.created_at,dark_web_files.original_name`).all(eventId, event.latest_batch_id);
      return json(res, 200, rows.map(parseDarkWebFile));
    }
    if (managedDarkWebFilesMatch && req.method === "POST") {
      if (!await requirePermission(req, res, "ingestion:manage")) return;
      const tenantId = await requireTenantContext(req, res); if (!tenantId) return;
      const eventId = decodeURIComponent(managedDarkWebFilesMatch[1]);
      const event = await db.prepare("SELECT id,latest_batch_id FROM dark_web_events WHERE id=? AND tenant_id=?").get(eventId, tenantId);
      if (!event) return json(res, 404, { message: "暗网情报不存在" });
      if (!event.latest_batch_id) return json(res, 409, { message: "该情报缺少有效导入批次，暂时不能维护证据文件" });
      const multipart = parseMultipart(await readBody(req, DARK_WEB_ATTACHMENT_MAX_BYTES + 1024 * 1024), req.headers["content-type"]);
      const attachment = await normalizeDarkWebAttachment(multipart.file);
      const duplicate = await db.prepare("SELECT id FROM dark_web_files WHERE event_id=? AND batch_id=? AND blob_sha256=? AND kind='attachment'").get(eventId, event.latest_batch_id, attachment.sha256);
      if (duplicate) return json(res, 409, { message: "该证据文件已经上传，无需重复添加" });
      const now = new Date().toISOString();
      let createdBlobPath = "";
      try {
        await db.transaction(async () => {
          let blob = await db.prepare("SELECT * FROM dark_web_blobs WHERE sha256=?").get(attachment.sha256);
          if (!blob) {
            const stored = storePlainDarkWebBlob(darkWebBlobsDir, attachment);
            if (stored.created) createdBlobPath = stored.storedPath;
            await db.prepare("INSERT INTO dark_web_blobs (sha256,stored_name,size_bytes,media_type,iv_b64,auth_tag_b64,created_at) VALUES (?,?,?,?,?,?,?)")
              .run(attachment.sha256, stored.storedName, attachment.buffer.length, attachment.mediaType, "", "", now);
          }
          const fileId = `DWF-${randomBytes(8).toString("hex")}`;
          await db.prepare("INSERT INTO dark_web_files (id,batch_id,event_id,blob_sha256,kind,original_name,sheet_count,row_count,column_count,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
            .run(fileId, event.latest_batch_id, eventId, attachment.sha256, "attachment", attachment.name, attachment.sheetCount, attachment.rowCount, attachment.columnCount, now);
          await db.prepare("UPDATE dark_web_events SET reviewed_at=?,last_seen_at=?,is_published=FALSE WHERE id=?").run(now, now, eventId);
        });
      } catch (error) {
        if (createdBlobPath) { try { unlinkSync(createdBlobPath); } catch {} }
        throw error;
      }
      const uploaded = await db.prepare(`SELECT dark_web_files.*,dark_web_blobs.size_bytes,dark_web_blobs.media_type
        FROM dark_web_files JOIN dark_web_blobs ON dark_web_blobs.sha256=dark_web_files.blob_sha256
        WHERE dark_web_files.event_id=? AND dark_web_files.batch_id=? AND dark_web_files.blob_sha256=? AND dark_web_files.kind='attachment'`).get(eventId, event.latest_batch_id, attachment.sha256);
      return json(res, 201, parseDarkWebFile(uploaded));
    }
    const managedDarkWebFileMatch = url.pathname.match(/^\/api\/ingestion\/records\/dark-web\/([^/]+)\/files\/([^/]+)$/);
    if (managedDarkWebFileMatch && req.method === "DELETE") {
      if (!await requirePermission(req, res, "ingestion:manage")) return;
      const tenantId = await requireTenantContext(req, res); if (!tenantId) return;
      const eventId = decodeURIComponent(managedDarkWebFileMatch[1]); const fileId = decodeURIComponent(managedDarkWebFileMatch[2]);
      const event = await db.prepare("SELECT id,latest_batch_id FROM dark_web_events WHERE id=? AND tenant_id=?").get(eventId, tenantId);
      if (!event) return json(res, 404, { message: "暗网情报不存在" });
      const file = await db.prepare(`SELECT dark_web_files.*,dark_web_blobs.stored_name
        FROM dark_web_files JOIN dark_web_blobs ON dark_web_blobs.sha256=dark_web_files.blob_sha256
        WHERE dark_web_files.id=? AND dark_web_files.event_id=? AND dark_web_files.batch_id=? AND dark_web_files.kind='attachment'`).get(fileId, eventId, event.latest_batch_id);
      if (!file) return json(res, 404, { message: "证据文件不存在或来源报告不可删除" });
      const now = new Date().toISOString(); let orphanedBlob = null;
      await db.transaction(async () => {
        await db.prepare("DELETE FROM dark_web_files WHERE id=?").run(fileId);
        orphanedBlob = await db.prepare("DELETE FROM dark_web_blobs WHERE sha256=? AND NOT EXISTS (SELECT 1 FROM dark_web_files WHERE blob_sha256=?) RETURNING stored_name").get(file.blob_sha256, file.blob_sha256);
        await db.prepare("UPDATE dark_web_events SET reviewed_at=?,last_seen_at=?,is_published=FALSE WHERE id=?").run(now, now, eventId);
      });
      if (orphanedBlob?.stored_name) removeStoredDarkWebBlob(orphanedBlob.stored_name);
      return json(res, 200, { ok: true, id: fileId });
    }
    const managedRecordMatch = url.pathname.match(/^\/api\/ingestion\/records\/(sensitive|asset|dark-web)\/([^/]+)$/);
    if (managedRecordMatch && req.method === "GET") {
      if (!await requirePermission(req, res, "ingestion:manage")) return;
      const tenantId = await requireTenantContext(req, res); if (!tenantId) return;
      const type = assertManagedType(managedRecordMatch[1]); const id = decodeURIComponent(managedRecordMatch[2]);
      const table = type === "sensitive" ? "sensitive_records" : type === "asset" ? "asset_records" : "dark_web_events";
      const row = await db.prepare(`SELECT * FROM ${table} WHERE id=? AND tenant_id=?`).get(id, tenantId);
      if (!row) return json(res, 404, { message: "录入记录不存在" });
      return json(res, 200, type === "dark-web" ? parseManagedDarkWebRecord(row) : parseManagedRelationalRecord(row, type));
    }
    if (managedRecordMatch && req.method === "PUT") {
      if (!await requirePermission(req, res, "ingestion:manage")) return;
      const tenantContext = await requireTenantContext(req, res); if (!tenantContext) return;
      const type = assertManagedType(managedRecordMatch[1]); const id = decodeURIComponent(managedRecordMatch[2]);
      const table = type === "sensitive" ? "sensitive_records" : type === "asset" ? "asset_records" : "dark_web_events";
      const current = await db.prepare(`SELECT * FROM ${table} WHERE id=? AND tenant_id=?`).get(id, tenantContext);
      if (!current) return json(res, 404, { message: "录入记录不存在" });
      const values = managedRecordValues(type, await readJson(req, type === "dark-web" ? articleJsonBodyLimit : defaultJsonBodyLimit)); const tenantId = await tenantIdForTarget(values.targetId, tenantContext); const now = new Date().toISOString();
      if (type === "sensitive" || type === "asset") {
        if (type === "asset") {
          const currentFields = parseJson(current.fields_json, {});
          const changedFields = assetChangedFields(currentFields, values.fields);
          const primaryStateChanged = changedFields.length > 0;
          const previouslyPublished = Boolean(current.is_published || current.previously_published);
          await db.prepare(`UPDATE asset_records SET category=?,target_id=?,title=?,risk=?,fields_json=?,last_seen_at=?,tenant_id=?,reviewed_at=?,is_published=FALSE,
            import_status=?,change_type=?,previous_fields_json=?,previously_published=?,last_changed_at=? WHERE id=?`)
            .run(
              values.category, values.targetId, values.title, values.risk, JSON.stringify(values.fields), now, tenantId, now,
              primaryStateChanged ? "状态变化" : current.import_status,
              primaryStateChanged ? "changed" : current.change_type,
              primaryStateChanged ? current.fields_json : current.previous_fields_json,
              previouslyPublished,
              primaryStateChanged ? now : current.last_changed_at,
              id
            );
        } else {
          await db.prepare(`UPDATE sensitive_records SET category=?,target_id=?,title=?,risk=?,fields_json=?,last_seen_at=?,tenant_id=?,reviewed_at=?,is_published=FALSE WHERE id=?`)
            .run(values.category, values.targetId, values.title, values.risk, JSON.stringify(values.fields), now, tenantId, now, id);
        }
        return json(res, 200, parseManagedRelationalRecord(await db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id), type));
      }
      await db.transaction(async () => {
        await db.prepare(`UPDATE dark_web_events SET target_id=?,title=?,risk=?,report_date=?,source_group_name=?,source_group_id=?,source_group_url=?,message_url=?,intel_tags=?,leak_data_types=?,leak_count=?,transaction_count=?,transaction_price=?,published_at=?,publisher_id=?,intel_note=?,article_markdown=?,reviewed_at=?,last_seen_at=?,tenant_id=?,is_published=FALSE WHERE id=?`)
          .run(values.targetId, values.title, values.risk, values.reportDate, values.sourceGroupName, values.sourceGroupId, values.sourceGroupUrl, values.messageUrl, values.intelTags.join("、"), values.leakDataTypes, values.leakCount, values.transactionCount, values.transactionPrice, values.publishedAt, values.publisherId, values.intelNote, values.articleMarkdown, now, now, tenantId, id);
        if (current.latest_batch_id) await db.prepare("UPDATE ingestion_batches SET file_name=?,target_id=?,tenant_id=? WHERE id=? AND status='手工录入'").run(`手工录入 · ${values.title}`, values.targetId, tenantId, current.latest_batch_id);
      });
      return json(res, 200, parseManagedDarkWebRecord(await db.prepare("SELECT * FROM dark_web_events WHERE id=?").get(id)));
    }
    const managedPublishMatch = url.pathname.match(/^\/api\/ingestion\/records\/(sensitive|asset|dark-web)\/([^/]+)\/publish$/);
    if (managedPublishMatch && req.method === "POST") {
      if (!await requirePermission(req, res, "ingestion:manage")) return;
      const tenantId = await requireTenantContext(req, res); if (!tenantId) return;
      const type = assertManagedType(managedPublishMatch[1]); const id = decodeURIComponent(managedPublishMatch[2]);
      const table = type === "sensitive" ? "sensitive_records" : type === "asset" ? "asset_records" : "dark_web_events";
      const batchColumn = type === "dark-web" ? "latest_batch_id" : "batch_id";
      const row = await db.prepare(`SELECT * FROM ${table} WHERE id=? AND tenant_id=?`).get(id, tenantId);
      if (!row) return json(res, 404, { message: "数据记录不存在" });
      if (!row.reviewed_at) return json(res, 400, { message: "请先保存审核后的内容，再执行发布" });
      const now = new Date().toISOString(); const batchId = row[batchColumn];
      await db.transaction(async () => {
        if (type === "dark-web") await db.prepare("UPDATE dark_web_events SET is_published=TRUE,last_seen_at=? WHERE id=?").run(now, id);
        else if (type === "asset") await publishAssetRecords("id=?", [id], now);
        else await db.prepare(`UPDATE ${table} SET is_published=TRUE,last_seen_at=? WHERE id=?`).run(now, id);
        if (batchId) {
          const remaining = await remainingManagedBatchRecords(table, batchColumn, batchId, type);
          if (!remaining) {
            await db.prepare("UPDATE ingestion_batches SET status='已发布' WHERE id=?").run(batchId);
            if (type === "asset") await db.prepare("UPDATE asset_reports SET is_published=TRUE WHERE batch_id=?").run(batchId);
          }
        }
      });
      if (type === "asset") await vulnerabilityAlerts.recompute({ tenantId: row.tenant_id });
      const published = await db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id);
      return json(res, 200, type === "dark-web" ? parseManagedDarkWebRecord(published) : parseManagedRelationalRecord(published, type));
    }
    if (managedRecordMatch && req.method === "DELETE") {
      if (!await requirePermission(req, res, "ingestion:manage")) return;
      const tenantId = await requireTenantContext(req, res); if (!tenantId) return;
      const type = assertManagedType(managedRecordMatch[1]); const id = decodeURIComponent(managedRecordMatch[2]);
      const table = type === "sensitive" ? "sensitive_records" : type === "asset" ? "asset_records" : "dark_web_events";
      const current = await db.prepare(`SELECT * FROM ${table} WHERE id=? AND tenant_id=?`).get(id, tenantId);
      if (!current) return json(res, 404, { message: "录入记录不存在" });
      await db.transaction(async () => {
        if (type === "dark-web") await db.prepare("UPDATE dark_web_files SET event_id=NULL WHERE event_id=?").run(id);
        await db.prepare(`DELETE FROM ${table} WHERE id=?`).run(id);
        if (type === "dark-web" && current.latest_batch_id) await db.prepare("DELETE FROM ingestion_batches WHERE id=? AND status='手工录入' AND NOT EXISTS (SELECT 1 FROM dark_web_files WHERE batch_id=?)").run(current.latest_batch_id, current.latest_batch_id);
      });
      return json(res, 200, { ok: true, id, type });
    }
    if (req.method === "POST" && url.pathname === "/api/fingerprint-icons/catalog/sync") {
      const actor = await requirePermission(req, res, "ingestion:manage"); if (!actor) return;
      const simple = await syncSimpleIconCatalog(db, { actor: actor.account });
      const domestic = await syncDomesticFingerprintIconCatalog(db, { actor: actor.account });
      const provider = await syncProviderIconCatalog(db, { actor: actor.account });
      return json(res, 200, {
        catalogSize: simple.catalogSize + domestic.catalogSize + provider.catalogSize,
        inserted: simple.inserted + domestic.inserted + provider.inserted,
        updated: simple.updated + domestic.updated + provider.updated,
        preserved: simple.preserved + domestic.preserved + provider.preserved,
        unchanged: simple.unchanged + domestic.unchanged + provider.unchanged,
        failed: domestic.failed
      });
    }
    if (req.method === "GET" && url.pathname === "/api/fingerprint-icons") {
      if (!await requirePermission(req, res, "ingestion:manage")) return;
      const page = Math.max(1, Math.floor(Number(url.searchParams.get("page") || 1)));
      const pageSize = Math.min(100, Math.max(1, Math.floor(Number(url.searchParams.get("page_size") || 30))));
      const query = String(url.searchParams.get("query") || "").trim().slice(0, 160);
      const where = query ? "WHERE fingerprint_name ILIKE ? OR aliases_json::text ILIKE ?" : "";
      const params = query ? [`%${query}%`, `%${query}%`] : [];
      const total = Number((await db.prepare(`SELECT COUNT(*) AS count FROM fingerprint_icon_library ${where}`).get(...params)).count);
      const [rows, summary] = await Promise.all([
        db.prepare(`SELECT * FROM fingerprint_icon_library ${where} ORDER BY updated_at DESC,fingerprint_name ASC LIMIT ? OFFSET ?`).all(...params, pageSize, (page - 1) * pageSize),
        db.prepare("SELECT COUNT(*) AS total,COUNT(*) FILTER (WHERE active=TRUE) AS active_count,COUNT(*) FILTER (WHERE source IN ('simple-icons','iconify','domestic','provider')) AS builtin_count,COUNT(*) FILTER (WHERE source NOT IN ('simple-icons','iconify','domestic','provider')) AS managed_count FROM fingerprint_icon_library").get()
      ]);
      return json(res, 200, { page, pageSize, total, summary: { total: Number(summary.total), active: Number(summary.active_count), builtin: Number(summary.builtin_count), managed: Number(summary.managed_count) }, data: rows.map(parseFingerprintIcon) });
    }
    if (req.method === "GET" && url.pathname === "/api/fingerprint-icons/map") {
      if (!await requireSession(req, res)) return;
      const rows = await db.prepare("SELECT * FROM fingerprint_icon_library WHERE active=TRUE ORDER BY fingerprint_name ASC").all();
      const entries = rows.map((row) => ({ fingerprintName: row.fingerprint_name, aliases: Array.isArray(row.aliases_json) ? row.aliases_json : parseJson(row.aliases_json, []), iconUrl: `/api/fingerprint-icons/${encodeURIComponent(row.id)}/icon` }));
      return json(res, 200, { entries });
    }
    const fingerprintIconMatch = url.pathname.match(/^\/api\/fingerprint-icons\/([^/]+)$/);
    const fingerprintIconContentMatch = url.pathname.match(/^\/api\/fingerprint-icons\/([^/]+)\/icon$/);
    if (fingerprintIconContentMatch && req.method === "GET") {
      const row = await db.prepare("SELECT * FROM fingerprint_icon_library WHERE id=?").get(decodeURIComponent(fingerprintIconContentMatch[1]));
      if (!row) return json(res, 404, { message: "指纹图标不存在" });
      const base64 = String(row.icon_data || "").split(",", 2)[1] || "";
      const buffer = Buffer.from(base64, "base64");
      const svg = isSvgIconContent(buffer, row.media_type);
      if (svg) {
        try { assertSafeSvgIcon(buffer, { statusCode: 422 }); }
        catch { return json(res, 422, { message: "指纹图标包含不安全的 SVG 内容" }); }
      }
      res.writeHead(200, { "Content-Type": svg ? "image/svg+xml" : row.media_type, "Content-Length": buffer.length, "Cache-Control": "public, max-age=86400", "X-Content-Type-Options": "nosniff", "ETag": `\"${row.icon_sha256}\"`, ...(svg ? svgIconResponseHeaders() : {}) });
      return res.end(buffer);
    }
    if (req.method === "POST" && url.pathname === "/api/fingerprint-icons") {
      const actor = await requirePermission(req, res, "ingestion:manage"); if (!actor) return;
      const body = await readJson(req, 512 * 1024); const values = await fingerprintIconValues(body, null, actor); const id = `FICON-${randomBytes(6).toString("hex").toUpperCase()}`; const now = new Date().toISOString();
      await db.prepare("INSERT INTO fingerprint_icon_library (id,fingerprint_name,aliases_json,source,source_url,media_type,icon_data,icon_sha256,active,created_by,updated_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").run(id, values.fingerprintName, JSON.stringify(values.aliases), values.source, values.sourceUrl || null, values.mediaType, values.iconData, values.iconSha256, body.active === false ? 0 : 1, actor.account, actor.account, now, now);
      return json(res, 201, parseFingerprintIcon(await db.prepare("SELECT * FROM fingerprint_icon_library WHERE id=?").get(id)));
    }
    if (fingerprintIconMatch && req.method === "PUT") {
      const actor = await requirePermission(req, res, "ingestion:manage"); if (!actor) return;
      const id = decodeURIComponent(fingerprintIconMatch[1]); const current = await db.prepare("SELECT * FROM fingerprint_icon_library WHERE id=?").get(id); if (!current) return json(res, 404, { message: "指纹图标不存在" });
      const body = await readJson(req, 512 * 1024); const values = await fingerprintIconValues(body, current, actor); const now = new Date().toISOString();
      await db.prepare("UPDATE fingerprint_icon_library SET fingerprint_name=?,aliases_json=?,source=?,source_url=?,media_type=?,icon_data=?,icon_sha256=?,active=?,updated_by=?,updated_at=? WHERE id=?").run(values.fingerprintName, JSON.stringify(values.aliases), values.source, values.sourceUrl || null, values.mediaType, values.iconData, values.iconSha256, body.active === undefined ? current.active : body.active ? 1 : 0, actor.account, now, id);
      return json(res, 200, parseFingerprintIcon(await db.prepare("SELECT * FROM fingerprint_icon_library WHERE id=?").get(id)));
    }
    if (fingerprintIconMatch && req.method === "DELETE") {
      const actor = await requirePermission(req, res, "ingestion:manage"); if (!actor) return;
      const id = decodeURIComponent(fingerprintIconMatch[1]); const current = await db.prepare("SELECT id FROM fingerprint_icon_library WHERE id=?").get(id); if (!current) return json(res, 404, { message: "指纹图标不存在" });
      await db.prepare("DELETE FROM fingerprint_icon_library WHERE id=?").run(id); return json(res, 200, { ok: true, id, actor: actor.account });
    }
    if (req.method === "POST" && url.pathname === "/api/vulnerabilities") {
      if (!await requirePermission(req, res, "ingestion:manage")) return;
      const body = await readJson(req, articleJsonBodyLimit);
      const targetId = managedText(body.targetId, "监测对象", { required: true, max: 128 });
      const tenantId = await requireTenantContext(req, res, body.tenantId); if (!tenantId) return;
      await tenantIdForTarget(targetId, tenantId);
      const values = managedVulnerabilityValues(body);
      const publish = body.publish === true;
      const now = new Date().toISOString();
      const id = `VULN-MANUAL-${randomBytes(12).toString("hex").toUpperCase()}`;
      const sourceKey = `manual:${id}`;
      await db.prepare(`INSERT INTO vulnerability_records (id,tenant_id,target_id,source_connection_id,source_key,cve,title,summary,risk,source,disclosure_at,solutions,references_json,tags_json,raw_json,source_created_at,source_updated_at,first_seen_at,last_seen_at,import_count,status,manually_managed,is_published,reviewed_at) VALUES (?,?,?,NULL,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,TRUE,?,?)`)
        .run(id, tenantId, targetId, sourceKey, values.cve, values.title, values.summary, values.risk, values.source, values.disclosureAt, values.solutions, JSON.stringify(values.references), JSON.stringify(values.tags), JSON.stringify({ managed: true }), now, now, now, now, 1, values.status, publish, now);
      if (publish) await vulnerabilityAlerts.recompute({ tenantId });
      await enqueueVulnerabilitySnapshots(tenantId);
      const row = await db.prepare("SELECT vulnerability_records.*,monitoring_targets.name AS target_name FROM vulnerability_records LEFT JOIN monitoring_targets ON monitoring_targets.id=vulnerability_records.target_id WHERE vulnerability_records.id=?").get(id);
      return json(res, 201, parseVulnerabilityRecord(row));
    }
    if (req.method === "POST" && url.pathname === "/api/vulnerabilities/import") {
      if (!await requirePermission(req, res, "ingestion:manage")) return;
      const multipart = parseMultipart(await readBody(req, 20 * 1024 * 1024), req.headers["content-type"]);
      if (!multipart.file || !/\.(xlsx|xls|csv)$/i.test(multipart.file.filename || "")) return json(res, 400, { message: "请上传 .xlsx、.xls 或 .csv 漏洞清单" });
      const targetId = managedText(multipart.fields.targetId, "监测对象", { required: true, max: 128 });
      const tenantId = await requireTenantContext(req, res); if (!tenantId) return;
      await tenantIdForTarget(targetId, tenantId);
      return json(res, 201, await importVulnerabilityWorkbook(multipart.file.data, multipart.file.filename, targetId));
    }
    if (req.method === "POST" && url.pathname === "/api/vulnerabilities/bulk-action") {
      if (!await requirePermission(req, res, "ingestion:manage")) return;
      const body = await readJson(req);
      const tenantId = await requireTenantContext(req, res, body.tenantId); if (!tenantId) return;
      const action = String(body.action || "");
      if (!["publish", "delete"].includes(action)) return json(res, 400, { message: "批量操作类型不合法" });
      const allMatching = body.allMatching === true;
      const clauses = ["tenant_id=?"]; const params = [tenantId];
      if (allMatching) {
        const query = managedText(body.query, "搜索条件", { max: 200 });
        const risk = managedText(body.risk, "风险等级", { max: 32 });
        const source = managedText(body.source, "漏洞来源", { max: 200 });
        const publication = managedText(body.publication, "发布状态", { max: 32 });
        if (risk && !["critical", "high", "medium", "low", "info"].includes(risk)) return json(res, 400, { message: "风险等级不合法" });
        if (publication && !["draft", "published"].includes(publication)) return json(res, 400, { message: "发布状态不合法" });
        if (publication) { clauses.push("is_published=?"); params.push(publication === "published"); }
        if (query) { clauses.push("(title ILIKE ? OR cve ILIKE ? OR summary ILIKE ? OR tags_json ILIKE ?)"); params.push(...Array(4).fill(`%${query}%`)); }
        if (risk) { clauses.push("risk=?"); params.push(risk); }
        if (source) { clauses.push("source=?"); params.push(source); }
      } else {
        const ids = [...new Set((Array.isArray(body.ids) ? body.ids : []).map((id) => managedText(id, "漏洞 ID", { required: true, max: 128 })))];
        if (!ids.length) return json(res, 400, { message: "请选择需要批量操作的漏洞" });
        if (ids.length > 1000) return json(res, 400, { message: "单次最多操作 1000 条已勾选漏洞" });
        clauses.push(`id IN (${ids.map(() => "?").join(",")})`); params.push(...ids);
      }
      const where = clauses.join(" AND ");
      const rows = await db.prepare(`SELECT id,tenant_id,source_connection_id,source_key,is_published FROM vulnerability_records WHERE ${where}`).all(...params);
      if (rows.length > 20_000) return json(res, 400, { message: "单次最多操作 20000 条筛选结果，请缩小筛选范围" });
      const tenantIds = [...new Set(rows.map((row) => row.tenant_id).filter(Boolean))];
      if (action === "delete") {
        await db.transaction(async () => {
          for (const row of rows) await suppressVulnerability(row);
          if (rows.length) await db.prepare(`DELETE FROM vulnerability_records WHERE ${where}`).run(...params);
        });
        const snapshots = await enqueueVulnerabilitySnapshots(tenantIds);
        return json(res, 200, { ok: true, action, matched: rows.length, deleted: rows.length, tenants: tenantIds.length, snapshots });
      }
      const unpublished = rows.filter((row) => !row.is_published).length;
      if (rows.length) {
        const now = new Date().toISOString();
        await db.prepare(`UPDATE vulnerability_records SET is_published=TRUE,reviewed_at=COALESCE(reviewed_at,?),last_seen_at=? WHERE ${where}`).run(now, now, ...params);
      }
      for (const currentTenantId of tenantIds) await vulnerabilityAlerts.recompute({ tenantId: currentTenantId });
      const snapshots = await enqueueVulnerabilitySnapshots(tenantIds);
      return json(res, 200, { ok: true, action, matched: rows.length, published: unpublished, tenants: tenantIds.length, snapshots });
    }
    if (req.method === "POST" && url.pathname === "/api/vulnerabilities/bulk-delete") {
      if (!await requirePermission(req, res, "ingestion:manage")) return;
      const body = await readJson(req);
      const tenantId = await requireTenantContext(req, res, body.tenantId); if (!tenantId) return;
      const ids = [...new Set((Array.isArray(body.ids) ? body.ids : []).map((id) => managedText(id, "漏洞 ID", { required: true, max: 128 })))];
      if (!ids.length) return json(res, 400, { message: "请选择需要删除的漏洞" });
      if (ids.length > 1000) return json(res, 400, { message: "单次最多删除 1000 条漏洞" });
      const placeholders = ids.map(() => "?").join(",");
      const rows = await db.prepare(`SELECT id,tenant_id,source_connection_id,source_key FROM vulnerability_records WHERE tenant_id=? AND id IN (${placeholders})`).all(tenantId, ...ids);
      await db.transaction(async () => {
        for (const row of rows) await suppressVulnerability(row);
        if (rows.length) await db.prepare(`DELETE FROM vulnerability_records WHERE id IN (${rows.map(() => "?").join(",")})`).run(...rows.map((row) => row.id));
      });
      const snapshots = await enqueueVulnerabilitySnapshots([...new Set(rows.map((row) => row.tenant_id))]);
      return json(res, 200, { ok: true, deleted: rows.length, ids: rows.map((row) => row.id), snapshots });
    }
    if (req.method === "POST" && url.pathname === "/api/vulnerabilities/publish-all") {
      if (!await requirePermission(req, res, "ingestion:manage")) return;
      const body = await readJson(req);
      const tenantId = await requireTenantContext(req, res, body.tenantId); if (!tenantId) return;
      const scopeWhere = "tenant_id=?";
      const scopeParams = [tenantId];
      const where = `is_published=FALSE AND ${scopeWhere}`;
      const rows = await db.prepare(`SELECT id,tenant_id FROM vulnerability_records WHERE ${where}`).all(...scopeParams);
      const now = new Date().toISOString();
      const result = rows.length
        ? await db.prepare(`UPDATE vulnerability_records SET is_published=TRUE,reviewed_at=COALESCE(reviewed_at,?),last_seen_at=? WHERE ${where}`).run(now, now, ...scopeParams)
        : { changes: 0 };
      const tenantRows = [{ tenant_id: tenantId }];
      const tenantIds = [...new Set(tenantRows.map((row) => row.tenant_id).filter(Boolean))];
      const alerts = [];
      for (const currentTenantId of tenantIds) alerts.push({ tenantId: currentTenantId, ...await vulnerabilityAlerts.recompute({ tenantId: currentTenantId }) });
      const snapshots = await enqueueVulnerabilitySnapshots(tenantIds, { force: true, triggerType: "vulnerability_publish_all" });
      const publishedTotal = Number((await db.prepare(`SELECT COUNT(*) AS count FROM vulnerability_records WHERE is_published=TRUE AND ${scopeWhere}`).get(...scopeParams)).count);
      return json(res, 200, { ok: true, published: Number(result.changes || 0), publishedTotal, tenants: tenantIds.length, alerts, snapshots });
    }
    if (req.method === "GET" && url.pathname === "/api/vulnerabilities") {
      const user = await requireAnyPermission(req, res, ["portal:read", "ingestion:manage"]); if (!user) return;
      const page = Math.max(1, Math.floor(Number(url.searchParams.get("page") || 1)));
      const pageSize = Math.min(100, Math.max(1, Math.floor(Number(url.searchParams.get("page_size") || 20))));
      const query = String(url.searchParams.get("query") || "").trim().slice(0, 200);
      const risk = String(url.searchParams.get("risk") || "");
      const source = String(url.searchParams.get("source") || "").trim().slice(0, 200);
      const tenantId = await requireTenantContext(req, res, url.searchParams.get("tenant_id")); if (!tenantId) return;
      const publication = String(url.searchParams.get("publication") || "");
      const sinceInput = String(url.searchParams.get("since") || "").trim();
      const since = sinceInput && Number.isFinite(Date.parse(sinceInput)) ? new Date(sinceInput).toISOString() : "";
      if (risk && !["critical", "high", "medium", "low", "info"].includes(risk)) return json(res, 400, { message: "风险等级不合法" });
      if (publication && !["draft", "published"].includes(publication)) return json(res, 400, { message: "发布状态不合法" });
      if (sinceInput && !since) return json(res, 400, { message: "今日新增起始时间不合法" });
      const clauses = []; const params = [];
      const canManageDrafts = permissionsFor(user).includes("ingestion:manage");
      const facetClauses = []; const facetParams = [];
      if (!canManageDrafts) { clauses.push("vulnerability_records.is_published=TRUE"); facetClauses.push("is_published=TRUE"); }
      clauses.push("vulnerability_records.tenant_id=?"); params.push(tenantId); facetClauses.push("tenant_id=?"); facetParams.push(tenantId);
      if (canManageDrafts && publication) { const published = publication === "published"; clauses.push("vulnerability_records.is_published=?"); params.push(published); facetClauses.push("is_published=?"); facetParams.push(published); }
      if (query) { clauses.push("(vulnerability_records.title ILIKE ? OR vulnerability_records.cve ILIKE ? OR vulnerability_records.summary ILIKE ? OR vulnerability_records.tags_json ILIKE ?)"); params.push(...Array(4).fill(`%${query}%`)); }
      if (risk) { clauses.push("vulnerability_records.risk=?"); params.push(risk); }
      if (source) { clauses.push("vulnerability_records.source=?"); params.push(source); }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      const facetWhere = facetClauses.length ? `WHERE ${facetClauses.join(" AND ")}` : "";
      const total = Number((await db.prepare(`SELECT COUNT(*) AS count FROM vulnerability_records ${where}`).get(...params)).count);
      const todayWhere = since ? `${where || "WHERE"} ${where ? "AND" : ""} vulnerability_records.first_seen_at>=?` : "";
      const todayParams = since ? [...params, since] : [];
      const todayFacetWhere = since ? `${facetWhere || "WHERE"} ${facetWhere ? "AND" : ""} first_seen_at>=?` : "";
      const todayFacetParams = since ? [...facetParams, since] : [];
      const [rows, riskRows, sourceRows, todayRow, todayRiskRows] = await Promise.all([
        db.prepare(`SELECT vulnerability_records.*,monitoring_targets.name AS target_name FROM vulnerability_records LEFT JOIN monitoring_targets ON monitoring_targets.id=vulnerability_records.target_id ${where} ORDER BY vulnerability_records.first_seen_at DESC,source_updated_at DESC,id DESC LIMIT ? OFFSET ?`).all(...params, pageSize, (page - 1) * pageSize),
        db.prepare(`SELECT risk,COUNT(*) AS count FROM vulnerability_records ${facetWhere} GROUP BY risk`).all(...facetParams),
        db.prepare(`SELECT source,COUNT(*) AS count FROM vulnerability_records ${facetWhere} GROUP BY source ORDER BY count DESC,source LIMIT 50`).all(...facetParams),
        since ? db.prepare(`SELECT COUNT(*) AS count FROM vulnerability_records ${todayWhere}`).get(...todayParams) : Promise.resolve({ count: 0 }),
        since ? db.prepare(`SELECT risk,COUNT(*) AS count FROM vulnerability_records ${todayFacetWhere} GROUP BY risk`).all(...todayFacetParams) : Promise.resolve([])
      ]);
      return json(res, 200, {
        page, pageSize, total, todayNewCount: Number(todayRow.count),
        riskCounts: Object.fromEntries(riskRows.map((row) => [row.risk, Number(row.count)])),
        todayRiskCounts: Object.fromEntries(todayRiskRows.map((row) => [row.risk, Number(row.count)])),
        sources: sourceRows.map((row) => ({ name: row.source, count: Number(row.count) })), data: rows.map(parseVulnerabilityRecord)
      });
    }
    if (req.method === "GET" && url.pathname === "/api/vulnerabilities/major-event") {
      const user = await requireAnyPermission(req, res, ["portal:read", "ingestion:manage"]); if (!user) return;
      const page = Math.max(1, Math.floor(Number(url.searchParams.get("page") || 1)));
      const pageSize = Math.min(100, Math.max(1, Math.floor(Number(url.searchParams.get("page_size") || 20))));
      const query = String(url.searchParams.get("query") || "").trim().slice(0, 200);
      const risk = String(url.searchParams.get("risk") || "");
      const assetMatch = String(url.searchParams.get("asset_match") || "");
      const tenantId = await requireTenantContext(req, res, url.searchParams.get("tenant_id")); if (!tenantId) return;
      if (risk && !["critical", "high", "medium", "low", "info"].includes(risk)) return json(res, 400, { message: "风险等级不合法" });
      if (assetMatch && !["matched", "unmatched"].includes(assetMatch)) return json(res, 400, { message: "资产匹配状态不合法" });

      const baseClauses = ["vulnerability_records.tags_json ILIKE ?"];
      const baseParams = ["%重保%"];
      if (!permissionsFor(user).includes("ingestion:manage")) baseClauses.push("vulnerability_records.is_published=TRUE");
      baseClauses.push("vulnerability_records.tenant_id=?"); baseParams.push(tenantId);
      if (query) {
        baseClauses.push("(vulnerability_records.title ILIKE ? OR vulnerability_records.cve ILIKE ? OR vulnerability_records.summary ILIKE ? OR vulnerability_records.tags_json ILIKE ?)");
        baseParams.push(...Array(4).fill(`%${query}%`));
      }
      if (risk) { baseClauses.push("vulnerability_records.risk=?"); baseParams.push(risk); }
      const hasAssetMatch = "EXISTS (SELECT 1 FROM vulnerability_alerts matched_alert WHERE matched_alert.vulnerability_id=vulnerability_records.id AND matched_alert.asset_record_id IS NOT NULL)";
      const activeClauses = [...baseClauses];
      if (assetMatch === "matched") activeClauses.push(hasAssetMatch);
      if (assetMatch === "unmatched") activeClauses.push(`NOT ${hasAssetMatch}`);
      const baseWhere = `WHERE ${baseClauses.join(" AND ")}`;
      const activeWhere = `WHERE ${activeClauses.join(" AND ")}`;

      const [totalRow, matchedRow, unmatchedRow, matchedAssetRow, riskRows, rows] = await Promise.all([
        db.prepare(`SELECT COUNT(*) AS count FROM vulnerability_records ${activeWhere}`).get(...baseParams),
        db.prepare(`SELECT COUNT(*) AS count FROM vulnerability_records ${baseWhere} AND ${hasAssetMatch}`).get(...baseParams),
        db.prepare(`SELECT COUNT(*) AS count FROM vulnerability_records ${baseWhere} AND NOT ${hasAssetMatch}`).get(...baseParams),
        db.prepare(`SELECT COUNT(DISTINCT major_alert.asset_record_id) AS count FROM vulnerability_alerts major_alert JOIN vulnerability_records ON vulnerability_records.id=major_alert.vulnerability_id ${activeWhere} AND major_alert.asset_record_id IS NOT NULL`).get(...baseParams),
        db.prepare(`SELECT vulnerability_records.risk,COUNT(*) AS count FROM vulnerability_records ${activeWhere} GROUP BY vulnerability_records.risk`).all(...baseParams),
        db.prepare(`SELECT vulnerability_records.*,monitoring_targets.name AS target_name FROM vulnerability_records LEFT JOIN monitoring_targets ON monitoring_targets.id=vulnerability_records.target_id ${activeWhere} ORDER BY vulnerability_records.first_seen_at DESC,source_updated_at DESC,id DESC LIMIT ? OFFSET ?`).all(...baseParams, pageSize, (page - 1) * pageSize)
      ]);
      const vulnerabilityIds = rows.map((row) => row.id);
      const matches = vulnerabilityIds.length ? await db.prepare(`SELECT a.vulnerability_id,a.asset_record_id,a.matched_product,a.asset_version,a.confidence,asset.title AS asset_title,asset.fields_json AS asset_fields_json,target.name AS target_name FROM vulnerability_alerts a LEFT JOIN asset_records asset ON asset.id=a.asset_record_id LEFT JOIN monitoring_targets target ON target.id=a.target_id WHERE a.asset_record_id IS NOT NULL AND a.vulnerability_id IN (${vulnerabilityIds.map(() => "?").join(",")}) ORDER BY a.last_matched_at DESC,a.id DESC`).all(...vulnerabilityIds) : [];
      const matchesByVulnerability = new Map();
      for (const match of matches) {
        const assetFields = parseJson(match.asset_fields_json, {});
        const items = matchesByVulnerability.get(match.vulnerability_id) || [];
        if (!items.some((item) => item.id === match.asset_record_id)) items.push({
          id: match.asset_record_id, title: match.asset_title || "", url: assetFields.url || "", ip: assetFields.ipAddress || "", port: String(assetFields.port || ""),
          targetName: match.target_name || "未关联监测对象", matchedProduct: match.matched_product || "", assetVersion: match.asset_version || "", confidence: match.confidence
        });
        matchesByVulnerability.set(match.vulnerability_id, items);
      }
      const confidenceRank = { review: 1, suspected: 2, confirmed: 3 };
      const data = rows.map((row) => {
        const matchedAssets = matchesByVulnerability.get(row.id) || [];
        const highestConfidence = matchedAssets.reduce((best, asset) => !best || confidenceRank[asset.confidence] > confidenceRank[best] ? asset.confidence : best, undefined);
        return { ...parseVulnerabilityRecord(row), assetMatched: matchedAssets.length > 0, matchedAssetCount: matchedAssets.length, matchedProducts: [...new Set(matchedAssets.map((asset) => asset.matchedProduct).filter(Boolean))], matchedAssets, ...(highestConfidence ? { highestConfidence } : {}) };
      });
      return json(res, 200, {
        page, pageSize, total: Number(totalRow.count), matchedCount: Number(matchedRow.count), unmatchedCount: Number(unmatchedRow.count),
        matchedAssetCount: Number(matchedAssetRow.count), riskCounts: Object.fromEntries(riskRows.map((row) => [row.risk, Number(row.count)])), data
      });
    }
    const vulnerabilityDetailMatch = url.pathname.match(/^\/api\/vulnerabilities\/([^/]+)$/);
    if (vulnerabilityDetailMatch && req.method === "GET") {
      const user = await requireAnyPermission(req, res, ["portal:read", "ingestion:manage"]); if (!user) return;
      const includeDrafts = permissionsFor(user).includes("ingestion:manage");
      const tenantId = await requireTenantContext(req, res, url.searchParams.get("tenant_id")); if (!tenantId) return;
      const row = await db.prepare(`SELECT vulnerability_records.*,monitoring_targets.name AS target_name FROM vulnerability_records LEFT JOIN monitoring_targets ON monitoring_targets.id=vulnerability_records.target_id WHERE vulnerability_records.id=?${includeDrafts ? "" : " AND vulnerability_records.is_published=TRUE"} AND vulnerability_records.tenant_id=?`).get(decodeURIComponent(vulnerabilityDetailMatch[1]), tenantId);
      return row ? json(res, 200, parseVulnerabilityRecord(row)) : json(res, 404, { message: "漏洞情报不存在" });
    }
    if (vulnerabilityDetailMatch && req.method === "PUT") {
      if (!await requirePermission(req, res, "ingestion:manage")) return;
      const tenantId = await requireTenantContext(req, res); if (!tenantId) return;
      const id = decodeURIComponent(vulnerabilityDetailMatch[1]);
      const current = await db.prepare("SELECT * FROM vulnerability_records WHERE id=? AND tenant_id=?").get(id, tenantId);
      if (!current) return json(res, 404, { message: "漏洞情报不存在" });
      const body = await readJson(req, articleJsonBodyLimit);
      const values = managedVulnerabilityValues(body);
      const publish = body.publish === true;
      const now = new Date().toISOString();
      await db.prepare(`UPDATE vulnerability_records SET cve=?,title=?,summary=?,risk=?,source=?,disclosure_at=?,solutions=?,references_json=?,tags_json=?,status=?,source_updated_at=?,last_seen_at=?,manually_managed=TRUE,reviewed_at=?,is_published=? WHERE id=?`)
        .run(values.cve, values.title, values.summary, values.risk, values.source, values.disclosureAt, values.solutions, JSON.stringify(values.references), JSON.stringify(values.tags), values.status, now, now, now, publish, id);
      if (publish) await vulnerabilityAlerts.recompute({ tenantId: current.tenant_id });
      await enqueueVulnerabilitySnapshots(current.tenant_id);
      const row = await db.prepare("SELECT vulnerability_records.*,monitoring_targets.name AS target_name FROM vulnerability_records LEFT JOIN monitoring_targets ON monitoring_targets.id=vulnerability_records.target_id WHERE vulnerability_records.id=?").get(id);
      return json(res, 200, parseVulnerabilityRecord(row));
    }
    const vulnerabilityPublishMatch = url.pathname.match(/^\/api\/vulnerabilities\/([^/]+)\/publish$/);
    if (vulnerabilityPublishMatch && req.method === "POST") {
      if (!await requirePermission(req, res, "ingestion:manage")) return;
      const tenantId = await requireTenantContext(req, res); if (!tenantId) return;
      const id = decodeURIComponent(vulnerabilityPublishMatch[1]);
      const current = await db.prepare("SELECT * FROM vulnerability_records WHERE id=? AND tenant_id=?").get(id, tenantId);
      if (!current) return json(res, 404, { message: "漏洞情报不存在" });
      if (!current.reviewed_at) return json(res, 400, { message: "请先保存审核后的漏洞内容，再执行发布" });
      await db.prepare("UPDATE vulnerability_records SET is_published=TRUE,last_seen_at=? WHERE id=?").run(new Date().toISOString(), id);
      await vulnerabilityAlerts.recompute({ tenantId: current.tenant_id });
      await enqueueVulnerabilitySnapshots(current.tenant_id);
      const row = await db.prepare("SELECT vulnerability_records.*,monitoring_targets.name AS target_name FROM vulnerability_records LEFT JOIN monitoring_targets ON monitoring_targets.id=vulnerability_records.target_id WHERE vulnerability_records.id=?").get(id);
      return json(res, 200, parseVulnerabilityRecord(row));
    }
    if (vulnerabilityDetailMatch && req.method === "DELETE") {
      if (!await requirePermission(req, res, "ingestion:manage")) return;
      const tenantId = await requireTenantContext(req, res); if (!tenantId) return;
      const id = decodeURIComponent(vulnerabilityDetailMatch[1]);
      const current = await db.prepare("SELECT id,tenant_id,source_connection_id,source_key FROM vulnerability_records WHERE id=? AND tenant_id=?").get(id, tenantId);
      if (!current) return json(res, 404, { message: "漏洞情报不存在" });
      await db.transaction(async () => { await suppressVulnerability(current); await db.prepare("DELETE FROM vulnerability_records WHERE id=?").run(id); });
      const snapshots = await enqueueVulnerabilitySnapshots(current.tenant_id);
      return json(res, 200, { ok: true, id, snapshots });
    }
    if (req.method === "GET" && url.pathname === "/api/vulnerability-alerts") {
      const user = await requireSession(req, res); if (!user) return;
      const page = Math.max(1, Math.floor(Number(url.searchParams.get("page") || 1)));
      const pageSize = Math.min(100, Math.max(1, Math.floor(Number(url.searchParams.get("page_size") || 20))));
      const query = String(url.searchParams.get("query") || "").trim().slice(0, 200);
      const risk = String(url.searchParams.get("risk") || ""); const status = String(url.searchParams.get("status") || ""); const confidence = String(url.searchParams.get("confidence") || "");
      const tenantId = await requireTenantContext(req, res, url.searchParams.get("tenant_id")); if (!tenantId) return;
      if (risk && !["critical", "high", "medium", "low", "info"].includes(risk)) return json(res, 400, { message: "风险等级不合法" });
      if (status && !["new", "acknowledged", "resolved", "ignored"].includes(status)) return json(res, 400, { message: "告警状态不合法" });
      if (confidence && !["confirmed", "suspected", "review"].includes(confidence)) return json(res, 400, { message: "匹配置信度不合法" });
      const clauses = []; const params = [];
      if (!permissionsFor(user).includes("ingestion:manage")) clauses.push("v.is_published=TRUE AND asset.is_published=TRUE");
      clauses.push("v.tenant_id=?"); params.push(tenantId);
      if (query) { clauses.push("(v.title ILIKE ? OR v.cve ILIKE ? OR i.product_name ILIKE ? OR a.matched_product ILIKE ? OR asset.fields_json ILIKE ? OR target.name ILIKE ?)"); params.push(...Array(6).fill(`%${query}%`)); }
      if (risk) { clauses.push("v.risk=?"); params.push(risk); }
      if (status) { clauses.push("a.status=?"); params.push(status); }
      if (confidence) { clauses.push("a.confidence=?"); params.push(confidence); }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      const from = `FROM vulnerability_alerts a JOIN vulnerability_records v ON v.id=a.vulnerability_id JOIN fingerprint_watch_groups g ON g.id=a.watch_group_id JOIN fingerprint_watch_items i ON i.id=a.watch_item_id LEFT JOIN asset_records asset ON asset.id=a.asset_record_id LEFT JOIN monitoring_targets target ON target.id=a.target_id`;
      const total = Number((await db.prepare(`SELECT COUNT(*) AS count ${from} ${where}`).get(...params)).count);
      const [rows, statusRows, confidenceRows] = await Promise.all([
        db.prepare(`SELECT a.*,v.cve AS vulnerability_cve,v.title AS vulnerability_title,v.risk AS vulnerability_risk,v.source AS vulnerability_source,v.disclosure_at AS vulnerability_disclosure_at,v.first_seen_at AS vulnerability_first_seen_at,g.name AS watch_group_name,i.product_name AS watch_product,asset.title AS asset_title,asset.fields_json AS asset_fields_json,target.name AS target_name ${from} ${where} ORDER BY a.first_matched_at DESC,a.id DESC LIMIT ? OFFSET ?`).all(...params, pageSize, (page - 1) * pageSize),
        db.prepare(`SELECT a.status,COUNT(*) AS count ${from} ${where} GROUP BY a.status`).all(...params),
        db.prepare(`SELECT a.confidence,COUNT(*) AS count ${from} ${where} GROUP BY a.confidence`).all(...params)
      ]);
      return json(res, 200, { page, pageSize, total, statusCounts: Object.fromEntries(statusRows.map((row) => [row.status, Number(row.count)])), confidenceCounts: Object.fromEntries(confidenceRows.map((row) => [row.confidence, Number(row.count)])), data: rows.map(parseVulnerabilityAlert) });
    }
    const vulnerabilityAlertMatch = url.pathname.match(/^\/api\/vulnerability-alerts\/([^/]+)$/);
    if (vulnerabilityAlertMatch && req.method === "PUT") {
      if (!await requirePermission(req, res, "operations:manage")) return;
      const tenantId = await requireTenantContext(req, res); if (!tenantId) return;
      const body = await readJson(req); const status = String(body.status || "");
      if (!["new", "acknowledged", "resolved", "ignored"].includes(status)) return json(res, 400, { message: "告警状态不合法" });
      const result = await db.prepare("UPDATE vulnerability_alerts SET status=? WHERE id=? AND vulnerability_id IN (SELECT id FROM vulnerability_records WHERE tenant_id=?)").run(status, decodeURIComponent(vulnerabilityAlertMatch[1]), tenantId);
      return result.changes ? json(res, 200, { ok: true, id: decodeURIComponent(vulnerabilityAlertMatch[1]), status }) : json(res, 404, { message: "漏洞告警不存在" });
    }
    if (req.method === "GET" && url.pathname === "/api/fingerprint-watch-groups") {
      if (!await requirePermission(req, res, "targets:read")) return;
      const tenantId = await requireTenantContext(req, res, url.searchParams.get("tenant_id")); if (!tenantId) return;
      return json(res, 200, await vulnerabilityAlerts.listGroups(tenantId));
    }
    if (req.method === "POST" && url.pathname === "/api/fingerprint-watch-groups") {
      if (!await requirePermission(req, res, "targets:manage")) return;
      const body = await readJson(req); const tenantId = await requireTenantContext(req, res, body.tenantId); if (!tenantId) return;
      return json(res, 201, await vulnerabilityAlerts.saveGroup({ ...body, tenantId }));
    }
    const fingerprintWatchGroupMatch = url.pathname.match(/^\/api\/fingerprint-watch-groups\/([^/]+)$/);
    if (fingerprintWatchGroupMatch && req.method === "PUT") {
      if (!await requirePermission(req, res, "targets:manage")) return;
      const body = await readJson(req); const tenantId = await requireTenantContext(req, res, body.tenantId); if (!tenantId) return;
      const groupId = decodeURIComponent(fingerprintWatchGroupMatch[1]);
      if (!await db.prepare("SELECT id FROM fingerprint_watch_groups WHERE id=? AND tenant_id=?").get(groupId, tenantId)) return json(res, 404, { message: "当前租户下不存在该重点指纹监测组" });
      return json(res, 200, await vulnerabilityAlerts.saveGroup({ ...body, tenantId }, groupId));
    }
    if (fingerprintWatchGroupMatch && req.method === "DELETE") {
      if (!await requirePermission(req, res, "targets:manage")) return;
      const tenantId = await requireTenantContext(req, res); if (!tenantId) return;
      const groupId = decodeURIComponent(fingerprintWatchGroupMatch[1]);
      const group = await db.prepare("SELECT is_default FROM fingerprint_watch_groups WHERE id=? AND tenant_id=?").get(groupId, tenantId);
      if (group?.is_default) return json(res, 409, { message: "默认指纹监测组由系统自动维护，不能删除" });
      const result = await db.prepare("DELETE FROM fingerprint_watch_groups WHERE id=?").run(groupId);
      return result.changes ? json(res, 200, { ok: true }) : json(res, 404, { message: "重点指纹监测组不存在" });
    }
    if (req.method === "POST" && url.pathname === "/api/vulnerability-alerts/recompute") {
      if (!await requirePermission(req, res, "targets:manage")) return;
      const tenantId = await requireTenantContext(req, res); if (!tenantId) return;
      return json(res, 200, await vulnerabilityAlerts.recompute({ tenantId }));
    }
    if (req.method === "GET" && url.pathname === "/api/intelligence") {
      const user = await requireSession(req, res); if (!user) return;
      const pageValue = Number(url.searchParams.get("page") || 1);
      const pageSizeValue = Number(url.searchParams.get("page_size") || 20);
      const page = Number.isFinite(pageValue) ? Math.max(1, Math.floor(pageValue)) : 1;
      const pageSize = Number.isFinite(pageSizeValue) ? Math.min(100, Math.max(1, Math.floor(pageSizeValue))) : 20;
      const query = String(url.searchParams.get("query") || "").trim().slice(0, 200);
      const type = String(url.searchParams.get("type") || "");
      const excludeType = String(url.searchParams.get("exclude_type") || "");
      const subtype = String(url.searchParams.get("subtype") || "").trim().slice(0, 80);
      const risk = String(url.searchParams.get("risk") || "");
      if (type && !intelligenceTypes.includes(type)) return json(res, 400, { message: "情报类型不合法" });
      if (excludeType && !intelligenceTypes.includes(excludeType)) return json(res, 400, { message: "排除的情报类型不合法" });
      const risks = risk.split(",").filter(Boolean);
      if (risks.some((value) => !["critical", "high", "medium", "low", "info"].includes(value))) return json(res, 400, { message: "风险等级不合法" });
      const includeRiskCounts = url.searchParams.get("include_risk_counts") === "1";
      const since = String(url.searchParams.get("since") || "");
      const todayOnly = url.searchParams.get("today_only") === "1";
      const tenantId = await requireTenantContext(req, res, url.searchParams.get("tenant_id")); if (!tenantId) return;
      const includeDrafts = canPreviewDrafts(user, url);
      return json(res, 200, await intelligenceQuery({ page, pageSize, query, type, excludeType, subtype, risk, includeRiskCounts, since, todayOnly, tenantId, includeDrafts }));
    }
    const intelligenceDetailMatch = url.pathname.match(/^\/api\/intelligence\/([^/]+)$/);
    if (intelligenceDetailMatch && req.method === "GET") {
      const user = await requireSession(req, res); if (!user) return;
      const tenantId = await requireTenantContext(req, res, url.searchParams.get("tenant_id")); if (!tenantId) return;
      const result = await intelligenceQuery({ id: decodeURIComponent(intelligenceDetailMatch[1]), page: 1, pageSize: 1, tenantId, includeDrafts: canPreviewDrafts(user, url) });
      if (!result.total) return json(res, 404, { message: "情报不存在" });
      return json(res, 200, result.data[0]);
    }
    if (req.method === "GET" && url.pathname === "/api/dashboard/portal") {
      const user = await requireSession(req, res); if (!user) return;
      const tenantId = await requireTenantContext(req, res, url.searchParams.get("tenant_id")); if (!tenantId) return;
      return json(res, 200, await portalDashboard(String(url.searchParams.get("since") || ""), tenantId, canPreviewDrafts(user, url)));
    }
    if (req.method === "GET" && url.pathname === "/api/dashboard/admin") {
      if (!await requireAdmin(req, res)) return;
      const tenantId = await requireTenantContext(req, res, url.searchParams.get("tenant_id")); if (!tenantId) return;
      return json(res, 200, await adminDashboard(tenantId));
    }
    if (req.method === "GET" && url.pathname === "/api/dark-web/events") {
      const user = await requireSession(req, res); if (!user) return;
      const page = Math.max(1, Number(url.searchParams.get("page") || 1));
      const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get("page_size") || 20)));
      const query = String(url.searchParams.get("query") || "").trim();
      const targetId = String(url.searchParams.get("target_id") || "");
      const since = String(url.searchParams.get("since") || ""); const todayOnly = url.searchParams.get("today_only") === "1";
      const tenantId = await requireTenantContext(req, res, url.searchParams.get("tenant_id")); if (!tenantId) return;
      const baseConditions = canPreviewDrafts(user, url) ? [] : ["is_published=TRUE"]; const baseParams = [];
      baseConditions.push("tenant_id=?"); baseParams.push(tenantId);
      if (targetId) { baseConditions.push("target_id=?"); baseParams.push(targetId); }
      if (query) { baseConditions.push("(title ILIKE ? OR source_group_name ILIKE ? OR source_group_id ILIKE ? OR intel_tags ILIKE ? OR leak_data_types ILIKE ? OR intel_note ILIKE ? OR message_url ILIKE ?)"); baseParams.push(...Array(7).fill(`%${query}%`)); }
      const baseWhere = baseConditions.length ? baseConditions.join(" AND ") : "1=1";
      const allTotal = Number((await db.prepare(`SELECT COUNT(*) AS count FROM dark_web_events WHERE ${baseWhere}`).get(...baseParams)).count);
      const todayWhere = since ? `(${baseWhere}) AND first_seen_at>=?` : baseWhere; const todayParams = since ? [...baseParams, since] : baseParams;
      const todayNewCount = since ? Number((await db.prepare(`SELECT COUNT(*) AS count FROM dark_web_events WHERE ${todayWhere}`).get(...todayParams)).count) : 0;
      const where = todayOnly && since ? todayWhere : baseWhere; const params = todayOnly && since ? todayParams : baseParams;
      const total = todayOnly && since ? todayNewCount : allTotal;
      const rows = await db.prepare(`SELECT * FROM dark_web_events WHERE ${where} ORDER BY published_at DESC,last_seen_at DESC LIMIT ? OFFSET ?`).all(...params, pageSize, (page - 1) * pageSize);
      return json(res, 200, { page, pageSize, total, allTotal, todayNewCount, data: await Promise.all(rows.map(parseDarkWebEvent)) });
    }
    const darkWebEventMatch = url.pathname.match(/^\/api\/dark-web\/events\/([^/]+)$/);
    if (darkWebEventMatch && req.method === "GET") {
      const user = await requireSession(req, res); if (!user) return;
      const tenantId = await requireTenantContext(req, res, url.searchParams.get("tenant_id")); if (!tenantId) return;
      const row = await db.prepare(`SELECT * FROM dark_web_events WHERE id=?${canPreviewDrafts(user, url) ? "" : " AND is_published=TRUE"} AND tenant_id=?`).get(darkWebEventMatch[1], tenantId);
      if (!row) return json(res, 404, { message: "暗网情报不存在" });
      const files = (await db.prepare(`SELECT dark_web_files.*,dark_web_blobs.size_bytes,dark_web_blobs.media_type FROM dark_web_files JOIN dark_web_blobs ON dark_web_blobs.sha256=dark_web_files.blob_sha256 WHERE dark_web_files.event_id=? AND dark_web_files.batch_id=? AND dark_web_files.kind IN ('report','attachment') ORDER BY CASE dark_web_files.kind WHEN 'report' THEN 0 ELSE 1 END,dark_web_files.original_name`).all(row.id, row.latest_batch_id)).map(parseDarkWebFile);
      return json(res, 200, { ...await parseDarkWebEvent(row), files });
    }
    const darkWebFileMatch = url.pathname.match(/^\/api\/dark-web\/events\/([^/]+)\/files\/([^/]+)\/content$/);
    if (darkWebFileMatch && req.method === "GET") {
      const user = await requirePermission(req, res, "evidence:download"); if (!user) return;
      const tenantId = await requireTenantContext(req, res, url.searchParams.get("tenant_id")); if (!tenantId) return;
      const row = await db.prepare(`SELECT dark_web_files.*,dark_web_blobs.* FROM dark_web_files JOIN dark_web_blobs ON dark_web_blobs.sha256=dark_web_files.blob_sha256 JOIN dark_web_events ON dark_web_events.id=dark_web_files.event_id WHERE dark_web_files.id=? AND dark_web_files.event_id=?${canPreviewDrafts(user, url) ? "" : " AND dark_web_events.is_published=TRUE"} AND dark_web_events.tenant_id=? AND dark_web_files.kind IN ('report','attachment')`).get(darkWebFileMatch[2], darkWebFileMatch[1], tenantId);
      if (!row) return json(res, 404, { message: "事件附件不存在" });
      return download(res, darkWebBlob(row), row.original_name, row.media_type);
    }
    const darkWebPreviewMatch = url.pathname.match(/^\/api\/dark-web\/events\/([^/]+)\/files\/([^/]+)\/preview$/);
    if (darkWebPreviewMatch && req.method === "GET") {
      const user = await requireSession(req, res); if (!user) return;
      const tenantId = await requireTenantContext(req, res, url.searchParams.get("tenant_id")); if (!tenantId) return;
      const row = await db.prepare(`SELECT dark_web_files.*,dark_web_blobs.* FROM dark_web_files JOIN dark_web_blobs ON dark_web_blobs.sha256=dark_web_files.blob_sha256 JOIN dark_web_events ON dark_web_events.id=dark_web_files.event_id WHERE dark_web_files.id=? AND dark_web_files.event_id=?${canPreviewDrafts(user, url) ? "" : " AND dark_web_events.is_published=TRUE"} AND dark_web_events.tenant_id=? AND dark_web_files.kind IN ('report','attachment')`).get(darkWebPreviewMatch[2], darkWebPreviewMatch[1], tenantId);
      if (!row) return json(res, 404, { message: "事件附件不存在" });
      const buffer = darkWebBlob(row);
      await assertSafeOoxml(buffer);
      const preview = row.kind === "report"
        ? await createWordPreview(buffer)
        : createWorkbookPreview(buffer, { sheet: Number(url.searchParams.get("sheet") || 0), page: Number(url.searchParams.get("page") || 1), pageSize: Number(url.searchParams.get("page_size") || 50) });
      return json(res, 200, { file: parseDarkWebFile(row), ...preview });
    }
    const darkWebArchiveMatch = url.pathname.match(/^\/api\/ingestion\/batches\/([^/]+)\/archive$/);
    if (darkWebArchiveMatch && req.method === "GET") {
      if (!await requirePermission(req, res, "ingestion:manage")) return;
      const tenantId = await requireTenantContext(req, res); if (!tenantId) return;
      const row = await db.prepare(`SELECT dark_web_files.*,dark_web_blobs.* FROM dark_web_files JOIN dark_web_blobs ON dark_web_blobs.sha256=dark_web_files.blob_sha256 JOIN ingestion_batches ON ingestion_batches.id=dark_web_files.batch_id WHERE dark_web_files.batch_id=? AND ingestion_batches.tenant_id=? AND dark_web_files.kind='archive'`).get(darkWebArchiveMatch[1], tenantId);
      if (!row) return json(res, 404, { message: "原始暗网交付包不存在" });
      return download(res, darkWebBlob(row), row.original_name, row.media_type);
    }
    if (req.method === "GET" && url.pathname === "/api/sensitive/records") {
      const user = await requireSession(req, res); if (!user) return;
      const category = String(url.searchParams.get("category") || "");
      const targetId = url.searchParams.get("target_id");
      const page = Math.max(1, Number(url.searchParams.get("page") || 1));
      const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get("page_size") || 50)));
      if (!Object.values(sensitiveSheetCategories).includes(category)) return json(res, 400, { message: "缺少有效的敏感信息分类" });
      const since = String(url.searchParams.get("since") || ""); const todayOnly = url.searchParams.get("today_only") === "1";
      const query = String(url.searchParams.get("query") || "").trim().slice(0, 200);
      const risk = String(url.searchParams.get("risk") || "").trim();
      if (risk && !["高", "中", "低", "未标记"].includes(risk)) return json(res, 400, { message: "风险等级不合法" });
      const tenantId = await requireTenantContext(req, res, url.searchParams.get("tenant_id")); if (!tenantId) return;
      const baseClauses = canPreviewDrafts(user, url) ? ["category=?"] : ["is_published=TRUE", "category=?"]; const baseParams = [category];
      baseClauses.push("tenant_id=?"); baseParams.push(tenantId);
      if (targetId) { baseClauses.push("target_id=?"); baseParams.push(targetId); }
      const baseWhere = baseClauses.join(" AND ");
      const allTotal = Number((await db.prepare(`SELECT COUNT(*) AS count FROM sensitive_records WHERE ${baseWhere}`).get(...baseParams)).count);
      const todayWhere = since ? `(${baseWhere}) AND first_seen_at>=?` : baseWhere; const todayParams = since ? [...baseParams, since] : baseParams;
      const todayNewCount = since ? Number((await db.prepare(`SELECT COUNT(*) AS count FROM sensitive_records WHERE ${todayWhere}`).get(...todayParams)).count) : 0;
      const filteredClauses = [todayOnly && since ? todayWhere : baseWhere]; const filteredParams = todayOnly && since ? [...todayParams] : [...baseParams];
      if (query) { filteredClauses.push("(title ILIKE ? OR fields_json ILIKE ?)"); filteredParams.push(`%${query}%`, `%${query}%`); }
      const riskRows = await db.prepare(`SELECT risk,COUNT(*) AS count FROM sensitive_records WHERE ${filteredClauses.join(" AND ")} GROUP BY risk`).all(...filteredParams);
      if (risk) { filteredClauses.push("risk=?"); filteredParams.push(risk); }
      const where = filteredClauses.join(" AND "); const params = filteredParams;
      const total = Number((await db.prepare(`SELECT COUNT(*) AS count FROM sensitive_records WHERE ${where}`).get(...params)).count);
      const rows = await db.prepare(`SELECT * FROM sensitive_records WHERE ${where} ORDER BY last_seen_at DESC, id DESC LIMIT ? OFFSET ?`).all(...params, pageSize, (page - 1) * pageSize);
      return json(res, 200, { page, pageSize, total, allTotal, todayNewCount, riskCounts: Object.fromEntries(riskRows.map((row) => [row.risk, Number(row.count)])), data: rows.map((row, index) => ({ id: row.id, sequence: (page - 1) * pageSize + index + 1, category: row.category, targetId: row.target_id, title: row.title, risk: row.risk, fields: JSON.parse(row.fields_json || "{}"), firstSeenAt: row.first_seen_at, lastSeenAt: row.last_seen_at, importStatus: row.import_status, importCount: row.import_count, batchId: row.batch_id })) });
    }
    if (req.method === "GET" && url.pathname === "/api/assets/records") {
      const user = await requireSession(req, res); if (!user) return;
      const category = String(url.searchParams.get("category") || "");
      const targetId = url.searchParams.get("target_id");
      const page = Math.max(1, Number(url.searchParams.get("page") || 1));
      const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get("page_size") || 50)));
      if (!Object.values(assetCategories).includes(category)) return json(res, 400, { message: "缺少有效的资产分类" });
      const since = String(url.searchParams.get("since") || ""); const todayOnly = url.searchParams.get("today_only") === "1";
      const tenantId = await requireTenantContext(req, res, url.searchParams.get("tenant_id")); if (!tenantId) return;
      const baseClauses = canPreviewDrafts(user, url) ? ["category=?"] : ["is_published=TRUE", "category=?"];
      const baseParams = [category];
      if (targetId) { baseClauses.push("target_id=?"); baseParams.push(targetId); }
      baseClauses.push("tenant_id=?"); baseParams.push(tenantId);
      const baseWhere = baseClauses.join(" AND ");
      const allTotal = Number((await db.prepare(`SELECT COUNT(*) AS count FROM asset_records WHERE ${baseWhere}`).get(...baseParams)).count);
      const todayWhere = since ? `(${baseWhere}) AND first_seen_at>=?` : baseWhere; const todayParams = since ? [...baseParams, since] : baseParams;
      const todayNewCount = since ? Number((await db.prepare(`SELECT COUNT(*) AS count FROM asset_records WHERE ${todayWhere}`).get(...todayParams)).count) : 0;
      const where = todayOnly && since ? todayWhere : baseWhere; const params = todayOnly && since ? todayParams : baseParams;
      const total = todayOnly && since ? todayNewCount : allTotal;
      const rows = await db.prepare(`SELECT * FROM asset_records WHERE ${where} ORDER BY last_seen_at DESC, id DESC LIMIT ? OFFSET ?`).all(...params, pageSize, (page - 1) * pageSize);
      return json(res, 200, { page, pageSize, total, allTotal, todayNewCount, data: rows.map((row, index) => ({ id: row.id, sequence: (page - 1) * pageSize + index + 1, category: row.category, targetId: row.target_id, title: row.title, risk: row.risk, fields: JSON.parse(row.fields_json || "{}"), firstSeenAt: row.first_seen_at, lastSeenAt: row.last_seen_at, importStatus: row.import_status, importCount: row.import_count, batchId: row.batch_id, changeType: row.change_type, previousFields: parseOptionalJson(row.previous_fields_json), presentInLatestBatch: Boolean(row.present_in_latest_batch), previouslyPublished: Boolean(row.previously_published), lastChangedAt: row.last_changed_at || undefined, missingSince: row.missing_since || undefined })) });
    }
    if (req.method === "GET" && url.pathname === "/api/assets/reports/latest") {
      const user = await requireSession(req, res); if (!user) return;
      const targetId = url.searchParams.get("target_id");
      const tenantId = await requireTenantContext(req, res, url.searchParams.get("tenant_id")); if (!tenantId) return;
      const clauses = canPreviewDrafts(user, url) ? [] : ["is_published=TRUE"]; const params = [];
      if (targetId) { clauses.push("target_id=?"); params.push(targetId); }
      clauses.push("tenant_id=?"); params.push(tenantId);
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      const row = await db.prepare(`SELECT * FROM asset_reports ${where} ORDER BY created_at DESC LIMIT 1`).get(...params);
      const projected = row ? await loadProjectedAssetReport(row, String(url.searchParams.get("since") || ""), canPreviewDrafts(user, url)) : null;
      return json(res, 200, projected?.report || null);
    }
    const reportDataMatch = url.pathname.match(/^\/api\/assets\/reports\/([^/]+)\/data$/);
    if ((reportDataMatch || url.pathname === "/api/assets/reports/latest/data") && req.method === "GET") {
      const user = await requireSession(req, res); if (!user) return;
      const tenantId = await requireTenantContext(req, res, url.searchParams.get("tenant_id")); if (!tenantId) return;
      const publicationClause = canPreviewDrafts(user, url) ? "" : " AND is_published=TRUE";
      const tenantClause = " AND tenant_id=?";
      const row = reportDataMatch?.[1] === "latest" || url.pathname === "/api/assets/reports/latest/data"
        ? await db.prepare(`SELECT * FROM asset_reports WHERE TRUE${publicationClause}${tenantClause} ORDER BY created_at DESC LIMIT 1`).get(tenantId)
        : await db.prepare(`SELECT * FROM asset_reports WHERE id=?${publicationClause}${tenantClause}`).get(reportDataMatch[1], tenantId);
      if (!row) return json(res, 404, { message: "资产报告不存在" });
      const section = String(url.searchParams.get("section") || "web");
      const since = String(url.searchParams.get("since") || "");
      const todayOnly = url.searchParams.get("today_only") === "1";
      const { data, report } = await loadProjectedAssetReport(row, since, canPreviewDrafts(user, url));
      const sourceRows = reportSectionRows(data, section);
      if (!sourceRows) return json(res, 400, { message: "报告板块不合法" });
      const columns = reportColumnKeys(sourceRows);
      const query = String(url.searchParams.get("query") || "").trim().toLowerCase();
      const fingerprintType = String(url.searchParams.get("fingerprint_type") || "");
      const aliveFilter = String(url.searchParams.get("alive") || "");
      const statusCodeFilter = String(url.searchParams.get("status_code") || "");
      const changeTypeFilter = String(url.searchParams.get("change_type") || "");
      const sort = String(url.searchParams.get("sort") || "");
      const direction = url.searchParams.get("direction") === "asc" ? "asc" : "desc";
      const page = Math.max(1, Number(url.searchParams.get("page") || 1));
      const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get("page_size") || 20)));
      const todayRows = since ? sourceRows.filter((item) => assetReportRowIsSince(item, since)) : [];
      let rows = todayOnly && since ? [...todayRows] : [...sourceRows];
      if (fingerprintType && section === "fingerprints") rows = rows.filter((item) => item.type === fingerprintType);
      if (aliveFilter && (section === "web" || section === "ports")) rows = rows.filter((item) => stringifyField(item.alive) === aliveFilter);
      if (statusCodeFilter && section === "web") rows = rows.filter((item) => stringifyField(item.status_code) === statusCodeFilter);
      if (changeTypeFilter) rows = rows.filter((item) => stringifyField(item._change_type) === changeTypeFilter);
      if (query) rows = rows.filter((item) => Object.values(item || {}).some((value) => stringifyField(value).toLowerCase().includes(query)));
      const sortable = sort && (columns.includes(sort) || sort === "change_status");
      if (sortable) rows.sort((left, right) => {
        const changeOrder = { unchanged: 0, baseline: 1, reappeared: 2, new: 3, missing: 4, changed: 5 };
        const comparison = sort === "change_status"
          ? (changeOrder[left?._change_type] ?? -1) - (changeOrder[right?._change_type] ?? -1)
          : stringifyField(left?.[sort]).localeCompare(stringifyField(right?.[sort]), "zh-CN", { numeric: true });
        return comparison * (direction === "asc" ? 1 : -1);
      });
      const total = rows.length;
      let pageRows = rows.slice((page - 1) * pageSize, page * pageSize);
      if (section === "web") {
        const iconsByMd5 = new Map((Array.isArray(data.icons) ? data.icons : []).filter((item) => item.md5 && item.icon).map((item) => [item.md5, item.icon]));
        pageRows = pageRows.map((item) => ({ ...item, _icon: iconsByMd5.get(item.icon_hash_md5) || "" }));
      }
      return json(res, 200, { report, section, page, pageSize, total, allTotal: sourceRows.length, todayNewCount: todayRows.length, columns, facets: reportFacets(data, section), data: pageRows });
    }
    const reportContentMatch = url.pathname.match(/^\/api\/assets\/reports\/([^/]+)\/content$/);
    if (reportContentMatch && req.method === "GET") {
      const user = await requireSession(req, res); if (!user) return;
      const tenantId = await requireTenantContext(req, res, url.searchParams.get("tenant_id")); if (!tenantId) return;
      const row = await db.prepare(`SELECT * FROM asset_reports WHERE id=?${canPreviewDrafts(user, url) ? "" : " AND is_published=TRUE"} AND tenant_id=?`).get(reportContentMatch[1], tenantId);
      if (!row) return json(res, 404, { message: "资产报告不存在" });
      const fs = await import("node:fs/promises");
      try {
        const html = await fs.readFile(resolveReportPath(row.file_path, row.id, "html"));
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
        return res.end(html);
      } catch { return json(res, 404, { message: "资产报告文件已丢失" }); }
    }
    if (req.method === "GET" && url.pathname === "/api/auth/captcha") {
      res.setHeader("Cache-Control", "no-store");
      return json(res, 200, await captchaService.issue());
    }
    if (req.method === "POST" && url.pathname === "/api/auth/login") {
      const body = await readJson(req); req.auditAttemptedAccount = String(body.account || "").slice(0, 64);
      await captchaService.verify(body.captchaId, body.captchaCode);
      const user = await db.prepare("SELECT * FROM users WHERE account=? AND enabled=1").get(req.auditAttemptedAccount);
      if (!user) return json(res, 401, { message: "账号或密码不正确" });
      const expected = Buffer.from(user.password_hash, "hex"); const actual = Buffer.from(hashPassword(String(body.password || ""), user.password_salt), "hex");
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return json(res, 401, { message: "账号或密码不正确" });
      if (user.totp_enabled && user.totp_secret_enc) {
        const challenge = await createLoginChallenge(user.account);
        return json(res, 202, { otpRequired: true, account: user.account, ...challenge });
      }
      const session = await issueSession(user);
      req.auditUser = session.row;
      return json(res, 200, { token: session.token, expiresAt: session.expiresAt, user: session.user });
    }
    if (req.method === "POST" && url.pathname === "/api/auth/login/otp") {
      const body = await readJson(req);
      const challengeHash = tokenHash(String(body.challengeId || ""));
      const now = new Date().toISOString();
      const challenge = await db.prepare("SELECT auth_challenges.*,users.totp_secret_enc,users.totp_enabled,users.enabled FROM auth_challenges JOIN users ON users.account=auth_challenges.account WHERE token_hash=? AND purpose='login' AND expires_at>? AND users.enabled=1").get(challengeHash, now);
      if (!challenge) return json(res, 401, { message: "动态码验证已过期，请重新登录" });
      req.auditAttemptedAccount = challenge.account;
      if (challenge.attempts >= 5) {
        await db.prepare("DELETE FROM auth_challenges WHERE token_hash=?").run(challengeHash);
        return json(res, 401, { message: "动态码错误次数过多，请重新登录" });
      }
      const valid = Boolean(challenge.totp_enabled && challenge.totp_secret_enc && verifyTotpCode({ secret: decryptTotpSecret(challenge), code: body.code }));
      if (!valid) {
        await db.prepare("UPDATE auth_challenges SET attempts=attempts+1 WHERE token_hash=?").run(challengeHash);
        return json(res, 401, { message: "动态验证码不正确" });
      }
      await db.prepare("DELETE FROM auth_challenges WHERE token_hash=?").run(challengeHash);
      const user = await db.prepare("SELECT * FROM users WHERE account=? AND enabled=1").get(challenge.account);
      const session = await issueSession(user);
      req.auditUser = session.row;
      return json(res, 200, { token: session.token, expiresAt: session.expiresAt, user: session.user });
    }
    if (req.method === "GET" && url.pathname === "/api/auth/me") {
      const user = await authenticatedUser(req, res); if (!user) return;
      return json(res, 200, parseUser(await db.prepare("SELECT * FROM users WHERE account=?").get(user.account)));
    }
    if (url.pathname === "/api/profile") {
      const actor = await authenticatedUser(req, res); if (!actor) return;
      if (req.method === "GET") return json(res, 200, parseUser(await db.prepare("SELECT * FROM users WHERE account=?").get(actor.account)));
      if (req.method === "PUT") {
        const body = await readJson(req);
        const name = managedText(body.name, "姓名", { required: true, max: 80 });
        const email = managedText(body.email, "邮箱", { max: 160 });
        const phone = managedText(body.phone, "联系电话", { max: 40 });
        const department = managedText(body.department, "部门", { max: 120 });
        if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(res, 400, { message: "邮箱格式不正确" });
        const now = new Date().toISOString();
        await db.prepare("UPDATE users SET name=?,email=?,phone=?,department=?,updated_at=? WHERE account=?").run(name, email, phone, department, now, actor.account);
        return json(res, 200, parseUser(await db.prepare("SELECT * FROM users WHERE account=?").get(actor.account)));
      }
      return json(res, 405, { message: "请求方法不支持" });
    }
    if (req.method === "POST" && url.pathname === "/api/profile/change-password") {
      const actor = await authenticatedUser(req, res); if (!actor) return;
      const body = await readJson(req); const currentPassword = String(body.currentPassword || ""); const password = String(body.password || "");
      const current = await db.prepare("SELECT * FROM users WHERE account=?").get(actor.account);
      if (!passwordMatches(currentPassword, current)) return json(res, 401, { message: "当前密码不正确" });
      const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
      const changedAt = await rotateUserPassword(actor.account, password, { preserveTokenHash: tokenHash(token) });
      return json(res, 200, { ok: true, changedAt });
    }
    if (url.pathname === "/api/password-policy") {
      if (!await requirePermission(req, res, "accounts:manage")) return;
      if (req.method === "GET") return json(res, 200, await readPasswordPolicy());
      if (req.method === "PUT") {
        const body = await readJson(req);
        const minLength = Math.floor(Number(body.minLength)); const maxLength = Math.floor(Number(body.maxLength)); const historyCount = Math.floor(Number(body.historyCount));
        if (!Number.isInteger(minLength) || minLength < 8 || minLength > 64) return json(res, 400, { message: "最小密码长度必须为 8-64 位" });
        if (!Number.isInteger(maxLength) || maxLength < minLength || maxLength > 128) return json(res, 400, { message: "最大密码长度必须介于最小长度和 128 位之间" });
        if (!Number.isInteger(historyCount) || historyCount < 0 || historyCount > 20) return json(res, 400, { message: "密码历史次数必须为 0-20" });
        const now = new Date().toISOString();
        await db.prepare(`INSERT INTO platform_password_policy (id,min_length,max_length,require_uppercase,require_lowercase,require_number,require_special,history_count,updated_at) VALUES (1,?,?,?,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET min_length=excluded.min_length,max_length=excluded.max_length,require_uppercase=excluded.require_uppercase,require_lowercase=excluded.require_lowercase,require_number=excluded.require_number,require_special=excluded.require_special,history_count=excluded.history_count,updated_at=excluded.updated_at`)
          .run(minLength, maxLength, body.requireUppercase !== false, body.requireLowercase !== false, body.requireNumber !== false, body.requireSpecial !== false, historyCount, now);
        return json(res, 200, await readPasswordPolicy());
      }
      return json(res, 405, { message: "请求方法不支持" });
    }
    if (req.method === "POST" && url.pathname === "/api/auth/logout") {
      const user = await authenticatedUser(req, res); if (!user) return;
      const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
      await db.prepare("DELETE FROM sessions WHERE token_hash=?").run(tokenHash(token));
      return json(res, 200, { ok: true });
    }
    if (req.method === "GET" && url.pathname === "/api/roles") {
      if (!await requirePermission(req, res, "accounts:manage")) return;
      return json(res, 200, Object.values(roleDefinitions));
    }
    if (req.method === "GET" && url.pathname === "/api/users") {
      if (!await requirePermission(req, res, "accounts:manage")) return;
      return json(res, 200, (await db.prepare("SELECT * FROM users ORDER BY enabled DESC,created_at DESC,account").all()).map(parseUser));
    }
    if (req.method === "POST" && url.pathname === "/api/users") {
      if (!await requirePermission(req, res, "accounts:manage")) return;
      const body = await readJson(req); const account = String(body.account || "").trim(); const name = String(body.name || "").trim(); const password = String(body.password || ""); const role = roleFor(String(body.roleKey || ""));
      assertAccount(account); await assertPassword(password, account);
      if (!name || name.length > 80) return json(res, 400, { message: "姓名不能为空且不能超过 80 个字符" });
      if (!role) return json(res, 400, { message: "角色不存在" });
      if (await db.prepare("SELECT 1 FROM users WHERE account=?").get(account)) return json(res, 409, { message: "登录账号已存在" });
      const salt = randomBytes(16).toString("hex"); const now = new Date().toISOString();
      await db.prepare("INSERT INTO users (account,name,role,password_salt,password_hash,enabled,workspace,role_key,last_login_at,created_at,updated_at,password_changed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(account, name, role.label, salt, hashPassword(password, salt), body.enabled === false ? 0 : 1, role.workspace, role.key, null, now, now, now);
      return json(res, 201, parseUser(await db.prepare("SELECT * FROM users WHERE account=?").get(account)));
    }
    const userMatch = url.pathname.match(/^\/api\/users\/([^/]+)$/);
    if (userMatch && req.method === "GET") {
      if (!await requirePermission(req, res, "accounts:manage")) return;
      const account = decodeURIComponent(userMatch[1]); const current = await db.prepare("SELECT * FROM users WHERE account=?").get(account);
      return current ? json(res, 200, parseUser(current)) : json(res, 404, { message: "账号不存在" });
    }
    if (userMatch && req.method === "PUT") {
      const actor = await requirePermission(req, res, "accounts:manage"); if (!actor) return;
      const account = decodeURIComponent(userMatch[1]); const current = await db.prepare("SELECT * FROM users WHERE account=?").get(account);
      if (!current) return json(res, 404, { message: "账号不存在" });
      const body = await readJson(req); const name = String(body.name ?? current.name).trim(); const role = roleFor(String(body.roleKey || current.role_key)); const enabled = body.enabled === undefined ? Boolean(current.enabled) : Boolean(body.enabled);
      if (!name || name.length > 80) return json(res, 400, { message: "姓名不能为空且不能超过 80 个字符" });
      if (!role) return json(res, 400, { message: "角色不存在" });
      if (actor.account === account && !enabled) return json(res, 400, { message: "不能停用当前登录账号" });
      if (current.role_key === "platform-admin" && (role.key !== "platform-admin" || !enabled)) {
        const remaining = (await db.prepare("SELECT COUNT(*) AS count FROM users WHERE role_key='platform-admin' AND enabled=1 AND account<>?").get(account)).count;
        if (!remaining) return json(res, 400, { message: "系统必须至少保留一个启用的平台管理员" });
      }
      const now = new Date().toISOString();
      await db.prepare("UPDATE users SET name=?,role=?,role_key=?,workspace=?,enabled=?,updated_at=? WHERE account=?").run(name, role.label, role.key, role.workspace, enabled ? 1 : 0, now, account);
      if (!enabled || current.role_key !== role.key) await revokeUserAuth(account);
      return json(res, 200, parseUser(await db.prepare("SELECT * FROM users WHERE account=?").get(account)));
    }
    if (userMatch && req.method === "DELETE") {
      const actor = await requirePermission(req, res, "accounts:manage"); if (!actor) return;
      const account = decodeURIComponent(userMatch[1]); const current = await db.prepare("SELECT * FROM users WHERE account=?").get(account);
      if (!current) return json(res, 404, { message: "账号不存在" });
      if (actor.account === account) return json(res, 400, { message: "不能删除当前登录账号" });
      if (current.role_key === "platform-admin" && current.enabled) {
        const remaining = (await db.prepare("SELECT COUNT(*) AS count FROM users WHERE role_key='platform-admin' AND enabled=1 AND account<>?").get(account)).count;
        if (!remaining) return json(res, 400, { message: "系统必须至少保留一个启用的平台管理员" });
      }
      await db.transaction(async () => {
        await revokeUserAuth(account);
        await db.prepare("DELETE FROM users WHERE account=?").run(account);
      });
      return json(res, 200, { ok: true, account });
    }
    const resetPasswordMatch = url.pathname.match(/^\/api\/users\/([^/]+)\/reset-password$/);
    if (resetPasswordMatch && req.method === "POST") {
      const actor = await requirePermission(req, res, "accounts:manage"); if (!actor) return;
      const account = decodeURIComponent(resetPasswordMatch[1]);
      if (!await db.prepare("SELECT 1 FROM users WHERE account=?").get(account)) return json(res, 404, { message: "账号不存在" });
      const body = await readJson(req); const password = String(body.password || "");
      await rotateUserPassword(account, password);
      return json(res, 200, { ok: true, account, currentSessionRevoked: actor.account === account });
    }
    const totpMatch = url.pathname.match(/^\/api\/users\/([^/]+)\/totp\/(setup|enable|disable)$/);
    if (totpMatch && req.method === "POST") {
      const actor = await requirePermission(req, res, "accounts:manage"); if (!actor) return;
      const account = decodeURIComponent(totpMatch[1]);
      const current = await db.prepare("SELECT * FROM users WHERE account=?").get(account);
      if (!current) return json(res, 404, { message: "账号不存在" });
      if (totpMatch[2] === "setup") return json(res, 200, await createTotpSetup(account));
      if (totpMatch[2] === "disable") {
        await db.prepare("UPDATE users SET totp_secret_enc=NULL,totp_enabled=0,updated_at=? WHERE account=?").run(new Date().toISOString(), account);
        await revokeUserAuth(account);
        return json(res, 200, { ok: true, account, totpEnabled: false, currentSessionRevoked: actor.account === account });
      }
      const body = await readJson(req);
      const setupHash = tokenHash(String(body.setupToken || ""));
      const now = new Date().toISOString();
      const setup = await db.prepare("SELECT * FROM auth_challenges WHERE token_hash=? AND account=? AND purpose='totp_setup' AND expires_at>?").get(setupHash, account, now);
      if (!setup) return json(res, 401, { message: "动态码设置已过期，请重新生成密钥" });
      if (setup.attempts >= 5) {
        await db.prepare("DELETE FROM auth_challenges WHERE token_hash=?").run(setupHash);
        return json(res, 401, { message: "动态码错误次数过多，请重新生成密钥" });
      }
      const details = parseJson(setup.details_json, {});
      let secret = "";
      try { secret = decrypt(details.totpSecretEnc || ""); } catch {}
      if (!secret || !verifyTotpCode({ secret, code: body.code })) {
        await db.prepare("UPDATE auth_challenges SET attempts=attempts+1 WHERE token_hash=?").run(setupHash);
        return json(res, 401, { message: "动态验证码不正确" });
      }
      await db.prepare("UPDATE users SET totp_secret_enc=?,totp_enabled=1,updated_at=? WHERE account=?").run(encrypt(secret), new Date().toISOString(), account);
      await revokeUserAuth(account);
      return json(res, 200, { ok: true, account, totpEnabled: true, currentSessionRevoked: actor.account === account });
    }
    if (req.method === "GET" && url.pathname === "/api/targets") {
      if (!await requirePermission(req, res, "targets:read")) return;
      const tenantId = await requireTenantContext(req, res, url.searchParams.get("tenant_id")); if (!tenantId) return;
      const rows = await db.prepare("SELECT * FROM monitoring_targets WHERE tenant_id=? ORDER BY updated_at DESC").all(tenantId);
      return json(res, 200, rows.map(parseTarget));
    }
    if (req.method === "POST" && url.pathname === "/api/targets") {
      if (!await requirePermission(req, res, "targets:manage")) return;
      const body = await readJson(req); const id = `OBJ-${randomBytes(5).toString("hex").toUpperCase()}`;
      const tenantId = await requireTenantContext(req, res, body.tenantId); if (!tenantId) return;
      const tenant = { id: tenantId };
      await db.prepare("INSERT INTO monitoring_targets (id,name,target_type,owner,domains_json,ips_json,keywords_json,enabled,updated_at,tenant_id) VALUES (?,?,?,?,?,?,?,?,?,?)").run(id, body.name, body.targetType || "企业", body.owner || "待分配", JSON.stringify(body.domains || []), JSON.stringify(body.ips || []), JSON.stringify(body.keywords || []), body.enabled === false ? 0 : 1, new Date().toISOString(), tenant.id);
      return json(res, 201, parseTarget(await db.prepare("SELECT * FROM monitoring_targets WHERE id=?").get(id)));
    }
    const targetMatch = url.pathname.match(/^\/api\/targets\/([^/]+)$/);
    if (targetMatch && req.method === "GET") {
      if (!await requirePermission(req, res, "targets:read")) return;
      const tenantId = await requireTenantContext(req, res); if (!tenantId) return;
      const current = await db.prepare("SELECT * FROM monitoring_targets WHERE id=? AND tenant_id=?").get(targetMatch[1], tenantId);
      return current ? json(res, 200, parseTarget(current)) : json(res, 404, { message: "监测对象不存在" });
    }
    if (targetMatch && req.method === "PUT") {
      if (!await requirePermission(req, res, "targets:manage")) return;
      const tenantId = await requireTenantContext(req, res); if (!tenantId) return;
      const current = await db.prepare("SELECT * FROM monitoring_targets WHERE id=? AND tenant_id=?").get(targetMatch[1], tenantId); if (!current) return json(res, 404, { message: "监测对象不存在" });
      const body = await readJson(req); await db.prepare("UPDATE monitoring_targets SET name=?,target_type=?,owner=?,domains_json=?,ips_json=?,keywords_json=?,enabled=?,updated_at=? WHERE id=?").run(body.name, body.targetType, body.owner, JSON.stringify(body.domains || []), JSON.stringify(body.ips || []), JSON.stringify(body.keywords || []), body.enabled === false ? 0 : 1, new Date().toISOString(), targetMatch[1]);
      return json(res, 200, parseTarget(await db.prepare("SELECT * FROM monitoring_targets WHERE id=?").get(targetMatch[1])));
    }
    if (targetMatch && req.method === "DELETE") {
      if (!await requirePermission(req, res, "targets:manage")) return;
      const tenantId = await requireTenantContext(req, res); if (!tenantId) return;
      const id = targetMatch[1]; const current = await db.prepare("SELECT * FROM monitoring_targets WHERE id=? AND tenant_id=?").get(id, tenantId);
      if (!current) return json(res, 404, { message: "监测对象不存在" });
      const referenceTables = [
        ["数据接口", "api_connections"], ["凭据订阅", "credential_subscriptions"], ["录入批次", "ingestion_batches"],
        ["敏感信息", "sensitive_records"], ["资产记录", "asset_records"], ["资产报告", "asset_reports"], ["暗网情报", "dark_web_events"]
      ];
      const references = (await Promise.all(referenceTables.map(async ([label, table]) => ({ label, count: (await db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE target_id=?`).get(id)).count })))).filter((item) => item.count > 0);
      if (references.length) return json(res, 409, { message: `该监测对象仍关联${references.map((item) => `${item.count} 条${item.label}`).join("、")}，请先解除关联或停用对象` });
      await db.prepare("DELETE FROM monitoring_targets WHERE id=?").run(id);
      return json(res, 200, { ok: true, id });
    }
    if (req.method === "GET" && url.pathname === "/api/connections") {
      if (!await requirePermission(req, res, "sources:read")) return;
      const tenantId = await requireTenantContext(req, res, url.searchParams.get("tenant_id")); if (!tenantId) return;
      const rows = await db.prepare("SELECT api_connections.*,monitoring_targets.name AS target_name FROM api_connections LEFT JOIN monitoring_targets ON monitoring_targets.id=api_connections.target_id WHERE api_connections.tenant_id=? ORDER BY api_connections.id").all(tenantId);
      return json(res, 200, rows.map(parseConnection));
    }
    if (req.method === "GET" && url.pathname === "/api/connector-providers") {
      if (!await requirePermission(req, res, "sources:read")) return;
      return json(res, 200, Object.entries(connectorProviders).map(([type, provider]) => ({ type, label: provider.label, defaultCategory: provider.defaultCategory, supportsSync: Boolean(provider.sync) })));
    }
    if (req.method === "POST" && url.pathname === "/api/connections") {
      if (!await requirePermission(req, res, "sources:manage")) return;
      const body = await readJson(req); const id = `API-${randomBytes(4).toString("hex").toUpperCase()}`; const providerType = String(body.providerType || "generic_json"); const provider = connectorProviders[providerType];
      if (!provider) return json(res, 400, { message: "不支持的连接器类型" });
      const tenantId = await requireTenantContext(req, res, body.tenantId); if (!tenantId) return;
      await tenantIdForTarget(body.targetId, tenantId);
      const endpoint = assertEndpoint(body.endpoint); const config = body.config && typeof body.config === "object" ? { ...body.config } : {};
      if (providerType === "watchvuln" && config.autoPublish === undefined) config.autoPublish = true;
      await db.prepare("INSERT INTO api_connections (id,name,category,provider_type,endpoint,method,auth_mode,api_key_enc,target_id,config_json,enabled,status,success_rate,quota,last_called,tenant_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(id, String(body.name || provider.label).trim(), body.category || provider.defaultCategory, providerType, endpoint, body.method || (["hunter_asset", "watchvuln"].includes(providerType) ? "GET" : "POST"), body.apiKey ? "API Key" : "无认证", body.apiKey ? encrypt(String(body.apiKey)) : null, body.targetId, JSON.stringify(config), body.enabled === false ? 0 : 1, "未配置", 0, providerType === "darkweb_subscription" ? "sub/list + sub/data" : providerType === "watchvuln" ? "本地 Feed" : "按供应商配额", "从未调用", tenantId);
      return json(res, 201, parseConnection(await db.prepare("SELECT api_connections.*,monitoring_targets.name AS target_name FROM api_connections LEFT JOIN monitoring_targets ON monitoring_targets.id=api_connections.target_id WHERE api_connections.id=?").get(id)));
    }
    if (req.method === "POST" && url.pathname === "/api/connections/test-config") {
      if (!await requirePermission(req, res, "sources:manage")) return;
      const body = await readJson(req);
      const providerType = String(body.providerType || "generic_json"); if (!connectorProviders[providerType]) return json(res, 400, { message: "不支持的连接器类型" });
      const targetId = managedText(body.targetId, "监测对象", { required: true, max: 100 });
      const tenantId = await requireTenantContext(req, res, body.tenantId); if (!tenantId) return;
      await tenantIdForTarget(targetId, tenantId);
      const result = await testConnection({ provider_type: providerType, endpoint: assertEndpoint(body.endpoint), method: body.method || "GET", api_key_enc: body.apiKey ? encrypt(String(body.apiKey)) : null, target_id: targetId, tenant_id: tenantId, config_json: JSON.stringify(body.config && typeof body.config === "object" ? body.config : {}) });
      return json(res, 200, result);
    }
    const connectionMatch = url.pathname.match(/^\/api\/connections\/([^/]+)$/);
    if (connectionMatch && req.method === "GET") {
      if (!await requirePermission(req, res, "sources:read")) return;
      const tenantId = await requireTenantContext(req, res); if (!tenantId) return;
      const current = await db.prepare("SELECT api_connections.*,monitoring_targets.name AS target_name FROM api_connections LEFT JOIN monitoring_targets ON monitoring_targets.id=api_connections.target_id WHERE api_connections.id=? AND api_connections.tenant_id=?").get(connectionMatch[1], tenantId);
      return current ? json(res, 200, parseConnection(current)) : json(res, 404, { message: "接口不存在" });
    }
    if (connectionMatch && req.method === "PUT") {
      if (!await requirePermission(req, res, "sources:manage")) return;
      const body = await readJson(req); const tenantContext = await requireTenantContext(req, res, body.tenantId); if (!tenantContext) return;
      const current = await db.prepare("SELECT * FROM api_connections WHERE id=? AND tenant_id=?").get(connectionMatch[1], tenantContext); if (!current) return json(res, 404, { message: "接口不存在" });
      const providerType = String(body.providerType || current.provider_type); if (!connectorProviders[providerType]) return json(res, 400, { message: "不支持的连接器类型" });
      const targetId = body.targetId || current.target_id; const tenantId = await tenantIdForTarget(targetId, tenantContext);
      await db.prepare("UPDATE api_connections SET name=?,category=?,provider_type=?,endpoint=?,method=?,auth_mode=?,api_key_enc=?,target_id=?,config_json=?,enabled=?,tenant_id=? WHERE id=?").run(body.name, body.category, providerType, assertEndpoint(body.endpoint), body.method || current.method, body.apiKey || current.api_key_enc ? "API Key" : "无认证", body.apiKey ? encrypt(String(body.apiKey)) : current.api_key_enc, targetId, JSON.stringify(body.config && typeof body.config === "object" ? body.config : parseJson(current.config_json)), body.enabled === undefined ? current.enabled : body.enabled ? 1 : 0, tenantId, connectionMatch[1]);
      return json(res, 200, parseConnection(await db.prepare("SELECT api_connections.*,monitoring_targets.name AS target_name FROM api_connections LEFT JOIN monitoring_targets ON monitoring_targets.id=api_connections.target_id WHERE api_connections.id=?").get(connectionMatch[1])));
    }
    if (connectionMatch && req.method === "DELETE") {
      if (!await requirePermission(req, res, "sources:manage")) return;
      const tenantId = await requireTenantContext(req, res); if (!tenantId) return;
      const current = await db.prepare("SELECT id FROM api_connections WHERE id=? AND tenant_id=?").get(connectionMatch[1], tenantId);
      if (!current) return json(res, 404, { message: "接口不存在" });
      await db.prepare("DELETE FROM api_connections WHERE id=?").run(connectionMatch[1]);
      return json(res, 200, { ok: true, id: connectionMatch[1] });
    }
    const testMatch = url.pathname.match(/^\/api\/connections\/([^/]+)\/(test|sync)$/);
    if (testMatch && req.method === "POST") {
      if (!await requirePermission(req, res, "sources:manage")) return;
      const tenantId = await requireTenantContext(req, res); if (!tenantId) return;
      const row = await db.prepare("SELECT * FROM api_connections WHERE id=? AND tenant_id=?").get(testMatch[1], tenantId); if (!row) return json(res, 404, { message: "接口不存在" });
      if (testMatch[2] === "sync") {
        const queued = await collectionJobs.requestConnectionSync(row.id);
        return json(res, 202, queued);
      }
      try {
        const result = await testConnection(row); const now = new Date().toISOString();
        await db.prepare("UPDATE api_connections SET status=?,success_rate=?,last_called=?,last_test_message=?,last_test_at=?,last_sync_at=?,consecutive_failures=? WHERE id=?").run(result.ok ? "正常" : "异常", result.ok ? 100 : 0, "刚刚", result.message, now, testMatch[2] === "sync" && result.ok ? now : row.last_sync_at, result.ok ? 0 : Number(row.consecutive_failures || 0) + 1, row.id);
        if (!result.ok) throw Object.assign(new Error("连接器检测失败"), { statusCode: 502 });
        return json(res, 200, result);
      } catch (error) {
        await db.prepare("UPDATE api_connections SET status='异常',success_rate=0,last_called='刚刚',last_test_message=?,last_test_at=?,consecutive_failures=consecutive_failures+1 WHERE id=?").run("连接器检测失败，请检查配置后重试", new Date().toISOString(), row.id);
        throw error;
      }
    }
    if (req.method === "GET" && url.pathname === "/api/worker-nodes") {
      if (!await requirePermission(req, res, "operations:manage")) return;
      return json(res, 200, await listWorkerNodes());
    }
    if (req.method === "POST" && url.pathname === "/api/worker-nodes") {
      if (!await requirePermission(req, res, "operations:manage")) return;
      const body = await readJson(req);
      const nodeId = managedText(body.nodeId, "节点 ID", { required: true, max: 100 });
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(nodeId)) return json(res, 400, { message: "节点 ID 只能包含字母、数字、点、下划线、冒号和连字符" });
      if (await db.prepare("SELECT node_id FROM worker_nodes WHERE node_id=?").get(nodeId)) return json(res, 409, { message: "Worker 节点 ID 已存在" });
      const displayName = managedText(body.displayName || nodeId, "节点名称", { required: true, max: 120 });
      const description = managedText(body.description, "节点说明", { max: 500 });
      const now = new Date().toISOString();
      await db.prepare(`INSERT INTO worker_nodes
        (node_id,display_name,description,desired_state,registered_at,updated_at)
        VALUES (?,?,?,'disabled',?,?)`).run(nodeId, displayName, description, now, now);
      return json(res, 201, (await listWorkerNodes()).find((item) => item.nodeId === nodeId));
    }
    const workerNodeMatch = url.pathname.match(/^\/api\/worker-nodes\/([^/]+)$/);
    if (workerNodeMatch && req.method === "PUT") {
      if (!await requirePermission(req, res, "operations:manage")) return;
      const nodeId = decodeURIComponent(workerNodeMatch[1]);
      const current = await db.prepare("SELECT * FROM worker_nodes WHERE node_id=?").get(nodeId);
      if (!current) return json(res, 404, { message: "Worker 节点不存在" });
      const body = await readJson(req);
      const desiredState = String(body.desiredState || current.desired_state);
      if (!["active", "draining", "disabled"].includes(desiredState)) return json(res, 400, { message: "Worker 节点状态不合法" });
      const displayName = managedText(body.displayName ?? current.display_name, "节点名称", { required: true, max: 120 });
      const description = managedText(body.description ?? current.description, "节点说明", { max: 500 });
      await db.prepare("UPDATE worker_nodes SET display_name=?,description=?,desired_state=?,updated_at=? WHERE node_id=?")
        .run(displayName, description, desiredState, new Date().toISOString(), nodeId);
      return json(res, 200, (await listWorkerNodes()).find((item) => item.nodeId === nodeId));
    }
    if (workerNodeMatch && req.method === "DELETE") {
      if (!await requirePermission(req, res, "operations:manage")) return;
      const nodeId = decodeURIComponent(workerNodeMatch[1]);
      const current = await db.prepare("SELECT * FROM worker_nodes WHERE node_id=?").get(nodeId);
      if (!current) return json(res, 404, { message: "Worker 节点不存在" });
      if (current.desired_state !== "disabled") return json(res, 409, { message: "请先禁用 Worker 节点，再清理离线记录" });
      const staleBefore = new Date(Date.now() - 15_000).toISOString();
      const live = Number((await db.prepare("SELECT COUNT(*) AS count FROM worker_instances WHERE node_id=? AND status='running' AND last_heartbeat_at>=?").get(nodeId, staleBefore)).count);
      if (live > 0) return json(res, 409, { message: "Worker 节点仍在线，不能清理" });
      await db.prepare("DELETE FROM worker_nodes WHERE node_id=?").run(nodeId);
      return json(res, 200, { deleted: true, nodeId });
    }
    const backgroundRunDetailMatch = url.pathname.match(/^\/api\/background-runs\/([^/]+)$/);
    if (backgroundRunDetailMatch && req.method === "GET") {
      if (!await requirePermission(req, res, "operations:manage")) return;
      const bullmqJobId = decodeURIComponent(backgroundRunDetailMatch[1]);
      const rows = await db.prepare(`${backgroundRunSelect} WHERE r.bullmq_job_id=? ORDER BY r.attempt,r.id`).all(bullmqJobId);
      if (!rows.length) return json(res, 404, { message: "任务运行记录不存在" });
      const attempts = rows.map((row) => parseBackgroundRun({ ...row, attempt_count: rows.length }));
      return json(res, 200, { ...attempts.at(-1), attempts });
    }
    if (req.method === "GET" && url.pathname === "/api/background-runs") {
      if (!await requirePermission(req, res, "operations:manage")) return;
      const where = ["rank=1"];
      const params = [];
      const state = url.searchParams.get("state");
      const roleFilter = url.searchParams.get("role");
      const taskIdentifier = url.searchParams.get("task_identifier");
      const aggregateId = url.searchParams.get("aggregate_id");
      const requestedTenantId = url.searchParams.get("tenant_id");
      const attention = url.searchParams.get("attention") === "true";
      if (state === "running") where.push("status='running'");
      else if (state === "succeeded") where.push("status='succeeded'");
      else if (state === "retrying") where.push("status='failed' AND will_retry=TRUE");
      else if (state === "failed") where.push("status='failed' AND COALESCE(will_retry,FALSE)=FALSE");
      if (roleFilter) { where.push("queue_role=?"); params.push(roleFilter); }
      if (taskIdentifier) { where.push("task_identifier=?"); params.push(taskIdentifier); }
      if (aggregateId) { where.push("aggregate_id=?"); params.push(aggregateId); }
      if (requestedTenantId) {
        const tenantId = await requireTenantContext(req, res, requestedTenantId); if (!tenantId) return;
        where.push("tenant_id=?"); params.push(tenantId);
      }
      if (attention) where.push("(error_message IS NOT NULL OR resolved_notice_message IS NOT NULL)");
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") || 30)));
      const rows = await db.prepare(`WITH attempts AS (${backgroundRunSelect}), ranked_attempts AS (
        SELECT attempts.*,ROW_NUMBER() OVER (PARTITION BY bullmq_job_id ORDER BY attempt DESC,id DESC) AS rank,
          COUNT(*) OVER (PARTITION BY bullmq_job_id) AS attempt_count FROM attempts
      ) SELECT * FROM ranked_attempts WHERE ${where.join(" AND ")} ORDER BY started_at DESC LIMIT ?`).all(...params, limit);
      return json(res, 200, { items: rows.map(parseBackgroundRun) });
    }
    if (req.method === "GET" && url.pathname === "/api/background-tasks") {
      if (!await requirePermission(req, res, "operations:manage")) return;
      const schedules = await backgroundSchedules.list();
      const scheduleById = new Map(schedules.map((schedule) => [schedule.identifier, schedule]));
      const snapshotStatuses = await db.prepare("SELECT status,COUNT(*) AS count FROM edge_snapshot_jobs GROUP BY status").all();
      const collectionStatuses = await db.prepare("SELECT status,COUNT(*) AS count FROM collection_runs GROUP BY status").all();
      const queue = await bullmq.stats();
      const pendingOutbox = await db.prepare("SELECT COUNT(*) AS count,MIN(created_at) AS oldest FROM background_task_outbox WHERE status='pending'").get();
      queue.pending += Number(pendingOutbox.count || 0);
      if (pendingOutbox.oldest) queue.oldestWaitingMs = Math.max(queue.oldestWaitingMs, Date.now() - new Date(pendingOutbox.oldest).getTime());
      const workers = await workerHealth();
      const since = new Date(Date.now() - 3_600_000).toISOString();
      const metrics = await db.prepare(`WITH latest AS (
        SELECT DISTINCT ON (bullmq_job_id) bullmq_job_id,status,will_retry,duration_ms
        FROM background_task_runs WHERE started_at>=? ORDER BY bullmq_job_id,attempt DESC,id DESC
      ) SELECT COUNT(*) AS jobs,
        COUNT(*) FILTER (WHERE status='succeeded') AS succeeded,
        COUNT(*) FILTER (WHERE status='failed' AND COALESCE(will_retry,FALSE)=FALSE) AS failed,
        COUNT(*) FILTER (WHERE status='failed' AND will_retry=TRUE) AS retrying,
        COALESCE(ROUND(AVG(duration_ms))::INTEGER,0) AS average_duration_ms,
        COALESCE(ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_ms))::INTEGER,0) AS p95_duration_ms
        FROM latest`).get(since);
      const retryAttempts = Number((await db.prepare("SELECT COUNT(*) AS count FROM background_task_runs WHERE started_at>=? AND attempt>1").get(since)).count || 0);
      const completedJobs = Number(metrics.succeeded) + Number(metrics.failed);
      return json(res, 200, {
        timezone: "Asia/Shanghai",
        catalog: BACKGROUND_TASK_CATALOG.map((task) => {
          const schedule = scheduleById.get(task.identifier);
          return schedule ? { ...task, ...schedule, schedule: describeSchedule(schedule) } : { ...task, enabled: true, schedule: "按需", nextRunAt: null, lastEnqueuedAt: null };
        }),
        queue,
        workers,
        observability: {
          lastHour: {
            jobs: Number(metrics.jobs),
            succeeded: Number(metrics.succeeded),
            failed: Number(metrics.failed),
            retrying: Number(metrics.retrying),
            retryAttempts,
            successRate: completedJobs ? Math.round(Number(metrics.succeeded) * 10_000 / completedJobs) / 100 : null,
            averageDurationMs: Number(metrics.average_duration_ms),
            p95DurationMs: Number(metrics.p95_duration_ms)
          }
        },
        business: {
          snapshots: Object.fromEntries(snapshotStatuses.map((row) => [row.status, Number(row.count)])),
          collections: Object.fromEntries(collectionStatuses.map((row) => [row.status, Number(row.count)]))
        }
      });
    }
    const backgroundScheduleMatch = url.pathname.match(/^\/api\/background-tasks\/([^/]+)\/schedule$/);
    if (backgroundScheduleMatch && req.method === "PUT") {
      if (!await requirePermission(req, res, "operations:manage")) return;
      const schedule = await backgroundSchedules.update(decodeURIComponent(backgroundScheduleMatch[1]), await readJson(req));
      return json(res, 200, { ...schedule, schedule: describeSchedule(schedule) });
    }
    const backgroundRunMatch = url.pathname.match(/^\/api\/background-tasks\/([^/]+)\/run$/);
    if (backgroundRunMatch && req.method === "POST") {
      if (!await requirePermission(req, res, "operations:manage")) return;
      return json(res, 202, await backgroundSchedules.runNow(decodeURIComponent(backgroundRunMatch[1])));
    }
    if (req.method === "GET" && url.pathname === "/api/collection-jobs") {
      if (!await requirePermission(req, res, "operations:manage")) return;
      const tenantId = await requireTenantContext(req, res, url.searchParams.get("tenant_id")); if (!tenantId) return;
      const rows = await db.prepare("SELECT collection_jobs.*,api_connections.name AS connection_name,api_connections.provider_type FROM collection_jobs JOIN api_connections ON api_connections.id=collection_jobs.connection_id WHERE api_connections.tenant_id=? ORDER BY collection_jobs.created_at DESC").all(tenantId);
      return json(res, 200, rows.map(parseCollectionJob));
    }
    if (req.method === "POST" && url.pathname === "/api/collection-jobs") {
      if (!await requirePermission(req, res, "operations:manage")) return;
      const body = await readJson(req); const tenantId = await requireTenantContext(req, res, body.tenantId); if (!tenantId) return;
      const connection = await db.prepare("SELECT id,name FROM api_connections WHERE id=? AND tenant_id=?").get(body.connectionId, tenantId); if (!connection) return json(res, 400, { message: "当前租户下不存在该连接器" });
      const interval = Math.min(10080, Math.max(5, Number(body.intervalMinutes || 60))); const now = new Date().toISOString(); const id = `JOB-${randomBytes(5).toString("hex").toUpperCase()}`;
      const managed = await db.prepare("SELECT * FROM collection_jobs WHERE connection_id=? AND system_managed=1").get(connection.id);
      const jobId = managed?.id || id;
      if (managed) {
        await db.prepare("UPDATE collection_jobs SET name=?,enabled=?,interval_minutes=?,timeout_seconds=?,retry_limit=?,next_run_at=?,updated_at=?,system_managed=0 WHERE id=?")
          .run(String(body.name || `${connection.name} 定时采集`).trim(), body.enabled ? 1 : 0, interval, Math.min(600, Math.max(5, Number(body.timeoutSeconds || 60))), Math.min(10, Math.max(0, Number(body.retryLimit ?? 2))), body.enabled ? nextRunAt(interval) : null, now, managed.id);
      } else {
        await db.prepare("INSERT INTO collection_jobs (id,connection_id,name,enabled,interval_minutes,timeout_seconds,retry_limit,next_run_at,last_status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(id, connection.id, String(body.name || `${connection.name} 定时采集`).trim(), body.enabled ? 1 : 0, interval, Math.min(600, Math.max(5, Number(body.timeoutSeconds || 60))), Math.min(10, Math.max(0, Number(body.retryLimit ?? 2))), body.enabled ? nextRunAt(interval) : null, "从未运行", now, now);
      }
      const row = await db.prepare("SELECT collection_jobs.*,api_connections.name AS connection_name,api_connections.provider_type FROM collection_jobs JOIN api_connections ON api_connections.id=collection_jobs.connection_id WHERE collection_jobs.id=?").get(jobId); return json(res, 201, parseCollectionJob(row));
    }
    const jobMatch = url.pathname.match(/^\/api\/collection-jobs\/([^/]+)$/);
    if (jobMatch && req.method === "PUT") {
      if (!await requirePermission(req, res, "operations:manage")) return;
      const body = await readJson(req); const tenantId = await requireTenantContext(req, res, body.tenantId); if (!tenantId) return;
      const current = await db.prepare("SELECT collection_jobs.* FROM collection_jobs JOIN api_connections ON api_connections.id=collection_jobs.connection_id WHERE collection_jobs.id=? AND api_connections.tenant_id=?").get(jobMatch[1], tenantId); if (!current) return json(res, 404, { message: "采集任务不存在" });
      const interval = Math.min(10080, Math.max(5, Number(body.intervalMinutes || current.interval_minutes))); const enabled = body.enabled === undefined ? Boolean(current.enabled) : Boolean(body.enabled); const now = new Date().toISOString();
      const next = enabled ? (!current.enabled || interval !== Number(current.interval_minutes) ? nextRunAt(interval) : current.next_run_at || nextRunAt(interval)) : null;
      await db.prepare("UPDATE collection_jobs SET name=?,enabled=?,interval_minutes=?,timeout_seconds=?,retry_limit=?,next_run_at=?,updated_at=? WHERE id=?").run(body.name || current.name, enabled ? 1 : 0, interval, Math.min(600, Math.max(5, Number(body.timeoutSeconds || current.timeout_seconds))), Math.min(10, Math.max(0, Number(body.retryLimit ?? current.retry_limit))), next, now, current.id);
      const row = await db.prepare("SELECT collection_jobs.*,api_connections.name AS connection_name,api_connections.provider_type FROM collection_jobs JOIN api_connections ON api_connections.id=collection_jobs.connection_id WHERE collection_jobs.id=?").get(current.id); return json(res, 200, parseCollectionJob(row));
    }
    if (jobMatch && req.method === "DELETE") {
      if (!await requirePermission(req, res, "operations:manage")) return;
      const tenantId = await requireTenantContext(req, res); if (!tenantId) return;
      const result = await db.prepare("DELETE FROM collection_jobs WHERE id=? AND connection_id IN (SELECT id FROM api_connections WHERE tenant_id=?)").run(jobMatch[1], tenantId); return result.changes ? json(res, 200, { ok: true }) : json(res, 404, { message: "采集任务不存在" });
    }
    const runJobMatch = url.pathname.match(/^\/api\/collection-jobs\/([^/]+)\/run$/);
    if (runJobMatch && req.method === "POST") {
      if (!await requirePermission(req, res, "operations:manage")) return;
      const tenantId = await requireTenantContext(req, res); if (!tenantId) return;
      const job = await db.prepare("SELECT collection_jobs.* FROM collection_jobs JOIN api_connections ON api_connections.id=collection_jobs.connection_id WHERE collection_jobs.id=? AND api_connections.tenant_id=?").get(runJobMatch[1], tenantId); if (!job) return json(res, 404, { message: "采集任务不存在" });
      const result = await collectionJobs.requestRun(job.id, { triggerType: "manual" }); return json(res, 202, result);
    }
    if (req.method === "GET" && url.pathname === "/api/collection-runs") {
      if (!await requirePermission(req, res, "operations:manage")) return; const jobId = url.searchParams.get("job_id");
      const tenantId = await requireTenantContext(req, res, url.searchParams.get("tenant_id")); if (!tenantId) return;
      const rows = jobId
        ? await db.prepare("SELECT collection_runs.* FROM collection_runs JOIN collection_jobs ON collection_jobs.id=collection_runs.job_id JOIN api_connections ON api_connections.id=collection_jobs.connection_id WHERE collection_runs.job_id=? AND api_connections.tenant_id=? ORDER BY collection_runs.started_at DESC LIMIT 100").all(jobId, tenantId)
        : await db.prepare("SELECT collection_runs.* FROM collection_runs JOIN collection_jobs ON collection_jobs.id=collection_runs.job_id JOIN api_connections ON api_connections.id=collection_jobs.connection_id WHERE api_connections.tenant_id=? ORDER BY collection_runs.started_at DESC LIMIT 100").all(tenantId);
      return json(res, 200, rows.map(parseCollectionRun));
    }
    if (req.method === "GET" && url.pathname === "/api/credentials/subscriptions") {
      if (!await requirePermission(req, res, "evidence:download")) return; const targetId = url.searchParams.get("target_id"); const since = String(url.searchParams.get("since") || "");
      const tenantId = await requireTenantContext(req, res, url.searchParams.get("tenant_id")); if (!tenantId) return;
      const clauses = ["credential_subscriptions.tenant_id=?"]; const params = [tenantId];
      if (targetId) { clauses.push("credential_subscriptions.target_id=?"); params.push(targetId); }
      const todayJoin = since ? "LEFT JOIN (SELECT sub_id,COUNT(*) AS today_new_count FROM credential_records WHERE first_seen_at>=? GROUP BY sub_id) today ON today.sub_id=credential_subscriptions.id" : "";
      const todaySelect = since ? "COALESCE(today.today_new_count,0)" : "0";
      const storedJoin = "LEFT JOIN (SELECT sub_id,COUNT(*) AS stored_count FROM credential_records GROUP BY sub_id) stored ON stored.sub_id=credential_subscriptions.id";
      if (since) params.unshift(since);
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      const rows = await db.prepare(`SELECT credential_subscriptions.*,monitoring_targets.name AS target_name,${todaySelect} AS today_new_count,COALESCE(stored.stored_count,0) AS stored_count FROM credential_subscriptions JOIN monitoring_targets ON monitoring_targets.id=credential_subscriptions.target_id ${todayJoin} ${storedJoin} ${where} ORDER BY credential_subscriptions.id`).all(...params);
      return json(res, 200, rows.map((row) => ({ id: row.id, targetId: row.target_id, targetName: row.target_name, subType: row.sub_type, subCategory: row.sub_category, value: row.value, expireTime: row.expire_time, count: row.count, storedCount: Number(row.stored_count) || 0, todayNewCount: Number(row.today_new_count) || 0 })));
    }
    if (req.method === "POST" && url.pathname === "/api/credentials/records") {
      if (!await requirePermission(req, res, "ingestion:manage")) return;
      const body = await readJson(req); const tenantId = await requireTenantContext(req, res, body.tenantId); if (!tenantId) return; const subId = Number(body.subId);
      const subscription = Number.isInteger(subId) ? await db.prepare("SELECT * FROM credential_subscriptions WHERE id=? AND tenant_id=?").get(subId, tenantId) : null;
      if (!subscription) return json(res, 400, { message: "请选择当前租户下有效的凭据订阅" });
      const urlValue = managedText(body.url, "系统地址", { required: true, max: 2000 });
      const systemName = managedText(body.systemName, "系统名称", { required: true, max: 300 });
      const account = managedText(body.account, "泄露账号", { required: true, max: 500 });
      const password = managedText(body.password, "泄露口令", { required: true, max: 1000 });
      const source = managedText(body.source, "情报来源", { required: true, max: 300 });
      const leakedAt = managedText(body.leakedAt, "泄露时间", { max: 80 }) || new Date().toISOString();
      const now = new Date().toISOString(); const id = `CRED-MANUAL-${randomBytes(8).toString("hex").toUpperCase()}`;
      const published = await publicationModeFor(tenantId, "credentials") === "auto";
      await db.prepare("INSERT INTO credential_records (id,sub_id,url,system_name,account,password,leaked_at,source,raw_json,first_seen_at,is_published,reviewed_at,tenant_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(id, subId, urlValue, systemName, account, password, leakedAt, source, JSON.stringify({ manual: true }), now, published, published ? now : null, tenantId);
      return json(res, 201, { id, subId, subCategory: subscription.sub_category, url: urlValue, systemName, account, password, leakedAt, firstSeenAt: now, source, isPublished: published, reviewedAt: published ? now : undefined });
    }
    const credentialPublishMatch = url.pathname.match(/^\/api\/credentials\/records\/([^/]+)\/publish$/);
    if (credentialPublishMatch && req.method === "POST") {
      if (!await requirePermission(req, res, "ingestion:manage")) return;
      const body = await readJson(req); const tenantId = await requireTenantContext(req, res, body.tenantId); if (!tenantId) return;
      const id = decodeURIComponent(credentialPublishMatch[1]);
      const row = await db.prepare(`SELECT credential_records.id,credential_subscriptions.tenant_id FROM credential_records
        JOIN credential_subscriptions ON credential_subscriptions.id=credential_records.sub_id WHERE credential_records.id=? AND credential_subscriptions.tenant_id=?`).get(id, tenantId);
      if (!row) return json(res, 404, { message: "账号凭据记录不存在" });
      const now = new Date().toISOString();
      await db.prepare("UPDATE credential_records SET is_published=TRUE,reviewed_at=? WHERE id=?").run(now, id);
      return json(res, 200, { ok: true, id, tenantId: row.tenant_id, publishedAt: now });
    }
    const credentialRecordMatch = url.pathname.match(/^\/api\/credentials\/records\/([^/]+)$/);
    if (credentialRecordMatch && req.method === "PUT") {
      if (!await requirePermission(req, res, "ingestion:manage")) return;
      const id = decodeURIComponent(credentialRecordMatch[1]); const body = await readJson(req); const tenantId = await requireTenantContext(req, res, body.tenantId); if (!tenantId) return; const subId = Number(body.subId);
      const current = await db.prepare(`SELECT credential_records.*,credential_subscriptions.tenant_id FROM credential_records JOIN credential_subscriptions ON credential_subscriptions.id=credential_records.sub_id WHERE credential_records.id=? AND credential_subscriptions.tenant_id=?`).get(id, tenantId);
      if (!current) return json(res, 404, { message: "当前租户下不存在该账号凭据" });
      const subscription = Number.isInteger(subId) ? await db.prepare("SELECT * FROM credential_subscriptions WHERE id=? AND tenant_id=?").get(subId, tenantId) : null;
      if (!subscription) return json(res, 400, { message: "请选择当前租户下有效的凭据订阅" });
      const urlValue = managedText(body.url, "系统地址", { required: true, max: 2000 }); const systemName = managedText(body.systemName, "系统名称", { required: true, max: 300 });
      const account = managedText(body.account, "泄露账号", { required: true, max: 500 }); const password = managedText(body.password, "泄露口令", { required: true, max: 1000 });
      const source = managedText(body.source, "情报来源", { required: true, max: 300 }); const leakedAt = managedText(body.leakedAt, "泄露时间", { required: true, max: 80 });
      await db.prepare("UPDATE credential_records SET sub_id=?,url=?,system_name=?,account=?,password=?,leaked_at=?,source=? WHERE id=?").run(subId, urlValue, systemName, account, password, leakedAt, source, id);
      return json(res, 200, { id, subId, subCategory: subscription.sub_category, url: urlValue, systemName, account, password, leakedAt, firstSeenAt: current.first_seen_at || leakedAt, source, isPublished: Boolean(current.is_published), reviewedAt: current.reviewed_at || undefined });
    }
    if (credentialRecordMatch && req.method === "DELETE") {
      if (!await requirePermission(req, res, "ingestion:manage")) return;
      const id = decodeURIComponent(credentialRecordMatch[1]); const body = await readJson(req); const tenantId = await requireTenantContext(req, res, body.tenantId); if (!tenantId) return;
      const result = await db.prepare("DELETE FROM credential_records WHERE id=? AND sub_id IN (SELECT id FROM credential_subscriptions WHERE tenant_id=?)").run(id, tenantId);
      return result.changes ? json(res, 200, { ok: true, id }) : json(res, 404, { message: "当前租户下不存在该账号凭据" });
    }
    if (req.method === "GET" && url.pathname === "/api/credentials/results") {
      const user = await requirePermission(req, res, "evidence:download"); if (!user) return; const subId = Number(url.searchParams.get("sub_id")); const page = Math.max(1, Number(url.searchParams.get("page") || 1)); const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get("page_size") || 10)));
      const since = String(url.searchParams.get("since") || ""); const todayOnly = url.searchParams.get("today_only") === "1";
      const tenantId = await requireTenantContext(req, res, url.searchParams.get("tenant_id")); if (!tenantId) return;
      if (!await db.prepare("SELECT id FROM credential_subscriptions WHERE id=? AND tenant_id=?").get(subId, tenantId)) return json(res, 404, { message: "当前租户下不存在该凭据订阅" });
      const publicationClause = canPreviewDrafts(user, url) ? "" : " AND credential_records.is_published=TRUE";
      const allTotal = Number((await db.prepare(`SELECT COUNT(*) AS count FROM credential_records WHERE sub_id=?${publicationClause}`).get(subId)).count);
      const todayNewCount = since ? Number((await db.prepare(`SELECT COUNT(*) AS count FROM credential_records WHERE sub_id=? AND first_seen_at>=?${publicationClause}`).get(subId, since)).count) : 0;
      const where = `${todayOnly && since ? "credential_records.sub_id=? AND credential_records.first_seen_at>=?" : "credential_records.sub_id=?"}${publicationClause}`;
      const params = todayOnly && since ? [subId, since] : [subId]; const total = todayOnly && since ? todayNewCount : allTotal;
      const rows = await db.prepare(`SELECT credential_records.*, credential_subscriptions.sub_category FROM credential_records JOIN credential_subscriptions ON credential_subscriptions.id=credential_records.sub_id WHERE credential_subscriptions.tenant_id=? AND ${where} ORDER BY leaked_at DESC LIMIT ? OFFSET ?`).all(tenantId, ...params, pageSize, (page - 1) * pageSize);
      return json(res, 200, { page, pageSize, total, allTotal, todayNewCount, next: null, data: rows.map((row, index) => {
        let raw = {};
        try { raw = row.raw_json ? JSON.parse(row.raw_json) : {}; } catch {}
        const fields = Object.keys(raw).length ? flattenFields(raw, raw.original_other || {}) : { account: row.account, password: row.password, leaked_at: row.leaked_at };
        const resolvedUrl = row.url && row.url !== row.source ? row.url : fields.url || fields.domain || fields.root_domain || "未知域名";
        let resolvedSystem = row.system_name && row.system_name !== row.source ? row.system_name : "";
        if (!resolvedSystem && resolvedUrl) { try { resolvedSystem = new URL(resolvedUrl.includes("://") ? resolvedUrl : `https://${resolvedUrl}`).hostname; } catch {} }
        if (!resolvedSystem) resolvedSystem = fields.domain || fields.root_domain || "未知系统";
        return { id: row.id, sequence: (page - 1) * pageSize + index + 1, url: resolvedUrl, systemName: resolvedSystem, account: row.account, password: row.password, leakedAt: row.leaked_at, firstSeenAt: row.first_seen_at || row.leaked_at, source: row.source, subId: row.sub_id, subCategory: row.sub_category, fields, isPublished: Boolean(row.is_published), reviewedAt: row.reviewed_at || undefined };
      }) });
    }
    if (!url.pathname.startsWith("/api/") && !url.pathname.startsWith("/edge/") && adminSite && await adminSite(req, res, url.pathname)) return;
    return json(res, 404, { message: "接口不存在" });
  } catch (error) {
    console.error(`[${auditRequestId}]`, error);
    if (res.headersSent) {
      res.destroy();
      return;
    }
    const response = createPublicErrorResponse(error, auditRequestId);
    return json(res, response.statusCode, response.body);
  }
};

const server = transportSecurity.enabled
  ? createHttpsServer(transportSecurity.serverOptions, requestHandler)
  : createHttpServer(requestHandler);

server.listen(port, host, () => { console.log(`Sentinel API listening on ${transportSecurity.protocol}://${host}:${port}`); console.log(`Transport security: ${transportSecurity.enabled ? "TLS 1.3 / TLS_AES_256_GCM_SHA384 / ECDHE" : "development HTTP (loopback only)"}`); console.log(`PostgreSQL database: ${databaseInfo.host}:${databaseInfo.port}/${databaseInfo.database} (${databaseInfo.schema})`); });
async function shutdown() {
  server.close(async () => {
    await snapshotJobs.release();
    if (databaseInfo.schema.startsWith("sentinel_test_") || databaseInfo.schema.startsWith("sentinel_e2e_")) await bullmq.obliterate();
    await bullmq.close();
    await closeDatabase();
    process.exit(0);
  });
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
