import mammoth from "mammoth";
import XLSX from "xlsx";

const MAX_PREVIEW_PAGE_SIZE = 100;
const MAX_PREVIEW_COLUMNS = 100;
const MAX_PREVIEW_CELL_LENGTH = 2_000;
const MAX_WORD_PREVIEW_LENGTH = 1_000_000;

function worksheetRows(worksheet) {
  return XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: "", raw: false, blankrows: false })
    .filter((row) => row.some((value) => String(value ?? "").trim() !== ""));
}

function previewCell(value) {
  const text = String(value ?? "");
  return text.length > MAX_PREVIEW_CELL_LENGTH ? `${text.slice(0, MAX_PREVIEW_CELL_LENGTH)}…` : text;
}

function sanitizeWordHtml(value) {
  const allowedTags = new Set(["p", "br", "h1", "h2", "h3", "h4", "h5", "h6", "strong", "b", "em", "i", "u", "s", "ul", "ol", "li", "table", "thead", "tbody", "tfoot", "tr", "th", "td", "blockquote", "pre", "code"]);
  return String(value || "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|iframe|object|embed|svg|math)[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<\/?([a-z][a-z0-9-]*)\b[^>]*>/gi, (tag, name) => {
      const normalized = String(name).toLowerCase();
      if (!allowedTags.has(normalized)) return "";
      return tag.startsWith("</") ? `</${normalized}>` : normalized === "br" ? "<br>" : `<${normalized}>`;
    });
}

export async function createWordPreview(buffer) {
  const converted = await mammoth.convertToHtml({ buffer });
  const sanitized = sanitizeWordHtml(converted.value);
  const truncated = sanitized.length > MAX_WORD_PREVIEW_LENGTH;
  return {
    kind: "word",
    html: truncated ? `${sanitized.slice(0, MAX_WORD_PREVIEW_LENGTH)}<p>预览内容过长，已截断。</p>` : sanitized,
    truncated,
    warnings: converted.messages.map((message) => message.message)
  };
}

export function createWorkbookPreview(buffer, options = {}) {
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: false, raw: false });
  const sheets = workbook.SheetNames.map((name) => {
    const rows = worksheetRows(workbook.Sheets[name]);
    return {
      name,
      rowCount: rows.length,
      columnCount: rows.reduce((count, row) => Math.max(count, row.length), 0)
    };
  });
  const requestedSheet = Number(options.sheet);
  const sheetIndex = Math.min(Math.max(Number.isInteger(requestedSheet) ? requestedSheet : 0, 0), Math.max(0, sheets.length - 1));
  const page = Math.max(1, Math.floor(Number(options.page) || 1));
  const pageSize = Math.min(MAX_PREVIEW_PAGE_SIZE, Math.max(1, Math.floor(Number(options.pageSize) || 50)));
  const sheet = sheets[sheetIndex];
  const allRows = sheet ? worksheetRows(workbook.Sheets[sheet.name]) : [];
  const start = (page - 1) * pageSize;
  const rows = allRows.slice(start, start + pageSize).map((row) => row.slice(0, MAX_PREVIEW_COLUMNS).map(previewCell));
  const totalPages = Math.max(1, Math.ceil(allRows.length / pageSize));
  return {
    kind: "spreadsheet",
    sheets,
    sheetIndex,
    page: Math.min(page, totalPages),
    pageSize,
    totalRows: allRows.length,
    totalPages,
    displayedColumns: Math.min(sheet?.columnCount || 0, MAX_PREVIEW_COLUMNS),
    columnsTruncated: (sheet?.columnCount || 0) > MAX_PREVIEW_COLUMNS,
    rows: page > totalPages ? allRows.slice((totalPages - 1) * pageSize, totalPages * pageSize).map((row) => row.slice(0, MAX_PREVIEW_COLUMNS).map(previewCell)) : rows
  };
}
