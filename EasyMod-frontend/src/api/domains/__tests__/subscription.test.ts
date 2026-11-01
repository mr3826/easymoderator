/**
 * Subscription Domain API Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as subscription from '../subscription';
import { httpClient } from '@/shared/lib/http/client';
import { publicApiGet } from '@/shared/lib/http/public-client';

const LIVE_PLANS = [
  {
    code: 'SHURU', name: 'Shuru', public_name: 'Get Your Moderator',
    description: 'No monthly plan fee; the active allowance counts Messenger conversations.',
    description_bn: 'মাসিক প্ল্যান ফি নেই; Messenger কথোপকথন গণনা হয়।', billing_model: 'flat_monthly',
    price_bdt_monthly: 0, price_bdt_yearly: 0, conversations_limit: 100,
    orders_limit: -1, products_limit: -1, can_purchase_topups: false,
    per_order_charge_bdt: null, features: {}, topup_packs: [], partner_order_tiers: [],
    support_reply_allowance: { amount: 300, unit: 'provider_accepted_ai_reply', period: 'utc_calendar_month', status: 'shadow_only', billable: false, enforced: false },
  },
  {
    code: 'GROWTH', name: 'Growth', public_name: 'Moderator Plus',
    description: 'Monthly subscription with conversation-only top-ups.',
    description_bn: 'মাসিক সাবস্ক্রিপশন; top-up-এ কথোপকথন যোগ হয়।', billing_model: 'flat_monthly',
    price_bdt_monthly: 999, price_bdt_yearly: 9990, conversations_limit: 500,
    orders_limit: -1, products_limit: -1, can_purchase_topups: true,
    per_order_charge_bdt: null, features: {},
    topup_packs: [{ code: 'PACK_100', conversations: 100, priceBdt: 250 }], partner_order_tiers: [],
    support_reply_allowance: { amount: 3000, unit: 'provider_accepted_ai_reply', period: 'utc_calendar_month', status: 'shadow_only', billable: false, enforced: false },
  },
  {
    code: 'PARTNER', name: 'Partner', public_name: 'Partnership',
    description: 'No upfront subscription; billed by delivered-order bands.',
    description_bn: 'কোনো upfront subscription নেই; delivered-order band অনুযায়ী বিল।', billing_model: 'per_order',
    price_bdt_monthly: 0, price_bdt_yearly: 0, conversations_limit: -1,
    orders_limit: -1, products_limit: -1, can_purchase_topups: false,
    per_order_charge_bdt: null, features: {}, topup_packs: [],
    partner_order_tiers: [{ minOrders: 300, maxOrders: 999, rateBdt: 15 }], support_reply_allowance: null,
  },
];

vi.mock('@/shared/lib/http/client', () => ({
  httpClient: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
  },
}));
vi.mock('@/shared/lib/http/public-client', () => ({
  publicApiGet: vi.fn(),
}));

describe('Subscription Domain API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getSubscription', () => {
    it('should return subscription details', async () => {
      const mockResponse = {
        data: {
          data: {
            subscription: { plan_code: 'SHURU', status: 'active' },
            usage: {},
          },
        },
      };
      (httpClient.get as any).mockResolvedValue(mockResponse);

      const result = await subscription.getSubscription();

      expect(httpClient.get).toHaveBeenCalledWith('/api/subscription');
      expect(result.subscription.plan_code).toBe('SHURU');
    });
  });

  describe('getSubscriptionPlans', () => {
    it('should return available plans', async () => {
      const mockResponse = { success: true, data: LIVE_PLANS };
      (publicApiGet as any).mockResolvedValue(mockResponse);

      const result = await subscription.getSubscriptionPlans();

      expect(publicApiGet).toHaveBeenCalledWith('/api/subscription/plans');
      expect(result.map((plan) => plan.code)).toEqual(['SHURU', 'GROWTH', 'PARTNER']);
      expect(result.map((plan) => plan.publicName)).toEqual(['Get Your Moderator', 'Moderator Plus', 'Partnership']);
      expect(result.find((plan) => plan.code === 'GROWTH')?.supportReplyAllowance?.amount).toBe(3000);
    });

    it('does not substitute pinned commercial values when the live catalog is unavailable', async () => {
      (publicApiGet as any).mockRejectedValue(new Error('offline'));

      await expect(subscription.getPublicSubscriptionCatalog()).rejects.toThrow('offline');
    });

    it('marks a successful catalog response as live', async () => {
      (publicApiGet as any).mockResolvedValue({ success: true, data: LIVE_PLANS });

      const result = await subscription.getPublicSubscriptionCatalog();

      expect(result.source).toBe('live');
      expect(result.plans.map((plan) => plan.code)).toEqual(['SHURU', 'GROWTH', 'PARTNER']);
    });

    it('rejects unavailable live catalog data instead of returning pinned prices', async () => {
      (publicApiGet as any).mockRejectedValue(new Error('offline'));

      await expect(subscription.getCurrentPublicSubscriptionCatalog()).rejects.toThrow('offline');
    });

    it('rejects an empty live catalog rather than presenting a stale price list', async () => {
      (publicApiGet as any).mockResolvedValue({ success: true, data: [] });

      await expect(subscription.getCurrentPublicSubscriptionCatalog()).rejects.toThrow(/catalog/i);
    });

    it('rejects a live catalog that omits the accepted-reply allowance instead of pinning it locally', async () => {
      const incomplete = LIVE_PLANS.map((plan) => ({ ...plan }));
      delete (incomplete[0] as any).support_reply_allowance;
      (publicApiGet as any).mockResolvedValue({ success: true, data: incomplete });

      await expect(subscription.getCurrentPublicSubscriptionCatalog()).rejects.toThrow(/shadow allowance/i);
    });
  });

  describe('subscribeToPlan', () => {
    it('should subscribe to plan', async () => {
      const mockResponse = {
        data: { data: { plan: 'PRO', status: 'active' } },
      };
      (httpClient.put as any).mockResolvedValue(mockResponse);

      const result = await subscription.subscribeToPlan('pro', 'yearly');

      expect(httpClient.put).toHaveBeenCalledWith('/api/subscription/plan', { plan_code: 'PRO', billing_cycle: 'yearly' });
      expect(result.status).toBe('active');
    });

    it('should use monthly as default billing cycle', async () => {
      const mockResponse = { data: { data: {} } };
      (httpClient.put as any).mockResolvedValue(mockResponse);

      await subscription.subscribeToPlan('SHURU');

      expect(httpClient.put).toHaveBeenCalledWith('/api/subscription/plan', { plan_code: 'SHURU', billing_cycle: 'monthly' });
    });
  });

  describe('cancelSubscription', () => {
    it('should cancel with no reason by default', async () => {
      const mockResponse = { data: { data: { status: 'cancelled' } } };
      (httpClient.post as any).mockResolvedValue(mockResponse);

      const result = await subscription.cancelSubscription();

      expect(httpClient.post).toHaveBeenCalledWith('/api/subscription/cancel', { reason: undefined });
      expect(result.status).toBe('cancelled');
    });

    it('should forward a cancellation reason when provided', async () => {
      const mockResponse = { data: { data: { status: 'cancelled' } } };
      (httpClient.post as any).mockResolvedValue(mockResponse);

      await subscription.cancelSubscription('Too expensive');

      expect(httpClient.post).toHaveBeenCalledWith('/api/subscription/cancel', { reason: 'Too expensive' });
    });
  });

  describe('reactivateSubscription', () => {
    it('should reactivate subscription', async () => {
      const mockResponse = { data: { data: { status: 'active' } } };
      (httpClient.post as any).mockResolvedValue(mockResponse);

      const result = await subscription.reactivateSubscription();

      expect(httpClient.post).toHaveBeenCalledWith('/api/subscription/reactivate');
      expect(result.status).toBe('active');
    });
  });

  describe('getPaymentMethods', () => {
    it('should return payment methods', async () => {
      const mockResponse = {
        data: {
          data: [
            { id: 'pm1', type: 'card', last4: '4242' },
          ],
        },
      };
      (httpClient.get as any).mockResolvedValue(mockResponse);

      const result = await subscription.getPaymentMethods();

      expect(httpClient.get).toHaveBeenCalledWith('/api/payment-methods/available');
      expect(result[0].last4).toBe('4242');
    });
  });
});
