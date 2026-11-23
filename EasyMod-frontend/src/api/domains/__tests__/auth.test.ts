/**
 * Auth Domain API Tests
 * Comprehensive tests for authentication operations
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as auth from '../auth';
import { httpClient } from '@/shared/lib/http/client';

// Mock the HTTP client
vi.mock('@/shared/lib/http/client', () => ({
  httpClient: {
    post: vi.fn(),
    get: vi.fn(),
    clearCsrfToken: vi.fn(),
    initCsrfToken: vi.fn().mockResolvedValue(undefined),
    setSessionHint: vi.fn(),
  },
}));

describe('Auth Domain API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('signin', () => {
    it('should sign in user successfully', async () => {
      const mockResponse = {
        data: {
          data: {
            user: { id: '1', email: 'test@example.com', full_name: 'Test User' },
            currentShop: { id: 'shop1', unique_code: 'SHOP001', role: 'owner' as const },
            allShops: [{ id: 'shop1', unique_code: 'SHOP001', role: 'owner' as const }],
          },
        },
      };
      (httpClient.post as any).mockResolvedValue(mockResponse);

      const result = await auth.signin({ email: 'test@example.com', password: 'password123' });

      expect(httpClient.post).toHaveBeenCalledWith('/api/auth/signin', { email: 'test@example.com', password: 'password123' });
      expect(httpClient.clearCsrfToken).toHaveBeenCalled();
      expect(httpClient.initCsrfToken).toHaveBeenCalled();
      expect(result.user).toEqual(mockResponse.data.data.user);
      expect(result.currentShop).toEqual(mockResponse.data.data.currentShop);
    });

    it('should throw error on failed signin', async () => {
      (httpClient.post as any).mockRejectedValue(new Error('Invalid credentials'));

      await expect(auth.signin({ email: 'test@example.com', password: 'wrong' })).rejects.toThrow('Invalid credentials');
    });
  });

  describe('signup', () => {
    it('should create account successfully', async () => {
      const mockResponse = {
        data: {
          data: {
            user: { id: '2', email: 'new@example.com', full_name: 'New User' },
            currentShop: { id: 'shop2', unique_code: 'SHOP002', role: 'owner' as const },
            allShops: [{ id: 'shop2', unique_code: 'SHOP002', role: 'owner' as const }],
          },
        },
      };
      (httpClient.post as any).mockResolvedValue(mockResponse);

      const result = await auth.signup({ email: 'new@example.com', password: 'password123', full_name: 'New User', accepted_terms: true });

      expect(httpClient.post).toHaveBeenCalledWith('/api/auth/signup', { email: 'new@example.com', password: 'password123', full_name: 'New User', accepted_terms: true }, { timeout: 30000 });
      expect(result.user).toEqual(mockResponse.data.data.user);
      expect(result.currentShop).toEqual(mockResponse.data.data.currentShop);
    });

    it('grants signup ONLY the extended cold-server timeout', async () => {
      // A8 merchant pass (F-1): a cold local server answered signup 201 in
      // 12.18 s while the shared client aborts at 10 s — the UI then lied
      // "failed" about an account that existed. Signup carries a targeted 30 s
      // budget; signin (fast path) must keep the client default.
      (httpClient.post as any).mockResolvedValue({ data: { data: { user: {}, allShops: [] } } });

      await auth.signup({ email: 'cold@example.com', password: 'password123', full_name: 'Cold', accepted_terms: true });
      expect(httpClient.post).toHaveBeenLastCalledWith('/api/auth/signup', expect.anything(), { timeout: 30000 });

      await auth.signin({ email: 'fast@example.com', password: 'password123' });
      expect(httpClient.post).toHaveBeenLastCalledWith('/api/auth/signin', { email: 'fast@example.com', password: 'password123' });
    });

    it('should normalize response when only shop is returned', async () => {
      const mockResponse = {
        data: {
          data: {
            user: { id: '2', email: 'new@example.com', full_name: 'New User' },
            shop: { id: 'shop2', unique_code: 'SHOP002', role: 'owner' as const },
          },
        },
      };
      (httpClient.post as any).mockResolvedValue(mockResponse);

      const result = await auth.signup({ email: 'new@example.com', password: 'password123', full_name: 'New User', accepted_terms: true });

      expect(result.currentShop).toEqual(mockResponse.data.data.shop);
      expect(result.allShops).toHaveLength(1);
    });
  });

  describe('forgotPassword', () => {
    it('should send reset email successfully', async () => {
      const mockResponse = { data: { data: { message: 'Reset email sent' } } };
      (httpClient.post as any).mockResolvedValue(mockResponse);

      const result = await auth.forgotPassword('test@example.com');

      expect(httpClient.post).toHaveBeenCalledWith('/api/auth/forgot-password', { email: 'test@example.com' });
      expect(result.message).toBe('Reset email sent');
    });

    it('should return fallback message when no data', async () => {
      const mockResponse = { data: { message: 'Custom message' } };
      (httpClient.post as any).mockResolvedValue(mockResponse);

      const result = await auth.forgotPassword('test@example.com');

      expect(result.message).toBe('Custom message');
    });
  });

  describe('resetPassword', () => {
    it('should reset password successfully', async () => {
      const mockResponse = { data: { data: { message: 'Password reset successful' } } };
      (httpClient.post as any).mockResolvedValue(mockResponse);

      const result = await auth.resetPassword('reset-token', 'newpassword123');

      expect(httpClient.post).toHaveBeenCalledWith('/api/auth/reset-password', { token: 'reset-token', password: 'newpassword123' });
      expect(result.message).toBe('Password reset successful');
    });
  });

  describe('logout', () => {
    it('should logout successfully', async () => {
      (httpClient.post as any).mockResolvedValue({ data: {} });

      await auth.logout();

      expect(httpClient.post).toHaveBeenCalledWith('/api/auth/logout');
    });

    it('should not throw even when server fails', async () => {
      (httpClient.post as any).mockRejectedValue(new Error('Server error'));

      await expect(auth.logout()).resolves.not.toThrow();
    });
  });

  describe('getAuthContext', () => {
    it('should return auth context', async () => {
      const mockResponse = {
        data: {
          data: {
            user: { id: '1', email: 'test@example.com', full_name: 'Test User' },
            currentShop: { id: 'shop1', unique_code: 'SHOP001', role: 'owner' as const },
            allShops: [{ id: 'shop1', unique_code: 'SHOP001', role: 'owner' as const }],
          },
        },
      };
      (httpClient.get as any).mockResolvedValue(mockResponse);

      const result = await auth.getAuthContext();

      expect(httpClient.get).toHaveBeenCalledWith('/api/auth/me');
      expect(result.user).toEqual(mockResponse.data.data.user);
      expect(result.allShops).toHaveLength(1);
    });

    it('forwards a bounded recheck config without a global error toast', async () => {
      // The signup-timeout session recheck must fail quietly and fast — the
      // honest outcome copy is rendered by the signup flow itself.
      (httpClient.get as any).mockResolvedValue({
        data: { data: { user: {}, currentShop: {}, allShops: [] } },
      });

      await auth.getAuthContext({ timeoutMs: 5000, skipGlobalErrorToast: true });

      expect(httpClient.get).toHaveBeenCalledWith('/api/auth/me', { timeout: 5000, __skipGlobalErrorToast: true });
    });
  });

  describe('refreshToken', () => {
    it('should refresh token successfully', async () => {
      const mockResponse = { data: { data: { refreshed: true } } };
      (httpClient.post as any).mockResolvedValue(mockResponse);

      const result = await auth.refreshToken();

      expect(httpClient.post).toHaveBeenCalledWith('/api/auth/refresh', {});
      expect(result.refreshed).toBe(true);
    });
  });

  describe('getShops', () => {
    it('should return list of shops', async () => {
      const mockResponse = {
        data: {
          data: [
            { id: 'shop1', unique_code: 'SHOP001', role: 'owner' as const },
            { id: 'shop2', unique_code: 'SHOP002', role: 'admin' as const },
          ],
        },
      };
      (httpClient.get as any).mockResolvedValue(mockResponse);

      const result = await auth.getShops();

      expect(httpClient.get).toHaveBeenCalledWith('/api/shop/list');
      expect(result).toHaveLength(2);
    });
  });

  describe('createShop', () => {
    it('should create shop successfully', async () => {
      const mockResponse = {
        data: {
          data: { id: 'shop3', unique_code: 'SHOP003', role: 'owner' as const, shop_name: 'New Shop' },
        },
      };
      (httpClient.post as any).mockResolvedValue(mockResponse);

      const result = await auth.createShop({ shop_name: 'New Shop' });

      expect(httpClient.post).toHaveBeenCalledWith('/api/shop/create', { shop_name: 'New Shop' });
      expect(result.shop_name).toBe('New Shop');
    });
  });

  describe('switchShop', () => {
    it('should switch shop successfully', async () => {
      const mockResponse = {
        data: {
          data: { currentShop: { id: 'shop2', unique_code: 'SHOP002', role: 'owner' as const } },
        },
      };
      (httpClient.post as any).mockResolvedValue(mockResponse);

      const result = await auth.switchShop('shop2');

      expect(httpClient.post).toHaveBeenCalledWith('/api/shop/switch', { shopId: 'shop2' });
      expect(result.currentShop.id).toBe('shop2');
    });
  });
});
