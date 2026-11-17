/**
 * Shared shell navigation item (guardrails §15/§18). One component for the
 * sidebar rail (main/settings/billing) and the mobile tab bar so active,
 * hover, focus and collapsed states can never drift between the four former
 * inline copies. IA (labels/paths/order) is owned by DashboardLayout.
 */
import { Link } from "react-router-dom";
import type { LucideIcon } from "lucide-react";
import { cn } from "../ui/utils";

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-em-focus-light focus-visible:transition-none";

export interface ShellNavItemProps {
  name: string;
  path: string;
  icon: LucideIcon;
  isActive: boolean;
  collapsed?: boolean;
  variant?: "rail" | "mobile";
}

export function ShellNavItem({
  name,
  path,
  icon: Icon,
  isActive,
  collapsed = false,
  variant = "rail",
}: ShellNavItemProps) {
  if (variant === "mobile") {
    return (
      <Link
        to={path}
        aria-current={isActive ? "page" : undefined}
        className={cn(
          "flex min-h-12 flex-col items-center justify-center rounded-lg px-1 text-xs font-semibold transition-colors",
          FOCUS_RING,
          isActive ? "bg-em-violet-50 text-em-violet-700" : "text-em-text-secondary hover:bg-em-bg-muted",
        )}
      >
        <Icon className="mb-1 h-4 w-4" aria-hidden="true" />
        <span className="leading-none">{name}</span>
      </Link>
    );
  }

  return (
    <Link
      to={path}
      aria-current={isActive ? "page" : undefined}
      aria-label={collapsed ? name : undefined}
      title={collapsed ? name : undefined}
      className={cn(
        // 44px touch target (guardrails §18) — the rail is also the navigation
        // on tablets, where the pointer is a finger. The nav scrolls, so the
        // extra height cannot push the sidebar footer out of view.
        "group relative flex min-h-11 items-center gap-3 rounded-lg px-3 py-2.5 transition-colors",
        FOCUS_RING,
        isActive
          ? "bg-em-violet-50 text-em-violet-700"
          : "text-em-text-secondary hover:bg-em-bg-muted hover:text-em-text-primary",
      )}
    >
      <Icon className="w-5 h-5 shrink-0" aria-hidden="true" />
      {!collapsed && <span className="text-sm font-medium">{name}</span>}
      {isActive && (
        <span className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-6 bg-em-violet-600 rounded-r-full" aria-hidden="true" />
      )}
    </Link>
  );
}
