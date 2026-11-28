/**
 * Centralized HTTP Client with Interceptors
 * Single source of truth for all API communication
 * 
 * Features:
 * - Auth token injection (Bearer fallback)
 * - CSRF token protection for mutations
 * - Shop ID injection (for multi-tenant)
 * - Automatic token refresh with request queueing
 * - Automatic retry with exponential backoff
 * - Error normalization
 * 
 * Usage:
 * import { httpClient } from '@shared/lib/http/client';
 * const response = await httpClient.get('/api/endpoint');
 * 
 * Multi-tenant setup:
 * import { useShopId } from '@/shared/context/ShopContext';
 * import { useHttpShopId } from '@/shared/lib/http/useHttpShopId';
 * 
 * function App() {
 *   useHttpShopId(); // Syncs ShopContext with HTTP client
 *   return <Routes>...</Routes>;
 * }
 */

import axios, { AxiosInstance, AxiosError, AxiosResponse, InternalAxiosRequestConfig } from 'axios';
import { toast } from 'sonner';
import { normalizeApiError } from './errors';
import config, { toApiRequestPath } from '@/app/lib/config';

// Extend axios config to track retry count, CSRF init, and shopId injection
export interface ExtendedAxiosRequestConfig extends InternalAxiosRequestConfig {
  __retryCount?: number;
  __retry?: boolean;
  __csrfInit?: boolean;
  __skipShopId?: boolean;
  __skipGlobalErrorToast?: boolean;
  __idempotent?: boolean;
  __noRetry?: boolean;
}

export function shouldRetryRequest(
  config: Pick<ExtendedAxiosRequestConfig, 'method' | '__idempotent' | '__noRetry'>,
): boolean {
  const method = (config.method || 'GET').toUpperCase();
  return !config.__noRetry && (method === 'GET' || method === 'HEAD' || config.__idempotent === true);
}

/**
 * Marks that this browser has established a session at least once.
 *
 * The auth cookies are httpOnly, so JS cannot tell "logged out" from "access
 * token expired". Without a hint, every anonymous page view answered a 401 on
 * GET /api/auth/me by firing POST /api/auth/refresh — a request that can only
 * fail when there is no session. That wasted call is rate limited (10/min/IP on
 * /api/auth plus 20/5min/IP on the refresh route), and because Bangladeshi
 * mobile carriers put many users behind one NATed IP, anonymous landing-page
 * traffic could exhaust the budget and make real merchants' sign-ins 429.
 *
 * Persisted in localStorage so it survives a reload: the bootstrap /me on a
 * fresh page load still needs to know whether a refresh is worth attempting.
 * Clearing site data clears cookies and localStorage together, so the flag
 * cannot outlive the cookies it stands for.
 */
const SESSION_HINT_KEY = 'em.hasSession';

function readSessionHint(): boolean {
  try {
    return typeof window !== 'undefined' && window.localStorage?.getItem(SESSION_HINT_KEY) === '1';
  } catch {
    // Private mode / storage disabled — assume a session may exist so that a
    // genuine expired-token refresh is never suppressed.
    return true;
  }
}

function writeSessionHint(hasSession: boolean): void {
  try {
    if (typeof window === 'undefined') return;
    if (hasSession) window.localStorage?.setItem(SESSION_HINT_KEY, '1');
    else window.localStorage?.removeItem(SESSION_HINT_KEY);
  } catch {
    /* storage unavailable — the in-memory path still works for this tab */
  }
}

class HttpClient {
  private client: AxiosInstance;
  private csrfToken: string | null = null;
  private csrfInitPromise: Promise<void> | null = null;
  private accessToken: string | null = null;
  private isRefreshing = false;
  private refreshQueue: Array<{
    resolve: (value: AxiosResponse) => void;
    reject: (reason: any) => void;
    config: ExtendedAxiosRequestConfig;
  }> = [];

  constructor() {
    this.client = axios.create({
      baseURL: config.apiBaseUrl === '/api' ? '' : config.apiBaseUrl,
      timeout: 10000,
      withCredentials: true,
      headers: {
        'Content-Type': 'application/json',
      },
    });

    this.setupInterceptors();
  }

