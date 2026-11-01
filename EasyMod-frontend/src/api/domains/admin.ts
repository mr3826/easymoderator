/**
 * Admin (operations panel) API Domain
 * All calls hit /api/admin/* and require a platform-admin role on the backend.
 */

import { httpClient } from '@/shared/lib/http/client';
import type { AxiosResponse } from 'axios';
import type { ApiResponse } from '../types/common';

export type AdminDashboard = {
  shops: { total: number; active: number; shuru: number; suspended: number };
  today: {
    messages: number; aiAutoReplies: number; orders: number;
    failedAiReplies: number | null; courierFailures: number | null;
    estimatedAiCost: number | null; systemErrors: number | null;
  };
  generatedAt: string;
};

export type AdminShopRow = {
  id: string; shopName: string;
  owner: { name: string | null; email: string | null; phone: string | null } | null;
  plan: string | null; status: string | null;
  channelCount: number; conversationsUsed: number | null; conversationsLimit: number | null;
  createdAt: string;
};

export type Paginated<T> = { items: T[]; total: number; page: number; limit: number };

async function get<T>(url: string, params?: Record<string, unknown>): Promise<T> {
  const res: AxiosResponse<ApiResponse<T>> = await httpClient.get(url, params ? { params } : undefined);
  return res.data.data;
}
async function patch<T>(url: string, body?: unknown): Promise<T> {
  const res: AxiosResponse<ApiResponse<T>> = await httpClient.patch(url, body ?? {});
  return res.data.data;
}
async function post<T>(url: string, body?: unknown): Promise<T> {
  const res: AxiosResponse<ApiResponse<T>> = await httpClient.post(url, body ?? {});
  return res.data.data;
}

export const adminApi = {
  getDashboard: () => get<AdminDashboard>('/api/admin/dashboard'),
  listShops: (params: { search?: string; page?: number; limit?: number }) =>
    get<Paginated<AdminShopRow>>('/api/admin/shops', params),
  getShop: (id: string) => get<any>(`/api/admin/shops/${id}`),
  getShopChannels: (id: string) => get<any[]>(`/api/admin/shops/${id}/channels`),
  getShopBilling: (id: string) => get<any>(`/api/admin/shops/${id}/billing`),
  getAuditLogs: (params: Record<string, string | number | undefined>) =>
    get<Paginated<any>>('/api/admin/audit-logs', params),

  setStatus: (id: string, status: 'suspended' | 'active') =>
    patch<any>(`/api/admin/shops/${id}/status`, { status }),
  changePlan: (id: string, body: { plan_code?: string; plan_name?: string }) =>
    patch<any>(`/api/admin/shops/${id}/billing`, body),
  addCredits: (id: string, amount: number, reason?: string) =>
    post<any>(`/api/admin/shops/${id}/add-credits`, { amount, reason }),
  markReconnect: (id: string, channelId: string) =>
    patch<any>(`/api/admin/shops/${id}/channels/${channelId}/reconnect`, {}),
  emergencyAiOff: (id: string) =>
    post<any>(`/api/admin/shops/${id}/ai/emergency-off`, {}),

  // Pilot intelligence rollout (Customer 360 / Order Confidence). SUPER_ADMIN writes.
  getPilotFeatures: (id: string) => get<AdminPilotFeatures>(`/api/admin/shops/${id}/pilot-features`),
  setPilotFeatures: (id: string, body: Partial<Pick<AdminPilotFeatures,
    'customer_intelligence' | 'order_confidence_mode' | 'ads_studio' | 'storefront' | 'ai_reply_shadow_meter'>>) =>
    patch<AdminPilotFeatures>(`/api/admin/shops/${id}/pilot-features`, body),
};

export type AdminPilotFeatures = {
  shop_id: string;
  customer_intelligence: boolean;
  ads_studio: boolean;
  storefront: boolean;
  ai_reply_shadow_meter: boolean;
  ai_reply_shadow_meter_enabled_at: string | null;
  order_confidence_mode: 'off' | 'shadow' | 'enforce';
  order_confidence_config: { high_value_cod_threshold: number; address_min_length: number };
  updated_by: string | null;
  updated_at: string | null;
};
