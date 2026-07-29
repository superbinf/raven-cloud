import { EDGE_PORTAL_MODULES } from "@sentinel/contracts";

function tenantDto(row) {
  return row && {
    id: row.id,
    name: row.name,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    counts: {
      targets: Number(row.target_count || 0),
      connections: Number(row.connection_count || 0),
      deployments: Number(row.deployment_count || 0),
      fingerprintGroups: Number(row.fingerprint_group_count || 0)
    }
  };
}

function deploymentDto(row) {
  if (!row) return null;
  const licenseStatus = !row.license_id ? "unissued" : row.license_status === "revoked" ? "revoked" : Date.parse(row.license_expires_at) <= Date.now() ? "expired" : "active";
  return {
    id: row.id,
    tenantId: row.tenant_id,
    tenantName: row.tenant_name,
    name: row.name,
    enabled: Boolean(row.enabled),
    syncMode: row.sync_mode,
    pollIntervalSeconds: row.poll_interval_seconds,
    enabledModules: (() => {
      try {
        const value = typeof row.enabled_modules_json === "string" ? JSON.parse(row.enabled_modules_json) : row.enabled_modules_json;
        return Array.isArray(value) && value.length ? EDGE_PORTAL_MODULES.filter((module) => value.includes(module)) : [...EDGE_PORTAL_MODULES];
      } catch { return [...EDGE_PORTAL_MODULES]; }
    })(),
    configVersion: row.config_version,
    apiKeyStatus: row.api_key_status || "active",
    apiKeyVersion: Number(row.api_key_version || 1),
    apiKeyLastRotatedAt: row.api_key_last_rotated_at || row.created_at,
    license: row.license_id ? { id: row.license_id, status: licenseStatus, issuedAt: row.license_issued_at, expiresAt: row.license_expires_at, lastValidatedAt: row.license_last_validated_at, updatedAt: row.license_updated_at } : { id: null, status: "unissued", issuedAt: null, expiresAt: null, lastValidatedAt: null, updatedAt: null },
    lastSeenAt: row.last_seen_at,
    lastAppliedSnapshotVersion: row.last_applied_snapshot_version,
    lastSyncStatus: row.last_sync_status,
    lastSyncMessage: row.last_sync_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function licenseDto(row) {
  if (!row) return null;
  const status = row.status === "revoked" ? "revoked" : Date.parse(row.expires_at) <= Date.now() ? "expired" : "active";
  return { id: row.id, deploymentId: row.deployment_id, tenantId: row.tenant_id, status, issuedAt: row.issued_at, expiresAt: row.expires_at, lastValidatedAt: row.last_validated_at, updatedAt: row.updated_at };
}

function snapshotDto(row) {
  return row && {
    id: row.id,
    tenantId: row.tenant_id,
    deploymentId: row.deployment_id,
    version: row.version,
    status: row.status,
    manifest: row.manifest_json ? JSON.parse(row.manifest_json) : null,
    sha256: row.sha256,
    sourceHash: row.source_hash,
    sizeBytes: row.size_bytes,
    createdAt: row.created_at,
    expiresAt: row.expires_at
  };
}

function snapshotJobDto(row) {
  return row && {
    id: row.id,
    deploymentId: row.deployment_id,
    force: Boolean(row.force_build),
    triggerType: row.trigger_type,
    status: row.status,
    bullmqJobId: row.bullmq_job_id,
    snapshotId: row.snapshot_id,
    reused: row.reused === null ? null : Boolean(row.reused),
    attempts: Number(row.attempts || 0),
    errorMessage: !row.error_message
      ? null
      : row.status === "succeeded"
        ? "快照已生成，但部分数据未能处理"
        : "快照生成失败，请稍后重试",
    requestedAt: row.requested_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    updatedAt: row.updated_at
  };
}

const deploymentSelect = `SELECT edge_deployments.*, tenants.name AS tenant_name,
  edge_licenses.id AS license_id,edge_licenses.status AS license_status,edge_licenses.issued_at AS license_issued_at,
  edge_licenses.expires_at AS license_expires_at,edge_licenses.last_validated_at AS license_last_validated_at,edge_licenses.updated_at AS license_updated_at
  FROM edge_deployments JOIN tenants ON tenants.id=edge_deployments.tenant_id
  LEFT JOIN edge_licenses ON edge_licenses.deployment_id=edge_deployments.id`;

export function createCloudEdgeRepository(db) {
  return {
    async listTenants() {
      return (await db.prepare(`SELECT tenants.*,
        (SELECT COUNT(*) FROM monitoring_targets WHERE tenant_id=tenants.id) AS target_count,
        (SELECT COUNT(*) FROM api_connections WHERE tenant_id=tenants.id) AS connection_count,
        (SELECT COUNT(*) FROM edge_deployments WHERE tenant_id=tenants.id) AS deployment_count,
        (SELECT COUNT(*) FROM fingerprint_watch_groups WHERE tenant_id=tenants.id) AS fingerprint_group_count
        FROM tenants ORDER BY tenants.created_at,tenants.id`).all()).map(tenantDto);
    },
    async getTenant(id) {
      return tenantDto(await db.prepare("SELECT * FROM tenants WHERE id=?").get(id));
    },
    async createTenant(row) {
      await db.prepare("INSERT INTO tenants (id,name,status,created_at,updated_at) VALUES (?,?,?,?,?)")
        .run(row.id, row.name, row.status, row.createdAt, row.updatedAt);
      return this.getTenant(row.id);
    },
    async updateTenant(id, patch) {
      await db.prepare("UPDATE tenants SET name=?,status=?,updated_at=? WHERE id=?")
        .run(patch.name, patch.status, patch.updatedAt, id);
      return this.getTenant(id);
    },
    async tenantUsage(id) {
      const row = await db.prepare(`SELECT
        (SELECT COUNT(*) FROM monitoring_targets WHERE tenant_id=?) AS targets,
        (SELECT COUNT(*) FROM api_connections WHERE tenant_id=?) AS connections,
        (SELECT COUNT(*) FROM credential_subscriptions WHERE tenant_id=?) AS credential_subscriptions,
        (SELECT COUNT(*) FROM ingestion_batches WHERE tenant_id=?) AS ingestion_batches,
        (SELECT COUNT(*) FROM sensitive_records WHERE tenant_id=?) AS sensitive_records,
        (SELECT COUNT(*) FROM asset_records WHERE tenant_id=?) AS asset_records,
        (SELECT COUNT(*) FROM asset_reports WHERE tenant_id=?) AS asset_reports,
        (SELECT COUNT(*) FROM dark_web_events WHERE tenant_id=?) AS dark_web_events,
        (SELECT COUNT(*) FROM vulnerability_records WHERE tenant_id=?) AS vulnerability_records,
        (SELECT COUNT(*) FROM vulnerability_alerts WHERE tenant_id=?) AS vulnerability_alerts,
        (SELECT COUNT(*) FROM vulnerability_suppressions WHERE tenant_id=?) AS vulnerability_suppressions,
        (SELECT COUNT(*) FROM edge_deployments WHERE tenant_id=?) AS deployments,
        (SELECT COUNT(*) FROM edge_snapshots WHERE tenant_id=?) AS snapshots,
        (SELECT COUNT(*) FROM edge_licenses WHERE tenant_id=?) AS licenses,
        (SELECT COUNT(*) FROM fingerprint_watch_groups WHERE tenant_id=? AND is_default=FALSE) AS custom_fingerprint_groups`)
        .get(...Array(15).fill(id));
      return Object.fromEntries(Object.entries(row || {}).map(([key, value]) => [key, Number(value || 0)]));
    },
    async deleteEmptyTenant(id) {
      return db.transaction(async () => {
        await db.prepare("DELETE FROM fingerprint_watch_groups WHERE tenant_id=? AND is_default=TRUE").run(id);
        const result = await db.prepare("DELETE FROM tenants WHERE id=?").run(id);
        return result.changes > 0;
      });
    },
    async listDeployments() {
      return (await db.prepare(`${deploymentSelect} ORDER BY edge_deployments.created_at DESC`).all()).map(deploymentDto);
    },
    async getDeployment(id, { includeSecret = false } = {}) {
      const row = await db.prepare(`${deploymentSelect} WHERE edge_deployments.id=?`).get(id);
      if (!row) return null;
      return includeSecret ? {
        ...deploymentDto(row),
        deploymentSecretHash: row.deployment_secret_hash,
        deploymentSecretEnc: row.deployment_secret_enc,
        snapshotSecretEnc: row.snapshot_secret_enc
      } : deploymentDto(row);
    },
    async createDeployment(row) {
      await db.prepare(`INSERT INTO edge_deployments
        (id,tenant_id,name,enabled,sync_mode,poll_interval_seconds,enabled_modules_json,config_version,deployment_secret_hash,deployment_secret_enc,snapshot_secret_enc,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(row.id, row.tenantId, row.name, row.enabled ? 1 : 0, row.syncMode, row.pollIntervalSeconds, JSON.stringify(row.enabledModules), 1, row.deploymentSecretHash, row.deploymentSecretEnc, row.snapshotSecretEnc, row.createdAt, row.updatedAt);
      return this.getDeployment(row.id);
    },
    async updateDeployment(id, patch) {
      await db.prepare(`UPDATE edge_deployments SET name=?,enabled=?,sync_mode=?,poll_interval_seconds=?,enabled_modules_json=?,config_version=config_version+1,updated_at=? WHERE id=?`)
        .run(patch.name, patch.enabled ? 1 : 0, patch.syncMode, patch.pollIntervalSeconds, JSON.stringify(patch.enabledModules), patch.updatedAt, id);
      return this.getDeployment(id);
    },
    async deleteDeployment(id) {
      const result = await db.prepare("DELETE FROM edge_deployments WHERE id=?").run(id);
      return result.changes > 0;
    },
    async rotateDeploymentSecret(id, secretHash, secretEnc, updatedAt) {
      await db.prepare(`UPDATE edge_deployments SET deployment_secret_hash=?,deployment_secret_enc=?,api_key_status='active',api_key_version=api_key_version+1,api_key_last_rotated_at=?,config_version=config_version+1,updated_at=? WHERE id=?`)
        .run(secretHash, secretEnc, updatedAt, updatedAt, id);
      return this.getDeployment(id);
    },
    async revokeDeploymentSecret(id, updatedAt) {
      await db.prepare("UPDATE edge_deployments SET api_key_status='revoked',config_version=config_version+1,updated_at=? WHERE id=?").run(updatedAt, id);
      return this.getDeployment(id);
    },
    async issueLicense(row) {
      await db.prepare(`INSERT INTO edge_licenses(id,deployment_id,tenant_id,license_secret_hash,status,issued_at,expires_at,last_validated_at,updated_at)
        VALUES (?,?,?,?, 'active',?,?,NULL,?)
        ON CONFLICT(deployment_id) DO UPDATE SET id=EXCLUDED.id,tenant_id=EXCLUDED.tenant_id,license_secret_hash=EXCLUDED.license_secret_hash,status='active',issued_at=EXCLUDED.issued_at,expires_at=EXCLUDED.expires_at,last_validated_at=NULL,updated_at=EXCLUDED.updated_at`)
        .run(row.id, row.deploymentId, row.tenantId, row.licenseSecretHash, row.issuedAt, row.expiresAt, row.updatedAt);
      return this.getLicenseByDeployment(row.deploymentId);
    },
    async updateLicense(deploymentId, expiresAt, updatedAt) {
      await db.prepare("UPDATE edge_licenses SET status='active',expires_at=?,updated_at=? WHERE deployment_id=?").run(expiresAt, updatedAt, deploymentId);
      return this.getLicenseByDeployment(deploymentId);
    },
    async revokeLicense(deploymentId, updatedAt) {
      await db.prepare("UPDATE edge_licenses SET status='revoked',updated_at=? WHERE deployment_id=?").run(updatedAt, deploymentId);
      return this.getLicenseByDeployment(deploymentId);
    },
    async getLicenseByDeployment(deploymentId, { includeSecret = false } = {}) {
      const row = await db.prepare("SELECT * FROM edge_licenses WHERE deployment_id=?").get(deploymentId);
      if (!row) return null;
      return includeSecret ? { ...licenseDto(row), licenseSecretHash: row.license_secret_hash } : licenseDto(row);
    },
    async getLicenseById(id, { includeSecret = false } = {}) {
      const row = await db.prepare("SELECT * FROM edge_licenses WHERE id=?").get(id);
      if (!row) return null;
      return includeSecret ? { ...licenseDto(row), licenseSecretHash: row.license_secret_hash } : licenseDto(row);
    },
    async touchLicenseValidation(id, validatedAt) {
      await db.prepare("UPDATE edge_licenses SET last_validated_at=?,updated_at=? WHERE id=?").run(validatedAt, validatedAt, id);
      return licenseDto(await db.prepare("SELECT * FROM edge_licenses WHERE id=?").get(id));
    },
    async touchDeployment(id, report, now) {
      await db.prepare(`UPDATE edge_deployments SET last_seen_at=?,last_applied_snapshot_version=COALESCE(?,last_applied_snapshot_version),last_sync_status=?,last_sync_message=?,updated_at=? WHERE id=?`)
        .run(now, report.version ?? null, report.status, report.message || null, now, id);
      return this.getDeployment(id);
    },
    async markSeen(id, now) {
      await db.prepare("UPDATE edge_deployments SET last_seen_at=? WHERE id=?").run(now, id);
    },
    async reserveSnapshot(row) {
      return db.transaction(async () => {
        await db.prepare("SELECT id FROM edge_deployments WHERE id=? FOR UPDATE").get(row.deploymentId);
        const next = await db.prepare("SELECT COALESCE(MAX(version),0)+1 AS version FROM edge_snapshots WHERE deployment_id=?").get(row.deploymentId);
        const version = Number(next.version);
        await db.prepare(`INSERT INTO edge_snapshots (id,tenant_id,deployment_id,version,status,created_at,expires_at) VALUES (?,?,?,?,?,?,?)`)
          .run(row.id, row.tenantId, row.deploymentId, version, "building", row.createdAt, row.expiresAt || null);
        return version;
      });
    },
    async publishSnapshot(id, values, { snapshotJobId } = {}) {
      return db.transaction(async () => {
        await db.prepare(`UPDATE edge_snapshots SET status='published',manifest_json=?,content_path=?,object_key=?,source_hash=?,sha256=?,size_bytes=? WHERE id=?`)
          .run(JSON.stringify(values.manifest), values.contentPath, values.objectKey || null, values.sourceHash, values.sha256, values.sizeBytes, id);
        if (snapshotJobId) {
          await db.prepare("UPDATE edge_snapshot_jobs SET snapshot_id=?,reused=0,updated_at=? WHERE id=?")
            .run(id, new Date().toISOString(), snapshotJobId);
        }
        return snapshotDto(await db.prepare("SELECT * FROM edge_snapshots WHERE id=?").get(id));
      });
    },
    async failSnapshot(id) {
      await db.prepare("UPDATE edge_snapshots SET status='failed' WHERE id=?").run(id);
    },
    async latestSnapshot(deploymentId, { includeStorage = false } = {}) {
      const row = await db.prepare("SELECT * FROM edge_snapshots WHERE deployment_id=? AND status='published' ORDER BY version DESC LIMIT 1").get(deploymentId);
      if (!row) return null;
      return includeStorage ? { ...snapshotDto(row), contentPath: row.content_path, objectKey: row.object_key } : snapshotDto(row);
    },
    async getSnapshot(deploymentId, version, { includeStorage = false } = {}) {
      const row = await db.prepare("SELECT * FROM edge_snapshots WHERE deployment_id=? AND version=? AND status='published'").get(deploymentId, version);
      if (!row) return null;
      return includeStorage ? { ...snapshotDto(row), contentPath: row.content_path, objectKey: row.object_key } : snapshotDto(row);
    },
    async publishedSnapshotById(id) {
      return snapshotDto(await db.prepare("SELECT * FROM edge_snapshots WHERE id=? AND status='published'").get(id));
    },
    async listSnapshotStorage(deploymentId) {
      return (await db.prepare("SELECT * FROM edge_snapshots WHERE deployment_id=? ORDER BY version").all(deploymentId))
        .map((row) => ({ ...snapshotDto(row), contentPath: row.content_path, objectKey: row.object_key }));
    },
    async listDueSnapshotDeploymentIds(now) {
      return (await db.prepare(`SELECT deployments.id
        FROM edge_deployments deployments
        LEFT JOIN LATERAL (
          SELECT requested_at FROM edge_snapshot_jobs
          WHERE deployment_id=deployments.id
          ORDER BY requested_at DESC LIMIT 1
        ) latest_job ON TRUE
        WHERE deployments.enabled=1 AND (
          latest_job.requested_at IS NULL OR
          latest_job.requested_at::timestamptz<=?::timestamptz-(deployments.poll_interval_seconds*INTERVAL '1 second')
        )
        ORDER BY deployments.id`).all(now)).map((row) => row.id);
    },
    async createSnapshotJob(row) {
      await db.prepare(`INSERT INTO edge_snapshot_jobs
        (id,deployment_id,force_build,trigger_type,status,requested_at,updated_at)
        VALUES (?,?,?,?,?,?,?)`)
        .run(row.id, row.deploymentId, row.force ? 1 : 0, row.triggerType, "queued", row.requestedAt, row.requestedAt);
      return this.getSnapshotJob(row.id);
    },
    async getSnapshotJob(id) {
      return snapshotJobDto(await db.prepare("SELECT * FROM edge_snapshot_jobs WHERE id=?").get(id));
    },
    async activeSnapshotJob(deploymentId) {
      return snapshotJobDto(await db.prepare(`SELECT * FROM edge_snapshot_jobs
        WHERE deployment_id=? AND status IN ('queued','running','retrying')
        ORDER BY requested_at DESC LIMIT 1`).get(deploymentId));
    },
    async latestSnapshotJob(deploymentId) {
      return snapshotJobDto(await db.prepare("SELECT * FROM edge_snapshot_jobs WHERE deployment_id=? ORDER BY requested_at DESC LIMIT 1").get(deploymentId));
    },
    async forceSnapshotJob(id, now) {
      await db.prepare("UPDATE edge_snapshot_jobs SET force_build=1,updated_at=? WHERE id=? AND status IN ('queued','running','retrying')").run(now, id);
      return this.getSnapshotJob(id);
    },
    async attachBullmqJob(id, bullmqJobId, now) {
      await db.prepare("UPDATE edge_snapshot_jobs SET bullmq_job_id=?,updated_at=? WHERE id=?").run(String(bullmqJobId), now, id);
      return this.getSnapshotJob(id);
    },
    async linkSnapshotJobResult(id, snapshotId, reused, now) {
      await db.prepare("UPDATE edge_snapshot_jobs SET snapshot_id=?,reused=?,updated_at=? WHERE id=?")
        .run(snapshotId, reused ? 1 : 0, now, id);
      return this.getSnapshotJob(id);
    },
    async startSnapshotJob(id, attempts, now) {
      await db.prepare(`UPDATE edge_snapshot_jobs
        SET status='running',attempts=?,started_at=COALESCE(started_at,?),error_message=NULL,updated_at=?
        WHERE id=?`).run(attempts, now, now, id);
      return this.getSnapshotJob(id);
    },
    async retrySnapshotJob(id, attempts, message, now) {
      await db.prepare(`UPDATE edge_snapshot_jobs
        SET status='retrying',attempts=?,error_message=?,updated_at=? WHERE id=?`)
        .run(attempts, message, now, id);
      return this.getSnapshotJob(id);
    },
    async failSnapshotJob(id, attempts, message, now) {
      await db.prepare(`UPDATE edge_snapshot_jobs
        SET status='failed',attempts=?,error_message=?,finished_at=?,updated_at=? WHERE id=?`)
        .run(attempts, message, now, now, id);
      return this.getSnapshotJob(id);
    },
    async completeSnapshotJob(id, result, attempts, now) {
      await db.prepare(`UPDATE edge_snapshot_jobs
        SET status='succeeded',snapshot_id=?,reused=?,attempts=?,error_message=?,finished_at=?,updated_at=? WHERE id=?`)
        .run(result.snapshot.id, result.reused ? 1 : 0, attempts, result.warningMessage || null, now, now, id);
      return this.getSnapshotJob(id);
    }
  };
}
