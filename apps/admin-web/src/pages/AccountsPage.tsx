import { useEffect, useState, type FormEvent } from "react";

import {
  Check,
  KeyRound,
  Power,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  UserCog,
} from "lucide-react";
import {
  type Permission,
  type RoleDefinition,
  type UserRecord,
  type Workspace,
} from "@sentinel/shared";
import { Button, Modal, Panel, StatusDot, Tag } from "@sentinel/ui";
import {
  DeleteConfirmation,
  PageHeader,
  SequenceCell,
  SequenceHeader,
  Toast,
  type ToastState,
} from "../components/AdminPrimitives";
import {
  TablePagination,
  useClientPagination,
} from "../components/TablePagination";
import { adminApiFetch as apiFetch } from "../shared/api/adminApi";
import { useAdminInitialLoading } from "../app/AdminInitialLoading";

const workspaceLabels: Record<Workspace, string> = {
  portal: "仅前台",
  admin: "仅后台",
  both: "前台 + 后台",
};
const permissionLabels: Record<Permission, string> = {
  "portal:read": "查看情报前台",
  "evidence:download": "下载事件证据",
  "accounts:manage": "管理账号权限",
  "ingestion:manage": "管理数据录入",
  "targets:read": "查看监测对象",
  "targets:manage": "管理监测对象",
  "sources:read": "查看数据源",
  "sources:manage": "管理数据源",
  "operations:manage": "运营处置与状态管理",
  "edge:admin": "地端管理",
  "edge:accounts": "地端账号管理",
  "edge:sync": "地端同步管理",
  "edge:license": "地端授权管理",
  "edge:branding": "地端品牌配置",
};
type TotpSetup = {
  setupToken: string;
  secret: string;
  otpauthUri: string;
  expiresAt: string;
};
type TotpAction = {
  ok: boolean;
  account: string;
  totpEnabled: boolean;
  currentSessionRevoked?: boolean;
};

