/**
 * Thread-level evidence rail (guardrails §14/§24 EvidencePanel, adapted).
 * The §24 shape is moderation-item shaped: `merchantId` has no inbox analog
 * (the tenant is the JWT shop, shown in the page breadcrumb; the counterparty
 * here is a customer) and no policy reference exists on conversations — the
 * honest substitute is the AI draft's stored grounding references. Deviations
 * are documented in the PR body. Presentational only: a native <details>/<dl>,
 * never a combobox, never a heading carrying the customer name, never an echo
 * of message content (list/thread dedup pins).
 */
import { FileSearch } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import type { Conversation, MessageSourceReference } from "@/api/types/conversation";
import { formatRelative } from "../customers/customerDisplay";
import { replyReasonLabel } from "./InboxThreadList";
import type { InboxNarrative } from "./derive";

export type OutboundResult = "confirmed" | "pending" | "failed" | "none";

const OUTCOME_KEYS: Record<OutboundResult, string> = {
  confirmed: "inbox.evidence.deliveryConfirmed",
  pending: "inbox.evidence.deliveryPending",
  failed: "inbox.evidence.deliveryFailed",
  none: "inbox.evidence.deliveryNone",
};

interface InboxEvidenceRailProps {
  conversation: Conversation;
  narrative: InboxNarrative;
  sseConnected: boolean;
  outboundResult: OutboundResult;
  groundingRefs?: MessageSourceReference[] | null;
}

function Row({ label, value, tabular }: { label: string; value: string; tabular?: boolean }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2">
      <dt className="font-medium text-em-text-secondary">{label}</dt>
      <dd className={`min-w-0 truncate text-em-text-primary ${tabular ? "em-tabular" : ""}`}>{value}</dd>
    </div>
  );
}

export function InboxEvidenceRail({
  conversation,
  narrative,
  sseConnected,
  outboundResult,
  groundingRefs,
}: InboxEvidenceRailProps) {
  const { t, i18n } = useTranslation();
  const source = [
    conversation.channel,
    conversation.metaChannel?.displayName,
    conversation.metaChannel?.purposeLabel,
  ].filter(Boolean).join(" · ");
  const grounding = Array.isArray(groundingRefs) ? groundingRefs : [];

  return (
    <details
      data-testid="inbox-evidence-rail"
      className="mx-4 mb-4 rounded-xl border border-em-border bg-em-bg-surface"
    >
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-4 text-sm font-semibold text-em-text-primary focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-em-focus-light focus-visible:transition-none">
        <FileSearch className="h-4 w-4 text-em-text-secondary" aria-hidden="true" />
        {t("inbox.evidence.title")}
      </summary>
      <dl className="space-y-1.5 px-4 pb-3 text-xs">
        <Row label={t("inbox.evidence.conversation")} value={conversation.id} tabular />
        <Row
          label={t("inbox.evidence.customer")}
          value={
            conversation.customer_id
              ? `${conversation.customer?.name || t("inbox.unknownCustomer")} (${conversation.customer_id})`
              : t("inbox.evidence.customerUnlinked")
          }
        />
        <Row label={t("inbox.evidence.source")} value={source} />
        <Row
          label={t("inbox.evidence.replyTask")}
          value={
            conversation.needs_merchant_reply
              ? t("inbox.evidence.replyTaskSentence", {
                  reason: replyReasonLabel(t, conversation.needs_merchant_reply_reason),
                })
              : t("inbox.replyReason.noReplyNeeded")
          }
        />
        <Row
          label={t("inbox.evidence.lastActivity")}
          value={formatRelative(conversation.updated_at, i18n.language)}
          tabular
        />
        <Row label={t("inbox.evidence.delivery")} value={t(OUTCOME_KEYS[outboundResult])} />
        {grounding.length > 0 && (
          <Row
            label={t("inbox.evidence.grounding", { count: grounding.length })}
            value={grounding.map((reference) => reference.title || reference.id).filter(Boolean).join(", ")}
          />
        )}
        <Row
          label={t("inbox.evidence.title")}
          value={sseConnected ? t("inbox.evidence.syncSse") : t("inbox.evidence.syncOffline")}
        />
      </dl>
      <div className="space-y-1 border-t border-em-border px-4 py-3">
        <p aria-live="polite" className="em-tabular text-xs font-medium text-em-text-secondary">
          {narrative.provenResult}
        </p>
        <p className="text-xs text-em-text-secondary">{narrative.whereNext}</p>
        {conversation.customer_id && (
          <Link
            to={`/customers?customerId=${encodeURIComponent(conversation.customer_id)}`}
            aria-label={t("inbox.evidence.customer")}
            className="inline-flex min-h-11 items-center rounded-lg px-2 text-xs font-semibold text-em-violet-700 hover:bg-em-violet-50 focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-em-focus-light focus-visible:transition-none"
          >
            {t("inbox.viewCustomer")}
          </Link>
        )}
      </div>
    </details>
  );
}
