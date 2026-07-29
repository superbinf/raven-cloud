import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const periodSeconds = 30;

export function createTotpSecret(bytes = 20) {
  const value = randomBytes(bytes);
  let bits = 0;
  let bitLength = 0;
  let output = "";
  for (const byte of value) {
    bits = (bits << 8) | byte;
    bitLength += 8;
    while (bitLength >= 5) {
      output += alphabet[(bits >>> (bitLength - 5)) & 31];
      bitLength -= 5;
    }
  }
  if (bitLength > 0) output += alphabet[(bits << (5 - bitLength)) & 31];
  return output;
}

function decodeBase32(value) {
  const normalized = String(value || "").replace(/[\s=-]/g, "").toUpperCase();
  let bits = 0;
  let bitLength = 0;
  const bytes = [];
  for (const character of normalized) {
    const index = alphabet.indexOf(character);
    if (index < 0) throw new Error("TOTP 密钥格式不合法");
    bits = (bits << 5) | index;
    bitLength += 5;
    if (bitLength >= 8) {
      bytes.push((bits >>> (bitLength - 8)) & 255);
      bitLength -= 8;
    }
  }
  return Buffer.from(bytes);
}

function hotp(secret, counter) {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", decodeBase32(secret)).update(buffer).digest();
  const offset = digest[digest.length - 1] & 0xf;
  const value = ((digest[offset] & 0x7f) << 24) | ((digest[offset + 1] & 0xff) << 16) | ((digest[offset + 2] & 0xff) << 8) | (digest[offset + 3] & 0xff);
  return String(value % 1_000_000).padStart(6, "0");
}

export function generateTotpCode({ secret, now = Date.now() }) {
  return hotp(secret, Math.floor(now / 1000 / periodSeconds));
}

export function verifyTotpCode({ secret, code, now = Date.now(), window = 1 }) {
  const normalized = String(code || "").replace(/\s+/g, "");
  if (!/^\d{6}$/.test(normalized)) return false;
  const expected = Buffer.from(normalized);
  const counter = Math.floor(now / 1000 / periodSeconds);
  for (let offset = -window; offset <= window; offset += 1) {
    const candidate = Buffer.from(hotp(secret, counter + offset));
    if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) return true;
  }
  return false;
}

export function createOtpAuthUri({ issuer = "Sentinel", account, secret }) {
  const label = `${issuer}:${String(account || "").trim()}`;
  const params = new URLSearchParams({ secret, issuer, algorithm: "SHA1", digits: "6", period: String(periodSeconds) });
  return `otpauth://totp/${encodeURIComponent(label)}?${params.toString()}`;
}
