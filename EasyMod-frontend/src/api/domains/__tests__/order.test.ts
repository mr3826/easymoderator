/**
 * Order Domain API Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as order from '../order';
import { httpClient } from '@/shared/lib/http/client';

vi.mock('@/shared/lib/http/client', () => ({
  httpClient: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    put: vi.fn(),
  },
}));

describe('Order Domain API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getOrders', () => {
    it('should return list of orders, normalised from the backend snake_case shape', async () => {
      const mockResponse = {
        data: {
          data: [
            {
              id: '1', total: 100, order_status: 'confirmed',
              customer_name: 'Rahim', customer_phone: '01712345678',
              delivery_address: 'Mirpur 10, Dhaka', created_at: '2026-06-13T10:00:00Z',
              items: [{ product_id: 'p1', product_name: 'Azal Lawn', quantity: 2, price: 1650 }],
            },
          ],
        },
      };
      (httpClient.get as any).mockResolvedValue(mockResponse);

      const result = await order.getOrders();

      expect(httpClient.get).toHaveBeenCalledWith('/api/order', { params: undefined });
      // The backend sends order_status / customer_name; the app reads status / customerName.
      expect(result[0].status).toBe('confirmed');
      expect(result[0].customerName).toBe('Rahim');
      expect(result[0].customerPhone).toBe('01712345678');
      expect(result[0].deliveryAddress).toBe('Mirpur 10, Dhaka');
      expect(result[0].createdAt).toBe('2026-06-13T10:00:00Z');
      expect(result[0].items[0].productName).toBe('Azal Lawn');
      expect(result[0].items[0].quantity).toBe(2);
    });

    // FE-08: the ONLY safe link from an order to a conversation is the
    // shop-scoped customer id — it must survive normalisation (flat column on
    // list rows, nested customer object on detail rows). Manual orders without
    // a customer record must normalise to undefined, never guess by name.
    it('carries customerId through normalisation (FE-08)', async () => {
      (httpClient.get as any).mockResolvedValue({
        data: { data: [
          { id: '1', customer_name: 'Rahim', customer_id: 'cust-1' },
          { id: '2', customer: { id: 'cust-2', name: 'Karim' } },
          { id: '3', customer_name: 'No Link', customer_id: null, customer: null },
        ] },
      });

      const result = await order.getOrders();

      expect(result[0].customerId).toBe('cust-1');
      expect(result[1].customerId).toBe('cust-2');
      expect(result[2].customerId).toBeUndefined();
    });

    it('returns an empty array when the API sends a non-array payload', async () => {
      (httpClient.get as any).mockResolvedValue({ data: { data: null } });
      const result = await order.getOrders();
      expect(result).toEqual([]);
    });

    it('keeps a structured delivery_address object and also exposes a readable string', async () => {
      const mockResponse = {
        data: {
          data: [{
            id: '9', total: 0, order_status: 'draft',
            delivery_address: { street_address: 'House 5', upazila: 'Savar', district: 'Dhaka', division: 'Dhaka', zone: 'sub_dhaka' },
            items: [],
          }],
        },
      };
      (httpClient.get as any).mockResolvedValue(mockResponse);

      const result = await order.getOrders();
      expect(typeof result[0].delivery_address).toBe('object');
      expect(result[0].delivery_address?.zone).toBe('sub_dhaka');
      expect(result[0].deliveryAddress).toContain('House 5');
      expect(result[0].deliveryAddress).toContain('Savar');
    });

    it('should handle query parameters', async () => {
      const mockResponse = { data: { data: [] } };
      (httpClient.get as any).mockResolvedValue(mockResponse);

      await order.getOrders({ status: 'pending', page: 1, limit: 10 });

      expect(httpClient.get).toHaveBeenCalledWith('/api/order', { params: { status: 'pending', page: 1, limit: 10 } });
    });
  });

  describe('getOrder', () => {
    it('should return single order', async () => {
      const mockResponse = {
        data: {
          data: { id: '1', total: 100, status: 'pending', items: [] },
        },
      };
      (httpClient.get as any).mockResolvedValue(mockResponse);

      const result = await order.getOrder('1');

      expect(httpClient.get).toHaveBeenCalledWith('/api/order/1');
      expect(result.id).toBe('1');
    });
  });

  describe('createOrder', () => {
    it('should create order successfully', async () => {
      const orderData = { items: [{ product_id: '1', quantity: 2 }], customer_id: 'cust1' };
      const mockResponse = {
        data: { data: { id: '3', ...orderData, status: 'pending' } },
      };
      (httpClient.post as any).mockResolvedValue(mockResponse);

      const result = await order.createOrder(orderData as any);

      expect(httpClient.post).toHaveBeenCalledWith('/api/order', orderData);
      expect(result.id).toBe('3');
    });

    it('sends an optional idempotency key as an HTTP header', async () => {
      const orderData = { customer_name: 'Rahim', items: [] };
      (httpClient.post as any).mockResolvedValue({ data: { data: { id: 'order-1' } } });

      await order.createOrder(orderData as any, 'same-request-key');

      expect(httpClient.post).toHaveBeenCalledWith('/api/order', orderData, {
        headers: { 'Idempotency-Key': 'same-request-key' },
      });
    });
  });

  describe('updateOrder', () => {
    it('translates status → order_status so the backend actually applies it', async () => {
      const mockResponse = { data: { data: { id: '1', order_status: 'cancelled' } } };
      (httpClient.patch as any).mockResolvedValue(mockResponse);

      const result = await order.updateOrder('1', { status: 'cancelled' });

      // The bug: the app sent { status } but the API only honours { order_status },
      // so Cancel silently did nothing. The boundary now maps it correctly.
      expect(httpClient.patch).toHaveBeenCalledWith('/api/order/1', { order_status: 'cancelled' });
      expect(result.id).toBe('1');
      expect(result.status).toBe('cancelled');
    });

    it('passes a note-only update through unchanged', async () => {
      (httpClient.patch as any).mockResolvedValue({ data: { data: { id: '1', note: 'call before delivery' } } });

      await order.updateOrder('1', { note: 'call before delivery' });

      expect(httpClient.patch).toHaveBeenCalledWith('/api/order/1', { note: 'call before delivery' });
    });

    it('sends a verified payment method through the audited update path', async () => {
      (httpClient.patch as any).mockResolvedValue({ data: { data: { id: '1', payment_method: 'cod' } } });

      await order.updateOrder('1', { payment_method: 'cod' });

      expect(httpClient.patch).toHaveBeenCalledWith('/api/order/1', { payment_method: 'cod' });
    });
  });

  describe('confirmOrder', () => {
    it('should confirm order', async () => {
      const mockResponse = {
        data: { data: { id: '1', status: 'confirmed' } },
      };
      (httpClient.post as any).mockResolvedValue(mockResponse);

      const result = await order.confirmOrder('1');

      expect(httpClient.post).toHaveBeenCalledWith('/api/order/1/confirm');
      expect(result.status).toBe('confirmed');
    });
  });

  describe('cancelOrder', () => {
    it('should cancel order with reason', async () => {
      const mockResponse = {
        data: { data: { id: '1', status: 'cancelled' } },
      };
      (httpClient.post as any).mockResolvedValue(mockResponse);

      await order.cancelOrder('1', 'Out of stock');

      expect(httpClient.post).toHaveBeenCalledWith('/api/order/1/cancel', { reason: 'Out of stock' });
    });

    it('should cancel order without reason', async () => {
      const mockResponse = {
        data: { data: { id: '1', status: 'cancelled' } },
      };
      (httpClient.post as any).mockResolvedValue(mockResponse);

      await order.cancelOrder('1');

      expect(httpClient.post).toHaveBeenCalledWith('/api/order/1/cancel', { reason: undefined });
    });

    it('normalizes the snake_case response so the status pill is not blank', async () => {
      // The bug: cancelOrder returned raw response.data.data, so the backend's
      // snake_case (order_status / customer_name) left status undefined and the
      // status pill blank until a manual refresh. It must normalize like every
      // other order fn.
      const mockResponse = {
        data: { data: { id: '1', order_status: 'cancelled', customer_name: 'Karim' } },
      };
      (httpClient.post as any).mockResolvedValue(mockResponse);

      const result = await order.cancelOrder('1', 'Out of stock');

      expect(result.status).toBe('cancelled');
      expect(result.customerName).toBe('Karim');
    });

    it('accepts the legacy top-level cancel response during deploy rollouts', async () => {
      const mockResponse = {
        data: { id: '1', order_status: 'cancelled', customer_name: 'Karim' },
      };
      (httpClient.post as any).mockResolvedValue(mockResponse);

      const result = await order.cancelOrder('1', 'Out of stock');

      expect(result.status).toBe('cancelled');
      expect(result.customerName).toBe('Karim');
    });
  });

  describe('bookCourier', () => {
    it('should book courier successfully', async () => {
      const payload = {
        provider: 'steadfast',
        recipient_name: 'Test Customer',
        recipient_phone: '01700000000',
        recipient_address: 'Mirpur, Dhaka',
      };
      const mockResponse = {
        data: { data: { tracking_id: 'TRK123', provider: 'steadfast' } },
      };
      (httpClient.post as any).mockResolvedValue(mockResponse);

      const result = await order.bookCourier('1', payload as any);

      expect(httpClient.post).toHaveBeenCalledWith('/api/order/1/courier', payload);
      expect(result.tracking_id).toBe('TRK123');
    });
  });

  describe('getCourierEligibility', () => {
    it('passes the requested provider and returns the server verdict unchanged', async () => {
      const verdict = {
        provider: 'redx',
        decision: 'NOT_SERVICEABLE',
        reason_code: 'NO_AREA_MATCH',
        source: 'order_destination',
        checked_at: '2026-11-03T00:00:00.000Z',
        ttl_seconds: 300,
      };
      (httpClient.get as any).mockResolvedValue({ data: { data: verdict } });

      const result = await order.getCourierEligibility('1', 'redx');

      expect(httpClient.get).toHaveBeenCalledWith(
        '/api/order/1/courier/eligibility',
        { params: { provider: 'redx' } },
      );
      expect(result).toEqual(verdict);
    });

    it('omits the provider param so the server uses the shop default', async () => {
      (httpClient.get as any).mockResolvedValue({
        data: { data: { decision: 'UNCERTAIN', provider: 'steadfast' } },
      });

      await order.getCourierEligibility('1');

      expect(httpClient.get).toHaveBeenCalledWith(
        '/api/order/1/courier/eligibility',
        { params: undefined },
      );
    });
  });

  describe('getDeliverySettings', () => {
    it('should return delivery settings', async () => {
      const mockResponse = {
        data: {
          data: {
            providers: [
              {
                provider: 'pathao',
                display_name: 'Pathao Courier',
                is_connected: true,
                is_active: true,
                is_sandbox: false,
                last_validated_at: null,
                connected_at: null,
              },
              {
                provider: 'steadfast',
                display_name: 'Steadfast Courier',
                is_connected: false,
                is_active: false,
                is_sandbox: false,
                last_validated_at: null,
                connected_at: null,
              },
            ],
            settings: {
              default_delivery_charge: 50,
              cod_enabled: true,
              cod_charge: 0,
              non_refundable: false,
              area_pricing: [],
              weight_tiers: [],
            },
          },
        },
      };
      (httpClient.get as any).mockResolvedValue(mockResponse);

      const result = await order.getDeliverySettings();

      expect(httpClient.get).toHaveBeenCalledWith('/api/shop/delivery/settings');
      expect(result.providers).toHaveLength(2);
    });
  });

  describe('connectDeliveryProvider', () => {
    it('should connect provider with credentials', async () => {
      (httpClient.post as any).mockResolvedValue({ data: {} });

      const payload = { provider: 'pathao' as any, credentials: { client_id: '123', client_secret: 'secret' } };
      await order.connectDeliveryProvider(payload);

      expect(httpClient.post).toHaveBeenCalledWith('/api/shop/delivery/connect', payload);
    });
  });

  describe('disconnectDeliveryProvider', () => {
    it('should disconnect provider', async () => {
      (httpClient.post as any).mockResolvedValue({ data: {} });

      await order.disconnectDeliveryProvider('pathao' as any);

      expect(httpClient.post).toHaveBeenCalledWith('/api/shop/delivery/disconnect', { provider: 'pathao' });
    });
  });

  describe('toggleDeliveryProvider', () => {
    it('should toggle provider on via POST', async () => {
      (httpClient.post as any).mockResolvedValue({ data: {} });

      await order.toggleDeliveryProvider('pathao' as any, true);

      expect(httpClient.post).toHaveBeenCalledWith('/api/shop/delivery/toggle', { provider: 'pathao', is_active: true });
    });

    it('should toggle provider off', async () => {
      (httpClient.post as any).mockResolvedValue({ data: {} });

      await order.toggleDeliveryProvider('steadfast' as any, false);

      expect(httpClient.post).toHaveBeenCalledWith('/api/shop/delivery/toggle', { provider: 'steadfast', is_active: false });
    });
  });

  describe('updateDeliverySettings', () => {
    it('should update settings', async () => {
      (httpClient.put as any).mockResolvedValue({ data: {} });

      const settings = { default_delivery_charge: 50, cod_enabled: true };
      await order.updateDeliverySettings(settings);

      expect(httpClient.put).toHaveBeenCalledWith('/api/shop/delivery/settings', settings);
    });

    it('should update partial settings', async () => {
      (httpClient.put as any).mockResolvedValue({ data: {} });

      await order.updateDeliverySettings({ cod_charge: 20 });

      expect(httpClient.put).toHaveBeenCalledWith('/api/shop/delivery/settings', { cod_charge: 20 });
    });
  });

  describe('testDeliveryConnection', () => {
    it('should test delivery provider connection', async () => {
      (httpClient.post as any).mockResolvedValue({ data: {} });

      await order.testDeliveryConnection('pathao' as any);

      expect(httpClient.post).toHaveBeenCalledWith('/api/shop/delivery/test', { provider: 'pathao' });
    });
  });

  describe('courier setup', () => {
    it('activates, deactivates, and assigns the AI default through dedicated endpoints', async () => {
      (httpClient.post as any).mockResolvedValue({ data: { data: { provider: 'pathao' } } });

      await order.activateDeliveryProvider('pathao');
      await order.deactivateDeliveryProvider('pathao');
      await order.setAiDefaultDeliveryProvider('pathao');

      expect(httpClient.post).toHaveBeenNthCalledWith(1, '/api/shop/delivery/activate', { provider: 'pathao' });
      expect(httpClient.post).toHaveBeenNthCalledWith(2, '/api/shop/delivery/deactivate', { provider: 'pathao' });
      expect(httpClient.post).toHaveBeenNthCalledWith(3, '/api/shop/delivery/ai-default', { provider: 'pathao' });
    });

    it('uses pickup CRUD and provider sync endpoints without legacy priority writes', async () => {
      (httpClient.get as any).mockResolvedValue({ data: { success: true, data: { locations: [{ id: 'pickup-1' }] } } });
      (httpClient.post as any).mockResolvedValue({ data: { success: true, data: { id: 'pickup-1' } } });
      (httpClient.put as any).mockResolvedValue({ data: { success: true, data: { id: 'pickup-1' } } });

      const payload = {
        display_name: 'Warehouse',
        phone: '01712345678',
        address: 'Road 1',
        area_name: 'Mirpur',
      };
      const locations = await order.getPickupLocations();
      await order.createPickupLocation(payload);
      await order.updatePickupLocation('pickup-1', payload);
      await order.syncProviderPickup('redx', {
        pickup_location_id: 'pickup-1',
        provider_pickup_meta: { delivery_area_id: 9 },
      });

      expect(locations).toEqual([{ id: 'pickup-1' }]);
      expect(httpClient.get).toHaveBeenCalledWith('/api/shop/delivery/pickup-locations');
      expect(httpClient.post).toHaveBeenNthCalledWith(1, '/api/shop/delivery/pickup-locations', payload);
      expect(httpClient.put).toHaveBeenCalledWith('/api/shop/delivery/pickup-locations', { ...payload, id: 'pickup-1' });
      expect(httpClient.post).toHaveBeenNthCalledWith(2, '/api/shop/delivery/redx/pickup/sync', {
        pickup_location_id: 'pickup-1',
        provider_pickup_meta: { delivery_area_id: 9 },
      });
    });

    it('unwraps Pathao and RedX location lists from their keyed response shapes', async () => {
      (httpClient.get as any)
        .mockResolvedValueOnce({ data: { success: true, data: { cities: [{ id: 1, name: 'Dhaka' }] } } })
        .mockResolvedValueOnce({ data: { success: true, data: { zones: [{ id: 2, name: 'Gulshan' }] } } })
        .mockResolvedValueOnce({ data: { success: true, data: { areas: [{ id: 3, name: 'Gulshan 1' }] } } })
        .mockResolvedValueOnce({ data: { success: true, data: { areas: [{ id: 4, name: 'Mirpur' }] } } });

      await expect(order.getPathaoCities()).resolves.toEqual([{ id: 1, name: 'Dhaka' }]);
      await expect(order.getPathaoZones(1)).resolves.toEqual([{ id: 2, name: 'Gulshan' }]);
      await expect(order.getPathaoAreas(2)).resolves.toEqual([{ id: 3, name: 'Gulshan 1' }]);
      await expect(order.getProviderAreas('redx')).resolves.toEqual([{ id: 4, name: 'Mirpur' }]);

      expect(httpClient.get).toHaveBeenNthCalledWith(1, '/api/shop/delivery/pathao/cities');
      expect(httpClient.get).toHaveBeenNthCalledWith(2, '/api/shop/delivery/pathao/cities/1/zones');
      expect(httpClient.get).toHaveBeenNthCalledWith(3, '/api/shop/delivery/pathao/zones/2/areas');
      expect(httpClient.get).toHaveBeenNthCalledWith(4, '/api/shop/delivery/redx/areas');
    });
  });
});
