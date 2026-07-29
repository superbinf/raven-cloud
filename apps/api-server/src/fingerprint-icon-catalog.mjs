import { createHash } from "node:crypto";
import { assertSafeSvgIcon } from "@sentinel/transport-security";

const aliasOverrides = {
  apache: ["Apache HTTP Server", "Apache Web Server"],
  apachetomcat: ["Apache Tomcat", "Tomcat"],
  dotnet: ["ASP.NET", "Microsoft ASP.NET", "Microsoft-ASP.NET", "DotNet"],
  javascript: ["JavaScript", "JS"],
  kubernetes: ["K8s"],
  microsoftsqlserver: ["Microsoft SQL Server", "MSSQL", "SQL Server"],
  mongodb: ["Mongo DB"],
  nextdotjs: ["Next.js", "NextJS"],
  nginx: ["OpenResty", "Tengine"],
  nodedotjs: ["Node.js", "NodeJS"],
  openjdk: ["Java", "JDK"],
  openresty: ["OpenResty"],
  phpmyadmin: ["phpMyAdmin"],
  postgresql: ["Postgres", "PostgreSQL"],
  springboot: ["Spring Boot", "Spring-Boot", "SpringBoot"],
  vuedotjs: ["Vue", "Vue.js", "VueJS"],
  wordpress: ["WordPress", "Wordpress"]
};

function visibleColor(hex) {
  const value = String(hex || "7F8EA3").replace(/^#/, "").padStart(6, "0").slice(0, 6);
  const channels = [0, 2, 4].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16) / 255);
  const luminance = channels.reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
  return luminance < 0.16 ? "DCE7F5" : value.toUpperCase();
}

function normalizeAliases(icon) {
  const candidates = [icon.slug, ...(aliasOverrides[icon.slug] || [])];
  const canonical = icon.title.trim().toLocaleLowerCase();
  return [...new Set(candidates.map((value) => String(value).trim()).filter((value) => value && value.toLocaleLowerCase() !== canonical))];
}

export function simpleIconRecord(icon) {
  const color = visibleColor(icon.hex);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#${color}" d="${icon.path}"/></svg>`;
  const buffer = assertSafeSvgIcon(Buffer.from(svg, "utf8"));
  return {
    id: `FICON-SI-${icon.slug.toUpperCase()}`,
    fingerprintName: icon.title,
    aliases: normalizeAliases(icon),
    source: "simple-icons",
    sourceUrl: `https://simpleicons.org/?q=${encodeURIComponent(icon.title)}`,
    mediaType: "image/svg+xml",
    iconData: `data:image/svg+xml;base64,${buffer.toString("base64")}`,
    iconSha256: createHash("sha256").update(buffer).digest("hex")
  };
}

export async function loadSimpleIconCatalog() {
  const module = await import("simple-icons");
  const icons = Object.values(module).filter((value) => value && typeof value === "object" && value.title && value.slug && value.path && value.hex);
  const records = icons.map(simpleIconRecord).sort((left, right) => left.fingerprintName.localeCompare(right.fingerprintName, "en") || left.id.localeCompare(right.id));
  return [...new Map(records.map((record) => [record.fingerprintName.trim().toLocaleLowerCase(), record])).values()];
}

export async function syncSimpleIconCatalog(database, { actor = "system:simple-icons" } = {}) {
  const catalog = await loadSimpleIconCatalog();
  const existingRows = await database.prepare("SELECT fingerprint_name,aliases_json,source,source_url,icon_sha256 FROM fingerprint_icon_library").all();
  const existing = new Map(existingRows.map((row) => [String(row.fingerprint_name).trim().toLocaleLowerCase(), row]));
  let inserted = 0;
  let updated = 0;
  let preserved = 0;
  const changed = [];

  for (const record of catalog) {
    const current = existing.get(record.fingerprintName.trim().toLocaleLowerCase());
    if (current && current.source !== "simple-icons") { preserved += 1; continue; }
    if (!current) inserted += 1;
    else if (current.icon_sha256 !== record.iconSha256 || JSON.stringify(current.aliases_json || []) !== JSON.stringify(record.aliases) || current.source_url !== record.sourceUrl) updated += 1;
    else continue;
    changed.push(record);
  }

  if (changed.length) {
    const now = new Date().toISOString();
    const upsert = database.prepare(`INSERT INTO fingerprint_icon_library
      (id,fingerprint_name,aliases_json,source,source_url,media_type,icon_data,icon_sha256,active,created_by,updated_by,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,TRUE,?,?,?,?)
      ON CONFLICT (lower(trim(fingerprint_name))) DO UPDATE SET
        aliases_json=EXCLUDED.aliases_json,source_url=EXCLUDED.source_url,media_type=EXCLUDED.media_type,
        icon_data=EXCLUDED.icon_data,icon_sha256=EXCLUDED.icon_sha256,updated_by=EXCLUDED.updated_by,updated_at=EXCLUDED.updated_at
      WHERE fingerprint_icon_library.source='simple-icons'`);
    await database.transaction(async () => {
      for (const record of changed) {
        await upsert.run(record.id, record.fingerprintName, JSON.stringify(record.aliases), record.source, record.sourceUrl, record.mediaType, record.iconData, record.iconSha256, actor, actor, now, now);
      }
    });
  }

  return { catalogSize: catalog.length, inserted, updated, preserved, unchanged: catalog.length - inserted - updated - preserved };
}

export async function ensureSimpleIconCatalog(database) {
  const row = await database.prepare("SELECT COUNT(*) AS count FROM fingerprint_icon_library WHERE source='simple-icons'").get();
  if (Number(row?.count || 0) > 0) return null;
  return syncSimpleIconCatalog(database);
}
