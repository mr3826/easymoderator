/**
 * Pure Business-Policies tab signal derivation (guardrails §8/§29; redesign
 * spec 02 §3). One dominant signal for THIS tab only — derived from the
 * policies' own load phase and how many of the four policies the SERVER has
 * actually stated; never fabricated page-wide across the workspace (02 §4.1)
 * and never inferred from unsaved edits (server-confirmed rule).
 *
 * Mirror of business/derive.ts + faq/derive.ts: key names deliberately avoid
 * the legacy pin-regex substrings (error/failed/saved/success/loading/save)
 * so identity tMock raw-key renders never collide with singular queryByText
 * assertions in the guardrail suites.
 */
import type { Signal } from "../dashboard/types";

export interface PoliciesDeriveInput {
  phase: "loading" | "error" | "ready";
  /**
   * How many of the four policies carry an EXPLICIT server stance
   * (offered | not_offered | conditional). Absent policies and rows whose
   * stance is unspecified both count as NOT stated — Y3 honesty rule:
   * absence ≠ empty object ≠ 'not_offered' ≠ invented default.
   */
  statedCount: number;
}

export type PoliciesTranslate = (key: string, opts?: Record<string, unknown>) => string;

/** The contract's four policy kinds (returns, exchange, refunds, warranty). */
export const POLICY_TOTAL = 4;

export function derivePoliciesSignal(input: PoliciesDeriveInput, t: PoliciesTranslate): Signal {
  if (input.phase === "error") {
    return {
      kind: "blocked",
      label: t("manageShop.businessFaq.policies.signal.blocked"),
      reason: t("manageShop.businessFaq.policies.signal.reason.unavailable"),
    };
  }
  if (input.phase === "loading") {
    return { kind: "pending", label: t("manageShop.businessFaq.policies.signal.pending") };
  }
  const stated = Math.max(0, Math.min(POLICY_TOTAL, Math.trunc(Number(input.statedCount) || 0)));
  if (stated === 0) {
    // The documented DEFAULT state of a fresh shop: nothing pre-filled,
    // nothing invented — the merchant simply has not stated any policy yet.
    return {
      kind: "attention",
      label: t("manageShop.businessFaq.policies.signal.attention"),
      reason: t("manageShop.businessFaq.policies.signal.reason.noneStated"),
    };
  }
  if (stated < POLICY_TOTAL) {
    return {
      kind: "attention",
      label: t("manageShop.businessFaq.policies.signal.attention"),
      reason: t("manageShop.businessFaq.policies.signal.reason.stated", { count: stated }),
    };
  }
  return {
    kind: "healthy",
    label: t("manageShop.businessFaq.policies.signal.healthy"),
    reason: t("manageShop.businessFaq.policies.signal.reason.stated", { count: POLICY_TOTAL }),
  };
}
