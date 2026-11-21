'use strict';

const fs = require('node:fs');

/**
 * Meta-shaped E2E harness.
 *
 * `deliver()` puts a signed, Meta-shaped `messages` webhook into the REAL
 * webhook route and returns everything the pipeline produced downstream:
 *
 *     signed webhook  →  meta-webhook.routes (HMAC, rate limit, dispatcher)
 *                     →  meta-webhook-events.handler (receipt, dedup, consent)
 *                     →  Redis / BullMQ  (real queue, real job payload)
 *                     →  message-worker.processMessageJob (real guard chain)
 *                     →  intent-router  (real shop-scoped catalog + FAQ reads)
 *                     →  llm.service    (real provider chain; wire response scripted)
 *                     →  outbound grounding gate (real, unmocked)
 *                     →  policy engine  (real)
 *                     →  MetaMessengerProvider.sendMessage (real)
 *                     →  Graph transport CAPTURE          ← the only Meta stub
 *
 * Queue boundary: the webhook awaits the BullMQ enqueue and records its receipt
 * as recoverable QUEUED before returning. The encrypted replay body remains
 * until worker settlement. The worker is then invoked by draining the jobs
 * the webhook really enqueued in Redis, rather than by racing a live BullMQ
 * Worker process. The job payload, queue round-trip and worker handler are all
 * real; what this does not cover is BullMQ's own scheduler timing, which
 * pipeline-canary.job.js already probes in production.
 * ponytail: drain-and-invoke, swap for a live Worker if scheduler regressions
 * ever become the failure mode.
 */

const crypto = require('crypto');
const express = require('express');
const request = require('supertest');

const grounding = require('../../src/modules/ai/grounding');
const transport = require('./transport');
const fixtures = require('./fixtures');

const WEBHOOK_PATH = '/api/webhooks/meta';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── App under test ───────────────────────────────────────────────────────────

/**
 * The real webhook router, at the real mount path, with no body parser in front
 * of it — the same shape as src/app.js, which deliberately mounts this router
 * above express.json() so the raw body survives for HMAC verification.
 */
const buildWebhookApp = () => {
    const app = express();
    app.use(WEBHOOK_PATH, require('../../src/modules/integration/meta-webhook.routes'));
    return app;
};

let app = null;
const webhookApp = () => (app || (app = buildWebhookApp()));

// ── Meta payload construction ────────────────────────────────────────────────

let midSeq = 0;

/** A Meta `page` webhook envelope carrying one inbound Messenger text message. */
const messagePayload = ({ pageId, psid, text, mid, attachments, quickReply, replyTo, referral }) => ({
    object: 'page',
    entry: [{
        id: String(pageId),
        time: Date.now(),
        messaging: [{
            sender: { id: String(psid) },
            recipient: { id: String(pageId) },
            timestamp: Date.now(),
            message: {
                mid: mid || `m_e2e_${++midSeq}_${Date.now()}`,
                ...(text === undefined ? {} : { text }),
                ...(attachments ? { attachments } : {}),
                ...(quickReply ? { quick_reply: quickReply } : {}),
                ...(replyTo ? { reply_to: replyTo } : {}),
            },
            // P0-02: an m.me / ad referral riding on a real message event.
            ...(referral ? { referral } : {}),
        }],
    }],
});

/**
 * A Meta `page` webhook envelope carrying one quick-reply BUTTON TAP
 * (`messaging.postback`). `payload` is the opaque p1: reference the platform
 * stamped on the outbound button; `mid` deliberately names the SHARED outbound
 * message (Meta semantics) so tests can prove it is NOT the event identity.
 * `referral` optionally mirrors Meta's postback.referral (ref on a tapped
 * message that came through an m.me link).
 */
const postbackPayload = ({ pageId, psid, payload, title, mid, referral }) => ({
    object: 'page',
    entry: [{
        id: String(pageId),
        time: Date.now(),
        messaging: [{
            sender: { id: String(psid) },
            recipient: { id: String(pageId) },
            timestamp: Date.now(),
            postback: {
                title: title || '[Selection]',
                payload,
                mid: mid || `pb_e2e_${++midSeq}_${Date.now()}`,
                ...(referral ? { referral } : {}),
            },
        }],
    }],
});

