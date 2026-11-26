/**
 * Pure derivation tests: Core Design Test narrative completeness (incl. the
 * A8 exception-authority + locale-numeral rules the retired header hero used
 * to render — the same deriveNarrative output is pinned so the honesty rules
 * survive the header removal), coverage honesty, and en/bn key parity (the
 * app falls back to bn, so a missing en key would silently render Bengali).
 * deriveSignal/derivePrimaryAction were deleted with the page header band
 * (header-removal C2/C3); their DOM pins were flipped to absence in the e2e
 * suites and the record-level badges keep their own suites.
 */
import { describe, expect, it } from "vitest";
import en from "@/i18n/locales/en.json";
import bn from "@/i18n/locales/bn.json";
import {
  buildWorkGroups,
  buildWorkItems,
  deriveNarrative,
  hasAllWorkSources,
  isCaughtUp,
} from "../derive";
import type { DeriveInput, PulseData, Translate } from "../types";

const t: Translate = (key, opts) => {
  if (opts && typeof opts === "object") {
    const vals = Object.values(opts).filter((v) => v != null).join(" ");
    if (vals) return `${key} ${vals}`;
  }
  return key;
};

const basePulse = (overrides: Partial<PulseData> = {}): PulseData => ({
  ordersToday: 0,
  replyTasks: [],
  replyTaskCoverageComplete: true,
  draftOrders: [],
  draftCoverageComplete: true,
  atRiskOrders: [],
  exceptionCoverageComplete: true,
  lastFiveOrders: [],
  cashPosition: null,
  needsReply: { count: 0, scanned: 0, cap: 200, coverageComplete: true, generated_at: "2026-11-15T10:00:00.000Z" },
  pendingPaymentCount: 0,
  readyToDispatchCount: 0,
  predicateVersion: "worklist-v1",
  worklistNeedsActionCount: 0,
  stockExceptions: null,
  chartData: null,
  ...overrides,
});

const input = (phase: DeriveInput["phase"], pulse: PulseData | null, extra: Partial<DeriveInput> = {}): DeriveInput => {
  const workItems = pulse ? buildWorkItems(pulse, t) : [];
  return {
    phase,
    pulse,
    workItems,
    caughtUp: pulse ? isCaughtUp(pulse, workItems) : false,
    hasAllWorkSources: pulse ? hasAllWorkSources(pulse) : false,
    ...extra,
  };
};

const conversation = (id: string) => ({
  id,
  needs_merchant_reply: true,
  needs_merchant_reply_reason: "CUSTOMER_UNANSWERED",
  customer: { name: `Customer ${id}` },
  updated_at: "2026-11-15T10:00:00.000Z",
}) as never;

const draftOrder = (id: string) => ({
  id,
  orderNumber: `D-${id}`,
  customerName: "Draft customer",
  updatedAt: "2026-11-15T09:00:00.000Z",
  createdAt: "2026-11-15T08:00:00.000Z",
}) as never;

// D3 PII-free projection: order number + timestamps only. The worklist row is
// identified by orderNumber (id fallback) — never customer_name/customer_phone.
const atRiskOrder = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  orderNumber: `ORD-${id}`,
  status: "returned",
  tracking_id: `TRK-${id}`,
  updatedAt: "2026-11-15T10:30:00.000Z",
  ...overrides,
}) as never;

