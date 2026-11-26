/**
 * Pure derivation for the dashboard redesign: work items/groups (baseline
 * logic, unchanged) and the Core Design Test narrative (§4). The page-level
 * dominant signal and single primary action DERIVATIONS were retired with the
 * header band (header-removal C3/C2 — status now lives in record-level
 * content: ConnectionHealth badges, FTS task rows, queue chips). No DOM, no
 * fetch — every function is unit-testable with a key-returning `t`.
 */
import { AlertTriangle, FileText, MessageCircle } from "lucide-react";
import type {
  DashboardNarrative,
  DeriveInput,
  PulseData,
  Translate,
  WorkGroup,
  WorkItem,
} from "./types";

export const WORK_ITEMS_PER_GROUP = 2;

export const validDate = (value: string | null | undefined) => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
};

export const orderLabel = (order: { orderNumber?: string | null; id: string }) =>
  order.orderNumber || order.id.slice(0, 8);

/**
 * A8 round-3 (INFO): exception rows showed the raw server enum ("confirmed")
 * inside an otherwise-Bangla UI. The order-status vocabulary already exists
 * (`dashboard.pulse.status.*`, shared with the RecentOrders status pills) —
 * known statuses render through it; an unknown server value passes through
 * unchanged so the row never hides or invents data the projection carries.
 */
const LOCALIZED_ORDER_STATUSES = new Set([
  "confirmed", "cancelled", "processing", "draft", "delivered", "returned",
  "finalized", "completed", "pending", "failed",
]);

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
    const statusText = status && LOCALIZED_ORDER_STATUSES.has(status)
      ? t(`dashboard.pulse.status.${status}`)
      : status;
    workItems.push({
      id: `exception-${order.id}`,
      kind: "exception",
      // D3: PII-free projection — the row is identified by the human order
      // number (id fallback), never by customer_name/customer_phone.
      title: orderLabel(order),
      detail: [statusText, order.tracking_id].filter(Boolean).join(" · ") || t("dashboard.pulse.status.unknown"),
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

export interface NarrativeOptions {
  lastSyncLabel?: string;
  provenResultOverride?: string;
}

/** Core Design Test (§4): the answers that feed the evidence footer and the
 *  inbox rail. `whatNow` left with the header action band (C2) and `whyHere`
 *  with its last render consumer (round-1 F2) — the counts reach the page via
 *  AttentionQueue, QueueSignalChips and BusinessHealth, all of which keep the
 *  A8 MAJOR-3 locale formatter at the component edge. A8 MAJOR-2's
 *  bucket-count authority survives the same way: Dashboard.tsx hands the
 *  BusinessHealth tile the exhaustive `worklistNeedsActionCount`
 *  (GET /api/order/counts needs_action) directly — null renders
 *  "unavailable", never a capped-sample figure presented as verified. */
export function deriveNarrative(
  input: DeriveInput,
  t: Translate,
  options: NarrativeOptions = {},
): DashboardNarrative {
  let whereNext: string;
  switch (input.phase) {
    case "setup-loading":
    case "pulse-loading":
      whereNext = t("dashboard.pulse.whereNext.loading");
      break;
    case "pulse-error":
      whereNext = t("dashboard.pulse.whereNext.error");
      break;
    case "setup":
      whereNext = t("dashboard.pulse.whereNext.setup");
      break;
    case "setup-complete":
      whereNext = t("dashboard.pulse.whereNext.setupComplete");
      break;
    case "ready":
      if (input.workItems.length > 0) {
        whereNext = t("dashboard.pulse.whereNext.work");
      } else if (input.caughtUp) {
        whereNext = t("dashboard.pulse.whereNext.caughtUp");
      } else {
        whereNext = t("dashboard.pulse.whereNext.partial");
      }
      break;
  }

  const provenResult = options.provenResultOverride
    ?? (options.lastSyncLabel
      ? t("dashboard.pulse.lastChecked", { time: options.lastSyncLabel })
      : t("dashboard.pulse.timeUnavailable"));

  return {
    whereNext,
    provenResult,
  };
}
