import assert from "node:assert/strict";
import test from "node:test";
import { domesticFingerprintIconCatalog } from "../src/domestic-fingerprint-icon-catalog.mjs";

test("国产商业应用目录覆盖常见政企产品且键和别名不重复", () => {
  assert.ok(domesticFingerprintIconCatalog.length >= 20);
  assert.equal(new Set(domesticFingerprintIconCatalog.map((item) => item.key)).size, domesticFingerprintIconCatalog.length);
  for (const name of ["泛微协同办公", "致远协同办公", "用友", "金蝶", "蓝凌协同办公", "帆软", "达梦数据库", "人大金仓"]) {
    assert.ok(domesticFingerprintIconCatalog.some((item) => item.name === name), `缺少 ${name}`);
  }
  assert.ok(domesticFingerprintIconCatalog.find((item) => item.name === "泛微协同办公")?.aliases.includes("泛微Ecology-v9"));
  assert.ok(domesticFingerprintIconCatalog.find((item) => item.name === "金蝶")?.aliases.includes("金蝶云星瀚ierp"));
});
