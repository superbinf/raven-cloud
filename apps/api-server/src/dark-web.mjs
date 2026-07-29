import { createHash } from "node:crypto";
import { posix } from "node:path";
import mammoth from "mammoth";
import yauzl from "yauzl";
import XLSX from "xlsx";
export { createWordPreview, createWorkbookPreview } from "@sentinel/file-preview";

const MAX_ENTRY_COUNT = 100;
const MAX_ARCHIVE_SIZE = 50 * 1024 * 1024;
const MAX_UNCOMPRESSED_SIZE = 200 * 1024 * 1024;
const MAX_PREVIEW_PAGE_SIZE = 100;
const MAX_PREVIEW_COLUMNS = 100;
// OOXML（.xlsx/.docx）本身是 ZIP，XLSX.read/mammoth 会二次解压且无膨胀上限，这里限制其内部未压缩总量以防解压炸弹。
const MAX_OOXML_UNCOMPRESSED = 60 * 1024 * 1024;
const MAX_OOXML_ENTRY_COUNT = 2000;

// 仅遍历 OOXML 中央目录累加未压缩大小，不读取流；超限即抛错，避免 XLSX.read/mammoth 在内存中二次膨胀导致 OOM。
export function assertSafeOoxml(buffer) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, decodeStrings: true, validateEntrySizes: true }, (openError, zipFile) => {
      if (openError) { reject(Object.assign(new Error("附件文件损坏或不是有效的 Office 文档"), { statusCode: 400 })); return; }
      let entries = 0;
      let total = 0;
      let settled = false;
      const fail = (error) => { if (settled) return; settled = true; try { zipFile.close(); } catch {} reject(error); };
      zipFile.on("error", (error) => fail(Object.assign(new Error("附件文件损坏或不是有效的 Office 文档"), { statusCode: 400, cause: error })));
      zipFile.on("entry", (entry) => {
        entries += 1;
        if (entries > MAX_OOXML_ENTRY_COUNT) return fail(Object.assign(new Error("Office 文档内部结构条目过多"), { statusCode: 413 }));
        total += Number(entry.uncompressedSize || 0);
        if (total > MAX_OOXML_UNCOMPRESSED) return fail(Object.assign(new Error("Office 文档解压后体积过大"), { statusCode: 413 }));
        zipFile.readEntry();
      });
      zipFile.on("end", () => { if (settled) return; settled = true; resolve(); });
      zipFile.readEntry();
    });
  });
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (_, value) => String.fromCodePoint(Number(value)))
    .replace(/&#x([0-9a-f]+);/gi, (_, value) => String.fromCodePoint(Number.parseInt(value, 16)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[\t ]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

function articleMarkdownFromHtml(html) {
  const firstHeading = html.search(/<h[12][^>]*>/i);
  const body = firstHeading >= 0 ? html.slice(firstHeading) : html;
  const block = (tag) => new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi");
  return body
    .replace(block("h1"), (_, value) => `\n# ${decodeHtml(value)}\n`)
    .replace(block("h2"), (_, value) => `\n## ${decodeHtml(value)}\n`)
    .replace(block("h3"), (_, value) => `\n### ${decodeHtml(value)}\n`)
    .replace(block("li"), (_, value) => `\n- ${decodeHtml(value)}`)
    .replace(block("p"), (_, value) => `\n${decodeHtml(value)}\n`)
    .replace(/<tr[^>]*>([\s\S]*?)<\/tr>/gi, (_, row) => `\n${[...row.matchAll(/<(?:td|th)[^>]*>([\s\S]*?)<\/(?:td|th)>/gi)].map((cell) => decodeHtml(cell[1])).filter(Boolean).join(" | ")}`)
    .replace(/<[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function safeArchivePath(fileName) {
  const normalized = String(fileName || "").replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) return null;
  const clean = posix.normalize(normalized);
  if (clean === ".." || clean.startsWith("../") || clean.includes("/../")) return null;
  return clean;
}

function readZipEntries(buffer) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, decodeStrings: true, validateEntrySizes: true }, (openError, zipFile) => {
      if (openError) { reject(new Error(`ZIP 文件无法打开：${openError.message}`)); return; }
      const entries = [];
      let entryCount = 0;
      let totalSize = 0;
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        try { zipFile.close(); } catch {}
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      zipFile.on("error", (error) => fail(new Error(`ZIP 文件损坏：${error.message}`)));
      zipFile.on("entry", (entry) => {
        entryCount += 1;
        if (entryCount > MAX_ENTRY_COUNT) return fail(new Error(`ZIP 条目超过 ${MAX_ENTRY_COUNT} 个限制`));
        if (entry.generalPurposeBitFlag & 0x1) return fail(new Error("ZIP 中包含加密文件，无法导入"));
        totalSize += Number(entry.uncompressedSize || 0);
        if (totalSize > MAX_UNCOMPRESSED_SIZE) return fail(new Error("ZIP 解压后超过 200 MB 限制"));
        const cleanPath = safeArchivePath(entry.fileName);
        if (!cleanPath) return fail(new Error(`ZIP 中包含不安全路径：${entry.fileName}`));
        const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
        if ((unixMode & 0xf000) === 0xa000) return fail(new Error(`ZIP 中不允许符号链接：${entry.fileName}`));
        if (/\/$/.test(cleanPath)) { zipFile.readEntry(); return; }
        if (cleanPath.startsWith("__MACOSX/") || posix.basename(cleanPath) === ".DS_Store") { zipFile.readEntry(); return; }
        const extension = posix.extname(cleanPath).toLowerCase();
        if ([".zip", ".rar", ".7z", ".tar", ".gz"].includes(extension)) return fail(new Error(`ZIP 中不允许嵌套压缩包：${cleanPath}`));
        if (![".docx", ".xlsx"].includes(extension)) return fail(new Error(`ZIP 中包含不支持的文件：${cleanPath}`));
        zipFile.openReadStream(entry, (streamError, stream) => {
          if (streamError) { fail(streamError); return; }
          const chunks = [];
          stream.on("data", (chunk) => chunks.push(chunk));
          stream.on("error", fail);
          stream.on("end", () => {
            entries.push({ path: cleanPath, name: posix.basename(cleanPath), extension, buffer: Buffer.concat(chunks) });
            zipFile.readEntry();
          });
        });
      });
      zipFile.on("end", () => {
        if (settled) return;
        settled = true;
        resolve(entries);
      });
      zipFile.readEntry();
    });
  });
}

