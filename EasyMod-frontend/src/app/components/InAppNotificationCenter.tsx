import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useInRouterContext } from "react-router-dom";
import { Bell, CheckCircle2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import {
  getInAppNotifications,
  markInAppNotificationRead,
  respondToPaymentConfirmation,
} from "@/api/domains/notification";
import type { OwnerNotification } from "@/api/types/notification";
import { getErrorMessage } from "@shared/lib/http/errors";
import { authService } from "../lib/auth";
import { useDialogFocus } from "./inbox/useDialogFocus";

// The /in-app rows carry these columns (owner-notification.entity.js) even
// though the shared interface predates the claim flow — extend locally so the
// expired surfacing (F3) and evidence line (F2) stay type-safe.
type NotificationRow = OwnerNotification & {
  expires_at?: string | null;
  owner_response?: string | null;
};

interface RowResult {
  kind: "success" | "error";
  title: string;
  description: string;
}

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-em-focus-light focus-visible:transition-none";

function notificationTitle(notification: NotificationRow) {
  return notification.customer_data?.title || notification.type.replace(/_/g, " ");
}

function notificationTime(notification: NotificationRow) {
  const value = notification.created_at || notification.createdAt;
  if (!value) return "";
  return new Date(value).toLocaleString();
}

// Payment confirmations are completed by an explicit approve/reject action, not by
// marking them read. The API rejects generic mark-read for them with a 409.
function requiresOwnerAction(notification: NotificationRow) {
  return notification.type === "payment_confirmation";
}

// F3/D-4: the server persists `expires_at` but never auto-fails an expired
// claim (D-4 ratified — merchant judgment is the settlement authority). Render
// the deadline HONESTLY (chip + copy) while keeping approve/reject actionable;
// the server, not the UI, owns what an expired action returns.
function isExpiredRow(notification: NotificationRow) {
  if (notification.status === "expired") return true;
  if (notification.status !== "pending" || !notification.expires_at) return false;
  const deadline = new Date(notification.expires_at).getTime();
  return Number.isFinite(deadline) && deadline <= Date.now();
}

// D-4: pending AND expired rows stay actionable; completed rows are settled.
function isActionableConfirmation(notification: NotificationRow) {
  return (
    requiresOwnerAction(notification) &&
    (notification.status === "pending" || notification.status === "expired" || isExpiredRow(notification))
  );
}

function actionLink(notification: OwnerNotification) {
  const deepLink = notification.customer_data?.deepLink;
  if (deepLink) return String(deepLink);
  const orderId = notification.customer_data?.orderId;
  return orderId ? `/orders?orderId=${encodeURIComponent(String(orderId))}` : null;
}

export default function InAppNotificationCenter() {
  const { t } = useTranslation();
  // F3 (A8 round-2): the payment-confirmation action route is owner-only
  // (notification.routes.js:41-52 → 403 for staff). Follow the app's existing
  // client-side owner-gating idiom (BusinessAutomationDefaults.tsx,
  // PoliciesTab.tsx, ChannelDetail.tsx): staff keep seeing the claim row and
  // its evidence, but get a stated reason instead of always-403 buttons.
  const isOwner = authService.getCurrentShop()?.role?.toLowerCase() === "owner";
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [notifications, setNotifications] = useState<NotificationRow[]>([]);
  // Per-row action state: which action is in flight, and the last honest verdict.
  const [actionBusy, setActionBusy] = useState<Record<string, "approve" | "reject">>({});
  const [rowResults, setRowResults] = useState<Record<string, RowResult>>({});
  const panelRef = useRef<HTMLDivElement>(null);
  useDialogFocus(panelRef, open);
  // Unit renders mount the center without a Router; keep SPA links in-app but
  // fall back to a plain anchor outside router context (ContextualEntityLink
  // precedent).
  const inRouter = useInRouterContext();

  const unreadCount = useMemo(
    () => notifications.filter(notification => notification.status === "pending").length,
    [notifications]
  );

  const load = async () => {
    setLoading(true);
    try {
      setNotifications(await getInAppNotifications(10));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("shell.notifications.loadFailed"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next) await load();
  };

  const markRead = async (id: string) => {
    try {
      await markInAppNotificationRead(id);
      setNotifications(current => current.map(item => item.id === id ? { ...item, status: "completed" } : item));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("shell.notifications.updateFailed"));
      // The server rejected the change, so resync rather than leave a stale row on screen.
      await load();
    }
  };

  // F2: merchant claim review — the EXISTING authenticated owner-action route
  // (`POST /api/notifications/payment-confirmation/:id/:action`). The banner
  // states only what the server said: success renders the server `message`
  // verbatim; a refusal (409 claim/lifecycle guards, 404/403, anything) renders
  // the server error `message` verbatim — never rewritten, never softened.
  const respond = async (notification: NotificationRow, action: "approve" | "reject") => {
    const { id } = notification;
    setActionBusy(current => ({ ...current, [id]: action }));
    setRowResults(({ [id]: _dismissed, ...rest }) => rest);
    try {
      const verdict = await respondToPaymentConfirmation(id, action);
      const serverMessage = typeof verdict?.message === "string" && verdict.message.trim() ? verdict.message : "";
      setRowResults(current => ({
        ...current,
        [id]: {
          kind: "success",
          title: action === "approve"
            ? t("shell.notifications.approvedTitle")
            : t("shell.notifications.rejectedTitle"),
          description: serverMessage || t("shell.notifications.actionRecorded"),
        },
      }));
      // The server flipped the row (and the transaction) — resync from it.
      await load();
    } catch (error) {
      setRowResults(current => ({
        ...current,
        [id]: {
          kind: "error",
          title: t("shell.notifications.actionFailedTitle"),
          description: getErrorMessage(error, t("shell.notifications.actionFailedFallback")),
        },
      }));
      // A refusal leaves the row untouched server-side; resync to prove it.
      await load();
    } finally {
      setActionBusy(({ [id]: _used, ...rest }) => rest);
    }
  };

  return (
    <div
      className="relative"
      onKeyDown={(event) => {
        if (event.key === "Escape") setOpen(false);
      }}
    >
      <button
        type="button"
        data-testid="notification-bell"
        aria-label={t("shell.notifications.title")}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={toggle}
        className={`relative min-h-11 min-w-11 inline-flex items-center justify-center rounded-lg p-2 text-em-text-secondary transition-colors hover:bg-em-bg-muted hover:text-em-text-primary ${FOCUS_RING}`}
      >
        <Bell className="h-5 w-5" aria-hidden="true" />
        {unreadCount > 0 && (
          <span className="absolute right-1 top-1 h-2.5 w-2.5 rounded-full bg-em-danger-700 ring-2 ring-em-bg-surface" />
        )}
      </button>

      {open && (
        <>
          <button
            type="button"
            className="fixed inset-0 z-40 cursor-default bg-transparent"
            aria-label={t("common.close", { defaultValue: "Close" })}
            onClick={() => setOpen(false)}
          />
          <div
            ref={panelRef}
            role="dialog"
            aria-modal="false"
            aria-label={t("shell.notifications.title")}
            className="absolute right-0 top-full z-50 mt-2 w-[min(360px,calc(100vw-2rem))] overflow-hidden rounded-lg border border-em-border bg-em-bg-surface shadow-lg"
          >
            <div className="flex items-center justify-between border-b border-em-border px-4 py-3">
              <div>
                <div className="text-sm font-semibold text-em-text-primary">{t("shell.notifications.title")}</div>
                <div className="em-tabular text-xs text-em-text-secondary">{t("shell.notifications.unread", { count: unreadCount })}</div>
              </div>
              {loading && <Loader2 className="h-4 w-4 animate-spin text-em-text-secondary" aria-hidden="true" />}
            </div>

            <div className="max-h-96 overflow-y-auto">
              {notifications.length === 0 && !loading ? (
                <div className="px-4 py-8 text-center text-sm text-em-text-secondary">{t("shell.notifications.empty")}</div>
              ) : (
                notifications.map((notification) => {
                  const deepLink = actionLink(notification);
                  const ownerActionRequired = requiresOwnerAction(notification);
                  const expired = isExpiredRow(notification);
                  const actionable = isActionableConfirmation(notification);
                  const busy = actionBusy[notification.id];
                  const result = rowResults[notification.id];
                  const data = notification.customer_data ?? {};
                  const trxId = data.transactionId ? String(data.transactionId) : "";
                  const orderId = data.orderId ? String(data.orderId) : "";
                  const walletNumber = data.walletNumber ? String(data.walletNumber) : "";
                  const hasClaimAmount = data.claimAmount !== undefined && data.claimAmount !== null && data.claimAmount !== "";
                  const actionReference = trxId || orderId || notification.id;
                  return (
                    <div key={notification.id} className="border-b border-em-border px-4 py-3 last:border-b-0" aria-busy={Boolean(busy)}>
                      <div className="flex items-start gap-3">
                        <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${
                          notification.status === "completed"
                            ? "bg-em-border-strong"
                            : expired
                              ? "bg-em-sunlight-500"
                              : "bg-em-violet-600"
                        }`} />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                          {deepLink ? (
                            inRouter ? (
                              <Link
                                to={String(deepLink)}
                                onClick={() => setOpen(false)}
                                className={`block truncate text-sm font-semibold text-em-text-primary hover:text-em-violet-700 ${FOCUS_RING}`}
                              >
                                {notificationTitle(notification)}
                              </Link>
                            ) : (
                              <a
                                href={String(deepLink)}
                                onClick={() => setOpen(false)}
                                className={`block truncate text-sm font-semibold text-em-text-primary hover:text-em-violet-700 ${FOCUS_RING}`}
                              >
                                {notificationTitle(notification)}
                              </a>
                            )
                          ) : (
                            <div className="truncate text-sm font-semibold text-em-text-primary">{notificationTitle(notification)}</div>
                          )}
                          {expired && (
                            <span
                              data-testid={`expired-chip-${notification.id}`}
                              className="shrink-0 rounded-full bg-em-sunlight-100 px-2 py-0.5 text-xs font-semibold text-em-sunlight-700"
                            >
                              {t("shell.notifications.expiredChip")}
                            </span>
                          )}
                          {ownerActionRequired && notification.status === "completed" && (
                            <span
                              data-testid={`completed-chip-${notification.id}`}
                              className="shrink-0 rounded-full bg-em-success-100 px-2 py-0.5 text-xs font-semibold text-em-success-700"
                            >
                              {t("shell.notifications.completedChip")}
                            </span>
                          )}
                          </div>
                          {/* The deadline copy is about the merchant's action window —
                              only true for payment confirmations; other row types just
                              carry the chip. */}
                          {expired && ownerActionRequired && (
                            <p className="mt-1 text-xs text-em-text-secondary" data-testid={`expired-copy-${notification.id}`}>
                              {t("shell.notifications.expiredCopy")}
                            </p>
                          )}
                          <p className="mt-1 line-clamp-2 text-xs text-em-text-secondary">{notification.customer_message}</p>
                          {/* F2 evidence context: the number the customer was shown and the
                              claim they filed — read back from the server row (no silent
                              number switching; contract §6). */}
                          {ownerActionRequired && (trxId || hasClaimAmount || walletNumber) && (
                            <div
                              className="em-tabular mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs font-medium text-em-text-primary"
                              data-testid={`confirmation-evidence-${notification.id}`}
                            >
                              {trxId && <span>{t("shell.notifications.evidenceTrxId", { value: trxId })}</span>}
                              {hasClaimAmount && <span>{t("shell.notifications.evidenceAmount", { value: String(data.claimAmount) })}</span>}
                              {walletNumber && <span>{t("shell.notifications.evidenceNumber", { value: walletNumber })}</span>}
                            </div>
                          )}
                          <div className="em-tabular mt-2 text-xs text-em-text-secondary">{notificationTime(notification)}</div>
                        </div>
                        {notification.status === "pending" && !ownerActionRequired && (
                          <button
                            type="button"
                            aria-label={t("shell.notifications.markRead")}
                            onClick={() => void markRead(notification.id)}
                            className={`min-h-11 min-w-11 inline-flex items-center justify-center rounded-md p-1 text-em-text-secondary hover:bg-em-bg-muted hover:text-em-success-700 ${FOCUS_RING}`}
                          >
                            <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                          </button>
                        )}
                        {notification.status === "pending" && ownerActionRequired && deepLink && (
                          inRouter ? (
                            <Link
                              to={deepLink}
                              onClick={() => setOpen(false)}
                              className={`shrink-0 min-h-11 inline-flex items-center rounded-md px-2 py-1 text-xs font-medium text-em-violet-700 hover:bg-em-violet-50 ${FOCUS_RING}`}
                            >
                              {t("shell.notifications.review")}
                            </Link>
                          ) : (
                            <a
                              href={deepLink}
                              onClick={() => setOpen(false)}
                              className={`shrink-0 min-h-11 inline-flex items-center rounded-md px-2 py-1 text-xs font-medium text-em-violet-700 hover:bg-em-violet-50 ${FOCUS_RING}`}
                            >
                              {t("shell.notifications.review")}
                            </a>
                          )
                        )}
                      </div>
                      {actionable && !isOwner && (
                        // Owner-only affordance (the endpoint 403s anyone else):
                        // non-owners see the row + this note, never live buttons.
                        <p
                          role="status"
                          className="mt-2 rounded-md border border-em-border bg-em-bg-muted px-3 py-2 text-xs text-em-text-secondary"
                          data-testid={`claim-owner-only-${notification.id}`}
                        >
                          {t("shell.notifications.ownerOnlyNote", {
                            defaultValue: "Only the shop owner can approve or reject payment confirmations. You can review the details here.",
                          })}
                        </p>
                      )}
                      {actionable && isOwner && (
                        <div className="mt-2 flex flex-wrap items-center gap-2 pl-5">
                          <button
                            type="button"
                            onClick={() => void respond(notification, "approve")}
                            disabled={Boolean(busy)}
                            aria-label={t("shell.notifications.approveAria", { reference: actionReference })}
                            className={`inline-flex min-h-11 items-center gap-1.5 rounded-md border border-em-success-700/40 bg-em-success-100 px-3 py-1 text-xs font-semibold text-em-success-700 hover:border-em-success-700 disabled:opacity-50 ${FOCUS_RING}`}
                            data-testid={`approve-${notification.id}`}
                          >
                            {busy === "approve" && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
                            {t("shell.notifications.approve")}
                          </button>
                          <button
                            type="button"
                            onClick={() => void respond(notification, "reject")}
                            disabled={Boolean(busy)}
                            aria-label={t("shell.notifications.rejectAria", { reference: actionReference })}
                            className={`inline-flex min-h-11 items-center gap-1.5 rounded-md border border-em-danger-700/40 bg-em-danger-100 px-3 py-1 text-xs font-semibold text-em-danger-700 hover:border-em-danger-700 disabled:opacity-50 ${FOCUS_RING}`}
                            data-testid={`reject-${notification.id}`}
                          >
                            {busy === "reject" && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
                            {t("shell.notifications.reject")}
                          </button>
                        </div>
                      )}
                      {result && (
                        <div
                          role={result.kind === "error" ? "alert" : "status"}
                          aria-live="polite"
                          className={`mt-2 rounded-md border px-3 py-2 text-xs ${
                            result.kind === "error"
                              ? "border-em-danger-700/30 bg-em-danger-100 text-em-danger-700"
                              : "border-em-success-700/30 bg-em-success-100 text-em-success-700"
                          }`}
                          data-testid={`confirmation-result-${notification.id}`}
                        >
                          <div className="font-semibold">{result.title}</div>
                          <div className="mt-0.5 break-words">{result.description}</div>
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
