export function resolveCloudApiBaseUrl(value?: string) {
  const normalized = (value ?? "").trim().replace(/\/$/, "");
  if (!normalized) return "";
  const url = new URL(normalized);
  const localHttp = url.protocol === "http:" && (url.hostname === "localhost" || url.hostname.startsWith("127."));
  if (url.protocol !== "https:" && !localHttp) throw new Error("VITE_CLOUD_API_URL 必须使用 HTTPS；仅本机开发地址允许 HTTP");
  return normalized;
}

const cloudApiBaseUrl = resolveCloudApiBaseUrl(import.meta.env.VITE_CLOUD_API_URL);
const adminSessionKey = "sentinel.admin.session";
const adminTenantContextKey = "sentinel.admin.tenant";

function readAccessToken() {
  try {
    const value = window.sessionStorage.getItem(adminSessionKey);
    return value ? (JSON.parse(value) as { token?: string }).token : undefined;
  } catch {
    return undefined;
  }
}

function readTenantContext() {
  return new URLSearchParams(window.location.search).get("tenant")?.trim() || window.sessionStorage.getItem(adminTenantContextKey) || "";
}

export function storeAdminTenantContext(tenantId: string) {
  if (tenantId) window.sessionStorage.setItem(adminTenantContextKey, tenantId);
  else window.sessionStorage.removeItem(adminTenantContextKey);
}

export function adminApiRequestHeaders(initial?: HeadersInit) {
  const headers = new Headers(initial);
  const token = readAccessToken();
  const tenantId = readTenantContext();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (tenantId) headers.set("X-Sentinel-Tenant-Id", tenantId);
  return headers;
}

export function adminApiUrl(path: string) {
  return `${cloudApiBaseUrl}${path}`;
}

export async function adminApiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = adminApiRequestHeaders(options.headers);
  if (options.body !== undefined && !(options.body instanceof FormData)) headers.set("Content-Type", "application/json");
  let response: Response;
  try {
    response = await fetch(adminApiUrl(path), { ...options, headers });
  } catch {
    window.dispatchEvent(new Event("sentinel:system-error"));
    throw new Error("服务暂时不可用，请稍后重试");
  }
  const payload = await response.json().catch(() => ({})) as { message?: string };
  if (!response.ok) {
    if (response.status >= 500) window.dispatchEvent(new Event("sentinel:system-error"));
    const message = response.status >= 500 ? "服务暂时不可用，请稍后重试" : payload.message || "请求无法处理";
    throw new Error(message);
  }
  return payload as T;
}
