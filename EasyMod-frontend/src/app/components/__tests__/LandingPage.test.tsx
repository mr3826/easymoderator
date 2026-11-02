import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import i18n from "@/i18n";
import LandingPage from "../LandingPage";

const { mockCatalog, mockAddonCatalog, mockPlans, mockConfig } = vi.hoisted(() => ({
  mockCatalog: vi.fn(),
  mockAddonCatalog: vi.fn(),
  mockConfig: { checkoutEnabled: false },
  mockPlans: [
    { id: "shuru", code: "SHURU", name: "Shuru", publicName: "Get Your Moderator", description: "No monthly plan fee.", descriptionBn: "মাসিক ফি নেই।", billingModel: "flat_monthly", monthlyPrice: 0, yearlyPrice: 0, canPurchaseTopups: false, limits: { conversations: 100, orders: -1, products: -1 }, supportReplyAllowance: { amount: 300, unit: "provider_accepted_ai_reply", period: "utc_calendar_month", status: "shadow_only", billable: false, enforced: false }, features: { image_understanding: true, advanced_ai: true, priority_support: true, custom_branding: false, messenger_dm_only: true }, highlights: [] },
    { id: "growth", code: "GROWTH", name: "Growth", publicName: "Moderator Plus", description: "Monthly subscription.", descriptionBn: "মাসিক সাবস্ক্রিপশন।", billingModel: "flat_monthly", monthlyPrice: 999, yearlyPrice: 0, canPurchaseTopups: true, limits: { conversations: 500, orders: -1, products: -1 }, supportReplyAllowance: { amount: 3000, unit: "provider_accepted_ai_reply", period: "utc_calendar_month", status: "shadow_only", billable: false, enforced: false }, features: { image_understanding: true, advanced_ai: true, priority_support: true, custom_branding: false, messenger_dm_only: true }, highlights: [], topupPacks: [{ code: "PACK_100", conversations: 100, priceBdt: 250 }] },
    { id: "partner", code: "PARTNER", name: "Partner", publicName: "Partnership", description: "Delivered-order billing.", descriptionBn: "Delivered-order billing।", billingModel: "per_order", monthlyPrice: 0, yearlyPrice: 0, canPurchaseTopups: false, limits: { conversations: -1, orders: -1, products: -1 }, supportReplyAllowance: null, features: { image_understanding: true, advanced_ai: true, priority_support: true, custom_branding: false, messenger_dm_only: true }, highlights: [], partnerOrderTiers: [{ minOrders: 300, maxOrders: 999, rateBdt: 15 }, { minOrders: 1000, maxOrders: 2999, rateBdt: 12 }, { minOrders: 3000, maxOrders: null, rateBdt: 10 }] },
  ],
}));

vi.mock("@/app/lib/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/lib/config")>();
  return { ...actual, isBkashEnabled: vi.fn(() => mockConfig.checkoutEnabled) };
});
vi.mock("@/api/domains/publicSubscription", () => ({ getCurrentPublicSubscriptionCatalog: mockCatalog }));
vi.mock("@/api/domains/publicAddons", () => ({ getPublicAddonCatalog: mockAddonCatalog }));
vi.mock("@/app/lib/funnel", () => ({ trackFunnelEvent: vi.fn() }));