  private setupInterceptors() {
    // Request interceptor - Add CSRF token for mutations, shop ID, auth header
    this.client.interceptors.request.use(
      async (config: ExtendedAxiosRequestConfig) => {
        if (config.url) config.url = toApiRequestPath(config.url);
        const method = (config.method || 'get').toUpperCase();
        const isMutation = !['GET', 'HEAD', 'OPTIONS'].includes(method);

        // Initialize CSRF token for mutations if not already present.
        // Skip for /auth/refresh — that endpoint is authenticated by httpOnly cookie
        // and doesn't need CSRF. More critically, including it creates a deadlock:
        // refresh POST → CSRF init → GET /api/csrf → 401 → queued for refresh →
        // refresh POST waiting for CSRF → circular dependency never resolves.
        const isRefreshRequest = config.url?.includes('/auth/refresh');
        if (isMutation && !this.csrfToken && !config.__csrfInit && !isRefreshRequest) {
          config.__csrfInit = true;
          await this.initCsrfToken();
        }

        // Inject CSRF token for mutations
        if (this.csrfToken && isMutation) {
          config.headers['X-CSRF-Token'] = this.csrfToken;
        }

        // Inject auth token (Bearer fallback)
        if (this.accessToken) {
          config.headers.Authorization = `Bearer ${this.accessToken}`;
        }

        // Inject shop ID for multi-tenant (if not explicitly skipped)
        const currentShopId = this.getShopId();
        if (currentShopId && !config.__skipShopId) {
          config.headers['X-Shop-ID'] = currentShopId;
        }

        // Track retry count for network errors
        config.__retryCount = config.__retryCount || 0;

        return config;
      },
      (error) => Promise.reject(error)
    );

    // Response interceptor - Handle errors, token refresh, and retries
    this.client.interceptors.response.use(
      (response) => response,
      async (error: AxiosError) => {
        const config = error.config as ExtendedAxiosRequestConfig;
        const status = error.response?.status;

        // Handle 401 with automatic token refresh (queue requests during refresh).
        // Never attempt refresh for the refresh endpoint itself — it returns 401 when
        // there is no valid refresh token, and retrying would deadlock isRefreshing forever.
        // Never attempt refresh for signin/signup/2fa-verify — a 401 there means wrong
        // credentials, not an expired token; attempting refresh adds 5-10s of latency
        // before the error is shown and emits a spurious auth:unauthorized event.
        // Never attempt refresh for /api/csrf — that endpoint is public; if it 401s,
        // treating it as expired-token creates the same CSRF-refresh circular deadlock
        // described in the request interceptor above.
        // Mirrors the backend's anonymousAuthPaths set in csrf-middleware.js. Those
        // endpoints are exempt from the double-submit token and instead bound to the
        // exact merchant-app Origin, so they answer 403 with an operator-facing
        // message ("Authentication requests must originate from the merchant app")
        // whenever a stale apex-origin tab posts to them during the domain migration.
        // Keeping the two lists aligned stops that internal message from reaching a
        // merchant as a global toast — each form renders its own inline error.
        const isRefreshEndpoint = config.url?.includes('/auth/refresh');
        const isAuthEndpoint = config.url?.includes('/auth/signin') ||
          config.url?.includes('/auth/signup') ||
          config.url?.includes('/auth/forgot-password') ||
          config.url?.includes('/auth/reset-password') ||
          config.url?.includes('/auth/2fa/verify');
        const isCsrfEndpoint = /\/(?:api\/)?csrf(?:$|\?)/.test(config.url || '');
        // Skip the refresh entirely when this browser has never held a session —
        // there is nothing to refresh, and the attempt would burn shared per-IP
        // auth rate-limit budget that real sign-ins need. See SESSION_HINT_KEY.
        if (status === 401 && !config.__retry && !isRefreshEndpoint && !isAuthEndpoint && !isCsrfEndpoint && readSessionHint()) {
          config.__retry = true;

          try {
            const refreshedResponse = await this.handleRefreshQueue(config);
            return refreshedResponse;
          } catch (refreshError) {
            this.clearTokens();
            this.clearRefreshQueue();
            this.emitUnauthorized();
            return Promise.reject(refreshError);
          }
        }

        // Already retried / refresh endpoint 401 - clear tokens and redirect
        if (status === 401 && (config.__retry || isRefreshEndpoint)) {
          this.clearTokens();
          this.clearRefreshQueue();
          this.emitUnauthorized();
        }

        // Handle CSRF token failure - clear it so it can be re-initialized
        let isCsrfFailure = false;
        if (status === 403) {
          const csrfErrorData = error.response?.data as {
            message?: string;
            error?: { message?: string };
          } | undefined;
          const csrfErrorMessage = csrfErrorData?.error?.message ?? csrfErrorData?.message;
          if (typeof csrfErrorMessage === 'string' && /^invalid csrf token\b/i.test(csrfErrorMessage.trim())) {
            isCsrfFailure = true;
            this.csrfToken = null;
            // Emit custom event for CSRF error handling
            if (typeof window !== 'undefined' && window.dispatchEvent) {
              window.dispatchEvent(new CustomEvent('csrf:invalid'));
            }
          }
        }

        // Retry transient failures (429 rate limit, 5xx server errors).
        // Never retry the refresh endpoint itself — a 429 there means the token is
        // locked out and retrying only burns more rate-limit budget before the redirect.
        // Never retry auth endpoints (signin/signup) on 429 — the lockout message
        // should be shown immediately; retrying adds 5-15s of invisible latency.
        const responseData = error.response?.data as {
          code?: unknown;
          error?: { code?: unknown };
        } | undefined;
        const responseErrorCode = responseData?.code || responseData?.error?.code;
        const isConsumedOAuthDiscoveryFailure = responseErrorCode === 'META_PAGE_DISCOVERY_FAILED';
        const canRetry = shouldRetryRequest(config);
        if (!isConsumedOAuthDiscoveryFailure
          && !isRefreshEndpoint
          && !isAuthEndpoint
          && canRetry
          && (status === 429 || (status && status >= 500 && status < 600))) {
          const retryCount = config.__retryCount || 0;
          if (retryCount < 2) {
            config.__retryCount = retryCount + 1;
            const delay = status === 429
              ? 5000 * (retryCount + 1)       // 5s, 10s for rate limiting
              : 1000 * Math.pow(2, retryCount); // 1s, 2s for server errors
            await new Promise(resolve => setTimeout(resolve, delay));
            return this.client(config);
          }
        }

        // Retry network errors with exponential backoff.
        // Never retry the refresh or auth endpoints on network failure:
        // - /auth/refresh: a network timeout here already caused isRefreshing to stay
        //   true for up to 37 s (3× retries × 10 s timeout + back-off) before the
        //   queue was finally cleared. Fail immediately so the refresh cycle exits fast.
        // - /auth/signin|signup: surface the network error to the user right away
        //   rather than silently retrying with invisible multi-second delays.
        // - Non-idempotent writes: an ambiguous timeout must not repeat a mutation.
        if (
          !isRefreshEndpoint &&
          !isAuthEndpoint &&
          canRetry &&
          (error.code === 'ECONNABORTED' ||
            error.code === 'ENOTFOUND' ||
            error.code === 'ETIMEDOUT')
        ) {
          const retryCount = config.__retryCount || 0;
          if (retryCount < 3) {
            config.__retryCount = retryCount + 1;
            const delay = 1000 * Math.pow(2, retryCount);
            await new Promise(resolve => setTimeout(resolve, delay));
            return this.client(config);
          }
        }

        const normalized = normalizeApiError(error);

        // Surface the failures no single component owns: a denied permission, a
        // dead connection, a 5xx that already burned its retries. Components keep
        // toasting their own domain errors; these are the ones that used to vanish
        // whenever a caller forgot a catch block.
        //
        // Excluded on purpose:
        // - 401/UNAUTHORIZED: emitUnauthorized() already redirects to sign-in, so a
        //   toast would just flash on the way out.
        // - signin/signup/refresh: the form shows the message next to the field, and
        //   a 5xx there is better read inline than as a toast that auto-dismisses.
        // - CSRF 403: internal plumbing, re-initialised transparently. "invalid csrf
        //   token" means nothing to a merchant.
        //
        // The id dedupes: N parallel requests failing on one dead connection replace
        // each other instead of stacking N identical toasts.
        if (
          !config.__skipGlobalErrorToast &&
          !isCsrfFailure &&
          !isAuthEndpoint &&
          !isRefreshEndpoint &&
          (normalized.type === 'FORBIDDEN' ||
            normalized.type === 'NETWORK_ERROR' ||
            normalized.type === 'TIMEOUT_ERROR' ||
            normalized.type === 'SERVER_ERROR')
        ) {
          toast.error(normalized.message, { id: normalized.type });
        }

        throw normalized;
      }
    );
  }

