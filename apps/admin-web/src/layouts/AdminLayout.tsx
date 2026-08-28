import { useEffect, useState, type FormEvent } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { Activity, Archive, Bug, Building2, ChevronRight, CircleGauge, CircleUserRound, Clock3, Database, Eye, FileInput, Fingerprint, Globe2, HardDrive, ImageIcon, KeyRound, LayoutDashboard, ListTodo, LockKeyhole, LogIn, LogOut, Menu, PanelLeftClose, PanelLeftOpen, ServerCog, Settings, ShieldCheck, SlidersHorizontal, Users, Webhook } from "lucide-react";
import { type Permission } from "@sentinel/shared";
import { Button, CaptchaField, IconButton, PasswordInput, ThemeSwitcher, cn, type CaptchaChallenge, useLoginCaptcha } from "@/components/ui";
import { adminApiFetch } from "@/api/admin";
import type { AdminSession } from "@/types";
import { useCustomerScope } from "./CustomerScopeLayout";

type OtpChallenge = { otpRequired: true; account: string; challengeId: string; expiresAt: string };
const loadCaptcha = () => adminApiFetch<CaptchaChallenge>("/api/auth/captcha");

type NavItem = { to: string; label: string; icon: typeof CircleGauge; end?: boolean; permission?: Permission };
type WorkspaceMode = "operations" | "management";

const operationsNav: Array<{ label: string; items: NavItem[] }> = [
  { label: "工作台", items: [
    { to: "/admin", label: "运营总览", icon: LayoutDashboard, end: true },
    { to: "/admin/tenant-portal", label: "客户 Portal", icon: Eye, permission: "ingestion:manage" }
  ] },
  { label: "监测与采集", items: [
    { to: "/admin/customer-operations/scope", label: "监测范围", icon: Globe2, permission: "targets:read" },
    { to: "/admin/customer-operations/fingerprint-watch-groups", label: "指纹监测策略", icon: Fingerprint, permission: "targets:read" },
    { to: "/admin/customer-operations/interfaces", label: "数据源接口", icon: Webhook, permission: "sources:read" }
  ] },
  { label: "情报运营", items: [
    { to: "/admin/customer-operations/ingestion/sensitive", label: "敏感信息", icon: FileInput, permission: "ingestion:manage" },
    { to: "/admin/customer-operations/ingestion/assets", label: "资产信息", icon: Database, permission: "ingestion:manage" },
    { to: "/admin/customer-operations/ingestion/dark-web", label: "暗网情报", icon: Archive, permission: "ingestion:manage" },
    { to: "/admin/customer-operations/ingestion/credentials", label: "账号凭据", icon: KeyRound, permission: "ingestion:manage" },
    { to: "/admin/customer-operations/ingestion/vulnerabilities", label: "漏洞情报", icon: Bug, permission: "ingestion:manage" }
  ] },
  { label: "发布与交付", items: [
    { to: "/admin/operations/publication-policies", label: "发布策略", icon: SlidersHorizontal, permission: "ingestion:manage" },
    { to: "/admin/operations/edge-deployments", label: "地端部署", icon: HardDrive, permission: "operations:manage" },
    { to: "/admin/operations/credentials", label: "许可证与 API Key", icon: KeyRound, permission: "operations:manage" }
  ] },
  { label: "运行保障", items: [
    { to: "/admin/operations/tasks", label: "任务中心", icon: ListTodo, permission: "operations:manage" },
    { to: "/admin/operations/schedules", label: "调度计划", icon: Clock3, permission: "operations:manage" },
    { to: "/admin/operations/workers", label: "Worker 节点", icon: ServerCog, permission: "operations:manage" },
    { to: "/admin/operations/status", label: "运行状态", icon: Activity, permission: "operations:manage" }
  ] }
];

const managementNav: Array<{ label: string; items: NavItem[] }> = [
  { label: "客户与权限", items: [
    { to: "/admin/management/customers", label: "客户管理", icon: Building2, permission: "targets:read" },
    { to: "/admin/management/users", label: "用户与角色", icon: Users, permission: "accounts:manage" }
  ] },
  { label: "安全与审计", items: [
    { to: "/admin/management/password-policy", label: "密码策略", icon: LockKeyhole, permission: "accounts:manage" },
    { to: "/admin/management/audit", label: "操作审计", icon: Archive, permission: "accounts:manage" }
  ] },
  { label: "平台基础能力", items: [
    { to: "/admin/management/fingerprint-library", label: "指纹识别库", icon: ImageIcon, permission: "ingestion:manage" }
  ] }
];

