'use strict';

/**
 * Seed the isolated Operational Gate Closure V1 browser rehearsal.
 *
 * This is idempotent for its named synthetic fixtures. It refuses every database except the
 * explicitly named local e2e database, and requires a second confirmation
 * token before writing rows. It creates no Meta channel, sends no message and
 * makes no provider request.
 *
 * Required environment:
 *   DATABASE_URL=postgres://...@postgres:5432/easymod_ops_gate_e2e
 *   OPS_E2E_PASSWORD=<local synthetic account password>
 *   OPS_E2E_SEED_CONFIRM=SEED_LOCAL_OPS_E2E_ONLY
 */

const { assertDisposableDatabase } = require('../../tests/helpers/disposable-database');

const EXPECTED_DATABASE = 'easymod_ops_gate_e2e';
const ALLOWED_DB_HOSTS = new Set(['postgres', '127.0.0.1', 'localhost']);
const TENANT_NAME = 'Operational Gate Closure E2E Tenant';
const SHOP_A_CODE = 'OGCE2E-A';
const SHOP_B_CODE = 'OGCE2E-B';
const EMAIL_A = 'closure.a.owner@ops.easymod.test';
const EMAIL_B = 'closure.b.owner@ops.easymod.test';
const SEED_TAG = 'operational-gate-closure-v1-e2e';

