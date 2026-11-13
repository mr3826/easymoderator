import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from '@tanstack/react-query';

import {
  courierBookingResponseSchema,
  deliveryTrackingResponseSchema,
  problemParcelsResponseSchema,
  type CourierBookingResponse,
  type DeliveryTrackingResponse,
  type ProblemParcelsResponse,
} from '@/api/mobile/schemas';
import { mobileQueryKeys } from '@/api/mobile/queryKeys';
import { retryNormalizedError } from '@/api/query';
import { apiRequest } from '@/api/client';
import type { NormalizedError } from '@/api/errors';
import { useAuth } from '@/auth/AuthProvider';
import { useNetworkStatus } from './useNetworkStatus';

export interface BookCourierParams {
  orderId: string;
  provider?: string;
  weight_kg?: number;
  note?: string;
  idempotencyKey?: string;
}

export function useProblemParcels(params?: {
  page?: number;
  limit?: number;
  status?: string;
  provider?: string;
}): UseQueryResult<ProblemParcelsResponse, NormalizedError> {
  const { user } = useAuth();
  const shopId = user?.shopId ?? null;
  const isOnline = useNetworkStatus();

  const searchParams = new URLSearchParams();
  if (params?.page) searchParams.set('page', String(params.page));
  if (params?.limit) searchParams.set('limit', String(params.limit));
  if (params?.status) searchParams.set('status', params.status);
  if (params?.provider) searchParams.set('provider', params.provider);
  const queryStr = searchParams.toString();
  const path = `/api/mobile/courier/problems${queryStr ? `?${queryStr}` : ''}`;

  return useQuery<ProblemParcelsResponse, NormalizedError>({
    queryKey: mobileQueryKeys.problemParcels(shopId, queryStr),
    queryFn: async () => {
      const result = await apiRequest(path, problemParcelsResponseSchema);
      if (!result.ok) throw result.error;
      return result.data;
    },
    enabled: Boolean(shopId) && isOnline,
    retry: retryNormalizedError,
  });
}

export function useDeliveryTracking(orderId: string): UseQueryResult<DeliveryTrackingResponse, NormalizedError> {
  const { user } = useAuth();
  const shopId = user?.shopId ?? null;
  const isOnline = useNetworkStatus();

  return useQuery<DeliveryTrackingResponse, NormalizedError>({
    queryKey: mobileQueryKeys.deliveryTracking(shopId, orderId),
    queryFn: async () => {
      const result = await apiRequest(
        `/api/mobile/orders/${encodeURIComponent(orderId)}/tracking`,
        deliveryTrackingResponseSchema,
      );
      if (!result.ok) throw result.error;
      return result.data;
    },
    enabled: Boolean(shopId && orderId) && isOnline,
    retry: retryNormalizedError,
  });
}

export function useBookCourier() {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const shopId = user?.shopId ?? null;

  return useMutation<CourierBookingResponse, NormalizedError, BookCourierParams>({
    mutationFn: async ({ orderId, provider, weight_kg, note, idempotencyKey }) => {
      const generatedKey = idempotencyKey || `idem-courier-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      const result = await apiRequest(
        `/api/mobile/orders/${encodeURIComponent(orderId)}/book-courier`,
        courierBookingResponseSchema,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Idempotency-Key': generatedKey,
          },
          body: {
            provider: provider || undefined,
            weight_kg: weight_kg ?? undefined,
            note: note || undefined,
            idempotencyKey: generatedKey,
          },
        },
      );

      if (!result.ok) throw result.error;
      return result.data;
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: mobileQueryKeys.problemParcels(shopId) });
      queryClient.invalidateQueries({ queryKey: mobileQueryKeys.order(shopId, variables.orderId) });
      queryClient.invalidateQueries({ queryKey: mobileQueryKeys.deliveryTracking(shopId, variables.orderId) });
      queryClient.invalidateQueries({ queryKey: mobileQueryKeys.orders(shopId) });
      queryClient.invalidateQueries({ queryKey: mobileQueryKeys.attention(shopId) });
    },
  });
}
