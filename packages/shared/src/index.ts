export type RiskLevel = "critical" | "high" | "medium" | "low" | "info";
export type IntelType = "暗网情报" | "敏感泄露" | "仿冒网站" | "暴露面" | "漏洞情报";
export interface IntelligenceItem {
  id: string;
  title: string;
  summary: string;
  type: IntelType;
  subtype: string;
  risk: RiskLevel;
  source: string;
  organization: string;
  observedAt: string;
  firstSeenAt?: string;
  confidence: number | null;
  tags: string[];
  intelTags?: string[];
  entities: string[];
  detailPath?: string;
}

export interface IntelligencePageResult {
  page: number;
  pageSize: number;
  total: number;
  data: IntelligenceItem[];
  riskCounts?: Record<RiskLevel, number>;
  allTotal?: number;
  todayNewCount?: number;
}

export type TodayModuleKey = "darkWebIntelligence" | "credentialLeaks" | "accountPassword" | "sourceCode" | "documents" | "assets" | "phishing" | "vulnerabilities";
export type TodayNewSummary = Record<TodayModuleKey, number>;

export interface Metric {
  label: string;
  value: string;
  delta: string;
  tone: RiskLevel | "success";
}

export interface TrendPoint {
  date: string;
  critical: number;
  high: number;
  medium: number;
  total: number;
}

export interface SourceDistributionItem {
  name: string;
  value: number;
  color?: string;
}

export interface ExposurePoint {
  label: string;
  value: number;
  path?: string;
}

export interface ThreatRegionPoint {
  name: string;
  value: number;
  risk: RiskLevel;
  coordinate: [number, number];
}

export interface PortalDashboardResult {
  metrics: Metric[];
  riskCounts: Record<RiskLevel, number>;
  trendData: TrendPoint[];
  sourceDistribution: SourceDistributionItem[];
  exposureData: ExposurePoint[];
  regionDistribution: ThreatRegionPoint[];
  criticalTotal: number;
  critical: IntelligenceItem[];
  latest: IntelligenceItem[];
  todayNew: TodayNewSummary;
}

export interface AdminDashboardMetric {
  label: string;
  value: string;
  note: string;
  tone: "orange" | "cyan" | "red" | "purple";
}

export interface AdminHealthItem {
  name: string;
  status: string;
  tone: "success" | "warning" | "danger";
}

export interface AdminDashboardResult {
  metrics: AdminDashboardMetric[];
  trendData: TrendPoint[];
  health: AdminHealthItem[];
}

export type Workspace = "portal" | "admin" | "both";
export type Permission =
  | "portal:read" | "evidence:download"
  | "edge:admin" | "edge:accounts" | "edge:sync" | "edge:license" | "edge:branding"
  | "accounts:manage" | "ingestion:manage"
  | "targets:read" | "targets:manage"
  | "sources:read" | "sources:manage"
  | "operations:manage";

export interface RoleDefinition {
  key: string;
  label: string;
  description: string;
  workspace: Workspace;
  permissions: Permission[];
}

