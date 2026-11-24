/**
 * Review-queue aggregates (guardrails §21.1) — the real counts the baseline
 * fetched but dropped. Each chip links to its workflow. null = source failed:
 * shows "Unavailable", never an invented 0. Aggregates are not verified tasks;
 * the note says so.
 */
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { MessageCircle, CreditCard, Truck, Receipt } from "lucide-react";
import type { DashboardCommerceSignals } from "@/api/types/dashboard";

interface QueueSignalChipsProps {
  unread: number | null;
  pendingPayment: number | null;
  readyToDispatch: number | null;
  billing?: DashboardCommerceSignals['deliveredCharges'];
  formatCount?: (n: number) => string;
  formatMoney?: (n: number) => string;
}

export function QueueSignalChips({ unread, pendingPayment, readyToDispatch, billing, formatCount = String, formatMoney = String }: QueueSignalChipsProps) {
  const { t } = useTranslation();
  // Dashboard aggregates use payment/fulfillment predicates that differ from the
  // worklist bucket predicates, so a chip count and the bucket count it opens can
  // differ. The links select the closest bucket / exact payment filter and never
  // adjust or fabricate counts (the "aggregates are not verified tasks" note stands).
  const chips = [
    { label: t("dashboard.pulse.attention.waitingForReply"), count: unread, to: "/inbox", icon: MessageCircle, tone: "border-l-em-sunlight-500", iconTone: "bg-em-sunlight-100 text-em-sunlight-700" },
    { label: t("dashboard.pulse.attention.pendingPayment"), count: pendingPayment, to: "/orders?payment=pending", icon: CreditCard, tone: "border-l-em-violet-700", iconTone: "bg-em-violet-100 text-em-violet-700" },
    { label: t("dashboard.pulse.attention.readyToDispatch"), count: readyToDispatch, to: "/orders?bucket=to_pack", icon: Truck, tone: "border-l-em-info-700", iconTone: "bg-em-info-100 text-em-info-700" },
  ];

  return (
    <section className="mb-4" aria-labelledby="dashboard-queues-heading">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="dashboard-queues-heading" className="text-sm font-semibold text-em-text-primary">
          {t("dashboard.pulse.attention.title")}
        </h2>
        <p className="text-xs text-em-text-secondary">{t("dashboard.pulse.queueChips.note")}</p>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {chips.map((chip) => (
          <Link
            key={chip.label}
            to={chip.to}
            className={`flex min-h-28 flex-col items-start gap-2 rounded-xl border border-em-border border-l-4 bg-em-bg-surface p-4 shadow-sm hover:bg-em-violet-50 ${chip.tone}`}
          >
            <span className={`inline-flex h-9 w-9 items-center justify-center rounded-lg ${chip.iconTone}`}><chip.icon className="h-5 w-5" aria-hidden="true" /></span>
            <span className="em-tabular text-xl font-semibold text-em-text-primary">
              {chip.count === null ? t("dashboard.pulse.queueChips.unavailable") : formatCount(chip.count)}
            </span>
            <span className="text-sm font-medium text-em-text-primary">{chip.label}</span>
          </Link>
        ))}
        {billing !== undefined && (
          <Link to="/subscription" className="flex min-h-28 flex-col items-start gap-2 rounded-xl border border-em-border border-l-4 border-l-em-success-700 bg-em-bg-surface p-4 shadow-sm hover:bg-em-violet-50">
            <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-em-success-100 text-em-success-700"><Receipt className="h-5 w-5" aria-hidden="true" /></span>
            <span className="em-tabular text-xl font-semibold text-em-text-primary">{billing === null ? t("dashboard.pulse.commerceSignals.unavailable") : formatMoney(billing.amountMinor / 100)}</span>
            <span className="text-sm font-medium text-em-text-primary">{t("dashboard.pulse.commerceSignals.charges")}</span>
            {billing !== null && <span className="text-xs text-em-text-secondary">{t("dashboard.pulse.commerceSignals.dayCount", { day: billing.dayUtc, count: formatCount(billing.count) })}</span>}
            <span className="text-xs text-em-text-secondary">{t("dashboard.pulse.commerceSignals.chargeNote")}</span>
          </Link>
        )}
      </div>
    </section>
  );
}
