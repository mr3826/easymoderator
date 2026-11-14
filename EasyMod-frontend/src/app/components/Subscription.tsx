import {
  AlertCircle,
  CreditCard,
  Download,
  Eye,
  Loader2,
  ReceiptText,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Badge } from "@/app/components/ui/badge";
import { Button } from "@/app/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/app/components/ui/card";
import {
  cancelInvoicePayment,
  completeInvoicePayment,
  getBillingLines,
  getInvoices,
  payInvoice,
  type InvoiceBillingLine,
} from "@/api/domains/subscription";
import { useCommercialContract } from "@/api/domains/commercialContract";
import type { Invoice } from "@/api/types/subscription";
import { buildApiUrl, isBkashEnabled } from "@/app/lib/config";
import { formatBdt, formatBdtBn } from "@/shared/contracts/commercial-contract";
import { getErrorMessage } from "@shared/lib/http/errors";
import { Claim } from "./claims/Claim";
import { ClaimProvider } from "./claims/ClaimProvider";

/**
 * Billing page (ADR-0011).
 *
 * There is no plan picker, no metered usage entitlement and no prepaid credit
 * store: the only merchant price is the frozen delivered-order contract. Every
 * number on this page comes from the validated public contract payload
 * (rendered through the contract formatters), and every capability sentence
 * comes from the claim registry. If the contract cannot be validated no price
 * is shown at all.
 */

interface InvoiceRow {
  id: string;
  rawId: string;
  billingPeriod: string;
  amount: number | null;
  status: string;
  type: string;
  date: string;
}

const invoiceAmountMinor = (amount: number | string): number | null => {
  const value = Number(amount);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 100);
};

