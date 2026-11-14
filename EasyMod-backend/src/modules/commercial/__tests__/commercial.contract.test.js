'use strict';

/**
 * UNIT lane — no DB, no network. Guards the commercial contract's terms, its
 * formatters, its public payload, and the forbidden-token scanner contract.
 *
 * The regression guard matters most: the NEW price (৳10 / ৳১০) must never be
 * caught by a token that exists only to retire the old subscription/band
 * prices. If it is, honest copy fails the build and the temptation is to widen
 * the exclusion until the scanner checks nothing.
 */

const {
    COMMERCIAL_CONTRACT,
    COMMERCIAL_CONTRACT_VERSION,
    FORBIDDEN_TOKENS,
    contractHash,
    formatBdt,
    formatBdtBn,
    publicContractPayload,
} = require('../commercial.contract');
const { registryHash } = require('../claim.registry');
const snapshot = require('../__snapshots__/commercial.snapshot.json');

const tokenMatches = (token, text) => {
    const flags = token.flags.includes('g') ? token.flags : `${token.flags}g`;
    const pattern = new RegExp(token.source, flags);
    const exclusions = (token.excludeSources || [])
        .map((source) => new RegExp(source, token.excludeFlags || 'gi'));
    const matches = [];
    let match = pattern.exec(text);
    while (match !== null) {
        // Exclusions are checked against the matched text plus a small
        // right-context window, so "Growth OS" is excluded where bare
        // "Growth" a sentence later is still caught.
        const windowText = text.slice(Math.max(0, match.index - 2), match.index + match[0].length + 8);
        if (!exclusions.some((exclusion) => exclusion.test(windowText))) {
            matches.push(match[0]);
        }
        match = pattern.exec(text);
    }
    return matches;
};

const forbiddenHits = (text) => FORBIDDEN_TOKENS
    .map((token) => ({ id: token.id, matches: tokenMatches(token, text) }))
    .filter((hit) => hit.matches.length > 0);

