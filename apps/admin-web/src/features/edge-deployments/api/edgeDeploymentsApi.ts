import { adminApiFetch } from "../../../shared/api/adminApi";
import type { EdgeActivationConfig, EdgeCredentialDelivery, EdgeDeployment, EdgeDeploymentInput, EdgeDeploymentStatus, EdgeSnapshotJob, EdgeTenant, EdgeLicense } from "../model/types";

export function listEdgeTenants() {
  return adminApiFetch<EdgeTenant[]>("/api/edge/tenants");
}

export function createEdgeTenant(name: string) {
  return adminApiFetch<EdgeTenant>("/api/edge/tenants", {
    method: "POST",
    body: JSON.stringify({ name })
  });
}

export function updateEdgeTenant(id: string, input: { name?: string; status?: "active" | "disabled" }) {
  return adminApiFetch<EdgeTenant>(`/api/edge/tenants/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify(input)
  });
}

export function deleteEdgeTenant(id: string) {
  return adminApiFetch<{ deleted: true; tenantId: string }>(`/api/edge/tenants/${encodeURIComponent(id)}`, {
    method: "DELETE",
    body: JSON.stringify({ confirmation: id })
  });
}

export function listEdgeDeployments() {
  return adminApiFetch<EdgeDeployment[]>("/api/edge/deployments");
}

export function createEdgeDeployment(input: EdgeDeploymentInput) {
  return adminApiFetch<{ deployment: EdgeDeployment; activationConfig: EdgeActivationConfig; license: EdgeCredentialDelivery & EdgeLicense }>("/api/edge/deployments", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function updateEdgeDeployment(id: string, input: Partial<EdgeDeploymentInput>) {
  return adminApiFetch<EdgeDeployment>(`/api/edge/deployments/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify(input)
  });
}

export function deleteEdgeDeployment(id: string) {
  return adminApiFetch<{ deleted: true; deploymentId: string; deletedSnapshots: number }>(`/api/edge/deployments/${encodeURIComponent(id)}`, {
    method: "DELETE",
    body: JSON.stringify({ confirmation: id })
  });
}

export function rotateEdgeActivation(id: string) {
  return adminApiFetch<{ deployment: EdgeDeployment; activationConfig: EdgeActivationConfig }>(`/api/edge/deployments/${encodeURIComponent(id)}/rotate-activation`, { method: "POST" });
}

export function generateEdgeApiKey(id: string) {
  return adminApiFetch<{ deployment: EdgeDeployment; activationConfig: EdgeActivationConfig }>(`/api/edge/deployments/${encodeURIComponent(id)}/openapi-key`, { method: "POST" });
}

export function updateEdgeApiKey(id: string) {
  return adminApiFetch<{ deployment: EdgeDeployment; activationConfig: EdgeActivationConfig }>(`/api/edge/deployments/${encodeURIComponent(id)}/openapi-key`, { method: "PUT" });
}

export function revokeEdgeApiKey(id: string) {
  return adminApiFetch<{ deployment: EdgeDeployment }>(`/api/edge/deployments/${encodeURIComponent(id)}/openapi-key`, { method: "DELETE" });
}

export function issueEdgeLicense(id: string, expiresAt: string) {
  return adminApiFetch<{ deployment: EdgeDeployment; license: EdgeCredentialDelivery & EdgeLicense }>(`/api/edge/deployments/${encodeURIComponent(id)}/license`, { method: "POST", body: JSON.stringify({ expiresAt }) });
}

export function updateEdgeLicense(id: string, expiresAt: string) {
  return adminApiFetch<{ deployment: EdgeDeployment; license: EdgeLicense }>(`/api/edge/deployments/${encodeURIComponent(id)}/license`, { method: "PUT", body: JSON.stringify({ expiresAt }) });
}

export function revokeEdgeLicense(id: string) {
  return adminApiFetch<{ deployment: EdgeDeployment; license: EdgeLicense }>(`/api/edge/deployments/${encodeURIComponent(id)}/license`, { method: "DELETE" });
}

export function publishEdgeSnapshot(id: string) {
  return adminApiFetch<{ deployment: EdgeDeployment; job: EdgeSnapshotJob; deduplicated: boolean }>(`/api/edge/deployments/${encodeURIComponent(id)}/publish-snapshot`, { method: "POST" });
}

export function getEdgeDeploymentStatus(id: string) {
  return adminApiFetch<EdgeDeploymentStatus>(`/api/edge/deployments/${encodeURIComponent(id)}/status`);
}
