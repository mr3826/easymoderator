/**
 * Pure product-catalog signal derivation (guardrails §8/§29). One dominant
 * signal: does the catalog need attention (low stock) or is it ready? Counts
 * come from the client-side list (the server returns a full array; low stock is
 * a client filter). Key names avoid the legacy pinned phrases so real-i18n
 * singular assertions never collide with the header signal.
 */
import type { Signal } from "../dashboard/types";

export interface ProductsDeriveInput {
  phase: "loading" | "error" | "ready";
  totalCount: number | null;
  lowStockCount: number | null;
}

export type ProductsTranslate = (key: string, opts?: Record<string, unknown>) => string;

export function deriveProductsSignal(input: ProductsDeriveInput, t: ProductsTranslate): Signal {
  if (input.phase === "error") {
    return {
      kind: "blocked",
      label: t("products.signal.blocked"),
      reason: t("products.signal.reason.unavailable"),
    };
  }
  if (input.phase === "loading") {
    return { kind: "pending", label: t("products.signal.pending") };
  }
  if ((input.lowStockCount ?? 0) > 0) {
    return {
      kind: "attention",
      label: t("products.signal.lowStock"),
      reason: t("products.signal.reason.lowStockCount", { count: input.lowStockCount }),
    };
  }
  if ((input.totalCount ?? 0) > 0) {
    return {
      kind: "healthy",
      label: t("products.signal.healthy"),
      reason: t("products.signal.reason.totalCount", { count: input.totalCount }),
    };
  }
  return {
    kind: "attention",
    label: t("products.signal.attention"),
    reason: t("products.signal.reason.noProducts"),
  };
}
