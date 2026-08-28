#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUTPUT_DIR = join(ROOT, "offline-packages");
const SUPPORTED_ARCHES = new Set(["amd64", "arm64"]);

export const TARGETS = Object.freeze({
  cloud: {
    appImage: "raven-cloud",
    workspace: ".",
    dockerfile: "apps/api-server/Dockerfile",
    compose: "docker-compose.cloud.production.yml",
    envExample: ".env.production.example",
    entryTemplate: "scripts/offline/cloud-entry.sh.template",
    entryName: "raven-cloud.sh",
    baseImages: [
      { image: "postgres:17-alpine", archive: (arch) => `postgres-17-${arch}.tar` },
      { image: "redis:7.4-alpine", archive: (arch) => `redis-7.4-${arch}.tar` },
    ],
  },
});

function fail(message, exitCode = 1) {
  const error = new Error(message);
  error.exitCode = exitCode;
  throw error;
}

export function applicationBuilds(config) {
  return [
    { image: config.appImage, dockerfile: config.dockerfile },
    ...(config.additionalBuilds || []),
  ];
}

export function parseArgs(argv) {
  const options = {
    version: "",
    arch: "",
    outputDir: DEFAULT_OUTPUT_DIR,
    only: "",
    dryRun: false,
    allowDirty: false,
    noCache: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--version") options.version = argv[++index] || "";
    else if (value === "--arch") options.arch = argv[++index] || "";
    else if (value === "--output-dir") options.outputDir = resolve(ROOT, argv[++index] || "");
    else if (value === "--only") options.only = argv[++index] || "";
    else if (value === "--dry-run") options.dryRun = true;
    else if (value === "--allow-dirty") options.allowDirty = true;
    else if (value === "--no-cache") options.noCache = true;
    else if (value === "--help" || value === "-h") options.help = true;
    else fail(`未知参数：${value}`, 2);
  }
  return options;
}

function usage() {
  return `Raven Cloud 完整离线包构建

用法：
  node scripts/build-offline.mjs --version <版本> --arch <amd64|arm64> [选项]

选项：
  --arch amd64|arm64    目标 Linux 架构，必须显式指定
  --only cloud          兼容旧命令；本仓库仅构建 Cloud
  --output-dir <目录>   输出目录，默认 offline-packages
  --allow-dirty         允许从有未提交改动的工作区构建
  --no-cache            应用镜像构建禁用 BuildKit 缓存
  --dry-run             只检查输入并显示构建计划
`;
}

export function validateOptions(options) {
  if (!options.version || !/^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/.test(options.version)) {
    fail("版本号不能为空，且只能包含字母、数字、点、下划线和连字符。", 2);
  }
  if (!options.arch) {
    fail("必须显式指定目标架构：--arch amd64 或 --arch arm64。", 2);
  }
  if (!SUPPORTED_ARCHES.has(options.arch)) {
    fail(`不支持的架构：${options.arch}；仅支持 amd64、arm64。`, 2);
  }
  if (options.only && !TARGETS[options.only]) {
    fail(`不支持的目标：${options.only}；本仓库仅支持 cloud。地端请使用 https://github.com/superbinf/raven。`, 2);
  }
}

function commandText(command, args) {
  return [command, ...args].map((item) => (/\s/.test(item) ? JSON.stringify(item) : item)).join(" ");
}

function run(command, args, { capture = false, dryRun = false } = {}) {
  if (dryRun) {
    console.log(`[dry-run] ${commandText(command, args)}`);
    return "";
  }
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: capture ? "utf8" : undefined,
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.error) fail(`${command} 无法执行：${result.error.message}`);
  if (result.status !== 0) {
    const detail = capture ? String(result.stderr || result.stdout || "").trim() : "";
    fail(`${commandText(command, args)} 执行失败${detail ? `：${detail}` : ""}`);
  }
  return capture ? String(result.stdout).trim() : "";
}

async function requireFiles(paths) {
  for (const path of paths) {
    try {
      const metadata = await stat(path);
      if (!metadata.isFile()) fail(`打包输入不是文件：${path}`);
    } catch (error) {
      if (error.code === "ENOENT") fail(`缺少打包输入：${path}`);
      throw error;
    }
  }
}

