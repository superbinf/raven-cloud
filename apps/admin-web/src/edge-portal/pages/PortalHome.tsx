import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Activity, CalendarPlus, ChevronRight, Database, FileKey, Globe2, Network, Radar, RefreshCw, Search, TriangleAlert } from "lucide-react";
import { type IntelligenceItem, type Metric, type TodayModuleKey } from "@sentinel/shared";
import type { EdgePortalModule } from "@sentinel/contracts";
import { Button, EmptyState, Panel, RiskBadge, Tag } from "@sentinel/ui";
import { ThreatTrendChart } from "../charts";

import { usePortalDashboard } from "../hooks/usePortalDashboard";
import { intelligenceContentPath } from "../lib/intelligence";
import { isTodayNew } from "../lib/today";
import { NewCornerBadge, TodayCountBadge } from "../shared/TodayNewBar";
import { EMPTY_DATA_DESCRIPTION, EMPTY_DATA_TITLE } from "../shared/emptyState";
import { portalApiFetch } from "../shared/api/portalApi";

const topics = [
  { title: "重保专项态势", desc: "重点资产、漏洞和升级事件", icon: Radar, tone: "blue", to: "/portal/modules/vulnerabilities/major-event", module: "vulnerabilities" },
  { title: "暗网监测", desc: "凭据泄露与暗网情报", icon: FileKey, tone: "pink", to: "/portal/modules/dark-web/intelligence", module: "dark-web" },
  { title: "敏感信息", desc: "账号口令、源码与文档泄露", icon: Network, tone: "cyan", to: "/portal/modules/sensitive/account-password", module: "sensitive" },
  { title: "互联网暴露面", desc: "资产监测与仿冒网站", icon: Globe2, tone: "green", to: "/portal/modules/exposure/assets", module: "exposure" }
] satisfies Array<{ title: string; desc: string; icon: typeof Radar; tone: string; to: string; module: EdgePortalModule }>;

const todayModules: Array<{ key: TodayModuleKey; label: string; to: string; module: EdgePortalModule }> = [
  { key: "darkWebIntelligence", label: "暗网情报", to: "/portal/modules/dark-web/intelligence?today=1", module: "dark-web" },
  { key: "credentialLeaks", label: "凭据泄露", to: "/portal/modules/dark-web/credential-leaks?today=1", module: "dark-web" },
  { key: "accountPassword", label: "账号口令", to: "/portal/modules/sensitive/account-password?today=1", module: "sensitive" },
  { key: "sourceCode", label: "源码泄露", to: "/portal/modules/sensitive/source-code?today=1", module: "sensitive" },
  { key: "documents", label: "文档泄露", to: "/portal/modules/sensitive/documents?today=1", module: "sensitive" },
  { key: "assets", label: "资产监测", to: "/portal/modules/exposure/assets?today=1", module: "exposure" },
  { key: "phishing", label: "仿冒网站", to: "/portal/modules/exposure/phishing?today=1", module: "exposure" },
  { key: "vulnerabilities", label: "漏洞情报", to: "/portal/search?type=漏洞情报", module: "vulnerabilities" }
];

function HeroSearch({ brandName, vulnerabilitiesEnabled }: { brandName: string; vulnerabilitiesEnabled: boolean }) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    navigate(`/portal/search${query.trim() ? `?q=${encodeURIComponent(query.trim())}` : ""}`);
  };
  const examples = [vulnerabilitiesEnabled ? "CVE-2026-15409" : null, "example.com", "ATO 凭据", "供应链", "favicon -247388890"].filter((value): value is string => Boolean(value));
  return (
    <section className="search-hero" aria-labelledby="portal-title">
      <div className="hero-grid" aria-hidden="true" />
      <div className="hero-content">
        <div className="hero-kicker"><Activity size={15} /> 全域情报 · 持续监测 · 关联研判</div>
        <h1 id="portal-title">{brandName}</h1>
        <p>{vulnerabilitiesEnabled ? "统一查询暗网、敏感泄露、仿冒网站、互联网暴露面和漏洞风险" : "统一查询暗网、敏感泄露、仿冒网站和互联网暴露面"}</p>
        <form className="integrated-search" onSubmit={submit}>
          <div className="integrated-search-field">
            <Search size={18} aria-hidden="true" />
            <label className="sr-only" htmlFor="hero-search">综合情报查询</label>
            <input id="hero-search" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={vulnerabilitiesEnabled ? "输入 IP、域名、URL、邮箱、文件哈希、证书指纹、CVE 或组织名称" : "输入 IP、域名、URL、邮箱、文件哈希、证书指纹或组织名称"} />
          </div>
          <Button type="submit" aria-label="搜索情报"><Search size={18} /><span>查询</span></Button>
        </form>
        <div className="search-examples" aria-label="示例查询">
          {examples.map((example) => <button key={example} type="button" onClick={() => navigate(`/portal/search?q=${encodeURIComponent(example)}`)}>{example}</button>)}
        </div>
      </div>
    </section>
  );
}

function MetricStrip({ data }: { data: Metric[] }) {
  return <section className="metric-strip" aria-label="核心指标">{data.map((metric) => {
    const numericValue = Number(metric.value);
    const displayValue = Number.isFinite(numericValue) ? numericValue.toLocaleString("zh-CN") : metric.value;
    return <div className="metric-item" key={metric.label}><span>{metric.label}</span><strong>{displayValue}</strong><small className={`metric-${metric.tone}`}>{metric.delta}</small></div>;
  })}</section>;
}