  private emitUnauthorized(): void {
    if (typeof window !== 'undefined' && window.dispatchEvent) {
      window.dispatchEvent(new CustomEvent('auth:unauthorized'));
    }
  }

  private clearTokens(): void {
    this.accessToken = null;
    this.csrfToken = null;
    // The session is definitively gone (refresh failed or a retried request
    // still 401'd), so stop attempting refreshes until the next sign-in.
    writeSessionHint(false);
  }

  /**
   * Record whether this browser currently holds a session. Call with `true`
   * after any successful authentication, `false` on logout.
   */
  setSessionHint(hasSession: boolean): void {
    writeSessionHint(hasSession);
  }

  hasSessionHint(): boolean {
    return readSessionHint();
  }

  private clearRefreshQueue(): void {
    this.refreshQueue.forEach(({ reject }) => {
      reject(new Error('Token refresh failed'));
    });
    this.refreshQueue = [];
    this.isRefreshing = false;
  }

  /**
   * Abort any in-flight token refresh and reject all queued requests immediately.
   *
   * Call this when the app-level initialization times out (8 s guard in auth.ts).
   * Without this, a slow or hanging POST /api/auth/refresh holds isRefreshing=true
   * indefinitely — any subsequent 401 during that window would be pushed onto the
   * queue and wait up to 37 s (3× ECONNABORTED retries with back-off) before the
   * refresh cycle eventually gives up and rejects the queue.
   */
  public abortPendingRefresh(): void {
    if (this.isRefreshing) {
      this.clearRefreshQueue();
    }
  }

