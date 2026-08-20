import { useEffect, useState, type FormEvent } from "react";
import {
  Fingerprint,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  ShieldAlert,
  Trash2,
} from "lucide-react";
import type { FingerprintWatchGroup } from "@sentinel/shared";
import { Button, EmptyState, IconButton, Modal, Panel, StatusDot, Tag } from "@/components/common";
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

type ItemDraft = {
  productName: string;
  source: "asset" | "custom";
  vendor: string;
  versionRule: string;
  aliases: string;
  enabled: boolean;
};
const emptyItem = (): ItemDraft => ({
  productName: "",
  source: "custom",
  vendor: "",
  versionRule: "",
  aliases: "",
  enabled: true,
});

export function FingerprintWatchGroupsPage({
  canManage,
  tenantId,
}: {
  canManage: boolean;
  tenantId?: string;
}) {
  const [groups, setGroups] = useState<FingerprintWatchGroup[]>([]);
  const [tenants, setTenants] = useState<EdgeTenant[]>([]);
  const [editing, setEditing] = useState<FingerprintWatchGroup | null>(null);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<ItemDraft[]>([emptyItem()]);
  const [toast, setToast] = useState<ToastState>(null);
  const [itemQuery, setItemQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const [recomputing, setRecomputing] = useState(false);
  const [deleting, setDeleting] = useState<FingerprintWatchGroup | null>(null);
  const [loading, setLoading] = useState(true);
  useAdminInitialLoading("fingerprint-watch-groups", loading);
  const load = () =>
    Promise.all([
      apiFetch<FingerprintWatchGroup[]>(tenantId ? `/api/fingerprint-watch-groups?tenant_id=${encodeURIComponent(tenantId)}` : "/api/fingerprint-watch-groups"),
      listEdgeTenants(),
    ]).then(([groupRows, tenantRows]) => {
      setGroups(groupRows);
      setTenants(tenantRows);
    });
  useEffect(() => {
    load().catch((reason) =>
      setToast({ tone: "warning", text: reason.message }),
    ).finally(() => setLoading(false));
  }, [tenantId]);
  const openGroup = (group?: FingerprintWatchGroup) => {
    setEditing(group || null);
    setItemQuery("");
    setItems(
      group?.items.map((item) => ({
        productName: item.productName,
        source: item.source,
        vendor: item.vendor,
        versionRule: item.versionRule,
        aliases: item.aliases.join("\n"),
        enabled: item.enabled,
      })) || [emptyItem()],
    );
    setOpen(true);
  };
  const updateItem = (index: number, values: Partial<ItemDraft>) =>
    setItems((current) =>
      current.map((item, itemIndex) =>
        itemIndex === index ? { ...item, ...values } : item,
      ),
    );
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    const form = new FormData(event.currentTarget);
    const payload = {
      tenantId: String(
        form.get("tenantId") || editing?.tenantId || tenantId || "",
      ),
      name: String(form.get("name") || "").trim(),
      description: String(form.get("description") || "").trim(),
      enabled: form.get("enabled") === "on",
      items: items
        .map((item) => ({
          ...item,
          productName: item.productName.trim(),
          vendor: item.vendor.trim(),
          versionRule: item.versionRule.trim(),
          aliases: item.aliases
            .split(/[\n,，、]+/)
            .map((value) => value.trim())
            .filter(Boolean),
        }))
        .filter((item) => item.productName),
    };
    try {
      const saved = await apiFetch<FingerprintWatchGroup>(
        editing
          ? `/api/fingerprint-watch-groups/${editing.id}`
          : "/api/fingerprint-watch-groups",
        { method: editing ? "PUT" : "POST", body: JSON.stringify(payload) },
      );
      setGroups((current) =>
        editing
          ? current.map((item) => (item.id === saved.id ? saved : item))
          : [saved, ...current],
      );
      setOpen(false);
      setToast({
        tone: "success",
        text: saved.isDefault
          ? "默认组监测设置已保存，漏洞告警已重新计算"
          : `${saved.name} 已保存，漏洞告警已重新计算`,
      });
    } catch (reason) {
      setToast({
        tone: "warning",
        text: reason instanceof Error ? reason.message : "监测组保存失败",
      });
    } finally {
      setSaving(false);
    }
  };
  const remove = async () => {
    if (!deleting) return;
    try {
      await apiFetch(`/api/fingerprint-watch-groups/${deleting.id}`, {
        method: "DELETE",
      });
      setGroups((current) => current.filter((item) => item.id !== deleting.id));
      setToast({ tone: "success", text: `${deleting.name} 已删除` });
      setDeleting(null);
    } catch (reason) {
      setToast({
        tone: "warning",
        text: reason instanceof Error ? reason.message : "监测组删除失败",
      });
    }
  };
  const recompute = async () => {
    setRecomputing(true);
    try {
      const result = await apiFetch<{
        matches: number;
        inserted: number;
        updated: number;
        removed: number;
      }>("/api/vulnerability-alerts/recompute", { method: "POST" });
      setToast({
        tone: "success",
        text: `重算完成：命中 ${result.matches}，新增 ${result.inserted}，更新 ${result.updated}，清理 ${result.removed}`,
      });
    } catch (reason) {
      setToast({
        tone: "warning",
        text: reason instanceof Error ? reason.message : "告警重算失败",
      });
    } finally {
      setRecomputing(false);
    }
  };
  const tenantName = (id: string) =>
    tenants.find((tenant) => tenant.id === id)?.name || id;
  const visibleGroups = tenantId
    ? groups.filter((group) => group.tenantId === tenantId)
    : groups;
  const groupPagination = useClientPagination(visibleGroups, 20, tenantId);
  const visibleTenants = tenantId
    ? tenants.filter((tenant) => tenant.id === tenantId)
    : tenants;
  const isSystemGroup = Boolean(editing?.isDefault);
  const assetItems = items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.source === "asset");
  const customItems = items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.source === "custom");
  const visibleAssetItems = assetItems.filter(
    ({ item }) =>
      !itemQuery.trim() ||
      [item.productName, item.vendor, item.aliases].some((value) =>
        value
          .toLocaleLowerCase()
          .includes(itemQuery.trim().toLocaleLowerCase()),
      ),
  );
  const editableItemRow = ({
    item,
    index,
  }: {
    item: ItemDraft;
    index: number;
  }) => (
    <div className="fingerprint-item-row" key={`${item.source}-${index}`}>
      <label>
        产品名称
        <input
          required={!isSystemGroup && index === 0}
          value={item.productName}
          onChange={(event) =>
            updateItem(index, { productName: event.target.value })
          }
          placeholder="例如：Nginx"
        />
      </label>
      <label>
        厂商
        <input
          value={item.vendor}
          onChange={(event) =>
            updateItem(index, { vendor: event.target.value })
          }
          placeholder="可选"
        />
      </label>
      <label>
        版本规则
        <input
          value={item.versionRule}
          onChange={(event) =>
            updateItem(index, { versionRule: event.target.value })
          }
          placeholder=">=1.20 <1.25"
        />
      </label>
      <label>
        产品别名
        <textarea
          rows={2}
          value={item.aliases}
          onChange={(event) =>
            updateItem(index, { aliases: event.target.value })
          }
          placeholder="每行一个别名"
        />
      </label>
      <label className="switch compact">
        <input
          type="checkbox"
          checked={item.enabled}
          onChange={(event) =>
            updateItem(index, { enabled: event.target.checked })
          }
        />
        <span />
        <em>启用</em>
      </label>
      <button
        type="button"
        className="fingerprint-remove-item"
        aria-label="删除该产品"
        title="删除该产品"
        disabled={!isSystemGroup && items.length === 1}
        onClick={() =>
          setItems((current) =>
            current.filter((_, itemIndex) => itemIndex !== index),
          )
        }
      >
        <Trash2 size={16} />
      </button>
    </div>
  );
  return (
    <>
      <PageHeader
        eyebrow="VULNERABILITY CORRELATION"
        title="指纹监测策略"
        description="系统自动同步资产监测中的应用和信息指纹；可在默认组中排除不需要监测的指纹，也可以新增自定义监测组。"
        actions={
          canManage ? (
            <>
              <Button
                variant="secondary"
                onClick={() => void recompute()}
                disabled={recomputing}
              >
                <RefreshCw size={16} />
                {recomputing ? "重算中..." : "重新计算告警"}
              </Button>
              <Button
                onClick={() => openGroup()}
                disabled={!visibleTenants.length}
              >
                <Plus size={17} />
                新增监测组
              </Button>
            </>
          ) : (
            <Tag>只读权限</Tag>
          )
        }
      />
      <Panel
        className="fingerprint-watch-panel"
        title={
          <span className="section-title">
            <Fingerprint size={17} /> 监测组 <em>{visibleGroups.length}</em>
          </span>
        }
      >
        {!visibleGroups.length ? (
          <EmptyState
            icon={<ShieldAlert size={31} />}
            title="尚未配置重点指纹"
            description="系统会自动同步资产监测中的全部应用和信息指纹；自定义指纹无资产命中时会进入待复核。"
          />
        ) : (
          <div className="fingerprint-watch-list">
            {groupPagination.items.map((group) => {
              const enabledItems = group.items.filter((item) => item.enabled);
              const excludedCount = group.items.length - enabledItems.length;
              return (
                <article className="fingerprint-watch-record" key={group.id}>
                  <header><div className="fingerprint-record-identity"><span><Fingerprint size={17} /></span><div><strong>{group.name}</strong><small>{group.description || "未填写说明"}</small></div>{group.isDefault && <Tag tone="cyan">系统同步</Tag>}</div><div className="fingerprint-record-meta"><span>{tenantName(group.tenantId)}</span><StatusDot label={group.enabled ? "监测中" : "已停用"} tone={group.enabled ? "success" : "muted"} /><time>{new Date(group.updatedAt).toLocaleString("zh-CN", { hour12: false })}</time></div>{canManage && <div className="fingerprint-watch-actions"><IconButton label={group.isDefault ? "管理指纹" : "编辑监测组"} onClick={() => openGroup(group)}><Pencil size={15} /></IconButton>{!group.isDefault && <IconButton label="删除监测组" className="danger-icon-button" onClick={() => setDeleting(group)}><Trash2 size={15} /></IconButton>}</div>}</header>
                  <section><div className="fingerprint-product-label"><span>重点产品</span><small>{enabledItems.length} 个监测{excludedCount ? ` / ${excludedCount} 个排除` : ""}</small></div><div className="fingerprint-product-tags">
                    {enabledItems.slice(0, 6).map((item) => (
                      <Tag key={item.id} tone="cyan">
                        {item.productName}
                        {item.versionRule ? ` ${item.versionRule}` : ""}
                      </Tag>
                    ))}
                    {enabledItems.length > 6 && <Tag>+{enabledItems.length - 6}</Tag>}
                  </div></section>
                </article>
              );
            })}
          </div>
        )}
        <TablePagination
          page={groupPagination.page}
          pageSize={groupPagination.pageSize}
          totalPages={groupPagination.totalPages}
          total={groupPagination.total}
          onPageChange={groupPagination.setPage}
          onPageSizeChange={groupPagination.setPageSize}
        />
      </Panel>
      <Modal
        open={open}
        title={
          isSystemGroup
            ? "管理默认组指纹"
            : editing
              ? `编辑监测组 · ${editing.name}`
              : "新增重点指纹监测组"
        }
        onClose={() => !saving && setOpen(false)}
        className="fingerprint-watch-modal"
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => setOpen(false)}
              disabled={saving}
            >
              取消
            </Button>
            <Button
              type="submit"
              form="fingerprint-watch-form"
              disabled={saving}
            >
              {saving
                ? "保存并重算中..."
                : isSystemGroup
                  ? "保存监测设置"
                  : "保存并重算"}
            </Button>
          </>
        }
      >
        <form
          id="fingerprint-watch-form"
          className="admin-form"
          onSubmit={save}
        >
          <div className="form-grid">
            <label>
              所属租户
              <select
                name="tenantId"
                required
                defaultValue={editing?.tenantId || tenantId || ""}
                disabled={Boolean(editing) || Boolean(tenantId)}
              >
                <option value="" disabled>
                  请选择租户
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
              监测组名称
              <input
                name="name"
                required
                readOnly={isSystemGroup}
                defaultValue={editing?.name || ""}
                placeholder="例如：互联网核心组件"
              />
            </label>
          </div>
          <label>
            监测组说明
            <textarea
              name="description"
              rows={2}
              readOnly={isSystemGroup}
              defaultValue={editing?.description || ""}
              placeholder="说明该组的业务范围或处置责任人"
            />
          </label>
          {!isSystemGroup && (
            <label className="switch">
              <input
                type="checkbox"
                name="enabled"
                defaultChecked={editing?.enabled ?? true}
              />
              <span />
              <em>启用该监测组</em>
            </label>
          )}
          {isSystemGroup ? (
            <>
              <section className="fingerprint-item-editor fingerprint-custom-editor">
                <header>
                  <div>
                    <strong>自定义补充指纹</strong>
                    <small>
                      可补充资产中尚未发现的重点产品；命中漏洞但没有关联资产时进入待复核。
                    </small>
                  </div>
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() =>
                      setItems((current) => [...current, emptyItem()])
                    }
                  >
                    <Plus size={15} />
                    添加自定义指纹
                  </Button>
                </header>
                {customItems.length ? (
                  customItems.map(editableItemRow)
                ) : (
                  <div className="fingerprint-custom-empty">
                    暂未添加自定义指纹
                  </div>
                )}
              </section>
              <section className="fingerprint-item-editor fingerprint-system-editor">
                <header>
                  <div>
                    <strong>资产同步指纹</strong>
                    <small>
                      关闭不需要监测的指纹后，系统会清理相关漏洞告警并保留排除设置。
                    </small>
                  </div>
                  <label className="fingerprint-item-search">
                    <Search size={15} />
                    <input
                      type="search"
                      aria-label="搜索默认组指纹"
                      value={itemQuery}
                      onChange={(event) => setItemQuery(event.target.value)}
                      placeholder="搜索产品名称或厂商"
                    />
                  </label>
                </header>
                <div className="fingerprint-system-list">
                  <div className="fingerprint-system-summary">
                    <span>共 {assetItems.length} 个资产指纹</span>
                    <span>
                      {assetItems.filter(({ item }) => item.enabled).length}{" "}
                      个监测中
                    </span>
                    <span>
                      {assetItems.filter(({ item }) => !item.enabled).length}{" "}
                      个已排除
                    </span>
                  </div>
                  {visibleAssetItems.length ? (
                    visibleAssetItems.map(({ item, index }) => (
                      <div
                        className="fingerprint-system-item"
                        key={item.productName}
                      >
                        <div>
                          <strong>{item.productName}</strong>
                          <small>
                            {item.vendor || "资产监测自动同步"}
                            {item.versionRule ? ` · ${item.versionRule}` : ""}
                          </small>
                        </div>
                        <label className="switch compact">
                          <input
                            aria-label={`${item.enabled ? "停用" : "启用"} ${item.productName}`}
                            type="checkbox"
                            checked={item.enabled}
                            onChange={(event) =>
                              updateItem(index, {
                                enabled: event.target.checked,
                              })
                            }
                          />
                          <span />
                          <em>{item.enabled ? "监测中" : "已排除"}</em>
                        </label>
                      </div>
                    ))
                  ) : (
                    <div className="fingerprint-system-empty">
                      没有匹配的指纹
                    </div>
                  )}
                </div>
              </section>
            </>
          ) : (
            <section className="fingerprint-item-editor">
              <header>
                <div>
                  <strong>重点应用指纹</strong>
                  <small>
                    产品名需与资产监测中的指纹名称一致；别名用于兼容不同数据源命名。
                  </small>
                </div>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() =>
                    setItems((current) => [...current, emptyItem()])
                  }
                >
                  <Plus size={15} />
                  添加产品
                </Button>
              </header>
              {items.map((item, index) => editableItemRow({ item, index }))}
            </section>
          )}
        </form>
      </Modal>
      <DeleteConfirmation
        open={Boolean(deleting)}
        title="删除重点指纹监测组"
        subject={
          deleting ? `${deleting.name}（${deleting.items.length} 个产品）` : ""
        }
        warning="删除后，该组产生的资产漏洞告警会同步清理，此操作不可恢复。"
        confirming={false}
        onClose={() => setDeleting(null)}
        onConfirm={() => void remove()}
      />
      <Toast value={toast} onClose={() => setToast(null)} />
    </>
  );
}
