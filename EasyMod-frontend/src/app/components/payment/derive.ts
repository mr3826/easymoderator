/**
 * Pure payment-channel signal derivation (guardrails §8/§29). One dominant
 * signal: can customers pay this shop right now? Method detail stays in the
 * cards; the header carries only facts.
 */
import type { Signal } from "../dashboard/types";

export interface PaymentDeriveInput {
  phase: "loading" | "error" | "ready";
  enabledCount: number;
}

export type PaymentTranslate = (key: string, opts?: Record<string, unknown>) => string;

export function derivePaymentSignal(input: PaymentDeriveInput, t: PaymentTranslate): Signal {
  if (input.phase === "error") {
    return {
      kind: "blocked",
      label: t("manageShop.paymentSettings.signal.blocked"),
      reason: t("manageShop.paymentSettings.signal.reason.loadFailed"),
    };
  }
  if (input.phase === "loading") {
    return { kind: "pending", label: t("manageShop.paymentSettings.signal.pending") };
  }
  if (input.enabledCount > 0) {
    return {
      kind: "healthy",
      label: t("manageShop.paymentSettings.signal.healthy"),
      reason: t("manageShop.paymentSettings.signal.reason.enabledCount", { count: input.enabledCount }),
    };
  }
  return {
    kind: "attention",
    label: t("manageShop.paymentSettings.signal.attention"),
    reason: t("manageShop.paymentSettings.signal.reason.noMethodEnabled"),
  };
}
