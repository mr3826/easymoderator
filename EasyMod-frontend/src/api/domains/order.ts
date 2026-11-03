/**
 * Order & Delivery API Domain
 */

import { httpClient } from '@/shared/lib/http/client';
import type { ApiResponse } from '../types/common';
import type {
  Order,
  OrderItem,
  CreateOrderPayload,
  DeliverySettings,
  CourierBookingPayload,
  CourierBookingResult,
  CourierEligibility,
  ConnectDeliveryProviderRequest,
  DeliveryProvider,
  DeliveryLocationOption,
  DeliveryProviderStatus,
  PickupLocation,
  PickupLocationPayload,
  ProviderPickupSyncRequest,
} from '../types/order';
import type { AxiosResponse } from 'axios';

type ApiEnvelope<T> = ApiResponse<T> | T;

function unwrapApiData<T>(response: AxiosResponse<ApiEnvelope<T>>): T {
  const body = response.data;
  if (body && typeof body === 'object' && 'data' in body) {
    return (body as ApiResponse<T>).data;
  }
  return body as T;
}

function unwrapList<T>(response: AxiosResponse<ApiEnvelope<T[] | Record<string, unknown>>>, key: string): T[] {
  const data = unwrapApiData<T[] | Record<string, unknown>>(response);
  if (Array.isArray(data)) return data as T[];
  if (data && Array.isArray(data[key])) return data[key] as T[];
  return [];
}

/**
 * The backend serialises orders in snake_case (customer_name, order_status,
 * delivery_address …) while the app's `Order` type — and every Orders/Dashboard
 * component — reads camelCase (customerName, status, deliveryAddress). Only the
 * Sequelize timestamps come through as camelCase, so without this mapping the
 * customer name/phone were blank, the status pills/counts were empty, and the
 * Cancel button (which sent `status`) was silently dropped by the API. Normalise
 * every order at the API boundary so the rest of the app gets the shape it expects.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizeOrderItem(raw: any): OrderItem {
  return {
    productId: raw?.product_id ?? raw?.productId ?? '',
    productName: raw?.productName ?? raw?.product_name ?? raw?.name ?? raw?.product?.name ?? '',
    quantity: Number(raw?.quantity ?? 1),
    price: Number(raw?.price ?? raw?.product?.price ?? 0),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizeOrder(raw: any): Order {
  if (!raw || typeof raw !== 'object') return raw;
  const da = raw.delivery_address;
  const isStructured = da !== null && typeof da === 'object';
  const deliveryAddressStr = isStructured
    ? [da.street_address, da.upazila, da.district, da.division].filter(Boolean).join(', ')
    : (typeof da === 'string' ? da : (raw.deliveryAddress ?? ''));

  return {
    ...raw,
    id: raw.id,
    orderNumber: raw.orderNumber ?? raw.order_number ?? raw.id,
    customerName: raw.customerName ?? raw.customer_name ?? raw.customer?.name ?? raw.customer?.display_name ?? '',
    // FE-08: the only verified link from an order to its conversation is the
    // shop-scoped customer id (flat list column or nested detail object).
    customerId: raw.customerId ?? raw.customer_id ?? raw.customer?.id ?? undefined,
    customerPhone: raw.customerPhone ?? raw.customer_phone ?? raw.customer?.phone ?? '',
    status: raw.status ?? raw.order_status ?? 'draft',
    channel: raw.channel ?? '',
    total: Number(raw.total ?? raw.total_amount ?? 0),
    deliveryAddress: deliveryAddressStr,
    // Keep the structured object only when it really is one, so the detail panel's
    // structured branch is used for manual orders and the plain-text branch for
    // chatbot orders (which store the address as free text).
    delivery_address: isStructured ? da : undefined,
    items: Array.isArray(raw.items) ? raw.items.map(normalizeOrderItem) : [],
    createdAt: raw.createdAt ?? raw.created_at ?? '',
    updatedAt: raw.updatedAt ?? raw.updated_at ?? '',
    payment_status: raw.payment_status ?? raw.paymentStatus,
    payment_method: raw.payment_method ?? raw.paymentMethod,
    note: raw.note ?? '',
  } as Order;
}

/**
 * Get all orders with optional filtering and pagination
 * @param params - Optional query parameters for filtering, pagination, and sorting
 * @returns Promise resolving to array of orders
 * @throws {Error} When order retrieval fails
 * @example
 * ```typescript
 * const orders = await getOrders({ status: 'pending', page: 1, limit: 10 });
 * ```
 */
