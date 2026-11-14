import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import i18n from "@/i18n";
import Pricing from "../Pricing";

const { mockContractQuery, mockClaimDecisions, mockAddons } = vi.hoisted(() => ({
  mockContractQuery: vi.fn(),
  mockClaimDecisions: vi.fn(),
  mockAddons: vi.fn(),
}));

vi.mock("@/api/domains/commercialContract", () => ({
  useCommercialContract: mockContractQuery,
  useClaimDecisions: mockClaimDecisions,
}));
vi.mock("@/api/domains/publicAddons", () => ({ getPublicAddonCatalog: mockAddons }));

const CONTRACT_HASH = `sha256:${"b".repeat(64)}`;
const REGISTRY_HASH = `sha256:${"a".repeat(64)}`;

const contractPayload = {
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
    blockCourierBooking: true,
    pauseAutomatedAi: true,
    keepInboxReadable: true,
    keepHistoryReadable: true,
    deleteData: false,
  },
  description: {
    en: "৳10.00 per delivered order. ৳0.00 on returned or cancelled orders. No subscription.",
    bn: "প্রতি ডেলিভারি অর্ডারে ৳১০.০০। রিটার্ন বা বাতিল অর্ডারে ৳০.০০।",
  },
  claims: [],
};

const addonData = [
  { code: "ADS_STUDIO", name: "EasyModerator Ads Studio", category: "advertising", availability: "pilot_approval_required", billing_terms: "not_activated", price_bdt_monthly: null, summary: "Import Meta Ads CSV reports and prepare grounded drafts.", limits: ["No direct Meta Ads API connection."] },
  { code: "STOREFRONT", name: "EasyModerator Storefront", category: "commerce", availability: "pilot_approval_required", billing_terms: "not_activated", price_bdt_monthly: null, summary: "Publish selected products and receive COD orders.", limits: ["No online payment or courier automation."] },
];

const decision = (overrides: Record<string, unknown> = {}) => ({
  claimId: "billing.delivered_order",
  available: true,
  render: "claim",
  textKey: `claims.billing.delivered_order.${i18n.language === "bn" ? "bn" : "en"}`,
  locale: i18n.language === "bn" ? "bn" : "en",
  surface: "pricing",
  scope: { claimedProviders: null, verifiedProviders: null, match: true, text: null },
  interpolation: {},
  mode: "enforce",
  predicate: {
    code_present: true,
    merchant_enabled: true,
    production_verified: true,
    deprecated: false,
    internal_only: false,
    scope_match: true,
  },
  wouldBlock: false,
  contractVersion: "1.0.0",
  registryHash: REGISTRY_HASH,
  ...overrides,
});

function availableContract(overrides: Record<string, unknown> = {}) {
  const refetch = vi.fn();
  mockContractQuery.mockReturnValue({ data: contractPayload, isPending: false, error: null, refetch, ...overrides });
  return refetch;
}

describe("Pricing", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await i18n.changeLanguage("en");
    availableContract();
    mockAddons.mockResolvedValue(addonData);
    mockClaimDecisions.mockReturnValue({
      data: {
        surface: "pricing",
        locale: "en",
        contractVersion: "1.0.0",
        registryHash: REGISTRY_HASH,
        decisions: [decision()],
      },
      isLoading: false,
      error: null,
    });
  });

  it("renders the single delivered-order offer from the commercial contract", async () => {
    render(<MemoryRouter><Pricing /></MemoryRouter>);

    expect(await screen.findByRole("heading", { name: "Delivered-order billing", level: 2 })).toBeInTheDocument();
    expect(screen.getByTestId("commercial-unit-price")).toHaveTextContent("৳10.00");
    expect(screen.getByText("per delivered order")).toBeInTheDocument();
    expect(screen.getByText(/৳10\.00 per delivered order\. ৳0\.00 on returned or cancelled orders/i)).toBeInTheDocument();
    expect(screen.getAllByText(/billed at ৳0\.00/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/no subscription, setup fee or monthly minimum/i)).toBeInTheDocument();
    expect(screen.getByText(/due within 7 days/i)).toBeInTheDocument();
    expect(screen.getByText(/contract version 1\.0\.0/i)).toBeInTheDocument();

    const offer = document.querySelector('[data-contract-version="1.0.0"]');
    expect(offer).not.toBeNull();
    expect(offer).toHaveAttribute("data-contract-hash", CONTRACT_HASH);

    expect(screen.getByRole("link", { name: /create an EasyModerator account/i })).toHaveAttribute("href", expect.stringContaining("/signup?lang=en"));
    expect(await screen.findByRole("heading", { name: "EasyModerator Ads Studio" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "EasyModerator Storefront" })).toBeInTheDocument();
  });

  it("renders the contract claim and its contract-version attribute", async () => {
    render(<MemoryRouter><Pricing /></MemoryRouter>);

    await screen.findByTestId("commercial-unit-price");
    const claim = document.querySelector('[data-claim-id="billing.delivered_order"]');
    expect(claim).not.toBeNull();
    expect(claim).toHaveAttribute("data-contract-version", "1.0.0");
    expect(claim?.textContent).toMatch(/৳10\.00 per provider-confirmed delivered order/i);
  });

  it("fails closed when the contract is unavailable and never substitutes a price", async () => {
    const refetch = vi.fn();
    mockContractQuery.mockReturnValue({ data: undefined, isPending: false, error: new Error("offline"), refetch });

    render(<MemoryRouter><Pricing /></MemoryRouter>);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/current pricing is unavailable/i);
    expect(screen.queryByTestId("commercial-unit-price")).not.toBeInTheDocument();
    expect(screen.queryByText("৳10.00")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("shows a loading status before the contract resolves", async () => {
    mockContractQuery.mockReturnValue({ data: undefined, isPending: true, error: null, refetch: vi.fn() });

    render(<MemoryRouter><Pricing /></MemoryRouter>);

    expect(await screen.findByRole("status")).toHaveTextContent(/loading current pricing/i);
    expect(screen.queryByTestId("commercial-unit-price")).not.toBeInTheDocument();
  });

  it("uses contracted Bengali numerals for the price", async () => {
    await act(async () => { await i18n.changeLanguage("bn"); });
    mockClaimDecisions.mockReturnValue({
      data: {
        surface: "pricing",
        locale: "bn",
        contractVersion: "1.0.0",
        registryHash: REGISTRY_HASH,
        decisions: [decision({ locale: "bn", textKey: "claims.billing.delivered_order.bn" })],
      },
      isLoading: false,
      error: null,
    });

    render(<MemoryRouter><Pricing /></MemoryRouter>);

    expect(await screen.findByTestId("commercial-unit-price")).toHaveTextContent("৳১০.০০");
    expect(screen.getByText("প্রতি ডেলিভারি অর্ডারে")).toBeInTheDocument();
  });

  it("renders one contract-backed offer instead of a plan catalog", async () => {
    render(<MemoryRouter><Pricing /></MemoryRouter>);

    await screen.findByTestId("commercial-unit-price");
    expect(document.querySelectorAll("article[data-contract-version]")).toHaveLength(1);
    expect(screen.queryByText(/per month/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});