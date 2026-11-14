/**
 * Commercial contract — frontend mirror of
 * EasyMod-backend/src/modules/commercial/commercial.contract.js.
 *
 * This file is HAND-MIRRORED: the monorepo forbids importing backend modules
 * from the frontend. `__tests__/commercial-contract.parity.test.ts` compares it
 * with `__fixtures__/commercial-contract.fixture.json`, which is generated from
 * the backend snapshot, so any drift is a failing test rather than a silent
 * price disagreement. Bump both sides together.
 *
 * Money is integer poisha (BDT minor units). See ADR-0011.
 */

export const COMMERCIAL_CONTRACT_VERSION = "1.0.0";

export const ZERO_RATED_OUTCOMES = [
  "RETURNED",
  "CANCELLED",
  "DRAFT",
  "CONFIRMED",
  "BOOKED",
  "IN_TRANSIT",
  "FAILED",
] as const;

export type ZeroRatedOutcome = (typeof ZERO_RATED_OUTCOMES)[number];

export interface OverduePolicy {
  readonly blockCourierBooking: boolean;
  readonly pauseAutomatedAi: boolean;
  readonly keepInboxReadable: boolean;
  readonly keepHistoryReadable: boolean;
  readonly deleteData: false;
}

export interface CommercialContract {
  readonly contractVersion: string;
  readonly schemaName: string;
  readonly model: "DELIVERED_ORDER";
  readonly currency: "BDT";
  readonly trigger: "ORDER_DELIVERED_PROVIDER_CONFIRMED";
  readonly unitPriceMinor: number;
  readonly zeroRatedOutcomes: readonly ZeroRatedOutcome[];
  readonly subscriptionFeeMinor: 0;
  readonly setupFeeMinor: 0;
  readonly monthlyMinimumMinor: 0;
  readonly conversationEntitlement: null;
  readonly cycle: "MONTHLY";
  readonly payment: "POSTPAID";
  readonly dueDays: number;
  readonly onOverdue: OverduePolicy;
}

export const COMMERCIAL_CONTRACT: CommercialContract = Object.freeze({
  contractVersion: COMMERCIAL_CONTRACT_VERSION,
  schemaName: "commercial.contract",
  model: "DELIVERED_ORDER",
  currency: "BDT",
  trigger: "ORDER_DELIVERED_PROVIDER_CONFIRMED",
  unitPriceMinor: 1000,
  zeroRatedOutcomes: Object.freeze([...ZERO_RATED_OUTCOMES]),
  subscriptionFeeMinor: 0,
  setupFeeMinor: 0,
  monthlyMinimumMinor: 0,
  conversationEntitlement: null,
  cycle: "MONTHLY",
  payment: "POSTPAID",
  dueDays: 7,
  onOverdue: Object.freeze({
    blockCourierBooking: true,
    pauseAutomatedAi: true,
    keepInboxReadable: true,
    keepHistoryReadable: true,
    deleteData: false,
  }),
});

/** Public API payload shape (snake_case), as served by the backend. */
export interface PublicCommercialContract {
  readonly contract_version: string;
  readonly contract_hash: string;
  readonly model: string;
  readonly currency: string;
  readonly trigger: string;
  readonly unit_price_bdt: number;
  readonly unit_price_minor: number;
  readonly zero_rated_outcomes: readonly string[];
  readonly subscription_fee_bdt: number;
  readonly setup_fee_bdt: number;
  readonly monthly_minimum_bdt: number;
  readonly conversation_entitlement: null;
  readonly cycle: string;
  readonly payment: string;
  readonly due_days: number;
  // The backend payload reuses the frozen camelCase onOverdue object verbatim.
  readonly on_overdue: OverduePolicy;
  readonly description: { readonly en: string; readonly bn: string };
}

const BENGALI_DIGITS = ["০", "১", "২", "৩", "৪", "৫", "৬", "৭", "৮", "৯"] as const;

export function toBengaliNumerals(text: string | number): string {
  return String(text).replace(/[0-9]/g, (digit) => BENGALI_DIGITS[Number(digit)]);
}

/** formatBdt(1000) -> '৳10.00' */
export function formatBdt(minor: number): string {
  const value = Number(minor);
  if (!Number.isFinite(value)) {
    throw new TypeError("formatBdt requires a finite integer minor amount");
  }
  return `৳${(value / 100).toFixed(2)}`;
}

/** formatBdtBn(1000) -> '৳১০.০০' */
export function formatBdtBn(minor: number): string {
  return toBengaliNumerals(formatBdt(minor));
}

export function unitPriceDisplay(locale: "en" | "bn" = "en"): string {
  return locale === "bn"
    ? formatBdtBn(COMMERCIAL_CONTRACT.unitPriceMinor)
    : formatBdt(COMMERCIAL_CONTRACT.unitPriceMinor);
}