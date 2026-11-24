/**
 * Dashboard data layer — extracted verbatim from the baseline Dashboard.tsx
 * (fetch fan-out, sequence guards, coverage honesty, polling cadence) so the
 * redesign changes presentation only. Adds the real queue aggregates that the
 * baseline fetched but dropped, and a stale-sync flag for the §21.1 warning.
 *
 * `t` must stay identity-stable (real react-i18next is); refreshPulse keeps
 * useCallback([t]) and the effect keeps its exact dependency shape — an
 * unstable dep re-fires polling and reintroduces documented test flakiness.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { apiClient } from "@/api";
import { getStockExceptions } from "@/api/domains/product";
import { getErrorMessage } from "@shared/lib/http/errors";
import type { NeedsReplyCount, StockExceptions } from "@/api/types/dashboard";
import type { CourierSnapshotState, PulseData } from "./types";

const REPLY_PAGE_SIZE = 100;
const DRAFT_PAGE_SIZE = 100;
const EXCEPTION_SAMPLE_LIMIT = 10;
const COURIER_SAMPLE_LIMIT = 100;
/** 2.5 poll intervals — avoids flapping on one throttled background tick. */
const STALE_AFTER_MS = 150_000;
const STALE_CHECK_MS = 30_000;

const countOrNull = (value: unknown): number | null => (
  typeof value === "number" && Number.isFinite(value) ? value : null
);

/**
 * C1 object acceptance: the chip only trusts a well-formed needs-reply payload.
 * Missing/legacy queue responses (old backend still emitting `unread_count`)
 * map to null — an honest Unavailable, never the stale count and never 0.
 */
const needsReplyOrNull = (value: unknown): NeedsReplyCount | null => {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<NeedsReplyCount>;
  const count = countOrNull(candidate.count);
  if (count === null) return null;
  return {
    count,
    scanned: countOrNull(candidate.scanned) ?? 0,
    cap: countOrNull(candidate.cap) ?? 200,
    coverageComplete: candidate.coverageComplete === true,
    generated_at: typeof candidate.generated_at === "string" ? candidate.generated_at : "",
  };
};

/** C2 object acceptance — same rule: malformed/absent source is null, never 0. */
const stockExceptionsOrNull = (value: unknown): StockExceptions | null => {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<StockExceptions>;
  const outOfStock = countOrNull(candidate.outOfStock);
  const lowStock = countOrNull(candidate.lowStock);
  const exceptions = countOrNull(candidate.exceptions);
  if (outOfStock === null || lowStock === null || exceptions === null) return null;
  return {
    outOfStock,
    lowStock,
    exceptions,
    scanned: countOrNull(candidate.scanned) ?? 0,
    cap: countOrNull(candidate.cap) ?? 1000,
    coverageComplete: candidate.coverageComplete === true,
    generated_at: typeof candidate.generated_at === "string" ? candidate.generated_at : "",
  };
};

