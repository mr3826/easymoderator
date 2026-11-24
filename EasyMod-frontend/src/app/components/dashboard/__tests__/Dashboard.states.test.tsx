/**
 * Dashboard state matrix: skeleton loading, error anatomy (what/impact/do),
 * partial-failure honesty, stale-sync warning, caught-up, and the setup
 * variant's single primary action.
 */
import "@testing-library/jest-dom";
import { act, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Dashboard from "../../Dashboard";
import { apiClient } from "@/api";
import { getStockExceptions } from "@/api/domains/product";

vi.mock("@/api", () => ({
  apiClient: {
    getSetupStatus: vi.fn(),
    getDashboardMetrics: vi.fn(),
    getDashboardQueue: vi.fn(),
    getOrders: vi.fn(),
    getConversations: vi.fn(),
    getOrderCounts: vi.fn(),
  },
}));

// New dashboard read sources (doc 04 §5) — honest empty reads by default so
// state tests exercise page behavior, not module wiring.
vi.mock("@/api/domains/product", () => ({
  getStockExceptions: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/api/domains/meta-channels", () => ({
  listMetaChannels: vi.fn().mockResolvedValue([]),
  reconnectMetaChannel: vi.fn(),
  pingMetaChannel: vi.fn(),
}));
vi.mock("@/api/domains/delivery", () => ({
  getDeliveryReadiness: vi.fn().mockResolvedValue({ providers: [] }),
}));

const { tMock } = vi.hoisted(() => ({
  tMock: (key: string, opts?: Record<string, unknown>) => {
    if (opts && typeof opts === "object") {
      const vals = Object.values(opts).filter((v) => v != null).join(" ");
      if (vals) return `${key} ${vals}`;
    }
    return key;
  },
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: tMock }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

const completeSetupStatus = {
  isComplete: true,
  completedCount: 4,
  totalCount: 4,
  progressPercent: 100,
  tasks: [],
  counts: { connectedFacebookPages: 1, webhookVerifiedFacebookPages: 1, activeProducts: 3 },
  generatedAt: "2026-11-15T00:00:00.000Z",
};

const metrics = { metrics: { ordersToday: 2 }, cashPosition: null };
const queue = {
  predicate_version: "worklist-v1",
  needs_reply: { count: 0, scanned: 0, cap: 200, coverageComplete: true, generated_at: "2026-11-24T10:00:00.000Z" },
  pending_payment_count: 0,
  ready_to_dispatch_count: 0,
  at_risk_orders: [],
};
const conversations = { data: [], total: 0, page: 1, pageSize: 100, ai_reply_mode: "MANUAL" };

const pending = () => new Promise(() => {});

function renderDashboard() {
  return render(
    <MemoryRouter>
      <Dashboard />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  window.localStorage.setItem("easymod:business-setup:default:complete-dismissed", "1");
  vi.mocked(apiClient.getSetupStatus).mockResolvedValue(completeSetupStatus as never);
  vi.mocked(apiClient.getDashboardMetrics).mockResolvedValue(metrics as never);
  vi.mocked(apiClient.getDashboardQueue).mockResolvedValue(queue as never);
  vi.mocked(apiClient.getOrders).mockResolvedValue([] as never);
  vi.mocked(apiClient.getOrderCounts).mockResolvedValue({ total: 0, needs_action: 0 } as never);
  vi.mocked(apiClient.getConversations).mockResolvedValue(conversations as never);
});

describe("Dashboard states", () => {
  it("shows a layout-preserving skeleton while loading", async () => {
    vi.mocked(apiClient.getDashboardMetrics).mockImplementation(pending as never);
    renderDashboard();
    // Setup status resolves first (setup-loading skeleton), then the pulse
    // skeleton takes over while metrics stay pending.
    await waitFor(() => {
      expect(screen.getByRole("status", { name: "dashboard.pulse.loading" })).toBeInTheDocument();
    });
    expect(screen.queryByText("dashboard.pulse.title")).not.toBeInTheDocument();
  });

  it("error state says what failed and offers one primary retry", async () => {
    vi.mocked(apiClient.getDashboardMetrics).mockRejectedValue(new Error("boom"));
    vi.mocked(apiClient.getDashboardQueue).mockRejectedValue(new Error("boom"));
    vi.mocked(apiClient.getOrders).mockRejectedValue(new Error("boom"));
    vi.mocked(apiClient.getConversations).mockRejectedValue(new Error("boom"));
    // Full-fail only when every fan-out source — including the Phase-1
    // bounded reads — is down.
    vi.mocked(apiClient.getOrderCounts).mockRejectedValue(new Error("boom"));
    vi.mocked(getStockExceptions).mockRejectedValue(new Error("boom"));
    renderDashboard();

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
    expect(screen.getByText("dashboard.pulse.errorTitle")).toBeInTheDocument();
    const primary = screen.getByTestId("dashboard-primary-action");
    expect(primary).toHaveTextContent("dashboard.pulse.retry");
    expect(screen.getByText("dashboard.pulse.timeUnavailable")).toBeInTheDocument();
  });

  it("partial failure lists the failed source and keeps the page usable", async () => {
    vi.mocked(apiClient.getDashboardQueue).mockRejectedValue(new Error("boom"));
    renderDashboard();

    await waitFor(() => {
      expect(screen.getByText("dashboard.pulse.title")).toBeInTheDocument();
    });
    expect(screen.getByText(/dashboard\.pulse\.partialFail/)).toHaveTextContent("dashboard.pulse.sourceNames.actionCounts");
    // Queue source failed → chips say Unavailable, never 0.
    expect(screen.getAllByText("dashboard.pulse.queueChips.unavailable")).toHaveLength(3);
  });

  it("warns when the last sync is older than 2.5 poll intervals", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(apiClient.getDashboardMetrics)
        .mockResolvedValueOnce(metrics as never)
        .mockImplementation(pending as never);
      vi.mocked(apiClient.getDashboardQueue)
        .mockResolvedValueOnce(queue as never)
        .mockImplementation(pending as never);
      vi.mocked(apiClient.getConversations)
        .mockResolvedValueOnce(conversations as never)
        .mockImplementation(pending as never);
      vi.mocked(apiClient.getOrders)
        .mockResolvedValueOnce([] as never)
        .mockResolvedValueOnce([] as never)
        .mockResolvedValueOnce([] as never)
        .mockImplementation(pending as never);

      renderDashboard();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(screen.getByText("dashboard.pulse.title")).toBeInTheDocument();
      expect(screen.queryByText("dashboard.pulse.staleWarning")).not.toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(180_000);
      });
      expect(screen.getByText("dashboard.pulse.staleWarning")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("caught-up banner appears only with full coverage", async () => {
    renderDashboard();
    await waitFor(() => {
      expect(screen.getByText("dashboard.pulse.work.caughtUp")).toBeInTheDocument();
    });
  });

  it("setup variant has exactly one primary action — the next incomplete task", async () => {
    window.localStorage.removeItem("easymod:business-setup:default:complete-dismissed");
    vi.mocked(apiClient.getSetupStatus).mockResolvedValue({
      ...completeSetupStatus,
      isComplete: false,
      completedCount: 1,
      progressPercent: 25,
      tasks: [
        { key: "connect_channel", title: "Connect", description: "", status: "complete", required: true, ctaLabel: "Connect", href: "/manage-shop/chat-settings", missing: [], warnings: [], meta: {} },
        { key: "shop_profile", title: "Profile", description: "", status: "incomplete", required: true, ctaLabel: "Complete info", href: "/manage-shop/business-info", missing: [], warnings: [], meta: {} },
        { key: "first_product", title: "Product", description: "", status: "incomplete", required: true, ctaLabel: "Add product", href: "/products", missing: [], warnings: [], meta: {} },
      ],
    } as never);

    renderDashboard();
    await waitFor(() => {
      expect(screen.getByText("dashboard.setup.title")).toBeInTheDocument();
    });

    const primaries = screen.getAllByTestId("dashboard-primary-action");
    expect(primaries).toHaveLength(1);
    expect(primaries[0]).toHaveTextContent("dashboard.setup.tasks.shop_profile.cta");
    // Completed task has no CTA; the later incomplete task is secondary.
    // tMock appends defaultValue interpolation, so match by prefix.
    expect(screen.queryByText(/dashboard\.setup\.tasks\.connect_channel\.cta/)).not.toBeInTheDocument();
    expect(screen.getByText(/dashboard\.setup\.tasks\.first_product\.cta/)).toBeInTheDocument();
  });
});
