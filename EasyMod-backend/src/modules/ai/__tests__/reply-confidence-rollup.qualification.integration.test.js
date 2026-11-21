'use strict';

/**
 * WP-03 — reply-confidence-rollup extended observation aggregates against a
 * REAL disposable PostgreSQL (integration suite: tests/integration/env.js +
 * the disposable-database name guard; CI provisions the services).
 *
 * Seeds the same storage the worker uses — conversation_turns as the durable
 * spine plus messages.metadata confidence_* shadow keys (migration
 * 20260823_001 surface; no observation table) — across multiple conversations
 * and TWO real shops, then pins:
 *   - conversations / firstEligibleObservedAt / scored / unscored /
 *     eligible / ineligible over eligible SCORED rows only;
 *   - the shadow selection rules the LATERAL already enforced (DRAFT_APPROVAL
 *     exclusion, scope↔delivery-state coherence, turn identity);
 *   - tenant isolation, including an adversarial cross-shop turn row;
 *   - window exclusion at 24h vs 168h and the 5000-cap/truncated semantics.
 *
 * The READ ONLY transaction and 2s statement timeout are pinned by
 * admin-confidence-rollup.readonly.test.js, which executes the REAL service
 * against a spy sequelize — this file adds no write attempt because a real
 * write here would be indistinguishable from the harness's own seeding.
 */

const { randomUUID } = require('crypto');

const {
    syncSchema,
    truncateAll,
} = require('../../../../tests/meta-e2e/fixtures');
const { sequelize } = require('../../../utils/database/database-setup');
const { getReplyConfidenceRollup } = require('../reply-confidence-rollup.service');

const HOUR = 60 * 60 * 1000;
const BASE = Date.now();
const ago = (hours) => new Date(BASE - hours * HOUR);

const ids = {
    tenant: randomUUID(),
    shopA: randomUUID(),
    shopB: randomUUID(),
    shopCap: randomUUID(),
};

const q = (sql, replacements = {}) => sequelize.query(sql, { replacements });

const insertShop = (id, code) => q(
    `INSERT INTO public.shops (id, unique_code, tenant_id, shop_name, name, is_active, ai_emergency_stop)
     VALUES (:id, :code, :tenant, :code, :code, true, false)`,
    { id, code, tenant: ids.tenant },
);

async function insertConversation(shopId, conversationId) {
    const customerId = randomUUID();
    await q(
        `INSERT INTO public.customers (id, shop_id, name, channel_type, channel_user_id)
         VALUES (:id, :shop, 'rollup fixture customer', 'messenger', :psid)`,
        { id: customerId, shop: shopId, psid: `rollup-${customerId.slice(0, 8)}` },
    );
    await q(
        `INSERT INTO public.conversations
            (id, shop_id, customer_id, channel, role, message, status, metadata)
         VALUES (:id, :shop, :customer, 'messenger', 'user', 'rollup fixture', 'active', '{}')`,
        { id: conversationId, shop: shopId, customer: customerId },
    );
}

async function insertTurn(shopId, conversationId, turnId, createdAt) {
    await q(
        `INSERT INTO public.conversation_turns (id, turn_id, trace_id, shop_id, conversation_id, created_at)
         VALUES (:id, :turnId, :traceId, :shop, :conversation, :createdAt)`,
        { id: randomUUID(), turnId, traceId: `trace-${turnId}`, shop: shopId, conversation: conversationId, createdAt },
    );
}

/**
 * Seed one shadow AI message matching a turn under the exact metadata keys
 * the worker writes (message-worker.js confidence_* block).
 */
async function insertShadowMessage({ conversationId, turnId, scope, score, deliveryState, deliverySource, createdAt }) {
    const metadata = {
        confidence_turn_id: turnId,
        confidence_mode: 'shadow',
        confidence_scope: scope,
        confidence_would_hold: false,
    };
    if (score !== null && score !== undefined) metadata.confidence_score = score;
    await q(
        `INSERT INTO public.messages
            (id, conversation_id, content, sender, external_id, metadata, delivery_state, delivery_source, created_at)
         VALUES (:id, :conversation, 'shadow reply', 'ai', :externalId, :metadata, :deliveryState, :deliverySource, :createdAt)`,
        {
            id: randomUUID(),
            conversation: conversationId,
            externalId: `rollup-${randomUUID()}`,
            metadata: JSON.stringify(metadata),
            deliveryState,
            deliverySource,
            createdAt,
        },
    );
}

