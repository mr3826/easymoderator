/**
 * Page-scoped button for the dashboard redesign (guardrails §11). Composes the
 * shared kit Button without editing it: violet primary, midnight-border
 * secondary, ghost, danger, and sunlight attention (midnight text — never
 * white on sunlight). 44px minimum target; focus handled by the .em-dashboard
 * scope outline.
 */
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { Button } from "../ui/button";
import { cn } from "../ui/utils";
import type { Action } from "./types";

export type EmButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "attention";

const variantClasses: Record<EmButtonVariant, string> = {
  primary: "bg-em-violet-600 text-white hover:bg-em-violet-700",
  secondary: "border border-em-border-strong bg-em-bg-surface text-em-text-primary hover:bg-em-bg-muted",
  ghost: "text-em-violet-700 hover:bg-em-violet-50",
  danger: "bg-em-danger-700 text-white hover:bg-em-danger-700/90",
  attention: "bg-em-sunlight-500 text-em-midnight-900 hover:bg-em-sunlight-300",
};

interface EmButtonProps {
  variant?: EmButtonVariant;
  action?: Action;
  children?: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  loading?: boolean;
  className?: string;
  title?: string;
  "data-testid"?: string;
}

export function EmButton({
  variant = "secondary",
  action,
  children,
  onClick,
  disabled,
  loading,
  className,
  title,
  "data-testid": testId,
}: EmButtonProps) {
  const isDisabled = Boolean(disabled || action?.disabled || loading);
  const label = children ?? action?.label;
  const classes = cn(
    // Explicit focus-visible outline utilities: the kit base ships outline-none,
    // and a scoped descendant rule alone proved engine-dependent in CI.
    "min-h-11 rounded-lg px-4 text-sm font-semibold focus-visible:ring-[0px] focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-em-focus-light",
    variantClasses[variant],
    className,
  );
  const content = (
    <>
      {loading && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
      {label}
    </>
  );
  const disabledReason = action?.disabledReason;

  if (action?.to && !isDisabled) {
    return (
      <Button asChild variant="ghost" className={classes} data-testid={testId} title={title}>
        <Link to={action.to} aria-label={typeof label === "string" ? label : undefined}>
          {content}
        </Link>
      </Button>
    );
  }

  return (
    <Button
      variant="ghost"
      className={classes}
      onClick={action?.onClick ?? onClick}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      title={title ?? (isDisabled ? disabledReason : undefined)}
      data-testid={testId}
    >
      {content}
    </Button>
  );
}
