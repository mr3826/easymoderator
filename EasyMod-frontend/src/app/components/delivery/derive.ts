/**
 * Pure delivery-channel signal derivation (guardrails §8/§29). One dominant
 * signal: can the shop hand parcels to a courier right now? Provider detail
 * stays in the cards; the header carries only facts.
 */
import type { Signal } from "../dashboard/types";
import type { DeliveryProviderStatus } from "@/api/types/order";

export interface DeliveryDeriveInput {
  phase: "loading" | "error" | "ready";
  providers: DeliveryProviderStatus[];
  activeCount: number;
  connectedCount: number;
}

export type DeliveryTranslate = (key: string, opts?: Record<string, unknown>) => string;

export function deriveDeliverySignal(input: DeliveryDeriveInput, t: DeliveryTranslate): Signal {
  if (input.phase === "error") {
    return {
      kind: "blocked",
      label: t("manageShop.deliverySettings.signal.blocked"),
      reason: t("manageShop.deliverySettings.signal.reason.error"),
    };
  }
  if (input.phase === "loading") {
    return { kind: "pending", label: t("manageShop.deliverySettings.signal.pending") };
  }
  if (input.providers.some((provider) => provider.activation_status === "ACTION_REQUIRED")) {
    return {
      kind: "attention",
      label: t("manageShop.deliverySettings.signal.attention"),
      reason: t("manageShop.deliverySettings.signal.reason.actionRequired"),
    };
  }
  if (input.activeCount > 0) {
    return {
      kind: "healthy",
      label: t("manageShop.deliverySettings.signal.healthy"),
      reason: t("manageShop.deliverySettings.signal.reason.activeCount", { count: input.activeCount }),
    };
  }
  if (input.connectedCount > 0) {
    return {
      kind: "attention",
      label: t("manageShop.deliverySettings.signal.attention"),
      reason: t("manageShop.deliverySettings.signal.reason.setupIncomplete"),
    };
  }
  return {
    kind: "attention",
    label: t("manageShop.deliverySettings.signal.attention"),
    reason: t("manageShop.deliverySettings.signal.reason.notConfigured"),
  };
}
