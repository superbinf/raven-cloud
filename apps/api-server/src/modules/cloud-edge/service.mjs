import { randomBytes } from "node:crypto";
import { EDGE_PORTAL_MODULES, edgeSyncStatusReportV1Schema } from "@sentinel/contracts";
import { verifyAndDecryptSnapshot } from "@sentinel/distribution";
import { buildTenantSnapshot, projectTenantSnapshotWithWarnings, snapshotSourceHash } from "./snapshot-builder.mjs";
import { createDeploymentApiKey, createLicenseKey, deploymentSecretMatches, hashDeploymentSecret, hashLicenseSecret, licenseSecretMatches, parseLicenseKey } from "./auth.mjs";

function httpError(statusCode, message) { return Object.assign(new Error(message), { statusCode }); }
function identifier(prefix) { return `${prefix}-${randomBytes(8).toString("hex").toUpperCase()}`; }
function requireName(value, label) {
  const name = String(value || "").trim();
  if (!name || name.length > 120) throw httpError(400, `${label}不能为空且不能超过 120 个字符`);
  return name;
}
function syncMode(value) {
  if (value !== "api_pull") throw httpError(400, "地端仅允许使用 API 拉取模式");
  return "api_pull";
}
function pollInterval(value) {
  const seconds = Number(value ?? 3_600);
  if (!Number.isInteger(seconds) || seconds < 30 || seconds > 86_400) throw httpError(400, "地端同步周期必须是 30 到 86400 秒之间的整数");
  return seconds;
}

function enabledModules(value) {
  const modules = value === undefined ? [...EDGE_PORTAL_MODULES] : value;
  if (!Array.isArray(modules) || !modules.length) throw httpError(400, "请至少开放一个地端板块");
  const normalized = [...new Set(modules.map((item) => String(item)))];
  if (normalized.length !== modules.length || normalized.some((item) => !EDGE_PORTAL_MODULES.includes(item))) throw httpError(400, "地端开放板块配置不合法");
  return EDGE_PORTAL_MODULES.filter((item) => normalized.includes(item));
}

function licenseExpiry(value) {
  const fallback = new Date(Date.now() + 365 * 86400_000).toISOString();
  const text = String(value || fallback).trim();
  const parsed = new Date(/^\d{4}-\d{2}-\d{2}$/.test(text) ? `${text}T23:59:59.999Z` : text);
  if (Number.isNaN(parsed.getTime()) || parsed.getTime() <= Date.now()) throw httpError(400, "许可证到期时间必须晚于当前时间");
  if (parsed.getTime() > Date.now() + 10 * 365 * 86400_000) throw httpError(400, "许可证有效期不能超过 10 年");
  return parsed.toISOString();
}

