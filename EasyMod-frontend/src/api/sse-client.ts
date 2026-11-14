/**
 * SSE Client — typed EventSource wrapper for EasyModerator real-time events.
 *
 * Features:
 *   - Typed event handler registration per event name.
 *   - Automatic Last-Event-ID tracking. The browser's native EventSource sends
 *     the Last-Event-ID header automatically on reconnect when the server emits
 *     "id:" lines. This client shadows that id in localStorage so it survives
 *     page reloads and manual reconnects.
 *   - Configurable retry with exponential backoff and jitter.
 *   - connect() / disconnect() lifecycle.
 *   - onError callback for error observability.
 *
 * Usage:
 *   const client = new SSEClient({ shopId: 'shop-123' });
 *   client.on('new_message', (data) => { ... });
 *   client.on('hitl_changed', (data) => { ... });
 *   client.connect();
 *   // later:
 *   client.disconnect();
 *
 * Last-Event-ID behaviour:
 *   The W3C EventSource spec mandates that browsers automatically include the
 *   Last-Event-ID header on reconnection (§9.2). This client does NOT need to
 *   manually append it as a query parameter. The server reads the header and
 *   replays missed events via sseManager.attachToRequest().
 *
 *   The client stores the last seen id in sessionStorage under the key
 *   "sse_last_id_{shopId}". On manual reconnect (e.g. after a page reload),
 *   it appends last_event_id as a query parameter as a fallback because
 *   EventSource does not persist Last-Event-ID across full page loads.
 */

/** Shape of a parsed SSE event payload from the server. */
import config, { toApiRequestPath } from '@/app/lib/config';

export interface SSEEnvelope {
  id: number;
  event: string;
  data: unknown;
}

/** Handler signature for a specific event type. */
export type SSEEventHandler<T = unknown> = (data: T) => void;

/** Known event names emitted by EasyModerator backend. */
export type KnownSSEEvent =
  | 'new_message'
  | 'hitl_changed'
  | 'ai_reply_mode_changed'
  | 'message_delivery_updated'
  | 'delivery_failed'
  | 'channel_error'
  | 'channel_status_changed'
  | 'channel_action_required'
  | 'channel_settings_changed'
  | 'emergency_stop_changed'
  | 'llm_outage'
  | (string & Record<never, never>); // allow arbitrary strings for forward-compat

export interface SSEClientOptions {
  /** Shop ID — used only to isolate the local Last-Event-ID cursor. */
  shopId: string;
  /** Override the base URL (defaults to the configured API origin). */
  baseUrl?: string;
  /** Override the SSE path (defaults to /api/conversation/events). */
  path?: string;
  /** Initial reconnect delay in milliseconds (default 1000). */
  initialRetryMs?: number;
  /** Maximum reconnect delay in milliseconds (default 30 000). */
  maxRetryMs?: number;
  /** Called when the EventSource emits an error event. */
  onError?: (err: Event) => void;
  /** Called when a connection is established (including reconnects). */
  onOpen?: () => void;
}

const STORAGE_KEY_PREFIX = 'sse_last_id_';

export class SSEClient {
  private readonly shopId: string;
  private readonly baseUrl: string;
  private readonly path: string;
  private readonly initialRetryMs: number;
  private readonly maxRetryMs: number;
  private readonly onError?: (err: Event) => void;
  private readonly onOpen?: () => void;

  // Handler registry: eventName → Set of handlers
  private readonly handlers = new Map<string, Set<SSEEventHandler>>();

  private eventSource: EventSource | null = null;
  private retryMs: number;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private _connected = false;

