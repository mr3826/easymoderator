import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AlertTriangle, CheckCircle2, FileText, Loader2, MessageCircle, PackageCheck, Truck } from "lucide-react";
import { toast } from "sonner";
import { apiClient } from "@/api";
import type { DashboardMetrics, DashboardQueue } from "@/api/types/dashboard";
import type { Conversation } from "@/api/types/conversation";
import type { Order } from "@/api/types/order";
import FirstTimeSetupDashboard from "./FirstTimeSetupDashboard";
import { useSetupStatus } from "@/app/lib/useSetupStatus";
import { authService } from "../lib/auth";
import { getErrorMessage } from "@shared/lib/http/errors";

const SETUP_DASHBOARD_ENABLED = import.meta.env.VITE_ENABLE_FIRST_TIME_SETUP_DASHBOARD !== "false";
const REPLY_PAGE_SIZE = 100;
const DRAFT_PAGE_SIZE = 100;
const EXCEPTION_SAMPLE_LIMIT = 10;
const COURIER_SAMPLE_LIMIT = 100;
const WORK_ITEMS_PER_GROUP = 2;
const ACTIVE_COURIER_STATUSES = new Set(["booked", "picked_up", "in_transit", "out_for_delivery"]);

type CashPosition = NonNullable<DashboardMetrics["cashPosition"]>;
type AtRiskOrder = DashboardQueue["at_risk_orders"][number];

type PulseData = {
  ordersToday: number | null;
  replyTasks: Conversation[] | null;
  replyTaskCoverageComplete: boolean;
  draftOrders: Order[] | null;
  draftCoverageComplete: boolean;
  atRiskOrders: AtRiskOrder[] | null;
  exceptionCoverageComplete: boolean;
  lastFiveOrders: Order[] | null;
  cashPosition: CashPosition | null;
};

type WorkItem = {
  id: string;
  kind: "reply" | "draft" | "exception";
  title: string;
  detail: string;
  to: string;
  sortAt: number;
  icon: typeof MessageCircle;
  action: string;
};

type CashPositionCardProps = {
  label: string;
  subLabel: string;
  data: { amount: number; count: number } | null;
  icon: typeof Truck;
  formatCurrency: (v: number) => string;
  formatCount: (v: number) => string;
  t: (key: string, options?: Record<string, unknown>) => string;
};

function CashPositionCard({ label, subLabel, data, icon: Icon, formatCurrency, formatCount, t }: CashPositionCardProps) {
  return (
    <section className="min-h-[112px] rounded-2xl border border-border bg-card p-4">
      <div className="mb-2 flex items-center justify-between">
        <Icon className="h-5 w-5 text-gray-700" aria-hidden="true" />
        <span className="text-xs font-medium text-muted-foreground">{subLabel}</span>
      </div>
      <h3 className="text-sm font-semibold text-muted-foreground">{label}</h3>
      {data ? (
        <>
          <p className="text-2xl font-black text-foreground md:text-3xl">{formatCurrency(data.amount)}</p>
          <p className="mt-1 text-sm font-semibold text-muted-foreground">
            {t("dashboard.pulse.cashPosition.ordersUnit", { count: formatCount(data.count) })}
          </p>
        </>
      ) : (
        <p className="mt-2 text-lg font-semibold text-muted-foreground">{t("dashboard.pulse.cashPosition.unavailable")}</p>
      )}
    </section>
  );
}

const countOrNull = (value: unknown): number | null => (
  typeof value === "number" && Number.isFinite(value) ? value : null
);

const validDate = (value: string | null | undefined) => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
};

const orderLabel = (order: Order) => order.orderNumber || order.id.slice(0, 8);

const nonEmptyString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

function getCourierReference(order: Order) {
  return nonEmptyString(order.delivery_tracking_code)
    || nonEmptyString(order.delivery_consignment_id);
}

