import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

import { TodayNewBar } from "./TodayNewBar";

type ModuleHeaderProps = {
  icon: LucideIcon;
  eyebrow: string;
  title: string;
  todayCount: number;
  todayActive: boolean;
  todayLoading?: boolean;
  todayLabel?: string;
  onToggleToday: () => void;
  action?: ReactNode;
};

export function ModuleHeader({
  icon: Icon,
  eyebrow,
  title,
  todayCount,
  todayActive,
  todayLoading = false,
  todayLabel,
  onToggleToday,
  action,
}: ModuleHeaderProps) {
  return (
    <header className="module-heading module-overview-header">
      <div className="module-heading-icon">
        <Icon size={26} />
      </div>
      <div className="module-heading-copy">
        <span className="eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
      </div>
      <div className="module-heading-tools">
        <TodayNewBar
          count={todayCount}
          active={todayActive}
          onToggle={onToggleToday}
          loading={todayLoading}
          label={todayLabel}
        />
        {action}
      </div>
    </header>
  );
}
