import assert from "node:assert/strict";
import test from "node:test";
import { createOtpAuthUri, verifyTotpCode } from "../src/modules/auth/totp.mjs";

test("TOTP verifier accepts RFC SHA1 vector truncated to six digits", () => {
  const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  assert.equal(verifyTotpCode({ secret, code: "287082", now: 59_000, window: 0 }), true);
  assert.equal(verifyTotpCode({ secret, code: "287083", now: 59_000, window: 0 }), false);
});

test("otpauth URI contains the issuer, account and base32 secret", () => {
  const secret = "JBSWY3DPEHPK3PXP";
  const uri = createOtpAuthUri({ issuer: "Sentinel", account: "analyst", secret });
  assert.match(uri, /^otpauth:\/\/totp\//);
  assert.match(uri, /secret=JBSWY3DPEHPK3PXP/);
  assert.match(uri, /issuer=Sentinel/);
});
