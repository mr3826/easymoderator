/**
 * Review-queue signal cards (guardrails §21.1, mission D3/D5) — four real
 * aggregates, each linking to the exact filtered workflow it shares a
 * predicate with (needs_reply == inbox tab == badge via C1; to_pack/needs_action
 * via order-worklist buckets; payment via the unchanged pending query). null =
 * source failed: shows "Unavailable", never an invented 0. Aggregates are not
 * verified tasks; the note says so. A capped/incomplete needs-reply scan renders
 * as `N+` (D1/D10 honesty) and is never presented as exhaustive.
 */
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { MessageCircle, CreditCard, Truck, Receipt } from "lucide-react";
import type { DashboardCommerceSignals, NeedsReplyCount } from "@/api/types/dashboard";

/** D1 display cap — larger values render "99+", never a bare big number. */
const DISPLAY_CAP = 99;

interface QueueSignalChipsProps {
  /** C1 object from the shared needs-reply service; null = failed (never 0). */
  needsReply: NeedsReplyCount | null;
  pendingPayment: number | null;
  readyToDispatch: number | null;
  billing?: DashboardCommerceSignals['deliveredCharges'];
  formatCount?: (n: number) => string;
  formatMoney?: (n: number) => string;
  /** A8 round-3 (MINOR-2): locale-formatted accounting day (default keeps the raw ISO day). */
  formatDay?: (dayUtc: string) => string;
}

/**
 * A8 round-3 (MINOR-2): the charges card's accounting-day chip carried the
 * raw `dayUtc` string, so a Bangla locale still saw "2026-11-24" — Latin
 * digits. Format the SAME UTC day through Intl for bn (Bangla day/month/
 * year), while EN keeps the ISO-ish server value (dayUtc is already
 * YYYY-MM-DD). The explicit "UTC" label lives in the locale string, so the
 * accounting-day semantics are unchanged — nothing here switches to local
 * calendar days.
 */
export function formatAccountingDay(dayUtc: string, locale: string): string {
  if (!locale.toLowerCase().startsWith("bn")) return dayUtc;
  const date = new Date(`${dayUtc}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime())) return dayUtc;
  return new Intl.DateTimeFormat(locale, {
    timeZone: "UTC",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(date);
}

/**
 * Reply-count display: exact when the server scan covered every open
 * conversation; a lower bound (`N+`, capped at 99+) otherwise — a number from
 * a truncated scan must never look exhaustive.
 */
export function needsReplyDisplay(
  needsReply: NeedsReplyCount | null,
  formatCount: (n: number) => string,
  unavailableLabel: string,
): string {
  if (needsReply === null) return unavailableLabel;
  const capped = needsReply.count > DISPLAY_CAP;
  if (needsReply.coverageComplete) {
    return capped ? `${DISPLAY_CAP}+` : formatCount(needsReply.count);
  }
  return capped ? `${DISPLAY_CAP}+` : `${formatCount(needsReply.count)}+`;
}

export function QueueSignalChips({ needsReply, pendingPayment, readyToDispatch, billing, formatCount = String, formatMoney = String, formatDay = (dayUtc: string) => dayUtc }: QueueSignalChipsProps) {
  const { t } = useTranslation();
  const unavailable = t("dashboard.pulse.queueChips.unavailable");
  const chips = [
    { label: t("dashboard.pulse.attention.waitingForReply"), display: needsReplyDisplay(needsReply, formatCount, unavailable), to: "/inbox?tab=needs_review", icon: MessageCircle, tone: "border-l-em-sunlight-500", iconTone: "bg-em-sunlight-100 text-em-sunlight-700" },
    { label: t("dashboard.pulse.attention.pendingPayment"), display: pendingPayment === null ? unavailable : formatCount(pendingPayment), to: "/orders?payment=pending", icon: CreditCard, tone: "border-l-em-violet-700", iconTone: "bg-em-violet-100 text-em-violet-700" },
    { label: t("dashboard.pulse.attention.readyToDispatch"), display: readyToDispatch === null ? unavailable : formatCount(readyToDispatch), to: "/orders?bucket=to_pack", icon: Truck, tone: "border-l-em-info-700", iconTone: "bg-em-info-100 text-em-info-700" },
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
            <span className="em-tabular text-xl font-semibold text-em-text-primary">{chip.display}</span>
            <span className="text-sm font-medium text-em-text-primary">{chip.label}</span>
          </Link>
        ))}
        {billing !== undefined && (
          <Link
            to="/subscription"
            title={t("dashboard.pulse.commerceSignals.chargesTooltip")}
            className="flex min-h-28 flex-col items-start gap-2 rounded-xl border border-em-border border-l-4 border-l-em-success-700 bg-em-bg-surface p-4 shadow-sm hover:bg-em-violet-50"
          >
            <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-em-success-100 text-em-success-700"><Receipt className="h-5 w-5" aria-hidden="true" /></span>
            <span className="em-tabular text-xl font-semibold text-em-text-primary">{billing === null ? t("dashboard.pulse.commerceSignals.unavailable") : formatMoney(billing.amountMinor / 100)}</span>
            <span className="text-sm font-medium text-em-text-primary">{t("dashboard.pulse.commerceSignals.charges")}</span>
            {/* D5 + A8: `count` stays the RAW number so i18next can select the
                dayCount_one/_other plural form ("1 order" / "4 orders"), while
                `displayCount` carries the locale-formatted (Bangla) digits the
                string interpolates — plural grammar and digits-correct render
                together (doc 04 §6; founder numerals rule). A8 round-3
                (MINOR-2): `day` likewise arrives pre-formatted — same UTC
                day, Bangla digits in bn, ISO kept in en. */}
            {billing !== null && <span className="text-xs text-em-text-secondary">{t("dashboard.pulse.commerceSignals.dayCount", { day: formatDay(billing.dayUtc), count: billing.count, displayCount: formatCount(billing.count) })}</span>}
            <span className="text-xs text-em-text-secondary">{t("dashboard.pulse.commerceSignals.chargeNote")}</span>
          </Link>
        )}
      </div>
    </section>
  );
}
