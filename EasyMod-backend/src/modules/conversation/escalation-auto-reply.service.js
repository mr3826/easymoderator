/**
 * Escalation Auto-Reply Service
 *
 * When a conversation is escalated to a human agent, automatically sends a
 * templated reassurance message to the customer. The template is pulled from
 * the shop's AI settings (settings.ai.escalation_reply_template) so each shop
 * can customise it. Falls back to a bilingual Bengali/English default.
 *
 * Default template (Bengali + English) — deliberately non-time-bound:
 *   "আপনার অনুরোধটি আমাদের টিমের কাছে পাঠানো হয়েছে। একজন প্রতিনিধি আপনার
 *    সাথে যোগাযোগ করবেন।
 *    Your request has been forwarded to our team. A representative will get back to you."
 *
 * No response-time SLA is asserted: the platform has not committed to a fixed
 * human-response window (the previous "within 2 hours" wording was an unsupported
 * claim that could promise contact the business never agreed to deliver).
 */

const { v4: uuidv4 } = require('uuid');
const { Conversation, Message } = require('./conversation.entity');
const shopService = require('../shop/shop.service');
const {
    MESSAGE_DELIVERY_STATES,
    SUGGESTION_VISIBILITY,
    normalizeDeliveryState,
    deriveEscalationSendIdempotencyKey,
} = require('./message-lifecycle');

const DEFAULT_ESCALATION_TEMPLATE =
    'আপনার অনুরোধটি আমাদের টিমের কাছে পাঠানো হয়েছে। একজন প্রতিনিধি আপনার সাথে যোগাযোগ করবেন।\n\n' +
    'Your request has been forwarded to our team. A representative will get back to you. 🙏';

/**
 * Send an escalation auto-reply message to the customer.
 *
 * @param {string} conversationId  - UUID of the conversation being escalated
 * @param {string} shopId          - UUID of the shop (for settings lookup)
 * @param {string} [channelType]   - Channel identifier (messenger, instagram, etc.) — reserved for future platform-specific routing
 * @returns {Promise<object|null>} - The created message record, or null if skipped/failed
 */
const sendEscalationAutoReply = async (conversationId, shopId, channelType, lifecycleMetadata = {}) => {
    try {
        // Resolve the template: shop-specific override → default bilingual template
        let template = DEFAULT_ESCALATION_TEMPLATE;

        try {
            const aiSettings = await shopService.getShopAiSettings(shopId);
            if (aiSettings && aiSettings.escalation_reply_template) {
                template = aiSettings.escalation_reply_template;
            }
        } catch (settingsErr) {
            // Non-fatal — use default template if shop settings unavailable
            console.warn(
                `[EscalationAutoReply] Could not load shop AI settings for ${shopId}: ${settingsErr.message}`
            );
        }

        // Verify the conversation belongs to this shop
        const conversation = await Conversation.findOne({
            where: { id: conversationId, shop_id: shopId }
        });

        if (!conversation) {
            console.warn(
                `[EscalationAutoReply] Conversation ${conversationId} not found for shop ${shopId}. Skipping.`
            );
            return null;
        }

        const sendIdempotencyKey = deriveEscalationSendIdempotencyKey({
            shopId,
            conversationId,
            turnId: lifecycleMetadata.logicalTurnId || null,
        });

        // Repeated handoff signals must reuse the same logical reassurance
        // until a prior provider attempt is known to have failed before send.
        if (typeof Message.findOne === 'function') {
            const existing = await Message.findOne({
                where: {
                    conversation_id: conversationId,
                    sender: 'ai',
                    delivery_source: 'HITL_ESCALATION',
                    ...(lifecycleMetadata.logicalTurnId
                        ? { send_idempotency_key: sendIdempotencyKey }
                        : {}),
                },
                order: [['created_at', 'DESC']],
            });
            const existingMetadata = existing?.metadata && typeof existing.metadata === 'object'
                ? existing.metadata
                : {};
            const existingState = normalizeDeliveryState(existing);
            let returnedState = existingState;
            let returnedMetadata = existingMetadata;
            if (existing && existingState === MESSAGE_DELIVERY_STATES.FAILED
                && existingMetadata.provider_send_attempted !== true
                && typeof existing.update === 'function') {
                returnedState = MESSAGE_DELIVERY_STATES.SEND_PENDING;
                returnedMetadata = {
                    ...existingMetadata,
                    delivered: false,
                    delivery_status: 'pending',
                    delivery_state: MESSAGE_DELIVERY_STATES.SEND_PENDING,
                    suggestion_visibility: SUGGESTION_VISIBILITY.HIDDEN_AUTO_PROCESSING,
                };
                await existing.update({
                    delivery_state: MESSAGE_DELIVERY_STATES.SEND_PENDING,
                    metadata: returnedMetadata,
                });
            }
            if (existing) {
                return {
                    id: existing.id,
                    conversation_id: existing.conversation_id,
                    content: existing.content,
                    sender: existing.sender,
                    created_at: existing.created_at,
                    delivery_state: returnedState,
                    provider_message_id: existing.provider_message_id || existingMetadata.provider_message_id || null,
                    metadata: returnedMetadata,
                };
            }
        }

        // Create the auto-reply message
        const messageId = uuidv4();
        const message = await Message.create({
            id: messageId,
            conversation_id: conversationId,
            content: template,
            sender: 'ai',
            external_id: null,
            delivery_state: MESSAGE_DELIVERY_STATES.SEND_PENDING,
            delivery_source: 'HITL_ESCALATION',
            provider_message_id: null,
            send_idempotency_key: sendIdempotencyKey,
            metadata: {
                type: 'escalation_auto_reply',
                channel_type: channelType || conversation.channel || null,
                timestamp: new Date().toISOString(),
                auto_sent: false,
                delivered: false,
                delivery_status: 'pending',
                delivery_state: MESSAGE_DELIVERY_STATES.SEND_PENDING,
                delivery_source: 'HITL_ESCALATION',
                suggestion_visibility: SUGGESTION_VISIBILITY.HIDDEN_AUTO_PROCESSING,
                send_idempotency_key: sendIdempotencyKey,
                logical_turn_id: lifecycleMetadata.logicalTurnId || null,
                turn_started_at: lifecycleMetadata.turnStartedAt || null,
            }
        }).catch(async (error) => {
            const isUniqueConflict = error?.name === 'SequelizeUniqueConstraintError'
                || error?.parent?.code === '23505';
            if (!isUniqueConflict || typeof Message.findOne !== 'function') throw error;
            const existing = await Message.findOne({
                where: { conversation_id: conversationId, send_idempotency_key: sendIdempotencyKey },
            });
            if (!existing) throw error;
            return existing;
        });

        console.info(
            `[EscalationAutoReply] Auto-reply queued for conversation ${conversationId} (shop ${shopId})`
        );

        return {
            id: message.id,
            conversation_id: message.conversation_id,
            content: message.content,
            sender: message.sender,
            created_at: message.created_at,
            delivery_state: message.delivery_state,
            provider_message_id: message.provider_message_id || null,
            metadata: message.metadata,
        };

    } catch (error) {
        // Never throw — escalation auto-reply is best-effort and must not block the escalation flow
        console.error(
            `[EscalationAutoReply] Failed to send auto-reply for conversation ${conversationId}: ${error.message}`
        );
        return null;
    }
};

module.exports = { sendEscalationAutoReply, DEFAULT_ESCALATION_TEMPLATE };
