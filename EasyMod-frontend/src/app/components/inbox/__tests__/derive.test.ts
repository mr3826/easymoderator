/**
 * Inbox narrative derivation contract (guardrails §4/§8). Pure module:
 * page-scoped honesty, non-empty narrative answers in every state, en/bn key
 * parity. The page-level signal and header primary action retired with the
 * band (docs/header-removal/03_CONTRACT.md C3); this narrative survives
 * because the evidence rail and the empty state consume it (C3 keep-list).
 */
import { describe, expect, it } from "vitest";
import en from "@/i18n/locales/en.json";
import bn from "@/i18n/locales/bn.json";
import {
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
};

describe("deriveInboxNarrative", () => {
  it("answers the content-side questions in every state", () => {
    const states: InboxDeriveInput[] = [
      base,
      { ...base, phase: "loading" },
      { ...base, phase: "error" },
      { ...base, phase: "empty" },
      { ...base, emergencyStop: true },
      { ...base, needsReviewCount: 2 },
      { ...base, draftCount: 1 },
      { ...base, unreadTotal: 3 },
    ];
    for (const state of states) {
      for (const opts of [{}, { lastSyncLabel: "2 minutes ago" }]) {
        const narrative = deriveInboxNarrative(state, t, opts);
        expect(narrative.whyHere.length).toBeGreaterThan(0);
        expect(narrative.whereNext.length).toBeGreaterThan(0);
        expect(narrative.provenResult.length).toBeGreaterThan(0);
      }
    }
  });
  it("guidance is page-scoped, never shop-wide claims", () => {
    const narrative = deriveInboxNarrative({ ...base, needsReviewCount: 1 }, t);
    expect(narrative.whyHere).toContain("on this page");
  });
  it("emergency guidance mirrors the in-content emergency-stop banner", () => {
    const narrative = deriveInboxNarrative({ ...base, emergencyStop: true, needsReviewCount: 4 }, t);
    expect(narrative.whyHere).toBe(en.inbox.emergencyBanner);
    expect(bn.inbox.emergencyBanner).toBeTruthy();
  });
  it("proven result reports sync evidence or its absence", () => {
    expect(deriveInboxNarrative(base, t).provenResult).toBe("Not synced yet");
    expect(deriveInboxNarrative(base, t, { lastSyncLabel: "now" }).provenResult).toContain("now");
  });
});

describe("locale parity for inbox derivation keys", () => {
  const keys = [
    "inbox.whyHere.loading", "inbox.whyHere.error", "inbox.whyHere.review", "inbox.whyHere.drafts",
    "inbox.whyHere.unread", "inbox.whyHere.caughtUp", "inbox.whyHere.empty",
    "inbox.whereNext.work", "inbox.whereNext.caughtUp", "inbox.whereNext.error", "inbox.whereNext.empty",
    "inbox.emergencyBanner",
    "inbox.evidence.replyTaskSentence",
    "inbox.evidence.title", "inbox.evidence.conversation", "inbox.evidence.customer", "inbox.evidence.source",
    "inbox.evidence.replyTask", "inbox.evidence.lastActivity", "inbox.evidence.delivery",
    "inbox.evidence.deliveryConfirmed", "inbox.evidence.deliveryPending", "inbox.evidence.deliveryFailed",
    "inbox.evidence.deliveryNone", "inbox.evidence.syncSse", "inbox.evidence.syncOffline",
    "inbox.evidence.lastSync", "inbox.evidence.noSync", "inbox.evidence.grounding", "inbox.evidence.customerUnlinked",
    "inbox.actions.partial", "inbox.empty.connectChannel",
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