export default function Subscription() {
  const { t, i18n } = useTranslation();
  const locale = String(i18n?.language ?? "").toLowerCase();
  const formatMinor = (minor: number) => (locale.startsWith("bn") ? formatBdtBn(minor) : formatBdt(minor));
  const localeCode = locale.startsWith("bn") ? "bn-BD" : "en-GB";

  const bkashEnabled = isBkashEnabled();
  const contractQuery = useCommercialContract();
  const contract = contractQuery.data ?? null;

  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [invoicesLoading, setInvoicesLoading] = useState(true);
  const [expandedInvoiceId, setExpandedInvoiceId] = useState<string | null>(null);
  const [payingInvoiceId, setPayingInvoiceId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const loadInvoices = async () => {
    try {
      setInvoicesLoading(true);
      const rows = await getInvoices();
      setInvoices(
        Array.isArray(rows)
          ? rows.map((invoice: Invoice) => ({
              id: invoice.invoice_number,
              rawId: invoice.id,
              billingPeriod: invoice.billing_period,
              amount: invoiceAmountMinor(invoice.amount),
              status: invoice.status,
              type: invoice.invoice_type || "delivered_order",
              date: invoice.created_at
                ? new Date(invoice.created_at).toLocaleDateString(localeCode, {
                    day: "numeric",
                    month: "short",
                    year: "numeric",
                  })
                : "",
            }))
          : [],
      );
    } catch (loadError) {
      console.error("Failed to load invoices:", loadError);
      toast.error(t("subscription.invoicesLoadFailed"));
      setInvoices([]);
    } finally {
      setInvoicesLoading(false);
    }
  };

  const handlePaymentReturn = async () => {
    const params = new URLSearchParams(window.location.search);
    const paymentId = params.get("paymentID");
    const contextRaw = sessionStorage.getItem("easymod_pay_ctx");
    if (!paymentId || !contextRaw) return;

    let invoiceId: string;
    try {
      const context = JSON.parse(contextRaw) as { kind?: string; ref?: string };
      if (context?.kind !== "invoice" || typeof context.ref !== "string") {
        throw new Error("Unsupported payment context");
      }
      invoiceId = context.ref;
    } catch {
      sessionStorage.removeItem("easymod_pay_ctx");
      setError(t("subscription.paymentVerifyFailed"));
      return;
    }

    sessionStorage.removeItem("easymod_pay_ctx");
    window.history.replaceState({}, "", window.location.pathname);
    if (params.get("status") && params.get("status") !== "success") {
      await cancelInvoicePayment(invoiceId, paymentId).catch((cancelError) => {
        console.error("Failed to release cancelled invoice checkout:", cancelError);
      });
      setError(t("subscription.paymentCancelled"));
      return;
    }

    try {
      await completeInvoicePayment(invoiceId, paymentId);
      setSuccess(t("subscription.invoicePaymentSuccess"));
      await loadInvoices();
    } catch (paymentError) {
      setError(getErrorMessage(paymentError, t("subscription.paymentVerifyFailed")));
    }
  };

  useEffect(() => {
    void loadInvoices();
    void handlePaymentReturn();
  }, []);

  const linesQuery = useQuery({
    queryKey: ["billing-lines", expandedInvoiceId],
    queryFn: () => getBillingLines(expandedInvoiceId as string),
    enabled: Boolean(expandedInvoiceId),
    retry: 0,
  });

  const startBkashCheckout = (ref: string, bkashUrl: string) => {
    sessionStorage.setItem("easymod_pay_ctx", JSON.stringify({ kind: "invoice", ref }));
    window.location.href = bkashUrl;
  };

  const handlePayInvoice = async (invoiceId: string) => {
    if (!bkashEnabled) return;
    try {
      setPayingInvoiceId(invoiceId);
      setError(null);
      const result = await payInvoice(invoiceId);
      if (!result?.bkash_url) throw new Error(t("subscription.bkashStartFailed"));
      startBkashCheckout(invoiceId, result.bkash_url);
    } catch (paymentError) {
      setError(getErrorMessage(paymentError, t("subscription.bkashStartFailed")));
      setPayingInvoiceId(null);
    }
  };

  const outstanding = invoices.find(
    (invoice) => invoice.status === "pending" || invoice.status === "overdue",
  );

  const invoiceStatusLabel = (status: string) => {
    const known = ["paid", "pending", "overdue", "cancelled"];
    return known.includes(status)
      ? t(`subscription.status.${status}`, status)
      : status;
  };

  const invoiceStatusClass = (status: string) => {
    if (status === "paid") return "bg-emerald-100 text-emerald-700";
    if (status === "overdue") return "bg-red-100 text-red-700";
    if (status === "cancelled") return "bg-gray-100 text-gray-600";
    return "bg-amber-100 text-amber-700";
  };

  return (
    <div className="mx-auto max-w-7xl p-4 font-bn md:p-8">
      <div className="mb-6 flex flex-col gap-3 md:mb-8 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 md:text-3xl">{t("subscription.title")}</h1>
          <p className="mt-1 text-sm text-gray-600 md:text-base">{t("subscription.subtitle")}</p>
        </div>
        {outstanding && (
          <Button
            onClick={() => void handlePayInvoice(outstanding.rawId)}
            disabled={!bkashEnabled || payingInvoiceId === outstanding.rawId}
          >
            <CreditCard className="mr-2 h-4 w-4" />
            {bkashEnabled ? t("subscription.payInvoice") : t("subscription.bkashUnavailable")}
          </Button>
        )}
      </div>

      {error && <div className="mb-6 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div>}
      {success && <div className="mb-6 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-700">{success}</div>}

      <ClaimProvider surface="subscription">
        <Card className="mb-6 overflow-hidden border-emerald-100 bg-gradient-to-br from-white to-emerald-50/60">
          <CardHeader>
            <CardTitle>{t("subscription.contractTitle")}</CardTitle>
            <p className="text-sm text-gray-500">{t("subscription.contractSubtitle")}</p>
          </CardHeader>
          <CardContent className="space-y-3">
            {contractQuery.isLoading && (
              <p role="status" className="text-sm text-gray-500">{t("subscription.loading")}</p>
            )}
            {contractQuery.error && (
              <div role="alert" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                {t("subscription.contractUnavailable")}
              </div>
            )}
            {contract && (
              <>
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="text-3xl font-bold text-gray-900">
                    {formatMinor(contract.unit_price_minor)}
                  </span>
                  <span className="text-sm text-gray-600">{t("subscription.perDeliveredOrder")}</span>
                </div>
                <p className="text-sm text-gray-600">
                  {t("subscription.dueWithin", { days: contract.due_days })}
                </p>
                <p className="text-sm text-gray-600">
                  {t("subscription.zeroRatedNote", { amount: formatMinor(0) })}
                </p>
                <p className="text-xs uppercase tracking-wide text-gray-400">
                  {t("subscription.contractVersion", { version: contract.contract_version })}
                </p>
                <div className="space-y-2 rounded-lg bg-white/70 p-3 text-sm text-gray-700">
                  <Claim id="billing.delivered_order" surface="subscription" className="block" />
                  <Claim id="billing.overdue_policy" surface="subscription" className="block" />
                </div>
              </>
            )}
          </CardContent>
        </Card>

        <Card className="mb-6">
          <CardHeader>
            <CardTitle>{t("subscription.capabilitiesTitle")}</CardTitle>
            <p className="text-sm text-gray-500">{t("subscription.capabilitiesSubtitle")}</p>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-3">
            <div className="space-y-2 text-sm text-gray-700">
              <h3 className="font-semibold text-gray-900">{t("subscription.capabilityGroups.ai")}</h3>
              <Claim id="ai.draft_reply" surface="subscription" className="block" />
              <Claim id="ai.auto_reply" surface="subscription" className="block" />
            </div>
            <div className="space-y-2 text-sm text-gray-700">
              <h3 className="font-semibold text-gray-900">{t("subscription.capabilityGroups.courier")}</h3>
              <Claim id="courier.pathao.booking_live" surface="subscription" className="block" />
              <Claim id="courier.steadfast.booking_live" surface="subscription" className="block" />
              <Claim id="courier.redx.booking_live" surface="subscription" className="block" />
              <Claim id="courier.pathao.integration_status" surface="subscription" className="block" />
              <Claim id="courier.steadfast.integration_status" surface="subscription" className="block" />
              <Claim id="courier.redx.integration_status" surface="subscription" className="block" />
              <Claim id="courier.cod_settlement.pathao" surface="subscription" className="block" />
              <Claim id="courier.cod_settlement.steadfast" surface="subscription" className="block" />
              <Claim id="courier.cod_settlement.redx" surface="subscription" className="block" />
            </div>
            <div className="space-y-2 text-sm text-gray-700">
              <h3 className="font-semibold text-gray-900">{t("subscription.capabilityGroups.voiceAndTools")}</h3>
              <Claim id="voice.transcription" surface="subscription" className="block" />
              <Claim id="addons.ads_studio.pilot" surface="subscription" className="block" />
              <Claim id="addons.storefront.pilot" surface="subscription" className="block" />
            </div>
          </CardContent>
        </Card>
      </ClaimProvider>

      <Card>
        <CardHeader>
          <CardTitle>{t("subscription.invoicesTitle")}</CardTitle>
        </CardHeader>
        <CardContent>
          {invoicesLoading ? (
            <p role="status" className="py-8 text-center text-sm text-gray-500">{t("subscription.loading")}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px]">
                <thead>
                  <tr className="border-b border-gray-200 text-left text-sm text-gray-600">
                    <th className="px-3 py-3">{t("subscription.invoiceColumns.id")}</th>
                    <th className="px-3 py-3">{t("subscription.invoiceColumns.period")}</th>
                    <th className="px-3 py-3">{t("subscription.invoiceColumns.type")}</th>
                    <th className="px-3 py-3">{t("subscription.invoiceColumns.amount")}</th>
                    <th className="px-3 py-3">{t("subscription.invoiceColumns.status")}</th>
                    <th className="px-3 py-3">{t("subscription.invoiceColumns.action")}</th>
                  </tr>
                </thead>
                <tbody>
                  {invoices.map((invoice) => {
                    const isExpanded = expandedInvoiceId === invoice.rawId;
                    return (
                      <InvoiceTableRows
                        key={invoice.rawId}
                        invoice={invoice}
                        isExpanded={isExpanded}
                        bkashEnabled={bkashEnabled}
                        paying={payingInvoiceId === invoice.rawId}
                        lines={isExpanded ? linesQuery.data : undefined}
                        linesLoading={isExpanded && linesQuery.isLoading}
                        linesError={isExpanded && Boolean(linesQuery.error)}
                        labels={{
                          pay: t("subscription.pay"),
                          paying: t("subscription.paying"),
                          bkashUnavailable: t("subscription.bkashUnavailable"),
                          view: t("subscription.viewBillingLines"),
                          hide: t("subscription.hideBillingLines"),
                          linesLoading: t("subscription.billingLinesLoading"),
                          linesUnavailable: t("subscription.billingLinesUnavailable"),
                          linesEmpty: t("subscription.billingLinesEmpty"),
                          lineOrder: t("subscription.billingLineColumns.order"),
                          lineKind: t("subscription.billingLineColumns.kind"),
                          lineOutcome: t("subscription.billingLineColumns.outcome"),
                          lineAmount: t("subscription.billingLineColumns.amount"),
                          status: invoiceStatusLabel(invoice.status),
                          statusClass: invoiceStatusClass(invoice.status),
                          type: t(`subscription.invoiceTypes.${invoice.type}`, invoice.type),
                          amount: invoice.amount === null ? "—" : formatMinor(invoice.amount),
                          formatMinor,
                          viewInvoice: t("subscription.viewInvoiceTitle"),
                          downloadInvoice: t("subscription.downloadInvoiceTitle"),
                        }}
                        onToggle={() => setExpandedInvoiceId(isExpanded ? null : invoice.rawId)}
                        onPay={() => void handlePayInvoice(invoice.rawId)}
                      />
                    );
                  })}
                </tbody>
              </table>
              {invoices.length === 0 && (
                <p className="py-8 text-center text-sm text-gray-500">{t("subscription.noInvoices")}</p>
              )}
            </div>
          )}
        </CardContent>
        <CardFooter className="text-sm text-gray-500">
          <AlertCircle className="mr-2 h-4 w-4 shrink-0 text-gray-400" />
          {t("subscription.invoiceDisclaimer")}
        </CardFooter>
      </Card>
    </div>
  );
}

interface InvoiceTableLabels {
  pay: string;
  paying: string;
  bkashUnavailable: string;
  view: string;
  hide: string;
  linesLoading: string;
  linesUnavailable: string;
  linesEmpty: string;
  lineOrder: string;
  lineKind: string;
  lineOutcome: string;
  lineAmount: string;
  status: string;
  statusClass: string;
  type: string;
  amount: string;
  formatMinor: (minor: number) => string;
  viewInvoice: string;
  downloadInvoice: string;
}

function InvoiceTableRows({
  invoice,
  isExpanded,
  bkashEnabled,
  paying,
  lines,
  linesLoading,
  linesError,
  labels,
  onToggle,
  onPay,
}: {
  invoice: InvoiceRow;
  isExpanded: boolean;
  bkashEnabled: boolean;
  paying: boolean;
  lines: InvoiceBillingLine[] | undefined;
  linesLoading: boolean;
  linesError: boolean;
  labels: InvoiceTableLabels;
  onToggle: () => void;
  onPay: () => void;
}) {
  const canPay = bkashEnabled && (invoice.status === "pending" || invoice.status === "overdue");
  return (
    <>
      <tr className="border-b border-gray-100 text-sm">
        <td className="px-3 py-4 font-medium text-gray-900">{invoice.id}</td>
        <td className="px-3 py-4 text-gray-600">{invoice.billingPeriod}</td>
        <td className="px-3 py-4 text-gray-600">{labels.type}</td>
        <td className="px-3 py-4 font-semibold text-gray-900">{labels.amount}</td>
        <td className="px-3 py-4">
          <Badge className={labels.statusClass}>{labels.status}</Badge>
        </td>
        <td className="px-3 py-4">
          <div className="flex items-center gap-2">
            {canPay && (
              <Button size="sm" onClick={onPay} disabled={paying}>
                <CreditCard className="mr-1 h-3.5 w-3.5" />
                {paying ? labels.paying : labels.pay}
              </Button>
            )}
            {!bkashEnabled && invoice.status !== "paid" && (
              <span className="text-xs text-gray-400">{labels.bkashUnavailable}</span>
            )}
            <Button variant="ghost" size="sm" onClick={onToggle} aria-expanded={isExpanded}>
              <ReceiptText className="mr-1 h-3.5 w-3.5" />
              {isExpanded ? labels.hide : labels.view}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => window.open(buildApiUrl(`/api/subscription/invoices/${invoice.rawId}/pdf`), "_blank")}
              title={labels.viewInvoice}
            >
              <Eye className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => window.open(buildApiUrl(`/api/subscription/invoices/${invoice.rawId}/pdf`), "_blank")}
              title={labels.downloadInvoice}
            >
              <Download className="h-4 w-4" />
            </Button>
          </div>
        </td>
      </tr>
      {isExpanded && (
        <tr className="border-b border-gray-100 bg-slate-50">
          <td colSpan={6} className="px-3 py-3">
            {linesLoading && (
              <p role="status" className="flex items-center gap-2 text-sm text-gray-500">
                <Loader2 className="h-4 w-4 animate-spin" />
                {labels.linesLoading}
              </p>
            )}
            {!linesLoading && linesError && (
              <p role="status" className="text-sm text-amber-700">{labels.linesUnavailable}</p>
            )}
            {!linesLoading && !linesError && lines && lines.length === 0 && (
              <p className="text-sm text-gray-500">{labels.linesEmpty}</p>
            )}
            {!linesLoading && !linesError && lines && lines.length > 0 && (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-gray-500">
                    <th className="py-1 pr-4">{labels.lineOrder}</th>
                    <th className="py-1 pr-4">{labels.lineKind}</th>
                    <th className="py-1 pr-4">{labels.lineOutcome}</th>
                    <th className="py-1">{labels.lineAmount}</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line) => (
                    <tr key={line.id} className="text-gray-700">
                      <td className="py-1 pr-4 font-mono text-xs">{line.orderId ?? "—"}</td>
                      <td className="py-1 pr-4">{line.lineKind ?? "—"}</td>
                      <td className="py-1 pr-4">{line.outcome ?? "—"}</td>
                      <td className="py-1">{labels.formatMinor(line.amountMinor)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </td>
        </tr>
      )}
    </>
  );
}