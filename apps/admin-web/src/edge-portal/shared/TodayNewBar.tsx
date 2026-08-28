import { CalendarPlus, Layers3, ListFilter } from "lucide-react";
import { cn } from "@/components/ui";

export function TodayCountBadge({ count, className }: { count: number; className?: string }) {
  return <span className={cn("today-count-badge", count === 0 && "today-count-badge-empty", className)} aria-label={`今日新增 ${count} 条`}>+{count.toLocaleString("zh-CN")}</span>;
}

export function NewCornerBadge() {
  return <span className="new-corner-badge" aria-label="今日新增记录">新增</span>;
}

export function TodayNewBar({ count, active, onToggle, label = "今日新增", loading = false }: { count: number; active: boolean; onToggle: () => void; label?: string; loading?: boolean }) {
  return <section className={cn("today-new-bar", active && "today-new-bar-active")} aria-label={`${label}快速筛选`}>
    <span className="today-new-icon"><CalendarPlus size={20} /></span>
    <span className="today-new-copy"><span>{label}</span><strong>{loading ? "--" : `+${count.toLocaleString("zh-CN")}`}<small> 条</small></strong></span>
    <button type="button" aria-pressed={active} disabled={loading} onClick={onToggle}>{active ? <Layers3 size={16} /> : <ListFilter size={16} />}{active ? "查看全部数据" : "查看今日新增"}</button>
  </section>;
}
