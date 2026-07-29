import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { Antenna, BadgeCheck, Box, Cloud, Code2, Database, Globe2, HardDrive, Layers3, Network, PhoneCall, ShieldCheck, Smartphone } from "lucide-react";
import {
  siAlibabacloud, siAngular, siApache, siApachetomcat, siBaidu, siCloudflare, siDocker, siHuawei, siJquery,
  siKubernetes, siMongodb, siMysql, siNginx, siPhp, siReact, siRedis, siSpring, siSpringboot, siSpringsecurity, siVuedotjs, siWordpress,
  siAntdesign, siBootstrap, siF5, siGooglecloud, siGrafana, siKibana, siLinux, siMinio, siNodedotjs, siNextdotjs, siNuxt, siPhpmyadmin, siPaloaltonetworks,
  siPrometheus, siPython, siUbuntu, siVite, siWebpack, siWechat, siCisco, siCitrix, siEclipsejetty, siFortinet, siJunipernetworks, siRedhat, siSplunk, siVmware, siAuthentik,
  siJavascript, siLua, siOpenjdk, type SimpleIcon
} from "simple-icons";
import aeFlag from "flag-icons/flags/4x3/ae.svg";
import cnFlag from "flag-icons/flags/4x3/cn.svg";
import jpFlag from "flag-icons/flags/4x3/jp.svg";
import mxFlag from "flag-icons/flags/4x3/mx.svg";
import saFlag from "flag-icons/flags/4x3/sa.svg";
import sgFlag from "flag-icons/flags/4x3/sg.svg";
import usFlag from "flag-icons/flags/4x3/us.svg";

type RegistryEntry<T> = { pattern: RegExp; value: T };
export type FingerprintIconEntry = { fingerprintName: string; aliases: string[]; iconUrl: string };

const FingerprintIconContext = createContext<Map<string, string>>(new Map());
const normalizeFingerprintIconKey = (value: string) => value.split("✚", 1)[0].trim().toLocaleLowerCase().replace(/[\s_-]+/g, "");

export function FingerprintIconProvider({ entries, children }: { entries: FingerprintIconEntry[]; children: ReactNode }) {
  const icons = useMemo(() => {
    const next = new Map<string, string>();
    entries.forEach((entry) => [entry.fingerprintName, ...entry.aliases].forEach((name) => next.set(normalizeFingerprintIconKey(name), entry.iconUrl)));
    return next;
  }, [entries]);
  return <FingerprintIconContext.Provider value={icons}>{children}</FingerprintIconContext.Provider>;
}

