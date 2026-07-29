import {
  CLOUD_EDGE_PROTOCOL_VERSION,
  EDGE_SNAPSHOT_SCHEMA_VERSION,
  edgeSnapshotV1Schema,
  snapshotManifestV1Schema,
  snapshotRecordCounts
} from "@sentinel/contracts";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual
} from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });
const ENVELOPE_MAGIC = Buffer.from("SNTLEDG1", "ascii");
const AES_KEY_BYTES = 32;
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
const DEFAULT_MAX_DECOMPRESSED_BYTES = 512 * 1024 * 1024;
const HKDF_SALT = textEncoder.encode("sentinel-cloud-edge/v1/hkdf-salt");

export class SnapshotDistributionError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "SnapshotDistributionError";
    this.code = code;
  }
}

function error(code, message, cause) {
  throw new SnapshotDistributionError(code, message, cause === undefined ? undefined : { cause });
}

function bytes(input, name, { exact, min = 0 } = {}) {
  if (!(input instanceof Uint8Array)) error("INVALID_BYTES", `${name} must be a Uint8Array`);
  const result = input;
  if (exact !== undefined && result.byteLength !== exact) error("INVALID_BYTES", `${name} must contain exactly ${exact} bytes`);
  if (result.byteLength < min) error("INVALID_BYTES", `${name} must contain at least ${min} bytes`);
  return result;
}

function keyMaterial(input, name) {
  const result = typeof input === "string" ? textEncoder.encode(input) : bytes(input, name);
  if (result.byteLength < 32) error("WEAK_KEY_MATERIAL", `${name} must contain at least 32 bytes`);
  return result;
}

function canonicalValue(value, path, seen) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) error("NON_CANONICAL_VALUE", `${path} must be a finite JSON number`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object") error("NON_CANONICAL_VALUE", `${path} is not JSON serializable`);
  if (seen.has(value)) error("NON_CANONICAL_VALUE", `${path} contains a cycle`);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) error("NON_CANONICAL_VALUE", `${path}[${index}] is a sparse array entry`);
      }
      return value.map((item, index) => canonicalValue(item, `${path}[${index}]`, seen));
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) error("NON_CANONICAL_VALUE", `${path} must be a plain object`);
    if (Object.getOwnPropertySymbols(value).length > 0) error("NON_CANONICAL_VALUE", `${path} contains a symbol key`);
    const result = {};
    for (const key of Object.keys(value).sort()) {
      result[key] = canonicalValue(value[key], `${path}.${key}`, seen);
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

export function canonicalStringify(value) {
  return JSON.stringify(canonicalValue(value, "$", new Set()));
}

export function canonicalSerialize(value) {
  return textEncoder.encode(canonicalStringify(value));
}

export function parseCanonicalJson(input) {
  try {
    return JSON.parse(textDecoder.decode(bytes(input, "input")));
  } catch (cause) {
    if (cause instanceof SnapshotDistributionError) throw cause;
    return error("INVALID_JSON", "snapshot content is not valid UTF-8 JSON", cause);
  }
}

export function gzipBytes(input) {
  return Uint8Array.from(gzipSync(bytes(input, "input"), { level: 9, mtime: 0 }));
}

export function gunzipBytes(input, { maxOutputBytes = DEFAULT_MAX_DECOMPRESSED_BYTES } = {}) {
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) error("INVALID_LIMIT", "maxOutputBytes must be a positive safe integer");
  try {
    return Uint8Array.from(gunzipSync(bytes(input, "input"), { maxOutputLength: maxOutputBytes }));
  } catch (cause) {
    return error("INVALID_GZIP", "snapshot content is not valid gzip data or exceeds the output limit", cause);
  }
}

export function sha256(input) {
  return Uint8Array.from(createHash("sha256").update(bytes(input, "input")).digest());
}

export function sha256Hex(input) {
  return Buffer.from(sha256(input)).toString("hex");
}

function derivationInfo(purpose, context) {
  return canonicalSerialize({
    protocol: "sentinel-cloud-edge",
    protocolVersion: CLOUD_EDGE_PROTOCOL_VERSION,
    purpose,
    tenantId: context.tenantId,
    deploymentId: context.deploymentId
  });
}

function parseKeyContext(context) {
  if (context === null || typeof context !== "object" || Array.isArray(context)) error("INVALID_KEY_CONTEXT", "key context must be an object");
  for (const field of ["tenantId", "deploymentId"]) {
    if (typeof context[field] !== "string" || context[field].length === 0) error("INVALID_KEY_CONTEXT", `${field} must be a non-empty string`);
  }
  return { tenantId: context.tenantId, deploymentId: context.deploymentId };
}

