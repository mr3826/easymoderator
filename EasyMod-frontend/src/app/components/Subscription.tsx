import {
  AlertCircle,
  Check,
  CheckCircle2,
  CreditCard,
  Download,
  Eye,
  MessageSquare,
  Package,
  ShoppingCart,
  TrendingUp,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { apiClient } from "@/api";
import { Badge } from "@/app/components/ui/badge";
import { Button } from "@/app/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/app/components/ui/card";
import { Progress } from "@/app/components/ui/progress";
import {
  PUBLIC_PLAN_NAME_BY_CODE,
  type SubscriptionPlanDefinition,
} from "@/app/lib/subscriptionPlans";
import {
  getCrossedUsageThresholds,
  usagePercentage,
  usageThresholdSeverity,
} from "@/app/lib/usageThresholds";
import { buildApiUrl, isBkashEnabled } from "@/app/lib/config";
import { isGrowthUpgradeIntent } from "@/app/lib/signupIntent";
import { getErrorMessage } from "@shared/lib/http/errors";

interface InvoiceRow {
  id: string;
  rawId: string;
  billingPeriod: string;
  amount: number;
  status: "pending" | "paid" | "overdue" | "cancelled";
  type: string;
  date: string;
}

type UsageMetric = {
  used: number;
  limit: number;
  included_limit?: number;
  topup_balance?: number;
  percentage: number;
  status: "safe" | "warning" | "exceeded";
};

type ShadowReplyUsage = {
  candidate_units: 1;
  unit: "provider_accepted_ai_reply";
  target: number | null;
  current_shadow_use: number;
  plan_code: string | null;
  period: { start: string; end: string };
  billing_mode: "shadow";
  billable: false;
  enforce: false;
  recording_enabled: boolean;
  recording_status: string;
  conversation_usage?: { used: number; limit: number };
};

const numberValue = (value: unknown, fallback = 0) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

const initialUsage: {
  conversations: UsageMetric;
  orders: UsageMetric;
  products: UsageMetric;
} = {
  conversations: { used: 0, limit: 100, percentage: 0, status: "safe" },
  orders: { used: 0, limit: -1, percentage: 0, status: "safe" },
  products: { used: 0, limit: -1, percentage: 0, status: "safe" },
};

export default function Subscription() {
  const location = useLocation();
  const { t, i18n } = useTranslation();
  const formatNumber = (value: number) => value.toLocaleString(i18n.language === "bn" ? "bn-BD" : "en-US");
  const bkashEnabled = isBkashEnabled();
  const growthIntent = isGrowthUpgradeIntent(new URLSearchParams(location.search));
  const [plans, setPlans] = useState<SubscriptionPlanDefinition[]>([]);
  const [planCatalogLoading, setPlanCatalogLoading] = useState(true);
  const [planCatalogUnavailable, setPlanCatalogUnavailable] = useState(false);
  const [conversationPacks, setConversationPacks] = useState<NonNullable<SubscriptionPlanDefinition["topupPacks"]>>([]);
  const [selectedPackCode, setSelectedPackCode] = useState<string | null>(null);
  const [isRequestingTopup, setIsRequestingTopup] = useState(false);
  const [isUpdatingPlan, setIsUpdatingPlan] = useState(false);
  const [isRenewing, setIsRenewing] = useState(false);
  const [payingInvoiceId, setPayingInvoiceId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [hasSubscriptionData, setHasSubscriptionData] = useState(true);
  const [currentPlan, setCurrentPlan] = useState({
    code: "SHURU",
    name: "Get Your Moderator",
    price: 0,
    cycle: "Monthly",
    nextBillingDate: "",
    status: "active",
  });
  const [usage, setUsage] = useState(initialUsage);
  const [shadowUsage, setShadowUsage] = useState<ShadowReplyUsage | null>(null);
  const [effectiveLimit, setEffectiveLimit] = useState(100);
  const [quotaExhausted, setQuotaExhausted] = useState(false);
  const [topupBalance, setTopupBalance] = useState(0);
  const [billingPeriodStart, setBillingPeriodStart] = useState<string | null>(null);
  const [billingPeriodEnd, setBillingPeriodEnd] = useState<string | null>(null);
  const [partnerEligibility, setPartnerEligibility] = useState({
    delivered_orders_30d: 0,
    minimum_delivered_orders: 300,
    eligible: false,
  });
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [shownThresholds, setShownThresholds] = useState<Set<number>>(new Set());
  const [thresholdPeriod, setThresholdPeriod] = useState<string | null>(null);
  const [previousUsagePercentage, setPreviousUsagePercentage] = useState(0);

  const loadPlanCatalog = async () => {
    setPlanCatalogLoading(true);
    setPlanCatalogUnavailable(false);
    try {
      const livePlans = await apiClient.getSubscriptionPlans();
      if (!Array.isArray(livePlans) || livePlans.length !== 3
        || !livePlans.every((plan) => plan.publicName && plan.description && plan.descriptionBn)) {
        throw new Error("The published plan catalog is incomplete.");
      }
      setPlans(livePlans);
      setConversationPacks(livePlans.find((plan) => plan.code === "GROWTH")?.topupPacks || []);
    } catch {
      setPlans([]);
      setConversationPacks([]);
      setPlanCatalogUnavailable(true);
    } finally {
      setPlanCatalogLoading(false);
    }
  };

  const loadShadowUsage = async () => {
    try {
      const result = await apiClient.getAiReplyShadowUsage() as ShadowReplyUsage | undefined;
      if (
        !result ||
        result.billing_mode !== "shadow" ||
        result.billable !== false ||
        result.enforce !== false ||
        result.unit !== "provider_accepted_ai_reply"
      ) {
        setShadowUsage(null);
        return;
      }
      setShadowUsage(result);
    } catch {
      setShadowUsage(null);
    }
  };

  const loadSubscriptionData = async () => {
    try {
      setLoading(true);
      setHasSubscriptionData(true);
      const data = await apiClient.getSubscription();
      if (!data?.subscription) {
        setHasSubscriptionData(false);
        return;
      }

      const subscription = data.subscription;
      const planCode = String(subscription.plan_code || "SHURU").toUpperCase();
      const periodStart = data.period?.start || subscription.current_period_start || null;
      const periodEnd = data.period?.end || subscription.current_period_end || null;
      const conversationUsage = data.usage?.conversations || initialUsage.conversations;
      const calculatedEffectiveLimit = numberValue(
        data.effective_conversation_limit,
        numberValue(conversationUsage.limit, numberValue(subscription.conversations_limit, 100)),
      );

      setCurrentPlan({
        code: planCode,
        name: PUBLIC_PLAN_NAME_BY_CODE[planCode as keyof typeof PUBLIC_PLAN_NAME_BY_CODE]
          || subscription.plan_name || planCode,
        price: numberValue(subscription.plan_price),
        cycle: subscription.billing_cycle === "yearly" ? "Yearly" : "Monthly",
        nextBillingDate: subscription.next_billing_date
          ? new Date(subscription.next_billing_date).toLocaleDateString("en-GB", {
              day: "numeric",
              month: "short",
              year: "numeric",
            })
          : "",
        status: subscription.status,
      });
      setBillingPeriodStart(periodStart);
      setBillingPeriodEnd(periodEnd);
      setEffectiveLimit(calculatedEffectiveLimit);
      setQuotaExhausted(data.conversation_quota_exhausted === true);
      setTopupBalance(Math.max(0, numberValue(subscription.topup_balance, numberValue(conversationUsage.topup_balance))));
      setUsage({
        conversations: {
          ...conversationUsage,
          used: numberValue(conversationUsage.used),
          limit: calculatedEffectiveLimit,
          percentage: usagePercentage(numberValue(conversationUsage.used), calculatedEffectiveLimit),
        },
        orders: {
          ...data.usage.orders,
          used: numberValue(data.usage.orders.used),
          limit: numberValue(data.usage.orders.limit, -1),
          percentage: usagePercentage(numberValue(data.usage.orders.used), numberValue(data.usage.orders.limit, -1)),
        },
        products: {
          ...data.usage.products,
          used: numberValue(data.usage.products.used),
          limit: numberValue(data.usage.products.limit, -1),
          percentage: usagePercentage(numberValue(data.usage.products.used), numberValue(data.usage.products.limit, -1)),
        },
      });
      void loadShadowUsage();
      if (data.partner_eligibility) {
        setPartnerEligibility({
          delivered_orders_30d: numberValue(data.partner_eligibility.delivered_orders_30d),
          minimum_delivered_orders: numberValue(data.partner_eligibility.minimum_delivered_orders, 300),
          eligible: data.partner_eligibility.eligible === true,
        });
      }
    } catch (loadError) {
      console.error("Failed to load subscription data:", loadError);
      setError(t("subscription.loadFailed"));
      setHasSubscriptionData(false);
    } finally {
      setLoading(false);
    }
  };

  const loadInvoices = async () => {
    try {
      const rows = await apiClient.getSubscriptionInvoices();
      setInvoices(
        Array.isArray(rows)
          ? rows.map((invoice: any) => ({
              id: invoice.invoice_number,
              rawId: invoice.id,
              billingPeriod: invoice.billing_period,
              amount: numberValue(invoice.amount),
              status: invoice.status,
              type: invoice.invoice_type || t("subscription.subscriptionInvoice"),
              date: invoice.created_at
                ? new Date(invoice.created_at).toLocaleDateString("en-GB", {
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
    }
  };

  const handlePaymentReturn = async () => {
    const params = new URLSearchParams(window.location.search);
    const paymentId = params.get("paymentID");
    const contextRaw = sessionStorage.getItem("easymod_pay_ctx");
    if (!paymentId || !contextRaw) return;

    let context: { kind: "invoice" | "topup"; ref: string };
    try {
      context = JSON.parse(contextRaw) as { kind: "invoice" | "topup"; ref: string };
    } catch {
      sessionStorage.removeItem("easymod_pay_ctx");
      setError(t("subscription.paymentVerifyFailed"));
      return;
    }

    sessionStorage.removeItem("easymod_pay_ctx");
    window.history.replaceState({}, "", window.location.pathname);
    if (params.get("status") && params.get("status") !== "success") {
      if (context.kind === "invoice") {
        await apiClient.cancelInvoicePayment(context.ref, paymentId).catch((cancelError) => {
          console.error("Failed to release cancelled invoice checkout:", cancelError);
        });
      }
      setError(t("subscription.paymentCancelled"));
      return;
    }

    try {
      if (context.kind === "topup") {
        const result = await apiClient.completeTopup(context.ref, paymentId);
        setSuccess(t("subscription.topupPaymentSuccess", { count: result.conversations_added ?? 0 }));
      } else {
        const result = await apiClient.completeInvoicePayment(context.ref, paymentId);
        setSuccess(
          result.subscription_status === "active"
            ? t("subscription.invoicePaymentSuccessActive")
            : t("subscription.invoicePaymentSuccess"),
        );
      }
      await Promise.all([loadSubscriptionData(), loadInvoices()]);
    } catch (paymentError) {
      setError(getErrorMessage(paymentError, t("subscription.paymentVerifyFailed")));
    }
  };

  useEffect(() => {
    void loadSubscriptionData();
    void loadInvoices();
    void handlePaymentReturn();
    void loadPlanCatalog();
  }, []);

  useEffect(() => {
    const periodKey = billingPeriodStart || "unknown";
    if (thresholdPeriod !== periodKey) {
      setThresholdPeriod(periodKey);
      setShownThresholds(new Set());
      setPreviousUsagePercentage(0);
      return;
    }

    if (usage.conversations.limit < 0) return;
    const crossed = getCrossedUsageThresholds(
      previousUsagePercentage,
      usagePercentage(usage.conversations.used, usage.conversations.limit),
      shownThresholds,
    );
    if (crossed.length === 0) return;

    for (const threshold of crossed) {
      const severity = usageThresholdSeverity(threshold);
      const message = t("subscription.toastThreshold", {
        threshold,
        used: usage.conversations.used,
        limit: usage.conversations.limit,
      });
      toast[severity === "exhausted" ? "error" : "warning"](message, {
        duration: 8000,
        id: `conversation-threshold-${threshold}-${periodKey}`,
      });
    }
    setShownThresholds((previous) => new Set([...previous, ...crossed]));
    setPreviousUsagePercentage(usagePercentage(usage.conversations.used, usage.conversations.limit));
  }, [
    billingPeriodStart,
    previousUsagePercentage,
    shownThresholds,
    thresholdPeriod,
    usage.conversations.limit,
    usage.conversations.used,
    t,
  ]);

  const startBkashCheckout = (kind: "invoice" | "topup", ref: string, bkashUrl: string) => {
    sessionStorage.setItem("easymod_pay_ctx", JSON.stringify({ kind, ref }));
    window.location.href = bkashUrl;
  };

  const handlePlanUpdate = async (planId: string) => {
    const plan = plans.find((item) => item.id === planId);
    if (!plan) return;
    if (plan.code === "PARTNER") {
      window.location.href = "/pricing";
      return;
    }

    try {
      setIsUpdatingPlan(true);
      setError(null);
      if (plan.code === "GROWTH") {
        if (!bkashEnabled) return;
        const result = await apiClient.renewSubscription({ plan_code: "GROWTH" });
        if (!result?.bkash_url || !result.invoice_id) throw new Error(t("subscription.bkashStartFailed"));
        startBkashCheckout("invoice", result.invoice_id, result.bkash_url);
      } else {
        await apiClient.subscribeToPlan(plan.code, "monthly");
        setSuccess(t("subscription.planUpdateSuccess"));
        await loadSubscriptionData();
      }
    } catch (planError) {
      setError(getErrorMessage(planError, t("subscription.planUpdateFailed")));
    } finally {
      setIsUpdatingPlan(false);
    }
  };

  const handleRequestTopup = async () => {
    const pack = conversationPacks.find((item) => item.code === selectedPackCode);
    if (!pack || currentPlan.code !== "GROWTH" || !bkashEnabled) return;

    try {
      setIsRequestingTopup(true);
      const result = await apiClient.initiateTopup(pack.code, { idempotency_key: crypto.randomUUID() });
      if (!result?.bkash_url || !result.topup_id) throw new Error(t("subscription.bkashStartFailed"));
      startBkashCheckout("topup", result.topup_id, result.bkash_url);
    } catch (topupError) {
      setError(getErrorMessage(topupError, t("subscription.bkashStartFailed")));
      setIsRequestingTopup(false);
    }
  };

  const handlePayInvoice = async (invoiceId: string) => {
    if (!bkashEnabled) return;
    try {
      setPayingInvoiceId(invoiceId);
      const result = await apiClient.payInvoice(invoiceId);
      if (!result?.bkash_url) throw new Error(t("subscription.bkashStartFailed"));
      startBkashCheckout("invoice", invoiceId, result.bkash_url);
    } catch (paymentError) {
      setError(getErrorMessage(paymentError, t("subscription.bkashStartFailed")));
      setPayingInvoiceId(null);
    }
  };

  const handleRenew = async () => {
    if (!bkashEnabled) return;
    try {
      setIsRenewing(true);
      const result = await apiClient.renewSubscription();
      if (!result?.bkash_url || !result.invoice_id) throw new Error(t("subscription.bkashStartFailed"));
      startBkashCheckout("invoice", result.invoice_id, result.bkash_url);
    } catch (renewError) {
      setError(getErrorMessage(renewError, t("subscription.bkashStartFailed")));
      setIsRenewing(false);
    }
  };

  const usageStatusClass = (status: UsageMetric["status"]) => {
    if (status === "exceeded") return "bg-red-50 text-red-700";
    if (status === "warning") return "bg-amber-50 text-amber-700";
    return "bg-emerald-50 text-emerald-700";
  };

  const usageStatusLabel = (status: UsageMetric["status"]) => {
    if (status === "exceeded") return t("subscription.statusExhausted");
    if (status === "warning") return t("subscription.statusAlmostUsed");
    return t("subscription.statusSafe");
  };

  if (loading) {
    return <div className="mx-auto flex h-64 max-w-7xl items-center justify-center p-8 font-bn text-gray-600">{t("subscription.loading")}</div>;
  }

  if (!hasSubscriptionData) {
    return (
      <div className="mx-auto max-w-7xl p-8 font-bn">
        <Card className="text-center">
          <CardHeader><CardTitle>{t("subscription.noData")}</CardTitle></CardHeader>
          <CardContent><p className="text-gray-600">{t("subscription.noDataMsg")}</p></CardContent>
          <CardFooter className="justify-center">
            <Button onClick={() => void loadSubscriptionData()}>{t("subscription.reload")}</Button>
          </CardFooter>
        </Card>
      </div>
    );
  }

  const forecastDays = (() => {
    if (!billingPeriodStart || effectiveLimit < 0 || usage.conversations.used <= 0) return null;
    const elapsedDays = Math.max(1, (Date.now() - new Date(billingPeriodStart).getTime()) / 86400000);
    const burnRate = usage.conversations.used / elapsedDays;
    const remaining = effectiveLimit - usage.conversations.used;
    return remaining <= 0 ? 0 : Math.floor(remaining / burnRate);
  })();

  return (
    <div className="mx-auto max-w-7xl p-4 font-bn md:p-8">
      <div className="mb-6 flex flex-col gap-3 md:mb-8 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 md:text-3xl">{t("subscription.title")}</h1>
          <p className="mt-1 text-sm text-gray-600 md:text-base">{t("subscription.subtitle")}</p>
        </div>
        {currentPlan.status !== "active" && (
          <Button variant="outline" onClick={() => void handleRenew()} disabled={!bkashEnabled || isRenewing}>
            <CreditCard className="mr-2 h-4 w-4" />
            {t("subscription.renew")}
          </Button>
        )}
      </div>

      {error && <div className="mb-6 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div>}
      {success && <div className="mb-6 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-700">{success}</div>}

      {growthIntent && (
        <div role="status" className="mb-6 flex flex-col gap-2 rounded-xl border border-brand/20 bg-emerald-50 p-4 text-sm text-gray-700 sm:flex-row sm:items-center sm:justify-between">
          <p>{t("subscription.growthIntentNotice")}</p>
          <a href="#growth-plan" className="shrink-0 font-semibold text-brand underline underline-offset-2">
            {t("subscription.growthIntentViewPlan")}
          </a>
        </div>
      )}

      <Card className="mb-6 overflow-hidden border-emerald-100 bg-gradient-to-br from-white to-emerald-50/60">
        <CardContent className="grid gap-6 p-6 md:grid-cols-[1fr_auto_auto] md:items-center">
          <div>
            <p className="text-sm font-semibold uppercase tracking-wide text-brand">{t("subscription.currentPlan")}</p>
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <h2 className="text-2xl font-bold text-gray-900">{currentPlan.name}</h2>
              <Badge className={currentPlan.status === "active" ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}>
                {currentPlan.status === "active" ? t("common.active") : t("subscription.statusNeedsAttention")}
              </Badge>
            </div>
            <p className="mt-2 text-sm text-gray-600">
              {currentPlan.code === "PARTNER"
                ? t("subscription.partnerBillingSummary")
                : t("subscription.flatBillingSummary")}
            </p>
          </div>
          <div className="md:text-right">
            {currentPlan.code === "PARTNER" ? (
              <p className="text-xl font-bold text-gray-900">{t("subscription.partnerUpfront")}</p>
            ) : (
              <>
                <p className="text-3xl font-bold text-gray-900">৳{currentPlan.price.toLocaleString()}</p>
                <p className="text-sm text-gray-500">{currentPlan.cycle === "Yearly" ? t("subscription.perYear") : t("subscription.perMonth")}</p>
              </>
            )}
          </div>
          <div className="md:text-right">
            <p className="text-xs uppercase tracking-wide text-gray-400">{t("subscription.period")}</p>
            <p className="mt-1 text-sm font-semibold text-gray-700">
              {billingPeriodStart ? new Date(billingPeriodStart).toLocaleDateString("en-GB") : "-"}
              {billingPeriodEnd ? ` - ${new Date(billingPeriodEnd).toLocaleDateString("en-GB")}` : ""}
            </p>
          </div>
        </CardContent>
      </Card>

      <section className="mb-8">
        <div className="mb-4">
          <h2 className="text-xl font-bold text-gray-900">{t("subscription.plansTitle")}</h2>
          <p className="mt-1 text-sm text-gray-500">{t("subscription.plansSubtitle")}</p>
        </div>
        {planCatalogLoading && <p role="status" className="py-8 text-center text-sm text-gray-500">{t("subscription.planCatalogLoading")}</p>}
        {!planCatalogLoading && planCatalogUnavailable && (
          <div role="alert" className="flex flex-col items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 sm:flex-row sm:items-center sm:justify-between">
            <p>{t("subscription.planCatalogUnavailable")}</p>
            <Button type="button" variant="outline" onClick={() => void loadPlanCatalog()}>{t("subscription.retryPlanCatalog")}</Button>
          </div>
        )}
        {!planCatalogLoading && !planCatalogUnavailable && (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          {plans.map((plan) => {
            const isCurrent = plan.code === currentPlan.code;
            const isPartner = plan.code === "PARTNER";
            const translatedHighlights = t(`pricing.planFeatures.${plan.id}`, { returnObjects: true });
            const highlights = Array.isArray(translatedHighlights) ? translatedHighlights as string[] : plan.highlights;
            return (
              <Card id={plan.code === "GROWTH" ? "growth-plan" : undefined} key={plan.id} className={`flex h-full flex-col ${plan.code === "GROWTH" ? "border-brand shadow-lg shadow-emerald-900/10" : ""}`}>
                <CardHeader>
                  <div className="flex items-center justify-between gap-3">
                    <CardTitle>{plan.publicName || plan.name}</CardTitle>
                    {plan.code === "GROWTH" && <Badge className="bg-brand text-white">{t("pricing.mostPopular")}</Badge>}
                  </div>
                  <p className="text-sm text-gray-500">
                    {i18n.language.startsWith("bn") ? plan.descriptionBn : plan.description}
                  </p>
                </CardHeader>
                <CardContent className="flex flex-1 flex-col">
                  <div className="mb-4">
                    {isPartner ? (
                      <span className="text-xl font-bold text-gray-900">{t("subscription.partnerUpfront")}</span>
                    ) : (
                      <>
                        <span className="text-3xl font-bold text-gray-900">৳{plan.monthlyPrice.toLocaleString()}</span>
                        <span className="ml-1 text-sm text-gray-500">{t("subscription.perMonth")}</span>
                      </>
                    )}
                  </div>
                  <p className="mb-4 rounded-lg bg-slate-50 px-3 py-2 text-sm font-semibold text-gray-700">
                    {plan.limits.conversations < 0
                      ? t("subscription.unlimitedConversations")
                      : t("subscription.conversationsPerMonth", { count: plan.limits.conversations })}
                  </p>
                  {plan.supportReplyAllowance?.status === "shadow_only" && (
                    <aside aria-label={t("subscription.shadowAllowanceLabel")} className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-gray-700">
                      <p className="font-semibold text-gray-900">
                        {t("subscription.shadowAllowanceTitle", { count: formatNumber(plan.supportReplyAllowance.amount) })}
                      </p>
                      <p className="mt-1">
                        {t("subscription.shadowAllowanceNote", { conversations: formatNumber(plan.limits.conversations) })}
                      </p>
                    </aside>
                  )}
                  {isPartner && (
                    <div className="mb-4 space-y-1 rounded-lg border border-slate-100 p-3 text-xs text-gray-600">
                      <p className="font-semibold text-gray-800">{t("subscription.partnerRateBands")}</p>
                      {plan.partnerOrderTiers?.map((tier) => (
                        <p key={`${tier.minOrders}-${tier.maxOrders}`}>
                          {formatNumber(tier.minOrders)}+
                          {tier.maxOrders ? `-${formatNumber(tier.maxOrders)}` : ""}: ৳{formatNumber(tier.rateBdt)} {t("subscription.perDeliveredOrder")}
                        </p>
                      ))}
                    </div>
                  )}
                  <ul className="mt-auto space-y-2 text-sm text-gray-600">
                    {highlights.map((highlight) => (
                      <li key={highlight} className="flex gap-2"><Check className="mt-0.5 h-4 w-4 shrink-0 text-brand" />{highlight}</li>
                    ))}
                  </ul>
                </CardContent>
                <CardFooter>
                  <Button
                    className="w-full"
                    variant={isCurrent ? "outline" : plan.code === "GROWTH" ? "default" : "secondary"}
                    disabled={isCurrent || isUpdatingPlan || (plan.code === "GROWTH" && !bkashEnabled)}
                    onClick={() => void handlePlanUpdate(plan.id)}
                  >
                    {isCurrent
                      ? t("subscription.currentPlan")
                      : isPartner
                        ? t("subscription.viewPartnerApplication")
                        : plan.code === "GROWTH" && !bkashEnabled
                          ? t("subscription.bkashUnavailable")
                          : t("subscription.switchPlan")}
                  </Button>
                </CardFooter>
              </Card>
            );
          })}
        </div>
        )}
      </section>

      <section className="mb-6">
        <div className="mb-4">
          <h2 className="text-xl font-bold text-gray-900">{t("subscription.usageTitle")}</h2>
          <p className="mt-1 text-sm text-gray-500">{t("subscription.usageSubtitle")}</p>
        </div>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          {([
            { key: "conversations", icon: MessageSquare, label: t("subscription.conversationsUsed"), metric: usage.conversations },
            { key: "orders", icon: ShoppingCart, label: t("subscription.ordersCreated"), metric: usage.orders },
            { key: "products", icon: Package, label: t("subscription.productsUsed"), metric: usage.products },
          ] as const).map(({ key, icon: Icon, label, metric }) => (
            <Card key={key}>
              <CardContent className="p-5">
                <div className="mb-4 flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-emerald-50 text-brand"><Icon className="h-5 w-5" /></div>
                  <h3 className="font-semibold text-gray-900">{label}</h3>
                </div>
                <div className="mb-3 flex items-baseline gap-2">
                  <span className="text-3xl font-bold text-gray-900">{metric.used.toLocaleString()}</span>
                  <span className="text-sm text-gray-500">
                    {metric.limit < 0 ? t("subscription.unlimited") : t("subscription.usagePerMonth", { used: metric.used.toLocaleString(), limit: metric.limit.toLocaleString() })}
                  </span>
                </div>
                <Progress value={metric.limit < 0 ? 0 : usagePercentage(metric.used, metric.limit)} className="mb-3 h-2" />
                <Badge className={usageStatusClass(metric.status)}>{usageStatusLabel(metric.status)}</Badge>
                {key === "conversations" && (
                  <div className="mt-3 space-y-1 text-xs text-gray-500">
                    <p>{t("subscription.includedConversations", { count: usage.conversations.included_limit ?? effectiveLimit })}</p>
                    <p>{t("subscription.topupBalanceLabel")}: {formatNumber(topupBalance)}</p>
                    {quotaExhausted && <p className="font-semibold text-red-600">{t("subscription.aiPausedForUsage")}</p>}
                    {forecastDays !== null && forecastDays <= 7 && !quotaExhausted && (
                      <p className="flex items-center gap-1 font-medium text-amber-700"><TrendingUp className="h-3.5 w-3.5" />{t("subscription.forecastDays", { count: forecastDays })}</p>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      {shadowUsage && (
        <section aria-labelledby="shadow-support-usage-title" className="mb-6">
          <Card className="border-amber-200 bg-amber-50/40">
            <CardContent className="space-y-4 p-5 sm:p-6">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 id="shadow-support-usage-title" className="text-lg font-bold text-gray-900">
                  {t("subscription.shadowUsageTitle")}
                </h2>
                <Badge className="bg-amber-100 text-amber-900">{t("subscription.shadowOnlyBadge")}</Badge>
              </div>
              <p className="max-w-4xl text-sm leading-6 text-gray-700">{t("subscription.shadowUnitDefinition")}</p>
              <p className="text-xs text-gray-600">
                {t("subscription.shadowPeriod", {
                  start: shadowUsage.period.start.slice(0, 10),
                  end: shadowUsage.period.end.slice(0, 10),
                })}
              </p>
              {shadowUsage.recording_enabled ? (
                <div className="max-w-2xl space-y-2" aria-live="polite">
                  <p className="font-semibold text-gray-900">
                    {shadowUsage.target === null
                      ? t("subscription.shadowObservedOnly", { count: formatNumber(shadowUsage.current_shadow_use) })
                      : t("subscription.shadowUsageCount", {
                          used: formatNumber(shadowUsage.current_shadow_use),
                          target: formatNumber(shadowUsage.target),
                        })}
                  </p>
                  {shadowUsage.target !== null && (
                    <Progress
                      value={Math.min(100, (shadowUsage.current_shadow_use / Math.max(1, shadowUsage.target)) * 100)}
                      aria-label={t("subscription.shadowUsageProgress", { target: formatNumber(shadowUsage.target) })}
                      className="h-2"
                    />
                  )}
                  <p className="text-xs text-gray-600">{t("subscription.shadowRecordingActive")}</p>
                </div>
              ) : (
                <p role="status" className="text-sm font-medium text-gray-700">
                  {shadowUsage.recording_status === "gate_unavailable"
                    ? t("subscription.shadowGateUnavailable")
                    : t("subscription.shadowNotEnabled")}
                </p>
              )}
              <p className="border-t border-amber-200 pt-3 text-xs leading-5 text-gray-600">
                {t("subscription.shadowBillingBoundary")}
              </p>
            </CardContent>
          </Card>
        </section>
      )}

      <div className="mb-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>{t("subscription.addConversationsTitle")}</CardTitle></CardHeader>
          <CardContent>
            {currentPlan.code !== "GROWTH" ? (
              <div className="rounded-lg border border-slate-100 bg-slate-50 p-4 text-sm text-gray-600">
                <p>{currentPlan.code === "PARTNER" ? t("subscription.partnerNoTopups") : t("subscription.growthTopupsOnly")}</p>
              </div>
            ) : planCatalogUnavailable ? (
              <p role="status" className="text-sm text-gray-600">{t("subscription.topupCatalogUnavailable")}</p>
            ) : planCatalogUnavailable ? (
              <p role="status" className="text-sm text-gray-600">{t("subscription.topupCatalogUnavailable")}</p>
            ) : !bkashEnabled ? (
              <p data-testid="topup-bkash-unavailable" className="text-sm text-gray-500">{t("subscription.bkashUnavailable")}</p>
            ) : (
              <>
                <div className="space-y-3">
                  {conversationPacks.map((pack) => (
                    <button
                      type="button"
                      key={pack.code}
                      onClick={() => setSelectedPackCode(pack.code)}
                      className={`w-full rounded-lg border-2 p-4 text-left transition-colors ${selectedPackCode === pack.code ? "border-brand bg-emerald-50" : "border-gray-200 hover:border-emerald-200"}`}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div><p className="font-semibold text-gray-900">{t("subscription.plusConversations", { count: pack.conversations })}</p><p className="mt-1 text-xs text-gray-500">{t("subscription.addedToBalance")}</p></div>
                        <p className="font-bold text-gray-900">৳{pack.priceBdt.toLocaleString()}</p>
                      </div>
                    </button>
                  ))}
                </div>
                <Button className="mt-4 w-full" disabled={!selectedPackCode || isRequestingTopup} onClick={() => void handleRequestTopup()}>
                  <CreditCard className="mr-2 h-4 w-4" />{isRequestingTopup ? "..." : t("subscription.payWithBkash")}
                </Button>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>{t("subscription.planIncludes")}</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            {(t("subscription.planFeatures", { returnObjects: true }) as string[]).map((feature) => (
              <div key={feature} className="flex items-start gap-3 text-sm text-gray-700"><CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-brand" />{feature}</div>
            ))}
            {currentPlan.code === "PARTNER" && (
              <div className="rounded-lg bg-slate-50 p-3 text-sm text-gray-600">
                {t("subscription.partnerEligibility", {
                  count: partnerEligibility.delivered_orders_30d,
                  minimum: partnerEligibility.minimum_delivered_orders,
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="mb-6">
        <CardHeader><CardTitle>{t("subscription.billingTitle")}</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between"><span className="text-gray-600">{t("subscription.basePlan")}</span><span className="font-semibold text-gray-900">{currentPlan.code === "PARTNER" ? t("subscription.partnerUpfront") : `৳${currentPlan.price.toLocaleString()}`}</span></div>
          <div className="flex items-center justify-between"><span className="text-gray-600">{t("subscription.topupBalanceLabel")}</span><span className="font-semibold text-gray-900">{topupBalance.toLocaleString()}</span></div>
          <div className="border-t border-gray-100 pt-3 text-sm text-gray-500">{t("subscription.invoiceDisclaimer")}</div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>{t("subscription.invoicesTitle")}</CardTitle></CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[650px]">
              <thead><tr className="border-b border-gray-200 text-left text-sm text-gray-600">
                <th className="px-3 py-3">{t("subscription.invoiceColumns.id")}</th><th className="px-3 py-3">{t("subscription.invoiceColumns.period")}</th><th className="px-3 py-3">{t("subscription.invoiceColumns.type")}</th><th className="px-3 py-3">{t("subscription.invoiceColumns.amount")}</th><th className="px-3 py-3">{t("subscription.invoiceColumns.status")}</th><th className="px-3 py-3">{t("subscription.invoiceColumns.action")}</th>
              </tr></thead>
              <tbody>{invoices.map((invoice) => (
                <tr key={invoice.rawId} className="border-b border-gray-100 text-sm">
                  <td className="px-3 py-4 font-medium text-gray-900">{invoice.id}</td><td className="px-3 py-4 text-gray-600">{invoice.billingPeriod}</td><td className="px-3 py-4 text-gray-600">{invoice.type}</td><td className="px-3 py-4 font-semibold text-gray-900">৳{invoice.amount.toLocaleString()}</td>
                  <td className="px-3 py-4"><Badge className={invoice.status === "paid" ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}>{invoice.status === "paid" ? t("subscription.paid") : t("subscription.pending")}</Badge></td>
                  <td className="px-3 py-4"><div className="flex items-center gap-2">
                    {invoice.status !== "paid" && bkashEnabled && <Button size="sm" onClick={() => void handlePayInvoice(invoice.rawId)} disabled={payingInvoiceId === invoice.rawId}><CreditCard className="mr-1 h-3.5 w-3.5" />{payingInvoiceId === invoice.rawId ? "..." : t("subscription.payWithBkash")}</Button>}
                    {!bkashEnabled && invoice.status !== "paid" && <span className="text-xs text-gray-400">{t("subscription.bkashUnavailable")}</span>}
                    <Button variant="ghost" size="icon" onClick={() => window.open(buildApiUrl(`/api/subscription/invoices/${invoice.rawId}/pdf`), "_blank")} title={t("subscription.viewInvoiceTitle")}><Eye className="h-4 w-4" /></Button>
                    <Button variant="ghost" size="icon" onClick={() => window.open(buildApiUrl(`/api/subscription/invoices/${invoice.rawId}/pdf`), "_blank")} title={t("subscription.downloadInvoiceTitle")}><Download className="h-4 w-4" /></Button>
                  </div></td>
                </tr>
              ))}</tbody>
            </table>
            {invoices.length === 0 && <p className="py-8 text-center text-sm text-gray-500">{t("subscription.noInvoices")}</p>}
          </div>
        </CardContent>
      </Card>

      {currentPlan.code === "SHURU" && quotaExhausted && (
        <div className="mt-6 flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          <AlertCircle className="mt-0.5 h-5 w-5 shrink-0" />{t("subscription.usageExhaustedAction")}
        </div>
      )}
    </div>
  );
}
