'use strict';

/**
 * Pilot+ V1 founder lab seed — two independent synthetic shops with the five
 * capabilities visible in the real UI. SYNTHETIC ONLY: no live Meta sends, no
 * production data, local-only credentials. Idempotent ([PILOT-LAB] tag + fixed
 * emails). Run after `npm run migrate`:
 *
 *   npm run seed:pilotplus-lab     (or node scripts/pilotplus-seed-lab.js)
 *
 * Shop A (all Pilot+ flags ON):  live-commerce clothing boutique demoing
 *   P+01 lead chip+strip, P+03 queue buckets 1-5, P+04 suspended/deferred
 *   checkouts, P+05 gap suggestions, DRAFT/AUTO state surfaces.
 * Shop B (flags OFF): control shop proving isolation + default-off posture.
 */

require('module-alias/register');
require('dotenv').config();
process.env.NODE_ENV = process.env.NODE_ENV || 'development';

const LAB_TAG = '[PILOT-LAB]';
const LAB_PASSWORD = 'PilotLab@2026!';

async function main() {
    const { sequelize } = require('../src/utils/database/database-setup');
    const E = require('../src/modules/entities');
    const { v4: uuidv4 } = require('uuid');
    const { hashPassword } = require('../src/utils/password.util');

    await sequelize.authenticate();
    console.log('[pilotplus-lab] DB connected');

    const [tenant] = await E.Tenant.findOrCreate({
        where: { name: 'Pilot+ Lab Tenant' },
        defaults: { id: uuidv4(), name: 'Pilot+ Lab Tenant', is_active: true, settings: {} },
    });

    async function ensureUser(email, fullName) {
        let user = await E.User.findOne({ where: { email } });
        if (!user) {
            user = await E.User.create({
                id: uuidv4(), email, password: await hashPassword(LAB_PASSWORD),
                name: fullName, role: 'owner', is_active: true, is_verified: true, token_version: 0,
            });
        }
        return user;
    }

    async function ensureShop(code, name, owner, staff) {
        let shop = await E.Shop.findOne({ where: { unique_code: code } });
        if (!shop) {
            shop = await E.Shop.create({
                id: uuidv4(), unique_code: code, tenant_id: tenant.id,
                shop_name: `${LAB_TAG} ${name}`, name: `${LAB_TAG} ${name}`,
                is_active: true, timezone: 'Asia/Dhaka', settings: { bd: { enabled: true } },
            });
            await E.Subscription.findOrCreate({
                where: { shop_id: shop.id },
                defaults: {
                    id: uuidv4(), shop_id: shop.id, plan_name: 'MERCHANT', plan_code: 'MERCHANT',
                    plan_price: 999, billing_cycle: 'monthly', status: 'active',
                    conversations_limit: 500, conversations_used: 0, topup_balance: 0, threshold_debt: 0,
                    current_period_start: new Date(), current_period_end: new Date(Date.now() + 30 * 86400_000),
                    next_billing_date: new Date(Date.now() + 30 * 86400_000),
                    features: { ai_replies: true, order_management: true, delivery_tracking: true, bd_lite: true },
                },
            });
        }
        for (const [user, role] of [[owner, 'owner'], [staff, 'staff']]) {
            const existing = await E.UserShop.findOne({ where: { user_id: user.id, shop_id: shop.id } });
            if (!existing) await E.UserShop.create({ id: uuidv4(), user_id: user.id, shop_id: shop.id, role, is_active: true });
        }
        await E.ShopPilotFeatures.findOrCreate({
            where: { shop_id: shop.id },
            defaults: { shop_id: shop.id, customer_intelligence: false, order_confidence_mode: 'off', order_confidence_config: {} },
        });
        return shop;
    }

    const ownerA = await ensureUser('pilot.a.owner@lab.easymod.local', `${LAB_TAG} Rina (Owner A)`);
    const staffA = await ensureUser('pilot.a.staff@lab.easymod.local', `${LAB_TAG} Shamim (Staff A)`);
    const ownerB = await ensureUser('pilot.b.owner@lab.easymod.local', `${LAB_TAG} Tanvir (Owner B)`);

    const shopA = await ensureShop('LABSHOP-A', 'Rina Boutique (Live Seller)', ownerA, staffA);
    const shopB = await ensureShop('LABSHOP-B', 'TechGadget BD', ownerB, ownerB);

    await E.ShopPilotFeatures.update({
        customer_intelligence: true, interaction_choices: true, action_queue: true, knowledge_suggestions: true,
    }, { where: { shop_id: shopA.id } });
    await E.ShopPilotFeatures.update({
        customer_intelligence: false, interaction_choices: false, action_queue: false, knowledge_suggestions: false,
    }, { where: { shop_id: shopB.id } });

    // AI reply mode per shop: A = DRAFT (draft lifecycle visible), B = MANUAL
    const shopSettingsA = { ...(shopA.settings || {}), ai: { ...(shopA.settings?.ai || {}), reply_mode: 'DRAFT' } };
    await shopA.update({ settings: shopSettingsA });
    const shopSettingsB = { ...(shopB.settings || {}), ai: { ...(shopB.settings?.ai || {}), reply_mode: 'MANUAL' } };
    await shopB.update({ settings: shopSettingsB });

    // Payment + delivery config truth for shop A (single enabled rail)
    try {
        await E.PaymentConfig.findOrCreate({
            where: { shop_id: shopA.id, gateway: 'cod' },
            defaults: { id: uuidv4(), shop_id: shopA.id, gateway: 'cod', is_enabled: true, credentials: {}, config: {} },
        });
        await E.PaymentConfig.findOrCreate({
            where: { shop_id: shopA.id, gateway: 'self-mfs' },
            defaults: { id: uuidv4(), shop_id: shopA.id, gateway: 'self-mfs', is_enabled: false, credentials: {}, config: {} },
        });
    } catch (e) { console.warn('[pilotplus-lab] payment configs skipped:', e.message); }

    // Catalog for grounding (best effort)
    try {
        const catalog = [
            ['Lawn Two Piece - Navy', 'P-1100', 1490, 8, 'women, clothing, lawn'],
            ['Handloom Cotton Saree - Red', 'P-2044', 2100, 3, 'women, saree, cotton'],
            ['Jamdani Saree - Off White', 'P-2100', 4500, 0, 'women, saree, jamdani'],
            ['Kids Panjabi - Assorted', 'P-3310', 650, 12, 'kids, panjabi'],
        ];
        for (const [name, sku, price, qty, tags] of catalog) {
            await E.Product.findOrCreate({
                where: { shop_id: shopA.id, name },
                defaults: {
                    id: uuidv4(), shop_id: shopA.id, name, sku, price, quantity: qty,
                    category: 'women', tags: tags.split(','), is_active: true,
                },
            });
        }
    } catch (e) { console.warn('[pilotplus-lab] products skipped:', e.message); }

    async function ensureCustomer(shop, name, psid, consent = {}) {
        const [c] = await E.Customer.findOrCreate({
            where: { shop_id: shop.id, channel_user_id: psid },
            defaults: {
                id: uuidv4(), shop_id: shop.id, name: `${LAB_TAG} ${name}`,
                channel_type: 'messenger', channel_user_id: psid, messaging_consent: consent,
            },
        });
        return c;
    }

    async function conversationWith(shop, customer, messages, extra = {}) {
        let conv = await E.Conversation.findOne({ where: { shop_id: shop.id, customer_id: customer.id, metadata: { seedTag: 'pilotplus-lab' } }, limit: 1 });
        if (!conv) {
            conv = await E.Conversation.create({
                id: uuidv4(), shop_id: shop.id, customer_id: customer.id, channel: 'messenger',
                status: 'active', role: 'user', message: messages[messages.length - 1]?.[0] || 'hi',
                metadata: { seedTag: 'pilotplus-lab' },
            });
        }
        for (let i = 0; i < messages.length; i++) {
            const [content, sender, minutesAgo] = messages[i];
            const external_id = `pilotlab-${conv.id}-${i}`;
            const exists = await E.Message.findOne({ where: { external_id } });
            if (!exists) {
                await E.Message.create({
                    id: uuidv4(), conversation_id: conv.id, content, sender, external_id,
                    created_at: new Date(Date.now() - minutesAgo * 60_000),
                    delivery_state: sender === 'ai' ? 'SENT' : null,
                    metadata: {},
                });
            }
        }
        if (Object.keys(extra).length) {
            const updates = {};
            if (extra.hitl !== undefined) updates.hitl = extra.hitl;
            if (extra.metadata) updates.metadata = { seedTag: 'pilotplus-lab', ...extra.metadata };
            await conv.update(updates);
        }
        return conv;
    }

    // 1) Strong lead: purchase intent + started checkout, gone quiet (Banglish)
    const cLead = await ensureCustomer(shopA, 'Rima (serious buyer)', 'psid-lab-rima', { facebook: { opted_in: true } });
    const convLead = await conversationWith(shopA, cLead, [
        ['ei lawn two piece ta ache?', 'customer', 240],
        ['ha niye nin, size medium', 'customer', 235],
        ['order ta confirm korte chai', 'customer', 180],
    ]);

    // 2) Casual one-off price question (must NOT become a lead)
    const cCasual = await ensureCustomer(shopA, 'Sadia (browser)', 'psid-lab-sadia', { facebook: { opted_in: true } });
    await conversationWith(shopA, cCasual, [['dam koto?', 'customer', 300]]);

    // 3) Declined buyer (cancel after intent — suppressed)
    const cDeclined = await ensureCustomer(shopA, 'Mou (declined)', 'psid-lab-mou', { facebook: { opted_in: true } });
    await conversationWith(shopA, cDeclined, [
        ['saree ta nibo', 'customer', 400],
        ['na thik ache, lagbe na', 'customer', 395],
    ]);

    // 4) Human handoff in progress (queue bucket 1, English)
    const cHandoff = await ensureCustomer(shopA, 'Farhana (needs human)', 'psid-lab-farhana', { facebook: { opted_in: true } });
    await conversationWith(shopA, cHandoff, [
        ['I want to talk to a person please', 'customer', 95],
    ], { hitl: true, metadata: { handoff_reason: 'HUMAN_HANDOFF_REQUEST', handoff_at: new Date(Date.now() - 95 * 60_000).toISOString() } });

    // 5) Opted-out customer (never appears as a follow-up lead)
    const cOptOut = await ensureCustomer(shopA, 'Nabila (opted out)', 'psid-lab-nabila', { facebook: { opted_in: true, opted_out_at: new Date(Date.now() - 26 * 3600_000) } });
    await conversationWith(shopA, cOptOut, [
        ['STOP', 'customer', 1500],
    ]);

    // 6) Active checkout paused by a delivery question (P+04 awaiting_resume)
    const OrderSession = require('../src/modules/order/order-session.entity');
    const cCart = await ensureCustomer(shopA, 'Jahid (mid-checkout)', 'psid-lab-jahid', { facebook: { opted_in: true } });
    const convCart = await conversationWith(shopA, cCart, [
        ['lawn two piece nibo', 'customer', 90],
        ['delivery charge koto?', 'customer', 30],
    ]);
    await OrderSession.findOrCreate({
        where: { shop_id: shopA.id, customer_channel_id: 'psid-lab-jahid' },
        defaults: {
            id: uuidv4(), shop_id: shopA.id, customer_id: cCart.id, conversation_id: convCart.id,
            customer_channel_id: 'psid-lab-jahid', channel: 'messenger',
            status: 'ACTIVE', current_step: 'COLLECTING_PHONE', automation_mode: 'DRAFT',
            confidence_threshold: 60,
            step_data: {
                language: 'bn', cart: [{ name: 'Lawn Two Piece - Navy', price: 1490, quantity: 1 }],
                customer_name: 'Jahid Hasan', total: 1550, delivery_zone: 'inside_dhaka',
                delivery_charge: 60, enabled_gateways: ['cod'], awaiting_resume: 'COLLECTING_PHONE',
            },
            last_activity_at: new Date(Date.now() - 25 * 60_000),
            expires_at: new Date(Date.now() + 20 * 3600_000),
        },
    });

    // 7) Suspended checkout from a human request (cart preserved)
    const cSusp = await ensureCustomer(shopA, 'Akram (suspended cart)', 'psid-lab-akram', { facebook: { opted_in: true } });
    const convSusp = await conversationWith(shopA, cSusp, [
        ['panjabi ta order korte acche', 'customer', 200],
        ['manush er sathe kotha bolte chai', 'customer', 120],
    ], { hitl: true, metadata: { handoff_reason: 'HUMAN_HANDOFF_REQUEST', handoff_at: new Date(Date.now() - 120 * 60_000).toISOString() } });
    await OrderSession.findOrCreate({
        where: { shop_id: shopA.id, customer_channel_id: 'psid-lab-akram' },
        defaults: {
            id: uuidv4(), shop_id: shopA.id, customer_id: cSusp.id, conversation_id: convSusp.id,
            customer_channel_id: 'psid-lab-akram', channel: 'messenger',
            status: 'SUSPENDED', current_step: 'COLLECTING_ADDRESS', automation_mode: 'DRAFT',
            confidence_threshold: 60,
            step_data: {
                language: 'bn', cart: [{ name: 'Kids Panjabi - Assorted', price: 650, quantity: 2 }],
                customer_name: 'Akram Hossain', customer_phone: '01711000222',
                suspended_reason: 'HUMAN_HANDOFF_REQUEST',
            },
            last_activity_at: new Date(Date.now() - 110 * 60_000),
            expires_at: new Date(Date.now() + 22 * 3600_000),
        },
    });

    // 8) Committed order whose customer message FAILED (queue bucket 2)
    const cFailed = await ensureCustomer(shopA, 'Sabbir (order ack failed)', 'psid-lab-sabbir', { facebook: { opted_in: true } });
    const convFailed = await conversationWith(shopA, cFailed, [['ok order confirm', 'customer', 60]]);
    const failedExt = 'pilotlab-failed-ack-1';
    const existingFailed = await E.Message.findOne({ where: { external_id: failedExt } });
    if (!existingFailed) {
        await E.Message.create({
            id: uuidv4(), conversation_id: convFailed.id, sender: 'ai',
            content: 'Order #501 confirmed (total ৳710).', external_id: failedExt,
            delivery_state: 'FAILED', created_at: new Date(Date.now() - 55 * 60_000),
            metadata: { executed_mutation_without_outbound_send: true, held_reason: 'policy_blocked' },
        });
    }

    // 9) Reviewable draft (queue bucket 4, DRAFT mode surface)
    const draftExt = 'pilotlab-draft-1';
    if (!(await E.Message.findOne({ where: { external_id: draftExt } }))) {
        await E.Message.create({
            id: uuidv4(), conversation_id: convLead.id, sender: 'ai',
            content: 'Ji, Navy Lawn Two Piece ৳1490 — size Medium stock ache. Dhaka delivery ৳60, 1-2 din.',
            external_id: draftExt, ai_suggestion: true, ai_confidence: 0.82,
            delivery_state: 'DRAFT_READY', created_at: new Date(Date.now() - 170 * 60_000),
            metadata: { suggestion_visibility: 'VISIBLE_DRAFT_REVIEW' },
        });
    }

    // 10) Recurring unanswered questions (P+05 gaps -> suggestions)
    for (const [q, n] of [['exchange korte parbo?', 5], ['color change korle dimu?', 4], ['bkash e advance dile pabo?', 3]]) {
        for (let i = 0; i < n; i++) {
            await E.KnowledgeGap.create({
                shop_id: shopA.id, question: `${LAB_TAG} ${q}`, platform: 'messenger',
                language: 'bn', source: 'ai_unknown_response',
                created_at: new Date(Date.now() - (i + 1) * 36 * 3600_000),
            }).catch(() => {});
        }
    }

    // Same-looking customers in shop B (isolation demo; flags off)
    const cB = await ensureCustomer(shopB, 'ShopB Buyer (control)', 'psid-lab-b1', { facebook: { opted_in: true } });
    await conversationWith(shopB, cB, [['ei product ta ache?', 'customer', 90]]);

    // Run the real detection engines (same code paths as production jobs)
    try {
        const opp = require('../src/modules/customer-intelligence/opportunity.service');
        const r = await opp.detectForShop(shopA.id);
        console.log('[pilotplus-lab] opportunity sweep:', JSON.stringify(r));
    } catch (e) { console.warn('[pilotplus-lab] opportunity sweep skipped:', e.message); }

    try {
        const gaps = require('../src/modules/knowledge/gap-suggestions.service');
        const g = await gaps.computeForShop(shopA.id);
        console.log('[pilotplus-lab] gap suggestions:', JSON.stringify(g));
    } catch (e) { console.warn('[pilotplus-lab] gap sweep skipped:', e.message); }

    console.log('\n=== PILOT+ LAB READY ===');
    console.log(JSON.stringify({
        shopA: { id: shopA.id, name: shopA.shop_name, flags: 'ALL ON', login: 'pilot.a.owner@lab.easymod.local', staff: 'pilot.a.staff@lab.easymod.local', password: LAB_PASSWORD, aiReplyMode: 'DRAFT' },
        shopB: { id: shopB.id, name: shopB.shop_name, flags: 'ALL OFF (control)', login: 'pilot.b.owner@lab.easymod.local', password: LAB_PASSWORD, aiReplyMode: 'MANUAL' },
        demoed: [
            'P+01: open Inbox — "Rima (serious buyer)" has lead chip + reason strip; "Sadia (browser)" has none',
            'P+03: queue shows needs-human (Farhana), failed-ack (Sabbir), blocked-checkout (Jahid/Akram), opportunity (Rima)',
            'P+04: Jahid cart paused by a delivery question (fields preserved); Akram cart suspended by human request',
            'P+05: FAQ Settings shows exchange/color/payment suggestions; PAYMENT one routes to settings (disabled rail)',
            'Draft lifecycle: Rima thread has a reviewable DRAFT',
            'Isolation: shop B sees none of shop A data',
        ],
    }, null, 2));

    await sequelize.close();
}

main().catch((e) => { console.error('PILOTPLUS_LAB_SEED_FAILED', e); process.exit(1); });
