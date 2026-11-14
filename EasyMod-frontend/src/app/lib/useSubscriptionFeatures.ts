import { useTranslation } from "react-i18next";
import { useClaimDecisions } from "@/api/domains/commercialContract";
import type { ClaimDecision } from "@/api/types/commercial";
import { resolveClaimLocale } from "@/app/components/claims/ClaimProvider";

/**
 * Merchant capability flags — derived from the commercial claim registry
 * (ADR-0011), never from a subscription plan.
 *
 * There are no plan tiers any more: `advanced_ai` is available exactly when the
 * server-evaluated `ai.draft_reply` claim is available for this shop. A missing
 * query, a failed lookup, or an unavailable claim resolves `false` — capability
 * flags fail closed. Retired marketing flags (priority support, custom
 * branding, photo understanding) have no registry evidence and stay `false`
 * rather than asserting an unimplemented promise.
 */

export interface SubscriptionFeatures {
  image_understanding: boolean;
  advanced_ai: boolean;
  priority_support: boolean;
  custom_branding: boolean;
}

export interface UseSubscriptionFeaturesResult {
  features: SubscriptionFeatures;
  planName: string | null;
  loading: boolean;
  error: string | null;
}

const LOCKED_FEATURES: SubscriptionFeatures = Object.freeze({
  image_understanding: false,
  advanced_ai: false,
  priority_support: false,
  custom_branding: false,
});

function claimAvailable(decisions: ReadonlyMap<string, ClaimDecision>, claimId: string): boolean {
  const decision = decisions.get(claimId);
  if (!decision) return false;
  if (decision.render !== "claim" || !decision.available) return false;
  // Enforce mode may only render an available claim; shadow/off render through
  // but the capability is still gated by the predicate itself.
  return decision.predicate.code_present
    && decision.predicate.merchant_enabled
    && decision.predicate.production_verified
    && !decision.predicate.deprecated
    && !decision.predicate.internal_only;
}

export function useSubscriptionFeatures(): UseSubscriptionFeaturesResult {
  const { i18n } = useTranslation();
  const locale = resolveClaimLocale(i18n?.language);
  const query = useClaimDecisions("subscription", locale);

  const decisions = new Map<string, ClaimDecision>();
  for (const decision of query.data?.decisions ?? []) {
    decisions.set(decision.claimId, decision);
  }

  const advancedAi = claimAvailable(decisions, "ai.draft_reply");

  return {
    features: {
      ...LOCKED_FEATURES,
      advanced_ai: advancedAi,
    },
    planName: null,
    loading: query.isLoading,
    error: query.error ? "Failed to load capability decisions" : null,
  };
}