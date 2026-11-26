/**
 * Shared types for the guardrails-compliant /dashboard redesign.
 * Contracts follow EasyModerator-UI-UX-Guardrails.md §4/§24.
 */
import type { LucideIcon } from "lucide-react";
import type {
  DashboardCommerceSignals,
  DashboardMetrics,
  DashboardQueue,
  NeedsReplyCount,
  StockExceptions,
} from "@/api/types/dashboard";
import type { Conversation } from "@/api/types/conversation";
import type { Order } from "@/api/types/order";

export type CashPosition = NonNullable<DashboardMetrics["cashPosition"]>;
export type AtRiskOrder = DashboardQueue["at_risk_orders"][number];

/** One dominant workflow signal per screen (§8). Label + icon, never color alone. */
export type SignalKind =
  | "healthy"
  | "attention"
  | "review"
  | "blocked"
  | "resolved"
  | "pending";

export interface Signal {
  kind: SignalKind;
  label: string;
  reason?: string;
}

/** Verb-first action (§11/§20). `to` renders a router Link; otherwise a button. */
export interface Action {
  label: string;
  to?: string;
  onClick?: () => void;
  loading?: boolean;
  disabled?: boolean;
  disabledReason?: string;
}

export interface BreadcrumbItem {
  label: string;
  to?: string;
}

export type WorkKind = "reply" | "draft" | "exception";

export interface WorkItem {
  id: string;
  kind: WorkKind;
  title: string;
  detail: string;
  to: string;
  sortAt: number;
  icon: LucideIcon;
  action: string;
}

export interface WorkGroup {
  kind: WorkKind;
  title: string;
  to: string;
  action: string;
  items: WorkItem[];
  visibleItems: WorkItem[];
  hiddenCount: number;
}

export interface PulseData {
  commerceSignals?: DashboardCommerceSignals | null;
  ordersToday: number | null;
  replyTasks: Conversation[] | null;
  replyTaskCoverageComplete: boolean;
  draftOrders: Order[] | null;
  draftCoverageComplete: boolean;
  atRiskOrders: AtRiskOrder[] | null;
  exceptionCoverageComplete: boolean;
  lastFiveOrders: Order[] | null;
  cashPosition: CashPosition | null;
  /**
   * C1/C3 needs-reply object from the shared service — the D3 replacement for
   * the legacy `unread_count` (no longer read anywhere). null = source failed
   * or predates the contract: the chip renders Unavailable, never 0.
   */
  needsReply: NeedsReplyCount | null;
  pendingPaymentCount: number | null;
  readyToDispatchCount: number | null;
  /** D3 worklist predicate marker ('worklist-v1'); null = old backend payload. */
  predicateVersion: string | null;
  /**
   * D8: `needs_action` bucket count from the shared worklist counts source
   * (the same authority as the Orders nav badge and the queue sample).
   * null = source failed, never 0.
   */
  worklistNeedsActionCount: number | null;
  /** D2/C2 bounded stock-exception scan; null = source failed, never 0. */
  stockExceptions: StockExceptions | null;
  /** Already present in the metrics payload; optional 30-day trend. */
  chartData: unknown;
}

export interface CourierSnapshotState {
  orders: Order[] | null;
  isLoading: boolean;
}

export type DashboardPhase =
  | "setup-loading"
  | "setup"
  | "setup-complete"
  | "pulse-loading"
  | "pulse-error"
  | "ready";

/** Core Design Test (§4) — every state must answer all, non-empty. The
 *  former `whatNow` header answer retired with the page action band
 *  (header-removal C2/C3): the next action is the AttentionQueue row itself.
 *  The `whyHere` answer retired with its last consumer (header-removal round-1
 *  F2): nothing rendered it — counts reach the page through AttentionQueue,
 *  QueueSignalChips and BusinessHealth instead. */
export interface DashboardNarrative {
  whereNext: string;
  provenResult: string;
}

export interface DeriveInput {
  phase: DashboardPhase;
  pulse: PulseData | null;
  workItems: WorkItem[];
  caughtUp: boolean;
  hasAllWorkSources: boolean;
}

export type Translate = (key: string, options?: Record<string, unknown>) => string;