const technologyIconRegistry: Array<RegistryEntry<SimpleIcon>> = [
  { pattern: /nginx|openresty|tengine/i, value: siNginx },
  { pattern: /apache(?!.*tomcat)/i, value: siApache },
  { pattern: /tomcat/i, value: siApachetomcat },
  { pattern: /jetty/i, value: siEclipsejetty },
  { pattern: /citrix|netscaler/i, value: siCitrix },
  { pattern: /fortinet|深信服|天融信|vpn|安全产品/i, value: siFortinet },
  { pattern: /cisco|网络设备/i, value: siCisco },
  { pattern: /juniper/i, value: siJunipernetworks },
  { pattern: /vmware|vcloud/i, value: siVmware },
  { pattern: /splunk/i, value: siSplunk },
  { pattern: /reds*hat|redhat|红帽/i, value: siRedhat },
  { pattern: /authentik|派拉|sso|统一认证/i, value: siAuthentik },
  { pattern: /spring\s*boot|spring-boot/i, value: siSpringboot },
  { pattern: /spring\s*security/i, value: siSpringsecurity },
  { pattern: /spring/i, value: siSpring },
  { pattern: /react/i, value: siReact },
  { pattern: /vue/i, value: siVuedotjs },
  { pattern: /angular/i, value: siAngular },
  { pattern: /jquery/i, value: siJquery },
  { pattern: /\byui\b/i, value: siJavascript },
  { pattern: /\blua\b/i, value: siLua },
  { pattern: /\bjava\b|openjdk/i, value: siOpenjdk },
  { pattern: /apache\s*shiro|\bshiro\b/i, value: siApache },
  { pattern: /ant[-\s]?design|arco[-\s]?design/i, value: siAntdesign },
  { pattern: /bootstrap/i, value: siBootstrap },
  { pattern: /next\.js|nextjs/i, value: siNextdotjs },
  { pattern: /nuxt/i, value: siNuxt },
  { pattern: /vite/i, value: siVite },
  { pattern: /webpack/i, value: siWebpack },
  { pattern: /mysql/i, value: siMysql },
  { pattern: /redis/i, value: siRedis },
  { pattern: /mongo/i, value: siMongodb },
  { pattern: /cloudflare/i, value: siCloudflare },
  { pattern: /阿里云|alibaba\s*cloud/i, value: siAlibabacloud },
  { pattern: /华为云|huawei/i, value: siHuawei },
  { pattern: /百度|baidu/i, value: siBaidu },
  { pattern: /腾讯|wechat|微信/i, value: siWechat },
  { pattern: /google\s*cloud/i, value: siGooglecloud },
  { pattern: /prometheus/i, value: siPrometheus },
  { pattern: /腾讯|tencent|企业微信|微信|qq|cos|edgeone|vcloud/i, value: siWechat },
  { pattern: /grafana/i, value: siGrafana },
  { pattern: /kibana/i, value: siKibana },
  { pattern: /minio/i, value: siMinio },
  { pattern: /node\.js|nodejs/i, value: siNodedotjs },
  { pattern: /python|tornado|fast\s*http/i, value: siPython },
  { pattern: /ubuntu/i, value: siUbuntu },
  { pattern: /linux/i, value: siLinux },
  { pattern: /phpmyadmin/i, value: siPhpmyadmin },
  { pattern: /palo|globalprotect/i, value: siPaloaltonetworks },
  { pattern: /f5|big[-\s]?ip/i, value: siF5 },
  { pattern: /wordpress/i, value: siWordpress },
  { pattern: /php/i, value: siPhp },
  { pattern: /docker/i, value: siDocker },
  { pattern: /kubernetes|\bk8s\b/i, value: siKubernetes }
];

const organizationLogoRegistry: Array<RegistryEntry<string>> = [
  { pattern: /重庆长安汽车股份有限公司|重庆长安专用汽车有限公司/, value: "https://www.changan.com.cn/favicon.ico" },
  { pattern: /深蓝汽车科技有限公司/, value: "https://www.deepal.com.cn/favicon.ico" },
  { pattern: /江铃控股有限公司/, value: "https://www.jmc.com.cn/favicon.ico" },
  { pattern: /重庆铃耀汽车有限公司/, value: "https://www.lingyaoauto.com/favicon.ico" },
  { pattern: /重庆长安凯程汽车科技有限公司/, value: "https://www.landwind.com/favicon.ico" },
  { pattern: /重庆长安车联科技有限公司/, value: "https://www.changan.com.cn/favicon.ico" }
];

const countryFlagRegistry: Array<RegistryEntry<string>> = [
  { pattern: /中国|china/i, value: cnFlag },
  { pattern: /新加坡|singapore/i, value: sgFlag },
  { pattern: /墨西哥|mexico/i, value: mxFlag },
  { pattern: /美国|united states|\busa\b/i, value: usFlag },
  { pattern: /沙特阿拉伯|saudi arabia/i, value: saFlag },
  { pattern: /日本|japan/i, value: jpFlag },
  { pattern: /阿联酋|united arab emirates|\buae\b/i, value: aeFlag }
];

const providerBrandRegistry: Array<RegistryEntry<SimpleIcon>> = [
  { pattern: /阿里云|阿里巴巴|alibaba/i, value: siAlibabacloud },
  { pattern: /华为云|huawei/i, value: siHuawei },
  { pattern: /百度|baidu/i, value: siBaidu },
  { pattern: /腾讯|tencent/i, value: siWechat },
  { pattern: /cloudflare/i, value: siCloudflare }
];

