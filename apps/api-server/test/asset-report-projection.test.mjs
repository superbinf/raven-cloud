import assert from "node:assert/strict";
import test from "node:test";
import { canonicalSerialize } from "@sentinel/distribution";
import { assetReportCounts, assetReportRowIsSince, assetReportTodayCounts, projectAssetReportData } from "../src/asset-report-projection.mjs";

function record(category, fields, title = "", metadata = {}) {
  return { category, title, fields_json: JSON.stringify(fields), ...metadata };
}

test("新增已发布资产会进入扫描报告并增加各板块数量", () => {
  const source = {
    websites: [{ url: "https://old.example.test", ip: "192.0.2.1", domain: "old.example.test", port: "443", title: "原站点" }],
    ports: [{ ip: "192.0.2.1", protocol: "tcp", port: "443", service: "https" }],
    dns: [{ subdomain: "old.example.test", ips: ["192.0.2.1"], cnames: [] }],
    products: { datasource: [] },
    icons: []
  };
  const records = [
    record("web", { url: "https://old.example.test", ipAddress: "192.0.2.1", domain: "old.example.test", protocol: "https", port: "443", title: "原站点" }),
    record("web", { url: "https://new.example.test", ipAddress: "192.0.2.2", domain: "new.example.test", protocol: "https", port: "8443", title: "工程师新增站点", application: "New App" }),
    record("server", { address: "192.0.2.1", protocol: "tcp", port: "443", serviceType: "https" }),
    record("server", { address: "192.0.2.2", protocol: "tcp", port: "8443", serviceType: "admin" }),
    record("subdomain", { rootDomain: "example.test", subdomain: "old.example.test", ipAlias: "192.0.2.1" }),
    record("subdomain", { rootDomain: "example.test", subdomain: "new.example.test", ipAlias: "192.0.2.2" })
  ];

  const projected = projectAssetReportData(source, records);

  assert.deepEqual(assetReportCounts(projected), { webCount: 2, portCount: 2, dnsCount: 2, fingerprintCount: 1, iconCount: 0 });
  assert.equal(projected.websites.at(-1).title, "工程师新增站点");
  assert.deepEqual(projected.websites.at(-1).discovery_chain, []);
  assert.equal(projected.websites.at(-1).geo, null);
  assert.equal(projected.ports.at(-1).service, "admin");
  assert.deepEqual(projected.dns.at(-1).ips, ["192.0.2.2"]);
  assert.doesNotThrow(() => canonicalSerialize(projected));
});

test("编辑和删除资产会覆盖扫描报告，同时保留不可管理的原始行", () => {
  const source = {
    websites: [
      { url: "https://kept.example.test", ip: "192.0.2.10", domain: "kept.example.test", port: "443", title: "旧标题", response_body: "原始富数据" },
      { url: "https://deleted.example.test", ip: "192.0.2.11", domain: "deleted.example.test", port: "443", title: "待删除" },
      { url: "", title: "无法导入但应保留", response_body: "保留" }
    ],
    ports: [
      { ip: "192.0.2.10", protocol: "tcp", port: "443", service: "https", banner: "old banner" },
      { ip: "192.0.2.11", protocol: "tcp", port: "22", service: "ssh" },
      { ip: "", protocol: "tcp", port: "", service: "原始未知端口" }
    ],
    dns: [
      { subdomain: "kept.example.test", ips: ["192.0.2.10"], cnames: [] },
      { subdomain: "deleted.example.test", ips: ["192.0.2.11"], cnames: [] },
      { subdomain: "", ips: [], cnames: ["原始未知 DNS"] }
    ],
    products: { datasource: [] },
    icons: []
  };
  const records = [
    record("web", { url: "https://kept.example.test", ipAddress: "192.0.2.10", domain: "kept.example.test", protocol: "https", port: "443", title: "工程师修改后的标题" }),
    record("server", { address: "192.0.2.10", protocol: "tcp", port: "443", serviceType: "https", banner: "new banner" }),
    record("subdomain", { rootDomain: "example.test", subdomain: "kept.example.test", ipAlias: "192.0.2.10", ips: "192.0.2.10", cnames: "alias.example.test" })
  ];

  const projected = projectAssetReportData(source, records);

  assert.equal(projected.websites[0].title, "工程师修改后的标题");
  assert.equal(projected.websites[0].response_body, "原始富数据");
  assert.ok(!projected.websites.some((item) => item.url === "https://deleted.example.test"));
  assert.ok(projected.websites.some((item) => item.title === "无法导入但应保留"));
  assert.equal(projected.ports[0].banner, "new banner");
  assert.ok(!projected.ports.some((item) => item.port === "22"));
  assert.ok(projected.ports.some((item) => item.service === "原始未知端口"));
  assert.deepEqual(projected.dns[0].cnames, ["alias.example.test"]);
  assert.ok(!projected.dns.some((item) => item.subdomain === "deleted.example.test"));
  assert.ok(projected.dns.some((item) => item.cnames?.includes("原始未知 DNS")));
});

