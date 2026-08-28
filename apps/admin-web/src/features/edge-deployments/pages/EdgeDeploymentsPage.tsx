import { useState } from "react";
import { AlertTriangle, CloudDownload, HardDrive, Plus, RefreshCw, Trash2, Wifi, WifiOff } from "lucide-react";
import { Button, Modal, Panel, StatusDot, Tag } from "@/components/ui";
import { PageHeader, SequenceCell, SequenceHeader, Toast, type ToastState } from "@/components/business/AdminPrimitives";
import { useEdgeDeployments } from "../hooks/useEdgeDeployments";
import type { EdgeDeployment, EdgeDeploymentInput } from "../model/types";
import { CredentialDeliveryPanel } from "../components/ActivationConfigPanel";
import { DeploymentForm } from "../components/DeploymentForm";
import { portalModuleOptions } from "../model/portalModules";
import styles from "../edgeDeployments.module.css";

function formatTime(value: string | null) {
  if (!value) return "从未连接";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}

function statusTone(status: string | null) {
  if (["success", "正常", "成功"].includes(status ?? "")) return "success" as const;
  if (["failed", "offline", "失败", "离线"].includes(status ?? "")) return "danger" as const;
  return "muted" as const;
}

function formatInterval(seconds: number) {
  if (seconds % 3_600 === 0) return `${seconds / 3_600} 小时`;
  if (seconds % 60 === 0) return `${seconds / 60} 分钟`;
  return `${seconds} 秒`;
}

