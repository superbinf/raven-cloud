import { useEffect, useMemo, useState } from "react";
import { Building2, CircleOff, Pencil, Plus, Power, RefreshCw, Search, Trash2 } from "lucide-react";
import { Button, Modal, Panel, StatusDot } from "@/components/common";
import { DeleteConfirmation, PageHeader, SequenceCell, SequenceHeader, Toast, type ToastState } from "@/components/business/AdminPrimitives";
import { createEdgeTenant, deleteEdgeTenant, listEdgeTenants, updateEdgeTenant, type EdgeTenant } from "@/features/edge-deployments";

export function CustomersPage({ tenants, canManage, onChanged }: { tenants: EdgeTenant[]; canManage: boolean; onChanged: (tenants: EdgeTenant[]) => void }) {
  const [items, setItems] = useState(tenants);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<EdgeTenant | null | undefined>(undefined);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<EdgeTenant | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [actionId, setActionId] = useState("");
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState<ToastState>(null);

  useEffect(() => setItems(tenants), [tenants]);
  const publish = (next: EdgeTenant[]) => { setItems(next); onChanged(next); };
  const refresh = async () => {
    setLoading(true);
    try { publish(await listEdgeTenants()); }
    catch (reason) { setToast({ tone: "warning", text: reason instanceof Error ? reason.message : "客户列表加载失败" }); }
    finally { setLoading(false); }
  };
  const visible = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase();
    return keyword ? items.filter((item) => `${item.name} ${item.id}`.toLocaleLowerCase().includes(keyword)) : items;
  }, [items, query]);
  const openCreate = () => { setName(""); setEditing(null); };
  const openEdit = (tenant: EdgeTenant) => { setName(tenant.name); setEditing(tenant); };
  const save = async () => {
    const value = name.trim();
    if (!value) { setToast({ tone: "warning", text: "客户名称不能为空" }); return; }
    setSaving(true);
    try {
      const saved = editing ? await updateEdgeTenant(editing.id, { name: value }) : await createEdgeTenant(value);
      const next = editing ? items.map((item) => item.id === saved.id ? { ...item, ...saved } : item) : [...items, saved];
      publish(next);
      setEditing(undefined);
      setToast({ tone: "success", text: editing ? "客户信息已更新" : "客户已创建，可以继续配置关键词与域名" });
      void refresh();
    } catch (reason) { setToast({ tone: "warning", text: reason instanceof Error ? reason.message : "客户保存失败" }); }
    finally { setSaving(false); }
  };
  const toggleStatus = async (tenant: EdgeTenant) => {
    setActionId(tenant.id);
    try {
      const saved = await updateEdgeTenant(tenant.id, { status: tenant.status === "disabled" ? "active" : "disabled" });
      publish(items.map((item) => item.id === saved.id ? { ...item, ...saved } : item));
      setToast({ tone: "success", text: `${tenant.name}已${saved.status === "disabled" ? "停用" : "启用"}` });
    } catch (reason) { setToast({ tone: "warning", text: reason instanceof Error ? reason.message : "客户状态更新失败" }); }
    finally { setActionId(""); }
  };
  const remove = async () => {
    if (!deleting) return;
    setDeleteBusy(true);
    try {
      await deleteEdgeTenant(deleting.id);
      publish(items.filter((item) => item.id !== deleting.id));
      setToast({ tone: "success", text: `${deleting.name}已删除` });
      setDeleting(null);
    } catch (reason) { setToast({ tone: "warning", text: reason instanceof Error ? reason.message : "客户删除失败" }); }
    finally { setDeleteBusy(false); }
  };

  return <>
    <PageHeader eyebrow="CUSTOMER MANAGEMENT" title="客户管理" description="先建立客户，再按客户配置关键词、域名、数据接口和地端部署。" actions={canManage ? <Button onClick={openCreate}><Plus size={16} />新增客户</Button> : undefined} />
    <Panel>
      <div className="customer-list-toolbar">
        <label className="toolbar-search"><Search size={16} /><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索客户名称或 ID" /></label>
        <Button variant="ghost" onClick={() => void refresh()} disabled={loading}><RefreshCw size={15} className={loading ? "is-spinning" : ""} />刷新</Button>
      </div>
      {visible.length ? <div className="admin-table customer-table">
        <div className="admin-table-head"><SequenceHeader /><span>客户</span><span>关键词配置</span><span>接口</span><span>地端</span><span>指纹组</span><span>状态</span><span>操作</span></div>
        {visible.map((tenant, index) => <div className="admin-table-row" key={tenant.id}>
          <SequenceCell value={index + 1} />
          <div className="customer-identity"><span><Building2 size={16} /></span><div><strong>{tenant.name}</strong><code>{tenant.id}</code></div></div>
          <strong>{tenant.counts?.targets ?? 0}</strong><strong>{tenant.counts?.connections ?? 0}</strong><strong>{tenant.counts?.deployments ?? 0}</strong><strong>{tenant.counts?.fingerprintGroups ?? 0}</strong>
          <StatusDot label={tenant.status === "disabled" ? "已停用" : "启用中"} tone={tenant.status === "disabled" ? "muted" : "success"} />
          <div className="customer-actions">{canManage && <><button className="text-action" onClick={() => openEdit(tenant)}><Pencil size={14} />编辑</button><button className="text-action" disabled={actionId === tenant.id} onClick={() => void toggleStatus(tenant)}>{tenant.status === "disabled" ? <Power size={14} /> : <CircleOff size={14} />}{tenant.status === "disabled" ? "启用" : "停用"}</button><button className="text-action text-action-danger" onClick={() => setDeleting(tenant)}><Trash2 size={14} />删除</button></>}</div>
        </div>)}
      </div> : <div className="inline-empty customer-empty"><Building2 size={30} /><strong>{query ? "没有匹配的客户" : "尚未创建客户"}</strong><span>{query ? "请调整搜索条件。" : "创建第一个客户后，即可继续配置关键词、域名和数据接口。"}</span>{canManage && !query && <Button onClick={openCreate}><Plus size={16} />新增客户</Button>}</div>}
    </Panel>
    <Modal open={editing !== undefined} title={editing ? "编辑客户" : "新增客户"} onClose={() => { if (!saving) setEditing(undefined); }} footer={<><Button variant="ghost" onClick={() => setEditing(undefined)} disabled={saving}>取消</Button><Button onClick={() => void save()} disabled={saving}>{saving ? "保存中..." : "保存"}</Button></>}><div className="admin-form customer-form"><label>客户名称<input value={name} onChange={(event) => setName(event.target.value)} maxLength={120} autoFocus placeholder="请输入客户或组织名称" /></label>{editing && <label>客户 ID<input value={editing.id} disabled /></label>}</div></Modal>
    <DeleteConfirmation open={Boolean(deleting)} title="删除客户" subject={deleting?.name || ""} warning="仅空客户可以删除；若存在关键词、接口、业务数据、地端部署或自定义指纹组，系统将拒绝删除。" confirming={deleteBusy} onClose={() => setDeleting(null)} onConfirm={() => void remove()} />
    <Toast value={toast} onClose={() => setToast(null)} />
  </>;
}
