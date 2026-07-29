import { useEffect, useRef, useState } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { ArrowLeft, Building2, ChevronDown, ChevronRight, Menu, UserRound, X } from "lucide-react";
import type { EdgePortalModule } from "@sentinel/contracts";
import type { Permission } from "@sentinel/shared";
import { IconButton, ThemeSwitcher, cn } from "@sentinel/ui";
import { portalApiFetch, readCloudPortalTenantId, storeCloudPortalTenant } from "../shared/api/portalApi";
import { EdgeBrandLogo, useEdgeBranding } from "../shared/edgeBranding";

export const portalSessionKey = "sentinel.admin.session";

export type PortalSession = {
  id?: string;
  account: string;
  name: string;
  role: string;
  workspace: "portal" | "admin" | "both";
  permissions: Permission[];
  token?: string;
};

type Tenant = { id: string; name: string; status: "active" | "disabled" };

export function readPortalSession(): PortalSession | null {
  try {
    const value = window.sessionStorage.getItem(portalSessionKey);
    if (!value) return null;
    const admin = JSON.parse(value) as { token?: string; user?: Omit<PortalSession, "token"> };
    return admin.token && admin.user ? { ...admin.user, token: admin.token } : null;
  } catch {
    return null;
  }
}

const portalNavItems: Array<{ label: string; to: string; end?: boolean; module: EdgePortalModule }> = [
  { label: "态势总览", to: "/portal", end: true, module: "overview" },
  { label: "态势大屏", to: "/portal/dashboard", module: "dashboard" },
  { label: "综合查询", to: "/portal/search", end: true, module: "search" }
];

const portalNavGroups: Array<{ label: string; module: EdgePortalModule; items: Array<{ label: string; to: string }> }> = [
  { label: "暗网监测", module: "dark-web", items: [{ label: "凭据泄露", to: "/portal/modules/dark-web/credential-leaks" }, { label: "暗网情报", to: "/portal/modules/dark-web/intelligence" }] },
  { label: "敏感信息", module: "sensitive", items: [{ label: "账号口令", to: "/portal/modules/sensitive/account-password" }, { label: "源码泄露", to: "/portal/modules/sensitive/source-code" }, { label: "文档泄露", to: "/portal/modules/sensitive/documents" }] },
  { label: "互联网暴露面", module: "exposure", items: [{ label: "资产监测", to: "/portal/modules/exposure/assets" }, { label: "仿冒网站", to: "/portal/modules/exposure/phishing" }] },
  { label: "漏洞情报", module: "vulnerabilities", items: [{ label: "全量漏洞", to: "/portal/modules/vulnerabilities/all" }, { label: "重保漏洞情报", to: "/portal/modules/vulnerabilities/major-event" }, { label: "资产漏洞告警", to: "/portal/modules/vulnerabilities/asset-alerts" }] }
];

export function Brand() {
  const branding = useEdgeBranding();
  return <Link to="/portal" className="brand" aria-label={`${branding.name}首页`} title={branding.name}><EdgeBrandLogo branding={branding} className="portal-brand-logo" fallbackClassName="portal-brand-text" /></Link>;
}

export function PortalLayout({ session, enabledModules }: { session: PortalSession; enabledModules: EdgePortalModule[] }) {
  const [open, setOpen] = useState(false);
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [tenantId, setTenantId] = useState(readCloudPortalTenantId());
  const navRef = useRef<HTMLElement>(null);
  const location = useLocation();

  useEffect(() => {
    portalApiFetch<Tenant[]>("/api/edge/tenants").then((items) => {
      const active = items.filter((item) => item.status !== "disabled");
      const selected = active.find((item) => item.id === tenantId) || active[0];
      setTenants(active);
      if (selected) {
        setTenantId(selected.id);
        storeCloudPortalTenant(selected.id, selected.name);
      }
    }).catch(() => setTenants([]));
  }, [tenantId]);

  useEffect(() => { setOpen(false); setOpenGroup(null); }, [location.pathname, location.search]);
  useEffect(() => {
    if (!openGroup) return;
    const closeOnOutsideClick = (event: PointerEvent) => { if (!navRef.current?.contains(event.target as Node)) setOpenGroup(null); };
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpenGroup(null); };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => { document.removeEventListener("pointerdown", closeOnOutsideClick); document.removeEventListener("keydown", closeOnEscape); };
  }, [openGroup]);

  const changeTenant = (nextTenantId: string) => {
    const tenant = tenants.find((item) => item.id === nextTenantId);
    if (!tenant) return;
    storeCloudPortalTenant(tenant.id, tenant.name);
    window.top?.location.assign(`/admin/tenant-portal?tenant=${encodeURIComponent(tenant.id)}`);
  };

  return <div className="portal-shell">
    <a className="skip-link" href="#main-content">跳到主要内容</a>
    <header className="portal-header">
      <Brand />
      <nav ref={navRef} className={cn("portal-nav", open && "portal-nav-open")} aria-label="主导航">
        {portalNavItems.filter((item) => enabledModules.includes(item.module)).map((item) => <NavLink key={item.label} to={item.to} end={item.end}>{item.label}</NavLink>)}
        {portalNavGroups.filter((group) => enabledModules.includes(group.module)).map((group, groupIndex) => {
          const expanded = openGroup === group.label;
          const menuId = `portal-nav-menu-${groupIndex}`;
          return <div className={cn("portal-nav-group", expanded && "portal-nav-group-open", (group.items.some((item) => location.pathname === item.to) || (group.label === "暗网监测" && location.pathname.startsWith("/portal/dark-web/"))) && "portal-nav-group-active")} key={group.label}>
            <button type="button" aria-haspopup="menu" aria-controls={menuId} aria-expanded={expanded} onClick={() => setOpenGroup((value) => value === group.label ? null : group.label)}><span>{group.label}</span><ChevronDown size={15} aria-hidden="true" /></button>
            <div id={menuId} className="portal-nav-menu" role="menu">{group.items.map((item) => <NavLink role="menuitem" tabIndex={expanded ? 0 : -1} key={item.label} to={item.to}><span>{item.label}</span><ChevronRight size={14} aria-hidden="true" /></NavLink>)}</div>
          </div>;
        })}
      </nav>
      <div className="header-actions">
        <label className="cloud-portal-tenant"><Building2 size={15} /><select aria-label="切换当前客户" value={tenantId} onChange={(event) => changeTenant(event.target.value)}>{tenants.map((tenant) => <option key={tenant.id} value={tenant.id}>{tenant.name}</option>)}</select></label>
        <span className="cloud-portal-draft-status">含草稿</span>
        <ThemeSwitcher />
        <a className="icon-button" aria-label="返回运营平台" title="返回运营平台" href={`/admin?tenant=${encodeURIComponent(tenantId)}`}><ArrowLeft size={18} /></a>
        <a className="portal-session-user" href="/admin/profile" title="个人中心"><UserRound size={17} /><span>{session.name}</span></a>
        <IconButton label={open ? "关闭导航" : "打开导航"} className="menu-button" onClick={() => setOpen((value) => !value)}>{open ? <X size={20} /> : <Menu size={20} />}</IconButton>
      </div>
    </header>
    <main id="main-content"><Outlet /></main>
  </div>;
}
