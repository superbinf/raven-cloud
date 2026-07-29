import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export function createSecretCodec(secret) {
  const encryptionKey = createHash("sha256").update(secret).digest();
  return {
    encryptionKey,
    encrypt(value) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
      const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return `${iv.toString("base64")}.${cipher.getAuthTag().toString("base64")}.${encrypted.toString("base64")}`;
    },
    decrypt(value) {
      if (!value) return "";
      const [iv, tag, encrypted] = value.split(".").map((part) => Buffer.from(part, "base64"));
      const decipher = createDecipheriv("aes-256-gcm", encryptionKey, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
    }
  };
}