describe('commercial contract — version and hashes', () => {
    test('contractHash matches the snapshot (drift fails the build)', () => {
        expect(contractHash).toBe(snapshot.contractHash);
        expect(contractHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    });

    test('registryHash matches the snapshot', () => {
        expect(registryHash).toBe(snapshot.registryHash);
    });

    test('contract version matches the snapshot', () => {
        expect(COMMERCIAL_CONTRACT_VERSION).toBe(snapshot.contractVersion);
        expect(COMMERCIAL_CONTRACT.contractVersion).toBe(COMMERCIAL_CONTRACT_VERSION);
    });

    test('the contract is deeply frozen', () => {
        expect(Object.isFrozen(COMMERCIAL_CONTRACT)).toBe(true);
        expect(Object.isFrozen(COMMERCIAL_CONTRACT.onOverdue)).toBe(true);
        expect(Object.isFrozen(COMMERCIAL_CONTRACT.zeroRatedOutcomes)).toBe(true);
    });
});

describe('commercial contract — terms', () => {
    test('flat BDT 10 per delivered order in integer poisha', () => {
        expect(COMMERCIAL_CONTRACT.model).toBe('DELIVERED_ORDER');
        expect(COMMERCIAL_CONTRACT.currency).toBe('BDT');
        expect(COMMERCIAL_CONTRACT.unitPriceMinor).toBe(1000);
        expect(COMMERCIAL_CONTRACT.unitPriceMinor / 100).toBe(10);
    });

    test('no subscription, setup or monthly-minimum fee', () => {
        expect(COMMERCIAL_CONTRACT.subscriptionFeeMinor).toBe(0);
        expect(COMMERCIAL_CONTRACT.setupFeeMinor).toBe(0);
        expect(COMMERCIAL_CONTRACT.monthlyMinimumMinor).toBe(0);
        expect(COMMERCIAL_CONTRACT.conversationEntitlement).toBeNull();
    });

    test('postpaid monthly with a 7-day due window', () => {
        expect(COMMERCIAL_CONTRACT.cycle).toBe('MONTHLY');
        expect(COMMERCIAL_CONTRACT.payment).toBe('POSTPAID');
        expect(COMMERCIAL_CONTRACT.dueDays).toBe(7);
    });

    test('returned and cancelled outcomes are zero-rated', () => {
        expect(COMMERCIAL_CONTRACT.zeroRatedOutcomes).toEqual(
            expect.arrayContaining(['RETURNED', 'CANCELLED']),
        );
    });

    test('overdue never deletes data and keeps inbox/history readable', () => {
        expect(COMMERCIAL_CONTRACT.onOverdue).toEqual({
            blockCourierBooking: true,
            pauseAutomatedAi: true,
            keepInboxReadable: true,
            keepHistoryReadable: true,
            deleteData: false,
        });
    });
});

describe('commercial contract — public payload', () => {
    const payload = publicContractPayload();

    test('is snake_case with the canonical price and version fields', () => {
        expect(payload.contract_version).toBe(COMMERCIAL_CONTRACT_VERSION);
        expect(payload.contract_hash).toBe(contractHash);
        expect(payload.unit_price_minor).toBe(1000);
        expect(payload.unit_price_bdt).toBe(10);
        expect(payload.due_days).toBe(7);
        expect(payload.conversation_entitlement).toBeNull();
        expect(payload.subscription_fee_bdt).toBe(0);
        expect(payload.setup_fee_bdt).toBe(0);
        expect(payload.monthly_minimum_bdt).toBe(0);
        expect(payload.on_overdue).toEqual(COMMERCIAL_CONTRACT.onOverdue);
        expect(payload.on_overdue.deleteData).toBe(false);
        expect(Array.isArray(payload.zero_rated_outcomes)).toBe(true);
        expect(payload.description.en).toContain('৳10.00');
        expect(payload.description.bn).toContain('৳১০.০০');
    });

    test('the snapshot public contract is the same payload', () => {
        expect(snapshot.publicContract).toEqual(JSON.parse(JSON.stringify(payload)));
    });
});

describe('commercial contract — formatters', () => {
    test('formatBdt renders whole BDT with two decimals', () => {
        expect(formatBdt(1000)).toBe('৳10.00');
        expect(formatBdt(0)).toBe('৳0.00');
        expect(formatBdt(1050)).toBe('৳10.50');
    });

    test('formatBdtBn renders Bengali numerals', () => {
        expect(formatBdtBn(1000)).toBe('৳১০.০০');
        expect(formatBdtBn(0)).toBe('৳০.০০');
    });

    test('formatBdt rejects non-finite input', () => {
        expect(() => formatBdt(Number.NaN)).toThrow(TypeError);
        expect(() => formatBdt('not-money')).toThrow(TypeError);
    });
});

describe('forbidden tokens — scanner contract', () => {
    test('every token compiles and ids are unique', () => {
        const ids = FORBIDDEN_TOKENS.map((token) => token.id);
        expect(new Set(ids).size).toBe(ids.length);
        expect(ids).toEqual(snapshot.forbiddenTokenIds);
        expect(ids).toHaveLength(24);
        for (const token of FORBIDDEN_TOKENS) {
            expect(() => new RegExp(token.source, token.flags)).not.toThrow();
            for (const exclusion of token.excludeSources || []) {
                expect(() => new RegExp(exclusion, token.excludeFlags || 'gi')).not.toThrow();
            }
        }
    });

    test('the NEW price is not matched by any forbidden token', () => {
        const honestCopy = [
            '৳10.00 per delivered order',
            '৳১০.০০ প্রতি ডেলিভারি করা অর্ডার',
            'BDT 10 per delivered order',
            'BDT 10 / order',
            '10 poisha? no — 1000 poisha per delivered order',
            'unit_price_minor: 1000',
        ];
        for (const text of honestCopy) {
            expect({ text, hits: forbiddenHits(text) }).toEqual({ text, hits: [] });
        }
    });

    test('retired subscription prices are matched', () => {
        expect(forbiddenHits('৳999 per month').map((hit) => hit.id))
            .toEqual(expect.arrayContaining(['price.bdt999']));
        expect(forbiddenHits('BDT 999/month').map((hit) => hit.id))
            .toEqual(expect.arrayContaining(['price.999_per_month', 'price.any_per_month']));
        expect(forbiddenHits('৳৯৯৯').map((hit) => hit.id))
            .toEqual(expect.arrayContaining(['price.bn999']));
        expect(forbiddenHits('GROWTH yearly 9990').map((hit) => hit.id))
            .toEqual(expect.arrayContaining(['price.yearly9990']));
    });

    test('retired Partner band rates are matched', () => {
        expect(forbiddenHits('৳১৫ per order').map((hit) => hit.id))
            .toEqual(expect.arrayContaining(['band.retired_rate_15']));
        expect(forbiddenHits('৳১২ per order').map((hit) => hit.id))
            .toEqual(expect.arrayContaining(['band.retired_rate_12']));
        expect(forbiddenHits('300–999 delivered orders').map((hit) => hit.id))
            .toEqual(expect.arrayContaining(['band.range_300_999']));
        expect(forbiddenHits('300+ delivered orders').map((hit) => hit.id))
            .toEqual(expect.arrayContaining(['band.qualification']));
    });

    test('retired conversation entitlements are matched', () => {
        expect(forbiddenHits('100 conversations per month').map((hit) => hit.id))
            .toEqual(expect.arrayContaining(['entitlement.conv100']));
        expect(forbiddenHits('৫০০টি কথোপকথন').map((hit) => hit.id))
            .toEqual(expect.arrayContaining(['entitlement.bn_conv']));
        expect(forbiddenHits('top-up pack PACK_100').map((hit) => hit.id))
            .toEqual(expect.arrayContaining(['entitlement.topup_pack']));
    });

    test('Growth OS and the GROWTH_USER role are excluded from name.growth', () => {
        expect(forbiddenHits('Growth OS dashboards')).toEqual([]);
        expect(forbiddenHits('GROWTH_USER role')).toEqual([]);
        expect(forbiddenHits('growth-os surface')).toEqual([]);
        // Positive control: the retired display name alone is still caught.
        expect(forbiddenHits('Growth plan').map((hit) => hit.id)).toEqual(['name.growth']);
    });

    test('retired public names are matched', () => {
        expect(forbiddenHits('Get Your Moderator').map((hit) => hit.id))
            .toEqual(expect.arrayContaining(['name.get_your_moderator']));
        expect(forbiddenHits('Moderator Plus').map((hit) => hit.id))
            .toEqual(expect.arrayContaining(['name.moderator_plus']));
        expect(forbiddenHits('Partnership plan').map((hit) => hit.id))
            .toEqual(expect.arrayContaining(['name.partnership']));
    });
});