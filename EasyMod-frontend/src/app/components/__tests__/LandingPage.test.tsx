import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import i18n from "@/i18n";
import LandingPage from "../LandingPage";

const { mockContractQuery, mockClaimDecisions, mockAddonCatalog } = vi.hoisted(() => ({
  mockContractQuery: vi.fn(),
  mockClaimDecisions: vi.fn(),
  mockAddonCatalog: vi.fn(),
}));

vi.mock("@/api/domains/commercialContract", () => ({
  useCommercialContract: mockContractQuery,
  useClaimDecisions: mockClaimDecisions,
}));
vi.mock("@/api/domains/publicAddons", () => ({ getPublicAddonCatalog: mockAddonCatalog }));
vi.mock("@/app/lib/funnel", () => ({ trackFunnelEvent: vi.fn() }));

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

const landingDecision = {
  claimId: "billing.delivered_order",
  available: true,
  render: "claim",
  textKey: "claims.billing.delivered_order.en",
  locale: "en",
  surface: "landing",
  scope: { claimedProviders: null, verifiedProviders: null, match: true, text: null },
  interpolation: { unitPrice: "৳10.00", unitPriceBn: "৳১০.০০" },
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
};

function availableContract() {
  mockContractQuery.mockReturnValue({ data: contractPayload, isPending: false, error: null, refetch: vi.fn() });
}

