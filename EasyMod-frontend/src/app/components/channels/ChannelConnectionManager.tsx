/**
 * ChannelConnectionManager — the extracted ChatSettings connection surface
 * (ADR-0013 §9). Renders the Facebook OAuth connect flow, per-channel health
 * grid, purpose label, test/reconnect/disconnect actions and consent activity.
 *
 * Extracted with NO behaviour change; ChatSettings.tsx is now a thin consumer.
 * The hook `useMetaChannelConnection` owns all state and side effects. Restyled
 * onto the em-* guardrails system; the disconnect confirm traps focus (§17/§18).
 */
import { useRef } from "react";
import {
  MessageSquare,
  AlertCircle,
  ChevronDown,
  ChevronUp,
  Loader2,
  Shield,
  FlaskConical,
  Unplug,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { motion, AnimatePresence, MotionConfig } from "motion/react";
import * as Collapsible from "@radix-ui/react-collapsible";
import { useTranslation } from "react-i18next";
import type {
  MetaChannel,
  MetaConsentEventType,
} from "@/api/domains/meta-channels";
import { useDialogFocus } from "../inbox/useDialogFocus";
import { useMetaChannelConnection } from "./useMetaChannelConnection";
import ChannelOAuthFlowCard, { FB_BRAND, FacebookIcon } from "./ChannelOAuthFlowCard";

// OAuth leaf components moved into ChannelOAuthFlowCard (shared with the detail
// page); re-exported here so existing import sites stay unchanged.
export { FB_BRAND, FacebookIcon, NoMetaAssetsFound } from "./ChannelOAuthFlowCard";

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-em-focus-light focus-visible:transition-none";

export default function ChannelConnectionManager({ embedded = false }: { embedded?: boolean } = {}) {
  const { t } = useTranslation();
  const connection = useMetaChannelConnection();
  const {
    channels,
    isLoading,
    loadError,
    fetchChannels,
    activeOAuth,
    availablePages,
    selectedPageIds,
    isConnectingPage,
    handleConnect,
    handleCancelOAuth,
    handleRetryOAuthAssetLookup,
    togglePageSelection,
    handleConnectPages,
    testingId,
    disconnectingId,
    confirmDisconnect,
    setConfirmDisconnect,
    handleTestPipeline,
    handleDisconnect,
    handleReconnect,
    consentByChannelId,
    expandedConsentChannelId,
    setExpandedConsentChannelId,
    loadingConsentId,
    handleToggleConsent,
    savingLabelId,
    handleSavePurposeLabel,
    permissionsExpanded,
    setPermissionsExpanded,
  } = connection;

  const disconnectDialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(disconnectDialogRef, Boolean(confirmDisconnect));

  const consentEventLabel = (event: MetaConsentEventType): string =>
    ({
      OPT_IN_IMPLICIT: t("channels.consent.events.optInImplicit"),
      OPT_IN_EXPLICIT: t("channels.consent.events.optInExplicit"),
      OPT_OUT: t("channels.consent.events.optOut"),
      DEAUTHORIZED: t("channels.consent.events.deauthorized"),
      DATA_DELETED: t("channels.consent.events.dataDeleted"),
    })[event] || event;

  const consentEventBadgeClass = (event: MetaConsentEventType): string =>
    event === "OPT_OUT" || event === "DEAUTHORIZED" || event === "DATA_DELETED"
      ? "bg-em-danger-100 text-em-danger-700"
      : "bg-em-success-100 text-em-success-700";

  return (
    <MotionConfig reducedMotion="user">
    <div className="em-channels space-y-6 p-4 md:p-6">
      {!embedded && (
        <div className="flex items-center gap-3">
          <div className="p-3 bg-em-violet-600 rounded-lg">
            <MessageSquare className="w-6 h-6 text-white" />
          </div>
          <div>
            <h2 className="text-xl md:text-2xl font-bold text-em-text-primary">
              {t("channels.settings.title")}
            </h2>
            <p className="text-sm text-em-text-secondary">{t("channels.settings.subtitle")}</p>
          </div>
        </div>
      )}

      {!embedded && isLoading && (
        <div className="grid gap-4 md:grid-cols-2">
          {[0, 1].map((i) => (
            <div key={i} className="bg-em-bg-surface border border-em-border rounded-xl p-5 animate-pulse">
              <div className="flex items-center gap-3 mb-3">
                <div className="w-11 h-11 rounded-full bg-em-bg-muted" />
                <div className="flex-1">
                  <div className="h-4 w-32 bg-em-bg-muted rounded mb-2" />
                  <div className="h-3 w-20 bg-em-bg-muted rounded" />
                </div>
              </div>
              <div className="h-3 w-full bg-em-bg-muted rounded mb-2" />
              <div className="h-9 w-full bg-em-bg-muted rounded" />
            </div>
          ))}
        </div>
      )}

      {!embedded && loadError && (
        <div role="alert" className="bg-em-danger-100 border border-em-danger-700/20 rounded-xl p-4 flex items-center gap-3">
          <AlertCircle className="w-5 h-5 text-em-danger-700 flex-shrink-0" />
          <p className="text-sm text-em-danger-700 flex-1">{loadError}</p>
          <button
            onClick={fetchChannels}
            className={`min-h-11 px-3 py-1.5 bg-em-danger-700 text-white rounded-lg text-sm ${FOCUS_RING}`}
          >
            {t("common.retry")}
          </button>
        </div>
      )}

      {/* Connect flow (first-time + add another) — shared with the detail page */}
      {!isLoading && !loadError && activeOAuth && (
        <ChannelOAuthFlowCard
          activeOAuth={activeOAuth}
          availablePages={availablePages}
          selectedPageIds={selectedPageIds}
          isConnectingPage={isConnectingPage}
          channels={channels}
          onCancel={handleCancelOAuth}
          onRetryAssetLookup={handleRetryOAuthAssetLookup}
          onTogglePage={togglePageSelection}
          onConnectPages={handleConnectPages}
        />
      )}

      {!isLoading && !loadError && !activeOAuth && (
        <div className="space-y-3">
          <button
            onClick={handleConnect}
            className={`w-full min-h-11 rounded-xl border-2 border-em-violet-300 bg-em-violet-50 hover:bg-em-violet-100 p-4 flex items-center justify-center gap-3 transition-colors ${FOCUS_RING}`}
          >
            <div className="w-7 h-7 rounded-full bg-em-bg-surface border-2 border-em-violet-300 flex items-center justify-center">
              <MessageSquare className="w-3.5 h-3.5" style={{ color: FB_BRAND }} />
            </div>
            <span className="font-semibold text-em-text-primary text-sm">
              {channels.length === 0
                ? t("channels.connectCard.title")
                : t("channels.connectCard.addAnother")}
            </span>
          </button>

          <button
            onClick={() => setPermissionsExpanded((v) => !v)}
            className={`w-full text-xs text-em-text-secondary hover:text-em-text-primary flex items-center justify-center gap-1 ${FOCUS_RING}`}
          >
            <Shield className="w-3.5 h-3.5" />
            {permissionsExpanded
              ? t("channels.permissions.hide")
              : t("channels.permissions.show")}
            {permissionsExpanded ? (
              <ChevronUp className="w-3 h-3" />
            ) : (
              <ChevronDown className="w-3 h-3" />
            )}
          </button>

          {permissionsExpanded && (
            <div className="rounded-lg bg-em-bg-muted border border-em-border p-3 text-xs text-em-text-secondary">
              <ul className="space-y-1 list-disc list-inside">
                <li>
                  <strong>pages_show_list</strong> — {t("channels.permissions.pagesShowList")}
                </li>
                <li>
                  <strong>pages_messaging</strong> — {t("channels.permissions.pagesMessaging")}
                </li>
                <li>
                  <strong>pages_manage_metadata</strong> —{" "}
                  {t("channels.permissions.pagesManageMetadata")}
                </li>
              </ul>
              <p className="mt-2 text-em-text-secondary text-[11px]">{t("channels.permissions.note")}</p>
            </div>
          )}
        </div>
      )}

      {/* Connected channels — standalone surface only. When embedded in the
          overview, the overview owns the channel grid; the embedded manager is
          connector-only so a Page never appears twice with separate controls. */}
      {!embedded && !isLoading && !loadError && channels.length > 0 && (
        <div className="grid gap-4 md:grid-cols-2">
          {channels.map((channel) => {
            const isConnected = channel.isHealthy;
            const needsReconnect = channel.needsReconnect;
            const isErrored = channel.status === "ERROR";
            const isActionRequired =
              channel.status === "ERROR" &&
              (channel.lastError === "webhook_subscription_unverified" ||
                channel.lastError === "webhook_subscription_failed");
            const isConsentExpanded = expandedConsentChannelId === channel.id;
            const consentSummary = consentByChannelId[channel.id];
            const isConsentLoading = loadingConsentId === channel.id;

            return (
              <div
                key={channel.id}
                className="bg-em-bg-surface border border-em-border rounded-xl shadow-sm transition-shadow p-5 hover:shadow-md"
              >
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-3">
                    <div className="w-11 h-11 rounded-full bg-em-violet-100 flex items-center justify-center">
                      {channel.pictureUrl ? (
                        <img
                          src={channel.pictureUrl}
                          alt={channel.displayName}
                          className="w-11 h-11 rounded-full object-cover"
                        />
                      ) : (
                        <FacebookIcon />
                      )}
                    </div>
                    <div>
                      <div className="flex items-center gap-1.5">
                        <h4 className="font-semibold text-em-text-primary truncate max-w-[180px]">
                          {channel.displayName}
                        </h4>
                        {channel.purposeLabel && (
                          <span className="px-1.5 py-0.5 bg-em-bg-muted text-em-text-secondary rounded text-[10px] font-medium uppercase tracking-wide">
                            {channel.purposeLabel}
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-em-text-secondary">Facebook Messenger</p>
                    </div>
                  </div>
                  {isConnected && (
                    <span className="flex items-center gap-1 px-2.5 py-1 bg-em-success-100 text-em-success-700 rounded-full text-xs font-medium">
                      <div className="w-1.5 h-1.5 bg-em-success-700 rounded-full" />
                      {t("channels.statusActive")}
                    </span>
                  )}
                  {needsReconnect && !isErrored && (
                    <span className="flex items-center gap-1 px-2.5 py-1 bg-em-warning-100 text-em-warning-700 rounded-full text-xs font-medium">
                      <AlertCircle className="w-3 h-3" />
                      {t("channels.badge.reconnect")}
                    </span>
                  )}
                  {isErrored && isActionRequired && (
                    <span className="flex items-center gap-1 px-2.5 py-1 bg-em-warning-100 text-em-warning-700 rounded-full text-xs font-medium">
                      <AlertCircle className="w-3 h-3" />
                      {t("channels.badge.actionRequired", "Action Required")}
                    </span>
                  )}
                  {isErrored && !isActionRequired && (
                    <span className="flex items-center gap-1 px-2.5 py-1 bg-em-danger-100 text-em-danger-700 rounded-full text-xs font-medium">
                      <AlertCircle className="w-3 h-3" />
                      {t("channels.badge.error", "Error")}
                    </span>
                  )}
                </div>

                {isConnected &&
                  channel.tokenExpiresAt &&
                  (() => {
                    const expiresMs = new Date(channel.tokenExpiresAt).getTime() - Date.now();
                    const dayMs = 86_400_000;
                    if (expiresMs > 14 * dayMs) return null;
                    const label =
                      expiresMs < 0
                        ? t("channels.tokenExpired")
                        : t("channels.tokenExpiresIn", { days: Math.ceil(expiresMs / dayMs) });
                    return (
                      <div className="flex items-start gap-2 bg-em-warning-100 border border-em-warning-600/30 rounded-lg p-2.5 mb-4 text-xs text-em-warning-700">
                        <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                        <span>{label}</span>
                      </div>
                    );
                  })()}

                {!isConnected && needsReconnect && (
                  <button
                    onClick={() => handleReconnect(channel)}
                    style={{ backgroundColor: FB_BRAND }}
                    className={`w-full min-h-11 py-2.5 text-white rounded-lg font-semibold text-sm flex items-center justify-center gap-2 hover:opacity-90 transition-opacity mb-3 ${FOCUS_RING}`}
                  >
                    <FacebookIcon color="white" size={18} />
                    {t("channels.reconnectPage")}
                  </button>
                )}

                {isConnected && (
                  <>
                    <div className="mb-3">
                      <label
                        htmlFor={`purpose-label-${channel.id}`}
                        className="block text-[11px] font-medium text-em-text-secondary mb-1"
                      >
                        {t("channels.label.fieldLabel")}
                      </label>
                      <input
                        id={`purpose-label-${channel.id}`}
                        type="text"
                        maxLength={64}
                        defaultValue={channel.purposeLabel ?? ""}
                        placeholder={t("channels.label.placeholder")}
                        disabled={savingLabelId === channel.id}
                        onBlur={(e) =>
                          handleSavePurposeLabel(channel.id, e.target.value, channel.purposeLabel)
                        }
                        onKeyDown={(e) => {
                          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                        }}
                        className={`w-full min-h-11 px-2.5 py-1.5 border border-em-border-strong rounded-lg text-xs bg-em-bg-surface text-em-text-primary focus:outline-none disabled:opacity-60 ${FOCUS_RING}`}
                      />
                    </div>

                    <ChannelHealthGrid channel={channel} className="mb-3" />

                    <div className="grid grid-cols-2 gap-2 mb-3">
                      <button
                        onClick={() => handleTestPipeline(channel.id)}
                        disabled={testingId === channel.id}
                        title={t("channels.actions.testTitle")}
                        className={`flex min-h-11 items-center justify-center gap-1 px-2 py-1.5 border border-em-border-strong text-em-text-primary rounded-lg text-xs hover:bg-em-bg-muted disabled:opacity-60 ${FOCUS_RING}`}
                      >
                        {testingId === channel.id ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <FlaskConical className="w-3.5 h-3.5" />
                        )}
                        {t("channels.actions.test", "Test")}
                      </button>
                      <button
                        onClick={fetchChannels}
                        title={t("channels.actions.refreshList")}
                        className={`flex min-h-11 items-center justify-center gap-1 px-2 py-1.5 border border-em-border-strong text-em-text-primary rounded-lg text-xs hover:bg-em-bg-muted ${FOCUS_RING}`}
                      >
                        <RefreshCw className="w-3.5 h-3.5" />
                        {t("channels.actions.refreshList", "Refresh list")}
                      </button>
                      <button
                        onClick={() => handleReconnect(channel)}
                        title={t("channels.actions.refreshPermissions")}
                        className={`flex min-h-11 items-center justify-center gap-1 px-2 py-1.5 border border-em-violet-300 text-em-violet-700 rounded-lg text-xs hover:bg-em-violet-50 ${FOCUS_RING}`}
                      >
                        <ShieldCheck className="w-3.5 h-3.5" />
                        {t("channels.actions.refreshPermissions", "Refresh permissions")}
                      </button>
                      <button
                        onClick={() => setConfirmDisconnect(channel)}
                        disabled={disconnectingId === channel.id}
                        className={`flex min-h-11 items-center justify-center gap-1 px-2 py-1.5 border border-em-danger-700/30 text-em-danger-700 rounded-lg text-xs hover:bg-em-danger-100 disabled:opacity-60 ${FOCUS_RING}`}
                      >
                        {disconnectingId === channel.id ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Unplug className="w-3.5 h-3.5" />
                        )}
                        {t("channels.actions.disconnect", "Disconnect")}
                      </button>
                    </div>

                    <Collapsible.Root
                      open={isConsentExpanded}
                      onOpenChange={(open) => {
                        if (open) handleToggleConsent(channel.id);
                        else setExpandedConsentChannelId(null);
                      }}
                      className="pt-3 border-t border-em-border"
                    >
                      <Collapsible.Trigger asChild>
                        <button className={`w-full flex items-center justify-between text-xs text-em-text-secondary hover:text-em-text-primary ${FOCUS_RING}`}>
                          <span className="flex items-center gap-1.5">
                            <ShieldCheck className="w-3.5 h-3.5 text-em-text-secondary" />
                            <span className="font-medium">{t("channels.consent.activity")}</span>
                            {consentSummary && (
                              <span className="ml-1 text-em-text-secondary">
                                {t("channels.consent.optInsCount", {
                                  count: consentSummary.counts.optIns,
                                })}
                              </span>
                            )}
                          </span>
                          {isConsentLoading ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin text-em-text-secondary" />
                          ) : isConsentExpanded ? (
                            <ChevronUp className="w-3.5 h-3.5 text-em-text-secondary" />
                          ) : (
                            <ChevronDown className="w-3.5 h-3.5 text-em-text-secondary" />
                          )}
                        </button>
                      </Collapsible.Trigger>
                      <Collapsible.Content>
                        <AnimatePresence>
                          {isConsentExpanded && consentSummary && (
                            <motion.div
                              initial={{ height: 0, opacity: 0 }}
                              animate={{ height: "auto", opacity: 1 }}
                              exit={{ height: 0, opacity: 0 }}
                              transition={{ duration: 0.2 }}
                              className="overflow-hidden"
                            >
                              <div className="mt-3 space-y-2">
                                <div className="grid grid-cols-4 gap-1.5 text-center">
                                  <div className="rounded bg-em-success-100 px-1.5 py-1.5">
                                    <p className="text-sm font-semibold text-em-success-700">
                                      {consentSummary.counts.optIns}
                                    </p>
                                    <p className="text-[9px] uppercase text-em-success-700/80">
                                      {t("channels.consent.optIns")}
                                    </p>
                                  </div>
                                  <div className="rounded bg-em-danger-100 px-1.5 py-1.5">
                                    <p className="text-sm font-semibold text-em-danger-700">
                                      {consentSummary.counts.optOuts}
                                    </p>
                                    <p className="text-[9px] uppercase text-em-danger-700/80">
                                      {t("channels.consent.optOuts")}
                                    </p>
                                  </div>
                                  <div className="rounded bg-em-bg-muted px-1.5 py-1.5">
                                    <p className="text-sm font-semibold text-em-text-secondary">
                                      {consentSummary.counts.deauthorized}
                                    </p>
                                    <p className="text-[9px] uppercase text-em-text-secondary">
                                      {t("channels.consent.deauth")}
                                    </p>
                                  </div>
                                  <div className="rounded bg-em-bg-muted px-1.5 py-1.5">
                                    <p className="text-sm font-semibold text-em-text-secondary">
                                      {consentSummary.counts.dataDeleted}
                                    </p>
                                    <p className="text-[9px] uppercase text-em-text-secondary">
                                      {t("channels.consent.erased")}
                                    </p>
                                  </div>
                                </div>
                                {consentSummary.recentEvents.length === 0 ? (
                                  <p className="text-xs text-em-text-secondary italic">
                                    {t("channels.consent.noEvents")}
                                  </p>
                                ) : (
                                  <ul className="space-y-1 max-h-40 overflow-y-auto">
                                    {consentSummary.recentEvents.map((ev) => (
                                      <li
                                        key={ev.id}
                                        className="flex items-center justify-between gap-1.5 text-xs"
                                      >
                                        <span
                                          className={`px-1.5 py-0.5 rounded-full text-[10px] font-medium ${consentEventBadgeClass(
                                            ev.event,
                                          )}`}
                                        >
                                          {consentEventLabel(ev.event)}
                                        </span>
                                        <span className="text-em-text-secondary truncate flex-1">
                                          {ev.source}
                                        </span>
                                        <span className="text-em-text-secondary flex-shrink-0">
                                          {new Date(ev.createdAt).toLocaleDateString()}
                                        </span>
                                      </li>
                                    ))}
                                  </ul>
                                )}
                              </div>
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </Collapsible.Content>
                    </Collapsible.Root>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}

      {confirmDisconnect && (
        <div
          ref={disconnectDialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="channel-disconnect-title"
          onKeyDown={(e) => {
            if (e.key === "Escape") setConfirmDisconnect(null);
          }}
          className="fixed inset-0 bg-em-midnight-950/60 flex items-center justify-center z-50 p-4"
        >
          <div className="bg-em-bg-surface border border-em-border rounded-xl shadow-xl max-w-sm w-full p-6 space-y-4">
            <h3 id="channel-disconnect-title" className="font-semibold text-em-text-primary text-lg">
              {t("channels.disconnectModal.title", { name: confirmDisconnect.displayName })}
            </h3>
            <p className="text-sm text-em-text-secondary">{t("channels.disconnectModal.message")}</p>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setConfirmDisconnect(null)}
                className={`min-h-11 px-4 py-2 text-sm text-em-text-primary bg-em-bg-surface border border-em-border-strong rounded-lg hover:bg-em-bg-muted ${FOCUS_RING}`}
              >
                {t("common.cancel")}
              </button>
              <button
                onClick={() => handleDisconnect(confirmDisconnect)}
                className={`min-h-11 px-4 py-2 text-sm text-white bg-em-danger-700 rounded-lg hover:bg-em-danger-700/90 ${FOCUS_RING}`}
              >
                {t("channels.disconnectModal.confirm")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
    </MotionConfig>
  );
}

/**
 * Compact 2x2 health grid shared by the connection manager, the channels
 * overview cards and the channel detail header. Pure presentation.
 */
export function ChannelHealthGrid({
  channel,
  className = "",
}: {
  channel: MetaChannel;
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <div className={`grid grid-cols-2 gap-1.5 text-[11px] ${className}`} data-testid="channel-health-grid">
      <HealthRow
        label={t("channels.health.connection", "Connection")}
        ok={channel.status === "CONNECTED"}
        okText={t("channels.health.connected", "Connected")}
        badText={channel.status}
      />
      <HealthRow
        label={t("channels.health.webhook", "Webhook")}
        ok={!!channel.webhookLastVerifiedAt}
        okText={t("channels.health.active", "Active")}
        badText={t("channels.health.notVerified", "Not verified")}
      />
      <HealthRow
        label={t("channels.health.token", "Token")}
        ok={
          !channel.tokenExpiresAt || new Date(channel.tokenExpiresAt).getTime() > Date.now()
        }
        okText={t("channels.health.valid", "Valid")}
        badText={t("channels.health.expired", "Expired")}
      />
      <HealthRow
        label={t("channels.health.lastWebhook", "Last webhook")}
        ok={!!channel.webhookLastVerifiedAt}
        okText={
          channel.webhookLastVerifiedAt
            ? new Date(channel.webhookLastVerifiedAt).toLocaleDateString()
            : "—"
        }
        badText={t("channels.health.noneYet", "None yet")}
        neutral
      />
    </div>
  );
}

function HealthRow({
  label,
  ok,
  okText,
  badText,
  neutral = false,
}: {
  label: string;
  ok: boolean;
  okText: string;
  badText: string;
  neutral?: boolean;
}) {
  const tone = neutral ? "text-em-text-secondary" : ok ? "text-em-success-700" : "text-em-warning-700";
  return (
    <div className="flex items-center justify-between rounded bg-em-bg-muted px-2 py-1">
      <span className="text-em-text-secondary">{label}</span>
      <span className={`font-medium ${tone}`}>{ok ? okText : badText}</span>
    </div>
  );
}