function assertSeedTarget() {
    if (process.env.OPS_E2E_SEED_CONFIRM !== 'SEED_LOCAL_OPS_E2E_ONLY') {
        throw new Error('Refusing to seed without OPS_E2E_SEED_CONFIRM=SEED_LOCAL_OPS_E2E_ONLY');
    }
    if (!process.env.OPS_E2E_PASSWORD || process.env.OPS_E2E_PASSWORD.length < 14) {
        throw new Error('OPS_E2E_PASSWORD must be set to a synthetic password of at least 14 characters');
    }
    assertDisposableDatabase(process.env.DATABASE_URL, 'Operational Gate Closure E2E seed');
    const target = new URL(process.env.DATABASE_URL);
    const database = target.pathname.replace(/^\//, '');
    if (database !== EXPECTED_DATABASE || !ALLOWED_DB_HOSTS.has(target.hostname)) {
        throw new Error(`Refusing to seed unexpected target ${target.hostname}/${database}`);
    }
}

async function main() {
    assertSeedTarget();

    const { sequelize } = require('../../src/utils/database/database-setup');
    const E = require('../../src/modules/entities');
    const { hashPassword } = require('../../src/utils/password.util');

    await sequelize.authenticate();
    const now = new Date();
    const passwordHash = await hashPassword(process.env.OPS_E2E_PASSWORD);

    const [tenant] = await E.Tenant.findOrCreate({
        where: { name: TENANT_NAME },
        defaults: { name: TENANT_NAME, is_active: true, settings: {} },
    });
    await tenant.update({ is_active: true });

    async function ensureShop(code, name) {
        const [shop] = await E.Shop.findOrCreate({
            where: { unique_code: code },
            defaults: {
                unique_code: code,
                tenant_id: tenant.id,
                shop_name: name,
                name,
                is_active: true,
                timezone: 'Asia/Dhaka',
                settings: { ai: { reply_mode: code === SHOP_A_CODE ? 'DRAFT' : 'MANUAL' } },
            },
        });
        await shop.update({
            tenant_id: tenant.id,
            shop_name: name,
            name,
            is_active: true,
            settings: { ...(shop.settings || {}), ai: { reply_mode: code === SHOP_A_CODE ? 'DRAFT' : 'MANUAL' } },
        });
        await E.Subscription.findOrCreate({
            where: { shop_id: shop.id },
            defaults: {
                shop_id: shop.id,
                plan_name: 'MERCHANT',
                plan_code: 'MERCHANT',
                plan_price: 0,
                billing_cycle: 'monthly',
                status: 'active',
                conversations_limit: 500,
                orders_limit: 200,
                products_limit: 500,
                conversations_used: 0,
                current_period_start: now,
                current_period_end: new Date(now.getTime() + 30 * 86400_000),
                next_billing_date: new Date(now.getTime() + 30 * 86400_000),
                features: { ai_replies: true, advanced_ai: true, order_management: true, delivery_tracking: true },
            },
        });
        const [pilotFeatures] = await E.ShopPilotFeatures.findOrCreate({
            where: { shop_id: shop.id },
            defaults: {
                shop_id: shop.id,
                customer_intelligence: false,
                order_confidence_mode: 'off',
                order_confidence_config: {},
                interaction_choices: false,
                action_queue: false,
                knowledge_suggestions: false,
            },
        });
        await pilotFeatures.update({
            customer_intelligence: false,
            order_confidence_mode: 'off',
            order_confidence_config: {},
            interaction_choices: false,
            action_queue: false,
            knowledge_suggestions: false,
        });
        return shop;
    }

    async function ensureOwner(email, name, shop) {
        const [user] = await E.User.findOrCreate({
            where: { email },
            defaults: {
                email,
                password: passwordHash,
                full_name: name,
                is_active: true,
                is_verified: true,
                token_version: 1,
                settings: {},
                last_logged_shop_id: shop.id,
            },
        });
        await user.update({
            password: passwordHash,
            full_name: name,
            is_active: true,
            is_verified: true,
            last_logged_shop_id: shop.id,
            settings: {},
        });
        const [membership] = await E.UserShop.findOrCreate({
            where: { user_id: user.id, shop_id: shop.id },
            defaults: { user_id: user.id, shop_id: shop.id, role: 'owner', is_active: true },
        });
        await membership.update({ role: 'owner', is_active: true });
        return user;
    }

    const shopA = await ensureShop(SHOP_A_CODE, 'Ops Closure Synthetic Shop A');
    const shopB = await ensureShop(SHOP_B_CODE, 'Ops Closure Synthetic Shop B');
    const ownerA = await ensureOwner(EMAIL_A, 'Ops Closure Owner A', shopA);
    const ownerB = await ensureOwner(EMAIL_B, 'Ops Closure Owner B', shopB);

    const connectedFacebookChannel = await E.MetaChannel.findOne({
        where: {
            shop_id: [shopA.id, shopB.id],
            platform: 'facebook',
            status: 'CONNECTED',
        },
        attributes: ['id'],
    });
    if (connectedFacebookChannel) {
        throw new Error('Refusing provider-free seed: a connected Facebook channel already exists for a synthetic shop');
    }

    async function ensureCustomer(shop, name, channelUserId) {
        const [customer] = await E.Customer.findOrCreate({
            where: { shop_id: shop.id, channel_type: 'messenger', channel_user_id: channelUserId },
            defaults: {
                shop_id: shop.id,
                name,
                channel_type: 'messenger',
                channel_user_id: channelUserId,
                messaging_consent: { facebook: { opted_in: true, last_inbound_at: now.toISOString() } },
            },
        });
        await customer.update({ name, messaging_consent: { facebook: { opted_in: true, last_inbound_at: now.toISOString() } } });
        return customer;
    }

    async function ensureConversation(shop, customer, { title, hitl = false, inboundText, inboundAgeMs, draftText = null }) {
        const [conversation] = await E.Conversation.findOrCreate({
            where: { shop_id: shop.id, customer_id: customer.id, channel: 'messenger' },
            defaults: {
                shop_id: shop.id,
                customer_id: customer.id,
                channel: 'messenger',
                title,
                status: 'active',
                role: 'user',
                message: inboundText,
                hitl,
                metadata: { seed_tag: SEED_TAG },
            },
        });
        await conversation.update({
            title,
            status: 'active',
            role: 'user',
            message: inboundText,
            hitl,
            assignee_id: null,
            resolution_note: null,
            resolved_at: null,
            metadata: { seed_tag: SEED_TAG },
        });

        const inboundAt = new Date(now.getTime() - inboundAgeMs);
        await customer.update({
            messaging_consent: { facebook: { opted_in: true, last_inbound_at: inboundAt.toISOString() } },
        });
        const inboundId = `${SEED_TAG}:${customer.channel_user_id}:inbound`;
        const [inbound] = await E.Message.findOrCreate({
            where: { conversation_id: conversation.id, external_id: inboundId },
            defaults: {
                conversation_id: conversation.id,
                external_id: inboundId,
                content: inboundText,
                sender: 'customer',
                created_at: inboundAt,
                metadata: { synthetic: true, seed_tag: SEED_TAG },
            },
        });
        await inbound.update({ content: inboundText, created_at: inboundAt, sender: 'customer' });

        let draft = null;
        if (draftText) {
            const draftId = `${SEED_TAG}:${customer.channel_user_id}:draft`;
            const draftAt = new Date(Math.max(inboundAt.getTime() + 60_000, now.getTime() - 9 * 60_000));
            const [row] = await E.Message.findOrCreate({
                where: { conversation_id: conversation.id, external_id: draftId },
                defaults: {
                    conversation_id: conversation.id,
                    external_id: draftId,
                    content: draftText,
                    sender: 'ai',
                    ai_suggestion: draftText,
                    ai_confidence: 0.9,
                    delivery_state: 'DRAFT_READY',
                    delivery_source: 'AI_DRAFT',
                    created_at: draftAt,
                    metadata: {
                        synthetic: true,
                        seed_tag: SEED_TAG,
                        suggestion_visibility: 'VISIBLE_DRAFT_REVIEW',
                        held_reason: 'draft_mode',
                        delivery_status: 'pending',
                    },
                },
            });
            const priorOutbox = E.InboxDeliveryOutbox && await E.InboxDeliveryOutbox.findOne({
                where: { shop_id: shop.id, message_id: row.id },
            });
            if (priorOutbox) {
                const priorMetadata = row.metadata || {};
                const safeToReset = String(priorOutbox.status).toUpperCase() === 'PENDING'
                    && priorOutbox.last_error_code === 'DRAFT_DELIVERY_NOT_CONFIRMED'
                    && !priorOutbox.provider_message_id
                    && !priorOutbox.processing_token
                    && priorMetadata.provider_send_attempted !== true
                    && priorMetadata.provider_send_claimed !== true;
                if (!safeToReset) {
                    throw new Error('Refusing to reset a synthetic draft with active or provider-uncertain outbox work');
                }
                await priorOutbox.destroy();
            }
            await row.update({
                content: draftText,
                ai_suggestion: draftText,
                ai_confidence: 0.9,
                delivery_state: 'DRAFT_READY',
                delivery_source: 'AI_DRAFT',
                created_at: draftAt,
                provider_message_id: null,
                send_idempotency_key: null,
                metadata: {
                    synthetic: true,
                    seed_tag: SEED_TAG,
                    suggestion_visibility: 'VISIBLE_DRAFT_REVIEW',
                    held_reason: 'draft_mode',
                    delivery_status: 'pending',
                },
            });
            draft = row;
        }
        return { conversation, inbound, draft };
    }

    const customerCurrent = await ensureCustomer(shopA, 'Ops Closure Current Buyer A', 'ops-gate-current-a');
    await ensureConversation(shopA, customerCurrent, {
        title: 'Ops Closure Current Buyer A',
        inboundText: 'Is this item available?',
        inboundAgeMs: 10 * 60_000,
        draftText: 'I can check the current catalog details for you.',
    });

    const customerCurrentFirefox = await ensureCustomer(shopA, 'Ops Closure Current Buyer Firefox A', 'ops-gate-current-firefox-a');
    await ensureConversation(shopA, customerCurrentFirefox, {
        title: 'Ops Closure Current Buyer Firefox A',
        inboundText: 'Can I see the available details?',
        inboundAgeMs: 10 * 60_000,
        draftText: 'I can check the current catalog details for you in Firefox.',
    });

    const customerExpired = await ensureCustomer(shopA, 'Ops Closure Expired Buyer A', 'ops-gate-expired-a');
    const expiredDraft = await ensureConversation(shopA, customerExpired, {
        title: 'Ops Closure Expired Buyer A',
        inboundText: 'Please share more details about this item.',
        inboundAgeMs: 26 * 60 * 60_000,
        draftText: 'Here are the details from the shop catalog.',
    });
    // Preserve the draft's position within the expired customer's last turn.
    const expiredDraftAt = new Date(now.getTime() - 25 * 60 * 60_000);
    if (expiredDraft.draft) await expiredDraft.draft.update({ created_at: expiredDraftAt });

    const customerExpiredFirefox = await ensureCustomer(
        shopA,
        'Ops Closure Expired Buyer Firefox A',
        'ops-gate-expired-firefox-a',
    );
    const expiredFirefoxDraft = await ensureConversation(shopA, customerExpiredFirefox, {
        title: 'Ops Closure Expired Buyer Firefox A',
        inboundText: 'Please share more details about this item.',
        inboundAgeMs: 26 * 60 * 60_000,
        draftText: 'Here are the details from the shop catalog.',
    });
    if (expiredFirefoxDraft.draft) await expiredFirefoxDraft.draft.update({ created_at: expiredDraftAt });

    const customerHandoff = await ensureCustomer(shopA, 'Ops Closure Handoff Buyer A', 'ops-gate-handoff-a');
    await ensureConversation(shopA, customerHandoff, {
        title: 'Ops Closure Handoff Buyer A',
        hitl: true,
        inboundText: 'Please connect me with a person.',
        inboundAgeMs: 8 * 60_000,
    });

    const customerHandoffFirefox = await ensureCustomer(
        shopA,
        'Ops Closure Handoff Buyer Firefox A',
        'ops-gate-handoff-firefox-a',
    );
    await ensureConversation(shopA, customerHandoffFirefox, {
        title: 'Ops Closure Handoff Buyer Firefox A',
        hitl: true,
        inboundText: 'Please connect me with a person.',
        inboundAgeMs: 8 * 60_000,
    });

    const customerB = await ensureCustomer(shopB, 'Ops Closure Buyer B', 'ops-gate-buyer-b');
    await ensureConversation(shopB, customerB, {
        title: 'Ops Closure Buyer B',
        inboundText: 'Hello from synthetic Shop B.',
        inboundAgeMs: 8 * 60_000,
    });

    const [order] = await E.Order.findOrCreate({
        where: { order_number: 'OGCE2E-A-1001' },
        defaults: {
            shop_id: shopA.id,
            customer_id: customerCurrent.id,
            order_number: 'OGCE2E-A-1001',
            customer_name: customerCurrent.name,
            channel: 'messenger',
            items: [{ name: 'Synthetic Catalog Item', quantity: 1, price: 1250 }],
            order_status: 'processing',
            payment_status: 'pending',
            fulfillment_status: 'unfulfilled',
            subtotal: 1250,
            total: 1250,
            metadata: { synthetic: true, seed_tag: SEED_TAG },
        },
    });
    await order.update({
        shop_id: shopA.id,
        customer_id: customerCurrent.id,
        customer_name: customerCurrent.name,
        order_status: 'processing',
        payment_status: 'pending',
        fulfillment_status: 'unfulfilled',
        total: 1250,
        metadata: { synthetic: true, seed_tag: SEED_TAG },
    });

    const [tag] = await E.CustomerTag.findOrCreate({
        where: { shop_id: shopA.id, name_lower: 'priority follow up' },
        defaults: { shop_id: shopA.id, name: 'Priority follow up', name_lower: 'priority follow up', created_by: ownerA.id },
    });
    await tag.update({ name: 'Priority follow up', name_lower: 'priority follow up', created_by: ownerA.id });

    await sequelize.close();
    console.log('Seeded two synthetic shops in easymod_ops_gate_e2e.');
    console.log(`Shop A sign-in: ${EMAIL_A}`);
    console.log(`Shop B sign-in: ${EMAIL_B}`);
    console.log('Set OPS_E2E_PASSWORD to the same synthetic seed password when running Playwright.');
    console.log('No Meta channel or provider credentials were seeded.');
    console.log(`Fixture labels: ${customerCurrent.name}; ${customerExpired.name}; ${customerExpiredFirefox.name}; ${customerHandoff.name}; ${customerHandoffFirefox.name}; ${customerB.name}`);
}

main().catch(async (error) => {
    console.error('OPERATIONAL_GATE_CLOSURE_E2E_SEED_FAILED', error.message);
    process.exitCode = 1;
});
