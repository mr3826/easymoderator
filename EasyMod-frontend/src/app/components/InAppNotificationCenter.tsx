import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useInRouterContext } from "react-router-dom";
import { Bell, CheckCircle2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { getInAppNotifications, markInAppNotificationRead } from "@/api/domains/notification";
import type { OwnerNotification } from "@/api/types/notification";
import { useDialogFocus } from "./inbox/useDialogFocus";

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-em-focus-light focus-visible:transition-none";

function notificationTitle(notification: OwnerNotification) {
  return notification.customer_data?.title || notification.type.replace(/_/g, " ");
}

function notificationTime(notification: OwnerNotification) {
  const value = notification.created_at || notification.createdAt;
  if (!value) return "";
  return new Date(value).toLocaleString();
}

// Payment confirmations are completed by an explicit approve/reject action, not by
// marking them read. The API rejects generic mark-read for them with a 409.
function requiresOwnerAction(notification: OwnerNotification) {
  return notification.type === "payment_confirmation";
}

function actionLink(notification: OwnerNotification) {
  const deepLink = notification.customer_data?.deepLink;
  if (deepLink) return String(deepLink);
  const orderId = notification.customer_data?.orderId;
  return orderId ? `/orders?orderId=${encodeURIComponent(String(orderId))}` : null;
}

export default function InAppNotificationCenter() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [notifications, setNotifications] = useState<OwnerNotification[]>([]);
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
                  return (
                    <div key={notification.id} className="border-b border-em-border px-4 py-3 last:border-b-0">
                      <div className="flex items-start gap-3">
                        <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${notification.status === "pending" ? "bg-em-violet-600" : "bg-em-border-strong"}`} />
                        <div className="min-w-0 flex-1">
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
                          <p className="mt-1 line-clamp-2 text-xs text-em-text-secondary">{notification.customer_message}</p>
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
