/**
 * Authentication API Domain
 */

import { httpClient } from '@/shared/lib/http/client';
import type { ApiResponse } from '../types/common';
import type {
  User,
  Shop,
  AuthResponse,
  SigninRequest,
  SignupRequest,
  CreateShopRequest,
} from '../types/auth';
import type { ShopAgent } from '../types/dashboard';
import type { AxiosResponse } from 'axios';

/**
 * Sign in user with email and password
 * @param credentials - User signin credentials containing email and password
 * @returns Promise resolving to authentication response with user data and tokens
 * @throws {Error} When signin fails due to invalid credentials or network issues
 * @example
 * ```typescript
 * const result = await signin({ email: 'user@example.com', password: 'password123' });
 * ```
 */
export async function signin(credentials: SigninRequest): Promise<AuthResponse> {
  const response: AxiosResponse<ApiResponse<AuthResponse>> = await httpClient.post(
    '/api/auth/signin',
    credentials
  );
  const { data } = response.data;

  // When 2FA is enabled the backend does NOT issue full tokens yet.
  // It returns { requires2fa: true, tempToken } instead of the usual user/shop payload.
  // Signal this to the caller so it can route to the verification step without
  // setting isAuthenticated:true prematurely.
  if (data.requires2fa === true) {
    throw Object.assign(new Error('Two-factor authentication required'), {
      code: 'REQUIRES_2FA',
      tempToken: data.tempToken,
    });
  }

  // Refresh CSRF token for the new session — fire and forget so the caller
  // (navigate('/dashboard')) is not blocked waiting for the extra round-trip.
  httpClient.clearCsrfToken();
  httpClient.initCsrfToken();
  httpClient.setSessionHint(true);
  return data;
}

/**
 * Targeted client budget for signup ONLY (A8 merchant pass F-1, CRITICAL).
 * A cold server answered POST /auth/signup with 201 Created in 12.18 s while
 * the shared axios default aborts at 10 s — the first merchant moment then
 * lied ("Request timeout. Please try again.") about an account that existed.
 * 30 s keeps the honest full-response path (Set-Cookie arrives, true success)
 * for measured cold starts (12 s) with ~2.5x headroom, without slowing failure
 * detection everywhere else. Signin keeps the client default: it never showed
 * this behaviour and fast failure is better UX there.
 */
export const SIGNUP_REQUEST_TIMEOUT_MS = 30000;

export async function signup(userData: SignupRequest): Promise<AuthResponse> {
  const response: AxiosResponse<ApiResponse<AuthResponse>> = await httpClient.post(
    '/api/auth/signup',
    userData,
    { timeout: SIGNUP_REQUEST_TIMEOUT_MS }
  );
  const { data } = response.data;
  const normalizedData: AuthResponse = {
    user: data.user,
    currentShop: data.currentShop ?? data.shop,
    allShops: data.allShops ?? (data.shop ? [data.shop] : []),
  };
  httpClient.clearCsrfToken();
  httpClient.initCsrfToken();
  httpClient.setSessionHint(true);
  return normalizedData;
}

/**
 * Send password reset email to user
 * @param email - User email address to send reset link to
 * @returns Promise resolving to success message
 * @throws {Error} When email delivery fails
 * @example
 * ```typescript
 * const result = await forgotPassword('user@example.com');
 * console.log(result.message);
 * ```
 */
export async function forgotPassword(email: string): Promise<{ message: string }> {
  const response: AxiosResponse<ApiResponse<{ message: string }>> = await httpClient.post(
    '/api/auth/forgot-password',
    { email }
  );
  return response.data.data ?? {
    message: response.data.message ?? 'If an account exists, a reset link has been sent.',
  };
}

/**
 * Reset user password using reset token
 * @param token - Password reset token from email
 * @param password - New password to set
 * @returns Promise resolving to success message
 * @throws {Error} When token is invalid or password reset fails
 * @example
 * ```typescript
 * const result = await resetPassword('abc123', 'newPassword456');
 * console.log(result.message);
 * ```
 */
export async function resetPassword(token: string, password: string): Promise<{ message: string }> {
  const response: AxiosResponse<ApiResponse<{ message: string }>> = await httpClient.post(
    '/api/auth/reset-password',
    { token, password }
  );
  return response.data.data ?? { message: response.data.message ?? 'Password reset successfully.' };
}

/**
 * Log out current user and clear session
 * @returns Promise that resolves when logout completes
 * @throws {Error} When logout request fails
 * @example
 * ```typescript
 * await logout();
 * // User is now logged out
 * ```
 */
