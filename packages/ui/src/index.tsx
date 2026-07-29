import { Component, useCallback, useEffect, useRef, useState, type ButtonHTMLAttributes, type ErrorInfo, type FormEvent, type HTMLAttributes, type InputHTMLAttributes, type ReactNode } from "react";
import { CircleAlert, Eye, EyeOff, House, KeyRound, MoonStar, RefreshCw, ShieldCheck, Sun, X } from "lucide-react";
import type { RiskLevel } from "@sentinel/shared";

export function cn(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

export type UiTheme = "dark" | "light";

const themeStorageKey = "sentinel.ui.theme";
const themeOrder: UiTheme[] = ["dark", "light"];
const themeLabels: Record<UiTheme, string> = {
  dark: "深色主题",
  light: "浅色主题"
};

function normalizeTheme(value: string | null): UiTheme | null {
  if (value === "dark" || value === "sentinel") return "dark";
  if (value === "light") return "light";
  return null;
}

function readStoredTheme(): UiTheme {
  try {
    const stored = window.localStorage.getItem(themeStorageKey);
    return normalizeTheme(stored) ?? "dark";
  } catch {
    return "dark";
  }
}

function applyTheme(theme: UiTheme) {
  document.documentElement.dataset.theme = theme;
  try {
    window.localStorage.setItem(themeStorageKey, theme);
  } catch {
    // The theme still applies when storage is unavailable.
  }
}

export function initializeUiTheme() {
  applyTheme(readStoredTheme());
}

export function ThemeSwitcher({ className }: { className?: string }) {
  const [theme, setTheme] = useState<UiTheme>(() => readStoredTheme());
  const nextTheme = themeOrder[(themeOrder.indexOf(theme) + 1) % themeOrder.length];
  const nextLabel = themeLabels[nextTheme];
  const ThemeIcon = theme === "dark" ? MoonStar : Sun;

  useEffect(() => {
    applyTheme(theme);
    const syncTheme = (event: StorageEvent) => {
      if (event.key === themeStorageKey) setTheme(normalizeTheme(event.newValue) ?? "dark");
    };
    window.addEventListener("storage", syncTheme);
    return () => window.removeEventListener("storage", syncTheme);
  }, [theme]);

  return (
    <button
      type="button"
      className={cn("theme-switcher", className)}
      aria-label={`切换为${nextLabel}`}
      title={`当前为${themeLabels[theme]}，点击切换为${nextLabel}`}
      onClick={() => setTheme(nextTheme)}
    >
      <ThemeIcon size={17} aria-hidden="true" />
      <span>{themeLabels[theme]}</span>
    </button>
  );
}

export function PasswordInput({ className, ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, "type">) {
  const [visible, setVisible] = useState(false);
  const label = visible ? "隐藏密码" : "显示密码";
  const VisibilityIcon = visible ? EyeOff : Eye;

  return (
    <span className="password-input">
      <input {...props} className={className} type={visible ? "text" : "password"} />
      <button type="button" className="password-input-toggle" aria-label={label} aria-pressed={visible} title={label} onClick={() => setVisible((value) => !value)}>
        <VisibilityIcon size={17} aria-hidden="true" />
      </button>
    </span>
  );
}

type PasswordPolicyView = {
  minLength: number;
  maxLength: number;
  requireUppercase: boolean;
  requireLowercase: boolean;
  requireNumber: boolean;
  requireSpecial: boolean;
  forbidAccountParts: boolean;
  historyCount: number;
};

export function ForcedPasswordChange({ reason, policy, onSubmit }: { reason?: "initial" | "expired" | null; policy: PasswordPolicyView; onSubmit: (currentPassword: string, newPassword: string) => Promise<void> }) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");
    if (newPassword !== confirmation) { setError("两次输入的新密码不一致"); return; }
    setBusy(true);
    try { await onSubmit(currentPassword, newPassword); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "密码修改失败"); }
    finally { setBusy(false); }
  };
  const requirements = [
    `${policy.minLength}-${policy.maxLength} 位`, policy.requireUppercase && "大写字母", policy.requireLowercase && "小写字母",
    policy.requireNumber && "数字", policy.requireSpecial && "特殊字符", policy.forbidAccountParts && "不包含账号或姓名",
    `不能与最近 ${policy.historyCount} 次密码相同`
  ].filter(Boolean).join("、");
  return <main className="forced-password-shell"><section className="forced-password-panel" aria-labelledby="forced-password-title">
    <span className="forced-password-icon"><KeyRound size={24} /></span><span className="eyebrow">ACCOUNT SECURITY</span>
    <h1 id="forced-password-title">需要修改密码</h1>
    <p>{reason === "expired" ? "当前密码已到期，修改后才能继续使用系统。" : "这是该账号首次登录，必须先设置新的个人密码。"}</p>
    <form onSubmit={submit}>
      <label htmlFor="forced-current-password">当前密码<PasswordInput id="forced-current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} autoComplete="current-password" required autoFocus /></label>
      <label htmlFor="forced-new-password">新密码<PasswordInput id="forced-new-password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} autoComplete="new-password" minLength={policy.minLength} maxLength={policy.maxLength} required /></label>
      <label htmlFor="forced-confirm-password">确认新密码<PasswordInput id="forced-confirm-password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="new-password" minLength={policy.minLength} maxLength={policy.maxLength} required /></label>
      <small>{requirements}</small>{error && <div className="forced-password-error" role="alert">{error}</div>}
      <Button type="submit" disabled={busy || !currentPassword || !newPassword || !confirmation}><ShieldCheck size={17} />{busy ? "正在修改..." : "修改密码并重新登录"}</Button>
    </form>
  </section></main>;
}

