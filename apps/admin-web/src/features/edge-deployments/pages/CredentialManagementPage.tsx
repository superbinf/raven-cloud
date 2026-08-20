import { useState } from "react";
import { Ban, CalendarClock, KeyRound, RefreshCw, RotateCw, ShieldCheck } from "lucide-react";
import { Button, Modal, Panel, StatusDot, Tag } from "@/components/common";
import { PageHeader, SequenceCell, SequenceHeader, Toast, type ToastState } from "@/components/business/AdminPrimitives";
import { CredentialDeliveryPanel } from "../components/ActivationConfigPanel";
import { useEdgeDeployments } from "../hooks/useEdgeDeployments";
import type { EdgeDeployment } from "../model/types";
import styles from "../edgeDeployments.module.css";

function formatTime(value: string | null) {
  if (!value) return "尚未配置";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}

function licenseLabel(status: string) {
  return ({ active: "有效", expired: "已过期", revoked: "已注销", unissued: "未签发" } as Record<string, string>)[status] || status;
}

function CredentialEditor({ mode, deployment, state }: { mode: "license" | "api-key"; deployment: EdgeDeployment; state: ReturnType<typeof useEdgeDeployments> }) {
  const defaultExpiry = deployment.license.expiresAt?.slice(0, 10) || new Date(Date.now() + 365 * 86400_000).toISOString().slice(0, 10);
  const [expiresAt, setExpiresAt] = useState(defaultExpiry);
  const [notice, setNotice] = useState("");
  const current = state.deployments.find((item) => item.id === deployment.id) || deployment;
  const busy = state.busyId === deployment.id;
  const execute = async (action: () => Promise<unknown>, success: string) => {
    setNotice("");
    try { await action(); setNotice(success); }
    catch (error) { setNotice(error instanceof Error ? error.message : "操作失败"); }
  };
  return <div className={styles.credentialManager}>
    {mode === "api-key" ? <section><header><span><KeyRound size={18} /></span><div><strong>OpenAPI Key</strong><small>状态：{current.apiKeyStatus === "active" ? "有效" : "已注销"} · 版本 v{current.apiKeyVersion} · 更新于 {formatTime(current.apiKeyLastRotatedAt)}</small></div></header><p>Key 用于该地端实例拉取授权快照。生成或更新后，旧 Key 会立即失效。</p><div className={styles.credentialActions}><Button disabled={busy} onClick={() => void execute(() => state.generateKey(current), "新 OpenAPI Key 已生成，请立即保存。") }><KeyRound size={15} />生成 Key</Button><Button variant="secondary" disabled={busy || current.apiKeyStatus !== "active"} onClick={() => void execute(() => state.updateKey(current), "OpenAPI Key 已更新。") }><RotateCw size={15} />更新 Key</Button><Button variant="danger" disabled={busy || current.apiKeyStatus !== "active"} onClick={() => { if (window.confirm("注销后该实例将停止同步，确定继续？")) void execute(() => state.revokeKey(current), "OpenAPI Key 已注销。"); }}><Ban size={15} />注销</Button></div></section> : <section><header><span><ShieldCheck size={18} /></span><div><strong>地端许可证</strong><small>状态：{licenseLabel(current.license.status)} · {current.license.expiresAt ? `有效期至 ${formatTime(current.license.expiresAt)}` : "尚未设置有效期"}</small></div></header><p>许可证用于地端首次激活和后续授权校验。</p><label className={styles.expiryField}><span><CalendarClock size={15} />有效期至</span><input type="date" min={new Date(Date.now() + 86400_000).toISOString().slice(0, 10)} value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} /></label><div className={styles.credentialActions}><Button disabled={busy || !expiresAt} onClick={() => void execute(() => state.issueLicense(current, expiresAt), "新许可证已签发，请立即保存。") }><ShieldCheck size={15} />签发许可证</Button><Button variant="secondary" disabled={busy || !expiresAt || current.license.status === "unissued"} onClick={() => void execute(() => state.updateLicense(current, expiresAt), "许可证有效期已更新。") }><CalendarClock size={15} />更新有效期</Button><Button variant="danger" disabled={busy || !["active", "expired"].includes(current.license.status)} onClick={() => { if (window.confirm("注销后该地端将无法通过授权校验，确定继续？")) void execute(() => state.revokeLicense(current), "许可证已注销。"); }}><Ban size={15} />注销</Button></div></section>}
    {notice && <div className={styles.credentialNotice} role="status">{notice}</div>}
  </div>;
}

