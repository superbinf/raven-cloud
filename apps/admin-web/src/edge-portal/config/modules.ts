import { Code2, ExternalLink, FileKey, FileSearch, Globe2, Radar, ShieldCheck } from "lucide-react";
import type { IntelType, SensitiveCategory } from "@sentinel/shared";

export type ModuleTone = "pink" | "cyan" | "green" | "blue";
export type ModuleField = { label: string; value: string };
export type ModuleConfig = {
  path: string;
  parent: string;
  title: string;
  eyebrow: string;
  type: IntelType;
  subtype: string;
  tone: ModuleTone;
  icon: typeof FileKey;
  signalTitle: string;
  signalDescription: string;
  fields: ModuleField[];
  dimensions: string[];
};

export const moduleConfigs: ModuleConfig[] = [
  {
    path: "/portal/modules/dark-web/credential-leaks", parent: "暗网监测", title: "凭据泄露", eyebrow: "DARK WEB / CREDENTIAL LEAKS",
    type: "暗网情报", subtype: "凭据泄露", tone: "pink", icon: FileKey,
    signalTitle: "凭据暴露画像", signalDescription: "登录并通过授权后展示接口返回的原始账号和密码，仅供受控研判与接口调试。",
    fields: [{ label: "关注对象", value: "企业邮箱域 / SSO" }, { label: "展示字段", value: "账号、密码、URL、系统名称" }, { label: "风险重点", value: "ATO 关联与时效性" }],
    dimensions: ["邮箱域", "凭据类型", "来源论坛", "出现频次"]
  },
  {
    path: "/portal/modules/dark-web/intelligence", parent: "暗网监测", title: "暗网情报", eyebrow: "DARK WEB / INTELLIGENCE",
    type: "暗网情报", subtype: "暗网情报", tone: "pink", icon: Radar,
    signalTitle: "威胁主题、主体与证据", signalDescription: "按来源可信度、组织关联和事件时间线形成可追溯摘要，并为数据泄露事件提供证据预览。",
    fields: [{ label: "监测主题", value: "勒索、交易、供应链" }, { label: "关联维度", value: "主体、组织、事件" }, { label: "输出内容", value: "摘要、标签、时间线、证据" }],
    dimensions: ["威胁主体", "情报主题", "泄露组织", "来源可信度"]
  },
  {
    path: "/portal/modules/sensitive/account-password", parent: "敏感信息", title: "账号口令", eyebrow: "SENSITIVE DATA / ACCOUNT & PASSWORD",
    type: "敏感泄露", subtype: "账号口令", tone: "cyan", icon: ShieldCheck,
    signalTitle: "账号口令命中", signalDescription: "高敏字段在采集阶段完成遮罩，页面只呈现风险判断所需的最小信息。",
    fields: [{ label: "命中位置", value: "公开粘贴 / 业务配置" }, { label: "关联系统", value: "SSO、管理后台、API" }, { label: "处置动作", value: "通知、轮换、复测" }],
    dimensions: ["账号类型", "关联系统", "暴露位置", "处置状态"]
  },
  {
    path: "/portal/modules/sensitive/source-code", parent: "敏感信息", title: "源码泄露", eyebrow: "SENSITIVE DATA / SOURCE CODE",
    type: "敏感泄露", subtype: "源码泄露", tone: "cyan", icon: Code2,
    signalTitle: "仓库与代码风险", signalDescription: "关联仓库、提交和资产指纹，帮助分析员快速定位受影响的业务和供应商。",
    fields: [{ label: "监测范围", value: "GitHub / GitLab / 自建仓库" }, { label: "命中类型", value: "Access Key、Token、配置" }, { label: "关联对象", value: "仓库、分支、供应商" }],
    dimensions: ["仓库类型", "泄露字段", "提交时间", "供应链关联"]
  },
  {
    path: "/portal/modules/sensitive/documents", parent: "敏感信息", title: "文档泄露", eyebrow: "SENSITIVE DATA / DOCUMENTS",
    type: "敏感泄露", subtype: "文档泄露", tone: "cyan", icon: FileSearch,
    signalTitle: "文档内容与外泄范围", signalDescription: "展示文档类型、水印命中和页面状态，正文内容默认脱敏或不在前台展示。",
    fields: [{ label: "监测渠道", value: "网盘 / 文库 / CSDN" }, { label: "命中特征", value: "项目代号、水印、接口" }, { label: "页面状态", value: "公开、下架、待确认" }],
    dimensions: ["文档类型", "项目线", "发现渠道", "页面状态"]
  },
  {
    path: "/portal/modules/exposure/assets", parent: "互联网暴露面", title: "资产监测", eyebrow: "INTERNET EXPOSURE / ASSETS",
    type: "暴露面", subtype: "资产监测", tone: "green", icon: Globe2,
    signalTitle: "资产变化与指纹", signalDescription: "仅展示授权资产及变化结果，相关探测参数受访问策略控制。",
    fields: [{ label: "资产范围", value: "Web、IP、端口、域名" }, { label: "识别能力", value: "应用指纹、favicon、TLS" }, { label: "关注变化", value: "新增、下线、基线偏差" }],
    dimensions: ["资产类型", "IP / 端口", "应用指纹", "最近变化"]
  },
  {
    path: "/portal/modules/exposure/phishing", parent: "互联网暴露面", title: "仿冒网站", eyebrow: "INTERNET EXPOSURE / PHISHING",
    type: "仿冒网站", subtype: "仿冒网站", tone: "green", icon: ExternalLink,
    signalTitle: "仿冒域名与页面", signalDescription: "通过域名相似度、证书、DNS 和页面特征形成仿冒风险判断。",
    fields: [{ label: "发现来源", value: "证书透明度 / DNS" }, { label: "判断依据", value: "相似度、证书、页面指纹" }],
    dimensions: ["相似域名", "证书状态", "页面状态", "品牌关联"]
  }
];

export const sensitiveCategoryBySubtype: Record<string, SensitiveCategory> = {
  "账号口令": "account-password",
  "源码泄露": "source-code",
  "文档泄露": "documents",
  "仿冒网站": "phishing"
};
