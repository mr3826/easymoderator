const { v4: uuidv4 } = require('uuid');
const { Op } = require('sequelize');

// Use the shared main entity models — avoids re-defining on the same Sequelize instance
const Customer = require('../customer/customer.entity');
const { Conversation, Message } = require('./conversation.entity');
const { normalizeAiReplyMode } = require('../shop/ai-reply-mode');
const {
    MESSAGE_DELIVERY_STATES,
    SUGGESTION_VISIBILITY,
    isProviderConfirmed,
    resumeBoundaryStateFor,
    resumeBoundaryAtFor,
    candidateStartedAtFor,
    isBeforeResumeBoundary,
} = require('./message-lifecycle');
const { sequelize } = require('../../utils/database/database-setup');

// Import OrderSessionService
const OrderSessionService = require('../order/order-session-standalone.service');

class ConversationStateService {
    /**
     * Ingest incoming message and update conversation state. When
     * meta_channel_id is supplied, only that exact channel may reuse a thread.
     */
    static async ingestMessage(data) {
        const {
            shop_id,
            customer_channel_id,
            platform,
            message,
            sender_type = 'customer',
            metadata = {},
            meta_channel_id = null
        } = data;

        try {
            const channelType = platform === 'facebook' ? 'messenger' : platform;

            // Find or create customer. channel_type must be included — the same
            // channel_user_id can exist on both 'messenger' and 'instagram' rows
            // (two-row-per-channel design, locked 2026-05-22).
            let customer = await Customer.findOne({
                where: {
                    shop_id,
                    channel_type: channelType,
                    channel_user_id: customer_channel_id,
                    meta_channel_id,
                }
            });

            if (!customer) {
                customer = await Customer.create({
                    id: uuidv4(),
                    shop_id,
                    channel_user_id: customer_channel_id,
                    channel_type: channelType,
                    meta_channel_id,
                    name: `Facebook customer · …${String(customer_channel_id || '').replace(/[^A-Za-z0-9]/g, '').slice(-4) || 'unknown'}`,
                    phone: null,
                    email: null,
                    metadata: {}
                });

                // Best-effort: replace the "Customer" placeholder with the real
                // Facebook/Instagram name from the Graph profile API. Fire-and-forget
                // so a slow or denied Graph call never blocks message processing.
                try {
                    const { enrichCustomerNameFromMeta } = require('../customer/customer-profile.service');
                    enrichCustomerNameFromMeta({
                        customerId: customer.id,
                        metaChannelId: meta_channel_id,
                        shopId: shop_id,
                        platform: channelType,
                        psid: customer_channel_id,
                    }).catch(() => {});
                } catch (_) { /* never block ingestion */ }
            }

            // Find or create conversation (24-hour window). When the caller
            // knows the Page, an exact channel match is required; an unpinned
            // legacy row must not be adopted by that Page.
            const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
            const convoWhere = {
                shop_id,
                customer_id: customer.id,
                channel: channelType,
                updated_at: { [Op.gte]: oneDayAgo }
            };
            convoWhere.meta_channel_id = meta_channel_id;
            let conversation = await Conversation.findOne({
                where: convoWhere,
                order: [['updated_at', 'DESC']]
            });

            // Defend against a data layer that returns a row outside the exact
            // predicate. Never mutate an unpinned legacy conversation here.
            if (conversation && meta_channel_id
                && String(conversation.meta_channel_id) !== String(meta_channel_id)) {
                conversation = null;
            }

            const messageTime = new Date();

            if (!conversation || conversation.status === 'closed') {
                conversation = await Conversation.create({
                    id: uuidv4(),
                    shop_id,
                    customer_id: customer.id,
                    channel: channelType,
                    meta_channel_id,
                    status: 'active',
                    role: 'user',
                    message: message,
                    metadata: {
                        platform,
                        started_at: messageTime.toISOString(),
                        last_intent: null,
                        language_detected: null,
                        automation_enabled: true,
                        message_count: 0,
                        unreadCount: 0,
                    }
                });
            }

            // Store the message
            const senderValue = sender_type === 'ai' ? 'ai' : 'customer';
            const messageRecord = await Message.create({
                id: uuidv4(),
                conversation_id: conversation.id,
                content: message,
                sender: senderValue,
                external_id: metadata.message_id || null,
                metadata: {
                    ...metadata,
                    platform,
                    timestamp: messageTime.toISOString()
                }
            });

            // Update conversation activity
            const currentMeta = conversation.metadata && typeof conversation.metadata === 'object'
                ? conversation.metadata
                : {};
            const unreadCount = senderValue === 'customer'
                ? Math.max(0, Number(currentMeta.unreadCount) || 0) + 1
                : Math.max(0, Number(currentMeta.unreadCount) || 0);
            await conversation.update({
                ...(senderValue === 'customer' ? { message } : {}),
                metadata: {
                    ...currentMeta,
                    last_message_at: messageTime.toISOString(),
                    last_actual_message: senderValue === 'customer' ? message : currentMeta.last_actual_message,
                    unreadCount,
                    message_count: (currentMeta.message_count || 0) + 1,
                }
            });

            // FIX BUG #1: Get last 11 messages, exclude the newest (current message),
            // and use the 10 previous messages as context history.
            // This ensures the current message is not duplicated when passed to LLM.
            const allRecentMessages = await Message.findAll({
                where: { conversation_id: conversation.id },
                order: [['created_at', 'DESC']],
                limit: 11
            });

            // Find and remove the current message (most recent) from history
            // The rest become the context history (up to 10 messages)
            const previousMessages = allRecentMessages.filter(msg => msg.id !== messageRecord.id);
            const recentMessages = previousMessages.slice(0, 10).reverse();

            const conversationHistory = recentMessages.map(msg => ({
                role: msg.sender === 'customer' ? 'user' : 'assistant',
                message: msg.content,
                content: msg.content,
                timestamp: msg.created_at
            }));

            // Check for active order session
            const activeOrderSession = await OrderSessionService.getActiveSession(
                shop_id,
                customer_channel_id,
                conversation.meta_channel_id || meta_channel_id || null,
                customer.id,
            );

            return {
                success: true,
                conversation_id: conversation.id,
                customer_id: customer.id,
                message_id: messageRecord.id,
                shop_id,
                customer_channel_id,
                platform,
                conversation_state: {
                    status: conversation.status,
                    language: currentMeta.language_detected,
                    last_intent: currentMeta.last_intent,
                    message_count: (currentMeta.message_count || 0) + 1
                },
                conversation_history: conversationHistory,
                active_order_session: activeOrderSession,
                reply_context: messageRecord.metadata?.reply_to || metadata.reply_to || null,
                customer_info: {
                    id: customer.id,
                    name: customer.name,
                    channel_id: customer.channel_user_id,
                    platform
                }
            };

        } catch (error) {
            console.error('Message ingestion error:', error);
            throw new Error(`Failed to ingest message: ${error.message}`);
        }
    }