/**
 * A pure m.me / short-link referral open — `messaging.referral` with no
 * message and no postback. Meta sends these when a customer opens a thread
 * through a referral link.
 */
const referralPayload = ({ pageId, psid, ref, source = 'SHORTLINK', type = 'OPEN_THREAD' }) => ({
    object: 'page',
    entry: [{
        id: String(pageId),
        time: Date.now(),
        messaging: [{
            sender: { id: String(psid) },
            recipient: { id: String(pageId) },
            timestamp: Date.now(),
            referral: { ref, source, type },
        }],
    }],
});

const sign = (raw) => 'sha256=' + crypto
    .createHmac('sha256', process.env.META_APP_SECRET)
    .update(raw)
    .digest('hex');

/**
 * POST a Meta-shaped webhook. `signature` overrides the computed one so tests
 * can prove an unsigned or wrongly-signed payload is rejected.
 */
const postWebhook = async (payload, { signature } = {}) => {
    const raw = JSON.stringify(payload);
    return request(webhookApp())
        .post(WEBHOOK_PATH)
        .set('Content-Type', 'application/json')
        .set('X-Hub-Signature-256', signature === undefined ? sign(raw) : signature)
        .send(raw);
};

// ── Queue drain → worker ─────────────────────────────────────────────────────

const QUEUE_STATES = ['waiting', 'delayed', 'prioritized', 'paused'];

/** Jobs the webhook enqueued, as BullMQ sees them. Used to assert the queue hop. */
const pendingJobs = async () => {
    const { messageQueue } = require('../../src/jobs/message-queue');
    return messageQueue.getJobs(QUEUE_STATES, 0, -1);
};

/** The durable receipt for one Meta message id. */
const receiptForEvent = async (eventId) => {
    const MetaWebhookReceipt = require('../../src/modules/integration/meta-webhook-receipt.entity');
    const deadline = Date.now() + 2000;
    do {
        const receipt = await MetaWebhookReceipt.findOne({ where: { event_id: eventId } });
        if (receipt) return receipt;
        await sleep(25);
    } while (Date.now() < deadline);
    return null;
};

/** All durable receipts in a state, for DLQ and dedup assertions. */
const receiptsWithStatus = async (status) => {
    const MetaWebhookReceipt = require('../../src/modules/integration/meta-webhook-receipt.entity');
    return MetaWebhookReceipt.findAll({ where: { status }, order: [['created_at', 'ASC']] });
};

/**
 * The durable receipt for any messaging element — postbacks and referrals
 * included. Postbacks/referrals carry no `message.mid`, so the receipt service
 * dedupes on the page-scoped payload hash; this mirrors exactly
 * `meta-webhook-receipt.service.scopedDedupeKey`
 * (sha256(`${pageId}|${eventId || sha256(JSON.stringify(messaging))}`))
 * so the test reads back the row the pipeline really wrote, without exporting
 * internals from production code.
 */
const receiptForPayload = async (pageId, messaging, { timeoutMs = 2000 } = {}) => {
    const MetaWebhookReceipt = require('../../src/modules/integration/meta-webhook-receipt.entity');
    const sha = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
    const eventId = messaging.message?.mid || null;
    const dedupeKey = sha(`${String(pageId)}|${eventId || sha(JSON.stringify(messaging))}`);
    const where = eventId
        ? { page_id: String(pageId), event_id: eventId }
        : { page_id: String(pageId), dedupe_key: dedupeKey };
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const receipt = await MetaWebhookReceipt.findOne({ where });
        if (receipt || Date.now() > deadline) return receipt;
        await sleep(25);
    }
};

/**
 * Wait for the queue to reach `count` jobs.
 *
 * The webhook handler awaits Queue.add before acknowledging Meta and marking
 * the receipt recoverable QUEUED. This helper remains useful for direct route assertions and
 * gives BullMQ a bounded visibility check without depending on scheduler timing.
 * Returns whatever is queued when the deadline passes so the caller's own
 * assertion produces the failure message.
 */
const waitForJobs = async (count = 1, { timeoutMs = 8000 } = {}) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const jobs = await pendingJobs();
        if (jobs.length >= count || Date.now() > deadline) return jobs;
        await sleep(25);
    }
};

