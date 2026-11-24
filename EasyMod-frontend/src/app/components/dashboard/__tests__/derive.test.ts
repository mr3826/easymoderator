/**
 * Pure derivation tests: signal precedence, single primary action, Core Design
 * Test narrative completeness, coverage honesty, and en/bn key parity (the
 * app falls back to bn, so a missing en key would silently render Bengali).
 */
import { describe, expect, it } from "vitest";
import en from "@/i18n/locales/en.json";
import bn from "@/i18n/locales/bn.json";
import {
  buildWorkGroups,
  buildWorkItems,
  deriveNarrative,
  derivePrimaryAction,
  deriveSignal,
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

describe("deriveSignal — one dominant signal, first match wins", () => {
  it.each([
    ["setup-loading", "pending"],
    ["pulse-loading", "pending"],
    ["pulse-error", "blocked"],
    ["setup", "attention"],
    ["setup-complete", "resolved"],
  ] as const)("phase %s → %s", (phase, kind) => {
    expect(deriveSignal(input(phase, null), t).kind).toBe(kind);
  });

  it("ready with exceptions → attention (severity over replies/drafts)", () => {
    const pulse = basePulse({
      atRiskOrders: [atRiskOrder("1")],
      replyTasks: [conversation("c1")],
      draftOrders: [draftOrder("d1")],
    });
    expect(deriveSignal(input("ready", pulse), t).kind).toBe("attention");
  });

  it("ready with replies only → review", () => {
    const pulse = basePulse({ replyTasks: [conversation("c1")] });
    expect(deriveSignal(input("ready", pulse), t).kind).toBe("review");
  });

  it("ready with drafts only → review", () => {
    const pulse = basePulse({ draftOrders: [draftOrder("d1")] });
    expect(deriveSignal(input("ready", pulse), t).kind).toBe("review");
  });

  it("ready, verified zero work → healthy", () => {
    expect(deriveSignal(input("ready", basePulse()), t).kind).toBe("healthy");
  });

  it("ready, partial coverage and zero visible items → pending, never healthy", () => {
    const pulse = basePulse({ replyTaskCoverageComplete: false });
    expect(deriveSignal(input("ready", pulse), t).kind).toBe("pending");
  });
});

describe("derivePrimaryAction — exactly one, severity exception → reply → draft", () => {
  it("error → retry", () => {
    expect(derivePrimaryAction(input("pulse-error", null), t).label).toBe("dashboard.pulse.retry");
  });

  it("exception wins over reply and draft", () => {
    const pulse = basePulse({
      atRiskOrders: [atRiskOrder("e1")],
      replyTasks: [conversation("c1")],
      draftOrders: [draftOrder("d1")],
    });
    const action = derivePrimaryAction(input("ready", pulse), t);
    expect(action.label).toBe("dashboard.pulse.primary.exception");
    expect(action.to).toBe("/orders?orderId=e1");
  });

  it("reply wins over draft", () => {
    const pulse = basePulse({ replyTasks: [conversation("c1")], draftOrders: [draftOrder("d1")] });
    const action = derivePrimaryAction(input("ready", pulse), t);
    expect(action.label).toBe("dashboard.pulse.primary.reply");
    expect(action.to).toBe("/inbox?conversation=c1");
  });

  it("draft only", () => {
    const pulse = basePulse({ draftOrders: [draftOrder("d1")] });
    const action = derivePrimaryAction(input("ready", pulse), t);
    expect(action.label).toBe("dashboard.pulse.primary.draft");
    expect(action.to).toBe("/orders?orderId=d1");
  });

  it("caught up → open inbox", () => {
    const action = derivePrimaryAction(input("ready", basePulse()), t);
    expect(action.label).toBe("dashboard.pulse.attention.openInbox");
    expect(action.to).toBe("/inbox");
  });
});

describe("deriveNarrative — Core Design Test, all four answers non-empty", () => {
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
  it.each(cases)("%s answers whyHere/whatNow/whereNext/provenResult", (_name, deriveInput) => {
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
});

describe("en/bn parity for every redesign key", () => {
  const get = (obj: unknown, path: string): unknown =>
    path.split(".").reduce<unknown>((acc, part) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[part] : undefined), obj);

  const keys = [
    ...["healthy", "attention", "review", "blocked", "resolved", "pending"].map((k) => `dashboard.pulse.signal.${k}`),
    ...["exceptions", "work", "partial"].map((k) => `dashboard.pulse.signal.reason.${k}`),
    ...["reply", "draft", "exception"].map((k) => `dashboard.pulse.primary.${k}`),
    ...["loading", "error", "setup", "setupComplete", "work", "caughtUp", "partial"].map((k) => `dashboard.pulse.whyHere.${k}`),
    ...["loading", "error", "setup", "setupComplete", "work", "caughtUp", "partial"].map((k) => `dashboard.pulse.whereNext.${k}`),
    "dashboard.pulse.staleWarning",
    "dashboard.pulse.queueChips.note",
    "dashboard.pulse.queueChips.unavailable",
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
    "dashboard.pulse.context.breadcrumb",
    "dashboard.pulse.context.workspace",
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
