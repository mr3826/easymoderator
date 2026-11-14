'use strict';

/**
 * Property test (UNIT lane, no DB): `computeInvoiceFromLines` is the single
 * derivation the monthly invoice is built from. A merchant must never be able
 * to observe a total that is not exactly the sum of delivered billable lines
 * minus pending credits, clamped at zero.
 *
 * The generator is deterministic: a fixed seed drives a small mulberry32 PRNG,
 * so a failure reproduces identically. 1000 random mixes cover delivered,
 * returned, cancelled and credit values, including order that must not matter.
 */

const billing = require('../delivered-order-billing.service');
const { COMMERCIAL_CONTRACT } = require('../commercial.contract');

// The pure derivation never touches a model; stub the registry so the unit
// lane provably opens no database connection.
jest.mock('../../entities', () => ({
    BillingLine: {},
    Order: {},
}));

const UNIT = COMMERCIAL_CONTRACT.unitPriceMinor; // 1000 poisha

/** mulberry32 — tiny deterministic PRNG. */
const mulberry32 = (seed) => {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6D2B79F5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
};

const SEED = 0x5EED_0001;
const ITERATIONS = 1000;

const intBetween = (rand, min, max) => min + Math.floor(rand() * (max - min + 1));

const buildMix = (rand, index) => {
    const delivered = intBetween(rand, 0, 20);
    const returned = intBetween(rand, 0, 10);
    const cancelled = intBetween(rand, 0, 10);
    // Credits are whole poisha, sometimes larger than the gross (must clamp).
    const credits = rand() < 0.15 ? UNIT * intBetween(rand, 0, 25) : intBetween(rand, 0, 5000);

    const lines = [];
    for (let i = 0; i < delivered; i += 1) {
        lines.push({
            orderId: `d-${index}-${i}`,
            line_kind: 'billable',
            outcome: 'DELIVERED',
            amount_minor: UNIT,
            occurred_at: '2026-10-05',
        });
    }
    for (let i = 0; i < returned; i += 1) {
        lines.push({
            orderId: `r-${index}-${i}`,
            line_kind: 'zero_rated',
            outcome: 'RETURNED',
            amount_minor: 0,
            occurred_at: '2026-10-06',
        });
    }
    for (let i = 0; i < cancelled; i += 1) {
        lines.push({
            orderId: `c-${index}-${i}`,
            line_kind: 'zero_rated',
            outcome: 'CANCELLED',
            amount_minor: 0,
            occurred_at: '2026-10-07',
        });
    }

    // Shuffle so the derivation cannot depend on insertion order.
    for (let i = lines.length - 1; i > 0; i -= 1) {
        const j = Math.floor(rand() * (i + 1));
        [lines[i], lines[j]] = [lines[j], lines[i]];
    }

    return { delivered, returned, cancelled, credits, lines };
};

describe('invoice aggregation property (deterministic seed)', () => {
    it('net is exactly max(0, delivered*unit - credits) for 1000 random mixes', () => {
        const rand = mulberry32(SEED);

        for (let index = 0; index < ITERATIONS; index += 1) {
            const mix = buildMix(rand, index);
            const result = billing.computeInvoiceFromLines(mix.lines, mix.credits);

            const expectedGross = mix.delivered * UNIT;
            const expectedCredit = Math.max(0, Math.trunc(mix.credits));
            const expected = {
                grossMinor: expectedGross,
                creditMinor: expectedCredit,
                netMinor: Math.max(0, expectedGross - expectedCredit),
                deliveredCount: mix.delivered,
                zeroRatedCount: mix.returned + mix.cancelled,
            };

            expect(result).toMatchObject(expected);
            // Every line stays on the invoice: returned/cancelled are explicit
            // BDT 0 rows, never omitted.
            expect(result.lines).toHaveLength(mix.delivered + mix.returned + mix.cancelled);
            for (const line of result.lines) {
                expect(Number.isInteger(line.amountMinor)).toBe(true);
                if (line.kind === 'billable') {
                    expect(line.amountMinor).toBe(UNIT);
                    expect(line.outcome).toBe('DELIVERED');
                } else {
                    expect(line.amountMinor).toBe(0);
                    expect(['RETURNED', 'CANCELLED']).toContain(line.outcome);
                }
            }
        }
    });

    it('is order-independent and does not mutate its input', () => {
        const rand = mulberry32(SEED ^ 0x1234);
        for (let index = 0; index < 100; index += 1) {
            const mix = buildMix(rand, index);
            const snapshot = JSON.stringify(mix.lines);
            const forward = billing.computeInvoiceFromLines(mix.lines, mix.credits);
            const reversed = billing.computeInvoiceFromLines([...mix.lines].reverse(), mix.credits);

            expect(reversed.grossMinor).toBe(forward.grossMinor);
            expect(reversed.netMinor).toBe(forward.netMinor);
            expect(reversed.deliveredCount).toBe(forward.deliveredCount);
            expect(reversed.zeroRatedCount).toBe(forward.zeroRatedCount);
            expect(JSON.stringify(mix.lines)).toBe(snapshot);
        }
    });

    it('clamps at zero and ignores negative credits', () => {
        const rand = mulberry32(SEED ^ 0xABCD);
        for (let index = 0; index < 100; index += 1) {
            const delivered = intBetween(rand, 0, 5);
            const lines = Array.from({ length: delivered }, (_, i) => ({
                orderId: `o-${index}-${i}`,
                line_kind: 'billable',
                outcome: 'DELIVERED',
                amount_minor: UNIT,
            }));
            const result = billing.computeInvoiceFromLines(lines, -intBetween(rand, 1, 10000));
            expect(result.creditMinor).toBe(0);
            expect(result.netMinor).toBe(delivered * UNIT);
        }
    });
});