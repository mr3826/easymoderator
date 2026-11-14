/**
 * InboxThreadDetail — Right pane: message thread, AI suggestion, composer.
 * Extracted from UnifiedInbox.tsx (D2 split).
 */
import { memo, useState } from "react";
import {
  Bot, User, CheckCircle2, Edit3, Loader2, UserCheck, AlertTriangle,
  Clock, ArrowLeft, FileText, RotateCcw, PanelRight,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { apiClient } from "@/api";
import type {
  AiReplyMode,
  Conversation,
  Message,
  MessageAttachment,
  MessageDeliveryState,
  MessageMetadata,
  ResponseTemplate,
  SuggestionVisibility,
} from "@/api/types/conversation";
import { InboxComposer } from "./InboxComposer";
import ContextualEntityLink from "../merchant-workspace/ContextualEntityLink";
import OpportunityCard from "../customers/OpportunityCard";
import type { Opportunity } from "@/api/types/customer-intelligence";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isValidMediaUrl(url: unknown): url is string {
  if (typeof url !== "string" || !url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

function AttachmentImage({
  url,
  alt,
  className,
  fallbackLabel,
}: {
  url: string;
  alt: string;
  className: string;
  fallbackLabel: string;
}) {
  const [failed, setFailed] = useState(false);
  if (failed) return <span className="text-sm italic text-gray-500">{fallbackLabel}</span>;
  return (
    <img
      src={url}
      alt={alt}
      className={className}
      onError={() => setFailed(true)}
    />
  );
}

type TFunc = (key: string, opts?: Record<string, unknown>) => string;

function getDeliveryState(message: Message): MessageDeliveryState | null {
  const explicit = message.delivery_state || message.metadata?.delivery_state;
  if (explicit) return explicit;
  if (message.metadata?.delivered === true
    && (message.provider_message_id || message.metadata?.provider_message_id || message.metadata?.provider_send_confirmed === true)) {
    return "SENT";
  }
  return null;
}

function isProviderConfirmed(message: Message): boolean {
  const state = getDeliveryState(message);
  return (state === "SENT" || state === "DELIVERED")
    && Boolean(
      message.provider_message_id
      || message.metadata?.provider_message_id
      || message.metadata?.provider_send_confirmed === true,
    );
}

function isReviewableSuggestion(message: Message): boolean {
  if (message.sender !== "ai" || isProviderConfirmed(message)) return false;
  const state = getDeliveryState(message);
  const visibility = message.metadata?.suggestion_visibility as SuggestionVisibility | undefined;
  if (state === "DISMISSED" || visibility === "HIDDEN_DISMISSED") return false;
  if (state === "GENERATING" || state === "SEND_PENDING") return false;
  return visibility === "VISIBLE_DRAFT_REVIEW"
    || visibility === "VISIBLE_HITL_REVIEW"
    || visibility === "VISIBLE_MERCHANT_REQUESTED"
    || state === "DRAFT_READY"
    || (state === "HELD" && [
      "low_confidence",
      "human_active",
      "ai_paused",
      "channel_disconnected",
      "mode_changed",
      "policy_blocked",
      "provider_send_failed",
    ].includes(String(message.metadata?.held_reason)))
    || (state === null && message.metadata?.delivered === false && [
      "draft_mode",
      "low_confidence",
      "human_active",
      "ai_paused",
      "channel_disconnected",
      "mode_changed",
      "policy_blocked",
      "provider_send_failed",
    ].includes(String(message.metadata?.held_reason)));
}

function formatDate(dateString: string, t: TFunc): string {
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
}

function displayCustomerName(conversation: Conversation): string {
  const title = conversation.title?.trim();
  const customerName = conversation.customer?.name?.trim();
  if (customerName
    && !/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(customerName)
    && !["no title", "facebook user", "messenger user", "instagram user"].includes(customerName.toLowerCase())) {
    return customerName;
  }
  if (title && !/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(title) && title.toLowerCase() !== "no title") return title;
  return "Facebook customer";
}

// ─── MessageItem ──────────────────────────────────────────────────────────────

const MessageItem = memo(function MessageItem({
  message,
  customerName,
  onRetry,
}: {
  message: Message;
  customerName: string;
  onRetry: (message: Message) => void;
}) {
  const { t } = useTranslation();
  const ts = new Date(message.created_at).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
  });
  const rawDeliveryStatus = String(message.metadata?.delivery_status || "").toLowerCase();
  const deliveryState = getDeliveryState(message);
  const showDeliveryStatus = message.sender === "agent" || message.sender === "ai";
  const deliveryPending = showDeliveryStatus && (deliveryState === "SEND_PENDING" || rawDeliveryStatus === "pending");
  const deliveryConfirmed = showDeliveryStatus && isProviderConfirmed(message);
  const deliveryFailed = showDeliveryStatus && (deliveryState === "FAILED" || rawDeliveryStatus === "failed");
  const providerOutcomeUnknown = message.metadata?.provider_send_attempted === true
    && !message.provider_message_id
    && !message.metadata?.provider_message_id;
  const replyTo = message.reply_to || message.metadata?.reply_to;
  const attachments = Array.isArray(message.metadata?.attachments)
    ? message.metadata.attachments
    : [];

  return (
    <div className={`flex ${message.sender === "customer" ? "justify-start" : "justify-end"}`}>
      <div
        className={`max-w-lg rounded-2xl p-4 shadow-sm ${
          message.sender === "customer"
            ? "bg-white border border-gray-100"
            : message.sender === "ai"
            ? "bg-purple-100 border border-purple-200"
            : "bg-blue-600 text-white"
        }`}
      >
        <div className="flex items-center gap-2 mb-2">
          {message.sender === "customer" ? (
            <User className="w-4 h-4 text-gray-600" />
          ) : message.sender === "ai" ? (
            <Bot className="w-4 h-4 text-purple-600" />
          ) : null}
          <span className="text-sm font-semibold">
            {message.sender === "customer"
              ? customerName
              : message.sender === "ai"
              ? "AI Assistant"
              : "You"}
          </span>
        </div>
        {replyTo && (
          <div className="mb-2 rounded-lg border-l-2 border-gray-300 bg-black/5 px-3 py-2 text-xs text-gray-600">
            <span className="font-semibold">Replying to: </span>
            {replyTo.status === "resolved"
              ? replyTo.message_type === "image"
                ? "[Image]"
                : replyTo.message_type === "file"
                ? `[File${replyTo.file_name ? `: ${replyTo.file_name}` : ""}]`
                : replyTo.content || "a previous Messenger message"
              : "a previous Messenger message"}
          </div>
        )}
        {message.metadata?.attachment_available === false ? (
          <span role="status" className="text-sm italic text-gray-500">
            {t("inbox.attachmentUnavailable")}
          </span>
        ) : attachments.length > 0 ? (
          <div className="space-y-2">
            {attachments.map((attachment: MessageAttachment, index: number) => {
              const type = String(attachment?.type || "").toLowerCase();
              const url = attachment?.url;
              const label = type === "image"
                ? "Inline image"
                : type === "video"
                ? "Video"
                : type === "audio"
                ? "Voice message"
                : type === "sticker"
                ? "Sticker"
                : type === "file"
                ? attachment?.name || "Attachment"
                : "Attachment";

              if (type === "image") {
                return (
                  <div key={`${type}-${index}`}>
                    {isValidMediaUrl(url) ? (
                      <AttachmentImage
                        url={url}
                        alt={attachment?.name || "Inline image"}
                        className="max-w-xs rounded-xl border border-black/5"
                        fallbackLabel={t("inbox.attachmentUnavailable")}
                      />
                    ) : (
                      <span className="text-sm italic text-gray-500">Inline image</span>
                    )}
                  </div>
                );
              }

              return (
                <div
                  key={`${type}-${index}`}
                  className={`inline-flex items-center gap-2 px-3 py-2 rounded-lg ${
                    message.sender === "agent" ? "bg-blue-500/60" : "bg-gray-100"
                  }`}
                >
                  <FileText
                    className={`w-4 h-4 ${message.sender === "agent" ? "text-white" : "text-gray-600"}`}
                  />
                  <span className={`text-sm ${message.sender === "agent" ? "text-white" : "text-gray-700"}`}>
                    {label}
                  </span>
                  {isValidMediaUrl(url) && (
                    <a
                      href={url}
                      target="_blank"
                      rel="noreferrer"
                      className={`text-xs underline ${message.sender === "agent" ? "text-blue-100" : "text-blue-700"}`}
                    >
                      Open
                    </a>
                  )}
                </div>
              );
            })}
          </div>
        ) : message.message_type === "image" ? (
          <div>
            {isValidMediaUrl(message.metadata?.image_url) ? (
              <AttachmentImage
                url={message.metadata.image_url}
                alt="Attachment"
                className="max-w-xs rounded-xl border border-black/5"
                fallbackLabel={t("inbox.attachmentUnavailable")}
              />
            ) : (
              <span className="text-sm italic text-gray-500">[Image]</span>
            )}
          </div>
        ) : message.message_type === "file" ? (
          <div className="space-y-2">
            <div
              className={`inline-flex items-center gap-2 px-3 py-2 rounded-lg ${
                message.sender === "agent" ? "bg-blue-500/60" : "bg-gray-100"
              }`}
            >
              <FileText
                className={`w-4 h-4 ${message.sender === "agent" ? "text-white" : "text-gray-600"}`}
              />
              <span
                className={`text-sm ${message.sender === "agent" ? "text-white" : "text-gray-700"}`}
              >
                {message.metadata?.file_name || message.content || "Attachment"}
              </span>
            </div>
            {isValidMediaUrl(message.metadata?.file_url) && (
              <a
                href={message.metadata.file_url}
                download={message.metadata?.file_name || "attachment"}
                className={`inline-block text-xs underline ${
                  message.sender === "agent" ? "text-blue-100" : "text-blue-700"
                }`}
              >
                Download file
              </a>
            )}
          </div>
        ) : (
          <p className={message.sender === "agent" ? "text-white" : "text-gray-800"}>
            {message.content}
          </p>
        )}
        <p
          className={`mt-2 text-[11px] ${
            message.sender === "agent" ? "text-blue-100" : "text-gray-400"
          }`}
        >
          {ts}
          {deliveryPending && <span className="ml-2">{t("inbox.deliveryStatus.pending")}</span>}
          {deliveryConfirmed && <span className="ml-2">{t("inbox.deliveryStatus.sent")}</span>}
        </p>
        {deliveryFailed && (
          <div className={`mt-2 flex items-center gap-2 text-xs ${providerOutcomeUnknown ? "text-amber-100" : "text-red-50"}`}>
            {providerOutcomeUnknown ? (
              <span>{t("inbox.deliveryStatus.unknown")}</span>
            ) : (
              <>
                <span>{t("inbox.deliveryStatus.failed")}</span>
                <button
                  onClick={() => onRetry(message)}
                  className="inline-flex items-center gap-1 rounded border border-white/40 px-2 py-1 text-white hover:bg-white/10"
                >
                  <RotateCcw className="w-3 h-3" />
                  {t("inbox.retry", { defaultValue: "Retry" })}
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
});

// ─── InboxThreadDetail ────────────────────────────────────────────────────────

interface InboxThreadDetailProps {
  selectedConversation: Conversation;
  aiReplyMode: AiReplyMode;
  aiReplyStatus: "processing" | "sent" | "failed" | null;
  messages: Message[];
  loadingMessages: boolean;
  hasMoreMessages: boolean;
  loadingMoreMessages: boolean;
  togglingHITL: boolean;
  resolvingConversation: boolean;
  planFeaturesAdvancedAI: boolean;
  showResolveDialog: boolean;
  resolveNote: string;
  dismissedSuggestionId: string | null;
  templates: ResponseTemplate[];
  quickReplyTemplates: ResponseTemplate[];
  loadingTemplates: boolean;
  messagesEndRef: React.RefObject<HTMLDivElement>;
  is24hExpired: boolean;
  is24hWarning: boolean;
  mobilePanelOpen: boolean;
  onMobileBack: () => void;
  onToggleHITL: () => void;
  onResolve: () => void;
  onLoadOlderMessages: () => void;
  onDismissSuggestion: (msgId: string) => void | Promise<void>;
  /** P+01: authoritative opportunity state changed from within the inbox strip. */
  onOpportunityChanged?: (opportunity: Opportunity) => void;
  onSetShowResolveDialog: (show: boolean) => void;
  onSetResolveNote: (note: string) => void;
  /** MW-V1: toggle the customer-context panel (desktop column / mobile sheet). */
  onToggleContext?: () => void;
  contextOpen?: boolean;
  onMessageSent: (message: Message) => void;
  onSendFailed: () => void;
  onTemplatesChanged: () => Promise<void>;
}

export function InboxThreadDetail({
  selectedConversation,
  aiReplyMode,
  aiReplyStatus,
  messages,
  loadingMessages,
  hasMoreMessages,
  loadingMoreMessages,
  togglingHITL,
  resolvingConversation,
  planFeaturesAdvancedAI,
  showResolveDialog,
  resolveNote,
  dismissedSuggestionId,
  templates,
  quickReplyTemplates,
  loadingTemplates,
  messagesEndRef,
  is24hExpired,
  is24hWarning,
  mobilePanelOpen,
  onMobileBack,
  onToggleHITL,
  onResolve,
  onLoadOlderMessages,
  onDismissSuggestion,
  onOpportunityChanged,
  onSetShowResolveDialog,
  onSetResolveNote,
  onToggleContext,
  contextOpen,
  onMessageSent,
  onSendFailed,
  onTemplatesChanged,
}: InboxThreadDetailProps) {
  const { t } = useTranslation();
  const [editingSuggestion, setEditingSuggestion] = useState(false);
  const [editedSuggestion, setEditedSuggestion] = useState("");
  const [sendingSuggestion, setSendingSuggestion] = useState(false);

  const heldAiMsg =
    [...messages].reverse().find(
      (m) => isReviewableSuggestion(m)
    ) ?? null;
  const heldMeta = heldAiMsg?.metadata as MessageMetadata | undefined;
  const aiSuggestion = heldAiMsg?.ai_suggestion || heldAiMsg?.content || "";
  const aiConfidence = heldAiMsg?.ai_confidence ?? 0;
  const lastCustomerMsg = [...messages].reverse().find((m) => m.sender === "customer") ?? null;
  const lastAgentMsg = [...messages].reverse().find((m) => m.sender === "agent") ?? null;
  const customerSentAfterAgent =
    lastCustomerMsg &&
    (!lastAgentMsg ||
      new Date(lastCustomerMsg.created_at) > new Date(lastAgentMsg.created_at));
  // No !hitl guard: a low-confidence handoff sets hitl=true, yet we WANT the held
  // draft visible to the human who just took over.
  const hasAiSuggestion =
    !!aiSuggestion &&
    heldAiMsg?.id !== dismissedSuggestionId &&
    !!customerSentAfterAgent;
  const isLowConfidence = hasAiSuggestion && heldMeta?.held_reason === "low_confidence";
  const isAiActive =
    aiReplyMode === "AUTO" &&
    selectedConversation.status !== "closed" &&
    selectedConversation.hitl !== true &&
    aiReplyStatus === "processing";
  const replyStatusLabel =
    aiReplyMode === "AUTO" && selectedConversation.status !== "closed" && aiReplyStatus === "processing" && selectedConversation.hitl !== true
      ? t("inbox.status.processing")
      : aiReplyMode === "AUTO" && aiReplyStatus === "sent"
      ? t("inbox.status.sent")
      : aiReplyMode === "AUTO" && aiReplyStatus === "failed"
      ? t("inbox.status.failed")
      : null;

  const suggestionVisibility = heldMeta?.suggestion_visibility as SuggestionVisibility | undefined;
  const isDraftReview = aiReplyMode === "DRAFT"
    || suggestionVisibility === "VISIBLE_DRAFT_REVIEW"
    || (aiReplyMode !== "AUTO" && heldMeta?.held_reason === "draft_mode");
  const suggestionHeading = isDraftReview ? t("inbox.status.draftReady") : t("inbox.status.humanReviewRequired");
  const providerSendFailed = getDeliveryState(heldAiMsg || ({} as Message)) === "FAILED"
    || heldMeta?.held_reason === "provider_send_failed";
  // MW-V1 §11.1: a policy-blocked candidate gets the SAME blocked treatment
  // as a provider failure (no misleading re-send affordance) with its own
  // truthful copy — the stored reason class only, never an invented cause.
  const isPolicyBlocked = heldMeta?.held_reason === "policy_blocked";
  const messagingBlocked = providerSendFailed || isPolicyBlocked;

  const transcriptMessages = messages.filter((message) => (
    message.is_transcript_message !== false
    && (message.sender !== "ai" || isProviderConfirmed(message))
  ));

  // Traffic-light dot only — no English jargon for non-tech shop owners.
  const confidenceTier = (() => {
    const pct = Math.round((aiConfidence ?? 0) * 100);
    if (pct >= 85) return { dot: "bg-green-500" };
    if (pct >= 60) return { dot: "bg-amber-500" };
    return { dot: "bg-red-500" };
  })();

  const handleUseAiSuggestion = async (edit: boolean) => {
    if (!aiSuggestion || !heldAiMsg) return;
    if (edit) {
      if (editingSuggestion) {
        setEditingSuggestion(false);
        setEditedSuggestion("");
        return;
      }
      setEditedSuggestion(aiSuggestion);
      setEditingSuggestion(true);
      return;
    }
    if (is24hExpired) {
      toast.error(t("inbox.errors.outsideWindowDisabled"));
      return;
    }
    try {
      setSendingSuggestion(true);
      const message = await apiClient.approveAiDraft(
        selectedConversation.id,
        heldAiMsg.id,
        editingSuggestion ? editedSuggestion : undefined,
      );
      onMessageSent(message);
      setEditingSuggestion(false);
      setEditedSuggestion("");
      if (getDeliveryState(message) === "FAILED" || message.metadata?.delivery_status === "failed") {
        toast.error(t("inbox.taskOutcome.replyFailed"));
      } else if (!isProviderConfirmed(message)) {
        toast.warning(t("inbox.taskOutcome.replyPending"));
      }
    } catch (err: unknown) {
      onSendFailed();
      toast.error((err as { message?: string })?.message || "Failed to send AI suggestion");
    } finally {
      setSendingSuggestion(false);
    }
  };

  const handleRetryMessage = async (failedMessage: Message) => {
    try {
      const metadata = { ...(failedMessage.metadata || {}) };
      delete metadata.delivery_error;
      delete metadata.provider_message_id;
      delete metadata.provider_message_ids;
      const message = await apiClient.createMessage(selectedConversation.id, {
        content: failedMessage.content,
        sender: "agent",
        message_type: failedMessage.message_type,
        metadata: { ...metadata, delivery_status: "pending" },
      }, {
        idempotencyKey: typeof globalThis.crypto?.randomUUID === "function"
          ? globalThis.crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      });
      onMessageSent(message);
      if (!isProviderConfirmed(message)) toast.warning(t("inbox.taskOutcome.replyPending"));
    } catch (err: unknown) {
      onSendFailed();
      toast.error((err as { message?: string })?.message || "Retry failed");
    }
  };

  return (
    <div
      className={`flex-1 flex flex-col bg-gray-50 ${mobilePanelOpen ? "flex" : "hidden"} lg:flex`}
    >
      {/* Conversation Header */}
      <div className="bg-white border-b border-gray-200 px-4 md:px-6 py-3 shrink-0">
        <div className="flex items-start justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <button
              className="lg:hidden p-1 -ml-1 text-gray-500 hover:text-gray-700"
              onClick={onMobileBack}
              aria-label="Back to conversations"
            >
              <ArrowLeft className="w-5 h-5" />
            </button>
            <div className="min-w-0">
              <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                <h2 className="text-lg font-semibold text-gray-900 truncate">
                  {displayCustomerName(selectedConversation)}
                </h2>
                {(selectedConversation.assignee?.name || selectedConversation.assignee_id) && (
                  <span
                    data-testid="inbox-owner-chip"
                    title={t("inbox.owner.assigned", {
                      name: selectedConversation.assignee?.name || t("inbox.owner.teammate"),
                    })}
                    className="inline-flex max-w-[10rem] items-center gap-1 rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-medium text-blue-700"
                  >
                    <UserCheck className="h-3 w-3 shrink-0" aria-hidden="true" />
                    <span className="truncate">
                      {selectedConversation.assignee?.name || t("inbox.owner.teammate")}
                    </span>
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2 text-sm text-gray-500 flex-wrap">
                <span>{selectedConversation.channel}</span>
                <span>•</span>
                <span>{t("inbox.lastActive", { time: formatDate(selectedConversation.updated_at, t) })}</span>
              </div>
              {selectedConversation.customer_id && (
                <div className="mt-2">
                  <ContextualEntityLink
                    to={`/customers?customerId=${encodeURIComponent(selectedConversation.customer_id)}`}
                    ariaLabel={t("inbox.viewCustomer")}
                  >
                    {t("inbox.viewCustomer")}
                  </ContextualEntityLink>
                </div>
              )}
            </div>
          </div>
          <div className="flex items-center gap-1.5 flex-wrap justify-end shrink-0">
            {onToggleContext && (
              <button
                type="button"
                onClick={onToggleContext}
                aria-expanded={contextOpen === true}
                aria-label={t("inbox.context.title")}
                title={t("inbox.context.title")}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium font-bn ${
                  contextOpen ? "bg-blue-100 text-blue-700" : "bg-gray-100 text-gray-700 hover:bg-gray-200"
                }`}
                data-testid="context-toggle"
              >
                <PanelRight className="w-4 h-4" aria-hidden="true" />
                <span className="hidden md:inline">{t("inbox.context.title")}</span>
              </button>
            )}
            {selectedConversation.status !== "closed" && (
              <button
                onClick={() => onSetShowResolveDialog(true)}
                disabled={resolvingConversation}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-green-100 text-green-700 hover:bg-green-200 transition-colors"
                title={t("inbox.resolve")}
              >
                {resolvingConversation ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <CheckCircle2 className="w-4 h-4" />
                )}
                {t("inbox.resolve")}
              </button>
            )}
            {planFeaturesAdvancedAI ? (
              <>
                {isAiActive && !selectedConversation.hitl && (
                  <span
                    role="status"
                    aria-live="polite"
                    title={t("inbox.aiTooltip")}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-purple-100 text-purple-700"
                  >
                    <Bot className="w-4 h-4" />
                    {t("inbox.aiActive")}
                  </span>
                )}
                <button
                  onClick={onToggleHITL}
                  disabled={togglingHITL}
                  title={selectedConversation.hitl ? t("inbox.resumeAiTooltip") : t("inbox.takeOverTooltip")}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                    selectedConversation.hitl
                      ? "bg-amber-100 text-amber-700 hover:bg-amber-200"
                      : "bg-gray-100 text-gray-700 hover:bg-gray-200"
                  }`}
                >
                  {togglingHITL ? <Loader2 className="w-4 h-4 animate-spin" /> : selectedConversation.hitl ? <UserCheck className="w-4 h-4" /> : <User className="w-4 h-4" />}
                  {selectedConversation.hitl ? t("inbox.resumeAi") : t("inbox.takeOver")}
                </button>
              </>
            ) : null}
          </div>
        </div>
      </div>

      {replyStatusLabel && (
        <div
          data-testid="inbox-reply-status"
          aria-live="polite"
          className="bg-slate-50 border-b border-gray-200 px-6 py-2 text-sm text-slate-700 font-bn"
        >
          {replyStatusLabel}
        </div>
      )}

      {/* Banners */}
      {selectedConversation.hitl && (
        <div className="bg-amber-50 border-b border-amber-200 px-6 py-2 flex items-center gap-2 text-sm text-amber-800 font-bn">
          <UserCheck className="w-4 h-4 flex-shrink-0" />
          <span>{t("inbox.agentBanner")}</span>
        </div>
      )}
      {is24hWarning && (
        <div className="bg-orange-50 border-b border-orange-200 px-6 py-2 flex items-center gap-2 text-sm text-orange-800 font-bn">
          <Clock className="w-4 h-4 flex-shrink-0" />
          <span>{t("inbox.windowClosingSoon")}</span>
        </div>
      )}
      {is24hExpired && (
        <div className="bg-red-50 border-b border-red-200 px-6 py-2 flex items-center gap-2 text-sm text-destructive font-bn">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />
          <span>{t("inbox.windowExpired")}</span>
        </div>
      )}

      {/* P+01 Inbox Lead Intelligence — the same authoritative opportunity the
          Customers page shows; reasons are recorded facts, never a score. */}
      {selectedConversation.open_opportunity && (
        <div className="border-b border-gray-100 bg-gray-50/60 px-4 md:px-6 py-3" data-testid="inbox-lead-insight">
          <OpportunityCard
            opportunity={selectedConversation.open_opportunity}
            showCustomer={false}
            onChanged={(updated) => onOpportunityChanged?.(updated)}
          />
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 md:p-6 space-y-4 pb-24 md:pb-6">
        {loadingMessages ? (
          <div className="flex items-center justify-center h-full">
            <Loader2 className="w-6 h-6 animate-spin text-blue-500" />
          </div>
        ) : transcriptMessages.length === 0 ? (
          <div className="flex items-center justify-center h-full text-gray-500">
            <p className="font-bn">{t("inbox.noMessages")}</p>
          </div>
        ) : (
          <>
            {hasMoreMessages && (
              <div className="flex justify-center">
                <button
                  onClick={onLoadOlderMessages}
                  disabled={loadingMoreMessages}
                  className="flex items-center gap-1.5 px-4 py-1.5 text-xs text-gray-500 border border-gray-200 rounded-full hover:bg-gray-50 disabled:opacity-60"
                >
                  {loadingMoreMessages ? (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  ) : (
                    "↑"
                  )}
                  {t("inbox.loadOlder")}
                </button>
              </div>
            )}
            {transcriptMessages.map((message) => (
              <MessageItem
                key={message.id}
                message={message}
                customerName={displayCustomerName(selectedConversation)}
                onRetry={handleRetryMessage}
              />
            ))}
            <div ref={messagesEndRef} />
          </>
        )}
      </div>

      {/* AI Suggestion Panel */}
      {planFeaturesAdvancedAI && hasAiSuggestion && (
        <div
          className={`mx-4 rounded-t-lg border px-4 py-3 ${
            (() => {
              const pct = Math.round((aiConfidence ?? 0) * 100);
              if (pct >= 85) return "bg-green-50 border-green-200";
              if (pct >= 60) return "bg-amber-50 border-amber-300";
              return "bg-red-50 border-red-300";
            })()
          }`}
        >
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <Bot className="w-4 h-4 text-purple-600" />
              <span className="text-sm font-semibold text-purple-900">{suggestionHeading}</span>
            </div>
            <span
              className={`inline-block w-2.5 h-2.5 rounded-full ${confidenceTier.dot}`}
              aria-hidden="true"
            />
          </div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-600">
            {isDraftReview ? t("inbox.draftNotSent") : t("inbox.aiSuggestionNotSent")}
           </p>
           {editingSuggestion ? (
             <textarea
               aria-label={t("inbox.editedSuggestionLabel")}
               value={editedSuggestion}
               onChange={(event) => setEditedSuggestion(event.target.value)}
               rows={4}
               className="w-full text-sm text-gray-800 mb-2 rounded-lg border border-purple-200 bg-white p-2"
             />
           ) : (
             <p className="text-sm text-gray-800 mb-2 italic">"{aiSuggestion}"</p>
           )}
          {isLowConfidence && (
            <p className="text-xs text-amber-700 mb-2 flex items-center gap-1 font-bn">
              <AlertTriangle className="w-3 h-3" /> {t("inbox.lowConfidence")}
            </p>
          )}
           <div className="flex flex-col sm:flex-row gap-2">
              {messagingBlocked ? (
                <p className="flex-1 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 font-bn">
                  {t(isPolicyBlocked && !providerSendFailed ? "inbox.status.policyBlocked" : "inbox.status.providerBlocked")}
                </p>
              ) : (
               <>
            <button
               onClick={() => handleUseAiSuggestion(false)}
               disabled={sendingSuggestion || (editingSuggestion && !editedSuggestion.trim())}
              className="flex-1 flex items-center justify-center gap-1.5 py-2 sm:py-1.5 px-2 sm:px-3 bg-purple-600 text-white text-xs sm:text-sm font-medium rounded-lg hover:bg-purple-700 min-h-10"
            >
              <CheckCircle2 className="w-3 h-3 flex-shrink-0" />
              {sendingSuggestion ? t("inbox.sending") : editingSuggestion ? t("inbox.sendEdited") : t("inbox.useThis")}
            </button>
            <button
               onClick={() => handleUseAiSuggestion(true)}
               disabled={sendingSuggestion}
              className="flex-1 flex items-center justify-center gap-1.5 py-2 sm:py-1.5 px-2 sm:px-3 bg-white border border-purple-300 text-purple-700 text-xs sm:text-sm font-medium rounded-lg hover:bg-purple-50 min-h-10"
            >
              <Edit3 className="w-3 h-3 flex-shrink-0" />
               {editingSuggestion ? t("common.cancel") : t("inbox.editAndUse")}
            </button>
               </>
             )}
            <button
               onClick={() => heldAiMsg && void onDismissSuggestion(heldAiMsg.id)}
              className="flex-1 py-2 sm:py-1.5 px-2 sm:px-3 bg-white border border-gray-300 text-gray-600 text-xs sm:text-sm font-medium rounded-lg hover:bg-gray-50 min-h-10"
            >
              {t("inbox.ignore")}
            </button>
          </div>
        </div>
      )}

      {/* Composer */}
      <InboxComposer
        selectedConversation={selectedConversation}
        is24hExpired={is24hExpired}
        is24hWarning={is24hWarning}
        templates={templates}
        quickReplyTemplates={quickReplyTemplates}
        loadingTemplates={loadingTemplates}
        planFeaturesAdvancedAI={planFeaturesAdvancedAI}
        onMessageSent={onMessageSent}
        onSendFailed={onSendFailed}
        onTemplatesChanged={onTemplatesChanged}
      />

      {/* Resolve Dialog */}
      {showResolveDialog && (
        <div
          className="fixed inset-0 bg-gray-900/60 flex items-center justify-center z-50 p-4"
          onKeyDown={(e) => { if (e.key === "Escape") { onSetShowResolveDialog(false); onSetResolveNote(""); } }}
          onClick={(e) => { if (e.target === e.currentTarget) { onSetShowResolveDialog(false); onSetResolveNote(""); } }}
        >
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6 space-y-4">
            <div className="flex items-center gap-3">
              <CheckCircle2 className="w-6 h-6 text-green-600 flex-shrink-0" />
              <h2 className="text-lg font-semibold text-gray-900 font-bn">
                {t("inbox.resolveDialogTitle")}
              </h2>
            </div>
            <p className="text-sm text-gray-600 font-bn">{t("inbox.resolveDialogDescription")}</p>
            {aiReplyMode === "AUTO" && (
              <p className="text-sm text-gray-600 font-bn">{t("inbox.resolveDialogResumeDescription")}</p>
            )}
            <textarea
              value={resolveNote}
              onChange={(e) => onSetResolveNote(e.target.value)}
              placeholder={t("inbox.resolveNotePlaceholder")}
              rows={3}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
            />
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => { onSetShowResolveDialog(false); onSetResolveNote(""); }}
                className="px-4 py-2 text-sm text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50 font-bn"
              >
                {t("common.cancel")}
              </button>
              <button
                onClick={onResolve}
                disabled={resolvingConversation}
                className="px-4 py-2 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700 flex items-center gap-2 disabled:opacity-60 font-bn"
              >
                {resolvingConversation && <Loader2 className="w-4 h-4 animate-spin" />}
                {t("inbox.resolveConfirm")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
