import { apiClient } from '@/api';
import { httpClient } from '@/shared/lib/http/client';
import { isApiError } from '@/shared/lib/http/errors';
import type { User, Shop, SigninRequest, SignupRequest, CreateShopRequest } from '@/api/types';
import { queryClient } from './queryClient';
import { isMarketingSurface } from './config';

/**
 * Signup timeout recovery (A8 merchant pass F-1, CRITICAL).
 *
 * A cold server can finish the signup transaction AFTER the client-side
 * request deadline (observed: 201 Created at 12.18 s vs a then-10 s axios
 * timeout). The domain layer now gives signup its own 30 s budget so the
 * normal outcome is a genuine full response. If even that aborts, declaring
 * "failed" would be a lie about a possibly-existing account, so we re-query
 * session state twice (bounded: +2 s and +4 s, each probe capped) before
 * letting the UI render honest "still creating — try signing in" copy.
 *
 * Honest caveat: when axios aborts, the browser discards the late response
 * and its Set-Cookie, so a recovered session here is the exception, not the
 * rule — the loop is a safety net for races where the response completed
 * around the abort and for any future flow where cookies survive it. The
 * copy for the give-up branch never claims creation failed either way.
 */
const SIGNUP_RECHECK_ATTEMPTS = [
  { delayMs: 2000, timeoutMs: 5000 },
  { delayMs: 4000, timeoutMs: 5000 },
] as const;

function waitWithDeadline<T>(promise: Promise<T>, deadlineMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('session-recheck-deadline')), deadlineMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

// Auth state interface
export interface AuthState {
  user: User | null;
  currentShop: Shop | null;
  allShops: Shop[];
  isAuthenticated: boolean;
  isLoading: boolean;
  /** Set when signin requires a 2FA step. Cleared on successful verify or re-attempt. */
  pendingTwoFactor: { tempToken: string } | null;
}

export class AuthService {
  private authState: AuthState = {
    user: null,
    currentShop: null,
    allShops: [],
    isAuthenticated: false,
    isLoading: true,
    pendingTwoFactor: null,
  };

  private listeners: ((state: AuthState) => void)[] = [];
  private initialization: Promise<void>;

  constructor() {
    this.initialization = this.initializeAuth();
  }

  private async initializeAuth() {
    // This constructor runs at module import, before any route loader or
    // surface guard. The marketing origin is deliberately excluded from the
    // credentialed CORS allowlist and has no merchant session to restore, so
    // probing /auth/me from there only yields a blocked cross-origin request
    // and a console error on every public page view.
    if (isMarketingSurface()) {
      this.setAuthState({ isLoading: false });
      return;
    }

    // Cap the entire initialization to 8 seconds. Without this bound,
    // a slow backend (cold-start, Redis reconnect) can hold the
    // initializeAuth() promise pending indefinitely, which causes every
    // ensureInitialized() caller (route loaders, AuthProvider) to block
    // forever — producing the infinite-spinner symptom after sign-in.
    const timeoutPromise = new Promise<void>((resolve) =>
      setTimeout(resolve, 8000)
    );

    const authPromise = (async () => {
      try {
        const authContext = await apiClient.getAuthContext();
        this.setAuthState({
          user: authContext.user,
          currentShop: authContext.currentShop,
          allShops: authContext.allShops,
          isAuthenticated: true,
          isLoading: false,
        });
      } catch (error) {
        // Guard: if signin() completed concurrently while this /me was in-flight,
        // don't overwrite the authenticated session — just clear the loading flag.
        if (this.authState.isAuthenticated) {
          this.setAuthState({ isLoading: false });
        } else {
          this.setAuthState({
            user: null,
            currentShop: null,
            allShops: [],
            isAuthenticated: false,
            isLoading: false,
          });
        }
      }
    })();

    // Race: whichever resolves first wins. If timeout fires first, the auth
    // state defaults to unauthenticated (isLoading still true at this point —
    // set it false so callers aren't stuck on a loading screen).
    await Promise.race([authPromise, timeoutPromise]);

    if (this.authState.isLoading) {
      // Timeout won — the /me + refresh chain is still in-flight.
      // Treat as unauthenticated; the in-flight chain will still complete
      // and update state correctly when it finishes, but route loaders
      // are no longer blocked.
      //
      // Critically: abort any in-progress token refresh immediately so that
      // isRefreshing is reset to false right now. Without this, isRefreshing
      // stays true until the background performTokenRefresh() finishes (up to
      // 37 s with ECONNABORTED retries). Any 401 received during that window
      // (e.g. from dashboard API calls after a successful sign-in) would be
      // pushed onto the refresh queue and silently wait — producing a
      // "stuck loading" spinner on the dashboard.
      httpClient.abortPendingRefresh();

      this.setAuthState({
        user: null,
        currentShop: null,
        allShops: [],
        isAuthenticated: false,
        isLoading: false,
      });
    }
  }

