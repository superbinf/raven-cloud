import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

const mimeTypes = Object.freeze({
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2"
});
const developmentPathPrefixes = Object.freeze(["/@fs", "/@vite", "/node_modules", "/src"]);

function safePath(root, pathname) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); }
  catch { return null; }
  const relative = decoded.replace(/^[/\\]+/u, "");
  const candidate = resolve(root, relative || "index.html");
  return candidate === root || candidate.startsWith(`${root}${sep}`) ? candidate : null;
}

async function fileDetails(path) {
  try {
    const details = await stat(path);
    return details.isFile() ? details : null;
  } catch {
    return null;
  }
}

export function createStaticSiteHandler(directory) {
  if (!directory) return null;
  const root = resolve(directory);
  const indexPath = resolve(root, "index.html");

  return async function serveStaticSite(req, res, pathname) {
    if (!["GET", "HEAD"].includes(req.method)) return false;
    if (developmentPathPrefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))) return false;
    const requestedPath = safePath(root, pathname);
    if (!requestedPath) return false;

    let path = requestedPath;
    let details = await fileDetails(path);
    if (!details) {
      if (extname(pathname)) return false;
      path = indexPath;
      details = await fileDetails(path);
    }
    if (!details) return false;

    const extension = extname(path).toLowerCase();
    res.writeHead(200, {
      "Cache-Control": extension === ".html" ? "no-cache" : "public, max-age=31536000, immutable",
      "Content-Length": details.size,
      "Content-Type": mimeTypes[extension] || "application/octet-stream",
      "X-Content-Type-Options": "nosniff"
    });
    if (req.method === "HEAD") res.end();
    else createReadStream(path).pipe(res);
    return true;
  };
}
