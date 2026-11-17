/**
 * Pure order-worklist signal derivation (guardrails §8/§29). One dominant
 * signal: does the worklist need the merchant right now? Counts are the
 * server-aggregated bucket totals (null until loaded → dash, never invented 0).
 * Key names avoid the legacy pinned phrases ("could not be loaded", "No orders
 * are available yet", "No orders match these filters") so real-i18n singular
 * assertions never collide with the header signal.
 */
import type { Signal } from "../dashboard/types";

export interface OrdersDeriveInput {
  phase: "loading" | "error" | "ready";
  totalCount: number | null;
  needsActionCount: number | null;
}

export type OrdersTranslate = (key: string, opts?: Record<string, unknown>) => string;

export function deriveOrdersSignal(input: OrdersDeriveInput, t: OrdersTranslate): Signal {
  if (input.phase === "error") {
    return {
      kind: "blocked",
      label: t("orders.signal.blocked"),
      reason: t("orders.signal.reason.unavailable"),
    };
  }
  if (input.phase === "loading") {
    return { kind: "pending", label: t("orders.signal.pending") };
  }
  if ((input.needsActionCount ?? 0) > 0) {
    return {
      kind: "attention",
      label: t("orders.signal.needsAction"),
      reason: t("orders.signal.reason.needsActionCount", { count: input.needsActionCount }),
    };
  }
  if ((input.totalCount ?? 0) > 0) {
    return {
      kind: "healthy",
      label: t("orders.signal.healthy"),
      reason: t("orders.signal.reason.totalCount", { count: input.totalCount }),
    };
  }
  return {
    kind: "attention",
    label: t("orders.signal.attention"),
    reason: t("orders.signal.reason.noOrders"),
  };
}
