import { useEffect, useState } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import { ArrowLeft, Box, CircleAlert, Globe2, Network, ShieldCheck } from "lucide-react";
import { type IntelligenceItem } from "@sentinel/shared";
import { EmptyState, Panel, RiskBadge, Tag } from "@/components/ui";

import { confidenceLabel, intelligenceDetailPath } from "../lib/intelligence";
import { portalApiFetch as apiFetch } from "../shared/api/portalApi";

export function IntelligenceDetail() {
  const { id = "" } = useParams();
  const [item, setItem] = useState<IntelligenceItem | null | undefined>(undefined);
  const [error, setError] = useState("");
  const [tab, setTab] = useState("摘要");
  useEffect(() => {
    let active = true;
    setItem(undefined);
    setError("");
    apiFetch<IntelligenceItem>(`/api/intelligence/${encodeURIComponent(id)}`)
      .then((data) => { if (active) setItem(data); })
      .catch((loadError) => { if (active) { setItem(null); setError(loadError instanceof Error ? loadError.message : "情报详情加载失败"); } });
    return () => { active = false; };
  }, [id]);
  if (item === undefined) return <div className="portal-container page-content"><div className="detail-loading" /></div>;
  if (!item) return <div className="portal-container page-content"><EmptyState title="情报详情加载失败" description={error || "该记录可能已撤回或超出当前数据权限。"} /></div>;
  if (item.type === "暗网情报") return <Navigate to={intelligenceDetailPath(item)} replace />;
  const tabs = ["摘要", "证据", "关联", "时间线"];
  return (
    <div className="portal-container page-content">
      <Link className="back-link" to="/portal/search"><ArrowLeft size={16} />返回查询</Link>
      <header className="detail-heading"><div className="detail-title"><RiskBadge level={item.risk} /><div><span>{item.id}</span><h1>{item.title}</h1></div></div><div className="detail-status"><span>可信度 <strong>{confidenceLabel(item.confidence)}</strong></span></div></header>
      <div className="detail-layout">
        <section className="detail-main panel">
          <div className="detail-tabs" role="tablist">{tabs.map((value) => <button role="tab" aria-selected={tab === value} className={tab === value ? "active" : ""} onClick={() => setTab(value)} key={value}>{value}</button>)}</div>
          <div className="detail-tab-content">
            {tab === "摘要" && <><h2>情报摘要</h2><p>{item.summary || "当前记录未提供摘要。"}</p><div className="summary-callout"><ShieldCheck size={20} /><div><strong>数据说明</strong><p>本页内容来自已入库业务记录；敏感字段按前台数据边界进行展示。</p></div></div><h2>关键标签</h2>{item.tags.length ? <div className="tag-list">{item.tags.map((tag) => <Tag key={tag}>{tag}</Tag>)}</div> : <EmptyState title="暂无标签" description="当前记录未提取出可展示标签。" />}</>}
            {tab === "证据" && <><h2>证据链</h2><div className="evidence-item"><Globe2 size={20} /><div><strong>来源定位</strong><code>{item.source || "未提供"}</code><span>首次发现：{item.observedAt || "未提供"}</span></div></div><div className="summary-callout"><CircleAlert size={20} /><div><strong>证据边界</strong><p>当前视图未提供原始证据哈希或附件。</p></div></div></>}
            {tab === "关联" && <><h2>关联实体</h2>{item.entities.length ? <div className="entity-grid">{item.entities.map((entity, index) => <div className="entity-node" key={entity}><span>{index === 0 ? <Box size={18} /> : <Network size={18} />}</span><strong>{entity}</strong><small>{index === 0 ? "主要实体" : "关联实体"}</small></div>)}</div> : <EmptyState title="暂无关联实体" description="当前记录未提取出可展示的关联实体。" />}</>}
            {tab === "时间线" && <><h2>事件时间线</h2><ol className="timeline"><li><time>{item.observedAt || "时间未提供"}</time><strong>情报首次发现</strong><span>来源：{item.source || "未提供"}</span></li></ol></>}
          </div>
        </section>
        <aside className="detail-aside">
          <Panel title="基本信息"><dl className="metadata"><div><dt>情报类型</dt><dd>{item.type}</dd></div><div><dt>关联组织</dt><dd>{item.organization}</dd></div><div><dt>来源</dt><dd>{item.source}</dd></div><div><dt>发现时间</dt><dd>{item.observedAt}</dd></div><div><dt>可信度</dt><dd>{confidenceLabel(item.confidence)}</dd></div></dl></Panel>
          <Panel title="数据边界"><div className="boundary-note"><CircleAlert size={18} /><p>敏感字段已脱敏。前台不提供原始秘密、凭据组合、数据修改或处置操作。</p></div></Panel>
        </aside>
      </div>
    </div>
  );
}
