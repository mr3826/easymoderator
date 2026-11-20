/**
 * Customer 360 Lite, Sales Opportunities and Order Confidence (RTO Shield v2).
 * Backend: EasyMod-backend/src/modules/{customer-intelligence,order-confidence}
 * Contract: docs/pilot-intelligence/04-api.md
 */

export type CustomerState = 'NEW' | 'INTERESTED' | 'BUYER' | 'REPEAT_BUYER' | 'AT_RISK' | 'INACTIVE';
export type OpportunityStatus = 'OPEN' | 'ACTIONED' | 'CONVERTED' | 'DISMISSED' | 'EXPIRED';
export type OpportunityStrength = 'HIGH' | 'MEDIUM';
export type OrderOutcome = 'DELIVERED' | 'RETURNED' | 'CANCELLED' | 'IN_PROGRESS';
export type DismissReason = 'NOT_INTERESTED' | 'ALREADY_HANDLED' | 'NOT_A_REAL_REQUEST' | 'OTHER';

export interface PilotStatus {
  customer_intelligence: boolean;
  order_confidence_mode: 'off' | 'shadow' | 'enforce';
}

export interface StateReason {
  code: string;
  params?: Record<string, number | string>;
}

export interface Customer360ListItem {
  id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  channel_type: string;
  profile_pic: string | null;
  first_seen_at: string | null;
  state: CustomerState;
  state_reasons: StateReason[];
  total_orders: number;
  delivered_orders: number;
  returned_orders: number;
  delivered_value: number;
  last_order_at: string | null;
  last_activity_at: string | null;
  open_opportunity: { id: string; status: OpportunityStatus; strength: OpportunityStrength; reasons: string[] } | null;
}

export interface Customer360ListResponse {
  data: Customer360ListItem[];
  total: number;
  page: number;
  pageSize: number;
}

export interface Contactability {
  platform: string | null;
  window_open: boolean;
  window_closes_at: string | null;
  reason: 'WITHIN_24H_WINDOW' | 'OUTSIDE_24H_WINDOW' | 'OPTED_OUT' | 'NO_INBOUND_MESSAGE' | 'NOT_A_MESSAGING_CHANNEL';
}

export interface OpportunitySignal {
  code: string;
  source: 'MESSAGE' | 'ORDER_SESSION';
  intent_id: string | null;
  attribute: string | null;
  checkout_step: string | null;
  message_id: string | null;
  at: string;
}

export interface RecommendedAction {
  code: 'REPLY_IN_INBOX' | 'WAIT_FOR_CUSTOMER_MESSAGE' | 'DO_NOT_CONTACT' | 'CONTACT_BY_PHONE';
  window_closes_at?: string;
  reason?: string;
}

export interface Opportunity {
  id: string;
  status: OpportunityStatus;
  strength: OpportunityStrength;
  reasons: string[];
  signals: OpportunitySignal[];
  product_refs: Array<{ product_id: string; name: string | null; quantity?: number }>;
  customer_id: string;
  conversation_id: string | null;
  first_signal_at: string;
  last_signal_at: string;
  detected_at: string;
  actioned_at: string | null;
  converted_order_id: string | null;
  resolved_at: string | null;
  resolution_reason: string | null;
  recommended_action: RecommendedAction | null;
  customer: { id: string; name: string | null; channel_type: string } | null;
}

export interface OpportunityListResponse {
  data: Opportunity[];
  total: number;
  page: number;
  pageSize: number;
}

export interface CommerceSummary {
  total_orders: number;
  delivered_orders: number;
  returned_orders: number;
  cancelled_orders: number;
  in_progress_orders: number;
  ordered_value: number;
  delivered_value: number;
  first_order_at: string | null;
  last_order_at: string | null;
  last_delivered_at: string | null;
}

export interface CustomerOrderRow {
  id: string;
  order_number: string | null;
  created_at: string;
  total: number;
  order_status: string;
  payment_status: string | null;
  delivery_status: string | null;
  delivery_provider: string | null;
  outcome: OrderOutcome;
  link: 'CUSTOMER' | 'PHONE_MATCH';
  confidence: { decision: ConfidenceDecision; resolution: string | null; last_gate_result: string | null; outcome: string | null } | null;
}

export interface TimelineEvent {
  type: string;
  at: string;
  order_id?: string;
  order_number?: string | null;
  conversation_id?: string;
  opportunity_id?: string;
  strength?: OpportunityStrength;
  reasons?: string[];
  total?: number;
  provider?: string | null;
  customer_messages?: number;
  approximate_time?: boolean;
  link?: 'CUSTOMER' | 'PHONE_MATCH';
}

export interface RtoSignal {
  available: boolean;
  reason?: string;
  tier?: 'block' | 'verify' | 'clear';
  risk_score?: number;
  list?: 'SHOP_LIST' | 'NETWORK_LIST' | null;
  network?: { shops_reported: number; total_attempts: number; rto_rate: number } | null;
}

export interface Customer360Detail {
  customer: {
    id: string;
    name: string | null;
    phone: string | null;
    email: string | null;
    channel_type: string;
    profile_pic: string | null;
    first_seen_at: string | null;
    last_activity_at: string | null;
    last_inbound_at: string | null;
    page: { id: string; name: string | null; platform: string } | null;
  };
  contactability: Contactability;
  state: CustomerState;
  state_reasons: StateReason[];
  state_rules_version: string;
  summary: CommerceSummary;
  rto_signal: RtoSignal;
  orders: CustomerOrderRow[];
  conversations: Array<{ id: string; channel: string; status: string; started_at: string; last_activity_at: string; customer_messages: number }>;
  opportunities: Opportunity[];
  timeline: TimelineEvent[];
}

export type ConfidenceDecision = 'READY' | 'VERIFY' | 'MANUAL_REVIEW';
export type VerifyMethod = 'PHONE_CALL' | 'CHAT' | 'IN_PERSON' | 'OTHER';

export interface ConfidenceReason {
  code: string;
  severity: 'BLOCK' | 'REVIEW' | 'VERIFY' | 'INFO';
  source: string;
  evidence: Record<string, unknown>;
}

export interface OrderConfidenceDecision {
  order_id: string;
  mode: 'off' | 'shadow' | 'enforce';
  decision: ConfidenceDecision | null;
  effective_state?: ConfidenceDecision;
  bookable?: boolean;
  required_action?: 'NONE' | 'VERIFY' | 'APPROVE' | 'NOT_BOOKABLE';
  reasons?: ConfidenceReason[];
  rules_version?: string;
  evaluated_at?: string;
  decision_version?: number;
  resolution?: {
    type: 'VERIFIED' | 'APPROVED';
    level: string;
    method: string | null;
    note: string | null;
    resolved_by: string | null;
    resolved_at: string | null;
    applies: boolean;
    stale: boolean;
  } | null;
  gate?: { last_result: string | null; last_at: string | null; held_count: number };
  released_at?: string | null;
  outcome?: string | null;
  outcome_at?: string | null;
  history?: Array<{ at: string; event: string; decision?: string; from?: string; reasons?: string[]; actor?: string | null; method?: string | null }>;
}
