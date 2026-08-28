import assert from "node:assert/strict";
import test from "node:test";

import {
  SnapshotDistributionError,
  buildEncryptedSnapshot,
  canonicalSerialize,
  canonicalStringify,
  decryptAes256Gcm,
  deriveSnapshotKeys,
  encryptAes256Gcm,
  gzipBytes,
  sha256Hex,
  signManifest,
  verifyAndDecryptSnapshot
} from "../src/index.mjs";
import { expectedVector, ivVector, rootSecretVector, snapshotVector } from "../src/test-vector.mjs";

test("canonical JSON sorts object keys and rejects non-JSON values", () => {
  assert.equal(canonicalStringify({ z: 1, nested: { b: 2, a: 1 }, a: -0 }), '{"a":0,"nested":{"a":1,"b":2},"z":1}');
  assert.throws(() => canonicalStringify({ value: undefined }), /not JSON serializable/u);
  assert.throws(() => canonicalStringify({ value: Number.NaN }), /finite JSON number/u);
});

test("AES-256-GCM authenticates ciphertext and additional data", () => {
  const key = Uint8Array.from({ length: 32 }, (_, index) => index);
  const additionalData = canonicalSerialize({ deploymentId: "EDGE-CQ-001", version: 7 });
  const plaintext = canonicalSerialize({ message: "云地快照" });
  const encrypted = encryptAes256Gcm(plaintext, key, { iv: ivVector, additionalData });
  assert.deepEqual(decryptAes256Gcm(encrypted, key, { additionalData }), plaintext);
  assert.throws(
    () => decryptAes256Gcm(encrypted, key, { additionalData: canonicalSerialize({ deploymentId: "EDGE-CQ-002", version: 7 }) }),
    (value) => value instanceof SnapshotDistributionError && value.code === "AUTHENTICATION_FAILED"
  );
});

test("shared vector fixes canonical, gzip, HKDF, encrypted content and manifest bytes", () => {
  const canonical = canonicalSerialize(snapshotVector);
  const compressed = gzipBytes(canonical);
  const keys = deriveSnapshotKeys(rootSecretVector, { tenantId: snapshotVector.tenant.id, deploymentId: snapshotVector.deploymentId });
  const built = buildEncryptedSnapshot({ snapshot: snapshotVector, rootSecret: rootSecretVector, iv: ivVector });

  assert.equal(sha256Hex(canonical), expectedVector.canonicalSha256);
  assert.equal(compressed[9], 19);
  assert.equal(sha256Hex(compressed), expectedVector.gzipSha256);
  assert.equal(Buffer.from(keys.contentEncryptionKey).toString("hex"), expectedVector.encryptionKeyHex);
  assert.equal(Buffer.from(keys.manifestHmacKey).toString("hex"), expectedVector.manifestKeyHex);
  assert.equal(built.manifest.sha256, expectedVector.contentSha256);
  assert.equal(built.manifest.signature, expectedVector.manifestSignature);
  assert.equal(built.content.byteLength, expectedVector.contentSize);
  assert.deepEqual(verifyAndDecryptSnapshot({
    ...built,
    rootSecret: rootSecretVector,
    expectedTenantId: snapshotVector.tenant.id,
    expectedDeploymentId: snapshotVector.deploymentId
  }), snapshotVector);
});

test("verification rejects identity, manifest, digest and GCM tampering before returning data", () => {
  const built = buildEncryptedSnapshot({ snapshot: snapshotVector, rootSecret: rootSecretVector, iv: ivVector });

  assert.throws(
    () => verifyAndDecryptSnapshot({ ...built, rootSecret: rootSecretVector, expectedTenantId: "TENANT-OTHER" }),
    (value) => value instanceof SnapshotDistributionError && value.code === "TENANT_MISMATCH"
  );

  const badManifest = { ...built.manifest, recordCounts: { ...built.manifest.recordCounts, monitoringTargets: 2 } };
  assert.throws(
    () => verifyAndDecryptSnapshot({ manifest: badManifest, content: built.content, rootSecret: rootSecretVector }),
    (value) => value instanceof SnapshotDistributionError && value.code === "INVALID_MANIFEST_SIGNATURE"
  );

  const badContent = Uint8Array.from(built.content);
  badContent[badContent.length - 1] ^= 1;
  assert.throws(
    () => verifyAndDecryptSnapshot({ manifest: built.manifest, content: badContent, rootSecret: rootSecretVector }),
    (value) => value instanceof SnapshotDistributionError && value.code === "CONTENT_DIGEST_MISMATCH"
  );

  const wrongSecret = "abcdef0123456789abcdef0123456789";
  assert.throws(
    () => verifyAndDecryptSnapshot({ ...built, rootSecret: wrongSecret }),
    (value) => value instanceof SnapshotDistributionError && value.code === "INVALID_MANIFEST_SIGNATURE"
  );

  const keys = deriveSnapshotKeys(rootSecretVector, { tenantId: snapshotVector.tenant.id, deploymentId: snapshotVector.deploymentId });
  const resignedBadCounts = {
    ...badManifest,
    signature: signManifest(badManifest, keys.manifestHmacKey)
  };
  assert.throws(
    () => verifyAndDecryptSnapshot({ manifest: resignedBadCounts, content: built.content, rootSecret: rootSecretVector }),
    (value) => value instanceof SnapshotDistributionError && value.code === "RECORD_COUNT_MISMATCH"
  );
});

test("gunzip output is bounded", () => {
  const built = buildEncryptedSnapshot({ snapshot: snapshotVector, rootSecret: rootSecretVector, iv: ivVector });
  assert.throws(
    () => verifyAndDecryptSnapshot({ ...built, rootSecret: rootSecretVector, maxDecompressedBytes: 10 }),
    (value) => value instanceof SnapshotDistributionError && value.code === "INVALID_GZIP"
  );
});
