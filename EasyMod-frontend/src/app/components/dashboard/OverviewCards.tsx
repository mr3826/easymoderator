/**
 * Business overview (guardrails §21.1): every metric links to a workflow.
 * Orders today → /reports; cash-position cards → /orders. Cash cards stay
 * <section> elements with label + value together (pinned by unit tests) and
 * keep the derivation note — these are order-status derived, not settled cash.
 * The optional 30-day sparkline uses chartData already present in the metrics
 * payload; absent/invalid data renders nothing (single series, one hue, no
 * legend — the card title names it; endpoint marker carries a surface ring).
 */
import { Link } from "react-router-dom";
import { AlertTriangle, Truck, type LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { CashPosition } from "./types";

interface OrdersSparklineProps {
  chartData: unknown;
}

function OrdersSparkline({ chartData }: OrdersSparklineProps) {
  const { t } = useTranslation();
  if (!Array.isArray(chartData) || chartData.length < 2) return null;
  const points = chartData
    .filter((p): p is { date: string; orders: number } =>
      Boolean(p) && typeof p === "object" && typeof (p as { orders?: unknown }).orders === "number"
      && Number.isFinite((p as { orders: number }).orders))
    .slice(-30);
  if (points.length < 2) return null;

  const values = points.map((p) => p.orders);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const width = 120;
  const height = 32;
  const pad = 4;
  const coords = points.map((p, index) => {
    const x = pad + (index / (points.length - 1)) * (width - pad * 2);
    const y = height - pad - ((p.orders - min) / span) * (height - pad * 2);
    return { x, y };
  });
  const path = coords.map((c, i) => `${i === 0 ? "M" : "L"}${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" ");
  const last = coords[coords.length - 1];
  const summary = t("dashboard.pulse.overview.trendSummary", {
    count: points.length,
    min,
    max,
    latest: values[values.length - 1],
  });

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="mt-2 h-8 w-full"
      role="img"
      aria-label={summary}
      preserveAspectRatio="none"
    >
      <title>{summary}</title>
      <path d={path} fill="none" stroke="var(--em-violet-600)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={last.x} cy={last.y} r="4" fill="var(--em-violet-700)" stroke="var(--em-bg-surface)" strokeWidth="2" />
    </svg>
  );
}

interface CashPositionCardProps {
  label: string;
  subLabel: string;
  data: { amount: number; count: number } | null;
  icon: LucideIcon;
  formatCurrency: (v: number) => string;
}

function CashPositionCard({ label, subLabel, data, icon: Icon, formatCurrency }: CashPositionCardProps) {
  const { t } = useTranslation();
  return (
    <section className="min-h-[112px] rounded-xl border border-em-border bg-em-bg-surface">
      <Link to="/orders" className="block h-full rounded-xl p-4 hover:border-em-violet-300 hover:bg-em-violet-50">
        <div className="mb-2 flex items-center justify-between">
          <Icon className="h-5 w-5 text-em-text-secondary" aria-hidden="true" />
          <span className="text-xs font-medium text-em-text-secondary">{subLabel}</span>
        </div>
        <h3 className="text-sm font-semibold text-em-text-secondary">{label}</h3>
        {data ? (
          <>
            <p className="em-tabular mt-1 text-2xl font-semibold text-em-text-primary md:text-3xl">{formatCurrency(data.amount)}</p>
            <p className="mt-1 text-sm font-semibold text-em-text-secondary">
              {t("dashboard.pulse.cashPosition.ordersUnit", { count: data.count })}
            </p>
          </>
        ) : (
          <p className="mt-2 text-lg font-semibold text-em-text-secondary">{t("dashboard.pulse.cashPosition.unavailable")}</p>
        )}
      </Link>
    </section>
  );
}

interface OverviewCardsProps {
  ordersToday: number | null;
  cashPosition: CashPosition | null;
  chartData: unknown;
  formatCurrency: (v: number) => string;
  formatCount: (v: number) => string;
}

export function OverviewCards({ ordersToday, cashPosition, chartData, formatCurrency, formatCount }: OverviewCardsProps) {
  const { t } = useTranslation();
  return (
    <section className="mb-4 rounded-xl border border-em-border bg-em-bg-surface p-4" aria-labelledby="dashboard-overview-heading">
      <div className="mb-3">
        <h2 id="dashboard-overview-heading" className="text-lg font-semibold text-em-text-primary">
          {t("dashboard.pulse.overview.title")}
        </h2>
        <p className="text-sm text-em-text-secondary">{t("dashboard.pulse.overview.subtitle")}</p>
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <Link
          to="/reports"
          className="block min-h-[112px] rounded-xl border border-em-border bg-em-bg-app p-4 hover:border-em-violet-300 hover:bg-em-violet-50"
        >
          <p className="text-sm font-semibold text-em-text-secondary">{t("dashboard.pulse.overview.ordersToday")}</p>
          <p className="em-tabular mt-2 text-2xl font-semibold text-em-text-primary md:text-3xl">
            {ordersToday === null ? t("dashboard.pulse.cashPosition.unavailable") : formatCount(ordersToday)}
          </p>
          <OrdersSparkline chartData={chartData} />
          <p className="mt-2 text-xs font-semibold text-em-violet-700">{t("dashboard.pulse.overview.openReports")}</p>
        </Link>
        <CashPositionCard
          label={t("dashboard.pulse.cashPosition.inTransit")}
          subLabel={t("dashboard.pulse.cashPosition.inTransitSub")}
          data={cashPosition?.inTransit ?? null}
          icon={Truck}
          formatCurrency={formatCurrency}
        />
        <CashPositionCard
          label={t("dashboard.pulse.cashPosition.atRisk")}
          subLabel={t("dashboard.pulse.cashPosition.atRiskSub", { days: cashPosition?.atRisk.windowDays ?? 30 })}
          data={cashPosition?.atRisk ?? null}
          icon={AlertTriangle}
          formatCurrency={formatCurrency}
        />
      </div>
      <p role="note" className="mt-3 text-xs text-em-text-secondary">
        {t("dashboard.pulse.cashPosition.derivationNote")}
      </p>
    </section>
  );
}