    /**
     * Update conversation with AI response
     */
    static async storeAIResponse(conversationId, response, metadata = {}) {
        try {
            // Extract first-class columns from metadata bag; keep the rest in JSON.
            const {
                confidence,
                sourceReferences,
                delivery_state = MESSAGE_DELIVERY_STATES.GENERATING,
                delivery_source = 'AUTO',
                send_idempotency_key = null,
                ...restMeta
            } = metadata;
            const persist = async (transaction = null) => {
                const conversation = typeof Conversation.findOne === 'function'
                    ? await Conversation.findOne({
                        where: { id: conversationId },
                        ...(transaction ? { transaction, lock: transaction.LOCK?.UPDATE } : {}),
                    })
                    : await Conversation.findByPk(conversationId);
                if (!conversation) throw new Error('Conversation not found');

                let currentMeta = conversation.metadata;
                if (typeof currentMeta === 'string') {
                    try { currentMeta = JSON.parse(currentMeta); } catch (_) { currentMeta = {}; }
                }
                if (!currentMeta || typeof currentMeta !== 'object' || Array.isArray(currentMeta)) currentMeta = {};

                const candidateMetadata = {
                    ...restMeta,
                    confidence,
                    delivery_state,
                    delivery_source,
                    send_idempotency_key,
                };
                const resumeBoundaryState = resumeBoundaryStateFor(conversation);
                if (resumeBoundaryState.present && !resumeBoundaryState.valid) {
                    const error = new Error('AI candidate Resume boundary is invalid');
                    error.code = 'RESUME_BOUNDARY_INVALID';
                    throw error;
                }
                const resumeBoundaryAt = resumeBoundaryAtFor(conversation);
                const candidateStartedAt = candidateStartedAtFor({
                    metadata: candidateMetadata,
                    created_at: null,
                });
                if (resumeBoundaryAt && !Number.isFinite(candidateStartedAt)) {
                    const error = new Error('AI candidate turn start is unavailable after Resume AI');
                    error.code = 'RESUME_BOUNDARY_TURN_START_REQUIRED';
                    throw error;
                }
                const resumeObsolete = Boolean(
                    resumeBoundaryAt
                    && candidateMetadata.provider_send_attempted !== true
                    && isBeforeResumeBoundary({
                        metadata: candidateMetadata,
                        created_at: new Date(),
                    }, resumeBoundaryAt),
                );
                const effectiveDeliveryState = resumeObsolete
                    ? MESSAGE_DELIVERY_STATES.DISMISSED
                    : delivery_state;
                const effectiveMetadata = {
                    ...candidateMetadata,
                    delivery_state: effectiveDeliveryState,
                    delivered: false,
                    delivery_status: resumeObsolete
                        ? 'dismissed'
                        : delivery_state === MESSAGE_DELIVERY_STATES.DRAFT_READY ? 'pending' : 'processing',
                    suggestion_visibility: resumeObsolete
                        ? SUGGESTION_VISIBILITY.HIDDEN_DISMISSED
                        : candidateMetadata.suggestion_visibility,
                    timestamp: new Date().toISOString(),
                    type: 'ai_response',
                    ...(resumeObsolete ? {
                        held_reason: 'resume_obsolete',
                        dismissed_at: new Date().toISOString(),
                        dismissed_by_resume: true,
                    } : {}),
                };
                const message = await Message.create({
                    id: uuidv4(),
                    conversation_id: conversationId,
                    content: response,
                    sender: 'ai',
                    external_id: null,
                    ai_confidence: typeof confidence === 'number' ? confidence : null,
                    source_references: Array.isArray(sourceReferences) && sourceReferences.length
                        ? sourceReferences
                        : null,
                    ai_suggestion: response,
                    delivery_state: effectiveDeliveryState,
                    delivery_source,
                    provider_message_id: null,
                    send_idempotency_key,
                    metadata: effectiveMetadata,
                }, transaction ? { transaction } : undefined);

                await conversation.update({
                    metadata: {
                        ...currentMeta,
                        last_ai_response_at: new Date().toISOString(),
                        ai_response_count: (Number(currentMeta.ai_response_count) || 0) + 1
                    }
                }, ...(transaction ? [{ transaction }] : []));
                return { success: true, message_id: message.id, message };
            };

            if (sequelize?.getDialect?.() === 'postgres' && typeof sequelize.transaction === 'function') {
                return await sequelize.transaction((transaction) => persist(transaction));
            }
            return await persist();

        } catch (error) {
            console.error('Store AI response error:', error);
            const wrapped = new Error(`Failed to store AI response: ${error.message}`);
            if (error?.code) wrapped.code = error.code;
            throw wrapped;
        }
    }

