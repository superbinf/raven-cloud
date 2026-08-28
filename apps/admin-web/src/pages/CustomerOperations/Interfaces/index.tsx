import { useEffect, useState, type FormEvent } from "react";

import {
  Activity,
  AlertTriangle,
  Database,
  KeyRound,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Webhook,
} from "lucide-react";
import {
  type ApiConnection,
  type ConnectorProvider,
  type CredentialApiTestResult,
  type MonitoringTarget,
} from "@sentinel/shared";
import { Button, Modal, Panel, StatusDot, Tag, cn } from "@/components/ui";
import {
  DeleteConfirmation,
  PageHeader,
  SequenceCell,
  SequenceHeader,
  Toast,
  type ToastState,
} from "@/components/business/AdminPrimitives";
import {
  TablePagination,
  useClientPagination,
} from "@/components/business/TablePagination";
import { adminApiFetch as apiFetch } from "@/api/admin";
import { useAdminInitialLoading } from "@/hooks/useAdminInitialLoading";

export function InterfacesPage({
  canManage,
  tenantId,
}: {
  canManage: boolean;
  tenantId?: string;
}) {
  const [connections, setConnections] = useState<ApiConnection[]>([]);
  const [providers, setProviders] = useState<ConnectorProvider[]>([]);
  const [targets, setTargets] = useState<MonitoringTarget[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [testing, setTesting] = useState<string | null>(null);
  const [syncing, setSyncing] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastState>(null);
  const [configOpen, setConfigOpen] = useState(false);
  const [editingConnection, setEditingConnection] =
    useState<ApiConnection | null>(null);
  const [deletingConnection, setDeletingConnection] =
    useState<ApiConnection | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [testResult, setTestResult] = useState<CredentialApiTestResult | null>(
    null,
  );
  useAdminInitialLoading("interfaces", loading);
  const [providerType, setProviderType] = useState<
    ApiConnection["providerType"]
  >("darkweb_subscription");
  const load = async () => {
    setLoading(true);
    setLoadError("");
    try {
      const tenantQuery = tenantId ? `?tenant_id=${encodeURIComponent(tenantId)}` : "";
      const [items, targetItems, providerItems] = await Promise.all([
        apiFetch<ApiConnection[]>(`/api/connections${tenantQuery}`),
        apiFetch<MonitoringTarget[]>(`/api/targets${tenantQuery}`),
        apiFetch<ConnectorProvider[]>("/api/connector-providers"),
      ]);
      setConnections(items);
      setTargets(targetItems);
      setProviders(providerItems);
    } catch (reason) {
      setLoadError(
        reason instanceof Error ? reason.message : "接口数据加载失败",
      );
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
  }, [tenantId]);
  const openConfig = (connection?: ApiConnection) => {
    setEditingConnection(connection ?? null);
    setProviderType(connection?.providerType ?? "darkweb_subscription");
    setTestResult(null);
    setConfigOpen(true);
  };
  const saveConnection = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = String(form.get("name") || "新接口").trim();
    const endpoint = String(form.get("endpoint") || "")
      .trim()
      .replace(/\/$/, "");
    const category = String(form.get("category") || "其他");
    const method = String(
      form.get("method") || "POST",
    ) as ApiConnection["method"];
    const key = String(form.get("apiKey") || "").trim();
    const targetId = String(
      form.get("targetId") || editingConnection?.targetId || "",
    );
    const selectedProvider = String(
      form.get("providerType") || providerType,
    ) as ApiConnection["providerType"];
    const query = String(form.get("query") || "").trim();
    const config =
      selectedProvider === "hunter_asset"
        ? { query, pageSize: Number(form.get("pageSize") || 100), isWeb: true }
        : selectedProvider === "watchvuln"
          ? {
              pageSize: Number(form.get("pageSize") || 500),
              maxPages: Number(form.get("maxPages") || 200),
              incremental: form.get("incremental") === "on",
              autoPublish: form.get("autoPublish") === "on",
            }
          : {};
    const payload = {
      name,
      endpoint,
      category,
      providerType: selectedProvider,
      method,
      apiKey: key || undefined,
      targetId: targetId || undefined,
      enabled: form.get("enabled") === "on",
      config,
    };
    const request = editingConnection
      ? apiFetch<ApiConnection>(`/api/connections/${editingConnection.id}`, {
          method: "PUT",
          body: JSON.stringify(payload),
        })
      : apiFetch<ApiConnection>("/api/connections", {
          method: "POST",
          body: JSON.stringify(payload),
        });
    request
      .then((saved) => {
        setConnections((items) =>
          editingConnection
            ? items.map((item) => (item.id === saved.id ? saved : item))
            : [saved, ...items],
        );
        setConfigOpen(false);
        setToast({
          tone: "success",
          text: `${name} 配置已保存，密钥仅保留配置状态`,
        });
      })
      .catch((error) => setToast({ tone: "warning", text: error.message }));
  };
  const test = async (connection: ApiConnection, apiKeyOverride?: string) => {
    setTesting(connection.id);
    setTestResult(null);
    try {
      const result = await apiFetch<CredentialApiTestResult>(
        `/api/connections/${connection.id}/test`,
        { method: "POST" },
      );
      setTestResult(result);
      setToast({
        tone: result.ok ? "success" : "warning",
        text: `${connection.name}：${result.message}`,
      });
      setConnections((items) =>
        items.map((item) =>
          item.id === connection.id
            ? {
                ...item,
                status: result.ok ? "正常" : "异常",
                successRate: result.ok ? 100 : 0,
                lastCalled: "刚刚",
                lastTestMessage: result.message,
              }
            : item,
        ),
      );
    } catch (error) {
      setToast({
        tone: "warning",
        text: error instanceof Error ? error.message : "接口测试失败",
      });
    }
    setTesting(null);
  };
  const sync = async (connection: ApiConnection) => {
    setSyncing(connection.id);
    try {
      const result = await apiFetch<{
        run: { id: string };
        deduplicated: boolean;
      }>(`/api/connections/${connection.id}/sync`, { method: "POST" });
      setToast({
        tone: "success",
        text: result.deduplicated
          ? `采集任务已在队列中（${result.run.id}）`
          : `采集任务已提交（${result.run.id}）`,
      });
    } catch (error) {
      setToast({
        tone: "warning",
        text: error instanceof Error ? error.message : "同步失败",
      });
    }
    setSyncing(null);
  };
  const deleteConnection = async () => {
    if (!deletingConnection) return;
    setDeleting(true);
    try {
      await apiFetch(
        `/api/connections/${encodeURIComponent(deletingConnection.id)}`,
        { method: "DELETE" },
      );
      setConnections((items) =>
        items.filter((item) => item.id !== deletingConnection.id),
      );
      setToast({ tone: "success", text: `${deletingConnection.name} 已删除` });
      setDeletingConnection(null);
    } catch (error) {
      setToast({
        tone: "warning",
        text: error instanceof Error ? error.message : "接口删除失败",
      });
    } finally {
      setDeleting(false);
    }
  };
  const testConfiguredConnection = async () => {
    const formElement = document.getElementById(
      "connection-config-form",
    ) as HTMLFormElement | null;
    if (!formElement) return;
    const form = new FormData(formElement);
    setTesting("API-CONFIG");
    try {
      const selectedProvider = String(form.get("providerType") || providerType);
      const config =
        selectedProvider === "hunter_asset"
          ? {
              query: String(form.get("query") || ""),
              pageSize: Number(form.get("pageSize") || 100),
              isWeb: true,
            }
          : selectedProvider === "watchvuln"
            ? {
                pageSize: Number(form.get("pageSize") || 500),
                maxPages: Number(form.get("maxPages") || 200),
                incremental: form.get("incremental") === "on",
                autoPublish: form.get("autoPublish") === "on",
              }
            : {};
      const result = await apiFetch<CredentialApiTestResult>(
        "/api/connections/test-config",
        {
          method: "POST",
          body: JSON.stringify({
            providerType: selectedProvider,
            endpoint: String(form.get("endpoint") || ""),
            method: String(form.get("method") || "GET"),
            apiKey: String(form.get("apiKey") || ""),
            targetId: String(
              form.get("targetId") || editingConnection?.targetId || "",
            ),
            config,
          }),
        },
      );
      setTestResult(result);
      setToast({
        tone: result.ok ? "success" : "warning",
        text: result.message,
      });
    } catch (error) {
      setToast({
        tone: "warning",
        text: error instanceof Error ? error.message : "接口测试失败",
      });
    }
    setTesting(null);
  };
  const visibleTargets = tenantId
    ? targets.filter((target) => target.tenantId === tenantId)
    : targets;
  const visibleTargetIds = new Set(visibleTargets.map((target) => target.id));
  const visibleConnections = tenantId
    ? connections.filter(
        (item) => item.targetId && visibleTargetIds.has(item.targetId),
      )
    : connections;
  const connectionPagination = useClientPagination(
    visibleConnections,
    20,
    tenantId,
  );
  const normalCount = visibleConnections.filter(
    (item) => item.status === "正常",
  ).length;
  const abnormalCount = visibleConnections.filter(
    (item) => item.status === "异常",
  ).length;
  return (
    <>
      <PageHeader
        eyebrow="DATA CONNECTORS"
        title="数据源接口"
        description="统一管理当前客户的数据源连接、开放 API、配额和调用健康度。"
        actions={
          <>
            {canManage ? (
              <Button
                onClick={() => openConfig()}
                disabled={!visibleTargets.length}
              >
                <Plus size={17} />
                新增接口
              </Button>
            ) : (
              <Tag>只读权限</Tag>
            )}
            <Button
              variant="secondary"
              onClick={() => void load()}
              disabled={loading}
            >
              <RefreshCw size={17} />
              {loading ? "刷新中..." : "刷新"}
            </Button>
          </>
        }
      />
      <section className="connection-summary">
        <div>
          <Webhook size={20} />
          <span>
            <strong>{visibleConnections.length}</strong>
            <small>已配置连接器</small>
          </span>
        </div>
        <div>
          <Activity size={20} />
          <span>
            <strong>{normalCount}</strong>
            <small>状态正常</small>
          </span>
        </div>
        <div>
          <AlertTriangle size={20} />
          <span>
            <strong>{abnormalCount}</strong>
            <small>状态异常</small>
          </span>
        </div>
        <div>
          <KeyRound size={20} />
          <span>
            <strong>
              {
                visibleConnections.filter((item) => item.apiKeyConfigured)
                  .length
              }
            </strong>
            <small>已配置 API Key</small>
          </span>
        </div>
      </section>
      <Panel
        className="interface-list-panel"
        title={<span className="interface-panel-title"><Database size={16} />数据接口</span>}
        action={!loading && !loadError ? <Tag tone="cyan">{visibleConnections.length} 个连接器</Tag> : undefined}
      >
        {loadError ? (
          <div className="inline-empty">
            <AlertTriangle size={24} />
            <strong>接口数据加载失败</strong>
            <span>{loadError}</span>
            <Button variant="secondary" onClick={() => void load()}>
              重新加载
            </Button>
          </div>
        ) : loading ? (
          <div className="inline-empty">
            <RefreshCw size={24} />
            <strong>正在加载接口配置</strong>
          </div>
        ) : (
          <>
            {visibleConnections.length ? (
              <div className="admin-table interface-table">
                <div className="admin-table-head">
                  <SequenceHeader />
                  <span>连接器</span>
                  <span>类型</span>
                  <span>运行状态</span>
                  <span>配额</span>
                  <span>最近调用</span>
                  <span className="interface-actions-heading">操作</span>
                </div>
                {connectionPagination.items.map((connection, index) => (
                  <div className="admin-table-row" key={connection.id}>
                    <SequenceCell value={(connectionPagination.page - 1) * connectionPagination.pageSize + index + 1} />
                    <div className="connector-cell">
                      <span>
                        <Database size={18} />
                      </span>
                      <div>
                        <strong>{connection.name}</strong>
                        <small>{connection.endpoint || "未配置地址"}</small>
                      </div>
                    </div>
                    <Tag>{connection.providerName}</Tag>
                    <div className="interface-status-cell">
                      <StatusDot
                        label={!connection.enabled ? "已停用" : connection.status}
                        tone={
                          !connection.enabled
                            ? "muted"
                            : connection.status === "正常"
                              ? "success"
                              : connection.status === "异常"
                                ? "danger"
                                : "muted"
                        }
                      />
                      <small>成功率 <span className="mono">{connection.successRate.toFixed(1)}%</span></small>
                    </div>
                    <div className="interface-meta-cell"><strong>{connection.quota}</strong><small>当前配额</small></div>
                    <div className="interface-meta-cell"><strong>{connection.lastCalled}</strong><small>最近调用</small></div>
                    {canManage ? (
                      <div className="interface-actions">
                        <button
                          className="interface-action-button"
                          aria-label={`配置 ${connection.name}`}
                          title="配置"
                          onClick={() => openConfig(connection)}
                        >
                          <Webhook size={15} />
                        </button>
                        <button
                          className="interface-action-button"
                          aria-label={`${testing === connection.id ? "正在测试" : "测试连接"} ${connection.name}`}
                          title={testing === connection.id ? "正在测试" : "测试连接"}
                          disabled={testing === connection.id}
                          onClick={() => test(connection)}
                        >
                          {testing === connection.id ? <RefreshCw className="is-spinning" size={15} /> : <Activity size={15} />}
                        </button>
                        {providers.find(
                          (item) => item.type === connection.providerType,
                        )?.supportsSync && (
                          <button
                            className="interface-action-button"
                            aria-label={`${syncing === connection.id ? "正在提交同步" : "同步数据"} ${connection.name}`}
                            title={syncing === connection.id ? "正在提交" : "同步数据"}
                            disabled={
                              syncing === connection.id || !connection.enabled
                            }
                            onClick={() => sync(connection)}
                          >
                            {syncing === connection.id ? <RefreshCw className="is-spinning" size={15} /> : <Database size={15} />}
                          </button>
                        )}
                        <button
                          className="interface-action-button interface-action-danger"
                          aria-label={`删除 ${connection.name}`}
                          title="删除"
                          onClick={() => setDeletingConnection(connection)}
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    ) : (
                      <span>查看</span>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div className="inline-empty">
                <Webhook size={24} />
                <strong>暂无接口配置</strong>
                <span>
                  {canManage
                    ? "可通过右上角新增第一个数据源接口"
                    : "当前没有可查看的数据源接口"}
                </span>
              </div>
            )}
            <TablePagination
              page={connectionPagination.page}
              pageSize={connectionPagination.pageSize}
              totalPages={connectionPagination.totalPages}
              total={connectionPagination.total}
              onPageChange={connectionPagination.setPage}
              onPageSizeChange={connectionPagination.setPageSize}
            />
          </>
        )}
      </Panel>
      <div className="security-notice">
        <ShieldCheck size={19} />
        <div>
          <strong>密钥安全策略</strong>
          <p>
            Key
            只允许在后台配置和测试，保存后不回显原值；真实部署应由服务端代理调用第三方
            API，前台只接收授权后的结果。
          </p>
        </div>
      </div>
      <Modal
        open={configOpen}
        title={
          editingConnection ? `配置 ${editingConnection.name}` : "新增数据接口"
        }
        onClose={() => setConfigOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfigOpen(false)}>
              取消
            </Button>
            <Button
              variant="secondary"
              type="submit"
              form="connection-config-form"
            >
              保存配置
            </Button>
            <Button
              type="button"
              onClick={() => void testConfiguredConnection()}
              disabled={Boolean(testing)}
            >
              {testing ? "测试中..." : "测试连接"}
            </Button>
          </>
        }
      >
        <form
          id="connection-config-form"
          className="admin-form"
          onSubmit={saveConnection}
        >
          <label>
            接口名称
            <input
              name="name"
              required
              defaultValue={editingConnection?.name ?? ""}
              placeholder="例如：WatchVuln 漏洞情报"
            />
          </label>
          <div className="form-grid">
            <label>
              连接器类型
              <select
                name="providerType"
                value={providerType}
                onChange={(event) =>
                  setProviderType(
                    event.target.value as ApiConnection["providerType"],
                  )
                }
              >
                {providers.map((provider) => (
                  <option key={provider.type} value={provider.type}>
                    {provider.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              业务分类
              <select
                name="category"
                defaultValue={editingConnection?.category ?? "凭据泄露"}
              >
                <option>凭据泄露</option>
                <option>互联网资产</option>
                <option>暗网情报</option>
                <option>敏感泄露</option>
                <option>漏洞情报</option>
                <option>仿冒监测</option>
                <option>其他</option>
              </select>
            </label>
          </div>
          <div className="form-grid">
            <label>
              请求方法
              <select
                name="method"
                defaultValue={
                  editingConnection?.method ??
                  (["hunter_asset", "watchvuln"].includes(providerType)
                    ? "GET"
                    : "POST")
                }
              >
                <option>POST</option>
                <option>GET</option>
              </select>
            </label>
            <label className="switch">
              <input
                name="enabled"
                type="checkbox"
                defaultChecked={editingConnection?.enabled ?? true}
              />
              <span />
              <em>启用连接器</em>
            </label>
          </div>
          <label>
            关联监测对象
            <select
              name="targetId"
              defaultValue={
                editingConnection?.targetId ?? visibleTargets[0]?.id ?? ""
              }
            >
              <option value="">不关联对象</option>
              {visibleTargets.map((target) => (
                <option value={target.id} key={target.id}>
                  {target.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            API 基础地址
            <input
              name="endpoint"
              type="url"
              required
              defaultValue={
                editingConnection?.endpoint ??
                (providerType === "hunter_asset"
                  ? "https://hunter.qianxin.com"
                  : providerType === "watchvuln"
                    ? "http://127.0.0.1:18080"
                    : "https://darkweb.xxx")
              }
              placeholder="https://api.example.com"
            />
          </label>
          <label>
            {providerType === "watchvuln" ? "Feed Token" : "API Key"}
            <input
              name="apiKey"
              type="password"
              autoComplete="new-password"
              placeholder={
                editingConnection?.apiKeyConfigured
                  ? "已配置，留空保持不变"
                  : providerType === "watchvuln"
                    ? "输入 WATCHVULN_FEED_TOKEN"
                    : "输入 API Key"
              }
            />
          </label>
          {providerType === "hunter_asset" && (
            <div className="form-grid">
              <label>
                Hunter 查询语句
                <input
                  name="query"
                  required
                  defaultValue={String(editingConnection?.config?.query ?? "")}
                  placeholder={'domain="example.com"'}
                />
              </label>
              <label>
                单次采集上限
                <input
                  name="pageSize"
                  type="number"
                  min="1"
                  max="100"
                  defaultValue={Number(
                    editingConnection?.config?.pageSize ?? 100,
                  )}
                />
              </label>
            </div>
          )}
          {providerType === "watchvuln" && (
            <>
              <div className="form-grid">
                <label>
                  每页数量
                  <input
                    name="pageSize"
                    type="number"
                    min="1"
                    max="500"
                    defaultValue={Number(
                      editingConnection?.config?.pageSize ?? 500,
                    )}
                  />
                </label>
                <label>
                  最大页数
                  <input
                    name="maxPages"
                    type="number"
                    min="1"
                    max="1000"
                    defaultValue={Number(
                      editingConnection?.config?.maxPages ?? 200,
                    )}
                  />
                </label>
              </div>
              <label className="switch">
                <input
                  name="incremental"
                  type="checkbox"
                  defaultChecked={
                    editingConnection?.config?.incremental !== false
                  }
                />
                <span />
                <em>成功同步后使用增量窗口</em>
              </label>
              <label className="switch">
                <input
                  name="autoPublish"
                  type="checkbox"
                  defaultChecked={
                    editingConnection?.config?.autoPublish !== false
                  }
                />
                <span />
                <em>自动审核并发布到云端与地端</em>
              </label>
            </>
          )}
          <p className="form-help">
            连接器决定认证方式、请求协议和入库适配器；接口实例只保存地址、密钥和查询参数。定时周期在“调度计划”中单独配置。
          </p>
          {testResult && (
            <div
              className={cn(
                "api-test-result",
                testResult.ok ? "api-test-success" : "api-test-failed",
              )}
            >
              <strong>{testResult.ok ? "连接成功" : "连接失败"}</strong>
              <span>
                HTTP {testResult.status || "--"} · {testResult.elapsedMs}ms ·{" "}
                {testResult.message}
              </span>
              <small>
                检查路径：{testResult.checkedPaths.join("、")}{" "}
                {testResult.ok && testResult.subscriptionCount
                  ? `· 返回规模 ${testResult.subscriptionCount}`
                  : ""}
              </small>
            </div>
          )}
        </form>
      </Modal>
      <DeleteConfirmation
        open={Boolean(deletingConnection)}
        title="删除数据接口"
        subject={
          deletingConnection
            ? `${deletingConnection.name}（${deletingConnection.id}）`
            : ""
        }
        warning="接口地址、认证配置和健康状态将被永久删除，已同步的情报数据不会受影响。"
        confirming={deleting}
        onClose={() => setDeletingConnection(null)}
        onConfirm={() => void deleteConnection()}
      />
      <Toast value={toast} onClose={() => setToast(null)} />
    </>
  );
}
