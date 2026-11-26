'use strict';

/**
 * A5 foundation — canonical payment vocabulary (contract §1.1, §2, §3, §6).
 * Single enum source + alias translation + ladder + automation predicate.
 */
const t = require('../payment-taxonomy');

describe('payment-taxonomy — canonical vocabulary', () => {
    test('providers / account types / ladder / statuses are frozen canonical sets', () => {
        expect(t.PROVIDERS).toEqual(['cod', 'bkash', 'nagad', 'rocket']);
        expect(t.ACCOUNT_TYPES).toContain('merchant_gateway');
        expect(t.ACCOUNT_TYPES).toContain('self');
        expect(t.ACCOUNT_TYPES).toContain('business');
        expect(t.VERIFICATION_LEVELS).toEqual([
            'unverified', 'configured_unverified', 'sandbox_verified', 'live_certified',
        ]);
        expect(t.PAYMENT_TRANSACTION_STATUSES).toContain(t.CLAIM_STATUS); // payment_claimed
        expect(t.CLAIM_STATUS).toBe('payment_claimed');
    });

    test('all three wallet providers are labeled (fixes the Rocket prompt gap, §1.1)', () => {
        for (const p of ['bkash', 'nagad', 'rocket']) {
            expect(t.PROVIDER_LABELS[p].en).toBeTruthy();
            expect(t.PROVIDER_LABELS[p].bn).toBeTruthy();
        }
    });

    test('legacy alias + case-insensitive normalization; self-mfs is ambiguous (not bkash)', () => {
        expect(t.normalizeProvider('bKash')).toBe('bkash');
        expect(t.normalizeProvider('Cash on Delivery')).toBeNull(); // spaced, not exact alias
        expect(t.normalizeProvider('cash_on_delivery')).toBe('cod');
        expect(t.normalizeProvider('rocket')).toBe('rocket');
        // 'self-mfs' is a GATEWAY label, not a provider → null, resolved from creds (§1.2)
        expect(t.normalizeProvider('self-mfs')).toBeNull();
        expect(t.normalizeProvider('nonsense')).toBeNull();
    });

    test('account_type normalization + legacy personal/merchant alias (§1.1)', () => {
        expect(t.normalizeAccountType('personal', 'bkash')).toBe('self');
        expect(t.normalizeAccountType('merchant', 'bkash')).toBe('business'); // upgraded by creds later
        expect(t.normalizeAccountType('anything', 'cod')).toBe('standard'); // cod forced
    });

    test('legacy gateway dual-write value (§1.4): cod→cod, wallet→self-mfs', () => {
        expect(t.legacyGatewayFor('cod')).toBe('cod');
        expect(t.legacyGatewayFor('bkash')).toBe('self-mfs');
        expect(t.legacyGatewayFor('nagad')).toBe('self-mfs');
        expect(t.legacyGatewayFor('rocket')).toBe('self-mfs');
        expect(t.legacyGatewayFor('self-mfs')).toBeNull(); // ambiguous input rejected
    });

    test('self-mfs credential recovery distinguishes merchant_gateway from a business wallet (§1.3-2)', () => {
        const gateway = { app_key: 'k', app_secret: 's', username: 'u', mfs_mode: 'merchant' };
        expect(t.accountTypeFromCredentials(gateway, 'bkash')).toBe('merchant_gateway');
        const business = { mfs_mode: 'merchant', mfs_number: '01700000000' }; // no gateway creds
        expect(t.accountTypeFromCredentials(business, 'bkash')).toBe('business');
        const self = { mfs_mode: 'self', mfs_number: '01700000000' };
        expect(t.accountTypeFromCredentials(self, 'bkash')).toBe('self');
        // provider never assumed to be bkash for a self-mfs row
        expect(t.providerFromCredentials({ mfs_type: 'nagad' }, null)).toBe('nagad');
        expect(t.providerFromCredentials({}, null)).toBeNull();
    });

    test('ladder ceilings: nagad/rocket + self/business top out at configured_unverified (§2)', () => {
        expect(t.maxVerificationLevel('nagad', 'self')).toBe('configured_unverified');
        expect(t.maxVerificationLevel('rocket', 'business')).toBe('configured_unverified');
        expect(t.maxVerificationLevel('bkash', 'self')).toBe('configured_unverified');
        expect(t.maxVerificationLevel('bkash', 'merchant_gateway')).toBe('live_certified');
        expect(t.canReachLevel('nagad', 'self', 'live_certified')).toBe(false);
        expect(t.canReachLevel('bkash', 'merchant_gateway', 'sandbox_verified')).toBe(true);
    });

    test('isAutomatable is INERT without the flag / live_certified / creds (R-12, §2.3)', () => {
        const acct = {
            is_enabled: true, provider: 'bkash', account_type: 'merchant_gateway',
            verification_level: 'live_certified',
            credentials: { app_key: 'k', app_secret: 's', username: 'u' },
        };
        // no live credentials + flag false by default in this env → false everywhere
        expect(t.isAutomatable(acct, { bKashEnabled: 'false' })).toBe(false);
        expect(t.isAutomatable(acct, { bKashEnabled: 'true' })).toBe(true); // ONLY with flag on + live_certified + creds
        expect(t.isAutomatable({ ...acct, verification_level: 'sandbox_verified' }, { bKashEnabled: 'true' })).toBe(false);
        expect(t.isAutomatable({ ...acct, account_type: 'self' }, { bKashEnabled: 'true' })).toBe(false);
        expect(t.isAutomatable(null)).toBe(false);
    });

    test('status canonicalization removes the Completed/COMPLETED mismatch class (§4.1)', () => {
        expect(t.canonicalStatus('Completed')).toBe('paid');
        expect(t.canonicalStatus('COMPLETED')).toBe('paid');
        expect(t.canonicalStatus('completed')).toBe('paid');
        expect(t.isSettledStatus('Completed')).toBe(true);
        expect(t.isSettledStatus('COMPLETED')).toBe(true);
        expect(t.isSettledStatus('Pending')).toBe(false);
        expect(t.canonicalStatus('payment_claimed')).toBe('payment_claimed');
    });

    test('providerLabelSafe never crashes on undefined (§3.3 null-safety)', () => {
        expect(t.providerLabelSafe(undefined)).toBe('Manual payment');
        expect(t.providerLabelSafe('bkash', 'en')).toBe('bKash');
    });
});
