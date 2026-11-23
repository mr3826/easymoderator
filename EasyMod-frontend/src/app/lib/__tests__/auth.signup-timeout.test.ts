/**
 * A8 merchant pass F-1 (CRITICAL): a cold server answered POST /api/auth/signup
 * with 201 Created in 12.18 s while the client aborted at 10 s, and the UI told
 * the first-time merchant "Request timeout. Please try again." about an account
 * that in fact existed. The signup flow therefore:
 *   (a) carries a targeted longer client timeout (domains/auth test), and
 *   (b) on timeout, re-queries session state before declaring anything —
 *       a session that exists completes the SUCCESS path, and when none is
 *       found the thrown error is re-rendered by Signup as honest
 *       "still creating — try signing in" copy (never "creation failed").
 * These tests pin (b) with fake timers so the recovery window is deterministic
 * (lesson from the #305 flake round: no real sleeps in timing tests).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const apiClient = vi.hoisted(() => ({
  signup: vi.fn(),
  signin: vi.fn(),
  getAuthContext: vi.fn(),
  logout: vi.fn(),
  refreshToken: vi.fn(),
  verifyTwoFactor: vi.fn(),
  getShops: vi.fn(),
  createShop: vi.fn(),
  switchShop: vi.fn(),
}));

vi.mock('@/api', () => ({ apiClient, default: apiClient }));
vi.mock('@/shared/lib/http/client', () => ({
  httpClient: {
    abortPendingRefresh: vi.fn(),
    clearCsrfToken: vi.fn(),
    initCsrfToken: vi.fn(),
    setSessionHint: vi.fn(),
  },
}));
vi.mock('@/app/lib/config', () => ({
  isMarketingSurface: () => true,
  toApiRequestPath: (p: string) => p,
}));
vi.mock('@/app/lib/queryClient', () => ({
  queryClient: { invalidateQueries: vi.fn() },
}));

import { AuthService } from '../auth';

const timeoutError = () => ({
  type: 'TIMEOUT_ERROR',
  statusCode: 408,
  message: 'Request timeout. Please try again.',
  timestamp: '2026-11-24T00:00:00.000Z',
});

const unauthorizedError = () => ({
  type: 'UNAUTHORIZED',
  statusCode: 401,
  message: 'Unauthorized. Please login again.',
  timestamp: '2026-11-24T00:00:00.000Z',
});

const authContext = {
  user: { id: 'u1', email: 'a8@pilot.test', full_name: 'Merchant' },
  currentShop: { id: 's1', unique_code: 'SHOP001', role: 'owner' },
  allShops: [{ id: 's1', unique_code: 'SHOP001', role: 'owner' }],
};

const signupPayload = {
  email: 'a8@pilot.test',
  password: 'ValidPass123!',
  full_name: 'Merchant',
  phone: '01711223344',
  accepted_terms: true,
} as never;

/** Drive fake timers while letting queued promise callbacks settle. */
async function runFor(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
}

describe('AuthService.signup — cold-timeout session recovery (A8 F-1)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('completes the success path when the session recheck finds the account', async () => {
    const svc = new AuthService();
    apiClient.signup.mockRejectedValueOnce(timeoutError());
    apiClient.getAuthContext
      .mockRejectedValueOnce(unauthorizedError())
      .mockResolvedValueOnce(authContext);

    const attempt = svc.signup(signupPayload);
    const resolved = expect(attempt).resolves.toBeUndefined();
    await runFor(2000);
    await runFor(4000);
    await resolved;

    expect(apiClient.getAuthContext).toHaveBeenCalledTimes(2);
    expect(apiClient.getAuthContext).toHaveBeenCalledWith({ timeoutMs: 5000, skipGlobalErrorToast: true });
    const state = svc.getState();
    expect(state.isAuthenticated).toBe(true);
    expect(state.user?.id).toBe('u1');
    expect(state.currentShop?.id).toBe('s1');
    expect(state.isLoading).toBe(false);
  });

  it('rejects after a bounded recheck window when no session exists, without claiming success', async () => {
    const svc = new AuthService();
    apiClient.signup.mockRejectedValueOnce(timeoutError());
    apiClient.getAuthContext.mockRejectedValue(unauthorizedError());

    const attempt = svc.signup(signupPayload);
    const rejected = expect(attempt).rejects.toMatchObject({ type: 'TIMEOUT_ERROR' });
    await runFor(30000);
    await rejected;

    // Bounded: exactly two rechecks, then give up and hand the caller the
    // timeout error so the signup UI can render honest "still creating" copy.
    expect(apiClient.getAuthContext).toHaveBeenCalledTimes(2);
    const state = svc.getState();
    expect(state.isAuthenticated).toBe(false);
    expect(state.isLoading).toBe(false);
  });

  it('does not recheck the session for non-timeout signup failures', async () => {
    const svc = new AuthService();
    apiClient.signup.mockRejectedValueOnce({
      type: 'VALIDATION_ERROR',
      statusCode: 400,
      message: 'User with this email already exists',
      timestamp: '2026-11-24T00:00:00.000Z',
    });

    await expect(svc.signup(signupPayload)).rejects.toMatchObject({ statusCode: 400 });
    expect(apiClient.getAuthContext).not.toHaveBeenCalled();
  });

  it('never runs a recheck on the fast success path', async () => {
    const svc = new AuthService();
    apiClient.signup.mockResolvedValueOnce({
      user: authContext.user,
      currentShop: authContext.currentShop,
      allShops: authContext.allShops,
    });

    await expect(svc.signup(signupPayload)).resolves.toBeUndefined();
    expect(apiClient.getAuthContext).not.toHaveBeenCalled();
    expect(svc.getState().isAuthenticated).toBe(true);
  });

  it('gives up cleanly when a recheck itself hangs, and never spins forever', async () => {
    const svc = new AuthService();
    apiClient.signup.mockRejectedValueOnce(timeoutError());
    apiClient.getAuthContext.mockReturnValue(new Promise(() => {})); // never settles

    const attempt = svc.signup(signupPayload);
    const rejected = expect(attempt).rejects.toMatchObject({ type: 'TIMEOUT_ERROR' });
    await runFor(120000);
    await rejected;
  });
});