export async function getOrders(params?: Record<string, unknown>): Promise<Order[]> {
  const response: AxiosResponse<ApiResponse<Order[]>> = await httpClient.get('/api/order', { params });
  return Array.isArray(response.data.data) ? response.data.data.map(normalizeOrder) : [];
}

/**
 * Get single order by ID
 * @param orderId - Unique identifier of order to retrieve
 * @returns Promise resolving to order object
 * @throws {Error} When order not found or retrieval fails
 * @example
 * ```typescript
 * const order = await getOrder('order123');
 * console.log(order.status);
 * ```
 */
export async function getOrder(orderId: string): Promise<Order> {
  const response: AxiosResponse<ApiResponse<Order>> = await httpClient.get(`/api/order/${orderId}`);
  return normalizeOrder(response.data.data ?? response.data);
}

/**
 * Create new order
 * @param order - Order data without id, createdAt, and updatedAt
 * @returns Promise resolving to created order object
 * @throws {Error} When order creation fails due to validation or network issues
 * @example
 * ```typescript
 * const newOrder = await createOrder({ 
 *   customer_id: 'cust123', 
 *   items: [{ product_id: 'prod1', quantity: 2 }],
 *   payment_method: 'cod',
 *   total: 199.99 
 * });
 * ```
 */
export async function createOrder(
  order: CreateOrderPayload,
  idempotencyKey?: string,
): Promise<Order> {
  // The manual-order form already sends a snake_case payload the create validator
  // expects, so only the response is normalised back into the app's Order shape.
  const response: AxiosResponse<ApiResponse<Order>> = idempotencyKey
    ? await httpClient.post('/api/order', order, { headers: { 'Idempotency-Key': idempotencyKey } })
    : await httpClient.post('/api/order', order);
  return normalizeOrder(response.data.data);
}

/**
 * Update existing order
 * @param orderId - ID of order to update
 * @param order - Partial order data with fields to update
 * @returns Promise resolving to updated order object
 * @throws {Error} When order update fails due to invalid ID or permissions
 * @example
 * ```typescript
 * const updated = await updateOrder('order123', { status: 'confirmed' });
 * ```
 */
export async function updateOrder(orderId: string, order: Partial<Order>): Promise<Order> {
  // Translate the app's camelCase fields to the backend's contract. The status
  // update buttons (incl. Cancel) send `status`, but the API only accepts
  // `order_status` — sending the wrong key is exactly why Cancel did nothing.
  const body: Record<string, unknown> = {};
  if (order.status !== undefined) body.order_status = order.status;
  if (order.note !== undefined) body.note = order.note;
  if (order.payment_status !== undefined) body.payment_status = order.payment_status;
  if (order.payment_method !== undefined) body.payment_method = order.payment_method;

  const response: AxiosResponse<ApiResponse<Order>> = await httpClient.patch(
    `/api/order/${orderId}`,
    body
  );
  return normalizeOrder(response.data.data);
}

/**
 * Confirm order for processing
 * @param orderId - ID of order to confirm
 * @returns Promise resolving to confirmed order object
 * @throws {Error} When order confirmation fails
 * @example
 * ```typescript
 * const confirmed = await confirmOrder('order123');
 * console.log('Order confirmed:', confirmed.id);
 * ```
 */
export async function confirmOrder(orderId: string): Promise<Order> {
  const response: AxiosResponse<ApiResponse<Order>> = await httpClient.post(
    `/api/order/${orderId}/confirm`
  );
  return normalizeOrder(response.data.data);
}

/**
 * Cancel order with optional reason
 * @param orderId - ID of order to cancel
 * @param reason - Optional reason for cancellation
 * @returns Promise resolving to cancelled order object
 * @throws {Error} When order cancellation fails
 * @example
 * ```typescript
 * const cancelled = await cancelOrder('order123', 'Customer requested');
 * console.log('Order cancelled:', cancelled.status);
 * ```
 */
export async function cancelOrder(orderId: string, reason?: string): Promise<Order> {
  const response: AxiosResponse<ApiResponse<Order>> = await httpClient.post(
    `/api/order/${orderId}/cancel`,
    { reason }
  );
  // Normalise like every other order fn — without this the cancelled order comes
  // back in raw snake_case, leaving the status pill blank and the courier check
  // broken until a manual refresh.
  return normalizeOrder(response.data.data ?? response.data);
}

