import { useCallback, useEffect, useState } from "react";
import { createEdgeDeployment, deleteEdgeDeployment, generateEdgeApiKey, getEdgeDeploymentStatus, issueEdgeLicense, listEdgeDeployments, listEdgeTenants, publishEdgeSnapshot, revokeEdgeApiKey, revokeEdgeLicense, rotateEdgeActivation, updateEdgeApiKey, updateEdgeLicense, updateEdgeDeployment } from "../api/edgeDeploymentsApi";
import type { EdgeActivationConfig, EdgeCredentialDelivery, EdgeDeployment, EdgeDeploymentInput, EdgeDeploymentStatus, EdgeTenant } from "../model/types";
import { useAdminInitialLoading } from "@/hooks/useAdminInitialLoading";

export function useEdgeDeployments() {
  const [deployments, setDeployments] = useState<EdgeDeployment[]>([]);
  const [tenants, setTenants] = useState<EdgeTenant[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [activationConfig, setActivationConfig] = useState<EdgeActivationConfig | null>(null);
  const [credentialDelivery, setCredentialDelivery] = useState<EdgeCredentialDelivery | null>(null);
  const [statuses, setStatuses] = useState<Record<string, EdgeDeploymentStatus>>({});
  useAdminInitialLoading("edge-deployments", loading);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const [deploymentItems, tenantItems] = await Promise.all([listEdgeDeployments(), listEdgeTenants()]);
      setDeployments(deploymentItems);
      setTenants(tenantItems);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "地端部署数据加载失败");
      throw error;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load().catch(() => undefined); }, [load]);

  const replace = (deployment: EdgeDeployment) => setDeployments((items) => items.map((item) => item.id === deployment.id ? deployment : item));

  const save = async (input: EdgeDeploymentInput, current?: EdgeDeployment | null) => {
    setBusyId(current?.id ?? "create");
    try {
      if (current) {
        const deployment = await updateEdgeDeployment(current.id, input);
        replace(deployment);
        return deployment;
      }
      const result = await createEdgeDeployment(input);
      setDeployments((items) => [result.deployment, ...items]);
      setActivationConfig(result.activationConfig);
      setCredentialDelivery({ cloudBaseUrl: result.activationConfig.cloudBaseUrl, apiKey: "apiKey" in result.activationConfig ? result.activationConfig.apiKey : result.activationConfig.deploymentSecret, licenseKey: result.license?.licenseKey, licenseExpiresAt: result.license?.expiresAt });
      return result.deployment;
    } finally {
      setBusyId(null);
    }
  };

  const toggle = async (deployment: EdgeDeployment) => {
    setBusyId(deployment.id);
    try {
      const saved = await updateEdgeDeployment(deployment.id, { enabled: !deployment.enabled });
      replace(saved);
      return saved;
    } finally {
      setBusyId(null);
    }
  };

  const rotate = async (deployment: EdgeDeployment) => {
    setBusyId(deployment.id);
    try {
      const result = await rotateEdgeActivation(deployment.id);
      replace(result.deployment);
      setActivationConfig(result.activationConfig);
    } finally {
      setBusyId(null);
    }
  };

  const generateKey = async (deployment: EdgeDeployment) => {
    setBusyId(deployment.id); try { const result = await generateEdgeApiKey(deployment.id); replace(result.deployment); setCredentialDelivery({ cloudBaseUrl: result.activationConfig.cloudBaseUrl, apiKey: "apiKey" in result.activationConfig ? result.activationConfig.apiKey : result.activationConfig.deploymentSecret }); return result; } finally { setBusyId(null); }
  };
  const updateKey = async (deployment: EdgeDeployment) => {
    setBusyId(deployment.id); try { const result = await updateEdgeApiKey(deployment.id); replace(result.deployment); setCredentialDelivery({ cloudBaseUrl: result.activationConfig.cloudBaseUrl, apiKey: "apiKey" in result.activationConfig ? result.activationConfig.apiKey : result.activationConfig.deploymentSecret }); return result; } finally { setBusyId(null); }
  };
  const revokeKey = async (deployment: EdgeDeployment) => { setBusyId(deployment.id); try { const result = await revokeEdgeApiKey(deployment.id); replace(result.deployment); return result; } finally { setBusyId(null); } };
  const issueLicense = async (deployment: EdgeDeployment, expiresAt: string) => { setBusyId(deployment.id); try { const result = await issueEdgeLicense(deployment.id, expiresAt); replace(result.deployment); setCredentialDelivery({ cloudBaseUrl: result.license.cloudBaseUrl, licenseKey: result.license.licenseKey, licenseExpiresAt: result.license.expiresAt }); return result; } finally { setBusyId(null); } };
  const updateLicense = async (deployment: EdgeDeployment, expiresAt: string) => { setBusyId(deployment.id); try { const result = await updateEdgeLicense(deployment.id, expiresAt); replace(result.deployment); return result; } finally { setBusyId(null); } };
  const revokeLicense = async (deployment: EdgeDeployment) => { setBusyId(deployment.id); try { const result = await revokeEdgeLicense(deployment.id); replace(result.deployment); return result; } finally { setBusyId(null); } };

  const publish = async (deployment: EdgeDeployment) => {
    setBusyId(deployment.id);
    try {
      const result = await publishEdgeSnapshot(deployment.id);
      replace(result.deployment);
      setStatuses((items) => ({
        ...items,
        [deployment.id]: {
          deployment: result.deployment,
          latestSnapshot: items[deployment.id]?.latestSnapshot ?? null,
          latestSnapshotJob: result.job
        }
      }));
      return result.job;
    } finally {
      setBusyId(null);
    }
  };

  const refreshStatus = async (deployment: EdgeDeployment): Promise<EdgeDeploymentStatus> => {
    setBusyId(deployment.id);
    try {
      const result = await getEdgeDeploymentStatus(deployment.id);
      replace(result.deployment);
      setStatuses((items) => ({ ...items, [deployment.id]: result }));
      return result;
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (deployment: EdgeDeployment) => {
    setBusyId(deployment.id);
    try {
      const result = await deleteEdgeDeployment(deployment.id);
      setDeployments((items) => items.filter((item) => item.id !== deployment.id));
      setStatuses((items) => { const next = { ...items }; delete next[deployment.id]; return next; });
      return result;
    } finally {
      setBusyId(null);
    }
  };

  return { deployments, tenants, statuses, loading, loadError, busyId, activationConfig, setActivationConfig, credentialDelivery, setCredentialDelivery, load, save, toggle, rotate, generateKey, updateKey, revokeKey, issueLicense, updateLicense, revokeLicense, publish, refreshStatus, remove };
}
