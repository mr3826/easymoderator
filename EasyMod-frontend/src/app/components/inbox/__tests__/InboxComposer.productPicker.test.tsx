/**
 * D-A3-1 / D-A3-2 / DC-1 / D-A3-3 / D-A3-4 — product picker truth states.
 *
 *  - Search is executed by the AUTHORIZED server-side catalog API (WP-04
 *    pattern: GET /api/product with `search`), not a local filter over the
 *    first fetch, so a >25-item catalog stays reachable (tenant scoping is
 *    server-side; the old `limit: 25` client hint is gone).
 *  - Four distinct states: loading ("productCardLoading" — D-A3-3, the old
 *    code reused the quick-replies label) / zero-matches / API-failed (distinct
 *    role=alert with a retry affordance — DC-1) / not-authorized (covered by
 *    InboxComposer.r3.test: flag-off renders no picker at all).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { InboxComposer } from "../InboxComposer";
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

function product(over: Record<string, unknown> = {}) {
  return {
    id: `prod-${Math.random().toString(36).slice(2)}`,
    name: "Jamdani Saree",
    price: 2500,
    sku: "JAM-1",
    is_active: true,
    status: "active",
    createdAt: "2026-11-20T00:00:00Z",
    updatedAt: "2026-11-20T00:00:00Z",
    ...over,
  } as any;
}

async function openPicker() {
  render(<InboxComposer {...baseProps} interactionChoicesEnabled={true} />);
  fireEvent.click(await screen.findByTestId("inbox-product-card-button"));
  return screen.findByTestId("inbox-product-card-popover");
}

describe("InboxComposer product picker (D-A3-1/2/3, DC-1, D-A3-4)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("queries the server catalog API with the search term instead of filtering locally", async () => {
    vi.mocked(apiClient.getProducts).mockResolvedValue([product({ name: "Kurta Panjabi" })]);
    await openPicker();
    expect(apiClient.getProducts).toHaveBeenCalledWith({ is_active: true });

    const input = screen.getByPlaceholderText("inbox.composer.productCardSearch");
    fireEvent.change(input, { target: { value: "kurta" } });

    await waitFor(() => {
      expect(apiClient.getProducts).toHaveBeenCalledWith({ is_active: true, search: "kurta" });
    });
    expect(await screen.findByText("Kurta Panjabi")).toBeInTheDocument();
  });

  it("shows a product-specific loading state that is not the quick-replies label", async () => {
    let release: (value: any[]) => void = () => {};
    vi.mocked(apiClient.getProducts).mockReturnValue(
      new Promise((resolve) => { release = resolve; }),
    );
    await openPicker();
    expect(screen.getByText("inbox.composer.productCardLoading")).toBeInTheDocument();
    expect(screen.queryByText("inbox.composer.loadingQuickReplies")).not.toBeInTheDocument();
    expect(screen.queryByText("inbox.composer.productCardEmpty")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    release([]);
    await screen.findByText("inbox.composer.productCardEmpty");
  });

  it("renders an API failure as a distinct retryable error state, never as zero results", async () => {
    vi.mocked(apiClient.getProducts).mockRejectedValueOnce(new Error("500 boom"));
    await openPicker();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("inbox.composer.productCardError");
    expect(screen.queryByText("inbox.composer.productCardEmpty")).not.toBeInTheDocument();

    vi.mocked(apiClient.getProducts).mockResolvedValueOnce([product({ name: "Recovered Item" })]);
    fireEvent.click(screen.getByRole("button", { name: "inbox.composer.productCardRetry" }));
    await waitFor(() => expect(apiClient.getProducts).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("Recovered Item")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("distinguishes zero search matches from an empty catalog", async () => {
    vi.mocked(apiClient.getProducts).mockResolvedValue([]);
    await openPicker();
    expect(screen.getByText("inbox.composer.productCardEmpty")).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("inbox.composer.productCardSearch"), {
      target: { value: "nonexistent-sku" },
    });
    await waitFor(() => {
      expect(apiClient.getProducts).toHaveBeenCalledWith({
        is_active: true,
        search: "nonexistent-sku",
      });
    });
    expect(await screen.findByText("inbox.composer.productCardNoResults")).toBeInTheDocument();
    expect(screen.queryByText("inbox.composer.productCardEmpty")).not.toBeInTheDocument();
  });

  it("marks out-of-stock rows honestly from the server payload while the server keeps send authority", async () => {
    vi.mocked(apiClient.getProducts).mockResolvedValue([
      product({ id: "prod-in", name: "In Stock Shirt", in_stock: true }),
      product({ id: "prod-out", name: "Sold Out Kurtas", in_stock: false }),
    ]);
    await openPicker();

    expect(await screen.findByText("Sold Out Kurtas")).toBeInTheDocument();
    const badges = screen.getAllByTestId("product-card-out-of-stock");
    expect(badges).toHaveLength(1);
    expect(badges[0]).toHaveTextContent("inbox.composer.productCardOutOfStock");
    // Send buttons stay enabled for all rows: the send-time stock policy is the
    // authority (conversation.product-card.stock-policy P0-05) — the picker
    // only labels what the catalog read actually reported.
    expect(screen.getAllByRole("button", { name: "inbox.composer.productCardSend" })).toHaveLength(2);
  });

  it("discards a stale catalog response that resolves after a newer search", async () => {
    const slow: Promise<any[]> = new Promise((resolve) => {
      setTimeout(() => resolve([product({ name: "Stale Match" })]), 500);
    });
    vi.mocked(apiClient.getProducts).mockReturnValueOnce(slow as any);
    await openPicker();

    vi.mocked(apiClient.getProducts).mockResolvedValueOnce([product({ name: "Fresh Match" })]);
    fireEvent.change(screen.getByPlaceholderText("inbox.composer.productCardSearch"), {
      target: { value: "fresh" },
    });
    await waitFor(() => {
      expect(apiClient.getProducts).toHaveBeenCalledWith({ is_active: true, search: "fresh" });
    });
    await waitFor(() => expect(screen.getByText("Fresh Match")).toBeInTheDocument());
    // The slow first response (gen 1) resolves now and must be ignored by the
    // generation guard rather than clobbering the newer search result.
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(screen.queryByText("Stale Match")).not.toBeInTheDocument();
    expect(screen.getByText("Fresh Match")).toBeInTheDocument();
  });
});
