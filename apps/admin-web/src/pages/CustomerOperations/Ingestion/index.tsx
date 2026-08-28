import { useEffect, useRef, useState, type ChangeEvent } from "react";

import { AlertTriangle, CheckCircle2, Download, Eye, FileStack, LoaderCircle, UploadCloud, X } from "lucide-react";
import { type IngestionBatch, type IngestionType, type MonitoringTarget } from "@sentinel/shared";
import { Button, Modal, Panel, Tag } from "@/components/ui";
import { PageHeader, Toast, type ToastState } from "@/components/business/AdminPrimitives";
import { IngestionRecordManager } from "@/components/business/IngestionRecordManager";
import { adminApiFetch as apiFetch, adminApiRequestHeaders, adminApiUrl } from "@/api/admin";
import { useAdminInitialLoading } from "@/hooks/useAdminInitialLoading";

type IngestionMode = IngestionType;
type UploadState = { phase: "idle" | "uploading" | "success" | "error"; fileName?: string; message?: string; batch?: IngestionBatch };

const ingestionModeMeta: Record<IngestionMode, {
  label: string;
  shortLabel: string;
  description: string;
  endpoint: string;
  accept: string;
  fileHelp: string;
  dedupeHelp: string;
  publishHelp: string;
}> = {
  sensitive: {
    label: "敏感信息",
    shortLabel: "敏感信息",
    description: "导入账号口令、源码泄露、文档泄露和仿冒网站汇总表。",
    endpoint: "/api/ingestion/sensitive-xlsx",
    accept: ".xlsx,.xls",
    fileHelp: "识别工作表：账号口令、源码泄露、文档泄露、仿冒网站",
    dedupeHelp: "按核心字段生成 SHA-256 内容指纹",
    publishHelp: "审核并发布后进入敏感信息模块"
  },
  asset: {
    label: "资产信息",
    shortLabel: "资产信息",
    description: "导入互联网资产 Excel 或扫描 HTML 报告。",
    endpoint: "/api/ingestion/assets-xlsx",
    accept: ".xlsx,.xls,.html,.htm",
    fileHelp: "支持 Excel 资产表或 HTML 资产报告",
    dedupeHelp: "按 DNS、端口和 Web 核心标识去重，仅比较存活状态与状态码",
    publishHelp: "审核并发布后进入资产视图"
  },
  "dark-web": {
    label: "暗网情报",
    shortLabel: "暗网情报",
    description: "导入文件后进入待审核草稿，在本页完成编辑、删除和发布。",
    endpoint: "/api/ingestion/dark-web",
    accept: ".zip,.docx",
    fileHelp: "支持 ZIP（DOCX 报告与 XLSX 附件）或单独 DOCX Word 报告",
    dedupeHelp: "优先按消息链接识别，无链接时按报告内容识别",
    publishHelp: "进入用户前台暗网情报模块"
  }
};

function assetBatchComparison(batch: IngestionBatch) {
  return `${batch.aliveChangedRows || 0} 条存活变化 · ${batch.statusCodeChangedRows || 0} 条状态码变化`;
}

