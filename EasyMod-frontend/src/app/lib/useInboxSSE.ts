import { useEffect, useRef } from 'react';
import { authService } from './auth';
import { buildApiUrl } from './config';
import { normalizeAiReplyMode, type AiReplyMode, type Message } from '@/api/types/conversation';

interface SSECallbacks {
    onNewMessage: (data: { conversation_id: string; message: Message; unread_count?: number }) => void;
    onHitlChanged: (data: { conversation_id: string; hitl: boolean }) => void;
    onAiPaused?: (data: { conversation_id: string; reason?: string }) => void;
    onAiReplyModeChanged?: (data: { mode: AiReplyMode }) => void;
    onMessageDeliveryUpdated?: (data: { conversation_id: string; message_id: string; metadata: Message['metadata']; delivery_state?: Message['delivery_state']; provider_message_id?: string | null; delivery_source?: string | null; content?: string | null; sender?: Message['sender']; created_at?: string | null }) => void;
    onConversationRead?: (data: { conversation_id: string; unread_count: number; last_read_message_id?: string | null; last_read_message_at?: string | null }) => void;
    onCustomerUpdated?: (data: { customer_id: string; name?: string; profile_pic?: string | null; meta_channel_id?: string | null }) => void;
    onConversationUpdated?: (data: { conversation_id: string; ai_paused?: boolean }) => void;
    onDeliveryFailed?: (data: { conversation_id?: string; message_id?: string; reason: string }) => void;
    onChannelError?: (data: { type: string; page_id: string; display_name: string; message: string }) => void;
    /** ADR-0013 §9: a channel override / purpose write changed effective config. */
    onChannelSettingsChanged?: (data: { channel_id: string; effective_mode?: AiReplyMode; mode_source?: string; override_keys?: string[] }) => void;
    /** ADR-0013 §6: business-wide emergency stop engaged or resumed. */
    onEmergencyStopChanged?: (data: { active: boolean; at?: string | null; by?: string | null; source?: string | null; prior_mode?: AiReplyMode | null }) => void;
    onSSEOffline?: () => void;
    onSSEOnline?: () => void;
}

/**
 * Opens a Server-Sent Events connection to /conversation/events for the
 * current shop. Calls the provided callbacks whenever the backend emits an
 * inbox event, including new_message, hitl_changed, or ai_reply_mode_changed.
 *
 * Reconnects automatically with exponential back-off (1s → 30s cap) on error.
 * Cookies are sent automatically by EventSource (withCredentials: true).
 */
