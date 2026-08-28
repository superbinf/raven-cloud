import { useEffect, useState, type FormEvent } from "react";
import { Database, FilePenLine, Pencil, Plus, Search, Send, Trash2 } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { type IngestionType, type ManagedIngestionRecord, type ManagedIngestionRecordsPageResult, type MonitoringTarget, type RiskLevel } from "@sentinel/shared";
import { Button, Modal, Panel, RiskBadge, Tag } from "@/components/ui";
import { DeleteConfirmation, SelectionCell, SelectionHeader, SequenceCell, SequenceHeader, type ToastState } from "@/components/business/AdminPrimitives";
import { TablePagination } from "@/components/business/TablePagination";
import { adminApiFetch as apiFetch } from "@/api/admin";
import { useAdminInitialLoading } from "@/hooks/useAdminInitialLoading";

type RelationalMode = "sensitive" | "asset";
type FieldDefinition = { key: string; label: string; placeholder?: string; multiline?: boolean; options?: Array<[string, string]> };

const aliveOptions: Array<[string, string]> = [["", "未知"], ["true", "存活"], ["false", "未存活"]];

const categories = {
  sensitive: [["account-password", "账号口令"], ["source-code", "源码泄露"], ["documents", "文档泄露"], ["phishing", "仿冒网站"]],
  asset: [["subdomain", "DNS / 子域名"], ["server", "端口 / 服务器"], ["web", "Web 资产"], ["fingerprint", "指纹列表"]],
  "dark-web": []
} satisfies Record<IngestionType, Array<[string, string]>>;

const fieldSchemas: Record<RelationalMode, Record<string, FieldDefinition[]>> = {
  sensitive: {
    "account-password": [{ key: "type", label: "类型" }, { key: "systemName", label: "系统名称" }, { key: "loginUrl", label: "登录地址" }, { key: "account", label: "账号" }, { key: "password", label: "密码" }, { key: "source", label: "信息来源" }, { key: "note", label: "备注", multiline: true }],
    "source-code": [{ key: "name", label: "源码名称" }, { key: "channel", label: "泄漏渠道" }, { key: "content", label: "泄漏内容", multiline: true }, { key: "note", label: "备注", multiline: true }],
    documents: [{ key: "name", label: "文档名称" }, { key: "channel", label: "泄漏渠道" }, { key: "content", label: "泄漏内容", multiline: true }, { key: "note", label: "备注", multiline: true }],
    phishing: [{ key: "type", label: "仿冒网站类型" }, { key: "name", label: "仿冒网站名称" }, { key: "url", label: "网站链接" }, { key: "note", label: "备注", multiline: true }]
  },
  asset: {
    subdomain: [{ key: "rootDomain", label: "根域名" }, { key: "subdomain", label: "子域名" }, { key: "ipAlias", label: "IP / 别名" }],
    server: [{ key: "address", label: "地址" }, { key: "serviceType", label: "服务类型" }, { key: "protocol", label: "协议" }, { key: "port", label: "端口" }, { key: "alive", label: "存活状态", options: aliveOptions }, { key: "riskFlag", label: "风险标记" }, { key: "note", label: "备注", multiline: true }],
    web: [{ key: "url", label: "URL" }, { key: "ipAddress", label: "IP 地址" }, { key: "domain", label: "域名" }, { key: "protocol", label: "协议" }, { key: "port", label: "端口" }, { key: "alive", label: "存活状态", options: aliveOptions }, { key: "statusCode", label: "状态码" }, { key: "title", label: "网站标题" }, { key: "application", label: "应用 / 组件" }, { key: "registrationUnit", label: "备案单位" }, { key: "registrationNo", label: "备案号" }, { key: "riskFlag", label: "风险标记" }, { key: "note", label: "备注", multiline: true }],
    fingerprint: [{ key: "fingerprintType", label: "指纹类型" }, { key: "name", label: "指纹名称" }, { key: "productType", label: "产品类型" }, { key: "nameAndType", label: "产品与类型" }, { key: "count", label: "命中数量" }, { key: "iconHashMd5", label: "图标 MD5" }, { key: "dataSource", label: "数据来源" }]
  }
};

const labels: Record<IngestionType, string> = { sensitive: "敏感信息", asset: "资产信息", "dark-web": "暗网情报" };
const darkWebRiskLabels: Record<string, string> = { critical: "严重", high: "高危", medium: "中危", low: "低危" };