export function AccountsPage({
  currentAccount,
  onCurrentSessionRevoked,
}: {
  currentAccount: string;
  onCurrentSessionRevoked: () => void;
}) {
  const [records, setRecords] = useState<UserRecord[]>([]);
  const [roles, setRoles] = useState<RoleDefinition[]>([]);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<UserRecord | null | undefined>(
    undefined,
  );
  const [resetting, setResetting] = useState<UserRecord | null>(null);
  const [totpUser, setTotpUser] = useState<UserRecord | null>(null);
  const [totpSetup, setTotpSetup] = useState<TotpSetup | null>(null);
  const [totpCode, setTotpCode] = useState("");
  const [deleting, setDeleting] = useState<UserRecord | null>(null);
  const [rolesOpen, setRolesOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<ToastState>(null);
  useAdminInitialLoading("accounts", loading);
  const load = () =>
    Promise.all([
      apiFetch<UserRecord[]>("/api/users"),
      apiFetch<RoleDefinition[]>("/api/roles"),
    ]).then(([users, roleItems]) => {
      setRecords(users);
      setRoles(roleItems);
    });
  useEffect(() => {
    load()
      .catch((error) => setToast({ tone: "warning", text: error.message }))
      .finally(() => setLoading(false));
  }, []);
  const filtered = records.filter((item) =>
    `${item.name}${item.account}${item.role}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const accountPagination = useClientPagination(filtered, 20, query);
  const saveUser = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    const form = new FormData(event.currentTarget);
    const payload = {
      name: String(form.get("name") || "").trim(),
      account: String(form.get("account") || "").trim(),
      roleKey: String(form.get("roleKey") || ""),
      password: String(form.get("password") || ""),
      enabled: editing?.enabled ?? true,
    };
    try {
      const saved = editing
        ? await apiFetch<UserRecord>(
            `/api/users/${encodeURIComponent(editing.account)}`,
            { method: "PUT", body: JSON.stringify(payload) },
          )
        : await apiFetch<UserRecord>("/api/users", {
            method: "POST",
            body: JSON.stringify(payload),
          });
      setRecords((items) =>
        editing
          ? items.map((item) => (item.account === saved.account ? saved : item))
          : [saved, ...items],
      );
      setEditing(undefined);
      setToast({ tone: "success", text: `${saved.name} 的账号权限已保存` });
      if (
        editing?.account === currentAccount &&
        editing.roleKey !== saved.roleKey
      )
        onCurrentSessionRevoked();
    } catch (error) {
      setToast({
        tone: "warning",
        text: error instanceof Error ? error.message : "账号保存失败",
      });
    } finally {
      setSaving(false);
    }
  };
  const toggleUser = async (user: UserRecord) => {
    try {
      const saved = await apiFetch<UserRecord>(
        `/api/users/${encodeURIComponent(user.account)}`,
        {
          method: "PUT",
          body: JSON.stringify({
            name: user.name,
            roleKey: user.roleKey,
            enabled: !user.enabled,
          }),
        },
      );
      setRecords((items) =>
        items.map((item) => (item.account === saved.account ? saved : item)),
      );
      setToast({
        tone: "warning",
        text: `${saved.name} 已${saved.enabled ? "启用" : "停用"}`,
      });
    } catch (error) {
      setToast({
        tone: "warning",
        text: error instanceof Error ? error.message : "状态修改失败",
      });
    }
  };
  const resetPassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!resetting) return;
    setSaving(true);
    const form = new FormData(event.currentTarget);
    try {
      await apiFetch(
        `/api/users/${encodeURIComponent(resetting.account)}/reset-password`,
        {
          method: "POST",
          body: JSON.stringify({
            password: String(form.get("password") || ""),
          }),
        },
      );
      const isSelf = resetting.account === currentAccount;
      setResetting(null);
      setToast({
        tone: "success",
        text: `${resetting.name} 的密码已重置，原会话已失效`,
      });
      if (isSelf) onCurrentSessionRevoked();
    } catch (error) {
      setToast({
        tone: "warning",
        text: error instanceof Error ? error.message : "密码重置失败",
      });
    } finally {
      setSaving(false);
    }
  };
  const deleteUser = async () => {
    if (!deleting) return;
    setSaving(true);
    try {
      await apiFetch(`/api/users/${encodeURIComponent(deleting.account)}`, {
        method: "DELETE",
      });
      setRecords((items) =>
        items.filter((item) => item.account !== deleting.account),
      );
      setToast({ tone: "success", text: `${deleting.name} 的账号已删除` });
      setDeleting(null);
    } catch (error) {
      setToast({
        tone: "warning",
        text: error instanceof Error ? error.message : "账号删除失败",
      });
    } finally {
      setSaving(false);
    }
  };
  const openTotpSetup = async (user: UserRecord) => {
    setSaving(true);
    setTotpUser(user);
    setTotpCode("");
    setTotpSetup(null);
    try {
      setTotpSetup(
        await apiFetch<TotpSetup>(
          `/api/users/${encodeURIComponent(user.account)}/totp/setup`,
          { method: "POST" },
        ),
      );
    } catch (error) {
      setTotpUser(null);
      setToast({
        tone: "warning",
        text: error instanceof Error ? error.message : "动态码设置失败",
      });
    } finally {
      setSaving(false);
    }
  };
  const enableTotp = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!totpUser || !totpSetup) return;
    setSaving(true);
    try {
      const saved = await apiFetch<TotpAction>(
        `/api/users/${encodeURIComponent(totpUser.account)}/totp/enable`,
        {
          method: "POST",
          body: JSON.stringify({
            setupToken: totpSetup.setupToken,
            code: totpCode,
          }),
        },
      );
      setRecords((items) =>
        items.map((item) =>
          item.account === saved.account
            ? { ...item, totpEnabled: saved.totpEnabled }
            : item,
        ),
      );
      setTotpUser(null);
      setTotpSetup(null);
      setTotpCode("");
      setToast({ tone: "success", text: "TOTP 二次验证已开启，原会话已失效" });
      if (saved.currentSessionRevoked) onCurrentSessionRevoked();
    } catch (error) {
      setToast({
        tone: "warning",
        text: error instanceof Error ? error.message : "动态码验证失败",
      });
    } finally {
      setSaving(false);
    }
  };
  const disableTotp = async (user: UserRecord) => {
    if (!window.confirm(`确定关闭 ${user.account} 的 TOTP 二次验证？`)) return;
    setSaving(true);
    try {
      const saved = await apiFetch<TotpAction>(
        `/api/users/${encodeURIComponent(user.account)}/totp/disable`,
        { method: "POST" },
      );
      setRecords((items) =>
        items.map((item) =>
          item.account === saved.account
            ? { ...item, totpEnabled: saved.totpEnabled }
            : item,
        ),
      );
      setToast({ tone: "warning", text: "TOTP 二次验证已关闭，原会话已失效" });
      if (saved.currentSessionRevoked) onCurrentSessionRevoked();
    } catch (error) {
      setToast({
        tone: "warning",
        text: error instanceof Error ? error.message : "关闭 TOTP 失败",
      });
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      <PageHeader
        eyebrow="IDENTITY & ACCESS"
        title="用户配置"
        description="统一配置平台管理员、情报分析师及其账号、角色和会话权限。"
        actions={
          <Button onClick={() => setEditing(null)}>
            <Plus size={17} />
            新建账号
          </Button>
        }
      />
      <div className="toolbar">
        <div className="toolbar-search">
          <Search size={17} />
          <input
            type="search"
            aria-label="搜索账号"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索姓名、账号或角色"
          />
        </div>
        <Button variant="secondary" onClick={() => setRolesOpen(true)}>
          <UserCog size={17} />
          角色权限矩阵
        </Button>
      </div>
      <Panel>
        {loading ? (
          <div className="inline-empty">
            <RefreshCw size={24} />
            <strong>正在加载账号</strong>
          </div>
        ) : (
          <>
            <div className="admin-table user-table">
              <div className="admin-table-head">
                <SequenceHeader />
                <span>用户</span>
                <span>角色</span>
                <span>工作区</span>
                <span>状态</span>
                <span>最近登录</span>
                <span>操作</span>
              </div>
              {accountPagination.items.map((user, index) => (
                <div className="admin-table-row" key={user.id}>
                  <SequenceCell value={(accountPagination.page - 1) * accountPagination.pageSize + index + 1} />
                  <div className="user-cell">
                    <span>{user.name.slice(0, 1)}</span>
                    <div>
                      <strong>{user.name}</strong>
                      <small>
                        {user.account} · {user.id}
                      </small>
                    </div>
                  </div>
                  <span>{user.role}</span>
                  <Tag tone={user.workspace === "portal" ? "default" : "cyan"}>
                    {workspaceLabels[user.workspace]}
                  </Tag>
                  <div className="user-status-stack">
                    <StatusDot
                      label={user.status}
                      tone={user.enabled ? "success" : "muted"}
                    />
                    <small>
                      {user.totpEnabled ? "TOTP 已开启" : "TOTP 未开启"}
                    </small>
                  </div>
                  <span>{user.lastLogin}</span>
                  <div className="user-actions" aria-label={`${user.name} 的账号操作`}>
                    <button
                      className="user-action-button"
                      onClick={() => setEditing(user)}
                      aria-label={`编辑 ${user.name}`}
                      title="编辑账号"
                    >
                      <UserCog size={15} />
                    </button>
                    <button
                      className="user-action-button"
                      onClick={() => setResetting(user)}
                      aria-label={`重置 ${user.name} 的密码`}
                      title="重置密码"
                    >
                      <KeyRound size={15} />
                    </button>
                    <button
                      className="user-action-button"
                      onClick={() =>
                        user.totpEnabled
                          ? void disableTotp(user)
                          : void openTotpSetup(user)
                      }
                      aria-label={`${user.totpEnabled ? "关闭" : "配置"} ${user.name} 的 TOTP`}
                      title={user.totpEnabled ? "关闭 TOTP" : "配置 TOTP"}
                    >
                      <ShieldCheck size={15} />
                    </button>
                    <button
                      className="user-action-button"
                      disabled={user.account === currentAccount}
                      onClick={() => void toggleUser(user)}
                      aria-label={`${user.enabled ? "停用" : "启用"} ${user.name}`}
                      title={
                        user.account === currentAccount
                          ? "当前账号不可停用"
                          : user.enabled
                            ? "停用账号"
                            : "启用账号"
                      }
                    >
                      <Power size={15} />
                    </button>
                    <button
                      className="user-action-button user-action-danger"
                      disabled={user.account === currentAccount}
                      onClick={() => setDeleting(user)}
                      aria-label={`删除 ${user.name}`}
                      title={
                        user.account === currentAccount
                          ? "当前账号不可删除"
                          : "删除账号"
                      }
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <TablePagination
              {...accountPagination}
              onPageChange={accountPagination.setPage}
            />
          </>
        )}
      </Panel>
      <Modal
        open={editing !== undefined}
        title={editing ? `编辑账号 · ${editing.account}` : "新建账号"}
        onClose={() => setEditing(undefined)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditing(undefined)}>
              取消
            </Button>
            <Button type="submit" form="user-form" disabled={saving}>
              {saving ? "保存中..." : "保存账号"}
            </Button>
          </>
        }
      >
        <form id="user-form" className="admin-form" onSubmit={saveUser}>
          <label>
            姓名
            <input
              name="name"
              required
              defaultValue={editing?.name ?? ""}
              placeholder="输入姓名"
            />
          </label>
          <label>
            登录账号
            <input
              name="account"
              required
              disabled={Boolean(editing)}
              defaultValue={editing?.account ?? ""}
              placeholder="name.example"
            />
          </label>
          {!editing && (
            <label>
              初始密码
              <input
                name="password"
                type="password"
                required
                minLength={12}
                autoComplete="new-password"
                placeholder="至少 12 位，包含大小写、数字和特殊字符"
              />
            </label>
          )}
          <label>
            角色
            <select
              name="roleKey"
              defaultValue={editing?.roleKey ?? "portal-viewer"}
            >
              {roles.map((role) => (
                <option value={role.key} key={role.key}>
                  {role.label} · {workspaceLabels[role.workspace]}
                </option>
              ))}
            </select>
          </label>
          <p className="form-help">
            权限由角色统一授予。角色变更、停用或重置密码会立即撤销该账号的所有现有会话。
          </p>
        </form>
      </Modal>
      <Modal
        open={Boolean(resetting)}
        title={resetting ? `重置密码 · ${resetting.account}` : "重置密码"}
        onClose={() => setResetting(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setResetting(null)}>
              取消
            </Button>
            <Button type="submit" form="reset-password-form" disabled={saving}>
              确认重置
            </Button>
          </>
        }
      >
        <form
          id="reset-password-form"
          className="admin-form"
          onSubmit={resetPassword}
        >
          <label>
            新密码
            <input
              name="password"
              type="password"
              required
              minLength={12}
              autoComplete="new-password"
              placeholder="至少 12 位，包含大小写、数字和特殊字符"
            />
          </label>
          <p className="form-help">
            重置后该账号在所有浏览器中的登录会话立即失效。
          </p>
        </form>
      </Modal>
      <Modal
        open={Boolean(totpUser)}
        title={totpUser ? `配置 TOTP · ${totpUser.account}` : "配置 TOTP"}
        onClose={() => {
          setTotpUser(null);
          setTotpSetup(null);
        }}
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => {
                setTotpUser(null);
                setTotpSetup(null);
              }}
            >
              取消
            </Button>
            <Button
              type="submit"
              form="totp-enable-form"
              disabled={saving || !totpSetup || totpCode.length !== 6}
            >
              <KeyRound size={15} />
              开启 TOTP
            </Button>
          </>
        }
      >
        {totpSetup ? (
          <form
            id="totp-enable-form"
            className="admin-form"
            onSubmit={enableTotp}
          >
            <label>
              手动密钥
              <input readOnly value={totpSetup.secret} />
            </label>
            <label>
              otpauth URI
              <input readOnly value={totpSetup.otpauthUri} />
            </label>
            <label>
              动态验证码
              <input
                value={totpCode}
                onChange={(event) =>
                  setTotpCode(event.target.value.replace(/\D/g, "").slice(0, 6))
                }
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="输入认证器中的 6 位验证码"
              />
            </label>
            <p className="form-help">
              在认证器 App
              中添加该密钥后，输入当前动态验证码完成绑定。开启后该账号现有会话会立即失效。
            </p>
          </form>
        ) : (
          <div className="inline-empty">
            <RefreshCw size={24} />
            <strong>正在生成密钥</strong>
          </div>
        )}
      </Modal>
      <Modal
        open={rolesOpen}
        title="角色权限矩阵"
        onClose={() => setRolesOpen(false)}
        footer={<Button onClick={() => setRolesOpen(false)}>关闭</Button>}
      >
        <div className="role-matrix">
          {roles.map((role) => (
            <section key={role.key}>
              <header>
                <div>
                  <strong>{role.label}</strong>
                  <small>{role.description}</small>
                </div>
                <Tag tone={role.workspace === "portal" ? "default" : "cyan"}>
                  {workspaceLabels[role.workspace]}
                </Tag>
              </header>
              <div>
                {role.permissions.map((permission) => (
                  <span key={permission}>
                    <Check size={13} />
                    {permissionLabels[permission]}
                  </span>
                ))}
              </div>
            </section>
          ))}
        </div>
      </Modal>
      <DeleteConfirmation
        open={Boolean(deleting)}
        title="删除账号"
        subject={deleting ? `${deleting.name}（${deleting.account}）` : ""}
        warning="账号及其现有登录会话将被永久删除，此操作不可撤销。"
        confirming={saving}
        onClose={() => setDeleting(null)}
        onConfirm={() => void deleteUser()}
      />
      <Toast value={toast} onClose={() => setToast(null)} />
    </>
  );
}
