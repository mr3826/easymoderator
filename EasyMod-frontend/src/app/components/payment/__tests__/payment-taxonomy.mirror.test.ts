/**
 * MIRROR INVARIANT — the frontend payment vocabulary (this dir's taxonomy.ts)
 * must equal the backend canonical enum source
 * (`EasyMod-backend/src/modules/payment/payment-taxonomy.js`) field-for-field.
 *
 * Why this test exists (contract §1.1): the original disease was THREE
 * disagreeing vocabularies (entity enum vs validator vs service aliasing),
 * which made a Nagad row storable-in-API-but-not-in-DB and erased the
 * merchant_gateway vs business distinction. FE arrays are projections of the
 * backend source, never second authorities — this pin fails the moment they
 * drift. Precedent: the "backend pins for mirror invariant" convention used
 * by the FAQ/delivery redesign waves; here the read direction is FE→BE because
 * the backend module is the authority.
 *
 * The backend module is dependency-free (zero `require`s — verified at
 * authoring), so it can be loaded directly with createRequire.
 */
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

import {
  PROVIDERS,
  ACCOUNT_TYPES,
  VERIFICATION_LEVELS,
  ADVANCE_POLICIES,
  WALLET_PROVIDERS,
  WALLET_ONLY_PROVIDERS,
  ADVANCE,
  channelsForProvider,
  maxLevelFor,
} from '../taxonomy';

const here = path.dirname(fileURLToPath(import.meta.url));
const BE_TAXONOMY_PATH = path.resolve(
  here,
  '../../../../../../EasyMod-backend/src/modules/payment/payment-taxonomy.js',
);
const BE = createRequire(import.meta.url)(BE_TAXONOMY_PATH) as {
  PROVIDERS: string[];
  ACCOUNT_TYPES: string[];
  VERIFICATION_LEVELS: string[];
  ADVANCE_POLICIES: string[];
  WALLET_ONLY_PROVIDERS: string[];
  PROVIDERS_WITH_WALLETS: string[];
  ADVANCE_PERCENTAGE_MIN: number;
  ADVANCE_PERCENTAGE_MAX: number;
  ADVANCE_FIXED_MIN: number;
  ADVANCE_FIXED_MAX: number;
  maxVerificationLevel: (provider: string, accountType: string) => string;
};

describe('payment taxonomy — FE mirror of the backend canonical source', () => {
  it('loads the backend module from the monorepo (fails loudly if moved)', () => {
    expect(fs.existsSync(BE_TAXONOMY_PATH)).toBe(true);
  });

  it('provider / account-type / ladder / advance-policy arrays are identical', () => {
    expect(PROVIDERS).toEqual(BE.PROVIDERS);
    expect(ACCOUNT_TYPES).toEqual(BE.ACCOUNT_TYPES);
    expect(VERIFICATION_LEVELS).toEqual(BE.VERIFICATION_LEVELS);
    expect(ADVANCE_POLICIES).toEqual(BE.ADVANCE_POLICIES);
    expect(WALLET_ONLY_PROVIDERS).toEqual(BE.WALLET_ONLY_PROVIDERS);
    expect(WALLET_PROVIDERS).toEqual(BE.PROVIDERS_WITH_WALLETS);
  });

  it('advance-policy client bounds mirror the server validator exactly (§5.2)', () => {
    expect(ADVANCE.percentageMin).toBe(BE.ADVANCE_PERCENTAGE_MIN);
    expect(ADVANCE.percentageMax).toBe(BE.ADVANCE_PERCENTAGE_MAX);
    expect(ADVANCE.fixedMin).toBe(BE.ADVANCE_FIXED_MIN);
    expect(ADVANCE.fixedMax).toBe(BE.ADVANCE_FIXED_MAX);
    // payment_message ≤ 500 lives in payment.validator.js, not the taxonomy —
    // pin it from source so a silent server-side change breaks here first.
    const validator = fs.readFileSync(
      path.resolve(BE_TAXONOMY_PATH, '../payment.validator.js'),
      'utf8',
    );
    expect(validator).toMatch(/payment_message: Joi\.string\(\)\.max\(500\)/);
    expect(ADVANCE.messageMax).toBe(500);
  });

  it('the (provider → channels) matrix matches §1.1 and stays inside the enum', () => {
    expect(channelsForProvider('cod')).toEqual(['standard']);
    expect(channelsForProvider('bkash')).toEqual(['self', 'business', 'merchant_gateway']);
    expect(channelsForProvider('nagad')).toEqual(['self', 'business']);
    expect(channelsForProvider('rocket')).toEqual(['self', 'business']);
    for (const p of PROVIDERS) {
      for (const c of channelsForProvider(p)) {
        expect(BE.ACCOUNT_TYPES).toContain(c);
      }
    }
  });

  it('maxLevelFor matches the backend maxVerificationLevel for EVERY pair (§2)', () => {
    for (const p of PROVIDERS) {
      for (const c of ACCOUNT_TYPES) {
        expect(maxLevelFor(p, c)).toBe(BE.maxVerificationLevel(p, c));
      }
    }
    // The ceiling facts themselves, spelled out (R-12 inert-by-default):
    expect(maxLevelFor('nagad', 'self')).toBe('configured_unverified');
    expect(maxLevelFor('rocket', 'business')).toBe('configured_unverified');
    expect(maxLevelFor('bkash', 'self')).toBe('configured_unverified');
    expect(maxLevelFor('bkash', 'merchant_gateway')).toBe('live_certified');
  });
});
