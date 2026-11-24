/**
 * Recent activity (mission D4) — the audited operational feed projected
 * through tenantAuditView. Actor is the STORED user (full_name) or the
 * localized "System" label for NULL actors; no AI/Provider actors are ever
 * inferred — the feed shows stored users or "System", nothing else. Order rows
 * with a stored resource id deep-link to the verified order seed
 * (/orders?orderId=…); conversation/product rows stay UNLINKED rather than
 * fabricating destinations. Limit 6, Asia/Dhaka display; null → unavailable,
 * [] → empty, list otherwise (guardrails §16).
 */
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { History } from "lucide-react";
import type { DashboardCommerceSignals } from "@/api/types/dashboard";

type ActivityItem = NonNullable<DashboardCommerceSignals["recentActivity"]>[number];

const ACTIVITY_LIMIT = 6;

/** Case-aware: the audit vocabulary stores ORDER rows as 'ORDER'/'order'. */
const isOrderRow = (item: ActivityItem): boolean =>
  String(item.resourceType || "").toLowerCase() === "order";

/** Verified deep link only for order rows that carry a stored resource id. */
export const orderRowHref = (item: ActivityItem): string | null => (
  isOrderRow(item) && item.resource_id ? `/orders?orderId=${encodeURIComponent(item.resource_id)}` : null
);

const RowBody = ({ item }: { item: ActivityItem }) => {
  const { t } = useTranslation();
  const actor = item.user?.full_name || t("dashboard.pulse.commerceSignals.activitySystem");
  return (
    <>
      <span className="font-semibold text-em-text-primary">
        {actor} · {t("dashboard.pulse.commerceSignals.actions." + item.action, { defaultValue: item.action })}
      </span>
      <span className="block truncate text-xs text-em-text-secondary">
        {t("dashboard.pulse.commerceSignals.resources." + item.resourceType, { defaultValue: item.resourceType })}
      </span>
    </>
  );
};

export function RecentActivity({ activity, locale }: { activity: DashboardCommerceSignals["recentActivity"]; locale: string }) {
  const { t } = useTranslation();
  const formatTime = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Dhaka" });
  const rows = activity ? activity.slice(0, ACTIVITY_LIMIT) : null;
  return (
    <section className="mb-4 min-w-0 rounded-xl border border-em-border bg-em-bg-surface p-4 shadow-sm" aria-labelledby="dashboard-activity-heading">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 id="dashboard-activity-heading" className="flex items-center gap-2 text-lg font-semibold text-em-text-primary">
          <History className="h-5 w-5 shrink-0 text-em-violet-700" aria-hidden="true" />
          {t("dashboard.pulse.commerceSignals.activity")}
        </h2>
        <Link to="/audit-logs" className="inline-flex min-h-11 items-center rounded-lg px-2 text-sm font-semibold text-em-violet-700 hover:underline">{t("dashboard.pulse.commerceSignals.viewAll")}</Link>
      </div>
      {rows === null ? <p className="text-sm text-em-warning-700">{t("dashboard.pulse.commerceSignals.activityUnavailable")}</p>
        : rows.length === 0 ? <p className="text-sm text-em-text-secondary">{t("dashboard.pulse.commerceSignals.activityEmpty")}</p>
        : <ul className="divide-y divide-em-border">
          {rows.map(item => {
            const timestamp = new Date(item.occurredAt);
            const href = orderRowHref(item);
            const timeText = Number.isFinite(timestamp.getTime()) ? formatTime.format(timestamp) : t("dashboard.pulse.commerceSignals.unavailable");
            const body = <RowBody item={item} />;
            return <li key={item.id} className="flex min-h-11 flex-col gap-1 py-3 text-sm">
              {href
                ? <Link to={href} className="min-w-0 rounded hover:text-em-violet-700 hover:underline">{body}</Link>
                : body}
              <span className="em-tabular text-xs text-em-text-secondary">{timeText}</span>
            </li>;
          })}
        </ul>}
      <p className="mt-2 text-xs text-em-text-secondary">{t("dashboard.pulse.commerceSignals.activityNote")}</p>
    </section>
  );
}
