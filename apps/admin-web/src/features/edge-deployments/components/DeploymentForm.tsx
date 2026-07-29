import { useState, type FormEvent } from "react";
import type { EdgePortalModule } from "@sentinel/contracts";
import type { EdgeDeployment, EdgeDeploymentInput, EdgeTenant } from "../model/types";
import { portalModuleOptions } from "../model/portalModules";
import styles from "../edgeDeployments.module.css";

export function DeploymentForm({ deployment, tenants, tenantId, onSubmit }: { deployment: EdgeDeployment | null; tenants: EdgeTenant[]; tenantId?: string; onSubmit: (input: EdgeDeploymentInput) => void }) {
  const [moduleError, setModuleError] = useState("");
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const enabledModules = form.getAll("enabledModules") as EdgePortalModule[];
    if (!enabledModules.length) { setModuleError("请至少开放一个地端板块"); return; }
    setModuleError("");
    onSubmit({
      tenantId: String(form.get("tenantId") || deployment?.tenantId || tenantId || ""),
      name: String(form.get("name") || "").trim(),
      enabled: form.get("enabled") === "on",
      syncMode: "api_pull",
      pollIntervalSeconds: Number(form.get("pollIntervalSeconds") || 3_600),
      enabledModules,
      licenseExpiresAt: String(form.get("licenseExpiresAt") || "")
    });
  };

  return <form id="edge-deployment-form" className="admin-form" onSubmit={submit}>
    <label>客户租户<select name="tenantId" required defaultValue={deployment?.tenantId ?? tenantId ?? ""} disabled={Boolean(deployment) || Boolean(tenantId)}><option value="" disabled>请选择租户</option>{tenants.filter((tenant) => tenant.status !== "disabled").map((tenant) => <option value={tenant.id} key={tenant.id}>{tenant.name} · {tenant.id}</option>)}</select></label>
    <label>部署实例名称<input name="name" required defaultValue={deployment?.name ?? ""} placeholder="例如：重庆研发中心 Portal" /></label>
    <div className="form-grid"><label>同步方式<input value="API 拉取" readOnly /></label><label>版本检查周期<select name="pollIntervalSeconds" defaultValue={deployment?.pollIntervalSeconds ?? 3_600}><option value="300">5 分钟</option><option value="900">15 分钟</option><option value="1800">30 分钟</option><option value="3600">1 小时</option><option value="21600">6 小时</option><option value="43200">12 小时</option><option value="86400">24 小时</option></select></label></div>
    <fieldset className={styles.moduleFieldset} aria-describedby={moduleError ? "edge-module-error" : undefined} onChange={() => setModuleError("")}>
      <legend>开放板块</legend>
      <p>仅选中的板块会在该地端显示并允许访问，配置将在地端下次同步后生效。</p>
      <div className={styles.moduleOptions}>{portalModuleOptions.map((module) => {
        const Icon = module.icon;
        return <label key={module.id} className={styles.moduleOption}>
          <input type="checkbox" name="enabledModules" value={module.id} defaultChecked={deployment?.enabledModules?.includes(module.id) ?? true} />
          <span className={styles.moduleCheck} aria-hidden="true" />
          <Icon size={18} aria-hidden="true" />
          <span><strong>{module.label}</strong><small>{module.description}</small></span>
        </label>;
      })}</div>
      {moduleError && <span id="edge-module-error" className={styles.moduleError} role="alert">{moduleError}</span>}
    </fieldset>
    {!deployment && <label>初始许可证有效期<input name="licenseExpiresAt" type="date" required min={new Date(Date.now() + 86400_000).toISOString().slice(0, 10)} defaultValue={new Date(Date.now() + 365 * 86400_000).toISOString().slice(0, 10)} /></label>}
    <label className="switch"><input name="enabled" type="checkbox" defaultChecked={deployment?.enabled ?? true} /><span /><em>允许该地端连接并同步数据</em></label>
    <p className="form-help">地端按配置周期通过 OpenAPI 检查快照版本；版本未变化时不下载业务数据，发现新版本后下载并原子应用完整快照，附件按内容哈希复用。</p>
  </form>;
}
