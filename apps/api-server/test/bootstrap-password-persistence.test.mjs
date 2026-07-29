import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { loginWithCaptcha } from "./support/captcha.mjs";

const apiRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForApi(baseUrl, child) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`API 提前退出：${child.exitCode}`);
    try { if ((await fetch(`${baseUrl}/health`)).ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error("API 启动超时");
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => { child.once("exit", resolve); child.kill("SIGTERM"); });
}

test("环境变量初始化密码不会覆盖用户修改后的密码", async (t) => {
  const dataDir = await mkdtemp(join(os.tmpdir(), "sentinel-password-persistence-"));
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const databaseUrl = process.env.DATABASE_URL || "postgresql://sentinel:sentinel-local-password@127.0.0.1:5432/sentinel";
  const schema = `sentinel_test_password_${process.pid}_${port}`;
  const bootstrapPassword = "Bootstrap-Test#2026";
  const changedPassword = "Changed-Test#2026";
  const env = { ...process.env, PORT: String(port), DATABASE_URL: databaseUrl, SENTINEL_DB_SCHEMA: schema, SENTINEL_DATA_DIR: dataDir, SENTINEL_SECRET: "password-persistence-secret", SENTINEL_ADMIN_ACCOUNT: "operator", SENTINEL_ADMIN_PASSWORD: bootstrapPassword, SENTINEL_PORTAL_PASSWORD: "Portal-Test#2026" };
  let child;
  const start = async () => {
    child = spawn(process.execPath, [join(apiRoot, "src/server.mjs")], { cwd: join(apiRoot, "../.."), env, stdio: ["ignore", "ignore", "pipe"] });
    await waitForApi(baseUrl, child);
  };
  t.after(async () => {
    await stopChild(child);
    const cleanup = new pg.Client({ connectionString: databaseUrl });
    await cleanup.connect();
    await cleanup.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await cleanup.end();
    await rm(dataDir, { recursive: true, force: true });
  });

  const request = async (path, { token, ...options } = {}) => {
    const headers = new Headers(options.headers);
    if (token) headers.set("Authorization", `Bearer ${token}`);
    if (options.body) headers.set("Content-Type", "application/json");
    const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
    return { status: response.status, body: await response.json() };
  };
  const login = (password) => loginWithCaptcha(request, { account: "operator", password, secret: "password-persistence-secret" });

  await start();
  const initialLogin = await login(bootstrapPassword);
  assert.equal(initialLogin.status, 200, JSON.stringify(initialLogin.body));
  const changed = await request("/api/profile/change-password", { token: initialLogin.body.token, method: "POST", body: JSON.stringify({ currentPassword: bootstrapPassword, password: changedPassword }) });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));

  await stopChild(child);
  await start();
  assert.equal((await login(bootstrapPassword)).status, 401);
  assert.equal((await login(changedPassword)).status, 200);
});
