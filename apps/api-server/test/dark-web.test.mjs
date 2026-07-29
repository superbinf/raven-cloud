import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import XLSX from "xlsx";
import { createWorkbookPreview, createWordPreview, parseDarkWebArchive, parseDarkWebDocument, parseDarkWebUpload } from "../src/dark-web.mjs";
import { standaloneWordReport, unstructuredWordArticle } from "./support/dark-web-docx.mjs";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const samples = [
  { name: "20260630-重庆长安汽车股份有限公司-暗网数据.zip", rows: 265 },
  { name: "20260707-重庆长安汽车股份有限公司-暗网数据.zip", rows: 266 }
];

test("真实长安暗网交付包解析为独立事件并生成受控文件预览", async (t) => {
  const missing = samples.filter((sample) => !existsSync(join(projectRoot, "templates", sample.name)));
  if (missing.length) { t.skip(`本地未提供受控真实交付样本：${missing.map((sample) => sample.name).join("、")}`); return; }
  const parsed = [];
  for (const sample of samples) {
    const path = join(projectRoot, "templates", sample.name);
    const result = await parseDarkWebArchive(await readFile(path), basename(path));
    assert.equal(result.events.length, 1);
    assert.equal(result.attachments.length, 1);
    assert.equal(result.attachments[0].rowCount, sample.rows);
    assert.ok(result.attachments[0].sheetCount >= 1);
    assert.match(result.events[0].messageUrl, /^https?:\/\//);
    assert.deepEqual(result.events[0].attachmentNames, [result.attachments[0].name]);
    const wordPreview = await createWordPreview(result.report.buffer);
    assert.equal(wordPreview.kind, "word");
    assert.match(wordPreview.html, /重庆长安汽车股份有限公司/);
    assert.doesNotMatch(wordPreview.html, /<(script|iframe|object|embed|svg|img|a)\b/i);
    const workbookPreview = createWorkbookPreview(result.attachments[0].buffer, { sheet: 0, page: 1, pageSize: 50 });
    assert.equal(workbookPreview.kind, "spreadsheet");
    assert.equal(workbookPreview.totalRows, sample.rows);
    assert.equal(workbookPreview.rows.length, Math.min(50, sample.rows));
    assert.equal(workbookPreview.sheets.length, result.attachments[0].sheetCount);
    assert.ok(workbookPreview.displayedColumns > 0);
    parsed.push(result);
  }
  assert.notEqual(parsed[0].events[0].messageUrl, parsed[1].events[0].messageUrl);
});

test("拒绝空包和非 ZIP 文件", async () => {
  await assert.rejects(() => parseDarkWebArchive(Buffer.alloc(0), "empty.zip"), /为空/);
  await assert.rejects(() => parseDarkWebArchive(Buffer.from("not-a-zip"), "report.xlsx"), /只支持/);
});

test("仅有 DOCX 的暗网情报可独立解析并预览", async () => {
  const buffer = await standaloneWordReport();
  const parsed = await parseDarkWebDocument(buffer, "仅Word暗网情报.docx");
  assert.equal(parsed.events.length, 1);
  assert.equal(parsed.attachments.length, 0);
  assert.equal(parsed.events[0].title, "仅 Word 暗网情报");
  assert.equal(parsed.events[0].messageUrl, "报告原文未提供链接");
  assert.deepEqual(parsed.events[0].intelTags, ["数据泄露"]);
  assert.equal(parsed.events[0].publishedAt, "");
  assert.deepEqual(parsed.events[0].attachmentNames, []);
  assert.equal(parsed.archive.mediaType, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  assert.equal((await parseDarkWebUpload(buffer, "仅Word暗网情报.docx")).events.length, 1);
  const preview = await createWordPreview(buffer);
  assert.equal(preview.kind, "word");
  assert.match(preview.html, /仅 Word 暗网情报/);
});

test("无事件表格和链接的 Word 文章可作为通用威胁情报解析", async () => {
  const parsed = await parseDarkWebDocument(await unstructuredWordArticle(), "通用威胁情报.docx");
  assert.equal(parsed.events.length, 1);
  assert.equal(parsed.events[0].title, "勒索软件组织活动观察");
  assert.equal(parsed.events[0].messageUrl, "");
  assert.equal(parsed.events[0].sourceGroupName, "");
  assert.deepEqual(parsed.events[0].intelTags, ["行业情报"]);
  assert.match(parsed.events[0].intelNote, /不限定具体企业/);
  assert.match(parsed.events[0].articleMarkdown, /^# /);
});

test("XLSX 在线预览支持工作表选择、分页和单元格长度限制", () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["标题", "内容"], ["第一行", "A".repeat(2_100)], ["第二行", "普通内容"]]), "泄漏明细");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["统计"], [2]]), "统计");
  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
  const firstPage = createWorkbookPreview(buffer, { sheet: 0, page: 1, pageSize: 2 });
  assert.equal(firstPage.sheets.length, 2);
  assert.equal(firstPage.totalRows, 3);
  assert.equal(firstPage.totalPages, 2);
  assert.equal(firstPage.rows.length, 2);
  assert.match(firstPage.rows[1][1], /…$/);
  const secondSheet = createWorkbookPreview(buffer, { sheet: 1, page: 1, pageSize: 50 });
  assert.equal(secondSheet.sheets[secondSheet.sheetIndex].name, "统计");
  assert.deepEqual(secondSheet.rows, [["统计"], ["2"]]);
});
