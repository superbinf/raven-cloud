import { useEffect, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ChevronRight, FileSearch, Search, TriangleAlert } from "lucide-react";
import {
  type IntelligenceItem,
  type IntelligencePageResult,
  type IntelType,
} from "@sentinel/shared";
import { Button, EmptyState, Panel, RiskBadge, Tag } from "@/components/ui";
import type { EdgePortalModule } from "@sentinel/contracts";

import {
  confidenceLabel,
  intelligenceContentPath,
  intelligenceQueryPath,
} from "../lib/intelligence";
import { portalApiFetch as apiFetch } from "../shared/api/portalApi";
import { PageSizeSelect } from "../shared/PageSizeSelect";
import {
  ListViewControls,
  ListViewFrame,
  SortableResizableHeader,
  listViewGridStyle,
  sortListItems,
  useListViewPreferences,
} from "../shared/ListViewControls";

const searchListColumns = [
  ["风险与情报", 420],
  ["分类与来源", 260],
  ["关联对象", 190],
  ["发现时间", 150],
  ["操作", 42],
].map(([label, width], index) => ({
  id: `column-${index + 1}`,
  label: String(label),
  defaultWidth: Number(width),
  minWidth: index === 4 ? 42 : 96,
  sortable: index !== 4,
}));

function observedTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return { date: value || "--", time: "" };
  return {
    date: date.toLocaleDateString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }),
    time: date.toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }),
  };
}

function sourceLabel(value: string) {
  try {
    return new URL(value).hostname.replace(/^www\./, "");
  } catch {
    return value;
  }
}

function SearchResultRow({ item }: { item: IntelligenceItem }) {
  const displayedTime = observedTime(item.observedAt);
  const source = item.source || "未知来源";
  const organization = item.organization || "未关联监测对象";
  return (
    <Link
      to={intelligenceContentPath(item)}
      className="result-table-row"
      role="row"
      aria-label={`${item.title}，${item.subtype}，${organization}`}
    >
      <div className="result-primary" role="cell">
        <RiskBadge level={item.risk} />
        <span>
          <strong>{item.title}</strong>
          <small className="result-record-meta">
            <code>{item.id}</code>
            <span>可信度 {confidenceLabel(item.confidence)}</span>
          </small>
        </span>
      </div>
      <div className="result-source" role="cell">
        <span className="result-classification">
          <Tag
            tone={
              item.type === "暗网情报"
                ? "pink"
                : item.type === "暴露面"
                  ? "green"
                  : "cyan"
            }
          >
            {item.subtype}
          </Tag>
          {item.type !== item.subtype ? <em>{item.type}</em> : null}
        </span>
        <small title={source}>{sourceLabel(source)}</small>
      </div>
      <span className="result-organization" role="cell" title={organization}>
        {organization}
      </span>
      <time
        className="result-time"
        role="cell"
        dateTime={item.observedAt}
        title={item.observedAt}
      >
        <span>{displayedTime.date}</span>
        {displayedTime.time ? <small>{displayedTime.time}</small> : null}
      </time>
      <ChevronRight size={18} aria-hidden="true" />
    </Link>
  );
}

const intelligenceTypes: Array<{ value: IntelType; module: EdgePortalModule }> = [
  { value: "暗网情报", module: "dark-web" },
  { value: "敏感泄露", module: "sensitive" },
  { value: "仿冒网站", module: "exposure" },
  { value: "暴露面", module: "exposure" },
  { value: "漏洞情报", module: "vulnerabilities" }
];

const intelligenceSubtypes: Array<{ value: string; module: EdgePortalModule }> = [
  { value: "凭据泄露", module: "dark-web" },
  { value: "暗网情报", module: "dark-web" },
  { value: "账号口令", module: "sensitive" },
  { value: "源码泄露", module: "sensitive" },
  { value: "文档泄露", module: "sensitive" },
  { value: "资产监测", module: "exposure" },
  { value: "仿冒网站", module: "exposure" },
  { value: "漏洞情报", module: "vulnerabilities" }
];

