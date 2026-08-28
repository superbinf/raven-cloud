import { useEffect, useState, type ChangeEvent, type FormEvent } from "react";
import { AlertTriangle, CheckCircle2, Database, Globe2, ImageIcon, Pencil, Plus, RefreshCw, Search, Trash2, Upload } from "lucide-react";
import { Button, Modal, Panel, Tag } from "@/components/ui";
import { DeleteConfirmation, PageHeader, SequenceCell, SequenceHeader, Toast, type ToastState } from "@/components/business/AdminPrimitives";
import { TablePagination } from "@/components/business/TablePagination";
import { adminApiFetch as apiFetch, adminApiUrl } from "@/api/admin";
import { useAdminInitialLoading } from "@/hooks/useAdminInitialLoading";

type IconSource = "upload" | "favicon" | "iconify" | "simple-icons" | "domestic" | "provider" | "custom";
type FingerprintIconRecord = {
  id: string;
  fingerprintName: string;
  aliases: string[];
  source: IconSource;
  sourceUrl: string;
  mediaType: string;
  iconSha256: string;
  iconUrl: string;
  active: boolean;
  updatedBy: string;
  updatedAt: string;
};
type FingerprintIconResult = {
  page: number;
  pageSize: number;
  total: number;
  summary: { total: number; active: number; builtin: number; managed: number };
  data: FingerprintIconRecord[];
};
type CatalogSyncResult = { catalogSize: number; inserted: number; updated: number; preserved: number; unchanged: number; failed?: Array<{ name: string; message: string }> };

const sourceLabels: Record<IconSource, string> = { upload: "本地上传", favicon: "远程 favicon", iconify: "Iconify", "simple-icons": "Simple Icons", domestic: "国产应用库", provider: "运营商图标库", custom: "自定义" };

function displayTime(value: string) {
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? value : time.toLocaleString("zh-CN", { hour12: false });
}

function fingerprintIconUrl(value: string) {
  return /^(?:data:|https?:\/\/)/i.test(value) ? value : adminApiUrl(value.startsWith("/") ? value : `/${value}`);
}

function readImage(file: File) {
  return new Promise<string>((resolve, reject) => {
    if (file.size > 256 * 1024) return reject(new Error("图标不能超过 256KB"));
    if (!file.type.startsWith("image/")) return reject(new Error("请选择图片文件"));
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("读取图标文件失败"));
    reader.readAsDataURL(file);
  });
}

