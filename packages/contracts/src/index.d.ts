export const CLOUD_EDGE_PROTOCOL_VERSION: 1;
export const EDGE_SNAPSHOT_SCHEMA_VERSION: 1;
export const SYNC_MODES: readonly ["api_pull", "object_storage_pull"];
export const EDGE_SYNC_STATUSES: readonly ["idle", "syncing", "success", "failed", "offline"];
export const EDGE_PORTAL_MODULES: readonly ["overview", "dashboard", "search", "dark-web", "sensitive", "exposure", "vulnerabilities"];
export const FINGERPRINT_ICON_SOURCES: readonly ["upload", "favicon", "iconify", "simple-icons", "domestic", "provider", "custom"];
export const RECORD_COUNT_KEYS: readonly ["monitoringTargets", "sensitiveRecords", "assetRecords", "credentialSubscriptions", "credentialRecords", "darkWebEvents", "assetReports"];

export type SyncMode = typeof SYNC_MODES[number];
export type EdgeSyncStatus = typeof EDGE_SYNC_STATUSES[number];
export type EdgePortalModule = typeof EDGE_PORTAL_MODULES[number];
export type FingerprintIconSource = typeof FINGERPRINT_ICON_SOURCES[number];
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface RuntimeSchema<T> {
  readonly name: string;
  parse(input: unknown): T;
  safeParse(input: unknown): { success: true; data: T } | { success: false; error: unknown };
}

export class ContractValidationError extends TypeError {
  readonly issues: string[];
  readonly retryable: false;
  readonly errorType: "validation";
  readonly errorCode: "ContractValidationError";
}

export interface EdgeDeploymentConfigV1 {
  protocolVersion: 1;
  configVersion: number;
  tenantId: string;
  deploymentId: string;
  enabled: boolean;
  syncMode: SyncMode;
  pollIntervalSeconds: number;
  enabledModules: EdgePortalModule[];
  license?: {
    status: "active" | "expired" | "revoked";
    issuedAt: string | null;
    expiresAt: string;
  };
}

export type EdgeActivationConfigV1 = {
  protocolVersion: 1;
  cloudBaseUrl: string;
  apiKey: string;
} | {
  protocolVersion: 1;
  cloudBaseUrl: string;
  deploymentId: string;
  deploymentSecret: string;
};

export interface RemoteSnapshotDescriptor {
  mode: SyncMode;
  version: number;
  manifestLocation: string;
  contentLocation: string;
  urlExpiresAt?: string;
}

export interface SnapshotRecordCounts {
  monitoringTargets: number;
  sensitiveRecords: number;
  assetRecords: number;
  credentialSubscriptions: number;
  credentialRecords: number;
  darkWebEvents: number;
  assetReports: number;
}

export interface SnapshotManifestV1 {
  protocolVersion: 1;
  schemaVersion: 1;
  tenantId: string;
  deploymentId: string;
  version: number;
  createdAt: string;
  fileName: string;
  compression: "gzip";
  encryption: "aes-256-gcm";
  size: number;
  sha256: string;
  recordCounts: SnapshotRecordCounts;
  signature: string;
}

export interface EdgeTenantSnapshot { id: string; name: string }
export interface EdgeMonitoringTarget {
  id: string; name: string; targetType: "企业" | "品牌" | "子公司" | "供应商"; owner: string;
  domains: string[]; ips: string[]; keywords: string[]; enabled: boolean; updatedAt: string;
}
export interface EdgeSensitiveRecord {
  id: string; category: "account-password" | "source-code" | "documents" | "phishing"; targetId: string | null;
  title: string; risk: string; fields: Record<string, string>;
  firstSeenAt: string; lastSeenAt: string; importStatus: "新增" | "已存在"; importCount: number; batchId: string | null;
}
export interface EdgeAssetRecord {
  id: string; category: "subdomain" | "server" | "web" | "fingerprint"; targetId: string | null;
  title: string; risk: string; fields: Record<string, string>;
  firstSeenAt: string; lastSeenAt: string; importStatus: "新增" | "已存在"; importCount: number; batchId: string | null;
  changeType?: "baseline" | "new" | "changed" | "reappeared" | "missing" | "unchanged";
  previousFields?: Record<string, string>; presentInLatestBatch?: boolean; previouslyPublished?: boolean;
  lastChangedAt?: string; missingSince?: string;
}
export interface EdgeVulnerabilityRecord {
  id: string; targetId: string | null; targetName: string; title: string; summary: string; risk: string; source: string; cve: string;
  disclosureAt: string | null; solutions: string; references: string[]; tags: string[]; sourceCreatedAt: string; sourceUpdatedAt: string;
  firstSeenAt: string; lastSeenAt: string; importCount: number; status: string;
}
export interface EdgeVulnerabilityAlert {
  id: string; vulnerabilityId: string; vulnerabilityFirstSeenAt?: string; cve: string; vulnerabilityTitle: string; risk: string; source: string; disclosureAt: string | null;
  watchGroupId: string; watchGroupName: string; watchItemId: string; watchProduct: string; assetRecordId: string | null; assetTitle: string;
  assetUrl: string; assetIp: string; assetPort: string; targetId: string | null; targetName: string; matchedProduct: string; assetVersion: string;
  confidence: "confirmed" | "suspected" | "review"; matchType: "exact" | "alias"; evidence: Record<string, string>;
  status: "new" | "acknowledged" | "resolved" | "ignored"; firstMatchedAt: string; lastMatchedAt: string;
}
export interface EdgeCredentialSubscription {
  id: number; targetId: string; subType: "credential-leak" | "privacy-leak";
  subCategory: "phone" | "email" | "credential" | "employee"; value: string; expireTime: string; count: number;
}
export interface EdgeCredentialRecord {
  id: string; subId: number; url: string; systemName: string; account: string; password: string;
  leakedAt: string; firstSeenAt: string; source: string; fields: Record<string, string>;
}
export interface EdgeDarkWebFileMetadata {
  id: string; kind: "report" | "attachment"; name: string; sizeBytes: number; sha256: string; mediaType: string;
  sheetCount: number; rowCount: number; columnCount: number; cached: boolean;
}
export interface EdgeDarkWebEvent {
  id: string; targetId: string; title: string; risk: "critical" | "high" | "medium" | "low"; reportDate: string; sourceGroupName: string; sourceGroupId: string;
  sourceGroupUrl: string; messageUrl: string; intelTags: string[]; leakDataTypes: string; leakCount: string; transactionCount: string;
  transactionPrice: string; publishedAt: string; publisherId: string; intelNote: string; articleMarkdown: string; firstSeenAt: string;
  lastSeenAt: string; importCount: number; repeatedPropagationCount: number; files: EdgeDarkWebFileMetadata[];
}
export interface EdgeAssetReport {
  id: string; targetId: string | null; fileName: string; sizeBytes: number; dnsCount: number; portCount: number;
  webCount: number; fingerprintCount: number; iconCount: number; createdAt: string; structuredData: { [key: string]: JsonValue };
}
export interface EdgeFingerprintIcon {
  id: string; fingerprintName: string; aliases: string[]; source: FingerprintIconSource;
  mediaType: string; iconData: string; iconSha256: string; active: boolean; updatedAt: string;
}

