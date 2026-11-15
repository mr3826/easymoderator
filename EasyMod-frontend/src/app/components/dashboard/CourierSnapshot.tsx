/**
 * Courier bookings and parcels — baseline logic and all five honest states
 * preserved verbatim (loading / unavailable+retry / noneActive /
 * aggregateUnavailable / noCompleteRecentSample), restyled with em tokens.
 */
import { Link } from "react-router-dom";
import { PackageCheck, Truck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { validDate, orderLabel } from "./derive";
import type { CourierSnapshotState } from "./types";
import type { Order } from "@/api/types/order";

const ACTIVE_COURIER_STATUSES = new Set(["booked", "picked_up", "in_transit", "out_for_delivery"]);
const COURIER_SAMPLE_LIMIT = 100;

const nonEmptyString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

function getCourierReference(order: Order) {
  return nonEmptyString(order.delivery_tracking_code)
    || nonEmptyString(order.delivery_consignment_id);
}

function isPersistedActiveCourierOrder(order: Order) {
  const status = nonEmptyString(order.delivery_status)?.toLowerCase();
  return Boolean(
    nonEmptyString(order.delivery_provider)
    && getCourierReference(order)
    && nonEmptyString(order.delivery_dispatched_at)
    && status
    && ACTIVE_COURIER_STATUSES.has(status),
  );
}

interface CourierSnapshotProps {
  snapshot: CourierSnapshotState;
  inTransitCount: number | null;
  locale: string;
  onRetry: () => void;
}

export function CourierSnapshot({ snapshot, inTransitCount, locale, onRetry }: CourierSnapshotProps) {
  const { t } = useTranslation();
  const courierOrders = snapshot.orders;
  const activeCourierOrders = (courierOrders ?? []).filter(isPersistedActiveCourierOrder);

  return (
    <section className="rounded-xl border border-em-border bg-em-bg-surface p-4" aria-labelledby="home-courier-heading">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h2 id="home-courier-heading" className="text-lg font-semibold text-em-text-primary">
            {t("dashboard.pulse.courierSnapshot.title")}
          </h2>
          <p className="text-xs text-em-text-secondary">{t("dashboard.pulse.courierSnapshot.subtitle")}</p>
        </div>
        <Truck className="h-5 w-5 text-em-text-secondary" aria-hidden="true" />
      </div>
      {snapshot.isLoading ? (
        <p role="status" className="rounded-lg bg-em-bg-muted p-4 text-sm font-medium text-em-text-secondary">
          {t("dashboard.pulse.courierSnapshot.loading")}
        </p>
      ) : courierOrders === null ? (
        <div role="status" className="rounded-lg bg-em-warning-100 p-4">
          <p className="text-sm text-em-warning-700">{t("dashboard.pulse.courierSnapshot.unavailable")}</p>
          <button
            type="button"
            onClick={onRetry}
            className="mt-2 min-h-11 rounded text-sm font-semibold text-em-warning-700 underline underline-offset-4"
          >
            {t("dashboard.pulse.retry")}
          </button>
        </div>
      ) : (
        <>
          <p role="note" className="mb-2 text-xs text-em-text-secondary">
            {t("dashboard.pulse.courierSnapshot.scope", { count: COURIER_SAMPLE_LIMIT })}
          </p>
          {activeCourierOrders.length > 0 ? (
            <div className="space-y-2">
              {activeCourierOrders.slice(0, 5).map((order) => {
                const provider = nonEmptyString(order.delivery_provider) || "";
                const providerLabel = t(`dashboard.pulse.courierSnapshot.providers.${provider.toLowerCase()}`, {
                  defaultValue: provider,
                });
                const status = nonEmptyString(order.delivery_status)?.toLowerCase() || "booked";
                const bookedAt = validDate(order.delivery_dispatched_at);
                const bookedLabel = bookedAt
                  ? t("dashboard.pulse.courierSnapshot.bookedAt", {
                    time: new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "Asia/Dhaka" }).format(bookedAt),
                  })
                  : "";
                return (
                  <Link
                    key={order.id}
                    to={`/orders?orderId=${encodeURIComponent(order.id)}`}
                    className="block w-full rounded-lg border border-em-border bg-em-bg-surface p-3 text-left hover:border-em-violet-300 hover:bg-em-violet-50"
                  >
                    <div className="flex items-start gap-3">
                      <PackageCheck className="mt-0.5 h-5 w-5 shrink-0 text-em-text-secondary" aria-hidden="true" />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-semibold text-em-text-primary">{orderLabel(order)}</p>
                        <p className="em-tabular truncate text-xs text-em-text-secondary">{providerLabel} · {getCourierReference(order)}</p>
                        <p className="text-xs font-medium text-em-text-secondary">
                          {t(`dashboard.pulse.courierSnapshot.status.${status}`, { defaultValue: status })}
                          {bookedLabel ? ` · ${bookedLabel}` : ""}
                        </p>
                      </div>
                      <span className="shrink-0 text-xs font-semibold text-em-violet-700">
                        {t("dashboard.pulse.courierSnapshot.openOrder")}
                      </span>
                    </div>
                  </Link>
                );
              })}
            </div>
          ) : inTransitCount === 0 ? (
            <p role="status" className="rounded-lg bg-em-bg-muted p-4 text-sm font-medium text-em-text-secondary">
              {t("dashboard.pulse.courierSnapshot.noneActive")}
            </p>
          ) : inTransitCount === null ? (
            <p role="status" className="rounded-lg bg-em-warning-100 p-4 text-sm text-em-warning-700">
              {t("dashboard.pulse.courierSnapshot.aggregateUnavailable")}
            </p>
          ) : (
            <p role="status" className="rounded-lg bg-em-warning-100 p-4 text-sm text-em-warning-700">
              {t("dashboard.pulse.courierSnapshot.noCompleteRecentSample")}
            </p>
          )}
          {activeCourierOrders.length > 5 && (
            <p role="note" className="mt-2 text-xs text-em-text-secondary">
              {t("dashboard.pulse.courierSnapshot.omitted", { count: activeCourierOrders.length - 5 })}
            </p>
          )}
        </>
      )}
    </section>
  );
}