/**
 * Run every queued job through the real worker handler, oldest first. The queue
 * handoff is complete before the webhook response, so this loop is only a drain
 * helper and does not stand in for durable dispatch.
 */
const drainQueue = async ({ timeoutMs = 8000 } = {}) => {
    const { processMessageJob } = require('../../src/jobs/message-worker');
    const results = [];
    const deadline = Date.now() + timeoutMs;

    for (;;) {
        const jobs = await pendingJobs();
        if (!jobs.length) {
            if (results.length || Date.now() > deadline) break;
            await sleep(25);
            continue;
        }
        jobs.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
        for (const job of jobs) {
            results.push(await processMessageJob(job));
            await job.remove().catch(() => { /* already gone */ });
        }
    }
    return results;
};

/**
 * drainQueue plus the settlement step: after each job, run the SAME
 * `settleInboundReceipts(job)` the production worker's `completed` listener
 * runs (src/jobs/message-worker.js startWorker), moving the durable receipt
 * QUEUED → PROCESSED. Used by the P0-01 postback acceptance scenarios; the
 * plain `drainQueue`/`deliver` pair stays QUEUED on purpose, because half the
 * existing suite asserts exactly that queue-handoff state.
 */
const drainAndSettle = async ({ timeoutMs = 8000 } = {}) => {
    const { processMessageJob, _private } = require('../../src/jobs/message-worker');
    const results = [];
    const deadline = Date.now() + timeoutMs;

    for (;;) {
        const jobs = await pendingJobs();
        if (!jobs.length) {
            if (results.length || Date.now() > deadline) break;
            await sleep(25);
            continue;
        }
        jobs.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
        for (const job of jobs) {
            results.push(await processMessageJob(job));
            await _private.settleInboundReceipts(job);
            await job.remove().catch(() => { /* already gone */ });
        }
    }
    return results;
};

// ── Grounding observation ────────────────────────────────────────────────────
//
// The gate itself is never mocked. This wraps the decision LOG so a test can
// read the correlation record the worker really emitted — decision, reasonCode,
// productStatus, mediaStatus, verifiedProductIds, mediaProductId, knowledgeIds,
// violations, provider — which is the internal evidence the trust boundary
// document says every reply must carry.

let groundingDecisions = [];
const deliveryDiagnostics = [];
let restoreGroundingObserver = null;
const SAFE_VIOLATION_CODES = new Set([
    'unsupported_product_identity',
    'unsourced_variant_availability',
    'unsupported_payment_destination',
    'unsupported_payment_method',
    'model_order_confirmation_claim',
    'model_payment_confirmation_claim',
    'unsupported_delivery_timeline',
    'unsupported_delivery_commitment',
    'empty_or_non_string_candidate',
    'attachment_provenance_rejected',
    'catalog_unreadable',
    'availability_asserted_for_absent_product',
    'unsupported_stock_claim',
    'unsupported_price',
    'unsupported_url',
    'attribute_asserted_but_unknown',
]);

const installGroundingObserver = () => {
    const real = grounding.logGroundingDecision;
    grounding.logGroundingDecision = (params) => {
        const payload = real(params);
        groundingDecisions.push(payload);
        return payload;
    };
    restoreGroundingObserver = () => { grounding.logGroundingDecision = real; };
};

/** Every grounding decision emitted so far, oldest first. */
const decisions = () => [...groundingDecisions];

/** The decision for the most recent turn. */
const lastDecision = () => groundingDecisions[groundingDecisions.length - 1] || null;

// ── Persisted state ──────────────────────────────────────────────────────────

const conversationFor = async (shopId) => {
    const { Conversation } = require('../../src/modules/conversation/conversation.entity');
    return Conversation.findOne({ where: { shop_id: shopId }, order: [['created_at', 'DESC']] });
};

const messagesFor = async (conversationId) => {
    const { Message } = require('../../src/modules/conversation/conversation.entity');
    return Message.findAll({ where: { conversation_id: conversationId }, order: [['created_at', 'ASC']] });
};

/**
 * The AI reply row stored for the most recent turn, with its grounding stamps.
 *
 * Prefers the newest AI row that actually carries a grounding decision: on a
 * handoff the worker also stores EasyModerator's templated holding message,
 * which is written copy and carries no grounding metadata.
 */
