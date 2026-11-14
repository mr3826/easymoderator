/**
 * Public subscription catalog — RETIRED (ADR-0011).
 *
 * `GET /api/subscription/plans` now answers `410 CATALOG_RETIRED`: there is no
 * subscription, no per-plan price and no prepaid credit product. Commercial
 * truth is the single delivered-order contract, consumed through
 * `@/api/domains/commercialContract` (re-exported here for the legacy import
 * path).
 *
 * These functions are tombstones: they fail closed instead of returning any
 * substituted or pinned price list.
 */

export const SUBSCRIPTION_CATALOG_RETIRED = "SUBSCRIPTION_CATALOG_RETIRED";

export class SubscriptionCatalogRetiredError extends Error {
  readonly code = SUBSCRIPTION_CATALOG_RETIRED;

  constructor() {
    super(
      "The subscription plan catalog was retired by ADR-0011. "
        + "Read the delivered-order commercial contract instead.",
    );
    this.name = "SubscriptionCatalogRetiredError";
  }
}

/** Legacy shape kept only so callers compile during migration. */
export interface PublicSubscriptionCatalog<TPlan = unknown> {
  readonly plans: readonly TPlan[];
  readonly source: "retired";
}

/** @deprecated The public catalog is retired; there is no plan allowlist. */
export function hasRequiredPublicPlans(_plans?: readonly unknown[]): false {
  void _plans;
  return false;
}

/** @deprecated Retired with the subscription model (ADR-0011). */
export async function getCurrentPublicSubscriptionCatalog<TPlan = unknown>(): Promise<
  PublicSubscriptionCatalog<TPlan>
> {
  throw new SubscriptionCatalogRetiredError();
}

/** @deprecated Retired with the subscription model (ADR-0011). */
export async function getPublicSubscriptionCatalog<TPlan = unknown>(): Promise<
  PublicSubscriptionCatalog<TPlan>
> {
  throw new SubscriptionCatalogRetiredError();
}

export {
  getPublicCommercialContract,
  useCommercialContract,
  useClaimDecisions,
} from "./commercialContract";