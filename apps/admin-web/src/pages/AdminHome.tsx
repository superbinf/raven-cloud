import { useEffect, useMemo, useState, type ComponentType } from "react";
import { Link } from "react-router-dom";
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  Cable,
  CheckCircle2,
  CloudCog,
  ContactRound,
  Database,
  FileInput,
  Gauge,
  RefreshCw,
  Server,
  ShieldCheck,
  TimerReset
} from "lucide-react";
import { type AdminDashboardMetric, type AdminDashboardResult, type Permission } from "@sentinel/shared";
import { Button, Panel, StatusDot, Tag } from "@sentinel/ui";
import { AdminTrendChart, PageHeader } from "../components/AdminPrimitives";
import { adminApiFetch as apiFetch } from "../shared/api/adminApi";
import { useAdminInitialLoading } from "../app/AdminInitialLoading";
import { useCustomerScope } from "../app/CustomerScopeLayout";

type DashboardMetric = AdminDashboardMetric & { context: string; icon: ComponentType<{ size?: number }> };

const metricMeta = [
  { context: "实时写入", icon: Activity },
  { context: "需要关注", icon: AlertTriangle },
  { context: "生效范围", icon: Database }
];

const healthMeta = {
  "核心 API": { icon: Server, detail: "运营服务与业务接口" },
  "PostgreSQL 数据库": { icon: Database, detail: "业务数据持久化" },
  "数据源连接": { icon: Cable, detail: "外部采集通道" },
  "证据文件存储": { icon: ShieldCheck, detail: "原始证据与附件" }
};

function formatValue(value: string) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric.toLocaleString("zh-CN") : value;
}

