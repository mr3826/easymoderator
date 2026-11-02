'use strict';

/**
 * Growth metrics — operational AI milestones & retention.
 *
 * First successful AI reply is an operational milestone, not Growth activation.
 * It is recorded once per shop into shop.settings.first_ai_reply. Redis uses a temporary NX claim
 * while the database write is in flight and persists it only after activation
 * is confirmed, so a failed DB write can never poison the shop permanently.
 *
 * Retention = a shop with >=1 captured order in a given week, derived live from
 * the Orders table (no extra storage).
 *
 * Together these power the launch / 10-shop smoke-test dashboard: how many shops
 * activated, how fast, and how many are still transacting week over week.
 */

const { Op } = require('sequelize');
const Shop = require('../shop/shop.entity');
const Order = require('../order/order.entity');
const { cacheRedis } = require('../../config/redis');

const DAY_MS = 24 * 60 * 60 * 1000;
const ACTIVATION_CLAIM_TTL_SECONDS = 5 * 60;

const writeFirstAiReply = async (_shop, shopId, conversationId, actorUserId = null, transaction = null) => {
    const sequelize = Shop.sequelize;
    const activatedAt = new Date().toISOString();

    // The production schema stores settings as JSON. Update only the
    // activation path in one SQL statement so a concurrent merchant settings
    // write cannot be replaced by a stale full-object snapshot.
    if (sequelize?.getDialect?.() === 'postgres') {
        const activation = JSON.stringify({
            occurred_at: activatedAt,
            first_conversation_id: conversationId || null,
            actor_user_id: actorUserId,
        });
        const escapedActivation = sequelize.escape(activation);
        const [updatedCount] = await Shop.update(
            {
                    settings: sequelize.literal(
                    `(COALESCE("settings"::jsonb, '{}'::jsonb) || jsonb_build_object('first_ai_reply', ${escapedActivation}::jsonb))::json`,
                ),
            },
            {
                where: {
                    [Op.and]: [
                        { id: shopId },
                        sequelize.literal(`("settings"::jsonb->'first_ai_reply'->>'occurred_at') IS NULL`),
                    ],
                },
                ...(transaction ? { transaction } : {}),
            },
        );
        return updatedCount === 1;
    }

    // SQLite-backed development/tests do not have the production JSON
    // operators. Re-read under the caller's row lock before merging so local
    // writes preserve settings committed since the initial activation check.
    const query = {};
    if (transaction) {
        query.transaction = transaction;
        if (transaction?.LOCK?.UPDATE) query.lock = transaction.LOCK.UPDATE;
    }
    const currentShop = await Shop.findByPk(shopId, query);
    if (!currentShop) return false;
    const currentSettings = normalizeSettings(currentShop.settings);
    if (currentSettings.first_ai_reply?.occurred_at) return false;

    const update = {
        settings: {
            ...currentSettings,
            first_ai_reply: {
                occurred_at: activatedAt,
                first_conversation_id: conversationId || null,
                actor_user_id: actorUserId,
            },
        },
    };
    if (transaction) await currentShop.update(update, { transaction });
    else await currentShop.update(update);
    return true;
};