function localDateTime(value?: string) {
  if (!value) return new Date().toISOString().slice(0, 16);
  const date = new Date(value); if (Number.isNaN(date.getTime())) return value.slice(0, 16);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function recordHighlights(record: ManagedIngestionRecord) {
  if (record.type === "dark-web") return [{ label: "来源", value: record.sourceGroupName }, { label: "泄漏类型", value: record.leakDataTypes }, { label: "消息", value: record.messageUrl }].filter((item) => item.value);
  const schema = fieldSchemas[record.type][record.category || ""] || [];
  return schema.map((field) => ({ label: field.label, value: record.fields?.[field.key] })).filter((item) => item.value).slice(0, 5);
}

const assetChangeLabels: Record<string, string> = { baseline: "初始基线", new: "新增资产", changed: "状态变化", reappeared: "重新出现", missing: "本批消失", unchanged: "未变化" };
const assetChangeTones: Record<string, "default" | "green" | "orange" | "pink"> = { baseline: "default", new: "green", changed: "pink", reappeared: "green", missing: "orange", unchanged: "default" };

function assetFieldValue(value: unknown) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function comparableAssetField(key: string, value: unknown) {
  const text = assetFieldValue(value).toLowerCase();
  if (key !== "alive") return text;
  if (["true", "1", "alive", "up", "存活"].includes(text)) return "alive";
  if (["false", "0", "dead", "down", "未存活"].includes(text)) return "dead";
  return text;
}

function assetFieldLabel(key: string, value: unknown) {
  const text = assetFieldValue(value);
  if (key !== "alive") return text || "--";
  if (["true", "1", "alive", "up", "存活"].includes(text.toLowerCase())) return "存活";
  if (["false", "0", "dead", "down", "未存活"].includes(text.toLowerCase())) return "未存活";
  return text || "--";
}

function assetPrimaryChanges(record: ManagedIngestionRecord) {
  if (record.type !== "asset" || !record.previousFields || !record.fields) return [];
  const previousFields = record.previousFields;
  const fields = record.fields;
  return ["alive", "statusCode"].filter((key) => (
    Object.prototype.hasOwnProperty.call(previousFields, key)
    && Object.prototype.hasOwnProperty.call(fields, key)
    && comparableAssetField(key, previousFields[key]) !== comparableAssetField(key, fields[key])
  ));
}

function assetFieldsDiffer(record: ManagedIngestionRecord) {
  return assetPrimaryChanges(record).length > 0;
}

function assetDisplayChangeType(record: ManagedIngestionRecord) {
  if (record.type !== "asset") return "";
  if (["new", "reappeared", "missing"].includes(record.changeType || "")) return record.changeType || "";
  if (assetFieldsDiffer(record)) return "changed";
  if (record.changeType && record.changeType !== "baseline") return record.changeType;
  if ((record.importCount || 0) > 1) return "unchanged";
  return record.changeType || "baseline";
}

function AssetChangeTag({ record }: { record: ManagedIngestionRecord }) {
  const changeType = assetDisplayChangeType(record);
  if (!changeType) return null;
  const primaryChange = changeType === "changed" ? assetPrimaryChanges(record)[0] : "";
  const label = primaryChange
    ? `${primaryChange === "alive" ? "" : "状态码 "}${assetFieldLabel(primaryChange, record.previousFields?.[primaryChange])} → ${assetFieldLabel(primaryChange, record.fields?.[primaryChange])}`
    : assetChangeLabels[changeType] || changeType;
  return <Tag tone={assetChangeTones[changeType] || "default"}>{label}</Tag>;
}

function assetChangeSummary(record: ManagedIngestionRecord) {
  return assetPrimaryChanges(record).map((key) => `${key === "alive" ? "存活状态" : "状态码"} ${assetFieldLabel(key, record.previousFields?.[key])} → ${assetFieldLabel(key, record.fields?.[key])}`).join(" · ");
}

function fieldEditorValue(field: FieldDefinition, value: unknown) {
  if (field.key === "alive") {
    const normalized = comparableAssetField("alive", value);
    if (normalized === "alive") return "true";
    if (normalized === "dead") return "false";
  }
  return assetFieldValue(value);
}

function recordPublicationLabel(record: ManagedIngestionRecord) {
  if (record.type === "asset" && record.changeType === "missing" && record.reviewedAt && !record.previouslyPublished) return "已从地端移除";
  return record.isPublished ? "已发送" : record.reviewedAt ? "待发送" : "待审核";
}

export function IngestionRecordManager({ mode, targets, tenantId, refreshVersion, onToast, onMutate }: { mode: IngestionType; targets: MonitoringTarget[]; tenantId?: string; refreshVersion: number; onToast: (toast: ToastState) => void; onMutate: () => void }) {
  const navigate = useNavigate(); const location = useLocation();
  const [records, setRecords] = useState<ManagedIngestionRecord[]>([]); const [total, setTotal] = useState(0); const [page, setPage] = useState(1); const [pageSize, setPageSize] = useState(20);
  const [query, setQuery] = useState(""); const [targetFilter, setTargetFilter] = useState(""); const [categoryFilter, setCategoryFilter] = useState(""); const [publication, setPublication] = useState("");
  const [loading, setLoading] = useState(true); const [open, setOpen] = useState(false); const [editing, setEditing] = useState<ManagedIngestionRecord | null>(null); const [editorCategory, setEditorCategory] = useState("");
  const [deleting, setDeleting] = useState<ManagedIngestionRecord | null>(null); const [saving, setSaving] = useState(false); const [publishingId, setPublishingId] = useState(""); const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set()); const [selectAllMatching, setSelectAllMatching] = useState(false); const [publishingSelected, setPublishingSelected] = useState(false);
  const [publishAllOpen, setPublishAllOpen] = useState(false); const [publishingAll, setPublishingAll] = useState(false);
  useAdminInitialLoading(`ingestion-records-${mode}`, loading);

  const loadRecords = async () => {
    const params = new URLSearchParams({ type: mode, page: String(page), page_size: String(pageSize) });
    if (tenantId) params.set("tenant_id", tenantId); if (query.trim()) params.set("query", query.trim()); if (targetFilter) params.set("target_id", targetFilter); if (categoryFilter && mode !== "dark-web") params.set("category", categoryFilter); if (publication) params.set("publication", publication);
    setLoading(true);
    try { const result = await apiFetch<ManagedIngestionRecordsPageResult>(`/api/ingestion/records?${params}`); setRecords(result.data); setTotal(result.total); }
    catch (error) { onToast({ tone: "warning", text: error instanceof Error ? error.message : "数据记录加载失败" }); }
    finally { setLoading(false); }
  };

  useEffect(() => { setPage(1); setQuery(""); setTargetFilter(""); setCategoryFilter(""); setPublication(""); }, [mode, tenantId]);
  useEffect(() => { void loadRecords(); }, [mode, tenantId, page, pageSize, query, targetFilter, categoryFilter, publication, refreshVersion]);
  useEffect(() => { setSelected(new Set()); setSelectAllMatching(false); }, [mode, tenantId, query, targetFilter, categoryFilter, publication]);

  const visibleIds = records.map((record) => record.id); const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
  const selectedCount = selectAllMatching ? total : selected.size;
  const toggle = (id: string) => { setSelectAllMatching(false); setSelected((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; }); };
  const toggleVisible = () => { if (selectAllMatching) { setSelectAllMatching(false); setSelected(new Set()); return; } setSelected((current) => { const next = new Set(current); if (allVisibleSelected) visibleIds.forEach((id) => next.delete(id)); else visibleIds.forEach((id) => next.add(id)); return next; }); };
  const clearSelection = () => { setSelected(new Set()); setSelectAllMatching(false); };

  const openEditor = (record?: ManagedIngestionRecord) => { setEditing(record || null); setEditorCategory(record?.category || (mode === "dark-web" ? "" : categories[mode][0][0])); setOpen(true); };
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const intent = ((event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null)?.value || "draft"; const form = new FormData(event.currentTarget);
    let body: Record<string, unknown> = { type: mode, targetId: String(form.get("targetId") || ""), title: String(form.get("title") || "").trim() };
    try {
      if (mode === "dark-web") {
        const intelTags = form.getAll("intelTags").map(String); if (!intelTags.length) throw new Error("至少选择一个情报标签");
        body = { ...body, risk: String(form.get("risk") || "low"), reportDate: String(form.get("reportDate") || ""), sourceGroupName: String(form.get("sourceGroupName") || "").trim(), sourceGroupId: String(form.get("sourceGroupId") || "").trim(), sourceGroupUrl: String(form.get("sourceGroupUrl") || "").trim(), messageUrl: String(form.get("messageUrl") || "").trim(), intelTags, leakDataTypes: String(form.get("leakDataTypes") || "").trim(), leakCount: String(form.get("leakCount") || "").trim(), transactionCount: String(form.get("transactionCount") || "").trim(), transactionPrice: String(form.get("transactionPrice") || "").trim(), publishedAt: String(form.get("publishedAt") || ""), publisherId: String(form.get("publisherId") || "").trim(), intelNote: String(form.get("intelNote") || "").trim(), articleMarkdown: editing?.articleMarkdown?.trim() || "" };
      } else {
        const fields = Object.fromEntries((fieldSchemas[mode][editorCategory] || []).map((field) => [field.key, String(form.get(`field_${field.key}`) || "").trim()]));
        body = { ...body, category: editorCategory, risk: String(form.get("risk") || "未标记"), fields };
      }
      setSaving(true);
      const saved = await apiFetch<ManagedIngestionRecord>(editing ? `/api/ingestion/records/${mode}/${encodeURIComponent(editing.id)}` : "/api/ingestion/records", { method: editing ? "PUT" : "POST", body: JSON.stringify(body) });
      if (intent === "publish") await apiFetch(`/api/ingestion/records/${mode}/${encodeURIComponent(saved.id)}/publish`, { method: "POST" });
      setOpen(false); setEditing(null);
      if (mode === "dark-web" && intent === "edit-article") {
        onToast({ tone: "success", text: `${saved.title} 的基础信息已保存` });
        navigate(`/admin/customer-operations/ingestion/dark-web/editor/${encodeURIComponent(saved.id)}${location.search}`);
      } else {
        onToast({ tone: "success", text: intent === "publish" ? `${saved.title} 已保存并发布` : `${saved.title} 已保存为草稿` });
        await loadRecords(); onMutate();
      }
    } catch (error) { onToast({ tone: "warning", text: error instanceof Error ? error.message : "记录保存失败" }); }
    finally { setSaving(false); }
  };
  const remove = async () => { if (!deleting) return; setConfirmingDelete(true); try { await apiFetch(`/api/ingestion/records/${mode}/${encodeURIComponent(deleting.id)}`, { method: "DELETE" }); onToast({ tone: "success", text: `${deleting.title} 已删除` }); setDeleting(null); await loadRecords(); onMutate(); } catch (error) { onToast({ tone: "warning", text: error instanceof Error ? error.message : "记录删除失败" }); } finally { setConfirmingDelete(false); } };
  const publish = async (record: ManagedIngestionRecord) => { setPublishingId(record.id); try { await apiFetch(`/api/ingestion/records/${mode}/${encodeURIComponent(record.id)}/publish`, { method: "POST" }); onToast({ tone: "success", text: `${record.title} 已发布` }); await loadRecords(); onMutate(); } catch (error) { onToast({ tone: "warning", text: error instanceof Error ? error.message : "数据发布失败" }); } finally { setPublishingId(""); } };
  const publishSelected = async () => {
    if (!selectedCount) return; setPublishingSelected(true);
    const selection = selectAllMatching
      ? { allMatching: true, tenantId: tenantId || "", query: query.trim(), targetId: targetFilter, category: categoryFilter, publication }
      : { ids: [...selected] };
    try {
      const result = await apiFetch<{ matched: number; published: number }>("/api/ingestion/records/bulk-action", { method: "POST", body: JSON.stringify({ type: mode, action: "publish", ...selection }) });
      onToast({ tone: "success", text: `已确认 ${result.matched} 条${labels[mode]}，新发布 ${result.published} 条` }); clearSelection(); await loadRecords(); onMutate();
    } catch (error) { onToast({ tone: "warning", text: error instanceof Error ? error.message : "批量发布失败" }); }
    finally { setPublishingSelected(false); }
  };
  const publishAll = async () => {
    setPublishingAll(true);
    try {
      const result = await apiFetch<{ published: number; publishedTotal: number }>("/api/ingestion/records/publish-all", { method: "POST", body: JSON.stringify({ type: mode, tenantId: tenantId || "" }) });
      onToast({ tone: "success", text: `已发布 ${result.published} 条${labels[mode]}，当前共 ${result.publishedTotal} 条已发布` }); setPublishAllOpen(false); clearSelection(); await loadRecords(); onMutate();
    } catch (error) { onToast({ tone: "warning", text: error instanceof Error ? error.message : "一键发布失败" }); }
    finally { setPublishingAll(false); }
  };
  const categoryLabel = (record: ManagedIngestionRecord) => mode === "dark-web" ? record.intelTags?.join(" / ") || "数据泄露" : categories[mode].find(([value]) => value === record.category)?.[1] || "未分类";
  const riskLevel = (record: ManagedIngestionRecord): RiskLevel => { const value = record.risk || ""; if (/严重|critical/i.test(value)) return "critical"; if (/高|high/i.test(value)) return "high"; if (/中|medium/i.test(value)) return "medium"; if (/低|low/i.test(value)) return "low"; return "info"; };
  const riskLabel = (record: ManagedIngestionRecord) => record.type === "dark-web" ? darkWebRiskLabels[record.risk || "low"] || "低危" : record.risk || "未标记";

  return <><div className="toolbar ingestion-record-toolbar"><label className="toolbar-search"><Search size={16} /><span className="sr-only">搜索记录</span><input type="search" value={query} onChange={(event) => { setPage(1); setQuery(event.target.value); }} placeholder={`搜索${labels[mode]}标题或字段`} /></label><select aria-label="发布状态" value={publication} onChange={(event) => { setPage(1); setPublication(event.target.value); }}><option value="">全部状态</option><option value="draft">待审核 / 待发布</option><option value="published">已发布</option></select><select aria-label="按监测对象筛选" value={targetFilter} onChange={(event) => { setPage(1); setTargetFilter(event.target.value); }}><option value="">全部归属</option>{targets.map((target) => <option key={target.id} value={target.id}>{target.name}</option>)}</select>{mode !== "dark-web" && <select aria-label="按分类筛选" value={categoryFilter} onChange={(event) => { setPage(1); setCategoryFilter(event.target.value); }}><option value="">全部分类</option>{categories[mode].map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select>}<Button variant="secondary" onClick={() => setPublishAllOpen(true)}><Send size={16} />一键全部发布</Button><Button onClick={() => openEditor()} disabled={!targets.length}><Plus size={16} />新增{labels[mode]}</Button></div>
    <Panel title={`${labels[mode]}记录（${total}）`} action={loading ? <Tag>加载中</Tag> : <Tag tone="green">可维护</Tag>}><div className="ingestion-selection-bar"><label><input type="checkbox" checked={allVisibleSelected || selectAllMatching} onChange={toggleVisible} disabled={!visibleIds.length} />选择当前页</label>{selected.size > 0 && !selectAllMatching && total > selected.size && <button type="button" onClick={() => setSelectAllMatching(true)}>选择当前筛选结果（{total.toLocaleString("zh-CN")} 条）</button>}<span>{selectedCount ? `已选择 ${selectedCount.toLocaleString("zh-CN")} 条` : "勾选需要审核发布的数据"}</span><Button onClick={() => void publishSelected()} disabled={!selectedCount || publishingSelected}><Send size={15} />{publishingSelected ? "发布中..." : "批量发布"}</Button></div><div className="admin-table ingestion-business-table"><div className="admin-table-head"><SelectionHeader control={<input type="checkbox" aria-label="选择当前页记录" checked={allVisibleSelected || selectAllMatching} onChange={toggleVisible} disabled={!visibleIds.length} />} /><SequenceHeader /><span>记录</span><span>业务字段</span><span>分类</span><span>归属</span><span>风险 / 发布</span><span>操作</span></div>{records.map((record, index) => <div className="admin-table-row" key={record.id}><SelectionCell control={<input type="checkbox" aria-label={`选择${record.title}`} checked={selected.has(record.id) || selectAllMatching} onChange={() => toggle(record.id)} />} /><SequenceCell value={(page - 1) * pageSize + index + 1} /><div className="ingestion-record-title"><strong>{record.title}</strong>{mode === "asset" && <AssetChangeTag record={record} />}<small>{record.id}</small></div><div className="record-field-preview">{assetChangeSummary(record) && <small className="asset-diff-summary"><b>差异</b><span>{assetChangeSummary(record)}</span></small>}{recordHighlights(record).map((item) => <small key={item.label}><b>{item.label}</b><span>{item.value}</span></small>)}</div><Tag tone={mode === "asset" ? "orange" : mode === "dark-web" ? "pink" : "cyan"}>{categoryLabel(record)}</Tag><span>{targets.find((target) => target.id === record.targetId)?.name || record.targetId}</span><div className="record-status-cell"><RiskBadge level={riskLevel(record)}>{riskLabel(record)}</RiskBadge><Tag tone={record.isPublished || (record.changeType === "missing" && record.reviewedAt && !record.previouslyPublished) ? "green" : "orange"}>{recordPublicationLabel(record)}</Tag><small>{(record.publishedAt || record.lastSeenAt).replace("T", " ").slice(0, 16)}</small></div><div className="ingestion-record-actions"><button className="text-action" type="button" onClick={() => openEditor(record)}><Pencil size={13} />编辑</button>{!record.isPublished && !(record.changeType === "missing" && record.reviewedAt && !record.previouslyPublished) && <button className="text-action" type="button" title={record.reviewedAt ? "发布已审核的数据" : "请先编辑并保存审核内容，或使用批量发布确认"} disabled={!record.reviewedAt || publishingId === record.id} onClick={() => void publish(record)}><Send size={13} />{publishingId === record.id ? "发布中..." : "发布"}</button>}<button className="text-action text-action-danger" type="button" onClick={() => setDeleting(record)}><Trash2 size={13} />删除</button></div></div>)}{!loading && !records.length && <div className="inline-empty"><Database size={25} /><strong>暂无匹配的{labels[mode]}记录</strong></div>}</div><TablePagination page={page} pageSize={pageSize} totalPages={Math.max(1, Math.ceil(total / pageSize))} total={total} loading={loading} onPageChange={setPage} onPageSizeChange={(value) => { setPageSize(value); setPage(1); }} /></Panel>
    <Modal className={mode === "dark-web" ? "dark-web-metadata-modal" : "business-record-modal"} open={open} title={mode === "dark-web" ? `${editing ? "编辑" : "新增"}暗网情报基础信息` : `${editing ? "编辑" : "新增"}${labels[mode]}`} onClose={() => { if (!saving) setOpen(false); }} footer={mode === "dark-web" ? <><Button variant="ghost" onClick={() => setOpen(false)} disabled={saving}>取消</Button><Button variant="secondary" type="submit" form="ingestion-record-form" name="intent" value="draft" disabled={saving}>{saving ? "保存中..." : "保存草稿"}</Button><Button type="submit" form="ingestion-record-form" name="intent" value="edit-article" disabled={saving}><FilePenLine size={16} />{saving ? "保存中..." : "保存并编辑正文"}</Button></> : <><Button variant="ghost" onClick={() => setOpen(false)} disabled={saving}>取消</Button><Button variant="secondary" type="submit" form="ingestion-record-form" name="intent" value="draft" disabled={saving}>{saving ? "保存中..." : "保存草稿"}</Button><Button type="submit" form="ingestion-record-form" name="intent" value="publish" disabled={saving}>{saving ? "发布中..." : "保存并发布"}</Button></>}>
      <form key={editing?.id || `new-${mode}`} id="ingestion-record-form" className={`admin-form${mode === "dark-web" ? " dark-web-metadata-form" : ""}`} onSubmit={save}>{mode === "dark-web" ? <DarkWebFields record={editing} targets={targets} /> : <RelationalFields mode={mode} record={editing} targets={targets} category={editorCategory} onCategoryChange={setEditorCategory} />}</form>
    </Modal>
    <Modal open={publishAllOpen} title={`一键发布全部${labels[mode]}`} onClose={() => { if (!publishingAll) setPublishAllOpen(false); }} footer={<><Button variant="ghost" onClick={() => setPublishAllOpen(false)} disabled={publishingAll}>取消</Button><Button onClick={() => void publishAll()} disabled={publishingAll}><Send size={16} />{publishingAll ? "发布中..." : "确认全部发布"}</Button></>}><div className="ingestion-publish-confirm"><strong>确认当前客户下全部{labels[mode]}数据已完成运营审核</strong><p>所有待审核、待发布记录将统一转为已发布。后续新导入的文档仍会进入待审核区，API 接口数据继续按自动发布规则处理。</p></div></Modal>
    <DeleteConfirmation open={Boolean(deleting)} title={`删除${labels[mode]}`} subject={deleting ? `${deleting.title}（${deleting.id}）` : ""} warning="删除后该记录将从运营数据、情报前台和后续地端快照中移除，此操作不可撤销。" confirming={confirmingDelete} onClose={() => setDeleting(null)} onConfirm={() => void remove()} />
  </>;
}

function RelationalFields({ mode, record, targets, category, onCategoryChange }: { mode: RelationalMode; record: ManagedIngestionRecord | null; targets: MonitoringTarget[]; category: string; onCategoryChange: (value: string) => void }) {
  const schema = fieldSchemas[mode][category] || [];
  return <><div className="form-grid"><label>归属<select name="targetId" required defaultValue={record?.targetId || targets[0]?.id || ""}>{targets.map((target) => <option key={target.id} value={target.id}>{target.name}</option>)}</select></label><label>分类<select name="category" required value={category} onChange={(event) => onCategoryChange(event.target.value)}>{categories[mode].map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label></div><label>记录标题<input name="title" required maxLength={300} defaultValue={record?.title || ""} placeholder={`输入${labels[mode]}标题`} /></label><div className="form-grid"><label>风险等级<select name="risk" defaultValue={record?.risk || "未标记"}><option>未标记</option><option>低</option><option>中</option><option>高</option><option>严重</option></select></label></div><section className="business-field-form" key={category}>{schema.map((field) => {
    const defaultValue = fieldEditorValue(field, record?.fields?.[field.key]);
    return <label className={field.multiline ? "field-wide" : ""} key={field.key}>{field.label}{field.options
      ? <select name={`field_${field.key}`} defaultValue={defaultValue}>{field.options.map(([value, label]) => <option key={value || "unknown"} value={value}>{label}</option>)}</select>
      : field.multiline
        ? <textarea name={`field_${field.key}`} rows={4} defaultValue={defaultValue} placeholder={field.placeholder} />
        : <input name={`field_${field.key}`} defaultValue={defaultValue} placeholder={field.placeholder} />}</label>;
  })}</section></>;
}

function DarkWebFields({ record, targets }: { record: ManagedIngestionRecord | null; targets: MonitoringTarget[] }) {
  const today = new Date().toISOString().slice(0, 10); const selectedTags = record?.intelTags?.length ? record.intelTags : ["数据泄露"];
  return <><div className="article-editor-header"><label>归属<select name="targetId" required defaultValue={record?.targetId || targets[0]?.id || ""}>{targets.map((target) => <option key={target.id} value={target.id}>{target.name}</option>)}</select></label><label>标题<input name="title" required maxLength={300} defaultValue={record?.title || ""} /></label><label>风险等级<select name="risk" defaultValue={record?.risk || "low"}><option value="low">低危</option><option value="medium">中危</option><option value="high">高危</option><option value="critical">严重</option></select></label><fieldset className="intel-tag-field"><legend>情报标签</legend><div>{["数据泄露", "行业情报"].map((tag) => <label key={tag}><input type="checkbox" name="intelTags" value={tag} defaultChecked={selectedTags.includes(tag)} /><span>{tag}</span></label>)}</div></fieldset></div><section className="dark-web-metadata-fields" aria-label="补充信息"><div className="form-grid"><label>报告日期<input type="date" name="reportDate" defaultValue={record?.reportDate || today} /></label><label>发布时间<input type="datetime-local" name="publishedAt" defaultValue={localDateTime(record?.publishedAt)} /></label></div><div className="form-grid"><label>来源群组<input name="sourceGroupName" defaultValue={record?.sourceGroupName || ""} /></label><label>来源群组 ID<input name="sourceGroupId" defaultValue={record?.sourceGroupId || ""} /></label></div><label>消息链接 / 原文说明<input name="messageUrl" defaultValue={record?.messageUrl || ""} /></label><label>来源群组链接 / 说明<input name="sourceGroupUrl" defaultValue={record?.sourceGroupUrl || ""} /></label><div className="form-grid"><label>泄漏数据类型<input name="leakDataTypes" defaultValue={record?.leakDataTypes || ""} /></label><label>泄漏数量<input name="leakCount" defaultValue={record?.leakCount || ""} /></label></div><div className="form-grid"><label>交易数量<input name="transactionCount" defaultValue={record?.transactionCount || ""} /></label><label>交易价格<input name="transactionPrice" defaultValue={record?.transactionPrice || ""} /></label></div><label>发布者 ID<input name="publisherId" defaultValue={record?.publisherId || ""} /></label><label>情报备注<textarea name="intelNote" rows={4} defaultValue={record?.intelNote || ""} /></label></section></>;
}