  private async handleRefreshQueue(originalRequest: ExtendedAxiosRequestConfig): Promise<AxiosResponse> {
    return new Promise((resolve, reject) => {
      this.refreshQueue.push({ resolve, reject, config: originalRequest });

      if (!this.isRefreshing) {
        this.isRefreshing = true;
        // Attach a catch so a rejected promise from performTokenRefresh() does not
        // surface as an unhandled rejection in environments that crash on them.
        // Queue clearing and isRefreshing reset are handled inside performTokenRefresh's
        // own try/catch/finally — this catch is a safety net for unexpected throws
        // before that cleanup runs.
        this.performTokenRefresh().catch(() => this.clearRefreshQueue());
      }
    });
  }

  private async performTokenRefresh(): Promise<void> {
    try {
      await this.refreshAuthToken();

      const queuedRequests = [...this.refreshQueue];
      this.refreshQueue = [];

      await Promise.all(
        queuedRequests.map(async ({ resolve, reject, config }) => {
          try {
            const response = await this.client(config);
            resolve(response);
          } catch (error) {
            reject(error);
          }
        })
      );
    } catch (error) {
      this.clearRefreshQueue();
    } finally {
      this.isRefreshing = false;
    }
  }

  // Public methods

  async get<T>(url: string, config?: any): Promise<AxiosResponse<T>> {
    return this.client.get<T>(url, config);
  }

  async post<T>(url: string, data?: any, config?: any): Promise<AxiosResponse<T>> {
    return this.client.post<T>(url, data, config);
  }

  async put<T>(url: string, data?: any, config?: any): Promise<AxiosResponse<T>> {
    return this.client.put<T>(url, data, config);
  }

  async patch<T>(url: string, data?: any, config?: any): Promise<AxiosResponse<T>> {
    return this.client.patch<T>(url, data, config);
  }

  async delete<T>(url: string, config?: any): Promise<AxiosResponse<T>> {
    return this.client.delete<T>(url, config);
  }

  async initCsrfToken(): Promise<void> {
    if (this.csrfToken) return;
    // If a fetch is already in-flight, join it rather than launching a second
    // request. Without this guard, multiple concurrent mutations on a cold page
    // load each fire their own GET /api/csrf, wasting round-trips and risking
    // a race where one fetch overwrites another's result.
    if (this.csrfInitPromise) return this.csrfInitPromise;
    this.csrfInitPromise = this._fetchCsrf().finally(() => {
      this.csrfInitPromise = null;
    });
    return this.csrfInitPromise;
  }

  private async _fetchCsrf(): Promise<void> {
    try {
      const response = await this.client.get('/api/csrf');
      this.csrfToken = response.data?.csrfToken || null;
    } catch (error) {
      console.error('CSRF Token initialization failed:', error);
      this.csrfToken = null;
    }
  }

  async refreshAuthToken(): Promise<void> {
    await this.client.post('/api/auth/refresh', {});
    this.accessToken = null; // Tokens are in httpOnly cookies
  }

  setAccessToken(token: string | null): void {
    this.accessToken = token;
  }

  clearCsrfToken(): void {
    this.csrfToken = null;
  }

  // Shop ID management (stored in memory, not localStorage)
  private currentShopId: string | null = null;

  setShopId(shopId: string | null): void {
    this.currentShopId = shopId;
  }

  getShopId(): string | null {
    return this.currentShopId;
  }

  getAxiosInstance(): AxiosInstance {
    return this.client;
  }

  skipShopIdConfig(config?: any): ExtendedAxiosRequestConfig {
    return {
      ...config,
      __skipShopId: true,
    } as ExtendedAxiosRequestConfig;
  }
}

export const httpClient = new HttpClient();
