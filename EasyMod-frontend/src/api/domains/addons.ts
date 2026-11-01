import { httpClient } from "@/shared/lib/http/client";
import type { ApiResponse } from "../types/common";
import type { PublicAddonDefinition, PublicAddonCode } from "./publicAddons";

export interface ShopAddonDefinition extends PublicAddonDefinition {
  eligible: boolean;
  enabled: boolean;
  enabled_at: string | null;
}

export interface ShopAddonState {
  shop_id: string;
  role: string;
  addons: ShopAddonDefinition[];
}

export async function getShopAddons(): Promise<ShopAddonState> {
  const response = await httpClient.get<ApiResponse<ShopAddonState>>("/api/addons");
  return response.data.data;
}

export async function setShopAddonEnabled(code: PublicAddonCode, enabled: boolean) {
  const response = await httpClient.put<ApiResponse<{ code: PublicAddonCode; enabled: boolean; enabled_at: string | null }>>(
    `/api/addons/${code}`,
    { enabled },
  );
  return response.data.data;
}
