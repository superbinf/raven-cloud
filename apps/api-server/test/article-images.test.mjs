import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import sharp from "sharp";

import { externalizeArticleImages, optimizeArticleImage, readArticleImage, referencedArticleImageNames, storeArticleImage } from "../src/article-images.mjs";

const onePixelPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLkVQAAAABJRU5ErkJggg==", "base64");

test("文章 Base64 图片外置存储并改写为可同步引用", async (t) => {
  const directory = await mkdtemp(join(os.tmpdir(), "sentinel-article-images-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const html = `<p>正文</p><img src="data:image/png;base64,${onePixelPng.toString("base64")}" alt="示例">`;
  const migrated = externalizeArticleImages(html, directory);
  assert.doesNotMatch(migrated.html, /data:image\//u);
  assert.equal(migrated.images.length, 1);
  assert.match(migrated.html, /^<p>正文<\/p><img src="\/api\/article-images\/[a-f0-9]{64}\.png" alt="示例">$/u);
  const names = referencedArticleImageNames(migrated.html);
  assert.deepEqual(names, [migrated.images[0].name]);
  const image = readArticleImage(directory, names[0]);
  assert.equal(image.mediaType, "image/png");
  assert.deepEqual(image.content, onePixelPng);
});

test("正文大图在存储前压缩为适合云地同步的 WebP", async (t) => {
  const directory = await mkdtemp(join(os.tmpdir(), "sentinel-article-images-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const original = await sharp({ create: { width: 2400, height: 1600, channels: 3, background: { r: 26, g: 88, b: 148 } } })
    .png({ compressionLevel: 0 })
    .toBuffer();
  const optimized = await optimizeArticleImage(original, "image/png");
  const stored = storeArticleImage(directory, optimized.content, optimized.mediaType);
  const metadata = await sharp(stored.path).metadata();
  assert.equal(stored.mediaType, "image/webp");
  assert.ok(stored.sizeBytes < original.length);
  assert.ok(Math.max(metadata.width, metadata.height) <= 1920);
  assert.equal(stored.sha256, stored.name.slice(0, 64));
});
