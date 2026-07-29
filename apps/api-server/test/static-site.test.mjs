import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createStaticSiteHandler } from "../src/app/static-site.mjs";

function response() {
  return {
    body: "",
    headers: null,
    statusCode: null,
    writeHead(statusCode, headers) { this.statusCode = statusCode; this.headers = headers; },
    end(value = "") { this.body += value; }
  };
}

test("static site serves assets and falls back to the SPA index", async () => {
  const root = await mkdtemp(join(tmpdir(), "sentinel-static-"));
  await writeFile(join(root, "index.html"), "<main>admin</main>");
  await writeFile(join(root, "app.js"), "console.log('admin')");
  const handler = createStaticSiteHandler(root);

  const headResponse = response();
  assert.equal(await handler({ method: "HEAD" }, headResponse, "/app.js"), true);
  assert.equal(headResponse.statusCode, 200);
  assert.equal(headResponse.headers["Content-Type"], "text/javascript; charset=utf-8");

  const spaResponse = response();
  assert.equal(await handler({ method: "HEAD" }, spaResponse, "/admin/accounts"), true);
  assert.equal(spaResponse.headers["Content-Type"], "text/html; charset=utf-8");
});

test("static site rejects traversal and missing asset paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "sentinel-static-"));
  await writeFile(join(root, "index.html"), "<main>admin</main>");
  const handler = createStaticSiteHandler(root);

  assert.equal(await handler({ method: "GET" }, response(), "/../../etc/passwd"), false);
  assert.equal(await handler({ method: "GET" }, response(), "/@vite/client"), false);
  assert.equal(await handler({ method: "GET" }, response(), "/@fs/project/source.ts"), false);
  assert.equal(await handler({ method: "GET" }, response(), "/src/App.tsx"), false);
  assert.equal(await handler({ method: "GET" }, response(), "/node_modules/react/index.js"), false);
  assert.equal(await handler({ method: "GET" }, response(), "/missing.js"), false);
  assert.equal(await handler({ method: "POST" }, response(), "/"), false);
});
