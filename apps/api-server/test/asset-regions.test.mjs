import assert from "node:assert/strict";
import test from "node:test";
import { aggregateAssetRegions } from "../src/asset-regions.mjs";

test("asset regions aggregate geo and ipLocation fields without fixed fallback data", () => {
  const result = aggregateAssetRegions([
    { risk: "中", fields_json: JSON.stringify({ geo: { province: "广东省", city: "深圳市" } }) },
    { risk: "critical", fields_json: JSON.stringify({ ipLocation: "中国 广东 广州" }) },
    { risk: "low", fields_json: JSON.stringify({ ip_location: "上海市" }) },
    { risk: "high", fields_json: JSON.stringify({ ipLocation: "未知区域" }) }
  ]);

  assert.deepEqual(result, [
    { name: "广东", value: 2, risk: "critical", coordinate: [113.27, 23.13] },
    { name: "上海", value: 1, risk: "low", coordinate: [121.47, 31.23] }
  ]);
});

test("asset regions return an empty collection when assets have no recognizable region", () => {
  assert.deepEqual(aggregateAssetRegions([
    { risk: "high", fields_json: JSON.stringify({ ipAddress: "198.51.100.10" }) },
    { risk: "critical", fields_json: JSON.stringify({ geo: "" }) }
  ]), []);
});