// A8 MAJOR-2 — exception-number authority. The header's dominant-signal
// derivation was retired with the band (header-removal C3), but the SAME
// rule still feeds deriveNarrative (and, through it, every count that reaches
// the page): bucket count 12 (the number the Orders nav badge reads) over a
// capped 10-row queue sample must never make the screen show two disagreeing
// numbers, and when that source failed the sample may only ever speak as a
// lower bound. Pinned through the narrative so the honesty survives the flip.
describe("hero exceptions authority in the narrative (A8 MAJOR-2)", () => {
  const cappedPulse = (overrides: Partial<PulseData> = {}) => basePulse({
    worklistNeedsActionCount: 12,
    atRiskOrders: Array.from({ length: 10 }, (_, i) => atRiskOrder(`cap-${i}`)),
    exceptionCoverageComplete: false,
    ...overrides,
  });

  it("hero number == the Orders badge bucket count (12), never the 10-row sample length", () => {
    const pulse = cappedPulse();
    const narrative = deriveNarrative(input("ready", pulse), t);
    expect(narrative.whyHere).toContain(" 12");
    expect(narrative.whyHere).not.toMatch(/ 10(\+| )/);
  });

  it("failed bucket source + capped sample renders the lower bound 10+", () => {
    const pulse = cappedPulse({ worklistNeedsActionCount: null });
    expect(deriveNarrative(input("ready", pulse), t).whyHere).toContain("10+");
  });

  it("an EXHAUSTIVE sample (coverage complete, under cap) falls back without a +", () => {
    const pulse = cappedPulse({
      worklistNeedsActionCount: null,
      atRiskOrders: [atRiskOrder("single")],
      exceptionCoverageComplete: true,
    });
    const narrative = deriveNarrative(input("ready", pulse), t);
    expect(narrative.whyHere).toContain(" 1");
    expect(narrative.whyHere).not.toContain("+");
  });
});

describe("locale numeral formatting (A8 MAJOR-3)", () => {
  const bnDigits = (value: number) => new Intl.NumberFormat("bn-BD").format(value);

  it("every interpolated count flows through formatCount (Bangla digits, never raw Latin)", () => {
    const pulse = basePulse({
      worklistNeedsActionCount: 12,
      atRiskOrders: [atRiskOrder("e1")],
      replyTasks: [conversation("c1")],
    });
    const narrative = deriveNarrative(input("ready", pulse), t, { formatCount: bnDigits });
    expect(narrative.whyHere).toContain(bnDigits(12));
    expect(narrative.whyHere).not.toMatch(/12/);
  });
});

describe("deriveNarrative — Core Design Test, all answers non-empty", () => {
  const cases: Array<[string, DeriveInput]> = [
    ["setup-loading", input("setup-loading", null)],
    ["pulse-loading", input("pulse-loading", null)],
    ["pulse-error", input("pulse-error", null)],
    ["setup", input("setup", null)],
    ["setup-complete", input("setup-complete", null)],
    ["ready-work", input("ready", basePulse({ replyTasks: [conversation("c1")] }))],
    ["ready-caughtUp", input("ready", basePulse())],
    ["ready-partial", input("ready", basePulse({ replyTaskCoverageComplete: false }))],
  ];
  it.each(cases)("%s answers whyHere/whereNext/provenResult", (_name, deriveInput) => {
    const narrative = deriveNarrative(deriveInput, t, { lastSyncLabel: "14:22" });
    for (const value of Object.values(narrative)) {
      expect(typeof value).toBe("string");
      expect(value.length).toBeGreaterThan(0);
    }
  });

  it("uses lastChecked evidence when a sync time exists, timeUnavailable otherwise", () => {
    const withSync = deriveNarrative(input("ready", basePulse()), t, { lastSyncLabel: "14:22" });
    expect(withSync.provenResult).toContain("dashboard.pulse.lastChecked");
    const withoutSync = deriveNarrative(input("ready", basePulse()), t);
    expect(withoutSync.provenResult).toBe("dashboard.pulse.timeUnavailable");
  });
});

describe("coverage honesty", () => {
  it("not caught up when the reply page is incomplete, even with zero items", () => {
    const pulse = basePulse({ replyTaskCoverageComplete: false });
    expect(isCaughtUp(pulse, buildWorkItems(pulse, t))).toBe(false);
    expect(hasAllWorkSources(pulse)).toBe(false);
  });

  it("caught up only when every source is complete and no items remain", () => {
    const pulse = basePulse();
    expect(isCaughtUp(pulse, buildWorkItems(pulse, t))).toBe(true);
  });

  it("groups keep baseline order replies/drafts/exceptions and cap at two rows", () => {
    const pulse = basePulse({
      replyTasks: [conversation("c1"), conversation("c2"), conversation("c3")],
      draftOrders: [draftOrder("d1")],
      atRiskOrders: [atRiskOrder("e1")],
    });
    const groups = buildWorkGroups(buildWorkItems(pulse, t), t);
    expect(groups.map((g) => g.kind)).toEqual(["reply", "draft", "exception"]);
    expect(groups.map((g) => g.to)).toEqual(["/inbox?tab=needs_review", "/orders?bucket=to_confirm", "/orders?bucket=needs_action"]);
    expect(groups[0].visibleItems).toHaveLength(2);
    expect(groups[0].hiddenCount).toBe(1);
  });
});

