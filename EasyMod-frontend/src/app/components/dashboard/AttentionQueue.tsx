/**
 * "What needs attention" — the verified work queue (guardrails §21.1 Attention
 * needed / §16 empty states). Baseline grouping, coverage honesty and deep
 * links preserved; rows are real Links to the exact record or filtered queue.
 */
import { Link } from "react-router-dom";
import { CheckCircle2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { WORK_ITEMS_PER_GROUP } from "./derive";
import type { WorkGroup } from "./types";

interface AttentionQueueProps {
  groups: WorkGroup[];
  hasAllWorkSources: boolean;
  caughtUp: boolean;
}

export function AttentionQueue({ groups, hasAllWorkSources, caughtUp }: AttentionQueueProps) {
  const { t } = useTranslation();

  if (caughtUp) {
    return (
      <p
        role="status"
        className="mb-4 flex items-center gap-2 rounded-xl border border-em-success-700/20 bg-em-success-100 p-4 text-sm font-semibold text-em-success-700"
      >
        <CheckCircle2 className="h-5 w-5 shrink-0" aria-hidden="true" />
        {t("dashboard.pulse.work.caughtUp")}
      </p>
    );
  }

  return (
    <section
      className="mb-4 rounded-xl border border-em-border bg-em-bg-surface p-4"
      aria-labelledby="dashboard-work-heading"
    >
      <div className="mb-3">
        <h2 id="dashboard-work-heading" className="text-lg font-semibold text-em-text-primary">
          {t("dashboard.pulse.work.title")}
        </h2>
        <p className="text-sm text-em-text-secondary">{t("dashboard.pulse.work.subtitle")}</p>
      </div>

      {groups.length > 0 ? (
        <div className="space-y-4">
          {groups.map((group) => (
            <section key={group.kind} aria-labelledby={`dashboard-work-${group.kind}`}>
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <h3 id={`dashboard-work-${group.kind}`} className="text-sm font-semibold text-em-text-primary">
                  {group.title}
                </h3>
                <Link
                  to={group.to}
                  className="inline-flex min-h-11 items-center rounded text-xs font-semibold text-em-violet-700 hover:underline"
                >
                  {group.action}
                </Link>
              </div>
              <div className="space-y-2">
                {group.visibleItems.map((item) => {
                  const Icon = item.icon;
                  return (
                    <Link
                      key={item.id}
                      to={item.to}
                      className="flex min-h-14 w-full items-center gap-3 rounded-lg border border-em-border bg-em-bg-app p-3 text-left hover:border-em-violet-300 hover:bg-em-violet-50"
                    >
                      <Icon className="h-5 w-5 shrink-0 text-em-violet-700" aria-hidden="true" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-semibold text-em-text-primary">{item.title}</span>
                        <span className="block truncate text-xs text-em-text-secondary">{item.detail}</span>
                      </span>
                      <span className="shrink-0 text-xs font-semibold text-em-violet-700">{item.action}</span>
                    </Link>
                  );
                })}
              </div>
              {group.hiddenCount > 0 && (
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-em-text-secondary" role="note">
                  <span>{t("dashboard.pulse.work.moreInGroup", { count: group.hiddenCount })}</span>
                  <Link
                    to={group.items[WORK_ITEMS_PER_GROUP].to}
                    className="inline-flex min-h-11 items-center font-semibold text-em-violet-700 hover:underline"
                  >
                    {t(group.kind === "reply" ? "dashboard.pulse.work.openNextConversation" : "dashboard.pulse.work.reviewNextOrder")}
                  </Link>
                </div>
              )}
            </section>
          ))}
        </div>
      ) : (
        <p role="status" className="rounded-lg bg-em-warning-100 p-3 text-sm text-em-warning-700">
          {t("dashboard.pulse.work.partialEmpty")}
        </p>
      )}

      {!hasAllWorkSources && (
        <p role="note" className="mt-3 text-xs text-em-text-secondary">{t("dashboard.pulse.work.coverageNote")}</p>
      )}
    </section>
  );
}
