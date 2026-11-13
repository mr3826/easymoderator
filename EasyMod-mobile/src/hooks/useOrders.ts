import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type UseInfiniteQueryResult,
  type UseQueryResult,
} from '@tanstack/react-query';

import {
  customerRiskResponseSchema,
  orderActionResponseSchema,
  orderDetailSchema,
  orderListResponseSchema,
  type CustomerRiskSummary,
  type OrderActionResponse,
  type OrderDetail,
  type OrderListResponse,
} from '@/api/mobile/schemas';
import { mobileQueryKeys } from '@/api/mobile/queryKeys';
import { retryNormalizedError, toQueryFn } from '@/api/query';
import { apiRequest } from '@/api/client';
import type { NormalizedError } from '@/api/errors';
import { useAuth } from '@/auth/AuthProvider';
import { useNetworkStatus } from './useNetworkStatus';

const PAGE_SIZE = 25;

function ordersPath(page: number, status?: string): string {
  const params = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
  if (status) params.set('order_status', status);
  return `/api/mobile/orders?${params.toString()}`;
}

export function useOrders(status?: string): UseInfiniteQueryResult<InfiniteData<OrderListResponse>, NormalizedError> {
  const { user } = useAuth();
  const shopId = user?.shopId ?? null;
  const isOnline = useNetworkStatus();

  return useInfiniteQuery<OrderListResponse, NormalizedError>({
    queryKey: mobileQueryKeys.orders(shopId, status ?? ''),
    initialPageParam: 1,
    queryFn: ({ pageParam }) => toQueryFn(
      ordersPath(Number(pageParam), status),
      orderListResponseSchema,
    )(),
    getNextPageParam: (lastPage) => lastPage.pagination.hasNextPage
      ? lastPage.pagination.page + 1
      : undefined,
    enabled: Boolean(shopId) && isOnline,
    retry: retryNormalizedError,
  });
}

export function useOrder(orderId: string): UseQueryResult<OrderDetail, NormalizedError> {
  const { user } = useAuth();
  const shopId = user?.shopId ?? null;
  const isOnline = useNetworkStatus();

  return useQuery<OrderDetail, NormalizedError>({
    queryKey: mobileQueryKeys.order(shopId, orderId),
    queryFn: toQueryFn(`/api/mobile/orders/${encodeURIComponent(orderId)}`, orderDetailSchema),
    enabled: Boolean(shopId && orderId) && isOnline,
    retry: retryNormalizedError,
  });
}

export function useOrderRisk(orderId: string): UseQueryResult<CustomerRiskSummary, NormalizedError> {
  const { user } = useAuth();
  const shopId = user?.shopId ?? null;
  const isOnline = useNetworkStatus();

  return useQuery<CustomerRiskSummary, NormalizedError>({
    queryKey: mobileQueryKeys.orderRisk(shopId, orderId),
    queryFn: async () => {
      const result = await apiRequest(
        `/api/mobile/orders/${encodeURIComponent(orderId)}/customer-risk`,
        customerRiskResponseSchema,
      );
      if (!result.ok) throw result.error;
      return result.data.risk;
    },
    enabled: Boolean(shopId && orderId) && isOnline,
    retry: retryNormalizedError,
  });
}

export interface ConfirmOrderParams {
  orderId: string;
  idempotencyKey?: string;
}

export function useConfirmOrder() {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const shopId = user?.shopId ?? null;

  return useMutation<OrderActionResponse, NormalizedError, ConfirmOrderParams>({
    mutationFn: async ({ orderId, idempotencyKey }) => {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (idempotencyKey) {
        headers['X-Idempotency-Key'] = idempotencyKey;
      }
      const result = await apiRequest(
        `/api/mobile/orders/${encodeURIComponent(orderId)}/confirm`,
        orderActionResponseSchema,
        {
          method: 'POST',
          headers,
          body: { idempotencyKey },
        },
      );
      if (!result.ok) throw result.error;
      return result.data;
    },
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({
        queryKey: mobileQueryKeys.order(shopId, variables.orderId),
      });
      void queryClient.invalidateQueries({
        queryKey: ['mobile', 'orders', shopId],
      });
      void queryClient.invalidateQueries({
        queryKey: mobileQueryKeys.attention(shopId),
      });
      void queryClient.invalidateQueries({
        queryKey: mobileQueryKeys.today(shopId),
      });
    },
  });
}

export interface CancelOrderParams {
  orderId: string;
  reason?: string;
  idempotencyKey?: string;
}

export function useCancelOrder() {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const shopId = user?.shopId ?? null;

  return useMutation<OrderActionResponse, NormalizedError, CancelOrderParams>({
    mutationFn: async ({ orderId, reason, idempotencyKey }) => {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (idempotencyKey) {
        headers['X-Idempotency-Key'] = idempotencyKey;
      }
      const result = await apiRequest(
        `/api/mobile/orders/${encodeURIComponent(orderId)}/cancel`,
        orderActionResponseSchema,
        {
          method: 'POST',
          headers,
          body: { reason, idempotencyKey },
        },
      );
      if (!result.ok) throw result.error;
      return result.data;
    },
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({
        queryKey: mobileQueryKeys.order(shopId, variables.orderId),
      });
      void queryClient.invalidateQueries({
        queryKey: ['mobile', 'orders', shopId],
      });
      void queryClient.invalidateQueries({
        queryKey: mobileQueryKeys.attention(shopId),
      });
      void queryClient.invalidateQueries({
        queryKey: mobileQueryKeys.today(shopId),
      });
    },
  });
}

export interface ManualOrderItem {
  product_id?: string;
  id?: string;
  name?: string;
  quantity: number;
  price: number;
}

export interface CreateManualOrderParams {
  customer_name?: string;
  customer_phone: string;
  delivery_address?: string;
  items: ManualOrderItem[];
  delivery_fee?: number;
  discount?: number;
  notes?: string;
  is_draft?: boolean;
  idempotencyKey?: string;
}

export function useCreateManualOrder() {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const shopId = user?.shopId ?? null;

  return useMutation<OrderActionResponse, NormalizedError, CreateManualOrderParams>({
    mutationFn: async (params) => {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (params.idempotencyKey) {
        headers['X-Idempotency-Key'] = params.idempotencyKey;
      }
      const result = await apiRequest(
        '/api/mobile/orders/manual',
        orderActionResponseSchema,
        {
          method: 'POST',
          headers,
          body: params,
        },
      );
      if (!result.ok) throw result.error;
      return result.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ['mobile', 'orders', shopId],
      });
      void queryClient.invalidateQueries({
        queryKey: mobileQueryKeys.today(shopId),
      });
      void queryClient.invalidateQueries({
        queryKey: mobileQueryKeys.attention(shopId),
      });
    },
  });
}
