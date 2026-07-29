import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { closeDatabase, databaseInfo, migrate } from "../src/database.mjs";

const tables = [
  "monitoring_targets", "api_connections", "credential_subscriptions", "credential_records",
  "users", "sessions", "ingestion_batches", "sensitive_records", "asset_records",
  "asset_reports", "dark_web_blobs", "dark_web_events", "dark_web_files"
];
const tenantScopedTables = new Set([
  "monitoring_targets", "api_connections", "credential_subscriptions", "ingestion_batches",
  "sensitive_records", "asset_records", "asset_reports", "dark_web_events"
]);
const __dirname = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(__dirname, "..");
const projectRoot = resolve(apiRoot, "../..");
const requestedPath = process.argv[2];
const workspaceCandidate = requestedPath ? resolve(requestedPath) : join(apiRoot, "data/sentinel.db");
const projectCandidate = requestedPath ? resolve(projectRoot, requestedPath) : workspaceCandidate;
const sqlitePath = existsSync(workspaceCandidate) ? workspaceCandidate : projectCandidate;

if (!existsSync(sqlitePath)) throw new Error(`SQLite 数据库不存在：${sqlitePath}`);

await migrate();
const source = new DatabaseSync(sqlitePath, { readOnly: true });
const client = new pg.Client({ connectionString: process.env.DATABASE_URL || "postgresql://sentinel:sentinel-local-password@127.0.0.1:5432/sentinel" });
await client.connect();

try {
  await client.query(`SET search_path TO "${databaseInfo.schema}", public`);
  const nonEmpty = [];
  for (const table of tables) {
    const result = await client.query(`SELECT COUNT(*)::int AS count FROM "${table}"`);
    if (result.rows[0].count) nonEmpty.push(`${table}=${result.rows[0].count}`);
  }
  if (nonEmpty.length) throw new Error(`PostgreSQL 目标表不是空的，已拒绝覆盖：${nonEmpty.join(", ")}`);

  await client.query("BEGIN");
  const imported = {};
  for (const table of tables) {
    const sourceExists = source.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
    if (!sourceExists) { imported[table] = 0; continue; }
    const sourceColumns = source.prepare(`PRAGMA table_info("${table}")`).all().map((column) => column.name);
    const targetColumns = (await client.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 ORDER BY ordinal_position",
      [databaseInfo.schema, table]
    )).rows.map((row) => row.column_name);
    const sourceSelectColumns = targetColumns.filter((column) => sourceColumns.includes(column));
    const columns = tenantScopedTables.has(table) && !sourceSelectColumns.includes("tenant_id") ? [...sourceSelectColumns, "tenant_id"] : sourceSelectColumns;
    const rows = source.prepare(`SELECT ${sourceSelectColumns.map((column) => `"${column}"`).join(",")} FROM "${table}"`).all();
    const columnSql = columns.map((column) => `"${column}"`).join(",");
    const valueSql = columns.map((_, index) => `$${index + 1}`).join(",");
    for (const row of rows) {
      await client.query(`INSERT INTO "${table}" (${columnSql}) VALUES (${valueSql})`, columns.map((column) => column === "tenant_id" && row[column] === undefined ? "TENANT-CHANGAN" : row[column]));
    }
    imported[table] = rows.length;
  }
  await client.query("COMMIT");
  console.log(JSON.stringify({ source: sqlitePath, target: databaseInfo, imported }, null, 2));
} catch (error) {
  try { await client.query("ROLLBACK"); } catch {}
  throw error;
} finally {
  source.close();
  await client.end();
  await closeDatabase();
}
