import { useEffect, useState, type FormEvent } from "react";
import { Globe2, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { type MonitoringTarget } from "@sentinel/shared";
import { Button, IconButton, Modal, Panel, Tag } from "@/components/common";
import {
  DeleteConfirmation,
  PageHeader,
  Toast,
  type ToastState,
} from "@/components/business/AdminPrimitives";
import {
  TablePagination,
  useClientPagination,
} from "@/components/business/TablePagination";
import { listEdgeTenants, type EdgeTenant } from "../features/edge-deployments";
import { adminApiFetch as apiFetch } from "@/api/admin";
import { useAdminInitialLoading } from "@/hooks/useAdminInitialLoading";

const splitLines = (value: FormDataEntryValue | null) => [
  ...new Set(
    String(value || "")
      .split(/[\n,，]+/)
      .map((item) => item.trim())
      .filter(Boolean),
  ),
];

export function TargetsPage({
  canManage,
  tenantId,
}: {
  canManage: boolean;
  tenantId?: string;
}) {
  const [targets, setTargets] = useState<MonitoringTarget[]>([]);
  const [tenants, setTenants] = useState<EdgeTenant[]>([]);
  const [editing, setEditing] = useState<MonitoringTarget | null | undefined>(
    undefined,
  );
  const [deleting, setDeleting] = useState<MonitoringTarget | null>(null);
  const [deletingBusy, setDeletingBusy] = useState(false);
  const [toast, setToast] = useState<ToastState>(null);
  const [loading, setLoading] = useState(true);
  useAdminInitialLoading("targets", loading);
  useEffect(() => {
    const targetPath = tenantId ? `/api/targets?tenant_id=${encodeURIComponent(tenantId)}` : "/api/targets";
    Promise.all([
      apiFetch<MonitoringTarget[]>(targetPath),
      listEdgeTenants(),
    ])
      .then(([items, tenantItems]) => {
        setTargets(items);
        setTenants(tenantItems);
      })
      .catch((error) => setToast({ tone: "warning", text: error.message }))
      .finally(() => setLoading(false));
  }, [tenantId]);
  const visibleTargets = tenantId
    ? targets.filter((target) => target.tenantId === tenantId)
    : targets;
  const targetPagination = useClientPagination(visibleTargets, 20, tenantId);
  const visibleTenants = tenantId
    ? tenants.filter((tenant) => tenant.id === tenantId)
    : tenants;

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const current = editing ?? null;
    const body = {
      tenantId: String(
        form.get("tenantId") || current?.tenantId || tenantId || "",
      ),
      name: String(form.get("name") || "关键词与域名配置").trim(),
      targetType: current?.targetType || "企业",
      owner: current?.owner || "情报运营",
      domains: splitLines(form.get("domains")),
      ips: current?.ips || [],
      keywords: splitLines(form.get("keywords")),
      enabled: current?.enabled ?? true,
    };
    try {
      const saved = await apiFetch<MonitoringTarget>(
        current ? `/api/targets/${current.id}` : "/api/targets",
        { method: current ? "PUT" : "POST", body: JSON.stringify(body) },
      );
      setTargets((items) =>
        current
          ? items.map((item) => (item.id === saved.id ? saved : item))
          : [saved, ...items],
      );
      setEditing(undefined);
      setToast({
        tone: "success",
        text: `已保存 ${saved.keywords.length} 个关键词和 ${saved.domains.length} 个域名`,
      });
    } catch (error) {
      setToast({
        tone: "warning",
        text: error instanceof Error ? error.message : "配置保存失败",
      });
    }
  };

  const remove = async () => {
    if (!deleting) return;
    setDeletingBusy(true);
    try {
      await apiFetch(`/api/targets/${encodeURIComponent(deleting.id)}`, {
        method: "DELETE",
      });
      setTargets((items) => items.filter((item) => item.id !== deleting.id));
      setDeleting(null);
      setToast({ tone: "success", text: "关键词与域名配置已删除。" });
    } catch (error) {
      setToast({
        tone: "warning",
        text: error instanceof Error ? error.message : "配置删除失败",
      });
    } finally {
      setDeletingBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        eyebrow="KEYWORD & DOMAIN SCOPE"
        title="监测范围"
        description="仅维护当前客户的关键词监控与域名范围。"
        actions={
          canManage ? (
            <Button
              onClick={() => setEditing(null)}
              disabled={!visibleTenants.length}
            >
              <Plus size={16} />
              新增配置
            </Button>
          ) : (
            <Tag>只读权限</Tag>
          )
        }
      />
      <Panel title={`配置列表（${visibleTargets.length}）`}>
        <div className="scope-config-list">
          {targetPagination.items.map((target) => (
            <div className="scope-config-row" key={target.id}>
              <header><div><span className="scope-config-icon"><Globe2 size={17} /></span><div><strong>{target.name}</strong><small>{target.id}</small></div></div><div className="scope-config-counts"><span><Search size={13} />{target.keywords.length} 个关键词</span><span><Globe2 size={13} />{target.domains.length} 个域名</span></div>{canManage && <div className="scope-config-actions"><IconButton label="编辑配置" onClick={() => setEditing(target)}><Pencil size={15} /></IconButton><IconButton label="删除配置" className="danger-icon-button" onClick={() => setDeleting(target)}><Trash2 size={15} /></IconButton></div>}</header>
              <section><h3><Search size={14} />关键词监控</h3><div className="scope-values">{target.keywords.length ? target.keywords.map((value) => <Tag key={value} tone="cyan">{value}</Tag>) : <span>暂无关键词</span>}</div></section>
              <section><h3><Globe2 size={14} />域名配置</h3><div className="scope-values">{target.domains.length ? target.domains.map((value) => <Tag key={value}>{value}</Tag>) : <span>暂无域名</span>}</div></section>
            </div>
          ))}
          {!visibleTargets.length && (
            <div className="inline-empty">
              <Globe2 size={24} />
              <strong>暂无关键词与域名配置</strong>
            </div>
          )}
        </div>
        <TablePagination
          page={targetPagination.page}
          pageSize={targetPagination.pageSize}
          totalPages={targetPagination.totalPages}
          total={targetPagination.total}
          onPageChange={targetPagination.setPage}
          onPageSizeChange={targetPagination.setPageSize}
        />
      </Panel>
      <Modal
        open={editing !== undefined}
        title={editing ? `编辑配置 · ${editing.name}` : "新增关键词与域名配置"}
        onClose={() => setEditing(undefined)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditing(undefined)}>
              取消
            </Button>
            <Button type="submit" form="scope-config-form">
              保存配置
            </Button>
          </>
        }
      >
        <form id="scope-config-form" className="admin-form" onSubmit={save}>
          <label>
            客户
            <select
              name="tenantId"
              required
              defaultValue={editing?.tenantId ?? tenantId ?? ""}
              disabled={Boolean(editing) || Boolean(tenantId)}
            >
              <option value="" disabled>
                请选择客户
              </option>
              {visibleTenants
                .filter((tenant) => tenant.status !== "disabled")
                .map((tenant) => (
                  <option value={tenant.id} key={tenant.id}>
                    {tenant.name}
                  </option>
                ))}
            </select>
          </label>
          <label>
            配置名称
            <input
              name="name"
              required
              defaultValue={editing?.name ?? ""}
              placeholder="例如：品牌与核心业务域名"
            />
          </label>
          <label>
            关键词监控
            <textarea
              name="keywords"
              rows={6}
              defaultValue={editing?.keywords.join("\n") ?? ""}
              placeholder="每行一个关键词，支持企业名称、品牌名和项目代号"
            />
          </label>
          <label>
            域名配置
            <textarea
              name="domains"
              rows={6}
              defaultValue={editing?.domains.join("\n") ?? ""}
              placeholder="每行一个根域名或子域名"
            />
          </label>
        </form>
      </Modal>
      <DeleteConfirmation
        open={Boolean(deleting)}
        title="删除关键词与域名配置"
        subject={deleting?.name || ""}
        warning="删除前会检查接口、订阅、录入和情报关联；仍有关联时不会执行删除。"
        confirming={deletingBusy}
        onClose={() => setDeleting(null)}
        onConfirm={() => void remove()}
      />
      <Toast value={toast} onClose={() => setToast(null)} />
    </>
  );
}
