import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  ROOT,
  TARGETS,
  applicationBuilds,
  applicationBuildArgs,
  parseArgs,
  releaseIdentity,
  renderEntryTemplate,
  stripComposeBuildSections,
  validateOptions,
} from "./build-offline.mjs";

test("cloud package includes the application and every runtime base image", () => {
  assert.deepEqual(applicationBuilds(TARGETS.cloud), [
    { image: "raven-cloud", dockerfile: "apps/api-server/Dockerfile" },
  ]);
  assert.deepEqual(
    TARGETS.cloud.baseImages.map((item) => item.image),
    ["postgres:17-alpine", "redis:7.4-alpine"],
  );
});

test("cloud offline build has no target-specific build arguments", () => {
  assert.deepEqual(applicationBuildArgs(TARGETS.cloud, {}), []);
});

test("parseArgs accepts the documented AMD64 build invocation", () => {
  const options = parseArgs(["--version", "0.3.1", "--arch", "amd64", "--only", "cloud", "--dry-run"]);
  assert.equal(options.version, "0.3.1");
  assert.equal(options.arch, "amd64");
  assert.equal(options.only, "cloud");
  assert.equal(options.dryRun, true);
  assert.doesNotThrow(() => validateOptions(options));
});

test("offline builds require an explicit target architecture", () => {
  const options = parseArgs(["--version", "0.3.1"]);
  assert.equal(options.arch, "");
  assert.throws(
    () => validateOptions(options),
    /必须显式指定目标架构/,
  );
});

test("validateOptions rejects unsafe version and unsupported architecture", () => {
  assert.throws(
    () => validateOptions({ version: "../release", arch: "amd64", only: "" }),
    /版本号/,
  );
  assert.throws(
    () => validateOptions({ version: "0.3.1", arch: "386", only: "" }),
    /不支持的架构/,
  );
  assert.throws(
    () => validateOptions({ version: "0.3.1", arch: "amd64", only: "edge" }),
    /raven/i,
  );
});

test("stripComposeBuildSections removes only service build blocks", () => {
  const source = `name: sentinel
services:
  api:
    image: sentinel:test
    build:
      context: .
      dockerfile: Dockerfile
    restart: unless-stopped
  postgres:
    image: postgres:17-alpine
`;
  const result = stripComposeBuildSections(source);
  assert.doesNotMatch(result, /\bbuild:/);
  assert.match(result, /image: sentinel:test/);
  assert.match(result, /restart: unless-stopped/);
  assert.match(result, /image: postgres:17-alpine/);
});

test("releaseIdentity ties package and image names to source revision", () => {
  const identity = releaseIdentity({
    version: "0.3.1",
    arch: "amd64",
    date: "20260730",
    gitSha: "fd049a03",
  });
  assert.equal(identity.imageTag, "0.3.1-20260730-fd049a03-amd64");
  assert.equal(identity.packageSuffix, identity.imageTag);
});

test("renderEntryTemplate resolves all release placeholders", () => {
  const result = renderEntryTemplate(
    "v=@@VERSION@@ arch=@@ARCH@@ tag=@@IMAGE_TAG@@",
    { VERSION: "0.3.1", ARCH: "arm64", IMAGE_TAG: "release-arm64" },
  );
  assert.equal(result, "v=0.3.1 arch=arm64 tag=release-arm64");
  assert.throws(
    () => renderEntryTemplate("@@MISSING@@", {}),
    /未替换变量/,
  );
});

for (const name of ["cloud-entry.sh.template"]) {
  test(`${name} renders as valid Bash without unresolved release fields`, async () => {
    const source = await readFile(`${ROOT}/scripts/offline/${name}`, "utf8");
    const rendered = renderEntryTemplate(source, {
      VERSION: "0.3.1",
      ARCH: "amd64",
      IMAGE_TAG: "0.3.1-20260730-fd049a03-amd64",
    });
    const syntax = spawnSync("bash", ["-n"], { input: rendered, encoding: "utf8" });
    assert.equal(syntax.status, 0, syntax.stderr);
    assert.doesNotMatch(rendered, /@@[A-Z_]+@@/);
    assert.doesNotMatch(rendered, /docker (?:compose )?(?:build|pull)/);
  });
}
