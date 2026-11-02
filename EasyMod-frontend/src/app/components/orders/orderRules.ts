import type { Order } from "@/api/types/order";

/** Courier booking is available only after a merchant confirms an order. */
export function canBookCourierForOrder(
  order: Pick<Order, "status" | "delivery_tracking_code" | "delivery_consignment_id">,
) {
  return (
    (order.status === "confirmed" || order.status === "processing")
    && !order.delivery_tracking_code
    && !order.delivery_consignment_id
  );
}

export function getExpectedCourierCollection(
  order: Pick<Order, "total" | "payment_method" | "payment_status">,
): number | null {
  const paymentStatus = order.payment_status?.trim().toLowerCase();
  if (paymentStatus === "paid") return 0;

  const paymentMethod = order.payment_method?.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!paymentMethod) return null;
  if (!["cod", "cash", "cash_on_delivery"].includes(paymentMethod)) return 0;
  if (paymentStatus === "partially_paid") return null;
  if (paymentStatus !== "pending" && paymentStatus !== "unpaid") return null;

  const total = Number(order.total);
  return Number.isFinite(total) && total >= 0 ? total : null;
}
