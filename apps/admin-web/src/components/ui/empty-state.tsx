import type { ReactNode } from "react";

export function EmptyState({ title, description, icon }: { title: string; description?: string; icon?: ReactNode }) {
  return <div className="empty-state grid justify-items-center gap-2 py-10 text-center text-muted-foreground">{icon}<strong className="text-foreground">{title}</strong>{description && <span>{description}</span>}</div>;
}
