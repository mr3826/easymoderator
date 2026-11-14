/**
 * Subscription Domain API Tests — ADR-0011 contract-only billing.
 *
 * The plan catalog is retired: these tests pin the tombstone behaviour (no
 * request, no substituted price) and the billing-lines validator.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as subscription from '../subscription';
import { httpClient } from '@/shared/lib/http/client';
import { COMMERCIAL_CONTRACT_VERSION } from '@/shared/contracts/commercial-contract';

vi.mock('@/shared/lib/http/client', () => ({
  httpClient: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
  },
}));

const LINE = {
  id: 'line-1',
  invoiceId: '0f9b5a2e-1c3d-4e5f-8a9b-0c1d2e3f4a5b',
  orderId: 'order-1',
  lineKind: 'DELIVERED_ORDER',
  outcome: 'DELIVERED',
  unitPriceMinor: 1000,
  amountMinor: 1000,
  currency: 'BDT',
  contractVersion: COMMERCIAL_CONTRACT_VERSION,
  createdAt: '2026-11-14T00:00:00.000Z',
};

describe('Subscription Domain API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getSubscription', () => {
    it('returns subscription details', async () => {
      const mockResponse = {
        data: {
          data: {
            subscription: { plan_code: 'MERCHANT', status: 'active' },
            usage: {},
          },
        },
      };
      (httpClient.get as any).mockResolvedValue(mockResponse);

      const result = await subscription.getSubscription();

      expect(httpClient.get).toHaveBeenCalledWith('/api/subscription');
      expect(result.subscription.plan_code).toBe('MERCHANT');
    });
  });

  describe('retired subscription catalog', () => {
    it('fails closed without requesting the retired plan endpoint', async () => {
      await expect(subscription.getSubscriptionPlans()).rejects.toMatchObject({
        code: 'SUBSCRIPTION_CATALOG_RETIRED',
      });
      expect(httpClient.get).not.toHaveBeenCalled();
    });

    it('exposes the public catalog as a tombstone', async () => {
      await expect(subscription.getPublicSubscriptionCatalog()).rejects.toMatchObject({
        code: 'SUBSCRIPTION_CATALOG_RETIRED',
      });
      await expect(subscription.getCurrentPublicSubscriptionCatalog()).rejects.toMatchObject({
        code: 'SUBSCRIPTION_CATALOG_RETIRED',
      });
      expect(subscription.hasRequiredPublicPlans()).toBe(false);
    });

    it('retires prepaid credit purchases', async () => {
      await expect(subscription.getTopupPacks()).rejects.toMatchObject({ code: 'SUBSCRIPTION_CATALOG_RETIRED' });
      await expect(subscription.initiateTopup('anything')).rejects.toMatchObject({ code: 'SUBSCRIPTION_CATALOG_RETIRED' });
      await expect(subscription.completeTopup('topup-1', 'pay-1')).rejects.toMatchObject({ code: 'SUBSCRIPTION_CATALOG_RETIRED' });
      expect(httpClient.post).not.toHaveBeenCalled();
    });

    it('does not subscribe to a retired plan', async () => {
      await expect(subscription.subscribeToPlan('anything')).rejects.toMatchObject({
        code: 'SUBSCRIPTION_CATALOG_RETIRED',
      });
      expect(httpClient.put).not.toHaveBeenCalled();
    });
  });

  describe('getBillingLines', () => {
    it('requests tenant-scoped lines for one invoice', async () => {
      (httpClient.get as any).mockResolvedValue({
        data: { success: true, data: { invoiceId: LINE.invoiceId, contractVersion: COMMERCIAL_CONTRACT_VERSION, lines: [LINE] } },
      });

      const lines = await subscription.getBillingLines(LINE.invoiceId);

      expect(httpClient.get).toHaveBeenCalledWith('/api/commercial/billing-lines', {
        params: { invoiceId: LINE.invoiceId },
      });
      expect(lines).toHaveLength(1);
      expect(lines[0].amountMinor).toBe(1000);
    });

    it('rejects a non-BDT line instead of guessing a currency', async () => {
      (httpClient.get as any).mockResolvedValue({
        data: { success: true, data: { lines: [{ ...LINE, currency: 'USD' }] } },
      });

      await expect(subscription.getBillingLines(LINE.invoiceId)).rejects.toThrow(/currency must be BDT/);
    });

    it('rejects a fractional minor amount', async () => {
      (httpClient.get as any).mockResolvedValue({
        data: { success: true, data: { lines: [{ ...LINE, amountMinor: 10.5 }] } },
      });

      await expect(subscription.getBillingLines(LINE.invoiceId)).rejects.toThrow(/integer minor amount/);
    });

    it('rejects a current-contract line whose unit price drifts from the contract', async () => {
      (httpClient.get as any).mockResolvedValue({
        data: { success: true, data: { lines: [{ ...LINE, unitPriceMinor: 999 }] } },
      });

      await expect(subscription.getBillingLines(LINE.invoiceId)).rejects.toThrow(/does not match contract/);
    });

    it('rejects an unsuccessful envelope', async () => {
      (httpClient.get as any).mockResolvedValue({ data: { success: false, data: { lines: [] } } });

      await expect(subscription.getBillingLines(LINE.invoiceId)).rejects.toThrow(/did not succeed/);
    });
  });
});