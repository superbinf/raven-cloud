export const CLOUD_EDGE_PROTOCOL_VERSION = 1;
export const EDGE_SNAPSHOT_SCHEMA_VERSION = 1;
export const MAX_DARK_WEB_ARTICLE_CHARS = 1_500_000;

export const SYNC_MODES = Object.freeze(["api_pull", "object_storage_pull"]);
export const EDGE_SYNC_STATUSES = Object.freeze(["idle", "syncing", "success", "failed", "offline"]);
export const EDGE_PORTAL_MODULES = Object.freeze(["overview", "dashboard", "search", "dark-web", "sensitive", "exposure", "vulnerabilities"]);
export const FINGERPRINT_ICON_SOURCES = Object.freeze(["upload", "favicon", "iconify", "simple-icons", "domestic", "provider", "custom"]);
export const RECORD_COUNT_KEYS = Object.freeze([
  "monitoringTargets",
  "sensitiveRecords",
  "assetRecords",
  "credentialSubscriptions",
  "credentialRecords",
  "darkWebEvents",
  "assetReports"
]);

export class ContractValidationError extends TypeError {
  constructor(issues) {
    super(`Contract validation failed: ${issues.join("; ")}`);
    this.name = "ContractValidationError";
    this.issues = issues;
    this.retryable = false;
    this.errorType = "validation";
    this.errorCode = "ContractValidationError";
  }
}

function fail(path, message) {
  throw new ContractValidationError([`${path}: ${message}`]);
}

function schema(name, parser) {
  return Object.freeze({
    name,
    parse(input) {
      try {
        return parser(input, "$");
      } catch (error) {
        if (error instanceof ContractValidationError) throw error;
        throw new ContractValidationError([`$: ${error instanceof Error ? error.message : String(error)}`]);
      }
    },
    safeParse(input) {
      try {
        return { success: true, data: this.parse(input) };
      } catch (error) {
        return { success: false, error };
      }
    }
  });
}

function object(input, path, allowedKeys) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) fail(path, "expected object");
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) fail(path, "expected plain object");
  const unexpected = Object.keys(input).filter((key) => !allowedKeys.includes(key));
  if (unexpected.length > 0) fail(path, `unexpected field(s): ${unexpected.join(", ")}`);
  return input;
}

function string(input, path, { min = 0, max = 100_000 } = {}) {
  if (typeof input !== "string") fail(path, "expected string");
  if (input.length < min) fail(path, `must contain at least ${min} character(s)`);
  if (input.length > max) fail(path, `must contain at most ${max} character(s)`);
  return input;
}

function nullableString(input, path, options) {
  return input === null ? null : string(input, path, options);
}

function identifier(input, path) {
  const value = string(input, path, { min: 1, max: 256 });
  if (value.trim() !== value || /[\x00-\x1f\x7f]/u.test(value)) fail(path, "must be a trimmed identifier without control characters");
  return value;
}

function integer(input, path, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(input)) fail(path, "expected safe integer");
  if (input < min || input > max) fail(path, `must be between ${min} and ${max}`);
  return input;
}

function boolean(input, path) {
  if (typeof input !== "boolean") fail(path, "expected boolean");
  return input;
}

function enumeration(input, path, values) {
  if (!values.includes(input)) fail(path, `expected one of: ${values.join(", ")}`);
  return input;
}

function isoDateTime(input, path) {
  const value = string(input, path, { min: 20, max: 40 });
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) || Number.isNaN(Date.parse(value))) {
    fail(path, "expected ISO-8601 timestamp with timezone");
  }
  return value;
}

function nullableIsoDateTime(input, path) {
  return input === null ? null : isoDateTime(input, path);
}

function array(input, path, itemParser, { max = 1_000_000 } = {}) {
  if (!Array.isArray(input)) fail(path, "expected array");
  if (input.length > max) fail(path, `must contain at most ${max} item(s)`);
  return input.map((item, index) => itemParser(item, `${path}[${index}]`));
}

function stringArray(input, path) {
  return array(input, path, (item, itemPath) => string(item, itemPath, { max: 4096 }));
}

function stringRecord(input, path) {
  const value = object(input, path, Object.keys(input ?? {}));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    string(key, `${path} key`, { min: 1, max: 256 }),
    string(item, `${path}.${key}`, { max: 100_000 })
  ]));
}

function jsonValue(input, path, seen = new Set()) {
  if (input === null || typeof input === "string" || typeof input === "boolean") return input;
  if (typeof input === "number") {
    if (!Number.isFinite(input)) fail(path, "JSON number must be finite");
    return input;
  }
  if (typeof input !== "object") fail(path, "expected JSON value");
  if (seen.has(input)) fail(path, "cyclic value is not allowed");
  seen.add(input);
  try {
    if (Array.isArray(input)) return input.map((item, index) => jsonValue(item, `${path}[${index}]`, seen));
    const value = object(input, path, Object.keys(input));
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      string(key, `${path} key`, { min: 1, max: 256 }),
      jsonValue(item, `${path}.${key}`, seen)
    ]));
  } finally {
    seen.delete(input);
  }
}

