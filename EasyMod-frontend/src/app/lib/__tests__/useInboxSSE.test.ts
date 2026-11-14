import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useInboxSSE } from '../useInboxSSE';

const { getCurrentShopId } = vi.hoisted(() => ({
  getCurrentShopId: vi.fn(() => 'shop-1'),
}));

vi.mock('../auth', () => ({
  authService: { getCurrentShopId },
}));

type EventListener = (event: MessageEvent) => void;

class MockEventSource {
  static instances: MockEventSource[] = [];

  readonly listeners = new Map<string, EventListener>();
  readonly url: string;
  onerror: ((event: Event) => void) | null = null;
  onopen: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(event: string, listener: EventListenerOrEventListenerObject): void {
    this.listeners.set(event, listener as EventListener);
  }

  close(): void {}

  emit(event: string, data: string): void {
    this.listeners.get(event)?.({ data } as MessageEvent);
  }
}

describe('useInboxSSE', () => {
  beforeEach(() => {
    MockEventSource.instances = [];
    getCurrentShopId.mockReturnValue('shop-1');
    vi.stubGlobal('EventSource', MockEventSource);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    ['AI_ACTIVE', 'AUTO'],
    ['AI_SUGGEST_ONLY', 'DRAFT'],
    ['GARBAGE', 'MANUAL'],
  ])('normalizes the %s mode event to %s', (input, expected) => {
    const onAiReplyModeChanged = vi.fn();
    const { unmount } = renderHook(() => useInboxSSE({
      onNewMessage: vi.fn(),
      onHitlChanged: vi.fn(),
      onAiReplyModeChanged,
    }));

    const source = MockEventSource.instances[0];
    expect(source).toBeDefined();

    act(() => {
      source.emit('ai_reply_mode_changed', JSON.stringify({ mode: input }));
    });

    expect(onAiReplyModeChanged).toHaveBeenCalledWith({ mode: expected });
    unmount();
  });

  it('forwards read-watermark and customer-enrichment events without mutation', () => {
    const onConversationRead = vi.fn();
    const onCustomerUpdated = vi.fn();
    const { unmount } = renderHook(() => useInboxSSE({
      onNewMessage: vi.fn(),
      onHitlChanged: vi.fn(),
      onConversationRead,
      onCustomerUpdated,
    }));
    const source = MockEventSource.instances[0];

    act(() => {
      source.emit('conversation_read', JSON.stringify({
        conversation_id: 'conv-1', unread_count: 0, last_read_message_id: 'msg-1',
      }));
      source.emit('customer_updated', JSON.stringify({ customer_id: 'customer-1', name: 'A Customer' }));
    });

    expect(onConversationRead).toHaveBeenCalledWith({
      conversation_id: 'conv-1', unread_count: 0, last_read_message_id: 'msg-1',
    });
    expect(onCustomerUpdated).toHaveBeenCalledWith({ customer_id: 'customer-1', name: 'A Customer' });
    unmount();
  });

  it('forwards AI pause events so the Inbox can clear its local processing claim', () => {
    const onAiPaused = vi.fn();
    const { unmount } = renderHook(() => useInboxSSE({
      onNewMessage: vi.fn(),
      onHitlChanged: vi.fn(),
      onAiPaused,
    }));
    const source = MockEventSource.instances[0];

    act(() => {
      source.emit('ai_paused', JSON.stringify({
        conversation_id: 'conv-1',
        reason: 'usage_exhausted',
      }));
    });

    expect(onAiPaused).toHaveBeenCalledWith({
      conversation_id: 'conv-1',
      reason: 'usage_exhausted',
    });
    unmount();
  });

  it('delivers channel_settings_changed with a normalized effective mode', () => {
    const onChannelSettingsChanged = vi.fn();
    const { unmount } = renderHook(() => useInboxSSE({
      onNewMessage: vi.fn(),
      onHitlChanged: vi.fn(),
      onChannelSettingsChanged,
    }));

    const source = MockEventSource.instances[0];
    act(() => {
      source.emit('channel_settings_changed', JSON.stringify({
        channel_id: 'chan-1',
        effective_mode: 'AI_SUGGEST_ONLY',
        mode_source: 'channel_override',
        override_keys: ['automation_mode'],
      }));
    });

    expect(onChannelSettingsChanged).toHaveBeenCalledWith({
      channel_id: 'chan-1',
      effective_mode: 'DRAFT',
      mode_source: 'channel_override',
      override_keys: ['automation_mode'],
    });
    unmount();
  });

  it('delivers emergency_stop_changed with a normalized prior mode', () => {
    const onEmergencyStopChanged = vi.fn();
    const { unmount } = renderHook(() => useInboxSSE({
      onNewMessage: vi.fn(),
      onHitlChanged: vi.fn(),
      onEmergencyStopChanged,
    }));

    const source = MockEventSource.instances[0];
    act(() => {
      source.emit('emergency_stop_changed', JSON.stringify({
        active: true,
        at: '2026-11-14T00:00:00.000Z',
        by: 'owner-1',
        source: 'merchant',
        prior_mode: 'AI_ACTIVE',
      }));
    });

    expect(onEmergencyStopChanged).toHaveBeenCalledWith({
      active: true,
      at: '2026-11-14T00:00:00.000Z',
      by: 'owner-1',
      source: 'merchant',
      prior_mode: 'AUTO',
    });
    unmount();
  });
});
