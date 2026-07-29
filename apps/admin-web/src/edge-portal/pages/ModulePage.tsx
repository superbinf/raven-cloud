import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  Activity,
  Building2,
  ChevronRight,
  CircleAlert,
  Download,
  FileSearch,
  Radar,
  RefreshCw,
  Search,
  TriangleAlert,
  X,
} from "lucide-react";
import {
  type IntelligenceItem,
  type IntelligencePageResult,
  type RiskLevel,
} from "@sentinel/shared";
import { Button, EmptyState, Panel, RiskBadge, Tag, cn } from "@sentinel/ui";

import { type ModuleConfig } from "../config/modules";

import {
  confidenceLabel,
  intelligenceDetailPath,
  intelligenceQueryPath,
} from "../lib/intelligence";
import { portalApiFetch as apiFetch } from "../shared/api/portalApi";
import { NewCornerBadge } from "../shared/TodayNewBar";
import { ModuleHeader } from "../shared/ModuleHeader";
import {
  ListViewControls,
  ListViewFrame,
  SortableResizableHeader,
  listViewGridStyle,
  sortListItems,
  useListViewPreferences,
} from "../shared/ListViewControls";
import { SequenceCell, SequenceHeader } from "../shared/SequenceCell";
import { PageSizeSelect } from "../shared/PageSizeSelect";
import { isTodayNew, todayStartIso } from "../lib/today";
import {
  downloadCsv,
  fetchAllPages,
  type CsvColumn,
} from "../shared/exportCsv";