function parseTenant(input, path) {
  const value = object(input, path, ["id", "name"]);
  return {
    id: identifier(value.id, `${path}.id`),
    name: string(value.name, `${path}.name`, { min: 1, max: 512 })
  };
}

function parseMonitoringTarget(input, path) {
  const value = object(input, path, ["id", "name", "targetType", "owner", "domains", "ips", "keywords", "enabled", "updatedAt"]);
  return {
    id: identifier(value.id, `${path}.id`),
    name: string(value.name, `${path}.name`, { min: 1, max: 512 }),
    targetType: enumeration(value.targetType, `${path}.targetType`, ["企业", "品牌", "子公司", "供应商"]),
    owner: string(value.owner, `${path}.owner`, { min: 1, max: 512 }),
    domains: stringArray(value.domains, `${path}.domains`),
    ips: stringArray(value.ips, `${path}.ips`),
    keywords: stringArray(value.keywords, `${path}.keywords`),
    enabled: boolean(value.enabled, `${path}.enabled`),
    updatedAt: isoDateTime(value.updatedAt, `${path}.updatedAt`)
  };
}

function parseSensitiveRecord(input, path) {
  const value = object(input, path, ["id", "category", "targetId", "title", "risk", "fields", "firstSeenAt", "lastSeenAt", "importStatus", "importCount", "batchId"]);
  return {
    id: identifier(value.id, `${path}.id`),
    category: enumeration(value.category, `${path}.category`, ["account-password", "source-code", "documents", "phishing"]),
    targetId: value.targetId === null ? null : identifier(value.targetId, `${path}.targetId`),
    title: string(value.title, `${path}.title`, { min: 1, max: 4096 }),
    risk: string(value.risk, `${path}.risk`, { min: 1, max: 128 }),
    fields: stringRecord(value.fields, `${path}.fields`),
    firstSeenAt: isoDateTime(value.firstSeenAt, `${path}.firstSeenAt`),
    lastSeenAt: isoDateTime(value.lastSeenAt, `${path}.lastSeenAt`),
    importStatus: enumeration(value.importStatus, `${path}.importStatus`, ["新增", "已存在"]),
    importCount: integer(value.importCount, `${path}.importCount`, { min: 1 }),
    batchId: nullableString(value.batchId, `${path}.batchId`, { min: 1, max: 256 })
  };
}

function parseAssetRecord(input, path) {
  const value = object(input, path, ["id", "category", "targetId", "title", "risk", "fields", "firstSeenAt", "lastSeenAt", "importStatus", "importCount", "batchId", "changeType", "previousFields", "presentInLatestBatch", "previouslyPublished", "lastChangedAt", "missingSince"]);
  return {
    id: identifier(value.id, `${path}.id`),
    category: enumeration(value.category, `${path}.category`, ["subdomain", "server", "web", "fingerprint"]),
    targetId: value.targetId === null ? null : identifier(value.targetId, `${path}.targetId`),
    title: string(value.title, `${path}.title`, { min: 1, max: 4096 }),
    risk: string(value.risk, `${path}.risk`, { min: 1, max: 128 }),
    fields: stringRecord(value.fields, `${path}.fields`),
    firstSeenAt: isoDateTime(value.firstSeenAt, `${path}.firstSeenAt`),
    lastSeenAt: isoDateTime(value.lastSeenAt, `${path}.lastSeenAt`),
    importStatus: enumeration(value.importStatus, `${path}.importStatus`, ["新增", "已存在"]),
    importCount: integer(value.importCount, `${path}.importCount`, { min: 1 }),
    batchId: nullableString(value.batchId, `${path}.batchId`, { min: 1, max: 256 }),
    ...(value.changeType === undefined ? {} : { changeType: enumeration(value.changeType, `${path}.changeType`, ["baseline", "new", "changed", "reappeared", "missing", "unchanged"]) }),
    ...(value.previousFields === undefined ? {} : { previousFields: stringRecord(value.previousFields, `${path}.previousFields`) }),
    ...(value.presentInLatestBatch === undefined ? {} : { presentInLatestBatch: boolean(value.presentInLatestBatch, `${path}.presentInLatestBatch`) }),
    ...(value.previouslyPublished === undefined ? {} : { previouslyPublished: boolean(value.previouslyPublished, `${path}.previouslyPublished`) }),
    ...(value.lastChangedAt === undefined ? {} : { lastChangedAt: isoDateTime(value.lastChangedAt, `${path}.lastChangedAt`) }),
    ...(value.missingSince === undefined ? {} : { missingSince: isoDateTime(value.missingSince, `${path}.missingSince`) })
  };
}