describe("exception rows are PII-free (D3)", () => {
  it("titles exception items with the human order number, never customer fields", () => {
    const pulse = basePulse({
      atRiskOrders: [atRiskOrder("e1", { customer_name: "LEAKED", customer_phone: "01700000000" })],
    });
    const items = buildWorkItems(pulse, t);
    const exception = items.find((item) => item.kind === "exception");
    expect(exception?.title).toBe("ORD-e1");
    expect(JSON.stringify(exception)).not.toMatch(/LEAKED|01700000000/);
    expect(JSON.stringify(items)).not.toMatch(/customer_name|customer_phone/);
  });

  it("falls back to the id prefix when the order number is absent", () => {
    const pulse = basePulse({ atRiskOrders: [atRiskOrder("abcdef123456", { orderNumber: "" })] });
    const exception = buildWorkItems(pulse, t).find((item) => item.kind === "exception");
    expect(exception?.title).toBe("abcdef12");
  });

  it("sorts exceptions by the projected updatedAt", () => {
    const pulse = basePulse({
      atRiskOrders: [
        atRiskOrder("old", { updatedAt: "2026-11-10T00:00:00.000Z" }),
        atRiskOrder("new", { updatedAt: "2026-11-15T00:00:00.000Z" }),
      ],
    });
    const groups = buildWorkGroups(buildWorkItems(pulse, t), t);
    const exceptions = groups.find((group) => group.kind === "exception");
    expect(exceptions?.items[0].id).toBe("exception-new");
    expect(exceptions?.items[0].sortAt).toBeGreaterThan(0);
  });

  // A8 round-3 (INFO): exception rows rendered the raw server enum
  // ("confirmed") inside an otherwise-Bangla UI. Known statuses now localize
  // through the existing dashboard.pulse.status.* vocabulary (the one the
  // RecentOrders pills use); unknown values pass through raw — the row never
  // hides or invents a state the projection carries.
  it("localizes known status enums through dashboard.pulse.status.*", () => {
    const pulse = basePulse({
      atRiskOrders: [atRiskOrder("e1", { status: "confirmed", tracking_id: null })],
    });
    const exception = buildWorkItems(pulse, t).find((item) => item.kind === "exception");
    expect(exception?.detail).toBe("dashboard.pulse.status.confirmed");
    expect(exception?.detail).not.toBe("confirmed");
  });

  it("keeps tracking id joined after the localized status", () => {
    const pulse = basePulse({ atRiskOrders: [atRiskOrder("e1", { status: "returned" })] });
    const exception = buildWorkItems(pulse, t).find((item) => item.kind === "exception");
    expect(exception?.detail).toBe("dashboard.pulse.status.returned · TRK-e1");
  });

  it("passes an unknown server status through raw, unchanged", () => {
    const pulse = basePulse({
      atRiskOrders: [atRiskOrder("e2", { status: "weird_state", tracking_id: "TRK-9" })],
    });
    const exception = buildWorkItems(pulse, t).find((item) => item.kind === "exception");
    expect(exception?.detail).toBe("weird_state · TRK-9");
  });
});