function AdminBrand({ mode = "operations" }: { mode?: WorkspaceMode }) {
  const home = mode === "management" ? "/admin/management" : "/admin";
  const label = mode === "management" ? "云端管理后台" : "云端运营平台";
  return <Link to={home} className="admin-brand" aria-label={`SENTINEL ${label}首页`}><span><ShieldCheck size={22} /></span><div><strong>SENTINEL</strong><small>{label}</small></div></Link>;
}

export function AdminLogin({ onLogin }: { onLogin: (session: AdminSession) => void }) {
  const [account, setAccount] = useState("");
  const [password, setPassword] = useState("");
  const [otpCode, setOtpCode] = useState("");
  const [otpChallenge, setOtpChallenge] = useState<OtpChallenge | null>(null);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const captcha = useLoginCaptcha(loadCaptcha);
  const finishLogin = (response: AdminSession) => {
    if (!["admin", "both"].includes(response.user.workspace)) throw new Error("当前账号无云端运营权限");
    onLogin(response);
  };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      if (otpChallenge) {
        finishLogin(await adminApiFetch<AdminSession>("/api/auth/login/otp", { method: "POST", body: JSON.stringify({ challengeId: otpChallenge.challengeId, code: otpCode }) }));
      } else {
        const response = await adminApiFetch<AdminSession | OtpChallenge>("/api/auth/login", { method: "POST", body: JSON.stringify({ account: account.trim(), password, captchaId: captcha.challenge?.captchaId, captchaCode: captcha.code }) });
        if ("otpRequired" in response && response.otpRequired) {
          setOtpChallenge(response);
          setOtpCode("");
          setPassword("");
        } else finishLogin(response as AdminSession);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "登录失败");
      if (!otpChallenge) await captcha.refresh();
    } finally {
      setSubmitting(false);
    }
  };
  return <main className="admin-login-shell"><section className="admin-login-card"><div className="admin-login-brand-row"><AdminBrand /><ThemeSwitcher className="login-theme-switcher" /></div><span className="eyebrow">CLOUD OPERATIONS ACCESS</span><h1>登录云端运营平台</h1><form className="admin-login-form" onSubmit={submit} autoComplete="off">{otpChallenge ? <><label>动态验证码<input value={otpCode} onChange={(event) => setOtpCode(event.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" autoFocus placeholder="输入 6 位验证码" /></label>{error && <div className="admin-login-error" role="alert">{error}</div>}<Button type="submit" disabled={submitting || otpCode.length !== 6}><KeyRound size={17} />{submitting ? "验证中..." : "验证并登录"}</Button><button className="text-action" type="button" onClick={() => { setOtpChallenge(null); setOtpCode(""); setError(""); void captcha.refresh(); }}>返回账号密码登录</button></> : <><label>运营账号<input value={account} onChange={(event) => setAccount(event.target.value)} autoComplete="off" /></label><label htmlFor="admin-password">密码<PasswordInput id="admin-password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" /></label><CaptchaField id="admin-login-captcha" challenge={captcha.challenge} code={captcha.code} loading={captcha.loading} error={captcha.error} onCodeChange={captcha.setCode} onRefresh={() => void captcha.refresh()} />{error && <div className="admin-login-error" role="alert">{error}</div>}<Button type="submit" disabled={submitting || !captcha.challenge || captcha.code.length !== captcha.challenge.length}><LogIn size={17} />{submitting ? "登录中..." : "登录平台"}</Button></>}</form></section></main>;
}

export function AdminLayout({ session, onLogout }: { session: AdminSession; onLogout: () => void }) {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();
  const customerScope = useCustomerScope();
  const mode: WorkspaceMode = location.pathname.startsWith("/admin/management") ? "management" : "operations";
  const navGroups = mode === "management" ? managementNav : operationsNav;
  const can = (permission?: Permission) => !permission || session.user.permissions.includes(permission);
  useEffect(() => { setMobileOpen(false); }, [location.pathname]);
  const switchTarget = mode === "management" ? "/admin" : "/admin/management";
  const switchLabel = mode === "management" ? "返回运营平台" : "进入管理后台";
  const tenantSearch = customerScope.tenantId ? `?tenant=${encodeURIComponent(customerScope.tenantId)}` : "";
  const showTenantSwitch = mode === "operations" && location.pathname !== "/admin/profile";
  const showRole = Boolean(session.user.role && session.user.role !== session.user.name);
  return (
    <div className={cn("admin-shell", `workspace-${mode}`, collapsed && "sidebar-collapsed", mobileOpen && "mobile-sidebar-open")}>
      <aside className="admin-sidebar">
        <div className="sidebar-brand"><AdminBrand mode={mode} /><IconButton className="sidebar-toggle" label={collapsed ? "展开侧栏" : "折叠侧栏"} onClick={() => setCollapsed((value) => !value)}>{collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}</IconButton></div>
        <nav aria-label={mode === "management" ? "管理后台导航" : "运营平台导航"}>{navGroups.map((group) => ({ ...group, items: group.items.filter((item) => can(item.permission)) })).filter((group) => group.items.length).map((group) => <section key={group.label}><h2>{group.label}</h2>{group.items.map((item) => {
          const Icon = item.icon;
          const itemSearch = mode === "operations" ? tenantSearch : "";
          return <NavLink to={`${item.to}${itemSearch}`} end={item.end} key={item.to} onClick={() => setMobileOpen(false)}><Icon size={18} /><span>{item.label}</span><ChevronRight className="nav-chevron" size={15} /></NavLink>;
        })}</section>)}</nav>
      </aside>
      <div className="admin-workspace">
        <header className="admin-topbar"><IconButton label="打开导航" className="mobile-menu" onClick={() => setMobileOpen(true)}><Menu size={20} /></IconButton><Link className="admin-mobile-brand" aria-label="SENTINEL 云端平台首页" to={mode === "management" ? "/admin/management/users" : `/admin${tenantSearch}`}><ShieldCheck size={20} /><strong>SENTINEL</strong></Link><div className="breadcrumb"><span>{mode === "management" ? "管理后台" : "运营平台"}</span><ChevronRight size={14} /><strong>{currentPageLabel(location.pathname)}</strong></div>{showTenantSwitch && <label className="topbar-tenant"><Building2 size={16} /><span>当前客户</span><select aria-label="切换当前客户" value={customerScope.tenantId} disabled={!customerScope.tenants.length} onChange={(event) => customerScope.changeTenant(event.target.value)}>{customerScope.tenants.map((tenant) => <option key={tenant.id} value={tenant.id}>{tenant.name}</option>)}</select></label>}<div className="topbar-actions"><div className="environment"><span />云端环境</div><ThemeSwitcher /><Link className="icon-button workspace-switch" aria-label={switchLabel} title={switchLabel} to={switchTarget}><Settings size={18} /></Link><Link className="admin-user" to="/admin/profile" title="个人中心"><CircleUserRound size={20} /><span><strong>{session.user.name}</strong>{showRole && <small>{session.user.role}</small>}</span></Link><IconButton label="退出登录" onClick={onLogout}><LogOut size={18} /></IconButton></div></header>
        <main className="admin-main"><Outlet /></main>
      </div>
      {mobileOpen && <button className="sidebar-scrim" aria-label="关闭导航" onClick={() => setMobileOpen(false)} />}
    </div>
  );
}

function currentPageLabel(path: string) {
  if (path.startsWith("/admin/customer-operations/ingestion/dark-web/editor/")) return "暗网正文编辑";
  const labels: Record<string, string> = {
    "/admin": "运营总览",
    "/admin/customer-operations/customers": "客户管理", "/admin/customer-operations/scope": "监测范围", "/admin/customer-operations/interfaces": "数据源接口",
    "/admin/customer-operations/ingestion/sensitive": "敏感信息",
    "/admin/customer-operations/ingestion/assets": "资产信息",
    "/admin/customer-operations/ingestion/dark-web": "暗网情报",
    "/admin/customer-operations/ingestion/credentials": "账号凭据",
    "/admin/customer-operations/ingestion/vulnerabilities": "漏洞情报",
    "/admin/customer-operations/publication-policies": "发布策略",
    "/admin/customer-operations/portal-preview": "客户 Portal",
    "/admin/customer-operations/fingerprint-watch-groups": "指纹监测策略",
    "/admin/operations/credentials": "许可证与 API Key", "/admin/data-operations/fingerprint-library": "指纹识别库", "/admin/operations/fingerprint-icons": "指纹识别库", "/admin/operations/edge-deployments": "地端部署", "/admin/operations/tasks": "任务中心", "/admin/operations/schedules": "调度计划",
    "/admin/operations/status": "运行状态", "/admin/operations/workers": "Worker 节点", "/admin/operations/audit": "操作审计",
    "/admin/operations/publication-policies": "发布策略", "/admin/tenant-portal": "客户 Portal", "/admin/profile": "个人中心",
    "/admin/management/customers": "客户管理", "/admin/management/users": "用户与角色", "/admin/management/password-policy": "密码策略", "/admin/management/audit": "操作审计", "/admin/management/fingerprint-library": "指纹识别库"
  };
  return labels[path] ?? "运营平台";
}
