import assert from "node:assert/strict";
import test from "node:test";

import {
  ContractValidationError,
  FINGERPRINT_ICON_SOURCES,
  MAX_DARK_WEB_ARTICLE_CHARS,
  createEdgeOpenApiKey,
  edgeDeploymentConfigV1Schema,
  edgeSnapshotV1Schema,
  parseEdgeOpenApiKey,
  remoteSnapshotDescriptorSchema,
  snapshotRecordCounts
} from "../src/index.mjs";

export const emptySnapshotVector = Object.freeze({
  schemaVersion: 1,
  tenant: { id: "TENANT-CHANGAN", name: "长安汽车" },
  deploymentId: "EDGE-CQ-001",
  version: 7,
  generatedAt: "2026-07-19T08:30:00.000Z",
  monitoringTargets: [],
  sensitiveRecords: [],
  assetRecords: [],
  credentialSubscriptions: [],
  credentialRecords: [],
  darkWebEvents: [],
  assetReports: [],
  fileObjects: []
});

test("provider fingerprint icons and versioned OpenAPI keys share one cloud-edge contract", () => {
  assert.equal(FINGERPRINT_ICON_SOURCES.includes("provider"), true);
  const snapshot = edgeSnapshotV1Schema.parse({
    ...emptySnapshotVector,
    fingerprintIcons: [{
      id: "FICON-PROVIDER-1", fingerprintName: "中国移动", aliases: ["CMCC"], source: "provider",
      mediaType: "image/png", iconData: "data:image/png;base64,iVBORw0KGgo=",
      iconSha256: "a".repeat(64), active: true, updatedAt: "2026-07-28T00:00:00.000Z"
    }]
  });
  assert.equal(snapshot.fingerprintIcons[0].source, "provider");

  const authenticationSecret = "a".repeat(43);
  const snapshotSecret = "s".repeat(43);
  const key = createEdgeOpenApiKey("EDGE-1", authenticationSecret, snapshotSecret);
  assert.deepEqual(parseEdgeOpenApiKey(key), { version: 2, deploymentId: "EDGE-1", authenticationSecret, snapshotSecret });
  const legacy = `sentinel-edge-v1.${Buffer.from("EDGE-1").toString("base64url")}.${authenticationSecret}`;
  assert.deepEqual(parseEdgeOpenApiKey(legacy), { version: 1, deploymentId: "EDGE-1", authenticationSecret, snapshotSecret: authenticationSecret });
  assert.equal(parseEdgeOpenApiKey(`${key}.extra`), null);
});

test("EdgeSnapshotV1 schema accepts an exact snapshot and calculates named counts", () => {
  const parsed = edgeSnapshotV1Schema.parse(emptySnapshotVector);
  assert.deepEqual(parsed, emptySnapshotVector);
  assert.deepEqual(snapshotRecordCounts(parsed), {
    monitoringTargets: 0,
    sensitiveRecords: 0,
    assetRecords: 0,
    credentialSubscriptions: 0,
    credentialRecords: 0,
    darkWebEvents: 0,
    assetReports: 0
  });
});

test("schemas reject unknown fields and report the failing path", () => {
  assert.throws(
    () => edgeSnapshotV1Schema.parse({ ...emptySnapshotVector, tenantId: "TENANT-CHANGAN" }),
    (error) => error instanceof ContractValidationError && error.retryable === false && error.errorType === "validation" && error.issues[0].includes("unexpected field(s): tenantId")
  );
  assert.throws(
    () => edgeSnapshotV1Schema.parse({ ...emptySnapshotVector, version: 0 }),
    (error) => error instanceof ContractValidationError && error.issues[0].includes("$.version")
  );
});

test("EdgeSnapshotV1 accepts a published dark-web article above the previous 100k limit", () => {
  const articleMarkdown = "A".repeat(406_122);
  const snapshot = edgeSnapshotV1Schema.parse({
    ...emptySnapshotVector,
    darkWebEvents: [{
      id: "DWE-LONG-ARTICLE", targetId: "OBJ-CHANGAN", title: "长篇行业情报", reportDate: "2026-07-21",
      sourceGroupName: "", sourceGroupId: "", sourceGroupUrl: "", messageUrl: "", intelTags: ["行业情报"],
      leakDataTypes: "", leakCount: "", transactionCount: "", transactionPrice: "", publishedAt: "2026-07-21T00:00:00.000Z",
      publisherId: "", intelNote: "", articleMarkdown, firstSeenAt: "2026-07-21T00:00:00.000Z",
      lastSeenAt: "2026-07-21T00:00:00.000Z", importCount: 1, repeatedPropagationCount: 0, files: []
    }],
    fileObjects: [{
      id: "article-image/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png", ownerType: "article-image", ownerId: "DWE-LONG-ARTICLE", kind: "image",
      name: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png", mediaType: "image/png", sizeBytes: 1,
      sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", contentLocation: "/edge/v1/files/article-image%2Faaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png/content"
    }]
  });
  assert.equal(snapshot.darkWebEvents[0].articleMarkdown.length, articleMarkdown.length);
  assert.throws(
    () => edgeSnapshotV1Schema.parse({ ...snapshot, darkWebEvents: [{ ...snapshot.darkWebEvents[0], articleMarkdown: "A".repeat(MAX_DARK_WEB_ARTICLE_CHARS + 1) }] }),
    (error) => error instanceof ContractValidationError && error.issues[0].includes("articleMarkdown")
  );
});

test("configuration and remote descriptor enforce protocol invariants", () => {
  const config = edgeDeploymentConfigV1Schema.parse({
    protocolVersion: 1,
    configVersion: 2,
    tenantId: "TENANT-CHANGAN",
    deploymentId: "EDGE-CQ-001",
    enabled: true,
    syncMode: "api_pull",
    pollIntervalSeconds: 300,
    enabledModules: ["overview", "sensitive"]
  });
  assert.equal(config.syncMode, "api_pull");
  assert.deepEqual(config.enabledModules, ["overview", "sensitive"]);
  assert.throws(() => edgeDeploymentConfigV1Schema.parse({ ...config, enabledModules: [] }), /at least one portal module/u);
  assert.throws(() => edgeDeploymentConfigV1Schema.parse({ ...config, enabledModules: ["overview", "unknown"] }), /expected one of/u);

  assert.throws(() => remoteSnapshotDescriptorSchema.parse({
    mode: "object_storage_pull",
    version: 7,
    manifestLocation: "https://objects.example/manifest",
    contentLocation: "https://objects.example/content"
  }), /urlExpiresAt/u);
});
