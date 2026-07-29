import assert from "node:assert/strict";
import test from "node:test";
import { createCaptchaService, deriveCaptchaAnswer } from "../src/index.mjs";

const secret = "captcha-unit-test-secret-value";

function memoryRepository() {
  const rows = new Map();
  return {
    rows,
    async create(row) { rows.set(row.tokenHash, { answer_hash: row.answerHash, expiresAt: row.expiresAt }); },
    async consume(tokenHash, now) {
      const row = rows.get(tokenHash);
      rows.delete(tokenHash);
      return row && row.expiresAt > now ? row : null;
    }
  };
}

test("captcha is a raster image and can only be consumed once", async () => {
  const repository = memoryRepository();
  const service = createCaptchaService({ repository, secret });
  const challenge = await service.issue();
  assert.match(challenge.image, /^data:image\/png;base64,/);
  const png = Buffer.from(challenge.image.split(",")[1], "base64");
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const answer = deriveCaptchaAnswer(secret, challenge.captchaId);
  assert.equal(challenge.length, 4);
  assert.match(answer, /^(?=.*[A-Z])(?=.*\d)[A-Z0-9]{4}$/);
  assert.equal(await service.verify(challenge.captchaId, answer), true);
  await assert.rejects(service.verify(challenge.captchaId, answer), { code: "CAPTCHA_INVALID" });
});

test("captcha answers use the full alphanumeric set and mix letters with digits", async () => {
  const observed = new Set();
  for (let index = 0; index < 2_000; index += 1) {
    const answer = deriveCaptchaAnswer(secret, `challenge-${index}`);
    assert.match(answer, /^(?=.*[A-Z])(?=.*\d)[A-Z0-9]{4}$/);
    for (const character of answer) observed.add(character);
  }
  assert.equal(observed.size, 36);
  const service = createCaptchaService({ repository: memoryRepository(), secret });
  const challenge = await service.issue();
  assert.equal(await service.verify(challenge.captchaId, deriveCaptchaAnswer(secret, challenge.captchaId).toLowerCase()), true);
});

test("a wrong answer consumes the challenge", async () => {
  const repository = memoryRepository();
  const service = createCaptchaService({ repository, secret });
  const challenge = await service.issue();
  await assert.rejects(service.verify(challenge.captchaId, "xxxxx"), { code: "CAPTCHA_INVALID" });
  await assert.rejects(service.verify(challenge.captchaId, deriveCaptchaAnswer(secret, challenge.captchaId)), { code: "CAPTCHA_INVALID" });
});

test("expired challenges fail with the same generic error", async () => {
  let currentTime = Date.now();
  const service = createCaptchaService({ repository: memoryRepository(), secret, ttlSeconds: 1, now: () => currentTime });
  const challenge = await service.issue();
  currentTime += 1_001;
  await assert.rejects(service.verify(challenge.captchaId, deriveCaptchaAnswer(secret, challenge.captchaId)), { code: "CAPTCHA_INVALID" });
});