const lastStoredAiMessage = async (shopId) => {
    const conversation = await conversationFor(shopId);
    if (!conversation) return null;
    const aiRows = (await messagesFor(conversation.id)).filter((m) => m.sender === 'ai').reverse();
    return aiRows.find((m) => m.metadata?.grounding_decision) || aiRows[0] || null;
};

/**
 * Insert an assistant turn directly into a conversation — used to reproduce an
 * earlier ungrounded statement and prove it cannot become evidence.
 */
const injectAssistantMessage = async (conversationId, content, sourceReferences = null) => {
    const { Message } = require('../../src/modules/conversation/conversation.entity');
    return Message.create({
        conversation_id: conversationId,
        content,
        sender: 'ai',
        external_id: null,
        source_references: sourceReferences,
        metadata: { type: 'ai_response', injected_by: 'meta-e2e' },
    });
};

/**
 * Set the business-level reply mode for one disposable E2E shop. This bypasses
 * the HTTP settings contract deliberately: the mode API has its own unit/API
 * coverage, while these tests need to isolate the worker's send boundary.
 */
const setBusinessReplyMode = async (shopId, mode) => {
    const { Shop } = require('../../src/modules/entities');
    const shop = await Shop.findByPk(shopId);
    if (!shop) throw new Error(`meta-e2e: shop ${shopId} not found`);

    const settings = shop.settings && typeof shop.settings === 'object' ? shop.settings : {};
    const ai = settings.ai && typeof settings.ai === 'object' ? settings.ai : {};
    await shop.update({
        settings: {
            ...settings,
            ai: {
                ...ai,
                automation_mode: mode,
                auto_reply_enabled: mode === 'AUTO',
            },
        },
    });
};

/** Resolve through the same service boundary used by the Inbox controller. */
const resolveConversation = async ({ shopId, lastSeenMessageId } = {}) => {
    const conversation = await conversationFor(shopId);
    if (!conversation) throw new Error(`meta-e2e: no conversation for shop ${shopId}`);
    const conversationService = require('../../src/modules/conversation/conversation.service');
    return conversationService.updateConversation(conversation.id, shopId, {
        status: 'closed',
        last_seen_message_id: lastSeenMessageId,
    });
};

/**
 * Send one explicit merchant reply through the real Shared Inbox delivery
 * helper. The provider transport remains captured by transport.js.
 */
const sendAgentReply = async ({ shopId, content }) => {
    const { Message } = require('../../src/modules/conversation/conversation.entity');
    const conversation = await conversationFor(shopId);
    if (!conversation) throw new Error(`meta-e2e: no conversation for shop ${shopId}`);

    const message = await Message.create({
        conversation_id: conversation.id,
        content,
        sender: 'business',
        external_id: null,
        metadata: { message_type: 'text', delivery_status: 'pending' },
    });
    const controller = require('../../src/modules/conversation/conversation.controller');
    const sendsBefore = transport.capturedSends().length;
    await controller._deliverViaMetaIfApplicable(
        conversation.id,
        shopId,
        message,
        'agent',
    );

    return {
        message,
        sends: transport.capturedSends().slice(sendsBefore),
    };
};

// ── The main entry point ─────────────────────────────────────────────────────

/**
 * Deliver one customer message end to end.
 *
 * @param {object}  params
 * @param {string}  params.text        - the customer's message
 * @param {string} [params.candidate]  - scripted model output for this turn
 *                                       (string, Error, or per-provider map)
 * @param {string} [params.pageId]     - defaults to the Shop A tester Page
 * @param {string} [params.psid]       - defaults to the E2E customer PSID
 * @param {string} [params.mid]        - Meta message id, for redelivery tests
 * @param {object} [params.quickReply] - Meta Messenger quick-reply payload
 * @param {object} [params.replyTo]    - Meta Messenger reply_to payload
 * @param {object} [params.postback]   - { payload, title, mid, referral } — deliver a
 *                                       quick-reply button tap instead of a text message
 * @param {object} [params.referral]   - { ref, source, type } — with `text` it rides on the
 *                                       message; alone it is a pure m.me referral open
 * @param {boolean} [params.drain]     - false skips the queue drain (a pure referral
 *                                       never enqueues; the handler settles its receipt inline)
 * @returns {Promise<{status:number, eventId:string, receipt:object|null,
 *                    jobResults:object[], sends:object[], decision:object|null}>}
 */
