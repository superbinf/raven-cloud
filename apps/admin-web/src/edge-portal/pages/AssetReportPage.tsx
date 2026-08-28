import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import {
  ChevronRight,
  CircleGauge,
  Clock3,
  Database,
  Download,
  FileSearch,
  Fingerprint,
  Globe2,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  RotateCcw,
  Search,
  Settings,
  SlidersHorizontal,
  SquareArrowOutUpRight,
  TriangleAlert,
  X,
} from "lucide-react";
import {
  type AssetCategory,
  type AssetRecord,
  type AssetRecordsPageResult,
  type AssetReport,
  type HtmlReportSection,
  type HtmlReportSectionResult,
} from "@sentinel/shared";
import { Button, EmptyState, Panel, Tag, cn } from "@/components/ui";

import {
  CountryFlag,
  FingerprintIconProvider,
  OrganizationGlyph,
  ProviderGlyph,
  TechnologyGlyph,
  type FingerprintIconEntry,
} from "../reportVisualRegistry";
import { type ModuleConfig } from "../config/modules";
import { portalApiFetch as apiFetch } from "../shared/api/portalApi";
import { EMPTY_DATA_DESCRIPTION, EMPTY_DATA_TITLE } from "../shared/emptyState";
import { NewCornerBadge, TodayCountBadge } from "../shared/TodayNewBar";
import { ModuleHeader } from "../shared/ModuleHeader";
import { isTodayNew, todayStartIso } from "../lib/today";
import {
  downloadCsv,
  fetchAllPages,
  type CsvColumn,
} from "../shared/exportCsv";
import { SequenceCell, SequenceHeader } from "../shared/SequenceCell";
import { PageSizeSelect } from "../shared/PageSizeSelect";
import {
  ListViewControls,
  ListViewFrame,
  SortableResizableHeader,
  listViewGridStyle,
  sortListItems,
  useListViewPreferences,
  type ListViewColumn,
} from "../shared/ListViewControls";

const reportSectionMeta: Record<
  HtmlReportSection,
  { label: string; icon: typeof Globe2; description: string }