function parseVulnerabilityRecord(input, path) {
  const keys = ["id", "targetId", "targetName", "title", "summary", "risk", "source", "cve", "disclosureAt", "solutions", "references", "tags", "sourceCreatedAt", "sourceUpdatedAt", "firstSeenAt", "lastSeenAt", "importCount", "status"];
  const value = object(input, path, keys);
  return {
    id: identifier(value.id, `${path}.id`),
    targetId: value.targetId === null ? null : identifier(value.targetId, `${path}.targetId`),
    targetName: string(value.targetName, `${path}.targetName`, { min: 1, max: 512 }),
    title: string(value.title, `${path}.title`, { min: 1, max: 4096 }),
    summary: string(value.summary, `${path}.summary`, { max: 100_000 }),
    risk: string(value.risk, `${path}.risk`, { min: 1, max: 128 }),
    source: string(value.source, `${path}.source`, { min: 1, max: 1024 }),
    cve: string(value.cve, `${path}.cve`, { max: 128 }),
    disclosureAt: value.disclosureAt === null ? null : isoDateTime(value.disclosureAt, `${path}.disclosureAt`),
    solutions: string(value.solutions, `${path}.solutions`, { max: 100_000 }),
    references: stringArray(value.references, `${path}.references`),
    tags: stringArray(value.tags, `${path}.tags`),
    sourceCreatedAt: isoDateTime(value.sourceCreatedAt, `${path}.sourceCreatedAt`),
    sourceUpdatedAt: isoDateTime(value.sourceUpdatedAt, `${path}.sourceUpdatedAt`),
    firstSeenAt: isoDateTime(value.firstSeenAt, `${path}.firstSeenAt`),
    lastSeenAt: isoDateTime(value.lastSeenAt, `${path}.lastSeenAt`),
    importCount: integer(value.importCount, `${path}.importCount`, { min: 1 }),
    status: string(value.status, `${path}.status`, { min: 1, max: 128 })
  };
}

function parseVulnerabilityAlert(input, path) {
  const keys = ["id", "vulnerabilityId", "vulnerabilityFirstSeenAt", "cve", "vulnerabilityTitle", "risk", "source", "disclosureAt", "watchGroupId", "watchGroupName", "watchItemId", "watchProduct", "assetRecordId", "assetTitle", "assetUrl", "assetIp", "assetPort", "targetId", "targetName", "matchedProduct", "assetVersion", "confidence", "matchType", "evidence", "status", "firstMatchedAt", "lastMatchedAt"];
  const value = object(input, path, keys);
  return {
    id: identifier(value.id, `${path}.id`), vulnerabilityId: identifier(value.vulnerabilityId, `${path}.vulnerabilityId`),
    ...(value.vulnerabilityFirstSeenAt === undefined ? {} : { vulnerabilityFirstSeenAt: isoDateTime(value.vulnerabilityFirstSeenAt, `${path}.vulnerabilityFirstSeenAt`) }),
    cve: string(value.cve, `${path}.cve`, { max: 128 }), vulnerabilityTitle: string(value.vulnerabilityTitle, `${path}.vulnerabilityTitle`, { min: 1, max: 4096 }),
    risk: string(value.risk, `${path}.risk`, { min: 1, max: 128 }), source: string(value.source, `${path}.source`, { min: 1, max: 1024 }),
    disclosureAt: value.disclosureAt === null ? null : isoDateTime(value.disclosureAt, `${path}.disclosureAt`),
    watchGroupId: identifier(value.watchGroupId, `${path}.watchGroupId`), watchGroupName: string(value.watchGroupName, `${path}.watchGroupName`, { min: 1, max: 512 }),
    watchItemId: identifier(value.watchItemId, `${path}.watchItemId`), watchProduct: string(value.watchProduct, `${path}.watchProduct`, { min: 1, max: 512 }),
    assetRecordId: value.assetRecordId === null ? null : identifier(value.assetRecordId, `${path}.assetRecordId`), assetTitle: string(value.assetTitle, `${path}.assetTitle`, { max: 4096 }),
    assetUrl: string(value.assetUrl, `${path}.assetUrl`, { max: 8192 }), assetIp: string(value.assetIp, `${path}.assetIp`, { max: 512 }), assetPort: string(value.assetPort, `${path}.assetPort`, { max: 128 }),
    targetId: value.targetId === null ? null : identifier(value.targetId, `${path}.targetId`), targetName: string(value.targetName, `${path}.targetName`, { min: 1, max: 512 }),
    matchedProduct: string(value.matchedProduct, `${path}.matchedProduct`, { min: 1, max: 512 }), assetVersion: string(value.assetVersion, `${path}.assetVersion`, { max: 128 }),
    confidence: enumeration(value.confidence, `${path}.confidence`, ["confirmed", "suspected", "review"]), matchType: enumeration(value.matchType, `${path}.matchType`, ["exact", "alias"]),
    evidence: stringRecord(value.evidence, `${path}.evidence`), status: enumeration(value.status, `${path}.status`, ["new", "acknowledged", "resolved", "ignored"]),
    firstMatchedAt: isoDateTime(value.firstMatchedAt, `${path}.firstMatchedAt`), lastMatchedAt: isoDateTime(value.lastMatchedAt, `${path}.lastMatchedAt`)
  };
}