export function useInboxSSE({ onNewMessage, onHitlChanged, onAiPaused, onAiReplyModeChanged, onMessageDeliveryUpdated, onConversationRead, onCustomerUpdated, onConversationUpdated, onDeliveryFailed, onChannelError, onChannelSettingsChanged, onEmergencyStopChanged, onSSEOffline, onSSEOnline }: SSECallbacks): void {
    // Keep callbacks in a ref so reconnects always use the latest closures
    const callbacksRef = useRef<SSECallbacks>({ onNewMessage, onHitlChanged, onAiPaused, onAiReplyModeChanged, onMessageDeliveryUpdated, onConversationRead, onCustomerUpdated, onConversationUpdated, onDeliveryFailed, onChannelError, onChannelSettingsChanged, onEmergencyStopChanged, onSSEOffline, onSSEOnline });
    callbacksRef.current = { onNewMessage, onHitlChanged, onAiPaused, onAiReplyModeChanged, onMessageDeliveryUpdated, onConversationRead, onCustomerUpdated, onConversationUpdated, onDeliveryFailed, onChannelError, onChannelSettingsChanged, onEmergencyStopChanged, onSSEOffline, onSSEOnline };

    const shopId = authService.getCurrentShopId();

    useEffect(() => {
        if (!shopId) return;
        let es: EventSource | null = null;
        let retryTimeout: ReturnType<typeof setTimeout> | null = null;
        let retryDelay = 1000;
        let destroyed = false;

        function connect() {
            if (destroyed) return;

            // The backend binds the tenant exclusively from the authenticated
            // session. A query selector is intentionally forbidden.
            const url = buildApiUrl('/api/conversation/events');
            es = new EventSource(url, { withCredentials: true });

            es.addEventListener('new_message', (e: MessageEvent) => {
                try {
                    callbacksRef.current.onNewMessage(JSON.parse(e.data));
                } catch (e) {
                    console.error('[useInboxSSE] Failed to parse SSE event data:', e);
                }
            });

            es.addEventListener('hitl_changed', (e: MessageEvent) => {
                try {
                    callbacksRef.current.onHitlChanged(JSON.parse(e.data));
                } catch (e) {
                    console.error('[useInboxSSE] Failed to parse SSE event data:', e);
                }
            });

            es.addEventListener('ai_paused', (e: MessageEvent) => {
                try {
                    callbacksRef.current.onAiPaused?.(JSON.parse(e.data));
                } catch (e) {
                    console.error('[useInboxSSE] Failed to parse SSE event data:', e);
                }
            });

            es.addEventListener('ai_reply_mode_changed', (e: MessageEvent) => {
                try {
                    const payload = JSON.parse(e.data) as { mode?: unknown };
                    callbacksRef.current.onAiReplyModeChanged?.({
                        mode: normalizeAiReplyMode(payload?.mode),
                    });
                } catch (e) {
                    console.error('[useInboxSSE] Failed to parse SSE event data:', e);
                }
            });

            es.addEventListener('delivery_failed', (e: MessageEvent) => {
                try {
                    callbacksRef.current.onDeliveryFailed?.(JSON.parse(e.data));
                } catch (e) {
                    console.error('[useInboxSSE] Failed to parse SSE event data:', e);
                }
            });

            es.addEventListener('message_delivery_updated', (e: MessageEvent) => {
                try {
                    callbacksRef.current.onMessageDeliveryUpdated?.(JSON.parse(e.data));
                } catch (e) {
                    console.error('[useInboxSSE] Failed to parse SSE event data:', e);
                }
            });

            es.addEventListener('conversation_read', (e: MessageEvent) => {
                try {
                    callbacksRef.current.onConversationRead?.(JSON.parse(e.data));
                } catch (e) {
                    console.error('[useInboxSSE] Failed to parse SSE event data:', e);
                }
            });

            es.addEventListener('customer_updated', (e: MessageEvent) => {
                try {
                    callbacksRef.current.onCustomerUpdated?.(JSON.parse(e.data));
                } catch (e) {
                    console.error('[useInboxSSE] Failed to parse SSE event data:', e);
                }
            });

            es.addEventListener('conversation_updated', (e: MessageEvent) => {
                try {
                    callbacksRef.current.onConversationUpdated?.(JSON.parse(e.data));
                } catch (e) {
                    console.error('[useInboxSSE] Failed to parse SSE event data:', e);
                }
            });

            es.addEventListener('channel_error', (e: MessageEvent) => {
                try {
                    callbacksRef.current.onChannelError?.(JSON.parse(e.data));
                } catch (e) {
                    console.error('[useInboxSSE] Failed to parse SSE event data:', e);
                }
            });

            es.addEventListener('channel_settings_changed', (e: MessageEvent) => {
                try {
                    const payload = JSON.parse(e.data) as { channel_id?: string; effective_mode?: unknown; mode_source?: string; override_keys?: string[] };
                    callbacksRef.current.onChannelSettingsChanged?.({
                        ...payload,
                        channel_id: String(payload?.channel_id ?? ''),
                        effective_mode: payload?.effective_mode === undefined
                            ? undefined
                            : normalizeAiReplyMode(payload.effective_mode),
                    });
                } catch (e) {
                    console.error('[useInboxSSE] Failed to parse SSE event data:', e);
                }
            });

            es.addEventListener('emergency_stop_changed', (e: MessageEvent) => {
                try {
                    const payload = JSON.parse(e.data) as { active?: unknown; at?: string | null; by?: string | null; source?: string | null; prior_mode?: unknown };
                    callbacksRef.current.onEmergencyStopChanged?.({
                        active: payload?.active === true,
                        at: payload?.at ?? null,
                        by: payload?.by ?? null,
                        source: payload?.source ?? null,
                        prior_mode: payload?.prior_mode === undefined || payload?.prior_mode === null
                            ? null
                            : normalizeAiReplyMode(payload.prior_mode),
                    });
                } catch (e) {
                    console.error('[useInboxSSE] Failed to parse SSE event data:', e);
                }
            });

            es.onopen = () => {
                retryDelay = 1000; // reset back-off on successful connect
                callbacksRef.current.onSSEOnline?.();
            };

            es.onerror = () => {
                console.error('[useInboxSSE] SSE connection error — will retry in', retryDelay, 'ms');
                callbacksRef.current.onSSEOffline?.();
                es?.close();
                es = null;
                if (destroyed) return;
                retryTimeout = setTimeout(() => {
                    retryDelay = Math.min(retryDelay * 2, 30000);
                    connect();
                }, retryDelay);
            };
        }

        connect();

        return () => {
            destroyed = true;
            if (retryTimeout) clearTimeout(retryTimeout);
            es?.close();
        };
    }, [shopId]); // re-run when shop changes so the SSE channel targets the right shop
}
