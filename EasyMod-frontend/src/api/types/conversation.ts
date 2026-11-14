/**
 * Conversation and Messaging types
 */

import type { Opportunity } from './customer-intelligence';

export type MessageSender = 'customer' | 'agent' | 'ai';
export type MessageType = 'text' | 'image' | 'file' | 'location';
export type MessageDeliveryState =
  | 'GENERATING'
  | 'DRAFT_READY'
  | 'SEND_PENDING'
  | 'SENT'
  | 'DELIVERED'
  | 'FAILED'
  | 'HELD'
  | 'DISMISSED';

export interface MessageAttachment {
  type?: 'image' | 'video' | 'audio' | 'file' | 'sticker' | string | null;
  url?: string | null;
  name?: string | null;
  mime_type?: string | null;
}
export type SuggestionVisibility =
  | 'HIDDEN_AUTO_PROCESSING'
  | 'VISIBLE_DRAFT_REVIEW'
  | 'VISIBLE_HITL_REVIEW'
  | 'VISIBLE_MERCHANT_REQUESTED'
  | 'HIDDEN_SENT'
  | 'HIDDEN_DISMISSED';

export interface ReplyContext {
  provider_message_id: string;
  internal_message_id?: string | null;
  is_self_reply?: boolean;
  status: 'resolved' | 'unavailable';
  sender?: MessageSender;
  content?: string | null;
  message_type?: MessageType;
  file_name?: string | null;
}

export const AI_REPLY_MODES = ['AUTO', 'DRAFT', 'MANUAL'] as const;
export type AiReplyMode = (typeof AI_REPLY_MODES)[number];
export const DEFAULT_AI_REPLY_MODE: AiReplyMode = 'MANUAL';

const AI_REPLY_MODE_ALIASES: Record<string, AiReplyMode> = {
  AUTO: 'AUTO',
  AI_ACTIVE: 'AUTO',
  DRAFT: 'DRAFT',
  AI_SUGGEST_ONLY: 'DRAFT',
  MANUAL: 'MANUAL',
  HUMAN_ACTIVE: 'MANUAL',
};

/** Normalize current and legacy API values, failing closed to MANUAL. */
export function normalizeAiReplyMode(value: unknown): AiReplyMode {
  if (typeof value !== 'string') return DEFAULT_AI_REPLY_MODE;
  return AI_REPLY_MODE_ALIASES[value.trim()] ?? DEFAULT_AI_REPLY_MODE;
}

/**
 * Which ownership layer produced the effective reply mode (ADR-0013 §4).
 * Business automation defaults, narrow-only channel overrides, or a safety
 * layer (emergency stop / inactive shop / fail-closed read).
 */
export type AiReplyModeSource =
  | 'emergency_stop'
  | 'shop_inactive'
  | 'channel_override'
  | 'business_default'
  | 'fail_closed';

/** Resolver warnings surfaced with an effective channel configuration. */
export type ChannelAutomationWarning =
  | 'override_clamped_by_business'
  | 'invalid_override_value'
  | (string & {});

/** Business-wide emergency stop snapshot (ADR-0013 §6). */
export interface EmergencyStopState {
  active: boolean;
  at: string | null;
  by: string | null;
  source: 'merchant' | 'admin' | null;
  prior_mode: AiReplyMode | null;
}

/** Merchant-selected reason for a manual conversation takeover (ADR-0013 §8). */
export type ManualHandoffReason =
  | 'manual_takeover'
  | 'customer_request'
  | 'phone_call'
  | 'order_issue'
  | 'other';

export type MessageSourceKind = 'rag' | 'faq' | 'product';

export interface MessageSourceReference {
  kind: MessageSourceKind;
  id?: string | null;
  title?: string | null;
  score?: number | null;
  /** Excludes related products from being reused as verified follow-up context. */
  contextEligible?: boolean;
}

/**
 * Why an AI reply was held instead of delivered to the customer.
 *  - 'low_confidence': auto-mode reply below the shop's confidence threshold;
 *    the conversation was handed off to a human.
 *  - 'draft_mode': suggest-only / DRAFT / policy-withheld reply.
 *  - 'executed_mutation_without_outbound_send': an order mutation completed
 *    but the safety gate withheld the customer-facing response.
 */
