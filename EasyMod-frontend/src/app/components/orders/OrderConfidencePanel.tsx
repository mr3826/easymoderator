import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, CheckCircle2, ChevronDown, Info, Loader2, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import {
  approveOrderConfidence,
  decisionFromConflict,
  getOrderConfidence,
  verifyOrderConfidence,
} from "@/api/domains/order-confidence";
import type { ConfidenceReason, OrderConfidenceDecision, VerifyMethod } from "@/api/types/customer-intelligence";
import { useAuth } from "../../../features/auth/AuthProvider";
import { formatDateTime } from "../customers/customerDisplay";

const METHODS: VerifyMethod[] = ["PHONE_CALL", "CHAT", "IN_PERSON", "OTHER"];

const decisionStyle = {
  READY: { box: "bg-emerald-50 border-emerald-200", text: "text-emerald-800" },
  VERIFY: { box: "bg-amber-50 border-amber-200", text: "text-amber-900" },
  MANUAL_REVIEW: { box: "bg-orange-50 border-orange-200", text: "text-orange-900" },
} as const;

function reasonText(reason: ConfidenceReason, t: (k: string, o?: Record<string, unknown>) => string) {
  return t(`orderConfidence.reasons.${reason.code}`, { ...(reason.evidence || {}), defaultValue: reason.code });
}

interface Props {
  orderId: string;
  /** Bumped by the parent after a booking attempt so the panel re-reads. */
  refreshKey?: number;
}

/**
 * RTO Shield v2 decision for one order. Everything shown here is computed and
 * enforced on the server; the buttons only record a merchant decision, and
 * the role check below is presentation — the API refuses a staff approval.
 */
