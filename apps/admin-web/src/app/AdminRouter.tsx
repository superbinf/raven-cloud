import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import { Navigate, Route, Routes, useLocation, useParams } from "react-router-dom";
import type { Permission, UserRecord } from "@sentinel/shared";
import { PlatformLoading } from "@sentinel/ui";
import { AdminLayout, AdminLogin, adminSessionKey, readAdminSession, type AdminSession } from "./AdminShell";
import { AdminInitialLoadingProvider } from "./AdminInitialLoading";
import { CustomerScopeLayout, useCustomerScope } from "./CustomerScopeLayout";
import { adminApiFetch } from "../shared/api/adminApi";
import { listEdgeTenants } from "../features/edge-deployments/api/edgeDeploymentsApi";
import type { EdgeTenant } from "../features/edge-deployments/model/types";

const AccountsPage = lazy(() => import("../pages/AccountsPage").then((module) => ({ default: module.AccountsPage })));
const AdminHome = lazy(() => import("../pages/AdminHome").then((module) => ({ default: module.AdminHome })));
const AuditPage = lazy(() => import("../pages/StaticPages").then((module) => ({ default: module.AuditPage })));
const CredentialManagementPage = lazy(() => import("../features/edge-deployments/pages/CredentialManagementPage").then((module) => ({ default: module.CredentialManagementPage })));
const CredentialOperationsPage = lazy(() => import("../pages/TenantOperationsPages").then((module) => ({ default: module.CredentialOperationsPage })));
const CustomersPage = lazy(() => import("../pages/CustomersPage").then((module) => ({ default: module.CustomersPage })));
const DarkWebArticleEditorPage = lazy(() => import("../pages/DarkWebArticleEditorPage").then((module) => ({ default: module.DarkWebArticleEditorPage })));
const EdgeDeploymentsPage = lazy(() => import("../features/edge-deployments/pages/EdgeDeploymentsPage").then((module) => ({ default: module.EdgeDeploymentsPage })));
const FingerprintIconsPage = lazy(() => import("../pages/FingerprintIconsPage").then((module) => ({ default: module.FingerprintIconsPage })));
const FingerprintWatchGroupsPage = lazy(() => import("../pages/FingerprintWatchGroupsPage").then((module) => ({ default: module.FingerprintWatchGroupsPage })));
const IngestionPage = lazy(() => import("../pages/IngestionPage").then((module) => ({ default: module.IngestionPage })));
const InterfacesPage = lazy(() => import("../pages/InterfacesPage").then((module) => ({ default: module.InterfacesPage })));
const OperationsStatusPage = lazy(() => import("../pages/OperationsStatusPage").then((module) => ({ default: module.OperationsStatusPage })));
const PasswordPolicyPage = lazy(() => import("../pages/PasswordPolicyPage").then((module) => ({ default: module.PasswordPolicyPage })));
const ProfilePage = lazy(() => import("../pages/ProfilePage").then((module) => ({ default: module.ProfilePage })));
const PublicationPoliciesPage = lazy(() => import("../pages/TenantOperationsPages").then((module) => ({ default: module.PublicationPoliciesPage })));
const SchedulesPage = lazy(() => import("../pages/SchedulesPage").then((module) => ({ default: module.SchedulesPage })));
const TaskCenterPage = lazy(() => import("../pages/TaskCenterPage").then((module) => ({ default: module.TaskCenterPage })));
const TargetsPage = lazy(() => import("../pages/TargetsPage").then((module) => ({ default: module.TargetsPage })));
const TenantPortalPage = lazy(() => import("../pages/TenantPortalPage").then((module) => ({ default: module.TenantPortalPage })));
const VulnerabilitiesPage = lazy(() => import("../pages/VulnerabilitiesPage").then((module) => ({ default: module.VulnerabilitiesPage })));

function ScopedTargets({ canManage }: { canManage: boolean }) {
  const { tenantId } = useCustomerScope();
  return <TargetsPage canManage={canManage} tenantId={tenantId} />;
}

function ScopedInterfaces({ canManage }: { canManage: boolean }) {
  const { tenantId } = useCustomerScope();
  return <InterfacesPage canManage={canManage} tenantId={tenantId} />;
}

function ScopedFingerprintWatchGroups({ canManage }: { canManage: boolean }) {
  const { tenantId } = useCustomerScope();
  return <FingerprintWatchGroupsPage canManage={canManage} tenantId={tenantId} />;
}

function ScopedIngestion({ mode }: { mode: "sensitive" | "asset" | "dark-web" | "vulnerabilities" }) {
  const { tenantId } = useCustomerScope();
  if (mode === "vulnerabilities") return <VulnerabilitiesPage tenantId={tenantId} />;
  return <IngestionPage mode={mode} tenantId={tenantId} />;
}

function ScopedDarkWebArticleEditor() {
  return <DarkWebArticleEditorPage />;
}

