import { afterEach, describe, expect, it, vi } from 'vitest';
import * as customerIntelligence from '../customer-intelligence';
import { httpClient } from '@/shared/lib/http/client';

vi.mock('@/shared/lib/http/client', () => ({
  httpClient: { get: vi.fn(), post: vi.fn() },
}));

afterEach(() => vi.clearAllMocks());

describe('customer intelligence API', () => {
  it('returns overview definitions and coverage from the gated overview endpoint', async () => {
    const overview = {
      total_records: 10,
      buyers: 4,
      repeat_buyers: 2,
      new_buyers: 1,
      open_opportunities: 3,
      scanned_orders: 10,
      total_linked_orders: 10,
      order_scan_cap: 1000,
      coverage_complete: true,
      definitions: {
        buyers: 'At least one delivered order',
        repeat_buyers: 'At least two delivered orders',
        new_buyers: 'First delivered order in the last 30 days',
        open_opportunities: 'Live opportunities',
        order_linkage: 'Customer metrics use linked orders only',
      },
    };
    (httpClient.get as any).mockResolvedValue({ data: { data: overview } });

    await expect(customerIntelligence.getCustomerOverview()).resolves.toEqual(overview);
    expect(httpClient.get).toHaveBeenCalledWith('/api/customer-intelligence/overview');
  });

  it('forwards customer search and AND filters to the 360 list', async () => {
    (httpClient.get as any).mockResolvedValue({
      data: { data: [], total: 0, page: 1, pageSize: 20 },
    });

    await customerIntelligence.listCustomers360({
      page: 2,
      pageSize: 20,
      search: '01712345678',
      phone: '01712345678',
      channel_type: 'messenger',
    });

    expect(httpClient.get).toHaveBeenCalledWith('/api/customer-intelligence/customers', {
      params: {
        page: 2,
        pageSize: 20,
        search: '01712345678',
        phone: '01712345678',
        channel_type: 'messenger',
      },
    });
  });
});
