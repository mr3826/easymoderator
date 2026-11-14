import "@testing-library/jest-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import i18n from "@/i18n";

import LandingPage from "../../LandingPage";

const { mockContract, mockDecisions, mockTrack } = vi.hoisted(() => ({
  mockContract: vi.fn(),
  mockDecisions: vi.fn(),
  mockTrack: vi.fn(),
}));

vi.mock("@/api/domains/commercialContract", () => ({
  useCommercialContract: mockContract,
  useClaimDecisions: mockDecisions,
}));
vi.mock("@/app/lib/funnel", () => ({ trackFunnelEvent: mockTrack }));
vi.mock("@/features/auth/AuthProvider", () => ({ useOptionalAuth: () => null }));

const REGISTRY_HASH = `sha256:${"a".repeat(64)}`;
const CONTRACT_HASH = `sha256:${"b".repeat(64)}`;

const payload = {
  contract_version: "1.0.0",
  contract_hash: CONTRACT_HASH,
  registry_hash: REGISTRY_HASH,
  model: "DELIVERED_ORDER",
  currency: "BDT",
  trigger: "ORDER_DELIVERED_PROVIDER_CONFIRMED",
  unit_price_bdt: 10,
  unit_price_minor: 1000,
  zero_rated_outcomes: ["RETURNED", "CANCELLED", "DRAFT", "CONFIRMED", "BOOKED", "IN_TRANSIT", "FAILED"],
  subscription_fee_bdt: 0,
  setup_fee_bdt: 0,
  monthly_minimum_bdt: 0,
  conversation_entitlement: null,
  cycle: "MONTHLY",
  payment: "POSTPAID",
  due_days: 7,
  on_overdue: {
    blockCourierBooking: true, pauseAutomatedAi: true, keepInboxReadable: true,
    keepHistoryReadable: true, deleteData: false,
  },
  description: { en: "৳10.00 per delivered order.", bn: "প্রতি ডেলিভারি অর্ডারে ৳১০.০০।" },
  claims: [],
};

const claimIds = [
  "price.unit", "price.zero", "price.nosub",
  "courier.booking", "courier.payout",
  "rto.verify", "voice.transcribe",
  "order.fromchat", "customer.ledger", "knowledge.gaps", "queue.priority", "handoff.human",
];

function decision(id: string, overrides: Record<string, unknown> = {}) {
  return {
    claimId: id,
    available: true,
    render: "claim",
    textKey: `claims.${id}.en`,
    locale: "en",
    surface: "landing",
    scope: { claimedProviders: null, verifiedProviders: null, match: true, text: null },
    interpolation: {
      unitPrice: "৳10.00", unitPriceBn: "৳১০.০০", zeroAmount: "৳0.00", zeroAmountBn: "৳০.০০",
      providerCount: "1", providerCountBn: "১",
    },
    mode: "enforce",
    predicate: { code_present: true, merchant_enabled: true, production_verified: true, deprecated: false, internal_only: false, scope_match: true },
    wouldBlock: false,
    contractVersion: "1.0.0",
    registryHash: REGISTRY_HASH,
    ...overrides,
  };
}

function mockDecisionSet(overridesById: Record<string, Record<string, unknown>> = {}) {
  const decisions = claimIds.map((id) => decision(id, overridesById[id]));
  mockDecisions.mockReturnValue({
    data: { surface: "landing", locale: "en", contractVersion: "1.0.0", registryHash: REGISTRY_HASH, decisions },
    isLoading: false,
    error: null,
  });
}

function renderLanding() {
  return render(<MemoryRouter><LandingPage /></MemoryRouter>);
}

beforeEach(async () => {
  vi.clearAllMocks();
  mockContract.mockReturnValue({ data: payload, isPending: false, error: null, refetch: vi.fn() });
  mockDecisionSet();
  await i18n.changeLanguage("en");
});

describe("contract-derived landing", () => {
  it("renders the unit price from the contract, not a literal", () => {
    renderLanding();
    expect(screen.getByTestId("lv7-unit-price")).toHaveTextContent("৳10.00");
    expect(screen.getByTestId("lv7-unit-price")).not.toHaveTextContent("999");
  });

  it("renders capability claims through the gate", () => {
    renderLanding();
    expect(document.querySelector('[data-claim-id="price.unit"]')).not.toBeNull();
    expect(document.querySelector('[data-claim-id="rto.verify"]')).not.toBeNull();
    expect(document.querySelector('[data-claim-id="handoff.human"]')).not.toBeNull();
  });

  it("fails closed when the commercial contract is unavailable", () => {
    mockContract.mockReturnValue({ data: undefined, isPending: false, error: new Error("offline"), refetch: vi.fn() });
    renderLanding();
    expect(screen.getByRole("alert")).toHaveTextContent(/pricing is unavailable/i);
    expect(screen.queryByTestId("lv7-unit-price")).not.toBeInTheDocument();
  });

  it("B3: price.zero failing closed removes the zero mark and the claim node", () => {
    mockDecisionSet({ "price.zero": { render: "none", textKey: null, available: false } });
    renderLanding();
    expect(screen.queryByTestId("lv7-zero-mark")).not.toBeInTheDocument();
    expect(document.querySelector('[data-claim-id="price.zero"]')).toBeNull();
  });

  it("B4: price.nosub failing closed removes the no-subscription claim node", () => {
    mockDecisionSet({ "price.nosub": { render: "none", textKey: null, available: false } });
    renderLanding();
    expect(document.querySelector('[data-claim-id="price.nosub"]')).toBeNull();
  });

  it("derives the calculator fee from the contract rate (7 live controls)", () => {
    renderLanding();
    const controls = document.querySelectorAll<HTMLInputElement>('input[type="range"]');
    expect(controls.length).toBe(7);
    // Defaults: 500 orders, 85% delivered, 1 month => 425 delivered * ৳10 = ৳4250.00
    expect(screen.getByTestId("lv7-calc-fee")).toHaveTextContent("৳4250.00");
    expect(screen.getByText(/Returned \+ cancelled \+ failed/i)).toBeInTheDocument();
  });

  it("shows the registry-derived capability status with a partial payout", () => {
    mockDecisionSet({
      "courier.payout": {
        available: true, render: "claim", textKey: "claims.courier.payout.en",
        scope: { claimedProviders: ["pathao", "steadfast", "redx"], verifiedProviders: ["steadfast"], match: false, text: null },
        predicate: { code_present: true, merchant_enabled: true, production_verified: true, deprecated: false, internal_only: false, scope_match: false },
      },
      "order.fromchat": {
        available: false, render: "fallback", textKey: "claims.order.fromchat.fallback.en",
        predicate: { code_present: true, merchant_enabled: true, production_verified: false, deprecated: false, internal_only: false, scope_match: true },
      },
    });
    renderLanding();
    const pay = document.querySelector('[data-claim-status="courier.payout"]');
    expect(pay).toHaveAttribute("data-status", "partial");
    const chat = document.querySelector('[data-claim-status="order.fromchat"]');
    expect(chat).toHaveAttribute("data-status", "partial");
    expect(within(document.querySelector(".lv7-status") as HTMLElement).getAllByText(/Partial/i).length).toBeGreaterThan(0);
  });

  it("labels the phone mockup as a sample", () => {
    renderLanding();
    expect(screen.getAllByText(/not a real customer or order/i).length).toBeGreaterThan(0);
  });
});