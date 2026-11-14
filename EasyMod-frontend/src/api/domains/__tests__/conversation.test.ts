/**
 * Conversation Domain API Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as conversation from '../conversation';
import { httpClient } from '@/shared/lib/http/client';
import { normalizeAiReplyMode } from '@/api/types/conversation';

vi.mock('@/shared/lib/http/client', () => ({
  httpClient: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

describe('Conversation Domain API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Conversations ──────────────────────────────────────────────────────────

  describe('getConversations', () => {
    it('should return paginated conversations', async () => {
      const mockData = { data: [{ id: 'c1', status: 'active' }], total: 1, page: 1, pageSize: 50 };
      (httpClient.get as any).mockResolvedValue({ data: { data: mockData } });

      const result = await conversation.getConversations();

      expect(httpClient.get).toHaveBeenCalledWith('/api/conversation', { params: undefined });
      expect(result).toEqual({ ...mockData, ai_reply_mode: 'MANUAL' });
    });

    it('should normalize production conversation list payloads', async () => {
      (httpClient.get as any).mockResolvedValue({
        data: {
          success: true,
          data: {
            conversations: [{ id: 'c1', status: 'active' }],
            pagination: { total: 1, page: 1, limit: 50, totalPages: 1 },
            ai_reply_mode: 'AI_ACTIVE',
          },
        },
      });

      const result = await conversation.getConversations({ limit: 50 });

      expect(httpClient.get).toHaveBeenCalledWith('/api/conversation', { params: { limit: 50 } });
      expect(result).toEqual({
        data: [{ id: 'c1', status: 'active' }],
        total: 1,
        page: 1,
        pageSize: 50,
        ai_reply_mode: 'AUTO',
      });
    });

    it('should forward query params', async () => {
      (httpClient.get as any).mockResolvedValue({ data: { data: {} } });

      await conversation.getConversations({ status: 'active', page: 2 });

      expect(httpClient.get).toHaveBeenCalledWith('/api/conversation', { params: { status: 'active', page: 2 } });
    });

    // FE-08: the optional second argument must thread the AbortSignal to the
    // HTTP layer for stale-request cancellation, and must OMIT the key entirely
    // when no signal is supplied so single-arg callers keep their exact config.
    it('passes an AbortSignal to the HTTP client when provided', async () => {
      (httpClient.get as any).mockResolvedValue({ data: { data: {} } });
      const controller = new AbortController();

      await conversation.getConversations({ customer_id: 'cust-1' }, controller.signal);

      expect(httpClient.get).toHaveBeenCalledWith(
        '/api/conversation',
        { params: { customer_id: 'cust-1' }, signal: controller.signal }
      );
    });

    it('omits the signal key when no AbortSignal is supplied', async () => {
      (httpClient.get as any).mockResolvedValue({ data: { data: {} } });

      await conversation.getConversations({ customer_id: 'cust-1' });

      expect(httpClient.get).toHaveBeenCalledWith(
        '/api/conversation',
        { params: { customer_id: 'cust-1' } }
      );
    });
  });

  describe('AiReplyMode normalization', () => {
    it.each([
      ['AUTO', 'AUTO'],
      ['AI_ACTIVE', 'AUTO'],
      ['DRAFT', 'DRAFT'],
      ['AI_SUGGEST_ONLY', 'DRAFT'],
      ['MANUAL', 'MANUAL'],
      ['HUMAN_ACTIVE', 'MANUAL'],
      [null, 'MANUAL'],
      [undefined, 'MANUAL'],
      ['', 'MANUAL'],
      ['GARBAGE', 'MANUAL'],
    ])('normalizes %s to %s', (value, expected) => {
      expect(normalizeAiReplyMode(value)).toBe(expected);
    });
  });

  describe('getConversation', () => {
    it('should return single conversation', async () => {
      const mockConv = { id: 'c1', status: 'active', customer_name: 'Alice' };
      (httpClient.get as any).mockResolvedValue({ data: { data: mockConv } });

      const result = await conversation.getConversation('c1');

      expect(httpClient.get).toHaveBeenCalledWith('/api/conversation/c1');
      expect(result.id).toBe('c1');
    });
  });

  describe('getMessages', () => {
    it('should return messages with pagination', async () => {
      const mockData = { messages: [{ id: 'm1', content: 'Hi' }], pagination: { page: 1, totalPages: 3 } };
      (httpClient.get as any).mockResolvedValue({ data: { data: mockData } });

      const result = await conversation.getMessages('c1', { page: 1, limit: 20 });

      expect(httpClient.get).toHaveBeenCalledWith('/api/conversation/c1/messages', { params: { page: 1, limit: 20 } });
      expect(result.messages).toHaveLength(1);
      expect(result.pagination.totalPages).toBe(3);
    });
  });

  describe('createMessage', () => {
    it('should post message to conversation', async () => {
      const msg = { content: 'Hello', sender: 'agent' as const, message_type: 'text' as const };
      const mockResponse = { id: 'm2', ...msg };
      (httpClient.post as any).mockResolvedValue({ data: { data: mockResponse } });

      const result = await conversation.createMessage('c1', msg);

      expect(httpClient.post).toHaveBeenCalledWith(
        '/api/conversation/c1/messages',
        msg,
        { __skipGlobalErrorToast: true },
      );
      expect(result.id).toBe('m2');
    });

    it('sends a stable idempotency header for merchant sends', async () => {
      const msg = { content: 'Hello', sender: 'agent' as const, message_type: 'text' as const };
      (httpClient.post as any).mockResolvedValue({ data: { data: { id: 'm2', ...msg } } });

      await conversation.createMessage('c1', msg, { idempotencyKey: 'send-key-12345' });

      expect(httpClient.post).toHaveBeenCalledWith(
        '/api/conversation/c1/messages',
        msg,
        { headers: { 'Idempotency-Key': 'send-key-12345' }, __skipGlobalErrorToast: true },
      );
    });
  });

  describe('Inbox lifecycle actions', () => {
    it('approves a draft through the scoped draft endpoint', async () => {
      (httpClient.post as any).mockResolvedValue({ data: { data: { message: { id: 'draft-1' } } } });

      await conversation.approveAiDraft('c1', 'draft-1', 'Edited reply');

      expect(httpClient.post).toHaveBeenCalledWith(
        '/api/conversation/c1/messages/draft-1/approve',
        { content: 'Edited reply' },
      );
    });

    it('persists dismiss and read actions through the server', async () => {
      (httpClient.post as any)
        .mockResolvedValueOnce({ data: { data: { message: { id: 'draft-1' } } } })
        .mockResolvedValueOnce({ data: { data: { id: 'c1', unreadCount: 0 } } });

      await conversation.dismissAiDraft('c1', 'draft-1');
      await conversation.markConversationRead('c1', 'customer-1');

      expect(httpClient.post).toHaveBeenNthCalledWith(
        1,
        '/api/conversation/c1/messages/draft-1/dismiss',
        {},
      );
      expect(httpClient.post).toHaveBeenNthCalledWith(
        2,
        '/api/conversation/c1/read',
        { message_id: 'customer-1' },
      );
    });
  });

  describe('updateConversation', () => {
    it('should update status to closed', async () => {
      const updated = { id: 'c1', status: 'closed' };
      (httpClient.patch as any).mockResolvedValue({ data: { data: updated } });

      const result = await conversation.updateConversation('c1', { status: 'closed' });

      expect(httpClient.patch).toHaveBeenCalledWith('/api/conversation/c1', { status: 'closed' });
      expect(result.status).toBe('closed');
    });

    it('should update hitl flag', async () => {
      const updated = { id: 'c1', hitl: true };
      (httpClient.patch as any).mockResolvedValue({ data: { data: updated } });

      await conversation.updateConversation('c1', { hitl: true });

      expect(httpClient.patch).toHaveBeenCalledWith('/api/conversation/c1', { hitl: true });
    });

    it('forwards force and a manual handoff reason on takeover', async () => {
      (httpClient.patch as any).mockResolvedValue({ data: { data: { id: 'c1', hitl: true } } });

      await conversation.updateConversation('c1', {
        hitl: true,
        force: true,
        handoff_reason: 'customer_request',
      });

      expect(httpClient.patch).toHaveBeenCalledWith('/api/conversation/c1', {
        hitl: true,
        force: true,
        handoff_reason: 'customer_request',
      });
    });
  });

  describe('transcribeVoice', () => {
    it('should transcribe voice request', async () => {
      const request = { audio_url: 'https://example.com/audio.mp3', language: 'bn' };
      const mockResult = { text: 'কেমন আছেন', confidence: 0.95 };
      (httpClient.post as any).mockResolvedValue({ data: { data: mockResult } });

      const result = await conversation.transcribeVoice(request as any);

      expect(httpClient.post).toHaveBeenCalledWith('/api/voice/transcribe', request);
      expect(result.text).toBe('কেমন আছেন');
    });
  });

  // ── Templates ──────────────────────────────────────────────────────────────

  describe('getResponseTemplates', () => {
    it('should return template list', async () => {
      const templates = [
        { id: 't1', title: 'Greeting', body: 'Hello!' },
        { id: 't2', title: 'Follow-up', body: 'How can I help?' },
      ];
      (httpClient.get as any).mockResolvedValue({ data: { data: templates } });

      const result = await conversation.getResponseTemplates();

      expect(httpClient.get).toHaveBeenCalledWith('/api/templates');
      expect(result).toHaveLength(2);
    });
  });

  describe('createTemplate', () => {
    it('should create a new template', async () => {
      const payload = { title: 'Thank You', body: 'Thank you for your order!' };
      const created = { id: 't3', ...payload };
      (httpClient.post as any).mockResolvedValue({ data: { data: created } });

      const result = await conversation.createTemplate(payload as any);

      expect(httpClient.post).toHaveBeenCalledWith('/api/templates', payload);
      expect(result.id).toBe('t3');
    });
  });

  describe('updateTemplate', () => {
    it('should update existing template', async () => {
      const patch = { body: 'Updated body' };
      const updated = { id: 't1', title: 'Greeting', body: 'Updated body' };
      (httpClient.patch as any).mockResolvedValue({ data: { data: updated } });

      const result = await conversation.updateTemplate('t1', patch as any);

      expect(httpClient.patch).toHaveBeenCalledWith('/api/templates/t1', patch);
      expect(result.body).toBe('Updated body');
    });
  });

  describe('deleteTemplate', () => {
    it('should delete template by id', async () => {
      (httpClient.delete as any).mockResolvedValue({ data: {} });

      await conversation.deleteTemplate('t1');

      expect(httpClient.delete).toHaveBeenCalledWith('/api/templates/t1');
    });
  });

  // MW-V1: the createAuditLog describe was removed with the helper — it pinned a
  // POST to /api/audit, a route the backend never mounted (a "test of illusion").
  // Ownership/CRM auditing is server-side now.

  // ── Error propagation ──────────────────────────────────────────────────────

  describe('error handling', () => {
    it('getConversations should propagate network errors', async () => {
      (httpClient.get as any).mockRejectedValue(new Error('Timeout'));

      await expect(conversation.getConversations()).rejects.toThrow('Timeout');
    });

    it('createMessage should propagate 400 errors', async () => {
      (httpClient.post as any).mockRejectedValue({ response: { status: 400, data: { error: 'Bad Request' } } });

      await expect(
        conversation.createMessage('c1', { content: '', sender: 'agent', message_type: 'text' })
      ).rejects.toMatchObject({ response: { status: 400 } });
    });
  });
});