export function CredentialManagementPage({ tenantId }: { tenantId?: string }) {
  const state = useEdgeDeployments();
  const deployments = tenantId ? state.deployments.filter((deployment) => deployment.tenantId === tenantId) : state.deployments;
  const [editing, setEditing] = useState<{ deployment: EdgeDeployment; mode: "license" | "api-key" } | null>(null);
  const [toast, setToast] = useState<ToastState>(null);
  const refresh = async () => {
    try { await state.load(); setToast({ tone: "success", text: "凭据状态已刷新" }); }
    catch (error) { setToast({ tone: "warning", text: error instanceof Error ? error.message : "刷新失败" }); }
  };
  return <><PageHeader eyebrow="DEPLOYMENT CREDENTIALS" title="许可证与 API Key" description="按当前客户的地端实例管理许可证与 OpenAPI Key，不在此处维护账号泄露数据。" actions={<Button variant="secondary" onClick={() => void refresh()} disabled={state.loading}><RefreshCw size={16} />刷新状态</Button>} />
    <Panel>{state.loading ? <div className="inline-empty"><RefreshCw size={24} /><strong>正在加载凭据</strong></div> : <div className={styles.credentialTable}><div className={styles.credentialTableHead}><SequenceHeader /><span>地端实例</span><span>客户</span><span>许可证</span><span>OpenAPI Key</span><span>操作</span></div>{deployments.map((deployment, index) => <div className={styles.credentialTableRow} key={deployment.id}><SequenceCell value={index + 1} /><div><strong>{deployment.name}</strong><small>{deployment.id}</small></div><div><strong>{deployment.tenantName || deployment.tenantId}</strong><small>{deployment.tenantId}</small></div><div><StatusDot label={licenseLabel(deployment.license.status)} tone={deployment.license.status === "active" ? "success" : "muted"} /><small>{deployment.license.expiresAt ? `至 ${formatTime(deployment.license.expiresAt)}` : "未设置有效期"}</small></div><div><Tag tone={deployment.apiKeyStatus === "active" ? "green" : "default"}>{deployment.apiKeyStatus === "active" ? "有效" : "已注销"}</Tag><small>v{deployment.apiKeyVersion} · {formatTime(deployment.apiKeyLastRotatedAt)}</small></div><div className={styles.actions}><button className="text-action" onClick={() => setEditing({ deployment, mode: "license" })}>管理许可证</button><button className="text-action" onClick={() => setEditing({ deployment, mode: "api-key" })}>管理 API Key</button></div></div>)}{!deployments.length && <div className="inline-empty"><KeyRound size={24} /><strong>当前客户暂无可管理的地端实例</strong></div>}</div>}</Panel>
    <Modal open={Boolean(editing)} title={editing ? `${editing.mode === "license" ? "许可证" : "API Key"} · ${editing.deployment.name}` : "凭据管理"} onClose={() => setEditing(null)}>{editing && <CredentialEditor key={`${editing.deployment.id}-${editing.mode}`} mode={editing.mode} deployment={editing.deployment} state={state} />}</Modal>
    <Modal open={Boolean(state.credentialDelivery)} title="一次性凭证交付" onClose={() => state.setCredentialDelivery(null)} footer={<Button onClick={() => state.setCredentialDelivery(null)}>我已安全保存</Button>}>{state.credentialDelivery && <CredentialDeliveryPanel delivery={state.credentialDelivery} />}</Modal>
    <Toast value={toast} onClose={() => setToast(null)} />
  </>;
}
