/**
 * D-A3-5 (U02) — failed-reply Retry must be exactly-once per logical attempt.
 *
 * Contract proved here:
 *  1. Rapid double-click on Retry fires exactly ONE POST with exactly ONE
 *     idempotency key (previously: no in-flight guard + fresh
 *     crypto.randomUUID() per click bypassed the server's
 *     send_idempotency_key dedup lookup).
 *  2. When a retry request itself errors (outcome UNKNOWN — the server may
 *     or may not have persisted the row), the next click REUSES the same key
 *     so the server dedup replays instead of creating a second SEND_PENDING.
 *  3. When the retry completed FAILED with the server saying the provider call
 *     was NOT attempted (metadata.provider_send_attempted === false —
 *     conversation.controller.js sets it explicitly), the completed attempt is
 *     closed and the next click is a genuinely new attempt: a fresh key.
 *  3b. F-1 (A6 QA on PR #305, P05 no-blind-resend posture): when the provider
 *     call was STARTED and errored (lost ack), the row persists FAILED with
 *     provider_send_attempted: true. Releasing the key there would mint a
 *     fresh attempt and risk a SECOND provider-visible message — so the key
 *     is KEPT (the same-key replay is inert: the server returns the stored
 *     row and skips dispatch, conversation.controller.js idempotency_replay).
 *     An indistinguishable FAILED (flag absent) likewise keeps the key.
 *  4. When the retry completed successfully (pending/confirmed), the key is
 *     kept, so a stray later click on the old failed bubble replays rather
 *     than double-sending.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { InboxThreadDetail } from "../InboxThreadDetail";
import { apiClient } from "@/api";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

vi.mock("@/api", () => ({
  apiClient: {
    getProducts: vi.fn(),
    sendProductCard: vi.fn(),
    createMessage: vi.fn(),
    createTemplate: vi.fn(),
    updateTemplate: vi.fn(),
    deleteTemplate: vi.fn(),
    approveAiDraft: vi.fn(),
  },
}));

const CONV_ID = "33333333-3333-4333-8333-333333333333";
const CUSTOMER_MSG_ID = "44444444-4444-4444-8444-444444444444";
const FAILED_MSG_ID = "55555555-5555-4555-8555-555555555555";

const conversation = {
  id: CONV_ID,
  channel: "messenger",
  status: "active",
  customer_id: "66666666-6666-4666-8666-666666666666",
} as any;

const now = "2026-11-23T09:00:00Z";

const failedOutbound = {
  id: FAILED_MSG_ID,
  conversation_id: CONV_ID,
  sender: "agent",
  content: "Could you confirm the delivery address?",
  message_type: "text",
  created_at: now,
  updated_at: now,
  delivery_state: "FAILED",
  is_transcript_message: true,
  metadata: { delivery_status: "failed" },
} as any;

const customerMsg = {
  id: CUSTOMER_MSG_ID,
  conversation_id: CONV_ID,
  sender: "customer",
  content: "Where is my order?",
  message_type: "text",
  created_at: now,
  updated_at: now,
} as any;

const baseProps = () => ({
  selectedConversation: conversation,
  aiReplyMode: "OFF" as any,
  aiReplyStatus: null,
  messages: [customerMsg, failedOutbound],
  loadingMessages: false,
  hasMoreMessages: false,
  loadingMoreMessages: false,
  togglingHITL: false,
  resolvingConversation: false,
  planFeaturesAdvancedAI: false,
  showResolveDialog: false,
  resolveNote: "",
  dismissedSuggestionId: null,
  templates: [],
  quickReplyTemplates: [],
  loadingTemplates: false,
  messagesEndRef: { current: null } as any,
  is24hExpired: false,
  is24hWarning: false,
  interactionChoicesEnabled: false,
  mobilePanelOpen: true,
  onMobileBack: vi.fn(),
  onToggleHITL: vi.fn(),
  onResolve: vi.fn(),
  onLoadOlderMessages: vi.fn(),
  onDismissSuggestion: vi.fn(),
  onSetShowResolveDialog: vi.fn(),
  onSetResolveNote: vi.fn(),
  onMessageSent: vi.fn(),
  onSendFailed: vi.fn(),
  onTemplatesChanged: vi.fn().mockResolvedValue(undefined),
});

const retryButton = () => screen.getByRole("button", { name: "inbox.retry" });
const keysUsed = () =>
  vi.mocked(apiClient.createMessage).mock.calls.map((call: any[]) => call[2]?.idempotencyKey as string);

/**
 * Deterministic attempt-settle gate (CI flake fix, A0 report on f3e0b4bd).
 * The 0->1-call waitFor can be satisfied synchronously at click time, BEFORE
 * the mocked response's continuation (and the handler's finally) runs; a
 * second click landing in that window is dropped by the in-flight ref guard -
 * correct production behavior, but it made the replay assertions timing-
 * dependent. The finally clause clears the guard and re-enables the button
 * together, so waiting for the enabled state guarantees the next click is
 * processed as a real attempt instead of racing the guard.
 */
