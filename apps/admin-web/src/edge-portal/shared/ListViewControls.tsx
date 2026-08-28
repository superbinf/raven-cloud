import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
  type ReactNode,
} from "react";
import {
  ArrowDown,
  ArrowUp,
  ChevronsUpDown,
  RotateCcw,
  Settings2,
} from "lucide-react";
import { cn } from "@/components/ui";

export type ListViewColumn = {
  id: string;
  label: string;
  defaultWidth?: number;
  minWidth?: number;
  sortable?: boolean;
};
export type ListSort = { id: string; direction: "asc" | "desc" } | null;

type ListViewPreferences = {
  hidden: string[];
  widths: Record<string, number>;
  sort: ListSort;
};

function readPreferences(
  storageKey: string,
  columns: ListViewColumn[],
): ListViewPreferences {
  try {
    const raw = window.localStorage.getItem(`sentinel.list-view.${storageKey}`);
    if (!raw) return { hidden: [], widths: {}, sort: null };
    const value = JSON.parse(raw) as Partial<ListViewPreferences>;
    return {
      hidden: Array.isArray(value.hidden)
        ? value.hidden.filter((id) =>
            columns.some((column) => column.id === id),
          )
        : [],
      widths:
        value.widths && typeof value.widths === "object"
          ? Object.fromEntries(
              Object.entries(value.widths).filter(
                ([id, width]) =>
                  columns.some((column) => column.id === id) &&
                  typeof width === "number",
              ),
            )
          : {},
      sort:
        value.sort && columns.some((column) => column.id === value.sort?.id)
          ? value.sort
          : null,
    };
  } catch {
    return { hidden: [], widths: {}, sort: null };
  }
}

export function useListViewPreferences(
  storageKey: string,
  columns: ListViewColumn[],
) {
  const columnIds = useMemo(
    () => columns.map((column) => column.id),
    [columns],
  );
  const [preferences, setPreferences] = useState<ListViewPreferences>(() =>
    readPreferences(storageKey, columns),
  );
  useEffect(() => {
    setPreferences((current) => ({
      ...current,
      hidden: current.hidden.filter((id) => columnIds.includes(id)),
      widths: Object.fromEntries(
        Object.entries(current.widths).filter(([id]) => columnIds.includes(id)),
      ),
      sort:
        current.sort && columnIds.includes(current.sort.id)
          ? current.sort
          : null,
    }));
  }, [columnIds]);
  useEffect(() => {
    window.localStorage.setItem(
      `sentinel.list-view.${storageKey}`,
      JSON.stringify(preferences),
    );
  }, [preferences, storageKey]);
  return {
    hidden: preferences.hidden,
    widths: preferences.widths,
    sort: preferences.sort,
    toggleColumn: (id: string) =>
      setPreferences((current) => ({
        ...current,
        hidden: current.hidden.includes(id)
          ? current.hidden.filter((value) => value !== id)
          : [...current.hidden, id],
      })),
    toggleSort: (id: string) =>
      setPreferences((current) => ({
        ...current,
        sort:
          current.sort?.id === id
            ? {
                id,
                direction: current.sort.direction === "asc" ? "desc" : "asc",
              }
            : { id, direction: "asc" },
      })),
    setColumnWidth: (id: string, width?: number) =>
      setPreferences((current) => {
        const widths = { ...current.widths };
        if (width === undefined) delete widths[id];
        else widths[id] = width;
        return { ...current, widths };
      }),
    columnWidth: (id: string) => preferences.widths[id],
    reset: () =>
      setPreferences({ hidden: [], widths: {}, sort: null }),
  };
}

export function sortListItems<T>(
  items: T[],
  sort: ListSort,
  accessors: Record<string, (item: T) => unknown>,
) {
  if (!sort || !accessors[sort.id]) return items;
  const normalize = (value: unknown) =>
    Array.isArray(value) ? value.join(" ") : (value ?? "");
  return items
    .map((item, index) => ({ item, index }))
    .sort((left, right) => {
      const a = normalize(accessors[sort.id](left.item));
      const b = normalize(accessors[sort.id](right.item));
      const compared =
        typeof a === "number" && typeof b === "number"
          ? a - b
          : String(a).localeCompare(String(b), "zh-CN", {
              numeric: true,
              sensitivity: "base",
            });
      return compared
        ? compared * (sort.direction === "asc" ? 1 : -1)
        : left.index - right.index;
    })
    .map(({ item }) => item);
}