describe('reply-confidence-rollup observation aggregates on PostgreSQL', () => {
    beforeAll(async () => {
        await syncSchema();
        await q(`INSERT INTO public.tenants (id, name) VALUES (:id, 'wp03-rollup-tenant')`, { id: ids.tenant });
        await Promise.all([insertShop(ids.shopA, 'WP03A'), insertShop(ids.shopB, 'WP03B'), insertShop(ids.shopCap, 'WP03CAP')]);

        // ── Shop A — the scenario surface ────────────────────────────────────
        const a1 = randomUUID(); const a2 = randomUUID(); const a3 = randomUUID();
        const a4 = randomUUID(); const a5 = randomUUID(); const a6 = randomUUID();
        const aOut = randomUUID(); const aCross = randomUUID();
        for (const conv of [a1, a2, a3, a4, a5, a6, aOut, aCross]) {
            // aCross is shop B's conversation, used adversarially below.
            await insertConversation(conv === aCross ? ids.shopB : ids.shopA, conv);
        }

        // Eligible scored DELIVERED rows (confirmed delivery), two conversations.
        await insertTurn(ids.shopA, a1, 'a1-t1', ago(100));
        await insertShadowMessage({ conversationId: a1, turnId: 'a1-t1', scope: 'delivered', score: 0.9, deliveryState: 'SENT', deliverySource: 'AI_AUTO', createdAt: ago(100) });
        await insertTurn(ids.shopA, a1, 'a1-t2', ago(10));
        await insertShadowMessage({ conversationId: a1, turnId: 'a1-t2', scope: 'delivered', score: 0.8, deliveryState: 'DELIVERED', deliverySource: 'AI_AUTO', createdAt: ago(10) });
        await insertTurn(ids.shopA, a2, 'a2-t1', ago(50));
        await insertShadowMessage({ conversationId: a2, turnId: 'a2-t1', scope: 'suggestion', score: 0.6, deliveryState: 'HELD', deliverySource: 'AI_AUTO', createdAt: ago(50) });

        // Human-handled turn: no AI message → missing.
        await insertTurn(ids.shopA, a3, 'a3-t1', ago(20));

        // In scope but UNSCORED: eligible scope, no confidence_score → ineligible.
        await insertTurn(ids.shopA, a4, 'a4-t1', ago(30));
        await insertShadowMessage({ conversationId: a4, turnId: 'a4-t1', scope: 'suggestion', score: null, deliveryState: 'HELD', deliverySource: 'AI_AUTO', createdAt: ago(30) });

        // DRAFT_APPROVAL shadow rows are excluded by the LATERAL → missing.
        await insertTurn(ids.shopA, a5, 'a5-t1', ago(40));
        await insertShadowMessage({ conversationId: a5, turnId: 'a5-t1', scope: 'suggestion', score: 0.95, deliveryState: 'HELD', deliverySource: 'DRAFT_APPROVAL', createdAt: ago(40) });

        // Scope/state incoherence ('delivered' claim, HELD state) → missing.
        await insertTurn(ids.shopA, a6, 'a6-t1', ago(60));
        await insertShadowMessage({ conversationId: a6, turnId: 'a6-t1', scope: 'delivered', score: 0.99, deliveryState: 'HELD', deliverySource: 'AI_AUTO', createdAt: ago(60) });

        // Older than any legal window → excluded at 168h.
        await insertTurn(ids.shopA, aOut, 'a7-t1', ago(200));
        await insertShadowMessage({ conversationId: aOut, turnId: 'a7-t1', scope: 'delivered', score: 0.7, deliveryState: 'SENT', deliverySource: 'AI_AUTO', createdAt: ago(200) });

        // ADVERSARIAL: a turn naming shop A but a conversation owned by shop B.
        // The c.shop_id = t.shop_id join must drop it from every shop's view.
        await q(
            `INSERT INTO public.conversation_turns (id, turn_id, trace_id, shop_id, conversation_id, created_at)
             VALUES (:id, 'cross-t1', 'trace-cross-t1', :shop, :conversation, :createdAt)`,
            { id: randomUUID(), shop: ids.shopA, conversation: aCross, createdAt: ago(5) },
        );

        // ── Shop B — a real non-empty neighbor (isolation must be proven
        // against data, not against emptiness) ───────────────────────────────
        const b1 = randomUUID();
        await insertConversation(ids.shopB, b1);
        for (const [turnId, hours] of [['b1-t1', 5], ['b1-t2', 90], ['b1-t3', 91], ['b1-t4', 92]]) {
            await insertTurn(ids.shopB, b1, turnId, ago(hours));
            // eslint-disable-next-line no-await-in-loop
            await insertShadowMessage({ conversationId: b1, turnId, scope: 'delivered', score: 0.85, deliveryState: 'SENT', deliverySource: 'AI_AUTO', createdAt: ago(hours) });
        }

        // ── Shop Cap — 5001 in-window human-handled turns via generate_series
        // to pin the 5000-row slice and the truncated flag ──────────────────
        const capConv = randomUUID();
        await insertConversation(ids.shopCap, capConv);
        await q(
            `INSERT INTO public.conversation_turns (id, turn_id, trace_id, shop_id, conversation_id, created_at)
             SELECT gen_random_uuid(), 'cap-' || g, 'trace-cap-' || g, :shop, :conversation,
                    NOW() - (g || ' minutes')::interval
             FROM generate_series(1, 5001) AS g`,
            { shop: ids.shopCap, conversation: capConv },
        );
    }, 180000);

    afterAll(async () => {
        await truncateAll();
        await sequelize.close();
    });

    test('168h window: observation aggregates over eligible scored rows only', async () => {
        const report = await getReplyConfidenceRollup(ids.shopA, 168);

        // 7 durable turns in window (the 200h turn and the cross-shop
        // conversation's turn are excluded) — the cross-shop row must not add
        // an eighth.
        expect(report).toMatchObject({
            hours: 168, turns: 7, truncated: false,
            delivered: 2, suggestion: 2, missing: 3, unscored: 1,
            scoreBuckets: { belowHalf: 0, halfToBelowThreeQuarters: 1, threeQuartersOrAbove: 2 },
        });
        expect(report).toMatchObject({
            scored: 3, eligible: 3, ineligible: 4, conversations: 2,
        });
        // The clock starts at the earliest ELIGIBLE SCORED observation —
        // the 100h delivered row, not the 200h one and not the unscored row.
        expect(report.firstEligibleObservedAt).toBe(ago(100).toISOString());
        // Existing counter semantics unchanged: eligible + ineligible = turns in window.
        expect(report.eligible + report.ineligible).toBe(report.turns);
    });

    test('24h window: same aggregates computed only over the fresher slice', async () => {
        const report = await getReplyConfidenceRollup(ids.shopA, 24);
        expect(report).toMatchObject({
            // In the fresher slice only: a1-t2 (delivered, eligible) and a3-t1
            // (human-handled). a4/a5/a6 are older than 24h and the adversarial
            // cross-shop turn is dropped by the shop-coherent join.
            hours: 24, turns: 2, truncated: false,
            delivered: 1, missing: 1, suggestion: 0,
            scored: 1, eligible: 1, ineligible: 1,
            conversations: 1,
        });
        expect(report.firstEligibleObservedAt).toBe(ago(10).toISOString());
    });

    test('tenant isolation: shop B reads only its own aggregates despite non-empty neighbours', async () => {
        const reportB = await getReplyConfidenceRollup(ids.shopB, 168);
        // 4 eligible delivered turns. The adversarial turn (shop A named on a
        // conversation owned by B) is invisible to B too: the spine filters
        // t.shop_id = $shopId and the join re-checks c.shop_id = t.shop_id.
        expect(reportB).toMatchObject({
            turns: 4,
            delivered: 4, missing: 0,
            scored: 4, eligible: 4, ineligible: 0, conversations: 1,
        });
        expect(reportB.firstEligibleObservedAt).toBe(ago(92).toISOString());

        const reportA = await getReplyConfidenceRollup(ids.shopA, 168);
        expect(reportA.turns).toBe(7);
        expect(reportA.conversations).toBe(2);
    });

    test('5000-row cap: aggregates stay inside the slice and truncated flags the overflow', async () => {
        const report = await getReplyConfidenceRollup(ids.shopCap, 168);
        expect(report).toMatchObject({
            turns: 5000, truncated: true,
            missing: 5000, scored: 0, unscored: 0, eligible: 0, ineligible: 5000,
            conversations: 0, firstEligibleObservedAt: null,
        });
    });

    test('input validation still guards the widened query (no scan without a bounded window)', async () => {
        await expect(getReplyConfidenceRollup(ids.shopA, 200)).rejects.toThrow(TypeError);
        await expect(getReplyConfidenceRollup(ids.shopA, 0)).rejects.toThrow(TypeError);
        await expect(getReplyConfidenceRollup('not-a-uuid', 168)).rejects.toThrow(TypeError);
    });
});
