import { useEffect, useState } from "react";
import { type PortalDashboardResult } from "@sentinel/shared";
import { portalApiFetch as apiFetch } from "../shared/api/portalApi";
import { todayStartIso } from "../lib/today";

export function usePortalDashboard() {
  const since = todayStartIso();
  const [dashboard, setDashboard] = useState<PortalDashboardResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    apiFetch<PortalDashboardResult>(`/api/dashboard/portal?since=${encodeURIComponent(since)}`)
      .then((data) => { if (active) setDashboard(data); })
      .catch((loadError) => { if (active) { setDashboard(null); setError(loadError instanceof Error ? loadError.message : "态势数据加载失败"); } })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [reloadKey, since]);
  return { dashboard, loading, error, reload: () => setReloadKey((value) => value + 1) };
}