function IntelRow({ item }: { item: IntelligenceItem }) {
  const fresh = isTodayNew(item.firstSeenAt);
  return (
    <Link className={`intel-row${fresh ? " record-is-new" : ""}`} to={intelligenceContentPath(item)}>
      {fresh && <NewCornerBadge />}
      <div className="intel-main"><div className="intel-title"><RiskBadge level={item.risk} /> <strong>{item.title}</strong></div><div className="intel-tags">{item.tags.slice(0, 3).map((tag) => <Tag key={tag}>{tag}</Tag>)}</div></div>
      <div className="intel-meta"><span>{item.organization}</span><time>{item.observedAt}</time></div>
      <ChevronRight size={17} aria-hidden="true" />
    </Link>
  );
}

export function PortalHome({ enabledModules }: { enabledModules: EdgePortalModule[] }) {
  const { dashboard, loading, error, reload } = usePortalDashboard();
  const [brandName, setBrandName] = useState("企业威胁情报中心");
  useEffect(() => { void portalApiFetch<{ name: string }>("/api/edge-admin/branding").then((branding) => setBrandName(branding.name || "企业威胁情报中心")).catch(() => undefined); }, []);
  const criticalItems = dashboard?.critical.slice(0, 5) ?? [];
  const latestItems = dashboard?.latest.slice(0, 5) ?? [];
  const vulnerabilitiesEnabled = enabledModules.includes("vulnerabilities");
  const visibleTodayModules = todayModules.filter((module) => enabledModules.includes(module.module));
  const todayTotal = dashboard ? Object.values(dashboard.todayNew ?? {}).reduce((sum, count) => sum + count, 0) : 0;
  return (
    <div className="portal-home">
      <HeroSearch brandName={brandName} vulnerabilitiesEnabled={vulnerabilitiesEnabled} />
      <div className="portal-container home-content">
        {loading ? <div className="skeleton-list" aria-label="正在加载态势数据">{Array.from({ length: 4 }).map((_, index) => <div className="skeleton-row" key={index} />)}</div> : error ? <Panel><EmptyState icon={<TriangleAlert size={34} />} title="态势数据加载失败" description={error} /><Button onClick={reload}><RefreshCw size={16} />重新加载</Button></Panel> : dashboard ? <>
        {dashboard.metrics.length ? <MetricStrip data={dashboard.metrics} /> : <EmptyState title="暂无核心指标" description="当前业务数据尚未形成可展示的聚合指标。" />}
        <section className="home-today-summary" aria-labelledby="home-today-title"><header><div><CalendarPlus size={18} /><span><strong id="home-today-title">今日新增</strong><small>首次进入平台的数据</small></span></div><em>+{todayTotal.toLocaleString("zh-CN")} 条</em></header><div>{visibleTodayModules.map((module) => <Link to={module.to} key={module.key}><span>{module.label}<small>今日新增</small></span><TodayCountBadge count={dashboard.todayNew?.[module.key] ?? 0} /><ChevronRight size={16} /></Link>)}</div></section>
        <section className="topic-grid" aria-label="重点专题">
          {topics.filter((topic) => enabledModules.includes(topic.module)).map(({ title, desc, icon: Icon, tone, to }) => <Link to={to} className={`topic-item topic-${tone}`} key={title}><span className="topic-icon"><Icon size={22} /></span><span><strong>{title}</strong><small>{desc}</small></span><ChevronRight size={17} /></Link>)}
        </section>
        <div className={vulnerabilitiesEnabled ? "two-column" : "analytics-grid analytics-grid-single"}>
          {vulnerabilitiesEnabled && <Panel title={<span className="section-title"><TriangleAlert size={17} /> 关键风险 <em>{dashboard.criticalTotal}</em></span>} action={<Link className="view-more" to="/portal/modules/vulnerabilities/asset-alerts">查看全部 <ChevronRight size={15} /></Link>}>{criticalItems.length ? criticalItems.map((item) => <IntelRow item={item} key={item.id} />) : <EmptyState title="暂无关键风险" description="当前没有严重或高危的资产漏洞告警。" />}</Panel>}
          <Panel title={<span className="section-title"><Database size={17} /> 最新情报 <em>{latestItems.length}</em></span>} action={<Link className="view-more" to="/portal/search?exclude_type=%E6%BC%8F%E6%B4%9E%E6%83%85%E6%8A%A5">查看全部 <ChevronRight size={15} /></Link>}>{latestItems.length ? latestItems.map((item) => <IntelRow item={item} key={item.id} />) : <EmptyState title={EMPTY_DATA_TITLE} description={EMPTY_DATA_DESCRIPTION} />}</Panel>
        </div>
        <div className="analytics-grid analytics-grid-single">
          <Panel title="近七日情报趋势">{dashboard.trendData.length ? <ThreatTrendChart data={dashboard.trendData} /> : <EmptyState title="暂无趋势数据" description="当前七日内没有情报记录。" />}</Panel>
        </div>
        </> : null}
      </div>
    </div>
  );
}
