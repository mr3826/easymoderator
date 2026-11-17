/**
 * Review-queue aggregates (guardrails §21.1) — the real counts the baseline
 * fetched but dropped. Each chip links to its workflow. null = source failed:
 * shows "Unavailable", never an invented 0. Aggregates are not verified tasks;
 * the note says so.
 */
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";

interface QueueSignalChipsProps {
  unread: number | null;
  pendingPayment: number | null;
  readyToDispatch: number | null;
}

export function QueueSignalChips({ unread, pendingPayment, readyToDispatch }: QueueSignalChipsProps) {
  const { t } = useTranslation();
  const chips = [
    { label: t("dashboard.pulse.attention.waitingForReply"), count: unread, to: "/inbox" },
    { label: t("dashboard.pulse.attention.pendingPayment"), count: pendingPayment, to: "/orders" },
    { label: t("dashboard.pulse.attention.readyToDispatch"), count: readyToDispatch, to: "/orders" },
  ];

  return (
    <section className="mb-4" aria-labelledby="dashboard-queues-heading">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="dashboard-queues-heading" className="text-sm font-semibold text-em-text-primary">
          {t("dashboard.pulse.attention.title")}
        </h2>
        <p className="text-xs text-em-text-secondary">{t("dashboard.pulse.queueChips.note")}</p>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        {chips.map((chip) => (
          <Link
            key={chip.label}
            to={chip.to}
            className="flex min-h-11 items-center justify-between gap-3 rounded-lg border border-em-border bg-em-bg-surface px-3 py-2 hover:border-em-violet-300 hover:bg-em-violet-50"
          >
            <span className="text-sm font-medium text-em-text-primary">{chip.label}</span>
            <span className="em-tabular shrink-0 text-sm font-semibold text-em-violet-700">
              {chip.count === null ? t("dashboard.pulse.queueChips.unavailable") : chip.count}
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}
