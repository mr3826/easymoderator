/**
 * Pure business-profile signal derivation (guardrails §8/§29). One dominant
 * signal: is the shop profile usable for customer replies? Detail stays in the
 * form; the header carries only facts. Key names deliberately avoid the legacy
 * pin regex substrings (error/failed/saved/success/loading/save) so identity
 * tMock raw-key renders never collide with singular queryByText assertions.
 */
import type { Signal } from "../dashboard/types";

export interface BusinessDeriveInput {
  phase: "loading" | "error" | "ready";
  hasShopName: boolean;
}

export type BusinessTranslate = (key: string, opts?: Record<string, unknown>) => string;

export function deriveBusinessSignal(input: BusinessDeriveInput, t: BusinessTranslate): Signal {
  if (input.phase === "error") {
    return {
      kind: "blocked",
      label: t("manageShop.businessInfo.signal.blocked"),
      reason: t("manageShop.businessInfo.signal.reason.unavailable"),
    };
  }
  if (input.phase === "loading") {
    return { kind: "pending", label: t("manageShop.businessInfo.signal.pending") };
  }
  if (input.hasShopName) {
    return {
      kind: "healthy",
      label: t("manageShop.businessInfo.signal.healthy"),
      reason: t("manageShop.businessInfo.signal.reason.profileReady"),
    };
  }
  return {
    kind: "attention",
    label: t("manageShop.businessInfo.signal.attention"),
    reason: t("manageShop.businessInfo.signal.reason.needsName"),
  };
}
