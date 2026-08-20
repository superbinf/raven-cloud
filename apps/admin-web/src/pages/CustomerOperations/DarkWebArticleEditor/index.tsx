import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ArrowLeft, Eye, File, FilePenLine, LoaderCircle, Paperclip, Save, Send, Trash2, Upload } from "lucide-react";
import { useNavigate, useParams } from "react-router-dom";
import type { DarkWebFileRecord, ManagedIngestionRecord, MonitoringTarget } from "@sentinel/shared";
import { Button, Tag } from "@/components/common";
import { useCustomerScope } from "@/layouts";
import { useAdminInitialLoading } from "@/hooks/useAdminInitialLoading";
import { ArticleEditor } from "@/components/business/ArticleEditor";
import { PageHeader, Toast, type ToastState } from "@/components/business/AdminPrimitives";
import { adminApiFetch as apiFetch, adminApiUrl } from "@/api/admin";

type EditorPane = "edit" | "preview";

const riskLabels: Record<string, string> = { critical: "严重", high: "高危", medium: "中危", low: "低危" };
const attachmentAccept = ".xlsx,.xls,.csv,.docx,.doc,.pdf,.txt,.json,.zip,.png,.jpg,.jpeg,.webp";

function useDebouncedValue<T>(value: T, delay: number) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [delay, value]);
  return debounced;
}

