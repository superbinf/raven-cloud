import { createContext, useContext, useEffect, useLayoutEffect, type ReactNode } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import type { EdgeTenant } from "../features/edge-deployments";
import { storeAdminTenantContext } from "../shared/api/adminApi";

type CustomerScope = {
  tenantId: string;
  tenant?: EdgeTenant;
  tenants: EdgeTenant[];
  error: string;
  changeTenant: (tenantId: string) => void;
};

const CustomerScopeContext = createContext<CustomerScope | null>(null);

export function CustomerScopeLayout({ tenants, error, children }: { tenants: EdgeTenant[]; error: string; children: ReactNode }) {
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const enabledTenants = tenants.filter((tenant) => tenant.status !== "disabled");
  const requestedTenantId = searchParams.get("tenant") || "";
  const activeTenant = enabledTenants.find((item) => item.id === requestedTenantId) ?? enabledTenants[0] ?? tenants[0];

  useLayoutEffect(() => { storeAdminTenantContext(activeTenant?.id || ""); }, [activeTenant?.id]);

  useEffect(() => {
    if (!activeTenant || requestedTenantId === activeTenant.id || location.pathname.startsWith("/admin/management")) return;
    const next = new URLSearchParams(location.search);
    next.set("tenant", activeTenant.id);
    navigate(`${location.pathname}?${next.toString()}`, { replace: true });
  }, [activeTenant, location.pathname, location.search, navigate, requestedTenantId]);

  const changeTenant = (tenantId: string) => {
    storeAdminTenantContext(tenantId);
    const next = new URLSearchParams(location.search);
    next.set("tenant", tenantId);
    navigate(`${location.pathname}?${next.toString()}`, { replace: true });
  };

  return <CustomerScopeContext.Provider value={{ tenantId: activeTenant?.id || "", tenant: activeTenant, tenants: enabledTenants, error, changeTenant }}>
    {children}
  </CustomerScopeContext.Provider>;
}

export function useCustomerScope() {
  const value = useContext(CustomerScopeContext);
  if (!value) throw new Error("客户租户上下文尚未初始化");
  return value;
}
