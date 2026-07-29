import { isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns";
import http from "node:http";
import https from "node:https";
import { DOMParser } from "@xmldom/xmldom";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const SVG_MAX_BYTES = 256 * 1024;
const SVG_ELEMENTS = new Set([
  "svg", "g", "path", "circle", "rect", "line", "polyline", "polygon", "ellipse",
  "title", "desc", "defs", "linearGradient", "radialGradient", "stop", "clipPath"
]);
const SVG_ATTRIBUTES = new Set([
  "xmlns", "viewBox", "width", "height", "preserveAspectRatio", "id",
  "fill", "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-linecap",
  "stroke-linejoin", "stroke-miterlimit", "stroke-dasharray", "stroke-dashoffset",
  "stroke-opacity", "clip-rule", "clip-path", "opacity", "color", "d", "points",
  "transform", "x", "y", "x1", "x2", "y1", "y2", "cx", "cy", "r", "rx", "ry",
  "gradientUnits", "gradientTransform", "spreadMethod", "offset", "stop-color", "stop-opacity"
]);
const SVG_LOCAL_URL_ATTRIBUTES = new Set(["fill", "stroke", "clip-path"]);

function svgSecurityError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

export function isSvgIconContent(content, mediaType = "") {
  const declared = String(mediaType || "").split(";", 1)[0].trim().toLowerCase();
  if (declared === "image/svg+xml") return true;
  const text = Buffer.from(content || "").toString("utf8").replace(/^\uFEFF/, "").trimStart();
  return text.startsWith("<") && /<svg(?:\s|>)/i.test(text);
}

export function assertSafeSvgIcon(content, { maxBytes = SVG_MAX_BYTES, statusCode = 400 } = {}) {
  const buffer = Buffer.from(content || "");
  if (!buffer.length || buffer.length > maxBytes) throw svgSecurityError("SVG 图标大小不合法", statusCode);
  const text = buffer.toString("utf8").replace(/^\uFEFF/, "");
  if (text.includes("\u0000") || text.includes("\uFFFD")) throw svgSecurityError("SVG 图标编码不合法", statusCode);
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(text)) throw svgSecurityError("SVG 图标不允许 DTD 或实体声明", statusCode);

  const parseErrors = [];
  const document = new DOMParser({
    errorHandler: {
      warning: (message) => parseErrors.push(message),
      error: (message) => parseErrors.push(message),
      fatalError: (message) => parseErrors.push(message)
    }
  }).parseFromString(text, "image/svg+xml");
  if (parseErrors.length || !document?.documentElement) throw svgSecurityError("SVG 图标结构不合法", statusCode);
  const root = document.documentElement;
  if (root.localName !== "svg" || root.namespaceURI !== SVG_NAMESPACE) throw svgSecurityError("SVG 图标必须包含标准 svg 根元素", statusCode);
  for (const node of Array.from(document.childNodes || [])) {
    if (node === root || node.nodeType === 8 || (node.nodeType === 3 && !String(node.nodeValue || "").trim())) continue;
    if (node.nodeType === 7 && node.nodeName.toLowerCase() === "xml") continue;
    throw svgSecurityError("SVG 图标包含不允许的 XML 文档节点", statusCode);
  }

  const inspect = (node, parentElement = null) => {
    if (node.nodeType === 1) {
      if (node.namespaceURI !== SVG_NAMESPACE || !SVG_ELEMENTS.has(node.localName)) {
        throw svgSecurityError(`SVG 图标包含不允许的元素：${node.nodeName}`, statusCode);
      }
      for (const attribute of Array.from(node.attributes || [])) {
        const name = attribute.name;
        const value = String(attribute.value || "").trim();
        if (/^on/i.test(name) || name === "style" || name === "href" || name.endsWith(":href")) {
          throw svgSecurityError(`SVG 图标包含不允许的属性：${name}`, statusCode);
        }
        if (!SVG_ATTRIBUTES.has(name)) throw svgSecurityError(`SVG 图标包含不允许的属性：${name}`, statusCode);
        if (name === "xmlns") {
          if (node !== root || value !== SVG_NAMESPACE) throw svgSecurityError("SVG 命名空间不合法", statusCode);
          continue;
        }
        if (attribute.namespaceURI || attribute.prefix) throw svgSecurityError(`SVG 图标包含不允许的命名空间属性：${name}`, statusCode);
        if (/\b(?:javascript|vbscript|data|https?):|(^|[\s"'])\/\//i.test(value)) {
          throw svgSecurityError(`SVG 图标属性包含外部或可执行引用：${name}`, statusCode);
        }
        if (/url\s*\(/i.test(value) && !(SVG_LOCAL_URL_ATTRIBUTES.has(name) && /^url\(#[A-Za-z_][\w:.-]{0,127}\)$/.test(value))) {
          throw svgSecurityError(`SVG 图标属性包含不安全的资源引用：${name}`, statusCode);
        }
        if (name === "id" && !/^[A-Za-z_][\w:.-]{0,127}$/.test(value)) throw svgSecurityError("SVG 图标 id 不合法", statusCode);
      }
      for (const child of Array.from(node.childNodes || [])) inspect(child, node);
      return;
    }
    if (node.nodeType === 3 || node.nodeType === 4) {
      if (String(node.nodeValue || "").trim() && !["title", "desc"].includes(parentElement?.localName)) {
        throw svgSecurityError("SVG 图标包含不允许的文本内容", statusCode);
      }
      return;
    }
    if (node.nodeType !== 8) throw svgSecurityError("SVG 图标包含不允许的 XML 节点", statusCode);
  };
  inspect(root);
  return buffer;
}

export function svgIconResponseHeaders() {
  return {
    "Content-Security-Policy": "default-src 'none'; style-src 'none'; script-src 'none'; img-src 'none'; object-src 'none'; sandbox",
    "Cross-Origin-Resource-Policy": "same-origin",
    "X-Content-Type-Options": "nosniff"
  };
}

export const TLS_13_AES_256_GCM_OPTIONS = Object.freeze({
  minVersion: "TLSv1.3",
  maxVersion: "TLSv1.3",
  ciphers: "TLS_AES_256_GCM_SHA384",
  ecdhCurve: "X25519:P-256",
  honorCipherOrder: true
});

export function createTlsServerOptions({ certificate, privateKey, certificateAuthority } = {}) {
  if (!certificate || !privateKey) throw new Error("TLS 证书和私钥必须同时配置");
  return {
    ...TLS_13_AES_256_GCM_OPTIONS,
    cert: certificate,
    key: privateKey,
    ...(certificateAuthority ? { ca: certificateAuthority } : {})
  };
}

export function resolveTlsServerConfig({
  nodeEnv,
  certificateFile,
  privateKeyFile,
  certificateAuthorityFile,
  readFile,
  variablePrefix = "TLS"
} = {}) {
  const certFile = String(certificateFile || "").trim();
  const keyFile = String(privateKeyFile || "").trim();
  const caFile = String(certificateAuthorityFile || "").trim();
  if (Boolean(certFile) !== Boolean(keyFile)) throw new Error(`${variablePrefix}_CERT_FILE 和 ${variablePrefix}_KEY_FILE 必须同时配置`);
  if (caFile && !certFile) throw new Error(`${variablePrefix}_CA_FILE 只能与服务端证书和私钥一起配置`);
  if (!certFile) {
    if (nodeEnv === "production") throw new Error(`生产环境必须配置 ${variablePrefix}_CERT_FILE 和 ${variablePrefix}_KEY_FILE`);
    return { enabled: false, protocol: "http", serverOptions: null };
  }
  if (typeof readFile !== "function") throw new Error("TLS 证书读取器未配置");
  const certificate = readFile(certFile);
  const privateKey = readFile(keyFile);
  const certificateAuthority = caFile ? readFile(caFile) : undefined;
  return {
    enabled: true,
    protocol: "https",
    serverOptions: createTlsServerOptions({ certificate, privateKey, certificateAuthority })
  };
}

export function isLoopbackHostname(value) {
  const hostname = String(value || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "::1" || hostname === "host.docker.internal") return true;
  return isIP(hostname) === 4 && hostname.split(".")[0] === "127";
}

export function assertEncryptedHttpUrl(value, { label = "地址", allowLoopbackHttp = true } = {}) {
  let url;
  try { url = value instanceof URL ? new URL(value) : new URL(String(value || "").trim()); }
  catch { throw new Error(`${label}必须是合法的 HTTP 或 HTTPS URL`); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error(`${label}只允许不含账号密码的 HTTP 或 HTTPS URL`);
  if (url.protocol !== "https:" && !(allowLoopbackHttp && isLoopbackHostname(url.hostname))) {
    throw new Error(`${label}必须使用 HTTPS；仅本机回环地址允许 HTTP`);
  }
  return url;
}

// 判定 IP 是否落在私网/保留段（IPv4 与 IPv6，含 IPv4-mapped）。用于 SSRF 出网防护。
export function isPrivateAddress(address) {
  let value = String(address || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!value) return true;
  const zone = value.indexOf("%");
  if (zone >= 0) value = value.slice(0, zone);
  const mapped = value.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) value = mapped[1];
  const kind = isIP(value);
  if (kind === 4) {
    const parts = value.split(".").map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
    const [a, b] = parts;
    if (a === 0 || a === 127 || a === 10 || a >= 224) return true;               // this-host / loopback / RFC1918-A / 多播+保留
    if (a === 169 && b === 254) return true;                                     // 链路本地（含云元数据 169.254.169.254）
    if (a === 172 && b >= 16 && b <= 31) return true;                            // RFC1918-B
    if (a === 192 && b === 168) return true;                                     // RFC1918-C
    if (a === 100 && b >= 64 && b <= 127) return true;                           // CGNAT 100.64/10
    if (a === 192 && b === 0) return true;                                       // 192.0.0/24、192.0.2/24 等保留
    if (a === 198 && (b === 18 || b === 19)) return true;                        // 基准测试 198.18/15
    return false;
  }
  if (kind === 6) {
    if (value === "::" || value === "::1") return true;                          // 未指定 / 回环
    if (value.startsWith("fe80") || value.startsWith("fc") || value.startsWith("fd")) return true; // 链路本地 / ULA
    if (value.startsWith("ff")) return true;                                     // 多播
    return false;
  }
  // 非 IP（主机名）交由调用方的 DNS pinning 解析后再判定；此处保守视为不可直连。
  return true;
}

// 解析 SSRF 出网白名单："host" 或 "host:port"，逗号分隔。命中项允许连接内网/回环地址。
export function parseHostAllowlist(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
    .map((item) => {
      const bracket = item.match(/^\[(.+)\](?::(\d+))?$/);
      if (bracket) return { host: bracket[1], port: bracket[2] ? Number(bracket[2]) : null };
      const idx = item.lastIndexOf(":");
      if (idx > 0 && /^\d+$/.test(item.slice(idx + 1))) return { host: item.slice(0, idx), port: Number(item.slice(idx + 1)) };
      return { host: item, port: null };
    });
}

export function isHostAllowlisted(host, port, allowlist = []) {
  const target = String(host || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  const targetPort = Number(port) || null;
  return allowlist.some((entry) => entry.host === target && (entry.port === null || entry.port === targetPort));
}

function guardedResponse(status, headers, buffer) {
  const get = (name) => {
    const value = headers[String(name).toLowerCase()];
    return Array.isArray(value) ? value.join(", ") : (value ?? null);
  };
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get },
    async text() { return buffer.toString("utf8"); },
    async json() { return JSON.parse(buffer.toString("utf8")); },
    async arrayBuffer() { return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength); }
  };
}

// 带 DNS pinning 的最小 fetch 兼容客户端：校验用的解析地址与建连地址同址，杜绝 rebinding TOCTOU。
export function createGuardedHttpClient({ allowlist = [], allowLoopback = false, maxBytes = 5 * 1024 * 1024, maxRedirects = 0, redirect = "error" } = {}) {
  const request = (rawUrl, { method = "GET", headers = {}, body, signal, timeoutMs = 15_000 } = {}, depth = 0) => new Promise((resolve, reject) => {
    let url;
    try { url = rawUrl instanceof URL ? new URL(rawUrl.toString()) : new URL(String(rawUrl || "").trim()); }
    catch { reject(Object.assign(new Error("请求地址不合法"), { statusCode: 400 })); return; }
    if (url.protocol !== "http:" && url.protocol !== "https:") { reject(Object.assign(new Error("仅支持 HTTP 或 HTTPS"), { statusCode: 400 })); return; }
    if (url.username || url.password) { reject(Object.assign(new Error("地址不允许内嵌账号密码"), { statusCode: 400 })); return; }
    if (signal?.aborted) { reject(Object.assign(new Error("请求已取消"), { name: "AbortError" })); return; }
    const isHttps = url.protocol === "https:";
    const port = url.port ? Number(url.port) : (isHttps ? 443 : 80);
    const internalAllowed = allowLoopback || isHostAllowlisted(url.hostname, port, allowlist);
    // 字面量 IP 不经过自定义 lookup（Node 直接建连），必须在请求前显式校验，否则 http://127.0.0.1:* 会绕过 DNS pinning。
    if (isIP(url.hostname) !== 0 && !internalAllowed && isPrivateAddress(url.hostname)) {
      reject(Object.assign(new Error(`不允许访问内网或保留地址（${url.hostname}）`), { statusCode: 400 })); return;
    }
    const pinnedLookup = (hostname, options, callback) => {
      const cb = typeof options === "function" ? options : callback;
      const opts = typeof options === "function" ? {} : (options || {});
      dnsLookup(hostname, { all: true, family: opts.family, hints: opts.hints }, (error, addresses) => {
        if (error) { cb(error); return; }
        const list = Array.isArray(addresses) ? addresses : (addresses ? [addresses] : []);
        if (!list.length) { cb(Object.assign(new Error("域名解析结果为空"), { statusCode: 502 })); return; }
        if (!internalAllowed) {
          const blocked = list.find((entry) => isPrivateAddress(entry.address));
          if (blocked) { cb(Object.assign(new Error(`不允许访问内网或保留地址（${blocked.address}）`), { statusCode: 400 })); return; }
        }
        if (opts.all) cb(null, list);
        else cb(null, list[0].address, list[0].family);
      });
    };
    const client = isHttps ? https : http;
    let settled = false;
    const done = (fn, value) => { if (settled) return; settled = true; fn(value); };
    const req = client.request(url, { method, headers, lookup: pinnedLookup }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        if (redirect === "manual") { const chunks = []; res.on("data", (c) => chunks.push(c)); res.on("end", () => done(resolve, guardedResponse(status, res.headers, Buffer.concat(chunks)))); return; }
        if (redirect === "error" || depth >= maxRedirects) { done(reject, Object.assign(new Error("上游发生不被允许的重定向"), { statusCode: 502 })); return; }
        let next;
        try { next = new URL(res.headers.location, url); } catch { done(reject, Object.assign(new Error("重定向地址不合法"), { statusCode: 502 })); return; }
        request(next, { method, headers, body, signal, timeoutMs }, depth + 1).then((value) => done(resolve, value), (error) => done(reject, error));
        return;
      }
      const chunks = [];
      let total = 0;
      res.on("data", (chunk) => {
        total += chunk.length;
        if (total > maxBytes) { done(reject, Object.assign(new Error("上游响应超过大小限制"), { statusCode: 413 })); try { req.destroy(); } catch {} return; }
        chunks.push(chunk);
      });
      res.on("end", () => done(resolve, guardedResponse(status, res.headers, Buffer.concat(chunks))));
      res.on("error", (error) => done(reject, error));
    });
    const onAbort = () => req.destroy(Object.assign(new Error("请求已取消"), { name: "AbortError" }));
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error("上游请求超时"), { name: "AbortError" })));
    req.on("error", (error) => { if (signal) signal.removeEventListener("abort", onAbort); done(reject, error); });
    req.on("close", () => { if (signal) signal.removeEventListener("abort", onAbort); });
    if (body !== undefined && body !== null) req.write(typeof body === "string" || Buffer.isBuffer(body) ? body : Buffer.from(body));
    req.end();
  });
  return request;
}
