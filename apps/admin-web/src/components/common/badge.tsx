import type { ComponentProps, ReactNode } from "react";
import type { RiskLevel } from "@sentinel/shared";

import { cn } from "@/utils/cn";

export function Badge({ className, ...props }: ComponentProps<"span">) {
  return <span data-slot="badge" className={cn("inline-flex min-h-6 w-fit shrink-0 items-center justify-center rounded-md border px-2 py-0.5 text-xs font-medium whitespace-nowrap", className)} {...props} />;
}

export function Tag({ children, tone = "default" }: { children: ReactNode; tone?: "default" | "cyan" | "pink" | "orange" | "green" }) {
  return <Badge className={cn("tag", `tag-${tone}`)}>{children}</Badge>;
}

export function RiskBadge({ level, children }: { level: RiskLevel; children?: ReactNode }) {
  const labels: Record<RiskLevel, string> = { critical: "严重", high: "高危", medium: "中危", low: "低危", info: "信息" };
  const safeLevel: RiskLevel = level in labels ? level : "info";
  return <Badge className={cn("risk-badge", `risk-${safeLevel}`)}>{children ?? labels[safeLevel]}</Badge>;
}

export function StatusDot({ tone = "success", label, live = false }: { tone?: "success" | "warning" | "danger" | "muted"; label: string; live?: boolean }) {
  return <Badge className={cn("status", `status-tone-${tone}`, live && "status-live")}><span className={cn("status-dot", `status-${tone}`)} aria-hidden="true" />{label}</Badge>;
}
