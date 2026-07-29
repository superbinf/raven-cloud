export interface WordPreview {
  kind: "word";
  html: string;
  truncated: boolean;
  warnings: string[];
}

export interface WorkbookPreviewOptions {
  sheet?: number;
  page?: number;
  pageSize?: number;
}

export interface WorkbookPreview {
  kind: "spreadsheet";
  sheets: Array<{ name: string; rowCount: number; columnCount: number }>;
  sheetIndex: number;
  page: number;
  pageSize: number;
  totalRows: number;
  totalPages: number;
  displayedColumns: number;
  columnsTruncated: boolean;
  rows: string[][];
}

export function createWordPreview(buffer: Uint8Array): Promise<WordPreview>;
export function createWorkbookPreview(buffer: Uint8Array, options?: WorkbookPreviewOptions): WorkbookPreview;
