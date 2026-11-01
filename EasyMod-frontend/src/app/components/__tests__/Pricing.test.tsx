import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import i18n from "@/i18n";
import Pricing from "../Pricing";

const { mockPlans, mockConfig, mockCatalog, mockAddons, mockPost } = vi.hoisted(() => ({
  mockConfig: { checkoutEnabled: false },
  mockCatalog: vi.fn(),
  mockAddons: vi.fn(),
  mockPost: vi.fn().mockResolvedValue({}),
  mockPlans: [
    { id: "shuru", code: "SHURU", name: "Shuru", publicName: "Get Your Moderator", description: "No plan fee.", descriptionBn: "মাসিক ফি নেই।", billingModel: "flat_monthly", monthlyPrice: 0, yearlyPrice: 0, canPurchaseTopups: false, limits: { conversations: 100, orders: -1, products: -1 }, supportReplyAllowance: { amount: 300, unit: "provider_accepted_ai_reply", period: "utc_calendar_month", status: "shadow_only", billable: false, enforced: false }, features: { image_understanding: true, advanced_ai: true, priority_support: true, custom_branding: false, messenger_dm_only: true }, highlights: [] },
    { id: "growth", code: "GROWTH", name: "Growth", publicName: "Moderator Plus", description: "Monthly subscription.", descriptionBn: "মাসিক সাবস্ক্রিপশন।", billingModel: "flat_monthly", monthlyPrice: 999, yearlyPrice: 9990, canPurchaseTopups: true, limits: { conversations: 500, orders: -1, products: -1 }, supportReplyAllowance: { amount: 3000, unit: "provider_accepted_ai_reply", period: "utc_calendar_month", status: "shadow_only", billable: false, enforced: false }, features: { image_understanding: true, advanced_ai: true, priority_support: true, custom_branding: false, messenger_dm_only: true }, highlights: [], topupPacks: [{ code: "PACK_100", conversations: 100, priceBdt: 250 }, { code: "PACK_300", conversations: 300, priceBdt: 500 }, { code: "PACK_700", conversations: 700, priceBdt: 1000 }] },
    { id: "partner", code: "PARTNER", name: "Partner", publicName: "Partnership", description: "Delivered-order billing.", descriptionBn: "Delivered-order billing।", billingModel: "per_order", monthlyPrice: 0, yearlyPrice: 0, canPurchaseTopups: false, limits: { conversations: -1, orders: -1, products: -1 }, supportReplyAllowance: null, features: { image_understanding: true, advanced_ai: true, priority_support: true, custom_branding: false, messenger_dm_only: true }, highlights: [], partnerOrderTiers: [{ minOrders: 300, maxOrders: 999, rateBdt: 15 }, { minOrders: 1000, maxOrders: 2999, rateBdt: 12 }, { minOrders: 3000, maxOrders: null, rateBdt: 10 }] },
  ],
}));

const mockAddonData = [
  { code: "ADS_STUDIO", name: "EasyModerator Ads Studio", category: "advertising", availability: "pilot_approval_required", billing_terms: "not_activated", price_bdt_monthly: null, summary: "Import Meta Ads CSV reports and prepare grounded drafts.", limits: ["No direct Meta Ads API connection.", "No spend changes or ROAS/profit attribution."] },
  { code: "STOREFRONT", name: "EasyModerator Storefront", category: "commerce", availability: "pilot_approval_required", billing_terms: "not_activated", price_bdt_monthly: null, summary: "Publish selected products and receive COD orders.", limits: ["No online payment or courier automation."] },
];

vi.mock("@/app/lib/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/lib/config")>();
  return { ...actual, isBkashEnabled: vi.fn(() => mockConfig.checkoutEnabled) };
});

vi.mock("@/api/domains/publicSubscription", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/domains/publicSubscription")>();
  return { ...actual, getCurrentPublicSubscriptionCatalog: mockCatalog };
});
vi.mock("@/api/domains/publicAddons", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/domains/publicAddons")>();
  return { ...actual, getPublicAddonCatalog: mockAddons };
});
vi.mock("@/shared/lib/http/public-client", () => ({ publicApiPost: mockPost }));