export function listViewGridStyle(
  columns: ListViewColumn[],
  widths: Record<string, number>,
) {
  return Object.fromEntries(
    columns.map((column) => [
      `--list-${column.id}-width`,
      widths[column.id] !== undefined
        ? `${widths[column.id]}px`
        : `minmax(${column.minWidth ?? 72}px, ${column.defaultWidth ?? 140}fr)`,
    ]),
  ) as CSSProperties;
}

export function SortableResizableHeader({
  column,
  sort,
  width,
  onSort,
  onResize,
  className = "",
  leading,
}: {
  column: ListViewColumn;
  sort: ListSort;
  width?: number;
  onSort: (id: string) => void;
  onResize: (id: string, width?: number) => void;
  className?: string;
  leading?: ReactNode;
}) {
  const start = useRef({ x: 0, width: 0 });
  const minWidth = column.minWidth ?? 72;
  const active = sort?.id === column.id;
  const startResize = (event: PointerEvent<HTMLSpanElement>) => {
    event.preventDefault();
    event.stopPropagation();
    start.current = {
      x: event.clientX,
      width:
        width ??
        event.currentTarget.parentElement?.getBoundingClientRect().width ??
        column.defaultWidth ??
        minWidth,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.dataset.resizing = "true";
  };
  const moveResize = (event: PointerEvent<HTMLSpanElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    onResize(
      column.id,
      Math.max(
        minWidth,
        Math.round(start.current.width + event.clientX - start.current.x),
      ),
    );
  };
  const stopResize = (event: PointerEvent<HTMLSpanElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    delete event.currentTarget.dataset.resizing;
  };
  return (
    <span
      className={cn("table-column-header", className)}
      style={width ? { width } : undefined}
      role="columnheader"
      aria-sort={
        column.sortable === false
          ? undefined
          : active
            ? sort?.direction === "asc"
              ? "ascending"
              : "descending"
            : "none"
      }
    >
      {leading && <span className="table-header-leading">{leading}</span>}
      {column.sortable === false ? (
        <span className="table-sort-button table-sort-static">
          <span>{column.label}</span>
        </span>
      ) : (
        <button
          type="button"
          className="table-sort-button"
          onClick={() => onSort(column.id)}
          aria-label={`${column.label}，${active ? (sort?.direction === "asc" ? "当前升序，点击切换降序" : "当前降序，点击切换升序") : "点击排序"}`}
        >
          <span>{column.label}</span>
          {active ? (
            sort?.direction === "asc" ? (
              <ArrowUp size={12} />
            ) : (
              <ArrowDown size={12} />
            )
          ) : (
            <ChevronsUpDown size={12} />
          )}
        </button>
      )}
      <span
        className="table-column-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label={`调整${column.label}列宽`}
        tabIndex={0}
        data-column-resizer
        onPointerDown={startResize}
        onPointerMove={moveResize}
        onPointerUp={stopResize}
        onPointerCancel={stopResize}
        onDoubleClick={(event) => {
          event.stopPropagation();
          onResize(column.id);
        }}
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          onResize(
            column.id,
            Math.max(
              minWidth,
              (width ?? column.defaultWidth ?? minWidth) +
                (event.key === "ArrowRight" ? 12 : -12),
            ),
          );
        }}
      />
    </span>
  );
}

export function ListViewControls({
  columns,
  hidden,
  onToggleColumn,
  onReset,
}: {
  columns: ListViewColumn[];
  hidden: string[];
  onToggleColumn: (id: string) => void;
  onReset: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="list-view-controls">
      <button
        type="button"
        className={cn("list-view-settings", open && "active")}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Settings2 size={14} />
        表头设置
      </button>
      {open && (
        <div className="list-view-column-menu">
          <strong>显示列</strong>
          {columns.map((column) => (
            <label key={column.id}>
              <input
                type="checkbox"
                checked={!hidden.includes(column.id)}
                onChange={() => onToggleColumn(column.id)}
              />
              <span>{column.label}</span>
            </label>
          ))}
          <button type="button" className="list-view-reset" onClick={onReset}>
            <RotateCcw size={13} />
            恢复默认
          </button>
        </div>
      )}
    </div>
  );
}

export function ListViewFrame({
  hidden,
  className,
  children,
}: {
  hidden?: string[];
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "list-view-frame",
        className,
        ...(hidden ?? []).map((id) => `list-column-hidden-${id}`),
      )}
    >
      {children}
    </div>
  );
}