export function IngestionPage({ mode, tenantId }: { mode: IngestionMode; tenantId?: string }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [batches, setBatches] = useState<IngestionBatch[]>([]);
  const [targets, setTargets] = useState<MonitoringTarget[]>([]);
  const [targetId, setTargetId] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadState, setUploadState] = useState<UploadState>({ phase: "idle" });
  const [selectedBatch, setSelectedBatch] = useState<IngestionBatch | null>(null);
  const [recordRefreshVersion, setRecordRefreshVersion] = useState(0);
  const [toast, setToast] = useState<ToastState>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  useAdminInitialLoading(`ingestion-${mode}`, initialLoading);
  const meta = ingestionModeMeta[mode];

  const loadData = () => Promise.all([
    apiFetch<IngestionBatch[]>(`/api/ingestion/batches?type=${encodeURIComponent(mode)}${tenantId ? `&tenant_id=${encodeURIComponent(tenantId)}` : ""}`),
    apiFetch<MonitoringTarget[]>(tenantId ? `/api/targets?tenant_id=${encodeURIComponent(tenantId)}` : "/api/targets")
  ]).then(([batchItems, targetItems]) => {
    const visibleTargets = tenantId ? targetItems.filter((target) => target.tenantId === tenantId) : targetItems;
    const targetIds = new Set(visibleTargets.map((target) => target.id));
    setBatches(tenantId ? batchItems.filter((batch) => batch.targetId && targetIds.has(batch.targetId)) : batchItems);
    setTargets(visibleTargets);
    setTargetId((current) => visibleTargets.some((target) => target.id === current) ? current : visibleTargets[0]?.id ?? "");
  });

  useEffect(() => {
    loadData().catch((error) => setToast({ tone: "warning", text: error.message })).finally(() => setInitialLoading(false));
  }, [mode, tenantId]);

  const handleFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const isAssetHtml = mode === "asset" && /\.html?$/i.test(file.name);
    const valid = mode === "dark-web" ? /\.(zip|docx)$/i.test(file.name) : mode === "asset" ? /\.(xlsx|xls|html?)$/i.test(file.name) : /\.(xlsx|xls)$/i.test(file.name);
    if (!valid) {
      setToast({ tone: "warning", text: meta.label + "不支持该文件类型" });
      return;
    }
    const form = new FormData();
    form.append("file", file);
    form.append("targetId", targetId);
    setUploading(true);
    setUploadState({ phase: "uploading", fileName: file.name, message: "文件已接收，正在执行安全校验、解析和差异比对" });
    try {
      const endpoint = isAssetHtml ? "/api/ingestion/assets-html" : meta.endpoint;
      const batch = await apiFetch<IngestionBatch>(endpoint, { method: "POST", body: form });
      setBatches((items) => [batch, ...items]);
      setRecordRefreshVersion((value) => value + 1);
      setUploadState({ phase: "success", fileName: file.name, batch, message: batch.status === "已发布" ? "解析完成，已按当前客户策略自动发送" : "解析完成，数据已进入待审核区" });
      setToast({ tone: "success", text: mode === "asset" ? `资产比对完成：${assetBatchComparison(batch)}，新增 ${batch.newRows} 条，消失 ${batch.missingRows || 0} 条` : `${meta.shortLabel}解析完成：新增 ${batch.newRows} 条` });
    } catch (error) {
      const message = error instanceof Error ? error.message : "文件解析失败";
      setUploadState({ phase: "error", fileName: file.name, message });
      setToast({ tone: "warning", text: message });
    } finally {
      setUploading(false);
    }
  };

  const downloadArchive = async (batch: IngestionBatch) => {
    try {
      const response = await fetch(adminApiUrl("/api/ingestion/batches/" + batch.id + "/archive"), { headers: adminApiRequestHeaders() });
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).message || "原始文件下载失败");
      const href = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = href;
      anchor.download = batch.fileName;
      anchor.click();
      URL.revokeObjectURL(href);
    } catch (error) {
      setToast({ tone: "warning", text: error instanceof Error ? error.message : "原始文件下载失败" });
    }
  };

  const progressStep = uploading ? 2 : uploadState.phase === "success" ? 3 : 0;
  return <><PageHeader eyebrow="MANUAL INGESTION" title={meta.label} description={meta.description} actions={<Button onClick={() => inputRef.current?.click()} disabled={uploading || !targetId}><UploadCloud size={17} />{uploading ? "解析中..." : "上传" + meta.shortLabel}</Button>} />
    <input ref={inputRef} className="hidden-input" type="file" accept={meta.accept} onChange={handleFile} />
    {uploadState.phase !== "idle" && <section className={`ingestion-status ingestion-status-${uploadState.phase}`} aria-live="polite">{uploadState.phase === "uploading" ? <LoaderCircle className="is-spinning" size={21} /> : uploadState.phase === "success" ? <CheckCircle2 size={21} /> : <AlertTriangle size={21} />}<div><strong>{uploadState.phase === "uploading" ? "正在解析并比对" : uploadState.phase === "success" ? "文件处理完成" : "文件处理失败"}</strong><span>{uploadState.fileName} · {uploadState.message}</span>{uploadState.batch && <small>{uploadState.batch.totalRows} 条总记录 · {uploadState.batch.newRows} 条新增 · {mode === "asset" ? `${assetBatchComparison(uploadState.batch)} · ` : ""}{uploadState.batch.missingRows || 0} 条消失 · {uploadState.batch.unchangedRows ?? uploadState.batch.duplicateRows} 条未变化</small>}{uploading && <i aria-hidden="true" />}</div>{!uploading && <button aria-label="关闭处理结果" onClick={() => setUploadState({ phase: "idle" })}><X size={16} /></button>}</section>}
    <div className="ingestion-grid">
      <div className={`upload-zone ingestion-xlsx-zone${uploading ? " is-uploading" : ""}`} role="button" aria-disabled={uploading} tabIndex={uploading ? -1 : 0} onClick={() => { if (!uploading) inputRef.current?.click(); }} onKeyDown={(event) => { if (!uploading && (event.key === "Enter" || event.key === " ")) inputRef.current?.click(); }}>
        {uploading ? <LoaderCircle className="is-spinning" size={34} /> : <UploadCloud size={34} />}
        <strong>{uploading ? `正在处理 ${uploadState.fileName}` : `导入${meta.shortLabel}`}</strong>
        <span>{uploading ? "请保持页面打开，完成后会在这里显示处理结果" : meta.fileHelp}</span>
        <small>{meta.dedupeHelp}，处理后按当前客户的发布策略自动发送或进入待审核区</small>
        <label className="ingestion-target-select" onClick={(event) => event.stopPropagation()}>
          <span>归属监测对象</span>
          <select value={targetId} onChange={(event) => setTargetId(event.target.value)}>
            {targets.length ? targets.map((target) => <option key={target.id} value={target.id}>{target.name}</option>) : <option value="">当前客户暂无监测对象</option>}
          </select>
        </label>
      </div>
      <Panel title="解析流程"><ol className="ingestion-steps">
        <li className={progressStep >= 1 ? "done" : ""}><span>1</span><div><strong>识别文件</strong><small>{meta.fileHelp}</small></div></li>
        <li className={progressStep === 2 ? "current" : progressStep > 2 ? "done" : ""}><span>2</span><div><strong>安全校验</strong><small>{mode === "dark-web" ? "校验文件类型并提取报告原始内容" : "统一名称、链接、风险与备注"}</small></div></li>
        <li className={progressStep === 3 ? "done" : ""}><span>3</span><div><strong>{mode === "asset" ? "基线差异比对" : "内容去重"}</strong><small>{meta.dedupeHelp}</small></div></li>
        <li className={uploadState.phase === "success" ? "current" : ""}><span>4</span><div><strong>按策略发送</strong><small>{meta.publishHelp}</small></div></li>
      </ol></Panel>
    </div>
    <IngestionRecordManager mode={mode} targets={targets} tenantId={tenantId} refreshVersion={recordRefreshVersion} onToast={setToast} onMutate={() => {
      setRecordRefreshVersion((value) => value + 1);
      void loadData().catch((error) => setToast({ tone: "warning", text: error.message }));
    }} />
    <Panel title={"最近" + meta.shortLabel + "录入批次"}><div className="batch-list">{batches.length ? batches.map((batch) => <div key={batch.id}>
      <span className="file-icon"><FileStack size={19} /></span>
      <div><strong>{batch.fileName}</strong><small>{batch.id} · {batch.sheets.map((sheet) => sheet.label + " " + sheet.total).join("、") || "未识别内容"}</small></div>
      <Tag tone={batch.status === "已发布" ? "green" : "orange"}>{batch.status}</Tag>
      <span>{batch.newRows} 新增{mode === "asset" ? ` / ${batch.aliveChangedRows || 0} 存活变化 / ${batch.statusCodeChangedRows || 0} 状态码变化 / ${batch.missingRows || 0} 消失` : ` / ${batch.duplicateRows} 去重`}</span>
      <time>{batch.createdAt.replace("T", " ").slice(0, 16)}</time>
      <button className="text-action" type="button" onClick={() => setSelectedBatch(batch)}><Eye size={13} />查看批次</button>
    </div>) : <div className="inline-empty"><FileStack size={24} /><strong>暂无{meta.shortLabel}录入批次</strong></div>}</div></Panel>
    <Modal open={Boolean(selectedBatch)} title={selectedBatch ? "录入批次 · " + selectedBatch.id : "录入批次"} onClose={() => setSelectedBatch(null)} footer={selectedBatch?.type === "dark-web" ? <Button onClick={() => void downloadArchive(selectedBatch)}><Download size={16} />下载原始文件</Button> : undefined}>
      {selectedBatch && <div className="batch-detail"><dl>
        <div><dt>文件名</dt><dd>{selectedBatch.fileName}</dd></div>
        <div><dt>统计</dt><dd>{selectedBatch.totalRows} 条 · {selectedBatch.newRows} 新增 · {mode === "asset" ? `${assetBatchComparison(selectedBatch)} · ` : ""}{selectedBatch.missingRows || 0} 消失 · {selectedBatch.unchangedRows ?? selectedBatch.duplicateRows} 未变化</dd></div>
        <div><dt>录入时间</dt><dd>{selectedBatch.createdAt.replace("T", " ").slice(0, 19)}</dd></div>
      </dl><div className="batch-sheet-summary">{selectedBatch.sheets.map((sheet) => <div key={sheet.sheet}><strong>{sheet.label}</strong><span>{sheet.sheet}</span><small>{sheet.total} 条 · {sheet.newRows} 新增{mode === "asset" ? ` · ${sheet.aliveChangedRows || 0} 存活变化 · ${sheet.statusCodeChangedRows || 0} 状态码变化` : ` · ${sheet.duplicateRows} 去重`} · {sheet.skippedRows} 跳过</small></div>)}</div></div>}
    </Modal>
    <Toast value={toast} onClose={() => setToast(null)} />
  </>;
}
