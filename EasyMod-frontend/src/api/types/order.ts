/**
 * Order and Delivery types
 */

export interface OrderItem {
  productId: string;
  productName: string;
  quantity: number;
  price: number;
}

export interface DeliveryAddress {
  division: string;
  district: string;
  upazila: string;
  street_address: string;
  zone?: 'inside_dhaka' | 'sub_dhaka' | 'outside_dhaka';
}

export interface CreateOrderItemPayload {
  product_id: string;
  quantity: number;
  price: number;
}

export interface CreateOrderPayload {
  customer_name: string;
  customer_phone: string;
  delivery_address: DeliveryAddress;
  channel: string;
  items: CreateOrderItemPayload[];
  discount?: number;
  tax?: number;
  delivery_fee?: number;
  payment_status?: string;
  payment_method: string;
  note?: string;
}

export interface Order {
  id: string;
  orderNumber?: string;
  customerName: string;
  /** Verified shop-scoped customer id (FE-08) — the only safe order→conversation link. */
  customerId?: string;
  customerPhone?: string;
  deliveryAddress?: string;
  delivery_address?: DeliveryAddress;
  items: OrderItem[];
  total: number;
  status: 'draft' | 'pending' | 'confirmed' | 'processing' | 'completed' | 'delivered' | 'cancelled';
  channel: string;
  createdAt: string;
  updatedAt: string;
  rto_risk?: 'high' | 'medium' | 'low';
  payment_status?: string;
  payment_method?: string;
  fulfillment_status?: string | null;
  delivery_tracking_code?: string;
  delivery_consignment_id?: string;
  delivery_provider?: string;
  delivery_booked_at?: string;
  delivery_status?: string | null;
  delivery_dispatched_at?: string | null;
  metadata?: {
    payment_reconciliation?: {
      required?: boolean;
      code?: string | null;
    };
    [key: string]: unknown;
  } | null;
  note?: string;
}

export type DeliveryProvider = 'pathao' | 'steadfast' | 'redx';

export type DeliveryActivationStatus =
  | 'NOT_CONFIGURED'
  | 'SETUP_INCOMPLETE'
  | 'VALIDATING'
  | 'ACTIVE'
  | 'ACTION_REQUIRED';

export interface ProviderPickupMetadata {
  city_id?: string | number | null;
  zone_id?: string | number | null;
  area_id?: string | number | null;
  delivery_area_id?: string | number | null;
  pickup_store_id?: string | number | null;
  [key: string]: unknown;
}

export interface PickupLocationSummary {
  id?: string;
  shop_id?: string;
  display_name?: string | null;
  contact_name?: string | null;
  phone?: string | null;
  secondary_phone?: string | null;
  address?: string | null;
  city_name?: string | null;
  zone_name?: string | null;
  area_name?: string | null;
  postal_code?: string | null;
  city_id?: string | number | null;
  zone_id?: string | number | null;
  area_id?: string | number | null;
  provider?: string | null;
  provider_store_id?: string | null;
  is_active?: boolean;
  metadata?: Record<string, unknown>;
  is_default?: boolean;
}

export interface PickupLocation extends PickupLocationSummary {
  id: string;
  display_name: string;
  phone: string;
  address: string;
  area_name: string;
  is_default: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface PickupLocationPayload {
  display_name: string;
  contact_name?: string;
  phone: string;
  secondary_phone?: string | null;
  address: string;
  city_name?: string | null;
  zone_name?: string | null;
  area_name: string;
  postal_code?: string | null;
  is_default?: boolean;
}

export interface ProviderPickupSyncRequest {
  pickup_location_id?: string | null;
  provider_pickup_meta?: ProviderPickupMetadata;
}

export interface DeliveryLocationOption {
  id?: string | number;
  name?: string;
  name_bn?: string;
  label?: string;
  city_name?: string;
  zone_name?: string;
  area_name?: string;
  city_name_bn?: string;
  zone_name_bn?: string;
  area_name_bn?: string;
  city_id?: string | number;
  zone_id?: string | number;
  area_id?: string | number;
  [key: string]: unknown;
}

export interface DeliveryProviderStatus {
  provider: DeliveryProvider;
  display_name: string;
  is_connected: boolean;
  is_active: boolean;
  is_sandbox: boolean;
  activation_status?: DeliveryActivationStatus;
  activation_error?: string | null;
  is_ai_default?: boolean;
  missing?: string[];
  pickup_summary?: PickupLocationSummary | null;
  provider_store_id?: string | number | null;
  provider_pickup_meta?: ProviderPickupMetadata | null;
  pickup_enabled?: boolean;
  pickup_location_id?: string | null;
  pickup_store_id?: string | null;
  setup_complete?: boolean;
  metadata?: Record<string, unknown>;
  last_validated_at: string | null;
  connected_at: string | null;
}

export interface DeliveryAreaPricing {
  zone: 'inside_dhaka' | 'sub_dhaka' | 'outside_dhaka';
  charge: number;
  cod_enabled: boolean;
}

export interface DeliveryWeightTier {
  from_kg: number;
  to_kg: number;
  extra_charge: number;
}

export interface DeliveryShopSettings {
  default_delivery_charge: number;
  cod_enabled: boolean;
  cod_charge: number;
  non_refundable: boolean;
  area_pricing: DeliveryAreaPricing[];
  weight_tiers: DeliveryWeightTier[];
}

export interface DeliverySettings {
  providers: DeliveryProviderStatus[];
  settings: DeliveryShopSettings;
  pickup_locations?: PickupLocation[];
}

export interface CourierBookingPayload {
  provider: DeliveryProvider;
  recipient_name: string;
  recipient_phone: string;
  recipient_address: string;
  weight_kg?: number;
  item_description?: string;
}

export interface CourierBookingResult {
  tracking_id: string;
  consignment_id?: string;
  provider: string;
  booked_at: string;
}

/**
 * Server verdict on whether a courier can reach an order's destination.
 * UNCERTAIN and CHECK_UNAVAILABLE are honest answers, not failures — the UI
 * must show them rather than implying the destination was verified.
 */
export type CourierDestinationDecision =
  | 'SERVICEABLE'
  | 'NOT_SERVICEABLE'
  | 'UNCERTAIN'
  | 'CHECK_UNAVAILABLE';

export interface CourierEligibility {
  provider: string | null;
  decision: CourierDestinationDecision;
  reason_code: string;
  source: 'order_destination';
  checked_at: string;
  ttl_seconds: number;
}

export interface PathaoCredentials {
  client_id: string;
  client_secret: string;
  username?: string;
  password?: string;
}

export interface SteadfastCredentials {
  api_key: string;
  secret_key: string;
}

export interface RedxCredentials {
  api_key: string;
}

export type DeliveryCredentials = PathaoCredentials | SteadfastCredentials | RedxCredentials;

export interface ConnectDeliveryProviderRequest {
  provider: DeliveryProvider;
  credentials: DeliveryCredentials;
  is_sandbox?: boolean;
  metadata?: Record<string, unknown>;
}
