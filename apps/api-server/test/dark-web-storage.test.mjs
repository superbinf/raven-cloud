import assert from "node:assert/strict";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readDarkWebBlob, storePlainDarkWebBlob } from "../src/dark-web-storage.mjs";

test("暗网文件以 SHA-256 内容寻址并明文落盘", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sentinel-dark-web-storage-"));
  const buffer = Buffer.from("dark-web plain file");
  const file = { buffer, sha256: createHash("sha256").update(buffer).digest("hex") };
  const stored = storePlainDarkWebBlob(directory, file);
  assert.equal(stored.storedName, `${file.sha256}.blob`);
  assert.equal(stored.created, true);
  assert.deepEqual(await readFile(stored.storedPath), buffer);
  assert.deepEqual(readDarkWebBlob(directory, { stored_name: stored.storedName, iv_b64: "", auth_tag_b64: "" }), buffer);
  assert.equal(storePlainDarkWebBlob(directory, file).created, false);
});

test("历史 AES-GCM 暗网文件仍可读取", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sentinel-dark-web-legacy-"));
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const source = Buffer.from("legacy encrypted file");
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(source), cipher.final()]);
  await writeFile(join(directory, "legacy.enc"), encrypted);
  assert.deepEqual(readDarkWebBlob(directory, {
    stored_name: "legacy.enc",
    iv_b64: iv.toString("base64"),
    auth_tag_b64: cipher.getAuthTag().toString("base64")
  }, key), source);
});
