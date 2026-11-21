/**
 * meta-token-refresh.job.js
 *
 * Phase 2 — proactively refresh Meta Page access tokens BEFORE they expire.
 *
 * Why this exists:
 *   The legacy token-refresh-check.job.js only emits warnings and writes
 *   shop.settings.notifications entries. It never calls the Meta token
 *   exchange endpoint for rows in the new meta_channels table — so when this
 *   becomes the source of truth (Phase 3 read switch), shops would silently
 *   stop receiving messages on token expiry.
 *
 * Behavior:
 *   - Selects meta_channels rows where status='CONNECTED' AND
 *     token_expires_at <= NOW() + 14 days. (14d window gives 2 retry cycles
 *     at the 6h cadence before the token actually expires.)
 *   - For each row, decrypts the current token via MetaChannel entity getter
 *     and exchanges it for a new long-lived token via meta.service.
 *   - On success: writes the new ciphertext + expiry + resets
 *     token_refresh_attempts, sets status=CONNECTED. Emits SSE.
 *   - On Meta 4xx (token revoked / expired): sets status=TOKEN_EXPIRED,
 *     increments token_refresh_attempts, writes OwnerNotification +
 *     emits SSE channel_action_required.
 *
 * Schedule: every 6 hours (registered in queue-manager).
 *
 * Idempotency: BaseJob's Redis lock prevents overlapping runs. Within a run,
 * each channel is processed once. Failed refreshes don't block other channels.
 */

'use strict';

const { Op } = require('sequelize');
const BaseJob = require('./base-job');
const MetaChannel = require('../modules/channel-providers/meta-channel.entity');
const metaChannelService = require('../modules/channel-providers/meta-channel.service');
const { exchangeForLongLivedToken } = require('../utils/meta-oauth-exchange');
const { OwnerNotification } = require('../modules/entities');
const sse = require('../utils/sse-manager');

const REFRESH_WINDOW_DAYS = 14;
const FAILURE_THRESHOLD = 3;
const FAILURE_WINDOW_HOURS = 24;

class MetaTokenRefreshJob extends BaseJob {
    constructor() {
        super('meta_token_refresh');
    }

    async run({ dryRun, runDate }) {
        this.logger.info(`[${this.jobName}] Starting refresh sweep`, {
            dryRun,
            windowDays: REFRESH_WINDOW_DAYS,
        });

        const now = runDate || new Date();
        const horizon = new Date(now.getTime() + REFRESH_WINDOW_DAYS * 24 * 3600 * 1000);

        const channels = await MetaChannel.findAll({
            where: {
                status: 'CONNECTED',
                token_expires_at: { [Op.ne]: null, [Op.lte]: horizon },
            },
            order: [['token_expires_at', 'ASC']],
        });

        const results = {
            channelsChecked: channels.length,
            refreshed: 0,
            failed: 0,
            details: [],
        };
        this.metrics.recordsProcessed = channels.length;

        for (const channel of channels) {
            const detail = {
                channelId: channel.id,
                shopId: channel.shop_id,
                platform: channel.platform,
                tokenExpiresAt: channel.token_expires_at,
            };

            try {
                // Entity getter decrypts; if the ciphertext is corrupt this throws
                // and the channel is flagged TOKEN_EXPIRED below.
                const currentToken = channel.page_access_token_ct;
                if (!currentToken) throw new Error('Channel has no stored token');

                if (dryRun) {
                    detail.dryRun = true;
                    results.details.push(detail);
                    continue;
                }

                const { access_token: newToken, expiresAt } =
                    await exchangeForLongLivedToken(currentToken);

                if (!newToken) throw new Error('Token exchange returned empty token');

                await metaChannelService.updateTokens(channel.id, {
                    pageAccessToken: newToken,
                    tokenExpiresAt: expiresAt,
                });

                detail.refreshed = true;
                detail.newExpiresAt = expiresAt;
                results.refreshed += 1;
                this.metrics.recordsSucceeded += 1;

                try {
                    sse.emit(channel.shop_id, 'channel_status_changed', {
                        channelId: channel.id,
                        platform: channel.platform,
                        status: 'CONNECTED',
                        tokenExpiresAt: expiresAt,
                    });
                } catch (sseErr) {
                    // SSE is best-effort.
                    this.logger.warn(`[${this.jobName}] SSE emit failed`, { err: sseErr.message });
                }
            } catch (err) {
                results.failed += 1;
                this.metrics.recordsFailed += 1;
                this.metrics.errors.push(`${channel.id}: ${err.message}`);
                detail.error = err.message;
                results.details.push(detail);

                if (dryRun) continue;

                try {
                    await this._markFailure(channel, err.message);
                } catch (markErr) {
                    this.logger.error(
                        `[${this.jobName}] Failed to mark channel failure`,
                        { channelId: channel.id, err: markErr.message }
                    );
                }
                continue;
            }

            results.details.push(detail);
        }

        this.logger.info(`[${this.jobName}] Refresh sweep complete`, {
            checked: results.channelsChecked,
            refreshed: results.refreshed,
            failed: results.failed,
        });

        return results;
    }