> = {
  web: {
    label: "Web资产",
    icon: Globe2,
    description: "网站、状态码、证书、应用指纹与资产归属",
  },
  ports: {
    label: "端口",
    icon: Network,
    description: "IP、端口、协议、存活状态与 Banner",
  },
  dns: {
    label: "DNS",
    icon: Network,
    description: "子域名、IP、CNAME 与资产归属",
  },
  fingerprints: {
    label: "指纹列表",
    icon: Fingerprint,
    description: "应用、框架和信息指纹统计",
  },
  icons: {
    label: "图标统计",
    icon: CircleGauge,
    description: "favicon MD5、图标数据与命中数量",
  },
};
const reportFieldLabels: Record<string, string> = {
  change_status: "变更状态",
  asset: "资产入口",
  state: "响应状态",
  url: "URL",
  alive: "存活状态",
  status_code: "状态码",
  title: "站点标题",
  cert_subject_cn: "证书域名",
  domain: "域名",
  root_domain: "根域名",
  ip: "IP",
  port: "端口",
  port_service: "端口 / 服务",
  protocol: "协议",
  icon_hash_md5: "图标哈希",
  md5: "图标 MD5",
  app_products: "应用指纹",
  framework_products: "信息指纹",
  application: "应用指纹信息",
  registration_unit: "ICP备案单位",
  discovery_chain: "发现路径",
  ip_location: "IP归属地",
  geo: "地址位置",
  country: "国家",
  carrier: "网络 / 云服务",
  updated_at: "更新时间",
  company_path: "资产归属",
  banner: "Banner",
  cnames: "CNAME",
  ips: "IP列表",
  subdomain: "子域名",
  key: "指纹名称",
  name: "名称",
  nameAndType: "名称 / 类型",
  type: "类型",
  count: "命中数量",
  icon: "图标数据",
};
const reportDefaultColumns: Record<HtmlReportSection, string[]> = {
  web: [
    "change_status",
    "ip",
    "port_service",
    "domain",
    "url",
    "alive",
    "status_code",
    "title",
    "application",
    "company_path",
    "geo",
    "carrier",
  ],
  ports: [
    "change_status",
    "ip",
    "port_service",
    "alive",
    "banner",
    "company_path",
    "updated_at",
  ],
  dns: [
    "change_status",
    "root_domain",
    "subdomain",
    "ips",
    "cnames",
    "company_path",
    "updated_at",
  ],
  fingerprints: ["change_status", "nameAndType", "type", "count"],
  icons: ["change_status", "icon", "md5", "count"],
};
const reportDisplayColumnOrder: Record<HtmlReportSection, string[]> = {
  web: [
    ...reportDefaultColumns.web,
    "port",
    "cert_subject_cn",
    "icon_hash_md5",
    "app_products",
    "framework_products",
    "discovery_chain",
    "ip_location",
    "updated_at",
  ],
  ports: [...reportDefaultColumns.ports, "port", "protocol"],
  dns: [...reportDefaultColumns.dns],
  fingerprints: [...reportDefaultColumns.fingerprints, "key"],
  icons: [...reportDefaultColumns.icons],
};
const reportDetailWideFields = new Set([
  "url",
  "company_path",
  "app_products",
  "framework_products",
  "application",
  "geo",
  "banner",
  "ips",
  "cnames",
  "discovery_chain",
  "icon",
]);
const reportDetailMonoFields = new Set([
  "ip",
  "port",
  "port_service",
  "protocol",
  "domain",
  "root_domain",
  "subdomain",
  "url",
  "md5",
  "icon_hash_md5",
  "cert_subject_cn",
]);
const reportDefaultHiddenColumns = Object.fromEntries(
  (Object.keys(reportDefaultColumns) as HtmlReportSection[]).map((section) => [
    section,
    reportDisplayColumnOrder[section].filter(
      (column) => !reportDefaultColumns[section].includes(column),
    ),
  ]),
) as Record<HtmlReportSection, string[]>;
function reportFieldLabel(key: string) {
  return reportFieldLabels[key] || key.replaceAll("_", " ");
}
function reportRootDomain(value: unknown) {
  const hostname = String(value || "")
    .toLowerCase()
    .replace(/^\.+|\.+$/g, "");
  const parts = hostname.split(".").filter(Boolean);
  if (parts.length <= 2) return hostname;
  const suffix = parts.slice(-2).join(".");
  return new Set([
    "com.cn",
    "net.cn",
    "org.cn",
    "gov.cn",
    "co.uk",
    "com.au",
    "co.jp",
  ]).has(suffix)
    ? parts.slice(-3).join(".")
    : suffix;
}
function reportGeoField(
  row: Record<string, unknown>,
  field: "location" | "country" | "carrier",
) {
  if (row.geo && typeof row.geo === "object" && field in row.geo)
    return String((row.geo as Record<string, unknown>)[field] || "");
  if (field === "location") return String(row.ip_location || "");
  return "";
}
function reportNameList(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) =>
      typeof item === "string"
        ? item
        : item && typeof item === "object" && "name" in item
          ? String(item.name || "")
          : "",
    )
    .filter(Boolean);
}
function reportCellValue(value: unknown, key: string) {
  if (value === null || value === undefined || value === "") return "";
  if (key === "alive") {
    const normalized = String(value).trim().toLowerCase();
    if (["true", "1", "alive", "up", "存活"].includes(normalized)) return "存活";
    if (["false", "0", "dead", "down", "未存活"].includes(normalized)) return "未存活";
  }
  if (
    key === "icon" &&
    typeof value === "string" &&
    value.startsWith("data:image")
  )
    return "图标数据";
  if (key === "app_products" || key === "framework_products")
    return reportNameList(value).join("、");
  if (Array.isArray(value))
    return value
      .map((item) =>
        typeof item === "object" ? JSON.stringify(item) : String(item),
      )
      .join("、");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
function reportDisplayValue(
  row: Record<string, unknown>,
  key: string,
): unknown {
  if (key === "change_status") return row._change_type || "";
  if (key === "asset")
    return [
      row.domain || row.ip,
      row.url,
      reportDisplayValue(row, "port_service"),
    ]
      .filter(Boolean)
      .join(" | ");
  if (key === "state")
    return [row.alive, row.status_code].filter(Boolean).join(" | ");
  if (key === "port_service") {
    let protocol = "";
    try {
      protocol = new URL(String(row.url || "")).protocol.replace(":", "");
    } catch {
      protocol = String(row.protocol || "");
    }
    return [row.port, protocol].filter(Boolean).join(" / ");
  }
  if (key === "registration_unit")
    return row.registration_unit || row.icp_company || "";
  if (key === "application")
    return [
      ...reportNameList(row.app_products),
      ...reportNameList(row.framework_products),
    ].join("、");
  if (key === "company_path")
    return (
      String(row.company_path || "")
        .split(/->|→/)
        .at(-1)
        ?.trim() || ""
    );
  if (key === "root_domain")
    return reportRootDomain(row.subdomain || row.domain);
  if (key === "geo") return reportGeoField(row, "location");
  if (key === "country") return reportGeoField(row, "country");
  if (key === "carrier") return reportGeoField(row, "carrier");
  return row[key];
}
function reportExportCell(value: unknown, key: string) {
  return reportCellValue(value, key)
    .replaceAll('"', '""')
    .replaceAll("\n", " ");
}

function AliveStatusBadge({ value }: { value: unknown }) {
  const text = reportCellValue(value, "alive");
  if (!text) return null;
  const tone =
    text === "存活" ? "success" : text === "未存活" ? "danger" : "muted";
  return (
    <span className={`html-status-badge alive-${tone}`}>
      <span className="html-status-dot" aria-hidden="true" />
      <span>{text}</span>
    </span>
  );
}

function StatusCodeBadge({ value }: { value: unknown }) {
  const text = reportCellValue(value, "status_code");
  if (!text) return null;
  return (
    <span className={`html-status-badge status-${statusCodeTone(value)}`}>
      <small aria-hidden="true">HTTP</small>
      <strong>{text}</strong>
    </span>
  );
}

type AssetChangeType = NonNullable<AssetRecord["changeType"]>;

const assetChangeMeta: Record<
  AssetChangeType,
  { label: string; tone: "default" | "green" | "orange" | "pink" | "cyan" }
> = {
  baseline: { label: "初始基线", tone: "default" },
  new: { label: "新增资产", tone: "green" },
  changed: { label: "状态变化", tone: "pink" },
  reappeared: { label: "重新出现", tone: "cyan" },
  missing: { label: "已消失", tone: "orange" },
  unchanged: { label: "未变化", tone: "default" },
};
const assetChangeFilterOrder: AssetChangeType[] = [
  "changed",
  "missing",
  "new",
  "reappeared",
  "baseline",
  "unchanged",
];

function AssetChangeBadge({
  changeType,
  summary,
}: {
  changeType: unknown;
  summary?: unknown;
}) {
  if (!changeType || !(String(changeType) in assetChangeMeta)) return null;
  const meta = assetChangeMeta[String(changeType) as AssetChangeType];
  const detail = reportCellValue(summary, "change_summary");
  return (
    <span className="asset-change-status" title={detail || meta.label}>
      <Tag tone={meta.tone}>{meta.label}</Tag>
      {detail ? <small>{detail}</small> : null}
    </span>
  );
}

function HtmlReportDetailValue({
  row,
  fieldKey,
  value,
}: {
  row: Record<string, unknown>;
  fieldKey: string;
  value: unknown;
}) {
  const text =
    fieldKey === "geo"
      ? reportGeoField(row, "location")
      : reportCellValue(value, fieldKey);
  if (!text) return <span className="html-detail-empty">--</span>;
  if (
    fieldKey === "icon" &&
    typeof value === "string" &&
    value.startsWith("data:image")
  )
    return <img className="html-detail-icon" src={value} alt="favicon 原图" />;
  if (
    fieldKey === "app_products" ||
    fieldKey === "framework_products" ||
    fieldKey === "application"
  ) {
    const names =
      fieldKey === "application"
        ? [
            ...reportNameList(row.app_products),
            ...reportNameList(row.framework_products),
          ]
        : reportNameList(value);
    return (
      <span className="html-technology-list html-detail-technology-list">
        {names.map((name, index) => (
          <span
            className="html-technology-chip"
            title={name}
            key={`${name}-${index}`}
          >
            <TechnologyGlyph name={name} />
            <em>{name}</em>
          </span>
        ))}
      </span>
    );
  }
  if (fieldKey === "company_path") {
    const company = String(reportDisplayValue(row, fieldKey) || text);
    return (
      <span className="html-organization" title={company}>
        <OrganizationGlyph name={company} />
        <span>{company}</span>
      </span>
    );
  }
  if (fieldKey === "carrier")
    return (
      <span className="html-provider" title={text}>
        <ProviderGlyph name={text} />
        <span>{text}</span>
      </span>
    );
  if (fieldKey === "geo") {
    const country = reportGeoField(row, "country");
    const carrier = reportGeoField(row, "carrier");
    return (
      <span className="html-detail-geo">
        <span className="html-location" title={text}>
          {country ? <CountryFlag country={country} /> : null}
          <span>{text}</span>
        </span>
        {carrier ? (
          <span className="html-provider" title={carrier}>
            <ProviderGlyph name={carrier} />
            <span>{carrier}</span>
          </span>
        ) : null}
      </span>
    );
  }
  if (fieldKey === "status_code") return <StatusCodeBadge value={value} />;
  if (fieldKey === "alive") return <AliveStatusBadge value={value} />;
  if (fieldKey === "url" && /^https?:\/\//i.test(text))
    return (
      <a
        className="html-asset-url"
        href={text}
        target="_blank"
        rel="noreferrer"
      >
        <span>{text}</span>
        <SquareArrowOutUpRight size={12} />
      </a>
    );
  return <span>{text}</span>;
}

function statusCodeTone(value: unknown) {
  const code = Number(value);
  if (code >= 200 && code < 300) return "success";
  if (code >= 300 && code < 400) return "redirect";
  if (code >= 400 && code < 500) return "warning";
  if (code >= 500) return "danger";
  return "muted";
}
const reportStickyColumns: Record<HtmlReportSection, string[]> = {
  web: ["ip"],
  ports: ["ip"],
  dns: ["root_domain", "subdomain"],
  fingerprints: [],
  icons: [],
};
function reportColumnClass(section: HtmlReportSection, column: string) {
  const fixedIndex = reportStickyColumns[section].indexOf(column);
  return cn(
    `html-report-column-${column.replaceAll("_", "-")}`,
    fixedIndex >= 0 && `html-report-fixed-col-${fixedIndex + 1}`,
  );
}

const assetCategoryMeta: Record<
  AssetCategory,
  { label: string; description: string }
> = {
  subdomain: {
    label: "DNS / 子域名",
    description: "根域名、子域名与解析 IP / 别名",
  },
  server: {
    label: "端口 / 服务器",
    description: "IP 地址、服务、协议、端口与风险标记",
  },
  web: {
    label: "Web资产",
    description: "URL、状态码、站点标题、应用组件与备案信息",
  },
  fingerprint: {
    label: "指纹列表",
    description: "产品指纹、图标 MD5 与命中数量",
  },
};

function assetField(record: AssetRecord, ...keys: string[]) {
  for (const key of keys) if (record.fields[key]) return record.fields[key];
  return "";
}

function assetTime(value: string) {
  return value
    .replace("T", " ")
    .replace(/\.\d{3}Z$/, "")
    .slice(0, 19);
}

const assetListLabels: Record<AssetCategory, string[]> = {
  subdomain: [
    "序号",
    "变更状态",
    "根域名",
    "子域名",
    "IP / 别名",
    "发现时间",
  ],
  server: [
    "序号",
    "变更状态",
    "服务器地址",
    "服务类型",
    "协议",
    "端口",
    "风险标记",
    "发现时间",
    "备注",
  ],
  web: [
    "序号",
    "变更状态",
    "URL",
    "IP / 域名",
    "协议 / 端口",
    "状态码",
    "标题 / 应用",
    "风险标记",
    "发现时间",
    "备注",
  ],
  fingerprint: [
    "序号",
    "变更状态",
    "指纹类型",
    "指纹名称",
    "产品类型",
    "命中数量",
    "来源",
    "发现时间",
  ],
};
const assetWidthByLabel: Record<string, number> = {
  序号: 64,
  变更状态: 150,
  根域名: 180,
  子域名: 270,
  "IP / 别名": 400,
  发现时间: 150,
  服务器地址: 180,
  服务类型: 130,
  协议: 90,
  端口: 90,
  风险标记: 110,
  备注: 180,
  URL: 280,
  "IP / 域名": 180,
  "协议 / 端口": 120,
  状态码: 90,
  "标题 / 应用": 220,
  指纹类型: 130,
  指纹名称: 240,
  产品类型: 150,
  命中数量: 110,
  来源: 160,
};
const assetListColumns = (category: AssetCategory): ListViewColumn[] =>
  assetListLabels[category].map((label, index) => ({
    id: `column-${index + 1}`,
    label,
    defaultWidth: assetWidthByLabel[label] || 150,
    minWidth: label === "序号" ? 56 : 80,
  }));

function SyncedAssetRecordsView() {
  const categories = Object.keys(assetCategoryMeta) as AssetCategory[];
  const [searchParams, setSearchParams] = useSearchParams();
  const todayOnly = searchParams.get("today") === "1";
  const since = todayStartIso();
  const [activeCategory, setActiveCategory] =
    useState<AssetCategory>("subdomain");
  const [records, setRecords] = useState<AssetRecord[]>([]);
  const [totals, setTotals] = useState<Record<AssetCategory, number>>({
    subdomain: 0,
    server: 0,
    web: 0,
    fingerprint: 0,
  });
  const [todayTotals, setTodayTotals] = useState<Record<AssetCategory, number>>(
    { subdomain: 0, server: 0, web: 0, fingerprint: 0 },
  );
  const [resultTotal, setResultTotal] = useState(0);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [pageSize, setPageSize] = useState(50);
  const listColumns = useMemo(
    () => assetListColumns(activeCategory),
    [activeCategory],
  );
  const listView = useListViewPreferences(
    `synced-assets-${activeCategory}`,
    listColumns,
  );

  useEffect(() => {
    let active = true;
    Promise.all(
      categories.map((category) =>
        apiFetch<AssetRecordsPageResult>(
          `/api/assets/records?category=${category}&page=1&page_size=1&since=${encodeURIComponent(since)}`,
        ),
      ),
    )
      .then((results) => {
        if (!active) return;
        setTotals(
          Object.fromEntries(
            categories.map((category, index) => [
              category,
              results[index].allTotal ?? results[index].total,
            ]),
          ) as Record<AssetCategory, number>,
        );
        const nextTodayTotals = Object.fromEntries(
          categories.map((category, index) => [
            category,
            results[index].todayNewCount ?? 0,
          ]),
        ) as Record<AssetCategory, number>;
        setTodayTotals(nextTodayTotals);
        if (todayOnly && nextTodayTotals[activeCategory] === 0) {
          const firstWithNewRecords = categories.find(
            (category) => nextTodayTotals[category] > 0,
          );
          if (firstWithNewRecords) {
            setActiveCategory(firstWithNewRecords);
            setPage(1);
          }
        }
      })
      .catch((loadError) => {
        if (active)
          setError(
            loadError instanceof Error ? loadError.message : "资产统计加载失败",
          );
      });
    return () => {
      active = false;
    };
  }, [since, todayOnly]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    apiFetch<AssetRecordsPageResult>(
      `/api/assets/records?category=${activeCategory}&page=${page}&page_size=${pageSize}&since=${encodeURIComponent(since)}${todayOnly ? "&today_only=1" : ""}`,
    )
      .then((result) => {
        if (active) {
          setRecords(result.data);
          setResultTotal(result.total);
        }
      })
      .catch((loadError) => {
        if (active)
          setError(
            loadError instanceof Error ? loadError.message : "同步资产加载失败",
          );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [activeCategory, page, pageSize, since, todayOnly]);

  const needle = query.trim().toLocaleLowerCase();
  const filtered = needle
    ? records.filter((record) =>
        `${record.title} ${Object.values(record.fields).join(" ")}`
          .toLocaleLowerCase()
          .includes(needle),
      )
    : records;
  const sortedRecords = sortListItems(
    filtered,
    listView.sort,
    Object.fromEntries(
      listColumns.map((column) => [
        column.id,
        (record: AssetRecord) => {
          if (column.label === "序号") return record.id;
          if (column.label === "发现时间") return record.lastSeenAt;
          const keys: Record<string, string[]> = {
            变更状态: [],
            根域名: ["rootDomain"],
            子域名: ["subdomain"],
            "IP / 别名": ["ipAlias", "ips", "cnames"],
            服务器地址: ["address"],
            服务类型: ["serviceType"],
            协议: ["protocol"],
            端口: ["port"],
            风险标记: ["riskFlag"],
            备注: ["note"],
            URL: ["url"],
            "IP / 域名": ["ipAddress", "domain"],
            "协议 / 端口": ["protocol", "port"],
            状态码: ["statusCode"],
            "标题 / 应用": ["title", "application"],
            指纹类型: ["fingerprintType"],
            指纹名称: ["name"],
            产品类型: ["productType", "iconHashMd5"],
            命中数量: ["count"],
            来源: ["dataSource"],
          };
          if (column.label === "变更状态") return record.changeType || "";
          return assetField(record, ...(keys[column.label] || [])) || record.title;
        },
      ]),
    ),
  );
  const total = resultTotal;
  const moduleTodayTotal = Object.values(todayTotals).reduce(
    (sum, value) => sum + value,
    0,
  );
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const toggleToday = () => {
    const next = new URLSearchParams(searchParams);
    if (todayOnly) next.delete("today");
    else next.set("today", "1");
    setPage(1);
    setQuery("");
    setSearchParams(next, { replace: true });
  };

  return (
    <div className="asset-structured-view">
      <section className="module-kpi-grid" aria-label="同步资产核心指标">
        <div className="module-kpi">
          <span>资产总量</span>
          <strong>
            {Object.values(totals)
              .reduce((sum, value) => sum + value, 0)
              .toLocaleString("zh-CN")}
          </strong>
          <small className="metric-info">本地快照投影</small>
        </div>
        <div className="module-kpi">
          <span>子域名资产</span>
          <strong>{totals.subdomain.toLocaleString("zh-CN")}</strong>
          <small className="metric-success">域名与解析关系</small>
        </div>
        <div className="module-kpi">
          <span>服务器资产</span>
          <strong>{totals.server.toLocaleString("zh-CN")}</strong>
          <small className="metric-critical">服务与端口</small>
        </div>
        <div className="module-kpi">
          <span>Web资产</span>
          <strong>{totals.web.toLocaleString("zh-CN")}</strong>
          <small className="metric-high">站点与应用组件</small>
        </div>
      </section>
      <section className="asset-category-tabs" aria-label="资产类型">
        {categories.map((category) => (
          <button
            type="button"
            key={category}
            className={activeCategory === category ? "active" : ""}
            aria-pressed={activeCategory === category}
            onClick={() => {
              setActiveCategory(category);
              setPage(1);
              setQuery("");
            }}
          >
            <span>
              <strong>{assetCategoryMeta[category].label}</strong>
              <small>
                {todayOnly
                  ? "今日首次进入平台"
                  : assetCategoryMeta[category].description}
              </small>
            </span>
            <span className="related-counts">
              {!todayOnly && (
                <em>{totals[category].toLocaleString("zh-CN")}</em>
              )}
              {(todayOnly || todayTotals[category] > 0) && (
                <TodayCountBadge count={todayTotals[category]} />
              )}
            </span>
          </button>
        ))}
      </section>
      <Panel
        className="asset-record-panel"
        title={
          <span className="section-title">
            <Database size={17} /> {assetCategoryMeta[activeCategory].label}{" "}
            <em>{total.toLocaleString("zh-CN")}</em>
          </span>
        }
        action={
          <div className="asset-panel-actions">
            <div className="sensitive-inline-search">
              <Search size={16} />
              <input
                aria-label="搜索当前页资产"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索域名、IP、URL、端口或应用"
              />
            </div>
            <ListViewControls
              columns={listColumns}
              hidden={listView.hidden}
              onToggleColumn={listView.toggleColumn}
              onReset={listView.reset}
            />
          </div>
        }
      >
        {error ? (
          <EmptyState
            icon={<TriangleAlert size={32} />}
            title="同步资产加载失败"
            description={error}
          />
        ) : loading ? (
          <div className="skeleton-list">
            {Array.from({ length: 6 }).map((_, index) => (
              <div className="skeleton-row" key={index} />
            ))}
          </div>
        ) : !filtered.length ? (
          <EmptyState
            icon={<Globe2 size={32} />}
            title={EMPTY_DATA_TITLE}
            description={
              needle
                ? "当前页没有匹配记录，请清空搜索条件或切换分页。"
                : EMPTY_DATA_DESCRIPTION
            }
          />
        ) : (
          <ListViewFrame hidden={listView.hidden}>
            <div
              className={`asset-record-table asset-record-${activeCategory}`}
              style={listViewGridStyle(listColumns, listView.widths)}
              role="table"
              aria-label={assetCategoryMeta[activeCategory].label}
            >
              <div className="asset-record-head" role="row">
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
              {sortedRecords.map((record, index) => (
                <div
                  className={cn(
                    "asset-record-row",
                    isTodayNew(record.firstSeenAt) && "record-is-new",
                  )}
                  role="row"
                  key={record.id}
                >
                  {isTodayNew(record.firstSeenAt) && <NewCornerBadge />}
                  <SequenceCell value={(page - 1) * pageSize + index + 1} />
                  <AssetChangeBadge
                    changeType={record.changeType}
                    summary={
                      record.changeType === "missing"
                        ? "最新清单中已不再出现"
                        : record.changeType === "reappeared"
                          ? "曾经消失的资产再次出现"
                          : undefined
                    }
                  />
                  {activeCategory === "subdomain" ? (
                    <>
                      <strong>
                        {assetField(record, "rootDomain") || "--"}
                      </strong>
                      <code>
                        {assetField(record, "subdomain") ||
                          record.title ||
                          "--"}
                      </code>
                      <span>
                        {assetField(record, "ipAlias", "ips", "cnames") || "--"}
                      </span>
                      <time>{assetTime(record.lastSeenAt)}</time>
                    </>
                  ) : activeCategory === "server" ? (
                    <>
                      <code>
                        {assetField(record, "address") || record.title || "--"}
                      </code>
                      <span>{assetField(record, "serviceType") || "--"}</span>
                      <span>{assetField(record, "protocol") || "--"}</span>
                      <code>{assetField(record, "port") || "--"}</code>
                      <Tag
                        tone={assetField(record, "riskFlag") ? "pink" : "green"}
                      >
                        {assetField(record, "riskFlag") || "未标记"}
                      </Tag>
                      <time>{assetTime(record.lastSeenAt)}</time>
                      <span>{assetField(record, "note") || "--"}</span>
                    </>
                  ) : activeCategory === "web" ? (
                    <>
                      <code>
                        {assetField(record, "url") || record.title || "--"}
                      </code>
                      <div>
                        <strong>
                          {assetField(record, "ipAddress") || "--"}
                        </strong>
                        <small>
                          {assetField(record, "domain") || "未关联域名"}
                        </small>
                      </div>
                      <span>
                        {assetField(record, "protocol") || "--"} /{" "}
                        {assetField(record, "port") || "--"}
                      </span>
                      <code>{assetField(record, "statusCode") || "--"}</code>
                      <div>
                        <strong>
                          {assetField(record, "title") ||
                            record.title ||
                            "未命名站点"}
                        </strong>
                        <small>
                          {assetField(record, "application") || "未识别组件"}
                        </small>
                      </div>
                      <Tag
                        tone={assetField(record, "riskFlag") ? "pink" : "green"}
                      >
                        {assetField(record, "riskFlag") || "未标记"}
                      </Tag>
                      <time>{assetTime(record.lastSeenAt)}</time>
                      <span>{assetField(record, "note") || "--"}</span>
                    </>
                  ) : (
                    <>
                      <Tag tone="cyan">
                        {assetField(record, "fingerprintType") || "指纹"}
                      </Tag>
                      <span className="html-technology-chip html-fingerprint-name">
                        <TechnologyGlyph
                          name={
                            assetField(record, "name") || record.title || ""
                          }
                        />
                        <em>
                          {assetField(record, "name") || record.title || "--"}
                        </em>
                      </span>
                      <span>
                        {assetField(record, "productType", "iconHashMd5") ||
                          "--"}
                      </span>
                      <code>{assetField(record, "count") || "--"}</code>
                      <span>{assetField(record, "dataSource") || "HTML"}</span>
                      <time>{assetTime(record.lastSeenAt)}</time>
                    </>
                  )}
                </div>
              ))}
            </div>
          </ListViewFrame>
        )}
        <footer className="credential-pagination">
          <span>
            第 {page} / {totalPages} 页，共 {total.toLocaleString("zh-CN")}{" "}
            条资产
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
      </Panel>
    </div>
  );
}

export function HtmlAssetReportPage({ config }: { config: ModuleConfig }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const todayOnly = searchParams.get("today") === "1";
  const since = todayStartIso();
  const requestedSection = searchParams.get("section");
  const initialSection: HtmlReportSection = [
    "web",
    "ports",
    "dns",
    "fingerprints",
    "icons",
  ].includes(requestedSection || "")
    ? (requestedSection as HtmlReportSection)
    : "web";
  const emptyFacets: HtmlReportSectionResult["facets"] = {
    ports: [],
    domains: [],
    protocols: [],
    components: [],
    alive: [],
    statusCodes: [],
    changeTypes: [],
    icons: [],
  };
  const [report, setReport] = useState<AssetReport | null>(null);
  const [section, setSection] = useState<HtmlReportSection>(initialSection);
  const [rows, setRows] = useState<Array<Record<string, unknown>>>([]);
  const [columns, setColumns] = useState<string[]>([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [total, setTotal] = useState(0);
  const [query, setQuery] = useState(searchParams.get("query") || "");
  const [queryDraft, setQueryDraft] = useState(searchParams.get("query") || "");
  const [sort, setSort] = useState("");
  const [direction, setDirection] = useState<"asc" | "desc">("desc");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [iconPreview, setIconPreview] = useState<string | null>(null);
  const [facets, setFacets] =
    useState<HtmlReportSectionResult["facets"]>(emptyFacets);
  const [fingerprintType, setFingerprintType] = useState<
    "全部" | "应用指纹" | "信息指纹"
  >("全部");
  const [aliveFilter, setAliveFilter] = useState("全部");
  const [statusCodeFilter, setStatusCodeFilter] = useState("全部");
  const [changeTypeFilter, setChangeTypeFilter] = useState("全部");
  const [portFilter, setPortFilter] = useState("全部");
  const [protocolFilter, setProtocolFilter] = useState("全部");
  const [domainFilter, setDomainFilter] = useState("全部");
  const [componentFilter, setComponentFilter] = useState("全部");
  const [detailRow, setDetailRow] = useState<Record<string, unknown> | null>(
    null,
  );
  const detailCloseRef = useRef<HTMLButtonElement>(null);
  const [columnSettingsOpen, setColumnSettingsOpen] = useState(false);
  const [hiddenColumns, setHiddenColumns] = useState<
    Record<HtmlReportSection, string[]>
  >(reportDefaultHiddenColumns);
  const [collapsedFacets, setCollapsedFacets] = useState<
    Record<string, boolean>
  >({});
  const [rankingsCollapsed, setRankingsCollapsed] = useState(false);
  const [fingerprintIcons, setFingerprintIcons] = useState<
    FingerprintIconEntry[]
  >([]);
  const [selectedRowIds, setSelectedRowIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState("");
  const tableWrapRef = useRef<HTMLDivElement | null>(null);
  const detailFields = useMemo(() => {
    if (!detailRow) return [];
    const fieldOrder = reportDisplayColumnOrder[section];
    return Object.entries(detailRow)
      .filter(([key]) => !key.startsWith("_"))
      .sort(([left], [right]) => {
        const leftIndex = fieldOrder.indexOf(left);
        const rightIndex = fieldOrder.indexOf(right);
        return (
          (leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex) -
          (rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex)
        );
      });
  }, [detailRow, section]);
  const DetailSectionIcon = reportSectionMeta[section].icon;
  const detailTitle = detailRow
    ? reportCellValue(
        detailRow.title ||
          detailRow.url ||
          detailRow.ip ||
          detailRow.subdomain ||
          detailRow.key,
        "title",
      ) || "资产详情"
    : "资产详情";
  useEffect(() => {
    if (!detailRow) return;
    const previousOverflow = document.body.style.overflow;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDetailRow(null);
    };
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", closeOnEscape);
    requestAnimationFrame(() => detailCloseRef.current?.focus());
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [detailRow]);
  useEffect(() => {
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") setRefreshKey((value) => value + 1);
    };
    window.addEventListener("focus", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.removeEventListener("focus", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, []);
  const reportDataPath = (nextPage: number, nextPageSize: number) => {
    const params = new URLSearchParams({
      section,
      page: String(nextPage),
      page_size: String(nextPageSize),
      query,
      search_field: "all",
      sort,
      direction,
      fingerprint_type: fingerprintType === "全部" ? "" : fingerprintType,
      alive:
        (section === "web" || section === "ports") && aliveFilter !== "全部"
          ? aliveFilter
          : "",
      status_code:
        section === "web" && statusCodeFilter !== "全部"
          ? statusCodeFilter
          : "",
      change_type: changeTypeFilter === "全部" ? "" : changeTypeFilter,
      port:
        (section === "web" || section === "ports") && portFilter !== "全部"
          ? portFilter
          : "",
      protocol:
        (section === "web" || section === "ports") && protocolFilter !== "全部"
          ? protocolFilter
          : "",
      domain:
        (section === "web" || section === "dns") && domainFilter !== "全部"
          ? domainFilter
          : "",
      component:
        (section === "web" || section === "fingerprints") &&
        componentFilter !== "全部"
          ? componentFilter
          : "",
      since,
    });
    if (todayOnly) params.set("today_only", "1");
    return `/api/assets/reports/latest/data?${params.toString()}`;
  };
  const loadSection = async () => {
    setLoading(true);
    setError("");
    try {
      const result = await apiFetch<HtmlReportSectionResult>(
        reportDataPath(page, pageSize),
      );
      setReport(result.report);
      setRows(result.data);
      setColumns(result.columns);
      setTotal(result.total);
      setFacets(result.facets || emptyFacets);
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : "报告数据加载失败",
      );
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void loadSection();
  }, [
    section,
    page,
    pageSize,
    query,
    sort,
    direction,
    fingerprintType,
    aliveFilter,
    statusCodeFilter,
    changeTypeFilter,
    portFilter,
    protocolFilter,
    domainFilter,
    componentFilter,
    todayOnly,
    refreshKey,
  ]);
  useEffect(() => {
    tableWrapRef.current?.scrollTo({ left: 0, top: 0 });
  }, [section]);
  useEffect(() => {
    setSelectedRowIds(new Set());
  }, [
    section,
    page,
    query,
    sort,
    direction,
    fingerprintType,
    aliveFilter,
    statusCodeFilter,
    changeTypeFilter,
    portFilter,
    protocolFilter,
    domainFilter,
    componentFilter,
    todayOnly,
  ]);
  useEffect(() => {
    apiFetch<AssetReport | null>(
      `/api/assets/reports/latest?since=${encodeURIComponent(since)}`,
    )
      .then((value) => setReport(value))
      .catch(() => undefined);
  }, [since, refreshKey]);
  useEffect(() => {
    apiFetch<{ entries: FingerprintIconEntry[] }>("/api/fingerprint-icons/map")
      .then((value) => setFingerprintIcons(value.entries || []))
      .catch(() => setFingerprintIcons([]));
  }, []);
  const selectSection = (value: HtmlReportSection) => {
    setSection(value);
    setPage(1);
    setQuery("");
    setQueryDraft("");
    setSort("");
    setDirection("desc");
    setFingerprintType("全部");
    setAliveFilter("全部");
    setStatusCodeFilter("全部");
    setChangeTypeFilter("全部");
    setPortFilter("全部");
    setProtocolFilter("全部");
    setDomainFilter("全部");
    setComponentFilter("全部");
  };
  const toggleToday = () => {
    const next = new URLSearchParams(searchParams);
    if (todayOnly) next.delete("today");
    else next.set("today", "1");
    setPage(1);
    setQuery("");
    setQueryDraft("");
    setFingerprintType("全部");
    setAliveFilter("全部");
    setStatusCodeFilter("全部");
    setChangeTypeFilter("全部");
    setPortFilter("全部");
    setProtocolFilter("全部");
    setDomainFilter("全部");
    setComponentFilter("全部");
    setSearchParams(next, { replace: true });
  };
  const applySearch = (event: FormEvent) => {
    event.preventDefault();
    setPage(1);
    setQuery(queryDraft.trim());
  };
  const toggleSort = (column: string) => {
    const nextDirection =
      sort === column && direction === "desc" ? "asc" : "desc";
    setSort(column);
    setDirection(nextDirection);
    setPage(1);
  };
  const applyFacet = (
    facet: "ports" | "components" | "domains" | "protocols" | "icons",
    value: string,
  ) => {
    if (facet === "ports") setPortFilter(value);
    if (facet === "protocols") setProtocolFilter(value);
    if (facet === "domains") setDomainFilter(value);
    if (facet === "components") setComponentFilter(value);
    if (facet === "icons") {
      setQuery(value);
      setQueryDraft(value);
    }
    setPage(1);
    setSort("");
    setDirection("desc");
  };
  const viewAssets = (value: string) => {
    if (!value) return;
    setSection("web");
    setPage(1);
    setQuery(section === "fingerprints" ? "" : value);
    setQueryDraft(section === "fingerprints" ? "" : value);
    setSort("");
    setDirection("desc");
    setFingerprintType("全部");
    setAliveFilter("全部");
    setStatusCodeFilter("全部");
    setChangeTypeFilter("全部");
    setPortFilter("全部");
    setProtocolFilter("全部");
    setDomainFilter("全部");
    setComponentFilter(section === "fingerprints" ? value : "全部");
  };
  const resetFilters = () => {
    setQuery("");
    setQueryDraft("");
    setFingerprintType("全部");
    setAliveFilter("全部");
    setStatusCodeFilter("全部");
    setChangeTypeFilter("全部");
    setPortFilter("全部");
    setProtocolFilter("全部");
    setDomainFilter("全部");
    setComponentFilter("全部");
    setPage(1);
  };
  const orderedColumns = useMemo(
    () => [
      ...reportDisplayColumnOrder[section],
      ...columns.filter(
        (column) => !reportDisplayColumnOrder[section].includes(column),
      ),
    ],
    [columns, section],
  );
  const visibleColumns = orderedColumns.filter(
    (column) => !hiddenColumns[section].includes(column),
  );
  const reportTableColumns = useMemo<ListViewColumn[]>(
    () =>
      visibleColumns.map((column) => ({
        id: column,
        label: reportFieldLabel(column),
        defaultWidth:
          column === "change_status"
            ? 190
            : column === "asset"
            ? 360
            : column === "state"
              ? 140
              : ["title", "banner", "application"].includes(column)
                ? 260
                : ["company_path", "carrier"].includes(column)
                  ? 220
                  : 170,
        minWidth: 84,
      })),
    [visibleColumns.join("|")],
  );
  const reportTableView = useListViewPreferences(
    `asset-report-${section}`,
    reportTableColumns,
  );
  const isAssetReferenceSection =
    section === "fingerprints" || section === "icons";
  const rowId = (row: Record<string, unknown>, index: number) =>
    String(row._record_id || row.id || `${section}-${page}-${index}`);
  const selectedCount = rows.filter((row, index) =>
    selectedRowIds.has(rowId(row, index)),
  ).length;
  const currentPageAllSelected =
    Boolean(rows.length) &&
    rows.every((row, index) => selectedRowIds.has(rowId(row, index)));
  const reportExportColumns: Array<CsvColumn<Record<string, unknown>>> =
    visibleColumns.map((column) => ({
      header: reportFieldLabel(column),
      value: (row) => reportExportCell(reportDisplayValue(row, column), column),
    }));
  const downloadReportRows = (
    items: Array<Record<string, unknown>>,
    scope: "selected" | "all",
  ) =>
    downloadCsv(
      `asset-report-${section}-${scope === "selected" ? "selected" : "all"}-${new Date().toISOString().slice(0, 10)}.csv`,
      reportExportColumns,
      items,
    );
  const exportSelected = () => {
    const selectedRows = rows.filter((row, index) =>
      selectedRowIds.has(rowId(row, index)),
    );
    if (selectedRows.length) downloadReportRows(selectedRows, "selected");
  };
  const exportAll = async () => {
    setExporting(true);
    setExportError("");
    try {
      const allRows = await fetchAllPages<Record<string, unknown>>(
        (exportPage, exportPageSize) =>
          apiFetch<HtmlReportSectionResult>(
            reportDataPath(exportPage, exportPageSize),
          ),
      );
      if (!allRows.length) throw new Error("当前筛选条件下没有可导出的记录");
      downloadReportRows(allRows, "all");
    } catch (reason) {
      setExportError(reason instanceof Error ? reason.message : "导出失败");
    } finally {
      setExporting(false);
    }
  };
  const toggleRow = (id: string) =>
    setSelectedRowIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleCurrentPage = () => {
    setSelectedRowIds((current) => {
      const next = new Set(current);
      if (currentPageAllSelected)
        rows.forEach((row, index) => next.delete(rowId(row, index)));
      else rows.forEach((row, index) => next.add(rowId(row, index)));
      return next;
    });
  };
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const todayCounts = report?.todayNewCounts || {
    web: 0,
    ports: 0,
    dns: 0,
    fingerprints: 0,
    icons: 0,
  };
  const moduleTodayTotal = Object.values(todayCounts).reduce(
    (sum, value) => sum + value,
    0,
  );
  const activeFilters = [
    query
      ? {
          key: "query",
          label: `关键词：${query}`,
          clear: () => {
            setQuery("");
            setQueryDraft("");
          },
        }
      : null,
    fingerprintType !== "全部"
      ? {
          key: "fingerprintType",
          label: `指纹类型：${fingerprintType}`,
          clear: () => setFingerprintType("全部"),
        }
      : null,
    portFilter !== "全部"
      ? {
          key: "port",
          label: `端口：${portFilter}`,
          clear: () => setPortFilter("全部"),
        }
      : null,
    protocolFilter !== "全部"
      ? {
          key: "protocol",
          label: `协议：${protocolFilter}`,
          clear: () => setProtocolFilter("全部"),
        }
      : null,
    domainFilter !== "全部"
      ? {
          key: "domain",
          label: `根域名：${domainFilter}`,
          clear: () => setDomainFilter("全部"),
        }
      : null,
    componentFilter !== "全部"
      ? {
          key: "component",
          label: `应用指纹：${componentFilter}`,
          clear: () => setComponentFilter("全部"),
        }
      : null,
    aliveFilter !== "全部"
      ? {
          key: "alive",
          label: `存活状态：${aliveFilter}`,
          clear: () => setAliveFilter("全部"),
        }
      : null,
    statusCodeFilter !== "全部"
      ? {
          key: "statusCode",
          label: `状态码：${statusCodeFilter}`,
          clear: () => setStatusCodeFilter("全部"),
        }
      : null,
    changeTypeFilter !== "全部"
      ? {
          key: "changeType",
          label: `变更状态：${assetChangeMeta[changeTypeFilter as AssetChangeType]?.label || changeTypeFilter}`,
          clear: () => setChangeTypeFilter("全部"),
        }
      : null,
  ].filter((item): item is { key: string; label: string; clear: () => void } =>
    Boolean(item),
  );
  const Icon = config.icon;
  return (
    <FingerprintIconProvider entries={fingerprintIcons}>
      <div className="portal-container page-content module-page module-green html-report-page">
        <ModuleHeader
          icon={Icon}
          eyebrow={config.eyebrow}
          title="资产监测"
          todayCount={moduleTodayTotal}
          todayActive={todayOnly}
          onToggleToday={toggleToday}
          todayLoading={loading && !report}
          todayLabel="扫描报告今日新增"
        />
        {report && (
          <section className="html-report-summary" aria-label="报告板块快速筛选">
            {(Object.keys(reportSectionMeta) as HtmlReportSection[]).map(
              (value) => {
                const counts: Record<HtmlReportSection, number> = {
                  web: report.webCount,
                  ports: report.portCount,
                  dns: report.dnsCount,
                  fingerprints: report.fingerprintCount,
                  icons: report.iconCount,
                };
                return (
                  <button
                    type="button"
                    aria-pressed={section === value}
                    onClick={() => selectSection(value)}
                    key={value}
                  >
                    <span>{reportSectionMeta[value].label}</span>
                    <strong>
                      {(todayOnly ? todayCounts[value] : counts[value]).toLocaleString(
                        "zh-CN",
                      )}
                    </strong>
                    <small>{todayOnly ? "今日新增" : "点击快速筛选"}</small>
                  </button>
                );
              },
            )}
          </section>
        )}
        <div
          className={cn(
            "html-report-workbench",
            rankingsCollapsed && "facets-collapsed",
          )}
        >
          <aside
            className={cn(
              "html-report-facets",
              rankingsCollapsed && "collapsed",
            )}
            aria-label="资产排行筛选"
          >
            {!rankingsCollapsed && (
              <>
            {(["ports", "components", "domains", "protocols"] as const)
              .filter((facet) => facets[facet].length > 0)
              .map((facet) => (
                <section key={facet}>
                  <h3>
                    <button
                      type="button"
                      onClick={() =>
                        setCollapsedFacets((current) => ({
                          ...current,
                          [facet]: !current[facet],
                        }))
                      }
                    >
                      {facet === "ports"
                        ? "端口排行"
                        : facet === "components"
                          ? "指纹排行"
                          : facet === "domains"
                            ? "根域名排行"
                            : "协议排行"}
                      <ChevronRight
                        className={collapsedFacets[facet] ? "collapsed" : ""}
                        size={14}
                      />
                    </button>
                  </h3>
                  {!collapsedFacets[facet] && (
                    <div>
                      {facets[facet].map((item, index) => (
                        <button
                          type="button"
                          key={`${item.label}-${index}`}
                          onClick={() => applyFacet(facet, item.label)}
                        >
                          <span>{item.label}</span>
                          <em>{item.count.toLocaleString("zh-CN")}</em>
                        </button>
                      ))}
                    </div>
                  )}
                </section>
              ))}
            {facets.icons.length > 0 && (
              <section className="html-icon-facet">
                <h3>
                  <button
                    type="button"
                    onClick={() =>
                      setCollapsedFacets((current) => ({
                        ...current,
                        icons: !current.icons,
                      }))
                    }
                  >
                    icon排行
                    <ChevronRight
                      className={collapsedFacets.icons ? "collapsed" : ""}
                      size={14}
                    />
                  </button>
                </h3>
                {!collapsedFacets.icons && (
                  <div>
                    {facets.icons.map((item) => (
                      <button
                        type="button"
                        key={item.md5}
                        title={`${item.md5} · ${item.count}`}
                        onClick={() => applyFacet("icons", item.md5)}
                      >
                        {item.icon && item.icon.startsWith("data:image/") ? (
                          <img
                            src={item.icon}
                            alt="favicon"
                            onError={(event) => {
                              event.currentTarget.style.display = "none";
                            }}
                          />
                        ) : (
                          <Fingerprint size={17} />
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </section>
            )}
              </>
            )}
          </aside>
          <div className="html-report-main">
            <Panel
              className={cn(
                "html-report-data-panel",
                `html-report-section-${section}`,
                section === "fingerprints" && "html-report-fingerprint-panel",
              )}
              action={
                <div className="asset-merged-toolbar">
                  <Button
                    type="button"
                    className="asset-rankings-toggle"
                    variant="ghost"
                    aria-expanded={!rankingsCollapsed}
                    aria-label={rankingsCollapsed ? "展开资产排行" : "收起资产排行"}
                    title={rankingsCollapsed ? "展开资产排行" : "收起资产排行"}
                    onClick={() => setRankingsCollapsed((current) => !current)}
                  >
                    {rankingsCollapsed ? (
                      <PanelLeftOpen size={16} />
                    ) : (
                      <PanelLeftClose size={16} />
                    )}
                  </Button>
                  <form className="asset-search-form" onSubmit={applySearch}>
                    <label className="sensitive-inline-search">
                      <Search size={16} />
                      <input
                        aria-label="搜索报告数据"
                        value={queryDraft}
                        onChange={(event) => setQueryDraft(event.target.value)}
                        placeholder={`输入${reportSectionMeta[section].label}关键词`}
                      />
                      {queryDraft && (
                        <button
                          type="button"
                          className="asset-search-clear"
                          title="清空搜索"
                          aria-label="清空搜索"
                          onClick={() => {
                            setQueryDraft("");
                            if (query) {
                              setQuery("");
                              setPage(1);
                            }
                          }}
                        >
                          <X size={14} />
                        </button>
                      )}
                    </label>
                    <Button type="submit">
                      搜索
                    </Button>
                  </form>
                  <div className="html-report-column-settings">
                    <button
                      type="button"
                      className={columnSettingsOpen ? "active" : ""}
                      onClick={() => setColumnSettingsOpen((value) => !value)}
                    >
                      <Settings size={15} />
                      表头设置
                    </button>
                    {columnSettingsOpen && (
                      <div className="html-column-menu">
                        {orderedColumns.map((column) => (
                          <label key={column}>
                            <input
                              type="checkbox"
                              checked={!hiddenColumns[section].includes(column)}
                              onChange={() =>
                                setHiddenColumns((current) => ({
                                  ...current,
                                  [section]: current[section].includes(column)
                                    ? current[section].filter(
                                        (item) => item !== column,
                                      )
                                    : [...current[section], column],
                                }))
                              }
                            />
                            <span>{reportFieldLabel(column)}</span>
                          </label>
                        ))}
                        <button
                          type="button"
                          onClick={() =>
                            setHiddenColumns((current) => ({
                              ...current,
                              [section]: [
                                ...reportDefaultHiddenColumns[section],
                              ],
                            }))
                          }
                        >
                          恢复默认
                        </button>
                      </div>
                    )}
                  </div>
                  <div className="html-report-actions">
                    <div className="export-action-group">
                      <Button
                        className="data-export-button"
                        variant="ghost"
                        onClick={exportSelected}
                        disabled={!selectedCount}
                      >
                        <Download size={15} />
                        导出选中{selectedCount ? ` ${selectedCount}` : ""}
                      </Button>
                      <Button
                        className="data-export-button"
                        variant="secondary"
                        onClick={() => void exportAll()}
                        disabled={exporting || !total}
                        title={exportError || "导出当前筛选范围内全部记录"}
                      >
                        <Download size={15} />
                        {exporting ? "导出中..." : "导出全部"}
                      </Button>
                    </div>
                  </div>
                </div>
              }
            >
              <div className="asset-data-toolbar">
                <div className="asset-filter-row">
                  <span className="asset-filter-heading">
                    <SlidersHorizontal size={14} /> 快速筛选
                  </span>
                  <div className="asset-filter-grid">
                    <label className="asset-filter-control">
                      <span>变更状态</span>
                      <select
                        value={changeTypeFilter}
                        onChange={(event) => {
                          setChangeTypeFilter(event.target.value);
                          setPage(1);
                        }}
                      >
                        <option value="全部">全部变更状态</option>
                        {assetChangeFilterOrder.map((value) => {
                          const count = (facets.changeTypes || []).find((item) => item.label === value)?.count || 0;
                          return <option value={value} key={value}>{assetChangeMeta[value].label}{count ? `（${count}）` : ""}</option>;
                        })}
                      </select>
                    </label>
                    {(section === "web" || section === "ports") && (
                      <label className="asset-filter-control">
                        <span>端口</span>
                        <select
                          value={portFilter}
                          onChange={(event) => {
                            setPortFilter(event.target.value);
                            setPage(1);
                          }}
                        >
                          <option value="全部">全部端口</option>
                          {facets.ports.map((item) => (
                            <option value={item.label} key={item.label}>
                              {item.label}（{item.count}）
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                    {(section === "web" || section === "ports") && (
                      <label className="asset-filter-control">
                        <span>协议</span>
                        <select
                          value={protocolFilter}
                          onChange={(event) => {
                            setProtocolFilter(event.target.value);
                            setPage(1);
                          }}
                        >
                          <option value="全部">全部协议</option>
                          {facets.protocols.map((item) => (
                            <option value={item.label} key={item.label}>
                              {item.label}（{item.count}）
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                    {(section === "web" || section === "dns") && (
                      <label className="asset-filter-control asset-filter-wide">
                        <span>根域名</span>
                        <select
                          value={domainFilter}
                          onChange={(event) => {
                            setDomainFilter(event.target.value);
                            setPage(1);
                          }}
                        >
                          <option value="全部">全部根域名</option>
                          {facets.domains.map((item) => (
                            <option value={item.label} key={item.label}>
                              {item.label}（{item.count}）
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                    {section === "web" && (
                      <label className="asset-filter-control asset-filter-wide">
                        <span>应用指纹</span>
                        <select
                          value={componentFilter}
                          onChange={(event) => {
                            setComponentFilter(event.target.value);
                            setPage(1);
                          }}
                        >
                          <option value="全部">全部指纹</option>
                          {facets.components.map((item) => (
                            <option value={item.label} key={item.label}>
                              {item.label}（{item.count}）
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                    {(section === "web" || section === "ports") && (
                      <label className="asset-filter-control">
                        <span>存活状态</span>
                        <select
                          value={aliveFilter}
                          onChange={(event) => {
                            setAliveFilter(event.target.value);
                            setPage(1);
                          }}
                        >
                          <option value="全部">全部状态</option>
                          {facets.alive.map((item) => (
                            <option value={item.label} key={item.label}>
                              {item.label}（{item.count}）
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                    {section === "web" && (
                      <label className="asset-filter-control">
                        <span>状态码</span>
                        <select
                          value={statusCodeFilter}
                          onChange={(event) => {
                            setStatusCodeFilter(event.target.value);
                            setPage(1);
                          }}
                        >
                          <option value="全部">全部状态码</option>
                          {facets.statusCodes.map((item) => (
                            <option value={item.label} key={item.label}>
                              {item.label}（{item.count}）
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                    {section === "fingerprints" && (
                      <div className="html-fingerprint-filter">
                        {(["全部", "应用指纹", "信息指纹"] as const).map(
                          (value) => (
                            <button
                              type="button"
                              className={
                                fingerprintType === value ? "active" : ""
                              }
                              key={value}
                              onClick={() => {
                                setFingerprintType(value);
                                setPage(1);
                              }}
                            >
                              {value}
                            </button>
                          ),
                        )}
                      </div>
                    )}
                  </div>
                </div>
                {activeFilters.length > 0 && (
                  <div
                    className="asset-active-filters"
                    aria-label="当前筛选条件"
                  >
                    <span>已筛选</span>
                    {activeFilters.map((filter) => (
                      <button
                        type="button"
                        className="asset-filter-chip"
                        onClick={() => {
                          filter.clear();
                          setPage(1);
                        }}
                        title={`移除 ${filter.label}`}
                        key={filter.key}
                      >
                        {filter.label} <X size={12} />
                      </button>
                    ))}
                    <button
                      type="button"
                      className="asset-filter-reset"
                      onClick={resetFilters}
                    >
                      <RotateCcw size={13} /> 重置全部
                    </button>
                  </div>
                )}
              </div>
              {error ? (
                <EmptyState
                  icon={<TriangleAlert size={32} />}
                  title="报告数据加载失败"
                  description={error}
                />
              ) : loading ? (
                <div className="skeleton-list">
                  {Array.from({ length: 8 }).map((_, index) => (
                    <div className="skeleton-row" key={index} />
                  ))}
                </div>
              ) : !rows.length ? (
                <EmptyState
                  icon={<FileSearch size={32} />}
                  title={EMPTY_DATA_TITLE}
                  description={EMPTY_DATA_DESCRIPTION}
                />
              ) : (
                <div ref={tableWrapRef} className="html-report-table-wrap">
                  <table
                    className={cn(
                      "html-report-table",
                      `html-report-table-${section}`,
                    )}
                  >
                    <colgroup>
                      <col style={{ width: 88 }} />
                      {reportTableColumns.map((column) => (
                        <col
                          key={column.id}
                          style={{
                            width: reportTableView.columnWidth(column.id),
                          }}
                        />
                      ))}
                      <col style={{ width: 96 }} />
                    </colgroup>
                    <thead>
                      <tr>
                        <th className="html-report-sequence">
                          <SequenceHeader
                            selection={
                              <input
                                className="selection-checkbox"
                                type="checkbox"
                                checked={currentPageAllSelected}
                                onChange={toggleCurrentPage}
                                aria-label="选择当前页资产"
                              />
                            }
                          />
                        </th>
                        {reportTableColumns.map((column) => (
                          <th
                            className={reportColumnClass(section, column.id)}
                            aria-sort={
                              sort === column.id
                                ? direction === "asc"
                                  ? "ascending"
                                  : "descending"
                                : undefined
                            }
                            key={column.id}
                          >
                            <SortableResizableHeader
                              column={column}
                              sort={sort ? { id: sort, direction } : null}
                              width={reportTableView.columnWidth(column.id)}
                              onSort={toggleSort}
                              onResize={reportTableView.setColumnWidth}
                            />
                          </th>
                        ))}
                        <th className="html-report-operation">操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row, index) => {
                        const fresh = isTodayNew(
                          String(row._first_seen_at || ""),
                        );
                        const id = rowId(row, index);
                        return (
                          <tr className={cn(fresh && "record-is-new")} key={id}>
                            <td className="html-report-sequence">
                              {fresh && <NewCornerBadge />}
                              <SequenceCell
                                selection={
                                  <input
                                    className="selection-checkbox"
                                    type="checkbox"
                                    checked={selectedRowIds.has(id)}
                                    onChange={() => toggleRow(id)}
                                    aria-label={`选择第 ${(page - 1) * pageSize + index + 1} 条资产`}
                                  />
                                }
                                value={(page - 1) * pageSize + index + 1}
                              />
                            </td>
                            {visibleColumns.map((column) => {
                              const value = reportDisplayValue(row, column);
                              const text = reportCellValue(value, column);
                              const isIcon =
                                section === "icons" &&
                                column === "icon" &&
                                typeof value === "string" &&
                                value.startsWith("data:image/");
                              const assetReference = isAssetReferenceSection
                                ? section === "fingerprints"
                                  ? String(row.nameAndType || row.key || "")
                                  : String(row.md5 || "")
                                : "";
                              const cellClass = reportColumnClass(
                                section,
                                column,
                              );
                              if (column === "change_status")
                                return (
                                  <td className={cellClass} key={column}>
                                    <AssetChangeBadge
                                      changeType={row._change_type}
                                      summary={row._change_summary}
                                    />
                                  </td>
                                );
                              if (section === "web" && column === "asset") {
                                const titleIcon =
                                  typeof row._icon === "string" &&
                                  row._icon.startsWith("data:image/")
                                    ? row._icon
                                    : "";
                                const identity = String(
                                  row.domain || row.ip || "--",
                                );
                                const url = String(row.url || "");
                                let protocol = String(row.protocol || "");
                                try {
                                  protocol = new URL(url).protocol.replace(
                                    ":",
                                    "",
                                  );
                                } catch {
                                  // Some imported rows contain host-only values.
                                }
                                return (
                                  <td className={cellClass} key={column}>
                                    <div className="html-asset-identity">
                                      <div className="html-asset-primary">
                                        {titleIcon ? (
                                          <img
                                            src={titleIcon}
                                            alt=""
                                            onError={(event) => {
                                              event.currentTarget.style.display =
                                                "none";
                                            }}
                                          />
                                        ) : (
                                          <Globe2 size={15} />
                                        )}
                                        <strong title={identity}>
                                          {identity}
                                        </strong>
                                      </div>
                                      {url ? (
                                        <a
                                          className="html-asset-entry-url"
                                          href={url}
                                          target="_blank"
                                          rel="noreferrer"
                                          title={url}
                                        >
                                          {url}
                                          <SquareArrowOutUpRight size={11} />
                                        </a>
                                      ) : null}
                                      <div className="html-asset-meta">
                                        {row.ip && row.ip !== row.domain ? (
                                          <code>{String(row.ip)}</code>
                                        ) : null}
                                        {row.port ? (
                                          <span>:{String(row.port)}</span>
                                        ) : null}
                                        {protocol ? (
                                          <span>{protocol.toUpperCase()}</span>
                                        ) : null}
                                      </div>
                                    </div>
                                  </td>
                                );
                              }
                              if (section === "web" && column === "state") {
                                const alive = String(row.alive || "");
                                const statusCode = String(
                                  row.status_code || "",
                                );
                                return (
                                  <td className={cellClass} key={column}>
                                    <span className="html-status-group">
                                      <AliveStatusBadge value={alive} />
                                      <StatusCodeBadge value={statusCode} />
                                    </span>
                                  </td>
                                );
                              }
                              if (isIcon)
                                return (
                                  <td className={cellClass} key={column}>
                                    <button
                                      type="button"
                                      className="html-icon-thumb"
                                      aria-label="预览图标"
                                      onClick={() =>
                                        setIconPreview(value as string)
                                      }
                                    >
                                      <img
                                        src={value as string}
                                        alt="favicon"
                                        onError={(event) => {
                                          event.currentTarget.style.display =
                                            "none";
                                        }}
                                      />
                                    </button>
                                  </td>
                                );
                              if (
                                column === "type" &&
                                section === "fingerprints"
                              )
                                return (
                                  <td className={cellClass} key={column}>
                                    <span
                                      className={cn(
                                        "html-fingerprint-type",
                                        value === "应用指纹"
                                          ? "is-application"
                                          : "is-information",
                                      )}
                                    >
                                      {text}
                                    </span>
                                  </td>
                                );
                              if (isAssetReferenceSection && column === "count")
                                return (
                                  <td className={cellClass} key={column}>
                                    <button
                                      className="html-report-count-link"
                                      type="button"
                                      disabled={!assetReference}
                                      onClick={() => viewAssets(assetReference)}
                                    >
                                      {text}
                                    </button>
                                  </td>
                                );
                              if (section === "web" && column === "url")
                                return (
                                  <td className={cellClass} key={column}>
                                    {text ? (
                                      <a
                                        className="html-asset-url"
                                        href={text}
                                        target="_blank"
                                        rel="noreferrer"
                                        title={text}
                                      >
                                        <span>{text}</span>
                                        <SquareArrowOutUpRight size={12} />
                                      </a>
                                    ) : null}
                                  </td>
                                );
                              if (section === "web" && column === "title") {
                                const titleIcon =
                                  typeof row._icon === "string" &&
                                  row._icon.startsWith("data:image/")
                                    ? row._icon
                                    : "";
                                return (
                                  <td className={cellClass} key={column}>
                                    <span
                                      className="html-site-title"
                                      title={text}
                                    >
                                      {titleIcon ? (
                                        <img
                                          className="html-title-icon"
                                          src={titleIcon}
                                          alt="站点图标"
                                          onError={(event) => {
                                            event.currentTarget.style.display =
                                              "none";
                                          }}
                                        />
                                      ) : null}
                                      {text}
                                    </span>
                                  </td>
                                );
                              }
                              if (
                                section === "web" &&
                                column === "status_code"
                              ) {
                                return (
                                  <td className={cellClass} key={column}>
                                    <StatusCodeBadge value={value} />
                                  </td>
                                );
                              }
                              if (column === "alive")
                                return (
                                  <td className={cellClass} key={column}>
                                    <AliveStatusBadge value={value} />
                                  </td>
                                );
                              if (column === "company_path")
                                return (
                                  <td className={cellClass} key={column}>
                                    {text ? (
                                      <span
                                        className="html-organization"
                                        title={text}
                                      >
                                        <OrganizationGlyph name={text} />
                                        <span>{text}</span>
                                      </span>
                                    ) : null}
                                  </td>
                                );
                              if (
                                section === "web" &&
                                column === "application"
                              ) {
                                const technologies = [
                                  ...reportNameList(row.app_products),
                                  ...reportNameList(row.framework_products),
                                ];
                                return (
                                  <td className={cellClass} key={column}>
                                    <span className="html-technology-list">
                                      {technologies.map(
                                        (name, technologyIndex) => (
                                          <span
                                            className="html-technology-chip"
                                            title={name}
                                            key={`${name}-${technologyIndex}`}
                                          >
                                            <TechnologyGlyph name={name} />
                                            <em>{name}</em>
                                          </span>
                                        ),
                                      )}
                                    </span>
                                  </td>
                                );
                              }
                              if (
                                section === "fingerprints" &&
                                column === "nameAndType"
                              ) {
                                const fingerprintName = String(
                                  row.key || text,
                                ).split("✚", 1)[0];
                                return (
                                  <td className={cellClass} key={column}>
                                    {fingerprintName ? (
                                      <span
                                        className="html-fingerprint-identity"
                                        title={fingerprintName}
                                      >
                                        <TechnologyGlyph
                                          name={fingerprintName}
                                        />
                                        <em>{fingerprintName}</em>
                                      </span>
                                    ) : null}
                                  </td>
                                );
                              }
                              if (section === "web" && column === "geo") {
                                const country = reportGeoField(row, "country");
                                return (
                                  <td className={cellClass} key={column}>
                                    {text ? (
                                      <span
                                        className="html-location"
                                        title={text}
                                      >
                                        {country ? (
                                          <CountryFlag country={country} />
                                        ) : null}
                                        <span>{text}</span>
                                      </span>
                                    ) : null}
                                  </td>
                                );
                              }
                              if (section === "web" && column === "carrier")
                                return (
                                  <td className={cellClass} key={column}>
                                    {text ? (
                                      <span
                                        className="html-provider"
                                        title={text}
                                      >
                                        <ProviderGlyph name={text} />
                                        <span>{text}</span>
                                      </span>
                                    ) : null}
                                  </td>
                                );
                              return (
                                <td className={cellClass} key={column}>
                                  <span title={text}>{text}</span>
                                </td>
                              );
                            })}
                            <td className="html-report-operation">
                              {isAssetReferenceSection ? (
                                <button
                                  type="button"
                                  disabled={
                                    !(section === "fingerprints"
                                      ? row.nameAndType || row.key
                                      : row.md5)
                                  }
                                  onClick={() =>
                                    viewAssets(
                                      section === "fingerprints"
                                        ? String(
                                            row.nameAndType || row.key || "",
                                          )
                                        : String(row.md5 || ""),
                                    )
                                  }
                                >
                                  查看资产
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => setDetailRow(row)}
                                >
                                  查看详情
                                </button>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              <footer className="credential-pagination">
                <span>
                  第 {page} / {totalPages} 页，共{" "}
                  {total.toLocaleString("zh-CN")} 条记录
                </span>
                <div>
                  <label className="html-page-size">
                    每页
                    <select
                      value={pageSize}
                      onChange={(event) => {
                        setPageSize(Number(event.target.value));
                        setPage(1);
                      }}
                    >
                      <option value="20">20</option>
                      <option value="50">50</option>
                      <option value="100">100</option>
                    </select>
                    条
                  </label>
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
            </Panel>
          </div>
        </div>
        {detailRow && (
          <div
            className="html-detail-overlay"
            role="dialog"
            aria-modal="true"
            aria-labelledby="asset-detail-title"
            onClick={() => setDetailRow(null)}
          >
            <article
              className="html-detail-card"
              onClick={(event) => event.stopPropagation()}
            >
              <header className="html-detail-header">
                <div className="html-detail-heading-icon" aria-hidden="true">
                  {typeof detailRow._icon === "string" &&
                  detailRow._icon.startsWith("data:image/") ? (
                    <img src={detailRow._icon} alt="" />
                  ) : (
                    <DetailSectionIcon size={24} />
                  )}
                </div>
                <div className="html-detail-heading">
                  <span className="eyebrow">ASSET DETAIL</span>
                  <h2 id="asset-detail-title">{detailTitle}</h2>
                  <p>
                    {reportSectionMeta[section].label} · {detailFields.length}{" "}
                    项字段
                  </p>
                </div>
                <button
                  ref={detailCloseRef}
                  type="button"
                  className="html-detail-close"
                  onClick={() => setDetailRow(null)}
                  aria-label="关闭资产详情"
                  title="关闭"
                >
                  <X size={19} />
                </button>
              </header>
              <section className="html-detail-summary" aria-label="资产摘要">
                <div>
                  <span className="html-detail-summary-icon" aria-hidden="true">
                    <RotateCcw size={17} />
                  </span>
                  <div>
                    <span>变更状态</span>
                    <AssetChangeBadge
                      changeType={detailRow._change_type}
                      summary={detailRow._change_summary}
                    />
                  </div>
                </div>
                <div>
                  <span className="html-detail-summary-icon" aria-hidden="true">
                    <DetailSectionIcon size={17} />
                  </span>
                  <div>
                    <span>资产类型</span>
                    <strong>{reportSectionMeta[section].label}</strong>
                  </div>
                </div>
                <div>
                  <span className="html-detail-summary-icon" aria-hidden="true">
                    <Globe2 size={17} />
                  </span>
                  <div>
                    <span>关键标识</span>
                    <strong className="html-detail-summary-mono">
                      {reportCellValue(
                        detailRow.ip ||
                          detailRow.domain ||
                          detailRow.subdomain ||
                          detailRow.md5 ||
                          detailRow.key,
                        "identifier",
                      ) || "--"}
                    </strong>
                  </div>
                </div>
                <div>
                  <span className="html-detail-summary-icon" aria-hidden="true">
                    <CircleGauge size={17} />
                  </span>
                  <div>
                    <span>运行状态</span>
                    <span className="html-detail-status">
                      {detailRow.alive ? (
                        <HtmlReportDetailValue
                          row={detailRow}
                          fieldKey="alive"
                          value={detailRow.alive}
                        />
                      ) : null}
                      {detailRow.status_code ? (
                        <HtmlReportDetailValue
                          row={detailRow}
                          fieldKey="status_code"
                          value={detailRow.status_code}
                        />
                      ) : null}
                      {!detailRow.alive && !detailRow.status_code ? "--" : null}
                    </span>
                  </div>
                </div>
                <div>
                  <span className="html-detail-summary-icon" aria-hidden="true">
                    <Clock3 size={17} />
                  </span>
                  <div>
                    <span>更新时间</span>
                    <time>
                      {reportCellValue(detailRow.updated_at, "updated_at") ||
                        "--"}
                    </time>
                  </div>
                </div>
              </section>
              <section className="html-detail-body">
                <div className="html-detail-section-title">
                  <div>
                    <strong>资产字段</strong>
                    <span>扫描识别到的资产属性与技术信息</span>
                  </div>
                  <span>{detailFields.length} 项</span>
                </div>
                <dl>
                  {detailFields.map(([key, value]) => (
                    <div
                      className={cn(
                        "html-detail-field",
                        reportDetailWideFields.has(key) &&
                          "html-detail-field-wide",
                      )}
                      key={key}
                    >
                      <dt>{reportFieldLabel(key)}</dt>
                      <dd
                        className={cn(
                          reportDetailMonoFields.has(key) &&
                            "html-detail-value-mono",
                        )}
                      >
                        <HtmlReportDetailValue
                          row={detailRow}
                          fieldKey={key}
                          value={value}
                        />
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            </article>
          </div>
        )}
        {iconPreview && (
          <div
            className="html-icon-preview"
            role="dialog"
            aria-label="图标预览"
            onClick={() => setIconPreview(null)}
          >
            <img src={iconPreview} alt="favicon 原图" />
          </div>
        )}
      </div>
    </FingerprintIconProvider>
  );
}
