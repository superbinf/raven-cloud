import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertSafeSvgIcon } from "@sentinel/transport-security";

const iconDirectory = join(dirname(fileURLToPath(import.meta.url)), "../assets/provider-icons");

export const providerIconCatalog = [
  { key: "china-mobile", name: "中国移动", file: "china-mobile.ico", mediaType: "image/x-icon", sourceUrl: "https://www.10086.cn/favicon.ico", aliases: ["移动", "China Mobile", "CMCC", "中国铁通", "铁通", "北京北方星辰信息技术有限责任公司铁通数据中心"] },
  { key: "china-telecom", name: "中国电信", file: "china-telecom.ico", mediaType: "image/x-icon", sourceUrl: "https://www.189.cn/favicon.ico", aliases: ["电信", "China Telecom", "CTCC", "电信中心网络", "263网络通信电信数据中心", "广州海之光通信技术有限公司电信节点", "成都西维数码科技有限公司四川电信成都光华互联网数据中心节点"] },
  { key: "china-unicom", name: "中国联通", file: "china-unicom.ico", mediaType: "image/x-icon", sourceUrl: "https://www.10010.com/favicon.ico", aliases: ["联通", "China Unicom", "CUCC"] },
  { key: "alibaba-cloud", name: "阿里云", file: "alibaba-cloud.svg", mediaType: "image/svg+xml", sourceUrl: "https://simpleicons.org/?q=Alibaba%20Cloud", aliases: ["Alibaba Cloud", "阿里巴巴云", "阿里巴巴网络有限公司", "阿里云BGP数据中心", "阿里巴巴网络有限公司BGP数据中心(BGP)", "阿里云计算有限公司"] },
  { key: "huawei-cloud", name: "华为云", file: "huawei-cloud.svg", mediaType: "image/svg+xml", sourceUrl: "https://simpleicons.org/?q=Huawei", aliases: ["Huawei Cloud", "华为云计算"] },
  { key: "tencent-cloud", name: "腾讯云", file: "tencent-cloud.ico", mediaType: "image/x-icon", sourceUrl: "https://cloud.tencent.com/favicon.ico", aliases: ["Tencent Cloud", "腾讯云计算"] },
  { key: "baidu-cloud", name: "百度云", file: "baidu-cloud.svg", mediaType: "image/svg+xml", sourceUrl: "https://simpleicons.org/?q=Baidu", aliases: ["百度智能云", "Baidu Cloud", "北京百度网讯科技有限公司电信节点"] },
  { key: "ucloud", name: "UCloud", file: "ucloud.ico", mediaType: "image/x-icon", sourceUrl: "https://www.ucloud.cn/favicon.ico", aliases: ["优刻得", "优刻得科技"] },
  { key: "wangsu", name: "网宿科技", file: "wangsu.ico", mediaType: "image/x-icon", sourceUrl: "https://www.wangsu.com/favicon.ico", aliases: ["Wangsu", "ChinaNetCenter", "网宿科技BGP数据中心", "网宿科技电信CDN节点"] },
  { key: "cloudflare", name: "Cloudflare CDN", file: "cloudflare.svg", mediaType: "image/svg+xml", sourceUrl: "https://simpleicons.org/?q=Cloudflare", aliases: ["Cloudflare"] }
];

export async function loadProviderIconCatalog() {
  return Promise.all(providerIconCatalog.map(async (entry) => {
    const source = await readFile(join(iconDirectory, entry.file));
    const buffer = entry.mediaType === "image/svg+xml" ? assertSafeSvgIcon(source) : source;
    return {
      id: `FICON-PROVIDER-${entry.key.toUpperCase()}`,
      fingerprintName: entry.name,
      aliases: entry.aliases,
      source: "provider",
      sourceUrl: entry.sourceUrl,
      mediaType: entry.mediaType,
      iconData: `data:${entry.mediaType};base64,${buffer.toString("base64")}`,
      iconSha256: createHash("sha256").update(buffer).digest("hex")
    };
  }));
}

export async function syncProviderIconCatalog(database, { actor = "system:provider-icons" } = {}) {
  const catalog = await loadProviderIconCatalog();
  const existingRows = await database.prepare("SELECT fingerprint_name,aliases_json,source,source_url,icon_sha256 FROM fingerprint_icon_library").all();
  const existing = new Map(existingRows.map((row) => [String(row.fingerprint_name).trim().toLocaleLowerCase(), row]));
  let inserted = 0; let updated = 0; let preserved = 0; let unchanged = 0;
  const changed = [];
  for (const record of catalog) {
    const current = existing.get(record.fingerprintName.trim().toLocaleLowerCase());
    if (current && current.source !== "provider") { preserved += 1; continue; }
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
      WHERE fingerprint_icon_library.source='provider'`);
    await database.transaction(async () => {
      for (const record of changed) await upsert.run(record.id, record.fingerprintName, JSON.stringify(record.aliases), record.source, record.sourceUrl, record.mediaType, record.iconData, record.iconSha256, actor, actor, now, now);
    });
  }
  return { catalogSize: catalog.length, loaded: catalog.length, inserted, updated, preserved, unchanged };
}
