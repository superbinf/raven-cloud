import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { assertSafeSvgIcon, isSvgIconContent } from "@sentinel/transport-security";

const maxIconBytes = 256 * 1024;

export const domesticFingerprintIconCatalog = [
  { key: "weaver", name: "泛微协同办公", url: "https://www.weaver.com.cn/img/favicon.ico", aliases: ["泛微", "泛微OA", "Weaver", "Weaver OA", "Ecology", "泛微Ecology", "泛微Ecology-v9", "e-cology", "e-cology 9", "泛微 e-Mobile 移动管理平台", "e-Mobile", "泛微云桥 e-Bridge OA", "e-Bridge"] },
  { key: "seeyon", name: "致远协同办公", url: "https://www.seeyon.com/favicon.ico", aliases: ["致远", "致远OA", "致远互联", "Seeyon", "Seeyon OA", "致远A8", "致远A6", "致远M3"] },
  { key: "yonyou", name: "用友", url: "https://www.yonyou.com/assets/images/version26/logo.png", aliases: ["用友软件", "用友ERP", "Yonyou", "用友NC", "NC Cloud", "用友U8", "用友U9", "YonBIP", "YonSuite"] },
  { key: "kingdee", name: "金蝶", url: "https://www.kingdee.com/r/cms/www/default/v0.1/images/favicon.ico", aliases: ["Kingdee", "金蝶云", "金蝶云星瀚ierp", "金蝶星瀚", "金蝶苍穹", "金蝶EAS", "金蝶K3", "金蝶K/3"] },
  { key: "landray", name: "蓝凌协同办公", url: "https://www.landray.com.cn/favicon.ico?1", aliases: ["蓝凌", "蓝凌OA", "Landray", "蓝凌EKP", "蓝凌MK", "蓝凌数字办公"] },
  { key: "fanruan", name: "帆软", url: "https://src.fanruan.com/website/finereport/logo-fanruan.png", aliases: ["FanRuan", "FineReport", "帆软FineReport", "FineBI", "帆软FineBI", "FineVis"] },
  { key: "dameng", name: "达梦数据库", url: "https://www.dameng.com/static/cn/images/favicon.ico", aliases: ["达梦", "Dameng", "DM Database", "DM8", "达梦DM8"] },
  { key: "kingbase", name: "人大金仓", url: "https://www.kingbase.com.cn/static/cn/img/favicon.ico", aliases: ["Kingbase", "KingbaseES", "金仓数据库", "人大金仓数据库"] },
  { key: "gbase", name: "南大通用", url: "https://g2.cdn.gbase.cn/static_assets/website/favicon/favicon-32x32.png", aliases: ["GBase", "南大通用GBase", "GBase 8a", "GBase 8s"] },
  { key: "shentong", name: "神通数据库", url: "https://shentongdata.com/template/default/index/images/logo_index.png", aliases: ["神通", "ShenTong", "Oscar", "神通OSCAR数据库"] },
  { key: "primeton", name: "普元", url: "https://www.primeton.com/images/favicon.ico", aliases: ["Primeton", "普元EOS", "Primeton EOS", "普元数字化中台"] },
  { key: "bes", name: "宝兰德", url: "https://www.bessystem.com/favicon.ico", aliases: ["BES", "BES Application Server", "宝兰德应用服务器", "宝兰德BES"] },
  { key: "tongda", name: "通达OA", url: "https://www.tongda2000.com/favicon.png", aliases: ["通达", "通达OA系统", "Tongda OA", "Office Anywhere"] },
  { key: "whir", name: "万户OA", url: "https://www.whir.net/cn/images/ico/favicon.ico", aliases: ["万户", "万户网络", "万户ezOFFICE", "ezOFFICE"] },
  { key: "sangfor", name: "深信服", url: "https://download.sangfor.com.cn/5d0c9eaab18e4429a6344b2c7e860994.png", aliases: ["Sangfor", "深信服 SSLVPN", "深信服SSL VPN", "深信服零信任aTrust", "aTrust", "Sangfor SSL VPN"] },
  { key: "h3c", name: "新华三", url: "https://www.h3c.com/favicon.ico", aliases: ["H3C", "新华三H3C", "H3C安全产品管理平台", "H3C SecPath"] },
  { key: "dbappsecurity", name: "安恒信息", url: "https://www.dbappsecurity.com.cn/images/favicon.ico", aliases: ["安恒", "DBAPPSecurity", "安恒明御堡垒机", "安恒明御运维审计与风险控制系统(堡垒机)", "明御堡垒机"] },
  { key: "topsec", name: "天融信", url: "https://www.topsec.com.cn/static/favicon.ico", aliases: ["Topsec", "天融信VPN", "天融信防火墙", "TopVPN"] },
  { key: "qianxin", name: "奇安信", url: "https://www.qianxin.com/static/images/logo-95015.png", aliases: ["Qi-Anxin", "Qianxin", "奇安信网神", "网神", "奇安信天擎"] },
  { key: "venustech", name: "启明星辰", url: "https://www.venustech.com.cn/r/cms/www/default/images/favicon.ico", aliases: ["Venustech", "启明星辰天清", "启明星辰天玥", "启明星辰防火墙"] }
];

