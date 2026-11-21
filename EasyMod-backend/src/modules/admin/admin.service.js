'use strict';

const { Op, fn, col, where: sequelizeWhere } = require('sequelize');
const {
  Shop, Subscription, Message, Order, MetaChannel, MetaUserIdentity,
  AuditLog, User, Invoice,
} = require('../entities');
const cacheService = require('../../utils/cache.service');
const subscriptionService = require('../subscription/subscription.service');
const metaChannelService = require('../channel-providers/meta-channel.service');
const shopService = require('../shop/shop.service');
const { AI_REPLY_MODES } = require('../shop/ai-reply-mode');
const { readEmergencyStopState } = require('../channel-providers/channel-automation.resolver');
const { AppError } = require('../../utils/AppError');
const { effectiveConversationLimit } = require('../subscription/subscription.access');
const { countRecentDeliveredOrders } = require('../subscription/partner.service');
const { redactSecretiveValues } = require('../growth-os/growth-os.audit-sanitizer');

function startOfTodayUTC() {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function likeTerm(value) {
  return `%${String(value).trim().toLowerCase()}%`;
}

// ── Dashboard ────────────────────────────────────────────────────────────────
async function getDashboard() {
  const cacheKey = 'admin:dashboard';
  const cached = await cacheService.get(cacheKey).catch(() => null);
  if (cached) return cached;

  const since = startOfTodayUTC();
  const [
     totalShops, activeShops, shuruShops, suspendedShops,
    messagesToday, aiRepliesToday, ordersToday,
  ] = await Promise.all([
    Shop.count(),
    Subscription.count({ where: { status: 'active' } }),
    Subscription.count({ where: { plan_code: 'SHURU', status: 'active' } }),
    Subscription.count({ where: { status: 'suspended' } }),
    Message.count({ where: { created_at: { [Op.gte]: since } } }),
    Message.count({ where: { created_at: { [Op.gte]: since }, sender: 'ai' } }),
    Order.count({ where: { created_at: { [Op.gte]: since } } }),
  ]);

  const data = {
    shops: { total: totalShops, active: activeShops, shuru: shuruShops, suspended: suspendedShops },
    today: {
      messages: messagesToday,
      aiAutoReplies: aiRepliesToday,
      orders: ordersToday,
      // Phase 2 — no clean source yet. Render as "—" in the UI; never fabricate.
      failedAiReplies: null,
      courierFailures: null,
      estimatedAiCost: null,
      systemErrors: null,
    },
    generatedAt: new Date().toISOString(),
  };
  await cacheService.set(cacheKey, data, 30).catch(() => {});
  return data;
}

async function getMetaIdentityReadiness() {
  const mappingScope = {
    where: {
      page_scoped_user_id: { [Op.ne]: null },
      is_current_connection: true,
    },
    include: [{
      model: MetaChannel,
      as: 'channel',
      attributes: [],
      required: true,
      where: { status: 'CONNECTED' },
    }],
  };
  const [
    totalConnectedChannels,
    channelsWithValidMappings,
    mostRecentMappingCaptureAt,
  ] = await Promise.all([
    MetaChannel.count({ where: { status: 'CONNECTED' } }),
    MetaUserIdentity.count({
      ...mappingScope,
      distinct: true,
      col: 'channel_id',
    }),
    MetaUserIdentity.max('last_verified_at', mappingScope),
  ]);
  const connectedChannelsMissingMappings = Math.max(
    0,
    totalConnectedChannels - channelsWithValidMappings,
  );

  return {
    totalConnectedChannels,
    channelsWithValidMappings,
    connectedChannelsMissingMappings,
    mostRecentMappingCaptureAt: mostRecentMappingCaptureAt || null,
    ready: connectedChannelsMissingMappings === 0,
  };
}

// ── Shops list ───────────────────────────────────────────────────────────────
async function listShops({ search = '', page = 1, limit = 20 } = {}) {
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
  const safePage = Math.max(parseInt(page, 10) || 1, 1);
  const offset = (safePage - 1) * safeLimit;

  const queryWhere = {};
  const normalizedSearch = String(search || '').trim();
  if (normalizedSearch) {
    const match = { [Op.like]: likeTerm(normalizedSearch) };
    queryWhere[Op.or] = [
      sequelizeWhere(fn('LOWER', col('shop_name')), match),
      sequelizeWhere(fn('LOWER', col('users.email')), match),
      sequelizeWhere(fn('LOWER', col('users.full_name')), match),
    ];
  }

  const { rows, count } = await Shop.findAndCountAll({
    where: queryWhere,
    include: [
      { model: Subscription, as: 'subscription', required: false },
      {
        model: User, as: 'users', required: false,
        through: { attributes: ['role'], where: { role: 'owner' } },
        attributes: ['id', 'full_name', 'email', 'phone'],
      },
    ],
    order: [['created_at', 'DESC']],
    limit: safeLimit,
    offset,
    distinct: true,
    subQuery: false,
  });

  const shopIds = rows.map((s) => s.id);
  let channelCounts = [];
  if (shopIds.length) {
    channelCounts = await MetaChannel.count({
      where: { shop_id: { [Op.in]: shopIds } },
      group: ['shop_id'],
    }).catch(() => []);
  }
  const channelCountByShop = {};
  (Array.isArray(channelCounts) ? channelCounts : []).forEach((c) => {
    channelCountByShop[c.shop_id] = parseInt(c.count, 10);
  });

  const items = rows.map((shop) => {
    const sub = shop.subscription || {};
    const owner = (shop.users && shop.users[0]) || null;
    return {
      id: shop.id,
      shopName: shop.shop_name || shop.name,
      owner: owner ? { name: owner.full_name, email: owner.email, phone: owner.phone } : null,
      plan: sub.plan_name || null,
      status: sub.status || null,
       channelCount: channelCountByShop[shop.id] || 0,
      conversationsUsed: sub.conversations_used ?? null,
      conversationsLimit: sub.conversations_limit ?? null,
      createdAt: shop.created_at,
    };
  });

  return { items, total: count, page: safePage, limit: safeLimit };
}

// ── Shop overview ────────────────────────────────────────────────────────────
async function getShopOverview(shopId) {
  const shop = await Shop.findByPk(shopId, {
    include: [
      { model: Subscription, as: 'subscription', required: false },
      {
        model: User, as: 'users', required: false,
        through: { attributes: ['role'], where: { is_active: true } },
        attributes: ['id', 'full_name', 'email', 'phone'],
      },
    ],
  });
  if (!shop) throw new AppError('Shop not found', 404);

  const sub = shop.subscription || {};
  const owner = (shop.users || []).find((u) => u.UserShop?.role === 'owner') || (shop.users || [])[0] || null;
  const settings = shop.settings || {};
  const partnerOrders30d = await countRecentDeliveredOrders(shopId).catch(() => 0);

  return {
    shop: {
      id: shop.id,
      shopName: shop.shop_name || shop.name,
      uniqueCode: shop.unique_code,
      isActive: shop.is_active,
      timezone: shop.timezone,
      createdAt: shop.created_at,
    },
    owner: owner ? { id: owner.id, name: owner.full_name, email: owner.email, phone: owner.phone } : null,
    subscription: {
      planName: sub.plan_name || null,
      status: sub.status || null,
      currentPeriodEnd: sub.current_period_end || null,
    },
    usage: {
      conversationsUsed: sub.conversations_used ?? null,
      conversationsLimit: sub.conversations_limit ?? null,
      effectiveConversationLimit: effectiveConversationLimit(sub),
      topupBalance: sub.topup_balance ?? 0,
      partnerEligibility: {
        delivered_orders_30d: partnerOrders30d,
        minimum_delivered_orders: 300,
        eligible: partnerOrders30d >= 300,
      },
    },
    onboarding: {
      completed: Boolean(
        settings.onboarding_completed
          ?? settings.onboarding?.completed
          ?? settings.onboardingCompleted
          ?? false,
      ),
    },
  };
}

// ── Channels (NEVER expose page_access_token_ct) ──────────────────────────────
async function getShopChannels(shopId) {
  const channels = await metaChannelService.listByShop(shopId);
  return channels.map((c) => ({
    id: c.id,
    displayName: c.display_name,
    platform: c.platform,
    status: c.status,
    tokenExpiresAt: c.token_expires_at || null,
    webhookLastVerifiedAt: c.webhook_last_verified_at || null,
    webhookSubscribedFields: c.webhook_subscribed_fields || null,
    lastError: c.last_error || null,
    connectedAt: c.connected_at || null,
    // token field intentionally omitted
  }));
}

// ── Billing read ──────────────────────────────────────────────────────────────
async function getShopBilling(shopId) {
  const sub = await Subscription.findOne({ where: { shop_id: shopId } });
  if (!sub) throw new AppError('Subscription not found', 404);

  // Recent invoices + a count of what is still owed, so support can see the exact
  // billing state that gates the AI (suspended = unpaid recurring invoice past due).
  const invoices = await Invoice.findAll({
    where: { shop_id: shopId },
    order: [['created_at', 'DESC']],
    limit: 12,
  });
  const outstanding = invoices
    .filter((i) => i.status === 'pending' || i.status === 'overdue')
    .reduce((sum, i) => sum + parseFloat(i.amount || 0), 0);
  const partnerOrders30d = await countRecentDeliveredOrders(shopId).catch(() => 0);

  return {
    planName: sub.plan_name,
    planCode: sub.plan_code,
    billingCycle: sub.billing_cycle,
    billingModel: sub.billing_model,
    status: sub.status,
    periodStart: sub.current_period_start,
    currentPeriodEnd: sub.current_period_end,
    nextBillingDate: sub.next_billing_date,
    conversationsLimit: sub.conversations_limit,
    effectiveConversationLimit: effectiveConversationLimit(sub),
    conversationsUsed: sub.conversations_used,
    topupBalance: sub.topup_balance,
    partnerEligibility: {
      delivered_orders_30d: partnerOrders30d,
      minimum_delivered_orders: 300,
      eligible: partnerOrders30d >= 300,
    },
    outstandingAmount: outstanding,
    invoices: invoices.map((i) => ({
      id: i.id,
      invoiceNumber: i.invoice_number,
      type: i.invoice_type,
      amount: parseFloat(i.amount || 0),
      status: i.status,
      billingPeriod: i.billing_period,
      dueDate: i.due_date,
      paidAt: i.paid_at,
      createdAt: i.created_at,
    })),
    estimatedAiCost: null, // Phase 2
  };
}

// ── Audit logs (cross-shop, filtered) ─────────────────────────────────────────
async function getAuditLogs({ adminUserId, shopId, action, startDate, endDate, page = 1, limit = 50 } = {}) {
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  const safePage = Math.max(parseInt(page, 10) || 1, 1);
  const where = {};
  if (adminUserId) where.user_id = adminUserId;
  if (shopId) where.shop_id = shopId;
  if (action) where.action = action;
  if (startDate || endDate) {
    where.created_at = {};
    if (startDate) where.created_at[Op.gte] = new Date(startDate);
    if (endDate) where.created_at[Op.lte] = new Date(endDate);
  }
  const { rows, count } = await AuditLog.findAndCountAll({
    where,
    order: [['created_at', 'DESC']],
    limit: safeLimit,
    offset: (safePage - 1) * safeLimit,
    include: [{ model: User, as: 'user', attributes: ['id', 'full_name', 'email'], required: false }],
  });
  return {
    items: rows.map((r) => ({
      id: r.id,
      action: r.action,
      resourceType: r.resource_type,
      resourceId: r.resource_id,
      shopId: r.shop_id,
      admin: r.user ? { id: r.user.id, name: r.user.full_name, email: r.user.email } : null,
      oldValues: redactSecretiveValues(r.old_values),
      newValues: redactSecretiveValues(r.new_values),
      ipAddress: r.ip_address,
      createdAt: r.created_at,
    })),
    total: count, page: safePage, limit: safeLimit,
  };
}

// ── Mutations ─────────────────────────────────────────────────────────────────
// These are thin wrappers over existing services + cache-bust. Audit logging
// happens in the controller (it holds req). Each returns { before, after }.
const SUBSCRIPTION_STATUS_CACHE_KEY = 'subscription:status';

async function bustSubscriptionStatusCache(shopId) {
  await cacheService.deleteForShop(shopId, SUBSCRIPTION_STATUS_CACHE_KEY).catch(() => {});
}

async function invalidateSubscriptionStatusCache(shopId, transaction = null) {
  if (transaction && typeof transaction.afterCommit === 'function') {
    // Cache is external to the database transaction; publish invalidation only
    // after the status write has committed.
    transaction.afterCommit(() => bustSubscriptionStatusCache(shopId));
    return;
  }
  await bustSubscriptionStatusCache(shopId);
}

async function setShopStatus(shopId, status, { transaction = null } = {}) {
  if (!['suspended', 'active'].includes(status)) throw new AppError('status must be suspended|active', 400);
  const findOptions = { where: { shop_id: shopId } };
  if (transaction) findOptions.transaction = transaction;
  const sub = await Subscription.findOne(findOptions);
  if (!sub) throw new AppError('Subscription not found', 404);
  const before = { status: sub.status };
  if (transaction) await sub.update({ status }, { transaction });
  else await sub.update({ status });
  await invalidateSubscriptionStatusCache(shopId, transaction);
  return { before, after: { status } };
}

function assertCreditIdempotencyKey(value) {
  const key = typeof value === 'string' ? value.trim() : '';
  if (!key || key.length > 255 || !/^[\x21-\x7E]+$/.test(key)) {
    throw new AppError('Idempotency-Key header is required for credit grants.', 400, 'ADMIN_IDEMPOTENCY_REQUIRED');
  }
  return key;
}

function creditRequestHash({ shopId, amount, reason }) {
  return require('crypto').createHash('sha256')
    .update(JSON.stringify({ shopId, amount, reason }), 'utf8')
    .digest('hex');
}

async function addCredits(shopId, amount, reason = 'admin_grant', {
  transaction = null, idempotencyKey = null, actorUserId = null,
} = {}) {
  const n = parseInt(amount, 10);
  if (!Number.isInteger(n) || n <= 0 || n > 100000) throw new AppError('amount must be 1..100000', 400);
  const key = idempotencyKey ? assertCreditIdempotencyKey(idempotencyKey) : null;
  const execute = async (activeTransaction) => {
    let idempotencyRecord = null;
    if (key) {
      if (!actorUserId) throw new AppError('Authenticated actor is required for credit grants.', 401, 'AUTH_REQUIRED');
      const { IdempotencyKey } = require('../entities');
      const [record, created] = await IdempotencyKey.findOrCreate({
        where: { idempotency_key: key, shop_id: shopId },
        defaults: {
          user_id: actorUserId,
          endpoint: '/api/admin/shops/:shopId/add-credits',
          method: 'POST',
          request_hash: creditRequestHash({ shopId, amount: n, reason }),
          response_data: null,
          status_code: null,
        },
        transaction: activeTransaction,
      });
      if (!created) {
        if (
          record.user_id !== actorUserId
          || record.endpoint !== '/api/admin/shops/:shopId/add-credits'
          || record.method !== 'POST'
          || record.request_hash !== creditRequestHash({ shopId, amount: n, reason })
        ) {
          throw new AppError('The idempotency key was already used for a different credit request.', 409, 'ADMIN_IDEMPOTENCY_CONFLICT');
        }
        if (record.response_data === null || record.response_data === undefined) {
          throw new AppError('The credit request with this idempotency key is still being processed.', 409, 'ADMIN_IDEMPOTENCY_IN_PROGRESS');
        }
        return record.response_data;
      }
      idempotencyRecord = record;
    }

    const findOptions = { where: { shop_id: shopId }, attributes: ['topup_balance'] };
    if (activeTransaction) findOptions.transaction = activeTransaction;
    const beforeSub = await Subscription.findOne(findOptions);
    if (!beforeSub) throw new AppError('Subscription not found', 404);
    if (activeTransaction) await subscriptionService.grantBonusConversations(shopId, n, reason, { transaction: activeTransaction });
    else await subscriptionService.grantBonusConversations(shopId, n, reason);
    const afterSub = await Subscription.findOne(findOptions);
    const result = {
      before: { topup_balance: beforeSub?.topup_balance ?? null },
      after: { topup_balance: afterSub?.topup_balance ?? null, granted: n },
    };
    if (idempotencyRecord) await idempotencyRecord.update({ response_data: result, status_code: 200 }, { transaction: activeTransaction });
    return result;
  };

  if (transaction || !key) return execute(transaction);
  const { sequelize } = require('../../utils/database/database-setup');
  return sequelize.transaction(execute);
}

async function changePlan(shopId, adminUserId, planData, { transaction = null } = {}) {
  const findOptions = { where: { shop_id: shopId }, attributes: ['plan_name', 'plan_code'] };
  if (transaction) findOptions.transaction = transaction;
  const sub = await Subscription.findOne(findOptions);
  const before = { plan_name: sub?.plan_name, plan_code: sub?.plan_code };
  const updated = await subscriptionService.updatePlan(shopId, adminUserId, planData, {
    transaction,
    skipShopAccess: true,
  });
  return { before, after: { plan_name: updated?.plan_name ?? planData.plan_name, plan_code: planData.plan_code } };
}

async function markChannelReconnect(shopId, channelId, { transaction = null } = {}) {
  const channels = transaction
    ? await metaChannelService.listByShop(shopId, { transaction })
    : await metaChannelService.listByShop(shopId);
  const ch = channels.find((candidate) => (
    String(candidate.id) === String(channelId)
    && (candidate.shop_id === undefined
      || candidate.shop_id === null
      || String(candidate.shop_id) === String(shopId))
  ));
  if (!ch) throw new AppError('Channel not found for this shop', 404);
  const before = { status: ch.status };
  if (transaction) {
    await metaChannelService.updateStatus(
      channelId,
      'TOKEN_EXPIRED',
      'Reconnect requested by admin',
      { transaction, shopId },
    );
  } else {
    await metaChannelService.updateStatus(channelId, 'TOKEN_EXPIRED', 'Reconnect requested by admin');
  }
  return { before, after: { status: 'TOKEN_EXPIRED' } };
}

/**
 * EMERGENCY: hard-stop a shop's AI through the business-level source of truth.
 * Delegates to the same emergency-stop transaction as the merchant path with
 * source='admin' (flag + snapshot + MANUAL belt + audit). Channel-level
 * reply-mode writes are intentionally not part of this path.
 */
async function emergencyDisableAi(shopId, adminUserId, { transaction = null } = {}) {
  const currentSettings = transaction
    ? await shopService.getShopAiSettings(shopId, { transaction })
    : await shopService.getShopAiSettings(shopId);
  const before = { automation_mode: currentSettings?.automation_mode ?? null };
  const emergencyStop = await shopService.engageAiEmergencyStop(shopId, adminUserId, {
    source: 'admin',
    transaction,
  });
  return {
    before,
    after: { automation_mode: AI_REPLY_MODES.MANUAL },
    emergency_stop: emergencyStop,
  };
}

/**
 * Platform-admin resume. Clears any source; the mode stays MANUAL.
 */
async function resumeAiEmergencyStop(shopId, adminUserId, { transaction = null } = {}) {
  return shopService.resumeAiEmergencyStop(shopId, adminUserId, {
    source: 'admin',
    transaction,
  });
}

const DIAGNOSTIC_WINDOWS_HOURS = Object.freeze({
  '24h': 24,
  '7d': 24 * 7,
});

function aggregateGroupedCounts(rows, keyField) {
  const byKey = {};
  let total = 0;
  for (const row of (rows || [])) {
    const rawKey = row?.[keyField];
    const key = rawKey === null || rawKey === undefined || rawKey === '' ? 'unknown' : String(rawKey);
    const count = Number(row?.count ?? 0) || 0;
    byKey[key] = (byKey[key] || 0) + count;
    total += count;
  }
  return { total, byKey };
}

/**
 * Read-only, aggregate-only operational diagnostics for one shop.
 * Deliberately returns ZERO PII, PSIDs, tokens, customer identifiers, or raw messages.
 */
async function getShopDiagnostics(shopId, windowParam = '24h') {
  const rawWindow = windowParam === undefined || windowParam === null || windowParam === ''
    ? '24h'
    : String(windowParam).trim().toLowerCase();
  const windowHours = DIAGNOSTIC_WINDOWS_HOURS[rawWindow];
  if (!windowHours) {
    throw new AppError('Invalid diagnostics window. Use 24h or 7d.', 400, 'INVALID_DIAGNOSTICS_WINDOW');
  }

  const shop = await Shop.findByPk(shopId, {
    // ai_emergency_stop is the authoritative bypass-proof stop flag (dedicated
    // shops column, ADR-0013 §6) — NOT the legacy settings-JSON blob. Omitting
    // it here made readEmergencyStopState() see undefined and report
    // emergencyStopActive=false even while the stop was engaged (WP-05).
    attributes: ['id', 'is_active', 'settings', 'ai_emergency_stop'],
  });
  if (!shop) throw new AppError('Shop not found', 404, 'SHOP_NOT_FOUND');

  const since = new Date(Date.now() - windowHours * 60 * 60 * 1000);
  const entities = require('../entities');
  const ConversationModel = entities.Conversation;
  const CourierDispatchModel = entities.CourierDispatch;
  let MetaWebhookReceiptModel = null;
  try {
    MetaWebhookReceiptModel = require('../integration/meta-webhook-receipt.entity');
  } catch (_) {
    MetaWebhookReceiptModel = null;
  }

  let settings = shop.settings;
  if (typeof settings === 'string') {
    try { settings = JSON.parse(settings); } catch (_) { settings = {}; }
  }
  const emergencyStop = readEmergencyStopState(shop);
  const aiModeRaw = settings?.ai?.automation_mode;

  const [
    channelRows,
    webhookStatusRows,
    webhookTypeRows,
    aiMessageRows,
    orderRows,
    dispatchRows,
  ] = await Promise.all([
    typeof MetaChannel?.findAll === 'function'
      ? MetaChannel.findAll({
        where: { shop_id: shopId },
        attributes: ['id', 'status', 'token_expires_at'],
        raw: true,
      })
      : Promise.resolve([]),
    typeof MetaWebhookReceiptModel?.findAll === 'function'
      ? MetaWebhookReceiptModel.findAll({
        where: { shop_id: shopId, received_at: { [Op.gte]: since } },
        attributes: ['status', [fn('COUNT', col('id')), 'count']],
        group: ['status'],
        raw: true,
      })
      : Promise.resolve([]),
    typeof MetaWebhookReceiptModel?.findAll === 'function'
      ? MetaWebhookReceiptModel.findAll({
        where: { shop_id: shopId, received_at: { [Op.gte]: since } },
        attributes: ['event_type', [fn('COUNT', col('id')), 'count']],
        group: ['event_type'],
        raw: true,
      })
      : Promise.resolve([]),
    typeof Message?.findAll === 'function' && ConversationModel
      ? Message.findAll({
        where: { sender: 'ai', created_at: { [Op.gte]: since } },
        attributes: ['delivery_state', [fn('COUNT', col('Message.id')), 'count']],
        include: [{
          model: ConversationModel,
          as: 'conversation',
          attributes: [],
          required: true,
          where: { shop_id: shopId },
        }],
        group: ['delivery_state'],
        raw: true,
      })
      : Promise.resolve([]),
    typeof Order?.findAll === 'function'
      ? Order.findAll({
        where: { shop_id: shopId, created_at: { [Op.gte]: since } },
        attributes: ['order_status', [fn('COUNT', col('id')), 'count']],
        group: ['order_status'],
        raw: true,
      })
      : Promise.resolve([]),
    typeof CourierDispatchModel?.findAll === 'function'
      ? CourierDispatchModel.findAll({
        where: { shop_id: shopId, created_at: { [Op.gte]: since } },
        attributes: ['status', [fn('COUNT', col('id')), 'count']],
        group: ['status'],
        raw: true,
      })
      : Promise.resolve([]),
  ]);

  const nowMs = Date.now();
  const channelByStatus = {};
  let connectedChannels = 0;
  let needsReconnectChannels = 0;
  let expiredTokenChannels = 0;
  for (const ch of (channelRows || [])) {
    const st = String(ch.status || 'UNKNOWN');
    channelByStatus[st] = (channelByStatus[st] || 0) + 1;
    if (st === 'CONNECTED') connectedChannels += 1;
    if (st !== 'CONNECTED' && st !== 'DISCONNECTED') needsReconnectChannels += 1;
    if (ch.token_expires_at && new Date(ch.token_expires_at).getTime() <= nowMs) {
      expiredTokenChannels += 1;
    }
  }

  const webhookByStatus = aggregateGroupedCounts(webhookStatusRows, 'status');
  const webhookByEventType = aggregateGroupedCounts(webhookTypeRows, 'event_type');
  const outboundAi = aggregateGroupedCounts(aiMessageRows, 'delivery_state');
  const ordersAgg = aggregateGroupedCounts(orderRows, 'order_status');
  const dispatchesAgg = aggregateGroupedCounts(dispatchRows, 'status');

  return {
    shopId: shop.id,
    isActive: shop.is_active !== false,
    window: rawWindow,
    since: since.toISOString(),
    generatedAt: new Date().toISOString(),
    ai: {
      automationMode: aiModeRaw || AI_REPLY_MODES.MANUAL,
      emergencyStopActive: Boolean(emergencyStop?.active),
    },
    channels: {
      total: (channelRows || []).length,
      connected: connectedChannels,
      needsReconnect: needsReconnectChannels,
      tokenExpired: expiredTokenChannels,
      byStatus: channelByStatus,
    },
    webhooks: {
      total: webhookByStatus.total,
      byStatus: webhookByStatus.byKey,
      byEventType: webhookByEventType.byKey,
    },
    outboundAiMessages: {
      total: outboundAi.total,
      byDeliveryState: outboundAi.byKey,
    },
    orders: {
      total: ordersAgg.total,
      byStatus: ordersAgg.byKey,
    },
    courierDispatches: {
      total: dispatchesAgg.total,
      byStatus: dispatchesAgg.byKey,
    },
  };
}

/**
 * Shadow-confidence aggregate rollup for one shop (WP-09 wiring).
 * Read-only, aggregate-only: delegates to the operator-only rollup service,
 * which runs a READ ONLY transaction with a 2s statement timeout and a
 * 5000-turn cap. Returns ZERO PII, PSIDs, tokens, or raw messages, and is
 * never consulted by the live send/hold gate (confidence_would_hold stays a
 * stored counterfactual).
 */
async function getShopConfidenceRollup(shopId, hoursParam) {
  const rawHours = hoursParam === undefined || hoursParam === null || hoursParam === ''
    ? '24'
    : String(hoursParam).trim();
  if (!/^\d{1,3}$/.test(rawHours)) {
    throw new AppError('Invalid confidence window. Use hours between 1 and 168.', 400, 'INVALID_CONFIDENCE_WINDOW');
  }
  const hours = Number(rawHours);
  if (!Number.isSafeInteger(hours) || hours < 1 || hours > 168) {
    throw new AppError('Invalid confidence window. Use hours between 1 and 168.', 400, 'INVALID_CONFIDENCE_WINDOW');
  }

  const shop = await Shop.findByPk(shopId, { attributes: ['id'] });
  if (!shop) throw new AppError('Shop not found', 404, 'SHOP_NOT_FOUND');

  // Lazy require keeps the rollup's sequelize import out of module load for
  // callers that never touch this endpoint (mirrors reconciliation reads).
  const { getReplyConfidenceRollup } = require('../ai/reply-confidence-rollup.service');
  const report = await getReplyConfidenceRollup(shop.id, hours);
  return { shopId: shop.id, generatedAt: new Date().toISOString(), ...report };
}

/**
 * WP-03 observation qualification for one shop (aggregate-only, zero PII).
 *
 * Reads the shadow-confidence rollup over the contract's widest window (168h,
 * which is what makes the 72h span criterion provable — see the evaluator
 * header), maps the code-visible pilot-authorization proxy, and hands both to
 * the PURE evaluator. The rollup read itself keeps its READ ONLY / 2s / tenant
 * / 5000-cap invariants; this function performs no other data access beyond
 * the shop and pilot-feature existence reads.
 *
 * shadowToLiveViolations=0 is an ARCHITECTURAL-ISOLATION statement, not a
 * runtime counter: shouldHoldForLowConfidence() never reads shadow metadata
 * and live hold sites consume only the legacy router confidence (evidenced by
 * docs/ai/improvement-program/STAGE2_SHADOW_ISOLATION_PROOF.md and
 * confidence-gate.service.js). The contract record names this source honestly.
 */
async function getShopConfidenceQualification(shopId) {
  const shop = await Shop.findByPk(shopId, {
    attributes: ['id', 'is_active', 'ai_emergency_stop'],
  });
  if (!shop) throw new AppError('Shop not found', 404, 'SHOP_NOT_FOUND');

  // Lazy require mirrors getShopConfidenceRollup (keeps sequelize out of
  // module load for callers that never touch this endpoint).
  const { getReplyConfidenceRollup } = require('../ai/reply-confidence-rollup.service');
  const qualification = require('../ai/confidence-qualification.service');

  let rollup = null;
  try {
    rollup = await getReplyConfidenceRollup(shop.id, qualification.QUALIFICATION_WINDOW_HOURS);
  } catch (_) {
    // A failed read is MISSING evidence, not zero evidence: the evaluator
    // maps rollup=null to INSUFFICIENT_EVIDENCE. Never a fabricated pass.
    rollup = null;
  }

  let pilotFeatures = null;
  try {
    const PilotModel = require('../entities').ShopPilotFeatures;
    if (PilotModel && typeof PilotModel.findByPk === 'function') {
      pilotFeatures = await PilotModel.findByPk(shop.id, {
        attributes: ['shop_id', 'customer_intelligence', 'interaction_choices',
          'action_queue', 'knowledge_suggestions', 'ads_studio', 'storefront',
          'ai_reply_shadow_meter', 'order_confidence_mode'],
      });
    }
  } catch (_) {
    pilotFeatures = null; // unresolved enrollment = not authorized (fails closed)
  }

  const shopAuthorized = qualification.computeShopAuthorized({
    shop: { is_active: shop.is_active, ai_emergency_stop: shop.ai_emergency_stop },
    pilotFeatures,
  });

  const verdict = qualification.evaluateQualification({
    rollup,
    shopAuthorized,
    shadowToLiveViolations: 0, // architectural isolation — see function header
    now: new Date(),
  });
  return { shopId: shop.id, generatedAt: new Date().toISOString(), ...verdict };
}

module.exports = {
  // reads
  getDashboard, getMetaIdentityReadiness, listShops, getShopOverview,
  getShopChannels, getShopBilling, getAuditLogs, getShopDiagnostics,
  getShopConfidenceRollup, getShopConfidenceQualification,
  // mutations
  setShopStatus, addCredits, changePlan, markChannelReconnect,
  emergencyDisableAi, resumeAiEmergencyStop,
};
