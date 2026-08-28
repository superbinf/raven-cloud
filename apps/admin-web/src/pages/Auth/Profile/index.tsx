import { useEffect, useState, type FormEvent } from "react";
import { KeyRound, Save, UserRound } from "lucide-react";
import type { UserRecord } from "@sentinel/shared";
import { Button, Panel, PasswordInput } from "@/components/ui";
import { PageHeader, Toast, type ToastState } from "@/components/business/AdminPrimitives";
import { adminApiFetch as apiFetch } from "@/api/admin";

export function ProfilePage({ onProfileUpdated }: { onProfileUpdated: (user: UserRecord) => void }) {
  const [profile, setProfile] = useState<UserRecord | null>(null);
  const [saving, setSaving] = useState(false);
  const [changing, setChanging] = useState(false);
  const [toast, setToast] = useState<ToastState>(null);
  useEffect(() => { apiFetch<UserRecord>("/api/profile").then(setProfile).catch((error) => setToast({ tone: "warning", text: error.message })); }, []);
  const saveProfile = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setSaving(true);
    const form = new FormData(event.currentTarget);
    try {
      const user = await apiFetch<UserRecord>("/api/profile", { method: "PUT", body: JSON.stringify({ name: form.get("name"), email: form.get("email"), phone: form.get("phone"), department: form.get("department") }) });
      setProfile(user); onProfileUpdated(user); setToast({ tone: "success", text: "个人信息已保存" });
    } catch (error) { setToast({ tone: "warning", text: error instanceof Error ? error.message : "个人信息保存失败" }); }
    finally { setSaving(false); }
  };
  const changePassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setChanging(true);
    const form = new FormData(event.currentTarget); const password = String(form.get("password") || "");
    if (password !== String(form.get("confirmPassword") || "")) { setToast({ tone: "warning", text: "两次输入的新密码不一致" }); setChanging(false); return; }
    try {
      await apiFetch("/api/profile/change-password", { method: "POST", body: JSON.stringify({ currentPassword: form.get("currentPassword"), password }) });
      event.currentTarget.reset(); setToast({ tone: "success", text: "密码已修改，其他已登录会话已退出" });
    } catch (error) { setToast({ tone: "warning", text: error instanceof Error ? error.message : "密码修改失败" }); }
    finally { setChanging(false); }
  };
  return <><PageHeader eyebrow="PERSONAL ACCOUNT" title="个人中心" description="维护当前账号的个人资料与登录密码。" />
    <div className="profile-page-grid">
      <Panel title="个人信息"><form className="admin-form" onSubmit={saveProfile}><div className="profile-identity"><UserRound size={24} /><div><strong>{profile?.name || "--"}</strong><small>{profile?.account || "--"} · {profile?.role || "--"}</small></div></div><div className="form-grid"><label>姓名<input name="name" required maxLength={80} defaultValue={profile?.name || ""} key={`name-${profile?.name}`} /></label><label>部门<input name="department" maxLength={120} defaultValue={profile?.department || ""} key={`department-${profile?.department}`} /></label><label>邮箱<input name="email" type="email" maxLength={160} defaultValue={profile?.email || ""} key={`email-${profile?.email}`} /></label><label>联系电话<input name="phone" maxLength={40} defaultValue={profile?.phone || ""} key={`phone-${profile?.phone}`} /></label></div><div className="form-actions"><Button type="submit" disabled={!profile || saving}><Save size={16} />{saving ? "保存中..." : "保存资料"}</Button></div></form></Panel>
      <Panel title="修改密码"><form className="admin-form" onSubmit={changePassword}><div className="password-guidance"><KeyRound size={18} /><span>新密码须符合平台密码策略，修改后当前设备保持登录。</span></div><label>当前密码<PasswordInput name="currentPassword" required autoComplete="current-password" /></label><label>新密码<PasswordInput name="password" required autoComplete="new-password" /></label><label>确认新密码<PasswordInput name="confirmPassword" required autoComplete="new-password" /></label><div className="form-actions"><Button type="submit" disabled={changing}><KeyRound size={16} />{changing ? "修改中..." : "修改密码"}</Button></div></form></Panel>
    </div><Toast value={toast} onClose={() => setToast(null)} /></>;
}
