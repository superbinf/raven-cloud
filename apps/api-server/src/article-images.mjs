import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseFragment, serialize } from "parse5";
import sharp from "sharp";

export const ARTICLE_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const ARTICLE_IMAGE_UPLOAD_MAX_BYTES = 15 * 1024 * 1024;
export const ARTICLE_IMAGE_ROUTE = "/api/article-images/";
const ARTICLE_IMAGE_MAX_DIMENSION = 1920;
const ARTICLE_IMAGE_MAX_PIXELS = 40_000_000;

const imageTypes = Object.freeze({
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp"
});

function detectedMediaType(content) {
  if (content.length >= 8 && content.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return "image/png";
  if (content.length >= 3 && content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff) return "image/jpeg";
  if (content.length >= 6 && ["GIF87a", "GIF89a"].includes(content.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (content.length >= 12 && content.subarray(0, 4).toString("ascii") === "RIFF" && content.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return "";
}

export async function optimizeArticleImage(input, requestedMediaType = "") {
  const content = Buffer.isBuffer(input) ? input : Buffer.from(input || []);
  if (!content.length) throw Object.assign(new Error("文章图片不能为空"), { statusCode: 400 });
  if (content.length > ARTICLE_IMAGE_UPLOAD_MAX_BYTES) throw Object.assign(new Error("单张文章原图不能超过 15MB"), { statusCode: 413 });
  const mediaType = detectedMediaType(content);
  if (!mediaType || !imageTypes[mediaType]) throw Object.assign(new Error("文章图片仅支持 PNG、JPEG、GIF 或 WebP"), { statusCode: 400 });
  if (requestedMediaType && imageTypes[requestedMediaType] && requestedMediaType !== mediaType) {
    throw Object.assign(new Error("文章图片内容与声明类型不一致"), { statusCode: 400 });
  }

  try {
    const image = sharp(content, {
      animated: mediaType === "image/gif" || mediaType === "image/webp",
      limitInputPixels: ARTICLE_IMAGE_MAX_PIXELS
    });
    const metadata = await image.metadata();
    const optimized = await image
      .rotate()
      .resize({ width: ARTICLE_IMAGE_MAX_DIMENSION, height: ARTICLE_IMAGE_MAX_DIMENSION, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 82, alphaQuality: 88, effort: 4, smartSubsample: true })
      .toBuffer();
    if (optimized.length < content.length || Math.max(metadata.width || 0, metadata.height || 0) > ARTICLE_IMAGE_MAX_DIMENSION) {
      return { content: optimized, mediaType: "image/webp", originalSizeBytes: content.length };
    }
    return { content, mediaType, originalSizeBytes: content.length };
  } catch (cause) {
    throw Object.assign(new Error("图片无法解码或尺寸过大，请压缩后重试"), { statusCode: 400, cause });
  }
}

export function articleImageName(value) {
  const name = String(value || "").trim().toLowerCase();
  return /^[a-f0-9]{64}\.(?:png|jpg|gif|webp)$/u.test(name) ? name : "";
}

export function articleImageMediaType(name) {
  return { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp" }[String(name).split(".").at(-1)] || "";
}

export function storeArticleImage(directory, input, requestedMediaType = "") {
  const content = Buffer.isBuffer(input) ? input : Buffer.from(input || []);
  if (!content.length) throw Object.assign(new Error("文章图片不能为空"), { statusCode: 400 });
  if (content.length > ARTICLE_IMAGE_MAX_BYTES) throw Object.assign(new Error("单张文章图片不能超过 5MB"), { statusCode: 413 });
  const mediaType = detectedMediaType(content);
  if (!mediaType || !imageTypes[mediaType]) throw Object.assign(new Error("文章图片仅支持 PNG、JPEG、GIF 或 WebP"), { statusCode: 400 });
  if (requestedMediaType && imageTypes[requestedMediaType] && requestedMediaType !== mediaType) {
    throw Object.assign(new Error("文章图片内容与声明类型不一致"), { statusCode: 400 });
  }
  const sha256 = createHash("sha256").update(content).digest("hex");
  const name = `${sha256}.${imageTypes[mediaType]}`;
  mkdirSync(directory, { recursive: true });
  const path = join(directory, name);
  if (!existsSync(path)) writeFileSync(path, content, { flag: "wx", mode: 0o600 });
  else if (createHash("sha256").update(readFileSync(path)).digest("hex") !== sha256) throw new Error(`文章图片校验异常：${name}`);
  return { name, path, mediaType, sizeBytes: content.length, sha256, location: `${ARTICLE_IMAGE_ROUTE}${name}` };
}

function imageNodes(node, output = []) {
  if (node?.tagName === "img") output.push(node);
  for (const child of node?.childNodes || []) imageNodes(child, output);
  if (node?.content) imageNodes(node.content, output);
  return output;
}

function portableLocation(value) {
  const match = String(value || "").match(/(?:^|https?:\/\/[^/]+)\/api\/article-images\/([a-f0-9]{64}\.(?:png|jpg|gif|webp))$/iu);
  return match ? `${ARTICLE_IMAGE_ROUTE}${match[1].toLowerCase()}` : "";
}

export function externalizeArticleImages(html, directory) {
  const source = String(html || "");
  if (!/<img\b/iu.test(source)) return { html: source, images: [] };
  const fragment = parseFragment(source);
  const images = [];
  let changed = false;
  for (const node of imageNodes(fragment)) {
    const sourceAttribute = node.attrs?.find((attribute) => attribute.name.toLowerCase() === "src");
    if (!sourceAttribute) continue;
    const data = sourceAttribute.value.match(/^data:(image\/(?:png|jpeg|gif|webp));base64,([a-z0-9+/=\s]+)$/iu);
    if (data) {
      const stored = storeArticleImage(directory, Buffer.from(data[2].replace(/\s/gu, ""), "base64"), data[1].toLowerCase());
      sourceAttribute.value = stored.location;
      node.attrs = node.attrs.filter((attribute) => attribute.name.toLowerCase() !== "srcset");
      images.push(stored);
      changed = true;
      continue;
    }
    const portable = portableLocation(sourceAttribute.value);
    if (portable && portable !== sourceAttribute.value) {
      sourceAttribute.value = portable;
      changed = true;
    }
  }
  return { html: changed ? serialize(fragment) : source, images };
}

export function referencedArticleImageNames(html) {
  const source = String(html || "");
  if (!/<img\b/iu.test(source)) return [];
  const fragment = parseFragment(source);
  const names = imageNodes(fragment).map((node) => {
    const sourceAttribute = node.attrs?.find((attribute) => attribute.name.toLowerCase() === "src");
    return articleImageName(portableLocation(sourceAttribute?.value).slice(ARTICLE_IMAGE_ROUTE.length));
  }).filter(Boolean);
  return [...new Set(names)];
}

export function readArticleImage(directory, name) {
  const safeName = articleImageName(name);
  if (!safeName) return null;
  const path = join(directory, safeName);
  if (!existsSync(path)) return null;
  const content = readFileSync(path);
  const sha256 = safeName.slice(0, 64);
  if (createHash("sha256").update(content).digest("hex") !== sha256) throw new Error(`文章图片校验异常：${safeName}`);
  return { content, path, name: safeName, mediaType: articleImageMediaType(safeName), sizeBytes: content.length, sha256 };
}

export function readArticleImageFromDirectories(directories, name) {
  for (const directory of [...new Set((Array.isArray(directories) ? directories : [directories]).filter(Boolean))]) {
    const image = readArticleImage(directory, name);
    if (image) return image;
  }
  return null;
}
