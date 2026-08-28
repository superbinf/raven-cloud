import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cloudDir = rootDir;
const envPath = join(rootDir, ".env.development");
const composePath = join(rootDir, "docker-compose.cloud.development.yml");
const cacheDir = join(rootDir, ".npm-cache");
const runtimeDir = join(rootDir, ".runtime", "dev");
const children = new Map();
let shuttingDown = false;

const requiredConfigKeys = [
  "POSTGRES_DB", "POSTGRES_USER", "POSTGRES_PASSWORD", "POSTGRES_PORT", "REDIS_PORT",
  "CLOUD_HOST", "CLOUD_PORT", "CLOUD_ADMIN_PORT", "SENTINEL_SECRET", "SENTINEL_ADMIN_ACCOUNT",
  "SENTINEL_ADMIN_PASSWORD", "SENTINEL_PORTAL_ACCOUNT", "SENTINEL_PORTAL_PASSWORD"
];

function strongPassword() {
  return `Dev-${randomBytes(12).toString("base64url")}-Aa1!`;
}

function generatedConfig() {
  return {
    POSTGRES_DB: "sentinel",
    POSTGRES_USER: "sentinel",
    POSTGRES_PASSWORD: randomBytes(24).toString("base64url"),
    POSTGRES_PORT: "5432",
    REDIS_PORT: "6379",
    SENTINEL_DEV_DOCKER_PLATFORM: "linux/arm64",
    CLOUD_HOST: "127.0.0.1",
    CLOUD_PORT: "8787",
    CLOUD_ADMIN_PORT: "5174",
    SENTINEL_SECRET: randomBytes(32).toString("base64url"),
    SENTINEL_ADMIN_ACCOUNT: "operator",
    SENTINEL_ADMIN_PASSWORD: strongPassword(),
    SENTINEL_PORTAL_ACCOUNT: "analyst",
    SENTINEL_PORTAL_PASSWORD: strongPassword(),
    SENTINEL_SEED_DEMO_DATA: "1"
  };
}

function serializeEnv(config) {
  return `${Object.entries(config).map(([key, value]) => `${key}=${value}`).join("\n")}\n`;
}

function loadConfig({ create = true } = {}) {
  if (!existsSync(envPath)) {
    if (!create) throw new Error(`缺少开发配置：${envPath}，请先执行 make dev-init`);
    const config = generatedConfig();
    writeFileSync(envPath, serializeEnv(config), { mode: 0o600, flag: "wx" });
    console.log(`[dev] 已生成本地开发配置：${envPath}`);
  }
  const config = parseEnv(readFileSync(envPath, "utf8"));
  const missing = requiredConfigKeys.filter((key) => !String(config[key] || "").trim());
  if (missing.length) throw new Error(`本地开发配置缺少：${missing.join("、")}`);
  return config;
}

function command(commandName, args, { cwd = rootDir, env = process.env, capture = false } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(commandName, args, {
      cwd,
      env,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit"
    });
    let stdout = "";
    let stderr = "";
    if (capture) {
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
    }
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise({ stdout, stderr });
      else reject(new Error(`${commandName} ${args.join(" ")} 执行失败（${signal || code}）${stderr ? `\n${stderr.trim()}` : ""}`));
    });
  });
}

function composeArgs(...args) {
  return ["compose", "--project-name", "raven-cloud-dev", "--env-file", envPath, "-f", composePath, ...args];
}

