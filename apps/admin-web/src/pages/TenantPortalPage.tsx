import { useCustomerScope } from "../app/CustomerScopeLayout";

export function TenantPortalPage({ tenantId }: { tenantId: string }) {
  const scope = useCustomerScope();
  const activeTenantId = tenantId || scope.tenantId;
  const source = `/tenant-portal.html?tenant=${encodeURIComponent(activeTenantId)}`;

  return (
    <iframe
      key={activeTenantId}
      className="tenant-portal-frame"
      src={source}
      title={`${scope.tenant?.name || "当前客户"} Portal`}
    />
  );
}
