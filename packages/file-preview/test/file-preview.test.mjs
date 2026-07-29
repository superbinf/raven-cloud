import assert from "node:assert/strict";
import test from "node:test";
import XLSX from "xlsx";
import { createWorkbookPreview } from "../src/index.mjs";

test("workbook preview paginates every local row and limits oversized cells", () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["标题", "内容"], ["第一行", "A".repeat(2_100)], ["第二行", "普通内容"]]), "泄漏明细");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["统计"], [2]]), "统计");
  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
  const firstPage = createWorkbookPreview(buffer, { sheet: 0, page: 1, pageSize: 2 });
  assert.equal(firstPage.sheets.length, 2);
  assert.equal(firstPage.totalRows, 3);
  assert.equal(firstPage.totalPages, 2);
  assert.match(firstPage.rows[1][1], /…$/);
  const secondSheet = createWorkbookPreview(buffer, { sheet: 1, page: 1, pageSize: 50 });
  assert.deepEqual(secondSheet.rows, [["统计"], ["2"]]);
});