describe("en/bn parity for every redesign key", () => {
  const get = (obj: unknown, path: string): unknown =>
    path.split(".").reduce<unknown>((acc, part) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[part] : undefined), obj);

  const keys = [
    // Only the three signal LABEL keys with live in-content consumers survive
    // the W5 sweep: ConnectionHealth (pending) and the FirstTimeSetup task
    // rows (attention/resolved/pending) still consume them (00 inventory C3).
    // healthy/review/blocked died with deriveSignal, and the signal.reason.*
    // and pulse.primary.* groups die with deriveSignal/derivePrimaryAction.
    ...["attention", "resolved", "pending"].map((k) => `dashboard.pulse.signal.${k}`),
    ...["loading", "error", "setup", "setupComplete", "work", "caughtUp", "partial"].map((k) => `dashboard.pulse.whyHere.${k}`),
    ...["loading", "error", "setup", "setupComplete", "work", "caughtUp", "partial"].map((k) => `dashboard.pulse.whereNext.${k}`),
    "dashboard.pulse.staleWarning",
    "dashboard.pulse.queueChips.note",
    "dashboard.pulse.queueChips.unavailable",
    // A8 round-3 (INFO): the exception-row status vocabulary must exist in
    // both locales — derive renders known server enums through these keys.
    ...["confirmed", "cancelled", "processing", "draft", "delivered", "returned", "finalized", "completed", "pending", "failed"].map(
      (k) => `dashboard.pulse.status.${k}`,
    ),
    // Phase-1 D4–D8 dashboard surfaces (doc 04 §6 inventory).
    ...["charges", "chargeNote", "chargesTooltip", "activitySystem", "viewAll", "dayCount"].map(
      (k) => `dashboard.pulse.commerceSignals.${k}`,
    ),
    ...["title", "stockExceptions", "outOfStock", "lowStock", "deliveryExceptions", "cashInTransit", "cashAtRisk", "unavailable", "viewProducts", "viewOrders"].map(
      (k) => `dashboard.businessHealth.${k}`,
    ),
    ...["title", "metaRow", "courierRow", "connectedVerified", "connectedUnverified", "reconnectRequired", "disconnected", "unavailable", "ready", "connectedNotActive", "setupIncomplete", "notSetUp", "reconnect", "reconnectFailed", "missingCount"].map(
      (k) => `dashboard.connections.${k}`,
    ),
    ...["overview", "actionCounts", "drafts", "replies", "recentOrders", "worklistCounts", "stockExceptions"].map(
      (k) => `dashboard.pulse.sourceNames.${k}`,
    ),
    "dashboard.pulse.evidence.title",
    "dashboard.pulse.evidence.coverageComplete",
    "dashboard.pulse.evidence.auditLog",
    "dashboard.pulse.evidence.nextSteps",
    // context.breadcrumb stays (PageHeader v2 still labels its optional breadcrumb
    // nav); context.workspace died with the header breadcrumbs (C1).
    "dashboard.pulse.context.breadcrumb",
    "dashboard.pulse.overview.trendSummary",
    // P04: "verifiedAt" claimed the computation timestamp was a verification —
    // the honest label is statusCheckedAt, and the operational ladder states
    // must exist in BOTH locales so no state renders untranslated.
    "dashboard.setup.statusCheckedAt",
    "dashboard.setup.warningsTitle",
    ...["configured", "waiting_for_test", "action_required", "verified_operational"].flatMap((state) => [
      `dashboard.setup.states.${state}.title`,
      `dashboard.setup.states.${state}.description`,
    ]),
    ...["title", "webhookVerifiedAt", "webhookStale", "webhookNever", "providerAccepted", "providerNone", "deliveryFailures", "none"].map(
      (k) => `dashboard.setup.evidence.${k}`,
    ),
    ...["WEBHOOK_NOT_VERIFIED", "WEBHOOK_VERIFICATION_STALE", "OPERATIONAL_TEST_FAILED", "LOW_PRODUCT_COUNT", "AI_AUTO_ENABLED"].map(
      (code) => `dashboard.setup.warnings.${code}`,
    ),
  ];

  it.each(keys)("%s exists in both locales", (key) => {
    expect(typeof get(en, key)).toBe("string");
    expect(typeof get(bn, key)).toBe("string");
  });
});