describe("LandingPage", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    availableContract();
    mockClaimDecisions.mockReturnValue({
      data: {
        surface: "landing",
        locale: "en",
        contractVersion: "1.0.0",
        registryHash: REGISTRY_HASH,
        decisions: [landingDecision],
      },
      isLoading: false,
      error: null,
    });
    mockAddonCatalog.mockResolvedValue([
      { code: "ADS_STUDIO", name: "EasyModerator Ads Studio", category: "advertising", availability: "pilot_approval_required", billing_terms: "not_activated", price_bdt_monthly: null, summary: "Import a Meta Ads CSV and review grounded recommendations.", limits: ["No direct Meta Ads API connection."] },
      { code: "STOREFRONT", name: "EasyModerator Storefront", category: "commerce", availability: "pilot_approval_required", billing_terms: "not_activated", price_bdt_monthly: null, summary: "Publish selected existing products and receive COD orders.", limits: ["COD only."] },
    ]);
    await i18n.changeLanguage("en");
  });

  it("shows the English copy, section order, and accessible action routes", async () => {
    render(<MemoryRouter><LandingPage /></MemoryRouter>);

    expect(await screen.findByTestId("landing-unit-price")).toHaveTextContent("৳10.00");
    expect(screen.getByRole("heading", { name: "One offer for every shop" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Delivered-order billing" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "EasyModerator Ads Studio" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "EasyModerator Storefront" })).toBeInTheDocument();
    expect(document.querySelectorAll("#plans article")).toHaveLength(3);
    const heroHeading = screen.getByRole("heading", { level: 1, name: "From Messenger messages to orders, from ad reports to clearer decisions—all in one dashboard." });
    expect(heroHeading).toBeInTheDocument();
    expect(screen.getByText("Your Business. Our Technology. Forward, Together.")).toBeInTheDocument();
    expect(screen.getByText(/core workflow supports Facebook Page Messenger customer work/i)).toBeInTheDocument();
    const featureBar = document.querySelector<HTMLElement>("#feature-bar");
    expect(featureBar).toHaveTextContent(/approval is required/i);
    expect(screen.getByRole("link", { name: /skip to content/i })).toHaveAttribute("href", "#public-funnel-main");
    expect(document.getElementById("public-funnel-main")).toHaveAttribute("tabindex", "-1");
    const signupLinks = screen.getAllByRole("link", { name: /create your EasyModerator account/i });
    expect(signupLinks.length).toBeGreaterThanOrEqual(2);
    expect(signupLinks.every((link) => link.getAttribute("href")?.match(/\/signup\?lang=en$/))).toBe(true);
    expect(screen.getByRole("link", { name: /see the three steps/i })).toHaveAttribute("href", "#workflow");
    expect(screen.getByRole("link", { name: /customer support/i })).toHaveAttribute("href", "#capabilities");
    expect(screen.getByRole("link", { name: /plans/i })).toHaveAttribute("href", "#plans");
    const signinLinks = screen.getAllByRole("link", { name: /sign in/i });
    expect(signinLinks.every((link) => link.getAttribute("href")?.includes("/signin?lang=en"))).toBe(true);

    const main = document.getElementById("public-funnel-main");
    expect(main).toBeInTheDocument();
    const sectionOrder = [".landing-v6-hero", "#feature-bar", "#workflow", "#capabilities", ".landing-v6-story"]
      .map((selector) => Array.from(main!.children).indexOf(main!.querySelector(selector)!));
    expect(sectionOrder.every((index) => index >= 0)).toBe(true);
    expect(sectionOrder).toEqual([...sectionOrder].sort((left, right) => left - right));

    const painTitles = Array.from(document.querySelectorAll("#capabilities article h3"), (heading) => heading.textContent);
    expect(painTitles).toEqual([
      "Business is growing, but the work isn't shrinking?",
      "Drowning in messages?",
      "Want to reduce fake orders?",
      "Worried about wasted ad spend?",
      "Cash not adding up?",
    ]);
    const cards = Array.from(document.querySelectorAll<HTMLElement>("#capabilities article"));
    expect(cards).toHaveLength(5);
    expect(cards[2]).toHaveTextContent(/not proof of fraud or a delivery guarantee/i);
    expect(cards[3]).toHaveTextContent(/merchant-supplied Meta CSV/i);
    expect(cards[3]).toHaveTextContent(/No direct Meta ad-account connection/i);
    expect(cards[4]).toHaveTextContent(/An order total is not a confirmed collection/i);
    expect(cards[4]).toHaveTextContent(/no online payment verification, courier automation or cash reconciliation/i);
    expect(cards.map((card) => new URL(card.querySelector("a")!.href).pathname)).toEqual([
      "/signup", "/inbox", "/orders", "/signin", "/orders",
    ]);
    expect(cards.every((card) => new URL(card.querySelector("a")!.href).searchParams.get("lang") === "en")).toBe(true);
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("main")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /open navigation/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /play workflow story/i })).toBeInTheDocument();
    expect(screen.getAllByRole("link").every((link) => link.hasAttribute("href"))).toBe(true);

    expect(screen.getByRole("heading", { name: "Create your EasyModerator account" }).querySelector("a")?.getAttribute("href")).toMatch(/\/signup\?lang=en$/);
    expect(screen.getByRole("heading", { name: "Connect a Facebook Page" }).querySelector("a")?.getAttribute("href")).toMatch(/\/manage-shop\/chat-settings\?lang=en$/);
    expect(screen.getByRole("heading", { name: "Review the inbox and orders" }).querySelector("a")?.getAttribute("href")).toMatch(/\/orders\?lang=en$/);
  });

  it("renders the offer from the contract and the contract claim", async () => {
    render(<MemoryRouter><LandingPage /></MemoryRouter>);

    const price = await screen.findByTestId("landing-unit-price");
    expect(price).toHaveTextContent("৳10.00");
    expect(screen.getByText("per delivered order")).toBeInTheDocument();
    expect(screen.getByText(/contract version 1\.0\.0/i)).toBeInTheDocument();
    const offer = document.querySelector('#plans [data-contract-version="1.0.0"]');
    expect(offer).toHaveAttribute("data-contract-hash", CONTRACT_HASH);
    const offerLinks = offer!.querySelectorAll("a");
    expect(Array.from(offerLinks).some((link) => /create an EasyModerator account/i.test(link.textContent ?? "") && link.getAttribute("href")?.includes("/signup?lang=en"))).toBe(true);
    expect(screen.getAllByText(/৳10\.00 per provider-confirmed delivered order/i).length).toBeGreaterThan(0);
  });

  it("renders the exact Bangla-first hero and five founder pains with locale-aware calls to action", async () => {
    await act(async () => { await i18n.changeLanguage("bn"); });
    mockClaimDecisions.mockReturnValue({
      data: {
        surface: "landing",
        locale: "bn",
        contractVersion: "1.0.0",
        registryHash: REGISTRY_HASH,
        decisions: [{ ...landingDecision, locale: "bn", textKey: "claims.billing.delivered_order.bn" }],
      },
      isLoading: false,
      error: null,
    });

    render(<MemoryRouter><LandingPage /></MemoryRouter>);

    expect(await screen.findByText(/EasyModerator-এর মূল কাজ Facebook Page Messenger/i)).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "মেসেঞ্জারের মেসেজ থেকে অর্ডার, বিজ্ঞাপনের রিপোর্ট থেকে সিদ্ধান্ত—সব এক ড্যাশবোর্ডে" })).toBeInTheDocument();
    expect(screen.getByText("আপনার ব্যবসা। আমাদের প্রযুক্তি। এগিয়ে চলি একসাথে।")).toBeInTheDocument();
    expect(Array.from(document.querySelectorAll("#capabilities article h3"), (heading) => heading.textContent)).toEqual([
      "ব্যবসা বাড়ছে, কিন্তু কাজ কমছে না?",
      "মেসেজে ডুবে যাচ্ছেন?",
      "ফেক অর্ডার কমাতে চান?",
      "বিজ্ঞাপনের টাকা অপচয়?",
      "ক্যাশ মিলছে না?",
    ]);
    expect(screen.getByText(/নিজের দেওয়া Meta CSV import/i)).toBeInTheDocument();
    expect(screen.getByText(/প্রকৃত টাকা পাওয়া ম্যানুয়ালি যাচাই করুন/i)).toBeInTheDocument();
    expect(screen.getByTestId("landing-unit-price")).toHaveTextContent("৳১০.০০");
    expect(screen.getByRole("heading", { name: "সব শপের জন্য একটি অফার" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "ডেলিভারি অর্ডার বিলিং" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "EasyModerator Ads Studio" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "EasyModerator Storefront" })).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: /EasyModerator অ্যাকাউন্ট তৈরি করুন/i }).every((link) => link.getAttribute("href")?.endsWith("?lang=bn"))).toBe(true);
    expect(Array.from(document.querySelectorAll<HTMLAnchorElement>("#capabilities article a")).every((link) => new URL(link.href).searchParams.get("lang") === "bn")).toBe(true);
    expect(screen.getByRole("link", { name: /শুরু করার তিন ধাপ দেখুন/i })).toHaveAttribute("href", "#workflow");
    expect(document.documentElement.lang).toBe("bn");
  });

  it("explains Page selection and permission boundaries without claiming universal Meta access", async () => {
    render(<MemoryRouter><LandingPage /></MemoryRouter>);

    fireEvent.click(await screen.findByText(/what happens when I connect a Facebook Page/i));
    expect(screen.getByText(/pages_messaging.*selected Page/i)).toBeInTheDocument();
    expect(screen.getByText(/pages_manage_metadata.*subscribe the Page to message webhooks/i)).toBeInTheDocument();
    expect(screen.getByText(/Instagram and advertising access are not requested/i)).toBeInTheDocument();
    expect(screen.getByText(/access varies by account and Page/i)).toBeInTheDocument();
  });

  it("shows the reply and order gates without inventing success states or unavailable products", async () => {
    render(<MemoryRouter><LandingPage /></MemoryRouter>);

    const workflow = await screen.findByRole("figure", { name: /illustrative messenger reply and order review workflow/i });
    expect(workflow).toHaveTextContent(/Facebook Messenger/i);
    expect(workflow).toHaveTextContent(/draft.*not sent/i);
    expect(workflow).toHaveTextContent(/review required/i);
    expect(workflow).not.toHaveTextContent(/order confirmed|delivered/i);
    expect(screen.queryByText(/optional solutions|campaign measurement|customer insights|coming soon/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/WhatsApp/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Instagram (?:support|integration|messages)/i)).not.toBeInTheDocument();
    expect(screen.getAllByText(/Delivered-order billing is the only merchant billing model/i).length).toBeGreaterThan(0);
  });

  it("loads the authored story only after the visitor requests it", async () => {
    render(<MemoryRouter><LandingPage /></MemoryRouter>);

    expect(await screen.findByRole("button", { name: /play workflow story/i })).toBeInTheDocument();
    expect(screen.queryByLabelText(/EasyModerator workflow story/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /play workflow story/i }));
    const video = screen.getByLabelText(/EasyModerator workflow story/i) as HTMLVideoElement;
    expect(video).toHaveAttribute("controls");
    expect(video).toHaveAttribute("preload", "metadata");
    expect(video.querySelector("source")).toHaveAttribute("src", "/media/easymoderator-commerce-workflow-v6.mp4");
  });

  it("fails closed when the commercial contract is unavailable", async () => {
    mockContractQuery.mockReturnValue({ data: undefined, isPending: false, error: new Error("offline"), refetch: vi.fn() });
    render(<MemoryRouter><LandingPage /></MemoryRouter>);

    expect(await screen.findByRole("alert")).toHaveTextContent(/current pricing is unavailable/i);
    expect(screen.queryByTestId("landing-unit-price")).not.toBeInTheDocument();
  });

  it("keeps the mobile navigation operable with Escape", async () => {
    render(<MemoryRouter><LandingPage /></MemoryRouter>);

    expect(await screen.findByTestId("landing-unit-price")).toBeInTheDocument();
    const toggle = screen.getByRole("button", { name: /open navigation/i });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveFocus();
  });
});