export function deriveSnapshotKeys(rootSecret, contextInput) {
  const secret = keyMaterial(rootSecret, "rootSecret");
  const context = parseKeyContext(contextInput);
  const encryption = hkdfSync("sha256", secret, HKDF_SALT, derivationInfo("content-encryption", context), AES_KEY_BYTES);
  const manifest = hkdfSync("sha256", secret, HKDF_SALT, derivationInfo("manifest-hmac", context), AES_KEY_BYTES);
  return Object.freeze({
    contentEncryptionKey: encryption instanceof ArrayBuffer ? new Uint8Array(encryption) : Uint8Array.from(encryption),
    manifestHmacKey: manifest instanceof ArrayBuffer ? new Uint8Array(manifest) : Uint8Array.from(manifest)
  });
}

function encodeEnvelope(iv, tag, ciphertext) {
  return Uint8Array.from(Buffer.concat([ENVELOPE_MAGIC, Buffer.from(iv), Buffer.from(tag), Buffer.from(ciphertext)]));
}

function decodeEnvelope(input) {
  const envelope = bytes(input, "content", { min: ENVELOPE_MAGIC.length + GCM_IV_BYTES + GCM_TAG_BYTES });
  if (!timingSafeEqual(Buffer.from(envelope.subarray(0, ENVELOPE_MAGIC.length)), ENVELOPE_MAGIC)) {
    error("INVALID_ENVELOPE", "snapshot content envelope has an unsupported magic/version");
  }
  const ivStart = ENVELOPE_MAGIC.length;
  const tagStart = ivStart + GCM_IV_BYTES;
  const ciphertextStart = tagStart + GCM_TAG_BYTES;
  return {
    iv: envelope.subarray(ivStart, tagStart),
    authTag: envelope.subarray(tagStart, ciphertextStart),
    ciphertext: envelope.subarray(ciphertextStart)
  };
}

export function encryptAes256Gcm(plaintext, key, { iv = randomBytes(GCM_IV_BYTES), additionalData } = {}) {
  const encryptionKey = bytes(key, "key", { exact: AES_KEY_BYTES });
  const nonce = bytes(iv, "iv", { exact: GCM_IV_BYTES });
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, nonce, { authTagLength: GCM_TAG_BYTES });
  if (additionalData !== undefined) cipher.setAAD(bytes(additionalData, "additionalData"));
  const ciphertext = Buffer.concat([cipher.update(bytes(plaintext, "plaintext")), cipher.final()]);
  return encodeEnvelope(nonce, cipher.getAuthTag(), ciphertext);
}

export function decryptAes256Gcm(content, key, { additionalData } = {}) {
  const encryptionKey = bytes(key, "key", { exact: AES_KEY_BYTES });
  const { iv, authTag, ciphertext } = decodeEnvelope(content);
  try {
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey, iv, { authTagLength: GCM_TAG_BYTES });
    decipher.setAuthTag(authTag);
    if (additionalData !== undefined) decipher.setAAD(bytes(additionalData, "additionalData"));
    return Uint8Array.from(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
  } catch (cause) {
    return error("AUTHENTICATION_FAILED", "snapshot content authentication failed", cause);
  }
}

function unsignedManifest(manifest) {
  const { signature: _signature, ...unsigned } = manifest;
  return unsigned;
}

function manifestHmac(manifest, key) {
  return createHmac("sha256", bytes(key, "manifestHmacKey", { exact: AES_KEY_BYTES }))
    .update(canonicalSerialize(unsignedManifest(manifest)))
    .digest("hex");
}

export function signManifest(manifest, manifestHmacKey) {
  return manifestHmac(manifest, manifestHmacKey);
}

export function verifyManifest(manifestInput, manifestHmacKey) {
  const manifest = snapshotManifestV1Schema.parse(manifestInput);
  const expected = Buffer.from(manifestHmac(manifest, manifestHmacKey), "hex");
  const actual = Buffer.from(manifest.signature, "hex");
  if (!timingSafeEqual(expected, actual)) error("INVALID_MANIFEST_SIGNATURE", "manifest HMAC signature is invalid");
  return manifest;
}

export function assertSnapshotContent(manifestInput, contentInput) {
  const manifest = snapshotManifestV1Schema.parse(manifestInput);
  const content = bytes(contentInput, "content");
  if (content.byteLength !== manifest.size) {
    error("CONTENT_SIZE_MISMATCH", `snapshot content size mismatch: expected ${manifest.size}, received ${content.byteLength}`);
  }
  const digest = sha256Hex(content);
  const expected = Buffer.from(manifest.sha256, "hex");
  const actual = Buffer.from(digest, "hex");
  if (!timingSafeEqual(expected, actual)) error("CONTENT_DIGEST_MISMATCH", "snapshot content SHA-256 digest is invalid");
  return content;
}

