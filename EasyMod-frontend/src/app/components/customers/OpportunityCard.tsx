import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { CheckCircle2, Loader2, MessageSquare, Sparkles, X } from "lucide-react";
import { toast } from "sonner";
import { EmButton } from "../dashboard/EmButton";
import {
  dismissOpportunity,
  markOpportunityContacted,
} from "@/api/domains/customer-intelligence";
import type { DismissReason, Opportunity } from "@/api/types/customer-intelligence";
import { formatDateTime, formatRelative, strengthStyles } from "./customerDisplay";

const DISMISS_REASONS: DismissReason[] = ["NOT_INTERESTED", "ALREADY_HANDLED", "NOT_A_REAL_REQUEST", "OTHER"];

interface Props {
  opportunity: Opportunity;
  showCustomer?: boolean;
  onChanged?: (updated: Opportunity) => void;
}

/**
 * One sales opportunity with its reasons and the next manual step. Following
 * up always happens in the Inbox, where the normal messaging policy applies —
 * nothing here sends a message.
 */
export default function OpportunityCard({ opportunity, showCustomer = true, onChanged }: Props) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [busy, setBusy] = useState<"contacted" | "dismiss" | null>(null);
  const [dismissOpen, setDismissOpen] = useState(false);
  const [reason, setReason] = useState<DismissReason>("NOT_INTERESTED");
  const live = opportunity.status === "OPEN" || opportunity.status === "ACTIONED";
  const action = opportunity.recommended_action;

  const run = async (kind: "contacted" | "dismiss") => {
    setBusy(kind);
    try {
      const updated = kind === "contacted"
        ? await markOpportunityContacted(opportunity.id)
        : await dismissOpportunity(opportunity.id, reason);
      toast.success(kind === "contacted" ? t("customer360.contacted") : t("customer360.dismissed"));
      setDismissOpen(false);
      onChanged?.({ ...opportunity, ...updated, customer: opportunity.customer });
    } catch {
      toast.error(t("customer360.actionFailed"));
    } finally {
      setBusy(null);
    }
  };

  return (
    <article
      data-testid={`opportunity-${opportunity.id}`}
      className="bg-em-bg-surface rounded-2xl border border-em-border shadow-sm p-4 md:p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          {showCustomer && opportunity.customer && (
            <button
              type="button"
              onClick={() => navigate(`/customers/${opportunity.customer_id}`)}
              className="font-semibold text-em-text-primary hover:text-em-violet-700 truncate text-left"
            >
              {opportunity.customer.name || t("customer360.unknownName")}
            </button>
          )}
          <p className="text-xs text-em-text-secondary mt-0.5" title={formatDateTime(opportunity.detected_at, i18n.language)}>
            {t("customer360.detectedAt", { time: formatRelative(opportunity.last_signal_at, i18n.language) })}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold ${strengthStyles[opportunity.strength]}`}>
            <Sparkles className="w-3 h-3" aria-hidden="true" />
            {t(`customer360.strength.${opportunity.strength}`)}
          </span>
          {!live && (
            <span className="px-2.5 py-1 rounded-full text-xs font-medium bg-em-bg-muted text-em-text-secondary">
              {t(`customer360.opportunityStatus.${opportunity.status}`)}
            </span>
          )}
          {opportunity.status === "ACTIONED" && (
            <span className="px-2.5 py-1 rounded-full text-xs font-medium bg-em-success-100 text-em-success-700">
              {t("customer360.opportunityStatus.ACTIONED")}
            </span>
          )}
        </div>
      </div>

      <ul className="mt-3 flex flex-wrap gap-2" aria-label="reasons">
        {opportunity.reasons.map((code) => (
          <li key={code} className="px-2.5 py-1 rounded-lg bg-em-bg-muted border border-em-border text-xs text-em-text-primary">
            {t(`customer360.reasons.${code}`, { defaultValue: code })}
          </li>
        ))}
      </ul>

      {opportunity.product_refs.length > 0 && (
        <p className="mt-3 text-sm text-em-text-primary">
          <span className="font-medium">{t("customer360.products")}:</span>{" "}
          {opportunity.product_refs.map((p) => `${p.name ?? "—"}${p.quantity && p.quantity > 1 ? ` × ${p.quantity}` : ""}`).join(", ")}
        </p>
      )}

      {live && action && (
        <p className="mt-3 text-sm text-em-text-secondary" data-testid="opportunity-recommended-action">
          {t(`customer360.recommended.${action.code}`, {
            time: action.window_closes_at ? formatDateTime(action.window_closes_at, i18n.language) : "",
          })}
        </p>
      )}

      {live && (
        <div className="mt-4 flex flex-wrap gap-2">
          {opportunity.conversation_id && action?.code !== "DO_NOT_CONTACT" && (
            <EmButton
              variant="primary"
              onClick={() => navigate(`/inbox?conversation=${encodeURIComponent(opportunity.conversation_id!)}`)}
            >
              <MessageSquare className="w-4 h-4" aria-hidden="true" />
              {t("customer360.actions.openConversation")}
            </EmButton>
          )}
          {opportunity.status === "OPEN" && (
            <EmButton
              variant="secondary"
              onClick={() => run("contacted")}
              disabled={busy !== null}
            >
              {busy === "contacted" ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" aria-hidden="true" />}
              {t("customer360.actions.markContacted")}
            </EmButton>
          )}
          <button
            type="button"
            onClick={() => setDismissOpen((open) => !open)}
            disabled={busy !== null}
            aria-expanded={dismissOpen}
            className="inline-flex min-h-11 items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-em-text-secondary hover:bg-em-bg-muted focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-em-focus-light disabled:opacity-50"
          >
            <X className="w-4 h-4" aria-hidden="true" />
            {t("customer360.actions.dismiss")}
          </button>
        </div>
      )}

      {live && dismissOpen && (
        <div className="mt-3 rounded-xl border border-em-border bg-em-bg-muted p-3 flex flex-col sm:flex-row sm:items-end gap-2">
          <label className="flex-1 text-sm text-em-text-primary">
            <span className="block mb-1 font-medium">{t("customer360.dismissTitle")}</span>
            <select
              value={reason}
              onChange={(e) => setReason(e.target.value as DismissReason)}
              className="w-full px-3 py-2 border border-em-border rounded-lg bg-em-bg-surface text-sm"
            >
              {DISMISS_REASONS.map((code) => (
                <option key={code} value={code}>{t(`customer360.dismissReasons.${code}`)}</option>
              ))}
            </select>
          </label>
          <EmButton
            variant="danger"
            onClick={() => run("dismiss")}
            disabled={busy !== null}
          >
            {busy === "dismiss" ? <Loader2 className="w-4 h-4 animate-spin" /> : t("customer360.actions.dismiss")}
          </EmButton>
        </div>
      )}
    </article>
  );
}
