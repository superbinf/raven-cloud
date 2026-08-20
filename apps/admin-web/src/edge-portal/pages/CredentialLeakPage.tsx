import { useEffect, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import {
  Database,
  Download,
  Eye,
  EyeOff,
  FileKey,
  FileSearch,
  Search,
  UserRound,
  X,
} from "lucide-react";
import {
  type CredentialLeakPageResult,
  type CredentialLeakRecord,
  type CredentialSubscription,
} from "@sentinel/shared";
import { Button, EmptyState } from "@/components/common";

import { moduleConfigs, type ModuleConfig } from "../config/modules";
import { portalSessionKey } from "../app/PortalShell";
import { portalApiFetch as apiFetch } from "../shared/api/portalApi";
import {
  NewCornerBadge,
  TodayCountBadge,
} from "../shared/TodayNewBar";
import { ModuleHeader } from "../shared/ModuleHeader";
import {
  ListViewControls,
  ListViewFrame,
  SortableResizableHeader,
  listViewGridStyle,
  sortListItems,
  useListViewPreferences,
} from "../shared/ListViewControls";
import { isTodayNew, todayStartIso } from "../lib/today";
import { fetchAllPages } from "../shared/exportCsv";
import { SequenceCell } from "../shared/SequenceCell";
import { PageSizeSelect } from "../shared/PageSizeSelect";

const credentialCategoryMeta = {
  credential: {
    label: "用户登录凭证泄露",
    description: "账号、密码、登录入口和组合列表线索",
    tone: "pink",
  },
  employee: {
    label: "员工账户泄露",
    description: "员工姓名、邮箱、电话和组织关联信息",
    tone: "cyan",
  },
} as const;
const credentialListColumns = [
  ["序号", 88],
  ["系统域名", 180],
  ["完整 URL", 280],
  ["账号", 170],
  ["密码", 170],
  ["发现时间", 150],
].map(([label, width], index) => ({
  id: `column-${index + 1}`,
  label: String(label),
  defaultWidth: Number(width),
  minWidth: index ? 96 : 78,
}));
const employeeListColumns = [
  ["序号", 88],
  ["系统名称", 200],
  ["账号", 170],
  ["字段明细", 300],
  ["发现时间", 150],
].map(([label, width], index) => ({
  id: `column-${index + 1}`,
  label: String(label),
  defaultWidth: Number(width),
  minWidth: index ? 96 : 78,
}));

const credentialFieldLabels: Record<string, string> = {
  account: "账号",
  email: "Email",
  mail_domain: "邮箱域",
  phone: "手机号",
  pwd: "密码",
  password: "密码",
  name: "名称",
  source: "来源",
  user_id: "用户 ID",
  timestamp: "发现时间",
  find_time: "发现时间",
  root_domain: "根域名",
  domain: "业务域名",
  toplv_domain: "顶级域名",
  url: "URL",
  sub_id: "订阅 ID",
  country: "Country",
  Country: "Country",
  original_other: "原始附加信息",
};

function displayCredentialFieldLabel(key: string) {
  return credentialFieldLabels[key] ?? key.replaceAll("_", " ");
}

function csvCell(value: string) {
  return `"${String(value ?? "")
    .replaceAll('"', '""')
    .replaceAll("\r", " ")
    .replaceAll("\n", " ")}"`;
}

function downloadCredentialCsv(
  records: CredentialLeakRecord[],
  category: "credential" | "employee",
  subscriptionValue: string,
) {
  const headers =
    category === "credential"
      ? ["系统域名", "完整 URL", "账号", "密码", "发现时间"]
      : ["账号", "Email", "邮箱域", "手机号", "密码", "发现时间"];
  const rows = records.map((record) => {
    const fields = record.fields ?? {};
    const domain = fields.domain || fields.root_domain || record.url || "";
    const rawUrl = fields.url || record.url || domain;
    const fullUrl =
      rawUrl && !/^https?:\/\//i.test(rawUrl) ? `https://${rawUrl}` : rawUrl;
    return category === "credential"
      ? [
          domain,
          fullUrl,
          record.account || fields.email || "",
          record.password || fields.pwd || "",
          record.leakedAt,
        ]
      : [
          record.account || fields.email || "",
          fields.email || "",
          fields.mail_domain || "",
          fields.phone || "",
          record.password || fields.pwd || "",
          record.leakedAt,
        ];
  });
  const csv = `\uFEFF${[headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n")}`;
  const blobUrl = URL.createObjectURL(
    new Blob([csv], { type: "text/csv;charset=utf-8" }),
  );
  const link = document.createElement("a");
  link.href = blobUrl;
  link.download = `credential-leaks-${category}-${subscriptionValue || "current"}-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(blobUrl);
}

function credentialDisplayUrl(record: CredentialLeakRecord) {
  const fields = record.fields ?? {};
  const rawUrl =
    fields.url || record.url || fields.domain || fields.root_domain || "";
  return rawUrl && !/^https?:\/\//i.test(rawUrl) ? `https://${rawUrl}` : rawUrl;
}

function credentialDisplayDomain(record: CredentialLeakRecord) {
  const fields = record.fields ?? {};
  if (fields.domain || fields.root_domain)
    return fields.domain || fields.root_domain || "";
  try {
    return new URL(credentialDisplayUrl(record)).hostname;
  } catch {
    return record.url || "未知域名";
  }
}

function credentialRecordTime(value: string) {
  return value.replace("T", " ").replace("Z", "");
}

function credentialRecordFields(record: CredentialLeakRecord) {
  return Object.entries(record.fields ?? {}).filter(
    ([key]) => !["source", "sub_id"].includes(key),
  );
}

function credentialMatchesQuery(record: CredentialLeakRecord, query: string) {
  return `${record.url} ${record.systemName} ${record.account} ${Object.values(record.fields ?? {}).join(" ")}`
    .toLowerCase()
    .includes(query.trim().toLowerCase());
}

const maskedPassword = "••••••••";

function PasswordValue({
  value,
  visible,
  emptyLabel = "未提供密码",
  onToggle,
}: {
  value: string;
  visible: boolean;
  emptyLabel?: string;
  onToggle: () => void;
}) {
  if (!value) return <code>{emptyLabel}</code>;
  const label = visible ? "隐藏密码" : "显示密码明文";
  const VisibilityIcon = visible ? EyeOff : Eye;
  return (
    <span className="credential-password-value">
      <code>{visible ? value : maskedPassword}</code>
      <button
        type="button"
        aria-label={label}
        aria-pressed={visible}
        title={label}
        onClick={onToggle}
      >
        <VisibilityIcon size={15} aria-hidden="true" />
      </button>
    </span>
  );
}

export function CredentialLeakPage() {
  const config = moduleConfigs.find(
    (item) => item.subtype === "凭据泄露",
  ) as ModuleConfig;
  const [searchParams, setSearchParams] = useSearchParams();
  const todayOnly = searchParams.get("today") === "1";
  const requestedQuery = searchParams.get("query") || "";
  const since = todayStartIso();
  const [subscriptions, setSubscriptions] = useState<CredentialSubscription[]>(
    [],
  );
  const [activeCategory, setActiveCategory] = useState<
    "credential" | "employee"
  >("credential");
  const [selectedSubId, setSelectedSubId] = useState<number | null>(null);
  const [result, setResult] = useState<CredentialLeakPageResult | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [query, setQuery] = useState(requestedQuery);
  const [queryDraft, setQueryDraft] = useState(requestedQuery);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [visiblePasswordIds, setVisiblePasswordIds] = useState<Set<string>>(
    () => new Set(),
  );
  const listColumns =
    activeCategory === "credential"
      ? credentialListColumns
      : employeeListColumns;
  const listView = useListViewPreferences(
    `credential-${activeCategory}`,
    listColumns,
  );

  const loadSubscriptions = () =>
    apiFetch<CredentialSubscription[]>(
      `/api/credentials/subscriptions?since=${encodeURIComponent(since)}`,
    );
  useEffect(() => {
    let active = true;
    loadSubscriptions()
      .then((items) => {
        if (!active) return;
        setSubscriptions(items);
        const first =
          (todayOnly
            ? items.find((item) => (item.todayNewCount ?? 0) > 0)
            : undefined) ??
          items.find((item) => item.subCategory === "credential") ??
          items[0];
        setSelectedSubId(first?.id ?? null);
        setActiveCategory(
          (first?.subCategory as "credential" | "employee") ?? "credential",
        );
      })
      .catch(() => {
        window.sessionStorage.removeItem(portalSessionKey);
        window.top?.location.assign("/admin/login");
      });
    return () => {
      active = false;
    };
  }, [since, todayOnly]);

  const categorySubscriptions = subscriptions.filter(
    (item) => item.subCategory === activeCategory,
  );
  useEffect(() => {
    if (!categorySubscriptions.some((item) => item.id === selectedSubId)) {
      setSelectedSubId(
        (
          (todayOnly
            ? categorySubscriptions.find(
                (item) => (item.todayNewCount ?? 0) > 0,
              )
            : undefined) ?? categorySubscriptions[0]
        )?.id ?? null,
      );
      setPage(1);
    }
  }, [activeCategory, subscriptions, selectedSubId, todayOnly]);

  useEffect(() => {
    if (selectedSubId === null) return;
    let active = true;
    setLoading(true);
    apiFetch<CredentialLeakPageResult>(
      `/api/credentials/results?sub_id=${selectedSubId}&page=${page}&page_size=${pageSize}&since=${encodeURIComponent(since)}${todayOnly ? "&today_only=1" : ""}`,
    )
      .then((data) => {
        if (!active) return;
        setResult(data);
        setLoading(false);
      })
      .catch(() => {
        if (!active) return;
        setLoading(false);
        window.sessionStorage.removeItem(portalSessionKey);
        window.top?.location.assign("/admin/login");
      });
    return () => {
      active = false;
    };
  }, [page, pageSize, selectedSubId, since, todayOnly]);
  useEffect(() => {
    setSelectedIds(new Set());
    setVisiblePasswordIds(new Set());
  }, [activeCategory, page, pageSize, query, selectedSubId, todayOnly]);

  const selectedSubscription = subscriptions.find(
    (item) => item.id === selectedSubId,
  );
  const filteredRecords = (result?.data ?? []).filter((record) =>
    credentialMatchesQuery(record, query),
  );
  const totalPages = Math.max(1, Math.ceil((result?.total ?? 0) / pageSize));
  const selectedCount = filteredRecords.filter((record) =>
    selectedIds.has(record.id),
  ).length;
  const recordsWithPasswords = filteredRecords.filter(
    (record) =>
      Boolean(record.password || record.fields?.pwd || record.fields?.password),
  );
  const allPasswordsVisible =
    recordsWithPasswords.length > 0 &&
    recordsWithPasswords.every((record) => visiblePasswordIds.has(record.id));
  const currentPageAllSelected =
    Boolean(filteredRecords.length) &&
    filteredRecords.every((record) => selectedIds.has(record.id));
  const moduleTodayTotal = subscriptions.reduce(
    (total, item) => total + (item.todayNewCount ?? 0),
    0,
  );
  const Icon = config.icon;
  const filteredForExport = (records: CredentialLeakRecord[]) =>
    query.trim()
      ? records.filter((record) => credentialMatchesQuery(record, query))
      : records;
  const exportSelectedCsv = () => {
    const records = filteredRecords.filter((record) =>
      selectedIds.has(record.id),
    );
    if (records.length)
      downloadCredentialCsv(
        records,
        activeCategory,
        selectedSubscription?.value ?? "selected",
      );
  };
  const exportAllCsv = async () => {
    if (selectedSubId === null) return;
    setExporting(true);
    setExportError("");
    try {
      const records = filteredForExport(
        await fetchAllPages<CredentialLeakRecord>(
          (exportPage, exportPageSize) =>
            apiFetch<CredentialLeakPageResult>(
              `/api/credentials/results?sub_id=${selectedSubId}&page=${exportPage}&page_size=${exportPageSize}&since=${encodeURIComponent(since)}${todayOnly ? "&today_only=1" : ""}`,
            ),
        ),
      );
      if (!records.length) throw new Error("当前范围没有可导出的记录");
      downloadCredentialCsv(
        records,
        activeCategory,
        selectedSubscription?.value ?? "all",
      );
    } catch (error) {
      setExportError(error instanceof Error ? error.message : "CSV 导出失败");
    } finally {
      setExporting(false);
    }
  };
  const toggleToday = () => {
    const next = new URLSearchParams(searchParams);
    if (todayOnly) next.delete("today");
    else next.set("today", "1");
    setPage(1);
    setQuery("");
    setQueryDraft("");
    setSearchParams(next, { replace: true });
  };
  const applySearch = (event: FormEvent) => {
    event.preventDefault();
    setPage(1);
    setQuery(queryDraft.trim());
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
        filteredRecords.forEach((record) => next.delete(record.id));
      else filteredRecords.forEach((record) => next.add(record.id));
      return next;
    });
  const togglePassword = (id: string) =>
    setVisiblePasswordIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleAllPasswords = () =>
    setVisiblePasswordIds((current) => {
      const next = new Set(current);
      recordsWithPasswords.forEach((record) => {
        if (allPasswordsVisible) next.delete(record.id);
        else next.add(record.id);
      });
      return next;
    });
  const sortedRecords = sortListItems(
    filteredRecords,
    listView.sort,
    activeCategory === "credential"
      ? {
          "column-1": (record) => record.id,
          "column-2": credentialDisplayDomain,
          "column-3": credentialDisplayUrl,
          "column-4": (record) => record.account || record.fields?.email,
          "column-5": (record) => record.password || record.fields?.pwd,
          "column-6": (record) => record.leakedAt,
        }
      : {
          "column-1": (record) => record.id,
          "column-2": (record) => record.systemName,
          "column-3": (record) => record.account || record.fields?.email,
          "column-4": (record) => Object.values(record.fields || {}),
          "column-5": (record) => record.leakedAt,
        },
  );

  return (
    <div className="portal-container page-content module-page module-pink credential-page">
      <ModuleHeader
        icon={Icon}
        eyebrow={config.eyebrow}
        title="凭据泄露"
        todayCount={moduleTodayTotal}
        todayActive={todayOnly}
        onToggleToday={toggleToday}
        todayLoading={loading || selectedSubId === null}
        todayLabel="凭据泄露今日新增"
      />
      <section
        id="credential-results"
        className="credential-subscription-panel credential-data-layout"
      >
        <aside
          className="credential-subscription-list"
          aria-label="凭据订阅导航"
        >
          {(["credential", "employee"] as const).map((category) => {
            const items = subscriptions.filter(
              (item) => item.subCategory === category,
            );
            const stored = items.reduce(
              (sum, item) => sum + (item.storedCount ?? 0),
              0,
            );
            const CategoryIcon =
              category === "credential" ? FileKey : UserRound;
            return (
              <section
                key={category}
                className={`credential-subscription-group${
                  activeCategory === category ? " active" : ""
                }`}
              >
                <header>
                  <span aria-hidden="true">
                    <CategoryIcon size={16} />
                  </span>
                  <div>
                    <strong>{credentialCategoryMeta[category].label}</strong>
                    <small>
                      {items.length} 个订阅 · {stored.toLocaleString("zh-CN")} 条线索
                    </small>
                  </div>
                </header>
                <div className="credential-subscription-items">
                  {items.map((subscription) => (
                    <button
                      key={subscription.id}
                      type="button"
                      aria-current={
                        selectedSubId === subscription.id ? "true" : undefined
                      }
                      className={
                        selectedSubId === subscription.id ? "active" : ""
                      }
                      onClick={() => {
                        setActiveCategory(category);
                        setSelectedSubId(subscription.id);
                        setPage(1);
                        setQuery("");
                        setQueryDraft("");
                      }}
                    >
                      <span>
                        <strong>{subscription.value}</strong>
                        <small>
                          到期 {subscription.expireTime.slice(0, 10)}
                        </small>
                      </span>
                      {todayOnly ? (
                        <TodayCountBadge
                          count={subscription.todayNewCount ?? 0}
                        />
                      ) : (
                        <em title="累计入库记录">
                          {(subscription.storedCount ?? 0).toLocaleString(
                            "zh-CN",
                          )}
                        </em>
                      )}
                    </button>
                  ))}
                </div>
              </section>
            );
          })}
        </aside>
        <div className="credential-result-workspace">
          <header
            className="credential-workspace-summary"
            aria-label="当前凭据数据范围"
          >
            <div className="credential-workspace-object">
              <span className="credential-workspace-icon" aria-hidden="true">
                {activeCategory === "credential" ? (
                  <FileKey size={18} />
                ) : (
                  <UserRound size={18} />
                )}
              </span>
              <div>
                <span>当前订阅</span>
                <strong>
                  {selectedSubscription?.value ?? "正在读取订阅"}
                </strong>
                <small>
                  {selectedSubscription?.targetName &&
                  selectedSubscription.targetName !== selectedSubscription.value
                    ? `${selectedSubscription.targetName} · `
                    : "域名监测 · "}
                  {selectedSubscription?.expireTime
                    ? `有效期至 ${selectedSubscription.expireTime.slice(0, 10)}`
                    : "等待订阅信息"}
                </small>
              </div>
              <span className="credential-monitoring-status">
                <span aria-hidden="true" />持续监测
              </span>
            </div>
            <div className="credential-workspace-count">
              <span>
                <Database size={14} aria-hidden="true" />
                当前记录
              </span>
              <strong>
                {(selectedSubscription?.storedCount ?? 0).toLocaleString(
                  "zh-CN",
                )}
                <small>条</small>
              </strong>
              <p>{credentialCategoryMeta[activeCategory].description}</p>
            </div>
          </header>
          <div className="data-command-bar credential-result-toolbar">
            <form className="data-command-search" onSubmit={applySearch}>
              <label className="data-search-field">
                <span className="sr-only">
                  搜索{credentialCategoryMeta[activeCategory].label}
                </span>
                <Search size={18} aria-hidden="true" />
                <input
                  type="search"
                  value={queryDraft}
                  onChange={(event) => setQueryDraft(event.target.value)}
                  placeholder="搜索账号、邮箱、系统名称或原始字段"
                  autoComplete="off"
                />
                {queryDraft && (
                  <button
                    className="data-search-clear"
                    type="button"
                    onClick={() => {
                      setQueryDraft("");
                      setQuery("");
                      setPage(1);
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
            <div className="export-action-group credential-export-actions">
              <Button
                className="credential-password-bulk-toggle"
                variant="ghost"
                disabled={loading || !recordsWithPasswords.length}
                onClick={toggleAllPasswords}
                aria-pressed={allPasswordsVisible}
                title={allPasswordsVisible ? "隐藏当前列表的密码" : "显示当前列表的密码明文"}
              >
                {allPasswordsVisible ? <EyeOff size={15} /> : <Eye size={15} />}
                {allPasswordsVisible ? "隐藏全部明文" : "显示全部明文"}
              </Button>
              <Button
                className="data-export-button"
                variant="ghost"
                disabled={!selectedCount}
                onClick={exportSelectedCsv}
              >
                <Download size={15} />
                导出选中{selectedCount ? ` ${selectedCount}` : ""}
              </Button>
              <Button
                className="data-export-button"
                variant="secondary"
                onClick={() => void exportAllCsv()}
                disabled={loading || exporting || !result?.total}
                title={exportError || "导出当前范围内的全部记录"}
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
            <div className="skeleton-list" aria-label="正在加载凭据泄露数据">
              {Array.from({ length: 5 }).map((_, index) => (
                <div className="skeleton-row" key={index} />
              ))}
            </div>
          ) : !filteredRecords.length ? (
            <EmptyState
              icon={<FileSearch size={34} />}
              title="当前类型暂无记录"
              description="切换凭据类型、订阅域名或清空搜索条件。"
            />
          ) : (
            <ListViewFrame
              hidden={listView.hidden}
              className="credential-list-frame"
            >
              {activeCategory === "credential" ? (
                <div
                  className="credential-credential-table"
                  style={listViewGridStyle(listColumns, listView.widths)}
                  role="table"
                  aria-label="用户登录凭证泄露列表"
                >
                  <div className="credential-credential-head" role="row">
                      {credentialListColumns.map((column, index) => (
                        <SortableResizableHeader
                        key={column.id}
                        column={column}
                        sort={listView.sort}
                        width={listView.columnWidth(column.id)}
                          onSort={listView.toggleSort}
                          onResize={listView.setColumnWidth}
                          leading={
                            index === 0 ? (
                              <input
                                className="selection-checkbox"
                                type="checkbox"
                                checked={currentPageAllSelected}
                                onChange={toggleCurrentPage}
                                aria-label="选择当前页凭据"
                              />
                            ) : undefined
                          }
                        />
                    ))}
                  </div>
                  {sortedRecords.map((record, index) => (
                    <div
                      className={`credential-credential-row${isTodayNew(record.firstSeenAt) ? " record-is-new" : ""}`}
                      role="row"
                      key={record.id}
                    >
                      {isTodayNew(record.firstSeenAt) && <NewCornerBadge />}
                      <SequenceCell
                        className="credential-record-index"
                        selection={
                          <input
                            className="selection-checkbox"
                            type="checkbox"
                            checked={selectedIds.has(record.id)}
                            onChange={() => toggleSelected(record.id)}
                            aria-label={`选择${credentialDisplayDomain(record)}`}
                          />
                        }
                        value={(page - 1) * pageSize + index + 1}
                      />
                      <strong>{credentialDisplayDomain(record)}</strong>
                      <code>
                        {credentialDisplayUrl(record) || "未提供 URL"}
                      </code>
                      <span>
                        {record.account || record.fields?.email || "未提供账号"}
                      </span>
                      <PasswordValue
                        value={record.password || record.fields?.pwd || ""}
                        visible={visiblePasswordIds.has(record.id)}
                        onToggle={() => togglePassword(record.id)}
                      />
                      <time>{credentialRecordTime(record.leakedAt)}</time>
                    </div>
                  ))}
                </div>
              ) : (
                <div
                  className="credential-employee-feed"
                  role="list"
                  aria-label="员工账户泄露记录"
                >
                  {sortedRecords.map((record, index) => (
                    <article
                      className={`credential-employee-card${isTodayNew(record.firstSeenAt) ? " record-is-new" : ""}`}
                      role="listitem"
                      key={record.id}
                    >
                      {isTodayNew(record.firstSeenAt) && <NewCornerBadge />}
                      <header>
                        <div>
                          <SequenceCell
                            className="credential-employee-index"
                            selection={
                              <input
                                className="selection-checkbox"
                                type="checkbox"
                                checked={selectedIds.has(record.id)}
                                onChange={() => toggleSelected(record.id)}
                                aria-label={`选择${record.systemName || record.account || record.id}`}
                              />
                            }
                            value={(page - 1) * pageSize + index + 1}
                          />
                          <div>
                            <strong>{record.systemName || "未知组织"}</strong>
                            <small>
                              {record.account ||
                                record.fields?.email ||
                                "未提供账号"}
                            </small>
                          </div>
                        </div>
                        <time>{credentialRecordTime(record.leakedAt)}</time>
                      </header>
                      <div className="credential-employee-fields">
                        {credentialRecordFields(record).map(([key, value]) => {
                          const isPassword = key === "pwd" || key === "password";
                          return (
                            <div key={key}>
                              <span>{displayCredentialFieldLabel(key)}</span>
                              {isPassword ? (
                                <PasswordValue
                                  value={value}
                                  visible={visiblePasswordIds.has(record.id)}
                                  emptyLabel="--"
                                  onToggle={() => togglePassword(record.id)}
                                />
                              ) : (
                                <code>{value || "--"}</code>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </ListViewFrame>
          )}
          <footer className="credential-pagination">
            <span>
              第 {page} / {totalPages} 页，共 {result?.total ?? 0} 条记录
            </span>
            <div>
              <PageSizeSelect value={pageSize} disabled={loading} onChange={(value) => { setPageSize(value); setPage(1); }} />
              <Button
                variant="ghost"
                disabled={page <= 1}
                onClick={() => setPage((value) => Math.max(1, value - 1))}
              >
                上一页
              </Button>
              <Button
                variant="secondary"
                disabled={page >= totalPages}
                onClick={() =>
                  setPage((value) => Math.min(totalPages, value + 1))
                }
              >
                下一页
              </Button>
            </div>
          </footer>
        </div>
      </section>
    </div>
  );
}