function isPersistedActiveCourierOrder(order: Order) {
  const status = nonEmptyString(order.delivery_status)?.toLowerCase();
  return Boolean(
    nonEmptyString(order.delivery_provider)
    && getCourierReference(order)
    && nonEmptyString(order.delivery_dispatched_at)
    && status
    && ACTIVE_COURIER_STATUSES.has(status),
  );
}

type CourierSnapshot = {
  orders: Order[] | null;
  isLoading: boolean;
};

export default function Dashboard() {
  const navigate = useNavigate();
  const { t, i18n } = useTranslation();
  const [pulseData, setPulseData] = useState<PulseData | null>(null);
  const [courierSnapshot, setCourierSnapshot] = useState<CourierSnapshot>({ orders: null, isLoading: true });
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [failedSourceNames, setFailedSourceNames] = useState<string[]>([]);
  const requestSequenceRef = useRef(0);
  const courierRequestSequence = useRef(0);
  const setupStorageKeyPrefix = `easymod:business-setup:${authService.getCurrentShopId() || 'default'}`;
  const completionDismissedKey = `${setupStorageKeyPrefix}:complete-dismissed`;
  const [setupCompletionDismissed, setSetupCompletionDismissed] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(completionDismissedKey) === '1';
  });
  const {
    data: setupStatus,
    isLoading: isSetupLoading,
    error: setupError,
    refresh: refreshSetupStatus,
  } = useSetupStatus({ enabled: SETUP_DASHBOARD_ENABLED });

  useEffect(() => {
    if (typeof window === 'undefined') return;
    setSetupCompletionDismissed(window.localStorage.getItem(completionDismissedKey) === '1');
  }, [completionDismissedKey]);

  const locale = i18n?.language === "bn" ? "bn-BD" : "en-BD";
  const formatCurrency = useCallback((value: number) =>
    new Intl.NumberFormat(locale, {
      style: "currency",
      currency: "BDT",
      maximumFractionDigits: 0,
    }).format(Number.isFinite(value) ? value : 0), [locale]);
  const formatCount = useCallback((value: number) => new Intl.NumberFormat(locale).format(value), [locale]);

  const formatOrderStatus = (status: string) => {
    switch (status) {
      case "confirmed":
      case "completed":
        return { label: t("dashboard.pulse.status.confirmed"), className: "text-green-700 bg-green-50" };
      case "draft":
        return { label: t("dashboard.pulse.status.draft"), className: "text-gray-700 bg-gray-100" };
      case "delivered":
        return { label: t("dashboard.pulse.status.delivered"), className: "text-green-700 bg-green-50" };
      case "returned":
        return { label: t("dashboard.pulse.status.returned"), className: "text-red-700 bg-red-50" };
      case "cancelled":
        return { label: t("dashboard.pulse.status.cancelled"), className: "text-red-600 bg-red-50" };
      case "processing":
      case "pending":
        return { label: t("dashboard.pulse.status.processing"), className: "text-orange-600 bg-orange-50" };
      case "finalized":
        return { label: t("dashboard.pulse.status.finalized"), className: "text-blue-700 bg-blue-50" };
      default:
        return { label: t("dashboard.pulse.status.unknown"), className: "text-gray-600 bg-gray-100" };
    }
  };

  const refreshPulse = useCallback(async (isInitialLoad = false) => {
    const requestSequence = ++requestSequenceRef.current;
    if (isInitialLoad) setIsLoading(true);
    setError(null);

    try {
      const [metricsResult, queueResult, draftsResult, conversationsResult, latestOrdersResult] = await Promise.allSettled([
        apiClient.getDashboardMetrics(),
        apiClient.getDashboardQueue(),
        apiClient.getOrders({ order_status: "draft", page: 1, limit: DRAFT_PAGE_SIZE }),
        apiClient.getConversations({ page: 1, limit: REPLY_PAGE_SIZE }),
        apiClient.getOrders({ page: 1, limit: 5 }),
      ]);

      if (requestSequence !== requestSequenceRef.current) return;

      if (metricsResult.status === "rejected") console.error("Failed to load dashboard overview:", metricsResult.reason);
      if (queueResult.status === "rejected") console.error("Failed to load dashboard action counts:", queueResult.reason);
      if (draftsResult.status === "rejected") console.error("Failed to load Draft orders:", draftsResult.reason);
      if (conversationsResult.status === "rejected") console.error("Failed to load reply tasks:", conversationsResult.reason);
      if (latestOrdersResult.status === "rejected") console.error("Failed to load recent orders:", latestOrdersResult.reason);

      const results = [metricsResult, queueResult, draftsResult, conversationsResult, latestOrdersResult];
      const failedSources = [
        [metricsResult, "dashboard.pulse.sourceNames.overview"],
        [queueResult, "dashboard.pulse.sourceNames.actionCounts"],
        [draftsResult, "dashboard.pulse.sourceNames.drafts"],
        [conversationsResult, "dashboard.pulse.sourceNames.replies"],
        [latestOrdersResult, "dashboard.pulse.sourceNames.recentOrders"],
      ] as const;
      const nextFailedSources = failedSources
        .filter(([result]) => result.status === "rejected")
        .map(([, key]) => t(key));
      setFailedSourceNames(nextFailedSources);

      if (results.every((result) => result.status === "rejected")) {
        setPulseData(null);
        setError(t("dashboard.pulse.errorMsg"));
        setLastUpdatedAt(null);
        return;
      }

      if (!isInitialLoad && nextFailedSources.length > 0) {
        toast.warning(t("dashboard.pulse.partialFail", { sources: nextFailedSources.join(", ") }));
      }

      const metrics = metricsResult.status === 'fulfilled' ? metricsResult.value : null;
      const queue = queueResult.status === 'fulfilled' ? queueResult.value : null;
      const drafts = draftsResult.status === "fulfilled" ? draftsResult.value : null;
      const conversationPage = conversationsResult.status === "fulfilled" ? conversationsResult.value : null;
      const atRiskOrders = Array.isArray(queue?.at_risk_orders) ? queue.at_risk_orders : null;

      setPulseData({
        ordersToday: countOrNull(metrics?.metrics?.ordersToday),
        replyTasks: conversationPage
          ? conversationPage.data.filter((conversation) => conversation.needs_merchant_reply === true)
          : null,
        replyTaskCoverageComplete: conversationPage
          ? conversationPage.page === 1 && conversationPage.total <= conversationPage.data.length
          : false,
        draftOrders: drafts,
        draftCoverageComplete: drafts !== null && drafts.length < DRAFT_PAGE_SIZE,
        atRiskOrders,
        exceptionCoverageComplete: atRiskOrders !== null && atRiskOrders.length < EXCEPTION_SAMPLE_LIMIT,
        lastFiveOrders: latestOrdersResult.status === "fulfilled" ? latestOrdersResult.value : null,
        cashPosition: metrics?.cashPosition ?? null,
      });
      setLastUpdatedAt(new Date());
    } catch (loadError: unknown) {
      if (requestSequence !== requestSequenceRef.current) return;
      const e = loadError as { response?: { data?: { error?: { message?: string } } } };
      setError(getErrorMessage(e, t("dashboard.pulse.errorMsg")));
    } finally {
      if (requestSequence === requestSequenceRef.current) setIsLoading(false);
    }
  }, [t]);

  const refreshCourierSnapshot = useCallback(async () => {
    const requestSequence = ++courierRequestSequence.current;
    setCourierSnapshot({ orders: null, isLoading: true });
    try {
      const orders = await apiClient.getOrders({ page: 1, limit: COURIER_SAMPLE_LIMIT });
      if (requestSequence !== courierRequestSequence.current) return;
      setCourierSnapshot({ orders: Array.isArray(orders) ? orders : [], isLoading: false });
    } catch (requestError) {
      if (requestSequence !== courierRequestSequence.current) return;
      console.error("Failed to load the recent courier order sample:", requestError);
      setCourierSnapshot({ orders: null, isLoading: false });
    }
  }, []);

  const refreshAll = useCallback((isInitialLoad = false) => {
    void refreshPulse(isInitialLoad);
    void refreshCourierSnapshot();
  }, [refreshCourierSnapshot, refreshPulse]);

  useEffect(() => {
    const shouldLoadPulse = !SETUP_DASHBOARD_ENABLED || Boolean(setupError) || Boolean(setupStatus?.isComplete && setupCompletionDismissed);
    if (!shouldLoadPulse) {
      return;
    }

    refreshPulse(true);
    void refreshCourierSnapshot();
    const timer = window.setInterval(() => refreshPulse(false), 60000);
    // Order rows include customer and item details. Keep this broad sample on
    // entry/manual refresh and a slower cadence than the task sources.
    const courierTimer = window.setInterval(() => void refreshCourierSnapshot(), 300000);
    return () => {
      window.clearInterval(timer);
      window.clearInterval(courierTimer);
      requestSequenceRef.current += 1;
      courierRequestSequence.current += 1;
    };
  }, [refreshCourierSnapshot, refreshPulse, setupCompletionDismissed, setupError, setupStatus?.isComplete]);

  const dismissSetupCompletion = () => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(completionDismissedKey, '1');
    }
    setSetupCompletionDismissed(true);
  };

  const formatTime = useMemo(() => {
    if (!lastUpdatedAt) return "";
    return new Intl.DateTimeFormat(locale, {
      hour: "numeric",
      minute: "2-digit",
      timeZone: "Asia/Dhaka",
    }).format(lastUpdatedAt);
  }, [lastUpdatedAt, locale]);

  if (SETUP_DASHBOARD_ENABLED && isSetupLoading && !setupStatus && !setupError) {
    return (
      <div className="min-h-full bg-background p-4 md:p-6">
        <div className="mb-4 flex items-center gap-2 text-gray-600">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span className="text-sm font-semibold">{t("dashboard.setup.loading")}</span>
        </div>
      </div>
    );
  }

  if (SETUP_DASHBOARD_ENABLED && setupStatus && (!setupStatus.isComplete || !setupCompletionDismissed)) {
    return (
      <FirstTimeSetupDashboard
        setupStatus={setupStatus}
        onRefresh={refreshSetupStatus}
        onDismissCompletion={dismissSetupCompletion}
        storageKeyPrefix={setupStorageKeyPrefix}
      />
    );
  }

  if (isLoading) {
    return (
      <div className="min-h-full bg-background p-4 md:p-6">
        <div className="mb-4 flex items-center gap-2 text-gray-600">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span className="text-sm font-semibold">{t("dashboard.pulse.loading")}</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-full bg-background p-4 md:p-6">
        <div className="rounded-2xl border border-red-200 bg-red-50 p-5">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 text-red-600" />
            <div className="space-y-1">
              <h3 className="text-base font-bold text-red-900">{t("dashboard.pulse.errorTitle")}</h3>
              <p className="text-sm text-red-700">{error}</p>
            </div>
          </div>
          <button
            onClick={() => refreshPulse(true)}
            className="mt-4 min-h-12 rounded-xl bg-red-600 px-4 text-sm font-semibold text-white"
          >
            {t("dashboard.pulse.retry")}
          </button>
        </div>
      </div>
    );
  }

  if (!pulseData) {
    return null;
  }

  const courierOrders = courierSnapshot.orders;
  const activeCourierOrders = (courierOrders ?? []).filter(isPersistedActiveCourierOrder);
  const inTransitCount = pulseData.cashPosition?.inTransit?.count ?? null;

  const workItems: WorkItem[] = [];
  for (const conversation of pulseData.replyTasks ?? []) {
    const reason = conversation.needs_merchant_reply_reason;
    const detail = reason === "CUSTOMER_UNANSWERED"
      ? t("dashboard.pulse.replyTasks.reasons.CUSTOMER_UNANSWERED")
      : reason === "PROVIDER_SEND_FAILED"
        ? t("dashboard.pulse.replyTasks.reasons.PROVIDER_SEND_FAILED")
        : reason === "HITL_REQUIRED"
          ? t("dashboard.pulse.replyTasks.reasons.HITL_REQUIRED")
          : reason === "ORDER_CONFIDENCE_HOLD"
            ? t("dashboard.pulse.replyTasks.reasons.ORDER_CONFIDENCE_HOLD")
            : t("dashboard.pulse.replyTasks.reasons.default");
    workItems.push({
      id: `reply-${conversation.id}`,
      kind: "reply",
      title: conversation.customer?.name || t("inbox.unknownCustomer"),
      detail,
      to: `/inbox?conversation=${encodeURIComponent(conversation.id)}`,
      sortAt: validDate(conversation.updated_at)?.getTime() ?? 0,
      icon: MessageCircle,
      action: t("dashboard.pulse.replyTasks.open"),
    });
  }
  for (const order of pulseData.draftOrders ?? []) {
    workItems.push({
      id: `draft-${order.id}`,
      kind: "draft",
      title: orderLabel(order),
      detail: t("dashboard.pulse.work.draftDetail", { customer: order.customerName || t("inbox.unknownCustomer") }),
      to: `/orders?orderId=${encodeURIComponent(order.id)}`,
      sortAt: validDate(order.updatedAt)?.getTime() ?? validDate(order.createdAt)?.getTime() ?? 0,
      icon: FileText,
      action: t("dashboard.pulse.work.reviewDraft"),
    });
  }
  for (const order of pulseData.atRiskOrders ?? []) {
    const status = String(order.status || "").toLowerCase();
    workItems.push({
      id: `exception-${order.id}`,
      kind: "exception",
      title: order.customer_name || order.id,
      detail: [status, order.tracking_id].filter(Boolean).join(" · ") || t("dashboard.pulse.status.unknown"),
      to: `/orders?orderId=${encodeURIComponent(order.id)}`,
      sortAt: 0,
      icon: AlertTriangle,
      action: t("dashboard.pulse.attention.reviewOrder"),
    });
  }

  const hasAllWorkSources = pulseData.replyTasks !== null
    && pulseData.replyTaskCoverageComplete
    && pulseData.draftOrders !== null
    && pulseData.draftCoverageComplete
    && pulseData.atRiskOrders !== null
    && pulseData.exceptionCoverageComplete;
  const caughtUp = hasAllWorkSources && workItems.length === 0;
  const workGroups = ([
    {
      kind: "reply" as const,
      title: t("dashboard.pulse.work.groups.replies"),
      to: "/inbox?tab=needs_review",
      action: t("dashboard.pulse.replyTasks.viewFullInbox"),
    },
    {
      kind: "draft" as const,
      title: t("dashboard.pulse.work.groups.drafts"),
      to: "/orders",
      action: t("dashboard.pulse.work.openOrders"),
    },
    {
      kind: "exception" as const,
      title: t("dashboard.pulse.work.groups.exceptions"),
      to: "/orders",
      action: t("dashboard.pulse.work.openOrders"),
    },
  ]).map((group) => {
    const items = workItems
      .filter((item) => item.kind === group.kind)
      .sort((left, right) => right.sortAt - left.sortAt);
    return {
      ...group,
      items,
      visibleItems: items.slice(0, WORK_ITEMS_PER_GROUP),
      hiddenCount: Math.max(0, items.length - WORK_ITEMS_PER_GROUP),
    };
  }).filter((group) => group.items.length > 0);

  return (
    <div className="min-h-full bg-background p-4 md:p-6">
      <div className="mb-4 flex items-end justify-between">
        <div>
          <h1 className="text-xl font-extrabold text-foreground md:text-2xl">{t("dashboard.pulse.title")}</h1>
          <p className="text-sm text-muted-foreground">{t("dashboard.pulse.subtitle")}</p>
        </div>
        <button
          onClick={() => refreshAll(false)}
          className="min-h-12 rounded-xl border border-border bg-card px-3 text-sm font-semibold text-foreground"
        >
          {t("dashboard.pulse.refresh")}
        </button>
      </div>

      {SETUP_DASHBOARD_ENABLED && Boolean(setupError) && (
        <section role="status" className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <span>{t("dashboard.setup.stateUnavailable", { defaultValue: "Setup status is unavailable." })}</span>
          <button type="button" onClick={() => void refreshSetupStatus()} className="min-h-10 font-semibold underline">
            {t("dashboard.pulse.retry")}
          </button>
        </section>
      )}

      {failedSourceNames.length > 0 && (
        <section role="status" className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <span>{t("dashboard.pulse.partialFail", { sources: failedSourceNames.join(", ") })}</span>
          <button type="button" onClick={() => refreshAll(false)} className="min-h-10 font-semibold underline">
            {t("dashboard.pulse.retry")}
          </button>
        </section>
      )}

      {caughtUp ? (
        <p role="status" className="mb-4 flex items-center gap-2 rounded-xl border border-green-200 bg-green-50 p-4 text-sm font-semibold text-green-900">
          <CheckCircle2 className="h-5 w-5" aria-hidden="true" />
          {t("dashboard.pulse.work.caughtUp")}
        </p>
      ) : (
        <section className="mb-4 rounded-2xl border border-border bg-card p-4" aria-labelledby="dashboard-work-heading">
          <div className="mb-3">
            <h2 id="dashboard-work-heading" className="text-base font-bold text-card-foreground">
              {t("dashboard.pulse.work.title")}
            </h2>
            <p className="text-sm text-muted-foreground">{t("dashboard.pulse.work.subtitle")}</p>
          </div>

          {workGroups.length > 0 ? (
            <div className="space-y-4">
              {workGroups.map((group) => (
                <section key={group.kind} aria-labelledby={`dashboard-work-${group.kind}`}>
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <h3 id={`dashboard-work-${group.kind}`} className="text-sm font-semibold text-foreground">{group.title}</h3>
                    <button type="button" onClick={() => navigate(group.to)} className="min-h-10 text-xs font-semibold text-blue-700 hover:underline">
                      {group.action}
                    </button>
                  </div>
                  <div className="space-y-2">
                    {group.visibleItems.map((item) => {
                      const Icon = item.icon;
                      return (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => navigate(item.to)}
                          className="flex min-h-14 w-full items-center gap-3 rounded-xl border border-border bg-background p-3 text-left hover:bg-gray-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-600"
                        >
                          <Icon className="h-5 w-5 shrink-0 text-blue-700" aria-hidden="true" />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-semibold text-foreground">{item.title}</span>
                            <span className="block truncate text-xs text-muted-foreground">{item.detail}</span>
                          </span>
                          <span className="shrink-0 text-xs font-semibold text-blue-700">{item.action}</span>
                        </button>
                      );
                    })}
                  </div>
                  {group.hiddenCount > 0 && (
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground" role="note">
                      <span>{t("dashboard.pulse.work.moreInGroup", { count: group.hiddenCount })}</span>
                      <button type="button" className="font-semibold text-blue-700 hover:underline" onClick={() => navigate(group.items[WORK_ITEMS_PER_GROUP].to)}>
                        {t(group.kind === "reply" ? "dashboard.pulse.work.openNextConversation" : "dashboard.pulse.work.reviewNextOrder")}
                      </button>
                    </div>
                  )}
                </section>
              ))}
            </div>
          ) : (
            <p role="status" className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900">
              {t("dashboard.pulse.work.partialEmpty")}
            </p>
          )}

          {!hasAllWorkSources && (
            <p role="note" className="mt-3 text-xs text-muted-foreground">{t("dashboard.pulse.work.coverageNote")}</p>
          )}
        </section>
      )}

      <section className="mb-4 rounded-2xl border border-border bg-card p-4" aria-labelledby="dashboard-overview-heading">
        <div className="mb-3">
          <h2 id="dashboard-overview-heading" className="text-base font-bold text-card-foreground">{t("dashboard.pulse.overview.title")}</h2>
          <p className="text-sm text-muted-foreground">{t("dashboard.pulse.overview.subtitle")}</p>
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <article className="min-h-[112px] rounded-2xl border border-border bg-background p-4">
            <p className="text-sm font-semibold text-muted-foreground">{t("dashboard.pulse.overview.ordersToday")}</p>
            <p className="mt-2 text-2xl font-black text-foreground md:text-3xl">
              {pulseData.ordersToday === null ? t("dashboard.pulse.cashPosition.unavailable") : formatCount(pulseData.ordersToday)}
            </p>
          </article>
          <CashPositionCard
            label={t("dashboard.pulse.cashPosition.inTransit")}
            subLabel={t("dashboard.pulse.cashPosition.inTransitSub")}
            data={pulseData.cashPosition?.inTransit ?? null}
            icon={Truck}
            formatCurrency={formatCurrency}
            formatCount={formatCount}
            t={t}
          />
          <CashPositionCard
            label={t("dashboard.pulse.cashPosition.atRisk")}
            subLabel={t("dashboard.pulse.cashPosition.atRiskSub", { days: pulseData.cashPosition?.atRisk.windowDays ?? 30 })}
            data={pulseData.cashPosition?.atRisk ?? null}
            icon={AlertTriangle}
            formatCurrency={formatCurrency}
            formatCount={formatCount}
            t={t}
          />
        </div>
        <p role="note" className="mt-3 text-xs text-muted-foreground">
          {t("dashboard.pulse.cashPosition.derivationNote")}
        </p>
      </section>

      <section className="rounded-2xl border border-border bg-card p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-bold text-card-foreground">{t("dashboard.pulse.latestOrders.title")}</h2>
          <button
            onClick={() => navigate("/orders")}
            className="min-h-12 rounded-xl px-3 text-sm font-semibold text-green-600"
            type="button"
          >
            {t("dashboard.pulse.latestOrders.viewAll")}
          </button>
        </div>

        {pulseData.lastFiveOrders === null ? (
          <p role="status" className="rounded-xl bg-amber-50 p-4 text-sm text-amber-900">
            {t("dashboard.pulse.cashPosition.unavailable")}
          </p>
        ) : pulseData.lastFiveOrders.length === 0 ? (
          <p className="rounded-xl bg-gray-50 p-4 text-sm font-medium text-gray-600">{t("dashboard.pulse.latestOrders.empty")}</p>
        ) : (
          <div className="space-y-2">
            {pulseData.lastFiveOrders.map((order) => {
              const firstItem = order.items[0];
                const status = formatOrderStatus(order.status);

                return (
                  <button
                    key={order.id}
                    onClick={() => navigate(`/orders?orderId=${encodeURIComponent(order.id)}`)}
                    type="button"
                  className="w-full rounded-xl border border-border bg-card p-3 text-left"
                >
                  <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                    <div>
                      <p className="text-sm font-bold text-card-foreground">{order.customerName}</p>
                      <p className="text-sm text-muted-foreground">
                        {firstItem?.productName || t("dashboard.pulse.latestOrders.noProduct")} · {formatCurrency(Number(order.total) || 0)}
                      </p>
                    </div>
                    <span className={`inline-flex rounded-full px-2 py-1 text-xs font-bold ${status.className}`}>
                      {status.label}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        )}

        <p className="mt-3 text-xs font-medium text-muted-foreground">{t("dashboard.pulse.latestOrders.valueNote")}</p>
        <p className="mt-3 text-xs font-medium text-muted-foreground">
          {t("dashboard.pulse.liveUpdate")}
          {formatTime ? ` ${t("dashboard.pulse.lastUpdated", { time: formatTime })}` : ""}
        </p>
      </section>

      <section className="rounded-2xl border border-border bg-card p-4" aria-labelledby="home-courier-heading">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h2 id="home-courier-heading" className="text-base font-bold text-card-foreground">{t("dashboard.pulse.courierSnapshot.title")}</h2>
            <p className="text-xs text-muted-foreground">{t("dashboard.pulse.courierSnapshot.subtitle")}</p>
          </div>
          <Truck className="h-5 w-5 text-gray-500" aria-hidden="true" />
        </div>
        {courierSnapshot.isLoading ? (
          <p role="status" className="rounded-xl bg-gray-50 p-4 text-sm font-medium text-gray-600">{t("dashboard.pulse.courierSnapshot.loading")}</p>
        ) : courierOrders === null ? (
          <div role="status" className="rounded-xl bg-amber-50 p-4">
            <p className="text-sm text-amber-900">{t("dashboard.pulse.courierSnapshot.unavailable")}</p>
            <button
              type="button"
              onClick={() => void refreshCourierSnapshot()}
              className="mt-2 min-h-10 text-sm font-semibold text-amber-900 underline underline-offset-4"
            >
              {t("dashboard.pulse.retry")}
            </button>
          </div>
        ) : (
          <>
            <p role="note" className="mb-2 text-xs text-muted-foreground">{t("dashboard.pulse.courierSnapshot.scope", { count: COURIER_SAMPLE_LIMIT })}</p>
            {activeCourierOrders.length > 0 ? (
              <div className="space-y-2">
                {activeCourierOrders.slice(0, 5).map((order) => {
                  const provider = nonEmptyString(order.delivery_provider) || "";
                  const providerLabel = t(`dashboard.pulse.courierSnapshot.providers.${provider.toLowerCase()}`, {
                    defaultValue: provider,
                  });
                  const status = nonEmptyString(order.delivery_status)?.toLowerCase() || "booked";
                  const bookedAt = validDate(order.delivery_dispatched_at);
                  const bookedLabel = bookedAt
                    ? t("dashboard.pulse.courierSnapshot.bookedAt", {
                      time: new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "Asia/Dhaka" }).format(bookedAt),
                    })
                    : "";
                  return (
                    <button
                      key={order.id}
                      type="button"
                      onClick={() => navigate(`/orders?orderId=${encodeURIComponent(order.id)}`)}
                      className="w-full rounded-xl border border-border bg-card p-3 text-left hover:bg-muted transition-colors"
                    >
                      <div className="flex items-start gap-3">
                        <PackageCheck className="mt-0.5 h-5 w-5 shrink-0 text-gray-600" aria-hidden="true" />
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-bold text-card-foreground">{orderLabel(order)}</p>
                          <p className="truncate text-xs text-muted-foreground">{providerLabel} · {getCourierReference(order)}</p>
                          <p className="text-xs font-medium text-muted-foreground">
                            {t(`dashboard.pulse.courierSnapshot.status.${status}`, { defaultValue: status })}
                            {bookedLabel ? ` · ${bookedLabel}` : ""}
                          </p>
                        </div>
                        <span className="shrink-0 text-xs font-semibold text-green-700">{t("dashboard.pulse.courierSnapshot.openOrder")}</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            ) : inTransitCount === 0 ? (
              <p role="status" className="rounded-xl bg-gray-50 p-4 text-sm font-medium text-gray-600">{t("dashboard.pulse.courierSnapshot.noneActive")}</p>
            ) : inTransitCount === null ? (
              <p role="status" className="rounded-xl bg-amber-50 p-4 text-sm text-amber-900">{t("dashboard.pulse.courierSnapshot.aggregateUnavailable")}</p>
            ) : (
              <p role="status" className="rounded-xl bg-amber-50 p-4 text-sm text-amber-900">{t("dashboard.pulse.courierSnapshot.noCompleteRecentSample")}</p>
            )}
            {activeCourierOrders.length > 5 && (
              <p role="note" className="mt-2 text-xs text-muted-foreground">{t("dashboard.pulse.courierSnapshot.omitted", { count: activeCourierOrders.length - 5 })}</p>
            )}
          </>
        )}
      </section>
    </div>
  );
}