export function EdgeDeploymentsPage({ tenantId }: { tenantId?: string }) {
  const state = useEdgeDeployments();
  const [editing, setEditing] = useState<EdgeDeployment | null | undefined>(undefined);
  const [deleting, setDeleting] = useState<EdgeDeployment | null>(null);
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [toast, setToast] = useState<ToastState>(null);
  const deployments = tenantId ? state.deployments.filter((item) => item.tenantId === tenantId) : state.deployments;
  const tenants = tenantId ? state.tenants.filter((item) => item.id === tenantId) : state.tenants;
  const enabled = deployments.filter((item) => item.enabled).length;
  const failed = deployments.filter((item) => ["failed", "offline", "失败", "离线"].includes(item.lastSyncStatus ?? "")).length;
  const intervals = [...new Set(deployments.map((item) => item.pollIntervalSeconds))];
  const intervalSummary = intervals.length === 1 ? formatInterval(intervals[0]) : "按实例配置";

  const perform = async (action: () => Promise<unknown>, success: string) => {
    try { await action(); setToast({ tone: "success", text: success }); }
    catch (error) { setToast({ tone: "warning", text: error instanceof Error ? error.message : "操作失败" }); }
  };
  const save = async (input: EdgeDeploymentInput) => {
    const current = editing ?? null;
    await perform(async () => { await state.save(input, current); setEditing(undefined); }, current ? "部署配置已更新" : "地端实例已创建，请立即保存一次性激活配置");
  };
  const remove = async () => {
    if (!deleting || deleteConfirmation !== deleting.id) return;
    await perform(async () => { await state.remove(deleting); setDeleting(null); setDeleteConfirmation(""); }, "地端实例及云端快照已删除");
  };

  return <><PageHeader eyebrow="EDGE DEPLOYMENTS" title="地端部署" description="维护地端实例参数，并执行快照发布与同步状态检查。许可证和 API Key 在凭据管理中单独维护。" actions={<><Button variant="secondary" onClick={() => void perform(state.load, "部署状态已刷新")}><RefreshCw size={16} />刷新</Button><Button onClick={() => setEditing(null)} disabled={!tenants.length}><Plus size={16} />新建部署</Button></>} />
    <section className={styles.summary}><div><HardDrive size={20} /><span><strong>{deployments.length}</strong><small>部署实例</small></span></div><div><Wifi size={20} /><span><strong>{enabled}</strong><small>已启用</small></span></div><div><WifiOff size={20} /><span><strong>{failed}</strong><small>失败或离线</small></span></div><div><CloudDownload size={20} /><span><strong>{intervalSummary}</strong><small>API 版本检查</small></span></div></section>
    <Panel>{state.loading ? <div className="inline-empty"><RefreshCw size={26} /><strong>正在加载地端实例</strong></div> : state.loadError ? <div className="inline-empty"><AlertTriangle size={28} /><strong>地端部署数据加载失败</strong><span>{state.loadError}</span><Button variant="secondary" onClick={() => void state.load().catch(() => undefined)}>重新加载</Button></div> : deployments.length ? <div className={styles.table}><div className={styles.tableHead}><SequenceHeader /><span>部署实例</span><span>客户租户</span><span>开放板块</span><span>同步状态</span><span>数据版本</span><span>最后心跳</span><span>启用</span><span>操作</span></div>{deployments.map((deployment, index) => <div className={styles.tableRow} key={deployment.id}><SequenceCell value={index + 1} /><div><strong>{deployment.name}</strong><small>{deployment.id} · 配置 v{deployment.configVersion}</small></div><div><strong>{deployment.tenantName ?? deployment.tenantId}</strong><small>{deployment.tenantId}</small></div><div className={styles.moduleSummary}><strong>{deployment.enabledModules.length} / {portalModuleOptions.length} 个板块</strong><small title={portalModuleOptions.filter((item) => deployment.enabledModules.includes(item.id)).map((item) => item.label).join("、")}>{portalModuleOptions.filter((item) => deployment.enabledModules.includes(item.id)).map((item) => item.label).join("、")}</small></div><div><StatusDot label={deployment.lastSyncStatus || "从未同步"} tone={statusTone(deployment.lastSyncStatus)} /><small title={deployment.lastSyncMessage ?? ""}>{deployment.lastSyncMessage || "暂无状态说明"}</small></div><div className={styles.versionCell}><code>已应用 {deployment.lastAppliedSnapshotVersion === null ? "--" : `v${deployment.lastAppliedSnapshotVersion}`}</code><small>已发布 {state.statuses[deployment.id]?.latestSnapshot ? `v${state.statuses[deployment.id]?.latestSnapshot?.version}` : "点击同步状态查看"}</small>{state.statuses[deployment.id]?.latestSnapshotJob && <small>生成任务：{state.statuses[deployment.id]?.latestSnapshotJob?.status}</small>}</div><span>{formatTime(deployment.lastSeenAt)}</span><label className="switch compact"><input type="checkbox" checked={deployment.enabled} disabled={state.busyId === deployment.id} onChange={() => void perform(() => state.toggle(deployment), deployment.enabled ? "部署实例已停用" : "部署实例已启用")} /><span /></label><div className={styles.actions}><button className="text-action" onClick={() => setEditing(deployment)}>编辑</button><button className="text-action" disabled={state.busyId === deployment.id || !deployment.enabled} onClick={() => void perform(() => state.publish(deployment), "快照生成任务已提交")}>发布快照</button><button className="text-action" disabled={state.busyId === deployment.id} onClick={() => void perform(() => state.refreshStatus(deployment), "同步状态已刷新")}>同步状态</button><button className="text-action text-action-danger" title={deployment.enabled ? "请先停用实例" : "删除实例"} disabled={state.busyId === deployment.id || deployment.enabled} onClick={() => { setDeleting(deployment); setDeleteConfirmation(""); }}><Trash2 size={13} />删除</button></div></div>)}</div> : <div className="inline-empty"><HardDrive size={28} /><strong>暂无地端部署实例</strong><span>创建实例后可发布授权数据快照。</span></div>}</Panel>
    <Modal open={editing !== undefined} title={editing ? `编辑部署 · ${editing.name}` : "新建地端部署"} onClose={() => setEditing(undefined)} footer={<><Button variant="ghost" onClick={() => setEditing(undefined)}>取消</Button><Button type="submit" form="edge-deployment-form" disabled={Boolean(state.busyId)}>{state.busyId ? "保存中..." : "保存配置"}</Button></>}><DeploymentForm key={editing?.id ?? "new"} deployment={editing ?? null} tenants={tenants} tenantId={tenantId} onSubmit={(input) => void save(input)} /></Modal>
    <Modal open={Boolean(state.credentialDelivery)} title="一次性激活配置" onClose={() => state.setCredentialDelivery(null)} footer={<Button onClick={() => state.setCredentialDelivery(null)}>我已安全保存</Button>}>{state.credentialDelivery && <CredentialDeliveryPanel delivery={state.credentialDelivery} />}</Modal>
    <Modal open={Boolean(deleting)} title="删除地端实例" onClose={() => { setDeleting(null); setDeleteConfirmation(""); }} footer={<><Button variant="ghost" onClick={() => { setDeleting(null); setDeleteConfirmation(""); }}>取消</Button><Button variant="danger" disabled={!deleting || deleteConfirmation !== deleting.id || state.busyId === deleting.id} onClick={() => void remove()}><Trash2 size={16} />确认删除</Button></>}>
      {deleting && <div className={styles.deleteConfirm}><div><AlertTriangle size={20} /><p><strong>此操作不可撤销</strong><span>将删除云端地端实例及其全部快照。地端已保存的数据不会被远程删除。</span></p></div><label htmlFor="delete-edge-confirmation">输入实例 ID <code>{deleting.id}</code> 以确认<input id="delete-edge-confirmation" autoComplete="off" value={deleteConfirmation} onChange={(event) => setDeleteConfirmation(event.target.value)} /></label></div>}
    </Modal>
    <Toast value={toast} onClose={() => setToast(null)} />
  </>;
}