describe("V7-enhanced V6 LandingPage", () => {
  beforeEach(async () => {
    mockCatalog.mockReset().mockResolvedValue({ plans: mockPlans, source: "live" });
    mockAddonCatalog.mockReset().mockResolvedValue([
      { code: "ADS_STUDIO", name: "EasyModerator Ads Studio", category: "advertising", availability: "pilot_approval_required", billing_terms: "not_activated", price_bdt_monthly: null, summary: "Import a Meta Ads CSV and review grounded recommendations.", limits: ["No direct Meta Ads API connection.", "No spend changes, campaign publishing or attribution."] },
      { code: "STOREFRONT", name: "EasyModerator Storefront", category: "commerce", availability: "pilot_approval_required", billing_terms: "not_activated", price_bdt_monthly: null, summary: "Publish selected existing products and receive COD orders.", limits: ["COD only.", "No courier automation or cash reconciliation."] },
    ]);
    mockConfig.checkoutEnabled = false;
    await i18n.changeLanguage("en");
  });

  it("shows the English V7 copy, section order, and accessible action routes", async () => {
    render(<MemoryRouter><LandingPage /></MemoryRouter>);

    expect(await screen.findByText(/100 Messenger conversations each month/i)).toBeInTheDocument();
    for (const packageName of ["Get Your Moderator", "Moderator Plus", "Partnership"]) {
      expect(screen.getByRole("heading", { name: packageName })).toBeInTheDocument();
    }
    expect(screen.getByRole("heading", { name: "EasyModerator Ads Studio" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "EasyModerator Storefront" })).toBeInTheDocument();
    expect(document.querySelectorAll("#plans article")).toHaveLength(5);
    const heroHeading = screen.getByRole("heading", { level: 1, name: "From Messenger messages to orders, from ad reports to clearer decisions—all in one dashboard." });
    expect(heroHeading).toBeInTheDocument();
    expect(screen.getByText("Your Business. Our Technology. Forward, Together.")).toBeInTheDocument();
    expect(screen.getByText(/core workflow supports Facebook Page Messenger customer work/i)).toBeInTheDocument();
    const featureBar = document.querySelector<HTMLElement>("#feature-bar");
    expect(featureBar).toHaveTextContent(/approval is required/i);
    expect(screen.getByRole("link", { name: /skip to content/i })).toHaveAttribute("href", "#public-funnel-main");
    expect(document.getElementById("public-funnel-main")).toHaveAttribute("tabindex", "-1");
    const signupLinks = screen.getAllByRole("link", { name: /create your Get Your Moderator account/i });
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

    expect(screen.getByRole("heading", { name: "Create your Get Your Moderator account" }).querySelector("a")?.getAttribute("href")).toMatch(/\/signup\?lang=en$/);
    expect(screen.getByRole("heading", { name: "Connect a Facebook Page" }).querySelector("a")?.getAttribute("href")).toMatch(/\/manage-shop\/chat-settings\?lang=en$/);
    expect(screen.getByRole("heading", { name: "Review the inbox and orders" }).querySelector("a")?.getAttribute("href")).toMatch(/\/orders\?lang=en$/);
  });

  it("renders the exact Bangla-first hero and five founder pains with locale-aware calls to action", async () => {
    await act(async () => { await i18n.changeLanguage("bn"); });
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
    expect(screen.getByRole("heading", { name: /^Get Your Moderator$/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /^Moderator Plus$/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /^Partnership$/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "EasyModerator Ads Studio" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "EasyModerator Storefront" })).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: /Get Your Moderator অ্যাকাউন্ট তৈরি করুন/i }).every((link) => link.getAttribute("href")?.endsWith("?lang=bn"))).toBe(true);
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
    expect(screen.getAllByText(/Get Your Moderator, Moderator Plus and Partnership map to the existing SHURU/i).length).toBeGreaterThan(0);
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

  it("fails closed when the live plan catalog is incomplete", async () => {
    mockCatalog.mockResolvedValueOnce({ plans: [mockPlans[0]], source: "live" });
    render(<MemoryRouter><LandingPage /></MemoryRouter>);

    expect(await screen.findByRole("alert")).toHaveTextContent(/current plan details are unavailable/i);
    expect(screen.queryByText("৳999")).not.toBeInTheDocument();
    expect(screen.queryByText("৳0")).not.toBeInTheDocument();
  });

  it("does not mention separately priced packs while local checkout is disabled", async () => {
    render(<MemoryRouter><LandingPage /></MemoryRouter>);

    expect(await screen.findByText(/500 Messenger conversations each month/i)).toBeInTheDocument();
    expect(screen.queryByText(/100 conversations · ৳250 per pack/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Moderator Plus \(GROWTH\) only.*conversation-credit packs/i)).not.toBeInTheDocument();
  });

  it("discloses the current Growth pack prices when checkout is enabled", async () => {
    mockConfig.checkoutEnabled = true;
    render(<MemoryRouter><LandingPage /></MemoryRouter>);

    expect(await screen.findByText(/100 conversations · ৳250 per pack/i)).toBeInTheDocument();
    expect(screen.getByText(/Moderator Plus \(GROWTH\) only.*conversation-credit packs/i)).toBeInTheDocument();
  });

  it("keeps the mobile navigation operable with Escape", async () => {
    render(<MemoryRouter><LandingPage /></MemoryRouter>);

    expect(await screen.findByText(/100 Messenger conversations each month/i)).toBeInTheDocument();
    const toggle = screen.getByRole("button", { name: /open navigation/i });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveFocus();
  });
});