export function FingerprintIconsPage() {
  const [result, setResult] = useState<FingerprintIconResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [queryInput, setQueryInput] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [reloadKey, setReloadKey] = useState(0);
  const [editing, setEditing] = useState<FingerprintIconRecord | null | undefined>(undefined);
  const [deleting, setDeleting] = useState<FingerprintIconRecord | null>(null);
  const [deletingBusy, setDeletingBusy] = useState(false);
  const [catalogConfirm, setCatalogConfirm] = useState(false);
  const [catalogBusy, setCatalogBusy] = useState(false);
  const [toast, setToast] = useState<ToastState>(null);
  useAdminInitialLoading("fingerprint-icons", loading);

  useEffect(() => {
    let active = true;
    const params = new URLSearchParams({ page: String(page), page_size: String(pageSize) });
    if (query) params.set("query", query);
    setLoading(true); setError("");
    apiFetch<FingerprintIconResult>(`/api/fingerprint-icons?${params.toString()}`)
      .then((value) => { if (active) setResult(value); })
      .catch((reason) => { if (active) { setResult(null); setError(reason instanceof Error ? reason.message : "指纹识别库加载失败"); } })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [page, pageSize, query, reloadKey]);

  const refresh = () => setReloadKey((value) => value + 1);
  const totalPages = Math.max(1, Math.ceil((result?.total || 0) / pageSize));
  const search = (event: FormEvent) => { event.preventDefault(); setPage(1); setQuery(queryInput.trim()); };
  const remove = async () => {
    if (!deleting) return;
    setDeletingBusy(true);
    try {
      await apiFetch(`/api/fingerprint-icons/${encodeURIComponent(deleting.id)}`, { method: "DELETE" });
      setDeleting(null); setToast({ tone: "success", text: "指纹图标已删除。" }); refresh();
    } catch (reason) { setToast({ tone: "warning", text: reason instanceof Error ? reason.message : "删除失败" }); }
    finally { setDeletingBusy(false); }
  };
  const syncCatalog = async () => {
    setCatalogBusy(true);
    try {
      const value = await apiFetch<CatalogSyncResult>("/api/fingerprint-icons/catalog/sync", { method: "POST" });
      setCatalogConfirm(false);
      setPage(1);
      setToast({ tone: value.failed?.length ? "warning" : "success", text: `基础库已更新：新增 ${value.inserted}，更新 ${value.updated}，保留人工维护 ${value.preserved}${value.failed?.length ? `，${value.failed.length} 个官网图标获取失败` : ""}。` });
      refresh();
    } catch (reason) { setToast({ tone: "warning", text: reason instanceof Error ? reason.message : "基础库更新失败" }); }
    finally { setCatalogBusy(false); }
  };

  return <>
    <PageHeader eyebrow="FINGERPRINT IDENTIFICATION LIBRARY" title="指纹识别库" description="维护指纹名称、别名与图标映射，供资产监测统一匹配和展示。" actions={<><Button className="fingerprint-icon-action-refresh" variant="secondary" onClick={refresh} disabled={loading || catalogBusy}><RefreshCw size={16} />刷新</Button><Button className="fingerprint-icon-action-catalog" variant="secondary" onClick={() => setCatalogConfirm(true)} disabled={catalogBusy}><Database size={16} />更新基础库</Button><Button className="fingerprint-icon-action-add" onClick={() => setEditing(null)}><Plus size={16} />新增图标</Button></>} />
    <section className="fingerprint-icon-summary" aria-label="指纹识别库统计"><div><span>图标总数</span><strong>{result?.summary.total ?? 0}</strong></div><div><span>启用映射</span><strong>{result?.summary.active ?? 0}</strong></div><div><span>基础图库</span><strong>{result?.summary.builtin ?? 0}</strong></div><div><span>人工维护</span><strong>{result?.summary.managed ?? 0}</strong></div></section>
    <form className="toolbar fingerprint-icon-toolbar" onSubmit={search}><div className="toolbar-search"><Search size={17} /><input type="search" aria-label="搜索指纹识别库" value={queryInput} onChange={(event) => setQueryInput(event.target.value)} placeholder="搜索指纹名称或别名" /></div><Button variant="secondary" type="submit"><Search size={16} />查询</Button></form>
    <Panel className="fingerprint-icon-panel" title={<span className="fingerprint-icon-panel-title"><ImageIcon size={17} /> 图标映射 <em>{result?.total ?? 0}</em></span>}>
      {loading ? <div className="fingerprint-icon-empty"><RefreshCw size={26} /><strong>正在加载指纹识别库</strong></div>
        : error ? <div className="fingerprint-icon-empty"><AlertTriangle size={27} /><strong>指纹识别库加载失败</strong><span>{error}</span><Button variant="secondary" onClick={refresh}>重新加载</Button></div>
          : result?.data.length ? <div className="admin-table fingerprint-icon-table"><div className="admin-table-head"><SequenceHeader /><span>图标</span><span>指纹键</span><span>来源</span><span>来源地址</span><span>状态</span><span>更新时间</span><span>操作</span></div>{result.data.map((item, index) => <div className="admin-table-row" key={item.id}><SequenceCell value={(page - 1) * pageSize + index + 1} /><span className="fingerprint-icon-preview"><img src={fingerprintIconUrl(item.iconUrl)} alt={`${item.fingerprintName} 图标`} /></span><div className="fingerprint-icon-key"><strong>{item.fingerprintName}</strong><small>{item.aliases.length ? item.aliases.join("、") : "暂无别名"}</small><code>{item.id}</code></div><Tag tone={item.source === "favicon" ? "cyan" : "default"}>{sourceLabels[item.source]}</Tag><span className="fingerprint-icon-source" title={item.sourceUrl}>{item.sourceUrl || "--"}</span><Tag tone={item.active ? "green" : "orange"}>{item.active ? "启用" : "停用"}</Tag><time>{displayTime(item.updatedAt)}<small>{item.updatedBy || "--"}</small></time><div className="fingerprint-icon-actions"><button className="text-action" onClick={() => setEditing(item)}><Pencil size={14} />编辑</button><button className="text-action text-action-danger" onClick={() => setDeleting(item)}><Trash2 size={14} />删除</button></div></div>)}</div>
            : <div className="fingerprint-icon-empty"><ImageIcon size={28} /><strong>暂无指纹图标</strong><span>{query ? "请调整查询条件。" : "点击“新增图标”建立第一条指纹映射。"}</span></div>}
      {!loading && !error && result && <TablePagination page={page} pageSize={pageSize} totalPages={totalPages} total={result.total} loading={loading} onPageChange={setPage} onPageSizeChange={(value) => { setPageSize(value); setPage(1); }} />}
    </Panel>
    {editing !== undefined && <FingerprintIconModal item={editing} onClose={() => setEditing(undefined)} onSaved={() => { setEditing(undefined); setToast({ tone: "success", text: editing ? "指纹图标已更新。" : "指纹图标已创建。" }); refresh(); }} />}
    <Modal open={catalogConfirm} title="更新基础图标库" onClose={() => { if (!catalogBusy) setCatalogConfirm(false); }} footer={<><Button variant="ghost" onClick={() => setCatalogConfirm(false)} disabled={catalogBusy}>取消</Button><Button onClick={() => void syncCatalog()} disabled={catalogBusy}><Database size={16} />{catalogBusy ? "更新中..." : "确认更新"}</Button></>}><div className="fingerprint-catalog-confirmation"><Database size={26} /><div><strong>Simple Icons 基础图标库</strong><p>同步当前内置版本的品牌与技术图标；同名人工上传或 favicon 图标保持不变。</p></div></div></Modal>
    <DeleteConfirmation open={Boolean(deleting)} title="删除指纹图标" subject={deleting?.fingerprintName || ""} warning="删除后该指纹及其别名将回退到通用图标。" confirming={deletingBusy} onClose={() => setDeleting(null)} onConfirm={() => void remove()} />
    <Toast value={toast} onClose={() => setToast(null)} />
  </>;
}

function FingerprintIconModal({ item, onClose, onSaved }: { item: FingerprintIconRecord | null; onClose: () => void; onSaved: () => void }) {
  const [fingerprintName, setFingerprintName] = useState(item?.fingerprintName || "");
  const [aliases, setAliases] = useState(item?.aliases.join("、") || "");
  const [mode, setMode] = useState<"upload" | "favicon">(item?.source === "favicon" ? "favicon" : "upload");
  const [sourceUrl, setSourceUrl] = useState(item?.sourceUrl || "");
  const [iconData, setIconData] = useState("");
  const [preview, setPreview] = useState(item?.iconUrl ? fingerprintIconUrl(item.iconUrl) : "");
  const [active, setActive] = useState(item?.active ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const chooseFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; if (!file) return;
    try { const value = await readImage(file); setIconData(value); setPreview(value); setError(""); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "读取图标失败"); }
  };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const payload = { fingerprintName: fingerprintName.trim(), aliases: aliases.split(/[、,，;；|\n]+/).map((value) => value.trim()).filter(Boolean), source: mode, sourceUrl: mode === "favicon" ? sourceUrl.trim() : "", ...(iconData ? { iconData } : {}), active };
      if (item) await apiFetch(`/api/fingerprint-icons/${encodeURIComponent(item.id)}`, { method: "PUT", body: JSON.stringify(payload) });
      else await apiFetch("/api/fingerprint-icons", { method: "POST", body: JSON.stringify(payload) });
      onSaved();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "保存失败"); }
    finally { setBusy(false); }
  };
  return <Modal open title={item ? "编辑指纹图标" : "新增指纹图标"} onClose={onClose} className="fingerprint-icon-modal" footer={null}><form className="fingerprint-icon-form" onSubmit={submit}>
    <label>标准指纹名称<input value={fingerprintName} onChange={(event) => setFingerprintName(event.target.value)} maxLength={160} required placeholder="例如 Spring Boot" /></label>
    <label>匹配别名<textarea value={aliases} onChange={(event) => setAliases(event.target.value)} placeholder="多个别名使用逗号或顿号分隔" /></label>
    <fieldset><legend>图标来源</legend><div className="fingerprint-icon-source-modes" role="group" aria-label="图标来源"><button type="button" className={mode === "upload" ? "active" : ""} aria-pressed={mode === "upload"} onClick={() => setMode("upload")}><Upload size={16} />上传图标</button><button type="button" className={mode === "favicon" ? "active" : ""} aria-pressed={mode === "favicon"} onClick={() => setMode("favicon")}><Globe2 size={16} />请求 favicon.ico</button></div></fieldset>
    {mode === "upload" ? <label className="fingerprint-icon-upload"><input className="hidden-input" type="file" accept="image/png,image/x-icon,image/vnd.microsoft.icon,image/svg+xml,image/webp,image/jpeg,image/gif,.ico" onChange={(event) => void chooseFile(event)} /><Upload size={22} /><strong>{iconData ? "已选择新图标" : item ? "选择新图标以替换当前图标" : "选择图标文件"}</strong><span>PNG、ICO、SVG、WEBP、JPEG 或 GIF，最大 256KB</span></label> : <label>站点或 favicon 地址<input type="url" value={sourceUrl} onChange={(event) => setSourceUrl(event.target.value)} required placeholder="https://example.com/favicon.ico" /><small>请求由服务端发起并保存到数据库；不允许访问本机或内网地址。</small></label>}
    {preview && <div className="fingerprint-icon-form-preview"><img src={preview} alt="图标预览" /><span><CheckCircle2 size={15} />当前图标预览</span></div>}
    <label className="switch"><input type="checkbox" checked={active} onChange={(event) => setActive(event.target.checked)} /><span /><em>{active ? "启用映射" : "停用映射"}</em></label>
    {error && <div className="admin-login-error" role="alert">{error}</div>}
    <footer><Button variant="ghost" type="button" onClick={onClose} disabled={busy}>取消</Button><Button type="submit" disabled={busy || !fingerprintName.trim() || (!item && mode === "upload" && !iconData)}>{mode === "favicon" ? <Globe2 size={16} /> : <Upload size={16} />}{busy ? mode === "favicon" ? "抓取中..." : "保存中..." : mode === "favicon" ? "抓取并保存" : "保存图标"}</Button></footer>
  </form></Modal>;
}
