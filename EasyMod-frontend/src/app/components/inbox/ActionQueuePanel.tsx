/**
 * ActionQueuePanel — P+03 Merchant Action Queue.
 * Compact, action-first read-only strip above the thread list: what to do
 * next, in operational-risk order, with one deep link per item. Resolution
 * always happens on the linked surface (thread / draft / checkout /
 * opportunity), so this panel never mutates — it mirrors the server read
 * model. Renders nothing while the feature flag is off, while loading, when
 * the queue is empty, or when the fetch fails: the queue must never block or
 * clutter the inbox.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ArrowRight, RefreshCw, TriangleAlert } from "lucide-react";
import { motion } from "motion/react";
import { getInboxActions, type InboxActionsResult } from "@/api/domains/inbox";
import {
  INBOX_ACTION_BUCKET_NAME,
  INBOX_ACTION_BUCKET_ORDER,
  type InboxActionBucketName,
  type InboxActionItem,
  type InboxActionNextType,
  type InboxActionReasonCode,
  type InboxActionView,
} from "@/api/types/inbox";
import { Badge } from "@/app/components/ui/badge";
import { formatRelative } from "../customers/customerDisplay";
import { fadeUp, staggerChildren } from "@/lib/motion";

const ANIMATE = import.meta.env.MODE !== "test";
const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-em-focus-light focus-visible:transition-none";

// Display maps — keep in sync with the unions in @/api/types/inbox and the
// locale files. Dynamic template keys are resolved through these maps instead
// of inline interpolation (translation-coverage.test.ts scans literals only).
const BUCKET_LABEL_KEYS: Record<InboxActionBucketName, string> = {
  NEEDS_HUMAN: "inbox.actions.bucket.NEEDS_HUMAN",
  COMMITTED_WITHOUT_ACK: "inbox.actions.bucket.COMMITTED_WITHOUT_ACK",
  CUSTOMER_BLOCKED: "inbox.actions.bucket.CUSTOMER_BLOCKED",
  DRAFT_RECOVERY: "inbox.actions.bucket.DRAFT_RECOVERY",
  PURCHASE_OPPORTUNITY: "inbox.actions.bucket.PURCHASE_OPPORTUNITY",
  KNOWLEDGE_GAP: "inbox.actions.bucket.KNOWLEDGE_GAP",
};

// MW-V1 built-in work views (literals for the translation-coverage guard).
const QUEUE_VIEWS: InboxActionView[] = [
  "attention", "mine", "unassigned", "handoff", "recovery", "opportunities", "review",
];

const VIEW_LABEL_KEYS: Record<InboxActionView, string> = {
  attention: "inbox.actions.views.attention",
  mine: "inbox.actions.views.mine",
  unassigned: "inbox.actions.views.unassigned",
  handoff: "inbox.actions.views.handoff",
  recovery: "inbox.actions.views.recovery",
  opportunities: "inbox.actions.views.opportunities",
  review: "inbox.actions.views.review",
};

const REASON_LABEL_KEYS: Record<InboxActionReasonCode, string> = {
  HITL_REQUIRED: "inbox.actions.reason.HITL_REQUIRED",
  HANDOFF_SUSPENDED_CHECKOUT: "inbox.actions.reason.HANDOFF_SUSPENDED_CHECKOUT",
  SEND_FAILED_AFTER_MUTATION: "inbox.actions.reason.SEND_FAILED_AFTER_MUTATION",
  SEND_NEEDS_RECONCILIATION: "inbox.actions.reason.SEND_NEEDS_RECONCILIATION",
  CHECKOUT_WAITING_CUSTOMER: "inbox.actions.reason.CHECKOUT_WAITING_CUSTOMER",
  DRAFT_AWAITING_REVIEW: "inbox.actions.reason.DRAFT_AWAITING_REVIEW",
  HELD_MESSAGE: "inbox.actions.reason.HELD_MESSAGE",
  OPPORTUNITY_OPEN: "inbox.actions.reason.OPPORTUNITY_OPEN",
  KNOWLEDGE_GAP_OPEN: "inbox.actions.reason.KNOWLEDGE_GAP_OPEN",
};

const NEXT_ACTION_LABEL_KEYS: Record<InboxActionNextType, string> = {
  open_conversation: "inbox.actions.next.open_conversation",
  review_draft: "inbox.actions.next.review_draft",
  reconcile_send: "inbox.actions.next.reconcile_send",
  resume_checkout: "inbox.actions.next.resume_checkout",
  review_opportunity: "inbox.actions.next.review_opportunity",
  review_knowledge_gap: "inbox.actions.next.review_knowledge_gap",
};

/** Where the merchant resolves this item — conversation first, then the
 *  authoritative source page, then the knowledge surface. */