export interface UserRecord {
  id: string;
  name: string;
  account: string;
  role: string;
  roleKey: string;
  workspace: Workspace;
  permissions: Permission[];
  status: "正常" | "停用";
  enabled: boolean;
  totpEnabled?: boolean;
  email?: string;
  phone?: string;
  department?: string;
  passwordChangedAt?: string | null;
  lastLogin: string;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type IngestionType = "sensitive" | "asset" | "dark-web";

export interface ApiConnection {
  id: string;
  name: string;
  category: string;
  endpoint: string;
  status: "正常" | "异常" | "未配置";
  successRate: number;
  lastCalled: string;
  quota: string;
  method?: "GET" | "POST" | "PUT" | "DELETE";
  authMode?: "API Key" | "无认证" | "自定义";
  apiKeyConfigured?: boolean;
  apiKeyPreview?: string;
  lastTestMessage?: string;
  lastTestAt?: string;
  targetId?: string;
  targetName?: string;
  providerType: "darkweb_subscription" | "hunter_asset" | "watchvuln" | "generic_json";
  providerName: string;
  enabled: boolean;
  config: Record<string, unknown>;
  lastSyncAt?: string | null;
  consecutiveFailures: number;
}

export interface ConnectorProvider {
  type: ApiConnection["providerType"];
  label: string;
  defaultCategory: string;
  supportsSync: boolean;
}

export interface CollectionJob {
  id: string;
  connectionId: string;
  connectionName: string;
  providerType: ApiConnection["providerType"];
  name: string;
  enabled: boolean;
  intervalMinutes: number;
  timeoutSeconds: number;
  retryLimit: number;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: "从未运行" | "成功" | "失败";
  lastMessage?: string | null;
  updatedAt: string;
}

export type BackgroundRunState = "running" | "retrying" | "succeeded" | "failed";

export interface BackgroundRunError {
  message: string;
}

export interface BackgroundRun {
  id: number;
  bullmqJobId: string;
  queueRole: "scheduler" | "snapshot" | "io" | "maintenance";
  taskIdentifier: string;
  taskLabel: string;
  triggerType: string;
  state: BackgroundRunState;
  attempt: number;
  attemptCount: number;
  maxAttempts: number;
  aggregateType?: string | null;
  aggregateId?: string | null;
  collectionJobId?: string | null;
  connectionName?: string | null;
  businessStatus?: string | null;
  businessMessage?: string | null;
  noticeMessage?: string | null;
  workerInstanceId?: string | null;
  queuedAt?: string | null;
  startedAt: string;
  finishedAt?: string | null;
  queueLatencyMs?: number | null;
  durationMs?: number | null;
  willRetry?: boolean | null;
  nextRetryAt?: string | null;
  error?: BackgroundRunError | null;
}

export interface BackgroundRunDetail extends BackgroundRun {
  attempts: BackgroundRun[];
}

export interface MonitoringTarget {
  id: string;
  tenantId: string;
  name: string;
  targetType: "企业" | "品牌" | "子公司" | "供应商";
  owner: string;
  domains: string[];
  ips: string[];
  keywords: string[];
  enabled: boolean;
  updatedAt: string;
}

export interface CredentialApiTestResult {
  ok: boolean;
  status: number;
  message: string;
  elapsedMs: number;
  subscriptionCount: number;
  checkedPaths: string[];
  mode?: "local-debug" | "upstream";
}

export interface CredentialSubscription {
  id: number;
  subType: "credential-leak" | "privacy-leak";
  subCategory: "phone" | "email" | "credential" | "employee";
  value: string;
  expireTime: string;
  count: number;
  storedCount?: number;
  todayNewCount?: number;
  targetId?: string;
  targetName?: string;
}

export interface CredentialLeakRecord {
  id: string;
  sequence: number;
  url: string;
  systemName: string;
  account: string;
  password: string;
  leakedAt: string;
  firstSeenAt?: string;
  source: string;
  subId: number;
  subCategory?: "credential" | "employee" | "phone" | "email";
  fields?: Record<string, string>;
  isPublished?: boolean;
  reviewedAt?: string;
}

export interface PasswordPolicy {
  minLength: number;
  maxLength: number;
  requireUppercase: boolean;
  requireLowercase: boolean;
  requireNumber: boolean;
  requireSpecial: boolean;
  historyCount: number;
  updatedAt: string;
}

export interface CredentialLeakPageResult {
  page: number;
  pageSize: number;
  total: number;
  next: null | [number, string];
  data: CredentialLeakRecord[];
  allTotal?: number;
  todayNewCount?: number;
}

export type SensitiveCategory = "account-password" | "source-code" | "documents" | "phishing";
export type AssetCategory = "subdomain" | "server" | "web" | "fingerprint";

export interface SensitiveRecord {
  id: string;
  sequence: number;
  category: SensitiveCategory;
  targetId?: string;
  title: string;
  risk: string;
  fields: Record<string, string>;
  firstSeenAt: string;
  lastSeenAt: string;
  importStatus: "新增" | "已存在";
  importCount: number;
  batchId?: string;
}

export interface SensitiveRecordsPageResult {
  page: number;
  pageSize: number;
  total: number;
  data: SensitiveRecord[];
  allTotal?: number;
  todayNewCount?: number;
  riskCounts?: Record<string, number>;
}

export interface AssetRecord {
  id: string;
  sequence: number;
  category: AssetCategory;
  targetId?: string;
  title: string;
  risk: string;
  fields: Record<string, string>;
  firstSeenAt: string;
  lastSeenAt: string;
  importStatus: "新增" | "已存在";
  importCount: number;
  batchId?: string;
  changeType?: "baseline" | "new" | "changed" | "reappeared" | "missing" | "unchanged";
  previousFields?: Record<string, string>;
  presentInLatestBatch?: boolean;
  previouslyPublished?: boolean;
  lastChangedAt?: string;
  missingSince?: string;
}

export interface AssetRecordsPageResult {
  page: number;
  pageSize: number;
  total: number;
  data: AssetRecord[];
  allTotal?: number;
  todayNewCount?: number;
}

export interface VulnerabilityRecord {
  id: string;
  targetId?: string | null;
  targetName: string;
  cve: string;
  title: string;
  summary: string;
  risk: RiskLevel;
  source: string;
  disclosureAt: string | null;
  solutions: string;
  references: string[];
  tags: string[];
  sourceCreatedAt: string;
  sourceUpdatedAt: string;
  firstSeenAt: string;
  lastSeenAt: string;
  importCount: number;
  status: string;
  manuallyManaged?: boolean;
  isPublished?: boolean;
  reviewedAt?: string;
}

export interface VulnerabilityPageResult {
  page: number;
  pageSize: number;
  total: number;
  todayNewCount?: number;
  riskCounts: Partial<Record<RiskLevel, number>>;
  todayRiskCounts?: Partial<Record<RiskLevel, number>>;
  sources: Array<{ name: string; count: number }>;
  tagCounts?: Array<{ name: string; count: number }>;
  data: VulnerabilityRecord[];
}

export type VulnerabilityAlertConfidence = "confirmed" | "suspected" | "review";
export type VulnerabilityAlertStatus = "new" | "acknowledged" | "resolved" | "ignored";

export interface VulnerabilityAlert {
  id: string;
  vulnerabilityId: string;
  vulnerabilityFirstSeenAt?: string;
  cve: string;
  vulnerabilityTitle: string;
  risk: RiskLevel;
  source: string;
  disclosureAt: string | null;
  watchGroupId: string;
  watchGroupName: string;
  watchItemId: string;
  watchProduct: string;
  assetRecordId: string | null;
  assetTitle: string;
  assetUrl: string;
  assetIp: string;
  assetPort: string;
  targetId?: string | null;
  targetName: string;
  matchedProduct: string;
  assetVersion: string;
  confidence: VulnerabilityAlertConfidence;
  matchType: "exact" | "alias";
  evidence: Record<string, string>;
  status: VulnerabilityAlertStatus;
  firstMatchedAt: string;
  lastMatchedAt: string;
}

export interface VulnerabilityAlertPageResult {
  page: number;
  pageSize: number;
  total: number;
  statusCounts: Partial<Record<VulnerabilityAlertStatus, number>>;
  confidenceCounts: Partial<Record<VulnerabilityAlertConfidence, number>>;
  data: VulnerabilityAlert[];
}

export interface MajorEventMatchedAsset {
  id: string;
  title: string;
  url: string;
  ip: string;
  port: string;
  targetName: string;
  matchedProduct: string;
  assetVersion: string;
  confidence: VulnerabilityAlertConfidence;
}

export interface MajorEventVulnerability extends VulnerabilityRecord {
  assetMatched: boolean;
  matchedAssetCount: number;
  matchedProducts: string[];
  matchedAssets: MajorEventMatchedAsset[];
  highestConfidence?: VulnerabilityAlertConfidence;
}

export interface MajorEventVulnerabilityPageResult {
  page: number;
  pageSize: number;
  total: number;
  matchedCount: number;
  unmatchedCount: number;
  matchedAssetCount: number;
  riskCounts: Partial<Record<RiskLevel, number>>;
  data: MajorEventVulnerability[];
}

export interface FingerprintWatchItem {
  id: string;
  productName: string;
  normalizedProduct: string;
  source: "asset" | "custom";
  vendor: string;
  versionRule: string;
  aliases: string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface FingerprintWatchGroup {
  id: string;
  tenantId: string;
  name: string;
  description: string;
  enabled: boolean;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
  items: FingerprintWatchItem[];
}

export interface AssetReport {
  id: string;
  targetId?: string;
  fileName: string;
  sizeBytes: number;
  dnsCount: number;
  portCount: number;
  webCount: number;
  fingerprintCount: number;
  iconCount: number;
  todayNewCounts?: Record<HtmlReportSection, number>;
  createdAt: string;
  contentPath: string;
}

export type HtmlReportSection = "web" | "ports" | "dns" | "fingerprints" | "icons";

export interface HtmlReportSectionResult {
  report: AssetReport;
  section: HtmlReportSection;
  page: number;
  pageSize: number;
  total: number;
  allTotal?: number;
  todayNewCount?: number;
  columns: string[];
  facets: {
    ports: Array<{ label: string; count: number }>;
    domains: Array<{ label: string; count: number }>;
    protocols: Array<{ label: string; count: number }>;
    components: Array<{ label: string; count: number }>;
    alive: Array<{ label: string; count: number }>;
    statusCodes: Array<{ label: string; count: number }>;
    changeTypes: Array<{ label: string; count: number }>;
    icons: Array<{ md5: string; icon: string; count: number }>;
  };
  data: Array<Record<string, unknown>>;
}

export interface IngestionSheetSummary {
  sheet: string;
  category: SensitiveCategory | AssetCategory | "dark-web" | "dark-web-attachment";
  label: string;
  total: number;
  newRows: number;
  duplicateRows: number;
  changedRows?: number;
  aliveChangedRows?: number;
  statusCodeChangedRows?: number;
  missingRows?: number;
  skippedRows: number;
}

export interface IngestionBatch {
  id: string;
  type: IngestionType;
  fileName: string;
  targetId?: string;
  status: string;
  totalRows: number;
  newRows: number;
  duplicateRows: number;
  changedRows?: number;
  aliveChangedRows?: number;
  statusCodeChangedRows?: number;
  missingRows?: number;
  unchangedRows?: number;
  sheets: IngestionSheetSummary[];
  createdAt: string;
}

export type ManagedIngestionRecord = {
  id: string;
  type: IngestionType;
  targetId: string;
  title: string;
  category?: SensitiveCategory | AssetCategory;
  risk?: string;
  fields?: Record<string, string>;
  firstSeenAt: string;
  lastSeenAt: string;
  importCount: number;
  batchId?: string;
  reportDate?: string;
  sourceGroupName?: string;
  sourceGroupId?: string;
  sourceGroupUrl?: string;
  messageUrl?: string;
  intelTags?: string[];
  leakDataTypes?: string;
  leakCount?: string;
  transactionCount?: string;
  transactionPrice?: string;
  publishedAt?: string;
  publisherId?: string;
  intelNote?: string;
  articleMarkdown?: string;
  isPublished?: boolean;
  reviewedAt?: string;
  changeType?: "baseline" | "new" | "changed" | "reappeared" | "missing" | "unchanged";
  previousFields?: Record<string, string>;
  presentInLatestBatch?: boolean;
  previouslyPublished?: boolean;
  lastChangedAt?: string;
  missingSince?: string;
};

export type PublicationModule = "sensitive" | "asset" | "dark-web" | "credentials" | "vulnerabilities";
export type PublicationMode = "auto" | "approval";

export interface TenantPublicationPolicy {
  tenantId: string;
  module: PublicationModule;
  mode: PublicationMode;
  updatedAt: string | null;
}

export interface ManagedIngestionRecordsPageResult {
  page: number;
  pageSize: number;
  total: number;
  data: ManagedIngestionRecord[];
}

export interface DarkWebFileRecord {
  id: string;
  kind: "report" | "attachment";
  name: string;
  sizeBytes: number;
  sha256: string;
  mediaType: string;
  sheetCount: number;
  rowCount: number;
  columnCount: number;
  cached?: boolean;
}

export interface DarkWebEventSummary {
  id: string;
  targetId: string;
  title: string;
  risk: RiskLevel;
  reportDate: string;
  sourceGroupName: string;
  sourceGroupId: string;
  sourceGroupUrl: string;
  messageUrl: string;
  intelTags: string[];
  leakDataTypes: string;
  leakCount: string;
  transactionCount: string;
  transactionPrice: string;
  publishedAt: string;
  publisherId: string;
  intelNote: string;
  articleMarkdown?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  importCount: number;
  repeatedPropagationCount: number;
}

export interface DarkWebEventDetail extends DarkWebEventSummary {
  files: DarkWebFileRecord[];
}

export interface DarkWebEventsPageResult {
  page: number;
  pageSize: number;
  total: number;
  data: DarkWebEventSummary[];
  allTotal?: number;
  todayNewCount?: number;
}

export interface DarkWebWordPreview {
  kind: "word";
  file: DarkWebFileRecord;
  html: string;
  truncated: boolean;
  warnings: string[];
}

export interface DarkWebSpreadsheetPreview {
  kind: "spreadsheet";
  file: DarkWebFileRecord;
  sheets: { name: string; rowCount: number; columnCount: number }[];
  sheetIndex: number;
  page: number;
  pageSize: number;
  totalRows: number;
  totalPages: number;
  displayedColumns: number;
  columnsTruncated: boolean;
  rows: string[][];
}

export type DarkWebFilePreview = DarkWebWordPreview | DarkWebSpreadsheetPreview;

export const credentialApiContract = {
  baseUrl: "https://darkweb.xxx",
  subscriptionsPath: "/api/sub/list/",
  resultsPath: "/api/sub/data/",
  method: "POST" as const,
  pagination: { pageMax: 100, nextSupported: true }
};

export interface ScheduleRecord {
  id: string;
  name: string;
  connector: string;
  cron: string;
  nextRun: string;
  lastResult: string;
  enabled: boolean;
  state: "空闲" | "运行中" | "失败";
}

export const metrics: Metric[] = [
  { label: "今日新增情报", value: "1,284", delta: "+12.6%", tone: "info" },
  { label: "高危风险", value: "37", delta: "较昨日 +6", tone: "critical" },
  { label: "受影响资产", value: "59", delta: "8 个新资产", tone: "medium" },
  { label: "活跃数据源", value: "86,420", delta: "成功率 97.8%", tone: "success" }
];

export const intelligenceItems: IntelligenceItem[] = [
  {
    id: "INT-2026-0718-001",
    title: "疑似供应商代码仓库泄露云服务访问密钥",
    summary: "公开代码提交中发现疑似测试环境访问密钥与内部接口地址，已完成脱敏并关联供应商资产。",
    type: "敏感泄露",
    subtype: "源码泄露",
    risk: "critical",
    source: "代码托管监测",
    organization: "星海科技 / 北辰供应链",
    observedAt: "2026-07-18 08:42",
    confidence: 96,
    tags: ["Access Key", "供应链", "代码泄露"],
    entities: ["api.sandbox.example", "repo-demo-42", "北辰供应链"],
  },
  {
    id: "INT-2026-0718-002",
    title: "暗网论坛出现企业邮箱域相关凭据样本",
    summary: "Tor 监测源发现包含企业邮箱域的组合列表样本，未执行凭据验证，记录仅保留哈希指纹。",
    type: "暗网情报",
    subtype: "凭据泄露",
    risk: "high",
    source: "Tor 论坛监测",
    organization: "星海科技",
    observedAt: "2026-07-18 07:26",
    confidence: 82,
    tags: ["ATO", "凭据暴露", "Tor"],
    entities: ["ex***@example.com", "sample-market.onion"],
  },
  {
    id: "INT-2026-0718-003",
    title: "新注册相似域名使用品牌登录页截图",
    summary: "相似域名与品牌主域编辑距离为 1，证书签发后出现仿冒登录界面，页面未提交任何测试凭据。",
    type: "仿冒网站",
    subtype: "仿冒网站",
    risk: "high",
    source: "证书透明度 / DNS",
    organization: "星海金融",
    observedAt: "2026-07-18 06:58",
    confidence: 91,
    tags: ["钓鱼", "相似域名", "品牌仿冒"],
    entities: ["xinghai-login.example", "203.0.113.42"],
  },
  {
    id: "INT-2026-0718-004",
    title: "互联网资产新增远程管理端口暴露",
    summary: "授权资产周期探测发现新增管理端口，应用指纹与 CMDB 基线不一致，已通知资产负责人。",
    type: "暴露面",
    subtype: "资产监测",
    risk: "medium",
    source: "资产探针-华东",
    organization: "星海科技",
    observedAt: "2026-07-18 05:31",
    confidence: 99,
    tags: ["端口变化", "未知服务", "互联网暴露"],
    entities: ["198.51.100.27:8443", "ops-gateway.example"],
  },
  {
    id: "INT-2026-0718-005",
    title: "CVE-2026-15409 疑似影响公网边界资产",
    summary: "漏洞情报显示存在在野利用，产品版本与一项公网资产指纹疑似匹配，需资产团队进一步确认。",
    type: "漏洞情报",
    subtype: "漏洞情报",
    risk: "critical",
    source: "CISA KEV / 厂商通告",
    organization: "星海数据中心",
    observedAt: "2026-07-17 23:18",
    confidence: 88,
    tags: ["CISA KEV", "在野利用", "重保关注"],
    entities: ["CVE-2026-15409", "edge-vpn.example"],
  },
  {
    id: "INT-2026-0718-006",
    title: "公开文库出现内部项目交付文档",
    summary: "文档标题和水印命中项目代号，正文包含测试接口与人员分工，当前页面已转为不可访问。",
    type: "敏感泄露",
    subtype: "文档泄露",
    risk: "medium",
    source: "公开文库监测",
    organization: "星海科技",
    observedAt: "2026-07-17 21:04",
    confidence: 86,
    tags: ["文档泄露", "项目资料"],
    entities: ["Project Aurora", "docs-share.example"],
  },
  {
    id: "INT-2026-0718-007",
    title: "勒索组织披露页面提及上游服务商",
    summary: "勒索披露站新增受害者名称与供应商别名相似，尚无可验证样本，需继续观察。",
    type: "暗网情报",
    subtype: "暗网情报",
    risk: "medium",
    source: "勒索披露站监测",
    organization: "北辰供应链",
    observedAt: "2026-07-17 19:46",
    confidence: 64,
    tags: ["勒索", "供应链", "低可信"],
    entities: ["北辰供应链", "RansomGroup-X"],
  },
  {
    id: "INT-2026-0718-008",
    title: "公网 Web 应用 favicon 指纹关联未知资产",
    summary: "新增域名与现有业务系统 favicon hash 相同，证书主体和备案关系尚未确认。",
    type: "暴露面",
    subtype: "资产监测",
    risk: "low",
    source: "互联网资产测绘",
    organization: "待认领",
    observedAt: "2026-07-17 17:22",
    confidence: 72,
    tags: ["favicon", "未知资产"],
    entities: ["-247388890", "portal-lab.example"],
  },
  {
    id: "INT-2026-0718-009",
    title: "暗网索引出现疑似企业客户资料打包出售帖",
    summary: "多个暗网索引页面出现相同压缩包命名模式，当前仅记录标题、哈希和来源关联，不下载或传播原始数据。",
    type: "暗网情报",
    subtype: "暗网情报",
    risk: "high",
    source: "暗网索引监测",
    organization: "星海金融",
    observedAt: "2026-07-17 16:03",
    confidence: 74,
    tags: ["数据泄露", "暗网索引", "客户资料"],
    entities: ["sample-dump.onion", "customer-pack-0717"],
  },
  {
    id: "INT-2026-0718-010",
    title: "企业 SSO 测试账号口令出现在公开粘贴内容",
    summary: "公开粘贴内容命中企业测试邮箱格式和口令字段，已对敏感值脱敏并生成哈希指纹。",
    type: "敏感泄露",
    subtype: "账号口令",
    risk: "critical",
    source: "公开粘贴监测",
    organization: "星海科技",
    observedAt: "2026-07-17 14:27",
    confidence: 93,
    tags: ["账号口令", "SSO", "高敏字段"],
    entities: ["te***@example.com", "paste.example.invalid"],
  }
];

export const trendData: TrendPoint[] = [
  { date: "07-12", critical: 5, high: 16, medium: 28, total: 124 },
  { date: "07-13", critical: 7, high: 19, medium: 31, total: 138 },
  { date: "07-14", critical: 6, high: 17, medium: 34, total: 151 },
  { date: "07-15", critical: 9, high: 24, medium: 39, total: 176 },
  { date: "07-16", critical: 8, high: 21, medium: 36, total: 163 },
  { date: "07-17", critical: 11, high: 28, medium: 43, total: 194 },
  { date: "07-18", critical: 13, high: 31, medium: 47, total: 218 }
];

export const sourceDistribution = [
  { name: "搜索引擎", value: 28, color: "#4f7fff" },
  { name: "代码平台", value: 21, color: "#22c7d6" },
  { name: "暗网通路", value: 19, color: "#d96fa7" },
  { name: "资产探针", value: 18, color: "#2db783" },
  { name: "漏洞源", value: 14, color: "#f59e42" }
];

export const users: UserRecord[] = [
  { id: "U-001", name: "林澈", account: "lin.che", role: "平台管理员", roleKey: "platform-admin", workspace: "both", permissions: ["portal:read", "evidence:download", "accounts:manage", "ingestion:manage", "targets:read", "targets:manage", "sources:read", "sources:manage", "operations:manage"], status: "正常", enabled: true, lastLogin: "2026-07-18 08:51", lastLoginAt: "2026-07-18T08:51:00Z", createdAt: "2026-07-01T00:00:00Z", updatedAt: "2026-07-18T08:51:00Z" }
];

export const apiConnections: ApiConnection[] = [
  { id: "API-01", name: "漏洞情报聚合接口", category: "漏洞情报", providerType: "generic_json", providerName: "通用 JSON API", enabled: true, config: {}, consecutiveFailures: 0, endpoint: "https://api.example.invalid/v1/cve", status: "正常", successRate: 99.2, lastCalled: "2 分钟前", quota: "8,420 / 10,000" },
  { id: "API-02", name: "代码平台监测", category: "敏感泄露", providerType: "generic_json", providerName: "通用 JSON API", enabled: true, config: {}, consecutiveFailures: 0, endpoint: "https://api.example.invalid/v1/code", status: "正常", successRate: 97.8, lastCalled: "8 分钟前", quota: "2,181 / 5,000" },
  { id: "API-03", name: "证书透明度数据", category: "仿冒监测", providerType: "generic_json", providerName: "通用 JSON API", enabled: true, config: {}, consecutiveFailures: 1, endpoint: "https://stream.example.invalid/ct", status: "异常", successRate: 84.3, lastCalled: "26 分钟前", quota: "无限制" },
  { id: "API-04", name: "暗网凭据订阅 API", category: "凭据泄露", providerType: "darkweb_subscription", providerName: "暗网凭据订阅", enabled: true, config: {}, consecutiveFailures: 0, endpoint: "https://darkweb.xxx", status: "正常", successRate: 100, lastCalled: "12 分钟前", quota: "sub/list + sub/data", method: "POST", authMode: "API Key", apiKeyConfigured: true, apiKeyPreview: "已配置" },
  { id: "API-05", name: "企业 IM 通知", category: "通知", providerType: "generic_json", providerName: "通用 JSON API", enabled: false, config: {}, consecutiveFailures: 0, endpoint: "https://api.example.invalid/notify", status: "未配置", successRate: 0, lastCalled: "--", quota: "--" }
];

export const monitoringTargets: MonitoringTarget[] = [
  { id: "OBJ-001", tenantId: "TENANT-CHANGAN", name: "星海科技", targetType: "企业", owner: "周宁", domains: ["example.com", "xinghai.example"], ips: ["198.51.100.27", "198.51.100.42"], keywords: ["星海科技", "SENTINEL", "Xinghai"], enabled: true, updatedAt: "2026-07-18 08:42" },
  { id: "OBJ-002", tenantId: "TENANT-CHANGAN", name: "星海金融", targetType: "子公司", owner: "陈屿", domains: ["finance.example.com"], ips: ["198.51.100.61"], keywords: ["星海金融", "Xinghai Finance"], enabled: true, updatedAt: "2026-07-17 21:18" },
  { id: "OBJ-003", tenantId: "TENANT-CHANGAN", name: "北辰供应链", targetType: "供应商", owner: "赵岚", domains: ["beichen.example.net"], ips: ["203.0.113.18"], keywords: ["北辰供应链", "Beichen"], enabled: true, updatedAt: "2026-07-17 19:46" }
];

export const credentialSubscriptions: CredentialSubscription[] = [
  { id: 55, subType: "credential-leak", subCategory: "credential", value: "星海科技", expireTime: "2026-12-31T23:59:59Z", count: 24187 },
  { id: 56, subType: "credential-leak", subCategory: "employee", value: "星海金融", expireTime: "2026-11-30T23:59:59Z", count: 6384 },
  { id: 57, subType: "credential-leak", subCategory: "email", value: "example.com", expireTime: "2026-10-31T23:59:59Z", count: 1842 }
];

export const credentialLeakRecords: CredentialLeakRecord[] = [
  { id: "207a85dad1002c21f173954479342c09_55", sequence: 1, url: "https://portal.example.com/login", systemName: "企业 SSO 门户", account: "li.chen@example.com", password: "Xh!Portal-2026", leakedAt: "2026-07-18 07:26", source: "combolog", subId: 55 },
  { id: "c8f20c2d9bcf4d9d9f75b0f9a1a3c912_55", sequence: 2, url: "https://vpn.example.com/auth", systemName: "远程接入 VPN", account: "zhang.wei@example.com", password: "Vpn#Access-8842", leakedAt: "2026-07-18 06:52", source: "credential-market", subId: 55 },
  { id: "9d49ab9f55bd4d22a9a8b2e8eaf4e309_55", sequence: 3, url: "https://oa.example.com/signin", systemName: "协同办公 OA", account: "wang.an@example.com", password: "OA-Cloud!2026", leakedAt: "2026-07-17 23:44", source: "paste-monitor", subId: 55 },
  { id: "1f3b0d82f62b4e4bb7d8a0c7d1931a44_56", sequence: 1, url: "https://finance.example.com/login", systemName: "财务管理系统", account: "sun.qi@example.com", password: "Finance$2026", leakedAt: "2026-07-17 21:16", source: "combolog", subId: 56 },
  { id: "ad5a991a3b1d4d44a83c2f2c0c1e55b8_56", sequence: 2, url: "https://mail.example.com/owa", systemName: "企业邮件系统", account: "he.jun@example.com", password: "Mail-Office#28", leakedAt: "2026-07-17 19:08", source: "dark-forum", subId: 56 },
  { id: "0a1bf42a2d514f3d8a4f5f0f2b6e44c2_57", sequence: 1, url: "https://service.example.com/account", systemName: "客户服务平台", account: "chen.yu@example.com", password: "Service@2026", leakedAt: "2026-07-17 16:42", source: "paste-monitor", subId: 57 }
];

export const schedules: ScheduleRecord[] = [
  { id: "SCH-001", name: "重点品牌仿冒监测", connector: "证书透明度 + DNS", cron: "*/15 * * * *", nextRun: "09:45", lastResult: "新增 3 条", enabled: true, state: "空闲" },
  { id: "SCH-002", name: "代码秘密增量监测", connector: "代码平台监测", cron: "0 */2 * * *", nextRun: "10:00", lastResult: "新增 1 条", enabled: true, state: "空闲" },
  { id: "SCH-003", name: "暗网关键词巡检", connector: "暗网模拟采集器", cron: "30 */4 * * *", nextRun: "12:30", lastResult: "命中 7 条", enabled: true, state: "运行中" },
  { id: "SCH-004", name: "供应商暴露面基线", connector: "资产探针-华东", cron: "0 2 * * *", nextRun: "明日 02:00", lastResult: "失败：探针超时", enabled: false, state: "失败" }
];

const delay = (ms = 180) => new Promise((resolve) => window.setTimeout(resolve, ms));

export const mockService = {
  async getMetrics() {
    await delay();
    return metrics;
  },
  async searchIntelligence(query = "", type = "全部", risk = "全部", subtype = "全部") {
    await delay(240);
    const keyword = query.trim().toLowerCase();
    return intelligenceItems.filter((item) => {
      const matchesQuery = !keyword || [item.title, item.summary, item.type, item.source, item.organization, ...item.tags, ...item.entities]
        .join(" ")
        .toLowerCase()
        .includes(keyword);
      return matchesQuery && (type === "全部" || item.type === type) && (risk === "全部" || item.risk === risk) && (subtype === "全部" || item.subtype === subtype);
    });
  },
  async getIntelligence(id: string) {
    await delay();
    return intelligenceItems.find((item) => item.id === id) ?? null;
  },
  async getCredentialSubscriptions() {
    await delay();
    return credentialSubscriptions;
  },
  async getCredentialLeakResults(subId: number, page = 1, pageSize = 10): Promise<CredentialLeakPageResult> {
    await delay(220);
    const records = credentialLeakRecords.filter((item) => item.subId === subId);
    const start = (page - 1) * pageSize;
    const data = records.slice(start, start + pageSize);
    return { page, pageSize, total: records.length, next: null, data };
  },
  async testCredentialApiConnection(baseUrl: string, apiKey: string): Promise<CredentialApiTestResult> {
    await delay(420);
    const normalizedUrl = baseUrl.trim().replace(/\/$/, "");
    const checkedPaths = ["/api/sub/list/", "/api/sub/data/"];
    if (!normalizedUrl || !/^https?:\/\//i.test(normalizedUrl)) {
      return { ok: false, status: 0, message: "API 地址必须以 http:// 或 https:// 开头", elapsedMs: 18, subscriptionCount: 0, checkedPaths };
    }
    if (!apiKey.trim()) {
      return { ok: false, status: 401, message: "未提供 API Key，无法完成订阅列表鉴权", elapsedMs: 24, subscriptionCount: 0, checkedPaths };
    }
    const isDemoEndpoint = normalizedUrl.includes("darkweb.xxx") || normalizedUrl.includes("example.invalid");
    return isDemoEndpoint
      ? { ok: true, status: 200, message: "订阅列表与结果接口模拟连接成功", elapsedMs: 284, subscriptionCount: credentialSubscriptions.length, checkedPaths }
      : { ok: false, status: 502, message: "测试环境无法访问该地址，请确认服务端代理、网络和 CORS 配置", elapsedMs: 1200, subscriptionCount: 0, checkedPaths };
  }
};
