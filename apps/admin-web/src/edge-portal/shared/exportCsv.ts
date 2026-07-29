export type CsvColumn<T> = {
  header: string;
  value: (row: T, index: number) => unknown;
};

export function csvCell(value: unknown) {
  if (value === null || value === undefined) return "";
  const text = Array.isArray(value)
    ? value.join("、")
    : typeof value === "object"
      ? JSON.stringify(value)
      : String(value);
  return `"${text.replaceAll("\"", "\"\"").replaceAll("\r", " ").replaceAll("\n", " ")}"`;
}

export function downloadCsv<T>(filename: string, columns: Array<CsvColumn<T>>, rows: T[]) {
  const lines = [
    columns.map((column) => csvCell(column.header)).join(","),
    ...rows.map((row, rowIndex) => columns.map((column) => csvCell(column.value(row, rowIndex))).join(","))
  ];
  const blob = new Blob([`\uFEFF${lines.join("\r\n")}`], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a");
  const url = URL.createObjectURL(blob);
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export async function fetchAllPages<T>(fetchPage: (page: number, pageSize: number) => Promise<{ data: T[]; total: number }>, pageSize = 100) {
  const rows: T[] = [];
  let page = 1;
  while (true) {
    const result = await fetchPage(page, pageSize);
    rows.push(...result.data);
    if (rows.length >= result.total || !result.data.length) return rows;
    page += 1;
  }
}

export function selectedOrAll<T>(rows: T[], selectedIds: Set<string>, idOf: (row: T, index: number) => string) {
  if (!selectedIds.size) return rows;
  return rows.filter((row, index) => selectedIds.has(idOf(row, index)));
}
