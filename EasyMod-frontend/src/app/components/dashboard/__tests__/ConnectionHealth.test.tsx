/**
 * ConnectionHealth (D7) state matrices: Meta row from real channel facts
 * (worst-state aggregate; connected·verified vs connected·unverified via the
 * stored webhook timestamp; reconnect-required with the REAL OAuth hand-off —
 * no auto-ping; disconnected; fetch failure → Unavailable, never green) and
 * the courier row from getDeliveryReadiness (ACTIVE → ready; READY →
 * connectedNotActive — the two server states are distinct (A8);
 * SETUP_INCOMPLETE + missingCount excluding provider_not_active; no
 * integrations → notSetUp; failure → unavailable).
 */
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectionHealth, aggregateMetaState, channelState, courierMissingCount } from "../ConnectionHealth";
import { listMetaChannels, reconnectMetaChannel, pingMetaChannel } from "@/api/domains/meta-channels";
import { getDeliveryReadiness } from "@/api/domains/delivery";
import type { MetaChannel } from "@/api/domains/meta-channels";
import type { DeliveryReadiness } from "@/api/domains/delivery";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (opts && typeof opts === "object") {
        const vals = Object.values(opts).filter((v) => v != null).join(" ");
        if (vals) return `${key} ${vals}`;
      }
      return key;
    },
  }),
}));

vi.mock("@/api/domains/meta-channels", () => ({
  listMetaChannels: vi.fn(),
  reconnectMetaChannel: vi.fn(),
  pingMetaChannel: vi.fn(),
}));

vi.mock("@/api/domains/delivery", () => ({
  getDeliveryReadiness: vi.fn(),
}));

const channel = (overrides: Partial<MetaChannel> = {}): MetaChannel => ({
  id: "ch-1", shopId: "shop-1", platform: "facebook", metaAssetId: "123",
  displayName: "Sales Page", pictureUrl: null, status: "CONNECTED", isHealthy: true,
  needsReconnect: false, lastError: null, tokenExpiresAt: null, tokenLastRefreshedAt: null,
  webhookSubscribedFields: [], webhookLastVerifiedAt: "2026-11-20T10:00:00.000Z",
  connectedAt: null, disconnectedAt: null, createdAt: "", updatedAt: "", purposeLabel: null,
  ...overrides,
});

const readiness = (overrides: Partial<DeliveryReadiness> = {}): DeliveryReadiness => ({
  provider: "pathao", ready: true, connected: true, active: true,
  credentials_configured: true, provider_store_id: "st", provider_store_count: 1,
  pickup_location_configured: true, pickup_enabled: true, pickup_summary: null,
  provider_pickup_meta: {}, pickup_locations_count: 1,
  missing: [], missing_fields: [], status: "ACTIVE",
  providers: [{} as DeliveryReadiness],
  ...overrides,
} as DeliveryReadiness);

function stubLocation() {
  const assign = vi.fn();
  Object.defineProperty(window.location, "assign", { value: assign, configurable: true });
  return assign;
}

const originalAssign = window.location.assign;
afterEach(() => {
  Object.defineProperty(window.location, "assign", { value: originalAssign, configurable: true });
});

beforeEach(() => vi.clearAllMocks());

async function renderHealth(meta: unknown, courier: unknown) {
  vi.mocked(listMetaChannels).mockResolvedValue(meta as never);
  vi.mocked(getDeliveryReadiness).mockResolvedValue(courier as never);
  render(<MemoryRouter><ConnectionHealth /></MemoryRouter>);
  await waitFor(() => {
    expect(screen.queryByText("dashboard.pulse.signal.pending")).toBeNull();
  });
}

describe("pure state helpers", () => {
  it("maps channel facts to the four honest states", () => {
    expect(channelState(channel())).toBe("connectedVerified");
    expect(channelState(channel({ webhookLastVerifiedAt: null }))).toBe("connectedUnverified");
    expect(channelState(channel({ status: "TOKEN_EXPIRED", webhookLastVerifiedAt: null }))).toBe("reconnectRequired");
    expect(channelState(channel({ status: "REVOKED" }))).toBe("reconnectRequired");
    expect(channelState(channel({ status: "ERROR" }))).toBe("reconnectRequired");
    expect(channelState(channel({ needsReconnect: true }))).toBe("reconnectRequired");
    expect(channelState(channel({ status: "DISCONNECTED", webhookLastVerifiedAt: null }))).toBe("disconnected");
  });

  it("aggregates the WORST state across channels; empty means disconnected", () => {
    expect(aggregateMetaState([])).toBe("disconnected");
    expect(aggregateMetaState([channel(), channel({ webhookLastVerifiedAt: null })])).toBe("connectedUnverified");
    expect(aggregateMetaState([channel(), channel({ status: "DISCONNECTED", webhookLastVerifiedAt: null })])).toBe("disconnected");
    expect(aggregateMetaState([channel({ status: "DISCONNECTED" }), channel({ status: "TOKEN_EXPIRED", webhookLastVerifiedAt: null })])).toBe("reconnectRequired");
    expect(aggregateMetaState([channel(), channel()])).toBe("connectedVerified");
  });

  it("counts courier gaps from the single missing array, excluding provider_not_active", () => {
    // missing and missing_fields are the SAME array — never summed together.
    expect(courierMissingCount(readiness({
      missing: ["pickup_location", "provider_not_active"],
      missing_fields: ["pickup_location", "provider_not_active"],
    }))).toBe(1);
    expect(courierMissingCount(readiness({ missing: [], missing_fields: [] }))).toBe(0);
  });
});

