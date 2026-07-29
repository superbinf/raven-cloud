import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { Bug, Download, FileSpreadsheet, Pencil, Plus, Search, Send, Trash2, Upload } from "lucide-react";
import type { MonitoringTarget, RiskLevel, VulnerabilityPageResult, VulnerabilityRecord } from "@sentinel/shared";
import { Button, EmptyState, Modal, Panel, RiskBadge, Tag } from "@sentinel/ui";
import { DeleteConfirmation, PageHeader, SelectionCell, SelectionHeader, SequenceCell, SequenceHeader, Toast, type ToastState } from "../components/AdminPrimitives";
import { adminApiFetch as apiFetch } from "../shared/api/adminApi";
import { useAdminInitialLoading } from "../app/AdminInitialLoading";

const riskOptions: Array<{ value: "" | RiskLevel; label: string }> = [
  { value: "", label: "全部风险" }, { value: "critical", label: "严重" }, { value: "high", label: "高危" },
  { value: "medium", label: "中危" }, { value: "low", label: "低危" }, { value: "info", label: "信息" }
];

function displayTime(value?: string | null) {
  if (!value) return "--";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value.slice(0, 19) : date.toLocaleString("zh-CN", { hour12: false });
}

export function VulnerabilitiesPage({ tenantId }: { tenantId?: string }) {
  const importInput = useRef<HTMLInputElement>(null);
  const [result, setResult] = useState<VulnerabilityPageResult | null>(null);
  const [targets, setTargets] = useState<MonitoringTarget[]>([]);
  const [page, setPage] = useState(1); const [pageSize, setPageSize] = useState(50); const [query, setQuery] = useState(""); const [appliedQuery, setAppliedQuery] = useState("");
  const [risk, setRisk] = useState(""); const [source, setSource] = useState(""); const [publication, setPublication] = useState(""); const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectAllMatching, setSelectAllMatching] = useState(false); const [publishingSelected, setPublishingSelected] = useState(false);
  const [loading, setLoading] = useState(true); const [toast, setToast] = useState<ToastState>(null);
  const [editing, setEditing] = useState<VulnerabilityRecord | null>(null); const [creating, setCreating] = useState(false); const [saving, setSaving] = useState(false);
  const [publishingId, setPublishingId] = useState(""); const [publishAllOpen, setPublishAllOpen] = useState(false); const [publishingAll, setPublishingAll] = useState(false);
  const [deleteRequest, setDeleteRequest] = useState<{ ids: string[]; label: string; allMatching?: boolean } | null>(null); const [deleting, setDeleting] = useState(false);
  const [importOpen, setImportOpen] = useState(false); const [importFile, setImportFile] = useState<File | null>(null);
  const [importTargetId, setImportTargetId] = useState(""); const [importing, setImporting] = useState(false);
  useAdminInitialLoading("vulnerabilities", loading);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), page_size: String(pageSize) });
      if (appliedQuery) params.set("query", appliedQuery);
      if (risk) params.set("risk", risk);
      if (source) params.set("source", source);
      if (tenantId) params.set("tenant_id", tenantId);
      if (publication) params.set("publication", publication);
      const data = await apiFetch<VulnerabilityPageResult>(`/api/vulnerabilities?${params}`);
      setResult(data);
    } catch (error) {
      setToast({ tone: "warning", text: error instanceof Error ? error.message : "漏洞清单加载失败" });
    } finally { setLoading(false); }
  }, [page, pageSize, appliedQuery, risk, source, publication, tenantId]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { setSelected(new Set()); setSelectAllMatching(false); }, [appliedQuery, risk, source, publication, tenantId]);
  useEffect(() => {
    apiFetch<MonitoringTarget[]>(tenantId ? `/api/targets?tenant_id=${encodeURIComponent(tenantId)}` : "/api/targets").then((items) => {
      const visibleTargets = tenantId ? items.filter((item) => item.tenantId === tenantId) : items;
      setTargets(visibleTargets); setImportTargetId((current) => current || visibleTargets[0]?.id || "");
    }).catch((error) => setToast({ tone: "warning", text: error.message }));
  }, [tenantId]);

  const totalPages = Math.max(1, Math.ceil((result?.total || 0) / pageSize));
  const visibleIds = result?.data.map((item) => item.id) || [];
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
  const selectedCount = selectAllMatching ? (result?.total || 0) : selected.size;
  const toggle = (id: string) => { setSelectAllMatching(false); setSelected((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; }); };
  const toggleVisible = () => { if (selectAllMatching) { setSelectAllMatching(false); setSelected(new Set()); return; } setSelected((current) => {
    const next = new Set(current);
    if (allVisibleSelected) visibleIds.forEach((id) => next.delete(id)); else visibleIds.forEach((id) => next.add(id));
    return next;
  }); };
  const search = (event: FormEvent) => { event.preventDefault(); setPage(1); setAppliedQuery(query.trim()); };
  const bulkSelection = (action: "publish" | "delete") => selectAllMatching
    ? { action, allMatching: true, tenantId: tenantId || "", query: appliedQuery, risk, source, publication }
    : { action, ids: [...selected] };

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (!editing && !creating) return; setSaving(true);
    const intent = ((event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null)?.value || "draft";
    const form = new FormData(event.currentTarget);
    try {
      const path = creating ? "/api/vulnerabilities" : `/api/vulnerabilities/${encodeURIComponent(editing!.id)}`;
      await apiFetch(path, { method: creating ? "POST" : "PUT", body: JSON.stringify({
        targetId: form.get("targetId") || editing?.targetId || importTargetId,
        cve: form.get("cve"), title: form.get("title"), risk: form.get("risk"), source: form.get("source"),
        disclosureAt: form.get("disclosureAt") || null, status: form.get("status"), summary: form.get("summary"), solutions: form.get("solutions"),
        tags: String(form.get("tags") || "").split(/[\n,，]+/).map((item) => item.trim()).filter(Boolean),
        references: String(form.get("references") || "").split(/\n+/).map((item) => item.trim()).filter(Boolean), publish: intent === "publish"
      }) });
      setEditing(null); setCreating(false); setToast({ tone: "success", text: intent === "publish" ? "漏洞信息已保存，地端覆盖同步任务已生成" : "漏洞信息已保存为待发布草稿" }); await load();
    } catch (error) { setToast({ tone: "warning", text: error instanceof Error ? error.message : "漏洞保存失败" }); }
    finally { setSaving(false); }
  };

  const publish = async (item: VulnerabilityRecord) => {
    setPublishingId(item.id);
    try {
      await apiFetch(`/api/vulnerabilities/${encodeURIComponent(item.id)}/publish`, { method: "POST" });
      setToast({ tone: "success", text: `${item.cve || item.title} 已发布` }); await load();
    } catch (error) { setToast({ tone: "warning", text: error instanceof Error ? error.message : "漏洞发布失败" }); }
    finally { setPublishingId(""); }
  };

  const publishAll = async () => {
    setPublishingAll(true);
    try {
      const summary = await apiFetch<{ published: number; publishedTotal: number; snapshots: Array<{ deploymentId: string }> }>("/api/vulnerabilities/publish-all", { method: "POST", body: JSON.stringify({ tenantId: tenantId || "" }) });
      setPublishAllOpen(false);
      setToast({ tone: "success", text: `当前 ${summary.publishedTotal} 条漏洞已全部发布（本次新增 ${summary.published} 条），已生成 ${summary.snapshots.length} 个地端全量同步任务` });
      await load();
    } catch (error) { setToast({ tone: "warning", text: error instanceof Error ? error.message : "漏洞批量发布失败" }); }
    finally { setPublishingAll(false); }
  };

  const publishSelection = async () => {
    if (!selectedCount) return; setPublishingSelected(true);
    try {
      const summary = await apiFetch<{ matched: number; published: number; snapshots: Array<{ deploymentId: string }> }>("/api/vulnerabilities/bulk-action", { method: "POST", body: JSON.stringify(bulkSelection("publish")) });
      setSelected(new Set()); setSelectAllMatching(false);
      setToast({ tone: "success", text: `已处理 ${summary.matched} 条漏洞，本次新增发布 ${summary.published} 条，并生成 ${summary.snapshots.length} 个地端同步任务` }); await load();
    } catch (error) { setToast({ tone: "warning", text: error instanceof Error ? error.message : "漏洞批量发布失败" }); }
    finally { setPublishingSelected(false); }
  };

  const remove = async () => {
    if (!deleteRequest) return; setDeleting(true);
    try {
      const summary = deleteRequest.allMatching
        ? await apiFetch<{ deleted: number }>("/api/vulnerabilities/bulk-action", { method: "POST", body: JSON.stringify(bulkSelection("delete")) })
        : deleteRequest.ids.length === 1
          ? await apiFetch(`/api/vulnerabilities/${encodeURIComponent(deleteRequest.ids[0])}`, { method: "DELETE" }) as { id: string }
          : await apiFetch<{ deleted: number }>("/api/vulnerabilities/bulk-action", { method: "POST", body: JSON.stringify({ action: "delete", ids: deleteRequest.ids }) });
      const deleted = "deleted" in summary ? summary.deleted : 1;
      setSelected(new Set()); setSelectAllMatching(false); setToast({ tone: "success", text: `已删除 ${deleted} 条漏洞，后续同步不会自动恢复` }); setDeleteRequest(null); await load();
    } catch (error) { setToast({ tone: "warning", text: error instanceof Error ? error.message : "漏洞删除失败" }); }
    finally { setDeleting(false); }
  };

  const chooseImport = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] || null; event.target.value = "";
    if (file && !/\.(xlsx|xls|csv)$/i.test(file.name)) { setToast({ tone: "warning", text: "仅支持 .xlsx、.xls 或 .csv 漏洞清单" }); return; }
    setImportFile(file);
  };
  const runImport = async () => {
    if (!importFile || !importTargetId) return; setImporting(true);
    const body = new FormData(); body.append("file", importFile); body.append("targetId", importTargetId);
    try {
      const summary = await apiFetch<{ inserted: number; updated: number; skippedRows: number }>("/api/vulnerabilities/import", { method: "POST", body });
      setImportOpen(false); setImportFile(null); setToast({ tone: "success", text: `已导入待审核区：新增 ${summary.inserted} 条，更新 ${summary.updated} 条，跳过 ${summary.skippedRows} 条` }); await load();
    } catch (error) { setToast({ tone: "warning", text: error instanceof Error ? error.message : "漏洞清单导入失败" }); }
    finally { setImporting(false); }
  };
  const downloadTemplate = () => {
    const csv = "\ufeffCVE,漏洞标题,漏洞描述,风险等级,漏洞来源,披露时间,处置建议,参考链接,标签,状态\nCVE-2026-0001,示例组件安全漏洞,漏洞描述,high,手工导入,2026-07-22,升级至安全版本,https://example.com/advisory,示例组件,待处置\n";
    const href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a"); anchor.href = href; anchor.download = "漏洞清单导入模板.csv"; anchor.click(); URL.revokeObjectURL(href);
  };

  return <>
    <PageHeader eyebrow="VULNERABILITY MANAGEMENT" title="漏洞情报" description="WatchVuln 数据自动发布；工程师可在运营平台新增、编辑、删除并覆盖同步到地端。" actions={<><Button variant="secondary" onClick={downloadTemplate}><Download size={16} />下载模板</Button><Button variant="secondary" onClick={() => setPublishAllOpen(true)} disabled={publishingAll}><Send size={16} />一键发布全部</Button><Button variant="secondary" onClick={() => setCreating(true)}><Plus size={16} />新增漏洞</Button><Button onClick={() => setImportOpen(true)}><Upload size={16} />批量导入</Button></>} />
    <form className="toolbar vulnerability-admin-toolbar" onSubmit={search}>
      <label className="toolbar-search"><Search size={17} /><span className="sr-only">搜索漏洞</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索 CVE、标题、产品或描述" /></label>
      <select aria-label="发布状态" value={publication} onChange={(event) => { setPublication(event.target.value); setPage(1); }}><option value="">全部状态</option><option value="draft">待审核 / 待发布</option><option value="published">已发布</option></select>
      <select aria-label="风险等级" value={risk} onChange={(event) => { setRisk(event.target.value); setPage(1); }}>{riskOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select>
      <select aria-label="漏洞来源" value={source} onChange={(event) => { setSource(event.target.value); setPage(1); }}><option value="">全部来源</option>{result?.sources.map((item) => <option key={item.name} value={item.name}>{item.name}（{item.count}）</option>)}</select>
      <Button variant="secondary" type="submit">查询</Button>
    </form>
    <Panel className="vulnerability-admin-panel" title={<span className="vulnerability-admin-title"><Bug size={17} />漏洞记录 <em>{(result?.total || 0).toLocaleString("zh-CN")}</em></span>}>
      <div className="vulnerability-selection-bar"><label><input type="checkbox" checked={selectAllMatching} disabled={!result?.total} onChange={(event) => { setSelectAllMatching(event.target.checked); setSelected(new Set()); }} />全选当前筛选结果（{(result?.total || 0).toLocaleString("zh-CN")} 条）</label><span>已选择 {selectedCount.toLocaleString("zh-CN")} 条</span><Button variant="secondary" disabled={!selectedCount || publishingSelected} onClick={() => void publishSelection()}><Send size={15} />{publishingSelected ? "发布中..." : "批量发布"}</Button><Button variant="danger" disabled={!selectedCount} onClick={() => setDeleteRequest({ ids: [...selected], allMatching: selectAllMatching, label: `当前已选择 ${selectedCount.toLocaleString("zh-CN")} 条漏洞` })}><Trash2 size={15} />批量删除</Button></div>
      {loading ? <div className="vulnerability-admin-loading">正在加载漏洞清单...</div> : !result?.data.length ? <EmptyState icon={<Bug size={30} />} title="暂无漏洞记录" description="当前筛选条件下没有数据。" /> : <div className="admin-table vulnerability-admin-table">
        <div className="admin-table-head"><SelectionHeader control={<input type="checkbox" aria-label="选择当前页全部漏洞" checked={selectAllMatching || allVisibleSelected} onChange={toggleVisible} />} /><SequenceHeader /><span>CVE / 漏洞标题</span><span>风险</span><span>来源</span><span>披露时间</span><span>处理 / 发布</span><span>操作</span></div>
        {result.data.map((item, index) => <div className="admin-table-row" key={item.id}><SelectionCell control={<input type="checkbox" aria-label={`选择 ${item.title}`} checked={selectAllMatching || selected.has(item.id)} onChange={() => toggle(item.id)} />} /><SequenceCell value={(page - 1) * pageSize + index + 1} /><div className="vulnerability-admin-record"><code>{item.cve || "--"}</code><strong>{item.title}</strong><small>{item.summary || "暂无描述"}</small></div><RiskBadge level={item.risk} /><div className="vulnerability-admin-source"><span>{item.source}</span>{item.manuallyManaged && <Tag tone="cyan">人工维护</Tag>}</div><time>{displayTime(item.disclosureAt || item.sourceUpdatedAt)}</time><div className="vulnerability-admin-source"><span>{item.status}</span><Tag tone={item.isPublished ? "green" : item.reviewedAt ? "orange" : "default"}>{item.isPublished ? "已发布" : item.reviewedAt ? "待发布" : "待审核"}</Tag></div><div className="vulnerability-admin-actions"><button className="text-action" type="button" onClick={() => setEditing(item)}><Pencil size={13} />编辑</button>{!item.isPublished && <button className="text-action" type="button" title={item.reviewedAt ? "发布已审核的漏洞情报" : "请先编辑并保存审核内容"} disabled={!item.reviewedAt || publishingId === item.id} onClick={() => void publish(item)}><Send size={13} />{publishingId === item.id ? "发布中" : "发布"}</button>}<button className="text-action text-action-danger" type="button" onClick={() => setDeleteRequest({ ids: [item.id], label: item.cve ? `${item.cve} · ${item.title}` : item.title })}><Trash2 size={13} />删除</button></div></div>)}
      </div>}
      <footer className="ingestion-pagination"><span>第 {page} / {totalPages} 页，共 {(result?.total || 0).toLocaleString("zh-CN")} 条</span><div className="vulnerability-page-controls"><label>每页<select aria-label="每页条数" value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); setPage(1); }}><option value={10}>10 条</option><option value={20}>20 条</option><option value={50}>50 条</option><option value={100}>100 条</option></select></label><Button variant="ghost" disabled={page <= 1 || loading} onClick={() => setPage((value) => Math.max(1, value - 1))}>上一页</Button><Button variant="secondary" disabled={page >= totalPages || loading} onClick={() => setPage((value) => Math.min(totalPages, value + 1))}>下一页</Button></div></footer>
    </Panel>
    <Modal open={creating || Boolean(editing)} title={creating ? "新增漏洞" : editing ? `编辑漏洞 · ${editing.cve || editing.id}` : "编辑漏洞"} onClose={() => { if (!saving) { setEditing(null); setCreating(false); } }} className="vulnerability-edit-modal" footer={<><Button variant="ghost" onClick={() => { setEditing(null); setCreating(false); }} disabled={saving}>取消</Button><Button variant="secondary" type="submit" form="vulnerability-edit-form" name="intent" value="draft" disabled={saving}>{saving ? "保存中..." : "保存为待发布"}</Button><Button type="submit" form="vulnerability-edit-form" name="intent" value="publish" disabled={saving}>{saving ? "同步中..." : "保存并同步到地端"}</Button></>}>
      {(creating || editing) && <form id="vulnerability-edit-form" className="admin-form" onSubmit={save} key={creating ? "new" : editing!.id}>{creating && <label>归属监测对象<select name="targetId" required defaultValue={importTargetId}>{targets.map((target) => <option key={target.id} value={target.id}>{target.name}</option>)}</select></label>}<div className="form-grid"><label>CVE / 编号<input name="cve" defaultValue={editing?.cve || ""} /></label><label>风险等级<select name="risk" defaultValue={editing?.risk || "high"}>{riskOptions.filter((item) => item.value).map((item) => <option value={item.value} key={item.value}>{item.label}</option>)}</select></label></div><label>漏洞标题<input name="title" required defaultValue={editing?.title || ""} /></label><div className="form-grid"><label>漏洞来源<input name="source" required defaultValue={editing?.source || "手工维护"} /></label><label>披露时间<input name="disclosureAt" type="date" defaultValue={editing?.disclosureAt?.slice(0, 10) || ""} /></label></div><label>状态<input name="status" required defaultValue={editing?.status || "待处置"} /></label><label>漏洞描述<textarea name="summary" rows={5} defaultValue={editing?.summary || ""} /></label><label>处置建议<textarea name="solutions" rows={4} defaultValue={editing?.solutions || ""} /></label><div className="form-grid"><label>产品标签<textarea name="tags" rows={4} defaultValue={editing?.tags.join("\n") || ""} /></label><label>参考链接<textarea name="references" rows={4} defaultValue={editing?.references.join("\n") || ""} /></label></div></form>}
    </Modal>
    <Modal open={importOpen} title="批量导入漏洞清单" onClose={() => { if (!importing) setImportOpen(false); }} footer={<><Button variant="ghost" onClick={() => setImportOpen(false)} disabled={importing}>取消</Button><Button onClick={() => void runImport()} disabled={!importFile || !importTargetId || importing}><Upload size={16} />{importing ? "导入中..." : "开始导入"}</Button></>}>
      <div className="vulnerability-import-form"><label>归属监测对象<select value={importTargetId} onChange={(event) => setImportTargetId(event.target.value)}>{targets.map((target) => <option key={target.id} value={target.id}>{target.name}</option>)}</select></label><button className="vulnerability-import-file" type="button" onClick={() => importInput.current?.click()}><FileSpreadsheet size={28} /><strong>{importFile?.name || "选择漏洞清单"}</strong><span>.xlsx / .xls / .csv</span></button><input ref={importInput} className="hidden-input" type="file" accept=".xlsx,.xls,.csv" onChange={chooseImport} /><small>导入内容全部进入待审核区，不会直接出现在情报前台或地端快照。</small></div>
    </Modal>
    <Modal open={publishAllOpen} title="一键发布全部漏洞" onClose={() => { if (!publishingAll) setPublishAllOpen(false); }} footer={<><Button variant="ghost" onClick={() => setPublishAllOpen(false)} disabled={publishingAll}>取消</Button><Button onClick={() => void publishAll()} disabled={publishingAll}><Send size={16} />{publishingAll ? "发布中..." : "确认全部发布"}</Button></>}>
      <div className="vulnerability-publish-confirm"><strong>以运营平台当前漏洞库为准，全量发布并下发</strong><p>待发布记录会先转为已发布；即使当前没有待发布记录，也会强制生成地端全量快照任务。工程师后续增删改并发布时，将继续覆盖同步到地端。</p></div>
    </Modal>
    <DeleteConfirmation open={Boolean(deleteRequest)} title={deleteRequest?.ids.length === 1 ? "删除漏洞" : "批量删除漏洞"} subject={deleteRequest?.label || ""} warning="删除后将同步清理相关资产漏洞告警，并阻止上游同步自动恢复这些记录。" confirming={deleting} onClose={() => setDeleteRequest(null)} onConfirm={() => void remove()} />
    <Toast value={toast} onClose={() => setToast(null)} />
  </>;
}