function parseTable(tableHtml) {
  const result = {};
  for (const rowMatch of tableHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...rowMatch[1].matchAll(/<(?:td|th)[^>]*>([\s\S]*?)<\/(?:td|th)>/gi)].map((match) => decodeHtml(match[1]));
    if (cells.length >= 2 && cells[0]) result[cells[0].replace(/\s+/g, "")] = cells.slice(1).join(" ").trim();
  }
  return result;
}

function field(table, ...labels) {
  for (const label of labels) {
    const normalized = label.replace(/\s+/g, "");
    if (table[normalized] !== undefined) return table[normalized];
  }
  return "";
}

function reportTags(value, fallback) {
  const tags = [...new Set(String(value || "").split(/[、,，;；|/\n]+/).map((item) => item.trim()).filter(Boolean))].slice(0, 8);
  return tags.length ? tags : fallback;
}

function workbookMetrics(buffer) {
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: false, raw: false });
  const sheets = workbook.SheetNames.map((sheetName) => {
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: "", raw: false, blankrows: false });
    const nonEmptyRows = rows.filter((row) => row.some((value) => String(value ?? "").trim() !== ""));
    return {
      name: sheetName,
      rowCount: nonEmptyRows.length,
      columnCount: nonEmptyRows.reduce((count, row) => Math.max(count, row.reduce((last, value, index) => String(value ?? "").trim() ? index + 1 : last, 0)), 0)
    };
  });
  return {
    sheetCount: sheets.length,
    rowCount: sheets.reduce((sum, sheet) => sum + sheet.rowCount, 0),
    columnCount: sheets.reduce((max, sheet) => Math.max(max, sheet.columnCount), 0),
    sheets
  };
}

