/**
 * Pure derivation for the dashboard redesign: work items/groups (baseline
 * logic, unchanged), the single dominant signal (§8), the single primary
 * action (§11), and the Core Design Test narrative (§4). No DOM, no fetch —
 * every function is unit-testable with a key-returning `t`.
 */
import { AlertTriangle, FileText, MessageCircle } from "lucide-react";
import type {
  Action,
  DashboardNarrative,
  DeriveInput,
  PulseData,
  Signal,
  SignalKind,
  Translate,
  WorkGroup,
  WorkItem,
  WorkKind,
} from "./types";

export const WORK_ITEMS_PER_GROUP = 2;

export const validDate = (value: string | null | undefined) => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
};

export const orderLabel = (order: { orderNumber?: string | null; id: string }) =>
  order.orderNumber || order.id.slice(0, 8);

export function buildWorkItems(pulse: PulseData, t: Translate): WorkItem[] {
  const workItems: WorkItem[] = [];
  for (const conversation of pulse.replyTasks ?? []) {
    const reason = conversation.needs_merchant_reply_reason;
    const detail = reason === "CUSTOMER_UNANSWERED"
      ? t("dashboard.pulse.replyTasks.reasons.CUSTOMER_UNANSWERED")
      : reason === "PROVIDER_SEND_FAILED"
        ? t("dashboard.pulse.replyTasks.reasons.PROVIDER_SEND_FAILED")
        : reason === "HITL_REQUIRED"
          ? t("dashboard.pulse.replyTasks.reasons.HITL_REQUIRED")
          : reason === "ORDER_CONFIDENCE_HOLD"
            ? t("dashboard.pulse.replyTasks.reasons.ORDER_CONFIDENCE_HOLD")
            : t("dashboard.pulse.replyTasks.reasons.default");
    workItems.push({
      id: `reply-${conversation.id}`,
      kind: "reply",
      title: conversation.customer?.name || t("inbox.unknownCustomer"),
      detail,
      to: `/inbox?conversation=${encodeURIComponent(conversation.id)}`,
      sortAt: validDate(conversation.updated_at)?.getTime() ?? 0,
      icon: MessageCircle,
      action: t("dashboard.pulse.replyTasks.open"),
    });
  }
  for (const order of pulse.draftOrders ?? []) {
    workItems.push({
      id: `draft-${order.id}`,
      kind: "draft",
      title: orderLabel(order),
      detail: t("dashboard.pulse.work.draftDetail", { customer: order.customerName || t("inbox.unknownCustomer") }),
      to: `/orders?orderId=${encodeURIComponent(order.id)}`,
      sortAt: validDate(order.updatedAt)?.getTime() ?? validDate(order.createdAt)?.getTime() ?? 0,
      icon: FileText,
      action: t("dashboard.pulse.work.reviewDraft"),
    });
  }
  for (const order of pulse.atRiskOrders ?? []) {
    const status = String(order.status || "").toLowerCase();
    workItems.push({
      id: `exception-${order.id}`,
      kind: "exception",
      // D3: PII-free projection — the row is identified by the human order
      // number (id fallback), never by customer_name/customer_phone.
      title: orderLabel(order),
      detail: [status, order.tracking_id].filter(Boolean).join(" · ") || t("dashboard.pulse.status.unknown"),
      to: `/orders?orderId=${encodeURIComponent(order.id)}`,
      sortAt: validDate(order.updatedAt)?.getTime() ?? 0,
      icon: AlertTriangle,
      action: t("dashboard.pulse.attention.reviewOrder"),
    });
  }
  return workItems;
}

