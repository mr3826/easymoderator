/**
 * Pure inbox narrative derivation (guardrails §4/§8). No DOM, no fetch: every
 * input comes from state UnifiedInbox already owns. Page-scoped honesty:
 * counts describe the fetched page, never the whole shop (the list API has no
 * server-side needs-reply filter). SSE connectivity and AI mode never change
 * the narrative — the offline banner and mode pill carry those facts
 * separately. The page-level signal and header primary action retired with
 * the band (docs/header-removal/03_CONTRACT.md C1/C3); the emergency/review
 * facts they carried live on as the in-content offline and emergency-stop
 * banners.
 */
export type InboxPhase = "loading" | "error" | "ready" | "empty";

export interface InboxDeriveInput {
  phase: InboxPhase;
  emergencyStop: boolean;
  needsReviewCount: number;
  draftCount: number;
  unreadTotal: number;
}

export interface InboxNarrative {
  whyHere: string;
  whereNext: string;
  provenResult: string;
}

export type InboxTranslate = (key: string, opts?: Record<string, unknown>) => string;

/** Literal keys only — the i18n coverage test AST-scans t() call sites. */
export function deriveInboxNarrative(
  input: InboxDeriveInput,
  t: InboxTranslate,
  opts: { lastSyncLabel?: string } = {},
): InboxNarrative {
  let whyHere: string;
  let whereNext: string;
  if (input.phase === "loading") {
    whyHere = t("inbox.whyHere.loading");
    whereNext = t("inbox.whereNext.work");
  } else if (input.phase === "error") {
    whyHere = t("inbox.whyHere.error");
    whereNext = t("inbox.whereNext.error");
  } else if (input.emergencyStop) {
    whyHere = t("inbox.emergencyBanner");
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
    whereNext,
    provenResult: opts.lastSyncLabel
      ? t("inbox.evidence.lastSync", { time: opts.lastSyncLabel })
      : t("inbox.evidence.noSync"),
  };
}
