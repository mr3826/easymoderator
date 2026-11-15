/**
 * Last 5 Orders — real recent activity with honest status pills (icon + text,
 * no emoji). Covers §21.1 activity; there is no dedicated "recently completed"
 * endpoint, so none is fabricated. Order totals are not collected cash.
 */
import { Link } from "react-router-dom";
import {
  BadgeCheck,
  CheckCircle2,
  CircleHelp,
  Clock4,
  FileText,
  PackageCheck,
  RotateCcw,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "../ui/utils";
import type { Order } from "@/api/types/order";

const statusStyles: Record<string, { labelKey: string; tone: string; icon: LucideIcon }> = {
  confirmed: { labelKey: "dashboard.pulse.status.confirmed", tone: "bg-em-success-100 text-em-success-700", icon: CheckCircle2 },
  completed: { labelKey: "dashboard.pulse.status.completed", tone: "bg-em-success-100 text-em-success-700", icon: CheckCircle2 },
  delivered: { labelKey: "dashboard.pulse.status.delivered", tone: "bg-em-success-100 text-em-success-700", icon: PackageCheck },
  returned: { labelKey: "dashboard.pulse.status.returned", tone: "bg-em-danger-100 text-em-danger-700", icon: RotateCcw },
  cancelled: { labelKey: "dashboard.pulse.status.cancelled", tone: "bg-em-danger-100 text-em-danger-700", icon: XCircle },
  processing: { labelKey: "dashboard.pulse.status.processing", tone: "bg-em-warning-100 text-em-warning-700", icon: Clock4 },
  pending: { labelKey: "dashboard.pulse.status.pending", tone: "bg-em-warning-100 text-em-warning-700", icon: Clock4 },
  finalized: { labelKey: "dashboard.pulse.status.finalized", tone: "bg-em-info-100 text-em-info-700", icon: BadgeCheck },
  draft: { labelKey: "dashboard.pulse.status.draft", tone: "bg-em-bg-muted text-em-text-secondary", icon: FileText },
};

export function OrderStatusPill({ status }: { status: string }) {
  const { t } = useTranslation();
  const style = statusStyles[status] ?? {
    labelKey: "dashboard.pulse.status.unknown",
    tone: "bg-em-bg-muted text-em-text-secondary",
    icon: CircleHelp,
  };
  const Icon = style.icon;
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs font-semibold", style.tone)}>
      <Icon className="h-3 w-3" aria-hidden="true" />
      {t(style.labelKey)}
    </span>
  );
}

interface RecentOrdersProps {
  orders: Order[] | null;
  formatCurrency: (v: number) => string;
}

export function RecentOrders({ orders, formatCurrency }: RecentOrdersProps) {
  const { t } = useTranslation();
  return (
    <section className="mb-4 rounded-xl border border-em-border bg-em-bg-surface p-4" aria-labelledby="dashboard-recent-heading">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 id="dashboard-recent-heading" className="text-lg font-semibold text-em-text-primary">
          {t("dashboard.pulse.latestOrders.title")}
        </h2>
        <Link
          to="/orders"
          className="inline-flex min-h-11 items-center rounded-lg px-3 text-sm font-semibold text-em-violet-700 hover:bg-em-violet-50"
        >
          {t("dashboard.pulse.latestOrders.viewAll")}
        </Link>
      </div>

      {orders === null ? (
        <p role="status" className="rounded-lg bg-em-warning-100 p-4 text-sm text-em-warning-700">
          {t("dashboard.pulse.latestOrders.unavailable")}
        </p>
      ) : orders.length === 0 ? (
        <div role="status" className="rounded-lg bg-em-bg-muted p-4">
          <p className="text-sm font-medium text-em-text-secondary">{t("dashboard.pulse.latestOrders.empty")}</p>
          <Link to="/orders" className="mt-1 inline-block text-sm font-semibold text-em-violet-700 hover:underline">
            {t("dashboard.pulse.attention.openOrders")}
          </Link>
        </div>
      ) : (
        <div className="space-y-2">
          {orders.map((order) => {
            const firstItem = order.items[0];
            return (
              <Link
                key={order.id}
                to={`/orders?orderId=${encodeURIComponent(order.id)}`}
                className="block w-full rounded-lg border border-em-border bg-em-bg-surface p-3 text-left hover:border-em-violet-300 hover:bg-em-violet-50"
              >
                <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-em-text-primary">{order.customerName}</p>
                    <p className="em-tabular text-[13px] text-em-text-secondary">
                      {firstItem?.productName || t("dashboard.pulse.latestOrders.noProduct")} · {formatCurrency(Number(order.total) || 0)}
                    </p>
                  </div>
                  <OrderStatusPill status={order.status} />
                </div>
              </Link>
            );
          })}
        </div>
      )}

      <p role="note" className="mt-3 text-xs font-medium text-em-text-secondary">
        {t("dashboard.pulse.latestOrders.valueNote")}
      </p>
    </section>
  );
}