export type HeldReason =
  | 'low_confidence'
  | 'draft_mode'
  | 'mode_changed'
  | 'channel_disconnected'
  | 'human_active'
  | 'ai_paused'
  | 'policy_blocked'
  | 'provider_send_failed'
  | 'dismissed'
  | 'resume_obsolete'
  | 'newer_customer_message'
  | 'executed_mutation_without_outbound_send';

export interface MessageMetadata {
  message_type?: MessageType;
  attachments?: MessageAttachment[];
  image_url?: string;
  file_url?: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
  attachment_source?: string | null;
  attachment_storage_key?: string | null;
  attachment_available?: boolean;
  delivery_status?: 'processing' | 'pending' | 'sent' | 'failed' | 'held' | 'dismissed';
  delivery_error?: string;
  /** true = delivered to the customer; false = HELD as a reviewable suggestion. */
  delivered?: boolean;
  held_reason?: HeldReason;
  delivery_state?: MessageDeliveryState;
  provider_message_id?: string | null;
  provider_message_ids?: string[] | null;
  delivery_source?: string | null;
  suggestion_visibility?: SuggestionVisibility;
  reply_to_provider_message_id?: string | null;
  reply_to_internal_message_id?: string | null;
  reply_to_is_self_reply?: boolean;
  reply_to?: ReplyContext;
  quick_reply?: { payload?: unknown };
  [key: string]: unknown;
}

export interface Message {
  id: string;
  conversation_id: string;
  content: string;
  sender: MessageSender;
  message_type: MessageType;
  metadata?: MessageMetadata;
  ai_suggestion?: string;
  ai_confidence?: number;
  source_references?: MessageSourceReference[] | null;
  delivery_state?: MessageDeliveryState | null;
  provider_message_id?: string | null;
  delivery_source?: string | null;
  reply_to?: ReplyContext | null;
  is_transcript_message?: boolean;
  idempotency_replay?: boolean;
  created_at: string;
  updated_at: string;
}

export interface ConversationMetaChannel {
  id: string;
  displayName: string | null;
  platform: 'facebook' | null;
  purposeLabel: string | null;
}

export interface Conversation {
  id: string;
  customer_id: string;
  customer?: {
    id: string;
    name: string;
    email?: string;
    phone?: string;
    channel_user_id?: string;
    meta_channel_id?: string | null;
  };
  channel: 'telegram' | 'messenger' | 'facebook' | 'web';
  meta_channel_id?: string | null;
  metaChannel?: ConversationMetaChannel | null;
  /**
   * Channel-aware effective reply mode (stop-aware, clamped). ADR-0013 §6
   * additive field; prefer this over `ai_reply_mode` for display.
   */
  effective_ai_reply_mode?: AiReplyMode | null;
  mode_source?: AiReplyModeSource | null;
  emergency_stop?: EmergencyStopState | null;
  billing_ai_active?: boolean;
  title?: string;
  status: 'active' | 'closed' | 'archived';
  hitl?: boolean;
  lastMessage?: string;
  unreadCount?: number;
  lastReadMessageId?: string | null;
  lastReadMessageAt?: string | null;
  suggestionCount?: number;
  resolution_outcome?: 'kept_open_newer_customer_message' | null;
  hasAiSuggestion?: boolean;
  needs_merchant_reply?: boolean;
  needs_merchant_reply_reason?: string | null;
  ai_is_replying?: boolean;
  /**
   * P+01 Inbox Lead Intelligence: the server-authoritative LIVE Sales
   * Opportunity for this conversation's customer (null/absent when none, or
   * when the shop's pilot flag is off). Never a client-computed score.
   */
  open_opportunity?: Opportunity | null;
  created_at: string;
  updated_at: string;
  messages?: Message[];
  assignee_id?: string | null;
  assignee?: { id: string; name: string | null; email?: string } | null;
  resolved_at?: string;
  resolution_note?: string;
}

export interface ResponseTemplate {
  id: string;
  name: string;
  content: string;
  body?: string;
  variables?: string[];
  category?: string;
  is_active?: boolean;
}

export interface VoiceTranscriptionRequest {
  messageId: string;
  audioBase64: string;
  language?: 'auto' | 'bengali' | 'english' | 'banglish';
}

export interface VoiceTranscriptionResponse {
  messageId: string;
  transcript: string;
  text?: string;
  language: string;
}