function parseCredentialSubscription(input, path) {
  const value = object(input, path, ["id", "targetId", "subType", "subCategory", "value", "expireTime", "count"]);
  return {
    id: integer(value.id, `${path}.id`, { min: 1 }),
    targetId: identifier(value.targetId, `${path}.targetId`),
    subType: enumeration(value.subType, `${path}.subType`, ["credential-leak", "privacy-leak"]),
    subCategory: enumeration(value.subCategory, `${path}.subCategory`, ["phone", "email", "credential", "employee"]),
    value: string(value.value, `${path}.value`, { min: 1, max: 4096 }),
    expireTime: isoDateTime(value.expireTime, `${path}.expireTime`),
    count: integer(value.count, `${path}.count`, { min: 0 })
  };
}

function parseCredentialRecord(input, path) {
  const value = object(input, path, ["id", "subId", "url", "systemName", "account", "password", "leakedAt", "firstSeenAt", "source", "fields"]);
  const leakedAt = isoDateTime(value.leakedAt, `${path}.leakedAt`);
  return {
    id: identifier(value.id, `${path}.id`),
    subId: integer(value.subId, `${path}.subId`, { min: 1 }),
    url: string(value.url, `${path}.url`, { max: 8192 }),
    systemName: string(value.systemName, `${path}.systemName`, { max: 1024 }),
    account: string(value.account, `${path}.account`, { max: 4096 }),
    password: string(value.password, `${path}.password`, { max: 4096 }),
    leakedAt,
    firstSeenAt: value.firstSeenAt === undefined ? leakedAt : isoDateTime(value.firstSeenAt, `${path}.firstSeenAt`),
    source: string(value.source, `${path}.source`, { min: 1, max: 1024 }),
    fields: stringRecord(value.fields, `${path}.fields`)
  };
}

function parseDarkWebFileMetadata(input, path) {
  const value = object(input, path, ["id", "kind", "name", "sizeBytes", "sha256", "mediaType", "sheetCount", "rowCount", "columnCount", "cached"]);
  return {
    id: identifier(value.id, `${path}.id`),
    kind: enumeration(value.kind, `${path}.kind`, ["report", "attachment"]),
    name: string(value.name, `${path}.name`, { min: 1, max: 1024 }),
    sizeBytes: integer(value.sizeBytes, `${path}.sizeBytes`, { min: 0 }),
    sha256: hexDigest(value.sha256, `${path}.sha256`),
    mediaType: string(value.mediaType, `${path}.mediaType`, { min: 1, max: 256 }),
    sheetCount: integer(value.sheetCount, `${path}.sheetCount`, { min: 0 }),
    rowCount: integer(value.rowCount, `${path}.rowCount`, { min: 0 }),
    columnCount: integer(value.columnCount, `${path}.columnCount`, { min: 0 }),
    cached: boolean(value.cached, `${path}.cached`)
  };
}

function parseDarkWebEvent(input, path) {
  const keys = ["id", "targetId", "title", "risk", "reportDate", "sourceGroupName", "sourceGroupId", "sourceGroupUrl", "messageUrl", "intelTags", "leakDataTypes", "leakCount", "transactionCount", "transactionPrice", "publishedAt", "publisherId", "intelNote", "articleMarkdown", "firstSeenAt", "lastSeenAt", "importCount", "repeatedPropagationCount", "files"];
  const value = object(input, path, keys);
  return {
    id: identifier(value.id, `${path}.id`),
    targetId: identifier(value.targetId, `${path}.targetId`),
    title: string(value.title, `${path}.title`, { min: 1, max: 4096 }),
    risk: value.risk === undefined ? "low" : enumeration(value.risk, `${path}.risk`, ["critical", "high", "medium", "low"]),
    reportDate: string(value.reportDate, `${path}.reportDate`, { min: 1, max: 128 }),
    sourceGroupName: string(value.sourceGroupName, `${path}.sourceGroupName`, { max: 1024 }),
    sourceGroupId: string(value.sourceGroupId, `${path}.sourceGroupId`, { max: 1024 }),
    sourceGroupUrl: string(value.sourceGroupUrl, `${path}.sourceGroupUrl`, { max: 8192 }),
    messageUrl: string(value.messageUrl, `${path}.messageUrl`, { max: 8192 }),
    intelTags: value.intelTags === undefined ? ["数据泄露"] : stringArray(value.intelTags, `${path}.intelTags`),
    leakDataTypes: string(value.leakDataTypes, `${path}.leakDataTypes`, { max: 4096 }),
    leakCount: string(value.leakCount, `${path}.leakCount`, { max: 256 }),
    transactionCount: string(value.transactionCount, `${path}.transactionCount`, { max: 256 }),
    transactionPrice: string(value.transactionPrice, `${path}.transactionPrice`, { max: 256 }),
    publishedAt: isoDateTime(value.publishedAt, `${path}.publishedAt`),
    publisherId: string(value.publisherId, `${path}.publisherId`, { max: 1024 }),
    intelNote: string(value.intelNote, `${path}.intelNote`, { max: 100_000 }),
    articleMarkdown: value.articleMarkdown === undefined ? "" : string(value.articleMarkdown, `${path}.articleMarkdown`, { max: MAX_DARK_WEB_ARTICLE_CHARS }),
    firstSeenAt: isoDateTime(value.firstSeenAt, `${path}.firstSeenAt`),
    lastSeenAt: isoDateTime(value.lastSeenAt, `${path}.lastSeenAt`),
    importCount: integer(value.importCount, `${path}.importCount`, { min: 1 }),
    repeatedPropagationCount: integer(value.repeatedPropagationCount, `${path}.repeatedPropagationCount`, { min: 0 }),
    files: array(value.files, `${path}.files`, parseDarkWebFileMetadata)
  };
}

