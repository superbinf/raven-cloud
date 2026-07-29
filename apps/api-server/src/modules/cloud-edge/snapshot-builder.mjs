import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { buildEncryptedSnapshot, canonicalSerialize, sha256Hex } from "@sentinel/distribution";
import { readArticleImageFromDirectories, referencedArticleImageNames } from "../../article-images.mjs";
import { assetReportCounts, projectAssetReportData } from "../../asset-report-projection.mjs";

function parseJson(value, fallback) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return value;
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

async function reportData(row) {
  if (!row.data_path) return {};
  try {
    const value = JSON.parse(await readFile(row.data_path, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

const fileDigest = (content) => createHash("sha256").update(content).digest("hex");
const fileLocation = (id) => `/edge/v1/files/${encodeURIComponent(id)}/content`;

async function assetReportFiles(rows) {
  const files = [];
  for (const row of rows) {
    if (row.file_path) {
      const content = await readFile(row.file_path);
      const id = `asset-report/${row.id}/content`;
      files.push({ id, ownerType: "asset-report", ownerId: row.id, kind: "report", name: basename(row.file_name), mediaType: "text/html; charset=utf-8", sizeBytes: content.length, sha256: fileDigest(content), contentLocation: fileLocation(id) });
    }
    if (row.data_path) {
      const content = await readFile(row.data_path);
      const id = `asset-report/${row.id}/structured-data`;
      files.push({ id, ownerType: "asset-report", ownerId: row.id, kind: "structured-data", name: `${row.id}.json`, mediaType: "application/json", sizeBytes: content.length, sha256: fileDigest(content), contentLocation: fileLocation(id) });
    }
  }
  return files;
}

async function ingestionSourceFiles(rows) {
  const files = [];
  for (const row of rows) {
    const content = await readFile(row.source_file_path);
    const id = `ingestion-batch/${row.id}/source`;
    files.push({ id, ownerType: "ingestion-batch", ownerId: row.id, kind: "source", name: basename(row.file_name), mediaType: "application/octet-stream", sizeBytes: content.length, sha256: fileDigest(content), contentLocation: fileLocation(id) });
  }
  return files;
}

function articleImagesForEvent(event, directories) {
  const images = [];
  for (const name of referencedArticleImageNames(event.articleMarkdown ?? event.article_markdown)) {
    let image = null;
    try { image = readArticleImageFromDirectories(directories, name); }
    catch { return { images: [], missing: name }; }
    if (!image) return { images: [], missing: name };
    images.push({
      id: `article-image/${name}`, ownerType: "article-image", ownerId: event.id, kind: "image", name,
      mediaType: image.mediaType, sizeBytes: image.sizeBytes, sha256: image.sha256, contentLocation: fileLocation(`article-image/${name}`)
    });
  }
  return { images, missing: null };
}

function warning(action, row, missing) {
  return `${action}暗网事件 ${row.id}（${row.title || "未命名"}）：文章图片 ${missing} 不可用`;
}

function iso(value) {
  const text = String(value || "").trim();
  if (!text) return new Date(0).toISOString();
  if (/^-?\d+(?:\.\d+)?$/.test(text)) {
    const numeric = Number(text);
    const milliseconds = Math.abs(numeric) < 100_000_000_000 ? numeric * 1_000 : numeric;
    const date = new Date(milliseconds);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?$/.test(text) ? `${text.replace(" ", "T")}${text.length === 16 ? ":00Z" : "Z"}` : text;
  const timestamp = Date.parse(normalized);
  if (Number.isNaN(timestamp)) throw new Error(`无法规范化时间字段：${text}`);
  return new Date(timestamp).toISOString();
}

function stringFields(value) {
  const output = {};
  for (const [key, item] of Object.entries(value && typeof value === "object" && !Array.isArray(value) ? value : {})) {
    if (item === null || item === undefined) output[key] = "";
    else if (typeof item === "string") output[key] = item;
    else if (typeof item === "number" || typeof item === "boolean") output[key] = String(item);
    else output[key] = JSON.stringify(item);
  }
  return output;
}

function stableImportStatus(row) {
  if (row.import_status === "新增" || row.import_status === "已存在") return row.import_status;
  return Number(row.import_count) > 1 ? "已存在" : "新增";
}

function darkWebEventDto(row, files, repeatedPropagationCount) {
  return {
    id: row.id, targetId: row.target_id, title: row.title, risk: row.risk || "low", reportDate: row.report_date,
    sourceGroupName: row.source_group_name, sourceGroupId: row.source_group_id, sourceGroupUrl: row.source_group_url,
    messageUrl: row.message_url, intelTags: String(row.intel_tags || "数据泄露").split("、").filter(Boolean),
    leakDataTypes: row.leak_data_types, leakCount: row.leak_count, transactionCount: row.transaction_count,
    transactionPrice: row.transaction_price, publishedAt: iso(row.published_at), publisherId: row.publisher_id,
    intelNote: row.intel_note, articleMarkdown: row.article_markdown || "", firstSeenAt: iso(row.first_seen_at),
    lastSeenAt: iso(row.last_seen_at), importCount: row.import_count, repeatedPropagationCount: repeatedPropagationCount(row.id),
    files
  };
}

async function resolveDarkWebEvents(rows, { filesByEvent, directories, previousSnapshot, loadPreviousSnapshot, repeatedPropagationCount }) {
  let baseline = previousSnapshot || null;
  const acceptedCurrentEventIds = new Set();
  const fallbackEventIds = new Set();
  const events = [];
  const images = new Map();
  const warnings = [];
  const addImages = (event) => {
    const result = articleImagesForEvent(event, directories);
    if (result.missing) return result;
    for (const image of result.images) if (!images.has(image.name)) images.set(image.name, image);
    return result;
  };

  for (const row of rows) {
    const current = addImages(row);
    if (!current.missing) {
      acceptedCurrentEventIds.add(row.id);
      events.push(darkWebEventDto(row, filesByEvent.get(row.id) || [], repeatedPropagationCount));
      continue;
    }

    if (!baseline && loadPreviousSnapshot) baseline = await loadPreviousSnapshot();
    const previous = baseline?.darkWebEvents?.find((event) => event.id === row.id);
    const retained = previous ? addImages(previous) : { missing: current.missing };
    if (previous && !retained.missing) {
      fallbackEventIds.add(row.id);
      events.push(previous);
      warnings.push(warning("保留上一成功版本，", row, current.missing));
    } else {
      warnings.push(warning(previous ? "跳过历史版本也不可恢复的" : "跳过首次或不可恢复的", row, retained.missing));
    }
  }
  return { events, articleImages: [...images.values()], warnings, acceptedCurrentEventIds, fallbackEventIds, baseline };
}

export async function projectTenantSnapshotWithWarnings(db, { tenant, deploymentId, version, articleImagesDir, articleImagesDirs, previousSnapshot, loadPreviousSnapshot }) {
  const imageDirectories = (articleImagesDirs || [articleImagesDir]).filter(Boolean);
  const targetRows = await db.prepare("SELECT * FROM monitoring_targets WHERE tenant_id=? ORDER BY id").all(tenant.id);
  const sensitiveRows = await db.prepare("SELECT * FROM sensitive_records WHERE tenant_id=? AND is_published=TRUE ORDER BY id").all(tenant.id);
  const assetCandidates = await db.prepare("SELECT * FROM asset_records WHERE tenant_id=? AND (is_published=TRUE OR previously_published=TRUE OR (change_type='missing' AND reviewed_at IS NOT NULL)) ORDER BY id").all(tenant.id);
  const assetRows = assetCandidates.map((row) => row.change_type === "missing" && row.previous_fields_json
    ? { ...row, fields_json: row.previous_fields_json, import_status: "已存在" }
    : row);
  const vulnerabilityRows = await db.prepare("SELECT * FROM vulnerability_records WHERE tenant_id=? AND is_published=TRUE ORDER BY id").all(tenant.id);
  const vulnerabilityAlertRows = await db.prepare(`SELECT alerts.*,vulnerabilities.cve,vulnerabilities.title AS vulnerability_title,vulnerabilities.risk AS vulnerability_risk,
    vulnerabilities.source AS vulnerability_source,vulnerabilities.disclosure_at,vulnerabilities.first_seen_at AS vulnerability_first_seen_at,groups.name AS watch_group_name,items.product_name AS watch_product,
    assets.title AS asset_title,assets.fields_json AS asset_fields_json,targets.name AS target_name
    FROM vulnerability_alerts alerts
    JOIN vulnerability_records vulnerabilities ON vulnerabilities.id=alerts.vulnerability_id
    JOIN fingerprint_watch_groups groups ON groups.id=alerts.watch_group_id
    JOIN fingerprint_watch_items items ON items.id=alerts.watch_item_id
    LEFT JOIN asset_records assets ON assets.id=alerts.asset_record_id
    LEFT JOIN monitoring_targets targets ON targets.id=alerts.target_id
    WHERE alerts.tenant_id=? AND vulnerabilities.is_published=TRUE AND (alerts.asset_record_id IS NULL OR assets.is_published=TRUE) ORDER BY alerts.id`).all(tenant.id);
  const subscriptionRows = await db.prepare("SELECT * FROM credential_subscriptions WHERE tenant_id=? ORDER BY id").all(tenant.id);
  const credentialRows = await db.prepare(`SELECT credential_records.* FROM credential_records
    JOIN credential_subscriptions ON credential_subscriptions.id=credential_records.sub_id
    WHERE credential_subscriptions.tenant_id=? AND credential_records.is_published=TRUE ORDER BY credential_records.id`).all(tenant.id);
  const eventRows = await db.prepare("SELECT * FROM dark_web_events WHERE tenant_id=? AND is_published=TRUE ORDER BY id").all(tenant.id);
  const allDarkWebFileRows = await db.prepare(`SELECT dark_web_files.*, dark_web_blobs.size_bytes, dark_web_blobs.media_type
    FROM dark_web_files JOIN dark_web_blobs ON dark_web_blobs.sha256=dark_web_files.blob_sha256
    JOIN ingestion_batches ON ingestion_batches.id=dark_web_files.batch_id
    JOIN dark_web_events ON dark_web_events.id=dark_web_files.event_id
    WHERE ingestion_batches.tenant_id=? AND dark_web_events.is_published=TRUE
    ORDER BY dark_web_files.batch_id,dark_web_files.event_id,dark_web_files.id`).all(tenant.id);
  const eventFileRows = allDarkWebFileRows.filter((row) => row.event_id && ["report", "attachment"].includes(row.kind));
  const reportRows = await db.prepare("SELECT * FROM asset_reports WHERE tenant_id=? AND is_published=TRUE ORDER BY id").all(tenant.id);
  const fingerprintIconRows = await db.prepare("SELECT * FROM fingerprint_icon_library WHERE active=TRUE ORDER BY fingerprint_name,id").all();
  const ingestionSourceRows = await db.prepare("SELECT * FROM ingestion_batches WHERE tenant_id=? AND status='已发布' AND source_file_path IS NOT NULL ORDER BY id").all(tenant.id);
  const filesByEvent = new Map();
  const eventsByAttachment = new Map();
  for (const row of eventFileRows) {
    const files = filesByEvent.get(row.event_id) || [];
    files.push({ id: row.id, kind: row.kind, name: basename(row.original_name), sizeBytes: Number(row.size_bytes), sha256: row.blob_sha256, mediaType: row.media_type, sheetCount: Number(row.sheet_count), rowCount: Number(row.row_count), columnCount: Number(row.column_count), cached: true });
    filesByEvent.set(row.event_id, files);
    if (row.kind === "attachment") {
      const events = eventsByAttachment.get(row.blob_sha256) || new Set();
      events.add(row.event_id); eventsByAttachment.set(row.blob_sha256, events);
    }
  }
  const repeatedPropagationCount = (eventId) => {
    const related = new Set();
    for (const row of eventFileRows) if (row.event_id === eventId && row.kind === "attachment") for (const relatedId of eventsByAttachment.get(row.blob_sha256) || []) related.add(relatedId);
    related.delete(eventId);
    return related.size;
  };
  const resolvedEvents = await resolveDarkWebEvents(eventRows, {
    filesByEvent,
    directories: imageDirectories,
    previousSnapshot,
    loadPreviousSnapshot,
    repeatedPropagationCount
  });
  const generatedAt = new Date().toISOString();
  const darkWebFileObjects = [...new Map(allDarkWebFileRows.filter((row) => resolvedEvents.acceptedCurrentEventIds.has(row.event_id)).map((row) => {
    const id = `dark-web/${row.blob_sha256}`;
    return [row.blob_sha256, { id, ownerType: "dark-web", ownerId: row.event_id || row.batch_id, kind: row.kind, name: basename(row.original_name), mediaType: row.media_type, sizeBytes: Number(row.size_bytes), sha256: row.blob_sha256, contentLocation: fileLocation(id) }];
  })).values()];
  const retainedDarkWebFiles = (resolvedEvents.baseline?.fileObjects || []).filter((file) => file.ownerType === "dark-web" && resolvedEvents.fallbackEventIds.has(String(file.ownerId)));
  const reportFiles = await assetReportFiles(reportRows);
  const ingestionFiles = await ingestionSourceFiles(ingestionSourceRows);
  const snapshot = {
    schemaVersion: 1,
    tenant: { id: tenant.id, name: tenant.name },
    deploymentId,
    version,
    generatedAt,
    monitoringTargets: targetRows.map((row) => ({ id: row.id, name: row.name, targetType: row.target_type, owner: row.owner, domains: parseJson(row.domains_json, []), ips: parseJson(row.ips_json, []), keywords: parseJson(row.keywords_json, []), enabled: Boolean(row.enabled), updatedAt: iso(row.updated_at) })),
    sensitiveRecords: sensitiveRows.map((row) => ({ id: row.id, category: row.category, targetId: row.target_id, title: row.title, risk: row.risk, fields: stringFields(parseJson(row.fields_json, {})), firstSeenAt: iso(row.first_seen_at), lastSeenAt: iso(row.last_seen_at), importStatus: stableImportStatus(row), importCount: row.import_count, batchId: row.batch_id })),
    assetRecords: assetRows.map((row) => ({
      id: row.id,
      category: row.category,
      targetId: row.target_id,
      title: row.title,
      risk: row.risk,
      fields: stringFields(parseJson(row.fields_json, {})),
      firstSeenAt: iso(row.first_seen_at),
      lastSeenAt: iso(row.last_seen_at),
      importStatus: stableImportStatus(row),
      importCount: row.import_count,
      batchId: row.batch_id,
      changeType: row.change_type || "baseline",
      presentInLatestBatch: Boolean(row.present_in_latest_batch),
      previouslyPublished: Boolean(row.previously_published),
      ...(row.previous_fields_json ? { previousFields: stringFields(parseJson(row.previous_fields_json, {})) } : {}),
      ...(row.last_changed_at ? { lastChangedAt: iso(row.last_changed_at) } : {}),
      ...(row.missing_since ? { missingSince: iso(row.missing_since) } : {})
    })),
    vulnerabilityRecords: vulnerabilityRows.map((row) => ({ id: row.id, targetId: row.target_id, targetName: targetRows.find((target) => target.id === row.target_id)?.name || "未关联监测对象", title: row.title, summary: row.summary, risk: row.risk, source: row.source, cve: row.cve, disclosureAt: row.disclosure_at ? iso(row.disclosure_at) : null, solutions: row.solutions, references: parseJson(row.references_json, []), tags: parseJson(row.tags_json, []), sourceCreatedAt: iso(row.source_created_at), sourceUpdatedAt: iso(row.source_updated_at), firstSeenAt: iso(row.first_seen_at), lastSeenAt: iso(row.last_seen_at), importCount: row.import_count, status: row.status })),
    vulnerabilityAlerts: vulnerabilityAlertRows.map((row) => {
      const fields = parseJson(row.asset_fields_json, {});
      return { id: row.id, vulnerabilityId: row.vulnerability_id, vulnerabilityFirstSeenAt: iso(row.vulnerability_first_seen_at), cve: row.cve, vulnerabilityTitle: row.vulnerability_title, risk: row.vulnerability_risk, source: row.vulnerability_source, disclosureAt: row.disclosure_at ? iso(row.disclosure_at) : null, watchGroupId: row.watch_group_id, watchGroupName: row.watch_group_name, watchItemId: row.watch_item_id, watchProduct: row.watch_product, assetRecordId: row.asset_record_id || null, assetTitle: row.asset_title || "", assetUrl: String(fields.url || ""), assetIp: String(fields.ipAddress || ""), assetPort: String(fields.port || ""), targetId: row.target_id, targetName: row.target_name || "未关联监测对象", matchedProduct: row.matched_product, assetVersion: row.asset_version, confidence: row.confidence, matchType: row.match_type, evidence: parseJson(row.evidence_json, {}), status: row.status, firstMatchedAt: iso(row.first_matched_at), lastMatchedAt: iso(row.last_matched_at) };
    }),
    credentialSubscriptions: subscriptionRows.map((row) => ({ id: row.id, targetId: row.target_id, subType: row.sub_type, subCategory: row.sub_category, value: row.value, expireTime: iso(row.expire_time), count: row.count })),
    credentialRecords: credentialRows.map((row) => ({ id: row.id, subId: row.sub_id, url: row.url, systemName: row.system_name, account: row.account, password: row.password, leakedAt: iso(row.leaked_at), firstSeenAt: iso(row.first_seen_at || row.leaked_at), source: row.source, fields: stringFields(parseJson(row.raw_json, {})) })),
    darkWebEvents: resolvedEvents.events,
    assetReports: await Promise.all(reportRows.map(async (row) => {
      const sourceData = await reportData(row);
      const structuredData = projectAssetReportData(sourceData, assetRows.filter((asset) => !row.target_id || asset.target_id === row.target_id));
      const counts = assetReportCounts(structuredData);
      return { id: row.id, targetId: row.target_id, fileName: basename(row.file_name), sizeBytes: row.size_bytes, ...counts, createdAt: iso(row.created_at), structuredData };
    })),
    fingerprintIcons: fingerprintIconRows.map((row) => ({ id: row.id, fingerprintName: row.fingerprint_name, aliases: parseJson(row.aliases_json, []), source: row.source, mediaType: row.media_type, iconData: row.icon_data, iconSha256: row.icon_sha256, active: Boolean(row.active), updatedAt: iso(row.updated_at) })),
    fileObjects: [...new Map([...darkWebFileObjects, ...retainedDarkWebFiles, ...reportFiles, ...ingestionFiles, ...resolvedEvents.articleImages].map((file) => [file.id, file])).values()]
  };
  return { snapshot, warnings: resolvedEvents.warnings };
}

export async function projectTenantSnapshot(db, options) {
  return (await projectTenantSnapshotWithWarnings(db, options)).snapshot;
}

export function snapshotSourceHash(snapshot) {
  const { generatedAt: _generatedAt, version: _version, deploymentId: _deploymentId, ...businessProjection } = snapshot;
  return sha256Hex(canonicalSerialize(businessProjection));
}

export async function buildTenantSnapshot(db, options) {
  const snapshot = options.snapshot || await projectTenantSnapshot(db, options);
  return { ...buildEncryptedSnapshot({ snapshot, rootSecret: options.rootSecret, fileName: `snapshot-${options.version}.bin` }), sourceHash: snapshotSourceHash(snapshot) };
}