export function SearchPage({ enabledModules }: { enabledModules: EdgePortalModule[] }) {
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useState(params.get("q") ?? "");
  const [type, setType] = useState(params.get("type") ?? "全部");
  const [risk, setRisk] = useState(params.get("risk") ?? "全部");
  const [subtype, setSubtype] = useState(params.get("subtype") ?? "全部");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [result, setResult] = useState<IntelligencePageResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const searchKey = params.toString();
  const listView = useListViewPreferences(
    "intelligence-search",
    searchListColumns,
  );

  useEffect(() => {
    setQuery(params.get("q") ?? "");
    setType(params.get("type") ?? "全部");
    setRisk(params.get("risk") ?? "全部");
    setSubtype(params.get("subtype") ?? "全部");
    setPage(1);
  }, [searchKey]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    const selectedType = params.get("type") || "";
    const selectedSubtype = params.get("subtype") || "";
    apiFetch<IntelligencePageResult>(
      intelligenceQueryPath({
        page,
        pageSize,
        query: params.get("q")?.trim() || undefined,
        type: selectedType || undefined,
        excludeType:
          params.get("exclude_type") ||
          (!selectedType && !selectedSubtype && !params.get("risk")
            ? "暴露面"
            : undefined),
        risk: params.get("risk") || undefined,
        subtype: selectedSubtype || undefined,
      }),
    )
      .then((data) => {
        if (active) setResult(data);
      })
      .catch((loadError) => {
        if (active) {
          setResult(null);
          setError(
            loadError instanceof Error ? loadError.message : "情报查询失败",
          );
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [page, pageSize, searchKey]);

  const apply = (event: FormEvent) => {
    event.preventDefault();
    const next: Record<string, string> = {};
    if (query.trim()) next.q = query.trim();
    if (type !== "全部") next.type = type;
    if (risk !== "全部") next.risk = risk;
    if (subtype !== "全部") next.subtype = subtype;
    setParams(next);
  };
  const sortedItems = sortListItems(result?.data || [], listView.sort, {
    "column-1": (item) => `${item.risk} ${item.title}`,
    "column-2": (item) => `${item.type} ${item.subtype} ${item.source}`,
    "column-3": (item) => item.organization,
    "column-4": (item) => item.observedAt,
  });

  return (
    <div className="portal-container page-content">
      <header className="page-heading">
        <div>
          <span className="eyebrow">INTELLIGENCE SEARCH</span>
          <h1>统一情报查询</h1>
        </div>
        <div className="result-count">
          <strong>{result?.total ?? "--"}</strong>
          <span>条结果</span>
        </div>
      </header>
      <form className="filter-bar" onSubmit={apply}>
        <div className="filter-search">
          <Search size={18} />
          <label className="sr-only" htmlFor="search-query">
            关键词
          </label>
          <input
            id="search-query"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索标题、实体、来源或标签"
          />
        </div>
        <select
          aria-label="情报类型"
          value={type}
          onChange={(event) => setType(event.target.value)}
        >
          <option value="全部">全部情报类型（不含暴露面）</option>
          {intelligenceTypes.filter((item) => enabledModules.includes(item.module)).map(({ value }) => (
            <option key={value}>{value}</option>
          ))}
        </select>
        <select
          aria-label="业务子类型"
          value={subtype}
          onChange={(event) => setSubtype(event.target.value)}
        >
          <option value="全部">全部业务子类型</option>
          {intelligenceSubtypes.filter((item) => enabledModules.includes(item.module)).map(({ value }) => (
            <option key={value}>{value}</option>
          ))}
        </select>
        <select
          aria-label="风险等级"
          value={risk}
          onChange={(event) => setRisk(event.target.value)}
        >
          <option value="全部">全部风险等级</option>
          <option value="critical,high">严重与高危</option>
          <option value="critical">严重</option>
          <option value="high">高危</option>
          <option value="medium">中危</option>
          <option value="low">低危</option>
        </select>
        <Button type="submit">
          <Search size={17} />
          应用筛选
        </Button>
        <ListViewControls
          columns={searchListColumns}
          hidden={listView.hidden}
          onToggleColumn={listView.toggleColumn}
          onReset={listView.reset}
        />
      </form>
      <Panel className="results-panel">
        {loading ? (
          <div className="skeleton-list" aria-label="正在加载">
            {Array.from({ length: 6 }).map((_, index) => (
              <div className="skeleton-row" key={index} />
            ))}
          </div>
        ) : error ? (
          <EmptyState
            icon={<TriangleAlert size={34} />}
            title="情报查询失败"
            description={error}
          />
        ) : result?.data.length ? (
          <ListViewFrame
            hidden={listView.hidden}
            className="search-list-frame"
          >
            <div
              className="result-table"
              style={listViewGridStyle(searchListColumns, listView.widths)}
              role="table"
              aria-label="情报检索结果"
            >
              <div className="result-table-head" role="row">
                {searchListColumns.map((column) => (
                  <SortableResizableHeader
                    key={column.id}
                    column={column}
                    sort={listView.sort}
                    width={listView.columnWidth(column.id)}
                    onSort={listView.toggleSort}
                    onResize={listView.setColumnWidth}
                  />
                ))}
              </div>
              {sortedItems.map((item) => (
                <SearchResultRow item={item} key={item.id} />
              ))}
            </div>
          </ListViewFrame>
        ) : (
          <EmptyState
            icon={<FileSearch size={34} />}
            title="没有匹配的情报"
            description="调整关键词或筛选条件后重试。"
          />
        )}
        {result ? (
          <footer className="credential-pagination">
            <span>
              第 {result.page} /{" "}
              {Math.max(1, Math.ceil(result.total / result.pageSize))} 页，共{" "}
              {result.total} 条记录
            </span>
            <div>
              <PageSizeSelect value={pageSize} disabled={loading} onChange={(value) => { setPageSize(value); setPage(1); }} />
              <Button
                variant="ghost"
                disabled={page <= 1 || loading}
                onClick={() => setPage((value) => Math.max(1, value - 1))}
              >
                上一页
              </Button>
              <Button
                variant="secondary"
                disabled={
                  page >= Math.max(1, Math.ceil(result.total / result.pageSize)) || loading
                }
                onClick={() => setPage((value) => value + 1)}
              >
                下一页
              </Button>
            </div>
          </footer>
        ) : null}
      </Panel>
    </div>
  );
}