export function ModulePage({ config }: { config: ModuleConfig }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const todayOnly = searchParams.get("today") === "1";
  const requestedQuery = searchParams.get("query") || "";
  const since = todayStartIso();
  const [risk, setRisk] = useState<RiskLevel | "全部">("全部");
  const [result, setResult] = useState<IntelligencePageResult | null>(null);
  const [riskCounts, setRiskCounts] = useState<Record<
    RiskLevel,
    number
  > | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [query, setQuery] = useState(requestedQuery);
  const [queryDraft, setQueryDraft] = useState(requestedQuery);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState("");
  const Icon = config.icon;
  const isDarkWebIntelligence = config.subtype === "暗网情报";
  const listColumns = useMemo(
    () =>
      (isDarkWebIntelligence
        ? [
            { label: "风险 / 情报", width: 320 },
            { label: "类型", width: 150 },
            { label: "来源", width: 180 },
            { label: "发现时间", width: 160 },
            { label: "操作", width: 96, sortable: false },
          ]
        : [
            { label: "风险 / 线索", width: 360 },
            { label: "核心实体", width: 210 },
            { label: "来源", width: 170 },
            { label: "发现时间", width: 150 },
            { label: "操作", width: 42, sortable: false },
          ]
      ).map((column, index) => ({
        id: `column-${index + 1}`,
        label: column.label,
        defaultWidth: column.width,
        minWidth: index === 4 ? 42 : 96,
        sortable: column.sortable,
      })),
    [isDarkWebIntelligence],
  );
  const listView = useListViewPreferences(
    `module-${config.subtype}`,
    listColumns,
  );
  const riskLabels: Record<RiskLevel, string> = {
    critical: "严重",
    high: "高危",
    medium: "中危",
    low: "低危",
    info: "信息",
  };
  const displayedRisks: RiskLevel[] = ["critical", "high", "medium", "low"];

  useEffect(() => {
    setPage(1);
    setQuery(requestedQuery);
    setQueryDraft(requestedQuery);
  }, [config.subtype, config.type, requestedQuery]);
  useEffect(() => {
    setSelectedIds(new Set());
  }, [config.subtype, config.type, page, query, risk, todayOnly]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    const baseFilters = {
      type: config.type,
      subtype: config.subtype === "暗网情报" ? undefined : config.subtype,
    };
    apiFetch<IntelligencePageResult>(
      intelligenceQueryPath({
        ...baseFilters,
        page,
        pageSize,
        query,
        risk: risk === "全部" ? undefined : risk,
        includeRiskCounts: true,
        since,
        todayOnly,
      }),
    )
      .then((pageResult) => {
        if (!active) return;
        setResult(pageResult);
        setRiskCounts(
          pageResult.riskCounts ??
            displayedRisks.reduce<Record<RiskLevel, number>>(
              (counts, level) => {
                counts[level] = pageResult.data.filter(
                  (item) => item.risk === level,
                ).length;
                return counts;
              },
              { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
            ),
        );
      })
      .catch((loadError) => {
        if (!active) return;
        setResult(null);
        setRiskCounts(null);
        setError(
          loadError instanceof Error
            ? loadError.message
            : `${config.title}数据加载失败`,
        );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [config.subtype, config.type, page, pageSize, query, reloadKey, risk, since, todayOnly]);

  const toggleToday = () => {
    const next = new URLSearchParams(searchParams);
    if (todayOnly) next.delete("today");
    else next.set("today", "1");
    setPage(1);
    setRisk("全部");
    setQuery("");
    setQueryDraft("");
    setSearchParams(next, { replace: true });
  };
  const applySearch = (event: FormEvent) => {
    event.preventDefault();
    setPage(1);
    setQuery(queryDraft.trim());
  };

  const metricsForModule =
    result && riskCounts
      ? [
          {
            label: todayOnly ? "今日新增" : "累计记录",
            value: (result.allTotal ?? result.total).toLocaleString("zh-CN"),
            meta: todayOnly ? "今日首次进入平台" : "全部分类记录",
            tone: "info" as const,
            filter: "全部" as const,
          },
          {
            label: "严重风险",
            value: riskCounts.critical.toLocaleString("zh-CN"),
            meta: "风险等级为严重",
            tone: "critical" as const,
            filter: "critical" as const,
          },
          {
            label: "高危风险",
            value: riskCounts.high.toLocaleString("zh-CN"),
            meta: "风险等级为高危",
            tone: "high" as const,
            filter: "high" as const,
          },
          {
            label: "中危风险",
            value: riskCounts.medium.toLocaleString("zh-CN"),
            meta: "风险等级为中危",
            tone: "medium" as const,
            filter: "medium" as const,
          },
          {
            label: "低危风险",
            value: riskCounts.low.toLocaleString("zh-CN"),
            meta: "风险等级为低危",
            tone: "low" as const,
            filter: "low" as const,
          },
        ]
      : [];
  const maxRiskCount = riskCounts
    ? Math.max(...displayedRisks.map((level) => riskCounts[level]), 1)
    : 1;
  const advancedSearchParams = new URLSearchParams({ type: config.type });
  if (config.subtype !== "暗网情报")
    advancedSearchParams.set("subtype", config.subtype);
  const selectedCount =
    result?.data.filter((item) => selectedIds.has(item.id)).length ?? 0;
  const currentPageAllSelected =
    Boolean(result?.data.length) &&
    result!.data.every((item) => selectedIds.has(item.id));
  const exportColumns: Array<CsvColumn<IntelligenceItem>> = [
    { header: "ID", value: (item) => item.id },
    { header: "标题", value: (item) => item.title },
    { header: "摘要", value: (item) => item.summary },
    { header: "类型", value: (item) => item.type },
    { header: "子类型", value: (item) => item.subtype },
    { header: "风险", value: (item) => riskLabels[item.risk] || item.risk },
    { header: "来源", value: (item) => item.source },
    { header: "组织", value: (item) => item.organization },
    { header: "发现时间", value: (item) => item.observedAt },
    { header: "首次入库", value: (item) => item.firstSeenAt || "" },
    { header: "可信度", value: (item) => confidenceLabel(item.confidence) },
    { header: "标签", value: (item) => item.tags },
    { header: "实体", value: (item) => item.entities },
  ];
  const exportModuleRows = (
    rows: IntelligenceItem[],
    scope: "selected" | "all",
  ) => {
    downloadCsv(
      `${config.title}-${scope === "selected" ? "选中" : "全部"}-${new Date().toISOString().slice(0, 10)}.csv`,
      exportColumns,
      rows,
    );
  };
  const exportSelected = () => {
    const rows = result?.data.filter((item) => selectedIds.has(item.id)) || [];
    if (!rows.length) return;
    exportModuleRows(rows, "selected");
  };
  const exportAll = async () => {
    setExporting(true);
    setExportError("");
    try {
      const baseFilters = {
        type: config.type,
        subtype: config.subtype === "暗网情报" ? undefined : config.subtype,
        query,
        risk: risk === "全部" ? undefined : risk,
        since,
        todayOnly,
      };
      const rows = await fetchAllPages<IntelligenceItem>(
        (exportPage, exportPageSize) =>
          apiFetch<IntelligencePageResult>(
            intelligenceQueryPath({
              ...baseFilters,
              page: exportPage,
              pageSize: exportPageSize,
            }),
          ),
      );
      if (!rows.length) throw new Error("当前筛选条件下没有可导出的记录");
      exportModuleRows(rows, "all");
    } catch (exportReason) {
      setExportError(
        exportReason instanceof Error ? exportReason.message : "导出失败",
      );
    } finally {
      setExporting(false);
    }
  };
  const toggleSelected = (id: string) =>
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleCurrentPage = () =>
    setSelectedIds((current) => {
      const next = new Set(current);
      if (currentPageAllSelected)
        result?.data.forEach((item) => next.delete(item.id));
      else result?.data.forEach((item) => next.add(item.id));
      return next;
    });
  const sortedItems = sortListItems(result?.data || [], listView.sort, {
    "column-1": (item) => `${item.risk} ${item.title}`,
    "column-2": (item) =>
      isDarkWebIntelligence
        ? item.intelTags?.length
          ? item.intelTags
          : item.tags
        : item.entities,
    "column-3": (item) => item.source,
    "column-4": (item) => item.observedAt,
  });

  return (
    <div
      className={cn(
        "portal-container page-content module-page",
        `module-${config.tone}`,
      )}
    >
      <ModuleHeader
        icon={Icon}
        eyebrow={config.eyebrow}
        title={config.title}
        todayCount={result?.todayNewCount ?? 0}
        todayActive={todayOnly}
        onToggleToday={toggleToday}
        todayLoading={loading}
        todayLabel={`${config.title}今日新增`}
        action={
          <Link
            className="module-search-link"
            to={`/portal/search?${advancedSearchParams.toString()}`}
          >
            <Search size={16} />
            高级查询
            <ChevronRight size={15} />
          </Link>
        }
      />

      {loading ? (
        <div
          className="skeleton-list"
          aria-label={`正在加载${config.title}数据`}
        >
          {Array.from({ length: 5 }).map((_, index) => (
            <div className="skeleton-row" key={index} />
          ))}
        </div>
      ) : error ? (
        <Panel>
          <EmptyState
            icon={<TriangleAlert size={34} />}
            title={`${config.title}数据加载失败`}
            description={error}
          />
          <Button onClick={() => setReloadKey((value) => value + 1)}>
            <RefreshCw size={16} />
            重新加载
          </Button>
        </Panel>
      ) : result && riskCounts ? (
        <>
          <section
            className="module-kpi-grid module-kpi-grid-five"
            aria-label={`${config.title}核心指标`}
          >
            {metricsForModule.map((metric) => (
              <button
                type="button"
                className="module-kpi"
                aria-pressed={risk === metric.filter}
                onClick={() => {
                  setRisk(metric.filter);
                  setPage(1);
                }}
                key={metric.label}
              >
                <span>{metric.label}</span>
                <strong>{metric.value}</strong>
                <small className={`metric-${metric.tone}`}>{metric.meta}</small>
              </button>
            ))}
          </section>

          <div className="module-overview-grid">
            <Panel
              title={
                <span className="section-title">
                  <Activity size={17} /> {config.signalTitle}
                </span>
              }
            >
              <div className="module-signal">
                <p>{config.signalDescription}</p>
                <dl>
                  {config.fields.map((field) => (
                    <div key={field.label}>
                      <dt>{field.label}</dt>
                      <dd>{field.value}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            </Panel>
            <Panel
              title={
                <span className="section-title">
                  <Radar size={17} /> 监测维度
                </span>
              }
            >
              <div className="module-dimensions">
                {config.dimensions.map((dimension, index) => (
                  <div key={dimension}>
                    <span>{String(index + 1).padStart(2, "0")}</span>
                    <strong>{dimension}</strong>
                    <small>{index % 2 === 0 ? "持续监测" : "实时关联"}</small>
                  </div>
                ))}
              </div>
            </Panel>
            <Panel
              title={
                <span className="section-title">
                  <Building2 size={17} /> 风险分布
                </span>
              }
            >
              <div className="module-risk-summary">
                {displayedRisks.map((level) => (
                  <div key={level}>
                    <span>{riskLabels[level]}</span>
                    <div>
                      <i
                        className={`risk-fill risk-fill-${level}`}
                        style={{
                          width: `${Math.round((riskCounts[level] / maxRiskCount) * 100)}%`,
                        }}
                      />
                    </div>
                    <strong>{riskCounts[level]}</strong>
                  </div>
                ))}
                <p>
                  <CircleAlert size={15} />
                  当前分布基于已入库并可在前台读取的真实记录。
                </p>
              </div>
            </Panel>
          </div>

          <Panel className="module-records">
            <div className="data-command-bar module-records-toolbar">
              <form className="data-command-search" onSubmit={applySearch}>
                <label className="data-search-field">
                  <span className="sr-only">搜索{config.title}记录</span>
                  <Search size={18} aria-hidden="true" />
                  <input
                    type="search"
                    value={queryDraft}
                    onChange={(event) => setQueryDraft(event.target.value)}
                    placeholder="搜索标题、实体、来源或标签"
                    autoComplete="off"
                  />
                  {queryDraft && (
                    <button
                      className="data-search-clear"
                      type="button"
                      onClick={() => {
                        setQueryDraft("");
                        if (query) {
                          setQuery("");
                          setPage(1);
                        }
                      }}
                      aria-label="清空搜索"
                      title="清空搜索"
                    >
                      <X size={16} aria-hidden="true" />
                    </button>
                  )}
                </label>
                <Button type="submit" variant="secondary">
                  <Search size={15} />
                  搜索
                </Button>
              </form>
              <div className="export-action-group">
                <Button
                  className="data-export-button"
                  variant="ghost"
                  disabled={!selectedCount}
                  onClick={exportSelected}
                >
                  <Download size={15} />
                  导出选中{selectedCount ? ` ${selectedCount}` : ""}
                </Button>
                <Button
                  className="data-export-button"
                  variant="secondary"
                  disabled={exporting || !result.total}
                  onClick={() => void exportAll()}
                  title={exportError || "导出当前筛选范围内全部记录"}
                >
                  <Download size={15} />
                  {exporting ? "导出中..." : "导出全部"}
                </Button>
                <ListViewControls
                  columns={listColumns}
                  hidden={listView.hidden}
                  onToggleColumn={listView.toggleColumn}
                  onReset={listView.reset}
                />
              </div>
            </div>
            {result.data.length ? (
              <ListViewFrame
                hidden={listView.hidden}
                className="module-list-frame"
              >
                <div
                  className={cn(
                    "module-record-list module-record-list-selectable",
                    isDarkWebIntelligence && "module-record-list-darkweb",
                  )}
                  style={listViewGridStyle(listColumns, listView.widths)}
                  role="table"
                  aria-label={`${config.title}记录`}
                >
                  {isDarkWebIntelligence ? (
                    <div className="module-record-head" role="row">
                      <SequenceHeader
                        selection={
                          <input
                            className="selection-checkbox"
                            type="checkbox"
                            checked={currentPageAllSelected}
                            onChange={toggleCurrentPage}
                            aria-label="选择当前页暗网情报"
                          />
                        }
                      />
                      {listColumns.map((column) => (
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
                  ) : (
                    <div className="module-record-head" role="row">
                      <SequenceHeader
                        selection={
                          <input
                            className="selection-checkbox"
                            type="checkbox"
                            checked={currentPageAllSelected}
                            onChange={toggleCurrentPage}
                            aria-label="选择当前页记录"
                          />
                        }
                      />
                      {listColumns.map((column) => (
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
                  )}
                  {sortedItems.map((item, index) => (
                    <Link
                      className={cn(
                        "module-record-row",
                        isDarkWebIntelligence && "module-record-row-darkweb",
                        isTodayNew(item.firstSeenAt) && "record-is-new",
                      )}
                      role="row"
                      to={intelligenceDetailPath(item)}
                      key={item.id}
                    >
                      {isTodayNew(item.firstSeenAt) && <NewCornerBadge />}
                      <SequenceCell
                        className="module-record-select"
                        selection={
                          <input
                            className="selection-checkbox"
                            type="checkbox"
                            checked={selectedIds.has(item.id)}
                            aria-label={`选择${item.title}`}
                            onClick={(event) => event.preventDefault()}
                            onChange={(event) => {
                              event.preventDefault();
                              toggleSelected(item.id);
                            }}
                          />
                        }
                        value={(page - 1) * pageSize + index + 1}
                      />
                      {isDarkWebIntelligence ? (
                        <>
                          <div className="darkweb-record-main">
                            <RiskBadge level={item.risk} />
                            <span>
                              <strong>{item.title}</strong>
                              <small>{item.id}</small>
                            </span>
                          </div>
                          <div className="darkweb-record-type">
                            {(item.intelTags?.length
                              ? item.intelTags
                              : item.tags.slice(0, 1)
                            ).map((tag) => (
                              <Tag
                                tone={tag === "数据泄露" ? "pink" : "cyan"}
                                key={tag}
                              >
                                {tag}
                              </Tag>
                            ))}
                          </div>
                          <span className="darkweb-record-source">
                            {item.source}
                          </span>
                          <time className="darkweb-record-time">
                            {item.observedAt}
                          </time>
                          <span className="darkweb-record-action">
                            查看详情
                            <ChevronRight size={13} />
                          </span>
                        </>
                      ) : (
                        <>
                          <div>
                            <RiskBadge level={item.risk} />
                            <span>
                              <strong>{item.title}</strong>
                              <small>
                                {item.id} · 可信度{" "}
                                {confidenceLabel(item.confidence)}
                              </small>
                              <span className="module-record-tags">
                                {item.tags.slice(0, 2).map((tag) => (
                                  <Tag
                                    tone={tag === "数据泄露" ? "pink" : "cyan"}
                                    key={tag}
                                  >
                                    {tag}
                                  </Tag>
                                ))}
                              </span>
                            </span>
                          </div>
                          <div className="module-entities">
                            {item.entities.slice(0, 2).map((entity) => (
                              <code key={entity}>{entity}</code>
                            ))}
                          </div>
                          <div className="module-record-source">
                            <span>{item.source}</span>
                          </div>
                          <time>{item.observedAt}</time>
                          <ChevronRight size={17} />
                        </>
                      )}
                    </Link>
                  ))}
                </div>
              </ListViewFrame>
            ) : (
              <EmptyState
                icon={<FileSearch size={34} />}
                title="当前风险筛选下暂无记录"
                description="切换风险等级或进入高级查询查看其他数据。"
              />
            )}
            {(
              <footer className="credential-pagination">
                <span>
                  第 {result.page} / {Math.max(1, Math.ceil(result.total / result.pageSize))}{" "}
                  页，共 {result.total.toLocaleString("zh-CN")} 条记录
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
                      page >= Math.max(1, Math.ceil(result.total / result.pageSize)) ||
                      loading
                    }
                    onClick={() => setPage((value) => value + 1)}
                  >
                    下一页
                  </Button>
                </div>
              </footer>
            )}
          </Panel>
        </>
      ) : null}
    </div>
  );
}
