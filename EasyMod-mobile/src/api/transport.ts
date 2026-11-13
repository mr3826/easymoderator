import { env, getAppVersion } from '@/config/env';
import { getAccessToken } from '@/auth/token-store';

export interface HttpResponse {
  status: number;
  ok: boolean;
  json: () => Promise<unknown>;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Request bodies are JSON objects; the transport owns serialization. */
  body?: object;
  headers?: Record<string, string>;
  /** Skip attaching the Authorization header — used for signin, which has no token yet. */
  skipAuth?: boolean;
  timeoutMs?: number;
}

/**
 * A `Transport` is the seam between the typed API client / auth client and the network. Production
 * code uses `fetchTransport`; tests inject a fake transport so the single-flight refresh guard and
 * the error normalizer can be exercised without a real server (ADR M-003, ADR M-004).
 */
export interface Transport {
  request(path: string, options?: RequestOptions): Promise<HttpResponse>;
}

const DEFAULT_TIMEOUT_MS = 15000;

export function clientHeaderValue(): string {
  return `android/${getAppVersion()}`;
}

export const fetchTransport: Transport = {
  async request(path, options = {}) {
    const { method = 'GET', body, headers = {}, skipAuth = false, timeoutMs = DEFAULT_TIMEOUT_MS } = options;

    const controller = new AbortController();
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const clearRequestTimeout = () => {
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
        timeoutHandle = undefined;
      }
    };
    timeoutHandle = setTimeout(() => {
      controller.abort();
      clearRequestTimeout();
    }, timeoutMs);

    const finalHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-EM-Client': clientHeaderValue(),
      ...headers,
    };
    // Native requests use bearer tokens and must never participate in a browser cookie session.
    // Strip an explicitly supplied Cookie header as well as opting out of fetch's credential jar.
    Object.keys(finalHeaders).forEach((headerName) => {
      if (headerName.toLowerCase() === 'cookie') delete finalHeaders[headerName];
    });
    if (!skipAuth) {
      const token = getAccessToken();
      if (token) finalHeaders.Authorization = `Bearer ${token}`;
    }

    try {
      const res = await fetch(`${env.apiBaseUrl}${path}`, {
        method,
        headers: finalHeaders,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
        credentials: 'omit',
      });

      // Keep the controller alive until the body has been consumed. Native fetch can resolve the
      // headers while `json()` is still waiting on a stalled response body.
      return {
        status: res.status,
        ok: res.ok,
        json: async () => {
          try {
            return await res.json();
          } finally {
            clearRequestTimeout();
          }
        },
      };
    } catch (error) {
      clearRequestTimeout();
      throw error;
    }
  },
};