function parseAssetReport(input, path) {
  const value = object(input, path, ["id", "targetId", "fileName", "sizeBytes", "dnsCount", "portCount", "webCount", "fingerprintCount", "iconCount", "createdAt", "structuredData"]);
  return {
    id: identifier(value.id, `${path}.id`),
    targetId: value.targetId === null ? null : identifier(value.targetId, `${path}.targetId`),
    fileName: safeFileName(value.fileName, `${path}.fileName`),
    sizeBytes: integer(value.sizeBytes, `${path}.sizeBytes`, { min: 0 }),
    dnsCount: integer(value.dnsCount, `${path}.dnsCount`, { min: 0 }),
    portCount: integer(value.portCount, `${path}.portCount`, { min: 0 }),
    webCount: integer(value.webCount, `${path}.webCount`, { min: 0 }),
    fingerprintCount: integer(value.fingerprintCount, `${path}.fingerprintCount`, { min: 0 }),
    iconCount: integer(value.iconCount, `${path}.iconCount`, { min: 0 }),
    createdAt: isoDateTime(value.createdAt, `${path}.createdAt`),
    structuredData: jsonObject(value.structuredData, `${path}.structuredData`)
  };
}

function parseFileObject(input, path) {
  const value = object(input, path, ["id", "ownerType", "ownerId", "kind", "name", "mediaType", "sizeBytes", "sha256", "contentLocation"]);
  return {
    id: identifier(value.id, `${path}.id`),
    ownerType: enumeration(value.ownerType, `${path}.ownerType`, ["dark-web", "asset-report", "ingestion-batch", "article-image"]),
    ownerId: identifier(value.ownerId, `${path}.ownerId`),
    kind: enumeration(value.kind, `${path}.kind`, ["archive", "report", "attachment", "structured-data", "source", "image"]),
    name: safeFileName(value.name, `${path}.name`),
    mediaType: string(value.mediaType, `${path}.mediaType`, { min: 1, max: 256 }),
    sizeBytes: integer(value.sizeBytes, `${path}.sizeBytes`, { min: 0 }),
    sha256: hexDigest(value.sha256, `${path}.sha256`),
    contentLocation: string(value.contentLocation, `${path}.contentLocation`, { min: 1, max: 8192 })
  };
}

function parseFingerprintIcon(input, path) {
  const value = object(input, path, ["id", "fingerprintName", "aliases", "source", "mediaType", "iconData", "iconSha256", "active", "updatedAt"]);
  return {
    id: identifier(value.id, `${path}.id`),
    fingerprintName: string(value.fingerprintName, `${path}.fingerprintName`, { min: 1, max: 160 }),
    aliases: array(value.aliases, `${path}.aliases`, (item, itemPath) => string(item, itemPath, { min: 1, max: 160 })),
    source: enumeration(value.source, `${path}.source`, FINGERPRINT_ICON_SOURCES),
    mediaType: string(value.mediaType, `${path}.mediaType`, { min: 1, max: 128 }),
    iconData: string(value.iconData, `${path}.iconData`, { min: 1, max: 400_000 }),
    iconSha256: hexDigest(value.iconSha256, `${path}.iconSha256`),
    active: boolean(value.active, `${path}.active`),
    updatedAt: isoDateTime(value.updatedAt, `${path}.updatedAt`)
  };
}

