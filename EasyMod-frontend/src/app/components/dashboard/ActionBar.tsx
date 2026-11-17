/**
 * Primary action bar (guardrails §24): exactly one primary action, secondary
 * actions beside it. The dashboard has no destructive operations, so
 * isDestructive/confirmationRequired are accepted for contract parity but
 * never set here. primaryTestId lets other redesigned pages (inbox) keep
 * their own proof hooks without forking the bar.
 */
import { cn } from "../ui/utils";
import { EmButton } from "./EmButton";
import type { Action } from "./types";

interface ActionBarProps {
  primaryAction: Action;
  secondaryActions?: Action[];
  loading?: boolean;
  isDestructive?: boolean;
  confirmationRequired?: boolean;
  className?: string;
  primaryTestId?: string;
}

export function ActionBar({
  primaryAction,
  secondaryActions,
  loading,
  isDestructive,
  className,
  primaryTestId = "dashboard-primary-action",
}: ActionBarProps) {
  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>
      <EmButton
        variant={isDestructive ? "danger" : "primary"}
        action={primaryAction}
        loading={loading}
        data-testid={primaryTestId}
      />
      {secondaryActions?.map((action) => (
        <EmButton key={action.label} variant="secondary" action={action} />
      ))}
      {primaryAction.disabled && primaryAction.disabledReason && (
        <p className="text-xs font-medium text-em-text-secondary">{primaryAction.disabledReason}</p>
      )}
    </div>
  );
}
