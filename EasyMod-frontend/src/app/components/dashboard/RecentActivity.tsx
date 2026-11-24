import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { History } from "lucide-react";
import type { DashboardCommerceSignals } from "@/api/types/dashboard";

export function RecentActivity({ activity, locale }: { activity: DashboardCommerceSignals["recentActivity"]; locale: string }) {
  const { t } = useTranslation();
  const formatTime = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Dhaka" });
  return (
    <section className="mb-4 min-w-0 rounded-xl border border-em-border bg-em-bg-surface p-4 shadow-sm" aria-labelledby="dashboard-activity-heading">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 id="dashboard-activity-heading" className="flex items-center gap-2 text-lg font-semibold text-em-text-primary">
          <History className="h-5 w-5 shrink-0 text-em-violet-700" aria-hidden="true" />
          {t("dashboard.pulse.commerceSignals.activity")}
        </h2>
        <Link to="/audit-logs" className="inline-flex min-h-11 items-center rounded-lg px-2 text-sm font-semibold text-em-violet-700 hover:underline">{t("dashboard.pulse.evidence.auditLog")}</Link>
      </div>
      {activity === null ? <p className="text-sm text-em-warning-700">{t("dashboard.pulse.commerceSignals.activityUnavailable")}</p>
        : activity.length === 0 ? <p className="text-sm text-em-text-secondary">{t("dashboard.pulse.commerceSignals.activityEmpty")}</p>
        : <ul className="divide-y divide-em-border">
          {activity.map(item => {
            const timestamp = new Date(item.occurredAt);
            return <li key={item.id} className="flex min-h-11 flex-col gap-1 py-3 text-sm">
              <span className="font-semibold text-em-text-primary">{t("dashboard.pulse.commerceSignals.actions." + item.action, { defaultValue: item.action })} · {t("dashboard.pulse.commerceSignals.resources." + item.resourceType, { defaultValue: item.resourceType })}</span>
              <span className="em-tabular text-xs text-em-text-secondary">{Number.isFinite(timestamp.getTime()) ? formatTime.format(timestamp) : t("dashboard.pulse.commerceSignals.unavailable")}</span>
            </li>;
          })}
        </ul>}
      <p className="mt-2 text-xs text-em-text-secondary">{t("dashboard.pulse.commerceSignals.activityNote")}</p>
    </section>
  );
}
