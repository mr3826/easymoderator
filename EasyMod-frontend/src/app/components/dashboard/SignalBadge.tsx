/**
 * Workflow signal badge (guardrails §8): icon + visible label, never color
 * alone. One dominant signal per screen; the header badge announces politely.
 */
import {
  BadgeCheck,
  CheckCircle2,
  Clock4,
  Eye,
  OctagonX,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import { cn } from "../ui/utils";
import type { Signal, SignalKind } from "./types";

const icons: Record<SignalKind, LucideIcon> = {
  healthy: CheckCircle2,
  attention: TriangleAlert,
  review: Eye,
  blocked: OctagonX,
  resolved: BadgeCheck,
  pending: Clock4,
};

const tones: Record<SignalKind, string> = {
  healthy: "border-em-success-700/20 bg-em-success-100 text-em-success-700",
  attention: "border-em-sunlight-600/30 bg-em-sunlight-100 text-em-sunlight-700",
  review: "border-em-violet-600/20 bg-em-violet-100 text-em-violet-700",
  blocked: "border-em-danger-700/20 bg-em-danger-100 text-em-danger-700",
  resolved: "border-em-success-700/20 bg-em-success-100 text-em-success-700",
  pending: "border-em-info-700/20 bg-em-info-100 text-em-info-700",
};

interface SignalBadgeProps {
  signal: Signal;
  size?: "sm" | "md";
  announce?: boolean;
  className?: string;
  "data-testid"?: string;
}

export function SignalBadge({ signal, size = "sm", announce, className, "data-testid": testId }: SignalBadgeProps) {
  const Icon = icons[signal.kind];
  return (
    <span
      role={announce ? "status" : undefined}
      data-testid={testId}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border font-semibold",
        size === "md" ? "px-3 py-1.5 text-sm" : "px-2.5 py-1 text-xs",
        tones[signal.kind],
        className,
      )}
    >
      <Icon className={size === "md" ? "h-4 w-4" : "h-3.5 w-3.5"} aria-hidden="true" />
      <span>{signal.label}</span>
      {signal.reason && <span className="text-xs font-normal">· {signal.reason}</span>}
    </span>
  );
}