async function parseReport(reportBuffer, attachmentEntries, { attachmentsRequired = true } = {}) {
  const converted = await mammoth.convertToHtml({ buffer: reportBuffer });
  const html = converted.value;
  const allText = decodeHtml(html);
  const articleMarkdown = articleMarkdownFromHtml(html);
  const warnings = converted.messages.map((message) => message.message);
  const reportDate = allText.match(/20\d{2}-\d{2}-\d{2}/)?.[0] || "";
  const headingMatches = [...html.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/gi)];
  const events = [];
  for (let index = 0; index < headingMatches.length; index += 1) {
    const heading = decodeHtml(headingMatches[index][1]);
    if (!heading) continue;
    const start = headingMatches[index].index + headingMatches[index][0].length;
    const end = headingMatches[index + 1]?.index ?? html.length;
    const section = html.slice(start, end);
    const tableHtml = section.match(/<table[^>]*>([\s\S]*?)<\/table>/i)?.[0];
    if (!tableHtml) continue;
    const table = parseTable(tableHtml);
    const messageUrl = field(table, "消息链接");
    const publishedAt = field(table, "发布时间");
    const leakDataTypes = field(table, "泄露数据类型", "泄漏数据类型");
    const leakCount = field(table, "泄漏数量", "泄露数量");
    const attachmentHeading = [...section.matchAll(/<h3[^>]*>([\s\S]*?)<\/h3>/gi)].find((match) => decodeHtml(match[1]).includes("泄露内容附件"));
    const attachmentStart = attachmentHeading ? attachmentHeading.index + attachmentHeading[0].length : -1;
    const attachmentTail = attachmentStart >= 0 ? section.slice(attachmentStart) : "";
    const nextHeading = attachmentTail.search(/<h[23][^>]*>/i);
    const attachmentSection = nextHeading >= 0 ? attachmentTail.slice(0, nextHeading) : attachmentTail;
    const declaredNames = [...attachmentSection.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
      .map((match) => decodeHtml(match[1]))
      .filter((value) => /\.xlsx$/i.test(value));
    if (attachmentsRequired && !declaredNames.length) throw new Error(`事件“${heading}”未声明泄露内容附件`);
    const attachmentNames = declaredNames.flatMap((name) => {
      const matched = attachmentEntries.find((entry) => entry.name === name);
      if (matched) return [matched.name];
      if (attachmentsRequired) throw new Error(`事件“${heading}”声明的附件无法匹配：${name}`);
      warnings.push(`事件“${heading}”声明的附件未随 Word 文件上传：${name}`);
      return [];
    });
    events.push({
      title: heading.replace(/^发布\s*[:：]\s*/, "") || "未命名暗网数据泄漏事件",
      reportDate,
      sourceGroupName: field(table, "源头(TG群名称)", "源头（TG群名称）"),
      sourceGroupId: field(table, "源头(TG群ID)", "源头（TG群ID）"),
      sourceGroupUrl: field(table, "源头(TG群链接)", "源头（TG群链接）"),
      messageUrl,
      intelTags: reportTags(field(table, "情报标签", "情报分类", "标签"), leakDataTypes || leakCount || attachmentNames.length ? ["数据泄露"] : ["行业情报"]),
      leakDataTypes,
      leakCount,
      transactionCount: field(table, "交易次数"),
      transactionPrice: field(table, "交易价格"),
      publishedAt,
      publisherId: field(table, "发布人ID"),
      intelNote: field(table, "情报说明"),
      articleMarkdown,
      attachmentNames
    });
  }
  if (!events.length && !attachmentsRequired) {
    const heading = decodeHtml(html.match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i)?.[1] || "") || allText.split("\n").find(Boolean) || "未命名威胁情报";
    events.push({
      title: heading.replace(/^发布\s*[:：]\s*/, ""),
      reportDate,
      sourceGroupName: "",
      sourceGroupId: "",
      sourceGroupUrl: "",
      messageUrl: "",
      intelTags: ["行业情报"],
      leakDataTypes: "",
      leakCount: "",
      transactionCount: "",
      transactionPrice: "",
      publishedAt: reportDate,
      publisherId: "",
      intelNote: allText.slice(0, 4000),
      articleMarkdown,
      attachmentNames: []
    });
  }
  if (!events.length) throw new Error("DOCX 报告中未找到可识别的数据泄漏事件");
  return { reportDate, events, warnings };
}

