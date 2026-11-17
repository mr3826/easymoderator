/**
 * Result banner (guardrails §24): success/error/pending with evidence and a
 * next action. Errors say what failed, the impact, and what to do (§16).
 */
import { CheckCircle2, Clock4, OctagonX, type LucideIcon } from "lucide-react";
import { cn } from "../ui/utils";
import { EmButton } from "./EmButton";
import type { Action } from "./types";

interface ResultBannerProps {
  status: "success" | "error" | "pending";
  title: string;
  description: string;
  evidenceId?: string;
  nextAction?: Action;
  className?: string;
}

const tones: Record<ResultBannerProps["status"], string> = {
  success: "border-em-success-700/20 bg-em-success-100 text-em-success-700",
  error: "border-em-danger-700/20 bg-em-danger-100 text-em-danger-700",
  pending: "border-em-info-700/20 bg-em-info-100 text-em-info-700",
};

const icons: Record<ResultBannerProps["status"], LucideIcon> = {
  success: CheckCircle2,
  error: OctagonX,
  pending: Clock4,
};

export function ResultBanner({ status, title, description, evidenceId, nextAction, className }: ResultBannerProps) {
  const Icon = icons[status];
  return (
    <section
      role={status === "error" ? "alert" : "status"}
      className={cn("rounded-xl border p-4", tones[status], className)}
    >
      <div className="flex items-start gap-3">
        <Icon className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold">{title}</h3>
          <p className="mt-1 text-sm">{description}</p>
          {evidenceId && <p className="em-tabular mt-1 text-xs font-medium">{evidenceId}</p>}
          {nextAction && (
            <EmButton
              className="mt-3"
              variant={status === "error" ? "primary" : "secondary"}
              action={nextAction}
            />
          )}
        </div>
      </div>
    </section>
  );
}