    /**
     * Mark a failed refresh on the channel and emit SSE / OwnerNotification
     * if the channel has crossed the failure threshold inside the failure window.
     */
    async _markFailure(channel, errorMessage) {
        const attempts = (channel.token_refresh_attempts || 0) + 1;

        // Update the channel directly — MetaChannelService.updateStatus
        // resets fields we want to preserve here (attempts counter).
        channel.status = 'TOKEN_EXPIRED';
        channel.last_error = `Refresh failed: ${errorMessage}`;
        channel.token_refresh_attempts = attempts;
        // D2 rule applies here too: this bypass path is the scheduled 6h
        // sweep's TOKEN_EXPIRED writer, and an expired token no longer backs
        // any webhook verification. Without the clear, the health grid shows
        // "Active" and setup-status keeps counting the webhook verified —
        // exactly the stale-stamp symptom D2 exists to remove.
        channel.webhook_last_verified_at = null;
        channel.webhook_subscribed_fields = [];
        await channel.save();

        try {
            sse.emit(channel.shop_id, 'channel_status_changed', {
                channelId: channel.id,
                platform: channel.platform,
                status: 'TOKEN_EXPIRED',
                error: errorMessage,
            });
        } catch (_) { /* best-effort */ }

        if (attempts >= FAILURE_THRESHOLD) {
            await this._writeOwnerNotificationIfNotRecent(channel, attempts);
            try {
                sse.emit(channel.shop_id, 'channel_action_required', {
                    channelId: channel.id,
                    platform: channel.platform,
                    reason: 'refresh_failed_repeatedly',
                    attempts,
                });
            } catch (_) { /* best-effort */ }
        }
    }

    /**
     * Write an OwnerNotification of type `channel.refresh_failed_repeatedly`
     * unless one already exists for this channel within the failure window.
     * Keeps the dashboard from filling up with duplicate alerts.
     */
    async _writeOwnerNotificationIfNotRecent(channel, attempts) {
        const windowStart = new Date(Date.now() - FAILURE_WINDOW_HOURS * 3600 * 1000);

        const recent = await OwnerNotification.findOne({
            where: {
                shop_id: channel.shop_id,
                type: 'channel.refresh_failed_repeatedly',
                created_at: { [Op.gte]: windowStart },
            },
        });

        if (recent) {
            this.logger.debug(`[${this.jobName}] Suppressing duplicate notification`, {
                channelId: channel.id,
            });
            return;
        }

        await OwnerNotification.create({
            shop_id: channel.shop_id,
            type: 'channel.refresh_failed_repeatedly',
            status: 'pending',
            customer_message: null,
            customer_data: {
                channel_id: channel.id,
                platform: channel.platform,
                meta_asset_id: channel.meta_asset_id,
                attempts,
                last_error: channel.last_error,
                token_expires_at: channel.token_expires_at,
                action_url: '/settings/channels',
            },
        });

        this.logger.warn(`[${this.jobName}] OwnerNotification written`, {
            channelId: channel.id,
            attempts,
        });
    }
}

module.exports = MetaTokenRefreshJob;