    /**
     * Update conversation intent and language
     */
    static async updateConversationState(conversationId, stateUpdate) {
        try {
            const {
                intent,
                language,
                confidence,
                automation_mode,
                intentRecord,
                intentConfidence,
                unsafeShadowActions = 0,
                shadowDivergence,
            } = stateUpdate;
            const normalizedAutomationMode = automation_mode === undefined
                ? undefined
                : normalizeAiReplyMode(automation_mode);
            const persist = async (transaction = null) => {
                const conversation = typeof Conversation.findOne === 'function'
                    ? await Conversation.findOne({
                        where: { id: conversationId },
                        ...(transaction ? { transaction, lock: transaction.LOCK?.UPDATE } : {}),
                    })
                    : await Conversation.findByPk(conversationId);
                if (!conversation) throw new Error('Conversation not found');

                let currentMeta = conversation.metadata || {};
                if (typeof currentMeta === 'string') {
                    try { currentMeta = JSON.parse(currentMeta); } catch (_) { currentMeta = {}; }
                }
                if (!currentMeta || typeof currentMeta !== 'object' || Array.isArray(currentMeta)) currentMeta = {};
                const nextMetadata = {
                    ...currentMeta,
                    ...(intent !== undefined ? { last_intent: intent } : {}),
                    ...(language !== undefined ? { language_detected: language } : {}),
                    ...(confidence !== undefined ? { last_intent_confidence: intentConfidence ?? confidence } : {}),
                    ...(normalizedAutomationMode !== undefined ? { automation_mode: normalizedAutomationMode } : {}),
                    ...(intentRecord ? { last_intent_record: intentRecord } : {}),
                    ...(unsafeShadowActions ? {
                        unsafeShadowActions: (Number(currentMeta.unsafeShadowActions) || 0) + Number(unsafeShadowActions),
                    } : {}),
                    ...(shadowDivergence ? { lastShadowDivergence: shadowDivergence } : {}),
                    last_state_update: new Date().toISOString(),
                };

                const stateColumns = { metadata: nextMetadata };
                if (intent !== undefined) stateColumns.intent = intent;
                if (confidence !== undefined) {
                    stateColumns.confidence = Number.isFinite(Number(confidence))
                        && Number(confidence) >= 0
                        && Number(confidence) <= 1
                        ? Math.round(Number(confidence) * 100)
                        : confidence;
                }
                await conversation.update(stateColumns, ...(transaction ? [{ transaction }] : []));

                return {
                    success: true,
                    conversation_state: {
                        status: conversation.status,
                        last_intent: intent,
                        language,
                        confidence,
                        automation_mode: normalizedAutomationMode
                    }
                };
            };

            if (sequelize?.getDialect?.() === 'postgres' && typeof sequelize.transaction === 'function') {
                return await sequelize.transaction((transaction) => persist(transaction));
            }
            return await persist();

        } catch (error) {
            console.error('Update conversation state error:', error);
            throw new Error(`Failed to update conversation state: ${error.message}`);
        }
    }

