import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const sourceRoots = [resolve(root, "apps"), resolve(root, "packages")];
const extensions = [".mjs", ".js", ".ts", ".tsx"];
const files = [];

function walk(directory) {
  if (!existsSync(directory)) return;
  for (const name of readdirSync(directory)) {
    if (["node_modules", "dist", "data", "test"].includes(name) || name.endsWith(".tsbuildinfo")) continue;
    const path = join(directory, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (extensions.includes(extname(path)) && path.includes(`${join("src", "")}`)) files.push(resolve(path));
  }
}
for (const directory of sourceRoots) walk(directory);

const packageEntries = new Map();
for (const packageDirectory of readdirSync(resolve(root, "packages"), { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
  const packageJsonPath = resolve(root, "packages", packageDirectory.name, "package.json");
  if (!existsSync(packageJsonPath)) continue;
  const manifest = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  const rootExport = typeof manifest.exports === "string" ? manifest.exports : manifest.exports?.["."];
  const exported = typeof rootExport === "string" ? rootExport : rootExport?.import;
  if (manifest.name && exported) packageEntries.set(manifest.name, resolve(dirname(packageJsonPath), exported));
}

function resolveImport(from, source) {
  if (packageEntries.has(source)) return packageEntries.get(source);
  if (!source.startsWith(".")) return null;
  const candidate = resolve(dirname(from), source);
  for (const path of [candidate, ...extensions.map((extension) => `${candidate}${extension}`), ...extensions.map((extension) => join(candidate, `index${extension}`))]) {
    if (existsSync(path) && !statSync(path).isDirectory()) return resolve(path);
  }
  return null;
}

const graph = new Map(files.map((file) => [file, []]));
const importPattern = /(?:import|export)\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;
for (const file of files) {
  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(importPattern)) {
    const target = resolveImport(file, match[1] || match[2]);
    if (target && graph.has(target)) graph.get(file).push(target);
  }
}

const visiting = new Set();
const visited = new Set();
const stack = [];
const cycles = [];
function visit(file) {
  if (visiting.has(file)) {
    const start = stack.indexOf(file);
    cycles.push([...stack.slice(start), file]);
    return;
  }
  if (visited.has(file)) return;
  visiting.add(file); stack.push(file);
  for (const target of graph.get(file) || []) visit(target);
  stack.pop(); visiting.delete(file); visited.add(file);
}
for (const file of files) visit(file);

const dumpingGrounds = files.filter((file) => /\/(?:common|misc)\/|\/utils\.(?:mjs|js|ts|tsx)$/.test(file));
if (cycles.length || dumpingGrounds.length) {
  if (cycles.length) console.error(`检测到循环依赖：\n${cycles.map((cycle) => cycle.map((file) => relative(root, file)).join(" -> ")).join("\n")}`);
  if (dumpingGrounds.length) console.error(`禁止新增模糊公共目录或万能 utils 文件：\n${dumpingGrounds.map((file) => relative(root, file)).join("\n")}`);
  process.exit(1);
}
console.log(`依赖边界检查通过：${files.length} 个源码文件，无循环依赖。`);
