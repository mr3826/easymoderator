/**
 * Customer 360 Lite + Sales Opportunities API Domain
 * Backend: EasyMod-backend/src/modules/customer-intelligence
 */

import { httpClient } from '@/shared/lib/http/client';
import type { AxiosResponse } from 'axios';
import type { ApiResponse } from '../types/common';
import type { ChannelType } from '../types/customer';
import type {
  Customer360Detail,
  Customer360ListResponse,
  CustomerOverview,
  DismissReason,
  Opportunity,
  OpportunityListResponse,
  OpportunityStatus,
  PilotStatus,
} from '../types/customer-intelligence';

type ListBody<T> = { success: boolean; data: T[]; total: number; page: number; pageSize: number };

/** Which pilot features are on for the current shop (always answers). */
export async function getPilotStatus(): Promise<PilotStatus> {
  const response: AxiosResponse<ApiResponse<PilotStatus>> = await httpClient.get('/api/customer-intelligence/status');
  return response.data.data;
}

export async function getCustomerOverview(): Promise<CustomerOverview> {
  const response: AxiosResponse<ApiResponse<CustomerOverview>> = await httpClient.get(
    '/api/customer-intelligence/overview',
  );
  return response.data.data;
}

export async function listCustomers360(params: {
  page?: number;
  pageSize?: number;
  search?: string;
  phone?: string;
  channel_type?: ChannelType;
  view?: 'all' | 'opportunities';
} = {}): Promise<Customer360ListResponse> {
  const response: AxiosResponse<ListBody<Customer360ListResponse['data'][number]>> = await httpClient.get(
    '/api/customer-intelligence/customers',
    { params },
  );
  const body = response.data;
  return { data: body.data ?? [], total: body.total ?? 0, page: body.page ?? 1, pageSize: body.pageSize ?? 20 };
}

export async function getCustomer360(customerId: string): Promise<Customer360Detail> {
  const response: AxiosResponse<ApiResponse<Customer360Detail>> = await httpClient.get(
    `/api/customer-intelligence/customers/${encodeURIComponent(customerId)}`,
  );
  return response.data.data;
}

export async function listOpportunities(params: {
  status?: 'LIVE' | OpportunityStatus;
  page?: number;
  pageSize?: number;
} = {}): Promise<OpportunityListResponse> {
  const response: AxiosResponse<ListBody<Opportunity>> = await httpClient.get(
    '/api/customer-intelligence/opportunities',
    { params },
  );
  const body = response.data;
  return { data: body.data ?? [], total: body.total ?? 0, page: body.page ?? 1, pageSize: body.pageSize ?? 20 };
}

export async function markOpportunityContacted(opportunityId: string): Promise<Opportunity> {
  const response: AxiosResponse<ApiResponse<Opportunity>> = await httpClient.post(
    `/api/customer-intelligence/opportunities/${encodeURIComponent(opportunityId)}/contacted`,
    {},
  );
  return response.data.data;
}

export async function dismissOpportunity(opportunityId: string, reason: DismissReason): Promise<Opportunity> {
  const response: AxiosResponse<ApiResponse<Opportunity>> = await httpClient.post(
    `/api/customer-intelligence/opportunities/${encodeURIComponent(opportunityId)}/dismiss`,
    { reason },
  );
  return response.data.data;
}
