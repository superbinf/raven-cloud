import { useEffect, useRef, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import {
  Clock3,
  Download,
  FileInput,
  Hash,
  Search,
  ShieldAlert,
  X,
} from "lucide-react";
import {
  type RiskLevel,
  type SensitiveRecord,
  type SensitiveRecordsPageResult,
} from "@sentinel/shared";
import { Button, EmptyState, Panel, RiskBadge, cn } from "@/components/ui";

import {
  sensitiveCategoryBySubtype,
  type ModuleConfig,
} from "../config/modules";
import { portalSessionKey } from "../app/PortalShell";
import { portalApiFetch as apiFetch } from "../shared/api/portalApi";
import { EMPTY_DATA_DESCRIPTION, EMPTY_DATA_TITLE } from "../shared/emptyState";
import { NewCornerBadge } from "../shared/TodayNewBar";
import { ModuleHeader } from "../shared/ModuleHeader";
import {
  ListViewControls,
  ListViewFrame,
  SortableResizableHeader,
  listViewGridStyle,
  sortListItems,
  useListViewPreferences,
  type ListViewColumn,
} from "../shared/ListViewControls";
import { isTodayNew, todayStartIso } from "../lib/today";
import {
  downloadCsv,
  fetchAllPages,
  type CsvColumn,
} from "../shared/exportCsv";
import { SequenceCell } from "../shared/SequenceCell";
import { PageSizeSelect } from "../shared/PageSizeSelect";

const sensitiveRiskLevels: Record<string, RiskLevel> = {
  严重: "critical",
  高: "high",
  中: "medium",
  低: "low",
  信息: "info",
  未标记: "info",
};
function sensitiveField(record: SensitiveRecord, ...keys: string[]) {
  for (const key of keys) if (record.fields[key]) return record.fields[key];
  return "";
}
function sensitiveTime(value: string) {
  return value ? value.replace("T", " ").replace("Z", "").slice(0, 19) : "--";
}
const sensitiveDetailLabels: Record<string, string> = {
  systemName: "系统名称",
  loginUrl: "登录位置",
  account: "账号",
  password: "密码",
  source: "来源",
  name: "名称",
  type: "类型",
  url: "网站链接",
  content: "泄漏内容",
  channel: "泄漏渠道",
  note: "备注",
  email: "Email",
  phone: "手机号",
  domain: "域名",
  sourceType: "来源类型",
  repository: "代码仓库",
  file: "文件名",
};
const sensitiveDetailMonoFields = new Set([
  "account",
  "password",
  "url",
  "loginUrl",
  "domain",
  "repository",
  "file",
  "email",
  "phone",
]);
const sensitiveDetailWideFields = new Set([
  "content",
  "url",
  "loginUrl",
  "source",
  "repository",
  "note",
]);
const sensitiveDetailFieldOrder = [
  "systemName",
  "name",
  "type",
  "account",
  "password",
  "loginUrl",
  "url",
  "source",
  "sourceType",
  "domain",
  "repository",
  "file",
  "email",
  "phone",
  "channel",
  "content",
  "note",
];
function sensitiveDetailEntries(record: SensitiveRecord) {
  return Object.entries(record.fields)
    .filter(([key]) => key !== "risk" && key !== "sequence")
    .sort(([left], [right]) => {
      const leftIndex = sensitiveDetailFieldOrder.indexOf(left);
      const rightIndex = sensitiveDetailFieldOrder.indexOf(right);
      return (
        (leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex) -
        (rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex)
      );
    });
}
const sensitiveWidths: Record<string, number> = {
  序号: 64,
  "系统 / 登录位置": 210,
  账号: 150,
  密码: 160,
  来源: 190,
  风险: 82,
  发现时间: 150,
  备注: 180,
  操作: 92,
  仿冒网站: 220,
  网站链接: 290,
  名称: 210,
  泄漏内容: 290,
  泄漏渠道: 200,
};
const sensitiveColumns = (labels: string[]): ListViewColumn[] =>
  labels.map((label, index) => ({
    id: `column-${index + 1}`,
    label,
    defaultWidth: sensitiveWidths[label] || 150,
    minWidth: label === "序号" ? 56 : label === "操作" ? 76 : 84,
    sortable: label !== "操作",
  }));
const sensitiveListColumns: Record<string, ListViewColumn[]> = {
  "account-password": sensitiveColumns([
    "序号",
    "系统 / 登录位置",
    "账号",
    "密码",
    "来源",
    "风险",
    "发现时间",
    "备注",
    "操作",
  ]),
  phishing: sensitiveColumns([
    "序号",
    "仿冒网站",
    "网站链接",
    "风险",
    "发现时间",
    "备注",
    "操作",
  ]),
  "source-code": sensitiveColumns([
    "序号",
    "名称",
    "泄漏内容",
    "泄漏渠道",
    "风险",
    "发现时间",
    "备注",
    "操作",
  ]),
  documents: sensitiveColumns([
    "序号",
    "名称",
    "泄漏内容",
    "泄漏渠道",
    "风险",
    "发现时间",
    "备注",
    "操作",
  ]),
};
function sensitiveDetailLabel(key: string) {
  return sensitiveDetailLabels[key] ?? key.replaceAll("_", " ");
}

export function SensitiveDataPage({ config }: { config: ModuleConfig }) {
  const category = sensitiveCategoryBySubtype[config.subtype];
  const [searchParams, setSearchParams] = useSearchParams();
  const todayOnly = searchParams.get("today") === "1";
  const requestedQuery = searchParams.get("query") || "";
  const requestedDetailId = searchParams.get("detail") || "";
  const since = todayStartIso();
  const [records, setRecords] = useState<SensitiveRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [allTotal, setAllTotal] = useState(0);
  const [todayNewCount, setTodayNewCount] = useState(0);
  const [riskCounts, setRiskCounts] = useState<Record<string, number>>({});
  const [query, setQuery] = useState(requestedQuery);
  const [queryDraft, setQueryDraft] = useState(requestedQuery);
  const [risk, setRisk] = useState("全部");
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [detailRecord, setDetailRecord] = useState<SensitiveRecord | null>(
    null,
  );
  const detailCloseRef = useRef<HTMLButtonElement>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState("");
  const openDetail = (record: SensitiveRecord) => {
    const next = new URLSearchParams(searchParams);
    next.set("detail", record.id);
    setDetailRecord(record);
    setSearchParams(next);
  };
  const closeDetail = () => {
    const next = new URLSearchParams(searchParams);
    next.delete("detail");
    setDetailRecord(null);
    setSearchParams(next, { replace: true });
  };
  const listColumns =
    sensitiveListColumns[category] || sensitiveListColumns.documents;
  const listView = useListViewPreferences(`sensitive-${category}`, listColumns);
  useEffect(() => {
    if (!detailRecord) return;
    const previousOverflow = document.body.style.overflow;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeDetail();
    };
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", closeOnEscape);
    requestAnimationFrame(() => detailCloseRef.current?.focus());
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [detailRecord]);
  const loadRecords = () =>
    apiFetch<SensitiveRecordsPageResult>(
      `/api/sensitive/records?category=${category}&page=${page}&page_size=${pageSize}&query=${encodeURIComponent(query.trim())}&risk=${encodeURIComponent(risk === "全部" ? "" : risk)}&since=${encodeURIComponent(since)}${todayOnly ? "&today_only=1" : ""}`,
    );
  useEffect(() => {
    let active = true;
    setLoading(true);
    loadRecords()
      .then((data) => {
        if (active) {
          setRecords(data.data);
          setTotal(data.total);
          setAllTotal(data.allTotal ?? data.total);
          setTodayNewCount(data.todayNewCount ?? 0);
          setRiskCounts(data.riskCounts ?? {});
          setDetailRecord(
            requestedDetailId
              ? data.data.find((record) => record.id === requestedDetailId) ?? null
              : null,
          );
          setLoading(false);
        }
      })
      .catch(() => {
        if (active) {
          setLoading(false);
          window.sessionStorage.removeItem(portalSessionKey);
          window.top?.location.assign("/admin/login");
        }
      });
    return () => {
      active = false;
    };
  }, [category, page, pageSize, query, requestedDetailId, risk, since, todayOnly]);
  useEffect(() => {
    setSelectedIds(new Set());
  }, [category, page, query, risk, todayOnly]);
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
  const visible = records;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const selectedCount = visible.filter((record) =>
    selectedIds.has(record.id),
  ).length;
  const currentPageAllSelected =
    Boolean(visible.length) &&
    visible.every((record) => selectedIds.has(record.id));
  const riskSummary = ["高", "中", "低"].map((level) => ({
    level,
    count: riskCounts[level] ?? 0,
  }));
  const Icon = config.icon;
  const metricsForModule = [
    {
      label: "累计记录",
      value: allTotal.toLocaleString("zh-CN"),
      meta: "去重后记录",
      tone: "info" as const,
      filter: "全部",
    },
    {
      label: "高风险记录",
      value: riskSummary[0].count.toLocaleString("zh-CN"),
      meta: "风险等级为高",
      tone: "high" as const,
      filter: "高",
    },
    {
      label: "中风险记录",
      value: riskSummary[1].count.toLocaleString("zh-CN"),
      meta: "风险等级为中",
      tone: "medium" as const,
      filter: "中",
    },
    {
      label: "低风险记录",
      value: riskSummary[2].count.toLocaleString("zh-CN"),
      meta: "风险等级为低",
      tone: "low" as const,
      filter: "低",
    },
  ];
  const riskTag = (value: string) => (
    <RiskBadge level={sensitiveRiskLevels[value] || "info"}>
      {value || "信息"}
    </RiskBadge>
  );
  const detailFields = detailRecord ? sensitiveDetailEntries(detailRecord) : [];
  const exportColumns: Array<CsvColumn<SensitiveRecord>> = [
    { header: "序号", value: (record) => record.sequence },
    { header: "标题", value: (record) => record.title },
    { header: "风险", value: (record) => record.risk },
    {
      header: "首次发现",
      value: (record) => sensitiveTime(record.firstSeenAt),
    },
    { header: "最近发现", value: (record) => sensitiveTime(record.lastSeenAt) },
    {
      header: "字段详情",
      value: (record) =>
        Object.entries(record.fields)
          .map(
            ([key, value]) => `${sensitiveDetailLabel(key)}=${value || "--"}`,
          )
          .join("；"),
    },
  ];
  const exportRows = (rows: SensitiveRecord[], scope: "selected" | "all") =>
    downloadCsv(
      `${config.title}-${scope === "selected" ? "选中" : "全部"}-${new Date().toISOString().slice(0, 10)}.csv`,
      exportColumns,
      rows,
    );
  const exportSelected = () => {
    const rows = visible.filter((record) => selectedIds.has(record.id));
    if (rows.length) exportRows(rows, "selected");
  };
  const exportAll = async () => {
    setExporting(true);
    setExportError("");
    try {
      const rows = await fetchAllPages<SensitiveRecord>(
        (exportPage, exportPageSize) =>
          apiFetch<SensitiveRecordsPageResult>(
            `/api/sensitive/records?category=${category}&page=${exportPage}&page_size=${exportPageSize}&query=${encodeURIComponent(query.trim())}&risk=${encodeURIComponent(risk === "全部" ? "" : risk)}&since=${encodeURIComponent(since)}${todayOnly ? "&today_only=1" : ""}`,
          ),
      );
      if (!rows.length) throw new Error("当前筛选条件下没有可导出的记录");
      exportRows(rows, "all");
    } catch (reason) {
      setExportError(reason instanceof Error ? reason.message : "导出失败");
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
        visible.forEach((record) => next.delete(record.id));
      else visible.forEach((record) => next.add(record.id));
      return next;
    });
  const sortedRecords = sortListItems(
    visible,
    listView.sort,
    Object.fromEntries(
      listColumns.map((column) => [
        column.id,
        (record: SensitiveRecord) => {
          const label = column.label;
          if (label === "序号") return record.sequence;
          if (label === "风险") return record.risk;
          if (label === "发现时间") return record.lastSeenAt;
          const keys: Record<string, string[]> = {
            "系统 / 登录位置": ["systemName", "loginUrl"],
            账号: ["account"],
            密码: ["password"],
            来源: ["source"],
            备注: ["note"],
            仿冒网站: ["name", "type"],
            网站链接: ["url"],
            名称: ["name"],
            泄漏内容: ["content"],
            泄漏渠道: ["channel"],
          };
          return sensitiveField(record, ...(keys[label] || []));
        },
      ]),
    ),
  );
  return (
    <div
      className={cn(
        "portal-container page-content module-page sensitive-data-page",
        `module-${config.tone}`,
      )}
    >
      <ModuleHeader
        icon={Icon}
        eyebrow={config.eyebrow}
        title={config.title}
        todayCount={todayNewCount}
        todayActive={todayOnly}
        onToggleToday={toggleToday}
        todayLoading={loading}
        todayLabel={`${config.title}今日新增`}
      />
      <section
        className="module-kpi-grid"
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
      <Panel className="sensitive-imported-records">
        <div className="data-command-bar sensitive-data-toolbar">
          <form className="data-command-search" onSubmit={applySearch}>
            <label className="data-search-field">
              <span className="sr-only">搜索情报记录</span>
              <Search size={18} aria-hidden="true" />
              <input
                type="search"
                value={queryDraft}
                onChange={(event) => setQueryDraft(event.target.value)}
                placeholder="搜索名称、账号、URL、内容"
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
              disabled={exporting || !total}
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
        {loading ? (
          <div className="skeleton-list" aria-label="正在加载情报记录">
            {Array.from({ length: 5 }).map((_, index) => (
              <div className="skeleton-row" key={index} />
            ))}
          </div>
        ) : !visible.length ? (
          <EmptyState
            icon={<FileInput size={30} aria-hidden="true" />}
            title={query || risk !== "全部" || todayOnly ? "未找到匹配记录" : EMPTY_DATA_TITLE}
            description={
              query || risk !== "全部" || todayOnly
                ? "请调整搜索关键词或筛选条件后重试。"
                : EMPTY_DATA_DESCRIPTION
            }
          />
        ) : (
          <ListViewFrame
            hidden={listView.hidden}
            className="sensitive-list-frame"
          >
            <div
              className={`sensitive-import-table sensitive-import-${category}`}
              style={listViewGridStyle(listColumns, listView.widths)}
              role="table"
              aria-label={`${config.title}记录`}
            >
              <div className="sensitive-import-head" role="row">
                <span>
                  <input
                    className="selection-checkbox"
                    type="checkbox"
                    checked={currentPageAllSelected}
                    onChange={toggleCurrentPage}
                    aria-label="选择当前页敏感信息"
                  />
                </span>
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
              {sortedRecords.map((record) => (
                <div
                  className={cn(
                    "sensitive-import-row",
                    isTodayNew(record.firstSeenAt) && "record-is-new",
                  )}
                  role="row"
                  key={record.id}
                >
                  {isTodayNew(record.firstSeenAt) && <NewCornerBadge />}
                  <span className="record-select-cell">
                    <input
                      className="selection-checkbox"
                      type="checkbox"
                      checked={selectedIds.has(record.id)}
                      onChange={() => toggleSelected(record.id)}
                      aria-label={`选择${record.title}`}
                    />
                  </span>
                  <SequenceCell value={record.sequence} />
                  {category === "account-password" ? (
                    <>
                      <div>
                        <strong>
                          {sensitiveField(record, "systemName") || "未命名系统"}
                        </strong>
                        <small>
                          {sensitiveField(record, "loginUrl") ||
                            "未提供登录位置"}
                        </small>
                      </div>
                      <code>
                        {sensitiveField(record, "account") || "未提供"}
                      </code>
                      <code
                        className="sensitive-secret"
                        title={sensitiveField(record, "password")}
                      >
                        {sensitiveField(record, "password") || "未提供"}
                      </code>
                      <span>
                        {sensitiveField(record, "source") || "未提供"}
                      </span>
                      {riskTag(record.risk)}
                      <time>{sensitiveTime(record.lastSeenAt)}</time>
                      <span>{sensitiveField(record, "note") || "--"}</span>
                      <button
                        type="button"
                        className="sensitive-detail-button"
                        onClick={() => openDetail(record)}
                      >
                        查看详情
                      </button>
                    </>
                  ) : category === "phishing" ? (
                    <>
                      <div>
                        <strong>
                          {sensitiveField(record, "name") || "未命名网站"}
                        </strong>
                        <small>
                          {sensitiveField(record, "type") || "未标记类型"}
                        </small>
                      </div>
                      <code>
                        {sensitiveField(record, "url") || "未提供链接"}
                      </code>
                      {riskTag(record.risk)}
                      <time>{sensitiveTime(record.lastSeenAt)}</time>
                      <span>{sensitiveField(record, "note") || "--"}</span>
                      <button
                        type="button"
                        className="sensitive-detail-button"
                        onClick={() => openDetail(record)}
                      >
                        查看详情
                      </button>
                    </>
                  ) : (
                    <>
                      <strong>
                        {sensitiveField(record, "name") || "未命名"}
                      </strong>
                      <span className="sensitive-content">
                        {sensitiveField(record, "content") || "未提供泄漏内容"}
                      </span>
                      <code>
                        {sensitiveField(record, "channel") || "未提供渠道"}
                      </code>
                      {riskTag(record.risk)}
                      <time>{sensitiveTime(record.lastSeenAt)}</time>
                      <span>{sensitiveField(record, "note") || "--"}</span>
                      <button
                        type="button"
                        className="sensitive-detail-button"
                        onClick={() => openDetail(record)}
                      >
                        查看详情
                      </button>
                    </>
                  )}
                </div>
              ))}
            </div>
          </ListViewFrame>
        )}
        {
          <footer className="credential-pagination">
            <span>
              第 {page} / {totalPages} 页，共 {total.toLocaleString("zh-CN")}{" "}
              条记录
            </span>
            <div>
              <PageSizeSelect
                value={pageSize}
                disabled={loading}
                onChange={(value) => {
                  setPageSize(value);
                  setPage(1);
                }}
              />
              <Button
                variant="ghost"
                disabled={page <= 1 || loading}
                onClick={() => setPage((value) => Math.max(1, value - 1))}
              >
                上一页
              </Button>
              <Button
                variant="secondary"
                disabled={page >= totalPages || loading}
                onClick={() =>
                  setPage((value) => Math.min(totalPages, value + 1))
                }
              >
                下一页
              </Button>
            </div>
          </footer>
        }
      </Panel>
      {detailRecord && (
        <div
          className="sensitive-detail-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="sensitive-detail-title"
          onClick={closeDetail}
        >
          <article
            className="sensitive-detail-card"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="sensitive-detail-header">
              <div className="sensitive-detail-heading-icon" aria-hidden="true">
                <Icon size={24} />
              </div>
              <div className="sensitive-detail-heading">
                <span className="eyebrow">SENSITIVE DATA</span>
                <h2 id="sensitive-detail-title">
                  {detailRecord.title || "敏感信息详情"}
                </h2>
                <p>
                  记录 #{detailRecord.sequence} · {detailFields.length} 项字段
                </p>
              </div>
              <button
                ref={detailCloseRef}
                type="button"
                className="sensitive-detail-close"
                onClick={closeDetail}
                aria-label="关闭敏感信息详情"
                title="关闭"
              >
                <X size={19} />
              </button>
            </header>
            <section className="sensitive-detail-summary" aria-label="记录摘要">
              <div>
                <span
                  className="sensitive-detail-summary-icon"
                  aria-hidden="true"
                >
                  <Hash size={17} />
                </span>
                <div>
                  <span>记录序号</span>
                  <strong>{detailRecord.sequence}</strong>
                </div>
              </div>
              <div>
                <span
                  className="sensitive-detail-summary-icon"
                  aria-hidden="true"
                >
                  <ShieldAlert size={17} />
                </span>
                <div>
                  <span>风险等级</span>
                  {riskTag(detailRecord.risk)}
                </div>
              </div>
              <div>
                <span
                  className="sensitive-detail-summary-icon"
                  aria-hidden="true"
                >
                  <Clock3 size={17} />
                </span>
                <div>
                  <span>首次发现</span>
                  <time>{sensitiveTime(detailRecord.firstSeenAt)}</time>
                </div>
              </div>
              <div>
                <span
                  className="sensitive-detail-summary-icon"
                  aria-hidden="true"
                >
                  <Clock3 size={17} />
                </span>
                <div>
                  <span>最近发现</span>
                  <time>{sensitiveTime(detailRecord.lastSeenAt)}</time>
                </div>
              </div>
            </section>
            <section className="sensitive-detail-body">
              <div className="sensitive-detail-section-title">
                <div>
                  <strong>记录字段</strong>
                  <span>采集到的敏感信息与来源明细</span>
                </div>
                <span>{detailFields.length} 项</span>
              </div>
              <dl>
                {detailFields.map(([key, value]) => (
                  <div
                    className={cn(
                      "sensitive-detail-field",
                      sensitiveDetailWideFields.has(key) &&
                        "sensitive-detail-field-wide",
                    )}
                    key={key}
                  >
                    <dt>{sensitiveDetailLabel(key)}</dt>
                    <dd
                      className={cn(
                        "sensitive-detail-value",
                        sensitiveDetailMonoFields.has(key) &&
                          "sensitive-detail-value-mono",
                      )}
                    >
                      {value || "--"}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          </article>
        </div>
      )}
    </div>
  );
}
