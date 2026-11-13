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
  aiModeResponseSchema,
  conversationListResponseSchema,
  conversationMessagesResponseSchema,
  conversationSchema,
  replyResponseSchema,
  type AiModeResponse,
  type Conversation,
  type ConversationListResponse,
  type ConversationMessagesResponse,
  type ReplyResponse,
} from '@/api/mobile/schemas';
import { mobileQueryKeys } from '@/api/mobile/queryKeys';
import { apiRequest } from '@/api/client';
import { retryNormalizedError, toQueryFn } from '@/api/query';
import type { NormalizedError } from '@/api/errors';
import { useAuth } from '@/auth/AuthProvider';
import { useNetworkStatus } from './useNetworkStatus';

const PAGE_SIZE = 25;

function inboxPath(page: number, status?: string): string {
  const params = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
  if (status) params.set('status', status);
  return `/api/mobile/inbox/conversations?${params.toString()}`;
}
export function useInboxConversations(
  status?: string,
): UseInfiniteQueryResult<InfiniteData<ConversationListResponse>, NormalizedError> {
  const { user } = useAuth();
  const shopId = user?.shopId ?? null;
  const isOnline = useNetworkStatus();

  return useInfiniteQuery<ConversationListResponse, NormalizedError>({
    queryKey: mobileQueryKeys.inbox(shopId, status ?? ''),
    initialPageParam: 1,
    queryFn: ({ pageParam }) => toQueryFn(
      inboxPath(Number(pageParam), status),
      conversationListResponseSchema,
    )(),
    getNextPageParam: (lastPage) => {
      const { page, totalPages } = lastPage.pagination;
      return page < totalPages ? page + 1 : undefined;
    },
    enabled: Boolean(shopId) && isOnline,
    retry: retryNormalizedError,
  });
}
export function useConversation(conversationId: string): UseQueryResult<Conversation, NormalizedError> {
  const { user } = useAuth();
  const shopId = user?.shopId ?? null;
  const isOnline = useNetworkStatus();

  return useQuery<Conversation, NormalizedError>({
    queryKey: mobileQueryKeys.conversation(shopId, conversationId),
    queryFn: toQueryFn(
      `/api/mobile/inbox/conversations/${encodeURIComponent(conversationId)}`,
      conversationSchema,
    ),
    enabled: Boolean(shopId && conversationId) && isOnline,
    retry: retryNormalizedError,
  });
}

export function useConversationMessages(
  conversationId: string,
  page = 1,
): UseQueryResult<ConversationMessagesResponse, NormalizedError> {
  const { user } = useAuth();
  const shopId = user?.shopId ?? null;
  const isOnline = useNetworkStatus();

  return useQuery<ConversationMessagesResponse, NormalizedError>({
    queryKey: mobileQueryKeys.conversationMessages(shopId, conversationId, page),
    queryFn: toQueryFn(
      `/api/mobile/inbox/conversations/${encodeURIComponent(conversationId)}/messages?page=${page}&limit=${PAGE_SIZE}`,
      conversationMessagesResponseSchema,
    ),
    enabled: Boolean(shopId && conversationId) && isOnline,
    retry: retryNormalizedError,
  });
}

export interface SendReplyParams {
  conversationId: string;
  message: string;
  messageTag?: string;
  idempotencyKey?: string;
}

export function useSendConversationReply() {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const shopId = user?.shopId ?? null;

  return useMutation<ReplyResponse, NormalizedError, SendReplyParams>({
    mutationFn: async ({ conversationId, message, messageTag, idempotencyKey }) => {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (idempotencyKey) {
        headers['X-Idempotency-Key'] = idempotencyKey;
      }
      const result = await apiRequest(
        `/api/mobile/inbox/conversations/${encodeURIComponent(conversationId)}/reply`,
        replyResponseSchema,
        {
          method: 'POST',
          headers,
          body: { message, message_tag: messageTag, idempotencyKey },
        },
      );
      if (!result.ok) throw result.error;
      return result.data;
    },
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({
        queryKey: mobileQueryKeys.conversationMessages(shopId, variables.conversationId, 1),
      });
      void queryClient.invalidateQueries({
        queryKey: mobileQueryKeys.conversation(shopId, variables.conversationId),
      });
      void queryClient.invalidateQueries({
        queryKey: ['mobile', shopId, 'inbox'],
      });
    },
  });
}

export interface SetAiModeParams {
  conversationId: string;
  mode: 'pause' | 'resume';
}

export function useSetConversationAiMode() {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const shopId = user?.shopId ?? null;

  return useMutation<AiModeResponse, NormalizedError, SetAiModeParams>({
    mutationFn: async ({ conversationId, mode }) => {
      const result = await apiRequest(
        `/api/mobile/inbox/conversations/${encodeURIComponent(conversationId)}/ai-mode`,
        aiModeResponseSchema,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: { mode },
        },
      );
      if (!result.ok) throw result.error;
      return result.data;
    },
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({
        queryKey: mobileQueryKeys.conversation(shopId, variables.conversationId),
      });
      void queryClient.invalidateQueries({
        queryKey: mobileQueryKeys.inbox(shopId),
      });
    },
  });
}
