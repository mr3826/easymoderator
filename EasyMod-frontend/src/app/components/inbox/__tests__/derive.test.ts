/**
 * Inbox signal/primary/narrative derivation contract (guardrails §4/§8).
 * Pure module: precedence, page-scoped honesty, never-mutation primary,
 * four non-empty narrative answers in every state, en/bn key parity.
 */
import { describe, expect, it } from "vitest";
import en from "@/i18n/locales/en.json";
import bn from "@/i18n/locales/bn.json";
import {
  deriveInboxSignal,
  deriveInboxPrimaryAction,
  deriveInboxNarrative,
  type InboxDeriveInput,
} from "../derive";

const t = (key: string, opts?: Record<string, unknown>) => {
  const value = key.split(".").reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], en);
  if (typeof value !== "string") throw new Error(`missing en key ${key}`);
  return value.replace(/\{\{(\w+)\}\}/g, (_m, name) => String(opts?.[name] ?? ""));
};

const base: InboxDeriveInput = {
  phase: "ready",
  emergencyStop: false,
  needsReviewCount: 0,
  draftCount: 0,
  unreadTotal: 0,
  conversationCount: 3,
  nextReplyId: null,
  nextDraftId: null,
  firstUnreadId: null,
};

describe("deriveInboxSignal precedence", () => {
  it("emergency stop outranks everything", () => {
    const signal = deriveInboxSignal({ ...base, emergencyStop: true, needsReviewCount: 4, phase: "error" }, t);
    expect(signal.kind).toBe("blocked");
    expect(signal.label).toBe("AI stopped");
  });
  it("list error is blocked", () => {
    expect(deriveInboxSignal({ ...base, phase: "error", needsReviewCount: 2 }, t).kind).toBe("blocked");
  });
  it("loading is pending", () => {
    expect(deriveInboxSignal({ ...base, phase: "loading", needsReviewCount: 2 }, t).kind).toBe("pending");
  });
  it("needs-review outranks drafts and unread", () => {
    const signal = deriveInboxSignal({ ...base, needsReviewCount: 2, draftCount: 1, unreadTotal: 5 }, t);
    expect(signal.kind).toBe("review");
    expect(signal.label).toBe("Needs review");
    expect(signal.reason).toContain("2");
  });
  it("drafts outrank unread", () => {
    const signal = deriveInboxSignal({ ...base, draftCount: 1, unreadTotal: 5 }, t);
    expect(signal.label).toBe("AI drafts waiting");
  });
  it("unread alone is attention", () => {
    expect(deriveInboxSignal({ ...base, unreadTotal: 5 }, t).kind).toBe("attention");
  });
  it("empty shop is pending with a why-empty reason", () => {
    const signal = deriveInboxSignal({ ...base, phase: "empty", conversationCount: 0 }, t);
    expect(signal.kind).toBe("pending");
    expect(signal.reason).toBeTruthy();
  });
  it("caught up is healthy", () => {
    expect(deriveInboxSignal(base, t).kind).toBe("healthy");
  });
  it("reasons are page-scoped, never shop-wide claims", () => {
    const signal = deriveInboxSignal({ ...base, needsReviewCount: 1 }, t);
    expect(signal.reason).toContain("on this page");
  });
});

describe("deriveInboxPrimaryAction", () => {
  it("error offers retry", () => {
    expect(deriveInboxPrimaryAction({ ...base, phase: "error" }, t)).toMatchObject({ intent: "retry", label: "Retry loading" });
  });
  it("loading is disabled", () => {
    expect(deriveInboxPrimaryAction({ ...base, phase: "loading" }, t).disabled).toBe(true);
  });
  it("targets the first reply task, then draft, then unread", () => {
    expect(deriveInboxPrimaryAction({ ...base, nextReplyId: "c1", nextDraftId: "c2", firstUnreadId: "c3" }, t).conversationId).toBe("c1");
    expect(deriveInboxPrimaryAction({ ...base, nextDraftId: "c2", firstUnreadId: "c3" }, t).conversationId).toBe("c2");
    expect(deriveInboxPrimaryAction({ ...base, firstUnreadId: "c3" }, t).conversationId).toBe("c3");
  });
  it("caught up refreshes without mutating", () => {
    const primary = deriveInboxPrimaryAction(base, t);
    expect(primary.intent).toBe("refresh");
    expect(primary.label).toBe("Refresh inbox");
  });
  it("never returns a mutation intent", () => {
    const states: InboxDeriveInput[] = [
      base,
      { ...base, phase: "error" },
      { ...base, phase: "loading" },
      { ...base, phase: "empty", conversationCount: 0 },
      { ...base, emergencyStop: true },
      { ...base, nextReplyId: "c1" },
    ];
    for (const state of states) {
      expect(["retry", "loading", "open-conversation", "refresh"]).toContain(deriveInboxPrimaryAction(state, t).intent);
    }
  });
});

