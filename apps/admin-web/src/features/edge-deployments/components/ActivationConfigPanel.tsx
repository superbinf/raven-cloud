import { Check, Copy, Download, KeyRound } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/common";
import type { EdgeActivationConfig, EdgeCredentialDelivery } from "../model/types";
import styles from "../edgeDeployments.module.css";

function downloadConfig(config: EdgeCredentialDelivery) {
  const blob = new Blob([`${JSON.stringify(config, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "sentinel-edge-credentials.json";
  anchor.click();
  URL.revokeObjectURL(url);
}

export function ActivationConfigPanel({ config }: { config: EdgeActivationConfig }) {
  const apiKey = "apiKey" in config ? config.apiKey : config.deploymentSecret;
  return <CredentialDeliveryPanel delivery={{ cloudBaseUrl: config.cloudBaseUrl, apiKey }} />;
}

export function CredentialDeliveryPanel({ delivery }: { delivery: EdgeCredentialDelivery }) {
  const [copied, setCopied] = useState<"apiKey" | "licenseKey" | null>(null);
  const copyCredential = async (type: "apiKey" | "licenseKey", value: string) => {
    await navigator.clipboard.writeText(value);
    setCopied(type);
    window.setTimeout(() => setCopied(null), 1800);
  };
  return <div className={styles.activationPanel}><span><KeyRound size={22} /></span><div><strong>新凭证只显示这一次</strong><p>首次部署先在地端输入许可证；校验通过后，再配置 OpenAPI Key。请通过受控渠道交付。</p><label>云端地址<code>{delivery.cloudBaseUrl}</code></label>{delivery.licenseKey && <label>许可证<code>{delivery.licenseKey}</code>{delivery.licenseExpiresAt && <small>有效期至 {new Date(delivery.licenseExpiresAt).toLocaleString("zh-CN", { hour12: false })}</small>}</label>}{delivery.apiKey && <label>OpenAPI Key<code>{delivery.apiKey}</code></label>}<div className={styles.activationActions}>{delivery.licenseKey && <Button variant="secondary" onClick={() => void copyCredential("licenseKey", delivery.licenseKey!)}>{copied === "licenseKey" ? <Check size={16} /> : <Copy size={16} />}{copied === "licenseKey" ? "已复制许可证" : "复制许可证"}</Button>}{delivery.apiKey && <Button variant="secondary" onClick={() => void copyCredential("apiKey", delivery.apiKey!)}>{copied === "apiKey" ? <Check size={16} /> : <Copy size={16} />}{copied === "apiKey" ? "已复制 API Key" : "复制 API Key"}</Button>}<Button onClick={() => downloadConfig(delivery)}><Download size={16} />下载配置</Button></div></div></div>;
}