export function stripComposeBuildSections(source) {
  const output = [];
  let skippedIndent = null;
  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    const indent = line.length - line.trimStart().length;
    if (skippedIndent !== null) {
      if (!trimmed || indent > skippedIndent) continue;
      skippedIndent = null;
    }
    if (/^build:\s*(?:#.*)?$/.test(trimmed) && indent >= 4) {
      skippedIndent = indent;
      continue;
    }
    output.push(line);
  }
  const result = output.join("\n");
  if (/^\s{4,}build:\s*$/m.test(result)) fail("无法从离线 Compose 中移除 build 配置。");
  return result;
}

export function releaseIdentity({ version, arch, date, gitSha }) {
  const imageTag = `${version}-${date}-${gitSha}-${arch}`;
  if (imageTag.length > 128) fail(`生成的镜像标签超过 128 个字符：${imageTag}`);
  return {
    imageTag,
    packageSuffix: `${version}-${date}-${gitSha}-${arch}`,
  };
}

export function renderEntryTemplate(source, replacements) {
  let output = source;
  for (const [key, value] of Object.entries(replacements)) {
    output = output.replaceAll(`@@${key}@@`, value);
  }
  const unresolved = output.match(/@@[A-Z_]+@@/g);
  if (unresolved) fail(`安装脚本仍有未替换变量：${[...new Set(unresolved)].join(", ")}`);
  return output;
}

async function sha256File(path) {
  const hash = createHash("sha256");
  await new Promise((resolvePromise, rejectPromise) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", rejectPromise);
    stream.on("end", resolvePromise);
  });
  return hash.digest("hex");
}

async function listFiles(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(root, path));
    else if (entry.isFile()) files.push(relative(root, path));
    else fail(`离线包不允许包含符号链接或特殊文件：${path}`);
  }
  return files;
}

async function writeChecksums(packageDir) {
  const files = (await listFiles(packageDir)).filter((path) => path !== "SHA256SUMS");
  const lines = [];
  for (const path of files) {
    lines.push(`${await sha256File(join(packageDir, path))}  ./${path}`);
  }
  await writeFile(join(packageDir, "SHA256SUMS"), `${lines.join("\n")}\n`, "utf8");
}

function readmeFor({ target, packageName, version, arch, imageTag, gitSha, createdAt }) {
  if (target !== "cloud") fail(`本仓库不支持构建 ${target} 离线包。`);
  const entry = "raven-cloud.sh";
  const defaultPort = "8787";
  const exampleAddress = "192.168.10.20";
  const services = "`raven-cloud`、`postgres:17-alpine`、`redis:7.4-alpine`";
  return `# Raven Cloud 运营平台 ${version} 完整离线包

构建来源：Git \`${gitSha}\`，镜像标签 \`${imageTag}\`，目标架构 Linux/${arch}。
生成时间：${createdAt}。

本包包含 ${services} 镜像，不包含源码、生产环境变量、数据库、激活信息、业务数据、TLS 私钥或客户凭据。

## 环境要求

- 与离线包一致的 Linux/${arch} 主机
- Docker Engine
- Docker Compose v2
- OpenSSL
- \`sha256sum\`

Docker 本身及操作系统 RPM/DEB 依赖不在本包内。

## 首次安装

\`\`\`bash
tar -xzf ${packageName}.tar.gz
cd ${packageName}
sha256sum -c SHA256SUMS
chmod +x ${entry}
./${entry} install ${exampleAddress} ${defaultPort}
\`\`\`

安装脚本会再次校验包内文件、加载本地镜像、生成随机密钥和初始密码、生成自签名 TLS 证书，并使用 \`--no-build\` 启动服务。

## 日常运维

\`\`\`bash
./${entry} status
./${entry} logs
./${entry} restart
./${entry} stop
\`\`\`

\`stop\` 会保留所有 Docker 数据卷。除非已经完成数据销毁审批，不要执行 \`docker compose down -v\`。

正式环境应将自动生成的自签名证书替换为企业 CA 或受信任证书。第三方情报连接器如需访问互联网或专网数据源，应按最小权限开放对应出口。
`;
}