export function buildWorkGroups(workItems: WorkItem[], t: Translate): WorkGroup[] {
  return ([
    {
      kind: "reply" as const,
      title: t("dashboard.pulse.work.groups.replies"),
      to: "/inbox?tab=needs_review",
      action: t("dashboard.pulse.replyTasks.viewFullInbox"),
    },
    {
      kind: "draft" as const,
      title: t("dashboard.pulse.work.groups.drafts"),
      to: "/orders?bucket=to_confirm",
      action: t("dashboard.pulse.work.openOrders"),
    },
    {
      kind: "exception" as const,
      title: t("dashboard.pulse.work.groups.exceptions"),
      to: "/orders?bucket=needs_action",
      action: t("dashboard.pulse.work.openOrders"),
    },
  ]).map((group) => {
    const items = workItems
      .filter((item) => item.kind === group.kind)
      .sort((left, right) => right.sortAt - left.sortAt);
    return {
      ...group,
      items,
      visibleItems: items.slice(0, WORK_ITEMS_PER_GROUP),
      hiddenCount: Math.max(0, items.length - WORK_ITEMS_PER_GROUP),
    };
  }).filter((group) => group.items.length > 0);
}

export function hasAllWorkSources(pulse: PulseData): boolean {
  return pulse.replyTasks !== null
    && pulse.replyTaskCoverageComplete
    && pulse.draftOrders !== null
    && pulse.draftCoverageComplete
    && pulse.atRiskOrders !== null
    && pulse.exceptionCoverageComplete;
}

export function isCaughtUp(pulse: PulseData, workItems: WorkItem[]): boolean {
  return hasAllWorkSources(pulse) && workItems.length === 0;
}

const signalLabel = (kind: SignalKind, t: Translate) => t(`dashboard.pulse.signal.${kind}`);

export interface DeriveCountFormat {
  /**
   * A8 MAJOR-3: every interpolated count reaches the locale string through
   * this formatter (the proven QueueSignalChips pattern — Dashboard.tsx passes
   * an Intl.NumberFormat bound to the active locale, so bn renders Bangla
   * numerals instead of raw Latin digits). Default keeps raw numbers for the
   * pure unit pins.
   */
  formatCount?: (value: number) => string;
}

/**
 * A8 MAJOR-2 (hero-number authority): the "delivery exceptions" figure must
 * come from the SAME exhaustive bucket count the Orders nav badge uses
 * (`worklistNeedsActionCount` = GET /api/order/counts `needs_action`) — never
 * from the capped 10-row sample length, which understated the true count
 * while claiming verification. The sample is a projection: when the bucket
 * source failed (null) the sample length is the FALLBACK, and an incomplete
 * exception scan is then rendered as an explicit lower bound ("10+"), never
 * as exhaustive.
 */
export function deliveryExceptionAuthority(pulse: PulseData | null): { count: number; lowerBound: boolean } {
  const exact = pulse?.worklistNeedsActionCount ?? null;
  if (exact !== null && Number.isFinite(exact) && exact >= 0) return { count: exact, lowerBound: false };
  const sample = pulse?.atRiskOrders?.length ?? 0;
  return { count: sample, lowerBound: pulse?.exceptionCoverageComplete === false };
}

const exceptionDisplay = (
  pulse: PulseData | null,
  formatCount: (value: number) => string,
): { count: number; display: string } => {
  const authority = deliveryExceptionAuthority(pulse);
  return {
    count: authority.count,
    display: `${formatCount(authority.count)}${authority.lowerBound ? '+' : ''}`,
  };
};

/** One dominant signal per screen (§8). First match wins; stale never changes it. */
export function deriveSignal(input: DeriveInput, t: Translate, options: DeriveCountFormat = {}): Signal {
  const formatCount = options.formatCount ?? ((value: number) => String(value));
  switch (input.phase) {
    case "setup-loading":
    case "pulse-loading":
      return { kind: "pending", label: signalLabel("pending", t) };
    case "pulse-error":
      return { kind: "blocked", label: signalLabel("blocked", t) };
    case "setup":
      return { kind: "attention", label: signalLabel("attention", t) };
    case "setup-complete":
      return { kind: "resolved", label: signalLabel("resolved", t) };
    case "ready": {
      const exceptions = exceptionDisplay(input.pulse, formatCount);
      const replies = input.pulse?.replyTasks?.length ?? 0;
      const drafts = input.pulse?.draftOrders?.length ?? 0;
      if (exceptions.count > 0) {
        // Display string in the {{count}} slot (tWithCountDisplay precedent —
        // the key has no plural forms, so i18next interpolates, never selects).
        return {
          kind: "attention",
          label: signalLabel("attention", t),
          reason: t("dashboard.pulse.signal.reason.exceptions", { count: exceptions.display }),
        };
      }
      if (replies > 0 || drafts > 0) {
        return {
          kind: "review",
          label: signalLabel("review", t),
          reason: t("dashboard.pulse.signal.reason.work", { replies: formatCount(replies), drafts: formatCount(drafts) }),
        };
      }
      if (input.caughtUp) {
        return { kind: "healthy", label: signalLabel("healthy", t) };
      }
      return {
        kind: "pending",
        label: signalLabel("pending", t),
        reason: t("dashboard.pulse.signal.reason.partial"),
      };
    }
  }
}

