import { createHmac, timingSafeEqual } from "node:crypto";
import { createEdgeOpenApiKey, parseEdgeOpenApiKey } from "@sentinel/contracts";

const licenseKeyPrefix = "sentinel-license-v1";

export function createDeploymentApiKey(deploymentId, authenticationSecret, snapshotSecret) {
  return createEdgeOpenApiKey(deploymentId, authenticationSecret, snapshotSecret);
}

export function parseDeploymentApiKey(value) {
  const parsed = parseEdgeOpenApiKey(value);
  return parsed ? { deploymentId: parsed.deploymentId, secret: parsed.authenticationSecret } : null;
}

export function hashDeploymentSecret(secret, masterSecret) {
  return createHmac("sha256", masterSecret).update(String(secret)).digest("hex");
}

export function deploymentSecretMatches(secret, expectedHash, masterSecret) {
  if (!secret || !expectedHash) return false;
  const actual = Buffer.from(hashDeploymentSecret(secret, masterSecret), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function deploymentCredentials(req) {
  const bearer = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  const apiKey = parseDeploymentApiKey(bearer);
  if (apiKey) return apiKey;
  return { deploymentId: String(req.headers["x-edge-deployment-id"] || "").trim(), secret: bearer };
}

export function createLicenseKey(licenseId, secret) {
  return `${licenseKeyPrefix}.${Buffer.from(String(licenseId), "utf8").toString("base64url")}.${secret}`;
}

export function parseLicenseKey(value) {
  const [prefix, encodedLicenseId, secret, ...extra] = String(value || "").trim().split(".");
  if (prefix !== licenseKeyPrefix || !encodedLicenseId || !secret || extra.length) return null;
  try {
    const licenseId = Buffer.from(encodedLicenseId, "base64url").toString("utf8");
    if (!licenseId || Buffer.from(licenseId, "utf8").toString("base64url") !== encodedLicenseId) return null;
    return { licenseId, secret };
  } catch { return null; }
}

export function hashLicenseSecret(secret, masterSecret) {
  return createHmac("sha256", masterSecret).update(`license:${String(secret)}`).digest("hex");
}

export function licenseSecretMatches(secret, expectedHash, masterSecret) {
  if (!secret || !expectedHash) return false;
  const actual = Buffer.from(hashLicenseSecret(secret, masterSecret), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