describe("Pricing", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockConfig.checkoutEnabled = false;
    await i18n.changeLanguage("en");
    mockCatalog.mockResolvedValue({ plans: mockPlans, source: "live" });
    mockAddons.mockResolvedValue(mockAddonData);
    mockPost.mockResolvedValue({});
  });

  it("renders live prices and gives Growth a fixed review path without purchasing it", async () => {
    render(<MemoryRouter><Pricing /></MemoryRouter>);

    await waitFor(() => expect(screen.getByText("Get Your Moderator")).toBeInTheDocument());
    expect(screen.getByText("Moderator Plus")).toBeInTheDocument();
    expect(screen.getByText("Partnership")).toBeInTheDocument();
    expect(screen.getByText(/300 accepted AI-generated replies per UTC calendar month \(shadow target\)/i)).toBeInTheDocument();
    expect(screen.getByText(/3,000 accepted AI-generated replies per UTC calendar month \(shadow target\)/i)).toBeInTheDocument();
    expect(screen.getAllByText(/measurement only; it is not billed or enforced/i)).toHaveLength(2);
    expect(await screen.findByRole("heading", { name: "Choose only the pilot tools your shop needs" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "EasyModerator Ads Studio" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "EasyModerator Storefront" })).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: /sign in to check eligibility/i })).toHaveLength(2);
    expect(screen.getByText(/Get Your Moderator, Moderator Plus and Partnership retain the existing SHURU, GROWTH and PARTNER records/i)).toBeInTheDocument();
    expect(screen.getByText(/Partnership delivered-order billing period/i)).toBeInTheDocument();
    expect(screen.getByText(/0–299 delivered orders have no per-order fee.*at 300 or more, the matching rate applies to every delivered order/i)).toBeInTheDocument();
    expect(screen.getByText(/100 Messenger conversations each month/i)).toBeInTheDocument();
    expect(screen.getByText(/500 Messenger conversations each month/i)).toBeInTheDocument();
    expect(screen.getByText(/one active Messenger thread for the same shop/i)).toBeInTheDocument();
    expect(screen.getByText("৳999")).toBeInTheDocument();
    expect(screen.queryByText(/Moderator Plus \(GROWTH\) conversation packs/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Moderator Plus \(GROWTH\) accounts only.*one-time purchase/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /buy top-up|purchase pack/i })).not.toBeInTheDocument();
    const shuruCard = screen.getAllByRole("article").find((card) => card.textContent?.includes("Get Your Moderator"));
    expect(shuruCard).toBeDefined();
    const shuruLink = within(shuruCard!).getByRole("link", { name: /create a Get Your Moderator account/i });
    expect(shuruLink).toHaveAttribute("href", expect.stringContaining("/signup?lang=en"));
    expect(new URL(shuruLink.getAttribute("href")!).searchParams.has("intent")).toBe(false);
    const growthLink = screen.getByRole("link", { name: /review Moderator Plus/i });
    const growthUrl = new URL(growthLink.getAttribute("href")!);
    expect(growthUrl.pathname).toBe("/signup");
    expect(growthUrl.searchParams.get("lang")).toBe("en");
    expect(growthUrl.searchParams.get("intent")).toBe("growth-upgrade");
    expect(screen.getByText(/new shops start with Get Your Moderator/i)).toBeInTheDocument();
    expect(screen.queryByText(/most popular/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/white-label/i)).not.toBeInTheDocument();
    expect(screen.queryByText("৳9,990")).not.toBeInTheDocument();
    expect(screen.queryByText(/100 conversations.*৳250/i)).not.toBeInTheDocument();
  });

  it("calculates the Partner threshold example from the live catalog rate", async () => {
    const plans = mockPlans.map((plan) => plan.code === "PARTNER"
      ? {
          ...plan,
          partnerOrderTiers: plan.partnerOrderTiers?.map((tier, index) => index === 0
            ? { ...tier, rateBdt: 17 }
            : tier),
        }
      : plan);
    mockCatalog.mockResolvedValueOnce({ plans, source: "live" });

    render(<MemoryRouter><Pricing /></MemoryRouter>);

    expect(await screen.findByText(/At 299 delivered orders: ৳0 per-order fees\. At 300: 300 × ৳17 = ৳5,100 for the invoice period\./i)).toBeInTheDocument();
  });

  it("does not advertise gated top-up rates in the pricing description", async () => {
    render(<MemoryRouter><Pricing /></MemoryRouter>);

    await screen.findByText("Get Your Moderator");
    await waitFor(() => expect(document.querySelector('meta[name="description"]'))
      .toHaveAttribute("content", expect.not.stringMatching(/top.?up/i)));
  });

  it("shows catalog top-up prices and separate-purchase terms only when checkout is enabled", async () => {
    mockConfig.checkoutEnabled = true;
    render(<MemoryRouter><Pricing /></MemoryRouter>);

    expect(await screen.findByText(/100 conversations.*৳250/i)).toBeInTheDocument();
    expect(screen.getByText(/300 conversations.*৳500/i)).toBeInTheDocument();
    expect(screen.getByText(/700 conversations.*৳1,000/i)).toBeInTheDocument();
    expect(screen.getByText(/Moderator Plus \(GROWTH\) accounts only.*separate one-time purchase/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /buy top-up|purchase pack/i })).not.toBeInTheDocument();
  });

  it("opens the Partnership application as a labelled dialog without submitting it", async () => {
    render(<MemoryRouter><Pricing /></MemoryRouter>);

    fireEvent.click(await screen.findByRole("button", { name: /request Partnership review/i }));

    expect(screen.getByRole("dialog", { name: /Partnership application/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/business name/i)).toBeRequired();
    expect(screen.getByLabelText(/phone/i)).toBeRequired();
    expect(screen.getByLabelText(/Facebook Page/i)).toBeRequired();
    expect(screen.getByText(/use a Bangladesh mobile number such as 017XXXXXXXX/i)).toBeInTheDocument();
  });

  it("normalizes an international Bangladesh phone number to the Partner API format", async () => {
    render(<MemoryRouter><Pricing /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: /request Partnership review/i }));
    fireEvent.change(screen.getByLabelText(/business name/i), { target: { value: "Sample shop" } });
    fireEvent.change(screen.getByLabelText(/phone/i), { target: { value: "+880 1712-345678" } });
    fireEvent.change(screen.getByLabelText(/Facebook Page/i), { target: { value: "https://facebook.com/sample-shop" } });
    fireEvent.click(screen.getByRole("button", { name: /send application for review/i }));

    await screen.findByText(/your request was recorded for review/i);
    expect(mockPost).toHaveBeenCalledWith("/api/partner/apply", {
      businessName: "Sample shop",
      phone: "01712345678",
      pageLink: "https://facebook.com/sample-shop",
    });
  });

  it("does not submit an invalid Bangladesh mobile number", async () => {
    render(<MemoryRouter><Pricing /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: /request Partnership review/i }));
    fireEvent.change(screen.getByLabelText(/business name/i), { target: { value: "Sample shop" } });
    fireEvent.change(screen.getByLabelText(/phone/i), { target: { value: "12345" } });
    fireEvent.change(screen.getByLabelText(/Facebook Page/i), { target: { value: "https://facebook.com/sample-shop" } });
    fireEvent.click(screen.getByRole("button", { name: /send application for review/i }));

    expect(await screen.findByText(/enter a valid Bangladesh mobile number/i)).toBeInTheDocument();
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("reports plan catalog errors without substituting static prices and allows retry", async () => {
    mockCatalog.mockRejectedValueOnce(new Error("offline"));
    render(<MemoryRouter><Pricing /></MemoryRouter>);

    expect(await screen.findByRole("alert")).toHaveTextContent(/current plan details are unavailable/i);
    expect(screen.queryByText("৳999")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));

    expect(await screen.findByText("Get Your Moderator")).toBeInTheDocument();
  });

  it("fails closed when the live catalog omits a required plan", async () => {
    mockCatalog.mockResolvedValueOnce({
      plans: mockPlans.filter((plan) => plan.code !== "PARTNER"),
      source: "live",
    });

    render(<MemoryRouter><Pricing /></MemoryRouter>);

    expect(await screen.findByRole("alert")).toHaveTextContent(/current plan details are unavailable/i);
    expect(screen.queryByText("৳999")).not.toBeInTheDocument();
  });

  it("renders the shadow unit and optional pilot terms in Bangla", async () => {
    await act(async () => { await i18n.changeLanguage("bn"); });
    render(<MemoryRouter><Pricing /></MemoryRouter>);

    expect(await screen.findAllByText(/Meta-তে গৃহীত AI-generated reply \(shadow লক্ষ্য\)/i)).toHaveLength(2);
    expect(screen.getAllByText(/শুধু shadow measurement—ফি নেই, quota enforce হয় না/i)).toHaveLength(2);
    expect(await screen.findByRole("heading", { name: "শপের প্রয়োজনমতো pilot tool বেছে নিন" })).toBeInTheDocument();
    expect(screen.getByText(/দুটি add-on-ই অনুমোদনসাপেক্ষ pilot/i)).toBeInTheDocument();
  });
});