function BrandSvg({ icon, label, className }: { icon: SimpleIcon; label: string; className: string }) {
  return <svg className={className} viewBox="0 0 24 24" role="img" aria-label={`${label}图标`} style={{ color: `#${icon.hex}` }}><path fill="currentColor" d={icon.path} /></svg>;
}

export function TechnologyGlyph({ name }: { name: string }) {
  const customIcon = useContext(FingerprintIconContext).get(normalizeFingerprintIconKey(name));
  if (customIcon) return <img className="html-tech-brand" src={customIcon} alt={`${name}图标`} />;
  const brand = technologyIconRegistry.find((entry) => entry.pattern.test(name))?.value;
  if (brand) return <BrandSvg className="html-tech-brand" icon={brand} label={brand.title} />;
  const normalized = name.toLowerCase();
  const FallbackIcon = /sql|database|redis|mongo|oracle/.test(normalized) ? HardDrive : /cloud|cdn|oss|cos/.test(normalized) ? Cloud : /vpn|waf|shiro|security|防火墙/.test(normalized) ? ShieldCheck : /js|java|lua|python|框架|framework/.test(normalized) ? Code2 : /server|web|http|tongweb|weblogic/.test(normalized) ? Network : /cms|组件|component/.test(normalized) ? Layers3 : Box;
  return <FallbackIcon className="html-tech-fallback" size={14} aria-hidden="true" />;
}

export function ProviderGlyph({ name }: { name: string }) {
  const customIcon = useContext(FingerprintIconContext).get(normalizeFingerprintIconKey(name));
  if (customIcon) return <img className="html-provider-icon" src={customIcon} alt="" aria-hidden="true" />;
  const providerTokens = name.split(/[\/|、,]+/).map((token) => token.trim()).filter(Boolean);
  if (providerTokens.length > 1) return <span className="html-provider-icon-list" aria-hidden="true">{providerTokens.slice(0, 4).map((token) => <ProviderGlyph key={token} name={token} />)}</span>;
  const brand = providerBrandRegistry.find((entry) => entry.pattern.test(name))?.value;
  if (brand) return <BrandSvg className="html-provider-icon" icon={brand} label={brand.title} />;
  const ProviderIcon = /移动/.test(name) ? Smartphone : /电信/.test(name) ? PhoneCall : /联通/.test(name) ? Globe2 : /铁通|通信|运营商/.test(name) ? Antenna : /cdn/i.test(name) ? Network : /云|数据中心|机房|idc/i.test(name) ? Cloud : /证书|ca-cert|ssl/i.test(name) ? BadgeCheck : Database;
  return <ProviderIcon className="html-provider-icon html-provider-fallback" size={14} aria-hidden="true" />;
}

export function CountryFlag({ country }: { country: string }) {
  const flag = countryFlagRegistry.find((entry) => entry.pattern.test(country))?.value;
  if (!flag) return <span className="html-country-fallback" aria-hidden="true"><Globe2 size={13} /></span>;
  return <img className="html-country-flag" src={flag} alt={`${country}国旗`} />;
}

export function OrganizationGlyph({ name }: { name: string }) {
  const logo = organizationLogoRegistry.find((entry) => entry.pattern.test(name))?.value;
  const [logoAvailable, setLogoAvailable] = useState(Boolean(logo));
  if (logo && logoAvailable) return <img className="html-organization-logo" src={logo} alt={`${name} Logo`} onError={() => setLogoAvailable(false)} />;
  const cleanName = name.replace(/[（(].*?[）)]/g, "").replace(/股份|有限|公司|集团|科技|汽车/g, "").replace(/^重庆/, "").trim();
  const initials = cleanName.slice(-2) || name.replace(/[（(].*?[）)]/g, "").trim().slice(0, 2) || "企";
  return <span className="html-organization-monogram" aria-hidden="true">{initials}</span>;
}
