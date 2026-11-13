import { fetchTransport } from './transport';
import { __resetTokenStoreForTests, setAccessToken } from '@/auth/token-store';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  __resetTokenStoreForTests();
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe('fetchTransport', () => {
  it('omits browser credentials and explicit cookies from native requests', async () => {
    setAccessToken('access-token');
    const fetchMock = jest.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.credentials).toBe('omit');
      expect(init?.headers).toEqual(
        expect.objectContaining({
          Authorization: 'Bearer access-token',
          'X-EM-Client': expect.any(String),
        }),
      );
      expect(init?.headers).not.toEqual(expect.objectContaining({ Cookie: expect.any(String) }));
      return {
        status: 200,
        ok: true,
        json: async () => ({ ok: true }),
      } as Response;
    });
    global.fetch = fetchMock as typeof fetch;

    const response = await fetchTransport.request('/api/mobile/today', {
      headers: { Cookie: 'commerce_ai.sid=browser-session' },
    });

    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('serializes an object request body exactly once', async () => {
    const fetchMock = jest.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.body).toBe(JSON.stringify({ mode: 'pause' }));
      return {
        status: 200,
        ok: true,
        json: async () => ({ ok: true }),
      } as Response;
    });
    global.fetch = fetchMock as typeof fetch;

    const response = await fetchTransport.request('/api/mobile/inbox/conversations/1/ai-mode', {
      method: 'POST',
      body: { mode: 'pause' },
    });

    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the timeout active while response JSON is stalled', async () => {
    jest.useFakeTimers();
    const jsonStarted = deferred<void>();
    let signal: AbortSignal | undefined;

    const fetchMock = jest.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal as AbortSignal;
      return {
        status: 200,
        ok: true,
        json: () =>
          new Promise<unknown>((_resolve, reject) => {
            jsonStarted.resolve();
            signal?.addEventListener('abort', () => {
              const error = new Error('The response body timed out');
              error.name = 'AbortError';
              reject(error);
            });
          }),
      } as Response;
    });
    global.fetch = fetchMock as typeof fetch;

    const response = await fetchTransport.request('/api/mobile/today', { timeoutMs: 100 });
    const bodyPromise = response.json();
    await jsonStarted.promise;

    expect(signal?.aborted).toBe(false);
    jest.advanceTimersByTime(100);
    expect(signal?.aborted).toBe(true);
    await expect(bodyPromise).rejects.toMatchObject({ name: 'AbortError' });
    jest.runOnlyPendingTimers();
  });
});
