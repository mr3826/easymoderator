/**
 * Page-level loading skeleton (guardrails §16): preserves the full screen
 * anatomy so layout does not jump when data arrives.
 */
import { useTranslation } from "react-i18next";
import { Skeleton } from "../ui/skeleton";

function Bar({ className }: { className?: string }) {
  return <Skeleton className={`bg-em-bg-muted ${className ?? ""}`} />;
}

export function DashboardSkeleton({ label }: { label?: string }) {
  const { t } = useTranslation();
  const text = label ?? t("dashboard.pulse.loading");
  return (
    <div role="status" aria-label={text} className="min-h-full">
      <span className="sr-only">{text}</span>
      <div className="mb-6">
        <Bar className="mb-2 h-3 w-40" />
        <Bar className="h-7 w-56" />
        <Bar className="mt-2 h-4 w-72 max-w-full" />
        <div className="mt-4 flex gap-2">
          <Bar className="h-11 w-40" />
          <Bar className="h-11 w-24" />
        </div>
      </div>
      <div className="mb-4 grid grid-cols-1 gap-2 sm:grid-cols-3">
        <Bar className="h-11" />
        <Bar className="h-11" />
        <Bar className="h-11" />
      </div>
      <div className="mb-4 rounded-xl border border-em-border bg-em-bg-surface p-4">
        <Bar className="mb-3 h-5 w-44" />
        <Bar className="mb-2 h-14" />
        <Bar className="h-14" />
      </div>
      <div className="mb-4 rounded-xl border border-em-border bg-em-bg-surface p-4">
        <Bar className="mb-3 h-5 w-40" />
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <Bar className="h-28" />
          <Bar className="h-28" />
          <Bar className="h-28" />
        </div>
      </div>
      <div className="rounded-xl border border-em-border bg-em-bg-surface p-4">
        <Bar className="mb-3 h-5 w-32" />
        <Bar className="mb-2 h-12" />
        <Bar className="mb-2 h-12" />
        <Bar className="h-12" />
      </div>
    </div>
  );
}
