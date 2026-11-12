import { httpClient } from "@/shared/lib/http/client";
import type { ApiResponse } from "../types/common";

export interface StorefrontSettings {
  delivery_fee: number | string;
  delivery_note?: string | null;
}

export interface StorefrontSelectedProduct {
  product_id: string;
  variant_ids: string[];
}

export interface StorefrontManageRecord {
  id?: string;
  slug: string;
  title: string;
  description?: string | null;
  logo_url?: string | null;
  settings?: StorefrontSettings;
  selected_products?: StorefrontSelectedProduct[];
  is_published?: boolean;
  published?: boolean;
  published_at?: string | null;
  status?: string;
}

export interface StorefrontDetails {
  slug: string;
  title: string;
  description: string | null;
  logo_url: string | null;
  settings: {
    delivery_fee: number;
    delivery_note: string | null;
  };
}

export interface StorefrontVariant {
  id: string;
  option_name: string;
  option_value: string;
  price: number | string;
}

export interface StorefrontPublicProduct {
  id: string;
  product_id?: string;
  name?: string;
  name_en?: string;
  name_bn?: string;
  description?: string | null;
  description_en?: string | null;
  description_bn?: string | null;
  price?: number | string;
  product_price?: number | string;
  image_url?: string | null;
  images?: string[];
  variants?: StorefrontVariant[];
  option_name?: string;
  option_value?: string;
  status?: string;
  is_active?: boolean;
}

export interface StorefrontCheckoutAddress {
  division?: string;
  district: string;
  upazila?: string;
  area: string;
  street_address: string;
  zone?: string;
}

export interface StorefrontCheckoutItem {
  product_id: string;
  variant_id?: string;
  quantity: number;
}

export interface StorefrontCheckoutPayload {
  customer_name: string;
  customer_phone: string;
  delivery_address: StorefrontCheckoutAddress;
  consent: true;
  items: StorefrontCheckoutItem[];
}

export interface StorefrontCheckoutResult {
  order_id: string;
  order_number: string;
  total: number;
  payment_status: "unpaid";
  order_status: "confirmed";
}

function unwrap<T>(body: ApiResponse<T> | T): T {
  if (body !== null && typeof body === "object" && "data" in body) {
    return (body as ApiResponse<T>).data;
  }
  return body as T;
}

export async function getStorefrontManage(): Promise<StorefrontManageRecord | null> {
  const response = await httpClient.get<ApiResponse<StorefrontManageRecord | null> | StorefrontManageRecord | null>(
    "/api/storefront/manage",
  );
  return unwrap(response.data);
}

export async function createStorefront(payload: {
  title: string;
  slug?: string;
  description?: string;
  logo_url?: string;
}): Promise<void> {
  await httpClient.post("/api/storefront/manage", payload);
}

export async function updateStorefront(payload: {
  title: string;
  slug?: string;
  description?: string;
  logo_url?: string;
}): Promise<void> {
  await httpClient.patch("/api/storefront/manage", payload);
}

export async function updateStorefrontSettings(payload: {
  delivery_fee: number;
  delivery_note: string;
}): Promise<void> {
  await httpClient.put("/api/storefront/manage/settings", payload);
}

export async function updateStorefrontProducts(payload: {
  selected_products: StorefrontSelectedProduct[];
}): Promise<void> {
  await httpClient.put("/api/storefront/manage/products", payload);
}

export async function publishStorefront(): Promise<void> {
  await httpClient.post("/api/storefront/manage/publish");
}

export async function unpublishStorefront(): Promise<void> {
  await httpClient.post("/api/storefront/manage/unpublish");
}

export async function getPublicStorefront(slug: string): Promise<StorefrontDetails> {
  const response = await httpClient.get<ApiResponse<StorefrontDetails> | StorefrontDetails>(
    `/api/storefront/public/${encodeURIComponent(slug)}`,
    httpClient.skipShopIdConfig(),
  );
  return unwrap(response.data);
}

export async function getPublicStorefrontProducts(slug: string): Promise<StorefrontPublicProduct[]> {
  const response = await httpClient.get<ApiResponse<StorefrontPublicProduct[]> | StorefrontPublicProduct[]>(
    `/api/storefront/public/${encodeURIComponent(slug)}/products`,
    httpClient.skipShopIdConfig(),
  );
  return unwrap(response.data);
}

export async function createStorefrontCheckout(
  slug: string,
  payload: StorefrontCheckoutPayload,
  idempotencyKey: string,
): Promise<StorefrontCheckoutResult> {
  const response = await httpClient.post<
    ApiResponse<StorefrontCheckoutResult> | StorefrontCheckoutResult
  >(
    `/api/storefront/public/${encodeURIComponent(slug)}/checkout`,
    payload,
    httpClient.skipShopIdConfig({ headers: { "Idempotency-Key": idempotencyKey } }),
  );
  return unwrap(response.data);
}
