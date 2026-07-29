import assert from "node:assert/strict";
import test from "node:test";
import { loadProviderIconCatalog, providerIconCatalog } from "../src/provider-icon-catalog.mjs";

test("运营商图标目录完整、离线可读并覆盖当前报告品牌", async () => {
  const records = await loadProviderIconCatalog();
  assert.equal(records.length, 10);
  assert.equal(new Set(providerIconCatalog.map((item) => item.key)).size, records.length);
  assert.ok(records.every((item) => item.source === "provider" && item.iconData.startsWith(`data:${item.mediaType};base64,`)));
  assert.ok(records.every((item) => /^[a-f0-9]{64}$/.test(item.iconSha256)));
  for (const name of ["中国移动", "中国电信", "中国联通", "阿里云", "华为云", "腾讯云", "百度云", "UCloud", "网宿科技", "Cloudflare CDN"]) {
    assert.ok(records.some((item) => item.fingerprintName === name), `缺少 ${name}`);
  }
  assert.ok(records.find((item) => item.fingerprintName === "中国移动")?.aliases.includes("铁通"));
  assert.ok(records.find((item) => item.fingerprintName === "网宿科技")?.aliases.includes("网宿科技电信CDN节点"));
});
