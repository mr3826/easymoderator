import {
  AlertCircle,
  CheckCircle2,
  Clock4,
  CreditCard,
  Download,
  Eye,
  Loader2,
  ReceiptText,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { motion, MotionConfig } from "motion/react";
import { toast } from "sonner";
import { fadeUp } from "@/lib/motion";
import { PageHeader } from "./dashboard/PageHeader";
import { deriveBillingSignal } from "./subscription/derive";
import { deriveUsageSummary, invoiceUsage, outcomeDateFor, type InvoiceUsageDetail } from "./subscription/usage";
import { Badge } from "@/app/components/ui/badge";
import { Button } from "@/app/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader } from "@/app/components/ui/card";
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

const ANIMATE = import.meta.env.MODE !== "test";

interface InvoiceRow {
  id: string;
  rawId: string;
  billingPeriod: string;
  amount: number | null;
  status: string;
  type: string;
  date: string;
  /** Inclusive period bounds, formatted; "" when the payload has none. */
  periodRange: string;
  dueDate: string;
  paidAt: string;
  /** Frozen usage from the invoice job, or null for legacy invoice types. */
  usage: InvoiceUsageDetail | null;
  metadata: Record<string, unknown> | null;
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

  const formatDay = (value?: string | null) => {
    if (!value) return "";
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return "";
    return parsed.toLocaleDateString(localeCode, { day: "numeric", month: "short", year: "numeric" });
  };

  // `occurredAt` is a DATEONLY value (UTC midnight). Formatting it in a local
  // zone west of UTC would show the previous day, so pin the zone.
  const formatUtcDay = (value: string) => {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return "";
    return parsed.toLocaleDateString(localeCode, {
      day: "numeric", month: "short", year: "numeric", timeZone: "UTC",
    });
  };

  // The job stores `billing_period_end` EXCLUSIVE (1st of the next month), so
  // the merchant-facing range subtracts a day. Both bounds are UTC midnights.
  const formatPeriodRange = (start?: string, end?: string) => {
    if (!start || !end) return "";
    const from = new Date(start);
    const to = new Date(end);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return "";
    const utcDay = (d: Date) =>
      d.toLocaleDateString(localeCode, { day: "numeric", month: "short", timeZone: "UTC" });
    return t("subscription.usagePeriodRange", {
      start: utcDay(from),
      end: utcDay(new Date(to.getTime() - 86_400_000)),
    });
  };

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
              date: formatDay(invoice.created_at),
              periodRange: formatPeriodRange(invoice.billing_period_start, invoice.billing_period_end),
              dueDate: formatDay(invoice.due_date),
              paidAt: formatDay(invoice.paid_at),
              usage: invoiceUsage(invoice.metadata),
              metadata: invoice.metadata ?? null,
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
  const outstandingCount = invoices.filter(
    (invoice) => invoice.status === "pending" || invoice.status === "overdue",
  ).length;
  // Usage is read from the invoice rows already fetched — the job freezes each
  // period's delivered/zero-rated counts into `metadata`. No extra request.
  const usage = deriveUsageSummary(invoices);

  const signal = deriveBillingSignal(
    {
      phase: contractQuery.error ? "error" : contractQuery.isLoading || invoicesLoading ? "loading" : "ready",
      invoiceCount: invoices.length,
      outstandingCount,
    },
    t,
  );

  const invoiceStatusLabel = (status: string) => {
    const known = ["paid", "pending", "overdue", "cancelled"];
    return known.includes(status)
      ? t(`subscription.status.${status}`, status)
      : status;
  };

  const invoiceStatusClass = (status: string) => {
    if (status === "paid") return "bg-em-success-100 text-em-success-700";
    if (status === "overdue") return "bg-em-danger-100 text-em-danger-700";
    if (status === "cancelled") return "bg-em-bg-muted text-em-text-secondary";
    return "bg-em-warning-100 text-em-warning-700";
  };

  return (
    <MotionConfig reducedMotion="user">
    <div className="em-billing min-h-full p-4 md:p-6">
      <div className="mx-auto w-full max-w-[1440px] space-y-6">
        <motion.div variants={fadeUp} initial={ANIMATE ? "hidden" : false} animate="visible">
          <PageHeader
            title={t("subscription.title")}
            breadcrumb={[]}
            signal={signal}
            signalTestId="billing-signal"
            signalAnnounce={false}
            meta={
              <div className="flex flex-wrap items-center gap-2">
                <span className="em-tabular whitespace-nowrap rounded-full border border-em-border bg-em-bg-muted px-3 py-1 text-xs font-medium text-em-text-secondary">
                  {t("subscription.invoiceCountLabel")}: {invoices.length}
                </span>
                <span className="em-tabular whitespace-nowrap rounded-full border border-em-border bg-em-bg-muted px-3 py-1 text-xs font-medium text-em-text-secondary">
                  {t("subscription.dueCountLabel")}: {outstandingCount}
                </span>
                {usage.hasDetail && (
                  <span className="em-tabular whitespace-nowrap rounded-full border border-em-border bg-em-bg-muted px-3 py-1 text-xs font-medium text-em-text-secondary">
                    {t("subscription.usageDeliveredPillLabel")}: {usage.deliveredCount}
                  </span>
                )}
              </div>
            }
          />
        </motion.div>

        {outstanding && (
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button
              onClick={() => void handlePayInvoice(outstanding.rawId)}
              disabled={!bkashEnabled || payingInvoiceId === outstanding.rawId}
              title={bkashEnabled ? undefined : t("subscription.bkashUnavailable")}
            >
              <CreditCard className="mr-2 h-4 w-4" />
              {bkashEnabled ? t("subscription.payInvoice") : t("subscription.bkashUnavailable")}
            </Button>
          </div>
        )}

      {error && <div role="alert" className="rounded-xl border border-em-danger-700/20 bg-em-danger-100 p-4 text-sm text-em-danger-700">{error}</div>}
      {success && <div role="status" className="rounded-xl border border-em-success-700/20 bg-em-success-100 p-4 text-sm text-em-success-700">{success}</div>}

      <ClaimProvider surface="subscription">
        <Card className="mb-6 overflow-hidden border-em-border bg-em-bg-surface">
          <CardHeader>
            <h2 className="text-lg font-semibold text-em-text-primary">{t("subscription.contractTitle")}</h2>
            <p className="text-sm text-em-text-secondary">{t("subscription.contractSubtitle")}</p>
          </CardHeader>
          <CardContent className="space-y-3">
            {contractQuery.isLoading && (
              <p role="status" className="text-sm text-em-text-secondary">{t("subscription.loading")}</p>
            )}
            {contractQuery.error && (
              <div role="alert" className="rounded-lg border border-em-warning-600/30 bg-em-warning-100 p-3 text-sm text-em-warning-700">
                {t("subscription.contractUnavailable")}
              </div>
            )}
            {contract && (
              <>
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="text-3xl font-bold text-em-text-primary">
                    {formatMinor(contract.unit_price_minor)}
                  </span>
                  <span className="text-sm text-em-text-secondary">{t("subscription.perDeliveredOrder")}</span>
                </div>
                <p className="text-sm text-em-text-secondary">
                  {t("subscription.dueWithin", { days: contract.due_days })}
                </p>
                <p className="text-sm text-em-text-secondary">
                  {t("subscription.zeroRatedNote", { amount: formatMinor(0) })}
                </p>
                <p className="text-sm text-em-text-secondary">
                  {t("subscription.cycleLabel")}: {t("subscription.cycleMonthly")} · {t("subscription.paymentLabel")}: {t("subscription.paymentPostpaid")}
                </p>
                <p className="text-xs uppercase tracking-wide text-em-text-secondary">
                  {t("subscription.contractVersion", { version: contract.contract_version })}
                </p>
                <div className="space-y-2 rounded-lg bg-em-bg-muted/70 p-3 text-sm text-em-text-primary">
                  <Claim id="billing.delivered_order" surface="subscription" className="block" />
                  <Claim id="billing.overdue_policy" surface="subscription" className="block" />
                </div>
              </>
            )}
          </CardContent>
        </Card>

        <Card className="mb-6">
          <CardHeader>
            <h2 className="text-lg font-semibold text-em-text-primary">{t("subscription.capabilitiesTitle")}</h2>
            <p className="text-sm text-em-text-secondary">{t("subscription.capabilitiesSubtitle")}</p>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-3">
            <div className="space-y-2 text-sm text-em-text-primary">
              <h3 className="font-semibold text-em-text-primary">{t("subscription.capabilityGroups.ai")}</h3>
              <Claim id="ai.draft_reply" surface="subscription" className="block" />
              <Claim id="ai.auto_reply" surface="subscription" className="block" />
            </div>
            <div className="space-y-2 text-sm text-em-text-primary">
              <h3 className="font-semibold text-em-text-primary">{t("subscription.capabilityGroups.courier")}</h3>
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
            <div className="space-y-2 text-sm text-em-text-primary">
              <h3 className="font-semibold text-em-text-primary">{t("subscription.capabilityGroups.voiceAndTools")}</h3>
              <Claim id="voice.transcription" surface="subscription" className="block" />
              <Claim id="addons.ads_studio.pilot" surface="subscription" className="block" />
              <Claim id="addons.storefront.pilot" surface="subscription" className="block" />
            </div>
          </CardContent>
        </Card>
      </ClaimProvider>

      {/* Usage truth (ADR-0011): every number here is read from the invoice rows
          already fetched — the job freezes each period's counts into metadata.
          Billed periods only; nothing is projected or estimated. */}
      <Card className="mb-6 border-em-border bg-em-bg-surface">
        <CardHeader>
          <h2 className="text-lg font-semibold text-em-text-primary">{t("subscription.usageTitle")}</h2>
          <p className="text-sm text-em-text-secondary">{t("subscription.usageSubtitle")}</p>
        </CardHeader>
        <CardContent>
          {invoicesLoading ? (
            <p role="status" className="text-sm text-em-text-secondary">{t("subscription.loading")}</p>
          ) : usage.hasDetail ? (
            <div className="space-y-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div className="rounded-xl border border-em-border bg-em-bg-muted/60 p-4">
                  <p className="flex items-center gap-2 text-xs font-medium text-em-text-secondary">
                    <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
                    {t("subscription.usageDeliveredLabel")}
                  </p>
                  <p className="em-tabular mt-1 text-2xl font-bold text-em-text-primary">{usage.deliveredCount}</p>
                </div>
                <div className="rounded-xl border border-em-border bg-em-bg-muted/60 p-4">
                  <p className="flex items-center gap-2 text-xs font-medium text-em-text-secondary">
                    <ReceiptText className="h-4 w-4 shrink-0" aria-hidden="true" />
                    {t("subscription.usageZeroRatedLabel")}
                  </p>
                  <p className="em-tabular mt-1 text-2xl font-bold text-em-text-primary">{usage.zeroRatedCount}</p>
                </div>
                <div className="rounded-xl border border-em-border bg-em-bg-muted/60 p-4">
                  <p className="flex items-center gap-2 text-xs font-medium text-em-text-secondary">
                    <Clock4 className="h-4 w-4 shrink-0" aria-hidden="true" />
                    {t("subscription.usageOutstandingLabel")}
                  </p>
                  <p className="em-tabular mt-1 text-2xl font-bold text-em-text-primary">{formatMinor(usage.outstandingMinor)}</p>
                </div>
              </div>
              <p className="text-xs text-em-text-secondary">
                {t("subscription.usagePeriodsLabel", { count: usage.periodsCovered })}
              </p>
            </div>
          ) : (
            <p className="text-sm text-em-text-secondary">{t("subscription.usageNoDetail")}</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <h2 className="text-lg font-semibold text-em-text-primary">{t("subscription.invoicesTitle")}</h2>
        </CardHeader>
        <CardContent>
          {invoicesLoading ? (
            <p role="status" className="py-8 text-center text-sm text-em-text-secondary">{t("subscription.loading")}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px]" aria-label={t("subscription.invoicesTitle")}>
                <thead>
                  <tr className="border-b border-em-border text-left text-sm text-em-text-secondary">
                    <th scope="col" className="px-3 py-3">{t("subscription.invoiceColumns.id")}</th>
                    <th scope="col" className="px-3 py-3">{t("subscription.invoiceColumns.period")}</th>
                    <th scope="col" className="px-3 py-3">{t("subscription.invoiceColumns.type")}</th>
                    <th scope="col" className="px-3 py-3">{t("subscription.invoiceColumns.amount")}</th>
                    <th scope="col" className="px-3 py-3">{t("subscription.invoiceColumns.status")}</th>
                    <th scope="col" className="px-3 py-3">{t("subscription.invoiceColumns.action")}</th>
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
                          lineOccurredAt: t("subscription.billingLineColumns.occurredAt"),
                          usageLine: invoice.usage
                            ? t("subscription.usagePerPeriod", {
                                delivered: invoice.usage.deliveredCount,
                                zeroRated: invoice.usage.zeroRatedCount,
                              })
                            : "",
                          dueLine: invoice.status === "paid" && invoice.paidAt
                            ? t("subscription.invoicePaidOn", { date: invoice.paidAt })
                            : invoice.dueDate
                              ? t("subscription.invoiceDueOn", { date: invoice.dueDate })
                              : "",
                          outcomeDate: (orderId) => {
                            const occurredAt = outcomeDateFor(invoice.metadata, orderId);
                            return occurredAt ? formatUtcDay(occurredAt) : "—";
                          },
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
                <p className="py-8 text-center text-sm text-em-text-secondary">{t("subscription.noInvoices")}</p>
              )}
            </div>
          )}
        </CardContent>
        <CardFooter className="text-sm text-em-text-secondary">
          <AlertCircle className="mr-2 h-4 w-4 shrink-0 text-em-text-secondary" />
          {t("subscription.invoiceDisclaimer")}
        </CardFooter>
      </Card>
      </div>
    </div>
    </MotionConfig>
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
  lineOccurredAt: string;
  usageLine: string;
  dueLine: string;
  outcomeDate: (orderId: string | null | undefined) => string;
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
      <tr className="border-b border-em-border text-sm">
        <td className="px-3 py-4 font-medium text-em-text-primary">{invoice.id}</td>
        <td className="px-3 py-4 text-em-text-secondary">
          <span className="block">{invoice.billingPeriod}</span>
          {invoice.periodRange && <span className="block text-xs">{invoice.periodRange}</span>}
          {labels.usageLine && <span className="em-tabular block text-xs">{labels.usageLine}</span>}
        </td>
        <td className="px-3 py-4 text-em-text-secondary">{labels.type}</td>
        <td className="px-3 py-4 font-semibold text-em-text-primary">{labels.amount}</td>
        <td className="px-3 py-4">
          <Badge className={labels.statusClass}>{labels.status}</Badge>
          {labels.dueLine && <span className="mt-1 block text-xs text-em-text-secondary">{labels.dueLine}</span>}
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
              <span className="text-xs text-em-text-secondary">{labels.bkashUnavailable}</span>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={onToggle}
              aria-expanded={isExpanded}
              aria-controls={`billing-lines-${invoice.rawId}`}
            >
              <ReceiptText className="mr-1 h-3.5 w-3.5" />
              {isExpanded ? labels.hide : labels.view}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => window.open(buildApiUrl(`/api/subscription/invoices/${invoice.rawId}/pdf`), "_blank")}
              title={labels.viewInvoice}
              aria-label={labels.viewInvoice}
            >
              <Eye className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => window.open(buildApiUrl(`/api/subscription/invoices/${invoice.rawId}/pdf`), "_blank")}
              title={labels.downloadInvoice}
              aria-label={labels.downloadInvoice}
            >
              <Download className="h-4 w-4" />
            </Button>
          </div>
        </td>
      </tr>
      {isExpanded && (
        <tr className="border-b border-em-border bg-em-bg-muted">
          <td colSpan={6} className="px-3 py-3" id={`billing-lines-${invoice.rawId}`}>
            {linesLoading && (
              <p role="status" className="flex items-center gap-2 text-sm text-em-text-secondary">
                <Loader2 className="h-4 w-4 animate-spin" />
                {labels.linesLoading}
              </p>
            )}
            {!linesLoading && linesError && (
              <p role="alert" className="text-sm text-em-warning-700">{labels.linesUnavailable}</p>
            )}
            {!linesLoading && !linesError && lines && lines.length === 0 && (
              <p className="text-sm text-em-text-secondary">{labels.linesEmpty}</p>
            )}
            {!linesLoading && !linesError && lines && lines.length > 0 && (
              <>
                {labels.usageLine && (
                  <p className="em-tabular mb-2 text-xs font-medium text-em-text-secondary">{labels.usageLine}</p>
                )}
                <table className="w-full text-sm" aria-label={labels.view}>
                  <thead>
                    <tr className="text-left text-xs text-em-text-secondary">
                      <th scope="col" className="py-1 pr-4">{labels.lineOrder}</th>
                      <th scope="col" className="py-1 pr-4">{labels.lineKind}</th>
                      <th scope="col" className="py-1 pr-4">{labels.lineOutcome}</th>
                      <th scope="col" className="py-1 pr-4">{labels.lineOccurredAt}</th>
                      <th scope="col" className="py-1">{labels.lineAmount}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((line) => (
                      <tr key={line.id} className="text-em-text-primary">
                        <td className="py-1 pr-4 font-mono text-xs">{line.orderId ?? "—"}</td>
                        <td className="py-1 pr-4">{line.lineKind ?? "—"}</td>
                        <td className="py-1 pr-4">{line.outcome ?? "—"}</td>
                        {/* The API's createdAt is row-insert time; the real outcome
                            date only exists in the invoice's frozen line list. */}
                        <td className="py-1 pr-4 text-xs">{labels.outcomeDate(line.orderId)}</td>
                        <td className="py-1">{labels.formatMinor(line.amountMinor)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </td>
        </tr>
      )}
    </>
  );
}