describe("deriveInboxNarrative", () => {
  it("answers all four Core Design Test questions in every state", () => {
    const states: InboxDeriveInput[] = [
      base,
      { ...base, phase: "loading" },
      { ...base, phase: "error" },
      { ...base, phase: "empty", conversationCount: 0 },
      { ...base, emergencyStop: true },
      { ...base, needsReviewCount: 2, nextReplyId: "c1" },
      { ...base, draftCount: 1, nextDraftId: "c2" },
      { ...base, unreadTotal: 3, firstUnreadId: "c3" },
    ];
    for (const state of states) {
      for (const opts of [{}, { lastSyncLabel: "2 minutes ago" }]) {
        const narrative = deriveInboxNarrative(state, t, opts);
        expect(narrative.whyHere.length).toBeGreaterThan(0);
        expect(narrative.whatNow.length).toBeGreaterThan(0);
        expect(narrative.whereNext.length).toBeGreaterThan(0);
        expect(narrative.provenResult.length).toBeGreaterThan(0);
      }
    }
  });
  it("proven result reports sync evidence or its absence", () => {
    expect(deriveInboxNarrative(base, t).provenResult).toBe("Not synced yet");
    expect(deriveInboxNarrative(base, t, { lastSyncLabel: "now" }).provenResult).toContain("now");
  });
});

describe("locale parity for inbox derivation keys", () => {
  const keys = [
    "inbox.signal.blocked", "inbox.signal.pending", "inbox.signal.review", "inbox.signal.drafts",
    "inbox.signal.unread", "inbox.signal.healthy", "inbox.signal.empty",
    "inbox.signal.reason.emergency", "inbox.signal.reason.review", "inbox.signal.reason.drafts",
    "inbox.signal.reason.unread", "inbox.signal.reason.caughtUp", "inbox.signal.reason.empty", "inbox.signal.reason.error",
    "inbox.whyHere.loading", "inbox.whyHere.error", "inbox.whyHere.review", "inbox.whyHere.drafts",
    "inbox.whyHere.unread", "inbox.whyHere.caughtUp", "inbox.whyHere.empty",
    "inbox.whereNext.work", "inbox.whereNext.caughtUp", "inbox.whereNext.error", "inbox.whereNext.empty",
    "inbox.primary.retry", "inbox.evidence.replyTaskSentence",
    "inbox.primary.openNextReply", "inbox.primary.openNextDraft", "inbox.primary.openFirstUnread",
    "inbox.primary.refresh", "inbox.primary.loading",
    "inbox.evidence.title", "inbox.evidence.conversation", "inbox.evidence.customer", "inbox.evidence.source",
    "inbox.evidence.replyTask", "inbox.evidence.lastActivity", "inbox.evidence.delivery",
    "inbox.evidence.deliveryConfirmed", "inbox.evidence.deliveryPending", "inbox.evidence.deliveryFailed",
    "inbox.evidence.deliveryNone", "inbox.evidence.syncSse", "inbox.evidence.syncOffline",
    "inbox.evidence.lastSync", "inbox.evidence.noSync", "inbox.evidence.grounding", "inbox.evidence.customerUnlinked",
    "inbox.actions.partial", "inbox.empty.connectChannel", "inbox.breadcrumb.workspace",
    "inbox.composer.quickReplies", "inbox.composer.manageQuickReplies", "inbox.composer.searchQuickReplies",
    "inbox.composer.quickReplyName", "inbox.composer.quickReplyMessage", "inbox.composer.loadingQuickReplies",
    "inbox.composer.closeQuickReplies", "inbox.composer.attachFile", "inbox.composer.noSavedQuickReplies",
  ];
  const lookup = (bundle: unknown, key: string) =>
    key.split(".").reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], bundle);
  it.each(keys)("%s exists in en and bn", (key) => {
    expect(typeof lookup(en, key)).toBe("string");
    expect(typeof lookup(bn, key)).toBe("string");
  });
});
