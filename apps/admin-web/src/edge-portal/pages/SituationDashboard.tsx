import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  Activity,
  ChevronRight,
  Crosshair,
  Database,
  Fullscreen,
  ImageIcon,
  Gauge,
  Globe2,
  Radio,
  RefreshCw,
  ScanSearch,
  ScanLine,
  Server,
  ShieldCheck,
  TriangleAlert,
  Waypoints,
  X
} from "lucide-react";

import { Button, EmptyState, IconButton } from "@sentinel/ui";
import { ChinaThreatMap, ThreatTrendChart } from "../charts";

import { usePortalDashboard } from "../hooks/usePortalDashboard";
import { intelligenceContentPath } from "../lib/intelligence";
import { EdgeBrandLogo, useEdgeBranding } from "../shared/edgeBranding";

const metricIcons = [Database, TriangleAlert, Crosshair, Activity];

function numberValue(value: string | undefined) {
  const parsed = Number(String(value || "0").replace(/[^\d.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function compactDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
}

function ExposureIcon({ label }: { label: string }) {
  if (label === "Web资产") return <Globe2 size={13} />;
  if (label === "端口") return <Server size={13} />;
  if (label === "DNS") return <Waypoints size={13} />;
  if (label === "指纹列表") return <ScanSearch size={13} />;
  if (label === "图标信息") return <ImageIcon size={13} />;
  if (label === "敏感信息") return <TriangleAlert size={13} />;
  return <Database size={13} />;
}

function SituationPanel({ title, code, icon, action, className = "", children }: { title: string; code: string; icon: ReactNode; action?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <section className={`situation-panel ${className}`}>
      <header className="situation-panel-header">
        <div>{icon}<span><small>{code}</small><strong>{title}</strong></span></div>
        {action ?? <i aria-hidden="true" />}
      </header>
      <div className="situation-panel-body">{children}</div>
    </section>
  );
}

export function SituationDashboard() {
  const [now, setNow] = useState(() => new Date());
  const branding = useEdgeBranding();
  const { dashboard, loading, error, reload } = usePortalDashboard();
  useEffect(() => { const timer = window.setInterval(() => setNow(new Date()), 1000); return () => window.clearInterval(timer); }, []);
  const enterFullscreen = async () => { if (!document.fullscreenElement) await document.documentElement.requestFullscreen(); else await document.exitFullscreen(); };

  const summary = useMemo(() => {
    const metrics = dashboard?.metrics ?? [];
    const find = (keyword: string) => numberValue(metrics.find((metric) => metric.label.includes(keyword))?.value);
    const riskCounts = dashboard?.riskCounts;
    return {
      total: riskCounts ? Object.values(riskCounts).reduce((sum, value) => sum + value, 0) : find("总量"),
      critical: riskCounts?.critical ?? find("严重"),
      high: riskCounts?.high ?? (find("高风险") || find("高危")),
      recent: find("新增"),
      today: Object.values(dashboard?.todayNew ?? {}).reduce((sum, value) => sum + value, 0)
    };
  }, [dashboard]);

  const criticalEventItems = dashboard?.critical.filter((item) => !["暴露面", "仿冒网站"].includes(item.type)) ?? [];
  const latestEventItems = dashboard?.latest.filter((item) => !["暴露面", "仿冒网站"].includes(item.type)) ?? [];
  const eventItems = (criticalEventItems.length ? criticalEventItems : latestEventItems).slice(0, 6);
  const regionDistribution = dashboard?.regionDistribution ?? [];
  const alertVisualItems = eventItems.length
    ? Array.from({ length: Math.max(2, Math.ceil(12 / eventItems.length)) }, (_, repetition) =>
        eventItems.map((item, sourceIndex) => ({ item, repetition, sourceIndex })))
      .flat()
    : [];
  const exposureMax = Math.max(...(dashboard?.exposureData.map((item) => item.value) ?? [1]), 1);
  const sourceMax = Math.max(...(dashboard?.sourceDistribution.map((item) => item.value) ?? [1]), 1);
  const safeTotal = Math.max(summary.total, summary.critical + summary.high, 1);
  const criticalRingEnd = summary.critical / safeTotal * 100;
  const highRingEnd = (summary.critical + summary.high) / safeTotal * 100;
  const riskRingStyle = {
    "--risk-critical-end": `${criticalRingEnd}%`,
    "--risk-high-end": `${highRingEnd}%`
  } as CSSProperties;
  const riskRows = [
    { label: "严重风险", value: summary.critical, tone: "critical" },
    { label: "高危风险", value: summary.high, tone: "high" },
    { label: "持续监测", value: Math.max(summary.total - summary.critical - summary.high, 0), tone: "monitor" }
  ];

  return (
    <div className="situation-screen">
      <header className="situation-header">
        <div className="situation-header-brand">
          <Link to="/portal" className="situation-brand-lockup" aria-label={`${branding.name}首页`}>
            <EdgeBrandLogo branding={branding} className="situation-brand-logo" fallbackClassName="situation-brand-fallback" />
          </Link>
          <span className="situation-online"><i />引擎在线</span>
        </div>
        <div className="situation-title">
          <span>SENTINEL SECURITY OPERATIONS</span>
          <h1>全域威胁感知中心</h1>
        </div>
        <div className="situation-header-tools">
          <div className="situation-clock"><strong>{now.toLocaleTimeString("zh-CN", { hour12: false })}</strong><span>{now.toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" })}</span></div>
          <IconButton label="切换全屏" onClick={enterFullscreen}><Fullscreen size={18} /></IconButton>
          <Link className="screen-exit" to="/portal" aria-label="退出大屏"><X size={18} /><span>退出大屏</span></Link>
        </div>
      </header>

      <main className="situation-body">
        {loading ? (
          <div className="situation-loading" aria-label="正在加载态势大屏数据">{Array.from({ length: 10 }).map((_, index) => <i key={index} />)}</div>
        ) : error ? (
          <div className="situation-error"><EmptyState icon={<TriangleAlert size={34} />} title="态势数据加载失败" description={error} /><Button onClick={reload}><RefreshCw size={16} />重新加载</Button></div>
        ) : dashboard ? <>
          <section className="situation-metrics" aria-label="核心监测指标">
            {dashboard.metrics.slice(0, 4).map((metric, index) => {
              const Icon = metricIcons[index] ?? Activity;
              return <article data-tone={metric.tone} key={metric.label}><span className="metric-icon"><Icon size={19} /></span><div><small>{metric.label}</small><strong>{metric.value}</strong></div><em><Radio size={11} />{metric.delta}</em></article>;
            })}
          </section>

          <div className="situation-command-grid">
            <div className="situation-left-rail">
              <SituationPanel title="风险态势" code="RISK POSTURE" icon={<Gauge size={17} />}>
                <div className="risk-score">
                  <div className="risk-score-ring" role="img" aria-label={`风险构成：严重 ${summary.critical} 条，高危 ${summary.high} 条，其他监测 ${Math.max(summary.total - summary.critical - summary.high, 0)} 条`} style={riskRingStyle}><span><strong>{summary.critical + summary.high}</strong><small>高危事件</small></span></div>
                  <div><strong>{summary.critical > 0 ? "风险升高" : summary.high > 0 ? "持续关注" : "态势平稳"}</strong><small>综合风险等级</small><em><i />实时计算</em></div>
                </div>
                <div className="risk-level-list">{riskRows.map((row) => <div key={row.label} data-tone={row.tone}><span>{row.label}</span><i><b style={{ width: `${Math.max(row.value ? 6 : 0, Math.min(100, row.value / safeTotal * 100))}%` }} /></i><strong>{row.value.toLocaleString("zh-CN")}</strong></div>)}</div>
              </SituationPanel>

              <SituationPanel title="情报来源" code="INTELLIGENCE SOURCES" icon={<Database size={17} />}>
                <div className="source-rank">{dashboard.sourceDistribution.length ? dashboard.sourceDistribution.slice(0, 5).map((item, index) => <div key={item.name}><span>{String(index + 1).padStart(2, "0")}</span><div><strong>{item.name}</strong><i><b style={{ width: `${item.value / sourceMax * 100}%` }} /></i></div><em>{item.value.toLocaleString("zh-CN")}</em></div>) : <span className="situation-empty-inline">暂无来源数据</span>}</div>
              </SituationPanel>
            </div>

            <section className="situation-map" aria-labelledby="situation-map-title">
              <div className="map-heading"><span><Globe2 size={16} />CHINA CYBERSPACE</span><h2 id="situation-map-title">重点区域风险监测</h2><small><i />{regionDistribution.length ? "REGION MONITORING ACTIVE" : "NO REGIONAL DATA"}</small></div>
              {regionDistribution.length > 0 && <><div className="map-orbit map-orbit-one" aria-hidden="true" /><div className="map-orbit map-orbit-two" aria-hidden="true" /></>}
              <ChinaThreatMap data={regionDistribution} />
              {regionDistribution.length > 0 && <div className="map-legend"><span><i className="legend-low" />低</span><span><i className="legend-mid" />中</span><span><i className="legend-high" />高</span></div>}
              <div className="map-stats">
                <div><span>今日捕获</span><strong>{summary.today.toLocaleString("zh-CN")}</strong></div>
                <div><span>监测节点</span><strong>{regionDistribution.length.toLocaleString("zh-CN")}</strong></div>
                <div><span>近期待研判</span><strong>{summary.recent.toLocaleString("zh-CN")}</strong></div>
              </div>
            </section>

            <div className="situation-right-rail">
              <SituationPanel title="实时威胁告警" code="LIVE ALERT STREAM" icon={<ScanLine size={17} />} action={<span className="alert-auto-status"><Radio size={9} />{eventItems.length ? "持续滚动" : "实时更新"}</span>} className="situation-alert-panel">
                <div className="situation-alerts">
                  {eventItems.length ? <div className="alert-scroll-track" style={{ "--alert-loop-duration": `${Math.max(28, alertVisualItems.length * 2.7)}s` } as CSSProperties}>
                    {[0, 1].map((groupIndex) => <div className="alert-scroll-group" aria-hidden={groupIndex === 1 || undefined} key={groupIndex}>
                      {alertVisualItems.map(({ item, repetition, sourceIndex }, index) => {
                        const isAccessible = groupIndex === 0 && repetition === 0;
                        return <Link aria-hidden={!isAccessible || undefined} aria-label={isAccessible ? `查看${item.title}详情` : undefined} tabIndex={isAccessible ? undefined : -1} to={intelligenceContentPath(item)} key={`${groupIndex}-${repetition}-${item.id}-${index}`}><span className={`alert-severity severity-${item.risk}`}>{item.risk === "critical" ? "严重" : item.risk === "high" ? "高危" : "关注"}</span><div><strong>{item.title}</strong><small><time>{compactDate(item.observedAt)}</time><b>{item.type}</b></small></div><em>{String(sourceIndex + 1).padStart(2, "0")}</em></Link>;
                      })}
                    </div>)}
                  </div> : <div className="situation-empty-alert"><ShieldCheck size={30} /><strong>当前无高危告警</strong><span>监测引擎运行正常</span></div>}
                </div>
              </SituationPanel>
            </div>
          </div>

          <div className="situation-bottom-grid">
            <SituationPanel title="威胁活动趋势" code="7 DAY ACTIVITY TREND" icon={<Activity size={17} />} className="situation-trend-panel">
              {dashboard.trendData.length ? <ThreatTrendChart data={dashboard.trendData} compact /> : <span className="situation-empty-inline">暂无趋势数据</span>}
            </SituationPanel>
            <SituationPanel title="暴露面监测" code="EXPOSURE SURFACE" icon={<Crosshair size={17} />}>
              <div className="exposure-list">{dashboard.exposureData.length ? dashboard.exposureData.map((item) => <Link to={item.path || "/portal/modules/exposure/assets"} aria-label={`查看${item.label}，共${item.value.toLocaleString("zh-CN")}条`} key={item.label}><span className="exposure-icon"><ExposureIcon label={item.label} /></span><span>{item.label}</span><strong>{item.value.toLocaleString("zh-CN")}</strong><ChevronRight size={11} /><i><b style={{ width: `${item.value / exposureMax * 100}%` }} /></i></Link>) : <span className="situation-empty-inline">暂无暴露面数据</span>}</div>
            </SituationPanel>
          </div>
        </> : null}
      </main>
    </div>
  );
}