export function createCloudEdgeService({ db, repository, masterSecret, encryptSecret, decryptSecret, localStorage, objectStorage, publicBaseUrl, readFileObject, snapshotJobs, articleImagesDir, articleImagesDirs }) {
  const activation = (deployment, authenticationSecret, snapshotSecret) => ({
    protocolVersion: 1,
    cloudBaseUrl: publicBaseUrl,
    apiKey: createDeploymentApiKey(deployment.id, authenticationSecret, snapshotSecret)
  });
  const licenseDelivery = (license, secret) => ({ ...license, cloudBaseUrl: publicBaseUrl, licenseKey: createLicenseKey(license.id, secret) });

  return {
    listTenants: () => repository.listTenants(),
    async createTenant(body) {
      const now = new Date().toISOString();
      const id = String(body.id || identifier("TENANT")).trim().toUpperCase();
      if (!/^[A-Z0-9][A-Z0-9_-]{2,63}$/.test(id)) throw httpError(400, "租户 ID 格式不合法");
      if (await repository.getTenant(id)) throw httpError(409, "租户 ID 已存在");
      return repository.createTenant({ id, name: requireName(body.name, "租户名称"), status: "active", createdAt: now, updatedAt: now });
    },
    async updateTenant(id, body) {
      const current = await repository.getTenant(id);
      if (!current) throw httpError(404, "客户不存在");
      const status = body.status === undefined ? current.status : String(body.status);
      if (!["active", "disabled"].includes(status)) throw httpError(400, "客户状态不合法");
      return repository.updateTenant(id, {
        name: body.name === undefined ? current.name : requireName(body.name, "客户名称"),
        status,
        updatedAt: new Date().toISOString()
      });
    },
    async deleteTenant(id, body) {
      const current = await repository.getTenant(id);
      if (!current) throw httpError(404, "客户不存在");
      if (String(body?.confirmation || "") !== current.id) throw httpError(400, "删除确认内容与客户 ID 不一致");
      const usage = await repository.tenantUsage(id);
      const related = Object.values(usage).reduce((sum, value) => sum + value, 0);
      if (related > 0) throw httpError(409, "该客户仍有关联配置或业务数据，请先完成清理后再删除");
      await repository.deleteEmptyTenant(id);
      return { deleted: true, tenantId: id };
    },
    listDeployments: () => repository.listDeployments(),
    async getDeployment(id) {
      const deployment = await repository.getDeployment(id);
      if (!deployment) throw httpError(404, "地端实例不存在");
      return deployment;
    },
    async createDeployment(body) {
      const tenant = await repository.getTenant(String(body.tenantId || ""));
      if (!tenant || tenant.status !== "active") throw httpError(400, "租户不存在或已停用");
      const authenticationSecret = randomBytes(32).toString("base64url");
      const snapshotSecret = randomBytes(32).toString("base64url");
      const now = new Date().toISOString();
      const deployment = await repository.createDeployment({
        id: identifier("EDGE"), tenantId: tenant.id, name: requireName(body.name, "实例名称"),
        enabled: body.enabled !== false, syncMode: syncMode(body.syncMode || "api_pull"),
        pollIntervalSeconds: pollInterval(body.pollIntervalSeconds),
        enabledModules: enabledModules(body.enabledModules),
        deploymentSecretHash: hashDeploymentSecret(authenticationSecret, masterSecret),
        deploymentSecretEnc: encryptSecret(authenticationSecret), snapshotSecretEnc: encryptSecret(snapshotSecret),
        createdAt: now, updatedAt: now
      });
      const licenseSecret = randomBytes(32).toString("base64url");
      const license = await repository.issueLicense({ id: identifier("LIC"), deploymentId: deployment.id, tenantId: deployment.tenantId, licenseSecretHash: hashLicenseSecret(licenseSecret, masterSecret), issuedAt: now, expiresAt: licenseExpiry(body.licenseExpiresAt), updatedAt: now });
      const snapshotJob = snapshotJobs ? (await snapshotJobs.enqueue(deployment.id, { force: true, triggerType: "create" })).job : null;
      return { deployment: await repository.getDeployment(deployment.id), activationConfig: activation(deployment, authenticationSecret, snapshotSecret), license: licenseDelivery(license, licenseSecret), snapshotJob };
    },
    async updateDeployment(id, body) {
      const current = await this.getDeployment(id);
      return repository.updateDeployment(id, {
        name: body.name === undefined ? current.name : requireName(body.name, "实例名称"),
        enabled: body.enabled === undefined ? current.enabled : Boolean(body.enabled),
        syncMode: body.syncMode === undefined ? current.syncMode : syncMode(body.syncMode),
        pollIntervalSeconds: body.pollIntervalSeconds === undefined ? current.pollIntervalSeconds : pollInterval(body.pollIntervalSeconds),
        enabledModules: body.enabledModules === undefined ? current.enabledModules : enabledModules(body.enabledModules),
        updatedAt: new Date().toISOString()
      });
    },
    async deleteDeployment(id, body) {
      const current = await repository.getDeployment(id);
      if (!current) throw httpError(404, "地端实例不存在");
      if (current.enabled) throw httpError(409, "请先停用地端实例，再执行删除");
      if (String(body?.confirmation || "") !== current.id) throw httpError(400, "删除确认内容与地端实例 ID 不一致");
      const snapshots = await repository.listSnapshotStorage(id);
      if (objectStorage) await objectStorage.deleteDeployment(id, snapshots);
      await localStorage.deleteDeployment(id, snapshots);
      await repository.deleteDeployment(id);
      return { deleted: true, deploymentId: id, deletedSnapshots: snapshots.length };
    },
    async rotateActivation(id) {
      const current = await repository.getDeployment(id, { includeSecret: true });
      if (!current) throw httpError(404, "地端实例不存在");
      const authenticationSecret = randomBytes(32).toString("base64url");
      const deployment = await repository.rotateDeploymentSecret(id, hashDeploymentSecret(authenticationSecret, masterSecret), encryptSecret(authenticationSecret), new Date().toISOString());
      return { deployment, activationConfig: activation(deployment, authenticationSecret, decryptSecret(current.snapshotSecretEnc)) };
    },
    async revokeApiKey(id) {
      await this.getDeployment(id);
      return { deployment: await repository.revokeDeploymentSecret(id, new Date().toISOString()) };
    },
    async issueLicense(id, body) {
      const deployment = await this.getDeployment(id);
      const secret = randomBytes(32).toString("base64url");
      const now = new Date().toISOString();
      const license = await repository.issueLicense({ id: identifier("LIC"), deploymentId: deployment.id, tenantId: deployment.tenantId, licenseSecretHash: hashLicenseSecret(secret, masterSecret), issuedAt: now, expiresAt: licenseExpiry(body?.expiresAt), updatedAt: now });
      return { deployment: await repository.getDeployment(id), license: licenseDelivery(license, secret) };
    },
    async updateLicense(id, body) {
      await this.getDeployment(id);
      if (!await repository.getLicenseByDeployment(id)) throw httpError(409, "当前部署尚未签发许可证");
      const license = await repository.updateLicense(id, licenseExpiry(body?.expiresAt), new Date().toISOString());
      return { deployment: await repository.getDeployment(id), license };
    },
    async revokeLicense(id) {
      await this.getDeployment(id);
      if (!await repository.getLicenseByDeployment(id)) throw httpError(409, "当前部署尚未签发许可证");
      const license = await repository.revokeLicense(id, new Date().toISOString());
      return { deployment: await repository.getDeployment(id), license };
    },
    async validateLicense(body) {
      const parsed = parseLicenseKey(body?.licenseKey);
      if (!parsed) return { valid: false, status: "invalid", message: "许可证格式不合法", serverTime: new Date().toISOString() };
      const license = await repository.getLicenseById(parsed.licenseId, { includeSecret: true });
      if (!license || !licenseSecretMatches(parsed.secret, license.licenseSecretHash, masterSecret)) return { valid: false, status: "invalid", message: "许可证不存在或密钥无效", serverTime: new Date().toISOString() };
      const deployment = await repository.getDeployment(license.deploymentId);
      if (!deployment?.enabled) return { valid: false, status: "disabled", message: "许可证绑定的地端部署已停用", serverTime: new Date().toISOString(), deploymentId: license.deploymentId };
      if (license.status === "revoked") return { valid: false, status: "revoked", message: "许可证已注销", serverTime: new Date().toISOString(), deploymentId: license.deploymentId, expiresAt: license.expiresAt };
      if (license.status === "expired") return { valid: false, status: "expired", message: "许可证已过期", serverTime: new Date().toISOString(), deploymentId: license.deploymentId, expiresAt: license.expiresAt };
      const validated = await repository.touchLicenseValidation(license.id, new Date().toISOString());
      return {
        valid: true,
        status: "active",
        licenseId: validated.id,
        deploymentId: validated.deploymentId,
        tenantId: validated.tenantId,
        issuedAt: validated.issuedAt,
        expiresAt: validated.expiresAt,
        enabledModules: deployment.enabledModules,
        configVersion: deployment.configVersion,
        serverTime: new Date().toISOString()
      };
    },
    async authenticate(deploymentId, secret, { controlPlane = false } = {}) {
      const deployment = await repository.getDeployment(deploymentId, { includeSecret: true });
      if (!deployment || !deploymentSecretMatches(secret, deployment.deploymentSecretHash, masterSecret)) throw httpError(401, "地端部署凭证无效或已注销");
      if (!controlPlane) {
        if (!deployment.enabled || deployment.apiKeyStatus !== "active") throw httpError(401, "地端部署凭证无效或已注销");
        if (deployment.license.status !== "active") throw httpError(403, deployment.license.status === "expired" ? "许可证已过期" : "许可证无效或已注销");
      }
      await repository.markSeen(deployment.id, new Date().toISOString());
      return deployment;
    },
    config(deployment) {
      return {
        protocolVersion: 1,
        deploymentId: deployment.id,
        tenantId: deployment.tenantId,
        enabled: deployment.enabled,
        syncMode: "api_pull",
        pollIntervalSeconds: deployment.pollIntervalSeconds,
        enabledModules: deployment.enabledModules,
        configVersion: deployment.configVersion,
        license: { status: deployment.license.status, issuedAt: deployment.license.issuedAt, expiresAt: deployment.license.expiresAt }
      };
    },
    async requestSnapshot(id, { force = false, triggerType = "manual" } = {}) {
      const deployment = await repository.getDeployment(id);
      if (!deployment) throw httpError(404, "地端实例不存在");
      if (!deployment.enabled) throw httpError(409, "地端实例已停用");
      if (!snapshotJobs) throw httpError(503, "云端快照任务队列尚未就绪");
      const queued = await snapshotJobs.enqueue(id, { force, triggerType });
      return { deployment, ...queued };
    },
    async snapshotJob(id) {
      const job = await repository.getSnapshotJob(id);
      if (!job) throw httpError(404, "快照任务不存在");
      return job;
    },
    async buildSnapshot(id, { force = false, operationId } = {}) {
      const deployment = await repository.getDeployment(id, { includeSecret: true });
      if (!deployment) throw httpError(404, "地端实例不存在");
      if (!deployment.enabled) throw httpError(409, "地端实例已停用");
      if (operationId) {
        const operation = await repository.getSnapshotJob(operationId);
        const published = operation?.snapshotId ? await repository.publishedSnapshotById(operation.snapshotId) : null;
        if (published) return { deployment: await repository.getDeployment(id), snapshot: published, reused: Boolean(operation.reused) };
      }
      const tenant = await repository.getTenant(deployment.tenantId);
      const now = new Date();
      const snapshotId = identifier("SNAP");
      const current = await repository.latestSnapshot(id, { includeStorage: true });
      const rootSecret = decryptSecret(deployment.snapshotSecretEnc);
      const projectedResult = await projectTenantSnapshotWithWarnings(db, {
        tenant,
        deploymentId: id,
        version: Number(current?.version || 0) + 1,
        articleImagesDir,
        articleImagesDirs,
        loadPreviousSnapshot: current?.manifest ? async () => verifyAndDecryptSnapshot({
          manifest: current.manifest,
          content: await localStorage.readContent(current),
          rootSecret,
          expectedTenantId: tenant.id,
          expectedDeploymentId: id
        }) : undefined
      });
      const projected = projectedResult.snapshot;
      const warningMessage = projectedResult.warnings.length ? `部分发布：${projectedResult.warnings.join("；")}` : null;
      const sourceHash = snapshotSourceHash(projected);
      if (!force && current?.sourceHash === sourceHash) {
        if (operationId) await repository.linkSnapshotJobResult(operationId, current.id, true, new Date().toISOString());
        return { deployment: await repository.getDeployment(id), snapshot: current, reused: true, warningMessage };
      }
      const version = await repository.reserveSnapshot({ id: snapshotId, tenantId: tenant.id, deploymentId: id, createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 30 * 86400_000).toISOString() });
      const versionedProjection = projected.version === version ? projected : { ...projected, version };
      try {
        const { manifest, content } = await buildTenantSnapshot(db, { tenant, deploymentId: id, version, rootSecret, snapshot: versionedProjection });
        const local = await localStorage.put({ deploymentId: id, version, manifest, content });
        const remote = objectStorage ? await objectStorage.put({ deploymentId: id, version, manifest, content }) : null;
        const snapshot = await repository.publishSnapshot(snapshotId, { manifest, contentPath: local.contentPath, objectKey: remote?.objectKey || local.objectKey, sourceHash, sha256: manifest.sha256, sizeBytes: content.length }, { snapshotJobId: operationId });
        return { deployment: await repository.getDeployment(id), snapshot, reused: false, warningMessage };
      } catch (error) {
        await repository.failSnapshot(snapshotId);
        throw error;
      }
    },
    async status(id) {
      return { deployment: await this.getDeployment(id), latestSnapshot: await repository.latestSnapshot(id), latestSnapshotJob: await repository.latestSnapshotJob(id) };
    },
    async latestDescriptor(deployment) {
      const snapshot = await repository.latestSnapshot(deployment.id);
      if (!snapshot) throw httpError(503, "云端快照尚未生成，请稍后重试");
      return {
        mode: "api_pull", version: snapshot.version,
        manifestLocation: `/edge/v1/snapshots/${snapshot.version}/manifest`,
        contentLocation: `/edge/v1/snapshots/${snapshot.version}/content`
      };
    },
    async snapshot(deployment, version) {
      const snapshot = await repository.getSnapshot(deployment.id, version, { includeStorage: true });
      if (!snapshot) throw httpError(404, "快照不存在");
      if (snapshot.tenantId !== deployment.tenantId) throw httpError(403, "禁止访问其他租户快照");
      return snapshot;
    },
    async fileObject(deployment, id) {
      if (!readFileObject) throw httpError(500, "云端文件读取器未配置");
      const result = await readFileObject({ tenantId: deployment.tenantId, id });
      if (!result) throw httpError(404, "同步文件不存在");
      return result;
    },
    async reportSync(deployment, body) {
      let report;
      try { report = edgeSyncStatusReportV1Schema.parse(body); }
      catch { throw httpError(400, "同步状态数据格式不正确"); }
      if (report.deploymentId !== deployment.id || report.tenantId !== deployment.tenantId) throw httpError(403, "同步状态身份与部署凭证不匹配");
      return repository.touchDeployment(deployment.id, { status: report.status, message: report.message, version: report.appliedSnapshotVersion }, new Date().toISOString());
    }
  };
}
