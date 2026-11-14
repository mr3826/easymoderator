/**
 * Commercial contract API types (ADR-0011).
 *
 * Mirrors the authenticated backend claim decision exactly (camelCase service
 * boundary, AGENT_CONTRACTS §1) and the public snake_case contract payload.
 * Money stays integer paisa/poisha at the boundary; display formatting belongs
 * to the shared contract mirror.
 */

import type { PublicCommercialContract } from "@/shared/contracts/commercial-contract";

export type { PublicCommercialContract };

export const CLAIM_SURFACES = [
  "pricing",
  "subscription",
  "signup",
  "landing",
  "email",
  "usage-banner",
  "mobile",
  "collateral",
  "growth-os",
  "admin",
  "invoice",
] as const;

export type ClaimSurface = (typeof CLAIM_SURFACES)[number];

export const CLAIM_MODES = ["off", "shadow", "enforce"] as const;
export type ClaimMode = (typeof CLAIM_MODES)[number];

export const CLAIM_RENDERS = ["claim", "fallback", "none"] as const;
export type ClaimRender = (typeof CLAIM_RENDERS)[number];

export type ClaimLocale = "en" | "bn";

export interface ClaimPredicate {
  readonly code_present: boolean;
  readonly merchant_enabled: boolean;
  readonly production_verified: boolean;
  readonly deprecated: boolean;
  readonly internal_only: boolean;
  readonly scope_match: boolean;
}

export interface ClaimScope {
  readonly claimedProviders: readonly string[] | null;
  readonly verifiedProviders: readonly string[] | null;
  readonly match: boolean;
  readonly text: string | null;
}

/**
 * One server-evaluated claim decision. `render:'none'` means the claim must
 * produce no DOM node at all; `render:'fallback'` means render the truthful
 * fallback key; `render:'claim'` means render the claim key.
 */
export interface ClaimDecision {
  readonly claimId: string;
  readonly available: boolean;
  readonly render: ClaimRender;
  readonly textKey: string | null;
  readonly locale: ClaimLocale;
  readonly surface: ClaimSurface;
  readonly scope: ClaimScope;
  readonly interpolation: Readonly<Record<string, string>>;
  readonly mode: ClaimMode;
  readonly predicate: ClaimPredicate;
  readonly wouldBlock: boolean;
  readonly contractVersion: string;
  readonly registryHash: string;
}

export interface ClaimDecisionPayload {
  readonly surface: ClaimSurface;
  readonly locale: ClaimLocale;
  readonly contractVersion: string;
  readonly registryHash: string;
  readonly decisions: readonly ClaimDecision[];
}

/** Public (unauthenticated) claim descriptor from the contract endpoint. */
export interface PublicClaimDescriptor {
  readonly id: string;
  readonly verified_scope: string | null;
  readonly surfaces: readonly ClaimSurface[];
  readonly i18n_key: Readonly<{ en: string; bn: string }>;
  readonly fallback_i18n_key: Readonly<{ en: string; bn: string }> | null;
}

/** Public contract payload: frozen snake_case contract plus registry metadata. */
export interface PublicCommercialContractPayload extends PublicCommercialContract {
  readonly registry_hash: string;
  readonly claims: readonly PublicClaimDescriptor[];
  /**
   * Server-evaluated claim decisions for anonymous visitors. Contracts and
   * platform claims are evaluated truthfully; merchant-dependent claims fail
   * closed to their fallback because no shop context exists.
   */
  readonly decisions: readonly ClaimDecision[];
}