import type { IntelligenceItem } from "@sentinel/shared";

export function confidenceLabel(value: number | null) {
  return value == null ? "未评分" : `${value}%`;
}

export function intelligenceDetailPath(itemOrId: IntelligenceItem | string) {
  if (typeof itemOrId !== "string" && itemOrId.detailPath) return itemOrId.detailPath;
  const id = typeof itemOrId === "string" ? itemOrId : itemOrId.id;
  const encodedId = encodeURIComponent(id);
  return (typeof itemOrId !== "string" && itemOrId.type === "暗网情报") ||
    id.startsWith("DWE-")
    ? `/portal/dark-web/events/${encodedId}`
    : `/portal/intelligence/${encodedId}`;
}

const intelligenceContentPaths: Record<string, string> = {
  "凭据泄露": "/portal/modules/dark-web/credential-leaks",
  "账号口令": "/portal/modules/sensitive/account-password",
  "account-password": "/portal/modules/sensitive/account-password",
  "源码泄露": "/portal/modules/sensitive/source-code",
  "source-code": "/portal/modules/sensitive/source-code",
  "文档泄露": "/portal/modules/sensitive/documents",
  documents: "/portal/modules/sensitive/documents",
  "资产监测": "/portal/modules/exposure/assets",
  subdomain: "/portal/modules/exposure/assets",
  server: "/portal/modules/exposure/assets",
  web: "/portal/modules/exposure/assets",
  fingerprint: "/portal/modules/exposure/assets",
  "仿冒网站": "/portal/modules/exposure/phishing",
  phishing: "/portal/modules/exposure/phishing",
  "漏洞情报": "/portal/modules/vulnerabilities/all",
  "资产漏洞告警": "/portal/modules/vulnerabilities/asset-alerts"
};

export function intelligenceContentPath(item: IntelligenceItem) {
  if (item.type === "暗网情报" && item.subtype === "暗网情报") {
    return intelligenceDetailPath(item);
  }
  const basePath = item.detailPath || intelligenceContentPaths[item.subtype] || (
    item.type === "暗网情报" ? "/portal/modules/dark-web/intelligence" :
      item.type === "敏感泄露" ? "/portal/modules/sensitive/account-password" :
        item.type === "仿冒网站" ? "/portal/modules/exposure/phishing" :
          item.type === "暴露面" ? "/portal/modules/exposure/assets" :
            "/portal/modules/vulnerabilities/all"
  );
  const [pathname, rawQuery = ""] = basePath.split("?", 2);
  const params = new URLSearchParams(rawQuery);
  if (!params.has("query")) params.set("query", item.title);
  if ((item.type === "敏感泄露" || item.type === "仿冒网站") && !params.has("detail")) {
    params.set("detail", item.id);
  }
  return `${pathname}?${params.toString()}`;
}

export function intelligenceQueryPath(filters: { page?: number; pageSize?: number; query?: string; type?: string; excludeType?: string; subtype?: string; risk?: string; includeRiskCounts?: boolean; since?: string; todayOnly?: boolean }) {
  const params = new URLSearchParams();
  params.set("page", String(filters.page ?? 1));
  params.set("page_size", String(filters.pageSize ?? 20));
  if (filters.query) params.set("query", filters.query);
  if (filters.type) params.set("type", filters.type);
  if (filters.excludeType) params.set("exclude_type", filters.excludeType);
  if (filters.subtype) params.set("subtype", filters.subtype);
  if (filters.risk) params.set("risk", filters.risk);
  if (filters.includeRiskCounts) params.set("include_risk_counts", "1");
  if (filters.since) params.set("since", filters.since);
  if (filters.todayOnly) params.set("today_only", "1");
  return `/api/intelligence?${params.toString()}`;
}
