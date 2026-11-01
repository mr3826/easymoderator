import type { ApiResponse } from "../types/common";
import { publicApiGet } from "@/shared/lib/http/public-client";
import {
  publicPlanToDefinition,
  type PublicSubscriptionPlanPayload,
  type SubscriptionPlanDefinition,
} from "@/app/lib/subscriptionPlans";

export type PublicSubscriptionCatalogSource = "live";

export interface PublicSubscriptionCatalog {
  plans: SubscriptionPlanDefinition[];
  source: PublicSubscriptionCatalogSource;
}

const REQUIRED_PUBLIC_PLAN_CODES = ["SHURU", "GROWTH", "PARTNER"] as const;

export function hasRequiredPublicPlans(plans: readonly SubscriptionPlanDefinition[]): boolean {
  if (plans.length !== REQUIRED_PUBLIC_PLAN_CODES.length) return false;
  const codes = new Set(plans.map(({ code }) => String(code).toUpperCase()));
  if (codes.size !== REQUIRED_PUBLIC_PLAN_CODES.length || !REQUIRED_PUBLIC_PLAN_CODES.every((code) => codes.has(code))) {
    return false;
  }

  const expectedNames = {
    SHURU: "Get Your Moderator",
    GROWTH: "Moderator Plus",
    PARTNER: "Partnership",
  } as const;
  const expectedShadowTargets = { SHURU: 300, GROWTH: 3000 } as const;

  return plans.every((plan) => {
    if (
      plan.publicName !== expectedNames[plan.code] ||
      typeof plan.description !== "string" ||
      plan.description.trim().length === 0 ||
      typeof plan.descriptionBn !== "string" ||
      plan.descriptionBn.trim().length === 0 ||
      !Number.isFinite(plan.monthlyPrice) ||
      !Number.isFinite(plan.yearlyPrice) ||
      !Number.isFinite(plan.limits.conversations)
    ) return false;

    if (plan.code === "PARTNER") {
      return plan.billingModel === "per_order" && plan.supportReplyAllowance === null
        && (plan.partnerOrderTiers?.length || 0) > 0;
    }

    const allowance = plan.supportReplyAllowance;
    const target = expectedShadowTargets[plan.code];
    if (!allowance || allowance.amount !== target
      || allowance.unit !== "provider_accepted_ai_reply"
      || allowance.period !== "utc_calendar_month"
      || allowance.status !== "shadow_only"
      || allowance.billable !== false
      || allowance.enforced !== false) return false;

    if (plan.code === "GROWTH") {
      return plan.billingModel === "flat_monthly" && plan.canPurchaseTopups && (plan.topupPacks?.length || 0) > 0;
    }
    return plan.billingModel === "flat_monthly";
  });
}

/** Fetch only the server-published catalog for public pricing surfaces. */
export async function getCurrentPublicSubscriptionCatalog(): Promise<PublicSubscriptionCatalog> {
  const response = await publicApiGet<ApiResponse<PublicSubscriptionPlanPayload[]>>(
    "/api/subscription/plans",
  );
  if (!Array.isArray(response.data) || response.data.length === 0) {
    throw new Error("The public subscription catalog is unavailable.");
  }
  const plans = response.data.map(publicPlanToDefinition);
  if (!hasRequiredPublicPlans(plans)) {
    throw new Error("The public subscription catalog is incomplete or does not include the approved shadow allowance contract.");
  }
  return { plans, source: "live" };
}

export async function getPublicSubscriptionCatalog(): Promise<PublicSubscriptionCatalog> {
  return getCurrentPublicSubscriptionCatalog();
}
