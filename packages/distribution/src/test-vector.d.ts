import type { EdgeSnapshotV1 } from "@sentinel/contracts";

export const snapshotVector: Readonly<EdgeSnapshotV1>;
export const rootSecretVector: string;
export const ivVector: Uint8Array;
export const expectedVector: Readonly<{
  canonicalSha256: string;
  gzipSha256: string;
  encryptionKeyHex: string;
  manifestKeyHex: string;
  contentSha256: string;
  manifestSignature: string;
  contentSize: number;
}>;
