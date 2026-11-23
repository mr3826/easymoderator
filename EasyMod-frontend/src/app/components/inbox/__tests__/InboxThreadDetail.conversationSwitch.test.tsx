/**
 * D-A3-6 (U01/U04) — composer draft text must never leak across conversations.
 *
 * Typing in thread A and switching to thread B must NOT show A's draft against
 * B's customer. Fixed via keyed remount of InboxComposer on the conversation id;
 * this test pins the contract at the thread-detail boundary (the composer is
 * rendered here, and UnifiedInbox swaps `selectedConversation` in place).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { InboxThreadDetail } from "../InboxThreadDetail";

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

const conversationA = {
  id: "33333333-3333-4333-8333-333333333333",
  channel: "messenger",
  status: "active",
  customer_id: "66666666-6666-4666-8666-666666666666",
} as any;

const conversationB = {
  id: "77777777-7777-4777-8777-777777777777",
  channel: "messenger",
  status: "active",
  customer_id: "88888888-8888-4888-8888-888888888888",
} as any;

const now = "2026-11-23T09:00:00Z";

const propsFor = (selectedConversation: any) => ({
  selectedConversation,
  aiReplyMode: "OFF" as any,
  aiReplyStatus: null,
  messages: [{
    id: "99999999-9999-4999-8999-999999999999",
    conversation_id: selectedConversation.id,
    sender: "customer",
    content: "Hello?",
    message_type: "text",
    created_at: now,
    updated_at: now,
  }] as any,
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

describe("InboxThreadDetail conversation-switch composer isolation (D-A3-6)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("clears typed draft text when the selected conversation changes", () => {
    const { rerender } = render(<InboxThreadDetail {...propsFor(conversationA)} />);
    const input = screen.getByTestId("message-input");
    fireEvent.change(input, { target: { value: "Draft written for customer A" } });
    expect(input).toHaveValue("Draft written for customer A");

    rerender(<InboxThreadDetail {...propsFor(conversationB)} />);
    const nextInput = screen.getByTestId("message-input");
    expect(nextInput).toHaveValue("");
  });
});