export function createEdgeOpenApiKey(deploymentIdInput, authenticationSecretInput, snapshotSecretInput) {
  const deploymentId = identifier(deploymentIdInput, "$.deploymentId");
  const authenticationSecret = string(authenticationSecretInput, "$.authenticationSecret", { min: 32, max: 4096 });
  const snapshotSecret = string(snapshotSecretInput, "$.snapshotSecret", { min: 32, max: 4096 });
  return `sentinel-edge-v2.${Buffer.from(deploymentId, "utf8").toString("base64url")}.${authenticationSecret}.${snapshotSecret}`;
}

export function parseEdgeOpenApiKey(value) {
  const parts = String(value || "").trim().split(".");
  const [prefix, encodedDeploymentId, authenticationSecret, snapshotSecret, ...extra] = parts;
  const version = prefix === "sentinel-edge-v1" ? 1 : prefix === "sentinel-edge-v2" ? 2 : null;
  if (!version || !encodedDeploymentId || !authenticationSecret || extra.length || (version === 1 ? snapshotSecret !== undefined : !snapshotSecret)) return null;
  if (authenticationSecret.length < 32 || (version === 2 && snapshotSecret.length < 32)) return null;
  try {
    const deploymentId = Buffer.from(encodedDeploymentId, "base64url").toString("utf8");
    if (!deploymentId || Buffer.from(deploymentId, "utf8").toString("base64url") !== encodedDeploymentId) return null;
    return { version, deploymentId, authenticationSecret, snapshotSecret: version === 1 ? authenticationSecret : snapshotSecret };
  } catch { return null; }
}

function jsonObject(input, path) {
  const value = object(input, path, Object.keys(input ?? {}));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    string(key, `${path} key`, { min: 1, max: 256 }),
    jsonValue(item, `${path}.${key}`)
  ]));
}

function hexDigest(input, path) {
  const value = string(input, path, { min: 64, max: 64 });
  if (!/^[a-f0-9]{64}$/u.test(value)) fail(path, "expected lowercase SHA-256 hex digest");
  return value;
}

function safeFileName(input, path) {
  const value = string(input, path, { min: 1, max: 255 });
  if (value === "." || value === ".." || /[\\/\x00-\x1f\x7f]/u.test(value)) fail(path, "expected a file name without path separators or control characters");
  return value;
}

function parseRecordCounts(input, path) {
  const value = object(input, path, RECORD_COUNT_KEYS);
  return Object.fromEntries(RECORD_COUNT_KEYS.map((key) => [key, integer(value[key], `${path}.${key}`, { min: 0 })]));
}

function parseSnapshotManifest(input, path) {
  const keys = ["protocolVersion", "schemaVersion", "tenantId", "deploymentId", "version", "createdAt", "fileName", "compression", "encryption", "size", "sha256", "recordCounts", "signature"];
  const value = object(input, path, keys);
  return {
    protocolVersion: enumeration(value.protocolVersion, `${path}.protocolVersion`, [CLOUD_EDGE_PROTOCOL_VERSION]),
    schemaVersion: enumeration(value.schemaVersion, `${path}.schemaVersion`, [EDGE_SNAPSHOT_SCHEMA_VERSION]),
    tenantId: identifier(value.tenantId, `${path}.tenantId`),
    deploymentId: identifier(value.deploymentId, `${path}.deploymentId`),
    version: integer(value.version, `${path}.version`, { min: 1 }),
    createdAt: isoDateTime(value.createdAt, `${path}.createdAt`),
    fileName: safeFileName(value.fileName, `${path}.fileName`),
    compression: enumeration(value.compression, `${path}.compression`, ["gzip"]),
    encryption: enumeration(value.encryption, `${path}.encryption`, ["aes-256-gcm"]),
    size: integer(value.size, `${path}.size`, { min: 1 }),
    sha256: hexDigest(value.sha256, `${path}.sha256`),
    recordCounts: parseRecordCounts(value.recordCounts, `${path}.recordCounts`),
    signature: hexDigest(value.signature, `${path}.signature`)
  };
}