function hashFile(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

async function dependenciesHealthy(workspaceDir, probeModules) {
  try {
    await command("npm", ["ls", "--depth=0"], { cwd: workspaceDir, capture: true });
    const imports = probeModules.map((name) => `await import(${JSON.stringify(name)});`).join("");
    await command(process.execPath, ["--input-type=module", "-e", imports], { cwd: workspaceDir, capture: true });
    return true;
  } catch {
    return false;
  }
}

function sharpPlatformDependencies(workspaceDir) {
  const sharpPackagePath = join(workspaceDir, "node_modules", "sharp", "package.json");
  if (!existsSync(sharpPackagePath)) return [];
  const sharpPackage = JSON.parse(readFileSync(sharpPackagePath, "utf8"));
  const libc = process.platform === "linux" && !process.report.getReport().header.glibcVersionRuntime ? "musl" : "";
  const suffix = process.platform === "linux"
    ? `linux${libc}-${process.arch}`
    : `${process.platform}-${process.arch}`;
  return [`@img/sharp-${suffix}`, `@img/sharp-libvips-${suffix}`]
    .map((name) => sharpPackage.optionalDependencies?.[name] ? `${name}@${sharpPackage.optionalDependencies[name]}` : null)
    .filter(Boolean);
}

async function repairPlatformDependencies(label, workspaceDir) {
  if (label !== "Cloud") return;
  const dependencies = sharpPlatformDependencies(workspaceDir);
  if (!dependencies.length) return;
  console.log(`[dev] 安装当前平台的图像运行时依赖：${dependencies.join("、")}`);
  await command("npm", ["install", "--no-save", ...dependencies, "--cache", cacheDir], { cwd: workspaceDir });
}

async function ensureWorkspaceDependencies(label, workspaceDir, probeModules) {
  const lockPath = join(workspaceDir, "package-lock.json");
  const modulesDir = join(workspaceDir, "node_modules");
  const markerPath = join(modulesDir, ".raven-cloud-package-lock.sha256");
  const expectedHash = hashFile(lockPath);
  const installedHash = existsSync(markerPath) ? readFileSync(markerPath, "utf8").trim() : "";
  if (existsSync(modulesDir) && installedHash === expectedHash) {
    if (await dependenciesHealthy(workspaceDir, probeModules)) return;
    console.log(`[dev] ${label} 关键运行时依赖缺失，尝试修复当前平台依赖...`);
    await repairPlatformDependencies(label, workspaceDir);
    if (await dependenciesHealthy(workspaceDir, probeModules)) return;
    console.log(`[dev] ${label} 依赖修复后仍不完整，将按 package-lock 重新安装。`);
  }
  if (existsSync(modulesDir) && !installedHash) {
    if (await dependenciesHealthy(workspaceDir, probeModules)) {
      writeFileSync(markerPath, `${expectedHash}\n`);
      console.log(`[dev] 已复用现有 ${label} 依赖；后续将按 package-lock 变化自动更新。`);
      return;
    }
    console.log(`[dev] ${label} 现有依赖不完整，将按 package-lock 重新安装。`);
  }
  console.log(`[dev] 安装 ${label} 依赖（package-lock 已变化或尚未安装）...`);
  await command("npm", ["ci", "--include=optional", "--cache", cacheDir], { cwd: workspaceDir });
  if (!await dependenciesHealthy(workspaceDir, probeModules)) {
    await repairPlatformDependencies(label, workspaceDir);
  }
  if (!await dependenciesHealthy(workspaceDir, probeModules)) {
    throw new Error(`${label} 依赖安装完成，但关键运行时模块仍无法加载`);
  }
  writeFileSync(markerPath, `${expectedHash}\n`);
}

async function ensureDependencies() {
  await ensureWorkspaceDependencies("Cloud", cloudDir, ["vite", "sharp"]);
}

async function ensureDocker(config) {
  await command("docker", ["info", "--format", "{{.ServerVersion}}"], { capture: true });
  console.log("[dev] 启动 PostgreSQL 和 Redis...");
  await command("docker", composeArgs("up", "-d", "postgres", "redis"), { env: { ...process.env, ...config } });

  const databaseDeadline = Date.now() + 60_000;
  let databaseReady = false;
  while (Date.now() < databaseDeadline) {
    try {
      await command("docker", composeArgs(
        "exec", "-T", "-e", `PGPASSWORD=${config.POSTGRES_PASSWORD}`, "postgres",
        "psql", "-h", "postgres", "-U", config.POSTGRES_USER, "-d", config.POSTGRES_DB, "-tAc", "SELECT 1"
      ), { env: { ...process.env, ...config }, capture: true });
      databaseReady = true;
      break;
    } catch {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
    }
  }
  if (!databaseReady) throw new Error("PostgreSQL 启动超时，请执行 make dev-logs 检查日志");

  const redisDeadline = Date.now() + 30_000;
  while (Date.now() < redisDeadline) {
    try {
      const result = await command("docker", composeArgs("exec", "-T", "redis", "redis-cli", "ping"), {
        env: { ...process.env, ...config },
        capture: true
      });
      if (result.stdout.trim() === "PONG") return;
    } catch {}
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw new Error("Redis 启动超时，请执行 make dev-logs 检查日志");
}

function portAvailable(port, host = "127.0.0.1") {
  return new Promise((resolvePromise) => {
    const server = net.createServer();
    server.once("error", () => resolvePromise(false));
    server.listen(Number(port), host, () => server.close(() => resolvePromise(true)));
  });
}

async function assertApplicationPorts(config) {
  const ports = {
    "Cloud Web": config.CLOUD_ADMIN_PORT,
    "Cloud API": config.CLOUD_PORT
  };
  const occupied = [];
  for (const [label, port] of Object.entries(ports)) {
    if (!await portAvailable(port)) occupied.push(`${label}:${port}`);
  }
  if (occupied.length) throw new Error(`开发端口已被占用：${occupied.join("、")}。请先停止旧进程，或修改 ${envPath}`);
}

function attachOutput(label, stream, target) {
  const lines = readline.createInterface({ input: stream });
  lines.on("line", (line) => target.write(`[${label}] ${line}\n`));
}

function service(label, commandName, args, { cwd, env }) {
  const detached = process.platform !== "win32";
  const child = spawn(commandName, args, {
    cwd,
    env,
    detached,
    stdio: ["ignore", "pipe", "pipe"]
  });
  children.set(child.pid, { child, label, detached });
  attachOutput(label, child.stdout, process.stdout);
  attachOutput(label, child.stderr, process.stderr);
  child.once("error", (error) => {
    console.error(`[${label}] 启动失败：${error.message}`);
    void shutdown(1);
  });
  child.once("exit", (code, signal) => {
    children.delete(child.pid);
    if (!shuttingDown) {
      console.error(`[${label}] 意外退出：${signal || code}`);
      void shutdown(code || 1);
    }
  });
  return child;
}

function terminateProcess(entry, signal) {
  try {
    if (entry.detached) process.kill(-entry.child.pid, signal);
    else entry.child.kill(signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

async function waitForUrl(label, url, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error(`${label} 启动超时：${url}`);
}

async function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  const entries = [...children.values()];
  for (const entry of entries) terminateProcess(entry, "SIGTERM");
  const deadline = Date.now() + 5_000;
  while (children.size && Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  for (const entry of children.values()) terminateProcess(entry, "SIGKILL");
  console.log("\n[dev] 本地应用进程已停止；PostgreSQL 和 Redis 继续运行。执行 make dev-down 可停止基础设施。");
  process.exit(exitCode);
}

function databaseUrl(config, database) {
  const url = new URL(`postgresql://127.0.0.1:${config.POSTGRES_PORT}/${database}`);
  url.username = config.POSTGRES_USER;
  url.password = config.POSTGRES_PASSWORD;
  return url.toString();
}

function applicationEnvironments(config) {
  const cloudUrl = `http://${config.CLOUD_HOST}:${config.CLOUD_PORT}`;
  const base = { ...process.env, ...config, NODE_ENV: "development" };
  return {
    cloudUrl,
    cloud: {
      ...base,
      HOST: config.CLOUD_HOST,
      PORT: config.CLOUD_PORT,
      DATABASE_URL: databaseUrl(config, config.POSTGRES_DB),
      REDIS_URL: `redis://127.0.0.1:${config.REDIS_PORT}`,
      SENTINEL_PUBLIC_BASE_URL: cloudUrl,
      SENTINEL_CLOUD_DEV_URL: cloudUrl,
      SENTINEL_DATA_DIR: join(runtimeDir, "cloud-data")
    }
  };
}

function printConfig(config) {
  console.log(`配置文件：${envPath}`);
  console.log(`Cloud 管理后台：http://${config.CLOUD_HOST}:${config.CLOUD_ADMIN_PORT}/admin`);
  console.log(`Cloud 管理账号：${config.SENTINEL_ADMIN_ACCOUNT}`);
  console.log(`Cloud 管理密码：${config.SENTINEL_ADMIN_PASSWORD}`);
}

async function start() {
  if (Number(process.versions.node.split(".")[0]) < 22) {
    throw new Error(`需要 Node.js 22+，当前版本为 ${process.version}`);
  }
  const config = loadConfig();
  mkdirSync(runtimeDir, { recursive: true });
  await assertApplicationPorts(config);
  await ensureDependencies();
  await ensureDocker(config);
  const environments = applicationEnvironments(config);

  service("cloud-api", "npm", ["run", "dev:api"], { cwd: cloudDir, env: environments.cloud });
  await waitForUrl("Cloud API", `${environments.cloudUrl}/health`);
  service("cloud-worker", "npm", ["run", "dev:worker"], { cwd: cloudDir, env: environments.cloud });

  const cloudVite = join(cloudDir, "node_modules", "vite", "bin", "vite.js");
  service("cloud-web", process.execPath, [cloudVite, "--host", config.CLOUD_HOST, "--port", config.CLOUD_ADMIN_PORT], {
    cwd: join(cloudDir, "apps", "admin-web"),
    env: environments.cloud
  });

  await waitForUrl("Cloud Web", `http://${config.CLOUD_HOST}:${config.CLOUD_ADMIN_PORT}/admin`);

  console.log("\nRaven Cloud 本机开发环境已就绪：");
  printConfig(config);
  console.log(`Cloud API：${environments.cloudUrl}/health`);
  console.log("\n云地联调请在独立 Raven 仓库启动地端：https://github.com/superbinf/raven");
  console.log("按 Ctrl+C 停止本地应用进程；数据库和 Redis 会保留。\n");
}

async function status() {
  const config = loadConfig({ create: false });
  await command("docker", composeArgs("ps"), { env: { ...process.env, ...config } });
  const endpoints = [
    ["Cloud Web", `http://${config.CLOUD_HOST}:${config.CLOUD_ADMIN_PORT}/admin`],
    ["Cloud API", `http://${config.CLOUD_HOST}:${config.CLOUD_PORT}/health`]
  ];
  for (const [label, url] of endpoints) {
    try {
      const response = await fetch(url);
      console.log(`${response.ok ? "✓" : "!"} ${label.padEnd(12)} ${url} (${response.status})`);
    } catch {
      console.log(`- ${label.padEnd(12)} ${url} (未运行)`);
    }
  }
}

async function main() {
  const action = process.argv[2] || "start";
  if (action === "start") return start();
  if (action === "install") {
    loadConfig();
    return ensureDependencies();
  }
  if (action === "config") return printConfig(loadConfig());
  if (action === "status") return status();
  if (action === "logs") {
    const config = loadConfig({ create: false });
    return command("docker", composeArgs("logs", "--tail", "200", "-f", "postgres", "redis"), {
      env: { ...process.env, ...config }
    });
  }
  if (action === "down") {
    const config = loadConfig({ create: false });
    return command("docker", composeArgs("stop", "postgres", "redis"), { env: { ...process.env, ...config } });
  }
  throw new Error(`未知命令：${action}`);
}

process.once("SIGINT", () => void shutdown(0));
process.once("SIGTERM", () => void shutdown(0));

main().catch(async (error) => {
  console.error(`[dev] ${error.message}`);
  if (children.size) await shutdown(1);
  else process.exit(1);
});