export async function parseDarkWebArchive(buffer, archiveName = "暗网交付包.zip") {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error("暗网交付包为空");
  if (buffer.length > MAX_ARCHIVE_SIZE) throw new Error("暗网交付包超过 50 MB 限制");
  if (!/\.zip$/i.test(archiveName)) throw new Error("暗网情报录入只支持 .zip 文件");
  const entries = await readZipEntries(buffer);
  const reports = entries.filter((entry) => entry.extension === ".docx");
  const workbooks = entries.filter((entry) => entry.extension === ".xlsx");
  if (reports.length !== 1) throw new Error("暗网交付包必须且只能包含一份 DOCX 报告");
  if (!workbooks.length) throw new Error("暗网交付包至少需要一份 XLSX 附件");
  if (new Set(workbooks.map((entry) => entry.name)).size !== workbooks.length) throw new Error("暗网交付包中存在同名 XLSX，无法安全关联报告附件");
  for (const workbook of workbooks) await assertSafeOoxml(workbook.buffer);
  await assertSafeOoxml(reports[0].buffer);
  const attachments = workbooks.map((entry) => ({
    ...entry,
    sha256: sha256(entry.buffer),
    mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ...workbookMetrics(entry.buffer)
  }));
  const parsedReport = await parseReport(reports[0].buffer, attachments);
  const referencedNames = new Set(parsedReport.events.flatMap((event) => event.attachmentNames));
  const unmatched = attachments.filter((attachment) => !referencedNames.has(attachment.name));
  if (unmatched.length) throw new Error(`存在未被报告引用的 XLSX 附件：${unmatched.map((item) => item.name).join("、")}`);
  return {
    archive: { name: archiveName, buffer, sha256: sha256(buffer), mediaType: "application/zip" },
    report: { ...reports[0], sha256: sha256(reports[0].buffer), mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
    attachments,
    events: parsedReport.events,
    reportDate: parsedReport.reportDate,
    warnings: parsedReport.warnings
  };
}

export async function parseDarkWebDocument(buffer, documentName = "暗网情报报告.docx") {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error("暗网 Word 报告为空");
  if (buffer.length > MAX_ARCHIVE_SIZE) throw new Error("暗网 Word 报告超过 50 MB 限制");
  if (!/\.docx$/i.test(documentName)) throw new Error("暗网 Word 报告只支持 .docx 文件");
  const name = posix.basename(String(documentName).replaceAll("\\", "/"));
  const report = {
    path: name,
    name,
    extension: ".docx",
    buffer,
    sha256: sha256(buffer),
    mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  };
  await assertSafeOoxml(buffer);
  const parsedReport = await parseReport(buffer, [], { attachmentsRequired: false });
  return {
    archive: report,
    report,
    attachments: [],
    events: parsedReport.events,
    reportDate: parsedReport.reportDate,
    warnings: parsedReport.warnings
  };
}

export function parseDarkWebUpload(buffer, filename) {
  if (/\.zip$/i.test(filename || "")) return parseDarkWebArchive(buffer, filename);
  if (/\.docx$/i.test(filename || "")) return parseDarkWebDocument(buffer, filename);
  throw new Error("暗网情报录入只支持 .zip 交付包或 .docx Word 报告");
}

export const darkWebLimits = {
  maxArchiveSize: MAX_ARCHIVE_SIZE,
  maxEntryCount: MAX_ENTRY_COUNT,
  maxUncompressedSize: MAX_UNCOMPRESSED_SIZE,
  maxPreviewPageSize: MAX_PREVIEW_PAGE_SIZE,
  maxPreviewColumns: MAX_PREVIEW_COLUMNS
};