const deepLinkFor = (item: InboxActionItem): string | null => {
  if (item.conversation_id) return `/inbox?conversation=${encodeURIComponent(item.conversation_id)}`;
  if (item.next_action.type === "review_opportunity" && item.customer_id) {
    return `/customers/${encodeURIComponent(item.customer_id)}`;
  }
  if (item.next_action.type === "review_knowledge_gap") return "/knowledge";
  return null;
};

interface ActionQueuePanelProps {
  /**
   * Registration hook: called once on mount with the panel's refresh function
   * so the parent can re-pull the queue when an SSE inbox event lands
   * (hitl_changed / message_delivery_updated / delivery_failed /
   * conversation_updated). Optional — the panel works unparented.
   */
  onSseRefresh?: (refresh: () => void) => void;
}

export function ActionQueuePanel({ onSseRefresh }: ActionQueuePanelProps) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [result, setResult] = useState<InboxActionsResult | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // MW-V1: built-in server-backed views. 'attention' = every open item.
  const [view, setView] = useState<InboxActionView>('attention');
  const requestIdRef = useRef(0);
  const viewRef = useRef<InboxActionView>(view);

  const refresh = useCallback(async (forView?: InboxActionView) => {
    const active = forView ?? viewRef.current;
    const requestId = ++requestIdRef.current;
    setRefreshing(true);
    try {
      const next = await getInboxActions(active);
      if (requestId === requestIdRef.current) setResult(next);
    } catch {
      // Fail closed and silently — the inbox itself is untouched by this strip.
      if (requestId === requestIdRef.current) setResult(null);
    } finally {
      if (requestId === requestIdRef.current) setRefreshing(false);
    }
  }, []);

  const onSseRefreshRef = useRef(onSseRefresh);
  useEffect(() => { onSseRefreshRef.current = onSseRefresh; });

  useEffect(() => {
    onSseRefreshRef.current?.(() => void refresh());
    void refresh();
  }, [refresh]);

  const changeView = (next: InboxActionView) => {
    setView(next);
    viewRef.current = next;
    void refresh(next);
  };

  // Malformed or legacy-shaped payloads (proxy pages, partial rollouts,
  // server bugs) must degrade the strip, not white-screen the whole inbox
  // through the app's error boundary.
  const payload = result && !result.featureDisabled ? result.data : null;
  const items = Array.isArray(payload?.items) ? payload.items : [];
  const counts = payload && typeof payload.counts === 'object' ? payload.counts : undefined;
  if (!result || result.featureDisabled || !payload) return null;
  if (items.length === 0 && !(counts && counts.total > 0) && payload.partial !== true) return null;

  // Server already sorts bucket asc → oldest fact first; group for display
  // without re-ordering, skipping empty buckets.
  const groups = INBOX_ACTION_BUCKET_ORDER
    .map((bucket) => ({ bucket, bucketItems: items.filter((item) => item.bucket === bucket) }))
    .filter((group) => group.bucketItems.length > 0);

  return (
    <section
      data-testid="action-queue"
      aria-live="polite"
      className="shrink-0 bg-em-bg-surface border-b border-em-border"
    >
      {/* Degraded-data honesty: a fail-closed source bucket contributed nothing.
          Only rendered once the queue itself is renderable (fail-closed first). */}
      {payload.partial === true && (
        <div
          role="status"
          data-testid="action-queue-partial"
          className="flex items-center gap-2 border-b border-em-sunlight-600/30 bg-em-sunlight-100 px-4 md:px-8 py-2 text-xs font-medium text-em-sunlight-700"
        >
          <TriangleAlert className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>{t("inbox.actions.partial")}</span>
        </div>
      )}
      <div className="flex items-center justify-between gap-2 px-4 md:px-8 pt-2.5 pb-1">
        <h2 className="text-sm font-semibold text-em-text-primary">
          {t("inbox.actions.title", { total: counts?.total ?? items.length })}
        </h2>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={refreshing}
          aria-label={t("inbox.actions.refresh")}
          title={t("inbox.actions.refresh")}
          className={`inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-lg text-em-text-secondary hover:bg-em-bg-muted hover:text-em-text-primary disabled:opacity-50 ${FOCUS_RING}`}
          data-testid="action-queue-refresh"
        >
          <RefreshCw className={`w-4 h-4 ${refreshing ? "animate-spin" : ""}`} aria-hidden="true" />
        </button>
      </div>

      {counts && (
        <div
          role="tablist"
          aria-label={t("inbox.actions.views.label")}
          className="flex gap-1.5 overflow-x-auto px-4 md:px-8 pb-1.5"
        >
          {counts && QUEUE_VIEWS.filter((v) => (counts.views?.[v] ?? 0) > 0 || v === "attention" || v === view).map((v) => {
            const n = counts.views?.[v] ?? 0;
            return (
              <button
                key={v}
                type="button"
                role="tab"
                aria-selected={view === v}
                onClick={() => changeView(v)}
                data-testid={`queue-view-${v}`}
                className={`shrink-0 min-h-11 rounded-full px-2.5 py-1 text-xs font-medium transition ${FOCUS_RING} ${
                  view === v
                    ? "bg-em-midnight-900 text-white"
                    : "bg-em-bg-muted text-em-text-primary hover:bg-em-border/60"
                }`}
              >
                {t(VIEW_LABEL_KEYS[v])}
                <span className="ml-1 tabular-nums">{n}</span>
              </button>
            );
          })}
        </div>
      )}

      <div
        className="max-h-56 overflow-y-auto px-4 md:px-8 pb-3"
        tabIndex={0}
        aria-label={t("inbox.actions.title", { total: counts?.total ?? items.length })}
      >
        {items.length === 0 ? (
          <p className="py-3 text-sm text-em-text-secondary">{t("inbox.actions.views.empty")}</p>
        ) : groups.map(({ bucket, bucketItems }) => (
          <div key={bucket} className="mt-1.5 first:mt-0">
            <p className="text-xs font-semibold uppercase tracking-wide text-em-text-secondary">
              {t(BUCKET_LABEL_KEYS[INBOX_ACTION_BUCKET_NAME[bucket]])}
            </p>
            <motion.ul
              variants={staggerChildren}
              initial={ANIMATE ? "hidden" : false}
              animate="visible"
              className="divide-y divide-em-border"
            >
              {bucketItems.map((item) => {
                const href = deepLinkFor(item);
                return (
                  <motion.li key={item.item_key} variants={fadeUp} data-testid="action-item">
                    <div className="flex items-center gap-2 py-1.5">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm text-em-text-primary">
                          {t(REASON_LABEL_KEYS[item.reason_code])}
                        </p>
                        <div className="flex flex-wrap items-center gap-x-2 text-xs text-em-text-secondary">
                          {item.grounded_deadline && (
                            <span data-testid="action-deadline" className="em-tabular font-medium text-em-sunlight-700">
                              {t("inbox.actions.dueBy", {
                                time: formatRelative(item.grounded_deadline, i18n.language),
                              })}
                            </span>
                          )}
                          {item.owner && (
                            <Badge variant="secondary" className="text-xs">
                              {t("inbox.actions.assigned")}
                            </Badge>
                          )}
                        </div>
                      </div>
                      {href ? (
                        <button
                          type="button"
                          onClick={() => navigate(href)}
                          data-testid="action-next-link"
                          className={`inline-flex min-h-11 shrink-0 items-center gap-1 px-1 py-2 text-sm font-medium text-em-violet-700 hover:underline ${FOCUS_RING}`}
                        >
                          {t(NEXT_ACTION_LABEL_KEYS[item.next_action.type])}
                          <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
                        </button>
                      ) : (
                        <span className="shrink-0 px-1 py-2 text-xs text-em-text-secondary">
                          {t(NEXT_ACTION_LABEL_KEYS[item.next_action.type])}
                        </span>
                      )}
                    </div>
                  </motion.li>
                );
              })}
            </motion.ul>
          </div>
        ))}
      </div>
    </section>
  );
}
