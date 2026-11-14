/**
 * Merchant plan display labels for the internal Growth OS console.
 *
 * ADR-0011 retires the SHURU / GROWTH / PARTNER commercial catalog. There is
 * exactly one merchant tier, `MERCHANT`, billed per provider-confirmed
 * delivered order. Historical subscription rows can still carry a retired
 * `plan_name`/`plan_code`, so this map renders every historical value as
 * `MERCHANT` instead of echoing a name the truth gate forbids.
 *
 * Growth OS is an internal surface (claim-registry mode `off`). This module
 * renders a tier label only; it deliberately renders no price or allowance.
 */

export const MERCHANT_PLAN_LABEL = 'MERCHANT';

/**
 * Prefixes of historical `plan_name` / `plan_code` values. Matching is on the
 * lower-cased, trimmed value so `Growth`, `GROWTH`, `growth_monthly`, and
 * `Package 1` all collapse to the single current tier.
 */
const RETIRED_PLAN_PREFIXES = Object.freeze([
  'shuru',
  'growth',
  'partner',
  'starter',
  'free',
  'package',
]);

function isRetiredPlanValue(value: string): boolean {
  return RETIRED_PLAN_PREFIXES.some((prefix) => (
    value === prefix || value.startsWith(`${prefix}_`) || value.startsWith(`${prefix} `)
  ));
}

/**
 * Render any plan value returned by the Growth OS API as a display label.
 * Never returns a retired plan name and never returns a price.
 */
export function planLabel(value: string | null | undefined): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return 'No plan';
  const normalized = raw.toLowerCase();
  if (normalized === 'merchant' || isRetiredPlanValue(normalized)) {
    return MERCHANT_PLAN_LABEL;
  }
  return raw.replace(/_/g, ' ');
}