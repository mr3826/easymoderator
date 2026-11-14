import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getMetaChannelSettings,
  updateMetaChannelSettings,
  channelQueryKeys,
} from '../meta-channels';
import { httpClient } from '@/shared/lib/http/client';

vi.mock('@/shared/lib/http/client', () => ({
  httpClient: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
  },
}));

describe('Meta channel settings API (ADR-0013 §2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reads effective channel settings from the channel-scoped route', async () => {
    const payload = {
      confidenceThresholdSend: 0.8,
      confidenceThresholdSuggest: 0.5,
      businessHours: { mon: { open: '09:00', close: '18:00' } },
      allowOrderCreation: true,
      purposeLabel: 'Sales',
      overrides: { automation_mode: 'DRAFT' },
      effective: {
        automation_mode: 'DRAFT',
        confidence_threshold: 80,
        greeting: { enabled: true, custom_text: 'Hi' },
        business_hours: null,
        allow_order_creation: true,
        purpose_label: 'Sales',
      },
      mode_source: 'channel_override',
      warnings: ['override_clamped_by_business'],
      emergency_stop: { active: false, at: null, by: null, source: null, prior_mode: null },
      billing_ai_active: true,
      deprecated_fields: ['confidenceThresholdSend', 'confidenceThresholdSuggest'],
    };
    (httpClient.get as any).mockResolvedValue({ data: { data: payload } });

    const result = await getMetaChannelSettings('channel-1');

    expect(httpClient.get).toHaveBeenCalledWith('/api/channels/meta/channel-1/settings');
    expect(result.mode_source).toBe('channel_override');
    expect(result.overrides).toEqual({ automation_mode: 'DRAFT' });
    expect(result.effective.automation_mode).toBe('DRAFT');
    expect(result.emergency_stop.active).toBe(false);
    expect(result.billing_ai_active).toBe(true);
  });

  it('patches overrides, including null to revert a key to inherit', async () => {
    (httpClient.patch as any).mockResolvedValue({ data: { data: {} } });

    await updateMetaChannelSettings('channel-1', {
      overrides: { automation_mode: null, confidence_threshold: 90 },
    });

    expect(httpClient.patch).toHaveBeenCalledWith('/api/channels/meta/channel-1/settings', {
      overrides: { automation_mode: null, confidence_threshold: 90 },
    });
  });

  it('exposes the frozen react-query keys', () => {
    expect(channelQueryKeys.list()).toEqual(['channels']);
    expect(channelQueryKeys.settings('abc')).toEqual(['channel-settings', 'abc']);
  });
});