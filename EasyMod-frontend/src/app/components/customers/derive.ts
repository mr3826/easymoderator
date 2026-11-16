/**
 * Pure customer-worklist signal derivation (guardrails §8/§29). One dominant
 * signal: is there customer activity to act on? Counts come from the list
 * response (null until loaded → dash, never invented 0). Key names avoid the
 * legacy pinned phrases ("No customers yet", "No customers match") so real-i18n
 * singular assertions never collide with the header signal.
 */
import type { Signal } from "../dashboard/types";

export interface CustomersDeriveInput {
  phase: "loading" | "error" | "ready";
  totalCount: number | null;
  opportunityCount: number | null;
}

export type CustomersTranslate = (key: string, opts?: Record<string, unknown>) => string;

export function deriveCustomersSignal(input: CustomersDeriveInput, t: CustomersTranslate): Signal {
  if (input.phase === "error") {
    return {
      kind: "blocked",
      label: t("customers.signal.blocked"),
      reason: t("customers.signal.reason.unavailable"),
    };
  }
  if (input.phase === "loading") {
    return { kind: "pending", label: t("customers.signal.pending") };
  }
  if ((input.opportunityCount ?? 0) > 0) {
    return {
      kind: "attention",
      label: t("customers.signal.opportunities"),
      reason: t("customers.signal.reason.opportunityCount", { count: input.opportunityCount }),
    };
  }
  if ((input.totalCount ?? 0) > 0) {
    return {
      kind: "healthy",
      label: t("customers.signal.healthy"),
      reason: t("customers.signal.reason.totalCount", { count: input.totalCount }),
    };
  }
  return {
    kind: "attention",
    label: t("customers.signal.attention"),
    reason: t("customers.signal.reason.noCustomers"),
  };
}