export type CaptchaChallenge = { captchaId: string; image: string; expiresAt: string; length: number };

export function useLoginCaptcha(load: () => Promise<CaptchaChallenge>) {
  const requestId = useRef(0);
  const [challenge, setChallenge] = useState<CaptchaChallenge | null>(null);
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    const currentRequest = ++requestId.current;
    setChallenge(null); setCode(""); setError(""); setLoading(true);
    try {
      const next = await load();
      if (requestId.current === currentRequest) setChallenge(next);
    } catch {
      if (requestId.current === currentRequest) setError("验证码加载失败，请重试");
    } finally {
      if (requestId.current === currentRequest) setLoading(false);
    }
  }, [load]);
  useEffect(() => { void refresh(); return () => { requestId.current += 1; }; }, [refresh]);
  return { challenge, code, setCode, loading, error, refresh };
}

export function CaptchaField({ id, challenge, code, loading, error, onCodeChange, onRefresh }: {
  id: string;
  challenge: CaptchaChallenge | null;
  code: string;
  loading: boolean;
  error?: string;
  onCodeChange: (value: string) => void;
  onRefresh: () => void;
}) {
  const length = challenge?.length || 4;
  return (
    <div className="captcha-field">
      <label htmlFor={id}>图形验证码</label>
      <span className="captcha-control">
        <input id={id} value={code} onChange={(event) => onCodeChange(event.target.value.replace(/[^0-9a-z]/gi, "").toUpperCase().slice(0, length))} inputMode="text" autoCapitalize="characters" autoComplete="off" spellCheck={false} maxLength={length} pattern="[0-9A-Za-z]+" disabled={!challenge || loading} required />
        <span className="captcha-image" aria-live="polite">{challenge ? <img src={challenge.image} alt="验证码图片" width="170" height="52" /> : <small>{loading ? "加载中..." : "加载失败"}</small>}</span>
        <button type="button" className="captcha-refresh" onClick={onRefresh} disabled={loading} aria-label="刷新图形验证码" title="刷新图形验证码"><RefreshCw size={17} aria-hidden="true" /></button>
      </span>
      {error && <small className="captcha-load-error" role="alert">{error}</small>}
    </div>
  );
}

export function RiskBadge({ level, children }: { level: RiskLevel; children?: ReactNode }) {
  const labels: Record<RiskLevel, string> = {
    critical: "严重",
    high: "高危",
    medium: "中危",
    low: "低危",
    info: "信息"
  };
  const safeLevel = level in labels ? level : "info";
  return <span className={cn("risk-badge", `risk-${safeLevel}`)}>{children ?? labels[safeLevel]}</span>;
}

export function Tag({ children, tone = "default" }: { children: ReactNode; tone?: "default" | "cyan" | "pink" | "orange" | "green" }) {
  return <span className={cn("tag", `tag-${tone}`)}>{children}</span>;
}