const deliver = async ({
    text,
    candidate,
    pageId = fixtures.IDS.pageA,
    psid = fixtures.CUSTOMER_PSID,
    mid,
    attachments,
    quickReply,
    replyTo,
    postback,
    referral,
    drain = true,
} = {}) => {
    if (candidate !== undefined) transport.setCandidate(candidate);

    const sendsBefore = transport.capturedSends().length;
    const decisionsBefore = groundingDecisions.length;
    const providersBefore = transport.llmProvidersCalled().length;

    const payload = postback
        ? postbackPayload({ pageId, psid, ...postback })
        : (referral && !text)
            ? referralPayload({ pageId, psid, ...referral })
            : messagePayload({ pageId, psid, text, mid, attachments, quickReply, replyTo, referral });
    const messaging = payload.entry[0].messaging[0];
    // Postbacks/referrals have no message.mid — their durable identity is the
    // page-scoped payload hash, which is exactly what the test must read back.
    const eventId = messaging.message?.mid || null;
    const response = await postWebhook(payload);
    const jobResults = drain ? await drainQueue() : [];

    // A pure referral never enqueues a job, but its receipt is terminal
    // (PROCESSED/SKIPPED) before the webhook responds — the drain's own wait
    // would only add latency, so receiptForPayload's poll covers visibility.

    // Scoped to THIS delivery: a turn that produced no grounding decision must
    // report null rather than silently re-asserting the previous turn's.
    const turnDecisions = groundingDecisions.slice(decisionsBefore);

    const result = {
        status: response.status,
        eventId,
        messaging,
        receipt: eventId
            ? await receiptForEvent(eventId)
            : await receiptForPayload(pageId, messaging),
        jobResults,
        sends: transport.capturedSends().slice(sendsBefore),
        decision: turnDecisions[turnDecisions.length - 1] || null,
        decisions: turnDecisions,
    };

    const decision = result.decision;
    const safeEnum = (value) => typeof value === 'string' && /^[A-Z][A-Z0-9_-]{0,63}$/.test(value)
        ? value
        : null;
    const safeId = (value) => typeof value === 'string' && /^[\w-]{1,80}$/.test(value)
        ? value
        : null;
    const testName = global.expect?.getState?.().currentTestName;
    const caseId = typeof testName === 'string'
        ? crypto.createHash('sha256').update(testName).digest('hex').slice(0, 16)
        : null;
    const safeViolationCode = (value) => {
        if (typeof value !== 'string') return null;
        const code = value.split(':', 1)[0];
        return SAFE_VIOLATION_CODES.has(code) ? code : null;
    };
    deliveryDiagnostics.push({
        sequence: deliveryDiagnostics.length + 1,
        caseId,
        status: Number.isInteger(result.status) ? result.status : null,
        receiptStatus: safeEnum(result.receipt?.status),
        worker: result.jobResults.map((job) => ({
            success: typeof job?.success === 'boolean' ? job.success : null,
            sent: typeof job?.sent === 'boolean' ? job.sent : null,
            reason: safeId(job?.reason),
        })),
        decision: decision ? {
            decision: safeEnum(decision.decision),
            reasonCode: safeEnum(decision.reasonCode),
            productStatus: safeEnum(decision.productStatus),
            mediaStatus: safeEnum(decision.mediaStatus),
            verifiedProductIds: (decision.verifiedProductIds || []).map(safeId).filter(Boolean),
            mediaProductId: safeId(decision.mediaProductId),
            knowledgeIds: (decision.knowledgeIds || []).map(safeId).filter(Boolean),
            violationCodes: [...new Set((decision.violations || [])
                .map(safeViolationCode).filter(Boolean))],
            provider: safeId(decision.provider),
        } : null,
        sendCount: result.sends.length,
        providerCalls: transport.llmProvidersCalled().slice(providersBefore),
    });
    return result;
};

// ── Assertion helpers ────────────────────────────────────────────────────────

/** Text bodies in the captured Graph sends. */
const sentTexts = (sends) => sends.map((b) => b?.message?.text).filter(Boolean);

