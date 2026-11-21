'use strict';

const { Op } = require('sequelize');
const {
    MetaChannel,
    Product,
    FaqResponse,
    Message,
    Conversation,
    InboxDeliveryOutbox,
} = require('../entities');
const shopService = require('../shop/shop.service');
const { AI_REPLY_MODES, normalizeAiReplyMode } = require('../shop/ai-reply-mode');
const { MESSAGE_DELIVERY_STATES } = require('../conversation/message-lifecycle');

const TASK_KEYS = Object.freeze({
    CONNECT_CHANNEL: 'connect_channel',
    SHOP_PROFILE: 'shop_profile',
    FIRST_PRODUCT: 'first_product',
    AI_SETTINGS: 'ai_settings',
});

/**
 * P04 — configuration is not operation. A shop becomes CONFIGURED when every
 * setup task is filled in; it only becomes VERIFIED_OPERATIONAL when existing
 * operational records (webhook verification, an approved draft, a provider
 * acceptance) prove a real reply actually reached Messenger. The states below
 * are merchant-facing; none of them is ever inferred from settings defaults.
 */
const OPERATIONAL_STATES = Object.freeze({
    CONFIGURED: 'configured',
    WAITING_FOR_TEST: 'waiting_for_test',
    ACTION_REQUIRED: 'action_required',
    VERIFIED_OPERATIONAL: 'verified_operational',
});

// Operational proof is only valid while it is fresh. A webhook verification or
// a provider-accepted reply older than this window is real history, not current
// proof — the shop drops back to waiting_for_test until a new test lands.
const OPERATIONAL_EVIDENCE_WINDOW_DAYS = 30;

// A draft counts as generated once generation finished. SEND_PENDING/SENT/
// DELIVERED rows imply an earlier DRAFT_READY, so "generated" counts everything
// that got past generation. GENERATING is deliberately excluded: it is not a
// draft yet.
const DRAFT_GENERATED_STATES = Object.freeze([
    MESSAGE_DELIVERY_STATES.DRAFT_READY,
    MESSAGE_DELIVERY_STATES.SEND_PENDING,
    MESSAGE_DELIVERY_STATES.SENT,
    MESSAGE_DELIVERY_STATES.DELIVERED,
]);

// delivery_source='DRAFT_APPROVAL' is only written by the merchant approval
// flow (conversation.service), so these rows are real approvals. FAILED is
// kept here as an approval whose delivery broke; the operational ladder below
// classifies it under action_required.
const APPROVED_DELIVERY_STATES = Object.freeze([
    MESSAGE_DELIVERY_STATES.SEND_PENDING,
    MESSAGE_DELIVERY_STATES.SENT,
    MESSAGE_DELIVERY_STATES.DELIVERED,
    MESSAGE_DELIVERY_STATES.FAILED,
]);

// Messenger never receives a DELIVERED transition (the subscription is
// ["messages"] only), so the strongest provider evidence is SENT + a stored
// provider_message_id — exactly what isProviderConfirmed() in
// message-lifecycle.js requires. Rows without provider_message_id are never
// counted as accepted, mirroring normalizeDeliveryState()'s HELD downgrade.
const PROVIDER_ACCEPTED_STATES = Object.freeze([
    MESSAGE_DELIVERY_STATES.SENT,
    MESSAGE_DELIVERY_STATES.DELIVERED,
]);

const TASK_DEFINITIONS = Object.freeze({
    [TASK_KEYS.CONNECT_CHANNEL]: {
        title: 'Connect Facebook Page',
        description: 'Connect at least one Facebook page so EasyModerator can receive and reply to customer messages.',
        ctaLabel: 'Manage channel',
        href: '/manage-shop/chat-settings',
    },
    [TASK_KEYS.SHOP_PROFILE]: {
        title: 'Complete shop profile',
        description: 'Add the basic shop name, support contact, delivery info, and payment methods customers need.',
        ctaLabel: 'Edit profile',
        href: '/manage-shop/business-info',
    },
    [TASK_KEYS.FIRST_PRODUCT]: {
        title: 'Add first product',
        description: 'Publish at least one active product. Three or more products are recommended before launch.',
        ctaLabel: 'Add product',
        href: '/products/add',
    },
    [TASK_KEYS.AI_SETTINGS]: {
        title: 'Configure AI reply settings',
        description: 'Keep AI replies in draft mode with a confidence threshold until the shop is ready for automation.',
        ctaLabel: 'Review AI settings',
        href: '/manage-shop/business-info',
    },
});

function normalizeObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizeArray(value) {
    return Array.isArray(value) ? value : [];
}

function hasText(value) {
    return typeof value === 'string' && value.trim().length > 0;
}

function hasAnyText(values) {
    return values.some(hasText);
}

function isoOrNull(value) {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function buildTask(key, complete, details = {}) {
    const definition = TASK_DEFINITIONS[key];
    return {
        key,
        title: definition.title,
        description: definition.description,
        status: complete ? 'complete' : 'incomplete',
        required: true,
        ctaLabel: definition.ctaLabel,
        href: definition.href,
        missing: details.missing || [],
        warnings: details.warnings || [],
        meta: details.meta || {},
    };
}

function assessShopProfile(shop, businessInfo, aiSettings) {
    const missing = [];
    const deliveryAreas = normalizeArray(businessInfo.deliveryAreas);
    const businessPaymentMethods = normalizeArray(businessInfo.paymentMethods);
    const aiPaymentMethods = normalizeArray(aiSettings.payment_methods);

    if (!hasAnyText([businessInfo.shopName, shop.shop_name, shop.name])) {
        missing.push('shop_name');
    }

    if (!hasAnyText([businessInfo.phone, businessInfo.email, businessInfo.supportEmail, shop.phone])) {
        missing.push('support_contact');
    }

    if (deliveryAreas.length === 0 && !hasAnyText([businessInfo.address, businessInfo.openingHours])) {
        missing.push('delivery_info');
    }

    if (businessPaymentMethods.length === 0 && aiPaymentMethods.length === 0) {
        missing.push('payment_methods');
    }

    return {
        complete: missing.length === 0,
        missing,
    };
}

function assessAiSettings(aiSettings) {
    const missing = [];
    const warnings = [];
    const hasAutomationMode = hasText(aiSettings.automation_mode);
    const automationMode = hasAutomationMode
        ? normalizeAiReplyMode(aiSettings.automation_mode)
        : null;
    const confidenceThreshold = Number(aiSettings.confidence_threshold);

    if (!hasAutomationMode) {
        missing.push('automation_mode');
    }

    if (!Number.isFinite(confidenceThreshold)) {
        missing.push('confidence_threshold');
    }

    if (automationMode === AI_REPLY_MODES.AUTO) {
        warnings.push({
            code: 'AI_AUTO_ENABLED',
            message: 'Automatic replies are enabled; verify the shop setup and safety gates before launch.',
        });
    }

    return {
        complete: missing.length === 0,
        missing,
        warnings,
        automationMode,
    };
}

/**
 * Operational messages live under conversations, so every evidence query joins
 * messages → conversations and pins the tenant. A missing/foreign conversation
 * can therefore never contribute evidence to this shop (fail-closed).
 */
function messageEvidenceScope(shopId) {
    return {
        include: [{
            model: Conversation,
            as: 'conversation',
            required: true,
            attributes: [],
            where: { shop_id: shopId },
        }],
    };
}

/**
 * A provider-accepted reply that counts toward OPERATIONAL truth must be a
 * real merchant-approved send on the SAME row (A5-1): delivery_source
 * 'DRAFT_APPROVAL' (only the approval flow writes it), SENT/DELIVERED, and a
 * non-empty provider_message_id. AUTO and HITL_ESCALATION sends are excluded —
 * verified_operational can never light up from a reply nobody approved. The
 * P05 launch contract runs DRAFT + approval (AUTO is not enabled), so this
 * matches the intended contract and the FE copy.
 */
function providerAcceptedWhere(shopId, extra = {}) {
    return {
        where: {
            sender: 'ai',
            delivery_source: 'DRAFT_APPROVAL',
            delivery_state: { [Op.in]: PROVIDER_ACCEPTED_STATES },
            provider_message_id: { [Op.and]: [{ [Op.ne]: null }, { [Op.ne]: '' }] },
            ...extra,
        },
        ...messageEvidenceScope(shopId),
    };
}

async function getSetupStatus({ shopId, userId }) {
    const shop = await shopService.getShopById(shopId, userId);
    const settings = normalizeObject(shop.settings);
    const businessInfo = normalizeObject(settings.businessInfo);
    const evidenceWindowStart = new Date(
        Date.now() - OPERATIONAL_EVIDENCE_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    );

    // Deliberately no `.catch(() => 0)` on any evidence query: a database or
    // schema failure must surface as a status error the UI retries, never as a
    // silent zero that fabricates (or erases) a verification claim.
    const [
        aiSettings,
        connectedFacebookPages,
        webhookVerifiedFacebookPages,
        webhookRecentlyVerifiedFacebookPages,
        mostRecentWebhookVerification,
        activeProducts,
        activeFaqs,
        draftsGenerated,
        draftsApproved,
        aiMessagesAcceptedEver,
        aiMessagesAcceptedRecently,
        latestAcceptedAiMessage,
        failedApprovedSends,
        stuckOutboxDeliveries,
    ] = await Promise.all([
        shopService.getShopAiSettings(shopId),
        MetaChannel.count({
            where: { shop_id: shopId, platform: 'facebook', status: 'CONNECTED' },
        }),
        MetaChannel.count({
            where: {
                shop_id: shopId,
                platform: 'facebook',
                status: 'CONNECTED',
                webhook_last_verified_at: { [Op.ne]: null },
            },
        }),
        MetaChannel.count({
            where: {
                shop_id: shopId,
                platform: 'facebook',
                status: 'CONNECTED',
                webhook_last_verified_at: { [Op.gte]: evidenceWindowStart },
            },
        }),
        MetaChannel.findOne({
            where: {
                shop_id: shopId,
                platform: 'facebook',
                status: 'CONNECTED',
                webhook_last_verified_at: { [Op.ne]: null },
            },
            attributes: ['webhook_last_verified_at'],
            order: [['webhook_last_verified_at', 'DESC']],
        }),
        Product.count({
            where: { shop_id: shopId, is_active: true },
        }),
        FaqResponse.count({
            where: { shop_id: shopId, is_active: true },
        }),
        Message.count({
            where: {
                sender: 'ai',
                delivery_state: { [Op.in]: DRAFT_GENERATED_STATES },
            },
            ...messageEvidenceScope(shopId),
        }),
        Message.count({
            where: {
                sender: 'ai',
                delivery_source: 'DRAFT_APPROVAL',
                delivery_state: { [Op.in]: APPROVED_DELIVERY_STATES },
            },
            ...messageEvidenceScope(shopId),
        }),
        Message.count(providerAcceptedWhere(shopId)),
        Message.count(providerAcceptedWhere(shopId, { created_at: { [Op.gte]: evidenceWindowStart } })),
        Message.findOne({
            ...providerAcceptedWhere(shopId),
            attributes: ['created_at'],
            order: [['created_at', 'DESC']],
        }),
        // Failures are windowed like positive evidence (A5-3): a single
        // historical FAILED approved send must not pin action_required
        // forever — a fresh verified test re-earns verified_operational.
        Message.count({
            where: {
                sender: 'ai',
                delivery_source: 'DRAFT_APPROVAL',
                delivery_state: MESSAGE_DELIVERY_STATES.FAILED,
                created_at: { [Op.gte]: evidenceWindowStart },
            },
            ...messageEvidenceScope(shopId),
        }),
        // NEEDS_RECONCILIATION is a CURRENT unresolved state (settled rows
        // leave it), so it stays unwindowed: an unresolved stuck delivery is
        // action_required no matter when it started. Fail-closed direction.
        InboxDeliveryOutbox.count({
            where: { shop_id: shopId, status: 'NEEDS_RECONCILIATION' },
        }),
    ]);

    const normalizedAiSettings = normalizeObject(aiSettings);
    const shopProfile = assessShopProfile(shop, businessInfo, normalizedAiSettings);
    const aiSettingsStatus = assessAiSettings(normalizedAiSettings);

    const connectedChannelWarnings = [];
    if (connectedFacebookPages > 0 && webhookVerifiedFacebookPages === 0) {
        connectedChannelWarnings.push({
            code: 'WEBHOOK_NOT_VERIFIED',
            message: 'No webhook verification was found for the connected page. Send a test message before launch.',
        });
    } else if (connectedFacebookPages > 0 && webhookRecentlyVerifiedFacebookPages === 0) {
        connectedChannelWarnings.push({
            code: 'WEBHOOK_VERIFICATION_STALE',
            message: `The most recent webhook verification is older than ${OPERATIONAL_EVIDENCE_WINDOW_DAYS} days. Re-run the channel webhook check before launch.`,
        });
    }

    const tasks = [
        buildTask(TASK_KEYS.CONNECT_CHANNEL, connectedFacebookPages > 0, {
            warnings: connectedChannelWarnings,
            meta: {
                connectedFacebookPages,
                webhookVerifiedFacebookPages,
                webhookRecentlyVerifiedFacebookPages,
            },
        }),
        buildTask(TASK_KEYS.SHOP_PROFILE, shopProfile.complete, {
            missing: shopProfile.missing,
        }),
        buildTask(TASK_KEYS.FIRST_PRODUCT, activeProducts > 0, {
            warnings: activeProducts > 0 && activeProducts < 3
                ? [{
                    code: 'LOW_PRODUCT_COUNT',
                    message: 'Three or more active products are recommended before launch.',
                }]
                : [],
            meta: { activeProducts },
        }),
        buildTask(TASK_KEYS.AI_SETTINGS, aiSettingsStatus.complete, {
            missing: aiSettingsStatus.missing,
            warnings: aiSettingsStatus.warnings,
            meta: {
                automationMode: aiSettingsStatus.automationMode,
                confidenceThreshold: normalizedAiSettings.confidence_threshold ?? null,
            },
        }),
    ];

    const webhookLastVerifiedAt = isoOrNull(mostRecentWebhookVerification?.webhook_last_verified_at);
    // The model exposes no acceptance timestamp (updatedAt is off; the
    // trigger-maintained DB column is not surfaced), so this is honestly the
    // CREATION time of the newest accepted reply, not the moment of
    // acceptance (A5-4) — name it as such rather than mislabelling it.
    const lastAcceptedReplyCreatedAt = isoOrNull(latestAcceptedAiMessage?.created_at);

    // The operational ladder reads EXISTING records only:
    //   webhook  — MetaChannel.webhook_last_verified_at (confirmWebhookActive)
    //   draft    — Message.delivery_state DRAFT_READY+ (message-lifecycle)
    //   approval — Message.delivery_source DRAFT_APPROVAL (approval flow)
    //   provider — APPROVED (delivery_source='DRAFT_APPROVAL') + SENT/DELIVERED
    //              + provider_message_id (isProviderConfirmed on an approved send)
    //   failure  — FAILED approved sends / stuck outbox reconciliations
    // Missing evidence keeps the shop below verified_operational; it is never
    // back-filled from configuration.
    const operationalWarnings = [];
    let operationalState;
    if (failedApprovedSends > 0 || stuckOutboxDeliveries > 0) {
        operationalState = OPERATIONAL_STATES.ACTION_REQUIRED;
        operationalWarnings.push({
            code: 'OPERATIONAL_TEST_FAILED',
            message: 'An approved AI reply failed to reach Messenger or could not be reconciled. Check the channel connection, then approve a fresh test reply.',
        });
    } else if (webhookRecentlyVerifiedFacebookPages > 0 && aiMessagesAcceptedRecently > 0) {
        operationalState = OPERATIONAL_STATES.VERIFIED_OPERATIONAL;
    } else if (
        webhookRecentlyVerifiedFacebookPages > 0
        || draftsGenerated > 0
        || draftsApproved > 0
        || aiMessagesAcceptedEver > 0
    ) {
        // A channel is listening or a test is in flight (or was attempted):
        // the remaining proof is an accepted reply. This is not a failure, so
        // it is never reported as success either.
        operationalState = OPERATIONAL_STATES.WAITING_FOR_TEST;
    } else {
        // Nothing operational has happened yet — only configuration exists.
        operationalState = OPERATIONAL_STATES.CONFIGURED;
    }

    if (operationalState !== OPERATIONAL_STATES.VERIFIED_OPERATIONAL) {
        if (connectedFacebookPages > 0 && webhookVerifiedFacebookPages === 0) {
            operationalWarnings.push({
                code: 'WEBHOOK_NOT_VERIFIED',
                message: 'No webhook verification was found for the connected page. Send a test message before launch.',
            });
        } else if (connectedFacebookPages > 0 && webhookRecentlyVerifiedFacebookPages === 0) {
            operationalWarnings.push({
                code: 'WEBHOOK_VERIFICATION_STALE',
                message: `The most recent webhook verification is older than ${OPERATIONAL_EVIDENCE_WINDOW_DAYS} days. Re-run the channel webhook check before launch.`,
            });
        }
    }

    const operational = {
        state: operationalState,
        operationalVerified: operationalState === OPERATIONAL_STATES.VERIFIED_OPERATIONAL,
        evidenceWindowDays: OPERATIONAL_EVIDENCE_WINDOW_DAYS,
        warnings: operationalWarnings,
        evidence: {
            webhook: {
                connectedFacebookPages,
                verifiedEver: webhookVerifiedFacebookPages,
                verifiedWithinWindow: webhookRecentlyVerifiedFacebookPages,
                lastVerifiedAt: webhookLastVerifiedAt,
            },
            assistant: {
                draftsGenerated,
                draftsApproved,
                providerAcceptedEver: aiMessagesAcceptedEver,
                providerAcceptedWithinWindow: aiMessagesAcceptedRecently,
                lastAcceptedReplyCreatedAt,
                approvedSendFailures: failedApprovedSends,
                outboxNeedsReconciliation: stuckOutboxDeliveries,
            },
        },
    };

    const completedCount = tasks.filter((task) => task.status === 'complete').length;
    const totalCount = tasks.length;

    return {
        // isComplete has always meant "configuration complete"; it does NOT
        // claim the shop is operational. Use `operational` for that.
        isComplete: completedCount === totalCount,
        completedCount,
        totalCount,
        progressPercent: Math.round((completedCount / totalCount) * 100),
        tasks,
        counts: {
            connectedFacebookPages,
            webhookVerifiedFacebookPages,
            activeProducts,
            activeFaqs,
            aiMessagesSent: aiMessagesAcceptedEver,
        },
        operational,
        generatedAt: new Date().toISOString(),
    };
}

/**
 * Legacy onboarding contract. Field names are kept for API compatibility, but
 * the values are no longer fabricated:
 *   - knowledge_added          ← active FAQ answers (was: product count)
 *   - assistant_test_completed ← one REAL same-row approved + provider-accepted
 *                                reply (was: "AI settings exist")
 *   - ai_messages              ← real provider-accepted AI sends (was: 0)
 * `completed`/`can_complete` still gate on configuration (unchanged meaning);
 * operational truth is exposed separately as `operational_verified`.
 */
function toLegacyOnboardingStatus(setupStatus) {
    const taskStatus = Object.fromEntries(
        setupStatus.tasks.map((task) => [task.key, task.status === 'complete'])
    );
    const missing = setupStatus.tasks
        .filter((task) => task.status !== 'complete')
        .map((task) => task.key);

    const counts = normalizeObject(setupStatus.counts);
    const operational = normalizeObject(setupStatus.operational);
    const assistant = normalizeObject(operational.evidence?.assistant);
    // providerAcceptedEver is already the SAME-ROW joined condition
    // (delivery_source='DRAFT_APPROVAL' AND SENT/DELIVERED AND a real
    // provider_message_id), so this check can no longer be true while the
    // ladder reports action_required from an approved-but-failed send (A5-2).
    const providerAccepted = Number(assistant.providerAcceptedEver || 0);
    const activeFaqs = Number(counts.activeFaqs || 0);

    return {
        completed: setupStatus.isComplete,
        can_complete: setupStatus.isComplete,
        checks: {
            facebook_connected: Boolean(taskStatus[TASK_KEYS.CONNECT_CHANNEL]),
            business_info_added: Boolean(taskStatus[TASK_KEYS.SHOP_PROFILE]),
            knowledge_added: activeFaqs > 0,
            assistant_test_completed: providerAccepted > 0,
        },
        missing,
        counts: {
            connected_facebook_pages: Number(counts.connectedFacebookPages || 0),
            active_products: Number(counts.activeProducts || 0),
            active_faqs: activeFaqs,
            ai_messages: providerAccepted,
        },
        operational_verified: Boolean(operational.operationalVerified),
        setup_status: setupStatus,
    };
}

module.exports = {
    TASK_KEYS,
    OPERATIONAL_STATES,
    OPERATIONAL_EVIDENCE_WINDOW_DAYS,
    getSetupStatus,
    toLegacyOnboardingStatus,
};
