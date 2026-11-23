/**
 * InboxThreadDetail — Right pane: message thread, AI suggestion, composer.
 * Extracted from UnifiedInbox.tsx (D2 split). Restyled to the guardrails
 * --em-* scope; every pinned literal, testid, role and the pane swap classes
 * stay verbatim. Adds the thread-level evidence rail and dialog semantics.
 */
import { memo, useRef, useState } from "react";
import {
  Bot, User, CheckCircle2, Edit3, Loader2, UserCheck, AlertTriangle,
  Clock, ArrowLeft, ArrowUp, FileText, RotateCcw, PanelRight,
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
import { EmButton } from "../dashboard/EmButton";
import { InboxEvidenceRail, type OutboundResult } from "./InboxEvidenceRail";
import { useDialogFocus } from "./useDialogFocus";
import type { InboxNarrative } from "./derive";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isValidMediaUrl(url: unknown): url is string {
  if (typeof url !== "string" || !url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-em-focus-light focus-visible:transition-none";

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
  if (failed) return <span className="text-sm italic text-em-text-secondary">{fallbackLabel}</span>;
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
  retrying = false,
}: {
  message: Message;
  customerName: string;
  onRetry: (message: Message) => void;
  retrying?: boolean;
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
            ? "bg-em-bg-surface border border-em-border"
            : message.sender === "ai"
            ? "bg-em-violet-100 border border-em-violet-300"
            : "bg-em-midnight-900 text-white"
        }`}
      >
        <div className="flex items-center gap-2 mb-2">
          {message.sender === "customer" ? (
            <User className="w-4 h-4 text-em-text-secondary" aria-hidden="true" />
          ) : message.sender === "ai" ? (
            <Bot className="w-4 h-4 text-em-violet-700" aria-hidden="true" />
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
          <div className="mb-2 rounded-lg border-l-2 border-em-border-strong bg-black/5 px-3 py-2 text-xs opacity-80">
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
          <span role="status" className="text-sm italic text-em-text-secondary">
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
                      <span className="text-sm italic text-em-text-secondary">Inline image</span>
                    )}
                  </div>
                );
              }

              return (
                <div
                  key={`${type}-${index}`}
                  className={`inline-flex items-center gap-2 px-3 py-2 rounded-lg ${
                    message.sender === "agent" ? "bg-em-midnight-700" : "bg-em-bg-muted"
                  }`}
                >
                  <FileText
                    className={`w-4 h-4 ${message.sender === "agent" ? "text-white" : "text-em-text-secondary"}`}
                    aria-hidden="true"
                  />
                  <span className={`text-sm ${message.sender === "agent" ? "text-white" : "text-em-text-primary"}`}>
                    {label}
                  </span>
                  {isValidMediaUrl(url) && (
                    <a
                      href={url}
                      target="_blank"
                      rel="noreferrer"
                      className={`text-xs underline ${message.sender === "agent" ? "text-em-sunlight-300" : "text-em-violet-700"}`}
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
              <span className="text-sm italic text-em-text-secondary">[Image]</span>
            )}
          </div>
        ) : message.message_type === "file" ? (
          <div className="space-y-2">
            <div
              className={`inline-flex items-center gap-2 px-3 py-2 rounded-lg ${
                message.sender === "agent" ? "bg-em-midnight-700" : "bg-em-bg-muted"
              }`}
            >
              <FileText
                className={`w-4 h-4 ${message.sender === "agent" ? "text-white" : "text-em-text-secondary"}`}
                aria-hidden="true"
              />
              <span
                className={`text-sm ${message.sender === "agent" ? "text-white" : "text-em-text-primary"}`}
              >
                {message.metadata?.file_name || message.content || "Attachment"}
              </span>
            </div>
            {isValidMediaUrl(message.metadata?.file_url) && (
              <a
                href={message.metadata.file_url}
                download={message.metadata?.file_name || "attachment"}
                className={`inline-block text-xs underline ${
                  message.sender === "agent" ? "text-em-sunlight-300" : "text-em-violet-700"
                }`}
              >
                Download file
              </a>
            )}
          </div>
        ) : (
          <p className={message.sender === "agent" ? "text-white" : "text-em-text-primary"}>
            {message.content}
          </p>
        )}
        <p
          className={`em-tabular mt-2 text-xs ${
            message.sender === "agent" ? "text-em-midnight-200" : "text-em-text-secondary"
          }`}
        >
          {ts}
          {deliveryPending && <span className="ml-2">{t("inbox.deliveryStatus.pending")}</span>}
          {deliveryConfirmed && <span className="ml-2">{t("inbox.deliveryStatus.sent")}</span>}
        </p>
        {message.sender === "ai" && deliveryConfirmed && (
          <p
            className="mt-1 text-xs text-em-text-secondary"
            data-testid="ai-confidence-evidence"
            aria-label={t("inbox.confidenceSignal.evidenceSignalLabel")}
          >
            {t(deriveConfidenceSignal(message.metadata).key)}
          </p>
        )}
        {deliveryFailed && (
          <div className={`mt-2 flex items-center gap-2 text-xs ${providerOutcomeUnknown ? "text-em-sunlight-300" : "text-em-danger-100"}`}>
            {providerOutcomeUnknown ? (
              <span>{t("inbox.deliveryStatus.unknown")}</span>
            ) : (
              <>
                <span>{t("inbox.deliveryStatus.failed")}</span>
                <button
                  onClick={() => onRetry(message)}
                  disabled={retrying}
                  aria-busy={retrying}
                  className={`inline-flex min-h-11 items-center gap-1 rounded border border-white/40 px-2 py-1 text-white hover:bg-white/10 disabled:opacity-50 disabled:cursor-not-allowed ${FOCUS_RING}`}
                >
                  <RotateCcw className="w-3 h-3" aria-hidden="true" />
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

/**
 * Evidence signal for an AI draft. Server codes are SCREAMING_SNAKE; the display
 * keys are camelCase literals so the translation-coverage test can verify both
 * locales. Never build a `t()` key by interpolation (same rule as
 * REPLY_REASON_LABEL_KEYS).
 *
 * The score itself is deliberately not shown: it is an evidence score, not a
 * calibrated probability, and displaying it as a percentage was the defect this
 * replaced.
 */
const CONFIDENCE_SIGNAL_KEYS = {
  verified: "inbox.confidenceSignal.verified",
  grounded: "inbox.confidenceSignal.grounded",
  knowledgeUnavailable: "inbox.confidenceSignal.knowledgeUnavailable",
  noEvidence: "inbox.confidenceSignal.noEvidence",
  retrievalFailed: "inbox.confidenceSignal.retrievalFailed",
  review: "inbox.confidenceSignal.review",
  safeFallback: "inbox.confidenceSignal.safeFallback",
  notRecorded: "inbox.confidenceSignal.notRecorded",
} as const;

type ConfidenceSignalTier = "success" | "warning" | "danger" | "neutral";

const CONFIDENCE_SIGNAL_DOT: Record<ConfidenceSignalTier, string> = {
  success: "bg-em-success-700",
  warning: "bg-em-sunlight-500",
  danger: "bg-em-danger-700",
  neutral: "bg-em-text-secondary",
};

const CONFIDENCE_SIGNAL_PANEL: Record<ConfidenceSignalTier, string> = {
  success: "bg-em-success-100 border-em-success-700/20",
  warning: "bg-em-sunlight-100 border-em-sunlight-600/30",
  danger: "bg-em-danger-100 border-em-danger-700/20",
  neutral: "bg-em-bg-surface border-em-border",
};

function deriveConfidenceSignal(
  meta: MessageMetadata | undefined
): { key: string; tier: ConfidenceSignalTier } {
  const raw = meta?.reply_evidence?.reasons;
  const codes = Array.isArray(raw) ? raw : [];
  const has = (code: string) => codes.includes(code);

  if (meta?.delivery_source === "DRAFT_APPROVAL") {
    return { key: CONFIDENCE_SIGNAL_KEYS.notRecorded, tier: "neutral" };
  }
  if (has("RETRIEVAL_FAILED")) {
    return { key: CONFIDENCE_SIGNAL_KEYS.retrievalFailed, tier: "danger" };
  }
  if (has("RAG_UNAVAILABLE") || has("RAG_TIMEOUT")) {
    return { key: CONFIDENCE_SIGNAL_KEYS.knowledgeUnavailable, tier: "danger" };
  }
  if (has("SAFE_COPY_DELIVERED")) {
    return { key: CONFIDENCE_SIGNAL_KEYS.safeFallback, tier: "warning" };
  }
  if (has("NO_EVIDENCE") || has("KNOWLEDGE_NOT_FOUND")) {
    return { key: CONFIDENCE_SIGNAL_KEYS.noEvidence, tier: "warning" };
  }
  if (has("GROUNDING_VIOLATIONS") || has("PRODUCT_NOT_FOUND") || has("INVALID_FAQ_SCORE")
    || has("EVIDENCE_MISSING") || has("EVIDENCE_INVALID") || has("COMPUTATION_FAILED")
    || has("FAQ_PARTIAL_MATCH") || has("EMPTY_COMPLETION") || has("SUPPRESSED")
    || has("GROUNDING_DECISION_MISSING") || has("GROUNDING_DECISION_INVALID")) {
    return { key: CONFIDENCE_SIGNAL_KEYS.review, tier: "warning" };
  }
  // A deterministic order-flow reply is authored from system-owned state.
  if (meta?.reply_evidence?.provenance === "deterministic" && has("ORDER_FLOW")) {
    return { key: CONFIDENCE_SIGNAL_KEYS.verified, tier: "neutral" };
  }
  if (has("GROUNDED")) {
    return { key: CONFIDENCE_SIGNAL_KEYS.grounded, tier: "neutral" };
  }
  // Messages written before the evidence score existed carry no signal. Saying
  // so is more honest than inventing a number.
  return { key: CONFIDENCE_SIGNAL_KEYS.notRecorded, tier: "neutral" };
}

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
  interactionChoicesEnabled?: boolean;
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
  /** Guardrails narrative + sync evidence for the thread evidence rail. */
  narrative?: InboxNarrative;
  lastSyncAt?: number | null;
  sseConnected?: boolean;
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
  interactionChoicesEnabled = false,
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
  narrative,
  sseConnected = true,
  onMessageSent,
  onSendFailed,
  onTemplatesChanged,
}: InboxThreadDetailProps) {
  const { t } = useTranslation();
  const [editingSuggestion, setEditingSuggestion] = useState(false);
  const [editedSuggestion, setEditedSuggestion] = useState("");
  const [sendingSuggestion, setSendingSuggestion] = useState(false);
  // D-A3-5: per-failed-message retry bookkeeping. `retryingMessageId` disables
  // the bubble's Retry affordance while its request is in flight; the two refs
  // below enforce the request-level contract even if clicks land before the
  // state flush (React batches): one in-flight attempt per message id, and one
  // STABLE idempotency key per logical attempt so server-side
  // send_idempotency_key dedup can replay it (conversation.service.js) instead
  // of creating a second SEND_PENDING row.
  const [retryingMessageId, setRetryingMessageId] = useState<string | null>(null);
  const retryInFlightRef = useRef(new Set<string>());
  const retryIdempotencyKeysRef = useRef(new Map<string, string>());
  const resolveDialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(resolveDialogRef, showResolveDialog);

  const heldAiMsg =
    [...messages].reverse().find(
      (m) => isReviewableSuggestion(m)
    ) ?? null;
  const heldMeta = heldAiMsg?.metadata as MessageMetadata | undefined;
  const aiSuggestion = heldAiMsg?.ai_suggestion || heldAiMsg?.content || "";
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

  // Provider-confirmed truth for the evidence rail: SENT means the provider
  // accepted, never that the customer read it (no read receipts exist).
  const lastOutboundMsg =
    [...messages].reverse().find((m) => m.sender === "agent" || m.sender === "ai") ?? null;
  const outboundResult: OutboundResult = !lastOutboundMsg
    ? "none"
    : isProviderConfirmed(lastOutboundMsg)
    ? "confirmed"
    : (getDeliveryState(lastOutboundMsg) === "FAILED" || lastOutboundMsg.metadata?.delivery_status === "failed")
    ? "failed"
    : "pending";

  // Evidence signal, never colour alone (§8). The numeric confidence badge was
  // retired: it reported a fixed 0.9 that no evidence supported, so it told the
  // merchant nothing about whether THIS draft could be trusted. The score is
  // still recorded (for calibration) but is not shown as a probability.
  const confidenceSignal = deriveConfidenceSignal(heldMeta);
  const confidenceDot = CONFIDENCE_SIGNAL_DOT[confidenceSignal.tier];
  const confidencePanelClass = CONFIDENCE_SIGNAL_PANEL[confidenceSignal.tier];

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

  /**
   * D-A3-5 retry idempotency semantics (pinned by InboxThreadDetail.retry.test):
   *  - One attempt per failed message may be in flight; extra clicks are dropped
   *    by the ref guard and the disabled button.
   *  - The key is minted at the first click for a given failed message id and
   *    persisted across attempts. If the REQUEST itself errored, the outcome is
   *    unknown (the row may exist server-side), so the next click reuses the
   *    same key and the server dedup replays rather than double-sending.
   *  - If the retry COMPLETED with FAILED, the key is released ONLY when the
   *    response says explicitly `provider_send_attempted === false` (a not-
   *    attempted failure — safe to re-dispatch as a genuinely new attempt).
   *    When the provider call was STARTED and errored (lost ack, outcome
   *    unknown), the row persists FAILED with provider_send_attempted: true
   *    (conversation.controller.js:779); minting a fresh key there would
   *    create a second row and a possible SECOND provider-visible message.
   *    An unknown attempt state (flag absent) also keeps the key — the FE
   *    cannot prove it is safe to re-send, and the same-key replay is inert:
   *    the server returns the stored row without dispatching (controller
   *    :990-999 skips delivery on idempotency_replay). Mirrors the P05
   *    no-blind-resend posture (PROVIDER_SEND_ALREADY_ATTEMPTED 409s).
   *  - If the retry completed pending/confirmed, the key is kept, so a stray
   *    later click on the old failed bubble replays the existing send.
   */
  const handleRetryMessage = async (failedMessage: Message) => {
    const messageId = failedMessage.id;
    if (!messageId || retryInFlightRef.current.has(messageId)) return;
    retryInFlightRef.current.add(messageId);
    setRetryingMessageId(messageId);
    try {
      let idempotencyKey = retryIdempotencyKeysRef.current.get(messageId);
      if (!idempotencyKey) {
        idempotencyKey = typeof globalThis.crypto?.randomUUID === "function"
          ? globalThis.crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        retryIdempotencyKeysRef.current.set(messageId, idempotencyKey);
        if (retryIdempotencyKeysRef.current.size > 50) {
          const oldest = retryIdempotencyKeysRef.current.keys().next().value;
          if (oldest) retryIdempotencyKeysRef.current.delete(oldest);
        }
      }
      const metadata = { ...(failedMessage.metadata || {}) };
      delete metadata.delivery_error;
      delete metadata.provider_message_id;
      delete metadata.provider_message_ids;
      const message = await apiClient.createMessage(selectedConversation.id, {
        content: failedMessage.content,
        sender: "agent",
        message_type: failedMessage.message_type,
        metadata: { ...metadata, delivery_status: "pending" },
      }, { idempotencyKey });
      const completedFailed =
        getDeliveryState(message) === "FAILED" || message.metadata?.delivery_status === "failed";
      if (completedFailed && message.metadata?.provider_send_attempted === false) {
        // Only a server-confirmed NOT-attempted failure releases the key; an
        // attempted (or indistinguishable) FAILED outcome keeps it so the next
        // click replays the stored row instead of risking a second
        // provider-visible send (F-1, A6 QA on PR #305).
        retryIdempotencyKeysRef.current.delete(messageId);
      }
      onMessageSent(message);
      if (!isProviderConfirmed(message)) toast.warning(t("inbox.taskOutcome.replyPending"));
    } catch (err: unknown) {
      onSendFailed();
      toast.error((err as { message?: string })?.message || "Retry failed");
    } finally {
      retryInFlightRef.current.delete(messageId);
      setRetryingMessageId(null);
    }
  };

  return (
    <div
      className={`flex-1 flex flex-col bg-em-bg-app ${mobilePanelOpen ? "flex" : "hidden"} lg:flex`}
    >
      {/* Conversation Header */}
      <div className="bg-em-bg-surface border-b border-em-border px-4 md:px-6 py-3 shrink-0">
        <div className="flex items-start justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <button
              className={`lg:hidden min-h-11 min-w-11 p-1 -ml-1 text-em-text-secondary hover:text-em-text-primary ${FOCUS_RING}`}
              onClick={onMobileBack}
              aria-label="Back to conversations"
            >
              <ArrowLeft className="w-5 h-5" aria-hidden="true" />
            </button>
            <div className="min-w-0">
              <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                <h2 className="text-lg font-semibold text-em-text-primary truncate">
                  {displayCustomerName(selectedConversation)}
                </h2>
                {(selectedConversation.assignee?.name || selectedConversation.assignee_id) && (
                  <span
                    data-testid="inbox-owner-chip"
                    title={t("inbox.owner.assigned", {
                      name: selectedConversation.assignee?.name || t("inbox.owner.teammate"),
                    })}
                    className="inline-flex max-w-[10rem] items-center gap-1 rounded-full bg-em-violet-50 px-2 py-0.5 text-xs font-medium text-em-violet-700"
                  >
                    <UserCheck className="h-3 w-3 shrink-0" aria-hidden="true" />
                    <span className="truncate">
                      {selectedConversation.assignee?.name || t("inbox.owner.teammate")}
                    </span>
                  </span>
                )}
              </div>
              <div className="em-tabular flex items-center gap-2 text-sm text-em-text-secondary flex-wrap">
                <span>{selectedConversation.channel}</span>
                <span aria-hidden="true">•</span>
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
                className={`flex min-h-11 items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium ${FOCUS_RING} ${
                  contextOpen ? "bg-em-violet-100 text-em-violet-700" : "bg-em-bg-muted text-em-text-primary hover:bg-em-border/60"
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
                className={`flex min-h-11 items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-em-success-100 text-em-success-700 hover:bg-em-success-100/70 transition-colors disabled:opacity-60 ${FOCUS_RING}`}
                title={t("inbox.resolve")}
              >
                {resolvingConversation ? (
                  <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                ) : (
                  <CheckCircle2 className="w-4 h-4" aria-hidden="true" />
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
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-em-violet-100 text-em-violet-700"
                  >
                    <Bot className="w-4 h-4" aria-hidden="true" />
                    {t("inbox.aiActive")}
                  </span>
                )}
                <button
                  onClick={onToggleHITL}
                  disabled={togglingHITL}
                  title={selectedConversation.hitl ? t("inbox.resumeAiTooltip") : t("inbox.takeOverTooltip")}
                  className={`flex min-h-11 items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors disabled:opacity-60 ${FOCUS_RING} ${
                    selectedConversation.hitl
                      ? "bg-em-sunlight-100 text-em-sunlight-700 hover:bg-em-sunlight-300/60"
                      : "bg-em-bg-muted text-em-text-primary hover:bg-em-border/60"
                  }`}
                >
                  {togglingHITL ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : selectedConversation.hitl ? <UserCheck className="w-4 h-4" aria-hidden="true" /> : <User className="w-4 h-4" aria-hidden="true" />}
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
          className="bg-em-bg-muted border-b border-em-border px-6 py-2 text-sm text-em-text-secondary"
        >
          {replyStatusLabel}
        </div>
      )}

      {/* Banners */}
      {selectedConversation.hitl && (
        <div className="bg-em-sunlight-100 border-b border-em-sunlight-600/30 px-6 py-2 flex items-center gap-2 text-sm text-em-sunlight-700">
          <UserCheck className="w-4 h-4 flex-shrink-0" aria-hidden="true" />
          <span>{t("inbox.agentBanner")}</span>
        </div>
      )}
      {is24hWarning && (
        <div className="bg-em-warning-100 border-b border-em-warning-700/20 px-6 py-2 flex items-center gap-2 text-sm text-em-warning-700">
          <Clock className="w-4 h-4 flex-shrink-0" aria-hidden="true" />
          <span>{t("inbox.windowClosingSoon")}</span>
        </div>
      )}
      {is24hExpired && (
        <div className="bg-em-danger-100 border-b border-em-danger-700/20 px-6 py-2 flex items-center gap-2 text-sm text-em-danger-700">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" aria-hidden="true" />
          <span>{t("inbox.windowExpired")}</span>
        </div>
      )}

      {/* P+01 Inbox Lead Intelligence — the same authoritative opportunity the
          Customers page shows; reasons are recorded facts, never a score. */}
      {selectedConversation.open_opportunity && (
        <div className="border-b border-em-border bg-em-bg-muted/60 px-4 md:px-6 py-3" data-testid="inbox-lead-insight">
          <OpportunityCard
            opportunity={selectedConversation.open_opportunity}
            showCustomer={false}
            onChanged={(updated) => onOpportunityChanged?.(updated)}
          />
        </div>
      )}

      {/* Messages */}
      <div
        className={`flex-1 overflow-y-auto p-4 md:p-6 space-y-4 pb-24 md:pb-6 ${FOCUS_RING}`}
        tabIndex={0}
        aria-label={t("inbox.evidence.conversation")}
      >
        {loadingMessages ? (
          <div className="flex items-center justify-center h-full">
            <Loader2 className="w-6 h-6 animate-spin text-em-violet-600" aria-hidden="true" />
          </div>
        ) : transcriptMessages.length === 0 ? (
          <div className="flex items-center justify-center h-full text-em-text-secondary">
            <p>{t("inbox.noMessages")}</p>
          </div>
        ) : (
          <>
            {hasMoreMessages && (
              <div className="flex justify-center">
                <button
                  onClick={onLoadOlderMessages}
                  disabled={loadingMoreMessages}
                  className={`flex min-h-11 items-center gap-1.5 px-4 py-1.5 text-xs text-em-text-secondary border border-em-border rounded-full hover:bg-em-bg-muted disabled:opacity-60 ${FOCUS_RING}`}
                >
                  {loadingMoreMessages ? (
                    <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />
                  ) : (
                    <ArrowUp className="w-3 h-3" aria-hidden="true" />
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
                retrying={retryingMessageId === message.id}
              />
            ))}
            <div ref={messagesEndRef} />
          </>
        )}
      </div>

      {/* AI Suggestion Panel */}
      {planFeaturesAdvancedAI && hasAiSuggestion && (
        <div
          className={`mx-4 rounded-t-lg border px-4 py-3 ${confidencePanelClass}`}
        >
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <Bot className="w-4 h-4 text-em-violet-700" aria-hidden="true" />
              <span className="text-sm font-semibold text-em-text-primary">{suggestionHeading}</span>
            </div>
            <span className="flex items-center gap-1.5">
              <span
                className={`inline-block w-2.5 h-2.5 rounded-full ${confidenceDot}`}
                aria-hidden="true"
              />
              <span className="text-xs font-medium text-em-text-secondary">
                {t(confidenceSignal.key)}
              </span>
            </span>
          </div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-em-text-secondary">
            {isDraftReview ? t("inbox.draftNotSent") : t("inbox.aiSuggestionNotSent")}
           </p>
           {editingSuggestion ? (
             <textarea
               aria-label={t("inbox.editedSuggestionLabel")}
               value={editedSuggestion}
               onChange={(event) => setEditedSuggestion(event.target.value)}
               rows={4}
               className={`w-full text-sm text-em-text-primary mb-2 rounded-lg border border-em-border-strong bg-em-bg-surface p-2 focus:outline-none ${FOCUS_RING}`}
             />
           ) : (
             <p className="text-sm text-em-text-primary mb-2 italic">"{aiSuggestion}"</p>
           )}
          {isLowConfidence && (
            <p className="text-xs text-em-sunlight-700 mb-2 flex items-center gap-1">
              <AlertTriangle className="w-3 h-3" aria-hidden="true" /> {t("inbox.lowConfidence")}
            </p>
          )}
           <div className="flex flex-col sm:flex-row gap-2">
              {messagingBlocked ? (
                <p className="flex-1 rounded-lg border border-em-danger-700/20 bg-em-danger-100 px-3 py-2 text-xs text-em-danger-700">
                  {t(isPolicyBlocked && !providerSendFailed ? "inbox.status.policyBlocked" : "inbox.status.providerBlocked")}
                </p>
              ) : (
               <>
            <EmButton
              variant="attention"
              onClick={() => handleUseAiSuggestion(false)}
              disabled={sendingSuggestion || (editingSuggestion && !editedSuggestion.trim())}
              loading={sendingSuggestion}
              className="flex-1 justify-center gap-1.5"
            >
              <CheckCircle2 className="w-3 h-3 flex-shrink-0" aria-hidden="true" />
              {sendingSuggestion ? t("inbox.sending") : editingSuggestion ? t("inbox.sendEdited") : t("inbox.useThis")}
            </EmButton>
            <EmButton
              variant="secondary"
              onClick={() => handleUseAiSuggestion(true)}
              disabled={sendingSuggestion}
              className="flex-1 justify-center gap-1.5"
            >
              <Edit3 className="w-3 h-3 flex-shrink-0" aria-hidden="true" />
               {editingSuggestion ? t("common.cancel") : t("inbox.editAndUse")}
            </EmButton>
               </>
             )}
            <EmButton
              variant="ghost"
              onClick={() => heldAiMsg && void onDismissSuggestion(heldAiMsg.id)}
              className="flex-1 justify-center"
            >
              {t("inbox.ignore")}
            </EmButton>
          </div>
        </div>
      )}

      {/* Composer — keyed per conversation (D-A3-6): switching threads remounts
          it so draft text, attachments and open pickers never leak from one
          customer's conversation into another's. */}
      <InboxComposer
        key={selectedConversation.id}
        selectedConversation={selectedConversation}
        is24hExpired={is24hExpired}
        is24hWarning={is24hWarning}
        interactionChoicesEnabled={interactionChoicesEnabled}
        templates={templates}
        quickReplyTemplates={quickReplyTemplates}
        loadingTemplates={loadingTemplates}
        planFeaturesAdvancedAI={planFeaturesAdvancedAI}
        onMessageSent={onMessageSent}
        onSendFailed={onSendFailed}
        onTemplatesChanged={onTemplatesChanged}
      />

      {/* Thread-level evidence rail (guardrails §14; §24 adaptation in PR body) */}
      {narrative && (
        <InboxEvidenceRail
          conversation={selectedConversation}
          narrative={narrative}
          sseConnected={sseConnected}
          outboundResult={outboundResult}
          groundingRefs={heldAiMsg?.source_references}
        />
      )}

      {/* Resolve Dialog */}
      {showResolveDialog && (
        <div
          className="fixed inset-0 bg-em-midnight-950/60 flex items-center justify-center z-50 p-4"
          onKeyDown={(e) => { if (e.key === "Escape") { onSetShowResolveDialog(false); onSetResolveNote(""); } }}
          onClick={(e) => { if (e.target === e.currentTarget) { onSetShowResolveDialog(false); onSetResolveNote(""); } }}
        >
          <div
            ref={resolveDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="inbox-resolve-title"
            className="bg-em-bg-surface rounded-xl shadow-xl w-full max-w-md p-6 space-y-4"
          >
            <div className="flex items-center gap-3">
              <CheckCircle2 className="w-6 h-6 text-em-success-700 flex-shrink-0" aria-hidden="true" />
              <h2 id="inbox-resolve-title" className="text-lg font-semibold text-em-text-primary">
                {t("inbox.resolveDialogTitle")}
              </h2>
            </div>
            <p className="text-sm text-em-text-secondary">{t("inbox.resolveDialogDescription")}</p>
            {aiReplyMode === "AUTO" && (
              <p className="text-sm text-em-text-secondary">{t("inbox.resolveDialogResumeDescription")}</p>
            )}
            <textarea
              value={resolveNote}
              onChange={(e) => onSetResolveNote(e.target.value)}
              placeholder={t("inbox.resolveNotePlaceholder")}
              rows={3}
              className={`w-full px-3 py-2 border border-em-border-strong bg-em-bg-surface rounded-lg text-sm text-em-text-primary focus:outline-none ${FOCUS_RING}`}
            />
            <div className="flex gap-3 justify-end">
              <EmButton
                variant="secondary"
                onClick={() => { onSetShowResolveDialog(false); onSetResolveNote(""); }}
              >
                {t("common.cancel")}
              </EmButton>
              <EmButton
                variant="primary"
                onClick={onResolve}
                disabled={resolvingConversation}
                loading={resolvingConversation}
              >
                {t("inbox.resolveConfirm")}
              </EmButton>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
