/**
 * Shared shell navigation item (guardrails §15/§18). One component for the
 * sidebar rail (workspace/settings/account-ops groups) and the mobile tab
 * bar so active, hover, focus and collapsed states can never drift between
 * the four former inline copies. IA (labels/paths/order) is owned by
 * DashboardLayout.
 *
 * D1 nav badges: when a badge is present the link ITSELF carries the
 * filtered destination (badgeHref) — one anchor, no nested interactive
 * elements, so keyboard traversal stays one stop per item. The pill is
 * aria-hidden and the honest sentence (nav.badges.*) rides inside the link
 * as sr-only text (rail/mobile) or inside the collapsed link's aria-label,
 * so the accessible name always states WHAT and HOW MANY. Motion: none —
 * badge changes are high-frequency passive data (design-motion frequency
 * gate); the pill swaps in place.
 */
import { Link } from "react-router-dom";
import type { LucideIcon } from "lucide-react";
import { cn } from "../ui/utils";
import type { NavBadge } from "./useNavBadges";

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-em-focus-light focus-visible:transition-none";

export interface ShellNavItemProps {
  name: string;
  path: string;
  icon: LucideIcon;
  isActive: boolean;
  collapsed?: boolean;
  variant?: "rail" | "mobile";
  /** Honest badge from useNavBadges; null (failure/zero) renders nothing. */
  badge?: NavBadge | null;
  /** Filtered destination carried by the link while the badge is present. */
  badgeHref?: string;
}

export function ShellNavItem({
  name,
  path,
  icon: Icon,
  isActive,
  collapsed = false,
  variant = "rail",
  badge = null,
  badgeHref,
}: ShellNavItemProps) {
  const to = badge ? badgeHref ?? path : path;

  if (variant === "mobile") {
    return (
      <Link
        to={to}
        aria-current={isActive ? "page" : undefined}
        className={cn(
          "relative flex min-h-12 flex-col items-center justify-center rounded-lg px-1 text-xs font-semibold transition-colors",
          FOCUS_RING,
          isActive ? "bg-em-violet-700 text-white" : "text-em-midnight-200 hover:bg-em-midnight-700 hover:text-white",
        )}
      >
        <span className="relative">
          <Icon className="mb-1 h-4 w-4" aria-hidden="true" />
          {badge && (
            <span
              aria-hidden="true"
              className="absolute -right-2.5 -top-1.5 min-w-4 rounded-full bg-em-sunlight-500 px-1 text-center text-[10px] font-bold leading-4 text-em-midnight-950"
            >
              {badge.display}
            </span>
          )}
        </span>
        <span className="leading-tight break-words text-center">{name}</span>
        {badge && <span className="sr-only">{` ${badge.aria}`}</span>}
      </Link>
    );
  }

  return (
    <Link
      to={to}
      aria-current={isActive ? "page" : undefined}
      // Collapsed: the accessible name must still carry the count (icons +
      // tooltips + aria remain — mission D9), so the sentence folds into the
      // label instead of an extra announced fragment.
      aria-label={collapsed ? (badge ? `${name}: ${badge.aria}` : name) : undefined}
      title={collapsed ? name : undefined}
      className={cn(
        // 44px touch target (guardrails §18) — the rail is also the navigation
        // on tablets, where the pointer is a finger. The nav scrolls, so the
        // extra height cannot push the sidebar footer out of view.
        "group relative flex min-h-11 items-center gap-3 rounded-lg px-3 py-2.5 transition-colors",
        FOCUS_RING,
        isActive
          ? "bg-em-violet-700 text-white"
          : "text-em-midnight-200 hover:bg-em-midnight-700 hover:text-white",
      )}
    >
      <Icon className="w-5 h-5 shrink-0" aria-hidden="true" />
      {!collapsed && <span className="text-sm font-medium">{name}</span>}
      {collapsed && badge && (
        <span
          aria-hidden="true"
          className="absolute right-1 top-1 min-w-[18px] rounded-full bg-em-sunlight-500 px-1 text-center text-[10px] font-bold leading-[14px] text-em-midnight-950"
        >
          {badge.display}
        </span>
      )}
      {!collapsed && badge && (
        <span
          aria-hidden="true"
          className="ml-auto min-w-[1.25rem] rounded-full bg-em-sunlight-500 px-1.5 py-0.5 text-center text-[11px] font-bold leading-none text-em-midnight-950 tabular-nums"
        >
          {badge.display}
        </span>
      )}
      {!collapsed && badge && <span className="sr-only">{` ${badge.aria}`}</span>}
      {isActive && (
        <span className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-6 bg-em-sunlight-500 rounded-r-full" aria-hidden="true" />
      )}
    </Link>
  );
}
