import type { ApiResponse } from "../types/common";
import { publicApiGet } from "@/shared/lib/http/public-client";

export type PublicAddonCode = "ADS_STUDIO" | "STOREFRONT";

export interface PublicAddonDefinition {
  code: PublicAddonCode;
  name: string;
  category: "advertising" | "commerce";
  availability: "pilot_approval_required";
  billing_terms: "not_activated";
  price_bdt_monthly: null;
  summary: string;
  limits: string[];
}

export function hasRequiredPublicAddons(addons: readonly Pick<PublicAddonDefinition, "code">[]) {
  return addons.length === 2 &&
    new Set(addons.map(({ code }) => code)).size === 2 &&
    addons.some(({ code }) => code === "ADS_STUDIO") &&
    addons.some(({ code }) => code === "STOREFRONT");
}

export async function getPublicAddonCatalog(): Promise<PublicAddonDefinition[]> {
  const response = await publicApiGet<ApiResponse<PublicAddonDefinition[]>>("/api/public/addons");
  if (!response.success || !Array.isArray(response.data) || !hasRequiredPublicAddons(response.data)) {
    throw new Error("The public add-on catalog is unavailable or incomplete.");
  }
  if (response.data.some((addon) => (
    addon.price_bdt_monthly !== null ||
    addon.billing_terms !== "not_activated" ||
    addon.availability !== "pilot_approval_required"
  ))) {
    throw new Error("The public add-on catalog contains unapproved billing terms.");
  }
  return response.data;
}
