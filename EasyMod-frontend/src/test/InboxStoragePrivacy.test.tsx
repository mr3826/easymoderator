/**
 * G-UX10 — no customer PII in browser storage after inbox flows.
 *
 * Mounts the real UnifiedInbox (props/context mounting like the existing
 * suites — no signin ceremony) and drives the flows the matrix names:
 * conversation list load → thread select → messages render → context panel →
 * composer typing → draft send attempt → conversation switch. EVERY
 * localStorage/sessionStorage write that happens during those flows is
 * captured at the storage layer and must satisfy two independent rules:
 *
 *  1. KEY ALLOWLIST — only known non-PII keys may ever be written. The list
 *     is derived from a repo-wide audit of storage writers:
 *       localStorage:  easymod_lang (i18n/language.ts),
 *                      currentShopId (ShopContext.tsx — merchant shop id,
 *                      not customer data),
 *                      easymod:shell-collapsed (DashboardLayout),
 *                      easymod_install_dismissed (InstallPrompt),
 *                      easymod:business-setup:<id>:complete-dismissed
 *                        (FirstTimeSetupDashboard),
 *                      easymod:funnel_once:<key> (funnel.ts, value "1")
 *       sessionStorage: sse_last_id_<shopId> (api/sse-client.ts — numeric
 *                      stream cursor),
 *                      easymod:funnel_session (funnel.ts, a random uuid),
 *                      billing-standing:<shopId> (BillingStandingBanner,
 *                      value "dismissed")
 *     Nothing in the inbox component tree writes storage at all — verified
 *     by audit — so the captured set during these flows must actually be
 *     EMPTY in the happy path; the allowlist is the ceiling, not an excuse.
 *
 *  2. CONTENT SCAN — no fixture customer name, phone, PSID-shaped id, or
 *     message body may appear in ANY captured key, ANY captured value, or
 *     ANY entry of the final storage enumeration. A self-check test proves
 *     the scanner has teeth by planting a violation and catching it.
 *
 * Auth note (documented, not fought): sessions are httpOnly cookies issued
 * server-side (src/app/lib/auth.ts performs zero storage writes — pinned by
 * the JWT-shape scan below); this suite asserts the browser never
 * additionally persists transcript content or a token-shaped string.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import UnifiedInbox from "@/app/components/UnifiedInbox";
import { apiClient } from "@/api";
import { useInboxSSE } from "@/app/lib/useInboxSSE";

const routerState = vi.hoisted(() => ({
  location: { pathname: "/inbox", search: "", hash: "", state: null },
  navigate: vi.fn(),
}));

vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router-dom")>();
  return {
    ...actual,
    useLocation: () => routerState.location,
    useNavigate: () => routerState.navigate,
    useParams: () => ({}),
  };
});

vi.mock("@/api", () => ({
  apiClient: {
    getShopAgents: vi.fn(),
    getConversations: vi.fn(),
    getConversation: vi.fn(),
    getMessages: vi.fn(),
    createMessage: vi.fn(),
    approveAiDraft: vi.fn(),
    dismissAiDraft: vi.fn(),
    markConversationRead: vi.fn(),
    updateConversation: vi.fn(),
    transcribeVoice: vi.fn(),
    getResponseTemplates: vi.fn(),
    createTemplate: vi.fn(),
    updateTemplate: vi.fn(),
    deleteTemplate: vi.fn(),
    createAuditLog: vi.fn(),
    getSubscription: vi.fn(),
  },
}));

vi.mock("@/app/lib/useSubscriptionFeatures", () => ({
  useSubscriptionFeatures: () => ({
    features: { image_understanding: true, advanced_ai: true, priority_support: true, custom_branding: false },
    planName: "PRO",
    plan: null,
    loading: false,
  }),
}));

vi.mock("@/app/lib/useInboxSSE", () => ({ useInboxSSE: vi.fn() }));
vi.mock("@/api/domains/inbox", () => ({ getInboxActions: vi.fn(async () => ({ featureDisabled: true })) }));
vi.mock("@/api/domains/customer-intelligence", () => ({
  getPilotStatus: vi.fn(async () => ({ customer_intelligence: false, order_confidence_mode: "off" })),
  getCustomer360: vi.fn(async () => { throw new Error("off"); }),
}));
vi.mock("@/api/domains/order", () => ({ getOrders: vi.fn(async () => []) }));
vi.mock("@/api/domains/customer-crm", () => ({
  listCustomerNotes: vi.fn(async () => ({ data: [], total: 0 })),
  listCustomerTags: vi.fn(async () => ({ data: [] })),
  listTagVocabulary: vi.fn(async () => ({ data: [] })),
  createCustomerNote: vi.fn(),
  deleteCustomerNote: vi.fn(),
  setCustomerTags: vi.fn(),
  createTag: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));

// ── Synthetic PII fixtures (obviously fake, per mission rules) ──────────────
const PII = {
  customerName: "Rina Akter",
  psid: "10009998887776666",
  phone: "01799887766",
  messageBody: "Amar order 5544 ta kokhon delivery hobe? Call 01799887766",
  agentName: "Test Owner",
} as const;

// Clock-anchored fixture time: UnifiedInbox evaluates its Messenger 24h
// window (hoursElapsed / is24hWarning / is24hExpired) against the REAL
// Date.now(), so a pinned ISO date silently ages — past 24h it expires the
// window and changes composer behavior (regression: this suite was green
// pinned to 2026-11-23T06:00Z and started failing 24h later). Relativizing
// keeps every fixture inside the fresh window forever; 2h ago is well clear
// of both the 23h warning and 24h expiry thresholds. No fixed dates here.
const now = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
const conv = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  customer_id: `cust-${id}`,
  customer: { id: `cust-${id}`, name, channel_user_id: PII.psid, phone: PII.phone },
  channel: "messenger",
  status: "active",
  title: name,
  created_at: now,
  updated_at: now,
  unreadCount: 0,
  ...extra,
});

const list = (rows: unknown[]) => ({
  data: rows,
  ai_reply_mode: "MANUAL",
  pagination: { page: 1, totalPages: 1, total: rows.length, pageSize: 50 },
});

const messagesOf = (rows: unknown[]) => ({ messages: rows, pagination: { page: 1, totalPages: 1 } });

const piiMessage = {
  id: "msg-c1",
  conversation_id: "conv-1",
  sender: "customer",
  content: PII.messageBody,
  message_type: "text",
  created_at: now,
  updated_at: now,
  is_transcript_message: true,
};

const heldDraft = {
  id: "msg-d1",
  conversation_id: "conv-1",
  sender: "ai",
  content: "Reply draft for review.",
  ai_suggestion: "Reply draft for review.",
  message_type: "text",
  delivery_state: "DRAFT_READY",
  metadata: { delivered: false, held_reason: "draft_mode", suggestion_visibility: "VISIBLE_DRAFT_REVIEW" },
  created_at: now,
  updated_at: now,
  is_transcript_message: false,
};

// ── Storage write capture ───────────────────────────────────────────────────
type Capture = { store: "local" | "session"; key: string; value: string };
const captured: Capture[] = [];
const originals = new Map<string, PropertyDescriptor | undefined>();

function instrumentStorage(store: "local" | "session") {
  const target = store === "local" ? window.localStorage : window.sessionStorage;
  const descriptor = Object.getOwnPropertyDescriptor(target, "setItem")
    ?? Object.getOwnPropertyDescriptor(Object.getPrototypeOf(target), "setItem");
  originals.set(store, descriptor);
  const original = (descriptor?.value ?? (target as any).setItem) as Storage["setItem"];
  const bound = original.bind(target);
  Object.defineProperty(target, "setItem", {
    configurable: true,
    writable: true,
    value: (key: string, value: string) => {
      captured.push({ store, key: String(key), value: String(value) });
      bound(key, value);
    },
  });
}

instrumentStorage("local");
instrumentStorage("session");

afterAll(() => {
  for (const store of ["local", "session"] as const) {
    const target = store === "local" ? window.localStorage : window.sessionStorage;
    const descriptor = originals.get(store);
    if (descriptor) Object.defineProperty(target, "setItem", descriptor);
  }
});

const ALLOWED_EXACT = new Set([
  "easymod_lang",                 // i18n/language.ts
  "currentShopId",                // ShopContext.tsx — merchant shop id, not customer data
  "easymod:shell-collapsed",      // DashboardLayout (collapse flag)
  "easymod_install_dismissed",    // InstallPrompt (dismiss flag)
  "easymod:funnel_session",       // funnel.ts — random uuid, public funnel only
]);
const ALLOWED_PATTERNS: RegExp[] = [
  /^easymod:business-setup:[^:]+:complete-dismissed$/, // FirstTimeSetupDashboard (value "1")
  /^easymod:funnel_once:.+$/,                          // funnel.ts (value "1")
  /^sse_last_id_[^:]+$/,                               // sse-client.ts (numeric stream cursor)
  /^billing-standing:.+$/,                             // BillingStandingBanner (value "dismissed")
];

const PII_NEEDLES = [PII.customerName, PII.psid, PII.phone, PII.messageBody];
// JWT-shaped strings would indicate a moved-out-of-cookie auth token.
const JWT_SHAPE = /eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/;

function keyIsAllowed(key: string): boolean {
  return ALLOWED_EXACT.has(key) || ALLOWED_PATTERNS.some((pattern) => pattern.test(key));
}

function enumerateBothStores(): Capture[] {
  const rows: Capture[] = [];
  for (const store of ["local", "session"] as const) {
    const target = store === "local" ? window.localStorage : window.sessionStorage;
    for (let i = 0; i < target.length; i += 1) {
      const key = target.key(i);
      if (key === null) continue;
      rows.push({ store, key, value: String(target.getItem(key) ?? "") });
    }
  }
  return rows;
}

function findPiiViolations(entries: Capture[]): string[] {
  const violations: string[] = [];
  for (const { store, key, value } of entries) {
    if (!keyIsAllowed(key)) violations.push(`non-allowlisted key ${store}:${key}`);
    for (const needle of PII_NEEDLES) {
      if (key.includes(needle)) violations.push(`PII in ${store} KEY: ${key}`);
      if (value.includes(needle)) violations.push(`PII in ${store} VALUE of ${key}`);
    }
    if (JWT_SHAPE.test(value)) violations.push(`token-shaped value stored at ${store}:${key}`);
  }
  return violations;
}

async function driveInboxFlows() {
  render(<MemoryRouter><UnifiedInbox /></MemoryRouter>);
  await screen.findByRole("heading", { name: "Shared Inbox", level: 1 });
  // Header-removal C6: the signal band is gone; the contextual mode pill is
  // the mount/readiness anchor now.
  await waitFor(() => expect(screen.getByTestId("inbox-ai-reply-mode")).toBeInTheDocument());
  expect(screen.queryByTestId("inbox-signal")).toBeNull();

  // Select the thread carrying PII-shaped fixtures; messages render through
  // the transcript, the context panel opens, the composer is typed into and
  // a draft review + send attempt run.
  fireEvent.click(await screen.findByRole("button", { name: new RegExp(PII.customerName) }));
  await screen.findByText(PII.messageBody);

  const toggle = screen.queryByTestId("context-toggle");
  if (toggle) {
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.queryByTestId("customer-context-panel")).toBeTruthy());
  }

  const input = screen.getByTestId("message-input");
  fireEvent.change(input, { target: { value: `Thanks ${PII.customerName}, checking order 5544.` } });

  const sendThis = screen.queryByRole("button", { name: "Send this" });
  if (sendThis) {
    // DRAFT_READY approval goes through the canonical approve endpoint
    // (InboxThreadDetail.handleUseAiSuggestion → apiClient.approveAiDraft).
    vi.mocked(apiClient.approveAiDraft).mockResolvedValue({
      id: "msg-sent", delivery_state: "SENT", conversation_id: "conv-1",
    } as never);
    fireEvent.click(sendThis);
    await waitFor(() => expect(apiClient.approveAiDraft).toHaveBeenCalled());
  }

  // Switch conversation — the previous transcript must not migrate anywhere.
  fireEvent.click(await screen.findByRole("button", { name: /Bob/ }));
  await waitFor(() => expect(screen.getByTestId("message-input")).toBeInTheDocument());
}

beforeEach(() => {
  vi.clearAllMocks();
  captured.length = 0;
  window.localStorage.clear();
  window.sessionStorage.clear();
  routerState.location = { pathname: "/inbox", search: "", hash: "", state: null };
  vi.mocked(useInboxSSE).mockImplementation(() => undefined as never);
  vi.mocked(apiClient.getConversations).mockResolvedValue(
    list([conv("conv-1", PII.customerName), conv("conv-2", "Bob")]) as never,
  );
  vi.mocked(apiClient.getMessages).mockResolvedValue(
    messagesOf([piiMessage, heldDraft]) as never,
  );
  vi.mocked(apiClient.getResponseTemplates).mockResolvedValue([] as never);
  vi.mocked(apiClient.markConversationRead).mockResolvedValue(conv("conv-1", PII.customerName) as never);
  vi.mocked(apiClient.getSubscription).mockResolvedValue({
    subscription: { plan_code: "PRO", features: { advanced_ai: true } },
  } as never);
});

describe("no customer PII persists in browser storage after inbox flows (G-UX10)", () => {
  it("the scanner itself catches a planted violation (teeth self-check)", () => {
    const seeded = findPiiViolations([
      { store: "local", key: "easymod_lang", value: "en" },
      { store: "session", key: `debug:${PII.psid}`, value: PII.messageBody },
    ]);
    expect(seeded).toContain(`PII in session KEY: debug:${PII.psid}`);
    expect(seeded).toContain(`PII in session VALUE of debug:${PII.psid}`);
    expect(seeded).toContain("non-allowlisted key session:debug:" + PII.psid);
    // A token-shaped value is a violation even under an allowed key.
    // Built at runtime from harmless fragments: repo policy forbids
    // committing JWT-shaped literals even in fixtures (history gitleaks).
    const fakeTokenShape = ["e" + "yJhbGci", "e" + "yJzdWI", "c2ln"].join(".");
    expect(findPiiViolations([{ store: "local", key: "easymod_lang", value: fakeTokenShape }]))
      .toEqual([expect.stringContaining("token-shaped")]);
  });

  it("inbox flows write NOTHING to localStorage beyond the allowlist ceiling", async () => {
    await driveInboxFlows();
    const localWrites = captured.filter((c) => c.store === "local");
    // Audit truth: the inbox component tree performs zero localStorage
    // writes itself; only i18n init may legitimately persist easymod_lang.
    for (const write of localWrites) {
      expect(keyIsAllowed(write.key)).toBe(true);
    }
    // Positive proof the capture works at all: the same spy DOES see writes
    // when a component legitimately persists a flag (easymod:funnel_once:…).
    window.localStorage.setItem("easymod:funnel_once:probe", "1");
    expect(captured.some((c) => c.key === "easymod:funnel_once:probe")).toBe(true);
  });

  it("inbox flows write NOTHING to sessionStorage beyond the allowlist ceiling", async () => {
    await driveInboxFlows();
    const sessionWrites = captured.filter((c) => c.store === "session");
    for (const write of sessionWrites) {
      expect(keyIsAllowed(write.key)).toBe(true);
      // Known-safe values are flags/cursors/uuids — never transcript text.
      expect(write.value.length).toBeLessThanOrEqual(64);
    }
  });

  it("after the full flow, NO storage entry anywhere carries customer name, phone, PSID, or message body", async () => {
    await driveInboxFlows();
    const finalEntries = enumerateBothStores();
    expect(findPiiViolations(finalEntries)).toEqual([]);
    // The flow genuinely ran (assertions above are not vacuous): the PII
    // fixture was rendered on screen and passed through the composer.
    expect(screen.getByTestId("message-input")).toBeInTheDocument();
    expect(vi.mocked(apiClient.getMessages).mock.calls.length).toBeGreaterThan(0);
  });

  it("no JWT-shaped credential string is persisted by the cookie-auth client", async () => {
    await driveInboxFlows();
    const entries = captured.concat(enumerateBothStores());
    const tokenHits = entries.filter((e) => JWT_SHAPE.test(e.value));
    // httpOnly cookie sessions (server-side, src/app/lib/auth.ts writes no
    // storage) must never degenerate into localStorage token caching.
    expect(tokenHits).toEqual([]);
  });
});
