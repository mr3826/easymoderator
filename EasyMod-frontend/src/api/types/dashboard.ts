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

export interface DashboardQueue {
  unread_count: number;
  pending_payment_count: number;
  ready_to_dispatch_count: number;
  at_risk_orders: Array<{
    id: string;
    customer_name: string;
    customer_phone: string;
    status: string;
    tracking_id: string | null;
  }>;
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
