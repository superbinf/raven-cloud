import { ChartNoAxesCombined, CircleGauge, Globe2, Radar, Search, ShieldAlert, ShieldCheck } from "lucide-react";
import type { EdgePortalModule } from "@sentinel/contracts";

export const portalModuleOptions: Array<{
  id: EdgePortalModule;
  label: string;
  description: string;
  icon: typeof CircleGauge;
}> = [
  { id: "overview", label: "态势总览", description: "情报指标、趋势与最新风险", icon: CircleGauge },
  { id: "dashboard", label: "态势大屏", description: "面向值守场景的可视化大屏", icon: ChartNoAxesCombined },
  { id: "search", label: "综合查询", description: "跨类型情报检索与详情", icon: Search },
  { id: "dark-web", label: "暗网监测", description: "凭据泄露、暗网情报与证据", icon: Radar },
  { id: "sensitive", label: "敏感信息", description: "账号口令、源码与文档泄露", icon: ShieldAlert },
  { id: "exposure", label: "互联网暴露面", description: "资产监测与仿冒网站", icon: Globe2 },
  { id: "vulnerabilities", label: "漏洞情报", description: "全量、重保与资产漏洞告警", icon: ShieldCheck }
];
