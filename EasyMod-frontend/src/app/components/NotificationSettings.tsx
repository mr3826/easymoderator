import { useEffect, useMemo, useState } from "react";
import type { ComponentType, ReactNode } from "react";
import { toast } from "sonner";
import {
  AlertCircle,
  Bell,
  CheckCircle2,
  Copy,
  RefreshCw,
  Send,
  Smartphone,
  Trash2,
} from "lucide-react";
import { useRef } from "react";
import { motion, MotionConfig } from "motion/react";
import { useTranslation } from "react-i18next";
import {
  createTelegramConnectIntent,
  disconnectTelegramAlerts,
  getTelegramNotificationStatus,
  sendTelegramTestAlert,
  updateTelegramPreferences,
} from "@/api/domains/notification";
import type { TelegramNotificationStatus } from "@/api/types/notification";
import { getPushPermission, subscribeToPush } from "../lib/pushNotification";
import { fadeUp } from "@/lib/motion";
import { EmButton } from "./dashboard/EmButton";
import { PageHeader } from "./dashboard/PageHeader";
import { ResultBanner } from "./dashboard/ResultBanner";
import { useDialogFocus } from "./inbox/useDialogFocus";

const ANIMATE = import.meta.env.MODE !== "test";

type PushPermission = NotificationPermission | "unsupported";

