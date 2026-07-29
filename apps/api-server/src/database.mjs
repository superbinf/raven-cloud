import { AsyncLocalStorage } from "node:async_hooks";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Pool, types } = pg;
types.setTypeParser(20, Number);

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, "../migrations");
const connectionString = process.env.DATABASE_URL || "postgresql://sentinel:sentinel-local-password@127.0.0.1:5432/sentinel";
const schema = process.env.SENTINEL_DB_SCHEMA || "public";

if (!/^[a-z_][a-z0-9_]*$/.test(schema)) {
  throw new Error("SENTINEL_DB_SCHEMA 只能包含小写字母、数字和下划线，且不能以数字开头");
}

const pool = new Pool({
  connectionString,
  max: Number(process.env.PGPOOL_MAX || 10),
  options: schema === "public" ? undefined : `-c search_path=${schema},public`
});
const transactionContext = new AsyncLocalStorage();

function placeholders(sql) {
  let index = 0;
  let quoted = false;
  let output = "";
  for (let position = 0; position < sql.length; position += 1) {
    const character = sql[position];
    if (character === "'") {
      output += character;
      if (quoted && sql[position + 1] === "'") output += sql[++position];
      else quoted = !quoted;
    } else if (character === "?" && !quoted) output += `$${++index}`;
    else output += character;
  }
  return output;
}

async function query(sql, params = []) {
  const client = transactionContext.getStore() || pool;
  return client.query(placeholders(sql), params);
}

class Statement {
  constructor(sql) { this.sql = sql; }
  async get(...params) { return (await query(this.sql, params)).rows[0]; }
  async all(...params) { return (await query(this.sql, params)).rows; }
  async run(...params) {
    const result = await query(this.sql, params);
    return { changes: result.rowCount };
  }
}

export const db = {
  prepare(sql) { return new Statement(sql); },
  async exec(sql) { return query(sql); },
  async transaction(callback) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await transactionContext.run(client, callback);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
};

export async function migrate() {
  if (schema !== "public") await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
  await query("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
  const applied = new Set((await query("SELECT name FROM schema_migrations")).rows.map((row) => row.name));
  const files = (await readdir(migrationsDir)).filter((name) => name.endsWith(".sql")).sort();
  for (const name of files) {
    if (applied.has(name)) continue;
    const sql = await readFile(join(migrationsDir, name), "utf8");
    await db.transaction(async () => {
      await db.exec(sql);
      await db.prepare("INSERT INTO schema_migrations (name) VALUES (?)").run(name);
    });
  }
}

export async function closeDatabase() { await pool.end(); }

export const databaseConfig = { connectionString, schema };

export const databaseInfo = (() => {
  const url = new URL(connectionString);
  return { engine: "postgresql", host: url.hostname, port: Number(url.port || 5432), database: url.pathname.slice(1), schema };
})();
