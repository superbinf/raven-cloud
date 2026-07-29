import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { deflateSync } from "node:zlib";

const CAPTCHA_LENGTH = 4;
const CAPTCHA_TTL_SECONDS = 120;
const WIDTH = 170;
const HEIGHT = 52;
const CAPTCHA_DIGITS = "0123456789";
const CAPTCHA_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const CAPTCHA_CHARACTERS = `${CAPTCHA_DIGITS}${CAPTCHA_LETTERS}`;
const glyphs = {
  "0": ["11111", "10001", "10011", "10101", "11001", "10001", "11111"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["11110", "00001", "00001", "11110", "10000", "10000", "11111"],
  "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  "4": ["10010", "10010", "10010", "11111", "00010", "00010", "00010"],
  "5": ["11111", "10000", "10000", "11110", "00001", "00001", "11110"],
  "6": ["01111", "10000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00001", "11110"],
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  C: ["01111", "10000", "10000", "10000", "10000", "10000", "01111"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  G: ["01111", "10000", "10000", "10111", "10001", "10001", "01111"],
  H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  I: ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
  J: ["00111", "00010", "00010", "00010", "00010", "10010", "01100"],
  K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  Q: ["01110", "10001", "10001", "10001", "10101", "10010", "01101"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  W: ["10001", "10001", "10001", "10101", "10101", "10101", "01010"],
  X: ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
  Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
  Z: ["11111", "00001", "00010", "00100", "01000", "10000", "11111"]
};

if ([...CAPTCHA_CHARACTERS].some((character) => !glyphs[character])) throw new Error("captcha glyph set is incomplete");

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const normalizedCode = (value) => typeof value === "string" && value.length <= 32 ? value.trim().replace(/\s+/g, "").toUpperCase() : "";

export function deriveCaptchaAnswer(secret, captchaId) {
  const digest = createHmac("sha256", secret).update(`captcha-answer:${captchaId}`).digest();
  const answer = Array.from({ length: CAPTCHA_LENGTH }, (_, index) => CAPTCHA_CHARACTERS[digest[index] % CAPTCHA_CHARACTERS.length]);
  const letterPosition = digest[CAPTCHA_LENGTH] % CAPTCHA_LENGTH;
  let digitPosition = digest[CAPTCHA_LENGTH + 1] % (CAPTCHA_LENGTH - 1);
  if (digitPosition >= letterPosition) digitPosition += 1;
  answer[letterPosition] = CAPTCHA_LETTERS[digest[CAPTCHA_LENGTH + 2] % CAPTCHA_LETTERS.length];
  answer[digitPosition] = CAPTCHA_DIGITS[digest[CAPTCHA_LENGTH + 3] % CAPTCHA_DIGITS.length];
  return answer.join("");
}

function answerHash(secret, captchaId, answer) {
  return createHmac("sha256", secret).update(`captcha-check:${captchaId}:${normalizedCode(answer)}`).digest("hex");
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const name = Buffer.from(type, "ascii");
  const output = Buffer.alloc(data.length + 12);
  output.writeUInt32BE(data.length, 0);
  name.copy(output, 4);
  data.copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([name, data])), data.length + 8);
  return output;
}

function renderCaptchaPng(answer, entropy) {
  const pixels = Buffer.alloc(WIDTH * HEIGHT * 3);
  const setPixel = (x, y, color) => {
    if (x < 0 || y < 0 || x >= WIDTH || y >= HEIGHT) return;
    const offset = (y * WIDTH + x) * 3;
    pixels[offset] = color[0]; pixels[offset + 1] = color[1]; pixels[offset + 2] = color[2];
  };
  const fillRect = (x, y, width, height, color) => {
    for (let row = 0; row < height; row += 1) for (let column = 0; column < width; column += 1) setPixel(x + column, y + row, color);
  };
  fillRect(0, 0, WIDTH, HEIGHT, [247, 249, 252]);
  let cursor = 0;
  const next = () => entropy[cursor++ % entropy.length];
  const glyphWidth = 20;
  const glyphStep = 31;
  const answerWidth = glyphWidth + (answer.length - 1) * glyphStep;
  const answerOriginX = Math.floor((WIDTH - answerWidth) / 2);
  const cellColors = [[231, 241, 250], [241, 237, 249], [233, 246, 239], [250, 241, 230]];
  for (let index = 0; index < answer.length; index += 1) {
    fillRect(answerOriginX + index * glyphStep - 5, 4, 30, HEIGHT - 8, cellColors[index % cellColors.length]);
  }
  for (let line = 0; line < 3; line += 1) {
    const shade = 175 + next() % 35;
    const color = [shade, shade + 4, Math.min(235, shade + 15)];
    let x = 0; let y = 5 + next() % (HEIGHT - 10); const slope = (next() % 7) - 3;
    while (x < WIDTH) { setPixel(x, Math.round(y), color); y += slope / 38; x += 1; }
  }
  for (let dot = 0; dot < 90; dot += 1) {
    const shade = 175 + next() % 55;
    setPixel(next() % WIDTH, next() % HEIGHT, [shade, Math.min(235, shade + 6), Math.min(240, shade + 12)]);
  }
  const textColors = [[19, 63, 112], [96, 42, 91], [27, 91, 69], [112, 54, 35]];
  for (let index = 0; index < answer.length; index += 1) {
    const glyph = glyphs[answer[index]];
    const originX = answerOriginX + index * glyphStep + (next() % 3) - 1;
    const originY = 8 + (next() % 3) - 1;
    const color = textColors[(index + next()) % textColors.length];
    for (let row = 0; row < glyph.length; row += 1) {
      for (let column = 0; column < glyph[row].length; column += 1) {
        if (glyph[row][column] === "1") fillRect(originX + column * 4 - 1, originY + row * 5 - 1, 6, 7, [255, 255, 255]);
      }
    }
    for (let row = 0; row < glyph.length; row += 1) {
      for (let column = 0; column < glyph[row].length; column += 1) {
        if (glyph[row][column] !== "1") continue;
        fillRect(originX + column * 4, originY + row * 5, 4, 5, color);
      }
    }
  }
  const raw = Buffer.alloc((WIDTH * 3 + 1) * HEIGHT);
  for (let y = 0; y < HEIGHT; y += 1) pixels.copy(raw, y * (WIDTH * 3 + 1) + 1, y * WIDTH * 3, (y + 1) * WIDTH * 3);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(WIDTH, 0); header.writeUInt32BE(HEIGHT, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

function captchaError() {
  return Object.assign(new Error("图形验证码错误或已失效，请刷新后重试"), { statusCode: 400, code: "CAPTCHA_INVALID" });
}

export function createCaptchaService({ repository, secret, ttlSeconds = CAPTCHA_TTL_SECONDS, now = () => Date.now(), random = randomBytes }) {
  if (!repository?.create || !repository?.consume) throw new TypeError("captcha repository is required");
  if (typeof secret !== "string" || secret.length < 16) throw new TypeError("captcha secret must contain at least 16 characters");
  return {
    async issue() {
      const captchaId = random(32).toString("base64url");
      const answer = deriveCaptchaAnswer(secret, captchaId);
      const expiresAt = new Date(now() + ttlSeconds * 1000).toISOString();
      await repository.create({ tokenHash: sha256(captchaId), answerHash: answerHash(secret, captchaId, answer), expiresAt });
      const image = renderCaptchaPng(answer, random(96));
      return { captchaId, image: `data:image/png;base64,${image.toString("base64")}`, expiresAt, length: CAPTCHA_LENGTH };
    },
    async verify(captchaId, captchaCode) {
      const rawId = typeof captchaId === "string" ? captchaId : "";
      const id = rawId.length <= 128 ? rawId : "";
      const stored = id ? await repository.consume(sha256(id), new Date(now()).toISOString()) : null;
      const submittedHash = answerHash(secret, id, captchaCode);
      const expected = Buffer.from(String(stored?.answer_hash || stored?.answerHash || ""), "hex");
      const actual = Buffer.from(submittedHash, "hex");
      if (normalizedCode(captchaCode).length !== CAPTCHA_LENGTH || expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw captchaError();
      return true;
    }
  };
}
