/**
 * Conversation & Messaging API Domain
 */

import { httpClient } from '@/shared/lib/http/client';
import type { ApiResponse, PaginatedResponse } from '../types/common';
import type {
  AiReplyMode,
  Conversation,
  ManualHandoffReason,
  Message,
  ResponseTemplate,
  VoiceTranscriptionRequest,
  VoiceTranscriptionResponse,
} from '../types/conversation';
import { normalizeAiReplyMode } from '../types/conversation';
import type { AxiosResponse } from 'axios';

interface ConversationListBody {
  conversations?: Conversation[];
  ai_reply_mode?: unknown;
  pagination?: {
    total?: number;
    page?: number;
    limit?: number;
    pageSize?: number;
    totalPages?: number;
  };
}

type ConversationListResponse =
  | (PaginatedResponse<Conversation> & { ai_reply_mode?: unknown })
  | ConversationListBody;

export interface ConversationsResponse extends PaginatedResponse<Conversation> {
  ai_reply_mode: AiReplyMode;
}

function normalizeConversationList(
  body: ConversationListResponse | undefined
): ConversationsResponse {
  if (body && 'data' in body && Array.isArray(body.data)) {
    return {
      ...body,
      ai_reply_mode: normalizeAiReplyMode(body.ai_reply_mode),
    };
  }

  const conversations = body && 'conversations' in body && Array.isArray(body.conversations)
    ? body.conversations
    : [];
  const pagination = body && 'pagination' in body ? body.pagination : undefined;

  return {
    data: conversations,
    total: pagination?.total ?? conversations.length,
    page: pagination?.page ?? 1,
    pageSize: pagination?.pageSize ?? pagination?.limit ?? conversations.length,
    ai_reply_mode: normalizeAiReplyMode(body && 'ai_reply_mode' in body ? body.ai_reply_mode : undefined),
  };
}

// Conversations
export async function getConversations(
  params?: Record<string, unknown>,
  signal?: AbortSignal
): Promise<ConversationsResponse> {
  const response: AxiosResponse<ApiResponse<ConversationListResponse>> =
    await httpClient.get('/api/conversation', { params, ...(signal ? { signal } : {}) });
  return normalizeConversationList(response.data.data);
}

export async function getConversation(conversationId: string): Promise<Conversation> {
  const response: AxiosResponse<ApiResponse<Conversation>> = await httpClient.get(
    `/api/conversation/${conversationId}`
  );
  return response.data.data;
}

export async function sendMessage(
  conversationId: string,
  content: string,
  options?: { useAI?: boolean; templateId?: string }
): Promise<Message> {
  const response: AxiosResponse<ApiResponse<Message>> = await httpClient.post(
    `/api/conversation/${conversationId}/message`,
    { content, ...options }
  );
  return response.data.data;
}

// Messages
export async function getMessages(
  conversationId: string,
  params?: { page?: number; limit?: number; signal?: AbortSignal }
): Promise<{ messages: Message[]; suggestions?: Message[]; pagination: { page: number; totalPages: number } }> {
  const { signal, ...queryParams } = params || {};
  const requestConfig = signal ? { params: queryParams, signal } : { params: queryParams };
  const response: AxiosResponse<ApiResponse<{ messages: Message[]; suggestions?: Message[]; pagination: { page: number; totalPages: number } }>> =
    await httpClient.get(`/api/conversation/${conversationId}/messages`, requestConfig);
  return response.data.data;
}

export async function createMessage(
  conversationId: string,
  message: {
    content: string;
    sender: 'customer' | 'agent' | 'ai';
    message_type: 'text' | 'image' | 'file' | 'location';
    metadata?: unknown;
  },
  options?: { idempotencyKey?: string }
): Promise<Message> {
  const response: AxiosResponse<ApiResponse<Message>> = options?.idempotencyKey
    ? await httpClient.post(
      `/api/conversation/${conversationId}/messages`,
      message,
      { headers: { 'Idempotency-Key': options.idempotencyKey }, __skipGlobalErrorToast: true },
    )
    : await httpClient.post(`/api/conversation/${conversationId}/messages`, message, { __skipGlobalErrorToast: true });
  return response.data.data;
}

export async function approveAiDraft(
  conversationId: string,
  messageId: string,
  content?: string,
): Promise<Message> {
  const response: AxiosResponse<ApiResponse<{ message: Message }>> = await httpClient.post(
    `/api/conversation/${conversationId}/messages/${messageId}/approve`,
    content === undefined ? {} : { content },
  );
  return response.data.data.message;
}

export async function dismissAiDraft(conversationId: string, messageId: string): Promise<Message> {
  const response: AxiosResponse<ApiResponse<{ message: Message }>> = await httpClient.post(
    `/api/conversation/${conversationId}/messages/${messageId}/dismiss`,
    {},
  );
  return response.data.data.message;
}

export async function markConversationRead(
  conversationId: string,
  messageId: string,
): Promise<Conversation> {
  const response: AxiosResponse<ApiResponse<Conversation>> = await httpClient.post(
    `/api/conversation/${conversationId}/read`,
    { message_id: messageId },
  );
  return response.data.data;
}

export async function updateConversation(
  conversationId: string,
  updates: {
    status?: 'active' | 'closed' | 'archived';
    hitl?: boolean;
    assignee_id?: string;
    /** Override a HUMAN_TAKEOVER_CONFLICT claim (server already supports it). */
    force?: boolean;
    /** Applies only with hitl:true (ADR-0013 §8); server defaults it. */
    handoff_reason?: ManualHandoffReason;
    resolution_note?: string;
    last_seen_message_id?: string;
  }
): Promise<Conversation> {
  const response: AxiosResponse<ApiResponse<Conversation>> = await httpClient.patch(
    `/api/conversation/${conversationId}`,
    updates
  );
  return response.data.data;
}

export async function transcribeVoice(
  request: VoiceTranscriptionRequest
): Promise<VoiceTranscriptionResponse> {
  const response: AxiosResponse<ApiResponse<VoiceTranscriptionResponse>> = await httpClient.post(
    '/api/voice/transcribe',
    request
  );
  return response.data.data;
}

// Response Templates
export async function getResponseTemplates(): Promise<ResponseTemplate[]> {
  const response: AxiosResponse<ApiResponse<ResponseTemplate[]>> = await httpClient.get(
    '/api/templates'
  );
  return response.data.data;
}

export async function createTemplate(
  template: Omit<ResponseTemplate, 'id'>
): Promise<ResponseTemplate> {
  const response: AxiosResponse<ApiResponse<ResponseTemplate>> = await httpClient.post(
    '/api/templates',
    template
  );
  return response.data.data;
}

export async function updateTemplate(
  templateId: string,
  template: Partial<ResponseTemplate>
): Promise<ResponseTemplate> {
  const response: AxiosResponse<ApiResponse<ResponseTemplate>> = await httpClient.patch(
    `/api/templates/${templateId}`,
    template
  );
  return response.data.data;
}

export async function deleteTemplate(templateId: string): Promise<void> {
  await httpClient.delete(`/api/templates/${templateId}`);
}

// MW-V1: the former createAuditLog() helper POSTed /api/audit — a route the
// backend never mounted (audit.routes.js exposes only GET /logs, GET
// /resource/:type/:id, POST /cleanup). Ownership/CRM changes are now audited
// SERVER-side (see conversation.service CONVERSATION_OWNERSHIP_UPDATE), so the
// client-side write helper is removed rather than kept as a silent no-op.


