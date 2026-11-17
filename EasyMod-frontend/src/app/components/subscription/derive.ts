/**
 * Pure billing signal derivation (guardrails §8/§29). One dominant signal: does
 * this shop owe a payment right now? Prices are never derived here — they come
 * only from the validated public contract (fail-closed, ADR-0011), so this
 * module deals in counts and phases alone. Key names avoid the legacy pinned
 * phrases and never render currency, so singular price assertions stay unique.
 */
import type { Signal } from "../dashboard/types";

export interface BillingDeriveInput {
  /** "error" means the commercial contract could not be validated. */
  phase: "loading" | "error" | "ready";
  invoiceCount: number;
  outstandingCount: number;
}

export type BillingTranslate = (key: string, opts?: Record<string, unknown>) => string;

export function deriveBillingSignal(input: BillingDeriveInput, t: BillingTranslate): Signal {
  if (input.phase === "error") {
    return {
      kind: "blocked",
      label: t("subscription.signal.blocked"),
      reason: t("subscription.signal.reason.termsUnavailable"),
    };
  }
  if (input.phase === "loading") {
    return { kind: "pending", label: t("subscription.signal.pending") };
  }
  if (input.outstandingCount > 0) {
    return {
      kind: "attention",
      label: t("subscription.signal.due"),
      reason: t("subscription.signal.reason.dueCount", { count: input.outstandingCount }),
    };
  }
  if (input.invoiceCount > 0) {
    return {
      kind: "healthy",
      label: t("subscription.signal.current"),
      reason: t("subscription.signal.reason.invoiceCount", { count: input.invoiceCount }),
    };
  }
  return {
    kind: "attention",
    label: t("subscription.signal.attention"),
    reason: t("subscription.signal.reason.noInvoices"),
  };
}
