import { closeDatabase, db, migrate } from "../src/database.mjs";
import { syncSimpleIconCatalog } from "../src/fingerprint-icon-catalog.mjs";
import { syncDomesticFingerprintIconCatalog } from "../src/domestic-fingerprint-icon-catalog.mjs";
import { syncProviderIconCatalog } from "../src/provider-icon-catalog.mjs";

try {
  await migrate();
  const simple = await syncSimpleIconCatalog(db);
  const domestic = await syncDomesticFingerprintIconCatalog(db);
  const provider = await syncProviderIconCatalog(db);
  console.log(`基础图标库同步完成：Simple Icons ${simple.catalogSize}，国产应用成功 ${domestic.loaded}/${domestic.catalogSize}，运营商 ${provider.loaded}/${provider.catalogSize}，新增 ${simple.inserted + domestic.inserted + provider.inserted}，更新 ${simple.updated + domestic.updated + provider.updated}，失败 ${domestic.failed.length}`);
  for (const failure of domestic.failed) console.warn(`国产应用图标获取失败：${failure.name}（${failure.message}）`);
} finally {
  await closeDatabase();
}
