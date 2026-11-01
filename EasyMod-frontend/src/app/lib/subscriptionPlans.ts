export type BillingCycle = "monthly" | "yearly";
export type PlanCode = "SHURU" | "GROWTH" | "PARTNER";

export const PUBLIC_PLAN_NAME_BY_CODE: Record<PlanCode, string> = {
  SHURU: "Get Your Moderator",
  GROWTH: "Moderator Plus",
  PARTNER: "Partnership",
};

export interface PartnerOrderTier {
  minOrders: number;
  maxOrders: number | null;
  rateBdt: number;
}

export interface ShadowSupportAllowance {
  amount: number;
  unit: "provider_accepted_ai_reply";
  period: "utc_calendar_month";
  status: "shadow_only";
  billable: false;
  enforced: false;
}

export interface TopupPackDefinition {
  code: string;
  conversations: number;
  priceBdt: number;
}

export interface SubscriptionPlanDefinition {
  id: string;
  code: PlanCode;
  name: string;
  publicName: string;
  description: string;
  descriptionBn: string;
  billingModel: "flat_monthly" | "per_order";
  monthlyPrice: number;
  yearlyPrice: number;
  canPurchaseTopups: boolean;
  /** For per-order billing plans (Partner). */
  perOrderChargeBdt?: number;
  limits: {
    conversations: number; // -1 = unlimited
    orders: number;
    products: number;
  };
  features: {
    image_understanding: boolean;
    advanced_ai: boolean;
    priority_support: boolean;
    custom_branding: boolean;
    messenger_dm_only: boolean;
  };
  highlights: string[];
  topupPacks?: TopupPackDefinition[];
  partnerOrderTiers?: PartnerOrderTier[];
  supportReplyAllowance: ShadowSupportAllowance | null;
  /** No popularity marker is published by the live catalog. */
}

export interface PublicSubscriptionPlanPayload {
  code: PlanCode;
  name: string;
  public_name: string;
  description: string;
  description_bn: string;
  billing_model: "flat_monthly" | "per_order";
  price_bdt_monthly: number;
  price_bdt_yearly: number;
  conversations_limit: number;
  orders_limit: number;
  products_limit: number;
  can_purchase_topups: boolean;
  per_order_charge_bdt: number | null;
  features?: Record<string, unknown>;
  highlights?: string[];
  topup_packs?: TopupPackDefinition[];
  partner_order_tiers?: PartnerOrderTier[];
  support_reply_allowance: ShadowSupportAllowance | null;
}

export const UNLIMITED = -1;

const SHARED_FEATURES = {
  image_understanding: true,
  advanced_ai: true,
  priority_support: true,
  custom_branding: false,
  messenger_dm_only: true,
};

export const TOPUP_PACK_FALLBACK: TopupPackDefinition[] = [
  { code: "PACK_100", conversations: 100, priceBdt: 250 },
  { code: "PACK_300", conversations: 300, priceBdt: 500 },
  { code: "PACK_700", conversations: 700, priceBdt: 1000 },
];

export const PARTNER_ORDER_TIERS_FALLBACK: PartnerOrderTier[] = [
  { minOrders: 300, maxOrders: 999, rateBdt: 15 },
  { minOrders: 1000, maxOrders: 2999, rateBdt: 12 },
  { minOrders: 3000, maxOrders: null, rateBdt: 10 },
];

export function publicPlanToDefinition(
  plan: PublicSubscriptionPlanPayload,
): SubscriptionPlanDefinition {
  const features = plan.features || {};
  return {
    id: plan.code.toLowerCase(),
    code: plan.code,
    name: plan.name,
    publicName: plan.public_name,
    description: plan.description,
    descriptionBn: plan.description_bn,
    billingModel: plan.billing_model,
    monthlyPrice: Number(plan.price_bdt_monthly),
    yearlyPrice: Number(plan.price_bdt_yearly),
    canPurchaseTopups: plan.can_purchase_topups,
    perOrderChargeBdt: plan.per_order_charge_bdt ?? undefined,
    limits: {
      conversations: plan.conversations_limit,
      orders: plan.orders_limit,
      products: plan.products_limit,
    },
    features: {
      image_understanding: features.image_understanding === true,
      advanced_ai: features.advanced_ai === true,
      priority_support: features.priority_support === true,
      custom_branding: features.custom_branding === true,
      messenger_dm_only: true,
    },
    highlights: plan.highlights || [],
    topupPacks: plan.topup_packs,
    partnerOrderTiers: plan.partner_order_tiers,
    supportReplyAllowance: plan.support_reply_allowance,
  };
}

