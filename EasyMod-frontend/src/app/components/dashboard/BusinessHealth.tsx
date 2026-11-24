/**
 * Business health (mission D8) — bounded, merchant-action-first tiles, each
 * with ONE authority behind it: stock exceptions from the D2 predicate
 * (shared with the Products page + nav badge), delivery exceptions from the
 * needs_action worklist bucket (shared with the Orders badge/list), and cash
 * in-transit/at-risk from the existing order-derived metrics — with the
 * "order status derived, not settled cash" note kept next to the figures.
 * Deliberately absent: customer opportunities (per-shop pilot flag), any
 * placeholder analytics (reports is unreliable), and billing-overdue status
 * (claim-driven BillingStandingBanner in the shell owns that — no duplicate).
 * Source failure renders the honest Unavailable state, never 0.
 */
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Boxes, Truck, Wallet } from "lucide-react";
import type { StockExceptions } from "@/api/types/dashboard";
import type { CashPosition } from "./types";

interface BusinessHealthProps {
  /** C2/D2 bounded scan; null = source failed (never 0). */
  stockExceptions: StockExceptions | null;
  /** needs_action bucket count from the shared worklist counts source. */
  deliveryExceptionCount: number | null;
  cashPosition: CashPosition | null;
  formatCount: (n: number) => string;
  formatCurrency: (n: number) => string;
}

/** A capped/incomplete scan is a lower bound — render `N+`, never bare N. */
const stockFigure = (value: number, coverageComplete: boolean, formatCount: (n: number) => string) =>
  `${formatCount(value)}${coverageComplete ? "" : "+"}`;

function Tile({ icon: Icon, label, value, note, to, viewLabel }: {
  icon: typeof Boxes;
  label: string;
  value: string;
  note?: string;
  to: string;
  viewLabel: string;
}) {
  return (
    <Link
      to={to}
      className="flex min-h-28 flex-col items-start gap-1 rounded-xl border border-em-border border-l-4 bg-em-bg-app p-4 shadow-sm hover:border-em-violet-300 hover:bg-em-violet-50"
    >
      <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-em-violet-100 text-em-violet-700">
        <Icon className="h-5 w-5" aria-hidden="true" />
      </span>
      <span className="em-tabular text-xl font-semibold text-em-text-primary">{value}</span>
      <span className="text-sm font-medium text-em-text-primary">{label}</span>
      {note && <span className="text-xs text-em-text-secondary">{note}</span>}
      <span className="mt-auto text-xs font-semibold text-em-violet-700">{viewLabel}</span>
    </Link>
  );
}

export function BusinessHealth({ stockExceptions, deliveryExceptionCount, cashPosition, formatCount, formatCurrency }: BusinessHealthProps) {
  const { t } = useTranslation();
  const unavailable = t("dashboard.businessHealth.unavailable");
  const inTransit = cashPosition?.inTransit ?? null;
  const atRisk = cashPosition?.atRisk ?? null;

  return (
    <section className="mb-4 min-w-0 rounded-xl border border-em-border bg-em-bg-surface p-4" aria-labelledby="dashboard-business-health-heading">
      <div className="mb-3">
        <h2 id="dashboard-business-health-heading" className="text-lg font-semibold text-em-text-primary">
          {t("dashboard.businessHealth.title")}
        </h2>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Tile
          icon={Boxes}
          label={t("dashboard.businessHealth.stockExceptions")}
          value={stockExceptions === null ? unavailable : stockFigure(stockExceptions.exceptions, stockExceptions.coverageComplete, formatCount)}
          note={stockExceptions === null ? undefined : t("dashboard.businessHealth.outOfStock") + ": " + stockFigure(stockExceptions.outOfStock, stockExceptions.coverageComplete, formatCount) + " · " + t("dashboard.businessHealth.lowStock") + ": " + stockFigure(stockExceptions.lowStock, stockExceptions.coverageComplete, formatCount)}
          to="/products?stock=exceptions"
          viewLabel={t("dashboard.businessHealth.viewProducts")}
        />
        <Tile
          icon={Truck}
          label={t("dashboard.businessHealth.deliveryExceptions")}
          value={deliveryExceptionCount === null ? unavailable : formatCount(deliveryExceptionCount)}
          to="/orders?bucket=needs_action"
          viewLabel={t("dashboard.businessHealth.viewOrders")}
        />
        <Tile
          icon={Wallet}
          label={t("dashboard.businessHealth.cashInTransit")}
          value={inTransit === null ? unavailable : formatCurrency(inTransit.amount)}
          note={inTransit === null ? undefined : t("dashboard.pulse.cashPosition.ordersUnit", { count: inTransit.count })}
          to="/orders?bucket=in_transit"
          viewLabel={t("dashboard.businessHealth.viewOrders")}
        />
        {/* No verified at-risk bucket seed — the figure lands on the plain
            orders list (same destination as the overview cash card). */}
        <Tile
          icon={AlertTriangle}
          label={t("dashboard.businessHealth.cashAtRisk")}
          value={atRisk === null ? unavailable : formatCurrency(atRisk.amount)}
          note={atRisk === null ? undefined : t("dashboard.pulse.cashPosition.ordersUnit", { count: atRisk.count })}
          to="/orders"
          viewLabel={t("dashboard.businessHealth.viewOrders")}
        />
      </div>
      <p role="note" className="mt-3 text-xs text-em-text-secondary">
        {t("dashboard.pulse.cashPosition.derivationNote")}
      </p>
    </section>
  );
}
