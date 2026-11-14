/**
 * Shop Domain API Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as shop from '../shop';
import { httpClient } from '@/shared/lib/http/client';

vi.mock('@/shared/lib/http/client', () => ({
  httpClient: {
    get: vi.fn(),
    put: vi.fn(),
    post: vi.fn(),
  },
}));

describe('Shop Domain API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getShopBusinessInfo', () => {
    it('should return business info and shop data', async () => {
      const mockData = {
        businessInfo: { name: 'Test Shop', address: '123 Main St' },
        shop: { id: 'shop1', shop_name: 'Test Shop' },
      };
      (httpClient.get as any).mockResolvedValue({ data: { data: mockData } });

      const result = await shop.getShopBusinessInfo();

      expect(httpClient.get).toHaveBeenCalledWith('/api/shop/business-info');
      expect(result.businessInfo.name).toBe('Test Shop');
      expect(result.shop.id).toBe('shop1');
    });

    it('should propagate errors', async () => {
      (httpClient.get as any).mockRejectedValue(new Error('Unauthorized'));

      await expect(shop.getShopBusinessInfo()).rejects.toThrow('Unauthorized');
    });
  });

  describe('updateShopBusinessInfo', () => {
    it('should update and return business info', async () => {
      const payload = { name: 'Updated Shop', phone: '+8801700000000' };
      const updated = { name: 'Updated Shop', phone: '+8801700000000' };
      (httpClient.put as any).mockResolvedValue({ data: { data: updated } });

      const result = await shop.updateShopBusinessInfo(payload);

      expect(httpClient.put).toHaveBeenCalledWith('/api/shop/business-info', payload);
      expect(result.name).toBe('Updated Shop');
    });

    it('should propagate validation errors', async () => {
      (httpClient.put as any).mockRejectedValue({ response: { status: 400 } });

      await expect(shop.updateShopBusinessInfo({})).rejects.toMatchObject({
        response: { status: 400 },
      });
    });
  });

  describe('getShopAISettings', () => {
    it('should return AI settings', async () => {
      const mockSettings = {
        automation_mode: 'AI_ACTIVE',
        ai_enabled: true,
        response_language: 'bn',
        confidence_threshold: 0.7,
        auto_reply: true,
      };
      (httpClient.get as any).mockResolvedValue({ data: { data: mockSettings } });

      const result = await shop.getShopAISettings();

      expect(httpClient.get).toHaveBeenCalledWith('/api/shop/ai-settings');
      expect(result.automation_mode).toBe('AUTO');
      expect(result.ai_enabled).toBe(true);
      expect(result.response_language).toBe('bn');
    });

    it('fails closed when the response contains an unknown mode', async () => {
      (httpClient.get as any).mockResolvedValue({
        data: { data: { automation_mode: 'GARBAGE' } },
      });

      const result = await shop.getShopAISettings();

      expect(result.automation_mode).toBe('MANUAL');
    });

    it('preserves the read-only emergency stop block', async () => {
      (httpClient.get as any).mockResolvedValue({
        data: {
          data: {
            automation_mode: 'MANUAL',
            emergency_stop: {
              active: true,
              at: '2026-11-14T00:00:00.000Z',
              by: 'user-1',
              source: 'merchant',
              prior_mode: 'DRAFT',
            },
          },
        },
      });

      const result = await shop.getShopAISettings();

      expect(result.emergency_stop?.active).toBe(true);
      expect(result.emergency_stop?.source).toBe('merchant');
      expect(result.emergency_stop?.prior_mode).toBe('DRAFT');
    });
  });

  describe('updateShopAISettings', () => {
    it('should update and return new AI settings', async () => {
      const payload = { ai_enabled: false, confidence_threshold: 0.8 } as any;
      (httpClient.put as any).mockResolvedValue({ data: { data: payload } });

      const result = await shop.updateShopAISettings(payload);

      expect(httpClient.put).toHaveBeenCalledWith('/api/shop/ai-settings', payload);
      expect(result.ai_enabled).toBe(false);
    });

    it('should propagate errors on update failure', async () => {
      (httpClient.put as any).mockRejectedValue(new Error('Server error'));

      await expect(shop.updateShopAISettings({} as any)).rejects.toThrow('Server error');
    });
  });

  describe('emergencyStop', () => {
    it('posts to the business emergency-stop route', async () => {
      const state = {
        active: true,
        at: '2026-11-14T00:00:00.000Z',
        by: 'user-1',
        source: 'merchant',
        prior_mode: 'DRAFT',
        already_active: false,
      };
      (httpClient.post as any).mockResolvedValue({ data: { data: state } });

      const result = await shop.emergencyStop();

      expect(httpClient.post).toHaveBeenCalledWith('/api/shop/ai/emergency-stop', {});
      expect(result.active).toBe(true);
    });

    it('forwards an optional reason', async () => {
      (httpClient.post as any).mockResolvedValue({ data: { data: { active: true } } });

      await shop.emergencyStop('runaway replies');

      expect(httpClient.post).toHaveBeenCalledWith('/api/shop/ai/emergency-stop', {
        reason: 'runaway replies',
      });
    });
  });

  describe('emergencyResume', () => {
    it('posts to the resume route and keeps the mode at MANUAL', async () => {
      (httpClient.post as any).mockResolvedValue({
        data: { data: { active: false, automation_mode: 'MANUAL', prior_mode: 'DRAFT' } },
      });

      const result = await shop.emergencyResume();

      expect(httpClient.post).toHaveBeenCalledWith('/api/shop/ai/emergency-resume', {});
      expect(result.automation_mode).toBe('MANUAL');
      expect(result.prior_mode).toBe('DRAFT');
    });
  });

  describe('getShop', () => {
    it('should return shop with success flag', async () => {
      const mockResponse = { success: true, data: { id: 'shop1', shop_name: 'My Shop', plan_code: 'SHURU' } };
      (httpClient.get as any).mockResolvedValue({ data: mockResponse });

      const result = await shop.getShop();

      expect(httpClient.get).toHaveBeenCalledWith('/api/shop/me');
      expect(result.success).toBe(true);
      expect(result.data.shop_name).toBe('My Shop');
    });
  });

  describe('updateShop', () => {
    it('should update shop with provided data', async () => {
      const updated = { id: 'shop1', shop_name: 'Renamed Shop' };
      (httpClient.post as any).mockResolvedValue({ data: { data: updated } });

      const result = await shop.updateShop('shop1', { shop_name: 'Renamed Shop' });

      expect(httpClient.post).toHaveBeenCalledWith('/api/shop/update', {
        shopId: 'shop1',
        shop_name: 'Renamed Shop',
      });
      expect(result.shop_name).toBe('Renamed Shop');
    });

    it('should merge shopId into the request body', async () => {
      (httpClient.post as any).mockResolvedValue({ data: { data: {} } });

      await shop.updateShop('shop99', { logo_url: 'https://cdn.example.com/logo.png' });

      expect(httpClient.post).toHaveBeenCalledWith('/api/shop/update', {
        shopId: 'shop99',
        logo_url: 'https://cdn.example.com/logo.png',
      });
    });
  });
});