export async function logout(): Promise<void> {
  try {
    await httpClient.post('/api/auth/logout');
  } catch {
    // Best-effort — even if server fails, proceed
  } finally {
    // Always clear the hint, even if the server call failed: the client is
    // dropping its session either way, so future 401s must not trigger a
    // refresh attempt.
    httpClient.setSessionHint(false);
  }
}

export interface AuthContextRequestConfig {
  /** Per-request timeout override (ms) for the /auth/me fetch. */
  timeoutMs?: number;
  /** Suppress the global error toast — for probes whose outcome the caller
   * renders itself (e.g. the signup-timeout session recheck). */
  skipGlobalErrorToast?: boolean;
}

/**
 * Get current authentication context including user and shop information
 * @returns Promise resolving to auth context with user, current shop, and all shops
 * @throws {Error} When auth context cannot be retrieved
 * @example
 * ```typescript
 * const context = await getAuthContext();
 * console.log('Current user:', context.user);
 * console.log('Current shop:', context.currentShop);
 * ```
 */
export async function getAuthContext(requestConfig?: AuthContextRequestConfig): Promise<{
  user: User;
  currentShop: Shop;
  allShops: Shop[];
}> {
  const response: AxiosResponse<ApiResponse<{
    user: User;
    currentShop: Shop;
    allShops: Shop[];
  }>> = requestConfig
    ? await httpClient.get('/api/auth/me', {
        timeout: requestConfig.timeoutMs,
        ...(requestConfig.skipGlobalErrorToast ? { __skipGlobalErrorToast: true } : {}),
      })
    : await httpClient.get('/api/auth/me');
  // A valid session exists — re-arm the hint in case storage was cleared while
  // the cookies survived, so a later expiry can still be refreshed.
  httpClient.setSessionHint(true);
  return response.data.data;
}

/**
 * Refresh authentication tokens for current user
 * @returns Promise resolving to refresh status
 * @throws {Error} When token refresh fails
 * @example
 * ```typescript
 * const refreshed = await refreshToken();
 * console.log('Tokens refreshed:', refreshed.refreshed);
 * ```
 */
export async function refreshToken(): Promise<{ refreshed: boolean }> {
  const response: AxiosResponse<ApiResponse<{ refreshed: boolean }>> = await httpClient.post(
    '/api/auth/refresh',
    {}
  );
  return response.data.data;
}

/**
 * Verify the 6-digit TOTP code during the 2FA login step.
 * On success the backend sets httpOnly auth cookies exactly as a normal signin does.
 * The caller should then call getAuthContext() to hydrate the session.
 */
export async function verifyTwoFactor(tempToken: string, token: string): Promise<void> {
  await httpClient.post('/api/auth/2fa/verify', { tempToken, token });
}

/**
 * Get all shops for current user
 * @returns Promise resolving to array of shops
 * @throws {Error} When shop list cannot be retrieved
 * @example
 * ```typescript
 * const shops = await getShops();
 * console.log('Available shops:', shops.length);
 * ```
 */
export async function getShops(): Promise<Shop[]> {
  const response: AxiosResponse<ApiResponse<Shop[]>> = await httpClient.get('/api/shop/list');
  return response.data.data;
}

/**
 * Create new shop for user
 * @param payload - Shop creation data including name, domain, and settings
 * @returns Promise resolving to created shop object
 * @throws {Error} When shop creation fails due to validation or network issues
 * @example
 * ```typescript
 * const shop = await createShop({ 
 *   name: 'My Shop', 
 *   domain: 'myshop.example.com' 
 * });
 * ```
 */
export async function createShop(payload: CreateShopRequest): Promise<Shop> {
  const response: AxiosResponse<ApiResponse<Shop>> = await httpClient.post('/api/shop/create', payload);
  return response.data.data;
}

/**
 * Switch to a different shop for current user
 * @param shopId - ID of shop to switch to
 * @returns Promise resolving to current shop object
 * @throws {Error} When shop switch fails due to invalid shop ID or permissions
 * @example
 * ```typescript
 * const current = await switchShop('shop123');
 * console.log('Switched to:', current.currentShop.name);
 * ```
 */
export async function switchShop(shopId: string): Promise<{ currentShop: Shop }> {
  const response: AxiosResponse<ApiResponse<{ currentShop: Shop }>> = await httpClient.post(
    '/api/shop/switch',
    { shopId }
  );
  return response.data.data;
}

/**
 * Get shop agents for current shop
 * @returns Promise resolving to array of shop agents
 * @throws {Error} When shop agents retrieval fails
 * @example
 * ```typescript
 * const agents = await getShopAgents();
 * console.log('Available agents:', agents.length);
 * ```
 */
export async function getShopAgents(): Promise<ShopAgent[]> {
  const response: AxiosResponse<ApiResponse<ShopAgent[]>> = await httpClient.get('/api/shop/agents');
  return response.data.data ?? [];
}