function formatFileSize(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function DarkWebAttachments({ recordId, onChanged }: { recordId: string; onChanged: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<DarkWebFileRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(0);
  const [uploadTotal, setUploadTotal] = useState(0);
  const [deletingId, setDeletingId] = useState("");
  const [message, setMessage] = useState("");

  const load = async () => {
    setLoading(true); setMessage("");
    try { setFiles(await apiFetch<DarkWebFileRecord[]>(`/api/ingestion/records/dark-web/${encodeURIComponent(recordId)}/files`)); }
    catch (reason) { setMessage(reason instanceof Error ? reason.message : "证据文件加载失败"); }
    finally { setLoading(false); }
  };

  useEffect(() => { void load(); }, [recordId]);

  const uploadFiles = async (selected: FileList | null) => {
    const pending = [...(selected || [])];
    if (!pending.length) return;
    setMessage(""); setUploadTotal(pending.length);
    let completed = 0;
    try {
      for (const file of pending) {
        setUploading(completed + 1);
        const form = new FormData(); form.append("file", file, file.name);
        await apiFetch(`/api/ingestion/records/dark-web/${encodeURIComponent(recordId)}/files`, { method: "POST", body: form });
        completed += 1;
      }
      onChanged();
      await load();
    } catch (reason) {
      setMessage(`${completed ? `已上传 ${completed} 个文件，` : ""}${reason instanceof Error ? reason.message : "证据文件上传失败"}`);
      await load();
    } finally {
      setUploading(0); setUploadTotal(0);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const remove = async (file: DarkWebFileRecord) => {
    if (file.kind !== "attachment" || !window.confirm(`确定删除证据文件“${file.name}”吗？删除后需要重新发布该条情报。`)) return;
    setDeletingId(file.id); setMessage("");
    try {
      await apiFetch(`/api/ingestion/records/dark-web/${encodeURIComponent(recordId)}/files/${encodeURIComponent(file.id)}`, { method: "DELETE" });
      setFiles((current) => current.filter((item) => item.id !== file.id));
      onChanged();
    } catch (reason) { setMessage(reason instanceof Error ? reason.message : "证据文件删除失败"); }
    finally { setDeletingId(""); }
  };

  const attachments = files.filter((file) => file.kind === "attachment");
  const reports = files.filter((file) => file.kind === "report");
  return <section className="dark-web-attachments" aria-label="情报证据文件">
    <header><div><Paperclip size={17} /><strong>证据文件</strong><Tag>{attachments.length}</Tag></div><div><input ref={inputRef} className="sr-only" type="file" multiple accept={attachmentAccept} onChange={(event) => void uploadFiles(event.target.files)} /><Button variant="secondary" disabled={Boolean(uploading)} onClick={() => inputRef.current?.click()}>{uploading ? <LoaderCircle className="spin" size={16} /> : <Upload size={16} />}{uploading ? `上传中 ${uploading}/${uploadTotal}` : "上传证据文件"}</Button></div></header>
    {message && <div className="dark-web-attachment-error" role="alert"><AlertTriangle size={15} />{message}</div>}
    <div className="dark-web-attachment-list">
      {loading ? <div className="dark-web-attachment-empty"><LoaderCircle className="spin" size={18} />正在加载证据文件...</div> : <>
        {reports.map((file) => <div className="dark-web-attachment-item" key={file.id}><File size={17} /><div><strong>{file.name}</strong><span>来源报告 · {formatFileSize(file.sizeBytes)}</span></div><Tag>只读</Tag></div>)}
        {attachments.map((file) => <div className="dark-web-attachment-item" key={file.id}><File size={17} /><div><strong>{file.name}</strong><span>证据文件 · {formatFileSize(file.sizeBytes)}{file.sheetCount ? ` · ${file.sheetCount} 个工作表 · ${file.rowCount.toLocaleString("zh-CN")} 行` : ""}</span></div><button type="button" className="dark-web-attachment-delete" aria-label={`删除证据文件 ${file.name}`} title="删除证据文件" disabled={deletingId === file.id} onClick={() => void remove(file)}>{deletingId === file.id ? <LoaderCircle className="spin" size={16} /> : <Trash2 size={16} />}</button></div>)}
        {!files.length && <div className="dark-web-attachment-empty"><Paperclip size={18} />暂无证据文件</div>}
      </>}
    </div>
  </section>;
}

function escapeAttribute(value: string) {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function previewDocument(value: string, light: boolean) {
  const parser = new DOMParser();
  const document = parser.parseFromString(value.trim() || "<p>正文尚未填写，开始编辑后将在这里实时预览。</p>", "text/html");
  document.querySelectorAll("script,style,iframe,object,embed,form,input,button,meta,link").forEach((node) => node.remove());
  document.querySelectorAll("*").forEach((element) => {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      const content = attribute.value.trim();
      if (name.startsWith("on") || name === "srcdoc" || (["href", "src", "xlink:href"].includes(name) && /^(?:javascript|vbscript):/i.test(content))) element.removeAttribute(attribute.name);
    }
    if (element instanceof HTMLAnchorElement) {
      element.target = "_blank";
      element.rel = "noopener noreferrer";
    }
    if (element instanceof HTMLImageElement && !element.alt) element.alt = "正文图片";
  });
  const background = light ? "#ffffff" : "#0c1420";
  const text = light ? "#1c2633" : "#dbe7f5";
  const muted = light ? "#607086" : "#90a3ba";
  const border = light ? "#d7e0eb" : "#31445c";
  const link = light ? "#0068d9" : "#74d7e7";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src http: https: data: blob:; style-src 'unsafe-inline'; font-src http: https: data:"><base href="${escapeAttribute(adminApiUrl("/"))}"><style>html{background:${background}}body{max-width:760px;margin:0 auto;padding:36px 40px 80px;background:${background};color:${text};font:15px/1.85 Arial,'Microsoft YaHei',sans-serif;overflow-wrap:anywhere}h1{font-size:28px;line-height:1.4}h2{font-size:22px;line-height:1.45}h3{font-size:18px;line-height:1.5}p{margin:0 0 1em}a{color:${link}}img{display:block;max-width:100%;height:auto;margin:20px auto}blockquote{margin:18px 0;padding:8px 18px;border-left:3px solid ${link};color:${muted}}table{width:100%;border-collapse:collapse}td,th{padding:9px;border:1px solid ${border};text-align:left}code{padding:2px 5px;border-radius:3px;background:${light ? "#eef3f8" : "#172538"}}</style></head><body>${document.body.innerHTML}</body></html>`;
}

function recordPayload(record: ManagedIngestionRecord, articleMarkdown: string) {
  return {
    targetId: record.targetId,
    title: record.title,
    risk: record.risk || "low",
    reportDate: record.reportDate || "",
    sourceGroupName: record.sourceGroupName || "",
    sourceGroupId: record.sourceGroupId || "",
    sourceGroupUrl: record.sourceGroupUrl || "",
    messageUrl: record.messageUrl || "",
    intelTags: record.intelTags?.length ? record.intelTags : ["数据泄露"],
    leakDataTypes: record.leakDataTypes || "",
    leakCount: record.leakCount || "",
    transactionCount: record.transactionCount || "",
    transactionPrice: record.transactionPrice || "",
    publishedAt: record.publishedAt || "",
    publisherId: record.publisherId || "",
    intelNote: record.intelNote || "",
    articleMarkdown: articleMarkdown.trim()
  };
}

export function DarkWebArticleEditorPage() {
  const { recordId = "" } = useParams();
  const { tenantId } = useCustomerScope();
  const navigate = useNavigate();
  const [record, setRecord] = useState<ManagedIngestionRecord | null>(null);
  const [target, setTarget] = useState<MonitoringTarget | null>(null);
  const [articleContent, setArticleContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState<ToastState>(null);
  const [activePane, setActivePane] = useState<EditorPane>("edit");
  const [lightTheme, setLightTheme] = useState(() => document.documentElement.dataset.theme === "light");
  const editorBaselinePending = useRef(true);
  const deferredContent = useDebouncedValue(articleContent, 300);
  const dirty = articleContent !== savedContent;
  useAdminInitialLoading("dark-web-article-editor", loading);

  const listPath = `/admin/customer-operations/ingestion/dark-web?tenant=${encodeURIComponent(tenantId)}`;

  useEffect(() => {
    const observer = new MutationObserver(() => setLightTheme(document.documentElement.dataset.theme === "light"));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let active = true;
    setLoading(true); setError("");
    Promise.all([
      apiFetch<ManagedIngestionRecord>(`/api/ingestion/records/dark-web/${encodeURIComponent(recordId)}`),
      apiFetch<MonitoringTarget[]>(tenantId ? `/api/targets?tenant_id=${encodeURIComponent(tenantId)}` : "/api/targets")
    ]).then(([item, targets]) => {
      if (!active) return;
      const currentTarget = targets.find((candidate) => candidate.id === item.targetId && candidate.tenantId === tenantId);
      if (!currentTarget) throw new Error("该暗网情报不属于当前客户，无法在此编辑");
      editorBaselinePending.current = true;
      setRecord(item); setTarget(currentTarget); setArticleContent(item.articleMarkdown || ""); setSavedContent(item.articleMarkdown || "");
    }).catch((reason) => {
      if (active) setError(reason instanceof Error ? reason.message : "暗网情报加载失败");
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [recordId, tenantId]);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const preview = useMemo(() => previewDocument(deferredContent, lightTheme), [deferredContent, lightTheme]);

  const goBack = () => {
    if (dirty && !window.confirm("正文还有未保存的修改，确定返回吗？")) return;
    navigate(listPath);
  };

  const save = async (publish: boolean) => {
    if (!record) return;
    setSaving(true);
    try {
      const saved = await apiFetch<ManagedIngestionRecord>(`/api/ingestion/records/dark-web/${encodeURIComponent(record.id)}`, { method: "PUT", body: JSON.stringify(recordPayload(record, articleContent)) });
      if (publish) await apiFetch(`/api/ingestion/records/dark-web/${encodeURIComponent(record.id)}/publish`, { method: "POST" });
      setRecord({ ...saved, isPublished: publish }); setArticleContent(saved.articleMarkdown || ""); setSavedContent(saved.articleMarkdown || "");
      setToast({ tone: "success", text: publish ? "正文已保存并发布" : "正文已保存为草稿" });
    } catch (reason) {
      setToast({ tone: "warning", text: reason instanceof Error ? reason.message : "正文保存失败" });
    } finally {
      setSaving(false);
    }
  };

  if (loading) return null;
  if (error || !record) return <><PageHeader eyebrow="DARK WEB ARTICLE" title="正文编辑器" description="无法载入需要编辑的暗网情报" actions={<Button variant="secondary" onClick={() => navigate(listPath)}><ArrowLeft size={16} />返回列表</Button>} /><div className="dark-web-editor-error" role="alert"><AlertTriangle size={22} /><div><strong>编辑器加载失败</strong><span>{error || "暗网情报不存在"}</span></div></div></>;

  return <div className="dark-web-editor-page">
    <PageHeader eyebrow="DARK WEB ARTICLE" title={record.title} description={`${record.id} · ${target?.name || record.targetId}`} actions={<><Button variant="ghost" onClick={goBack}><ArrowLeft size={16} />返回列表</Button><Button variant="secondary" onClick={() => void save(false)} disabled={saving || !dirty}><Save size={16} />{saving ? "保存中..." : "保存草稿"}</Button><Button onClick={() => void save(true)} disabled={saving}><Send size={16} />{saving ? "发布中..." : "保存并发布"}</Button></>} />
    <section className="dark-web-editor-context" aria-label="情报摘要"><div><span>风险等级</span><strong>{riskLabels[record.risk || "low"] || "低危"}</strong></div><div><span>情报标签</span><strong>{record.intelTags?.join(" / ") || "数据泄露"}</strong></div><div><span>来源群组</span><strong>{record.sourceGroupName || "未填写"}</strong></div><div><span>编辑状态</span><Tag tone={dirty ? "orange" : "green"}>{dirty ? "有未保存修改" : record.isPublished ? "已发布" : "草稿已保存"}</Tag></div></section>
    <DarkWebAttachments recordId={record.id} onChanged={() => setRecord((current) => current ? { ...current, isPublished: false } : current)} />
    <div className="dark-web-editor-mobile-tabs" role="tablist" aria-label="正文工作区视图"><button type="button" role="tab" aria-selected={activePane === "edit"} className={activePane === "edit" ? "active" : ""} onClick={() => setActivePane("edit")}><FilePenLine size={16} />编辑</button><button type="button" role="tab" aria-selected={activePane === "preview"} className={activePane === "preview" ? "active" : ""} onClick={() => setActivePane("preview")}><Eye size={16} />预览</button></div>
    <div className="dark-web-editor-workspace">
      <section className={`dark-web-editor-pane dark-web-editor-compose${activePane === "edit" ? " mobile-active" : ""}`} aria-label="正文编辑"><header><div><FilePenLine size={17} /><strong>正文编辑</strong></div><span>{dirty ? "待保存" : "已保存"}</span></header><ArticleEditor value={articleContent} onChange={setArticleContent} onReady={(content) => { if (!editorBaselinePending.current) return; editorBaselinePending.current = false; setArticleContent(content); setSavedContent(content); }} /></section>
      <section className={`dark-web-editor-pane dark-web-editor-preview${activePane === "preview" ? " mobile-active" : ""}`} aria-label="正文实时预览"><header><div><Eye size={17} /><strong>实时预览</strong></div><span>内容呈现效果</span></header><iframe title="暗网情报正文实时预览" sandbox="" srcDoc={preview} /></section>
    </div>
    <Toast value={toast} onClose={() => setToast(null)} />
  </div>;
}
