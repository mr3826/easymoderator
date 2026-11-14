import { useTranslation } from "react-i18next";
import type { ClaimSurface } from "@/api/types/commercial";
import { useClaimContext } from "./ClaimProvider";

/**
 * Renders one registry claim from the server-evaluated decisions of its
 * surface. Copy is never hardcoded here: the decision supplies the i18n key
 * (claim or truthful fallback) and the rewrite interpolation.
 *
 * Fail-closed:
 *   - no provider / no decision / unknown claim => no DOM node
 *   - enforce + unavailable without a fallback => no DOM node
 *   - a missing translation key => no DOM node (never leak the raw key)
 */

export interface ClaimProps {
  id: string;
  surface?: ClaimSurface;
  className?: string;
}

export function Claim({ id, surface, className }: ClaimProps) {
  const context = useClaimContext();
  const { t } = useTranslation();

  const decision = context?.decisions.get(id) ?? null;
  if (!decision) return null;

  // A decision is only valid on the surface that requested it.
  if (surface && decision.surface !== surface) return null;
  if (decision.render === "none") return null;
  if (decision.mode === "enforce" && !decision.available && decision.render !== "fallback") {
    return null;
  }
  if (!decision.textKey) return null;

  const text = t(decision.textKey, { ...decision.interpolation });
  if (typeof text !== "string" || text.length === 0 || text === decision.textKey) return null;

  return (
    <span
      data-claim-id={id}
      data-claim-render={decision.render}
      data-claim-mode={decision.mode}
      data-contract-version={decision.contractVersion}
      className={className}
    >
      {text}
    </span>
  );
}