import { useEffect, useState } from "react";

import { Button } from "@/components/common";

type PaginationResetKey = string | number | boolean | null | undefined;

export function useClientPagination<T>(items: readonly T[], initialPageSize = 20, resetKey?: PaginationResetKey) {
  const [requestedPage, setRequestedPage] = useState(1);
  const [pageSize, setPageSize] = useState(initialPageSize);
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const page = Math.min(requestedPage, totalPages);

  useEffect(() => {
    setRequestedPage(1);
  }, [resetKey]);

  return {
    items: items.slice((page - 1) * pageSize, page * pageSize),
    page,
    pageSize,
    total: items.length,
    totalPages,
    setPage: (nextPage: number) => setRequestedPage(Math.max(1, Math.min(totalPages, nextPage))),
    setPageSize: (nextPageSize: number) => { setPageSize(nextPageSize); setRequestedPage(1); }
  };
}

export function TablePagination({ page, pageSize, totalPages, total, loading = false, pageSizeOptions = [10, 20, 50, 100], onPageChange, onPageSizeChange, setPageSize }: {
  page: number;
  pageSize?: number;
  totalPages: number;
  total: number;
  loading?: boolean;
  pageSizeOptions?: number[];
  onPageChange: (page: number) => void;
  onPageSizeChange?: (pageSize: number) => void;
  setPageSize?: (pageSize: number) => void;
}) {
  return <footer className="audit-pagination" aria-label="表格分页">
    <span aria-live="polite">第 {page} / {totalPages} 页，共 {total.toLocaleString("zh-CN")} 条</span>
    <div>
      {pageSize && (onPageSizeChange || setPageSize) && <label className="table-page-size">每页<select aria-label="每页显示条数" value={pageSize} disabled={loading} onChange={(event) => (onPageSizeChange ?? setPageSize)?.(Number(event.target.value))}>{pageSizeOptions.map((option) => <option value={option} key={option}>{option}</option>)}</select>条</label>}
      <Button variant="ghost" disabled={page <= 1 || loading} onClick={() => onPageChange(page - 1)}>上一页</Button>
      <Button variant="ghost" disabled={page >= totalPages || loading} onClick={() => onPageChange(page + 1)}>下一页</Button>
    </div>
  </footer>;
}
