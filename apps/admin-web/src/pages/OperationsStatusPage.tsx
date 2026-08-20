import { useEffect, useState } from "react";
import { Activity, AlertTriangle, CheckCircle2, Clock3, Database, RefreshCw, ServerCog } from "lucide-react";
import type { ApiConnection, BackgroundRun } from "@sentinel/shared";
import { Button, Panel, StatusDot, Tag } from "@/components/common";
import { PageHeader, Toast, type ToastState } from "@/components/business/AdminPrimitives";
import { adminApiFetch as apiFetch } from "@/api/admin";
import { useAdminInitialLoading } from "@/hooks/useAdminInitialLoading";
import { useCustomerScope } from "@/layouts";

type BackgroundOverview = {
  queue: { pending: number; running: number; permanentlyFailed: number; oldestWaitingMs: number };
  observability: { lastHour: { jobs: number; succeeded: number; failed: number; retrying: number; successRate: number | null; p95DurationMs: number } };
};

function duration(value: number) {
  if (value < 1_000) return `${value}ms`;
  return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}s`;
}

export function OperationsStatusPage() {
  const { tenantId } = useCustomerScope();
  const [overview, setOverview] = useState<BackgroundOverview | null>(null);
  const [connections, setConnections] = useState<ApiConnection[]>([]);
  const [runs, setRuns] = useState<BackgroundRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<ToastState>(null);
  useAdminInitialLoading("operations-status", loading);
  const load = async () => {
    setLoading(true);
    try {
      const [background, connectionRows, runRows] = await Promise.all([apiFetch<BackgroundOverview>("/api/background-tasks"), apiFetch<ApiConnection[]>("/api/connections"), apiFetch<{ items: BackgroundRun[] }>(`/api/background-runs?tenant_id=${encodeURIComponent(tenantId)}&limit=12`)]);
      setOverview(background); setConnections(connectionRows); setRuns(runRows.items);
    } catch (error) { setToast({ tone: "warning", text: error instanceof Error ? error.message : "运行状态加载失败" }); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, [tenantId]);
  const abnormalConnections = connections.filter((item) => item.enabled && item.status !== "正常");
  return <>
    <PageHeader eyebrow="OPERATIONS OBSERVABILITY" title="运行状态" description="集中查看任务队列、数据接口与最近运行状态。" actions={<Button variant="secondary" onClick={() => void load()} disabled={loading}><RefreshCw size={16} />{loading ? "刷新中..." : "刷新状态"}</Button>} />
    <section className="status-summary">
      <div><Activity size={19} /><span><small>近 1 小时成功率</small><strong>{overview?.observability.lastHour.successRate == null ? "--" : `${overview.observability.lastHour.successRate}%`}</strong></span></div>
      <div><Clock3 size={19} /><span><small>运行 / 等待</small><strong>{overview ? `${overview.queue.running} / ${overview.queue.pending}` : "--"}</strong></span></div>
      <div><Database size={19} /><span><small>异常接口</small><strong>{abnormalConnections.length}</strong></span></div>
      <div><ServerCog size={19} /><span><small>P95 执行耗时</small><strong>{overview ? duration(overview.observability.lastHour.p95DurationMs) : "--"}</strong></span></div>
    </section>
    <div className="status-grid"><Panel title="数据接口健康" action={<StatusDot label={abnormalConnections.length ? `${abnormalConnections.length} 个异常` : "全部正常"} tone={abnormalConnections.length ? "danger" : "success"} live={!abnormalConnections.length} />}><div className="status-list">{connections.map((item) => <div key={item.id}><span className="status-list-icon">{item.status === "正常" ? <CheckCircle2 size={17} /> : <AlertTriangle size={17} />}</span><div><strong>{item.name}</strong><small>{item.providerName} · {item.lastCalled}</small></div><StatusDot label={!item.enabled ? "已停用" : item.status} tone={!item.enabled ? "muted" : item.status === "正常" ? "success" : "danger"} live={item.enabled && item.status === "正常"} /></div>)}</div></Panel>
      <Panel title="最近任务运行" action={overview && <Tag>{overview.observability.lastHour.jobs} 次 / 小时</Tag>}><div className="status-list">{runs.slice(0, 8).map((item) => <div key={item.bullmqJobId}><span className="status-list-icon"><Clock3 size={17} /></span><div><strong>{item.taskLabel}</strong><small>{item.startedAt ? new Date(item.startedAt).toLocaleString("zh-CN", { hour12: false }) : "等待执行"}</small></div><StatusDot label={item.state === "succeeded" ? "成功" : item.state === "failed" ? "失败" : item.state === "retrying" ? "重试中" : "运行中"} tone={item.state === "succeeded" ? "success" : item.state === "failed" ? "danger" : "warning"} /></div>)}</div></Panel></div>
    <Toast value={toast} onClose={() => setToast(null)} />
  </>;
}