const settleAttempt = async (btn: HTMLElement) => {
  await waitFor(() => expect(btn).toBeEnabled());
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("InboxThreadDetail failed-reply Retry (D-A3-5)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fires exactly one request with one idempotency key on a rapid double-click", async () => {
    const d = deferred<any>();
    vi.mocked(apiClient.createMessage).mockReturnValue(d.promise);

    render(<InboxThreadDetail {...baseProps()} />);
    const btn = retryButton();

    fireEvent.click(btn);
    fireEvent.click(btn);

    expect(apiClient.createMessage).toHaveBeenCalledTimes(1);
    expect(keysUsed()).toHaveLength(1);
    expect(keysUsed()[0]).toBeTruthy();

    d.resolve({
      id: "66666666-0000-4000-8000-000000000001",
      conversation_id: CONV_ID,
      sender: "agent",
      content: "Could you confirm the delivery address?",
      message_type: "text",
      created_at: now,
      updated_at: now,
      delivery_state: "SEND_PENDING",
      metadata: { delivery_status: "pending" },
    });
    await waitFor(() => expect(btn).toBeEnabled());
  });

  it("reuses the same idempotency key after a retry request errors (unknown outcome)", async () => {
    vi.mocked(apiClient.createMessage)
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce({
        id: "66666666-0000-4000-8000-000000000002",
        conversation_id: CONV_ID,
        sender: "agent",
        content: "Could you confirm the delivery address?",
        message_type: "text",
        created_at: now,
        updated_at: now,
        delivery_state: "SEND_PENDING",
        metadata: { delivery_status: "pending" },
      } as any);

    render(<InboxThreadDetail {...baseProps()} />);
    const btn = retryButton();

    fireEvent.click(btn);
    await waitFor(() => expect(apiClient.createMessage).toHaveBeenCalledTimes(1));
    await settleAttempt(btn);
    fireEvent.click(btn);
    await waitFor(() => expect(apiClient.createMessage).toHaveBeenCalledTimes(2));

    expect(keysUsed()[0]).toBe(keysUsed()[1]);
  });

  const completedRetry = (over: Record<string, unknown>) => ({
    id: "66666666-0000-4000-8000-000000000004",
    conversation_id: CONV_ID,
    sender: "agent",
    content: "Could you confirm the delivery address?",
    message_type: "text",
    created_at: now,
    updated_at: now,
    delivery_state: "SEND_PENDING",
    metadata: { delivery_status: "pending" },
    ...over,
  } as any);

  it("mints a fresh key only for a server-confirmed NOT-attempted FAILED retry", async () => {
    vi.mocked(apiClient.createMessage)
      .mockResolvedValueOnce(completedRetry({
        id: "66666666-0000-4000-8000-000000000003",
        delivery_state: "FAILED",
        metadata: { delivery_status: "failed", provider_send_attempted: false },
      }))
      .mockResolvedValueOnce(completedRetry({}));

    render(<InboxThreadDetail {...baseProps()} />);
    const btn = retryButton();

    fireEvent.click(btn);
    await waitFor(() => expect(apiClient.createMessage).toHaveBeenCalledTimes(1));
    await settleAttempt(btn);
    fireEvent.click(btn);
    await waitFor(() => expect(apiClient.createMessage).toHaveBeenCalledTimes(2));

    expect(keysUsed()[0]).not.toBe(keysUsed()[1]);
  });

  it("keeps the key when the FAILED retry says the provider send was ATTEMPTED (F-1, no blind resend)", async () => {
    // Provider call started then errored (ack lost): the stored row persists
    // FAILED with provider_send_attempted:true (controller :779). A fresh key
    // would create a second row and a second provider-visible send attempt;
    // replaying the same key returns the stored row inertly (controller
    // skips delivery on idempotency_replay).
    vi.mocked(apiClient.createMessage)
      .mockResolvedValueOnce(completedRetry({
        id: "66666666-0000-4000-8000-000000000013",
        delivery_state: "FAILED",
        metadata: {
          delivery_status: "failed",
          provider_send_attempted: true,
          held_reason: "provider_send_failed",
        },
      }))
      .mockResolvedValueOnce(completedRetry({
        delivery_state: "FAILED",
        metadata: {
          delivery_status: "failed",
          provider_send_attempted: true,
          held_reason: "provider_send_failed",
        },
      }));

    render(<InboxThreadDetail {...baseProps()} />);
    const btn = retryButton();

    fireEvent.click(btn);
    await waitFor(() => expect(apiClient.createMessage).toHaveBeenCalledTimes(1));
    await settleAttempt(btn);
    fireEvent.click(btn);
    await waitFor(() => expect(apiClient.createMessage).toHaveBeenCalledTimes(2));

    expect(keysUsed()[0]).toBe(keysUsed()[1]);
  });

  it("keeps the key for an indistinguishable FAILED (attempt state absent) — safest client-side default", async () => {
    vi.mocked(apiClient.createMessage)
      .mockResolvedValueOnce(completedRetry({
        id: "66666666-0000-4000-8000-000000000023",
        delivery_state: "FAILED",
        metadata: { delivery_status: "failed" },
      }))
      .mockResolvedValueOnce(completedRetry({}));

    render(<InboxThreadDetail {...baseProps()} />);
    const btn = retryButton();

    fireEvent.click(btn);
    await waitFor(() => expect(apiClient.createMessage).toHaveBeenCalledTimes(1));
    await settleAttempt(btn);
    fireEvent.click(btn);
    await waitFor(() => expect(apiClient.createMessage).toHaveBeenCalledTimes(2));

    expect(keysUsed()[0]).toBe(keysUsed()[1]);
  });

  it("keeps the key after a successful retry so an extra click replays instead of double-sending", async () => {
    vi.mocked(apiClient.createMessage).mockResolvedValue({
      id: "66666666-0000-4000-8000-000000000005",
      conversation_id: CONV_ID,
      sender: "agent",
      content: "Could you confirm the delivery address?",
      message_type: "text",
      created_at: now,
      updated_at: now,
      delivery_state: "SENT",
      provider_message_id: "meta-pmid-1",
      metadata: { delivery_status: "sent" },
    } as any);

    render(<InboxThreadDetail {...baseProps()} />);
    const btn = retryButton();

    fireEvent.click(btn);
    await waitFor(() => expect(apiClient.createMessage).toHaveBeenCalledTimes(1));
    await settleAttempt(btn);
    fireEvent.click(btn);
    await waitFor(() => expect(apiClient.createMessage).toHaveBeenCalledTimes(2));

    expect(keysUsed()[0]).toBe(keysUsed()[1]);
  });
});