function isPrivateAddress(address) {
  const value = String(address || "").toLowerCase();
  return value === "::1" || value.startsWith("127.") || value.startsWith("10.") || value.startsWith("192.168.") || /^172\.(1[6-9]|2\d|3[0-1])\./.test(value) || value === "0.0.0.0" || value.startsWith("169.254.") || value.startsWith("fc") || value.startsWith("fd") || value.startsWith("fe80:");
}

async function publicUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname.endsWith(".local")) throw new Error("图标地址必须是公网 HTTPS URL");
  const resolved = await lookup(url.hostname);
  if (isPrivateAddress(resolved.address)) throw new Error("图标地址解析到内网");
  return url.toString();
}

function mediaType(buffer, contentType) {
  const header = String(contentType || "").split(";", 1)[0].trim().toLowerCase();
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (buffer.subarray(0, 4).equals(Buffer.from([0, 0, 1, 0]))) return "image/x-icon";
  if (buffer.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return "image/jpeg";
  if (["GIF87a", "GIF89a"].includes(buffer.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (isSvgIconContent(buffer, header)) {
    assertSafeSvgIcon(buffer);
    return "image/svg+xml";
  }
  throw new Error(`不支持的图标格式：${header || "unknown"}`);
}

async function download(entry) {
  let target = await publicUrl(entry.url);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    let response;
    for (let redirect = 0; redirect <= 3; redirect += 1) {
      response = await fetch(target, { redirect: "manual", signal: controller.signal, headers: { Accept: "image/*,*/*;q=0.8", "User-Agent": "Sentinel-Domestic-Icon-Catalog/1.0" } });
      if (response.status < 300 || response.status >= 400) break;
      const location = response.headers.get("location");
      if (!location || redirect === 3) throw new Error("重定向次数过多");
      target = await publicUrl(new URL(location, target).toString());
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength > maxIconBytes) throw new Error("图标超过 256KB");
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length || buffer.length > maxIconBytes) throw new Error("图标大小不合法");
    const type = mediaType(buffer, response.headers.get("content-type"));
    return { ...entry, sourceUrl: target, mediaType: type, iconData: `data:${type};base64,${buffer.toString("base64")}`, iconSha256: createHash("sha256").update(buffer).digest("hex") };
  } finally { clearTimeout(timeout); }
}

export async function syncDomesticFingerprintIconCatalog(database, { actor = "system:domestic-icons" } = {}) {
  const settled = await Promise.allSettled(domesticFingerprintIconCatalog.map(download));
  const records = settled.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
  const failed = settled.flatMap((result, index) => result.status === "rejected" ? [{ name: domesticFingerprintIconCatalog[index].name, message: result.reason instanceof Error ? result.reason.message : String(result.reason) }] : []);
  const existingRows = await database.prepare("SELECT fingerprint_name,aliases_json,source,source_url,icon_sha256 FROM fingerprint_icon_library").all();
  const existing = new Map(existingRows.map((row) => [String(row.fingerprint_name).trim().toLocaleLowerCase(), row]));
  let inserted = 0; let updated = 0; let preserved = 0; let unchanged = 0;
  const changed = [];
  for (const record of records) {
    const current = existing.get(record.name.trim().toLocaleLowerCase());
    if (current && current.source !== "domestic") { preserved += 1; continue; }
    if (!current) inserted += 1;
    else if (current.icon_sha256 !== record.iconSha256 || JSON.stringify(current.aliases_json || []) !== JSON.stringify(record.aliases) || current.source_url !== record.sourceUrl) updated += 1;
    else { unchanged += 1; continue; }
    changed.push(record);
  }
  if (changed.length) {
    const now = new Date().toISOString();
    const upsert = database.prepare(`INSERT INTO fingerprint_icon_library
      (id,fingerprint_name,aliases_json,source,source_url,media_type,icon_data,icon_sha256,active,created_by,updated_by,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,TRUE,?,?,?,?)
      ON CONFLICT (lower(trim(fingerprint_name))) DO UPDATE SET aliases_json=EXCLUDED.aliases_json,source_url=EXCLUDED.source_url,
        media_type=EXCLUDED.media_type,icon_data=EXCLUDED.icon_data,icon_sha256=EXCLUDED.icon_sha256,updated_by=EXCLUDED.updated_by,updated_at=EXCLUDED.updated_at
      WHERE fingerprint_icon_library.source='domestic'`);
    await database.transaction(async () => {
      for (const record of changed) await upsert.run(`FICON-CN-${record.key.toUpperCase()}`, record.name, JSON.stringify(record.aliases), "domestic", record.sourceUrl, record.mediaType, record.iconData, record.iconSha256, actor, actor, now, now);
    });
  }
  return { catalogSize: domesticFingerprintIconCatalog.length, loaded: records.length, inserted, updated, preserved, unchanged, failed };
}
