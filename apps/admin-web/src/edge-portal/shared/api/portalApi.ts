const adminSessionKey = "sentinel.admin.session";
const tenantStorageKey = "sentinel.cloud.portal.tenant";
const tenantNameStorageKey = "sentinel.cloud.portal.tenant-name";
export const cloudPortalTenantChangedEvent = "sentinel:cloud-portal-tenant-changed";

function readAccessToken() {
  try {
    const value = window.sessionStorage.getItem(adminSessionKey);
    return value ? (JSON.parse(value) as { token?: string }).token : undefined;
  } catch {
    return undefined;
  }
}

export function readCloudPortalTenantId() {
  const requested = new URLSearchParams(window.location.search).get("tenant")?.trim();
  return requested || window.sessionStorage.getItem(tenantStorageKey) || "";
}

export function storeCloudPortalTenant(tenantId: string, tenantName: string) {
  window.sessionStorage.setItem(tenantStorageKey, tenantId);
  window.sessionStorage.setItem(tenantNameStorageKey, tenantName);
  window.dispatchEvent(new Event(cloudPortalTenantChangedEvent));
}

function readCloudPortalTenantName() {
  const tenantId = readCloudPortalTenantId();
  if (window.sessionStorage.getItem(tenantStorageKey) !== tenantId) return "";
  return window.sessionStorage.getItem(tenantNameStorageKey) || "";
}

export function portalApiUrl(path: string) {
  const url = new URL(path, window.location.origin);
  const tenantId = readCloudPortalTenantId();
  if (url.pathname.startsWith("/api/")) {
    if (tenantId && !url.searchParams.has("tenant_id")) url.searchParams.set("tenant_id", tenantId);
    if (!url.searchParams.has("include_drafts")) url.searchParams.set("include_drafts", "1");
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

export function portalApiRequestHeaders(initial?: HeadersInit) {
  const headers = new Headers(initial);
  const token = readAccessToken();
  const tenantId = readCloudPortalTenantId();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (tenantId) headers.set("X-Sentinel-Tenant-Id", tenantId);
  return headers;
}

export async function portalApiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  if (path === "/api/edge-admin/branding") {
    const name = readCloudPortalTenantName() || "企业威胁情报中心";
    return { name, logoUrl: "", loginTitle: "登录威胁情报中心", loginSlogan: "" } as T;
  }

  const headers = portalApiRequestHeaders(options.headers);
  if (options.body !== undefined && !(options.body instanceof FormData)) headers.set("Content-Type", "application/json");
  let response: Response;
  try {
    response = await fetch(portalApiUrl(path), { ...options, headers, credentials: "same-origin" });
  } catch {
    window.dispatchEvent(new Event("sentinel:system-error"));
    throw new Error("服务暂时不可用，请稍后重试");
  }
  const payload = await response.json().catch(() => ({})) as { message?: string };
  if (!response.ok) {
    if (response.status === 401) window.top?.location.assign("/admin/login");
    if (response.status >= 500) window.dispatchEvent(new Event("sentinel:system-error"));
    throw new Error(response.status >= 500 ? "服务暂时不可用，请稍后重试" : payload.message || "请求无法处理");
  }
  return payload as T;
}