async function preparePackage({
  target,
  config,
  tempRoot,
  outputDir,
  version,
  arch,
  date,
  gitSha,
  imageTag,
  createdAt,
}) {
  const packageName = `raven-cloud-complete-offline-${version}-${date}-${gitSha}-${arch}`;
  const packageDir = join(tempRoot, packageName);
  const imagesDir = join(packageDir, "images");
  const scriptsDir = join(packageDir, "scripts");
  await mkdir(imagesDir, { recursive: true });
  await mkdir(scriptsDir, { recursive: true });

  const composeSource = await readFile(join(ROOT, config.workspace, config.compose), "utf8");
  await writeFile(join(packageDir, "docker-compose.yml"), stripComposeBuildSections(composeSource), "utf8");
  await copyFile(join(ROOT, config.workspace, config.envExample), join(packageDir, config.envExample));
  await copyFile(join(ROOT, "scripts/offline/_offline-runtime.sh"), join(scriptsDir, "_offline-runtime.sh"));

  const template = await readFile(join(ROOT, config.entryTemplate), "utf8");
  const entry = renderEntryTemplate(template, {
    VERSION: version,
    ARCH: arch,
    IMAGE_TAG: imageTag,
  });
  const entryPath = join(packageDir, config.entryName);
  await writeFile(entryPath, entry, { encoding: "utf8", mode: 0o755 });
  await chmod(entryPath, 0o755);
  await chmod(join(scriptsDir, "_offline-runtime.sh"), 0o755);

  const release = {
    schemaVersion: 1,
    product: "raven-cloud",
    version,
    gitSha,
    createdAt,
    platform: `linux/${arch}`,
    imageTag,
    images: [
      ...applicationBuilds(config).map((build) => `${build.image}:${imageTag}`),
      ...config.baseImages.map((item) => item.image),
    ],
  };
  await writeFile(join(packageDir, "RELEASE.json"), `${JSON.stringify(release, null, 2)}\n`, "utf8");
  await writeFile(
    join(packageDir, "README.md"),
    readmeFor({ target, packageName, version, arch, imageTag, gitSha, createdAt }),
    "utf8",
  );

  for (const build of applicationBuilds(config)) {
    run("docker", [
      "save",
      "--output", join(imagesDir, `${build.image}-${arch}.tar`),
      `${build.image}:${imageTag}`,
    ]);
  }
  for (const baseImage of config.baseImages) {
    run("docker", ["save", "--output", join(imagesDir, baseImage.archive(arch)), baseImage.image]);
  }

  await writeChecksums(packageDir);
  await mkdir(outputDir, { recursive: true });
  const archivePath = join(outputDir, `${packageName}.tar.gz`);
  run("tar", ["-czf", archivePath, "-C", tempRoot, packageName]);
  const archiveHash = await sha256File(archivePath);
  await writeFile(`${archivePath}.sha256`, `${archiveHash}  ${basename(archivePath)}\n`, "utf8");
  return { archivePath, archiveHash };
}

async function validateInputs(targetNames) {
  const paths = [
    join(ROOT, "scripts/offline/_offline-runtime.sh"),
    ...targetNames.flatMap((target) => {
      const config = TARGETS[target];
      return [
        ...applicationBuilds(config).map((build) => join(ROOT, config.workspace, build.dockerfile)),
        join(ROOT, config.workspace, config.compose),
        join(ROOT, config.workspace, config.envExample),
        join(ROOT, config.entryTemplate),
      ];
    }),
  ];
  await requireFiles(paths);
  for (const target of targetNames) {
    const config = TARGETS[target];
    const compose = await readFile(join(ROOT, config.workspace, config.compose), "utf8");
    const offlineCompose = stripComposeBuildSections(compose);
    for (const build of applicationBuilds(config)) {
      if (!offlineCompose.includes(`image: ${build.image}:`)) {
        fail(`${target} Compose 未引用预期应用镜像 ${build.image}。`);
      }
    }
  }
}

function uniqueBaseImages(targetNames) {
  return [...new Set(targetNames.flatMap((target) => TARGETS[target].baseImages.map((item) => item.image)))];
}

export function applicationBuildArgs(config, env = process.env) {
  void config;
  void env;
  return [];
}