/** Attachment payloads in the captured Graph sends. */
const sentAttachments = (sends) => sends
    .map((b) => b?.message?.attachment)
    .filter(Boolean);

/** Every attachment URL that would have reached Meta. */
const sentAttachmentUrls = (sends) => sentAttachments(sends)
    .map((a) => a?.payload?.url)
    .filter(Boolean);

/** The concatenation of everything the customer would have received. */
const sentBody = (sends) => [
    ...sentTexts(sends),
    ...sentAttachmentUrls(sends),
].join('\n');

// ── Lifecycle ────────────────────────────────────────────────────────────────

let restoreMeta = null;
let restoreLlm = null;

const setupSuite = async () => {
    restoreMeta = transport.installMetaTransport();
    restoreLlm = transport.installLlmTransport();
    installGroundingObserver();
    await fixtures.syncSchema();
};

const deleteMatchingKeys = async (redis, patterns) => {
    if (!redis || typeof redis.scan !== 'function') return;

    for (const pattern of patterns) {
        let cursor = '0';
        do {
            const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
            if (keys.length > 0) await redis.del(...keys);
            cursor = nextCursor;
        } while (cursor !== '0');
    }
};

const removeQueuedTestJobs = async (messageQueue) => {
    const states = ['waiting', 'delayed', 'prioritized', 'paused', 'completed', 'failed'];
    const jobs = await messageQueue.getJobs(states, 0, -1);
    await Promise.all(jobs.map((job) => job.remove().catch(() => {})));
};

/** Clear only test-owned key/job families; never flush a Redis database. */
const resetRun = async () => {
    const { cacheRedis, rateLimitRedis } = require('../../src/config/redis');
    const { messageQueue } = require('../../src/jobs/message-queue');

    await removeQueuedTestJobs(messageQueue);
    await deleteMatchingKeys(cacheRedis, [
        'burst:*',
        'msg:dedup:*',
        'ai:pause:*',
        'holding:*',
        'cb:*',
        'canary:*',
        // The provider send-window counters (rateLimit.rule via cacheRedis).
        // CI's fresh containers hid this, but re-running the suite twice
        // within one hour on a persistent local Redis accumulates past the
        // 170/hr page cap and every subsequent turn defers into moveToDelayed.
        'meta:sends:*',
    ]);
    await deleteMatchingKeys(rateLimitRedis, ['rl:webhook:*']);

    await fixtures.truncateAll();
    await fixtures.seed();

    transport.resetTransports();
    groundingDecisions = [];
};

const teardownSuite = async () => {
    const { sequelize } = require('../../src/utils/database/database-setup');
    const { messageQueue } = require('../../src/jobs/message-queue');
    const redis = require('../../src/config/redis');

    try {
        if (process.env.META_E2E_DIAGNOSTICS_PATH) {
            fs.writeFileSync(
                process.env.META_E2E_DIAGNOSTICS_PATH,
                `${JSON.stringify(deliveryDiagnostics, null, 2)}\n`,
                { encoding: 'utf8', flag: 'wx', mode: 0o600 },
            );
        }
    } finally {
        for (const restore of [restoreGroundingObserver, restoreMeta, restoreLlm]) {
            try { if (restore) restore(); } catch (_) { /* always continue resource cleanup */ }
        }
        await messageQueue.close().catch(() => {});
        await sequelize.close().catch(() => {});
        if (typeof redis.closeAllRedis === 'function') await redis.closeAllRedis().catch(() => {});
    }
};

module.exports = {
    // pipeline
    deliver,
    postWebhook,
    messagePayload,
    postbackPayload,
    referralPayload,
    sign,
    drainQueue,
    drainAndSettle,
    pendingJobs,
    waitForJobs,
    receiptForEvent,
    receiptForPayload,
    receiptsWithStatus,
    // evidence
    decisions,
    lastDecision,
    lastStoredAiMessage,
    conversationFor,
    messagesFor,
    injectAssistantMessage,
    setBusinessReplyMode,
    resolveConversation,
    sendAgentReply,
    // captured outbound
    sentTexts,
    sentAttachments,
    sentAttachmentUrls,
    sentBody,
    // lifecycle
    setupSuite,
    resetRun,
    teardownSuite,
    WEBHOOK_PATH,
};
