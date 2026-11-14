import { publicApiRequest } from "@/shared/lib/http/public-client";

export type FunnelEvent =
  | "landing_view"
  | "signup_started"
  // Contract-derived landing instrumentation (anonymous, first-party).
  | "page_view"
  | "cta_click"
  | "signup_click"
  | "scroll_depth"
  | "section_view"
  | "mechanism_view"
  | "faq_open"
  | "calc_state"
  | "calc_reset";

// Privileged lifecycle milestones are recorded by trusted backend producers;
// browser code must not be able to forge them.

const SESSION_KEY = "easymod:funnel_session";

function buildIdempotencyKey(event: FunnelEvent, onceKey: string) {
  const normalizedOnceKey = onceKey.trim().replace(/[^\x21-\x7E]/g, "-");
  if (!normalizedOnceKey) return undefined;
  return `funnel-${event}-${normalizedOnceKey}`.slice(0, 128);
}

function getSessionId() {
  try {
    let value = sessionStorage.getItem(SESSION_KEY);
    if (!value) {
      value = crypto.randomUUID();
      sessionStorage.setItem(SESSION_KEY, value);
    }
    return value;
  } catch {
    return "session-unavailable";
  }
}

export function trackFunnelEvent(
  event: FunnelEvent,
  metadata: Record<string, string | number | boolean | null | undefined> = {},
  options: { onceKey?: string } = {},
): Promise<void> {
  const onceStorageKey = options.onceKey
    ? `easymod:funnel_once:${options.onceKey}`
    : null;

  try {
    if (onceStorageKey && localStorage.getItem(onceStorageKey)) return Promise.resolve();
  } catch {
    // Tracking must never interrupt the user flow.
  }

  const idempotencyKey = options.onceKey
    ? buildIdempotencyKey(event, options.onceKey)
    : undefined;
  const headers = idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined;

  return publicApiRequest("/api/analytics/funnel", {
    method: "POST",
    headers,
    body: JSON.stringify({
      event,
      metadata,
      sessionId: getSessionId(),
      path: typeof window !== "undefined" ? window.location.pathname : undefined,
    }),
  })
    .then(() => {
      if (!onceStorageKey) return;
      try {
        // Only suppress a future attempt after the server accepted this event.
        localStorage.setItem(onceStorageKey, "1");
      } catch {
        // Tracking must never interrupt the user flow.
      }
    })
    .catch(() => {
      // Tracking must never interrupt the user flow. Leaving the marker unset
      // allows a later successful attempt to record the event.
    });
}