/**
 * Book courier for order delivery
 * @param orderId - ID of order to book courier for
 * @param payload - Courier booking details including service type and address
 * @returns Promise resolving to booking result with tracking info
 * @throws {Error} When courier booking fails
 * @example
 * ```typescript
 * const booking = await bookCourier('order123', { 
 *   service: 'express', 
 *   address: '123 Main St' 
 * });
 * console.log('Tracking:', booking.trackingNumber);
 * ```
 */
export async function bookCourier(
  orderId: string,
  payload: CourierBookingPayload
): Promise<CourierBookingResult> {
  const response: AxiosResponse<ApiResponse<CourierBookingResult>> = await httpClient.post(
    `/api/order/${orderId}/courier`,
    payload
  );
  return response.data.data;
}

/**
 * Pre-check whether a courier can deliver to this order's destination.
 * Read-only: nothing is booked, and the server never guesses a verdict.
 * @param orderId - ID of the order to check
 * @param provider - Optional courier to check; defaults to the shop's AI default
 */
export async function getCourierEligibility(
  orderId: string,
  provider?: string
): Promise<CourierEligibility> {
  const response: AxiosResponse<ApiResponse<CourierEligibility>> = await httpClient.get(
    `/api/order/${orderId}/courier/eligibility`,
    { params: provider ? { provider } : undefined }
  );
  return response.data.data;
}

/**
 * Get delivery settings configuration
 * @returns Promise resolving to delivery settings object
 * @throws {Error} When delivery settings cannot be retrieved
 * @example
 * ```typescript
 * const settings = await getDeliverySettings();
 * console.log('Default provider:', settings.defaultProvider);
 * ```
 */
export async function getDeliverySettings(): Promise<DeliverySettings> {
  const response: AxiosResponse<ApiResponse<DeliverySettings>> = await httpClient.get('/api/shop/delivery/settings');
  return response.data.data;
}

/**
 * Connect delivery provider service
 * @param payload - Provider connection details including credentials and settings
 * @returns Promise that resolves when connection completes
 * @throws {Error} When provider connection fails
 * @example
 * ```typescript
 * await connectDeliveryProvider({ 
 *   provider: 'fedex', 
 *   apiKey: 'key123' 
 * });
 * ```
 */
export async function connectDeliveryProvider(
  payload: ConnectDeliveryProviderRequest
): Promise<void> {
  await httpClient.post('/api/shop/delivery/connect', payload);
}

/**
 * Disconnect delivery provider service
 * @param provider - Provider type to disconnect
 * @returns Promise that resolves when disconnection completes
 * @throws {Error} When provider disconnection fails
 * @example
 * ```typescript
 * await disconnectDeliveryProvider('fedex');
 * // Provider disconnected
 * ```
 */
export async function disconnectDeliveryProvider(provider: DeliveryProvider): Promise<void> {
  await httpClient.post('/api/shop/delivery/disconnect', { provider });
}

/**
 * Toggle delivery provider active status
 * @param provider - Provider type to toggle
 * @param isActive - Whether provider should be active
 * @returns Promise that resolves when toggle completes
 * @throws {Error} When provider toggle fails
 * @example
 * ```typescript
 * await toggleDeliveryProvider('fedex', true);
 * // Provider is now active
 * ```
 */
export async function toggleDeliveryProvider(provider: DeliveryProvider, isActive: boolean): Promise<void> {
  await httpClient.post('/api/shop/delivery/toggle', { provider, is_active: isActive });
}

/**
 * Update delivery settings configuration
 * @param settings - Delivery settings including charges, COD options, and pricing
 * @returns Promise that resolves when settings are updated
 * @throws {Error} When delivery settings update fails
 * @example
 * ```typescript
 * await updateDeliverySettings({ 
 *   default_delivery_charge: 10, 
 *   cod_enabled: true 
 * });
 * ```
 */
export async function updateDeliverySettings(settings: {
  default_delivery_charge?: number;
  cod_enabled?: boolean;
  cod_charge?: number;
  non_refundable?: boolean;
  area_pricing?: unknown[];
  weight_tiers?: unknown[];
}): Promise<void> {
  await httpClient.put('/api/shop/delivery/settings', settings);
}

export async function testDeliveryConnection(provider: DeliveryProvider): Promise<void> {
  await httpClient.post('/api/shop/delivery/test', { provider });
}

/** Activate a connected courier after its pickup readiness checks pass. */
export async function activateDeliveryProvider(provider: DeliveryProvider): Promise<DeliveryProviderStatus> {
  const response: AxiosResponse<ApiEnvelope<DeliveryProviderStatus>> = await httpClient.post(
    '/api/shop/delivery/activate',
    { provider },
  );
  return unwrapApiData(response);
}

