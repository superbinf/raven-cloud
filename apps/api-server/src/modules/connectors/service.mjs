import { createHash } from "node:crypto";
import { assertEncryptedHttpUrl, createGuardedHttpClient, parseHostAllowlist } from "@sentinel/transport-security";
import { assetChangedFields } from "../../asset-change.mjs";

// 默认出网客户端：带 DNS pinning 与内网防护，仅放行 SENTINEL_CONNECTOR_ALLOWED_HOSTS 白名单内的内网地址，禁止重定向。
const defaultConnectorFetch = createGuardedHttpClient({
  allowlist: parseHostAllowlist(process.env.SENTINEL_CONNECTOR_ALLOWED_HOSTS),
  allowLoopback: false,
  redirect: "error"
});

function parseJson(value, fallback = {}) {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

function stringifyField(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function httpError(statusCode, message, details = {}) {
  return Object.assign(new Error(message), { statusCode, ...details });
}

function upstreamContext(url, method, response = null) {
  const parsed = new URL(url);
  return {
    upstreamMethod: method,
    upstreamOrigin: parsed.origin,
    upstreamPath: parsed.pathname,
    upstreamStatus: response?.status,
    upstreamContentType: response?.headers.get("content-type")?.slice(0, 160)
  };
}

function subscriptionUrl(endpoint, suffix) {
  const base = endpoint.replace(/\/+$/, "");
  return base.endsWith("/api/sub") ? `${base}/${suffix}/` : `${base}/api/sub/${suffix}/`;
}

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, number)) : fallback;
}

function watchVulnFeedUrl(row, { limit = 1, offset = 0, updatedSince = "" } = {}) {
  const endpoint = assertConnectorEndpoint(row.endpoint);
  const url = new URL(endpoint.endsWith("/api/v1/vulnerabilities") ? endpoint : `${endpoint}/api/v1/vulnerabilities`);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("offset", String(offset));
  if (updatedSince) url.searchParams.set("updated_since", updatedSince);
  return url;
}

function normalizedTimestamp(value, fallback) {
  const timestamp = Date.parse(String(value || ""));
  return Number.isNaN(timestamp) ? fallback : new Date(timestamp).toISOString();
}

function normalizedStrings(value, limit = 100) {
  return [...new Set((Array.isArray(value) ? value : []).map(stringifyField).map((item) => item.trim()).filter(Boolean))].slice(0, limit);
}

function vulnerabilityRisk(value) {
  const risk = stringifyField(value).toLowerCase();
  if (/(critical|严重|极高|致命)/u.test(risk)) return "critical";
  if (/(high|高危|高风险|^高$)/u.test(risk)) return "high";
  if (/(medium|中危|中风险|^中$)/u.test(risk)) return "medium";
  if (/(low|低危|低风险|^低$)/u.test(risk)) return "low";
  return "info";
}

export function assertConnectorEndpoint(value) {
  try { return assertEncryptedHttpUrl(value, { label: "API 地址" }).toString().replace(/\/$/, ""); }
  catch { throw httpError(400, "API 地址格式不正确；必须使用 HTTPS，且不能包含账号密码"); }
}

