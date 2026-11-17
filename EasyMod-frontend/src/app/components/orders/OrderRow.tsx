/** Mobile task card and desktop worklist row for an order. */
import { AlertTriangle } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Order } from "@/api/types/order";
import { canBookCourierForOrder, getExpectedCourierCollection } from "./orderRules";

// em-token status pill classes (guardrails §8 semantic tones)
const STATUS_CLASSES: Record<string, string> = {
  draft: "bg-em-bg-em-bg-muted text-em-text-secondary",
  confirmed: "bg-em-info-100 text-em-info-700",
  processing: "bg-em-warning-100 text-em-warning-700",
  completed: "bg-em-success-100 text-em-success-700",
  delivered: "bg-em-success-100 text-em-success-700",
  cancelled: "bg-em-danger-100 text-em-danger-700",
};

interface OrderRowProps {
  order: Order;
  formatCurrency: (value: number) => string;
  formatDate: (value: string) => string;
  onViewDetail: (order: Order) => void;
  onDispatch: (order: Order) => void;
}

export function OrderRow({ order, formatCurrency, formatDate, onViewDetail, onDispatch }: OrderRowProps) {
  const { t } = useTranslation();
  const canDispatch = canBookCourierForOrder(order);
  const paymentLabel = order.payment_status
    ? t(`orders.paymentStatus.${order.payment_status.toLowerCase()}`, { defaultValue: order.payment_status })
    : t("orders.paymentStatus.unknown");
  const deliveryStatus = order.delivery_status || order.fulfillment_status;
  const deliveryLabel = deliveryStatus
    ? t(`orders.deliveryStatus.${deliveryStatus.toLowerCase()}`, {
      defaultValue: order.fulfillment_status
        ? t(`orders.fulfillmentStatus.${deliveryStatus.toLowerCase()}`, { defaultValue: deliveryStatus })
        : deliveryStatus,
    })
    : t("orders.deliveryStatus.unknown");
  const provider = order.delivery_provider?.trim().toLowerCase();
  const providerLabel = order.delivery_provider
    ? t(`orders.provider.${provider}`, { defaultValue: order.delivery_provider })
    : t("orders.fulfillment.providerUnavailable");
  const paymentMethod = order.payment_method || t("orders.paymentMethod.unknown");
  const itemSummary = order.items.length > 0
    ? order.items.slice(0, 2).map((item) => `${item.productName} × ${item.quantity}`).join(", ")
      + (order.items.length > 2 ? ` ${t("orders.additionalItems", { count: order.items.length - 2 })}` : "")
    : t("orders.row.noProduct");
  const expectedCollection = getExpectedCourierCollection(order);

  return (
    <article className="rounded-xl border border-em-border bg-em-bg-surface p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-bold text-em-text-primary">{order.customerName}</p>
          <p className="truncate text-xs text-em-text-secondary">#{order.orderNumber || order.id}{order.customerPhone ? ` · ${order.customerPhone}` : ""}</p>
        </div>
        <span
          className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-bold ${
            STATUS_CLASSES[order.status] ?? "bg-em-bg-muted text-em-text-secondary"
          }`}
        >
          {t(`orders.status.${order.status}`, { defaultValue: order.status })}
        </span>
      </div>

      <div className="mt-2 flex items-center justify-between gap-2">
        <p className="truncate text-xs text-em-text-secondary">{itemSummary}</p>
        <p className="shrink-0 text-sm font-bold text-em-text-primary">{formatCurrency(order.total)}</p>
      </div>

      <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
        <p className="col-span-2 truncate text-em-text-secondary">
          <span className="font-semibold text-em-text-primary">{t("orders.columns.channel")}:</span> {order.channel || t("orders.channelUnknown")}
        </p>
        <p className="rounded-md bg-em-bg-muted px-2 py-1.5 text-em-text-secondary">
          <span className="font-semibold text-em-text-primary">{t("orders.columns.payment")}:</span> {paymentLabel} · {paymentMethod}
        </p>
        <p className="rounded-md bg-em-bg-muted px-2 py-1.5 text-em-text-secondary">
          <span className="font-semibold text-em-text-primary">{t("orders.columns.delivery")}:</span> {deliveryLabel}
        </p>
        <p className="col-span-2 rounded-md bg-em-bg-muted px-2 py-1.5 text-em-text-secondary">
          <span className="font-semibold text-em-text-primary">{t("orders.columns.expectedCollection")}:</span>{" "}
          {expectedCollection === null ? t("orders.expectedCollectionUnknown") : formatCurrency(expectedCollection)}
        </p>
        <p className="col-span-2 truncate text-em-text-secondary">
          {providerLabel}{order.delivery_tracking_code ? ` · ${order.delivery_tracking_code}` : ` · ${t("orders.fulfillment.trackingUnavailable")}`}
        </p>
        <p className="col-span-2 text-em-text-secondary">{formatDate(order.createdAt)}</p>
        {order.rto_risk === "high" && (
          <p className="col-span-2 inline-flex items-center gap-1 font-semibold text-em-warning-700">
            <AlertTriangle className="h-3 w-3" /> {t("orders.rtoSignal")}
          </p>
        )}
      </div>

      <div className={`mt-3 grid gap-2 ${canDispatch ? "grid-cols-2" : "grid-cols-1"}`}>
        <button
          type="button"
          onClick={() => onViewDetail(order)}
          className="min-h-11 rounded-lg border border-em-border bg-em-bg-surface px-3 text-sm font-semibold text-em-text-primary hover:bg-em-bg-muted"
        >
          {order.status === "draft" ? t("orders.row.reviewDraft") : t("orders.row.viewDetail")}
        </button>
        {canDispatch && (
          <button
            type="button"
            onClick={() => onDispatch(order)}
            className="min-h-11 rounded-lg bg-em-violet-600 px-3 text-sm font-bold text-white"
          >
            {t("orders.row.dispatch")}
          </button>
        )}
        {order.delivery_tracking_code && provider === "steadfast" && (
          <a
            href={`https://steadfast.com.bd/track?trackingCode=${encodeURIComponent(order.delivery_tracking_code)}`}
            target="_blank"
            rel="noreferrer"
            className="col-span-2 min-h-11 rounded-lg border border-em-border px-3 py-2 text-center text-sm font-semibold text-em-violet-700"
          >
            {t("orders.row.track")}
          </a>
        )}
      </div>
    </article>
  );
}

