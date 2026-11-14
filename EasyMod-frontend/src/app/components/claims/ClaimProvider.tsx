import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useClaimDecisions } from "@/api/domains/commercialContract";
import { useOptionalAuth } from "@/features/auth/AuthProvider";
import type { ClaimDecision, ClaimSurface } from "@/api/types/commercial";

/**
 * One claim-decision query per surface (ADR-0011). Children read the decisions
 * from context; a surface never issues a query per <Claim/> node.
 *
 * Anonymous visitors (marketing origin, or a page rendered outside
 * AuthProvider) read the PUBLIC decisions embedded in
 * /api/public/commercial-contract: contract/platform claims are available,
 * merchant-dependent claims fail closed to their fallback. Authenticated
 * merchants keep the shop-scoped /api/commercial/claims source.
 */

export interface ClaimContextValue {
  readonly surface: ClaimSurface;
  readonly decisions: ReadonlyMap<string, ClaimDecision>;
  readonly loading: boolean;
  readonly error: Error | null;
  readonly contractVersion: string | null;
  readonly registryHash: string | null;
}

const ClaimContext = createContext<ClaimContextValue | null>(null);

/** Bengali is the product default; only an explicit English locale opts out. */
export function resolveClaimLocale(language?: string): "en" | "bn" {
  return typeof language === "string" && language.toLowerCase().startsWith("en") ? "en" : "bn";
}

export function ClaimProvider({
  surface,
  children,
}: {
  surface: ClaimSurface;
  children: ReactNode;
}) {
  const { i18n } = useTranslation();
  const locale = resolveClaimLocale(i18n?.language);
  const auth = useOptionalAuth();
  const authenticated = auth?.isAuthenticated === true;
  const query = useClaimDecisions(surface, locale, { authenticated });
  const data = query.data;

  const value = useMemo<ClaimContextValue>(() => {
    const decisions = new Map<string, ClaimDecision>();
    for (const decision of data?.decisions ?? []) {
      decisions.set(decision.claimId, decision);
    }
    return {
      surface,
      decisions,
      loading: query.isLoading,
      error: (query.error as Error | null) ?? null,
      contractVersion: data?.contractVersion ?? null,
      registryHash: data?.registryHash ?? null,
    };
  }, [surface, data, query.isLoading, query.error]);

  return <ClaimContext.Provider value={value}>{children}</ClaimContext.Provider>;
}

/** Null when rendered outside a provider: claim rendering then fails closed. */
export function useClaimContext(): ClaimContextValue | null {
  return useContext(ClaimContext);
}

export function useRequiredClaimContext(): ClaimContextValue {
  const context = useContext(ClaimContext);
  if (!context) {
    throw new Error("Claim components must be rendered inside <ClaimProvider>.");
  }
  return context;
}