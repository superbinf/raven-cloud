import type { EdgeActivationConfigV1, EdgePortalModule, SyncMode } from "@sentinel/contracts";

export type EdgeSyncMode = SyncMode;
export type EdgeSyncStatus = "never" | "syncing" | "success" | "failed" | "offline" | string;

export interface EdgeTenant {
  id: string;
  name: string;
  status: string;
  createdAt?: string;
  updatedAt?: string;
  counts?: {
    targets: number;
    connections: number;
    deployments: number;
    fingerprintGroups: number;
  };
}

export interface EdgeDeployment {
  id: string;
  tenantId: string;
  tenantName?: string;
  name: string;
  enabled: boolean;
  syncMode: EdgeSyncMode;
  pollIntervalSeconds: number;
  enabledModules: EdgePortalModule[];
  configVersion: number;
  lastSeenAt: string | null;
  lastAppliedSnapshotVersion: number | null;
  lastSyncStatus: EdgeSyncStatus | null;
  lastSyncMessage: string | null;
  createdAt: string;
  updatedAt: string;
  apiKeyStatus: "active" | "revoked" | string;
  apiKeyVersion: number;
  apiKeyLastRotatedAt: string | null;
  license: EdgeLicense;
}

export interface EdgeLicense {
  id: string | null;
  status: "active" | "expired" | "revoked" | "unissued" | string;
  issuedAt: string | null;
  expiresAt: string | null;
  lastValidatedAt: string | null;
  updatedAt: string | null;
}

export interface EdgeCredentialDelivery {
  cloudBaseUrl: string;
  apiKey?: string;
  licenseKey?: string;
  licenseExpiresAt?: string | null;
}

export type EdgeActivationConfig = EdgeActivationConfigV1;

export interface EdgeSnapshotSummary {
  id: string;
  version: number;
  status: string;
  createdAt: string;
  sizeBytes?: number;
}

export interface EdgeSnapshotJob {
  id: string;
  deploymentId: string;
  force: boolean;
  triggerType: "create" | "manual" | "schedule";
  status: "queued" | "running" | "retrying" | "succeeded" | "failed";
  snapshotId: string | null;
  reused: boolean | null;
  attempts: number;
  errorMessage: string | null;
  requestedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
}

export interface EdgeDeploymentStatus {
  deployment: EdgeDeployment;
  latestSnapshot: EdgeSnapshotSummary | null;
  latestSnapshotJob: EdgeSnapshotJob | null;
}

export interface EdgeDeploymentInput {
  tenantId: string;
  name: string;
  enabled: boolean;
  syncMode: EdgeSyncMode;
  pollIntervalSeconds: number;
  enabledModules: EdgePortalModule[];
  licenseExpiresAt?: string;
}