function ScopedCredentialOperations() {
  const { tenantId } = useCustomerScope();
  return <CredentialOperationsPage tenantId={tenantId} />;
}

function ScopedPublicationPolicies() {
  const { tenantId } = useCustomerScope();
  return <PublicationPoliciesPage tenantId={tenantId} />;
}

function ScopedPortalPreview() {
  const { tenantId } = useCustomerScope();
  return <TenantPortalPage tenantId={tenantId} />;
}

function ScopedEdgeDeployments() {
  const { tenantId } = useCustomerScope();
  return <EdgeDeploymentsPage tenantId={tenantId} />;
}

function ScopedDeploymentCredentials() {
  const { tenantId } = useCustomerScope();
  return <CredentialManagementPage tenantId={tenantId} />;
}

function LegacyCustomerRedirect() {
  const { tenantId = "" } = useParams();
  return <Navigate to={`/admin/customer-operations/scope?tenant=${encodeURIComponent(decodeURIComponent(tenantId))}`} replace />;
}

export function AdminRouter() {
  const location = useLocation();
  const [session, setSession] = useState<AdminSession | null>(() => readAdminSession());
  const [checkingSession, setCheckingSession] = useState(true);
  const [customerScope, setCustomerScope] = useState<{ tenants: EdgeTenant[]; error: string } | null>(null);

  useEffect(() => {
    if (!session) {
      setCheckingSession(false);
      return;
    }

    let active = true;
    adminApiFetch<UserRecord>("/api/auth/me")
      .then((user) => {
        if (!active) return;
        if (!["admin", "both"].includes(user.workspace)) throw new Error("当前账号无云端运营权限");
        const current = readAdminSession();
        if (!current) throw new Error("登录状态已失效");
        const next = { ...current, user };
        window.sessionStorage.setItem(adminSessionKey, JSON.stringify(next));
        setSession(next);
      })
      .catch(() => {
        if (!active) return;
        window.sessionStorage.removeItem(adminSessionKey);
        setSession(null);
      })
      .finally(() => {
        if (active) setCheckingSession(false);
      });

    return () => { active = false; };
  }, []);

  const customerScopeRoute = location.pathname.startsWith("/admin") && (!location.pathname.startsWith("/admin/management") || location.pathname === "/admin/management/customers");
  const shouldLoadCustomerScope = Boolean(
    !checkingSession
    && session?.user.permissions.includes("targets:read")
    && customerScopeRoute
    && customerScope === null
  );

  useEffect(() => {
    if (!shouldLoadCustomerScope) return;
    let active = true;
    listEdgeTenants()
      .then((tenants) => {
        if (active) setCustomerScope({ tenants, error: "" });
      })
      .catch((reason) => {
        if (active) setCustomerScope({ tenants: [], error: reason instanceof Error ? reason.message : "客户列表加载失败" });
      });
    return () => { active = false; };
  }, [shouldLoadCustomerScope]);

  const logout = () => {
    void adminApiFetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    window.sessionStorage.removeItem(adminSessionKey);
    setCustomerScope(null);
    setSession(null);
  };
  const login = (nextSession: AdminSession) => {
    setCustomerScope(null);
    setSession(nextSession);
  };
  const updateSessionUser = (user: UserRecord) => {
    if (!session) return;
    const next = { ...session, user };
    window.sessionStorage.setItem(adminSessionKey, JSON.stringify(next));
    setSession(next);
  };
  const allowed = (permission: Permission, element: ReactNode) => session?.user.permissions.includes(permission) ? element : <Navigate to="/admin" replace />;
  const canTargets = Boolean(session?.user.permissions.includes("targets:manage"));
  const canSources = Boolean(session?.user.permissions.includes("sources:manage"));
  const managementLanding = session?.user.permissions.includes("targets:read")
    ? "/admin/management/customers"
    : session?.user.permissions.includes("accounts:manage")
      ? "/admin/management/users"
      : session?.user.permissions.includes("ingestion:manage")
        ? "/admin/management/fingerprint-library"
        : "/admin";

  if (checkingSession || shouldLoadCustomerScope) return <PlatformLoading />;

  return <AdminInitialLoadingProvider><Suspense fallback={<PlatformLoading />}><Routes>
    <Route path="/admin/login" element={session ? <Navigate to="/admin" replace /> : <AdminLogin onLogin={login} />} />
    <Route path="/admin/tenant-portal" element={session ? allowed("ingestion:manage", <CustomerScopeLayout tenants={customerScope?.tenants ?? []} error={customerScope?.error ?? ""}><ScopedPortalPreview /></CustomerScopeLayout>) : <Navigate to="/admin/login" replace />} />
    <Route path="/admin" element={session ? <CustomerScopeLayout tenants={customerScope?.tenants ?? []} error={customerScope?.error ?? ""}><AdminLayout session={session} onLogout={logout} /></CustomerScopeLayout> : <Navigate to="/admin/login" replace />}>
      <Route index element={<AdminHome permissions={session?.user.permissions || []} />} />
      <Route path="customer-operations">
        <Route path="customers" element={<Navigate to="/admin/management/customers" replace />} />
        <Route>
          <Route index element={<Navigate to="scope" replace />} />
          <Route path="scope" element={allowed("targets:read", <ScopedTargets canManage={canTargets} />)} />
          <Route path="interfaces" element={allowed("sources:read", <ScopedInterfaces canManage={canSources} />)} />
          <Route path="ingestion/sensitive" element={allowed("ingestion:manage", <ScopedIngestion mode="sensitive" />)} />
          <Route path="ingestion/assets" element={allowed("ingestion:manage", <ScopedIngestion mode="asset" />)} />
          <Route path="ingestion/dark-web" element={allowed("ingestion:manage", <ScopedIngestion mode="dark-web" />)} />
          <Route path="ingestion/dark-web/editor/:recordId" element={allowed("ingestion:manage", <ScopedDarkWebArticleEditor />)} />
          <Route path="ingestion/credentials" element={allowed("ingestion:manage", <ScopedCredentialOperations />)} />
          <Route path="ingestion/vulnerabilities" element={allowed("ingestion:manage", <ScopedIngestion mode="vulnerabilities" />)} />
          <Route path="publication-policies" element={<Navigate to="/admin/operations/publication-policies" replace />} />
          <Route path="portal-preview" element={<Navigate to="/admin/tenant-portal" replace />} />
          <Route path="fingerprint-watch-groups" element={allowed("targets:read", <ScopedFingerprintWatchGroups canManage={canTargets} />)} />
        </Route>
      </Route>
      <Route path="operations/credentials" element={allowed("operations:manage", <ScopedDeploymentCredentials />)} />
      <Route path="operations/edge-deployments" element={allowed("operations:manage", <ScopedEdgeDeployments />)} />
      <Route path="operations/tasks" element={allowed("operations:manage", <TaskCenterPage />)} />
      <Route path="operations/schedules" element={allowed("operations:manage", <SchedulesPage />)} />
      <Route path="operations/status" element={allowed("operations:manage", <OperationsStatusPage />)} />
      <Route path="operations/publication-policies" element={allowed("ingestion:manage", <ScopedPublicationPolicies />)} />
      <Route path="management" element={<Navigate to={managementLanding} replace />} />
      <Route path="management/customers" element={allowed("targets:read", <CustomersPage tenants={customerScope?.tenants ?? []} canManage={canTargets} onChanged={(tenants) => setCustomerScope({ tenants, error: "" })} />)} />
      <Route path="management/users" element={allowed("accounts:manage", <AccountsPage currentAccount={session?.user.account || ""} onCurrentSessionRevoked={logout} />)} />
      <Route path="management/password-policy" element={allowed("accounts:manage", <PasswordPolicyPage />)} />
      <Route path="management/audit" element={allowed("accounts:manage", <AuditPage context="all" />)} />
      <Route path="management/fingerprint-library" element={allowed("ingestion:manage", <FingerprintIconsPage />)} />
      <Route path="profile" element={<ProfilePage onProfileUpdated={updateSessionUser} />} />

      <Route path="customers" element={<Navigate to="../customer-operations/scope" replace />} />
      <Route path="customers/:tenantId/*" element={<LegacyCustomerRedirect />} />
      <Route path="accounts" element={<Navigate to="../management/users" replace />} />
      <Route path="targets" element={<Navigate to="../customer-operations/scope" replace />} />
      <Route path="schedules" element={<Navigate to="../operations/schedules" replace />} />
      <Route path="tasks" element={<Navigate to="../operations/tasks" replace />} />
      <Route path="audit" element={<Navigate to="../management/audit" replace />} />
      <Route path="fingerprint-watch-groups" element={<Navigate to="../customer-operations/fingerprint-watch-groups" replace />} />
      <Route path="interfaces" element={<Navigate to="../customer-operations/interfaces" replace />} />
      <Route path="vulnerabilities" element={<Navigate to="../customer-operations/ingestion/vulnerabilities" replace />} />
      <Route path="ingestion/*" element={<Navigate to="../customer-operations/ingestion/sensitive" replace />} />
      <Route path="edge-deployments" element={<Navigate to="../operations/edge-deployments" replace />} />
      <Route path="data-operations/fingerprint-library" element={<Navigate to="/admin/management/fingerprint-library" replace />} />
      <Route path="operations/fingerprint-icons" element={<Navigate to="/admin/management/fingerprint-library" replace />} />
      <Route path="ai" element={<Navigate to="../" replace />} />
    </Route>
    <Route path="/" element={<Navigate to="/admin" replace />} />
    <Route path="*" element={<Navigate to="/admin" replace />} />
  </Routes></Suspense></AdminInitialLoadingProvider>;
}
