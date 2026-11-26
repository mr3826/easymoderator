/**
 * Business-Policies tab constants. The header-removal contract C3 deleted the
 * header-only `derivePoliciesSignal` (its sole consumer was the retired tab
 * PageHeader band); the stated-progress fact stays in the PoliciesTab body.
 */

/** The contract's four policy kinds (returns, exchange, refunds, warranty). */
export const POLICY_TOTAL = 4;
