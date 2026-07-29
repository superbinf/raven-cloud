import { createDecipheriv, createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function storePlainDarkWebBlob(directory, file) {
  const storedName = `${file.sha256}.blob`;
  const storedPath = join(directory, storedName);
  if (existsSync(storedPath)) {
    const existing = readFileSync(storedPath);
    if (sha256(existing) !== file.sha256) throw new Error(`暗网文件校验异常：${file.sha256}`);
    return { storedName, storedPath, created: false };
  }
  writeFileSync(storedPath, file.buffer, { flag: "wx", mode: 0o600 });
  return { storedName, storedPath, created: true };
}

export function readDarkWebBlob(directory, row, encryptionKey) {
  const value = readFileSync(join(directory, row.stored_name));
  if (!row.iv_b64 || !row.auth_tag_b64) return value;
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey, Buffer.from(row.iv_b64, "base64"));
  decipher.setAuthTag(Buffer.from(row.auth_tag_b64, "base64"));
  return Buffer.concat([decipher.update(value), decipher.final()]);
}

// Runtime data was moved out of the source tree. Keep pre-existing evidence readable
// during that transition without moving or mutating the original objects.
export function readDarkWebBlobFromDirectories(directories, row, encryptionKey) {
  const candidates = [...new Set((Array.isArray(directories) ? directories : [directories]).filter(Boolean))];
  for (const directory of candidates) {
    if (existsSync(join(directory, row.stored_name))) return readDarkWebBlob(directory, row, encryptionKey);
  }
  return readDarkWebBlob(candidates[0], row, encryptionKey);
}