interface OrderTableRowProps extends OrderRowProps {
  selected: boolean;
}

export function OrderTableRow({ order, selected, formatCurrency, formatDate, onViewDetail, onDispatch }: OrderTableRowProps) {
  const { t } = useTranslation();
  const canDispatch = canBookCourierForOrder(order);
  const paymentLabel = order.payment_status
    ? t(`orders.paymentStatus.${order.payment_status.toLowerCase()}`, { defaultValue: order.payment_status })
    : t("orders.paymentStatus.unknown");
  const deliveryStatus = order.delivery_status || order.fulfillment_status;
  const deliveryLabel = deliveryStatus
    ? t(`orders.deliveryStatus.${deliveryStatus.toLowerCase()}`, {
      defaultValue: order.fulfillment_status
        ? t(`orders.fulfillmentStatus.${deliveryStatus.toLowerCase()}`, { defaultValue: deliveryStatus })
        : deliveryStatus,
    })
    : t("orders.deliveryStatus.unknown");
  const provider = order.delivery_provider?.trim().toLowerCase();
  const providerLabel = order.delivery_provider
    ? t(`orders.provider.${provider}`, { defaultValue: order.delivery_provider })
    : t("orders.fulfillment.providerUnavailable");
  const itemSummary = order.items.length > 0
    ? order.items.slice(0, 2).map((item) => `${item.productName} × ${item.quantity}`).join(", ")
      + (order.items.length > 2 ? ` ${t("orders.additionalItems", { count: order.items.length - 2 })}` : "")
    : t("orders.row.noProduct");
  const expectedCollection = getExpectedCourierCollection(order);

  return (
    <tr className={selected ? "bg-em-violet-50" : "hover:bg-em-bg-muted/30"}>
      <td className="whitespace-nowrap px-3 py-3 align-top">
        <button type="button" onClick={() => onViewDetail(order)} className="inline-flex min-h-11 items-center font-semibold text-em-violet-700 hover:underline">
          {order.orderNumber || order.id}
        </button>
        {order.rto_risk === "high" && <p className="mt-1 flex items-center gap-1 text-xs text-em-warning-700"><AlertTriangle className="h-3 w-3" />{t("orders.rtoSignal")}</p>}
      </td>
      <td className="max-w-[180px] px-3 py-3 align-top">
        <p className="truncate font-medium text-em-text-primary">{order.customerName}</p>
        <p className="truncate text-xs text-em-text-secondary">{order.customerPhone || "—"}</p>
      </td>
      <td className="max-w-[220px] px-3 py-3 align-top text-em-text-secondary"><p className="truncate">{itemSummary}</p></td>
      <td className="max-w-[110px] px-3 py-3 align-top text-em-text-secondary">{order.channel || t("orders.channelUnknown")}</td>
      <td className="whitespace-nowrap px-3 py-3 text-right align-top font-semibold">{formatCurrency(order.total)}</td>
      <td className="px-3 py-3 align-top">
        <span className={`rounded-full px-2 py-1 text-xs font-semibold ${STATUS_CLASSES[order.status] ?? "bg-em-bg-muted text-em-text-secondary"}`}>
          {t(`orders.status.${order.status}`, { defaultValue: order.status })}
        </span>
      </td>
      <td className="max-w-[170px] px-3 py-3 align-top">
        <p>{paymentLabel}</p>
        <p className="truncate text-xs text-em-text-secondary">{order.payment_method || t("orders.paymentMethod.unknown")}</p>
      </td>
      <td className="max-w-[200px] px-3 py-3 align-top">
        <p>{deliveryLabel}</p>
        <p className="truncate text-xs text-em-text-secondary">
          {order.delivery_tracking_code ? `${providerLabel} · ${order.delivery_tracking_code}` : providerLabel}
        </p>
      </td>
      <td className="whitespace-nowrap px-3 py-3 align-top font-medium">
        {expectedCollection === null ? t("orders.expectedCollectionUnknown") : formatCurrency(expectedCollection)}
      </td>
      <td className="whitespace-nowrap px-3 py-3 align-top text-xs text-em-text-secondary">{formatDate(order.createdAt)}</td>
      <td className="whitespace-nowrap px-3 py-3 align-top">
        <div className="flex gap-2">
          <button type="button" onClick={() => onViewDetail(order)} className="min-h-11 rounded-md border border-em-border px-2 py-1.5 text-xs font-semibold hover:bg-em-bg-muted">
            {t("orders.row.viewDetail")}
          </button>
          {canDispatch && (
            <button type="button" onClick={() => onDispatch(order)} className="min-h-11 rounded-md bg-em-violet-600 px-2 py-1.5 text-xs font-semibold text-white">
              {t("orders.row.dispatch")}
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}