/** Exactly one primary action (§11). Severity: exception → reply → draft. */
export function derivePrimaryAction(input: DeriveInput, t: Translate): Action {
  if (input.phase === "pulse-error") {
    return { label: t("dashboard.pulse.retry") };
  }
  if (input.phase === "ready") {
    const firstOf = (kind: WorkKind) =>
      input.workItems
        .filter((item) => item.kind === kind)
        .sort((left, right) => right.sortAt - left.sortAt)[0];
    const first = firstOf("exception") ?? firstOf("reply") ?? firstOf("draft");
    if (first) {
      return { label: t(`dashboard.pulse.primary.${first.kind}`), to: first.to };
    }
  }
  return { label: t("dashboard.pulse.attention.openInbox"), to: "/inbox" };
}

export interface NarrativeOptions extends DeriveCountFormat {
  lastSyncLabel?: string;
  provenResultOverride?: string;
}

/** Core Design Test (§4): all four answers, always non-empty. */
export function deriveNarrative(
  input: DeriveInput,
  t: Translate,
  options: NarrativeOptions = {},
): DashboardNarrative {
  const formatCount = options.formatCount ?? ((value: number) => String(value));
  const replies = input.pulse?.replyTasks?.length ?? 0;
  const drafts = input.pulse?.draftOrders?.length ?? 0;
  // Same authority as the Orders badge (A8 MAJOR-2), same Intl formatter
  // (A8 MAJOR-3) — the hero sentence and the badge can never disagree.
  const exceptions = exceptionDisplay(input.pulse, formatCount);

  let whyHere: string;
  let whereNext: string;
  switch (input.phase) {
    case "setup-loading":
    case "pulse-loading":
      whyHere = t("dashboard.pulse.whyHere.loading");
      whereNext = t("dashboard.pulse.whereNext.loading");
      break;
    case "pulse-error":
      whyHere = t("dashboard.pulse.whyHere.error");
      whereNext = t("dashboard.pulse.whereNext.error");
      break;
    case "setup":
      whyHere = t("dashboard.pulse.whyHere.setup");
      whereNext = t("dashboard.pulse.whereNext.setup");
      break;
    case "setup-complete":
      whyHere = t("dashboard.pulse.whyHere.setupComplete");
      whereNext = t("dashboard.pulse.whereNext.setupComplete");
      break;
    case "ready":
      if (input.workItems.length > 0) {
        whyHere = t("dashboard.pulse.whyHere.work", {
          replies: formatCount(replies),
          drafts: formatCount(drafts),
          exceptions: exceptions.display,
        });
        whereNext = t("dashboard.pulse.whereNext.work");
      } else if (input.caughtUp) {
        whyHere = t("dashboard.pulse.whyHere.caughtUp");
        whereNext = t("dashboard.pulse.whereNext.caughtUp");
      } else {
        whyHere = t("dashboard.pulse.whyHere.partial");
        whereNext = t("dashboard.pulse.whereNext.partial");
      }
      break;
  }

  const provenResult = options.provenResultOverride
    ?? (options.lastSyncLabel
      ? t("dashboard.pulse.lastChecked", { time: options.lastSyncLabel })
      : t("dashboard.pulse.timeUnavailable"));

  return {
    whyHere,
    whatNow: derivePrimaryAction(input, t).label,
    whereNext,
    provenResult,
  };
}
