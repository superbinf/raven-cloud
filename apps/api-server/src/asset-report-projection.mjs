import { assetChangedFields } from "./asset-change.mjs";

const text = (value) => value == null ? "" : String(value).replace(/\u00a0/g, " ").trim();
const compact = (value) => text(value).replace(/\s+/g, " ").toLowerCase();

function parseJson(value, fallback) {
  if (value && typeof value === "object") return value;
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

function fieldsOf(record) {
  return parseJson(record.fields ?? record.fields_json, {});
}

const firstSeenAt = (record) => text(record.firstSeenAt || record.first_seen_at);
const changeFieldLabels = {
  alive: "存活状态",
  statusCode: "状态码"
};

function changeFieldValue(key, value) {
  const source = compact(value);
  if (key !== "alive") return text(value) || "--";
  if (["true", "1", "alive", "up", "存活"].includes(source)) return "存活";
  if (["false", "0", "dead", "down", "未存活"].includes(source)) return "未存活";
  return text(value) || "--";
}

function aliveLabel(value) {
  const source = compact(value);
  if (["true", "1", "alive", "up", "存活"].includes(source)) return "存活";
  if (["false", "0", "dead", "down", "未存活"].includes(source)) return "未存活";
  return text(value);
}

function assetChangeSummary(record) {
  const changeType = text(record.changeType || record.change_type);
  if (changeType === "new") return "首次出现在最新资产清单";
  if (changeType === "missing") return "最新资产清单中已不再出现";
  if (changeType === "reappeared") return "曾经消失的资产再次出现";
  if (changeType !== "changed") return "";
  const current = fieldsOf(record);
  const previous = parseJson(record.previousFields ?? record.previous_fields_json, {});
  const changed = assetChangedFields(previous, current)
    .map((key) => `${changeFieldLabels[key]} ${changeFieldValue(key, previous[key])} → ${changeFieldValue(key, current[key])}`);
  return changed.join(" / ") || "资产属性发生变化";
}

const recordMetadata = (record) => ({
  _record_id: text(record.id),
  _first_seen_at: firstSeenAt(record),
  _change_type: text(record.changeType || record.change_type),
  _change_summary: assetChangeSummary(record),
  _last_changed_at: text(record.lastChangedAt || record.last_changed_at),
  _missing_since: text(record.missingSince || record.missing_since)
});

function list(value) {
  if (Array.isArray(value)) return value;
  const source = text(value);
  if (!source) return [];
  const parsed = parseJson(source, null);
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object") return [parsed];
  const separated = source.split(/[、，;；|\n]+/u).map((item) => item.trim()).filter(Boolean);
  if (separated.length > 1) return separated.map((item) => parseJson(item, item));
  return source.includes("{") ? [source] : source.split(",").map((item) => item.trim()).filter(Boolean);
}

function joined(value) {
  return list(value).map((item) => typeof item === "string" ? item : JSON.stringify(item)).join("、");
}

function rootDomain(value) {
  const parts = text(value).replace(/^https?:\/\//iu, "").split(/[/:]/u)[0].split(".").filter(Boolean);
  if (parts.length < 2) return parts.join(".");
  const suffix = parts.slice(-2).join(".");
  return new Set(["com.cn", "net.cn", "org.cn", "gov.cn", "co.uk"]).has(suffix) && parts.length >= 3 ? parts.slice(-3).join(".") : suffix;
}

function sourceWebIdentity(item) {
  let protocol = "";
  try { protocol = new URL(text(item.url)).protocol.replace(":", ""); } catch {}
  return [item.url, item.ip, item.domain, protocol, item.port].map(compact).join("|");
}

function recordWebIdentity(record) {
  const fields = fieldsOf(record);
  return [fields.url, fields.ipAddress, fields.domain, fields.protocol, fields.port].map(compact).join("|");
}

const sourcePortIdentity = (item) => [item.ip, item.protocol, item.port, item.service || item.product || item.protocol].map(compact).join("|");
const recordPortIdentity = (record) => { const fields = fieldsOf(record); return [fields.address, fields.protocol, fields.port, fields.serviceType].map(compact).join("|"); };
const sourceDnsIdentity = (item) => [rootDomain(item.subdomain), item.subdomain, joined([...(Array.isArray(item.ips) ? item.ips : []), ...(Array.isArray(item.cnames) ? item.cnames : [])])].map(compact).join("|");
const recordDnsIdentity = (record) => { const fields = fieldsOf(record); return [fields.rootDomain, fields.subdomain, fields.ipAlias].map(compact).join("|"); };

function overlayRows(sourceRows, records, sourceIdentity, recordIdentity, sourceIsManaged, project) {
  const current = new Map(records.map((record) => [recordIdentity(record), record]));
  const sourceKeys = new Set(sourceRows.filter(sourceIsManaged).map(sourceIdentity));
  const rows = sourceRows.flatMap((source) => {
    if (!sourceIsManaged(source)) return [source];
    const record = current.get(sourceIdentity(source));
    return record ? [project(record, source)] : [];
  });
  for (const record of records) if (!sourceKeys.has(recordIdentity(record))) rows.push(project(record, {}));
  return rows;
}

function webRow(record, source) {
  const fields = fieldsOf(record);
  const importedProducts = "appProducts" in fields || "frameworkProducts" in fields;
  const appProducts = importedProducts && Array.isArray(source.app_products) ? source.app_products : importedProducts ? list(fields.appProducts) : list(fields.application);
  const frameworkProducts = importedProducts && Array.isArray(source.framework_products) ? source.framework_products : importedProducts ? list(fields.frameworkProducts) : [];
  return {
    ...source,
    ...recordMetadata(record),
    url: text(fields.url), ip: text(fields.ipAddress), domain: text(fields.domain), port: text(fields.port),
    status_code: text(fields.statusCode), title: text(fields.title || record.title),
    app_products: appProducts, framework_products: frameworkProducts,
    icon_hash_md5: text(fields.iconHashMd5 ?? source.icon_hash_md5), cert_subject_cn: text(fields.certSubjectCn ?? source.cert_subject_cn),
    company_path: text(fields.companyPath ?? source.company_path), discovery_chain: "discoveryChain" in fields ? list(fields.discoveryChain) : list(source.discovery_chain),
    geo: "geo" in fields ? parseJson(fields.geo, fields.geo) : source.geo ?? null, ip_location: text(fields.ipLocation ?? source.ip_location),
    alive: aliveLabel(fields.alive ?? source.alive), updated_at: text(fields.updatedAt || record.lastSeenAt || record.last_seen_at || source.updated_at),
    risk: text(fields.riskFlag || record.risk || source.risk), note: text(fields.note ?? source.note)
  };
}

function portRow(record, source) {
  const fields = fieldsOf(record);
  return {
    ...source,
    ...recordMetadata(record),
    ip: text(fields.address), service: text(fields.serviceType), protocol: text(fields.protocol), port: text(fields.port),
    alive: aliveLabel(fields.alive ?? source.alive), banner: text(fields.banner ?? source.banner), company_path: text(fields.companyPath ?? source.company_path),
    updated_at: text(fields.updatedAt || record.lastSeenAt || record.last_seen_at || source.updated_at), risk: text(fields.riskFlag || record.risk || source.risk), note: text(fields.note ?? source.note)
  };
}

function dnsRow(record, source) {
  const fields = fieldsOf(record);
  const hasSeparatedAddresses = "ips" in fields || "cnames" in fields;
  return {
    ...source,
    ...recordMetadata(record),
    root_domain: text(fields.rootDomain), subdomain: text(fields.subdomain || record.title),
    ips: hasSeparatedAddresses ? list(fields.ips) : list(fields.ipAlias), cnames: hasSeparatedAddresses ? list(fields.cnames) : [],
    company_path: text(fields.companyPath ?? source.company_path), updated_at: text(fields.updatedAt || record.lastSeenAt || record.last_seen_at || source.updated_at)
  };
}

function productName(value) {
  return typeof value === "string" ? text(value) : text(value?.name || value?.product || value?.key);
}

function productType(value, fallback = "应用指纹") {
  const type = compact(value);
  if (type === "app" || type.includes("应用")) return "应用指纹";
  if (type === "framework" || type.includes("框架") || type.includes("信息")) return "信息指纹";
  return text(value) || fallback;
}

function aggregateFingerprints(websites) {
  const aggregated = new Map();
  for (const website of websites) {
    for (const [field, type] of [["app_products", "应用指纹"], ["framework_products", "信息指纹"]]) {
      for (const product of Array.isArray(website[field]) ? website[field] : []) {
        const name = productName(product);
        if (!name) continue;
        const key = `${type}|${name}`;
        const current = aggregated.get(key) || { key: name, nameAndType: name, type, count: 0, _record_id: "", _first_seen_at: "" };
        current.count += 1;
        const seenAt = text(website._first_seen_at);
        if (seenAt && (!current._first_seen_at || Date.parse(seenAt) < Date.parse(current._first_seen_at))) {
          current._record_id = text(website._record_id);
          current._first_seen_at = seenAt;
        }
        aggregated.set(key, current);
      }
    }
  }
  return aggregated;
}

function fingerprintRows(sourceData, websites, records) {
  const rows = aggregateFingerprints(websites);
  for (const original of Array.isArray(sourceData.products?.datasource) ? sourceData.products.datasource : []) {
    const name = productName(original.key || original.nameAndType || original.name);
    rows.delete(`${productType(original.type)}|${name}`);
  }
  for (const record of records) {
    const fields = fieldsOf(record);
    if (fields.fingerprintType === "站点图标") continue;
    const name = text(fields.name || record.title);
    if (!name) continue;
    const type = productType(fields.productType, productType(fields.fingerprintType));
    const numericCount = Number(fields.count);
    rows.set(`${type}|${name}`, { key: name, nameAndType: name, type, count: Number.isFinite(numericCount) ? numericCount : text(fields.count) || 1, ...recordMetadata(record) });
  }
  return [...rows.values()].sort((left, right) => Number(right.count || 0) - Number(left.count || 0) || text(left.key).localeCompare(text(right.key), "zh-CN"));
}

function iconRows(sourceData, records) {
  const originals = new Map((Array.isArray(sourceData.icons) ? sourceData.icons : []).map((item) => [text(item.md5), item]));
  return records.flatMap((record) => {
    const fields = fieldsOf(record);
    if (fields.fingerprintType !== "站点图标") return [];
    const md5 = text(fields.iconHashMd5 || fields.name || record.title);
    const count = Number(fields.count);
    return [{ ...(originals.get(md5) || {}), md5, count: Number.isFinite(count) ? count : text(fields.count) || 0, ...recordMetadata(record) }];
  }).sort((left, right) => Number(right.count || 0) - Number(left.count || 0));
}

export function projectAssetReportData(sourceData = {}, assetRecords = []) {
  const byCategory = (category) => assetRecords.filter((record) => record.category === category);
  const websites = overlayRows(Array.isArray(sourceData.websites) ? sourceData.websites : [], byCategory("web"), sourceWebIdentity, recordWebIdentity, (item) => Boolean(text(item.url)), webRow)
    .map((row) => ({ ...row, alive: aliveLabel(row.alive) }));
  const ports = overlayRows(Array.isArray(sourceData.ports) ? sourceData.ports : [], byCategory("server"), sourcePortIdentity, recordPortIdentity, (item) => Boolean(text(item.ip) && text(item.port)), portRow)
    .map((row) => ({ ...row, alive: aliveLabel(row.alive) }));
  const dns = overlayRows(Array.isArray(sourceData.dns) ? sourceData.dns : [], byCategory("subdomain"), sourceDnsIdentity, recordDnsIdentity, (item) => Boolean(text(item.subdomain)), dnsRow);
  const fingerprintRecords = byCategory("fingerprint");
  return { ...sourceData, websites, ports, dns, fingerprints: fingerprintRows(sourceData, websites, fingerprintRecords), icons: iconRows(sourceData, fingerprintRecords) };
}

export function assetReportCounts(data = {}) {
  return {
    webCount: Array.isArray(data.websites) ? data.websites.length : 0,
    portCount: Array.isArray(data.ports) ? data.ports.length : 0,
    dnsCount: Array.isArray(data.dns) ? data.dns.length : 0,
    fingerprintCount: Array.isArray(data.fingerprints) ? data.fingerprints.length : 0,
    iconCount: Array.isArray(data.icons) ? data.icons.length : 0
  };
}

export function assetReportRowIsSince(row, since) {
  const timestamp = Date.parse(text(row?._first_seen_at));
  const threshold = Date.parse(text(since));
  return Number.isFinite(timestamp) && Number.isFinite(threshold) && timestamp >= threshold;
}

export function assetReportTodayCounts(data = {}, since = "") {
  const count = (rows) => (Array.isArray(rows) ? rows : []).filter((row) => assetReportRowIsSince(row, since)).length;
  return {
    web: count(data.websites),
    ports: count(data.ports),
    dns: count(data.dns),
    fingerprints: count(data.fingerprints),
    icons: count(data.icons)
  };
}
