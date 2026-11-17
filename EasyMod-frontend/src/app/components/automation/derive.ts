/**
 * Pure business-automation signal derivation (guardrails §8/§29). One dominant
 * signal for an EXECUTION page: can the owner edit these defaults right now,
 * and what does the current mode actually do?
 *
 * Precedence is first-match-wins. `stopActive` maps to `blocked` (not the
 * channels workspace's `attention`) because here the editor is literally
 * locked — the fieldset is disabled and the server rejects AUTO writes with
 * 409 EMERGENCY_STOP_ACTIVE. `!isOwner` maps to `review`: the merchant can
 * still read everything, so `blocked` would overstate it.
 *
 * The caller normalizes the mode (fail-closed to MANUAL) so this stays pure.
 * Key wording avoids every legacy pinned phrase ("Reply settings saved.",
 * "Review first", "Only the shop owner can change automation defaults",
 * "locked to Manual until the emergency stop is resumed").
 */
import type { Signal } from "../dashboard/types";
import type { AiReplyMode } from "@/api/types/conversation";

export interface AutomationDeriveInput {
  phase: "loading" | "error" | "ready";
  isOwner: boolean;
  stopActive: boolean;
  mode: AiReplyMode;
}

export type AutomationTranslate = (key: string, opts?: Record<string, unknown>) => string;

export function deriveAutomationSignal(input: AutomationDeriveInput, t: AutomationTranslate): Signal {
  if (input.phase === "error") {
    return {
      kind: "blocked",
      label: t("manageShop.automation.signal.blocked"),
      reason: t("manageShop.automation.signal.reason.unavailable"),
    };
  }
  if (input.phase === "loading") {
    return { kind: "pending", label: t("manageShop.automation.signal.pending") };
  }
  if (input.stopActive) {
    return {
      kind: "blocked",
      label: t("manageShop.automation.signal.stopped"),
      reason: t("manageShop.automation.signal.reason.stopActive"),
    };
  }
  if (!input.isOwner) {
    return {
      kind: "review",
      label: t("manageShop.automation.signal.readOnly"),
      reason: t("manageShop.automation.signal.reason.ownerOnly"),
    };
  }
  if (input.mode === "AUTO") {
    return {
      kind: "attention",
      label: t("manageShop.automation.signal.autoUnverified"),
      reason: t("manageShop.automation.signal.reason.autoUnverified"),
    };
  }
  if (input.mode === "DRAFT") {
    return {
      kind: "review",
      label: t("manageShop.automation.signal.draft"),
      reason: t("manageShop.automation.signal.reason.draft"),
    };
  }
  return {
    kind: "healthy",
    label: t("manageShop.automation.signal.manual"),
    reason: t("manageShop.automation.signal.reason.manual"),
  };
}
