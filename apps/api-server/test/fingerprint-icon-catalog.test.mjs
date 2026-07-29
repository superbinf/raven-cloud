import assert from "node:assert/strict";
import test from "node:test";
import { loadSimpleIconCatalog, simpleIconRecord } from "../src/fingerprint-icon-catalog.mjs";

test("Simple Icons 基础库生成安全、可见且包含常用指纹别名", async () => {
  const catalog = await loadSimpleIconCatalog();
  assert.ok(catalog.length > 3000);
  assert.equal(new Set(catalog.map((item) => item.id)).size, catalog.length);

  const springBoot = catalog.find((item) => item.fingerprintName === "Spring Boot");
  assert.ok(springBoot);
  assert.ok(springBoot.aliases.includes("Spring-Boot"));
  assert.equal(springBoot.source, "simple-icons");

  const dotnet = catalog.find((item) => item.fingerprintName === ".NET");
  assert.ok(dotnet);
  assert.ok(dotnet.aliases.includes("Microsoft-ASP.NET"));

  const nginx = catalog.find((item) => item.fingerprintName === "NGINX");
  assert.ok(nginx);
  assert.ok(nginx.aliases.includes("OpenResty"));

  const darkIcon = simpleIconRecord({ title: "Dark Test", slug: "darktest", hex: "000000", path: "M0 0h24v24H0z" });
  const svg = Buffer.from(darkIcon.iconData.split(",", 2)[1], "base64").toString("utf8");
  assert.match(svg, /fill="#DCE7F5"/);
  assert.doesNotMatch(svg, /<script|onload=|javascript:/i);
});
