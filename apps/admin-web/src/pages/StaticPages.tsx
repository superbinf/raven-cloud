import { useEffect, useState, type FormEvent } from "react";

import { AlertTriangle, Archive, Bot, RefreshCw, Search } from "lucide-react";
import { Button, Panel, StatusDot, Tag } from "@sentinel/ui";
import { PageHeader, SequenceCell, SequenceHeader } from "../components/AdminPrimitives";
import { TablePagination } from "../components/TablePagination";
import { adminApiFetch } from "../shared/api/adminApi";
import { useAdminInitialLoading } from "../app/AdminInitialLoading";

export function AiPage() {
  return <><PageHeader eyebrow="AI ORCHESTRATION" title="AI 中心" description="配置模型供应商、任务路由、提示词模板、脱敏策略和调用预算。" /><Panel><div className="inline-empty"><Bot size={28} /><strong>AI 能力尚未配置</strong><span>当前没有模型供应商、调用记录或路由配置的真实后端数据。</span><small>[WIP] 完成服务端模型配置、调用审计和测试接口后再开放操作。</small></div></Panel></>;
}

type AuditContext = "operations" | "management" | "all";
type AuditResult = "success" | "failed";

type AuditRecord = {
  id: string;
  occurredAt: string;
  context: AuditContext;
  actorAccount: string;
  actorName: string;
  actorRole: string;
  action: string;
  resourceType: string;
  resourceId: string;
  method: string;
  path: string;
  statusCode: number;
  result: AuditResult;
  ipAddress: string;
  requestId: string;
};

type AuditResponse = {
  page: number;
  pageSize: number;
  total: number;
  resultCounts: Partial<Record<AuditResult, number>>;
  data: AuditRecord[];
};

const resourceLabels: Record<string, string> = {
  "身份认证": "身份认证",
  user: "用户账号",
  "keyword-domain": "关键词与域名",
  connection: "数据接口",
  ingestion: "数据导入",
  "ingestion-record": "业务数据",
  vulnerability: "漏洞情报",
  "edge-deployment": "地端部署",
  operations: "运营配置",
  audit: "审计服务",
  api: "后台接口"
};

function displayTime(value: string) {
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? value : time.toLocaleString("zh-CN", { hour12: false });
}

export function AuditPage({ context = "operations" }: { context?: AuditContext }) {
  const management = context !== "operations";
  const allContexts = context === "all";
  const [records, setRecords] = useState<AuditRecord[]>([]);
  const [queryInput, setQueryInput] = useState("");
  const [query, setQuery] = useState("");
  const [resultFilter, setResultFilter] = useState<"" | AuditResult>("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [total, setTotal] = useState(0);
  const [resultCounts, setResultCounts] = useState<Partial<Record<AuditResult, number>>>({});
  const [refreshKey, setRefreshKey] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useAdminInitialLoading(`audit-${context}`, loading);

  useEffect(() => {
    let active = true;
    const params = new URLSearchParams({ context, page: String(page), page_size: String(pageSize) });
    if (query) params.set("query", query);
    if (resultFilter) params.set("result", resultFilter);
    setLoading(true);
    setError("");
    adminApiFetch<AuditResponse>(`/api/audit-logs?${params.toString()}`)
      .then((response) => {
        if (!active) return;
        setRecords(response.data);
        setTotal(response.total);
        setResultCounts(response.resultCounts);
      })
      .catch((reason) => {
        if (!active) return;
        setRecords([]);
        setError(reason instanceof Error ? reason.message : "审计日志加载失败");
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [context, page, pageSize, query, resultFilter, refreshKey]);

  const search = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPage(1);
    setQuery(queryInput.trim());
  };
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return <>
    <PageHeader
      eyebrow="AUDIT TRAIL"
      title="操作审计"
      description={allContexts ? "集中查询运营平台与管理后台的登录、配置、数据和发布操作。" : management ? "查询用户、角色、登录和管理配置变更记录。" : "查询监测采集、情报运营、发布交付和运行保障记录。"}
      actions={<Button variant="secondary" onClick={() => setRefreshKey((value) => value + 1)} disabled={loading}><RefreshCw size={16} />{loading ? "刷新中..." : "刷新"}</Button>}
    />
    <div className="audit-summary" aria-label="审计日志统计">
      <span><small>当前范围</small><strong>{allContexts ? "全平台" : management ? "管理后台" : "运营平台"}</strong></span>
      <span><small>成功操作</small><strong>{resultCounts.success ?? 0}</strong></span>
      <span><small>失败操作</small><strong className="audit-failed-count">{resultCounts.failed ?? 0}</strong></span>
    </div>
    <form className="toolbar audit-toolbar" onSubmit={search}>
      <div className="toolbar-search"><Search size={17} /><input type="search" aria-label="搜索审计日志" value={queryInput} onChange={(event) => setQueryInput(event.target.value)} placeholder="搜索操作人、动作、资源或接口路径" /></div>
      <select aria-label="筛选执行结果" value={resultFilter} onChange={(event) => { setResultFilter(event.target.value as "" | AuditResult); setPage(1); }}>
        <option value="">全部结果</option>
        <option value="success">成功</option>
        <option value="failed">失败</option>
      </select>
      <Button type="submit" variant="secondary"><Search size={16} />查询</Button>
    </form>
    <Panel>
      {loading ? <div className="inline-empty"><RefreshCw size={25} /><strong>正在加载审计日志</strong></div>
        : error ? <div className="inline-empty"><AlertTriangle size={26} /><strong>审计日志加载失败</strong><span>{error}</span><Button variant="secondary" onClick={() => setRefreshKey((value) => value + 1)}>重新加载</Button></div>
          : records.length ? <div className="admin-table audit-table">
            <div className="admin-table-head"><SequenceHeader /><span>时间</span><span>操作人</span><span>动作</span><span>资源</span><span>结果</span><span>IP / 请求 ID</span></div>
            {records.map((record, index) => <div className="admin-table-row" key={record.id}>
              <SequenceCell value={(page - 1) * pageSize + index + 1} />
              <time dateTime={record.occurredAt}>{displayTime(record.occurredAt)}</time>
              <div className="audit-actor"><strong>{record.actorName || record.actorAccount || "匿名访问"}</strong><small>{record.actorAccount || "anonymous"}{record.actorRole ? ` · ${record.actorRole}` : ""}</small></div>
              <div className="audit-action"><strong>{record.action}</strong><small><Tag tone="cyan">{record.method}</Tag>{record.path}</small></div>
              <div className="audit-resource"><strong>{resourceLabels[record.resourceType] || record.resourceType}</strong><small>{record.resourceId || "--"}</small></div>
              <StatusDot label={`${record.result === "success" ? "成功" : "失败"} · ${record.statusCode}`} tone={record.result === "success" ? "success" : "danger"} />
              <div className="audit-request"><code>{record.ipAddress || "--"}</code><small title={record.requestId}>{record.requestId}</small></div>
            </div>)}
          </div>
            : <div className="inline-empty"><Archive size={27} /><strong>暂无匹配的审计日志</strong><span>{query || resultFilter ? "请调整查询条件后重试。" : "该审计域暂未产生操作记录。"}</span></div>}
      {!loading && !error && <TablePagination page={page} pageSize={pageSize} totalPages={totalPages} total={total} loading={loading} onPageChange={setPage} onPageSizeChange={(value) => { setPageSize(value); setPage(1); }} />}
    </Panel>
  </>;
}
