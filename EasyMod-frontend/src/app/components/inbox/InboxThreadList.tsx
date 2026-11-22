/**
 * InboxThreadList — Left pane: conversation list with search + filter tabs.
 * Extracted from UnifiedInbox.tsx (D2 split). Restyled to the guardrails
 * --em-* scope; row structure (h3 name, role=button, aria-pressed) and the
 * lg:w-80/lg:flex pane classes are pinned by tests and stay verbatim.
 */
import { motion } from "motion/react";
import {
  Search,
  UserCheck,
  CheckCircle2,
  Loader2,
  MessageCircle,
  Sparkles,
  ChevronLeft,
  ChevronRight,
  Facebook,
  Send,
  Smartphone,
  Globe,
  type LucideIcon,
} from "lucide-react";
import type { Conversation } from "@/api/types/conversation";
import { Badge } from "@/app/components/ui/badge";
import { strengthStyles } from "../customers/customerDisplay";
import { useTranslation } from "react-i18next";
import { fadeUp } from "@/lib/motion";

const ANIMATE = import.meta.env.MODE !== "test";

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

/** Channel identity as icon + title, never emoji (guardrails §8/§9). */
const CHANNEL_ICONS: Record<string, LucideIcon> = {
  facebook: Facebook,
  telegram: Send,
  messenger: Smartphone,
  web: Globe,
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

const ROW_FOCUS =
  "focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-em-focus-light focus-visible:transition-none";

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
      className={`bg-em-bg-surface border-r border-em-border overflow-y-auto flex flex-col w-full lg:w-80 ${
        mobilePanelOpen ? "hidden" : "flex"
      } lg:flex`}
    >
      <div className="p-4 border-b border-em-border space-y-2">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-em-text-disabled" aria-hidden="true" />
          <input
            type="text"
            placeholder={t("inbox.searchPlaceholder")}
            aria-label={t("inbox.searchPlaceholder")}
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            className={`w-full min-h-11 pl-9 pr-4 py-2 border border-em-border-input bg-em-bg-surface rounded-lg text-sm text-em-text-primary placeholder:text-em-text-secondary focus:outline-none ${ROW_FOCUS}`}
          />
        </div>
        <div className="flex gap-1">
          {(["all", "needs_review", "closed"] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => onFilterChange(tab)}
              aria-pressed={filterTab === tab}
              className={`flex-1 min-h-11 py-1.5 text-xs font-semibold rounded-md transition-colors flex items-center justify-center gap-1 ${ROW_FOCUS} ${
                filterTab === tab
                  ? tab === "needs_review"
                    ? "bg-em-sunlight-100 text-em-sunlight-700"
                    : tab === "closed"
                    ? "bg-em-midnight-100 text-em-midnight-700"
                    : "bg-em-violet-100 text-em-violet-700"
                  : "text-em-text-secondary hover:bg-em-bg-muted"
              }`}
            >
              {tab === "all" && t("inbox.tabAll")}
              {tab === "needs_review" && (
                <>
                  {t("inbox.tabNeedsReview")}
                  {needsReviewCount > 0 && (
                    <span className="em-tabular bg-em-sunlight-500 text-em-midnight-900 text-xs rounded-full px-1.5 py-0.5 leading-none">
                      {needsReviewCount}
                    </span>
                  )}
                </>
              )}
              {tab === "closed" && (
                <>
                  {t("inbox.tabClosed")}
                  {closedCount > 0 && (
                    <span className="em-tabular bg-em-midnight-200 text-em-midnight-900 text-xs rounded-full px-1.5 py-0.5 leading-none">
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
        <div role="alert" className="mx-4 mt-3 rounded-lg border border-em-danger-700/20 bg-em-danger-100 p-3 text-sm text-em-danger-700">
          <p>{loadError}</p>
          <button
            type="button"
            onClick={onRetry}
            className={`mt-2 min-h-11 rounded-lg border border-em-border-strong bg-em-bg-surface px-3 font-semibold text-em-text-primary hover:bg-em-bg-muted ${ROW_FOCUS}`}
          >
            {t("inbox.tryAgain")}
          </button>
        </div>
      )}

      {loading ? (
        <div className="flex-1 flex items-center justify-center">
          <Loader2 className="w-6 h-6 animate-spin text-em-violet-600" aria-hidden="true" />
        </div>
      ) : filteredConversations.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center text-em-text-secondary gap-3 p-6">
          <MessageCircle className="w-10 h-10 text-em-border-strong" aria-hidden="true" />
          <p role="status" aria-live="polite" className="text-sm text-center">
            {t(emptyMessageKey)}
          </p>
          {(searchQuery || filterTab !== "all") && (
            <p className="text-xs text-center text-em-text-secondary">{t("inbox.empty.currentPageOnly")}</p>
          )}
        </div>
      ) : (
        <div className="divide-y divide-em-border flex-1 overflow-y-auto pb-20 md:pb-0">
          {filteredConversations.map((conversation) => {
            const isHITL = conversation.hitl === true;
            const needsReply = conversation.needs_merchant_reply
              ?? (conversation.hitl === true || conversation.hasAiSuggestion === true);
            const ChannelIcon = CHANNEL_ICONS[conversation.channel] || MessageCircle;

            return (
              <motion.div
                key={conversation.id}
                variants={fadeUp}
                initial={ANIMATE ? "hidden" : false}
                animate="visible"
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
                  `p-4 cursor-pointer hover:bg-em-bg-muted transition-colors relative ${ROW_FOCUS}`,
                  selectedConversationId === conversation.id ? "bg-em-violet-50" : "",
                  isHITL ? "border-l-4 border-destructive" : "",
                ].join(" ")}
              >
                <div className="flex items-start justify-between mb-2">
                  <div className="flex items-center gap-2 flex-1">
                    <div className="w-10 h-10 bg-em-violet-100 text-em-violet-700 rounded-full flex items-center justify-center flex-shrink-0 text-sm font-semibold">
                      {conversation.customer?.name?.charAt(0) || "C"}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1 flex-wrap">
                        <h3
                          className={`font-semibold truncate text-sm ${
                            conversation.status === "closed"
                              ? "text-em-text-secondary"
                              : "text-em-text-primary"
                          }`}
                        >
                          {conversation.customer?.name || t("inbox.unknownCustomer")}
                        </h3>
                        <span className="inline-flex items-center gap-1 rounded-full bg-em-bg-muted px-2 py-0.5 text-xs font-medium text-em-text-secondary">
                          {conversation.status === "closed" && <CheckCircle2 className="h-3 w-3 text-em-success-700" aria-hidden="true" />}
                          {conversation.status === "closed"
                            ? t("inbox.conversationState.resolved")
                            : t("inbox.conversationState.open")}
                        </span>
                        {isHITL && (
                          <span title={t("inbox.humanTooltip")} className="inline-flex">
                            <UserCheck className="w-3 h-3 text-em-sunlight-600 flex-shrink-0" aria-hidden="true" />
                          </span>
                        )}
                        {hasOwner(conversation) && (
                          <span
                            data-testid="inbox-owner-chip"
                            title={t("inbox.owner.assigned", {
                              name: conversation.assignee?.name || t("inbox.owner.teammate"),
                            })}
                            className="inline-flex max-w-[9rem] items-center gap-1 rounded-full bg-em-violet-50 px-1.5 py-0.5 text-xs font-medium text-em-violet-700"
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
                            className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-xs font-semibold flex-shrink-0 ${strengthStyles[conversation.open_opportunity.strength]}`}
                          >
                            <Sparkles className="w-2.5 h-2.5" aria-hidden="true" />
                            {t(`customer360.strength.${conversation.open_opportunity.strength}`)}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-1 text-xs text-em-text-secondary">
                        <span title={conversation.channel} className="inline-flex">
                          <ChannelIcon className="h-3.5 w-3.5" aria-hidden="true" />
                        </span>
                        {conversation.metaChannel?.displayName && (
                          <>
                            <span className="text-em-border-strong">·</span>
                            <span className="truncate">
                              {conversation.metaChannel.displayName}
                            </span>
                            {conversation.metaChannel.purposeLabel && (
                              <span className="px-1 py-0.5 rounded bg-em-bg-muted text-em-text-secondary text-xs leading-none">
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
                    <Badge variant="destructive" className="text-xs shrink-0">
                      {t("inbox.needsReplyBadge")}
                    </Badge>
                  )}
                  {(conversation.unreadCount || 0) > 0 && (
                    <span data-testid="unread-badge" className="em-tabular rounded-full bg-em-violet-600 px-1.5 py-0.5 text-xs font-bold text-white">
                      {conversation.unreadCount}
                    </span>
                  )}
                </div>
                <p className="text-sm text-em-text-secondary truncate">
                  {displayTitle(conversation, t("inbox.unknownCustomer"))}
                </p>
                {conversation.lastMessage && (
                  <p className="text-xs text-em-text-secondary truncate mt-0.5">{conversation.lastMessage}</p>
                )}
                {needsReply && conversation.needs_merchant_reply_reason && (
                  <p
                    data-testid="inbox-handoff-reason"
                    className="mt-0.5 truncate text-xs font-medium text-em-sunlight-700"
                  >
                    {replyReasonLabel(t, conversation.needs_merchant_reply_reason)}
                  </p>
                )}
                <p className="em-tabular text-xs text-em-text-secondary mt-1">
                  {formatDate(conversation.updated_at, t)}
                </p>
              </motion.div>
            );
          })}
        </div>
      )}

      {totalConversations > pageSize && (
        <nav aria-label={t("inbox.pagination.label")} className="mt-auto border-t border-em-border bg-em-bg-surface p-3">
          <p className="em-tabular mb-2 text-center text-xs text-em-text-secondary" aria-live="polite">
            {t("inbox.pagination.range", { start: rangeStart, end: rangeEnd, total: totalConversations })}
          </p>
          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              aria-label={t("inbox.pagination.previousPage")}
              disabled={currentPage <= 1 || loading}
              onClick={() => onPageChange(currentPage - 1)}
              className={`inline-flex min-h-11 items-center gap-1 rounded-md border border-em-border-strong bg-em-bg-surface px-2 text-sm text-em-text-primary hover:bg-em-bg-muted disabled:opacity-50 ${ROW_FOCUS}`}
            >
              <ChevronLeft className="h-4 w-4" aria-hidden="true" />
              {t("inbox.pagination.previousPage")}
            </button>
            <span className="em-tabular text-xs font-medium text-em-text-primary" aria-current="page">
              {t("inbox.pagination.page", { current: currentPage, total: totalPages })}
            </span>
            <button
              type="button"
              aria-label={t("inbox.pagination.nextPage")}
              disabled={currentPage >= totalPages || loading}
              onClick={() => onPageChange(currentPage + 1)}
              className={`inline-flex min-h-11 items-center gap-1 rounded-md border border-em-border-strong bg-em-bg-surface px-2 text-sm text-em-text-primary hover:bg-em-bg-muted disabled:opacity-50 ${ROW_FOCUS}`}
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