    /**
     * Mark conversation for human handoff
     */
    static async markForHumanHandoff(conversationId, reason, metadata = {}) {
        try {
            const conversation = await Conversation.findByPk(conversationId);
            if (!conversation) throw new Error('Conversation not found');

            const currentMeta = conversation.metadata || {};
            await conversation.update({
                status: 'needs_human',
                // ADR-0013 §8: `needs_human` alone is NOT a pause signal for the
                // worker on legacy rows. Setting the canonical HITL flag here
                // closes the keyword-fallback bypass — subsequent customer
                // messages must never receive an automatic AI reply.
                hitl: true,
                metadata: {
                    ...currentMeta,
                    handoff_reason: reason,
                    handoff_timestamp: new Date().toISOString(),
                    handoff_metadata: metadata
                }
            });

            // Log as a business message (no 'system' sender in production schema)
            await Message.create({
                id: uuidv4(),
                conversation_id: conversationId,
                content: `[HANDOFF] Marked for human review - Reason: ${reason}`,
                sender: 'business',
                external_id: null,
                metadata: { type: 'handoff', reason, timestamp: new Date().toISOString() }
            });

            return { success: true, status: 'needs_human', handoff_reason: reason };

        } catch (error) {
            console.error('Mark handoff error:', error);
            throw new Error(`Failed to mark for handoff: ${error.message}`);
        }
    }

    /**
     * Get conversation context for LLM
     */
    static async getConversationContext(conversationId, includeHistory = true) {
        try {
            const conversation = await Conversation.findByPk(conversationId, {
                include: [{ model: Customer, as: 'customer' }]
            });
            if (!conversation) throw new Error('Conversation not found');

            let history = [];
            if (includeHistory) {
                const messages = await Message.findAll({
                    where: { conversation_id: conversationId },
                    order: [['created_at', 'ASC']],
                    limit: 20
                });
                history = messages
                    .filter(msg => {
                        const metadata = msg.metadata && typeof msg.metadata === 'object' ? msg.metadata : {};
                        const hasExplicitDeliveryLifecycle = msg.delivery_state != null
                            || msg.provider_message_id != null
                            || metadata.delivery_state != null
                            || metadata.delivery_status != null
                            || metadata.delivered !== undefined
                            || metadata.suggestion_visibility != null;
                        return msg.sender !== 'ai'
                            || isProviderConfirmed(msg)
                            || !hasExplicitDeliveryLifecycle;
                    })
                    .map(msg => ({
                        role: msg.sender === 'customer' ? 'user' : msg.sender === 'ai' ? 'assistant' : 'system',
                        content: msg.content,
                        timestamp: msg.created_at,
                        metadata: msg.metadata,
                    }));
            }

            const activeOrderSession = await OrderSessionService.getActiveSession(
                conversation.shop_id,
                conversation.customer.channel_user_id,
                conversation.meta_channel_id || null,
                conversation.customer.id,
            );

            const meta = conversation.metadata || {};
            return {
                conversation_id: conversation.id,
                customer: {
                    id: conversation.customer.id,
                    name: conversation.customer.name,
                    channel_id: conversation.customer.channel_user_id,
                    platform: conversation.channel
                },
                state: {
                    status: conversation.status,
                    last_intent: meta.last_intent,
                    language: meta.language_detected,
                    message_count: meta.message_count || 0,
                    automation_enabled: meta.automation_enabled
                },
                history,
                active_order_session: activeOrderSession,
                metadata: meta
            };

        } catch (error) {
            console.error('Get conversation context error:', error);
            throw new Error(`Failed to get conversation context: ${error.message}`);
        }
    }