export function useDashboardData(enabled: boolean) {
  const { t } = useTranslation();
  const [pulseData, setPulseData] = useState<PulseData | null>(null);
  const [courierSnapshot, setCourierSnapshot] = useState<CourierSnapshotState>({ orders: null, isLoading: true });
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [failedSourceNames, setFailedSourceNames] = useState<string[]>([]);
  const [isStale, setIsStale] = useState(false);
  const requestSequenceRef = useRef(0);
  const courierRequestSequence = useRef(0);

  const refreshPulse = useCallback(async (isInitialLoad = false) => {
    const requestSequence = ++requestSequenceRef.current;
    if (isInitialLoad) setIsLoading(true);
    setError(null);

    try {
      const [metricsResult, queueResult, draftsResult, conversationsResult, latestOrdersResult, worklistCountsResult, stockExceptionsResult] = await Promise.allSettled([
        apiClient.getDashboardMetrics(),
        apiClient.getDashboardQueue(),
        apiClient.getOrders({ order_status: "draft", page: 1, limit: DRAFT_PAGE_SIZE }),
        apiClient.getConversations({ page: 1, limit: REPLY_PAGE_SIZE }),
        apiClient.getOrders({ page: 1, limit: 5 }),
        // D8 bounded read-side sources (shared bucket authority + D2 predicate).
        apiClient.getOrderCounts(),
        getStockExceptions(),
      ]);

      if (requestSequence !== requestSequenceRef.current) return;

      if (metricsResult.status === "rejected") console.error("Failed to load dashboard overview:", metricsResult.reason);
      if (queueResult.status === "rejected") console.error("Failed to load dashboard action counts:", queueResult.reason);
      if (draftsResult.status === "rejected") console.error("Failed to load Draft orders:", draftsResult.reason);
      if (conversationsResult.status === "rejected") console.error("Failed to load reply tasks:", conversationsResult.reason);
      if (latestOrdersResult.status === "rejected") console.error("Failed to load recent orders:", latestOrdersResult.reason);
      if (worklistCountsResult.status === "rejected") console.error("Failed to load worklist counts:", worklistCountsResult.reason);
      if (stockExceptionsResult.status === "rejected") console.error("Failed to load stock exceptions:", stockExceptionsResult.reason);

      const results = [metricsResult, queueResult, draftsResult, conversationsResult, latestOrdersResult, worklistCountsResult, stockExceptionsResult];
      const failedSources = [
        [metricsResult, "dashboard.pulse.sourceNames.overview"],
        [queueResult, "dashboard.pulse.sourceNames.actionCounts"],
        [draftsResult, "dashboard.pulse.sourceNames.drafts"],
        [conversationsResult, "dashboard.pulse.sourceNames.replies"],
        [latestOrdersResult, "dashboard.pulse.sourceNames.recentOrders"],
        // Published-name reuse (A2 sole-writer): the worklist-counts source is
        // the delivery-attempts/returns authority here, and the stock source is
        // labelled by the BusinessHealth tile key. No new i18n keys needed.
        [worklistCountsResult, "dashboard.pulse.sourceNames.deliveryExceptions"],
        [stockExceptionsResult, "dashboard.businessHealth.stockExceptions"],
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
      const drafts = draftsResult.status === 'fulfilled' ? draftsResult.value : null;
      const conversationPage = conversationsResult.status === 'fulfilled' ? conversationsResult.value : null;
      // D3: the queue sample is the PII-free needs_action projection
      // (id/orderNumber/status/tracking_id/updatedAt). Nothing downstream may
      // read customer_name/customer_phone — the deprecated shim fields are gone.
      const atRiskOrders = Array.isArray(queue?.at_risk_orders) ? queue.at_risk_orders : null;
      const worklistCounts = worklistCountsResult.status === 'fulfilled' ? worklistCountsResult.value : null;

      setPulseData({
        commerceSignals: queue?.commerce_signals ?? null,
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
        // C1/D3: needs_reply REPLACES the legacy unread_count (never read here;
        // an absent/malformed object is null → the chip says Unavailable).
        needsReply: needsReplyOrNull(queue?.needs_reply),
        pendingPaymentCount: countOrNull(queue?.pending_payment_count),
        readyToDispatchCount: countOrNull(queue?.ready_to_dispatch_count),
        predicateVersion: typeof queue?.predicate_version === "string" ? queue.predicate_version : null,
        worklistNeedsActionCount: countOrNull(worklistCounts?.needs_action),
        stockExceptions: stockExceptionsOrNull(stockExceptionsResult.status === 'fulfilled' ? stockExceptionsResult.value : null),
        chartData: metrics?.chartData ?? null,
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
    if (!enabled) {
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
  }, [refreshCourierSnapshot, refreshPulse, enabled]);

  // Stale-sync detection (§21.1): flips a boolean only, never re-fetches.
  useEffect(() => {
    setIsStale(false);
    if (!lastUpdatedAt) return;
    const check = () => setIsStale(Date.now() - lastUpdatedAt.getTime() > STALE_AFTER_MS);
    const id = window.setInterval(check, STALE_CHECK_MS);
    return () => window.clearInterval(id);
  }, [lastUpdatedAt]);

  return {
    pulseData,
    courierSnapshot,
    lastUpdatedAt,
    isLoading,
    error,
    failedSourceNames,
    isStale,
    refreshPulse,
    refreshCourierSnapshot,
    refreshAll,
  };
}