function parseEdgeSnapshot(input, path) {
  const keys = ["schemaVersion", "tenant", "deploymentId", "version", "generatedAt", ...RECORD_COUNT_KEYS, "vulnerabilityRecords", "vulnerabilityAlerts", "fingerprintIcons", "fileObjects"];
  const value = object(input, path, keys);
  return {
    schemaVersion: enumeration(value.schemaVersion, `${path}.schemaVersion`, [EDGE_SNAPSHOT_SCHEMA_VERSION]),
    tenant: parseTenant(value.tenant, `${path}.tenant`),
    deploymentId: identifier(value.deploymentId, `${path}.deploymentId`),
    version: integer(value.version, `${path}.version`, { min: 1 }),
    generatedAt: isoDateTime(value.generatedAt, `${path}.generatedAt`),
    monitoringTargets: array(value.monitoringTargets, `${path}.monitoringTargets`, parseMonitoringTarget),
    sensitiveRecords: array(value.sensitiveRecords, `${path}.sensitiveRecords`, parseSensitiveRecord),
    assetRecords: array(value.assetRecords, `${path}.assetRecords`, parseAssetRecord),
    ...(value.vulnerabilityRecords === undefined ? {} : { vulnerabilityRecords: array(value.vulnerabilityRecords, `${path}.vulnerabilityRecords`, parseVulnerabilityRecord) }),
    ...(value.vulnerabilityAlerts === undefined ? {} : { vulnerabilityAlerts: array(value.vulnerabilityAlerts, `${path}.vulnerabilityAlerts`, parseVulnerabilityAlert) }),
    credentialSubscriptions: array(value.credentialSubscriptions, `${path}.credentialSubscriptions`, parseCredentialSubscription),
    credentialRecords: array(value.credentialRecords, `${path}.credentialRecords`, parseCredentialRecord),
    darkWebEvents: array(value.darkWebEvents, `${path}.darkWebEvents`, parseDarkWebEvent),
    assetReports: array(value.assetReports, `${path}.assetReports`, parseAssetReport),
    ...(value.fingerprintIcons === undefined ? {} : { fingerprintIcons: array(value.fingerprintIcons, `${path}.fingerprintIcons`, parseFingerprintIcon) }),
    ...(value.fileObjects === undefined ? {} : { fileObjects: array(value.fileObjects, `${path}.fileObjects`, parseFileObject) })
  };
}

function parseDeploymentConfig(input, path) {
  const value = object(input, path, ["protocolVersion", "configVersion", "tenantId", "deploymentId", "enabled", "syncMode", "pollIntervalSeconds", "enabledModules", "license"]);
  const licenseValue = value.license === undefined ? undefined : object(value.license, `${path}.license`, ["status", "issuedAt", "expiresAt"]);
  const enabledModules = value.enabledModules === undefined
    ? [...EDGE_PORTAL_MODULES]
    : array(value.enabledModules, `${path}.enabledModules`, (item, itemPath) => enumeration(item, itemPath, EDGE_PORTAL_MODULES));
  if (!enabledModules.length) fail(`${path}.enabledModules`, "must contain at least one portal module");
  if (new Set(enabledModules).size !== enabledModules.length) fail(`${path}.enabledModules`, "must not contain duplicate modules");
  return {
    protocolVersion: enumeration(value.protocolVersion, `${path}.protocolVersion`, [CLOUD_EDGE_PROTOCOL_VERSION]),
    configVersion: integer(value.configVersion, `${path}.configVersion`, { min: 1 }),
    tenantId: identifier(value.tenantId, `${path}.tenantId`),
    deploymentId: identifier(value.deploymentId, `${path}.deploymentId`),
    enabled: boolean(value.enabled, `${path}.enabled`),
    syncMode: enumeration(value.syncMode, `${path}.syncMode`, SYNC_MODES),
    pollIntervalSeconds: integer(value.pollIntervalSeconds, `${path}.pollIntervalSeconds`, { min: 1, max: 86_400 }),
    enabledModules,
    ...(licenseValue === undefined ? {} : { license: {
      status: enumeration(licenseValue.status, `${path}.license.status`, ["active", "expired", "revoked"]),
      issuedAt: nullableIsoDateTime(licenseValue.issuedAt, `${path}.license.issuedAt`),
      expiresAt: isoDateTime(licenseValue.expiresAt, `${path}.license.expiresAt`)
    } })
  };
}

function parseActivationConfig(input, path) {
  const value = object(input, path, ["protocolVersion", "cloudBaseUrl", "apiKey", "deploymentId", "deploymentSecret"]);
  const cloudBaseUrl = string(value.cloudBaseUrl, `${path}.cloudBaseUrl`, { min: 1, max: 8192 });
  let url;
  try { url = new URL(cloudBaseUrl); } catch { fail(`${path}.cloudBaseUrl`, "expected absolute HTTP(S) URL"); }
  if (!['http:', 'https:'].includes(url.protocol)) fail(`${path}.cloudBaseUrl`, "expected HTTP(S) URL");
  const apiKey = value.apiKey === undefined ? undefined : string(value.apiKey, `${path}.apiKey`, { min: 32, max: 8192 });
  const deploymentId = value.deploymentId === undefined ? undefined : identifier(value.deploymentId, `${path}.deploymentId`);
  const deploymentSecret = value.deploymentSecret === undefined ? undefined : string(value.deploymentSecret, `${path}.deploymentSecret`, { min: 32, max: 4096 });
  if (!apiKey && (!deploymentId || !deploymentSecret)) fail(path, "expected apiKey or legacy deploymentId/deploymentSecret credentials");
  if (apiKey && (deploymentId || deploymentSecret)) fail(path, "apiKey cannot be combined with legacy credentials");
  return {
    protocolVersion: enumeration(value.protocolVersion, `${path}.protocolVersion`, [CLOUD_EDGE_PROTOCOL_VERSION]),
    cloudBaseUrl,
    ...(apiKey ? { apiKey } : { deploymentId, deploymentSecret })
  };
}