export default function OrderConfidencePanel({ orderId, refreshKey = 0 }: Props) {
  const { t, i18n } = useTranslation();
  const { currentShop } = useAuth();
  const canApprove = ["owner", "admin"].includes(String(currentShop?.role || "").toLowerCase());
  const [decision, setDecision] = useState<OrderConfidenceDecision | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [method, setMethod] = useState<VerifyMethod>("PHONE_CALL");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  const load = useCallback(async () => {
    setState("loading");
    try {
      setDecision(await getOrderConfidence(orderId));
      setState("ready");
    } catch {
      setState("error");
    }
  }, [orderId]);

  useEffect(() => { void load(); }, [load, refreshKey]);

  if (state === "loading") {
    return (
      <div className="rounded-lg border border-gray-200 p-4 mb-6 text-sm text-gray-600 flex items-center gap-2" role="status">
        <Loader2 className="w-4 h-4 animate-spin" /> {t("orderConfidence.loading")}
      </div>
    );
  }
  if (state === "error") {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-4 mb-6 text-sm text-red-800" role="alert">
        {t("orderConfidence.loadFailed")}
        <button type="button" onClick={() => void load()} className="ml-3 font-semibold underline">
          {t("orders.retry")}
        </button>
      </div>
    );
  }
  if (!decision || decision.mode === "off" || !decision.decision) return null;

  const effective = decision.effective_state ?? decision.decision;
  const style = decisionStyle[effective];
  const actionable = (decision.reasons || []).filter((r) => r.severity !== "INFO");
  const context = (decision.reasons || []).filter((r) => r.severity === "INFO");
  const resolved = decision.resolution?.applies;

  const submit = async () => {
    if (!decision.decision_version) return;
    setSaving(true);
    try {
      const next = decision.required_action === "APPROVE"
        ? await approveOrderConfidence(orderId, { decision_version: decision.decision_version, note: note.trim() })
        : await verifyOrderConfidence(orderId, {
          decision_version: decision.decision_version, method, ...(note.trim() ? { note: note.trim() } : {}),
        });
      setDecision(next);
      setNote("");
      toast.success(decision.required_action === "APPROVE" ? t("orderConfidence.approved") : t("orderConfidence.verified"));
    } catch (error) {
      const fresh = decisionFromConflict(error);
      if (fresh) {
        setDecision(fresh);
        toast.warning(t("orderConfidence.changed"));
      } else {
        toast.error(t("orderConfidence.actionFailed"));
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className={`rounded-lg border p-4 mb-6 ${style.box}`} data-testid="order-confidence-panel" aria-live="polite">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold text-gray-900 flex items-center gap-2">
          {effective === "READY"
            ? <ShieldCheck className="w-5 h-5 text-emerald-600" aria-hidden="true" />
            : <AlertTriangle className="w-5 h-5 text-amber-600" aria-hidden="true" />}
          {t("orderConfidence.title")}
        </h3>
        <span className={`text-sm font-semibold ${style.text}`} data-testid="order-confidence-decision">
          {resolved ? t("orderConfidence.resolvedReady") : t(`orderConfidence.decisions.${decision.decision}`)}
        </span>
      </div>

      {decision.mode === "shadow" && (
        <p className="mt-2 text-xs text-gray-600 flex items-start gap-1.5">
          <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" aria-hidden="true" /> {t("orderConfidence.shadowNote")}
        </p>
      )}
      {decision.bookable === false && (
        <p className="mt-2 text-sm font-medium text-red-800">{t("orderConfidence.notBookable")}</p>
      )}
      {decision.mode === "enforce" && effective !== "READY" && decision.bookable !== false && (
        <p className="mt-2 text-sm text-gray-800">{t("orderConfidence.held")}</p>
      )}
      {decision.resolution?.stale && (
        <p className="mt-2 text-sm text-orange-900">{t("orderConfidence.staleResolution")}</p>
      )}

      {actionable.length > 0 && (
        <ul className="mt-3 space-y-1.5" data-testid="order-confidence-reasons">
          {actionable.map((reason) => (
            <li key={reason.code} className="text-sm text-gray-900 flex items-start gap-2">
              <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-current shrink-0" aria-hidden="true" />
              {reasonText(reason, t)}
            </li>
          ))}
        </ul>
      )}
      {context.length > 0 && (
        <p className="mt-2 text-xs text-gray-600">
          {t("orderConfidence.context")}: {context.map((r) => reasonText(r, t)).join(" · ")}
        </p>
      )}

      {decision.resolution?.applies && (
        <p className="mt-3 text-sm text-emerald-800 flex items-center gap-1.5">
          <CheckCircle2 className="w-4 h-4" aria-hidden="true" />
          {t("orderConfidence.resolvedBy", {
            type: t(`orderConfidence.resolutionTypes.${decision.resolution.type}`),
            time: formatDateTime(decision.resolution.resolved_at, i18n.language),
          })}
          {decision.resolution.note ? ` — ${decision.resolution.note}` : ""}
        </p>
      )}

      {(decision.required_action === "VERIFY" || (decision.required_action === "APPROVE" && canApprove)) && (
        <div className="mt-4 rounded-lg bg-white/70 border border-gray-200 p-3 space-y-3" data-testid="order-confidence-action">
          <div>
            <p className="text-sm font-medium text-gray-900">{t("orderConfidence.verifyTitle")}</p>
            <p className="text-xs text-gray-600">{t("orderConfidence.verifyHelp")}</p>
          </div>
          {decision.required_action === "VERIFY" && (
            <label className="block text-sm text-gray-700">
              <span className="block mb-1">{t("orderConfidence.method")}</span>
              <select
                value={method}
                onChange={(e) => setMethod(e.target.value as VerifyMethod)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg bg-white text-sm"
              >
                {METHODS.map((m) => <option key={m} value={m}>{t(`orderConfidence.methods.${m}`)}</option>)}
              </select>
            </label>
          )}
          <label className="block text-sm text-gray-700">
            <span className="block mb-1">
              {decision.required_action === "APPROVE" ? t("orderConfidence.approveNote") : t("orderConfidence.note")}
            </span>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              maxLength={500}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg bg-white text-sm"
            />
          </label>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={saving || (decision.required_action === "APPROVE" && note.trim().length < 5)}
            className="w-full sm:w-auto px-4 py-2 rounded-lg bg-gray-900 text-white text-sm font-medium hover:bg-black disabled:opacity-50"
            data-testid="order-confidence-submit"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin inline" /> : decision.required_action === "APPROVE"
              ? t("orderConfidence.approveButton")
              : t("orderConfidence.verifyButton")}
          </button>
        </div>
      )}
      {decision.required_action === "APPROVE" && !canApprove && (
        <p className="mt-3 text-sm text-gray-700" data-testid="order-confidence-approve-help">{t("orderConfidence.approveHelp")}</p>
      )}

      {decision.outcome && (
        <p className="mt-3 text-xs text-gray-600">
          {t("orderConfidence.outcome", { outcome: t(`customer360.detail.outcome.${decision.outcome}`, { defaultValue: decision.outcome }) })}
        </p>
      )}

      {(decision.history?.length ?? 0) > 0 && (
        <div className="mt-3">
          <button
            type="button"
            onClick={() => setShowHistory((v) => !v)}
            aria-expanded={showHistory}
            className="text-xs font-medium text-gray-700 inline-flex items-center gap-1"
          >
            {t("orderConfidence.history")}
            <ChevronDown className={`w-3.5 h-3.5 transition-transform ${showHistory ? "rotate-180" : ""}`} aria-hidden="true" />
          </button>
          {showHistory && (
            <ol className="mt-2 space-y-1 text-xs text-gray-700">
              {[...(decision.history || [])].reverse().map((entry, i) => (
                <li key={`${entry.at}-${i}`}>
                  <span className="text-gray-500">{formatDateTime(entry.at, i18n.language)}</span>{" · "}
                  {t(`orderConfidence.events.${entry.event}`, { defaultValue: entry.event })}
                  {entry.decision ? ` (${t(`orderConfidence.decisions.${entry.decision}`, { defaultValue: entry.decision })})` : ""}
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </section>
  );
}
