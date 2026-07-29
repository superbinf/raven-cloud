import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrations = new URL("../migrations/", import.meta.url);

test("fresh Cloud migrations do not create the Changan customer", async () => {
  const migration = await readFile(new URL("003_cloud_edge_mvp.sql", migrations), "utf8");
  assert.doesNotMatch(migration, /重庆长安汽车股份有限公司/u);
  assert.doesNotMatch(migration, /TENANT-CHANGAN/u);
  assert.match(migration, /SELECT 'TENANT-HISTORICAL', '历史数据迁移租户'/u);
  assert.match(migration, /WHERE EXISTS \(/u);
});

test("upgrade migration removes only an empty legacy Changan customer", async () => {
  const migration = await readFile(new URL("040_remove_empty_legacy_changan_tenant.sql", migrations), "utf8");
  assert.match(migration, /id = 'TENANT-CHANGAN'/u);
  assert.match(migration, /name = '重庆长安汽车股份有限公司'/u);
  assert.match(migration, /NOT EXISTS \(SELECT 1 FROM monitoring_targets/u);
  assert.match(migration, /NOT EXISTS \(SELECT 1 FROM edge_licenses/u);
  assert.match(migration, /is_default = FALSE/u);
  assert.match(migration, /DELETE FROM fingerprint_watch_groups/u);
  assert.match(migration, /DELETE FROM tenants/u);
});