    /**
     * Detect language from message.
     *
     * 'bn'  \u2014 Bengali script OR Banglish (Romanised Bengali)
     * 'en'  \u2014 genuine English
     * 'mixed' \u2014 Bengali script + Latin together
     *
     * Banglish ("ami order korbo", "naam Rahim", "koyta lagbe") is pure ASCII, so the
     * old test (`hasEnglish \u2192 'en'`) misread it as English and the order flow asked
     * name/phone/address in English to customers who were typing Bengali. BD f-commerce
     * buyers overwhelmingly write Banglish and expect a Bengali reply, so recognisable
     * Banglish is classified as 'bn'. (Founder feedback 2026-06-13.)
     */
    static detectLanguage(message) {
        const hasBangla = /[\u0980-\u09FF]/.test(message);
        const hasEnglish = /[a-zA-Z]/.test(message);
        if (hasBangla && hasEnglish) return 'mixed';
        if (hasBangla) return 'bn';
        if (hasEnglish) return ConversationStateService.isBanglish(message) ? 'bn' : 'en';
        return 'unknown';
    }

    /**
     * True when Latin-script text is actually Romanised Bengali (Banglish).
     * Conservative high-frequency word list \u2014 a single confident hit is enough,
     * while genuine English ("I want to buy this dress") matches none and stays 'en'.
     */
    static isBanglish(message) {
        return ConversationStateService.BANGLISH_MARKERS.test(String(message || ''));
    }

    /**
     * Extract entities from message
     */
    static extractEntities(message) {
        const entities = {};
        const phones = message.match(/01[3-9]\d{8}/g);
        if (phones) entities.phone_numbers = phones;
        const prices = message.match(/[৳]?(\d+(?:,\d{3})*(?:\.\d{2})?|\d+)/g);
        if (prices) entities.prices = prices;
        const productKeywords = ['dress', 'shirt', 'panjabi', 'saree', 'kameez', 'পোশাক', 'ড্রেস', 'শার্ট'];
        const foundProducts = productKeywords.filter(k => message.toLowerCase().includes(k.toLowerCase()));
        if (foundProducts.length > 0) entities.product_types = foundProducts;
        return entities;
    }
}

// High-frequency Banglish (Romanised Bengali) markers. Word-boundary matched and
// case-insensitive; a single hit classifies Latin text as Bengali. Deliberately
// excludes ambiguous tokens that also occur in English (e.g. "chai", "dam", "han").
ConversationStateService.BANGLISH_MARKERS = new RegExp(
    '\\b(' + [
        'ami', 'amar', 'amake', 'amra', 'apni', 'apnar', 'apnara', 'tumi', 'tomar',
        'naam', 'koto', 'koto', 'koyta', 'koita', 'kothay', 'kobe', 'kemne', 'kibhabe',
        'korbo', 'korbe', 'korben', 'korte', 'dibo', 'dibe', 'deben', 'debe',
        'nibo', 'nibe', 'niben', 'nilam', 'lagbe', 'lagbe', 'ache', 'achhe', 'nai', 'naai',
        'kinbo', 'kinben', 'kinte', 'kemon', 'bhai', 'apu', 'pathao', 'pathai', 'pathaben',
        'jonno', 'taka', 'dorkar', 'order korbo', 'oder korbo'
    ].join('|') + ')\\b',
    'i'
);

module.exports = ConversationStateService;
