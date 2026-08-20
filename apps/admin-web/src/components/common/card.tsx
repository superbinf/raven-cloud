import type { ComponentProps, HTMLAttributes, ReactNode } from "react";

import { cn } from "@/utils/cn";

export function Card({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="card" className={cn("flex flex-col rounded-lg border border-border bg-card text-card-foreground shadow-sm", className)} {...props} />;
}

export function CardHeader({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="card-header" className={cn("flex items-center justify-between gap-4 border-b border-border px-4 py-3", className)} {...props} />;
}

export function CardContent({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="card-content" className={cn("min-w-0 p-4", className)} {...props} />;
}

export function Panel({ title, action, className, children, ...props }: Omit<HTMLAttributes<HTMLElement>, "title"> & { title?: ReactNode; action?: ReactNode }) {
  return <section data-slot="card" className={cn("panel overflow-hidden rounded-lg border border-border bg-card", className)} {...props}>
    {(title || action) && <header className="panel-header flex min-h-12 items-center justify-between gap-4 border-b border-border px-4"><div className="panel-title font-semibold">{title}</div>{action}</header>}
    <div className="panel-body min-w-0">{children}</div>
  </section>;
}