function inspectImageArchitecture(image, arch) {
  const actual = run("docker", ["image", "inspect", "--format", "{{.Architecture}}", image], { capture: true });
  if (actual !== arch) fail(`镜像架构不匹配：${image} 为 ${actual}，目标为 ${arch}。`);
}

export async function buildOffline(options) {
  validateOptions(options);
  const targetNames = ["cloud"];
  await validateInputs(targetNames);

  const gitSha = run("git", ["rev-parse", "--short=8", "HEAD"], { capture: true });
  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const createdAt = new Date().toISOString();
  const { imageTag, packageSuffix } = releaseIdentity({
    version: options.version,
    arch: options.arch,
    date,
    gitSha,
  });

  console.log(`版本：${options.version}`);
  console.log(`Git：${gitSha}`);
  console.log(`平台：linux/${options.arch}`);
  console.log(`镜像标签：${imageTag}`);
  console.log(`目标：${targetNames.join(", ")}`);
  console.log(`输出：${options.outputDir}`);

  if (options.dryRun) {
    for (const target of targetNames) {
      const config = TARGETS[target];
      for (const build of applicationBuilds(config)) {
        const buildArgs = [
          "buildx", "build",
          "--platform", `linux/${options.arch}`,
          "--load",
          "--tag", `${build.image}:${imageTag}`,
          "--label", `org.opencontainers.image.version=${options.version}`,
          "--label", `org.opencontainers.image.revision=${gitSha}`,
          ...applicationBuildArgs(config),
          ...(options.noCache ? ["--no-cache"] : []),
          "--file", join(config.workspace, build.dockerfile),
          config.workspace,
        ];
        run("docker", buildArgs, { dryRun: true });
      }
    }
    for (const image of uniqueBaseImages(targetNames)) {
      run("docker", ["pull", "--platform", `linux/${options.arch}`, image], { dryRun: true });
    }
    for (const target of targetNames) {
      console.log(`[dry-run] 生成 raven-cloud-complete-offline-${packageSuffix}.tar.gz`);
    }
    return [];
  }

  if (!options.allowDirty) {
    const dirty = run("git", ["status", "--porcelain"], { capture: true });
    if (dirty) fail("工作区存在未提交改动。提交后重试，或明确使用 --allow-dirty。");
  }

  run("docker", ["info"], { capture: true });
  run("docker", ["buildx", "version"], { capture: true });

  for (const target of targetNames) {
    const config = TARGETS[target];
    for (const build of applicationBuilds(config)) {
      const appImage = `${build.image}:${imageTag}`;
      console.log(`\n构建 ${target} 应用镜像：${appImage}`);
      run("docker", [
        "buildx", "build",
        "--platform", `linux/${options.arch}`,
        "--load",
        "--tag", appImage,
        "--label", `org.opencontainers.image.version=${options.version}`,
        "--label", `org.opencontainers.image.revision=${gitSha}`,
        ...applicationBuildArgs(config),
        ...(options.noCache ? ["--no-cache"] : []),
        "--file", join(config.workspace, build.dockerfile),
        config.workspace,
      ]);
      inspectImageArchitecture(appImage, options.arch);
    }
  }

  for (const image of uniqueBaseImages(targetNames)) {
    console.log(`\n准备基础镜像：${image}`);
    run("docker", ["pull", "--platform", `linux/${options.arch}`, image]);
    inspectImageArchitecture(image, options.arch);
  }

  const tempRoot = await mkdtemp(join(tmpdir(), "sentinel-offline-"));
  const results = [];
  try {
    for (const target of targetNames) {
      console.log(`\n组装 ${target} 完整离线包...`);
      results.push(await preparePackage({
        target,
        config: TARGETS[target],
        tempRoot,
        outputDir: options.outputDir,
        version: options.version,
        arch: options.arch,
        date,
        gitSha,
        imageTag,
        createdAt,
      }));
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }

  console.log("\n离线包构建完成：");
  for (const result of results) {
    console.log(`- ${result.archivePath}`);
    console.log(`  SHA-256 ${result.archiveHash}`);
  }
  return results;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  await buildOffline(options);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(`离线包构建失败：${error.message}`);
    process.exitCode = error.exitCode || 1;
  });
}
