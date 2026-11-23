/**
 * G-UX05 scale-path additions to the MERGED product picker (post PR #305).
 *
 * InboxComposer.productPicker.test.tsx already proves the four distinct truth
 * states (loading / zero-matches / API-failed+retry / stale-generation
 * discard), the OOS badge, and the debounced `search` round-trip, and
 * InboxComposer.r3.test.tsx proves the interaction_choices flag-off gate.
 * This file covers the remaining scale and isolation edges the matrix
 * flagged:
 *  - a >25-item catalog renders COMPLETELY (the picker keeps no local
 *    `limit: 25` slice — the server result set IS the row set),
 *  - the catalog query carries NO pagination/slice hint params at all
 *    (search is executed server-side by the authorized WP-04 path),
 *  - a server search REPLACES the previous snapshot (no client-side
 *    intersection with stale rows),
 *  - "Try again" refetches WITH the current search term (not just bare),
 *  - a stale response that lands after a newer one is discarded
 *    deterministically via deferred promises (no wall-clock sleeps),
 *  - non-Messenger threads render no picker button even with the flag on.
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

// Synthetic catalog rows only — names are generated, never real products.
function product(n: number, over: Record<string, unknown> = {}) {
  return {
    id: `scale-prod-${String(n).padStart(2, "0")}`,
    name: `Scale Item ${String(n).padStart(2, "0")}`,
    price: 100 + n,
    sku: `SCALE-${n}`,
    is_active: true,
    status: "active",
    createdAt: "2026-11-20T00:00:00Z",
    updatedAt: "2026-11-20T00:00:00Z",
    ...over,
  } as any;
}

function scaleCatalog(count: number) {
  return Array.from({ length: count }, (_, i) => product(i + 1));
}

async function openPicker(props: { interactionChoicesEnabled?: boolean; selectedConversation?: unknown } = {}) {
  render(
    <InboxComposer
      {...baseProps}
      {...props}
      selectedConversation={(props.selectedConversation ?? baseProps.selectedConversation) as any}
      interactionChoicesEnabled={props.interactionChoicesEnabled ?? true}
    />,
  );
  const button = screen.queryByTestId("inbox-product-card-button");
  if (!button) return null;
  fireEvent.click(button);
  await screen.findByTestId("inbox-product-card-popover");
  return screen.getByTestId("inbox-product-card-popover");
}

describe("InboxComposer picker scale paths (G-UX05)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders a 30-item catalog completely — the picker keeps no local 25-row cap", async () => {
    vi.mocked(apiClient.getProducts).mockResolvedValue(scaleCatalog(30));
    const popover = await openPicker();
    expect(popover).not.toBeNull();

    // Every server row renders, including item 26 and item 30 — rows beyond
    // the historical `limit: 25` client hint must stay reachable.
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: "inbox.composer.productCardSend" })).toHaveLength(30),
    );
    expect(screen.getByText("Scale Item 26")).toBeInTheDocument();
    expect(screen.getByText("Scale Item 30")).toBeInTheDocument();

    // The open query is EXACTLY the authorized-catalog call: search executes
    // server-side, so no local slice/pagination hint may be attached.
    const calls = vi.mocked(apiClient.getProducts).mock.calls;
    expect(calls.length).toBe(1);
    expect(calls[0][0]).toEqual({ is_active: true });
    for (const forbidden of ["limit", "page", "pageSize", "offset"]) {
      expect(calls[0][0]).not.toHaveProperty(forbidden);
    }
  });

  it("a server search REPLACES the snapshot instead of filtering the old rows locally", async () => {
    vi.mocked(apiClient.getProducts)
      .mockResolvedValueOnce(scaleCatalog(30))
      .mockResolvedValue([product(91, { name: "Matching Panjabi" }), product(92, { name: "Matching Kurta" })]);
    await openPicker();
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: "inbox.composer.productCardSend" })).toHaveLength(30),
    );

    fireEvent.change(screen.getByPlaceholderText("inbox.composer.productCardSearch"), {
      target: { value: "match" },
    });
    await waitFor(() => {
      expect(apiClient.getProducts).toHaveBeenCalledWith({ is_active: true, search: "match" });
    });

    // The server's 2-row answer is the whole truth: the 30 pre-search rows
    // are gone (a local slice of the first fetch could never recover item
    // 26+ for a term absent from page one — this is the >25 reachability
    // contract from the matrix).
    expect(await screen.findByText("Matching Panjabi")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "inbox.composer.productCardSend" })).toHaveLength(2);
    expect(screen.queryByText("Scale Item 30")).not.toBeInTheDocument();
    expect(screen.queryByText("Scale Item 01")).not.toBeInTheDocument();
  });

  it("Try again refetches with the CURRENT search term, not a bare catalog query", async () => {
    vi.mocked(apiClient.getProducts).mockRejectedValue(new Error("500 catalog unavailable"));
    await openPicker();

    fireEvent.change(screen.getByPlaceholderText("inbox.composer.productCardSearch"), {
      target: { value: "panjabi" },
    });
    await waitFor(() => {
      expect(apiClient.getProducts).toHaveBeenCalledWith({ is_active: true, search: "panjabi" });
    });

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("inbox.composer.productCardError");

    vi.mocked(apiClient.getProducts).mockResolvedValue([product(5, { name: "Recovered Panjabi" })]);
    fireEvent.click(screen.getByRole("button", { name: "inbox.composer.productCardRetry" }));

    // The retry must re-run the SAME query the merchant was looking at.
    await waitFor(() => {
      const calls = vi.mocked(apiClient.getProducts).mock.calls;
      const last = calls.length ? calls[calls.length - 1][0] : undefined;
      expect(last).toEqual({ is_active: true, search: "panjabi" });
    });
    expect(await screen.findByText("Recovered Panjabi")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("discards a stale catalog response deterministically when a newer search already resolved", async () => {
    let releaseStale: (rows: any[]) => void = () => {};
    const stalePromise = new Promise<any[]>((resolve) => { releaseStale = resolve; });
    vi.mocked(apiClient.getProducts)
      .mockReturnValueOnce(stalePromise as any)
      .mockResolvedValue([product(77, { name: "Fresh Match" })]);
    await openPicker();

    fireEvent.change(screen.getByPlaceholderText("inbox.composer.productCardSearch"), {
      target: { value: "fresh" },
    });
    await waitFor(() => {
      expect(apiClient.getProducts).toHaveBeenCalledWith({ is_active: true, search: "fresh" });
    });
    await screen.findByText("Fresh Match");

    // Now the FIRST (older) request lands late. The generation guard drops it
    // synchronously on settle — flushing macrotasks is sufficient, no
    // wall-clock sleep (the PR #305 flake lesson: settle on state, not time).
    releaseStale([product(88, { name: "Stale Match" })]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(screen.queryByText("Stale Match")).not.toBeInTheDocument();
    expect(screen.getByText("Fresh Match")).toBeInTheDocument();
    // And the late response may not even flip loading/error state: the
    // single fresh row is still the whole list, with no alert.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "inbox.composer.productCardSend" })).toHaveLength(1);
  });

  it("renders no product-card affordance on non-Messenger threads even with the flag on", async () => {
    const whatsappConversation = {
      ...messengerConversation,
      id: "44444444-4444-4444-8444-444444444444",
      channel: "whatsapp",
    };
    const popover = await openPicker({
      selectedConversation: whatsappConversation,
      interactionChoicesEnabled: true,
    });
    expect(popover).toBeNull();
    expect(screen.queryByTestId("inbox-product-card-button")).not.toBeInTheDocument();
    expect(screen.queryByTestId("inbox-product-card-popover")).not.toBeInTheDocument();
    expect(apiClient.getProducts).not.toHaveBeenCalled();
  });

  it("flag-off renders nothing new beyond the base composer (interaction_choices gate)", async () => {
    vi.mocked(apiClient.getProducts).mockResolvedValue(scaleCatalog(30));
    await render(
      <InboxComposer {...baseProps} interactionChoicesEnabled={false} />,
    );
    expect(screen.queryByTestId("inbox-product-card-button")).not.toBeInTheDocument();
    expect(screen.queryByTestId("inbox-product-card-popover")).not.toBeInTheDocument();
    expect(apiClient.getProducts).not.toHaveBeenCalled();
    // The rest of the composer is untouched by the gate.
    expect(screen.getByTestId("message-input")).toBeInTheDocument();
    expect(screen.getByTestId("inbox-send")).toBeInTheDocument();
  });
});
