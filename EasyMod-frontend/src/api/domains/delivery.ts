/**
 * Delivery (courier) read-side API domain — Phase-1 W1.
 *
 * Owns the shop courier READINESS projection used by the dashboard
 * ConnectionHealth module (mission D7). Writes (connect/activate/ai-default/
 * pickup) intentionally stay in `./order.ts` — this file exists so the new
 * read contract has a single, honest home without touching order.ts.
 *
 * Endpoint verification (2026-11-24, against the PR #311 head backend):
 * the readiness router is mounted at `/api/shop/delivery` (modules/routes.js:53
 * `router.use('/shop/delivery', deliveryRoutes)` + app.js `app.use('/api', …)`),
 * so the live paths are `GET /api/shop/delivery/readiness` and
 * `GET /api/shop/delivery/:provider/readiness` — NOT `/api/delivery/readiness`
 * (that prefix only serves `/api/delivery/rag`). Payload produced by
 * courier-readiness.service.js `getReadiness` via delivery.controller.js
 * `getProviderReadiness` (`{ success: true, data: … }`, credentials never
 * serialised).
 */
import { httpClient } from '@/shared/lib/http/client';
import type { ApiResponse } from '../types/common';
import type { AxiosResponse } from 'axios';

/** Serialised shop pickup location summary embedded in readiness
 *  (pickup-location.service.js serializePickupLocation — PII-safe by
 *  construction; the dashboard renders none of it). */
export interface DeliveryReadinessPickupSummary {
  id: string;
  shop_id?: string;
  display_name: string;
  contact_name?: string | null;
  phone?: string | null;
  secondary_phone?: string | null;
  address?: string;
  city_name?: string | null;
  zone_name?: string | null;
  area_name?: string;
  postal_code?: string | null;
  city_id?: string | number | null;
  zone_id?: string | number | null;
  area_id?: string | number | null;
  provider: string;
  provider_store_id?: string | null;
  is_active: boolean;
  is_default: boolean;
  metadata: Record<string, unknown>;
  created_at?: string | null;
  updated_at?: string | null;
}

/**
 * Per-provider readiness verdict (courier-readiness.service.js
 * readinessForIntegration). `missing` and `missing_fields` are the SAME
 * array serialised under both names by the service.
 *
 * status semantics: `missing.length === 0 ? (active ? 'ACTIVE' : 'READY')
 * : 'SETUP_INCOMPLETE'`. The controller calls getReadiness with the default
 * `requireActive = true`, so `provider_not_active` lands in `missing` for an
 * inactive-but-otherwise-complete courier: through THIS endpoint the
 * observable states are ACTIVE and SETUP_INCOMPLETE; 'READY' is typed for
 * contract truth (a requireActive=false caller could receive it) but is
 * currently unreachable from the merchant API.
 */
export interface DeliveryReadinessProvider {
  /** Provider key ('pathao' | 'redx' | 'steadfast' | …), null when unknown. */
  provider: string | null;
  ready: boolean;
  connected: boolean;
  active: boolean;
  credentials_configured: boolean;
  provider_store_id: string | null;
  provider_store_count: number;
  pickup_location_id?: string | null;
  pickup_location_configured: boolean;
  pickup_enabled: boolean;
  pickup_summary: DeliveryReadinessPickupSummary | null;
  /** Whitelisted pickup ids only: city_id/zone_id/area_id/delivery_area_id/
   *  pickup_store_id/provider_store_id — values are strings or numbers. */
  provider_pickup_meta: Record<string, string | number>;
  pickup_locations_count: number;
  missing: string[];
  missing_fields: string[];
  status: 'ACTIVE' | 'READY' | 'SETUP_INCOMPLETE';
}

/**
 * Shop-level readiness. This is the selected provider's verdict (best
 * ready+active+connected, else first, else an honest all-missing fallback
 * when the shop has no integrations at all) extended with the full
 * `providers[]` list.
 */
export interface DeliveryReadiness extends DeliveryReadinessProvider {
  providers: DeliveryReadinessProvider[];
}

/**
 * Phase-1 D7: courier connection readiness for the dashboard
 * ConnectionHealth row (and the Products/Orders-side courier hints).
 *
 * @param provider - Optional provider key; omitted returns the shop's
 *   selected-provider aggregate plus every integration verdict.
 * @throws on transport/HTTP failure — callers treat a rejection as
 *   "unknown", never as green (D10 disconnected state).
 */
export async function getDeliveryReadiness(
  provider?: string,
  signal?: AbortSignal,
): Promise<DeliveryReadiness> {
  const path = provider
    ? `/api/shop/delivery/${encodeURIComponent(provider)}/readiness`
    : '/api/shop/delivery/readiness';
  const response: AxiosResponse<ApiResponse<DeliveryReadiness>> = await httpClient.get(
    path,
    signal ? { signal } : undefined,
  );
  return response.data.data;
}