/** Deactivate a courier and clear any AI-default assignment server-side. */
export async function deactivateDeliveryProvider(provider: DeliveryProvider): Promise<DeliveryProviderStatus> {
  const response: AxiosResponse<ApiEnvelope<DeliveryProviderStatus>> = await httpClient.post(
    '/api/shop/delivery/deactivate',
    { provider },
  );
  return unwrapApiData(response);
}

/** Make one ACTIVE courier the shop's AI default. */
export async function setAiDefaultDeliveryProvider(provider: DeliveryProvider): Promise<DeliveryProviderStatus> {
  const response: AxiosResponse<ApiEnvelope<DeliveryProviderStatus>> = await httpClient.post(
    '/api/shop/delivery/ai-default',
    { provider },
  );
  return unwrapApiData(response);
}

/** List the shop's saved pickup locations. */
export async function getPickupLocations(): Promise<PickupLocation[]> {
  const response: AxiosResponse<ApiEnvelope<PickupLocation[] | { locations?: PickupLocation[] }>> = await httpClient.get(
    '/api/shop/delivery/pickup-locations',
  );
  return unwrapList<PickupLocation>(response, 'locations');
}

/** Create a pickup location for the shop. */
export async function createPickupLocation(payload: PickupLocationPayload): Promise<PickupLocation> {
  const response: AxiosResponse<ApiEnvelope<PickupLocation>> = await httpClient.post(
    '/api/shop/delivery/pickup-locations',
    payload,
  );
  return unwrapApiData(response);
}

/** Update a pickup location. The pickup API accepts the location id in the body. */
export async function updatePickupLocation(
  locationId: string,
  payload: PickupLocationPayload,
): Promise<PickupLocation> {
  const response: AxiosResponse<ApiEnvelope<PickupLocation>> = await httpClient.put(
    '/api/shop/delivery/pickup-locations',
    { ...payload, id: locationId },
  );
  return unwrapApiData(response);
}

/** Sync a saved pickup location into a provider-specific pickup store/mapping. */
export async function syncProviderPickup(
  provider: DeliveryProvider,
  payload: ProviderPickupSyncRequest = {},
): Promise<DeliveryProviderStatus> {
  const response: AxiosResponse<ApiEnvelope<DeliveryProviderStatus>> = await httpClient.post(
    `/api/shop/delivery/${provider}/pickup/sync`,
    payload,
  );
  return unwrapApiData(response);
}

/** Fetch provider-specific area options. */
export async function getProviderAreas(provider: DeliveryProvider): Promise<DeliveryLocationOption[]> {
  const response: AxiosResponse<ApiEnvelope<DeliveryLocationOption[] | { areas?: DeliveryLocationOption[] }>> = await httpClient.get(
    `/api/shop/delivery/${provider}/areas`,
  );
  return unwrapList<DeliveryLocationOption>(response, 'areas');
}

/** Fetch Pathao's city list for the pickup selector. */
export async function getPathaoCities(): Promise<DeliveryLocationOption[]> {
  const response: AxiosResponse<ApiEnvelope<DeliveryLocationOption[] | { cities?: DeliveryLocationOption[] }>> = await httpClient.get(
    '/api/shop/delivery/pathao/cities',
  );
  return unwrapList<DeliveryLocationOption>(response, 'cities');
}

/** Fetch Pathao zones for a selected city. */
export async function getPathaoZones(cityId: string | number): Promise<DeliveryLocationOption[]> {
  const response: AxiosResponse<ApiEnvelope<DeliveryLocationOption[] | { zones?: DeliveryLocationOption[] }>> = await httpClient.get(
    `/api/shop/delivery/pathao/cities/${encodeURIComponent(String(cityId))}/zones`,
  );
  return unwrapList<DeliveryLocationOption>(response, 'zones');
}

/** Fetch Pathao areas for a selected zone. */
export async function getPathaoAreas(zoneId: string | number): Promise<DeliveryLocationOption[]> {
  const response: AxiosResponse<ApiEnvelope<DeliveryLocationOption[] | { areas?: DeliveryLocationOption[] }>> = await httpClient.get(
    `/api/shop/delivery/pathao/zones/${encodeURIComponent(String(zoneId))}/areas`,
  );
  return unwrapList<DeliveryLocationOption>(response, 'areas');
}


