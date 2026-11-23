import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { InboxComposer } from "../InboxComposer";
import { apiClient } from "@/api";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@/api", () => ({
  apiClient: {
    getProducts: vi.fn(),
    sendProductCard: vi.fn(),
    createMessage: vi.fn(),
    createTemplate: vi.fn(),
    updateTemplate: vi.fn(),
    deleteTemplate: vi.fn(),
  },
}));

const messengerConversation = {
  id: "33333333-3333-4333-8333-333333333333",
  channel: "messenger",
  status: "active",
  customer_id: "66666666-6666-4666-8666-666666666666",
} as any;

const baseProps = {
  selectedConversation: messengerConversation,
  is24hExpired: false,
  is24hWarning: false,
  templates: [],
  quickReplyTemplates: [],
  loadingTemplates: false,
  planFeaturesAdvancedAI: false,
  onMessageSent: vi.fn(),
  onSendFailed: vi.fn(),
  onTemplatesChanged: vi.fn().mockResolvedValue(undefined),
};

describe("InboxComposer R3 product card picker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("hides product card picker when interactionChoicesEnabled is omitted or false", () => {
    const { rerender } = render(<InboxComposer {...baseProps} />);
    expect(screen.queryByTestId("inbox-product-card-button")).not.toBeInTheDocument();

    rerender(<InboxComposer {...baseProps} interactionChoicesEnabled={false} />);
    expect(screen.queryByTestId("inbox-product-card-button")).not.toBeInTheDocument();
  });

  it("shows product card picker when interactionChoicesEnabled is true and sends DB product card", async () => {
    vi.mocked(apiClient.getProducts).mockResolvedValue([
      {
        id: "prod-1",
        name: "Jamdani Saree",
        price: 2500,
        sku: "JAM-1",
        category: "Saree",
        is_active: true,
        status: "active",
        createdAt: "2026-11-20T00:00:00Z",
        updatedAt: "2026-11-20T00:00:00Z",
      },
    ]);
    const sentMsg = {
      id: "msg-card-1",
      conversation_id: messengerConversation.id,
      content: "Jamdani Saree (৳2500)",
      sender: "agent",
    } as any;
    vi.mocked(apiClient.sendProductCard).mockResolvedValue(sentMsg);

    render(<InboxComposer {...baseProps} interactionChoicesEnabled={true} />);
    const btn = screen.getByTestId("inbox-product-card-button");
    expect(btn).toBeEnabled();

    fireEvent.click(btn);
    expect(await screen.findByText("Jamdani Saree")).toBeInTheDocument();
    // D-A3-1: the client-side `limit: 25` first-page hack is gone — the
    // authorized catalog endpoint is server-authoritative (no LIMIT applied
    // server-side), so the picker reads the full active catalog.
    expect(apiClient.getProducts).toHaveBeenCalledWith({ is_active: true });

    fireEvent.click(screen.getByRole("button", { name: "inbox.composer.productCardSend" }));
    await waitFor(() => {
      expect(apiClient.sendProductCard).toHaveBeenCalledWith(
        messengerConversation.id,
        { product_id: "prod-1" },
        expect.objectContaining({ idempotencyKey: expect.any(String) }),
      );
      expect(baseProps.onMessageSent).toHaveBeenCalledWith(sentMsg);
    });
  });

  it("disables product card button when 24h window is expired", () => {
    render(<InboxComposer {...baseProps} interactionChoicesEnabled={true} is24hExpired={true} />);
    const btn = screen.getByTestId("inbox-product-card-button");
    expect(btn).toBeDisabled();
  });
});
