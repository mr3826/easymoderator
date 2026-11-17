/**
 * Pure FAQ-page signal derivation (guardrails §8/§29). Execution page: the
 * dominant signal tells the merchant whether customer questions are waiting
 * for answers; counts are factual context, never vanity metrics.
 */
import type { Signal } from "../dashboard/types";

export interface FaqDeriveInput {
  phase: "loading" | "error" | "ready" | "empty";
  openGapCount: number;
  activeCount: number;
  totalCount: number;
}

export type FaqTranslate = (key: string, opts?: Record<string, unknown>) => string;

export function deriveFaqSignal(input: FaqDeriveInput, t: FaqTranslate): Signal {
  if (input.phase === "error") {
    return {
      kind: "blocked",
      label: t("faqSettings.signal.blocked"),
      reason: t("faqSettings.signal.reason.error"),
    };
  }
  if (input.phase === "loading") {
    return { kind: "pending", label: t("faqSettings.signal.pending") };
  }
  if (input.openGapCount > 0) {
    return {
      kind: "attention",
      label: t("faqSettings.signal.attention"),
      reason: t("faqSettings.signal.reason.gaps", { count: input.openGapCount }),
    };
  }
  if (input.phase === "empty") {
    return {
      kind: "pending",
      label: t("faqSettings.signal.empty"),
      reason: t("faqSettings.signal.reason.empty"),
    };
  }
  return {
    kind: "healthy",
    label: t("faqSettings.signal.healthy"),
    reason: t("faqSettings.signal.reason.ready", {
      active: input.activeCount,
      total: input.totalCount,
    }),
  };
}
