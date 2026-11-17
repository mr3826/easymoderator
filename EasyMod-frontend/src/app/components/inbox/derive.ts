/**
 * Pure inbox signal / primary-action / narrative derivation (guardrails §4/§8).
 * No DOM, no fetch: every input comes from state UnifiedInbox already owns.
 * Page-scoped honesty: counts describe the fetched page, never the whole shop
 * (the list API has no server-side needs-reply filter). SSE connectivity and
 * AI mode never change the dominant signal — the offline banner and mode pill
 * carry those facts separately (dashboard "stale never changes signal" rule).
 */
import type { Signal } from "../dashboard/types";

export type InboxPhase = "loading" | "error" | "ready" | "empty";

export interface InboxDeriveInput {
  phase: InboxPhase;
  emergencyStop: boolean;
  needsReviewCount: number;
  draftCount: number;
  unreadTotal: number;
  conversationCount: number;
  nextReplyId: string | null;
  nextDraftId: string | null;
  firstUnreadId: string | null;
}

export type InboxPrimaryIntent = "retry" | "loading" | "open-conversation" | "refresh";

export interface InboxPrimary {
  label: string;
  intent: InboxPrimaryIntent;
  conversationId?: string;
  disabled?: boolean;
}

export interface InboxNarrative {
  whyHere: string;
  whatNow: string;
  whereNext: string;
  provenResult: string;
}

export type InboxTranslate = (key: string, opts?: Record<string, unknown>) => string;

/** Literal keys only — the i18n coverage test AST-scans t() call sites. */
export function deriveInboxSignal(input: InboxDeriveInput, t: InboxTranslate): Signal {
  if (input.emergencyStop) {
    return {
      kind: "blocked",
      label: t("inbox.signal.blocked"),
      reason: t("inbox.signal.reason.emergency"),
    };
  }
  if (input.phase === "error") {
    return {
      kind: "blocked",
      label: t("inbox.signal.blocked"),
      reason: t("inbox.signal.reason.error"),
    };
  }
  if (input.phase === "loading") {
    return { kind: "pending", label: t("inbox.signal.pending") };
  }
  if (input.needsReviewCount > 0) {
    return {
      kind: "review",
      label: t("inbox.signal.review"),
      reason: t("inbox.signal.reason.review", { count: input.needsReviewCount }),
    };
  }
  if (input.draftCount > 0) {
    return {
      kind: "review",
      label: t("inbox.signal.drafts"),
      reason: t("inbox.signal.reason.drafts", { count: input.draftCount }),
    };
  }
  if (input.unreadTotal > 0) {
    return {
      kind: "attention",
      label: t("inbox.signal.unread"),
      reason: t("inbox.signal.reason.unread", { count: input.unreadTotal }),
    };
  }
  if (input.phase === "empty") {
    return {
      kind: "pending",
      label: t("inbox.signal.empty"),
      reason: t("inbox.signal.reason.empty"),
    };
  }
  return {
    kind: "healthy",
    label: t("inbox.signal.healthy"),
    reason: t("inbox.signal.reason.caughtUp"),
  };
}

/** The header primary never mutates server state; mutations stay on the
 *  pinned per-thread buttons (Send / Send this / Take over / Resolve). */
export function deriveInboxPrimaryAction(input: InboxDeriveInput, t: InboxTranslate): InboxPrimary {
  if (input.phase === "error") {
    // Distinct from the list's own "Try again" retry button (singular pins).
    return { label: t("inbox.primary.retry"), intent: "retry" };
  }
  if (input.phase === "loading") {
    return { label: t("inbox.primary.loading"), intent: "loading", disabled: true };
  }
  if (input.nextReplyId) {
    return {
      label: t("inbox.primary.openNextReply"),
      intent: "open-conversation",
      conversationId: input.nextReplyId,
    };
  }
  if (input.nextDraftId) {
    return {
      label: t("inbox.primary.openNextDraft"),
      intent: "open-conversation",
      conversationId: input.nextDraftId,
    };
  }
  if (input.firstUnreadId) {
    return {
      label: t("inbox.primary.openFirstUnread"),
      intent: "open-conversation",
      conversationId: input.firstUnreadId,
    };
  }
  return { label: t("inbox.primary.refresh"), intent: "refresh" };
}

export function deriveInboxNarrative(
  input: InboxDeriveInput,
  t: InboxTranslate,
  opts: { lastSyncLabel?: string } = {},
): InboxNarrative {
  const primary = deriveInboxPrimaryAction(input, t);
  let whyHere: string;
  let whereNext: string;
  if (input.phase === "loading") {
    whyHere = t("inbox.whyHere.loading");
    whereNext = t("inbox.whereNext.work");
  } else if (input.phase === "error") {
    whyHere = t("inbox.whyHere.error");
    whereNext = t("inbox.whereNext.error");
  } else if (input.emergencyStop) {
    whyHere = t("inbox.signal.reason.emergency");
    whereNext = t("inbox.whereNext.caughtUp");
  } else if (input.needsReviewCount > 0) {
    whyHere = t("inbox.whyHere.review");
    whereNext = t("inbox.whereNext.work");
  } else if (input.draftCount > 0) {
    whyHere = t("inbox.whyHere.drafts");
    whereNext = t("inbox.whereNext.work");
  } else if (input.unreadTotal > 0) {
    whyHere = t("inbox.whyHere.unread");
    whereNext = t("inbox.whereNext.work");
  } else if (input.phase === "empty") {
    whyHere = t("inbox.whyHere.empty");
    whereNext = t("inbox.whereNext.empty");
  } else {
    whyHere = t("inbox.whyHere.caughtUp");
    whereNext = t("inbox.whereNext.caughtUp");
  }
  return {
    whyHere,
    whatNow: primary.label,
    whereNext,
    provenResult: opts.lastSyncLabel
      ? t("inbox.evidence.lastSync", { time: opts.lastSyncLabel })
      : t("inbox.evidence.noSync"),
  };
}