export function AdminHome({ permissions }: { permissions: Permission[] }) {
  const { tenantId } = useCustomerScope();
  const [dashboard, setDashboard] = useState<AdminDashboardResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  useAdminInitialLoading("dashboard", loading);
  const can = (permission: Permission) => permissions.includes(permission);

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      setDashboard(await apiFetch<AdminDashboardResult>(`/api/dashboard/admin${tenantId ? `?tenant_id=${encodeURIComponent(tenantId)}` : ""}`));
      setUpdatedAt(new Date());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "运营数据加载失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, [tenantId]);

  const overview = useMemo(() => {
    if (!dashboard) return null;
    const sevenDayTotal = dashboard.trendData.reduce((sum, point) => sum + point.total, 0);
    const sevenDayRisk = dashboard.trendData.reduce((sum, point) => sum + point.critical + point.high, 0);
    const peak = dashboard.trendData.reduce((current, point) => point.total > current.total ? point : current, dashboard.trendData[0] ?? { date: "--", total: 0, critical: 0, high: 0, medium: 0 });
    const healthyServices = dashboard.health.filter((item) => item.tone === "success").length;
    const healthRate = dashboard.health.length ? Math.round(healthyServices / dashboard.health.length * 100) : 0;
    const healthTone: "success" | "warning" | "danger" = dashboard.health.some((item) => item.tone === "danger") ? "danger" : dashboard.health.some((item) => item.tone === "warning") ? "warning" : "success";
    const metrics: DashboardMetric[] = [
      ...dashboard.metrics.map((metric, index) => ({ ...metric, ...metricMeta[index % metricMeta.length] })),
      {
        label: "七日入库",
        value: String(sevenDayTotal),
        note: `日均 ${Math.round(sevenDayTotal / Math.max(dashboard.trendData.length, 1)).toLocaleString("zh-CN")} 条`,
        tone: "orange",
        context: "数据规模",
        icon: Gauge
      }
    ];
    return { sevenDayTotal, sevenDayRisk, peak, healthyServices, healthRate, healthTone, metrics };
  }, [dashboard]);

  const tenantSearch = tenantId ? `?tenant=${encodeURIComponent(tenantId)}` : "";
  const quickActions = [
    can("targets:read") && { to: "/admin/customer-operations/scope", icon: ContactRound, label: "客户运营", detail: "关键词与域名配置" },
    can("sources:read") && { to: "/admin/customer-operations/interfaces", icon: Cable, label: "接口配置", detail: "数据源与连接状态" },
    can("ingestion:manage") && { to: "/admin/customer-operations/ingestion/sensitive", icon: FileInput, label: "数据接入", detail: "录入与批次管理" },
    can("operations:manage") && { to: "/admin/operations/status", icon: Gauge, label: "状态监控", detail: "服务与组件运行态势" },
    can("operations:manage") && { to: "/admin/operations/tasks", icon: TimerReset, label: "任务中心", detail: "任务执行与问题记录" }
  ].filter(Boolean).map((item) => item ? { ...item, to: `${item.to}${tenantSearch}` } : item) as Array<{ to: string; icon: ComponentType<{ size?: number }>; label: string; detail: string }>;

  return <>
    <PageHeader
      eyebrow="OPERATIONS OVERVIEW"
      title="运营工作台"
      description="聚合数据接入、采集链路与平台运行状态。"
      actions={<>
        {updatedAt && <span className="dashboard-updated"><CheckCircle2 size={13} />更新于 {updatedAt.toLocaleTimeString("zh-CN", { hour12: false })}</span>}
        <Button variant="secondary" onClick={() => void load()} disabled={loading} aria-busy={loading}>
          <RefreshCw className={loading ? "is-spinning" : ""} size={17} />
          {loading ? "刷新中..." : "刷新数据"}
        </Button>
      </>}
    />

    {error && !dashboard ? <Panel><div className="inline-empty"><AlertTriangle size={26} /><strong>运营数据加载失败</strong><span>{error}</span><Button variant="secondary" onClick={() => void load()}>重新加载</Button></div></Panel> : !dashboard || !overview ? <Panel><div className="inline-empty"><RefreshCw className="is-spinning" size={24} /><strong>正在加载运营数据</strong></div></Panel> : <>
      <section className="admin-metrics" aria-label="核心运营指标">
        {overview.metrics.map(({ label, value, note, tone, context, icon: Icon }) => <article className={`admin-metric metric-tone-${tone}`} key={label}>
          <header><span className="metric-icon"><Icon size={18} /></span><small>{context}</small></header>
          <div className="metric-value"><span>{label}</span><strong>{formatValue(value)}</strong></div>
          <footer><span>{note}</span><span className="metric-live"><i aria-hidden="true" />实时</span></footer>
        </article>)}
      </section>

      <div className="admin-dashboard-grid">
        <Panel
          className="dashboard-trend-panel"
          title={<span className="dashboard-panel-title"><Activity size={16} />数据入库趋势</span>}
          action={<div className="dashboard-trend-summary"><span>七日累计 <strong>{overview.sevenDayTotal.toLocaleString("zh-CN")}</strong></span><span>高危 <strong>{overview.sevenDayRisk.toLocaleString("zh-CN")}</strong></span><Tag tone="cyan">近 7 日</Tag></div>}
        >
          {dashboard.trendData.length ? <AdminTrendChart data={dashboard.trendData} /> : <div className="inline-empty"><Activity size={24} /><strong>近七日暂无入库数据</strong></div>}
          <footer className="dashboard-chart-insight"><span>峰值日期 <strong>{overview.peak.date}</strong></span><span>单日峰值 <strong>{overview.peak.total.toLocaleString("zh-CN")} 条</strong></span><span>风险数据 <strong>{overview.sevenDayRisk.toLocaleString("zh-CN")} 条</strong></span></footer>
        </Panel>

        <Panel
          className="dashboard-health-panel"
          title={<span className="dashboard-panel-title"><CloudCog size={16} />系统健康</span>}
          action={<StatusDot label={overview.healthTone === "success" ? "运行正常" : overview.healthTone === "warning" ? "部分异常" : "需要处理"} tone={overview.healthTone} live={overview.healthTone === "success"} />}
        >
          <div className={`dashboard-health-overview health-tone-${overview.healthTone}`}>
            <div><strong>{overview.healthRate}%</strong><span>服务可用率</span></div>
            <p><strong>{overview.healthyServices}/{dashboard.health.length} 项服务正常</strong><span>{overview.healthTone === "success" ? "核心能力均处于可用状态" : "请及时检查异常服务"}</span></p>
          </div>
          {dashboard.health.length ? <div className="dashboard-health-list">{dashboard.health.map(({ name, status, tone }) => {
            const meta = healthMeta[name as keyof typeof healthMeta] ?? { icon: CloudCog, detail: "平台基础服务" };
            const Icon = meta.icon;
            return <div key={name}><span className={`health-service-icon health-service-${tone}`}><Icon size={16} /></span><span><strong>{name}</strong><small>{meta.detail}</small></span><StatusDot label={status} tone={tone} live={tone === "success"} /></div>;
          })}</div> : <div className="inline-empty"><CloudCog size={24} /><strong>暂无系统健康数据</strong></div>}
          {can("operations:manage") && <Link className="dashboard-health-link" to="/admin/operations/status">查看完整运行状态<ArrowUpRight size={14} /></Link>}
        </Panel>

        {quickActions.length > 0 && <Panel
          className="dashboard-quick-panel"
          title={<span className="dashboard-panel-title"><Gauge size={16} />快捷操作</span>}
          action={<span className="dashboard-panel-note">常用运营入口</span>}
        >
          <div className="dashboard-quick-actions">{quickActions.map(({ to, icon: Icon, label, detail }) => <Link to={to} key={to}>
            <span><Icon size={18} /></span><span><strong>{label}</strong><small>{detail}</small></span><ArrowUpRight size={14} />
          </Link>)}</div>
        </Panel>}
      </div>
    </>}
  </>;
}