function parseRemoteDescriptor(input, path) {
  const value = object(input, path, ["mode", "version", "manifestLocation", "contentLocation", "urlExpiresAt"]);
  const mode = enumeration(value.mode, `${path}.mode`, SYNC_MODES);
  const expiresAt = value.urlExpiresAt === undefined ? undefined : isoDateTime(value.urlExpiresAt, `${path}.urlExpiresAt`);
  if (mode === "object_storage_pull" && expiresAt === undefined) fail(`${path}.urlExpiresAt`, "required for object_storage_pull");
  return {
    mode,
    version: integer(value.version, `${path}.version`, { min: 1 }),
    manifestLocation: string(value.manifestLocation, `${path}.manifestLocation`, { min: 1, max: 8192 }),
    contentLocation: string(value.contentLocation, `${path}.contentLocation`, { min: 1, max: 8192 }),
    ...(expiresAt === undefined ? {} : { urlExpiresAt: expiresAt })
  };
}

function parseSyncStatusReport(input, path) {
  const value = object(input, path, ["protocolVersion", "tenantId", "deploymentId", "status", "attemptedAt", "appliedSnapshotVersion", "message"]);
  return {
    protocolVersion: enumeration(value.protocolVersion, `${path}.protocolVersion`, [CLOUD_EDGE_PROTOCOL_VERSION]),
    tenantId: identifier(value.tenantId, `${path}.tenantId`),
    deploymentId: identifier(value.deploymentId, `${path}.deploymentId`),
    status: enumeration(value.status, `${path}.status`, ["success", "failed"]),
    attemptedAt: isoDateTime(value.attemptedAt, `${path}.attemptedAt`),
    appliedSnapshotVersion: value.appliedSnapshotVersion === null ? null : integer(value.appliedSnapshotVersion, `${path}.appliedSnapshotVersion`, { min: 1 }),
    message: nullableString(value.message, `${path}.message`, { max: 4096 })
  };
}

function parseSyncState(input, path) {
  const value = object(input, path, ["tenantId", "deploymentId", "status", "appliedSnapshotVersion", "lastAttemptAt", "lastSuccessAt", "message"]);
  return {
    tenantId: identifier(value.tenantId, `${path}.tenantId`),
    deploymentId: identifier(value.deploymentId, `${path}.deploymentId`),
    status: enumeration(value.status, `${path}.status`, EDGE_SYNC_STATUSES),
    appliedSnapshotVersion: value.appliedSnapshotVersion === null ? null : integer(value.appliedSnapshotVersion, `${path}.appliedSnapshotVersion`, { min: 1 }),
    lastAttemptAt: nullableIsoDateTime(value.lastAttemptAt, `${path}.lastAttemptAt`),
    lastSuccessAt: nullableIsoDateTime(value.lastSuccessAt, `${path}.lastSuccessAt`),
    message: nullableString(value.message, `${path}.message`, { max: 4096 })
  };
}

export const snapshotManifestV1Schema = schema("SnapshotManifestV1", parseSnapshotManifest);
export const edgeSnapshotV1Schema = schema("EdgeSnapshotV1", parseEdgeSnapshot);
export const edgeDeploymentConfigV1Schema = schema("EdgeDeploymentConfigV1", parseDeploymentConfig);
export const edgeActivationConfigV1Schema = schema("EdgeActivationConfigV1", parseActivationConfig);
export const remoteSnapshotDescriptorSchema = schema("RemoteSnapshotDescriptor", parseRemoteDescriptor);
export const edgeSyncStatusReportV1Schema = schema("EdgeSyncStatusReportV1", parseSyncStatusReport);
export const edgeSyncStateSchema = schema("EdgeSyncState", parseSyncState);

export const parseSnapshotManifestV1 = (input) => snapshotManifestV1Schema.parse(input);
export const parseEdgeSnapshotV1 = (input) => edgeSnapshotV1Schema.parse(input);
export const parseEdgeDeploymentConfigV1 = (input) => edgeDeploymentConfigV1Schema.parse(input);
export const parseEdgeActivationConfigV1 = (input) => edgeActivationConfigV1Schema.parse(input);
export const parseRemoteSnapshotDescriptor = (input) => remoteSnapshotDescriptorSchema.parse(input);
export const parseEdgeSyncStatusReportV1 = (input) => edgeSyncStatusReportV1Schema.parse(input);
export const parseEdgeSyncState = (input) => edgeSyncStateSchema.parse(input);

export function snapshotRecordCounts(snapshotInput) {
  const snapshot = edgeSnapshotV1Schema.parse(snapshotInput);
  return Object.fromEntries(RECORD_COUNT_KEYS.map((key) => [key, snapshot[key].length]));
}