function snapshotAdditionalData({ tenantId, deploymentId, version }) {
  return canonicalSerialize({
    protocolVersion: CLOUD_EDGE_PROTOCOL_VERSION,
    schemaVersion: EDGE_SNAPSHOT_SCHEMA_VERSION,
    tenantId,
    deploymentId,
    version,
    compression: "gzip",
    encryption: "aes-256-gcm"
  });
}

function assertIdentity(manifest, expectedTenantId, expectedDeploymentId) {
  if (expectedTenantId !== undefined && manifest.tenantId !== expectedTenantId) {
    error("TENANT_MISMATCH", `manifest tenant does not match expected tenant ${expectedTenantId}`);
  }
  if (expectedDeploymentId !== undefined && manifest.deploymentId !== expectedDeploymentId) {
    error("DEPLOYMENT_MISMATCH", `manifest deployment does not match expected deployment ${expectedDeploymentId}`);
  }
}

function assertSnapshotMatchesManifest(snapshot, manifest) {
  if (snapshot.tenant.id !== manifest.tenantId) error("TENANT_MISMATCH", "snapshot tenant does not match manifest tenant");
  if (snapshot.deploymentId !== manifest.deploymentId) error("DEPLOYMENT_MISMATCH", "snapshot deployment does not match manifest deployment");
  if (snapshot.version !== manifest.version) error("VERSION_MISMATCH", "snapshot version does not match manifest version");
  const actualCounts = snapshotRecordCounts(snapshot);
  for (const [name, expected] of Object.entries(manifest.recordCounts)) {
    if (actualCounts[name] !== expected) error("RECORD_COUNT_MISMATCH", `${name} count does not match manifest`);
  }
}

export function buildEncryptedSnapshot({ snapshot: snapshotInput, rootSecret, iv, fileName } = {}) {
  const snapshot = edgeSnapshotV1Schema.parse(snapshotInput);
  const context = { tenantId: snapshot.tenant.id, deploymentId: snapshot.deploymentId };
  const keys = deriveSnapshotKeys(rootSecret, context);
  const compressed = gzipBytes(canonicalSerialize(snapshot));
  const content = encryptAes256Gcm(compressed, keys.contentEncryptionKey, {
    ...(iv === undefined ? {} : { iv }),
    additionalData: snapshotAdditionalData({ ...context, version: snapshot.version })
  });
  const manifestWithoutSignature = {
    protocolVersion: CLOUD_EDGE_PROTOCOL_VERSION,
    schemaVersion: EDGE_SNAPSHOT_SCHEMA_VERSION,
    tenantId: context.tenantId,
    deploymentId: context.deploymentId,
    version: snapshot.version,
    createdAt: snapshot.generatedAt,
    fileName: fileName ?? `snapshot-${snapshot.version}.json.gz.enc`,
    compression: "gzip",
    encryption: "aes-256-gcm",
    size: content.byteLength,
    sha256: sha256Hex(content),
    recordCounts: snapshotRecordCounts(snapshot)
  };
  const manifest = snapshotManifestV1Schema.parse({
    ...manifestWithoutSignature,
    signature: signManifest(manifestWithoutSignature, keys.manifestHmacKey)
  });
  return Object.freeze({ manifest, content });
}

export function verifyAndDecryptSnapshot({
  manifest: manifestInput,
  content: contentInput,
  rootSecret,
  expectedTenantId,
  expectedDeploymentId,
  maxDecompressedBytes = DEFAULT_MAX_DECOMPRESSED_BYTES
} = {}) {
  const manifest = snapshotManifestV1Schema.parse(manifestInput);
  assertIdentity(manifest, expectedTenantId, expectedDeploymentId);
  const keys = deriveSnapshotKeys(rootSecret, { tenantId: manifest.tenantId, deploymentId: manifest.deploymentId });
  verifyManifest(manifest, keys.manifestHmacKey);
  const content = assertSnapshotContent(manifest, contentInput);
  const compressed = decryptAes256Gcm(content, keys.contentEncryptionKey, {
    additionalData: snapshotAdditionalData(manifest)
  });
  const snapshot = edgeSnapshotV1Schema.parse(parseCanonicalJson(gunzipBytes(compressed, { maxOutputBytes: maxDecompressedBytes })));
  assertSnapshotMatchesManifest(snapshot, manifest);
  return snapshot;
}
