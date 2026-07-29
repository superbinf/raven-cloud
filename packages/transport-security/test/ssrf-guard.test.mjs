import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import {
  createGuardedHttpClient,
  isHostAllowlisted,
  isPrivateAddress,
  parseHostAllowlist
} from "../src/index.mjs";

test("isPrivateAddress flags loopback, RFC1918, link-local, ULA and metadata ranges", () => {
  for (const address of ["127.0.0.1", "10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "0.0.0.0", "100.64.0.1", "::1", "fe80::1", "fc00::1", "fd12::1", "::ffff:169.254.169.254"]) {
    assert.equal(isPrivateAddress(address), true, `expected ${address} to be private`);
  }
  for (const address of ["8.8.8.8", "1.1.1.1", "203.0.113.10", "2606:4700:4700::1111"]) {
    assert.equal(isPrivateAddress(address), false, `expected ${address} to be public`);
  }
});

test("parseHostAllowlist and isHostAllowlisted match host and host:port", () => {
  const allowlist = parseHostAllowlist("127.0.0.1:18080, watchvuln.internal, [::1]:8080");
  assert.equal(isHostAllowlisted("127.0.0.1", 18080, allowlist), true);
  assert.equal(isHostAllowlisted("127.0.0.1", 9999, allowlist), false);
  assert.equal(isHostAllowlisted("watchvuln.internal", null, allowlist), true);
  assert.equal(isHostAllowlisted("::1", 8080, allowlist), true);
});

test("guarded client refuses loopback by default and respects the allowlist", async (t) => {
  let hits = 0;
  const server = createServer((req, res) => { hits += 1; res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const loopback = `http://127.0.0.1:${server.address().port}`;

  // 默认拒绝回环：必须 reject 且不应触达上游。
  const refusing = createGuardedHttpClient({ allowlist: [], allowLoopback: false });
  await assert.rejects(() => refusing(loopback, { timeoutMs: 2000 }));
  assert.equal(hits, 0, "回环请求应在 DNS pinning 阶段被拦截，不应触达上游");

  // 命中白名单后放行：正常返回。
  const allowing = createGuardedHttpClient({ allowlist: parseHostAllowlist(`127.0.0.1:${server.address().port}`), allowLoopback: false });
  const response = await allowing(loopback, { timeoutMs: 2000 });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {});
  assert.equal(hits, 1);
});

test("guarded client caps response size", async (t) => {
  const server = createServer((req, res) => { res.writeHead(200); res.end("x".repeat(64)); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const client = createGuardedHttpClient({ allowlist: parseHostAllowlist(`127.0.0.1:${server.address().port}`), maxBytes: 16 });
  await assert.rejects(() => client(url, { timeoutMs: 2000 }));
});
