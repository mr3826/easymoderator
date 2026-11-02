import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { CheckCircle2, Loader2, MessageSquare, Sparkles, X } from "lucide-react";
import { toast } from "sonner";
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
      className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4 md:p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          {showCustomer && opportunity.customer && (
            <button
              type="button"
              onClick={() => navigate(`/customers/${opportunity.customer_id}`)}
              className="font-semibold text-gray-900 hover:text-brand-hover truncate text-left"
            >
              {opportunity.customer.name || t("customer360.unknownName")}
            </button>
          )}
          <p className="text-xs text-gray-500 mt-0.5" title={formatDateTime(opportunity.detected_at, i18n.language)}>
            {t("customer360.detectedAt", { time: formatRelative(opportunity.last_signal_at, i18n.language) })}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold ${strengthStyles[opportunity.strength]}`}>
            <Sparkles className="w-3 h-3" aria-hidden="true" />
            {t(`customer360.strength.${opportunity.strength}`)}
          </span>
          {!live && (
            <span className="px-2.5 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-600">
              {t(`customer360.opportunityStatus.${opportunity.status}`)}
            </span>
          )}
          {opportunity.status === "ACTIONED" && (
            <span className="px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-50 text-emerald-700">
              {t("customer360.opportunityStatus.ACTIONED")}
            </span>
          )}
        </div>
      </div>

      <ul className="mt-3 flex flex-wrap gap-2" aria-label="reasons">
        {opportunity.reasons.map((code) => (
          <li key={code} className="px-2.5 py-1 rounded-lg bg-gray-50 border border-gray-100 text-xs text-gray-700">
            {t(`customer360.reasons.${code}`, { defaultValue: code })}
          </li>
        ))}
      </ul>

      {opportunity.product_refs.length > 0 && (
        <p className="mt-3 text-sm text-gray-700">
          <span className="font-medium">{t("customer360.products")}:</span>{" "}
          {opportunity.product_refs.map((p) => `${p.name ?? "—"}${p.quantity && p.quantity > 1 ? ` × ${p.quantity}` : ""}`).join(", ")}
        </p>
      )}

      {live && action && (
        <p className="mt-3 text-sm text-gray-600" data-testid="opportunity-recommended-action">
          {t(`customer360.recommended.${action.code}`, {
            time: action.window_closes_at ? formatDateTime(action.window_closes_at, i18n.language) : "",
          })}
        </p>
      )}

      {live && (
        <div className="mt-4 flex flex-wrap gap-2">
          {opportunity.conversation_id && action?.code !== "DO_NOT_CONTACT" && (
            <button
              type="button"
              onClick={() => navigate(`/inbox?conversation=${encodeURIComponent(opportunity.conversation_id!)}`)}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-brand-hover"
            >
              <MessageSquare className="w-4 h-4" aria-hidden="true" />
              {t("customer360.actions.openConversation")}
            </button>
          )}
          {opportunity.status === "OPEN" && (
            <button
              type="button"
              onClick={() => run("contacted")}
              disabled={busy !== null}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-gray-200 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              {busy === "contacted" ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" aria-hidden="true" />}
              {t("customer360.actions.markContacted")}
            </button>
          )}
          <button
            type="button"
            onClick={() => setDismissOpen((open) => !open)}
            disabled={busy !== null}
            aria-expanded={dismissOpen}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium text-gray-500 hover:bg-gray-50 disabled:opacity-50"
          >
            <X className="w-4 h-4" aria-hidden="true" />
            {t("customer360.actions.dismiss")}
          </button>
        </div>
      )}

      {live && dismissOpen && (
        <div className="mt-3 rounded-xl border border-gray-200 bg-gray-50 p-3 flex flex-col sm:flex-row sm:items-end gap-2">
          <label className="flex-1 text-sm text-gray-700">
            <span className="block mb-1 font-medium">{t("customer360.dismissTitle")}</span>
            <select
              value={reason}
              onChange={(e) => setReason(e.target.value as DismissReason)}
              className="w-full px-3 py-2 border border-gray-200 rounded-lg bg-white text-sm"
            >
              {DISMISS_REASONS.map((code) => (
                <option key={code} value={code}>{t(`customer360.dismissReasons.${code}`)}</option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={() => run("dismiss")}
            disabled={busy !== null}
            className="px-3 py-2 rounded-lg bg-gray-900 text-white text-sm font-medium hover:bg-black disabled:opacity-50"
          >
            {busy === "dismiss" ? <Loader2 className="w-4 h-4 animate-spin" /> : t("customer360.actions.dismiss")}
          </button>
        </div>
      )}
    </article>
  );
}
