import type { EdgeSnapshotV1, SnapshotManifestV1 } from "@sentinel/contracts";

export type KeyMaterial = Uint8Array | string;
export interface SnapshotKeyContext { tenantId: string; deploymentId: string }
export interface SnapshotKeys { readonly contentEncryptionKey: Uint8Array; readonly manifestHmacKey: Uint8Array }

export class SnapshotDistributionError extends Error {
  readonly code: string;
}

export function canonicalStringify(value: unknown): string;
export function canonicalSerialize(value: unknown): Uint8Array;
export function parseCanonicalJson(input: Uint8Array): unknown;
export function gzipBytes(input: Uint8Array): Uint8Array;
export function gunzipBytes(input: Uint8Array, options?: { maxOutputBytes?: number }): Uint8Array;
export function sha256(input: Uint8Array): Uint8Array;
export function sha256Hex(input: Uint8Array): string;
export function deriveSnapshotKeys(rootSecret: KeyMaterial, context: SnapshotKeyContext): SnapshotKeys;
export function encryptAes256Gcm(
  plaintext: Uint8Array,
  key: Uint8Array,
  options?: { iv?: Uint8Array; additionalData?: Uint8Array }
): Uint8Array;
export function decryptAes256Gcm(
  content: Uint8Array,
  key: Uint8Array,
  options?: { additionalData?: Uint8Array }
): Uint8Array;
export function signManifest(manifest: Omit<SnapshotManifestV1, "signature"> | SnapshotManifestV1, manifestHmacKey: Uint8Array): string;
export function verifyManifest(manifest: unknown, manifestHmacKey: Uint8Array): SnapshotManifestV1;
export function assertSnapshotContent(manifest: unknown, content: Uint8Array): Uint8Array;

export function buildEncryptedSnapshot(options: {
  snapshot: EdgeSnapshotV1;
  rootSecret: KeyMaterial;
  iv?: Uint8Array;
  fileName?: string;
}): Readonly<{ manifest: SnapshotManifestV1; content: Uint8Array }>;

export function verifyAndDecryptSnapshot(options: {
  manifest: unknown;
  content: Uint8Array;
  rootSecret: KeyMaterial;
  expectedTenantId?: string;
  expectedDeploymentId?: string;
  maxDecompressedBytes?: number;
}): EdgeSnapshotV1;
