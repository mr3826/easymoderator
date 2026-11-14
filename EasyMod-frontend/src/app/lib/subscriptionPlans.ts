/**
 * Commercial billing metadata — contract-derived only (ADR-0011).
 *
 * The retired subscription catalog (plan codes, monthly prices, metered usage
 * entitlements, prepaid credits and tiered per-order rates) is gone. There is
 * exactly one price authority: the frozen commercial contract and its frontend
 * mirror. Nothing in this module may define a merchant price or plan name; it
 * only re-exports the contract helpers so older import paths keep working.
 */

import {
  formatBdt,
  formatBdtBn,
} from "@/shared/contracts/commercial-contract";

export {
  COMMERCIAL_CONTRACT,
  COMMERCIAL_CONTRACT_VERSION,
  ZERO_RATED_OUTCOMES,
  formatBdt,
  formatBdtBn,
  toBengaliNumerals,
  unitPriceDisplay,
} from "@/shared/contracts/commercial-contract";

export type {
  CommercialContract,
  OverduePolicy,
  PublicCommercialContract,
  ZeroRatedOutcome,
} from "@/shared/contracts/commercial-contract";

/** Locale-aware rendering of any contract-derived integer minor amount. */
export function formatContractMoney(minor: number, locale?: string): string {
  return String(locale ?? "").toLowerCase().startsWith("bn")
    ? formatBdtBn(minor)
    : formatBdt(minor);
}