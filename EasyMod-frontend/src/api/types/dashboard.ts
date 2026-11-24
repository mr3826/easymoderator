/**
 * Dashboard and Analytics types
 */

import type { AiReplyMode, EmergencyStopState } from './conversation';

export interface DashboardMetrics {
  metrics: {
    totalMessages: number;
    activeProducts: number;
    ordersToday: number;
    ordersInPeriod: number;
    conversionRate: number;
    weeklyChange: number;
  };
  period?: number;
  analytics?: {
    total_messages: number;
    llm_calls: number;
    cache_hits: number;
    keyword_matches: number;
    cost_estimate: number;
  } | null;
  channels: {
    active: number;
    total: number;
  };
  chartData: Array<{
    date: string;
    orders: number;
  }>;
  cashPosition?: {
    inTransit: { amount: number; count: number };
    atRisk: { amount: number; count: number; windowDays: number };
  };
  totalRevenue?: number;
}

/**
 * C1 — `GET /api/conversation/needs-reply-count` (Phase-1 mission D1/D2/D3).
 * Bounded scan of open conversations through the shared needs-reply service;
 * the SAME predicate powers the Inbox nav badge, the dashboard chip and the
 * inbox `?tab=needs_review` list. Honesty fields are never omitted by the
 * backend; a client that cannot read the endpoint renders no chip/badge —
 * never zero.
 */
export interface NeedsReplyCount {
  /** Conversations needing a merchant reply inside the scanned window. */
  count: number;
  /** Open conversations actually scanned (≤ cap). */
  scanned: number;
  /** Server scan cap (contract value 200). */
  cap: number;
  /** True only when the scan covered every open conversation. */
  coverageComplete: boolean;
  /** ISO-8601 server generation timestamp. */
  generated_at: string;
}

/**
 * C2 — `GET /api/product/stock-exceptions` (Phase-1 mission D1/D2).
 * D2 predicate, single definition shared with Products.tsx:
 * scope `shop_id, is_active, track_quantity`;
 * effective quantity = Σ active variant quantities when variants exist,
 * else the parent quantity; out ≤ 0; low 0 < q ≤ low_stock_threshold;
 * exceptions = out + low (disjoint by construction).
 */
export interface StockExceptions {
  outOfStock: number;
  lowStock: number;
  /** outOfStock + lowStock — disjoint categories, safe to show as one total. */
  exceptions: number;
  scanned: number;
  /** Server scan cap (contract value 1000). */
  cap: number;
  coverageComplete: boolean;
  generated_at: string;
}

/**
 * D3 PII-free queue projection for `at_risk_orders` (needs_action sample).
 * This is the complete emitted shape — customer_name/customer_phone are
 * removed from the contract entirely (W3 cleanup, after A4 confirmed zero
 * readers and A5 confirmed the backend no longer serialises them). Order rows
 * carry delivery-exception state, never customer identity, at this boundary.
 */
export interface AtRiskOrderProjection {
  id: string;
  /** Human order number with the id as the deterministic fallback. */
  orderNumber: string;
  /** Authoritative order status vocabulary (worklist bucket source). */
  status: string;
  tracking_id: string | null;
  /** ISO-8601 last update. */
  updatedAt: string;
}

/** Read-only projections; null means the source could not be read. */
export interface DashboardCommerceSignals {
  deliveredCharges: { dayUtc: string; count: number; amountMinor: number } | null;
  recentActivity: Array<{
    id: string;
    action: string;
    resourceType: string;
    occurredAt: string;
    /** Entity id behind the row (order/conversation/product) when stored. */
    resource_id?: string | null;
    /** Stored actor (PII-stripped tenant view). NULL actor = system action. */
    user?: { id: string; full_name: string } | null;
  }> | null;
}

export interface DashboardQueue {
  commerce_signals?: DashboardCommerceSignals;
  /**
   * C1 object from the shared needs-reply service (replaces the legacy
   * `unread_count` entirely — removed in W3 after A4 confirmed zero readers
   * and A5 confirmed the backend no longer emits it). null = source failed
   * (never 0); absent = pre-W2 backend.
   */
  needs_reply?: NeedsReplyCount | null;
  /** D3 worklist predicate marker (e.g. 'worklist-v1'); pins chip↔bucket parity. */
  predicate_version?: string;
  pending_payment_count: number;
  ready_to_dispatch_count: number;
  at_risk_orders: AtRiskOrderProjection[];
  pendingOrders?: number;
}

export interface ShopAgent {
  id: string;
  name: string;
  email: string;
  role?: string;
}

export interface ShopAISettings {
  automation_mode: AiReplyMode;
  ai_enabled?: boolean;
  confidence_threshold: number;
  auto_reply_enabled: boolean;
  response_language?: string;
  max_auto_order_value: number;
  ask_email: boolean;
  primary_language: string;
  required_fields: {
    customer_name: boolean;
    mobile_number: boolean;
    delivery_address: boolean;
    payment_method: boolean;
    email_address: boolean;
    special_instructions: boolean;
  };
  handoff_settings: {
    trigger_keywords: string[];
    notification_channel: 'in_app' | 'telegram' | 'email' | 'sms';
    cooldown_minutes: number;
  };
  // Auto-sent welcome on the first AI reply of a conversation. The fixed Meta
  // AI-disclosure line is prepended server-side; custom_text is the editable part.
  greeting?: { enabled: boolean; custom_text: string };
  // Appended to the order-confirmation message (thank-you + social links).
  closing?: { enabled: boolean; custom_text: string };
  // Read-only business-wide safety state (ADR-0013 §6). Never editable through
  // the business settings PUT.
  emergency_stop?: EmergencyStopState;
}
