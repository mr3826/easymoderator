import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from '@tanstack/react-query';

import {
  productListResponseSchema,
  productQuickUpdateResponseSchema,
  photoDraftResponseSchema,
  type MobileProduct,
  type ProductListResponse,
  type ProductQuickUpdateResponse,
  type PhotoDraftResponse,
} from '@/api/mobile/schemas';
import { mobileQueryKeys } from '@/api/mobile/queryKeys';
import { retryNormalizedError } from '@/api/query';
import { apiRequest } from '@/api/client';
import type { NormalizedError } from '@/api/errors';
import { useAuth } from '@/auth/AuthProvider';
import { useNetworkStatus } from './useNetworkStatus';

export interface ProductsQueryParams {
  page?: number;
  limit?: number;
  stock_status?: string;
  search?: string;
}

export interface QuickUpdateStockParams {
  productId: string;
  stockDelta?: number;
  newStock?: number;
  newPrice?: number;
  inStock?: boolean;
}

export interface CreatePhotoDraftParams {
  name: string;
  price: number;
  quantity?: number;
  description?: string;
  category?: string;
  image_url?: string;
}

export function useProducts(params?: ProductsQueryParams): UseQueryResult<ProductListResponse, NormalizedError> {
  const { user } = useAuth();
  const shopId = user?.shopId ?? null;
  const isOnline = useNetworkStatus();

  const searchParams = new URLSearchParams();
  if (params?.page) searchParams.set('page', String(params.page));
  if (params?.limit) searchParams.set('limit', String(params.limit));
  if (params?.stock_status && params.stock_status !== 'all') {
    searchParams.set('stock_status', params.stock_status);
  }
  if (params?.search) searchParams.set('search', params.search);
  const queryStr = searchParams.toString();
  const path = `/api/mobile/products${queryStr ? `?${queryStr}` : ''}`;

  return useQuery<ProductListResponse, NormalizedError>({
    queryKey: mobileQueryKeys.products(shopId, params?.stock_status || 'all', params?.search || ''),
    queryFn: async () => {
      const result = await apiRequest(path, productListResponseSchema);
      if (!result.ok) throw result.error;
      return result.data;
    },
    enabled: Boolean(shopId) && isOnline,
    retry: retryNormalizedError,
  });
}

export function useQuickUpdateStock() {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const shopId = user?.shopId ?? null;

  return useMutation<ProductQuickUpdateResponse, NormalizedError, QuickUpdateStockParams, { previousData: unknown }>({
    mutationFn: async ({ productId, stockDelta, newStock, newPrice, inStock }) => {
      const result = await apiRequest(
        `/api/mobile/products/${encodeURIComponent(productId)}/quick-update`,
        productQuickUpdateResponseSchema,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
          },
          body: {
            stockDelta,
            newStock,
            newPrice,
            inStock,
          },
        },
      );

      if (!result.ok) throw result.error;
      return result.data;
    },
    onMutate: async ({ productId, stockDelta, newStock, newPrice }) => {
      // Cancel any outgoing refetches so they don't overwrite our optimistic update
      await queryClient.cancelQueries({ queryKey: ['mobile', 'products', shopId] });

      const queryCache = queryClient.getQueryCache();
      const matchingQueries = queryCache.findAll({ queryKey: ['mobile', 'products', shopId] });
      const previousData = matchingQueries.map((q) => ({ queryKey: q.queryKey, state: q.state.data }));

      // Optimistically update matching products in cache
      matchingQueries.forEach((q) => {
        const data = q.state.data as ProductListResponse | undefined;
        if (!data?.products) return;

        const updatedProducts = data.products.map((p: MobileProduct) => {
          if (p.id !== productId) return p;

          let nextQuantity = p.quantity;
          if (newStock !== undefined) {
            nextQuantity = newStock;
          } else if (stockDelta !== undefined) {
            nextQuantity = Math.max(0, p.quantity + stockDelta);
          }

          const nextPrice = newPrice !== undefined ? newPrice : p.price;
          const nextInStock = nextQuantity > 0;
          let nextStockStatus: 'in_stock' | 'low_stock' | 'out_of_stock' = 'in_stock';
          if (!nextInStock || nextQuantity <= 0) {
            nextStockStatus = 'out_of_stock';
          } else if (nextQuantity <= (p.low_stock_threshold || 5)) {
            nextStockStatus = 'low_stock';
          }

          return {
            ...p,
            quantity: nextQuantity,
            price: nextPrice,
            in_stock: nextInStock,
            stock_status: nextStockStatus,
          };
        });

        queryClient.setQueryData(q.queryKey, {
          ...data,
          products: updatedProducts,
        });
      });

      return { previousData };
    },
    onError: (_, __, context) => {
      // Rollback on error
      if (context?.previousData && Array.isArray(context.previousData)) {
        context.previousData.forEach((item) => {
          queryClient.setQueryData(item.queryKey, item.state);
        });
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['mobile', 'products', shopId] });
      queryClient.invalidateQueries({ queryKey: mobileQueryKeys.attention(shopId) });
      queryClient.invalidateQueries({ queryKey: mobileQueryKeys.today(shopId) });
    },
  });
}

export function usePhotoDraft() {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const shopId = user?.shopId ?? null;

  return useMutation<PhotoDraftResponse, NormalizedError, CreatePhotoDraftParams>({
    mutationFn: async ({ name, price, quantity, description, category, image_url }) => {
      const result = await apiRequest(
        '/api/mobile/products/photo-draft',
        photoDraftResponseSchema,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: {
            name,
            price,
            quantity: quantity ?? 0,
            description,
            category,
            image_url,
          },
        },
      );

      if (!result.ok) throw result.error;
      return result.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mobile', 'products', shopId] });
      queryClient.invalidateQueries({ queryKey: mobileQueryKeys.attention(shopId) });
      queryClient.invalidateQueries({ queryKey: mobileQueryKeys.today(shopId) });
    },
  });
}