const normalizeSettings = (settings) => {
    if (!settings) return {};
    if (typeof settings === 'object') return settings;
    try {
        const parsed = JSON.parse(settings);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
};

/**
 * Record the first successful AI reply as an operational milestone. Idempotent and
 * best-effort: a Redis NX claim throttles to one write per shop lifetime, and a
 * second DB-level guard prevents overwriting an existing activation timestamp.
 * Never throws — activation tracking must never block or fail a customer reply.
 * @param {string} shopId
 * @param {string|null} conversationId  the conversation that received the reply
 * @param {string|null} actorUserId server-side producer identity, when available
 */
const recordActivation = async (shopId, conversationId = null, actorUserId = null) => {
    if (!shopId) return;
    const claimKey = `shop:first-ai-reply:${shopId}`;
    let claimed = false;
    let activationConfirmed = false;

    try {
        // The expiry is a recovery boundary, not the long-term marker. Once the
        // DB confirms activation, PERSIST restores the fast lifetime short-circuit.
        const claimResult = await cacheRedis.set(
            claimKey,
            '1',
            'EX',
            ACTIVATION_CLAIM_TTL_SECONDS,
            'NX',
        );
        claimed = claimResult === 'OK' || claimResult === 1;
        if (!claimed) return;

        const recordWithinTransaction = async (transaction = null) => {
            let shop;
            if (transaction) {
                const query = { transaction };
                if (transaction?.LOCK?.UPDATE) query.lock = transaction.LOCK.UPDATE;
                shop = await Shop.findByPk(shopId, query);
            } else {
                shop = await Shop.findByPk(shopId);
            }
            if (!shop) return false;

            const settings = normalizeSettings(shop.settings);
            const firstReplyAlreadyRecorded = Boolean(settings.first_ai_reply?.occurred_at);
            const firstReplyRecorded = firstReplyAlreadyRecorded
                || await writeFirstAiReply(shop, shopId, conversationId, actorUserId, transaction);
            if (!firstReplyRecorded) return false;

            const { markLinkedShopsActivated } = require('../growth-os/growth-os.prospect.service');
            await markLinkedShopsActivated({ shopId, actorUserId, transaction });
            return true;
        };
        const sequelize = Shop.sequelize;
        activationConfirmed = sequelize?.transaction
            ? await sequelize.transaction(recordWithinTransaction)
            : await recordWithinTransaction();
    } catch (err) {
        // Best-effort — swallow so a reply is never blocked by metrics
        // bookkeeping, but retain a sanitized operational signal.
        console.error('Growth activation write failed:', { name: err?.name, code: err?.code });
    } finally {
        if (claimed) {
            try {
                if (activationConfirmed) {
                    await cacheRedis.persist(claimKey);
                } else {
                    await cacheRedis.del(claimKey);
                }
            } catch (_) {
                // The temporary claim still expires, so cleanup failure cannot poison
                // activation permanently and must never block the customer reply.
            }
        }
    }
};

/**
 * Deprecated operational AI-reply + retention report. Canonical Growth
 * activation is served by the Growth workspace prospect-ledger report.
 * @param {{ now?: Date|string }} [opts]
 * @returns {Promise<object>} { generatedAt, totals, shops[] }
 */
const getGrowthMetrics = async (opts = {}) => {
    const now = opts.now ? new Date(opts.now) : new Date();
    const weekAgo = new Date(now.getTime() - 7 * DAY_MS);
    const twoWeeksAgo = new Date(now.getTime() - 14 * DAY_MS);

    const shops = await Shop.findAll({
        attributes: ['id', 'shop_name', 'name', 'settings', 'created_at'],
    });

    const shopIds = shops.map(shop => shop.id);
    const [lastWeekCounts, previousWeekCounts] = shopIds.length > 0
        ? await Promise.all([
            Order.count({
                where: {
                    shop_id: { [Op.in]: shopIds },
                    created_at: { [Op.gte]: weekAgo },
                },
                group: ['shop_id'],
            }),
            Order.count({
                where: {
                    shop_id: { [Op.in]: shopIds },
                    created_at: { [Op.gte]: twoWeeksAgo, [Op.lt]: weekAgo },
                },
                group: ['shop_id'],
            }),
        ])
        : [[], []];
    const toCountMap = counts => new Map(
        counts.map(row => [row.shop_id, Number(row.count) || 0]),
    );
    const lastWeekByShop = toCountMap(lastWeekCounts);
    const previousWeekByShop = toCountMap(previousWeekCounts);

    const rows = shops.map((shop) => {
        const settings = normalizeSettings(shop.settings);
        const firstAiReplyAt = settings.first_ai_reply?.occurred_at || null;
        const createdAt = shop.created_at || null;
        const ordersLast7d = lastWeekByShop.get(shop.id) || 0;
        const ordersPrev7d = previousWeekByShop.get(shop.id) || 0;

        const daysToFirstAiReply = (firstAiReplyAt && createdAt)
            ? Math.max(0, Math.round((new Date(firstAiReplyAt) - new Date(createdAt)) / DAY_MS))
            : null;

        return {
            shopId: shop.id,
            name: shop.shop_name || shop.name || null,
            createdAt,
            firstAiReplyAt,
            firstAiReplyRecorded: Boolean(firstAiReplyAt),
            daysToFirstAiReply,
            ordersLast7d,
            ordersPrev7d,
            retainedThisWeek: ordersLast7d > 0,
            retainedLastWeek: ordersPrev7d > 0,
        };
    });

    const total = rows.length;
    const milestoneRows = rows.filter(r => r.firstAiReplyRecorded);
    const firstAiReplies = milestoneRows.length;
    const retainedThisWeek = milestoneRows.filter(r => r.retainedThisWeek).length;
    const pct = (n, d) => (d > 0 ? Math.round((n / d) * 100) : 0);

    return {
        generatedAt: now.toISOString(),
        totals: {
            shops: total,
            firstAiReplies,
            firstAiReplyRate: pct(firstAiReplies, total),
            retainedThisWeek,
            // Retention is measured against ACTIVATED shops — the meaningful denominator.
            retentionRate: pct(retainedThisWeek, firstAiReplies),
        },
        // Most-active shops first.
        shops: rows.sort((a, b) => b.ordersLast7d - a.ordersLast7d),
    };
};

module.exports = { recordActivation, getGrowthMetrics };
