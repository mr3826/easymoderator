import type { ReactNode } from "react";
import { Lock } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { useClaimDecisions } from "@/api/domains/commercialContract";
import type { ClaimDecision, ClaimSurface } from "@/api/types/commercial";
import { resolveClaimLocale } from "./claims/ClaimProvider";

/**
 * Capability gate backed by the commercial claim registry (ADR-0011).
 *
 * There is no subscription plan to upgrade to, so the old plan-highlight
 * upgrade modal is gone. A gate is open only while its server-evaluated claim
 * is available; otherwise it shows the claim's own truthful copy (or the
 * fallback text) and links to billing — never a promised plan.
 *
 * Fail-closed: a missing decision, a failed decision fetch, or an unavailable
 * claim keeps the children locked.
 */

interface FeatureGateProps {
  /** Claim registry id that grants the capability, e.g. `ai.draft_reply`. */
  claimId: string;
  /** Human-readable capability name used when no claim copy is available. */
  featureLabel?: string;
  /** Claim surface the decision must be evaluated on. */
  surface?: ClaimSurface;
  children: ReactNode;
}

function isClaimUsable(decision: ClaimDecision | null): boolean {
  if (!decision) return false;
  if (decision.render !== "claim" || !decision.available) return false;
  return decision.predicate.code_present
    && decision.predicate.merchant_enabled
    && decision.predicate.production_verified
    && !decision.predicate.deprecated
    && !decision.predicate.internal_only;
}

export function FeatureGate({
  claimId,
  featureLabel,
  surface = "subscription",
  children,
}: FeatureGateProps) {
  const { t, i18n } = useTranslation();
  const locale = resolveClaimLocale(i18n?.language);
  const query = useClaimDecisions(surface, locale);
  const decision = query.data?.decisions.find((entry) => entry.claimId === claimId) ?? null;

  if (query.isLoading) {
    return (
      <div
        data-testid="feature-gate-loading"
        className="relative select-none"
        aria-busy
      >
        <div className="absolute inset-0 z-10 rounded-lg bg-white/70 backdrop-blur-[2px] flex items-center justify-center p-4">
          <div className="flex items-center gap-1.5 bg-gray-100 text-gray-600 px-3 py-1.5 rounded-full text-sm font-medium shadow-sm text-center">
            <Lock className="w-3.5 h-3.5" />
            <span>{t("subscription.loadingFeatures", "Checking feature availability...")}</span>
          </div>
        </div>
        <div className="pointer-events-none opacity-40">{children}</div>
      </div>
    );
  }

  if (query.error) {
    return (
      <div
        data-testid="feature-gate-unavailable"
        className="relative select-none"
        aria-busy={false}
      >
        <div className="absolute inset-0 z-10 rounded-lg bg-white/70 backdrop-blur-[2px] flex items-center justify-center p-4">
          <div className="flex items-center gap-1.5 bg-gray-100 text-gray-600 px-3 py-1.5 rounded-full text-sm font-medium shadow-sm text-center">
            <Lock className="w-3.5 h-3.5" />
            <span>{t("subscription.entitlementsUnavailable", "Feature availability is temporarily unavailable.")}</span>
          </div>
        </div>
        <div className="pointer-events-none opacity-40">{children}</div>
      </div>
    );
  }

  if (isClaimUsable(decision)) {
    return <>{children}</>;
  }

  const claimText = decision?.textKey
    ? t(decision.textKey, { ...decision.interpolation })
    : null;
  const message = typeof claimText === "string" && claimText.length > 0 && claimText !== decision?.textKey
    ? claimText
    : featureLabel || t("featureGate.unavailable", "This capability is not available for this shop.");

  return (
    <div className="relative select-none" data-testid="feature-gate-locked">
      <div className="absolute inset-0 z-10 rounded-lg bg-white/60 backdrop-blur-[2px] flex flex-col items-center justify-center gap-2 p-4 text-center">
        <div className="flex items-center gap-1.5 bg-amber-100 text-amber-700 px-3 py-1.5 rounded-full text-sm font-medium shadow-sm">
          <Lock className="w-3.5 h-3.5" />
          <span>{message}</span>
        </div>
        <Link to="/subscription" className="text-xs font-semibold text-brand underline">
          {t("featureGate.viewBilling", "View billing")}
        </Link>
      </div>
      <div className="pointer-events-none opacity-40">{children}</div>
    </div>
  );
}