/** Subscription and billing API contracts. */

export type SubscriptionStatus =
  | 'active'
  | 'trialing'
  | 'past_due'
  | 'cancelled'
  | 'inactive'
  | 'suspended'
  | 'trial_expired';

export interface SubscriptionPlan {
  code: 'SHURU' | 'GROWTH' | 'PARTNER';
  name: string;
  description: string;
  billing_model: 'flat_monthly' | 'per_order';
  price_bdt_monthly: number;
  price_bdt_yearly: number;
  conversations_limit: number;
  orders_limit: number;
  products_limit: number;
  can_purchase_topups: boolean;
  per_order_charge_bdt: number | null;
  features: Record<string, unknown>;
  topup_packs: TopupPack[];
  partner_order_tiers: Array<{
    minOrders: number;
    maxOrders: number | null;
    rateBdt: number;
  }>;
}

export interface Subscription {
  id: string;
  shop_id: string;
  plan_code: string;
  plan_name: string;
  plan_price: number | string;
  billing_cycle: 'monthly' | 'yearly' | 'per_order';
  billing_model: 'flat_monthly' | 'per_order';
  per_order_charge_bdt?: number | string | null;
  status: SubscriptionStatus;
  conversations_limit: number;
  conversations_used: number;
  orders_limit: number;
  orders_used: number;
  products_limit: number;
  products_used: number;
  topup_balance: number;
  extra_conversations?: number;
  extra_charge?: number | string;
  features?: Record<string, unknown>;
  current_period_start: string;
  current_period_end: string;
  next_billing_date: string;
  trial_ends_at?: string | null;
  cancelled_at?: string | null;
}

export interface SubscriptionUsageMetric {
  used: number;
  limit: number;
  included_limit?: number;
  topup_balance?: number;
  percentage: number;
  status: 'safe' | 'warning' | 'exceeded';
}

export interface SubscriptionData {
  subscription: Subscription;
  usage: {
    conversations: SubscriptionUsageMetric;
    orders: SubscriptionUsageMetric;
    products: SubscriptionUsageMetric;
  };
  effective_conversation_limit: number;
  conversation_quota_exhausted: boolean;
  period: { start: string; end: string };
  partner_eligibility: {
    delivered_orders_30d: number;
    minimum_delivered_orders: number;
    eligible: boolean;
    available: boolean;
  };
  extra_usage: { conversations: number; charge: number };
}

export interface PaymentMethod {
  id: string;
  type: 'card' | 'bank_transfer' | 'mobile_money';
  last4?: string;
  brand?: string;
  exp_month?: number;
  exp_year?: number;
}

export interface Invoice {
  id: string;
  subscription_id: string;
  invoice_number: string;
  billing_period: string;
  /** Period bounds as stored by the invoice job; `end` is exclusive. */
  billing_period_start?: string;
  billing_period_end?: string;
  amount: number | string;
  base_amount?: number | string;
  extra_usage_amount?: number | string;
  addon_amount?: number | string;
  status: 'pending' | 'paid' | 'cancelled' | 'overdue';
  invoice_type?: string;
  due_date: string;
  created_at: string;
  paid_at?: string | null;
  payment_id?: string | null;
  metadata?: Record<string, unknown>;
  pdf_url?: string;
}

export interface TopupPack {
  code: string;
  conversations: number;
  priceBdt: number;
}