  constructor(opts: SSEClientOptions) {
    this.shopId = opts.shopId;
    this.baseUrl = opts.baseUrl ?? (
      config.apiBaseUrl === '/api'
        ? (typeof window !== 'undefined' ? window.location.origin : '')
        : config.apiBaseUrl
    );
    this.path = opts.path ?? '/api/conversation/events';
    this.initialRetryMs = opts.initialRetryMs ?? 1_000;
    this.maxRetryMs = opts.maxRetryMs ?? 30_000;
    this.onError = opts.onError;
    this.onOpen = opts.onOpen;
    this.retryMs = this.initialRetryMs;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Register a typed handler for a specific SSE event name.
   * Multiple handlers per event name are supported.
   *
   * @param event  SSE event name (e.g. 'new_message')
   * @param handler  Called with the parsed data field of the SSE envelope
   */
  on<T = unknown>(event: KnownSSEEvent, handler: SSEEventHandler<T>): this {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    (this.handlers.get(event) as Set<SSEEventHandler>).add(handler as SSEEventHandler);

    // If already connected, register the listener on the live EventSource
    if (this.eventSource) {
      this._addEventListenerToSource(this.eventSource, event, handler as SSEEventHandler);
    }
    return this;
  }

  /**
   * Remove a previously registered handler.
   *
   * @param event
   * @param handler  The exact function reference passed to on()
   */
  off<T = unknown>(event: KnownSSEEvent, handler: SSEEventHandler<T>): this {
    const set = this.handlers.get(event);
    if (set) set.delete(handler as SSEEventHandler);
    return this;
  }

  /**
   * Open the SSE connection.
   * Idempotent — calling connect() on an already-connected client is a no-op.
   */
  connect(): void {
    if (this._connected) return;
    this._open();
  }

  /**
   * Close the SSE connection and cancel any pending reconnect timer.
   * Clears the stored Last-Event-ID from sessionStorage.
   */
  disconnect(): void {
    this._connected = false;
    this._clearRetryTimer();
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
  }

  /** Whether the client is currently open (or attempting to connect). */
  get isConnected(): boolean {
    return this._connected;
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private _buildUrl(): string {
    const url = new URL(toApiRequestPath(this.path), this.baseUrl);

    // Append last_event_id as a query parameter as a fallback for page-reload
    // reconnects where the browser cannot carry Last-Event-ID in the header.
    // The server accepts this alongside the standard header.
    const storedId = this._getStoredLastId();
    if (storedId > 0) {
      url.searchParams.set('last_event_id', String(storedId));
    }

    return url.toString();
  }

  private _open(): void {
    this._connected = true;
    const url = this._buildUrl();

    const es = new EventSource(url, { withCredentials: true });
    this.eventSource = es;

    es.addEventListener('open', () => {
      // Reset backoff on successful connection
      this.retryMs = this.initialRetryMs;
      this.onOpen?.();
    });

    es.addEventListener('error', (err) => {
      this.onError?.(err);

      // EventSource auto-reconnects internally, but we manage the lifecycle
      // ourselves to support exponential backoff and Last-Event-ID persistence.
      if (es.readyState === EventSource.CLOSED) {
        this._reconnect();
      }
    });

    // Wire pre-registered handlers onto the new EventSource
    for (const [event, handlerSet] of this.handlers.entries()) {
      for (const handler of handlerSet) {
        this._addEventListenerToSource(es, event, handler);
      }
    }
  }

  /**
   * Add an event listener to an EventSource that:
   *   1. Parses the MessageEvent data as JSON.
   *   2. Stores the event id in sessionStorage.
   *   3. Calls the handler with the parsed data field.
   */
  private _addEventListenerToSource(
    es: EventSource,
    event: string,
    handler: SSEEventHandler
  ): void {
    es.addEventListener(event, (msgEvent: MessageEvent) => {
      // Track the last received id. The browser sends this automatically as
      // Last-Event-ID on reconnect, but we also store it for page-reload fallback.
      if (msgEvent.lastEventId) {
        this._storeLastId(parseInt(msgEvent.lastEventId, 10));
      }

      let data: unknown;
      try {
        data = JSON.parse(msgEvent.data as string);
      } catch {
        // Non-JSON data — pass through as raw string
        data = msgEvent.data;
      }

      try {
        handler(data);
      } catch (handlerErr) {
        // Handler errors must not crash the SSE pipeline
        console.error('[SSEClient] Handler error for event', event, handlerErr);
      }
    });
  }

  private _reconnect(): void {
    if (!this._connected) return;

    this.eventSource?.close();
    this.eventSource = null;

    // Exponential backoff with up to 25% jitter
    const jitter = this.retryMs * 0.25 * Math.random();
    const delay = Math.min(this.retryMs + jitter, this.maxRetryMs);
    this.retryMs = Math.min(this.retryMs * 2, this.maxRetryMs);

    this.retryTimer = setTimeout(() => {
      if (this._connected) this._open();
    }, delay);
  }

  private _clearRetryTimer(): void {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private _storageKey(): string {
    return `${STORAGE_KEY_PREFIX}${this.shopId}`;
  }

  private _getStoredLastId(): number {
    try {
      const raw = sessionStorage.getItem(this._storageKey());
      return raw ? parseInt(raw, 10) : 0;
    } catch {
      return 0;
    }
  }

  private _storeLastId(id: number): void {
    try {
      sessionStorage.setItem(this._storageKey(), String(id));
    } catch {
      // sessionStorage unavailable (e.g. incognito with storage disabled)
    }
  }
}

/**
 * Factory: create and connect an SSEClient for the given shop.
 *
 * Convenience wrapper for the common case. Handlers can be attached
 * before or after connect() — both work correctly.
 *
 * @example
 *   const sse = createSSEClient({ shopId: user.shopId });
 *   sse.on('new_message', (data) => setMessages(prev => [...prev, data]));
 *   sse.connect();
 *   // cleanup:
 *   return () => sse.disconnect();
 */
export function createSSEClient(opts: SSEClientOptions): SSEClient {
  return new SSEClient(opts);
}
