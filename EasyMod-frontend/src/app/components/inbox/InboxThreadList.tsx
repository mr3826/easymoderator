/**
 * InboxThreadList — Left pane: conversation list with search + filter tabs.
 * Extracted from UnifiedInbox.tsx (D2 split).
 */
import { motion } from "motion/react";
import { Search, UserCheck, CheckCircle2, Loader2, MessageCircle, Sparkles, ChevronLeft, ChevronRight } from "lucide-react";
import type { Conversation } from "@/api/types/conversation";
import { Badge } from "@/app/components/ui/badge";
import { strengthStyles } from "../customers/customerDisplay";
import { useTranslation } from "react-i18next";
import { fadeUp, staggerChildren } from "@/lib/motion";

interface InboxThreadListProps {
  conversations: Conversation[];
  selectedConversationId: string | null;
  filteredConversations: Conversation[];
  loading: boolean;
  searchQuery: string;
  filterTab: "all" | "needs_review" | "closed";
  needsReviewCount: number;
  closedCount: number;
  loadError: string | null;
  currentPage: number;
  pageSize: number;
  totalConversations: number;
  totalPages: number;
  mobilePanelOpen: boolean;
  onSearchChange: (q: string) => void;
  onFilterChange: (tab: "all" | "needs_review" | "closed") => void;
  onPageChange: (page: number) => void;
  onRetry: () => void;
  onSelectConversation: (conv: Conversation) => void;
}

const getChannelIcon = (channel: string): string => {
  const icons: Record<string, string> = {
    facebook: "👥",
    telegram: "✈️",
    messenger: "📱",
    web: "🌐",
  };
  return icons[channel] || "💬";
};

type TFunc = (key: string, opts?: Record<string, unknown>) => string;

const formatDate = (dateString: string, t: TFunc): string => {
  const date = new Date(dateString);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (minutes < 1) return t("inbox.timeJustNow");
  if (minutes < 60) return t("inbox.timeMinutes", { count: minutes });
  if (hours < 24) return t("inbox.timeHours", { count: hours });
  if (days < 7) return t("inbox.timeDays", { count: days });
  return date.toLocaleDateString();
};

const displayTitle = (conversation: Conversation, fallback: string): string => {
  const title = conversation.title?.trim();
  if (title && !/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(title) && title.toLowerCase() !== "no title") return title;
  return conversation.customer?.name || fallback;
};

/**
 * Literal display map for `needs_merchant_reply_reason` (ADR-0013 §9).
 * Server codes are SCREAMING_SNAKE; the display keys are camelCase literals so
 * the translation-coverage test can verify both locales. Never build a `t()`
 * key by interpolation — that is the bug this map replaces.
 */
export const REPLY_REASON_LABEL_KEYS: Record<string, string> = {
  HITL_REQUIRED: "inbox.replyReason.hitlRequired",
  HUMAN_REQUIRED: "inbox.replyReason.humanRequired",
  CUSTOMER_UNANSWERED: "inbox.replyReason.customerUnanswered",
  AI_PAUSED: "inbox.replyReason.aiPaused",
  PROVIDER_SEND_FAILED: "inbox.replyReason.providerSendFailed",
  LOW_CONFIDENCE: "inbox.replyReason.lowConfidence",
  SENTIMENT_NEGATIVE: "inbox.replyReason.sentimentNegative",
  MANUAL_TAKEOVER: "inbox.replyReason.manualTakeover",
  DRAFT_REVIEW_REQUIRED: "inbox.replyReason.draftReviewRequired",
  AI_FAILED: "inbox.replyReason.aiFailed",
  SEND_FAILED: "inbox.replyReason.sendFailed",
  NO_REPLY_NEEDED: "inbox.replyReason.noReplyNeeded",
  UNAVAILABLE: "inbox.replyReason.unavailable",
  hitlRequired: "inbox.replyReason.hitlRequired",
  humanRequired: "inbox.replyReason.humanRequired",
  customerUnanswered: "inbox.replyReason.customerUnanswered",
  aiPaused: "inbox.replyReason.aiPaused",
  providerSendFailed: "inbox.replyReason.providerSendFailed",
  lowConfidence: "inbox.replyReason.lowConfidence",
  sentimentNegative: "inbox.replyReason.sentimentNegative",
  manualTakeover: "inbox.replyReason.manualTakeover",
};

export function replyReasonLabel(t: TFunc, reason: string | null | undefined): string {
  const key = REPLY_REASON_LABEL_KEYS[String(reason ?? "")];
  return key ? t(key) : t("inbox.replyReason.needsReply");
}

/** True when the conversation is assigned to a named owner (or has an id). */
function hasOwner(conversation: Conversation): boolean {
  return Boolean(conversation.assignee_id || conversation.assignee?.name);
}