test("指纹投影保留产品类型和原始图标内容，并接纳工程师新增指纹", () => {
  const source = {
    websites: [{
      url: "https://app.example.test", ip: "192.0.2.20", domain: "app.example.test", port: "443",
      app_products: [{ name: "Baseline App", version: "1.0" }], framework_products: ["Baseline Framework"]
    }],
    ports: [],
    dns: [],
    products: { datasource: [
      { key: "Baseline App", nameAndType: "Baseline App+app", type: "app", count: 1 },
      { key: "Baseline Framework", nameAndType: "Baseline Framework+framework", type: "framework", count: 1 }
    ] },
    icons: [{ md5: "icon-md5", count: 2, icon: "data:image/png;base64,original-image" }]
  };
  const records = [
    record("web", {
      url: "https://app.example.test", ipAddress: "192.0.2.20", domain: "app.example.test", protocol: "https", port: "443",
      appProducts: "Baseline App", frameworkProducts: "Baseline Framework"
    }),
    record("fingerprint", { fingerprintType: "产品指纹", name: "Baseline App", productType: "app", count: "1" }),
    record("fingerprint", { fingerprintType: "产品指纹", name: "Baseline Framework", productType: "framework", count: "1" }),
    record("fingerprint", { fingerprintType: "产品指纹", name: "Engineer App", productType: "app", count: "3" }),
    record("fingerprint", { fingerprintType: "站点图标", name: "icon-md5", iconHashMd5: "icon-md5", count: "4" })
  ];

  const projected = projectAssetReportData(source, records);

  assert.ok(projected.fingerprints.some((item) => item.key === "Baseline App" && item.type === "应用指纹"));
  assert.ok(projected.fingerprints.some((item) => item.key === "Baseline Framework" && item.type === "信息指纹"));
  assert.ok(projected.fingerprints.some((item) => item.key === "Engineer App" && item.count === 3));
  assert.equal(projected.icons.length, 1);
  assert.deepEqual({ md5: projected.icons[0].md5, count: projected.icons[0].count, icon: projected.icons[0].icon }, { md5: "icon-md5", count: 4, icon: "data:image/png;base64,original-image" });
});

test("扫描报告按资产首次发现时间统计今日新增", () => {
  const old = { first_seen_at: "2026-07-22T15:59:59.999Z" };
  const today = { first_seen_at: "2026-07-22T16:00:00.000Z" };
  const projected = projectAssetReportData({ websites: [], ports: [], dns: [], products: { datasource: [] }, icons: [] }, [
    record("web", { url: "https://old.example.test", ipAddress: "192.0.2.30", domain: "old.example.test", protocol: "https", port: "443", application: "Old App" }, "", old),
    record("web", { url: "https://new.example.test", ipAddress: "192.0.2.31", domain: "new.example.test", protocol: "https", port: "443", application: "New App" }, "", today),
    record("server", { address: "192.0.2.31", protocol: "tcp", port: "443", serviceType: "https" }, "", today),
    record("subdomain", { rootDomain: "example.test", subdomain: "new.example.test", ipAlias: "192.0.2.31" }, "", today),
    record("fingerprint", { fingerprintType: "产品指纹", name: "Manual Fingerprint", productType: "app", count: "1" }, "", today),
    record("fingerprint", { fingerprintType: "站点图标", name: "today-icon", iconHashMd5: "today-icon", count: "1" }, "", today)
  ]);
  const since = "2026-07-22T16:00:00.000Z";

  assert.deepEqual(assetReportTodayCounts(projected, since), { web: 1, ports: 1, dns: 1, fingerprints: 2, icons: 1 });
  assert.equal(assetReportRowIsSince(projected.websites[0], since), false);
  assert.equal(assetReportRowIsSince(projected.websites[1], since), true);
});

test("资产差异状态和前后变化会投影到地端报告行", () => {
  const projected = projectAssetReportData({ websites: [], ports: [], dns: [], products: { datasource: [] }, icons: [] }, [
    record("web", {
      url: "https://changed.example.test",
      ipAddress: "192.0.2.40",
      domain: "changed.example.test",
      protocol: "https",
      port: "443",
      alive: false,
      statusCode: "503"
    }, "状态变化站点", {
      id: "ASSET-changed",
      changeType: "changed",
      previousFields: { alive: true, statusCode: "200", title: "旧标题不应进入状态差异" },
      lastChangedAt: "2026-07-29T08:00:00.000Z"
    })
  ]);

  assert.equal(projected.websites[0]._change_type, "changed");
  assert.match(projected.websites[0]._change_summary, /存活状态 存活 → 未存活/);
  assert.match(projected.websites[0]._change_summary, /状态码 200 → 503/);
  assert.doesNotMatch(projected.websites[0]._change_summary, /标题/);
  assert.equal(projected.websites[0].alive, "未存活");
  assert.equal(projected.websites[0]._last_changed_at, "2026-07-29T08:00:00.000Z");
});

test("资产报告统一归一化存活状态，避免筛选和列表暴露布尔值", () => {
  const projected = projectAssetReportData({
    websites: [{ url: "", alive: false, title: "无法关联的原始 Web 行" }],
    ports: [{ ip: "", port: "", alive: "up", service: "无法关联的原始端口行" }],
    dns: [],
    products: { datasource: [] },
    icons: []
  }, []);

  assert.equal(projected.websites[0].alive, "未存活");
  assert.equal(projected.ports[0].alive, "存活");
});
