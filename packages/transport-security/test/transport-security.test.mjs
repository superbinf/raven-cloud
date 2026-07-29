import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer, request } from "node:https";
import test from "node:test";
import {
  TLS_13_AES_256_GCM_OPTIONS,
  assertSafeSvgIcon,
  assertEncryptedHttpUrl,
  createTlsServerOptions,
  isSvgIconContent,
  isLoopbackHostname,
  resolveTlsServerConfig,
  svgIconResponseHeaders
} from "../src/index.mjs";

test("SVG icon validation accepts a strict, inert graphics subset", () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><defs><linearGradient id="paint"><stop offset="0" stop-color="#fff"/></linearGradient></defs><path fill="url(#paint)" d="M2 2h20v20H2z"/></svg>');
  assert.deepEqual(assertSafeSvgIcon(svg), svg);
  assert.deepEqual(svgIconResponseHeaders(), {
    "Content-Security-Policy": "default-src 'none'; style-src 'none'; script-src 'none'; img-src 'none'; object-src 'none'; sandbox",
    "Cross-Origin-Resource-Policy": "same-origin",
    "X-Content-Type-Options": "nosniff"
  });
});

test("SVG icon validation rejects active content across the complete document", () => {
  const lateScript = `<svg xmlns="http://www.w3.org/2000/svg"><desc>${"A".repeat(640)}</desc><script>alert(1)</script></svg>`;
  const unsafe = [
    lateScript,
    '<svg xmlns="http://www.w3.org/2000/svg"><path onerror="alert(1)" d="M0 0"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><body xmlns="http://www.w3.org/1999/xhtml">x</body></foreignObject></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><use href="https://attacker.example/a.svg#x"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><path style="fill:url(https://attacker.example/a)" d="M0 0"/></svg>',
    '<?xml-stylesheet href="https://attacker.example/a.css"?><svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>',
    '<!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg"><desc>&xxe;</desc></svg>'
  ];
  for (const svg of unsafe) assert.throws(() => assertSafeSvgIcon(Buffer.from(svg)), /SVG/);
  assert.equal(isSvgIconContent(Buffer.from(`<!--${"A".repeat(5000)}--><svg xmlns="http://www.w3.org/2000/svg"/>`), "image/png"), true);
});

test("TLS server options pin TLS 1.3 and AES-256-GCM", () => {
  const options = createTlsServerOptions({ certificate: "certificate", privateKey: "private-key" });
  assert.equal(options.minVersion, "TLSv1.3");
  assert.equal(options.maxVersion, "TLSv1.3");
  assert.equal(options.ciphers, "TLS_AES_256_GCM_SHA384");
  assert.equal(options.ecdhCurve, "X25519:P-256");
  assert.equal(TLS_13_AES_256_GCM_OPTIONS.honorCipherOrder, true);
});

test("TLS server options reject incomplete key material", () => {
  assert.throws(() => createTlsServerOptions({ certificate: "certificate" }), /证书和私钥/);
  assert.throws(() => createTlsServerOptions({ privateKey: "private-key" }), /证书和私钥/);
});

test("production requires complete TLS file configuration", () => {
  assert.throws(() => resolveTlsServerConfig({ nodeEnv: "production", readFile() {} }), /生产环境必须配置/);
  assert.throws(() => resolveTlsServerConfig({ certificateFile: "/cert.pem", readFile() {} }), /必须同时配置/);
  assert.deepEqual(resolveTlsServerConfig({ nodeEnv: "development", readFile() {} }), { enabled: false, protocol: "http", serverOptions: null });
});

test("configured TLS files are loaded and converted to server options", () => {
  const reads = [];
  const config = resolveTlsServerConfig({
    nodeEnv: "production",
    certificateFile: "/cert.pem",
    privateKeyFile: "/key.pem",
    certificateAuthorityFile: "/ca.pem",
    readFile(path) { reads.push(path); return Buffer.from(path); },
    variablePrefix: "SENTINEL_TLS"
  });
  assert.equal(config.enabled, true);
  assert.equal(config.protocol, "https");
  assert.equal(config.serverOptions.ciphers, "TLS_AES_256_GCM_SHA384");
  assert.deepEqual(reads, ["/cert.pem", "/key.pem", "/ca.pem"]);
});

test("transport URLs require HTTPS except for explicit local development hosts", () => {
  assert.equal(assertEncryptedHttpUrl("https://cloud.example/api").protocol, "https:");
  assert.equal(assertEncryptedHttpUrl("http://127.0.0.1:18080").protocol, "http:");
  assert.equal(assertEncryptedHttpUrl("http://[::1]:8790").protocol, "http:");
  assert.equal(assertEncryptedHttpUrl("http://host.docker.internal:18080").protocol, "http:");
  assert.throws(() => assertEncryptedHttpUrl("http://cloud.example/api"), /必须使用 HTTPS/);
  assert.throws(() => assertEncryptedHttpUrl("http://127.0.0.1", { allowLoopbackHttp: false }), /必须使用 HTTPS/);
  assert.throws(() => assertEncryptedHttpUrl("https://user:pass@cloud.example"), /账号密码/);
});

test("loopback detection does not trust lookalike hostnames", () => {
  assert.equal(isLoopbackHostname("localhost"), true);
  assert.equal(isLoopbackHostname("127.9.8.7"), true);
  assert.equal(isLoopbackHostname("127.0.0.1.example.com"), false);
  assert.equal(isLoopbackHostname("10.0.0.1"), false);
});

test("a real connection negotiates TLS 1.3 with AES-256-GCM", async (t) => {
  const [certificate, privateKey] = await Promise.all([
    readFile(new URL("./fixtures/localhost.crt", import.meta.url)),
    readFile(new URL("./fixtures/localhost.key", import.meta.url))
  ]);
  const server = createServer(createTlsServerOptions({ certificate, privateKey }), (req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ protocol: req.socket.getProtocol(), cipher: req.socket.getCipher().name }));
  });
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const payload = await new Promise((resolve, reject) => {
    const req = request({
      hostname: "127.0.0.1",
      port: server.address().port,
      path: "/",
      method: "GET",
      rejectUnauthorized: false,
      minVersion: "TLSv1.3",
      maxVersion: "TLSv1.3"
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))));
    });
    req.once("error", reject);
    req.end();
  });
  assert.deepEqual(payload, { protocol: "TLSv1.3", cipher: "TLS_AES_256_GCM_SHA384" });
});