function StatusPill({ tone, children }: { tone: "ok" | "warn" | "muted"; children: ReactNode }) {
  const classes = {
    ok: "border-em-success-700/20 bg-em-success-100 text-em-success-700",
    warn: "border-em-sunlight-600/30 bg-em-sunlight-100 text-em-sunlight-700",
    muted: "border-em-border bg-em-bg-muted text-em-text-secondary",
  };
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold ${classes[tone]}`}>
      {children}
    </span>
  );
}

function Panel({
  icon: Icon,
  title,
  subtitle,
  children,
}: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-em-border bg-em-bg-surface">
      <div className="flex items-start gap-3 border-b border-em-border px-4 py-4">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-em-violet-100 text-em-violet-700">
          <Icon className="h-5 w-5" />
        </div>
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-em-text-primary">{title}</h2>
          <p className="mt-1 text-xs leading-5 text-em-text-secondary">{subtitle}</p>
        </div>
      </div>
      <div className="px-4 py-4">{children}</div>
    </section>
  );
}

export default function NotificationSettings() {
  const { t } = useTranslation();
  const [telegram, setTelegram] = useState<TelegramNotificationStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [telegramBusy, setTelegramBusy] = useState<string | null>(null);
  const [pushPermission, setPushPermission] = useState<PushPermission>(() => getPushPermission());
  const [browserBusy, setBrowserBusy] = useState(false);
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const disconnectRef = useRef<HTMLDivElement>(null);
  useDialogFocus(disconnectRef, disconnectOpen);

  const unreadableStatus = telegram?.status === "unhealthy";
  const statusTone = telegram?.connected ? "ok" : unreadableStatus || telegram?.status === "pending" ? "warn" : "muted";
  const statusLabel = telegram?.connected
    ? t("manageShop.notifications.telegram.connected")
    : telegram?.status === "pending"
      ? t("manageShop.notifications.telegram.pending")
      : telegram?.status === "unhealthy"
        ? t("manageShop.notifications.telegram.unhealthy")
        : t("manageShop.notifications.telegram.disconnected");

  const events = useMemo(() => telegram?.events || [], [telegram?.events]);

  const loadTelegram = async () => {
    setLoading(true);
    try {
      setTelegram(await getTelegramNotificationStatus());
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : t("manageShop.notifications.errors.load"));
      toast.error(error instanceof Error ? error.message : t("manageShop.notifications.errors.load"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadTelegram();
  }, []);

  const enableBrowserNotifications = async () => {
    setBrowserBusy(true);
    try {
      const ok = await subscribeToPush();
      setPushPermission(getPushPermission());
      if (ok) toast.success(t("manageShop.notifications.browser.enabled"));
      else toast.error(t("manageShop.notifications.browser.failed"));
    } catch (error) {
      setPushPermission(getPushPermission());
      toast.error(error instanceof Error ? error.message : t("manageShop.notifications.browser.failed"));
    } finally {
      setBrowserBusy(false);
    }
  };

  const createIntent = async () => {
    setTelegramBusy("connect");
    try {
      setTelegram(await createTelegramConnectIntent());
      toast.success(t("manageShop.notifications.telegram.intentCreated"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("manageShop.notifications.telegram.intentFailed"));
    } finally {
      setTelegramBusy(null);
    }
  };

  const copyCommand = async () => {
    if (!telegram?.pendingCommand) return;
    await navigator.clipboard?.writeText(telegram.pendingCommand);
    toast.success(t("manageShop.notifications.telegram.copied"));
  };

  const refresh = async () => {
    setTelegramBusy("refresh");
    try {
      await loadTelegram();
    } finally {
      setTelegramBusy(null);
    }
  };

  const sendTest = async () => {
    setTelegramBusy("test");
    try {
      await sendTelegramTestAlert();
      toast.success(t("manageShop.notifications.telegram.testSent"));
      setTelegram(await getTelegramNotificationStatus());
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("manageShop.notifications.telegram.testFailed"));
    } finally {
      setTelegramBusy(null);
    }
  };

  const disconnect = async () => {
    setTelegramBusy("disconnect");
    try {
      const nextStatus = await disconnectTelegramAlerts();
      setTelegram(nextStatus || await getTelegramNotificationStatus());
      toast.success(t("manageShop.notifications.telegram.disconnectedToast"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("manageShop.notifications.telegram.disconnectFailed"));
    } finally {
      setTelegramBusy(null);
    }
  };

  const togglePreference = async (eventType: string, enabled: boolean) => {
    if (!telegram) return;
    const optimistic = {
      ...telegram,
      preferences: { ...telegram.preferences, [eventType]: enabled },
      events: telegram.events.map(event => event.eventType === eventType ? { ...event, enabled } : event),
    };
    setTelegram(optimistic);

    try {
      setTelegram(await updateTelegramPreferences(optimistic.preferences));
    } catch (error) {
      setTelegram(telegram);
      toast.error(error instanceof Error ? error.message : t("manageShop.notifications.telegram.preferenceFailed"));
    }
  };

  return (
    <MotionConfig reducedMotion="user">
      <div className="em-notifications min-h-full p-4 md:p-6">
        <div className="mx-auto w-full max-w-[1440px] space-y-6">
          {/* Slim title only (C1): the AppBar already shows "Notifications",
              and every status the old pills carried is repeated verbatim by
              the per-panel StatusPills below, which stay. */}
          <motion.div variants={fadeUp} initial={ANIMATE ? "hidden" : false} animate="visible">
            <PageHeader title={t("manageShop.notifications.title")} titleMode="srOnly" />
          </motion.div>

          <div className="grid gap-4 md:grid-cols-2">
            <motion.div variants={fadeUp} initial={ANIMATE ? "hidden" : false} animate="visible">
              <Panel
                icon={Smartphone}
                title={t("manageShop.notifications.browser.title")}
                subtitle={t("manageShop.notifications.browser.subtitle")}
              >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <StatusPill tone={pushPermission === "granted" ? "ok" : pushPermission === "denied" ? "warn" : "muted"}>
                    {pushPermission === "unsupported" ? t("manageShop.notifications.browser.unsupported") : pushPermission}
                  </StatusPill>
                  <EmButton
                    variant="primary"
                    onClick={enableBrowserNotifications}
                    disabled={browserBusy || pushPermission === "unsupported" || pushPermission === "granted"}
                    loading={browserBusy}
                    className="gap-2"
                  >
                    <Bell className="h-4 w-4" aria-hidden="true" />
                    {t("manageShop.notifications.browser.enable")}
                  </EmButton>
                </div>
              </Panel>
            </motion.div>

            <motion.div variants={fadeUp} initial={ANIMATE ? "hidden" : false} animate="visible">
              <Panel
                icon={Bell}
                title={t("manageShop.notifications.inApp.title")}
                subtitle={t("manageShop.notifications.inApp.subtitle")}
              >
                <div className="flex items-center gap-3 text-sm text-em-text-primary">
                  <CheckCircle2 className="h-5 w-5 text-em-success-700" aria-hidden="true" />
                  <span>{t("manageShop.notifications.inApp.active")}</span>
                </div>
              </Panel>
            </motion.div>
          </div>

          <motion.div variants={fadeUp} initial={ANIMATE ? "hidden" : false} animate="visible">
            <Panel
              icon={Send}
              title={t("manageShop.notifications.telegram.title")}
              subtitle={t("manageShop.notifications.telegram.subtitle")}
            >
              {loading ? (
                <div className="space-y-3" aria-label={t("common.loading")}>
                  {[0, 1, 2].map((row) => (
                    <div key={row} className="animate-pulse space-y-2 rounded-xl border border-em-border bg-em-bg-muted/60 p-3">
                      <div className="h-4 w-1/3 rounded bg-em-border" />
                      <div className="h-3 w-2/3 rounded bg-em-border" />
                    </div>
                  ))}
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusPill tone={statusTone}>{statusLabel}</StatusPill>
                      {telegram?.chatTitle && <span className="text-sm font-medium text-em-text-primary">{telegram.chatTitle}</span>}
                    </div>
                    <EmButton
                      variant="secondary"
                      onClick={refresh}
                      loading={telegramBusy === "refresh"}
                      className="gap-2"
                    >
                      <RefreshCw className={`h-4 w-4 ${telegramBusy === "refresh" ? "animate-spin" : ""}`} aria-hidden="true" />
                      {t("common.retry")}
                    </EmButton>
                  </div>

                  {loadError && (
                    <ResultBanner
                      status="error"
                      title={t("manageShop.notifications.errors.load")}
                      description={loadError}
                      nextAction={{ label: t("common.retry"), onClick: () => void refresh() }}
                    />
                  )}

                  {!telegram?.configured && (
                    <div className="flex gap-2 rounded-lg border border-em-sunlight-600/30 bg-em-sunlight-100 p-3 text-sm text-em-sunlight-700">
                      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                      <span>{t("manageShop.notifications.telegram.notConfigured")}</span>
                    </div>
                  )}

                  {!telegram?.connected && (
                    <div className="space-y-3 rounded-xl border border-em-border p-3">
                      <div className="text-sm font-semibold text-em-text-primary">
                        {t("manageShop.notifications.telegram.groupName", { name: telegram?.suggestedGroupName })}
                      </div>
                      <EmButton
                        variant="primary"
                        onClick={createIntent}
                        disabled={telegramBusy === "connect" || !telegram?.configured}
                        loading={telegramBusy === "connect"}
                        className="gap-2"
                      >
                        <Send className="h-4 w-4" aria-hidden="true" />
                        {t("manageShop.notifications.telegram.connect")}
                      </EmButton>

                      {telegram?.pendingCommand && (
                        <div className="space-y-3">
                          <ol className="list-decimal space-y-1 pl-5 text-sm text-em-text-secondary">
                            {(telegram.instructions || []).map((instruction) => (
                              <li key={instruction}>{instruction}</li>
                            ))}
                          </ol>
                          <div className="flex flex-col gap-2 sm:flex-row">
                            <code className="min-h-11 flex-1 overflow-x-auto rounded-lg bg-em-midnight-900 px-3 py-2 text-sm text-em-midnight-100">
                              {telegram.pendingCommand}
                            </code>
                            <EmButton variant="secondary" onClick={copyCommand} className="gap-2">
                              <Copy className="h-4 w-4" aria-hidden="true" />
                              {t("manageShop.notifications.telegram.copy")}
                            </EmButton>
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {telegram?.connected && (
                    <div className="flex flex-wrap gap-2">
                      <EmButton
                        variant="secondary"
                        onClick={sendTest}
                        disabled={telegramBusy === "test"}
                        loading={telegramBusy === "test"}
                        className="gap-2"
                      >
                        <Send className="h-4 w-4" aria-hidden="true" />
                        {t("manageShop.notifications.telegram.test")}
                      </EmButton>
                      <EmButton
                        variant="danger"
                        onClick={() => setDisconnectOpen(true)}
                        disabled={telegramBusy === "disconnect"}
                        className="gap-2"
                        data-testid="telegram-disconnect"
                      >
                        <Trash2 className="h-4 w-4" aria-hidden="true" />
                        {t("common.disconnect")}
                      </EmButton>
                    </div>
                  )}

                  {events.length > 0 && (
                    <div className="grid gap-2 sm:grid-cols-2">
                      {events.map((event) => (
                        <label
                          key={event.eventType}
                          className="flex min-h-12 items-center justify-between gap-3 rounded-lg border border-em-border px-3 py-2 text-sm"
                        >
                          <span className="min-w-0">
                            <span className="block font-medium text-em-text-primary">{event.label}</span>
                            <span className="block truncate text-xs text-em-text-secondary">{event.labelBn}</span>
                          </span>
                          <input
                            type="checkbox"
                            role="switch"
                            aria-checked={event.enabled}
                            className="h-5 w-5 rounded border-em-border-strong accent-em-violet-600"
                            checked={event.enabled}
                            disabled={!telegram}
                            onChange={(e) => togglePreference(event.eventType, e.target.checked)}
                          />
                        </label>
                      ))}
                    </div>
                  )}

                  {telegram?.lastError && (
                    <ResultBanner
                      status="error"
                      title={t("manageShop.notifications.telegram.unhealthy")}
                      description={telegram.lastError}
                    />
                  )}
                </div>
              )}
            </Panel>
          </motion.div>
        </div>

        {disconnectOpen && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-em-midnight-950/60 p-4"
            onClick={(event) => {
              if (event.target === event.currentTarget) setDisconnectOpen(false);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") setDisconnectOpen(false);
            }}
          >
            <div
              ref={disconnectRef}
              role="dialog"
              aria-modal="true"
              aria-labelledby="telegram-disconnect-title"
              className="w-full max-w-md rounded-xl bg-em-bg-surface p-5 shadow-xl md:p-6"
            >
              <h3 id="telegram-disconnect-title" className="text-lg font-semibold text-em-text-primary">
                {t("manageShop.notifications.telegram.disconnectConfirmTitle")}
              </h3>
              <p className="mt-2 text-sm text-em-text-secondary">
                {t("manageShop.notifications.telegram.disconnectConfirmBody")}
              </p>
              <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:justify-end">
                <EmButton variant="secondary" onClick={() => setDisconnectOpen(false)}>
                  {t("common.cancel")}
                </EmButton>
                <EmButton
                  variant="danger"
                  onClick={() => {
                    setDisconnectOpen(false);
                    void disconnect();
                  }}
                  loading={telegramBusy === "disconnect"}
                  data-testid="telegram-disconnect-confirm"
                >
                  {t("common.disconnect")}
                </EmButton>
              </div>
            </div>
          </div>
        )}
      </div>
    </MotionConfig>
  );
}