  async ensureInitialized(): Promise<void> {
    return this.initialization;
  }

  private setAuthState(state: Partial<AuthState>) {
    this.authState = { ...this.authState, ...state };
    this.notifyListeners();
  }

  private notifyListeners() {
    this.listeners.forEach(listener => listener(this.authState));
  }

  subscribe(listener: (state: AuthState) => void): () => void {
    this.listeners.push(listener);
    // Return unsubscribe function
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener);
    };
  }

  getState(): AuthState {
    return this.authState;
  }

  async signin(credentials: SigninRequest): Promise<void> {
    try {
      this.setAuthState({ isLoading: true });
      const authData = await apiClient.signin(credentials);

      this.setAuthState({
        user: authData.user,
        currentShop: authData.currentShop,
        allShops: authData.allShops,
        isAuthenticated: true,
        isLoading: false,
        pendingTwoFactor: null,
      });
    } catch (error: any) {
      if (error?.code === 'REQUIRES_2FA') {
        // Do NOT set isAuthenticated:true — the user has not fully authenticated.
        // Store the tempToken so TwoFactorVerify can use it without prop-drilling.
        this.setAuthState({
          isLoading: false,
          pendingTwoFactor: { tempToken: error.tempToken },
        });
        // Re-throw so the SignIn component can navigate to /2fa-verify.
        throw error;
      }
      this.setAuthState({ isLoading: false, pendingTwoFactor: null });
      throw error;
    }
  }

  async signup(userData: SignupRequest): Promise<void> {
    try {
      this.setAuthState({ isLoading: true });
      const authData = await apiClient.signup(userData);

      this.setAuthState({
        user: authData.user,
        currentShop: authData.currentShop,
        allShops: authData.allShops,
        isAuthenticated: true,
        isLoading: false,
      });
    } catch (error) {
      // Cold-server timeout (A8 F-1): re-query the session before anything is
      // declared. If a session exists, complete the normal success path —
      // the account genuinely exists and the browser genuinely holds cookies.
      if (isApiError(error) && error.type === 'TIMEOUT_ERROR') {
        const recovered = await this.recoverSessionAfterSignupTimeout();
        if (recovered) return;
      }
      this.setAuthState({ isLoading: false });
      throw error;
    }
  }

  private async recoverSessionAfterSignupTimeout(): Promise<boolean> {
    for (const { delayMs, timeoutMs } of SIGNUP_RECHECK_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      try {
        const authContext = await waitWithDeadline(
          apiClient.getAuthContext({ timeoutMs, skipGlobalErrorToast: true }),
          timeoutMs,
        );
        this.setAuthState({
          user: authContext.user,
          currentShop: authContext.currentShop,
          allShops: authContext.allShops,
          isAuthenticated: true,
          isLoading: false,
        });
        return true;
      } catch {
        // No session yet, or the probe itself failed/timed out — bounded loop.
      }
    }
    return false;
  }

  async switchShop(shopId: string): Promise<void> {
    const shop = this.authState.allShops.find(s => s.id === shopId);
    if (!shop) {
      throw new Error('Shop not found');
    }

    const result = await apiClient.switchShop(shopId);
    this.setAuthState({ currentShop: result.currentShop });
    await queryClient.invalidateQueries();
  }

  async refreshShops(): Promise<void> {
    if (!this.authState.isAuthenticated) return;

    const shops = await apiClient.getShops();
    const currentShop = this.authState.currentShop && shops.find(s => s.id === this.authState.currentShop?.id);

    this.setAuthState({
      allShops: shops,
      currentShop: currentShop || this.authState.currentShop || shops[0] || null,
    });
  }

  async createShop(payload: CreateShopRequest): Promise<Shop> {
    const newShop = await apiClient.createShop(payload);
    const switchResult = await apiClient.switchShop(newShop.id);
    const shops = await apiClient.getShops();

    this.setAuthState({
      allShops: shops,
      currentShop: switchResult.currentShop,
    });

    await queryClient.invalidateQueries();

    return newShop;
  }

  async verifyTwoFactor(code: string): Promise<void> {
    const pending = this.authState.pendingTwoFactor;
    if (!pending) throw new Error('No pending 2FA session');

    try {
      this.setAuthState({ isLoading: true });
      await apiClient.verifyTwoFactor(pending.tempToken, code);

      // Backend set the auth cookies — now fetch the full auth context.
      const authContext = await apiClient.getAuthContext();
      httpClient.clearCsrfToken();
      httpClient.initCsrfToken();

      this.setAuthState({
        user: authContext.user,
        currentShop: authContext.currentShop,
        allShops: authContext.allShops,
        isAuthenticated: true,
        isLoading: false,
        pendingTwoFactor: null,
      });
    } catch (error) {
      this.setAuthState({ isLoading: false });
      throw error;
    }
  }

  async refreshToken(): Promise<void> {
    await apiClient.refreshToken();
  }

  async logout(): Promise<void> {
    // Best-effort: blacklist the token and clear httpOnly cookies on the server.
    // Local state resets unconditionally so a network error never leaves the user
    // stuck in a half-authenticated state.
    try { await apiClient.logout(); } catch { /* best-effort */ }

    this.setAuthState({
      user: null,
      currentShop: null,
      allShops: [],
      isAuthenticated: false,
      isLoading: false,
    });
  }

  // Utility methods
  isAuthenticated(): boolean {
    return this.authState.isAuthenticated;
  }

  getCurrentShop(): Shop | null {
    return this.authState.currentShop;
  }

  getCurrentShopId(): string | null {
    return this.authState.currentShop?.id || null;
  }

  hasPermission(permission: string): boolean {
    if (!this.authState.currentShop) return false;

    // Shop role → permission matrix (mirrors SHOP_PERMISSION_MATRIX in rbac/types.ts)
    const SHOP_ROLE_PERMISSIONS: Record<string, string[]> = {
      owner: [
        'manage_products', 'manage_orders', 'view_reports', 'manage_channels',
        'manage_subscription', 'manage_staff', 'view_analytics', 'manage_settings',
        'manage_knowledge', 'manage_templates', 'manage_customers',
      ],
      admin: [
        'manage_products', 'manage_orders', 'view_reports', 'manage_channels',
        'view_analytics', 'manage_settings', 'manage_knowledge', 'manage_templates',
        'manage_customers',
      ],
      manager: [
        'manage_products', 'manage_orders', 'view_reports', 'manage_channels',
        'view_analytics', 'manage_knowledge', 'manage_templates', 'manage_customers',
      ],
      staff: ['manage_orders', 'view_reports', 'view_analytics'],
    };

    const role = (this.authState.currentShop.role ?? '').toLowerCase();
    return SHOP_ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
  }
}

// Export singleton instance
export const authService = new AuthService();

// Export convenience functions
export const logout = () => authService.logout();