export function InboxThreadList({
  filteredConversations,
  selectedConversationId,
  loading,
  searchQuery,
  filterTab,
  needsReviewCount,
  closedCount,
  loadError,
  currentPage,
  pageSize,
  totalConversations,
  totalPages,
  mobilePanelOpen,
  onSearchChange,
  onFilterChange,
  onPageChange,
  onRetry,
  onSelectConversation,
}: InboxThreadListProps) {
  const { t } = useTranslation();
  const rangeStart = totalConversations === 0 ? 0 : (currentPage - 1) * pageSize + 1;
  const rangeEnd = Math.min(currentPage * pageSize, totalConversations);
  const emptyMessageKey = searchQuery && filterTab === "needs_review"
    ? "inbox.empty.searchAndFilter"
    : searchQuery
      ? "inbox.empty.search"
      : filterTab !== "all"
        ? "inbox.empty.filter"
        : totalConversations > 0
          ? "inbox.empty.page"
          : "inbox.noConversations";

  return (
    <div
      className={`bg-white border-r border-gray-200 overflow-y-auto flex flex-col w-full lg:w-80 ${
        mobilePanelOpen ? "hidden" : "flex"
      } lg:flex`}
    >
      <div className="p-4 border-b border-gray-200 space-y-2">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            placeholder={t("inbox.searchPlaceholder")}
            aria-label={t("inbox.searchPlaceholder")}
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            className="w-full pl-9 pr-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
          />
        </div>
        <div className="flex gap-1">
          {(["all", "needs_review", "closed"] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => onFilterChange(tab)}
              aria-pressed={filterTab === tab}
              className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-colors flex items-center justify-center gap-1 ${
                filterTab === tab
                  ? tab === "needs_review"
                    ? "bg-amber-100 text-amber-700"
                    : tab === "closed"
                    ? "bg-gray-200 text-gray-700"
                    : "bg-blue-100 text-blue-700"
                  : "text-gray-500 hover:bg-gray-100"
              }`}
            >
              {tab === "all" && t("inbox.tabAll")}
              {tab === "needs_review" && (
                <>
                  {t("inbox.tabNeedsReview")}
                  {needsReviewCount > 0 && (
                    <span className="bg-amber-500 text-white text-xs rounded-full px-1.5 py-0.5 leading-none">
                      {needsReviewCount}
                    </span>
                  )}
                </>
              )}
              {tab === "closed" && (
                <>
                  {t("inbox.tabClosed")}
                  {closedCount > 0 && (
                    <span className="bg-gray-400 text-white text-xs rounded-full px-1.5 py-0.5 leading-none">
                      {closedCount}
                    </span>
                  )}
                </>
              )}
            </button>
          ))}
        </div>
      </div>

      {loadError && (
        <div role="alert" className="mx-4 mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          <p className="font-bn">{loadError}</p>
          <button type="button" onClick={onRetry} className="mt-2 min-h-10 font-semibold underline">
            {t("inbox.tryAgain")}
          </button>
        </div>
      )}

      {loading ? (
        <div className="flex-1 flex items-center justify-center">
          <Loader2 className="w-6 h-6 animate-spin text-blue-500" />
        </div>
      ) : filteredConversations.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center text-gray-500 gap-3 p-6">
          <MessageCircle className="w-10 h-10 text-gray-300" />
          <p role="status" aria-live="polite" className="text-sm text-center font-bn">
            {t(emptyMessageKey)}
          </p>
          {(searchQuery || filterTab !== "all") && (
            <p className="text-xs text-center text-gray-500 font-bn">{t("inbox.empty.currentPageOnly")}</p>
          )}
        </div>
      ) : (
        <motion.div
          className="divide-y divide-gray-100 flex-1 overflow-y-auto pb-20 md:pb-0"
          variants={staggerChildren}
          initial="hidden"
          animate="visible"
        >
          {filteredConversations.map((conversation) => {
            const isHITL = conversation.hitl === true;
            const needsReply = conversation.needs_merchant_reply
              ?? (conversation.hitl === true || conversation.hasAiSuggestion === true);

            return (
              <motion.div
                key={conversation.id}
                variants={fadeUp}
                onClick={() => onSelectConversation(conversation)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onSelectConversation(conversation);
                  }
                }}
                role="button"
                tabIndex={0}
                aria-pressed={selectedConversationId === conversation.id}
                className={[
                  "p-4 cursor-pointer hover:bg-gray-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-600 transition-colors relative",
                  selectedConversationId === conversation.id ? "bg-blue-50" : "",
                  isHITL ? "border-l-4 border-destructive" : "",
                ].join(" ")}
              >
                <div className="flex items-start justify-between mb-2">
                  <div className="flex items-center gap-2 flex-1">
                    <div className="w-10 h-10 bg-gradient-to-br from-blue-500 to-purple-500 rounded-full flex items-center justify-center text-white flex-shrink-0 text-sm font-semibold">
                      {conversation.customer?.name?.charAt(0) || "C"}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1 flex-wrap">
                        <h3
                          className={`font-semibold truncate text-sm ${
                            conversation.status === "closed"
                              ? "text-gray-400"
                              : "text-gray-900"
                          }`}
                        >
                          {conversation.customer?.name || t("inbox.unknownCustomer")}
                        </h3>
                        <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-600">
                          {conversation.status === "closed" && <CheckCircle2 className="h-3 w-3 text-green-600" aria-hidden="true" />}
                          {conversation.status === "closed"
                            ? t("inbox.conversationState.resolved")
                            : t("inbox.conversationState.open")}
                        </span>
                        {isHITL && (
                          <span title={t("inbox.humanTooltip")} className="inline-flex">
                            <UserCheck className="w-3 h-3 text-amber-500 flex-shrink-0" />
                          </span>
                        )}
                        {hasOwner(conversation) && (
                          <span
                            data-testid="inbox-owner-chip"
                            title={t("inbox.owner.assigned", {
                              name: conversation.assignee?.name || t("inbox.owner.teammate"),
                            })}
                            className="inline-flex max-w-[9rem] items-center gap-1 rounded-full bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium text-blue-700"
                          >
                            <UserCheck className="w-2.5 h-2.5 shrink-0" aria-hidden="true" />
                            <span className="truncate">
                              {conversation.assignee?.name || t("inbox.owner.teammate")}
                            </span>
                          </span>
                        )}
                        {conversation.open_opportunity && (
                          <span
                            data-testid="lead-chip"
                            title={t(`customer360.strength.${conversation.open_opportunity.strength}`)}
                            className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-semibold flex-shrink-0 ${strengthStyles[conversation.open_opportunity.strength]}`}
                          >
                            <Sparkles className="w-2.5 h-2.5" aria-hidden="true" />
                            {t(`customer360.strength.${conversation.open_opportunity.strength}`)}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-1 text-xs text-gray-500">
                        <span title={conversation.channel}>{getChannelIcon(conversation.channel)}</span>
                        {conversation.metaChannel?.displayName && (
                          <>
                            <span className="text-gray-300">·</span>
                            <span className="truncate">
                              {conversation.metaChannel.displayName}
                            </span>
                            {conversation.metaChannel.purposeLabel && (
                              <span className="px-1 py-0.5 rounded bg-gray-100 text-gray-600 text-[10px] leading-none">
                                {conversation.metaChannel.purposeLabel}
                              </span>
                            )}
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                  {/* Merchant action badge. Human ownership is shown separately. */}
                  {needsReply && (
                    <Badge variant="destructive" className="text-xs shrink-0 font-bn">
                      {t("inbox.needsReplyBadge")}
                    </Badge>
                  )}
                  {(conversation.unreadCount || 0) > 0 && (
                    <span data-testid="unread-badge" className="rounded-full bg-blue-600 px-1.5 py-0.5 text-[10px] font-bold text-white">
                      {conversation.unreadCount}
                    </span>
                  )}
                </div>
                <p className="text-sm text-gray-600 truncate">
                  {displayTitle(conversation, t("inbox.unknownCustomer"))}
                </p>
                {conversation.lastMessage && (
                  <p className="text-xs text-gray-500 truncate mt-0.5">{conversation.lastMessage}</p>
                )}
                {needsReply && conversation.needs_merchant_reply_reason && (
                  <p
                    data-testid="inbox-handoff-reason"
                    className="mt-0.5 truncate text-xs font-medium text-amber-700"
                  >
                    {replyReasonLabel(t, conversation.needs_merchant_reply_reason)}
                  </p>
                )}
                <p className="text-xs text-gray-400 mt-1">
                  {formatDate(conversation.updated_at, t)}
                </p>
              </motion.div>
            );
          })}
        </motion.div>
      )}

      {totalConversations > pageSize && (
        <nav aria-label={t("inbox.pagination.label")} className="mt-auto border-t border-gray-200 bg-white p-3">
          <p className="mb-2 text-center text-xs text-gray-600" aria-live="polite">
            {t("inbox.pagination.range", { start: rangeStart, end: rangeEnd, total: totalConversations })}
          </p>
          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              aria-label={t("inbox.pagination.previousPage")}
              disabled={currentPage <= 1 || loading}
              onClick={() => onPageChange(currentPage - 1)}
              className="inline-flex min-h-10 items-center gap-1 rounded-md border border-gray-300 px-2 text-sm disabled:opacity-50"
            >
              <ChevronLeft className="h-4 w-4" aria-hidden="true" />
              {t("inbox.pagination.previousPage")}
            </button>
            <span className="text-xs font-medium text-gray-700" aria-current="page">
              {t("inbox.pagination.page", { current: currentPage, total: totalPages })}
            </span>
            <button
              type="button"
              aria-label={t("inbox.pagination.nextPage")}
              disabled={currentPage >= totalPages || loading}
              onClick={() => onPageChange(currentPage + 1)}
              className="inline-flex min-h-10 items-center gap-1 rounded-md border border-gray-300 px-2 text-sm disabled:opacity-50"
            >
              {t("inbox.pagination.nextPage")}
              <ChevronRight className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        </nav>
      )}
    </div>
  );
}
