import { AlertTriangle, X } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { authService } from "@/app/lib/auth";
import { Claim } from "./claims/Claim";
import { ClaimProvider, useRequiredClaimContext } from "./claims/ClaimProvider";

/**
 * Billing standing notice (ADR-0011).
 *
 * The retired conversation-quota threshold banner is gone: there is no
 * conversation allowance to meter. What remains is the founder-approved
 * overdue policy, rendered from the claim registry on the `usage-banner`
 * surface — block new courier bookings, pause automated replies, keep the
 * manual inbox and history readable, never delete data.
 *
 * Fail-closed: when the claim cannot be evaluated the banner renders nothing
 * rather than inventing a notice.
 */

const OVERDUE_CLAIM_ID = "billing.overdue_policy";

function readDismissed(key: string): boolean {
  try {
    return sessionStorage.getItem(key) === "dismissed";
  } catch {
    return false;
  }
}

function writeDismissed(key: string): void {
  try {
    sessionStorage.setItem(key, "dismissed");
  } catch {
    // A blocked session store must not stop the dismiss from applying locally.
  }
}

function StandingNotice({ onDismiss }: { onDismiss: () => void }) {
  const { t } = useTranslation();
  const context = useRequiredClaimContext();
  const decision = context.decisions.get(OVERDUE_CLAIM_ID);

  // No decision, or a decision that must not render: no banner at all.
  if (!decision || decision.render === "none" || !decision.textKey) return null;

  return (
    <div
      data-testid="billing-standing-banner"
      data-claim-mode={decision.mode}
      className="mx-4 mt-3 flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800"
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="font-semibold">{t("billingStanding.title")}</p>
        <p className="mt-0.5">
          <Claim id={OVERDUE_CLAIM_ID} surface="usage-banner" />
        </p>
        <Link to="/subscription" className="mt-1 inline-block font-semibold underline">
          {t("billingStanding.manage")}
        </Link>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        className="rounded p-1 hover:bg-black/5"
        aria-label={t("billingStanding.dismiss")}
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}

export function BillingStandingBanner() {
  const shopId = authService.getCurrentShopId() || "anonymous";
  const dismissKey = `billing-standing:${shopId}`;
  const [dismissed, setDismissed] = useState(() => readDismissed(dismissKey));

  if (dismissed) return null;

  const dismiss = () => {
    writeDismissed(dismissKey);
    setDismissed(true);
  };

  return (
    <ClaimProvider surface="usage-banner">
      <StandingNotice onDismiss={dismiss} />
    </ClaimProvider>
  );
}

export default BillingStandingBanner;