export function Panel({ title, action, className, children, ...props }: Omit<HTMLAttributes<HTMLElement>, "title"> & { title?: ReactNode; action?: ReactNode }) {
  return (
    <section className={cn("panel", className)} {...props}>
      {(title || action) && <header className="panel-header"><div className="panel-title">{title}</div>{action}</header>}
      <div className="panel-body">{children}</div>
    </section>
  );
}

export function Button({ variant = "primary", className, type = "button", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" | "danger" }) {
  return <button type={type} className={cn("button", `button-${variant}`, className)} {...props} />;
}

export function IconButton({ label, className, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return <button type="button" className={cn("icon-button", className)} aria-label={label} title={label} {...props} />;
}

export function StatusDot({ tone = "success", label, live = false }: { tone?: "success" | "warning" | "danger" | "muted"; label: string; live?: boolean }) {
  return <span className={cn("status", `status-tone-${tone}`, live && "status-live")}><span className={cn("status-dot", `status-${tone}`)} aria-hidden="true" />{label}</span>;
}

export function PlatformLoading({ label = "正在读取威胁情报平台配置" }: { label?: string }) {
  return (
    <main className="platform-loading" aria-busy="true">
      <div className="platform-loading-content" role="status" aria-live="polite">
        <div className="platform-loading-visual" aria-hidden="true">
          <span className="platform-loading-orbit" />
          <span className="platform-loading-orbit-inner" />
          <span className="platform-loading-core"><ShieldCheck size={27} strokeWidth={1.7} /></span>
        </div>
        <div className="platform-loading-copy">
          <strong>{label}</strong>
          <span>正在校验服务连接与授权信息</span>
        </div>
        <span className="platform-loading-progress" aria-hidden="true"><span /></span>
      </div>
    </main>
  );
}

export function PlatformErrorPage({ homePath, homeLabel = "返回首页" }: { homePath: string; homeLabel?: string }) {
  return (
    <main className="platform-error" aria-labelledby="platform-error-title">
      <section className="platform-error-content" role="alert">
        <span className="platform-error-icon" aria-hidden="true"><CircleAlert size={30} strokeWidth={1.8} /></span>
        <div className="platform-error-copy">
          <span className="platform-error-kicker">服务异常</span>
          <h1 id="platform-error-title">页面暂时无法加载</h1>
          <p>系统遇到异常，请稍后重试。若问题持续，请联系平台管理员。</p>
        </div>
        <div className="platform-error-actions">
          <Button onClick={() => window.location.reload()} autoFocus><RefreshCw size={16} aria-hidden="true" />重新加载</Button>
          <Button variant="secondary" onClick={() => window.location.assign(homePath)}><House size={16} aria-hidden="true" />{homeLabel}</Button>
        </div>
      </section>
    </main>
  );
}

type GlobalErrorBoundaryProps = {
  children: ReactNode;
  homePath: string;
  homeLabel?: string;
};

type GlobalErrorBoundaryState = { failed: boolean };

export class GlobalErrorBoundary extends Component<GlobalErrorBoundaryProps, GlobalErrorBoundaryState> {
  state: GlobalErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): GlobalErrorBoundaryState {
    return { failed: true };
  }

  componentDidCatch(_error: Error, _info: ErrorInfo) {
    // Error details stay out of the rendered response.
  }

  render() {
    if (this.state.failed) return <PlatformErrorPage homePath={this.props.homePath} homeLabel={this.props.homeLabel} />;
    return this.props.children;
  }
}

export function Modal({ open, title, children, onClose, footer, className }: { open: boolean; title: string; children: ReactNode; onClose: () => void; footer?: ReactNode; className?: string }) {
  if (!open) return null;
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className={cn("modal", className)} role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <header className="modal-header"><h2 id="modal-title">{title}</h2><IconButton label="关闭" onClick={onClose}><X size={18} /></IconButton></header>
        <div className="modal-content">{children}</div>
        {footer && <footer className="modal-footer">{footer}</footer>}
      </section>
    </div>
  );
}

export function EmptyState({ title, description, icon }: { title: string; description?: string; icon?: ReactNode }) {
  return <div className="empty-state">{icon}<strong>{title}</strong>{description && <span>{description}</span>}</div>;
}
