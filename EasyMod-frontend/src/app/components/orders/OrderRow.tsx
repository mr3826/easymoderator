/** Mobile task card and desktop worklist row for an order. */
import { AlertTriangle } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Order } from "@/api/types/order";
import { canBookCourierForOrder, getExpectedCourierCollection } from "./orderRules";

// Semantic token-aligned status pill classes
const STATUS_CLASSES: Record<string, string> = {
  draft: "bg-muted text-muted-foreground",
  confirmed: "bg-blue-100 text-blue-700",
  processing: "bg-yellow-100 text-yellow-700",
  completed: "bg-green-100 text-green-700",
  delivered: "bg-green-100 text-green-700",
  cancelled: "bg-destructive/10 text-destructive",
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
    <article className="rounded-xl border border-border bg-card p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-bold text-card-foreground">{order.customerName}</p>
          <p className="truncate text-xs text-muted-foreground">#{order.orderNumber || order.id}{order.customerPhone ? ` · ${order.customerPhone}` : ""}</p>
        </div>
        <span
          className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-bold ${
            STATUS_CLASSES[order.status] ?? "bg-muted text-muted-foreground"
          }`}
        >
          {t(`orders.status.${order.status}`, { defaultValue: order.status })}
        </span>
      </div>

      <div className="mt-2 flex items-center justify-between gap-2">
        <p className="truncate text-xs text-muted-foreground">{itemSummary}</p>
        <p className="shrink-0 text-sm font-bold text-foreground">{formatCurrency(order.total)}</p>
      </div>

      <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
        <p className="col-span-2 truncate text-muted-foreground">
          <span className="font-semibold text-foreground">{t("orders.columns.channel")}:</span> {order.channel || t("orders.channelUnknown")}
        </p>
        <p className="rounded-md bg-muted px-2 py-1.5 text-muted-foreground">
          <span className="font-semibold text-foreground">{t("orders.columns.payment")}:</span> {paymentLabel} · {paymentMethod}
        </p>
        <p className="rounded-md bg-muted px-2 py-1.5 text-muted-foreground">
          <span className="font-semibold text-foreground">{t("orders.columns.delivery")}:</span> {deliveryLabel}
        </p>
        <p className="col-span-2 rounded-md bg-muted px-2 py-1.5 text-muted-foreground">
          <span className="font-semibold text-foreground">{t("orders.columns.expectedCollection")}:</span>{" "}
          {expectedCollection === null ? t("orders.expectedCollectionUnknown") : formatCurrency(expectedCollection)}
        </p>
        <p className="col-span-2 truncate text-muted-foreground">
          {providerLabel}{order.delivery_tracking_code ? ` · ${order.delivery_tracking_code}` : ` · ${t("orders.fulfillment.trackingUnavailable")}`}
        </p>
        <p className="col-span-2 text-muted-foreground">{formatDate(order.createdAt)}</p>
        {order.rto_risk === "high" && (
          <p className="col-span-2 inline-flex items-center gap-1 font-semibold text-amber-800">
            <AlertTriangle className="h-3 w-3" /> {t("orders.rtoSignal")}
          </p>
        )}
      </div>

      <div className={`mt-3 grid gap-2 ${canDispatch ? "grid-cols-2" : "grid-cols-1"}`}>
        <button
          type="button"
          onClick={() => onViewDetail(order)}
          className="min-h-10 rounded-lg border border-border bg-background px-3 text-sm font-semibold text-foreground hover:bg-muted"
        >
          {order.status === "draft" ? t("orders.row.reviewDraft") : t("orders.row.viewDetail")}
        </button>
        {canDispatch && (
          <button
            type="button"
            onClick={() => onDispatch(order)}
            className="min-h-10 rounded-lg bg-primary px-3 text-sm font-bold text-primary-foreground"
          >
            {t("orders.row.dispatch")}
          </button>
        )}
        {order.delivery_tracking_code && provider === "steadfast" && (
          <a
            href={`https://steadfast.com.bd/track?trackingCode=${encodeURIComponent(order.delivery_tracking_code)}`}
            target="_blank"
            rel="noreferrer"
            className="col-span-2 min-h-10 rounded-lg border border-border px-3 py-2 text-center text-sm font-semibold text-primary"
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
    <tr className={selected ? "bg-primary/5" : "hover:bg-muted/30"}>
      <td className="whitespace-nowrap px-3 py-3 align-top">
        <button type="button" onClick={() => onViewDetail(order)} className="font-semibold text-primary hover:underline">
          {order.orderNumber || order.id}
        </button>
        {order.rto_risk === "high" && <p className="mt-1 flex items-center gap-1 text-xs text-amber-800"><AlertTriangle className="h-3 w-3" />{t("orders.rtoSignal")}</p>}
      </td>
      <td className="max-w-[180px] px-3 py-3 align-top">
        <p className="truncate font-medium text-foreground">{order.customerName}</p>
        <p className="truncate text-xs text-muted-foreground">{order.customerPhone || "—"}</p>
      </td>
      <td className="max-w-[220px] px-3 py-3 align-top text-muted-foreground"><p className="truncate">{itemSummary}</p></td>
      <td className="max-w-[110px] px-3 py-3 align-top text-muted-foreground">{order.channel || t("orders.channelUnknown")}</td>
      <td className="whitespace-nowrap px-3 py-3 text-right align-top font-semibold">{formatCurrency(order.total)}</td>
      <td className="px-3 py-3 align-top">
        <span className={`rounded-full px-2 py-1 text-xs font-semibold ${STATUS_CLASSES[order.status] ?? "bg-muted text-muted-foreground"}`}>
          {t(`orders.status.${order.status}`, { defaultValue: order.status })}
        </span>
      </td>
      <td className="max-w-[170px] px-3 py-3 align-top">
        <p>{paymentLabel}</p>
        <p className="truncate text-xs text-muted-foreground">{order.payment_method || t("orders.paymentMethod.unknown")}</p>
      </td>
      <td className="max-w-[200px] px-3 py-3 align-top">
        <p>{deliveryLabel}</p>
        <p className="truncate text-xs text-muted-foreground">
          {order.delivery_tracking_code ? `${providerLabel} · ${order.delivery_tracking_code}` : providerLabel}
        </p>
      </td>
      <td className="whitespace-nowrap px-3 py-3 align-top font-medium">
        {expectedCollection === null ? t("orders.expectedCollectionUnknown") : formatCurrency(expectedCollection)}
      </td>
      <td className="whitespace-nowrap px-3 py-3 align-top text-xs text-muted-foreground">{formatDate(order.createdAt)}</td>
      <td className="whitespace-nowrap px-3 py-3 align-top">
        <div className="flex gap-2">
          <button type="button" onClick={() => onViewDetail(order)} className="rounded-md border border-border px-2 py-1.5 text-xs font-semibold hover:bg-muted">
            {t("orders.row.viewDetail")}
          </button>
          {canDispatch && (
            <button type="button" onClick={() => onDispatch(order)} className="rounded-md bg-primary px-2 py-1.5 text-xs font-semibold text-primary-foreground">
              {t("orders.row.dispatch")}
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}
