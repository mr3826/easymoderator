export const GROWTH_UPGRADE_INTENT = "growth-upgrade" as const;

/**
 * Acquisition attribution carried by marketing CTAs
 * (`/signup?source=landing_zero&offer=delivered_10`). Only bounded, URL-safe
 * slugs are accepted so arbitrary query input can never reach analytics or the
 * signup payload; anything else is dropped.
 */
const ATTRIBUTION_SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export interface SignupAttribution {
  source?: string;
  offer?: string;
}

export function getSignupAttribution(params: URLSearchParams): SignupAttribution {
  const attribution: SignupAttribution = {};
  for (const key of ["source", "offer"] as const) {
    const value = params.get(key);
    if (value && ATTRIBUTION_SLUG.test(value)) attribution[key] = value;
  }
  return attribution;
}

export function isGrowthUpgradeIntent(params: URLSearchParams): boolean {
  const intents = params.getAll("intent");
  return intents.length === 1 && intents[0] === GROWTH_UPGRADE_INTENT;
}

/**
 * Signup accepts only one fixed continuation. Arbitrary return URLs and
 * unknown/duplicate intent values always return to the merchant dashboard.
 */
export function getSignupSuccessPath(params: URLSearchParams, fallbackLocale: string): string {
  if (!isGrowthUpgradeIntent(params)) return "/dashboard";

  const requestedLocale = params.get("lang");
  const locale = requestedLocale === "bn" || requestedLocale === "en"
    ? requestedLocale
    : fallbackLocale === "bn" ? "bn" : "en";

  return `/subscription?intent=${GROWTH_UPGRADE_INTENT}&lang=${locale}`;
}