export interface ParsedEdgeOpenApiKey {
  version: 1 | 2;
  deploymentId: string;
  authenticationSecret: string;
  snapshotSecret: string;
}

export function createEdgeOpenApiKey(deploymentId: string, authenticationSecret: string, snapshotSecret: string): string;
export function parseEdgeOpenApiKey(value: unknown): ParsedEdgeOpenApiKey | null;

export interface EdgeSnapshotV1 {
  schemaVersion: 1;
  tenant: EdgeTenantSnapshot;
  deploymentId: string;
  version: number;
  generatedAt: string;
  monitoringTargets: EdgeMonitoringTarget[];
  sensitiveRecords: EdgeSensitiveRecord[];
  assetRecords: EdgeAssetRecord[];
  vulnerabilityRecords?: EdgeVulnerabilityRecord[];
  vulnerabilityAlerts?: EdgeVulnerabilityAlert[];
  credentialSubscriptions: EdgeCredentialSubscription[];
  credentialRecords: EdgeCredentialRecord[];
  darkWebEvents: EdgeDarkWebEvent[];
  assetReports: EdgeAssetReport[];
  fingerprintIcons?: EdgeFingerprintIcon[];
  fileObjects?: EdgeFileObject[];
}

export interface EdgeFileObject {
  id: string;
  ownerType: "dark-web" | "asset-report" | "ingestion-batch" | "article-image";
  ownerId: string;
  kind: "archive" | "report" | "attachment" | "structured-data" | "source" | "image";
  name: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
  contentLocation: string;
}

export interface EdgeSyncStatusReportV1 {
  protocolVersion: 1; tenantId: string; deploymentId: string; status: "success" | "failed";
  attemptedAt: string; appliedSnapshotVersion: number | null; message: string | null;
}
export interface EdgeSyncState {
  tenantId: string; deploymentId: string; status: EdgeSyncStatus; appliedSnapshotVersion: number | null;
  lastAttemptAt: string | null; lastSuccessAt: string | null; message: string | null;
}

export const snapshotManifestV1Schema: RuntimeSchema<SnapshotManifestV1>;
export const MAX_DARK_WEB_ARTICLE_CHARS: 1_500_000;
export const edgeSnapshotV1Schema: RuntimeSchema<EdgeSnapshotV1>;
export const edgeDeploymentConfigV1Schema: RuntimeSchema<EdgeDeploymentConfigV1>;
export const edgeActivationConfigV1Schema: RuntimeSchema<EdgeActivationConfigV1>;
export const remoteSnapshotDescriptorSchema: RuntimeSchema<RemoteSnapshotDescriptor>;
export const edgeSyncStatusReportV1Schema: RuntimeSchema<EdgeSyncStatusReportV1>;
export const edgeSyncStateSchema: RuntimeSchema<EdgeSyncState>;

export function parseSnapshotManifestV1(input: unknown): SnapshotManifestV1;
export function parseEdgeSnapshotV1(input: unknown): EdgeSnapshotV1;
export function parseEdgeDeploymentConfigV1(input: unknown): EdgeDeploymentConfigV1;
export function parseEdgeActivationConfigV1(input: unknown): EdgeActivationConfigV1;
export function parseRemoteSnapshotDescriptor(input: unknown): RemoteSnapshotDescriptor;
export function parseEdgeSyncStatusReportV1(input: unknown): EdgeSyncStatusReportV1;
export function parseEdgeSyncState(input: unknown): EdgeSyncState;
export function snapshotRecordCounts(input: unknown): SnapshotRecordCounts;