describe("ConnectionHealth rendering", () => {
  it("shows an honest pending state while both sources load", () => {
    vi.mocked(listMetaChannels).mockReturnValue(new Promise(() => {}));
    vi.mocked(getDeliveryReadiness).mockReturnValue(new Promise(() => {}));
    render(<MemoryRouter><ConnectionHealth /></MemoryRouter>);
    expect(screen.getAllByText("dashboard.pulse.signal.pending")).toHaveLength(2);
  });

  it("connected + webhook-verified channels read verified; courier ACTIVE reads ready", async () => {
    await renderHealth([channel()], readiness());
    // Aggregate badge AND the per-channel detail row both read verified.
    expect(screen.getAllByText("dashboard.connections.connectedVerified")).toHaveLength(2);
    expect(screen.getByText("dashboard.connections.ready")).toBeInTheDocument();
    // A verified read is allowed green here because it is a REAL stored fact.
    expect(screen.queryByText("dashboard.connections.unavailable")).toBeNull();
  });

  it("per-channel detail lists every channel with its own state", async () => {
    await renderHealth(
      [channel({ id: "a", displayName: "Main Page" }), channel({ id: "b", displayName: "Outlet Page", webhookLastVerifiedAt: null })],
      readiness(),
    );
    expect(screen.getByText("Main Page")).toBeInTheDocument();
    expect(screen.getByText("Outlet Page")).toBeInTheDocument();
    // Worst-state aggregate = unverified; the outlet row names its own state.
    expect(screen.getAllByText("dashboard.connections.connectedUnverified").length).toBeGreaterThan(0);
  });

  it("failed Meta fetch renders Unavailable — never green — with a retry", async () => {
    vi.mocked(listMetaChannels).mockRejectedValue(new Error("boom"));
    vi.mocked(getDeliveryReadiness).mockResolvedValue(readiness());
    render(<MemoryRouter><ConnectionHealth /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("connections-meta-row").textContent).toContain("dashboard.connections.unavailable"));
    expect(screen.getByTestId("connections-meta-row").textContent).not.toContain("connectedVerified");
    expect(screen.getByTestId("connections-retry")).toBeInTheDocument();
  });

  it("failed courier fetch renders Unavailable, independent of a healthy Meta row", async () => {
    vi.mocked(listMetaChannels).mockResolvedValue([channel()] as never);
    vi.mocked(getDeliveryReadiness).mockRejectedValue(new Error("boom"));
    render(<MemoryRouter><ConnectionHealth /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("connections-courier-row").textContent).toContain("dashboard.connections.unavailable"));
    expect(screen.getByTestId("connections-courier-row").textContent).not.toContain("connections.ready");
    // Meta row healthy despite the courier failure (independent reads).
    expect(screen.getByTestId("connections-meta-row").textContent).toContain("dashboard.connections.connectedVerified");
  });

  it("no courier integrations → Not set up (not a green tile)", async () => {
    await renderHealth([], readiness({ providers: [] }));
    expect(screen.getByTestId("connections-courier-row").textContent).toContain("dashboard.connections.notSetUp");
    expect(screen.getByTestId("connections-meta-row").textContent).toContain("dashboard.connections.disconnected");
  });

  it("SETUP_INCOMPLETE shows the missing count excluding provider_not_active", async () => {
    await renderHealth([], readiness({
      status: "SETUP_INCOMPLETE", active: false, ready: false, connected: true,
      missing: ["provider_not_active", "pickup_location", "credentials"],
      missing_fields: ["provider_not_active", "pickup_location", "credentials"],
    }));
    // connected && !active surfaces the honest connected·inactive label.
    expect(screen.getByText("dashboard.connections.connectedNotActive")).toBeInTheDocument();
    expect(screen.getByText(/connections.missingCount 2/)).toBeInTheDocument();
  });

  it("SETUP_INCOMPLETE without activation shows setupIncomplete", async () => {
    await renderHealth([], readiness({
      status: "SETUP_INCOMPLETE", active: false, ready: false, connected: false,
      missing: ["provider_not_connected", "pickup_location"],
      missing_fields: ["provider_not_connected", "pickup_location"],
    }));
    expect(screen.getByText("dashboard.connections.setupIncomplete")).toBeInTheDocument();
    expect(screen.getByText(/connections.missingCount 2/)).toBeInTheDocument();
  });

  // A8 MAJOR: ACTIVE and READY are DISTINCT server states — READY is
  // configured-but-not-active (can never dispatch) and must never borrow
  // the healthy "Ready" label. The missing-count rule is untouched.
  it("READY renders connectedNotActive, ACTIVE still renders ready", async () => {
    await renderHealth([channel()], readiness({ status: "READY", active: false, connected: true, ready: true, credentials_configured: true }));
    expect(screen.getByText("dashboard.connections.connectedNotActive")).toBeInTheDocument();
    expect(screen.queryByText("dashboard.connections.ready")).not.toBeInTheDocument();
  });

  it("READY keeps counting gaps from `missing` alone (provider_not_active excluded)", async () => {
    // READY with real missing steps — the distinct label did NOT change the
    // missing-count rule (uses `missing` only, provider_not_active excluded).
    await renderHealth([channel()], readiness({
      status: "READY", active: false, connected: true, ready: true,
      missing: ["default_store", "provider_not_active"],
      missing_fields: ["default_store", "provider_not_active"],
    }));
    expect(screen.getByText("dashboard.connections.connectedNotActive")).toBeInTheDocument();
    expect(screen.getByText(/connections.missingCount 1/)).toBeInTheDocument();
  });

  it("ACTIVE renders the healthy ready label (regression pin for the split)", async () => {
    await renderHealth([channel()], readiness());
    expect(screen.getByText("dashboard.connections.ready")).toBeInTheDocument();
    expect(screen.queryByText("dashboard.connections.connectedNotActive")).not.toBeInTheDocument();
  });

  it("row labels link to the verified settings destinations", async () => {
    await renderHealth([channel()], readiness());
    expect(screen.getByRole("link", { name: "dashboard.connections.metaRow" })).toHaveAttribute("href", "/manage-shop/channels");
    expect(screen.getByRole("link", { name: "dashboard.connections.courierRow" })).toHaveAttribute("href", "/manage-shop/delivery-settings");
  });

  it("reconnect-required renders a real OAuth reconnect per channel and navigates to the server redirectUrl", async () => {
    const assign = stubLocation();
    vi.mocked(reconnectMetaChannel).mockResolvedValue({ redirectUrl: "https://facebook.com/oauth?state=xyz", state: "xyz", channelId: "ch-tok", platform: "facebook" });
    await renderHealth([channel({ id: "ch-tok", status: "TOKEN_EXPIRED", webhookLastVerifiedAt: null, displayName: "Outlet Page" })], readiness());
    // Aggregate + per-channel detail both surface the reconnect-required state.
    expect(screen.getAllByText("dashboard.connections.reconnectRequired").length).toBeGreaterThan(0);
    await act(async () => { fireEvent.click(screen.getByTestId("connection-reconnect-ch-tok")); });
    expect(reconnectMetaChannel).toHaveBeenCalledWith("ch-tok");
    expect(assign).toHaveBeenCalledWith("https://facebook.com/oauth?state=xyz");
  });

  it("reconnect failure stays honest — no silent success, no navigation, button returns", async () => {
    const assign = stubLocation();
    vi.mocked(reconnectMetaChannel).mockRejectedValue(new Error("oauth unavailable"));
    await renderHealth([channel({ id: "ch-tok", status: "REVOKED", webhookLastVerifiedAt: null })], readiness());
    await act(async () => { fireEvent.click(screen.getByTestId("connection-reconnect-ch-tok")); });
    // A failed reconnect attempt says so specifically — not the generic
    // row-unavailable fallback.
    expect(screen.getByText("dashboard.connections.reconnectFailed")).toBeInTheDocument();
    expect(screen.queryByText("dashboard.connections.unavailable")).not.toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
    expect(screen.getByTestId("connection-reconnect-ch-tok")).not.toBeDisabled();
  });

  it("never pings the webhook test endpoint (D7: no auto-ping)", async () => {
    await renderHealth([channel({ status: "ERROR", webhookLastVerifiedAt: null, needsReconnect: true })], readiness());
    expect(pingMetaChannel).not.toHaveBeenCalled();
  });
});
