import { useEffect, useMemo, useState } from "react";
import { Ban, CirclePlay, PauseCircle, Plus, RefreshCw, ServerCog, Trash2 } from "lucide-react";
import type { WorkerNode, WorkerNodeDesiredState } from "@sentinel/shared";
import { Button, Modal, Panel, StatusDot, Tag } from "@/components/ui";
import { DeleteConfirmation, PageHeader, Toast, type ToastState } from "@/components/business/AdminPrimitives";
import { adminApiFetch as apiFetch } from "@/api/admin";

const runtimePresentation = {
  active: { label: "运行中", tone: "success" as const },
  draining: { label: "排空中", tone: "warning" as const },
  drained: { label: "已排空", tone: "warning" as const },
  disabled: { label: "已禁用", tone: "muted" as const },
  offline: { label: "离线", tone: "danger" as const },
};

const roleLabels: Record<string, string> = {
  scheduler: "调度",
  snapshot: "快照",
  io: "采集",
  maintenance: "维护",
};

function displayTime(value?: string | null) {
  return value
    ? new Date(value).toLocaleString("zh-CN", { hour12: false })
    : "从未连接";
}

export function WorkerNodesPage() {
  const [nodes, setNodes] = useState<WorkerNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionId, setActionId] = useState("");
  const [creating, setCreating] = useState(false);
  const [nodeId, setNodeId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");
  const [deleting, setDeleting] = useState<WorkerNode | null>(null);
  const [toast, setToast] = useState<ToastState>(null);

  const load = async (showLoading = false) => {
    if (showLoading) setLoading(true);
    try {
      setNodes(await apiFetch<WorkerNode[]>("/api/worker-nodes"));
    } catch (error) {
      setToast({ tone: "warning", text: error instanceof Error ? error.message : "Worker 节点加载失败" });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load(true);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 5_000);
    return () => window.clearInterval(timer);
  }, []);

  const summary = useMemo(() => ({
    total: nodes.length,
    healthy: nodes.filter((node) => node.healthy).length,
    draining: nodes.filter((node) => ["draining", "drained"].includes(node.runtimeState)).length,
    activeJobs: nodes.reduce((total, node) => total + node.activeJobs, 0),
  }), [nodes]);

  const updateState = async (node: WorkerNode, desiredState: WorkerNodeDesiredState) => {
    setActionId(node.nodeId);
    try {
      const saved = await apiFetch<WorkerNode>(`/api/worker-nodes/${encodeURIComponent(node.nodeId)}`, {
        method: "PUT",
        body: JSON.stringify({ desiredState }),
      });
      setNodes((current) => current.map((item) => item.nodeId === saved.nodeId ? saved : item));
      setToast({
        tone: "success",
        text: desiredState === "active" ? `${node.displayName}已发送启用指令` : desiredState === "draining" ? `${node.displayName}已进入排空` : `${node.displayName}已发送禁用指令`,
      });
      window.setTimeout(() => void load(), 1_000);
    } catch (error) {
      setToast({ tone: "warning", text: error instanceof Error ? error.message : "Worker 节点状态更新失败" });
    } finally {
      setActionId("");
    }
  };

  const createNode = async () => {
    setActionId("create");
    try {
      const saved = await apiFetch<WorkerNode>("/api/worker-nodes", {
        method: "POST",
        body: JSON.stringify({ nodeId: nodeId.trim(), displayName: displayName.trim(), description: description.trim() }),
      });
      setNodes((current) => [saved, ...current]);
      setCreating(false);
      setNodeId("");
      setDisplayName("");
      setDescription("");
      setToast({ tone: "success", text: "节点已预注册；在目标主机配置相同节点 ID 并启动 Worker 后，再执行启用。" });
    } catch (error) {
      setToast({ tone: "warning", text: error instanceof Error ? error.message : "Worker 节点创建失败" });
    } finally {
      setActionId("");
    }
  };

  const deleteNode = async () => {
    if (!deleting) return;
    setActionId(deleting.nodeId);
    try {
      await apiFetch(`/api/worker-nodes/${encodeURIComponent(deleting.nodeId)}`, { method: "DELETE" });
      setNodes((current) => current.filter((item) => item.nodeId !== deleting.nodeId));
      setToast({ tone: "success", text: `${deleting.displayName}的离线记录已清理` });
      setDeleting(null);
    } catch (error) {
      setToast({ tone: "warning", text: error instanceof Error ? error.message : "Worker 节点清理失败" });
    } finally {
      setActionId("");
    }
  };

  return <>
    <PageHeader
      eyebrow="WORKER CONTROL PLANE"
      title="Worker 节点"
      description="统一查看跨主机 Worker，控制新任务领取，并安全排空或下线节点。"
      actions={<><Button variant="secondary" onClick={() => void load(true)} disabled={loading}><RefreshCw size={16} className={loading ? "is-spinning" : ""} />刷新</Button><Button onClick={() => setCreating(true)}><Plus size={16} />预注册节点</Button></>}
    />
    <section className="status-summary">
      <div><ServerCog size={19} /><span><small>节点总数</small><strong>{summary.total}</strong></span></div>
      <div><CirclePlay size={19} /><span><small>在线节点</small><strong>{summary.healthy}</strong></span></div>
      <div><PauseCircle size={19} /><span><small>排空节点</small><strong>{summary.draining}</strong></span></div>
      <div><RefreshCw size={19} /><span><small>执行中任务</small><strong>{summary.activeJobs}</strong></span></div>
    </section>
    <Panel>
      {nodes.length ? <div className="admin-table">
        <div className="admin-table-head" style={{ gridTemplateColumns: "minmax(220px,1.4fr) minmax(170px,1fr) minmax(180px,1.2fr) 110px minmax(300px,1.5fr)" }}>
          <span>节点</span><span>角色与实例</span><span>最近心跳</span><span>状态</span><span>操作</span>
        </div>
        {nodes.map((node) => {
          const presentation = runtimePresentation[node.runtimeState];
          return <div className="admin-table-row" style={{ gridTemplateColumns: "minmax(220px,1.4fr) minmax(170px,1fr) minmax(180px,1.2fr) 110px minmax(300px,1.5fr)" }} key={node.nodeId}>
            <div><strong>{node.displayName}</strong><small><code>{node.nodeId}</code></small>{node.description && <small>{node.description}</small>}</div>
            <div><strong>{node.roles.length ? node.roles.map((role) => roleLabels[role] || role).join(" / ") : "尚未连接"}</strong><small>{node.instances.filter((item) => item.healthy).length} 个在线实例 · 并发 {node.instances.filter((item) => item.healthy).reduce((total, item) => total + item.concurrency, 0)}</small>{node.activeJobs > 0 && <small>{node.activeJobs} 个任务执行中</small>}</div>
            <div><strong>{displayTime(node.lastSeenAt)}</strong><small>{node.instances.find((item) => item.healthy)?.hostName || "无在线主机"}</small></div>
            <StatusDot label={presentation.label} tone={presentation.tone} live={node.runtimeState === "active"} />
            <div className="customer-actions">
              <button className="text-action" disabled={actionId === node.nodeId || node.desiredState === "active"} onClick={() => void updateState(node, "active")}><CirclePlay size={14} />启用</button>
              <button className="text-action" disabled={actionId === node.nodeId || node.desiredState === "draining"} onClick={() => void updateState(node, "draining")}><PauseCircle size={14} />排空</button>
              <button className="text-action" disabled={actionId === node.nodeId || node.desiredState === "disabled"} onClick={() => void updateState(node, "disabled")}><Ban size={14} />禁用</button>
              <button className="text-action text-action-danger" disabled={actionId === node.nodeId || node.healthy || node.desiredState !== "disabled"} onClick={() => setDeleting(node)}><Trash2 size={14} />清理</button>
            </div>
          </div>;
        })}
      </div> : <div className="inline-empty"><ServerCog size={30} /><strong>尚无 Worker 节点</strong><span>可以先预注册节点，或直接启动配置了数据库与 Redis 的 Worker。</span><Button onClick={() => setCreating(true)}><Plus size={16} />预注册节点</Button></div>}
      <div style={{ marginTop: 16 }}><Tag>排空只停止领取新任务，正在执行的任务会自然完成；禁用节点仍保持控制心跳，因此可以远程重新启用。</Tag></div>
    </Panel>
    <Modal open={creating} title="预注册 Worker 节点" onClose={() => { if (actionId !== "create") setCreating(false); }} footer={<><Button variant="ghost" onClick={() => setCreating(false)} disabled={actionId === "create"}>取消</Button><Button onClick={() => void createNode()} disabled={actionId === "create" || !nodeId.trim() || !displayName.trim()}>{actionId === "create" ? "创建中..." : "创建节点"}</Button></>}>
      <div className="admin-form">
        <label>节点 ID<input value={nodeId} onChange={(event) => setNodeId(event.target.value)} maxLength={100} placeholder="例如 worker-shanghai-01" autoFocus /></label>
        <label>节点名称<input value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength={120} placeholder="例如 上海采集节点 01" /></label>
        <label>节点说明<textarea value={description} onChange={(event) => setDescription(event.target.value)} maxLength={500} placeholder="可填写主机位置、用途或维护负责人" /></label>
        <small>目标主机需设置 <code>SENTINEL_WORKER_NODE_ID={nodeId.trim() || "worker-shanghai-01"}</code>，并连接同一 PostgreSQL 与 Redis。</small>
      </div>
    </Modal>
    <DeleteConfirmation open={Boolean(deleting)} title="清理 Worker 节点" subject={deleting?.displayName || ""} warning="仅可清理已禁用且离线的节点记录；若对应 Worker 进程再次启动，节点会自动重新注册。" confirming={Boolean(deleting && actionId === deleting.nodeId)} onClose={() => setDeleting(null)} onConfirm={() => void deleteNode()} />
    <Toast value={toast} onClose={() => setToast(null)} />
  </>;
}
