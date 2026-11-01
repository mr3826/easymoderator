import { describe, expect, it } from "vitest";
import {
  subscriptionPlans,
  TOPUP_PACK_FALLBACK,
  PARTNER_ORDER_TIERS_FALLBACK,
  publicPlanToDefinition,
} from "../subscriptionPlans";

describe("internal subscription plan metadata", () => {
  it("keeps internal compatibility IDs and feature-gate metadata", () => {
    expect(subscriptionPlans.map((plan) => plan.code)).toEqual(["SHURU", "GROWTH", "PARTNER"]);
    expect(subscriptionPlans[0]).toMatchObject({ monthlyPrice: 0, yearlyPrice: 0 });
    expect(subscriptionPlans[0].limits.conversations).toBe(100);
    expect(subscriptionPlans[1]).toMatchObject({ monthlyPrice: 999, yearlyPrice: 9990 });
    expect(subscriptionPlans[1].limits.conversations).toBe(500);
    expect(subscriptionPlans[2].limits.conversations).toBe(-1);
    expect(subscriptionPlans[2].partnerOrderTiers).toEqual(PARTNER_ORDER_TIERS_FALLBACK);
    expect(subscriptionPlans[0].features).toEqual(subscriptionPlans[1].features);
    expect(subscriptionPlans[1].features).toEqual(subscriptionPlans[2].features);
  });

  it("keeps the internal feature-gate snapshot separate from the live public catalog", () => {
    expect(subscriptionPlans.find((plan) => plan.code === "GROWTH")?.topupPacks).toEqual(TOPUP_PACK_FALLBACK);
  });

  it("does not infer an unlisted custom branding entitlement or popularity", () => {
    const plan = publicPlanToDefinition({
      code: "GROWTH",
      name: "Growth",
      public_name: "Moderator Plus",
      description: "Growth",
      description_bn: "Moderator Plus description",
      billing_model: "flat_monthly",
      price_bdt_monthly: 999,
      price_bdt_yearly: 9990,
      conversations_limit: 500,
      orders_limit: -1,
      products_limit: -1,
      can_purchase_topups: true,
      per_order_charge_bdt: null,
      features: { advanced_ai: true },
      topup_packs: TOPUP_PACK_FALLBACK,
      partner_order_tiers: [],
      support_reply_allowance: {
        amount: 3000,
        unit: "provider_accepted_ai_reply",
        period: "utc_calendar_month",
        status: "shadow_only",
        billable: false,
        enforced: false,
      },
    });

    expect(plan.publicName).toBe("Moderator Plus");
    expect(plan.supportReplyAllowance?.amount).toBe(3000);
    expect(plan.features.custom_branding).toBe(false);
    expect(plan).not.toHaveProperty("popular");
  });
});
