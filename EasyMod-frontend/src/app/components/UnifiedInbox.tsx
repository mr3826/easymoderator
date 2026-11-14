/**
 * UnifiedInbox — Page container + data orchestration.
 * UI split into:
 *   - InboxThreadList (left pane)
 *   - InboxThreadDetail (right pane)
 *   - InboxComposer (inside InboxThreadDetail)
 *
 * This file: state management, SSE wiring, data loading only (~250 lines).
 */
import { useState, useEffect, useCallback, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { AlertTriangle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { apiClient } from "@/api";
import {
  DEFAULT_AI_REPLY_MODE,
  normalizeAiReplyMode,
  type AiReplyMode,
  type Conversation,
  type ManualHandoffReason,
  type Message,
  type ResponseTemplate,
} from "@/api/types/conversation";
import type { Opportunity } from "@/api/types/customer-intelligence";
import { useSubscriptionFeatures } from "../lib/useSubscriptionFeatures";
import { useInboxSSE } from "../lib/useInboxSSE";
import { InboxThreadList } from "./inbox/InboxThreadList";
import { InboxThreadDetail } from "./inbox/InboxThreadDetail";
import CustomerContextPanel from "./inbox/CustomerContextPanel";
import { ActionQueuePanel } from "./inbox/ActionQueuePanel";

// ─── Constants ────────────────────────────────────────────────────────────────

type TFunc = (key: string, opts?: Record<string, unknown>) => string;
type AiReplyStatus = "processing" | "sent" | "failed";

const getDeliveryState = (message: Message): string | null => {
  const explicit = message.delivery_state || message.metadata?.delivery_state;
  const providerMessageId = message.provider_message_id || message.metadata?.provider_message_id;
  if (explicit) {
    if ((explicit === "SENT" || explicit === "DELIVERED") && !providerMessageId) return "HELD";
    return explicit;
  }
  if (message.metadata?.delivered === true
    && providerMessageId) {
    return "SENT";
  }
  return null;
};

const isProviderConfirmed = (message: Message): boolean => {
  const state = getDeliveryState(message);
  return (state === "SENT" || state === "DELIVERED")
    && Boolean(
      message.provider_message_id
      || message.metadata?.provider_message_id,
    );
};

const deliveryStateRank: Record<string, number> = {
  DRAFT_READY: 10,
  HELD: 10,
  SEND_PENDING: 20,
  FAILED: 30,
  DISMISSED: 30,
  SENT: 40,
  DELIVERED: 50,
};

const timestampMs = (value?: string | null): number => {
  if (!value) return NaN;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : NaN;
};

const mergeReadProjection = (
  conversation: Conversation,
  incoming: Pick<Conversation, "unreadCount" | "lastReadMessageId" | "lastReadMessageAt">,
): Conversation => {
  const currentReadAt = timestampMs(conversation.lastReadMessageAt);
  const incomingReadAt = timestampMs(incoming.lastReadMessageAt);
  if (Number.isFinite(currentReadAt)
    && (!Number.isFinite(incomingReadAt) || incomingReadAt < currentReadAt)) {
    return conversation;
  }
  return {
    ...conversation,
    unreadCount: incoming.unreadCount ?? conversation.unreadCount ?? 0,
    lastReadMessageId: incoming.lastReadMessageId ?? conversation.lastReadMessageId ?? null,
    lastReadMessageAt: incoming.lastReadMessageAt || conversation.lastReadMessageAt || null,
  };
};

const mergeConversationLists = (
  serverConversations: Conversation[],
  liveConversations: Conversation[],
  revisions: Record<string, number>,
  requestRevisions: Map<string, number>,
): Conversation[] => {
  const liveById = new Map(liveConversations.map((conversation) => [conversation.id, conversation]));
  const serverIds = new Set(serverConversations.map((conversation) => conversation.id));
  const merged = serverConversations.map((conversation) => {
    const live = liveById.get(conversation.id);
    const wasUpdatedDuringRequest = live
      && (revisions[conversation.id] || 0) > (requestRevisions.get(conversation.id) || 0);
    return wasUpdatedDuringRequest ? { ...conversation, ...live } : conversation;
  });
  const liveOnly = liveConversations.filter((conversation) => (
    !serverIds.has(conversation.id)
      && (revisions[conversation.id] || 0) > (requestRevisions.get(conversation.id) || 0)
  ));
  return [...merged, ...liveOnly];
};

const mergeMessageLifecycle = (current: Message, incoming: Message): Message => {
  const currentState = getDeliveryState(current);
  const incomingState = getDeliveryState(incoming);
  const currentRank = deliveryStateRank[currentState || ""] || 0;
  const incomingRank = deliveryStateRank[incomingState || ""] || 0;
  const keepCurrentLifecycle = isProviderConfirmed(current)
    && (!isProviderConfirmed(incoming) || incomingRank < currentRank)
    || currentState === "DISMISSED" && incomingState !== "SENT" && incomingState !== "DELIVERED"
    || incomingRank < currentRank;

  if (keepCurrentLifecycle) {
    return {
      ...current,
      ...incoming,
      delivery_state: current.delivery_state,
      provider_message_id: current.provider_message_id,
      delivery_source: current.delivery_source,
      metadata: { ...(incoming.metadata || {}), ...(current.metadata || {}) },
    };
  }
  return {
    ...current,
    ...incoming,
    metadata: { ...(current.metadata || {}), ...(incoming.metadata || {}) },
  };
};

const AI_REPLY_MODE_LABEL_KEYS: Record<AiReplyMode, string> = {
  AUTO: "inbox.mode.auto",
  DRAFT: "inbox.mode.draft",
  MANUAL: "inbox.mode.manual",
};

/** Literal keys — never build a t() key by interpolation (coverage test). */
const TAKEOVER_REASON_LABEL_KEYS: Record<ManualHandoffReason, string> = {
  manual_takeover: "inbox.takeoverReason.manualTakeover",
  customer_request: "inbox.takeoverReason.customerRequest",
  phone_call: "inbox.takeoverReason.phoneCall",
  order_issue: "inbox.takeoverReason.orderIssue",
  other: "inbox.takeoverReason.other",
};

const TAKEOVER_REASONS: ManualHandoffReason[] = [
  "manual_takeover",
  "customer_request",
  "phone_call",
  "order_issue",
  "other",
];

const getAiReplyStatus = (
  messages: Message[],
  mode: AiReplyMode,
  conversation?: Conversation | null,
): AiReplyStatus | null => {
  if (mode !== "AUTO") return null;
  if (conversation?.status === "closed" || conversation?.hitl === true) return null;

  const lastCustomerMessage = [...messages].reverse().find((message) => message.sender === "customer");
  if (!lastCustomerMessage) return null;
  const hasAuthoritativeProcessingState = typeof conversation?.ai_is_replying === "boolean";
  const lastAgentMessage = [...messages].reverse().find((message) => message.sender === "agent");
  const lastAiMessage = [...messages].reverse().find((message) => message.sender === "ai");

  if (!lastAiMessage) {
    if (hasAuthoritativeProcessingState) return conversation.ai_is_replying ? "processing" : null;
    if (lastAgentMessage && lastCustomerMessage) {
      const agentAfterCustomer =
        new Date(lastAgentMessage.created_at) > new Date(lastCustomerMessage.created_at);
      if (agentAfterCustomer) return null;
    }
    return "processing";
  }

  const customerAfterAi =
    lastCustomerMessage &&
    new Date(lastCustomerMessage.created_at) > new Date(lastAiMessage.created_at);
  const agentAfterCustomer =
    lastAgentMessage &&
    lastCustomerMessage &&
    new Date(lastAgentMessage.created_at) > new Date(lastCustomerMessage.created_at);

  if (customerAfterAi) {
    if (agentAfterCustomer) return null;
    return hasAuthoritativeProcessingState
      ? conversation.ai_is_replying ? "processing" : null
      : "processing";
  }

  const deliveryState = getDeliveryState(lastAiMessage);
  const deliveryStatus = lastAiMessage.metadata?.delivery_status;
  if (deliveryState === "FAILED" || deliveryStatus === "failed") return "failed";
  if (isProviderConfirmed(lastAiMessage)) return "sent";
  if (hasAuthoritativeProcessingState && conversation.ai_is_replying === false) return null;
  if (deliveryState === "GENERATING" || deliveryState === "SEND_PENDING" || deliveryStatus === "pending") return "processing";
  if (hasAuthoritativeProcessingState && conversation.ai_is_replying) return "processing";
  return null;
};

const needsMerchantReply = (conversation: Conversation): boolean => (
  conversation.needs_merchant_reply
    ?? (conversation.hitl === true || conversation.hasAiSuggestion === true)
);

// Quick-reply fallback templates. FE-01: these contain NO business facts.
// A fallback may only (a) promise to check and follow up, or (b) ask the
// customer for information. Order/payment/stock/courier/charge/return claims
// must come from merchant-authored templates or authoritative reads — never
// from code defaults, because the composer inserts them even when the
// templates API failed to load. Invariants enforced by
// src/test/QuickReplySafety.test.ts.
export const buildFallbackTemplates = (t: TFunc): ResponseTemplate[] => [
  { id: "fallback-check", name: t("inbox.templates.checkNow"), content: "আমি সঠিক তথ্যটা চেক করে নিচ্ছি 🙏" },
  { id: "fallback-received", name: t("inbox.templates.replySoon"), content: "আপনার বার্তা পেয়েছি — খুব শীঘ্রই উত্তর দিচ্ছি।" },
  { id: "fallback-details", name: t("inbox.templates.askDetails"), content: "একটা তথ্য দরকার ছিল, একটু বলবেন? 🙏" },
  { id: "fallback-address", name: t("inbox.templates.needAddress"), content: "ঠিকানা আর মোবাইল নম্বরটা পাঠিয়ে দিলে সুবিধা হতো 🙏" },
  { id: "fallback-thanks", name: t("inbox.templates.thankYou"), content: "ধন্যবাদ! 🙏" },
];

const META_CHANNELS = ["facebook", "messenger"];
const INBOX_CONVERSATION_PAGE_SIZE = 50;

type InboxFilterTab = "all" | "needs_review" | "closed";

const parseInboxPage = (value: string | null): number => {
  const page = Number(value);
  return Number.isSafeInteger(page) && page > 0 ? page : 1;
};

const parseInboxFilter = (value: string | null): InboxFilterTab => (
  value === "needs_review" || value === "closed" ? value : "all"
);

// ─── Component ────────────────────────────────────────────────────────────────

export default function UnifiedInbox() {
  const { t, i18n } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const initialSearchParams = new URLSearchParams(location.search);
  const initialPage = parseInboxPage(initialSearchParams.get("page"));
  const initialFilter = parseInboxFilter(initialSearchParams.get("tab"));

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedConversation, setSelectedConversation] = useState<Conversation | null>(null);
  const [currentPage, setCurrentPage] = useState(initialPage);
  const [totalConversations, setTotalConversations] = useState(0);
  const [conversationPageSize, setConversationPageSize] = useState(INBOX_CONVERSATION_PAGE_SIZE);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loadingConversations, setLoadingConversations] = useState(true);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [filterTab, setFilterTab] = useState<InboxFilterTab>(initialFilter);
  const [togglingHITL, setTogglingHITL] = useState(false);
  const [dismissedSuggestionId, setDismissedSuggestionId] = useState<string | null>(null);
  const [messagesPage, setMessagesPage] = useState(1);
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const [loadingMoreMessages, setLoadingMoreMessages] = useState(false);
  const [mobilePanelOpen, setMobilePanelOpen] = useState(false);
  // MW-V1: customer-context panel visibility (persistent column on xl+, sheet below).
  const [contextOpen, setContextOpen] = useState(false);
  const [templates, setTemplates] = useState<ResponseTemplate[]>([]);
  const [loadingTemplates, setLoadingTemplates] = useState(false);
  const [resolvingConversation, setResolvingConversation] = useState(false);
  const [showResolveDialog, setShowResolveDialog] = useState(false);
  const [resolveNote, setResolveNote] = useState("");
  const [sseConnected, setSseConnected] = useState(true);
  const sseEverConnectedRef = useRef(false);
  // ADR-0013 §6: shop-wide stop survives a conversation switch; SSE keeps it fresh.
  const [emergencyStopActive, setEmergencyStopActive] = useState(false);
  // ADR-0013 §8: optional manual-takeover reason (fixed list).
  const [takeoverOpen, setTakeoverOpen] = useState(false);
  const [takeoverReason, setTakeoverReason] = useState<ManualHandoffReason>("manual_takeover");
  const [aiReplyMode, setAiReplyMode] = useState<AiReplyMode>(DEFAULT_AI_REPLY_MODE);
  const [aiReplyStatuses, setAiReplyStatuses] = useState<Record<string, AiReplyStatus>>({});
  const aiReplyModeRef = useRef<AiReplyMode>(DEFAULT_AI_REPLY_MODE);
  const aiReplyModeRevisionRef = useRef(0);
  const locationSearchRef = useRef(location.search);
  const currentPageRef = useRef(initialPage);
  const filterTabRef = useRef<InboxFilterTab>(initialFilter);
  const lastLoadedPageRef = useRef<number | null>(null);
  const conversationRequestRef = useRef(0);
  const failedPageRef = useRef<number | null>(null);
  const syncPageSelectionRef = useRef(false);
  const navigateRef = useRef(navigate);
  const tRef = useRef(t);
  const selectedConversationRef = useRef<Conversation | null>(null);
  const conversationsRef = useRef<Conversation[]>([]);
  const messagesRef = useRef<Message[]>([]);
  const conversationProjectionRevisionRef = useRef<Record<string, number>>({});
  const liveMessageIdsRef = useRef<Set<string>>(new Set());
  const seenMessageIdsRef = useRef<Set<string>>(new Set());
  const readWatermarkRef = useRef<Record<string, string>>({});
  const readRequestRef = useRef<Record<string, number>>({});
  const latestInboundAtRef = useRef<Record<string, number>>({});
  const messageRequestRef = useRef(0);
  const pendingManualMessageIdsRef = useRef(new Map<string, string>());
  const providerConfirmedMessageIdsRef = useRef(new Set<string>());
  const shownManualDeliveryToastIdsRef = useRef(new Set<string>());

  const loadMessagesAbortRef = useRef<AbortController | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // P+03: the action queue is a server read model; any SSE fact it is derived
  // from (hitl, delivery state, conversation changes) re-pulls it through the
  // refresh function the panel registers on mount.
  const actionQueueRefreshRef = useRef<null | (() => void)>(null);
  const registerActionQueueRefresh = useCallback((refresh: () => void) => {
    actionQueueRefreshRef.current = refresh;
  }, []);
  const refreshActionQueue = useCallback(() => { actionQueueRefreshRef.current?.(); }, []);

  const { features: planFeatures } = useSubscriptionFeatures();
  const PAGE_SIZE = 30;

  const quickReplyTemplates = templates.length > 0 ? templates : buildFallbackTemplates(t);

  const updateSearchParams = useCallback((updates: Partial<Record<"tab" | "page" | "conversation", string | null>>) => {
    const params = new URLSearchParams(locationSearchRef.current);
    Object.entries(updates).forEach(([key, value]) => {
      if (value) params.set(key, value);
      else params.delete(key);
    });
    const serialized = params.toString();
    const nextSearch = serialized ? `?${serialized}` : "";
    if (nextSearch === locationSearchRef.current) return;
    locationSearchRef.current = nextSearch;
    navigateRef.current({ search: nextSearch }, { replace: true });
  }, []);

  useEffect(() => {
    selectedConversationRef.current = selectedConversation;
  }, [selectedConversation]);

  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    navigateRef.current = navigate;
  }, [navigate]);

  useEffect(() => {
    tRef.current = t;
  }, [t]);

  // ─── Data loading ──────────────────────────────────────────────────────────

  const loadConversations = useCallback(async (requestedPage = currentPageRef.current) => {
    const page = Math.max(1, requestedPage);
    const requestId = ++conversationRequestRef.current;
    const modeRevision = aiReplyModeRevisionRef.current;
    const requestRevisions = new Map(Object.entries(conversationProjectionRevisionRef.current));
    try {
      setLoadingConversations(true);
      setError(null);
      const result = await apiClient.getConversations({ page, limit: INBOX_CONVERSATION_PAGE_SIZE });
      if (requestId !== conversationRequestRef.current) return;

      const pageInfo = result as typeof result & {
        total?: number;
        page?: number;
        pageSize?: number;
        totalPages?: number;
        pagination?: { total?: number; page?: number; pageSize?: number; totalPages?: number };
      };
      const pageData = Array.isArray(result.data) ? result.data : [];
      const reportedPageSize = Number(pageInfo.pageSize ?? pageInfo.pagination?.pageSize ?? INBOX_CONVERSATION_PAGE_SIZE);
      const effectivePageSize = Number.isSafeInteger(reportedPageSize) && reportedPageSize > 0
        ? reportedPageSize
        : INBOX_CONVERSATION_PAGE_SIZE;
      const reportedTotal = Number(pageInfo.total ?? pageInfo.pagination?.total ?? pageData.length);
      const effectiveTotal = Number.isFinite(reportedTotal) && reportedTotal >= 0 ? reportedTotal : pageData.length;
      const reportedTotalPages = Number(pageInfo.totalPages ?? pageInfo.pagination?.totalPages);
      const effectiveTotalPages = Math.max(1, Number.isSafeInteger(reportedTotalPages) && reportedTotalPages > 0
        ? reportedTotalPages
        : Math.ceil(effectiveTotal / effectivePageSize));
      const responsePage = Number(pageInfo.page ?? pageInfo.pagination?.page ?? page);
      const effectivePage = Math.min(
        Number.isSafeInteger(responsePage) && responsePage > 0 ? responsePage : page,
        effectiveTotalPages,
      );

      if (effectivePage !== page) {
        currentPageRef.current = effectivePage;
        updateSearchParams({ page: effectivePage > 1 ? String(effectivePage) : null });
        await loadConversations(effectivePage);
        return;
      }

      const normalizedMode = normalizeAiReplyMode(result.ai_reply_mode);
      if (modeRevision === aiReplyModeRevisionRef.current) {
        aiReplyModeRef.current = normalizedMode;
        setAiReplyMode(normalizedMode);
      }
      const mergedConversations = mergeConversationLists(
        pageData,
        conversationsRef.current,
        conversationProjectionRevisionRef.current,
        requestRevisions,
      );
      setConversations(mergedConversations);
      setCurrentPage(effectivePage);
      currentPageRef.current = effectivePage;
      setTotalConversations(effectiveTotal);
      setConversationPageSize(effectivePageSize);
      setAiReplyStatuses((previous) => {
        const visibleIds = new Set(mergedConversations.map((conversation) => conversation.id));
        const next = Object.fromEntries(
          Object.entries(previous).filter(([conversationId]) => visibleIds.has(conversationId)),
        );
        mergedConversations.forEach((conversation) => {
          if (conversation.ai_is_replying === true && conversation.status !== "closed") {
            next[conversation.id] = "processing";
          } else {
            const status = selectedConversationRef.current?.id === conversation.id
              ? getAiReplyStatus(messagesRef.current, aiReplyModeRef.current, conversation)
              : null;
            if (status) next[conversation.id] = status;
            else delete next[conversation.id];
          }
        });
        return next;
      });
      const pageChanged = lastLoadedPageRef.current !== effectivePage;
      lastLoadedPageRef.current = effectivePage;
      const urlParams = new URLSearchParams(locationSearchRef.current);
      const linkedConversationId = urlParams.get("conversation");
      const selected = mergedConversations.find((conversation) => conversation.id === linkedConversationId)
        || (!pageChanged
          ? mergedConversations.find((conversation) => conversation.id === selectedConversationRef.current?.id)
          : undefined)
        || mergedConversations[0]
        || null;
      setSelectedConversation(selected);
      failedPageRef.current = null;
      if (syncPageSelectionRef.current || (effectivePage > 1 && !linkedConversationId)) {
        syncPageSelectionRef.current = false;
        updateSearchParams({
          page: effectivePage > 1 ? String(effectivePage) : null,
          conversation: selected?.id ?? null,
        });
      }
    } catch {
      if (requestId !== conversationRequestRef.current) return;
      failedPageRef.current = page;
      setError(tRef.current("inbox.errors.loadConversations"));
      toast.error(tRef.current("inbox.errors.loadConversations"));
    } finally {
      if (requestId === conversationRequestRef.current) setLoadingConversations(false);
    }
  }, [i18n?.language, updateSearchParams]);

  const loadConversationsRef = useRef(loadConversations);
  useEffect(() => { loadConversationsRef.current = loadConversations; });

  const loadTemplates = useCallback(async () => {
    try {
      setLoadingTemplates(true);
      const rows = await apiClient.getResponseTemplates();
      setTemplates(rows.filter((tpl) => tpl.is_active !== false));
    } catch {
      setTemplates([]);
    } finally {
      setLoadingTemplates(false);
    }
  }, []);

  const loadMessages = async (conversationId: string, page: number, signal?: AbortSignal) => {
    const requestId = ++messageRequestRef.current;
    try {
      if (page === 1) setLoadingMessages(true);
      const result = await apiClient.getMessages(conversationId, { page, limit: PAGE_SIZE, signal });
      if (signal?.aborted
        || requestId !== messageRequestRef.current
        || (selectedConversationRef.current && selectedConversationRef.current.id !== conversationId)) return;
      const projectedMessages = [...result.messages, ...(result.suggestions || [])]
        .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
      projectedMessages.forEach((message) => seenMessageIdsRef.current.add(message.id));
      const latestInbound = [...projectedMessages].reverse().find((message) => message.sender === "customer");
      const latestInboundAt = timestampMs(latestInbound?.created_at);
      if (Number.isFinite(latestInboundAt)) {
        latestInboundAtRef.current[conversationId] = Math.max(
          latestInboundAtRef.current[conversationId] || 0,
          latestInboundAt,
        );
      }
      if (page === 1) {
        setMessages((previous) => {
          const projectedIds = new Set(projectedMessages.map((message) => message.id));
          projectedIds.forEach((id) => liveMessageIdsRef.current.delete(id));
          const mergedProjectedMessages = projectedMessages.map((message) => {
            const previousMessage = previous.find((item) => item.id === message.id);
            return previousMessage ? mergeMessageLifecycle(previousMessage, message) : message;
          });
          const preservedLiveMessages = previous.filter((message) => (
            liveMessageIdsRef.current.has(message.id) && !projectedIds.has(message.id)
          ));
          return [...mergedProjectedMessages, ...preservedLiveMessages]
            .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
        });
        const status = getAiReplyStatus(
          projectedMessages,
          aiReplyModeRef.current,
          selectedConversationRef.current,
        );
        setAiReplyStatuses((prev) => {
          const next = { ...prev };
          if (status) next[conversationId] = status;
          else delete next[conversationId];
          return next;
        });
      } else {
        setMessages((prev) => [...projectedMessages, ...prev.filter((message) => !projectedMessages.some((item) => item.id === message.id))]);
      }
      setHasMoreMessages(result.pagination.page < result.pagination.totalPages);
    } catch (error) {
      if ((error as { name?: string })?.name === "CanceledError" || (error as { name?: string })?.name === "AbortError") return;
      toast.error(t("inbox.errors.loadMessages"));
    } finally {
      if (requestId === messageRequestRef.current) {
        setLoadingMessages(false);
        setLoadingMoreMessages(false);
      }
    }
  };

  const loadMessagesRef = useRef(loadMessages);
  useEffect(() => { loadMessagesRef.current = loadMessages; });

  const loadOlderMessages = async () => {
    const conversationId = selectedConversation?.id;
    if (!conversationId || loadingMoreMessages || !hasMoreMessages) return;
    const nextPage = messagesPage + 1;
    setLoadingMoreMessages(true);
    await loadMessages(conversationId, nextPage);
    if (selectedConversation?.id === conversationId) {
      setMessagesPage(nextPage);
    }
  };

  const showManualReplyProviderSuccess = useCallback((
    messageId: string,
    conversationId: string,
    deliveryState: "SENT" | "DELIVERED",
  ) => {
    if (shownManualDeliveryToastIdsRef.current.has(messageId)) return;
    shownManualDeliveryToastIdsRef.current.add(messageId);
    if (shownManualDeliveryToastIdsRef.current.size > 100) {
      const oldest = shownManualDeliveryToastIdsRef.current.values().next().value;
      if (oldest) shownManualDeliveryToastIdsRef.current.delete(oldest);
    }

    const normalizedSearch = searchQuery.trim().toLowerCase();
    const nextReplyTask = conversationsRef.current.find((conversation) => {
      if (conversation.id === conversationId
        || conversation.status === "closed"
        || conversation.needs_merchant_reply !== true
        || filterTab === "closed") return false;
      if (filterTab === "needs_review" && conversation.needs_merchant_reply !== true) return false;
      if (!normalizedSearch) return true;
      return [conversation.customer?.name, conversation.title, conversation.lastMessage]
        .some((value) => typeof value === "string" && value.toLowerCase().includes(normalizedSearch));
    });

    const options = nextReplyTask ? {
      action: {
        label: t("inbox.openNextReplyTask"),
        onClick: () => {
          if (selectedConversationRef.current?.id !== nextReplyTask.id) {
            setMessages([]);
            setLoadingMessages(true);
          }
          setSelectedConversation(nextReplyTask);
          setMobilePanelOpen(true);
          updateSearchParams({ conversation: nextReplyTask.id });
        },
      },
    } : undefined;
    toast.success(t(deliveryState === "DELIVERED" ? "inbox.messageDelivered" : "inbox.messageAccepted"), options);
  }, [filterTab, searchQuery, t, updateSearchParams]);

  // ─── Effects ───────────────────────────────────────────────────────────────

  useEffect(() => {
    loadConversations();
    loadTemplates();
  }, [loadConversations, loadTemplates]);

  useEffect(() => {
    locationSearchRef.current = location.search;
    const params = new URLSearchParams(location.search);
    const nextTab = parseInboxFilter(params.get("tab"));
    if (nextTab !== filterTabRef.current) {
      filterTabRef.current = nextTab;
      setFilterTab(nextTab);
    }
    const nextPage = parseInboxPage(params.get("page"));
    if (nextPage !== currentPageRef.current) {
      currentPageRef.current = nextPage;
      syncPageSelectionRef.current = false;
      void loadConversationsRef.current(nextPage);
    }
  }, [location.search]);

  // Deep link (/inbox?conversation=<id>) from a Sales Opportunity: open that
  // thread once the list has loaded. A thread older than the first page is
  // fetched on its own; the server scopes it to this shop.
  const deepLinkedConversationId = new URLSearchParams(location.search).get("conversation");
  const deepLinkHandledRef = useRef<string | null>(null);
  useEffect(() => {
    if (!deepLinkedConversationId || loadingConversations) return;
    if (deepLinkHandledRef.current === deepLinkedConversationId) return;
    deepLinkHandledRef.current = deepLinkedConversationId;
    const inList = conversations.find((conversation) => conversation.id === deepLinkedConversationId);
    if (inList) {
      setSelectedConversation(inList);
      setMobilePanelOpen(true);
      return;
    }
    Promise.resolve(apiClient.getConversation?.(deepLinkedConversationId))
      .then((conversation) => {
        if (!conversation?.id) return;
        setSelectedConversation(conversation);
        setMobilePanelOpen(true);
      })
      .catch(() => { /* not found or not this shop's: keep the default selection */ });
  }, [deepLinkedConversationId, loadingConversations, conversations]);

  useEffect(() => {
    if (selectedConversation) {
      loadMessagesAbortRef.current?.abort();
      const controller = new AbortController();
      loadMessagesAbortRef.current = controller;
      setMessagesPage(1);
      setHasMoreMessages(false);
      void loadMessages(selectedConversation.id, 1, controller.signal);
      setDismissedSuggestionId(null);
      return () => {
        controller.abort();
        if (loadMessagesAbortRef.current === controller) loadMessagesAbortRef.current = null;
      };
    }
    return undefined;
  }, [selectedConversation?.id]);

  useEffect(() => {
    const conversationId = selectedConversation?.id;
    if (!conversationId || !messages.length || typeof apiClient.markConversationRead !== "function") return;

    const markVisibleInboundRead = () => {
      if (document.visibilityState !== "visible") return;
      if (typeof window !== "undefined" && window.innerWidth < 1024 && !mobilePanelOpen) return;
      const latestInbound = [...messages].reverse().find((message) => message.sender === "customer");
      if (!latestInbound || readWatermarkRef.current[conversationId] === latestInbound.id) return;
      readWatermarkRef.current[conversationId] = latestInbound.id;
      const requestId = (readRequestRef.current[conversationId] || 0) + 1;
      readRequestRef.current[conversationId] = requestId;
      Promise.resolve(apiClient.markConversationRead(conversationId, latestInbound.id))
        .then((updated) => {
          if (readRequestRef.current[conversationId] !== requestId) return;
          const responseReadAt = timestampMs(updated.lastReadMessageAt);
          const latestInboundAt = latestInboundAtRef.current[conversationId];
          if (Number.isFinite(responseReadAt)
            && Number.isFinite(latestInboundAt)
            && latestInboundAt > responseReadAt) return;
          setConversations((previous) => previous.map((conversation) => (
            conversation.id === conversationId ? mergeReadProjection(conversation, updated) : conversation
          )));
          setSelectedConversation((previous) => previous?.id === conversationId
            ? mergeReadProjection(previous, updated)
            : previous);
        })
        .catch(() => {
          delete readWatermarkRef.current[conversationId];
        });
    };

    markVisibleInboundRead();
    document.addEventListener("visibilitychange", markVisibleInboundRead);
    return () => document.removeEventListener("visibilitychange", markVisibleInboundRead);
  }, [selectedConversation?.id, messages, mobilePanelOpen]);

  useEffect(() => {
    if (!loadingMoreMessages) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, loadingMoreMessages]);

  // ─── SSE ───────────────────────────────────────────────────────────────────

  useInboxSSE({
    onNewMessage: useCallback(({ conversation_id, message, unread_count }) => {
      if (!message?.id || seenMessageIdsRef.current.has(message.id)) return;
      conversationProjectionRevisionRef.current[conversation_id] =
        (conversationProjectionRevisionRef.current[conversation_id] || 0) + 1;
      liveMessageIdsRef.current.add(message.id);
      const selectedId = selectedConversationRef.current?.id;
      const isSelected = selectedId === conversation_id;
      if (isSelected) seenMessageIdsRef.current.add(message.id);
      const isCustomerMessage = message.sender === "customer";
      const inboundAt = timestampMs(message.created_at);
      if (isCustomerMessage && Number.isFinite(inboundAt)) {
        latestInboundAtRef.current[conversation_id] = Math.max(
          latestInboundAtRef.current[conversation_id] || 0,
          inboundAt,
        );
      }
      const knownConversation = conversationsRef.current.find((conversation) => conversation.id === conversation_id);
      const selectedForEvent = selectedConversationRef.current?.id === conversation_id
        ? selectedConversationRef.current
        : knownConversation;
      const hitlActive = selectedForEvent?.hitl === true;
      const needsMerchantReplyForInbound = hitlActive || aiReplyMode !== "AUTO";
      const providerConfirmed = message.sender === "customer" || isProviderConfirmed(message);
      const inboundWorkflow = isCustomerMessage
        ? {
            status: "active" as const,
            needs_merchant_reply: needsMerchantReplyForInbound,
            needs_merchant_reply_reason: needsMerchantReplyForInbound
              ? (hitlActive ? "HITL_REQUIRED" : "CUSTOMER_UNANSWERED")
              : null,
            ai_is_replying: aiReplyMode === "AUTO" && !hitlActive,
          }
        : {};
      setMessages((prev) => {
        if (!isSelected) return prev;
        const existing = prev.some((item) => item.id === message.id);
        const next = existing
          ? prev.map((item) => item.id === message.id ? mergeMessageLifecycle(item, message) : item)
          : [...prev, message];
        return next.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
      });
      setAiReplyStatuses((prev) => {
        const next = { ...prev };
        if (isCustomerMessage && aiReplyMode === "AUTO" && !hitlActive) {
          next[conversation_id] = "processing";
        } else if (message.sender === "agent") {
          delete next[conversation_id];
        } else if (message.sender === "ai") {
          const status = getDeliveryState(message) === "FAILED" || message.metadata?.delivery_status === "failed"
            ? "failed"
            : getAiReplyStatus([message], aiReplyMode, selectedForEvent);
          if (status) next[conversation_id] = status;
          else delete next[conversation_id];
        }
        return next;
      });
      setConversations((prev) => {
        const exists = prev.some((conv) => conv.id === conversation_id);
        if (!exists) {
          (async () => {
            try { await loadConversationsRef.current(); } catch { /* ignore */ }
          })();
          return prev;
        }
        const next = prev.map((conv) =>
          conv.id === conversation_id
            ? {
                ...conv,
                ...inboundWorkflow,
                ...(providerConfirmed ? { updated_at: message.created_at } : {}),
                ...(message.is_transcript_message === false || !providerConfirmed ? {} : { lastMessage: message.content }),
                ...(message.sender === "ai" && message.is_transcript_message === false
                  ? {
                      hasAiSuggestion: true,
                      suggestionCount: Math.max(1, conv.suggestionCount || 0),
                      needs_merchant_reply: true,
                      needs_merchant_reply_reason: "HITL_REQUIRED",
                      ai_is_replying: false,
                    }
                  : {}),
                unreadCount: (() => {
                  const currentUnread = conv.unreadCount ?? 0;
                  if (!isCustomerMessage) return currentUnread;
                  const eventAt = timestampMs(message.created_at);
                  const readAt = timestampMs(conv.lastReadMessageAt);
                  if (Number.isFinite(eventAt) && Number.isFinite(readAt) && eventAt <= readAt) {
                    return currentUnread;
                  }
                  const reportedUnread = typeof unread_count === "number" ? unread_count : null;
                  if (reportedUnread !== null) return Math.max(currentUnread, reportedUnread);
                  return isSelected ? currentUnread : currentUnread + 1;
                })(),
              }
            : conv
        );
        return next.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
      });
      setSelectedConversation((previous) => previous?.id === conversation_id
        ? { ...previous, ...inboundWorkflow }
        : previous);
    }, [aiReplyMode]),

      onHitlChanged: useCallback(({ conversation_id, hitl, status, needs_merchant_reply: needsReply, needs_merchant_reply_reason: needsReason, ai_is_replying: aiIsReplying, assignee_id: assigneeId, assignee: assigneeInfo }: {
        conversation_id: string;
        hitl: boolean;
        status?: Conversation["status"];
        needs_merchant_reply?: boolean;
        needs_merchant_reply_reason?: string | null;
        ai_is_replying?: boolean;
        // MW-V1 D3/D4b: the ownership-carrying event source is now the service
        // itself, so a teammate's claim/assign converges every open client.
        assignee_id?: string | null;
        assignee?: { id: string; name: string | null } | null;
      }) => {
      refreshActionQueue();
      conversationProjectionRevisionRef.current[conversation_id] =
        (conversationProjectionRevisionRef.current[conversation_id] || 0) + 1;
      const workflow = {
        hitl,
        ...(status ? { status } : {}),
        ...(needsReply !== undefined ? { needs_merchant_reply: needsReply } : {}),
        ...(needsReason !== undefined ? { needs_merchant_reply_reason: needsReason } : {}),
        ...(aiIsReplying !== undefined ? { ai_is_replying: aiIsReplying } : {}),
        ...(assigneeId !== undefined ? { assignee_id: assigneeId } : {}),
        ...(assigneeInfo !== undefined ? { assignee: assigneeInfo } : {}),
      };
      setConversations((prev) =>
        prev.map((conv) => conv.id === conversation_id ? { ...conv, ...workflow } : conv)
      );
      setSelectedConversation((prev) =>
        prev?.id === conversation_id ? { ...prev, ...workflow } : prev
      );
      setAiReplyStatuses((prev) => {
        const next = { ...prev };
        delete next[conversation_id];
        return next;
      });
    }, [refreshActionQueue]),

    onAiPaused: useCallback(({ conversation_id, reason }: { conversation_id: string; reason?: string }) => {
      conversationProjectionRevisionRef.current[conversation_id] =
        (conversationProjectionRevisionRef.current[conversation_id] || 0) + 1;
      const workflow = {
        needs_merchant_reply: true,
        needs_merchant_reply_reason: "AI_PAUSED",
        ai_is_replying: false,
      };
      setConversations((prev) => prev.map((conversation) => conversation.id === conversation_id
        ? { ...conversation, ...workflow }
        : conversation));
      setSelectedConversation((conversation) => conversation?.id === conversation_id
        ? { ...conversation, ...workflow }
        : conversation);
      setAiReplyStatuses((prev) => {
        const next = { ...prev };
        delete next[conversation_id];
        return next;
      });
      if (reason) {
        toast.warning(t("inbox.aiPaused", { reason }), { duration: 6000 });
      }
    }, []),

    onMessageDeliveryUpdated: useCallback(({ conversation_id, message_id, metadata, delivery_state, provider_message_id, delivery_source, content, created_at }: {
      conversation_id: string;
      message_id: string;
      metadata: Message["metadata"];
      delivery_state?: Message["delivery_state"];
      provider_message_id?: string | null;
      delivery_source?: string | null;
      content?: string | null;
      created_at?: string | null;
    }) => {
      refreshActionQueue();
      conversationProjectionRevisionRef.current[conversation_id] =
        (conversationProjectionRevisionRef.current[conversation_id] || 0) + 1;
      const currentMessage = messages.find((message) => message.id === message_id);
      if (currentMessage
        && getDeliveryState(currentMessage) === "DISMISSED"
        && delivery_state !== "DISMISSED") return;
      const workflowConversation = conversationsRef.current.find((conversation) => conversation.id === conversation_id)
        || (selectedConversationRef.current?.id === conversation_id ? selectedConversationRef.current : null);
      if (delivery_state === "DISMISSED" && selectedConversationRef.current?.id === conversation_id) {
        // A dismissal changes the server projection for every duplicate
        // sibling. Invalidate any older page-one response before reloading it.
        messageRequestRef.current += 1;
        void loadMessagesRef.current(conversation_id, 1);
      }
      if (!currentMessage && selectedConversationRef.current?.id === conversation_id) {
        void loadMessagesRef.current(conversation_id, 1);
      }
      const incomingMessage = {
        id: message_id,
        sender: currentMessage?.sender || "ai",
        content: content ?? currentMessage?.content,
        created_at: created_at || currentMessage?.created_at || new Date().toISOString(),
        ...(delivery_state !== undefined ? { delivery_state } : {}),
        ...(provider_message_id !== undefined ? { provider_message_id } : {}),
        ...(delivery_source !== undefined ? { delivery_source } : {}),
        metadata: metadata || {},
      } as Message;
      const mergedMessage = currentMessage
        ? mergeMessageLifecycle(currentMessage, incomingMessage)
        : null;
      if (delivery_state === "FAILED") {
        pendingManualMessageIdsRef.current.delete(message_id);
      } else if (isProviderConfirmed(mergedMessage || incomingMessage)) {
        providerConfirmedMessageIdsRef.current.add(message_id);
        if (providerConfirmedMessageIdsRef.current.size > 100) {
          const oldest = providerConfirmedMessageIdsRef.current.values().next().value;
          if (oldest) providerConfirmedMessageIdsRef.current.delete(oldest);
        }
        if (pendingManualMessageIdsRef.current.has(message_id)) {
          pendingManualMessageIdsRef.current.delete(message_id);
          showManualReplyProviderSuccess(message_id, conversation_id, delivery_state === "DELIVERED" ? "DELIVERED" : "SENT");
        }
      }
      setMessages((prev) => {
        if (selectedConversationRef.current?.id !== conversation_id) return prev;
        return prev.map((message) => message.id === message_id
          ? mergeMessageLifecycle(message, incomingMessage)
          : message);
      });
      setAiReplyStatuses((prev) => {
        const next = { ...prev };
        if (mergedMessage?.sender === "agent") {
          delete next[conversation_id];
          return next;
        }
        if (mergedMessage?.sender !== "ai" || aiReplyMode !== "AUTO") return next;
        const status = getDeliveryState(mergedMessage) === "FAILED" || mergedMessage.metadata?.delivery_status === "failed"
          ? "failed"
          : getAiReplyStatus([mergedMessage], aiReplyMode, workflowConversation);
        if (status) next[conversation_id] = status;
        else delete next[conversation_id];
        return next;
      });
      if ((delivery_state === "SENT" || delivery_state === "DELIVERED" || delivery_state === "FAILED")
        && (currentMessage?.content || content)) {
        const confirmed = mergedMessage ? isProviderConfirmed(mergedMessage) : Boolean(provider_message_id);
        const delivered = (delivery_state === "SENT" || delivery_state === "DELIVERED") && confirmed;
        const isSystemEscalation = (mergedMessage?.delivery_source
          || delivery_source
          || mergedMessage?.metadata?.delivery_source) === "HITL_ESCALATION";
        const deliveredAnswer = delivered && !isSystemEscalation;
        setConversations((prev) => prev.map((conversation) => conversation.id === conversation_id
          ? {
              ...conversation,
              lastMessage: currentMessage?.content || content || conversation.lastMessage,
              ...(created_at ? { updated_at: created_at } : {}),
              ...(deliveredAnswer
                ? { needs_merchant_reply: false, needs_merchant_reply_reason: null, ai_is_replying: false }
                : isSystemEscalation
                  ? { needs_merchant_reply: true, needs_merchant_reply_reason: "HITL_REQUIRED", ai_is_replying: false }
                  : { needs_merchant_reply: true, needs_merchant_reply_reason: "PROVIDER_SEND_FAILED", ai_is_replying: false }),
              ...(deliveredAnswer
                ? {
                    suggestionCount: Math.max(0, (conversation.suggestionCount || 1) - 1),
                    hasAiSuggestion: false,
                  }
                : {}),
            }
          : conversation));
        if (deliveredAnswer) {
          setSelectedConversation((conversation) => conversation?.id === conversation_id
            ? {
                ...conversation,
                needs_merchant_reply: false,
                needs_merchant_reply_reason: null,
                ai_is_replying: false,
                suggestionCount: Math.max(0, (conversation.suggestionCount || 1) - 1),
                hasAiSuggestion: false,
              }
            : conversation);
        } else if (isSystemEscalation) {
          setSelectedConversation((conversation) => conversation?.id === conversation_id
            ? {
                ...conversation,
                needs_merchant_reply: true,
                needs_merchant_reply_reason: "HITL_REQUIRED",
                ai_is_replying: false,
              }
            : conversation);
        } else if (delivery_state === "FAILED") {
          setSelectedConversation((conversation) => conversation?.id === conversation_id
            ? {
                ...conversation,
                needs_merchant_reply: true,
                needs_merchant_reply_reason: "PROVIDER_SEND_FAILED",
                ai_is_replying: false,
              }
            : conversation);
        }
      }
    }, [aiReplyMode, messages, refreshActionQueue, showManualReplyProviderSuccess]),

    onDeliveryFailed: useCallback(({ conversation_id, message_id, reason }: { conversation_id?: string; message_id?: string; reason: string }) => {
      refreshActionQueue();
      const failedConversationId = conversation_id || selectedConversation?.id;
      const failedMessage = message_id ? messages.find((message) => message.id === message_id) : null;
      if (aiReplyMode === "AUTO" && failedMessage?.sender === "ai") {
        setAiReplyStatuses((prev) =>
          failedConversationId ? { ...prev, [failedConversationId]: "failed" } : prev
        );
      }
      if (failedConversationId) {
        setConversations((prev) => prev.map((conversation) => conversation.id === failedConversationId
          ? {
              ...conversation,
              needs_merchant_reply: true,
              needs_merchant_reply_reason: "PROVIDER_SEND_FAILED",
              ai_is_replying: false,
            }
          : conversation));
        setSelectedConversation((conversation) => conversation?.id === failedConversationId
          ? {
              ...conversation,
              needs_merchant_reply: true,
              needs_merchant_reply_reason: "PROVIDER_SEND_FAILED",
              ai_is_replying: false,
            }
          : conversation);
      }
      toast.warning(t("inbox.deliveryFailed", { reason }), { duration: 6000 });
    }, [aiReplyMode, messages, selectedConversation?.id, refreshActionQueue]),

    onAiReplyModeChanged: useCallback(({ mode }: { mode: AiReplyMode }) => {
      const normalizedMode = normalizeAiReplyMode(mode);
      aiReplyModeRevisionRef.current += 1;
      aiReplyModeRef.current = normalizedMode;
      setAiReplyMode(normalizedMode);
      setAiReplyStatuses({});
      setDismissedSuggestionId(null);
      const selectedId = selectedConversationRef.current?.id;
      if (selectedId) void loadMessagesRef.current(selectedId, 1);
    }, []),

    onChannelError: useCallback(({ display_name, message: errMsg }: { display_name: string; message: string }) => {
      toast.error(t("inbox.channelIssue", { name: display_name, message: errMsg }), { duration: 12000 });
    }, []), // eslint-disable-line react-hooks/exhaustive-deps

    onSSEOffline: useCallback(() => {
      setSseConnected(false);
    }, []),

    onSSEOnline: useCallback(() => {
      setSseConnected(true);
      if (sseEverConnectedRef.current) {
        void loadConversationsRef.current();
        const selectedId = selectedConversationRef.current?.id;
        if (selectedId) void loadMessagesRef.current(selectedId, 1);
      }
      sseEverConnectedRef.current = true;
    }, []),
    onConversationRead: useCallback(({ conversation_id, unread_count, last_read_message_id, last_read_message_at }: {
      conversation_id: string;
      unread_count: number;
      last_read_message_id?: string | null;
      last_read_message_at?: string | null;
    }) => {
      setConversations((prev) => prev.map((conversation) => {
        if (conversation.id !== conversation_id) return conversation;
        return mergeReadProjection(conversation, {
          unreadCount: unread_count,
          lastReadMessageId: last_read_message_id,
          lastReadMessageAt: last_read_message_at,
        });
      }));
      setSelectedConversation((prev) => {
        if (!prev || prev.id !== conversation_id) return prev;
        return mergeReadProjection(prev, {
          unreadCount: unread_count,
          lastReadMessageId: last_read_message_id,
          lastReadMessageAt: last_read_message_at,
        });
      });
    }, []),
    onCustomerUpdated: useCallback(({ customer_id, name, meta_channel_id }: { customer_id: string; name?: string; meta_channel_id?: string | null }) => {
      if (!name) return;
      setConversations((prev) => prev.map((conversation) => (
        conversation.customer_id === customer_id
        && (!meta_channel_id || conversation.meta_channel_id === meta_channel_id)
          ? { ...conversation, customer: conversation.customer ? { ...conversation.customer, name } : { id: customer_id, name } }
          : conversation
      )));
      setSelectedConversation((prev) => {
        if (!prev || prev.customer_id !== customer_id || !prev.customer || !name
          || (meta_channel_id && prev.meta_channel_id !== meta_channel_id)) return prev;
        return { ...prev, customer: { ...prev.customer, name } };
      });
    }, []),

    // conversation_updated is emitted by surfaces outside this hook's own
    // mutations (e.g. the mobile app) — the action queue re-pulls rather than
    // guessing which bucket moved.
    onConversationUpdated: useCallback(() => {
      refreshActionQueue();
    }, [refreshActionQueue]),

    // ADR-0013 §9: an override / purpose write changed effective config.
    onChannelSettingsChanged: useCallback(() => {
      void loadConversationsRef.current();
      const selectedId = selectedConversationRef.current?.id;
      if (selectedId) void loadMessagesRef.current(selectedId, 1);
    }, []),

    // ADR-0013 §6: the shop-wide stop engaged or resumed.
    onEmergencyStopChanged: useCallback((payload: { active: boolean }) => {
      setEmergencyStopActive(payload.active === true);
      void loadConversationsRef.current();
    }, []),
  });

  // ─── Handlers ─────────────────────────────────────────────────────────────

  const applyHitl = async (newHITL: boolean, reason?: ManualHandoffReason) => {
    if (!selectedConversation) return;
    try {
      setTogglingHITL(true);
      const response = await apiClient.updateConversation(
        selectedConversation.id,
        newHITL
          ? { hitl: true, ...(reason ? { handoff_reason: reason } : {}) }
          : { hitl: false },
      );
      const updated = {
        ...selectedConversation,
        ...response,
        hitl: newHITL,
        ai_is_replying: newHITL ? false : response.ai_is_replying,
      };
      setSelectedConversation(updated);
      setConversations((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
      setAiReplyStatuses((prev) => {
        const next = { ...prev };
        delete next[selectedConversation.id];
        return next;
      });
      // MW-V1 D4: the server writes the authoritative CONVERSATION_OWNERSHIP_UPDATE
      // audit on this PATCH; the previously client-side createAuditLog call
      // targeted a route that does not exist and is removed.
      toast.success(
        newHITL
          ? t("inbox.aiPaused")
          : aiReplyMode === "AUTO"
          ? t("inbox.aiReEnabled")
          : t("inbox.mode.manual")
      );
    } catch (error) {
      // P+03: surface the server's authoritative conflict reason (e.g. takeover
      // 409 "already assigned to another team member"); only fall back to the
      // generic label when the API gave no message. Never fabricate success.
      const serverMessage = (error as { response?: { data?: { error?: { message?: string } } } })
        ?.response?.data?.error?.message
        || (typeof (error as Error)?.message === "string"
          && (error as Error).message
          && !/request failed|status code/i.test((error as Error).message)
          ? (error as Error).message
          : "");
      toast.error(serverMessage || t("inbox.errors.updateMode"));
    } finally {
      setTogglingHITL(false);
    }
  };

  // Taking over opens the optional-reason dialog; resuming is immediate.
  const handleToggleHITL = () => {
    if (!selectedConversation) return;
    if (selectedConversation.hitl) {
      void applyHitl(false);
    } else {
      setTakeoverReason("manual_takeover");
      setTakeoverOpen(true);
    }
  };

  const confirmTakeover = () => {
    setTakeoverOpen(false);
    void applyHitl(true, takeoverReason);
  };

  // MW-V1: merge a panel-driven ownership change (canonical PATCH result) into
  // both the thread list and the live conversation immediately.
  const applyOwnershipUpdate = useCallback((updated: Conversation) => {
    setConversations((prev) => prev.map((c) => (c.id === updated.id ? { ...c, ...updated } : c)));
    setSelectedConversation((prev) => (prev?.id === updated.id ? { ...prev, ...updated } : prev));
    refreshActionQueue();
  }, [refreshActionQueue]);

  const handleResolveConversation = async () => {
    if (!selectedConversation) return;
    try {
      setResolvingConversation(true);
      const lastSeenMessageId = messages[messages.length - 1]?.id;
      const response = await apiClient.updateConversation(selectedConversation.id, {
        status: "closed",
        resolution_note: resolveNote || undefined,
        ...(lastSeenMessageId ? { last_seen_message_id: lastSeenMessageId } : {}),
      });
      const updated = {
        ...selectedConversation,
        ...response,
        status: response.status,
        hitl: response.status === "closed" ? false : response.hitl,
        needs_merchant_reply: response.needs_merchant_reply,
        needs_merchant_reply_reason: response.needs_merchant_reply_reason,
        ai_is_replying: response.ai_is_replying,
      };
      setSelectedConversation(updated);
      setConversations((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
      // MW-V1 D4: ownership/resolution transitions are audited SERVER-side.
      toast.success(response.status === "closed"
        ? t("inbox.conversationResolved")
        : t("inbox.conversationKeptOpen"));
      setShowResolveDialog(false);
      setResolveNote("");
    } catch (error) {
      // MW-V1: mirror the takeover path — surface the authoritative conflict
      // reason (e.g. resolving over another owner's 409, or a newer customer
      // inbound fence), never a fabricated success. Optimistic state is NOT
      // applied on error (it only merges on the awaited response above).
      const serverMessage = (error as { response?: { data?: { error?: { message?: string } } } })
        ?.response?.data?.error?.message
        || (typeof (error as Error)?.message === "string"
          && (error as Error).message
          && !/request failed|status code/i.test((error as Error).message)
          ? (error as Error).message
          : "");
      toast.error(serverMessage || t("inbox.errors.resolveFailed"));
    } finally {
      setResolvingConversation(false);
    }
  };

  const handleMessageSent = (message: Message) => {
    seenMessageIdsRef.current.add(message.id);
    setMessages((prev) => {
      const exists = prev.some((item) => item.id === message.id);
      const next = exists
        ? prev.map((item) => item.id === message.id ? { ...item, ...message, metadata: { ...(item.metadata || {}), ...(message.metadata || {}) } } : item)
        : [...prev, message];
      return next.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    });
    setAiReplyStatuses((prev) => {
      const next = { ...prev };
      const conversationId = message.conversation_id || selectedConversation?.id;
      if (conversationId) delete next[conversationId];
      return next;
    });
    const messageState = getDeliveryState(message);
    const conversationId = message.conversation_id || selectedConversation?.id;
    const providerConfirmed = isProviderConfirmed(message)
      || providerConfirmedMessageIdsRef.current.has(message.id);
    const confirmedAgentReply = message.sender === "agent" && providerConfirmed;
    const confirmed = message.sender === "customer" || providerConfirmed;
    const clearsSuggestionProjection = confirmedAgentReply
      || (message.sender === "ai" && isProviderConfirmed(message));
    if (message.sender === "agent" && conversationId) {
      if (providerConfirmed) {
        pendingManualMessageIdsRef.current.delete(message.id);
        providerConfirmedMessageIdsRef.current.add(message.id);
        showManualReplyProviderSuccess(
          message.id,
          conversationId,
          messageState === "DELIVERED" ? "DELIVERED" : "SENT",
        );
      } else if (messageState !== "FAILED" && message.metadata?.delivery_status !== "failed") {
        pendingManualMessageIdsRef.current.set(message.id, conversationId);
        if (pendingManualMessageIdsRef.current.size > 100) {
          const oldest = pendingManualMessageIdsRef.current.keys().next().value;
          if (oldest) pendingManualMessageIdsRef.current.delete(oldest);
        }
      }
    }
    if (confirmed) {
      setConversations((prev) =>
        prev.map((conv) =>
          conv.id === selectedConversation?.id
            ? {
                ...conv,
                updated_at: message.created_at || conv.updated_at,
                lastMessage: message.content,
                ...(confirmedAgentReply || (message.sender === "ai" && isProviderConfirmed(message))
                  ? { needs_merchant_reply: false, needs_merchant_reply_reason: null, ai_is_replying: false }
                  : {}),
                ...(clearsSuggestionProjection ? { hasAiSuggestion: false, suggestionCount: 0 } : {}),
              }
            : conv
        )
      );
    } else if (clearsSuggestionProjection) {
      setConversations((prev) => prev.map((conv) => (
        conv.id === selectedConversation?.id
          ? { ...conv, hasAiSuggestion: false, suggestionCount: 0 }
          : conv
      )));
    }
    if (clearsSuggestionProjection && selectedConversation) {
      setSelectedConversation({
        ...selectedConversation,
        ...(confirmedAgentReply || (message.sender === "ai" && isProviderConfirmed(message))
          ? { needs_merchant_reply: false, needs_merchant_reply_reason: null, ai_is_replying: false }
          : {}),
        hasAiSuggestion: false,
        suggestionCount: 0,
      });
    }
  };

  const handleMessageSendFailed = () => {
    if (!selectedConversation) return;
    setAiReplyStatuses((prev) => {
      const next = { ...prev };
      delete next[selectedConversation.id];
      return next;
    });
  };

  // P+01: merchant acted on the inbox lead (contacted / dismissed / state
  // conflict resolved server-side). Keep the projection in sync with the
  // authoritative response; terminal states clear the chip and the strip.
  const handleOpportunityChanged = (updated: Opportunity) => {
    const live = updated.status === "OPEN" || updated.status === "ACTIONED";
    const targetId = updated.conversation_id || selectedConversation?.id;
    const apply = (conversation: Conversation | null): Conversation | null => (
      !conversation || conversation.id !== targetId
        ? conversation
        : {
            ...conversation,
            open_opportunity: live
              ? { ...conversation.open_opportunity, ...updated } as Opportunity
              : null,
          }
    );
    setConversations((prev) => prev.map(apply) as Conversation[]);
    setSelectedConversation(apply);
  };

  const handleDismissSuggestion = async (messageId: string) => {
    if (!selectedConversation) return;
    try {
      messageRequestRef.current += 1;
      loadMessagesAbortRef.current?.abort();
      const dismissed = await apiClient.dismissAiDraft(selectedConversation.id, messageId);
      setMessages((prev) => prev.map((message) => message.id === messageId ? dismissed : message));
      setConversations((prev) => prev.map((conversation) => {
        if (conversation.id !== selectedConversation.id) return conversation;
        const remaining = Math.max(0, (conversation.suggestionCount || 1) - 1);
        return {
          ...conversation,
          suggestionCount: remaining,
          hasAiSuggestion: remaining > 0,
          needs_merchant_reply: true,
          needs_merchant_reply_reason: "CUSTOMER_UNANSWERED",
          ai_is_replying: false,
        };
      }));
      setSelectedConversation((conversation) => conversation?.id === selectedConversation.id
        ? {
            ...conversation,
            needs_merchant_reply: true,
            needs_merchant_reply_reason: "CUSTOMER_UNANSWERED",
            ai_is_replying: false,
          }
        : conversation);
      setDismissedSuggestionId(messageId);
      setAiReplyStatuses((prev) => {
        const next = { ...prev };
        delete next[selectedConversation.id];
        return next;
      });
      await Promise.allSettled([
        loadMessagesRef.current(selectedConversation.id, 1),
        loadConversationsRef.current(),
      ]);
    } catch (err: unknown) {
      toast.error((err as { message?: string })?.message || t("inbox.errors.dismissSuggestion"));
    }
  };

  // ─── Derived values ────────────────────────────────────────────────────────

  const totalPages = Math.max(1, Math.ceil(totalConversations / conversationPageSize));

  const handlePageChange = (page: number) => {
    if (loadingConversations || page < 1 || page > totalPages || page === currentPageRef.current) return;
    currentPageRef.current = page;
    failedPageRef.current = null;
    syncPageSelectionRef.current = true;
    void loadConversations(page);
  };

  const handleFilterChange = (tab: InboxFilterTab) => {
    filterTabRef.current = tab;
    setFilterTab(tab);
    updateSearchParams({ tab: tab === "all" ? null : tab, conversation: null });
    if (currentPageRef.current > 1) {
      currentPageRef.current = 1;
      failedPageRef.current = null;
      syncPageSelectionRef.current = true;
      void loadConversations(1);
    }
  };

  const handleSearchChange = (query: string) => {
    setSearchQuery(query);
    if (currentPageRef.current > 1) {
      currentPageRef.current = 1;
      failedPageRef.current = null;
      syncPageSelectionRef.current = true;
      void loadConversations(1);
    }
  };

  const handleRetryConversations = () => {
    void loadConversations(failedPageRef.current ?? currentPageRef.current);
  };

  const filteredConversations = conversations.filter((conv) => {
    const matchesSearch =
      !searchQuery ||
      conv.customer?.name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      conv.title?.toLowerCase().includes(searchQuery.toLowerCase());
    if (!matchesSearch) return false;
    if (filterTab === "needs_review") return needsMerchantReply(conv);
    if (filterTab === "closed") return conv.status === "closed";
    return conv.status !== "closed";
  });

  const needsReviewCount = conversations.filter(needsMerchantReply).length;
  const closedCount = conversations.filter((c) => c.status === "closed").length;
  const unreadTotal = conversations.reduce((total, conversation) => total + (conversation.unreadCount || 0), 0);

  const latestInboundAt = messages.length
    ? [...messages].reverse().find((message) => message.sender === "customer")?.created_at
    : undefined;
  const hoursElapsed = selectedConversation
    ? (Date.now() - new Date(latestInboundAt || selectedConversation.updated_at).getTime()) / 3600000
    : 0;
  const is24hChannel = selectedConversation
    ? META_CHANNELS.includes(selectedConversation.channel)
    : false;
  const is24hExpired = is24hChannel && hoursElapsed >= 24;
  const is24hWarning = is24hChannel && hoursElapsed >= 23 && !is24hExpired;

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className="shrink-0 bg-white border-b border-gray-200 flex items-center px-4 md:px-8 py-3 gap-2 flex-wrap">
        <h1 className="text-lg md:text-xl font-semibold text-gray-900 whitespace-nowrap font-bn">
          {t("inbox.title")}
        </h1>
        <span className="px-3 py-1 bg-blue-100 text-blue-700 rounded-full text-sm whitespace-nowrap">
          {t("inbox.active", { count: conversations.filter((c) => c.status === "active").length })}
        </span>
        {unreadTotal > 0 && (
          <span data-testid="inbox-unread-total" className="px-3 py-1 bg-amber-100 text-amber-700 rounded-full text-sm whitespace-nowrap">
            {t("inbox.unread", { count: unreadTotal })}
          </span>
        )}
        <span
          data-testid="inbox-ai-reply-mode"
          className="px-3 py-1 bg-gray-100 text-gray-700 rounded-full text-sm whitespace-nowrap"
        >
          {t("inbox.modeLabel")}:{" "}
          {t(
            AI_REPLY_MODE_LABEL_KEYS[
              selectedConversation?.effective_ai_reply_mode ?? aiReplyMode
            ],
          )}
        </span>
      </div>

      {/* Offline banner */}
      {!sseConnected && (
        <div className="shrink-0 bg-yellow-50 border-b border-yellow-200 px-4 py-2 text-sm text-yellow-800 flex items-center gap-2 font-bn">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />
          <span>{t("inbox.offlineBanner")}</span>
        </div>
      )}

      {/* ADR-0013 §6: shop-wide emergency stop is always visible in the inbox. */}
      {(emergencyStopActive || selectedConversation?.emergency_stop?.active === true) && (
        <div
          role="alert"
          data-testid="emergency-stop-banner"
          className="shrink-0 bg-red-50 border-b border-red-200 px-4 py-2 text-sm text-red-800 flex items-center gap-2 font-bn"
        >
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />
          <span>{t("inbox.emergencyBanner")}</span>
        </div>
      )}

      <ActionQueuePanel onSseRefresh={registerActionQueueRefresh} />

      <div className="mw-inbox-workbench flex-1 flex overflow-hidden">
        <InboxThreadList
          conversations={conversations}
          selectedConversationId={selectedConversation?.id ?? null}
          filteredConversations={filteredConversations}
          loading={loadingConversations}
          searchQuery={searchQuery}
          filterTab={filterTab}
          needsReviewCount={needsReviewCount}
          closedCount={closedCount}
          loadError={error}
          currentPage={currentPage}
          pageSize={conversationPageSize}
          totalConversations={totalConversations}
          totalPages={totalPages}
          mobilePanelOpen={mobilePanelOpen}
          onSearchChange={handleSearchChange}
          onFilterChange={handleFilterChange}
          onPageChange={handlePageChange}
          onRetry={handleRetryConversations}
          onSelectConversation={(conv) => {
            const sameConversation = selectedConversationRef.current?.id === conv.id;
            setSelectedConversation(conv);
            updateSearchParams({ conversation: conv.id });
            if (!sameConversation) {
              setMessages([]);
              setLoadingMessages(true);
            }
            setMobilePanelOpen(true);
          }}
        />

        {selectedConversation ? (
          <>
          <InboxThreadDetail
            selectedConversation={selectedConversation}
            aiReplyMode={aiReplyMode}
            aiReplyStatus={aiReplyStatuses[selectedConversation.id] ?? null}
            messages={messages}
            loadingMessages={loadingMessages}
            hasMoreMessages={hasMoreMessages}
            loadingMoreMessages={loadingMoreMessages}
            togglingHITL={togglingHITL}
            resolvingConversation={resolvingConversation}
            planFeaturesAdvancedAI={planFeatures.advanced_ai}
            showResolveDialog={showResolveDialog}
            resolveNote={resolveNote}
            dismissedSuggestionId={dismissedSuggestionId}
            templates={templates}
            quickReplyTemplates={quickReplyTemplates}
            loadingTemplates={loadingTemplates}
            messagesEndRef={messagesEndRef}
            is24hExpired={is24hExpired}
            is24hWarning={is24hWarning}
            mobilePanelOpen={mobilePanelOpen}
            onMobileBack={() => setMobilePanelOpen(false)}
            onToggleHITL={handleToggleHITL}
            onResolve={handleResolveConversation}
            onLoadOlderMessages={loadOlderMessages}
            onDismissSuggestion={handleDismissSuggestion}
            onOpportunityChanged={handleOpportunityChanged}
            onSetShowResolveDialog={setShowResolveDialog}
            onSetResolveNote={setResolveNote}
            onToggleContext={() => setContextOpen((o) => !o)}
            contextOpen={contextOpen}
            onMessageSent={handleMessageSent}
            onSendFailed={handleMessageSendFailed}
            onTemplatesChanged={loadTemplates}
          />
          {/* MW-V1: customer context — inline column on xl+, bottom sheet below. */}
          {contextOpen && (
            <div className="fixed inset-x-0 bottom-0 top-14 z-40 max-h-[72vh] overflow-y-auto bg-white shadow-2xl xl:static xl:z-auto xl:max-h-none xl:w-80 xl:shrink-0 xl:shadow-none">
              <CustomerContextPanel conversation={selectedConversation} onClose={() => setContextOpen(false)} onConversationChanged={applyOwnershipUpdate} />
            </div>
          )}
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-gray-500 lg:flex hidden">
            <p className="font-bn">{t("inbox.selectConversation")}</p>
          </div>
        )}
      </div>

      {/* ADR-0013 §8: optional manual-takeover reason (fixed list). */}
      {takeoverOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="inbox-takeover-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-gray-900/60 p-4"
        >
          <div className="w-full max-w-sm space-y-4 rounded-lg bg-white p-6 shadow-xl">
            <h3 id="inbox-takeover-title" className="text-lg font-semibold text-gray-900 font-bn">
              {t("inbox.takeoverDialog.title")}
            </h3>
            <p className="text-sm text-gray-600 font-bn">{t("inbox.takeoverDialog.desc")}</p>
            <label className="block text-xs font-medium text-gray-700 font-bn">
              {t("inbox.takeoverDialog.reason")}
              <select
                data-testid="takeover-reason-select"
                value={takeoverReason}
                onChange={(event) =>
                  setTakeoverReason(event.target.value as ManualHandoffReason)
                }
                className="mt-1 block w-full rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-sm"
              >
                {TAKEOVER_REASONS.map((reason) => (
                  <option key={reason} value={reason}>
                    {t(TAKEOVER_REASON_LABEL_KEYS[reason])}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setTakeoverOpen(false)}
                className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm text-gray-700 font-bn"
              >
                {t("inbox.takeoverDialog.cancel")}
              </button>
              <button
                type="button"
                disabled={togglingHITL}
                onClick={confirmTakeover}
                className="rounded-lg bg-amber-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60 font-bn"
              >
                {t("inbox.takeoverDialog.confirm")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