/**
 * Internal display-name/feature map only. Public prices and plan entitlements
 * must always come from the live catalog and never use these values as fallback.
 */
export const subscriptionPlans: SubscriptionPlanDefinition[] = [
  {
    id: "shuru",
    code: "SHURU",
    name: "Shuru",
    publicName: "Get Your Moderator",
    description: "No monthly plan fee; the active Messenger-conversation allowance is published by the live catalog.",
    descriptionBn: "মাসিক প্ল্যান ফি নেই; সক্রিয় Messenger কথোপকথনের সীমা লাইভ ক্যাটালগে প্রকাশিত হয়।",
    billingModel: "flat_monthly",
    monthlyPrice: 0,
    yearlyPrice: 0,
    canPurchaseTopups: false,
    limits: { conversations: 100, orders: UNLIMITED, products: UNLIMITED },
    features: SHARED_FEATURES,
    highlights: [
      "100 customer conversations each month",
      "Facebook Messenger inbox",
      "Order capture and COD risk checks",
      "Manual replies always available",
    ],
    supportReplyAllowance: {
      amount: 300,
      unit: "provider_accepted_ai_reply",
      period: "utc_calendar_month",
      status: "shadow_only",
      billable: false,
      enforced: false,
    },
  },
  {
    id: "growth",
    code: "GROWTH",
    name: "Growth",
    publicName: "Moderator Plus",
    description: "The same core features with a larger conversation allowance and optional top-ups.",
    descriptionBn: "বেশি Messenger কথোপকথনের সীমা ও ঐচ্ছিক top-up-সহ একই মূল সুবিধা।",
    billingModel: "flat_monthly",
    monthlyPrice: 999,
    yearlyPrice: 9990,
    canPurchaseTopups: true,
    limits: { conversations: 500, orders: UNLIMITED, products: UNLIMITED },
    features: SHARED_FEATURES,
    highlights: [
      "500 customer conversations each month",
      "Facebook Messenger inbox",
      "Order capture and COD risk checks",
      "Top-ups when you need more conversations",
    ],
    topupPacks: TOPUP_PACK_FALLBACK,
    supportReplyAllowance: {
      amount: 3000,
      unit: "provider_accepted_ai_reply",
      period: "utc_calendar_month",
      status: "shadow_only",
      billable: false,
      enforced: false,
    },
  },
  {
    id: "partner",
    code: "PARTNER",
    name: "Partner",
    publicName: "Partnership",
    description: "No upfront fee; pay for successfully delivered orders.",
    descriptionBn: "কোনো upfront subscription নেই; ডেলিভারি সম্পন্ন হওয়া অর্ডার অনুযায়ী বিল।",
    billingModel: "per_order",
    monthlyPrice: 0,
    yearlyPrice: 0,
    canPurchaseTopups: false,
    limits: { conversations: UNLIMITED, orders: UNLIMITED, products: UNLIMITED },
    features: SHARED_FEATURES,
    highlights: [
      "300+ delivered orders in 30 days to qualify",
      "No monthly fee",
      "Unlimited customer conversations",
      "Flat rate by delivered-order band",
    ],
    partnerOrderTiers: PARTNER_ORDER_TIERS_FALLBACK,
    supportReplyAllowance: null,
  },
];

export const findPlanByName = (name: string) =>
  subscriptionPlans.find(
    (plan) => plan.name.toLowerCase() === name.toLowerCase(),
  );

export const findPlanByCode = (code: string) => {
  const normalized = code.toUpperCase();
  return subscriptionPlans.find(
    (plan) => plan.code === normalized || plan.id.toUpperCase() === normalized,
  );
};

export const getPlanPrice = (
  plan: SubscriptionPlanDefinition,
  billingCycle: BillingCycle,
) => (billingCycle === "yearly" ? plan.yearlyPrice : plan.monthlyPrice);