export function createConnectorService({ db, decrypt, fetchImpl = defaultConnectorFetch, onVulnerabilitiesChanged = async () => ({ matches: 0, inserted: 0, updated: 0 }), onAssetsChanged = async () => ({ matches: 0, inserted: 0, updated: 0 }) }) {
  async function autoPublishFor(tenantId, module, fallback) {
    const row = await db.prepare("SELECT mode FROM tenant_publication_policies WHERE tenant_id=? AND module=?").get(tenantId, module);
    return row?.mode ? row.mode === "auto" : fallback;
  }
  async function upstreamJson(url, { method = "GET", headers = {}, body, timeoutMs = 10_000 } = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, { method, headers: { Accept: "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal, timeoutMs });
      const text = await response.text();
      const context = upstreamContext(url, method, response);
      let data;
      try { data = JSON.parse(text); }
      catch {
        throw httpError(502, "上游服务返回格式不正确", {
          ...context,
          errorType: response.status >= 400 ? "upstream_http" : "upstream_format",
          errorCode: "UPSTREAM_NON_JSON"
        });
      }
      if (!response.ok) throw httpError(502, "上游服务请求失败", {
        ...context,
        errorType: "upstream_http",
        errorCode: `UPSTREAM_HTTP_${response.status}`
      });
      return data;
    } catch (error) {
      if (error?.upstreamOrigin) throw error;
      const context = upstreamContext(url, method);
      if (error?.name === "AbortError") {
        Object.assign(error, context, { errorType: "timeout", errorCode: "UPSTREAM_TIMEOUT" });
      } else {
        Object.assign(error, context, { errorType: "network", errorCode: error?.code || "UPSTREAM_NETWORK_ERROR" });
      }
      throw error;
    } finally { clearTimeout(timeout); }
  }

  async function upstreamPost(url, body, timeoutMs) {
    return upstreamJson(url, { method: "POST", headers: { "Content-Type": "application/json" }, body, timeoutMs });
  }

  async function testDarkwebSubscription(row) {
    const key = decrypt(row.api_key_enc);
    if (!key) return { ok: false, status: 401, message: "未配置 API Key", elapsedMs: 0, subscriptionCount: 0, checkedPaths: ["/api/sub/list/"] };
    const started = Date.now();
    const payload = await upstreamPost(subscriptionUrl(row.endpoint, "list"), { api_key: key }, row.timeout_ms);
    if (payload.code !== 0) return { ok: false, status: 401, message: "上游 API 鉴权失败", elapsedMs: Date.now() - started, subscriptionCount: 0, checkedPaths: ["/api/sub/list/"], mode: "upstream" };
    if (!Array.isArray(payload.data)) throw httpError(502, "订阅列表返回格式不正确");
    return { ok: true, status: 200, message: "真实上游订阅列表连接成功", elapsedMs: Date.now() - started, subscriptionCount: payload.data.length, checkedPaths: ["/api/sub/list/"], mode: "upstream" };
  }

  async function syncDarkwebSubscription(row) {
    const autoPublish = await autoPublishFor(row.tenant_id, "credentials", true);
    const key = decrypt(row.api_key_enc);
    if (!key) throw httpError(401, "未配置 API Key");
    const config = parseJson(row.config_json);
    // The upstream data service returns nginx 503 responses for larger pages.
    const pageSize = boundedInteger(config.pageSize, 20, 1, 20);
    const maxPages = boundedInteger(config.maxPages, 1000, 1, 1000);
    const fetchDataPage = async (sub, page) => {
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        try {
          return await upstreamPost(subscriptionUrl(row.endpoint, "data"), { sub_id: sub.id, page, page_size: pageSize, api_key: key }, row.timeout_ms);
        } catch (error) {
          const status = Number(error?.upstreamStatus || error?.statusCode || 0);
          const retryable = !status || status >= 500 || ["network", "timeout"].includes(error?.errorType);
          if (!retryable || attempt === 5) {
            Object.assign(error, { credentialSubId: sub.id, credentialPage: page, credentialPageSize: pageSize });
            throw error;
          }
          await new Promise((resolve) => setTimeout(resolve, Math.min(1000, 100 * (2 ** (attempt - 1)))));
        }
      }
      throw new Error("凭据分页重试状态异常");
    };
    const list = await upstreamPost(subscriptionUrl(row.endpoint, "list"), { api_key: key }, row.timeout_ms);
    if (list.code !== 0) throw httpError(401, list.message || "上游 API 鉴权失败");
    if (!Array.isArray(list.data)) throw httpError(502, "订阅列表返回格式不正确");
    await db.prepare("DELETE FROM credential_records WHERE source='local-api-debug' AND sub_id IN (SELECT id FROM credential_subscriptions WHERE target_id=?)").run(row.target_id);
    await db.prepare("DELETE FROM credential_subscriptions WHERE target_id=? AND user_permission_id='changan-debug-permission'").run(row.target_id);
    const firstSeenAt = new Date().toISOString();
    let recordCount = 0;
    for (const sub of list.data.filter((item) => item.sub_type === "credential-leak")) {
      const upstreamSubscriptionId = stringifyField(sub.id).trim();
      if (!upstreamSubscriptionId) throw httpError(502, "凭据订阅缺少上游 ID", { errorType: "upstream_format", errorCode: "CREDENTIAL_SUBSCRIPTION_ID_MISSING" });
      let storedSubscription = await db.prepare(`SELECT id FROM credential_subscriptions
        WHERE tenant_id=? AND source_connection_id=? AND upstream_id=?`).get(row.tenant_id, row.id, upstreamSubscriptionId);
      if (!storedSubscription) {
        const legacyId = Number(upstreamSubscriptionId);
        if (Number.isSafeInteger(legacyId) && legacyId > 0) {
          storedSubscription = await db.prepare(`SELECT id FROM credential_subscriptions
            WHERE id=? AND tenant_id=? AND source_connection_id IS NULL AND upstream_id IS NULL`).get(legacyId, row.tenant_id);
        }
      }
      if (storedSubscription) {
        await db.prepare(`UPDATE credential_subscriptions SET
          target_id=?,sub_type=?,sub_category=?,user_permission_id=?,value=?,expire_time=?,count=?,source_connection_id=?,upstream_id=?
          WHERE id=? AND tenant_id=?`)
          .run(row.target_id, sub.sub_type, sub.sub_category, sub.user_permission_id || "", sub.value, sub.expire_time, sub.count || 0, row.id, upstreamSubscriptionId, storedSubscription.id, row.tenant_id);
      } else {
        storedSubscription = await db.prepare(`INSERT INTO credential_subscriptions
          (target_id,sub_type,sub_category,user_permission_id,value,expire_time,count,tenant_id,source_connection_id,upstream_id)
          VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING id`)
          .get(row.target_id, sub.sub_type, sub.sub_category, sub.user_permission_id || "", sub.value, sub.expire_time, sub.count || 0, row.tenant_id, row.id, upstreamSubscriptionId);
      }
      const subscriptionId = Number(storedSubscription.id);
      const expectedCount = Math.max(0, Math.floor(Number(sub.count) || 0));
      const expectedPages = expectedCount ? Math.ceil(expectedCount / pageSize) : maxPages;
      if (expectedPages > maxPages) throw httpError(502, `订阅 ${sub.value} 共 ${expectedCount} 条，超过当前采集上限 ${maxPages * pageSize} 条`, { errorType: "upstream_format", errorCode: "CREDENTIAL_PAGE_LIMIT" });
      let subscriptionRecordCount = 0;
      for (let page = 1; page <= expectedPages; page += 1) {
        const result = await fetchDataPage(sub, page);
        if (result.code !== undefined && Number(result.code) !== 0) throw httpError(502, result.message || `订阅 ${sub.value} 第 ${page} 页采集失败`);
        if (!Array.isArray(result.data)) throw httpError(502, `订阅 ${sub.value} 第 ${page} 页返回格式不正确`);
        for (const item of result.data) {
          const source = item._source || {};
          const upstreamRecordId = stringifyField(item._id).trim();
          if (!upstreamRecordId) throw httpError(502, "凭据记录缺少上游 ID", { errorType: "upstream_format", errorCode: "CREDENTIAL_RECORD_ID_MISSING" });
          const msg = source.msg && typeof source.msg === "object" ? source.msg : {};
          let original = {};
          if (typeof source.original_other === "string") {
            try { original = JSON.parse(source.original_other || "{}"); } catch {}
          } else if (source.original_other && typeof source.original_other === "object") original = source.original_other;
          const displayUrl = (Array.isArray(original) ? original[0] : original.url || original.domain || original.root_domain) || msg.url || msg.domain || msg.root_domain || source.domain || source.root_domain || "";
          let systemName = source.name && source.name !== "-" ? source.name.trim() : "未知系统";
          try { if (systemName === "未知系统" && displayUrl) systemName = new URL(displayUrl.includes("://") ? displayUrl : `https://${displayUrl}`).hostname; } catch {}
          let storedRecord = await db.prepare(`SELECT id FROM credential_records
            WHERE tenant_id=? AND source_connection_id=? AND upstream_id=?`).get(row.tenant_id, row.id, upstreamRecordId);
          if (!storedRecord) {
            storedRecord = await db.prepare(`SELECT id FROM credential_records
              WHERE id=? AND tenant_id=? AND source_connection_id IS NULL AND upstream_id IS NULL`).get(upstreamRecordId, row.tenant_id);
          }
          const recordValues = [
            subscriptionId, stringifyField(displayUrl), stringifyField(systemName), stringifyField(source.account || source.email || ""),
            stringifyField(source.msg?.pwd || source.password || ""), stringifyField(source.timestamp || source.find_time || ""),
            stringifyField(source.source || "darkweb-api"), JSON.stringify({ ...source, original_other: original }),
            autoPublish, autoPublish ? firstSeenAt : null, row.tenant_id, row.id, upstreamRecordId
          ];
          if (storedRecord) {
            await db.prepare(`UPDATE credential_records SET
              sub_id=?,url=?,system_name=?,account=?,password=?,leaked_at=?,source=?,raw_json=?,is_published=?,reviewed_at=?,
              tenant_id=?,source_connection_id=?,upstream_id=?
              WHERE id=?`).run(...recordValues, storedRecord.id);
          } else {
            const internalRecordId = `CRED-${createHash("sha256").update(`${row.tenant_id}|${row.id}|${upstreamRecordId}`).digest("hex").slice(0, 24).toUpperCase()}`;
            await db.prepare(`INSERT INTO credential_records
              (id,sub_id,url,system_name,account,password,leaked_at,source,raw_json,first_seen_at,is_published,reviewed_at,tenant_id,source_connection_id,upstream_id)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
              .run(internalRecordId, ...recordValues.slice(0, 8), firstSeenAt, ...recordValues.slice(8));
          }
        }
        subscriptionRecordCount += result.data.length;
        recordCount += result.data.length;
        if (result.data.length < pageSize) break;
        if (!expectedCount && page === maxPages) throw httpError(502, `订阅 ${sub.value} 记录超过当前采集上限 ${maxPages * pageSize} 条`, { errorType: "upstream_format", errorCode: "CREDENTIAL_PAGE_LIMIT" });
      }
      if (expectedCount && subscriptionRecordCount < expectedCount) throw httpError(502, `订阅 ${sub.value} 声明 ${expectedCount} 条，但上游分页仅返回 ${subscriptionRecordCount} 条`, { errorType: "upstream_format", errorCode: "CREDENTIAL_INCOMPLETE" });
    }
    return { ok: true, message: autoPublish ? "真实上游数据同步完成并自动发布" : "真实上游数据已同步到待审核区", subscriptions: list.data.length, records: recordCount, status: autoPublish ? "已发布" : "待审核", mode: "upstream" };
  }

  function hunterSearchUrl(row, pageSize = 1) {
    const config = parseJson(row.config_json);
    const endpoint = assertConnectorEndpoint(row.endpoint);
    const url = new URL(endpoint.endsWith("/openApi/search") ? endpoint : `${endpoint}/openApi/search`);
    const query = String(config.query || "domain=\"example.com\"");
    url.searchParams.set("api-key", decrypt(row.api_key_enc));
    url.searchParams.set("search", Buffer.from(query).toString("base64"));
    url.searchParams.set("page", "1");
    url.searchParams.set("page_size", String(pageSize));
    url.searchParams.set("is_web", config.isWeb === false ? "2" : "3");
    return { url, query };
  }

  async function testHunter(row) {
    if (!decrypt(row.api_key_enc)) return { ok: false, status: 401, message: "未配置 Hunter API Key", elapsedMs: 0, subscriptionCount: 0, checkedPaths: ["/openApi/search"] };
    const started = Date.now(); const { url } = hunterSearchUrl(row, 1); const payload = await upstreamJson(url, { timeoutMs: row.timeout_ms || 15_000 });
    if (payload.code !== undefined && Number(payload.code) !== 200 && Number(payload.code) !== 0) return { ok: false, status: 401, message: "Hunter API 鉴权失败", elapsedMs: Date.now() - started, subscriptionCount: 0, checkedPaths: ["/openApi/search"], mode: "upstream" };
    return { ok: true, status: 200, message: "Hunter 资产检索连接成功", elapsedMs: Date.now() - started, subscriptionCount: Number(payload.data?.total || payload.total || 0), checkedPaths: ["/openApi/search"], mode: "upstream" };
  }

  async function syncHunter(row) {
    if (!decrypt(row.api_key_enc)) throw httpError(401, "未配置 Hunter API Key");
    const config = parseJson(row.config_json); const pageSize = Math.min(100, Math.max(1, Number(config.pageSize || 100)));
    const autoPublish = await autoPublishFor(row.tenant_id, "asset", false);
    const { url, query } = hunterSearchUrl(row, pageSize); const payload = await upstreamJson(url, { timeoutMs: row.timeout_ms || 30_000 });
    if (payload.code !== undefined && Number(payload.code) !== 200 && Number(payload.code) !== 0) throw httpError(502, payload.message || "Hunter API 请求失败");
    const records = Array.isArray(payload.data?.arr) ? payload.data.arr : Array.isArray(payload.data) ? payload.data : Array.isArray(payload.results) ? payload.results : [];
    const now = new Date().toISOString(); let inserted = 0; let updated = 0;
    for (const item of records) {
      const urlValue = stringifyField(item.url || item.web_url || item.domain || item.ip || "");
      const fields = {
        ...item,
        alive: stringifyField(item.alive),
        statusCode: stringifyField(item.statusCode ?? item.status_code),
        collector: "hunter",
        query
      };
      const recordHash = createHash("sha256").update(`hunter|${stringifyField(item.ip)}|${stringifyField(item.port)}|${urlValue}`).digest("hex");
      const current = await db.prepare("SELECT * FROM asset_records WHERE tenant_id=? AND target_id=? AND record_hash=?").get(row.tenant_id, row.target_id, recordHash);
      if (current) {
        const nextFields = JSON.stringify(fields);
        const changed = assetChangedFields(parseJson(current.fields_json), fields).length > 0;
        const pendingChange = !current.is_published && ["new", "changed", "reappeared", "missing"].includes(current.change_type);
        const preservePendingChange = !changed && pendingChange;
        const changeType = preservePendingChange ? current.change_type : changed ? "changed" : "unchanged";
        const previouslyPublished = Boolean(current.is_published || current.previously_published);
        await db.prepare(`UPDATE asset_records SET last_seen_at=?,import_status=?,import_count=import_count+1,fields_json=?,title=?,
          is_published=?,reviewed_at=?,change_type=?,previous_fields_json=?,present_in_latest_batch=TRUE,previously_published=?,last_changed_at=?,missing_since=NULL
          WHERE tenant_id=? AND target_id=? AND record_hash=?`).run(
          now, changed ? "状态变化" : preservePendingChange ? current.import_status : "已存在", nextFields, urlValue || stringifyField(item.ip) || "Hunter 资产",
          changed ? autoPublish : Boolean(current.is_published), changed ? autoPublish ? now : null : current.reviewed_at,
          changeType, changed ? current.fields_json : preservePendingChange ? current.previous_fields_json : null,
          changed && !autoPublish ? previouslyPublished : preservePendingChange ? Boolean(current.previously_published) : false,
          changed ? now : current.last_changed_at,
          row.tenant_id, row.target_id, recordHash
        );
        updated += 1;
      } else {
        const recordId = createHash("sha256").update(`${row.tenant_id}|${row.target_id}|${recordHash}`).digest("hex").slice(0, 20);
        await db.prepare(`INSERT INTO asset_records
          (id,category,target_id,title,risk,fields_json,record_hash,first_seen_at,last_seen_at,import_status,import_count,batch_id,tenant_id,is_published,reviewed_at,change_type,present_in_latest_batch,previously_published,last_changed_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,TRUE,FALSE,?)`)
          .run(`ASSET-hunter-${recordId}`, "web", row.target_id, urlValue || stringifyField(item.ip) || "Hunter 资产", "未标记", JSON.stringify(fields), recordHash, now, now, "新增", 1, null, row.tenant_id, autoPublish, autoPublish ? now : null, "new", now);
        inserted += 1;
      }
    }
    const alerts = autoPublish ? await onAssetsChanged(row.tenant_id) : null;
    return { ok: true, message: autoPublish ? "Hunter 资产数据同步完成并自动发布" : "Hunter 资产数据已同步到待审核区", records: records.length, inserted, updated, status: autoPublish ? "已发布" : "待审核", alerts, mode: "upstream" };
  }

  async function testGenericJson(row) {
    const started = Date.now(); const headers = {}; const key = decrypt(row.api_key_enc); const config = parseJson(row.config_json);
    if (key) headers[config.headerName || "Authorization"] = config.headerPrefix === "" ? key : `${config.headerPrefix || "Bearer"} ${key}`;
    await upstreamJson(assertConnectorEndpoint(row.endpoint), { method: row.method || "GET", headers, body: row.method === "GET" ? undefined : (config.requestBody || {}), timeoutMs: row.timeout_ms || 15_000 });
    return { ok: true, status: 200, message: "通用 JSON API 连接成功", elapsedMs: Date.now() - started, subscriptionCount: 0, checkedPaths: [new URL(row.endpoint).pathname || "/"], mode: "upstream" };
  }

  async function watchVulnPage(row, options) {
    const token = decrypt(row.api_key_enc);
    if (!token) throw httpError(401, "未配置 WatchVuln Feed Token");
    const url = watchVulnFeedUrl(row, options);
    const payload = await upstreamJson(url, {
      headers: { Authorization: `Bearer ${token}` },
      timeoutMs: row.timeout_ms || 30_000
    });
    if (!payload || !Array.isArray(payload.items) || !Number.isFinite(Number(payload.total))) {
      throw httpError(502, "WatchVuln Feed 返回格式不正确", { errorType: "upstream_format", errorCode: "WATCHVULN_INVALID_RESPONSE" });
    }
    return { payload, url };
  }

  async function testWatchVuln(row) {
    const started = Date.now();
    const { payload, url } = await watchVulnPage(row, { limit: 1, offset: 0 });
    return {
      ok: true,
      status: 200,
      message: "WatchVuln 漏洞 Feed 连接成功",
      elapsedMs: Date.now() - started,
      subscriptionCount: Number(payload.total),
      checkedPaths: [url.pathname],
      mode: "upstream"
    };
  }

  async function syncWatchVuln(row) {
    const config = parseJson(row.config_json);
    const pageSize = boundedInteger(config.pageSize, 500, 1, 500);
    const maxPages = boundedInteger(config.maxPages, 200, 1, 1000);
    const autoPublish = await autoPublishFor(row.tenant_id, "vulnerabilities", config.autoPublish !== false);
    const previousSync = Date.parse(row.last_sync_at || "");
    const [feedHead, stored] = await Promise.all([
      watchVulnPage(row, { limit: 1, offset: 0 }),
      db.prepare("SELECT COUNT(*) AS count FROM vulnerability_records WHERE tenant_id=? AND source_connection_id=?").get(row.tenant_id, row.id)
    ]);
    const backfill = Number(stored.count) < Number(feedHead.payload.total);
    const updatedSince = config.incremental !== false && Number.isFinite(previousSync) && !backfill
      ? new Date(previousSync - 10 * 60_000).toISOString()
      : "";
    let offset = 0;
    let total = 0;
    const records = [];
    for (let page = 0; page < maxPages; page += 1) {
      const result = await watchVulnPage(row, { limit: pageSize, offset, updatedSince });
      total = Number(result.payload.total);
      records.push(...result.payload.items);
      offset += result.payload.items.length;
      if (offset >= total || result.payload.items.length === 0) break;
    }
    if (offset < total) {
      throw httpError(502, `WatchVuln Feed 记录超过当前采集上限（${maxPages * pageSize} 条）`, { errorType: "upstream_format", errorCode: "WATCHVULN_PAGE_LIMIT" });
    }

    const now = new Date().toISOString();
    let inserted = 0;
    let updated = 0;
    let suppressed = 0;
    let autoPublished = 0;
    for (const item of records) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const sourceKey = stringifyField(item.key || item.id).trim().slice(0, 1024);
      const title = stringifyField(item.title).trim().slice(0, 4096);
      if (!sourceKey || !title) continue;
      const suppression = await db.prepare("SELECT id FROM vulnerability_suppressions WHERE tenant_id=? AND COALESCE(source_connection_id,'')=COALESCE(?,'') AND source_key=?").get(row.tenant_id, row.id, sourceKey);
      if (suppression) { suppressed += 1; continue; }
      const recordId = `VULN-${createHash("sha256").update(`${row.tenant_id}|${row.id}|${sourceKey}`).digest("hex").slice(0, 24)}`;
      const current = await db.prepare("SELECT id,manually_managed FROM vulnerability_records WHERE tenant_id=? AND source_connection_id=? AND source_key=?").get(row.tenant_id, row.id, sourceKey);
      const createdAt = normalizedTimestamp(item.createdAt, now);
      const updatedAt = normalizedTimestamp(item.updatedAt, createdAt);
      const disclosureAt = item.disclosure ? normalizedTimestamp(item.disclosure, updatedAt) : null;
      const references = normalizedStrings(item.references);
      const tags = normalizedStrings(item.tags);
      const values = {
        cve: stringifyField(item.cve).trim().toUpperCase().slice(0, 128),
        summary: stringifyField(item.description).slice(0, 100_000),
        risk: vulnerabilityRisk(item.severity),
        source: stringifyField(item.source || "WatchVuln_Web").trim().slice(0, 1024) || "WatchVuln_Web",
        solutions: stringifyField(item.solutions).slice(0, 100_000)
      };
      if (current) {
        if (current.manually_managed) {
          await db.prepare("UPDATE vulnerability_records SET raw_json=?,source_updated_at=?,last_seen_at=?,import_count=import_count+1 WHERE id=?")
            .run(JSON.stringify(item), updatedAt, now, current.id);
        } else {
          await db.prepare(`UPDATE vulnerability_records SET target_id=?,cve=?,title=?,summary=?,risk=?,source=?,disclosure_at=?,solutions=?,references_json=?,tags_json=?,raw_json=?,source_created_at=?,source_updated_at=?,last_seen_at=?,import_count=import_count+1,is_published=?,reviewed_at=? WHERE id=?`)
            .run(row.target_id, values.cve, title, values.summary, values.risk, values.source, disclosureAt, values.solutions, JSON.stringify(references), JSON.stringify(tags), JSON.stringify(item), createdAt, updatedAt, now, autoPublish, autoPublish ? now : null, current.id);
          if (autoPublish) autoPublished += 1;
        }
        updated += 1;
      } else {
        await db.prepare(`INSERT INTO vulnerability_records (id,tenant_id,target_id,source_connection_id,source_key,cve,title,summary,risk,source,disclosure_at,solutions,references_json,tags_json,raw_json,source_created_at,source_updated_at,first_seen_at,last_seen_at,import_count,status,is_published,reviewed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(recordId, row.tenant_id, row.target_id, row.id, sourceKey, values.cve, title, values.summary, values.risk, values.source, disclosureAt, values.solutions, JSON.stringify(references), JSON.stringify(tags), JSON.stringify(item), createdAt, updatedAt, now, now, 1, "待处置", autoPublish, autoPublish ? now : null);
        inserted += 1;
        if (autoPublish) autoPublished += 1;
      }
    }
    const alerts = autoPublish ? await onVulnerabilitiesChanged(row.tenant_id) : null;
    return {
      ok: true,
      message: autoPublish ? "WatchVuln 漏洞情报已同步并自动发布" : "WatchVuln 漏洞情报已同步到待审核区",
      records: records.length, inserted, updated, suppressed, autoPublished,
      status: autoPublish ? "已发布" : "待审核", alerts,
      incremental: Boolean(updatedSince), backfill, feedTotal: Number(feedHead.payload.total), mode: "upstream"
    };
  }

  const providers = {
    darkweb_subscription: { label: "暗网凭据订阅", defaultCategory: "凭据泄露", test: testDarkwebSubscription, sync: syncDarkwebSubscription },
    hunter_asset: { label: "Hunter 资产测绘", defaultCategory: "互联网资产", test: testHunter, sync: syncHunter },
    watchvuln: { label: "WatchVuln 漏洞情报", defaultCategory: "漏洞情报", test: testWatchVuln, sync: syncWatchVuln },
    generic_json: { label: "通用 JSON API", defaultCategory: "其他", test: testGenericJson, sync: null }
  };

  function providerFor(row) {
    const provider = providers[row.provider_type || "darkweb_subscription"];
    if (!provider) throw httpError(400, "不支持的连接器类型");
    return provider;
  }

  return {
    providers,
    catalog: () => Object.entries(providers).map(([type, provider]) => ({ type, label: provider.label, defaultCategory: provider.defaultCategory, supportsSync: Boolean(provider.sync) })),
    assertEndpoint: assertConnectorEndpoint,
    testConnection(row) { return providerFor(row).test(row); },
    syncConnection(row) {
      if (!row.enabled) throw httpError(409, "连接器已停用");
      const provider = providerFor(row);
      if (!provider.sync) throw httpError(409, "该连接器只支持健康检查，尚未配置入库适配器");
      return provider.sync(row);
    }
  };
}
