/**
 * ChannelConnectionManager — the extracted ChatSettings connection surface
 * (ADR-0013 §9). Renders the Facebook OAuth connect flow, per-channel health
 * grid, purpose label, test/reconnect/disconnect actions and consent activity.
 *
 * Extracted with NO behaviour change; ChatSettings.tsx is now a thin consumer.
 * The hook `useMetaChannelConnection` owns all state and side effects.
 */
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
  Check,
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import * as Collapsible from "@radix-ui/react-collapsible";
import { useTranslation } from "react-i18next";
import type {
  MetaChannel,
  MetaConsentEventType,
} from "@/api/domains/meta-channels";
import { useMetaChannelConnection } from "./useMetaChannelConnection";

// Facebook-only launch — Instagram was removed from product scope (2026-06-24).
export const FB_BRAND = "#1877F2";

export function FacebookIcon({ color = FB_BRAND, size = 22 }: { color?: string; size?: number }) {
  return <MessageSquare style={{ color, width: size, height: size }} />;
}

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
      ? "bg-red-50 text-red-700"
      : "bg-green-50 text-green-700";

  // Only healthy channels block adding the same Page. Reconnect-required
  // channels remain selectable so OAuth can heal the existing row in place.
  const alreadyConnectedAssetIds = new Set(
    channels.filter((channel) => channel.isHealthy).map((channel) => channel.metaAssetId),
  );
  const reconnectRequiredAssetIds = new Set(
    channels.filter((channel) => channel.needsReconnect).map((channel) => channel.metaAssetId),
  );
  const selectedPageCount = availablePages.filter(
    (page) =>
      page.connectable === true &&
      selectedPageIds.has(page.id) &&
      !alreadyConnectedAssetIds.has(page.id),
  ).length;

  return (
    <div className="space-y-6 p-4 md:p-6">
      {!embedded && (
        <div className="flex items-center gap-3">
          <div className="p-3 bg-gradient-to-br from-blue-500 to-blue-600 rounded-lg">
            <MessageSquare className="w-6 h-6 text-white" />
          </div>
          <div>
            <h2 className="text-xl md:text-2xl font-bold text-gray-900">
              {t("channels.settings.title")}
            </h2>
            <p className="text-sm text-gray-500">{t("channels.settings.subtitle")}</p>
          </div>
        </div>
      )}

      {isLoading && (
        <div className="grid gap-4 md:grid-cols-2">
          {[0, 1].map((i) => (
            <div key={i} className="bg-white border border-gray-200 rounded-xl p-5 animate-pulse">
              <div className="flex items-center gap-3 mb-3">
                <div className="w-11 h-11 rounded-full bg-gray-200" />
                <div className="flex-1">
                  <div className="h-4 w-32 bg-gray-200 rounded mb-2" />
                  <div className="h-3 w-20 bg-gray-200 rounded" />
                </div>
              </div>
              <div className="h-3 w-full bg-gray-100 rounded mb-2" />
              <div className="h-9 w-full bg-gray-100 rounded" />
            </div>
          ))}
        </div>
      )}

      {loadError && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-center gap-3">
          <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0" />
          <p className="text-sm text-red-700 flex-1">{loadError}</p>
          <button
            onClick={fetchChannels}
            className="px-3 py-1.5 bg-red-600 text-white rounded-lg text-sm"
          >
            {t("common.retry")}
          </button>
        </div>
      )}

      {/* Connect flow (first-time + add another) */}
      {!isLoading && !loadError && activeOAuth && (
        <div className="rounded-xl border-2 border-blue-300 bg-blue-50 p-5 space-y-3">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-full bg-white border-2 border-blue-300 flex items-center justify-center">
              <MessageSquare className="w-3.5 h-3.5" style={{ color: FB_BRAND }} />
            </div>
            <h3 className="font-semibold text-gray-900">{t("channels.connectCard.title")}</h3>
          </div>

          {activeOAuth.step === "connecting" && (
            <div className="text-center py-4">
              <Loader2 className="w-7 h-7 animate-spin mx-auto mb-2 text-blue-600" />
              <p className="text-sm text-gray-700">{t("channels.connectCard.loginPopup")}</p>
              <button
                onClick={handleCancelOAuth}
                className="mt-2 text-xs text-gray-600 hover:text-gray-800 underline"
              >
                {t("common.cancel")}
              </button>
            </div>
          )}

          {activeOAuth.step === "page-select" && (
            <div>
              <p className="text-xs text-gray-700 mb-3">
                {t("channels.connectCard.selectPagesHint")}
              </p>
              {availablePages.length === 0 ? (
                <NoMetaAssetsFound onRetry={handleRetryOAuthAssetLookup} onCancel={handleCancelOAuth} />
              ) : (
                <div className="space-y-2 max-h-72 overflow-y-auto">
                  {availablePages.map((page) => {
                    const isAlreadyConnected = alreadyConnectedAssetIds.has(page.id);
                    const needsReconnect =
                      !isAlreadyConnected && reconnectRequiredAssetIds.has(page.id);
                    const isOutsideReconnectTarget =
                      Boolean(activeOAuth?.reconnectAssetId) &&
                      page.id !== activeOAuth?.reconnectAssetId;
                    const isConnectable = page.connectable === true;
                    const isDisabled =
                      isAlreadyConnected || !isConnectable || isOutsideReconnectTarget;
                    return (
                      <label
                        key={page.id}
                        className={`flex items-center gap-3 p-2.5 rounded-lg border-2 transition-colors ${
                          isAlreadyConnected || isOutsideReconnectTarget
                            ? "border-gray-200 bg-gray-100 cursor-not-allowed opacity-70"
                            : !isConnectable
                              ? "border-amber-200 bg-amber-50 cursor-not-allowed opacity-80"
                              : selectedPageIds.has(page.id)
                                ? "border-blue-500 bg-white cursor-pointer"
                                : "border-gray-200 bg-white hover:bg-gray-50 cursor-pointer"
                        }`}
                      >
                        <input
                          type="checkbox"
                          className="w-4 h-4 accent-blue-600"
                          checked={selectedPageIds.has(page.id)}
                          disabled={isDisabled}
                          aria-describedby={
                            !isConnectable ? `page-task-reason-${page.id}` : undefined
                          }
                          onChange={() => togglePageSelection(page.id)}
                        />
                        {page.pictureUrl ? (
                          <img
                            src={page.pictureUrl}
                            alt={page.name}
                            className="w-8 h-8 rounded-full object-cover"
                          />
                        ) : (
                          <div className="w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center">
                            <FacebookIcon size={14} />
                          </div>
                        )}
                        <div className="flex-1 min-w-0">
                          <p className="font-medium text-gray-900 text-sm truncate">{page.name}</p>
                          <p className="text-[10px] uppercase tracking-wide text-gray-500">
                            Facebook Page
                          </p>
                          {!isConnectable && (
                            <p
                              id={`page-task-reason-${page.id}`}
                              className="text-[10px] text-amber-700"
                            >
                              {t("channels.connectCard.pageTaskRequired")}
                            </p>
                          )}
                        </div>
                        {isAlreadyConnected && (
                          <span className="flex items-center gap-1 text-[10px] font-medium text-green-700 bg-green-50 px-1.5 py-0.5 rounded-full flex-shrink-0">
                            <Check className="w-3 h-3" />
                            {t("channels.health.connected")}
                          </span>
                        )}
                        {needsReconnect && (
                          <span className="flex items-center gap-1 text-[10px] font-medium text-amber-700 bg-amber-50 px-1.5 py-0.5 rounded-full flex-shrink-0">
                            <AlertCircle className="w-3 h-3" />
                            {t("channels.badge.reconnect")}
                          </span>
                        )}
                      </label>
                    );
                  })}
                </div>
              )}
              <div className="mt-3 flex gap-2">
                <button
                  onClick={handleCancelOAuth}
                  className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-xs text-gray-700 hover:bg-white"
                >
                  {t("common.cancel")}
                </button>
                <button
                  onClick={handleConnectPages}
                  disabled={selectedPageCount === 0 || isConnectingPage}
                  className="flex-1 px-3 py-2 bg-blue-600 text-white rounded-lg text-xs font-semibold disabled:opacity-50 flex items-center justify-center gap-1.5"
                >
                  {isConnectingPage && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  {t("channels.connectCard.connectCount", { count: selectedPageCount })}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {!isLoading && !loadError && !activeOAuth && (
        <div className="space-y-3">
          <button
            onClick={handleConnect}
            className="w-full rounded-xl border-2 border-blue-400 bg-gradient-to-r from-blue-50 to-blue-100 hover:from-blue-100 hover:to-blue-200 p-4 flex items-center justify-center gap-3 transition-colors"
          >
            <div className="w-7 h-7 rounded-full bg-white border-2 border-blue-300 flex items-center justify-center">
              <MessageSquare className="w-3.5 h-3.5" style={{ color: FB_BRAND }} />
            </div>
            <span className="font-semibold text-gray-900 text-sm">
              {channels.length === 0
                ? t("channels.connectCard.title")
                : t("channels.connectCard.addAnother")}
            </span>
          </button>

          <button
            onClick={() => setPermissionsExpanded((v) => !v)}
            className="w-full text-xs text-gray-500 hover:text-gray-700 flex items-center justify-center gap-1"
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
            <div className="rounded-lg bg-gray-50 border border-gray-200 p-3 text-xs text-gray-700">
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
              <p className="mt-2 text-gray-500 text-[11px]">{t("channels.permissions.note")}</p>
            </div>
          )}
        </div>
      )}

      {/* Connected channels */}
      {!isLoading && !loadError && channels.length > 0 && (
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
                className="bg-white border border-gray-200 rounded-xl shadow-sm transition-shadow p-5 hover:shadow-md"
              >
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-3">
                    <div className="w-11 h-11 rounded-full bg-blue-50 flex items-center justify-center">
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
                        <h4 className="font-semibold text-gray-900 truncate max-w-[180px]">
                          {channel.displayName}
                        </h4>
                        {channel.purposeLabel && (
                          <span className="px-1.5 py-0.5 bg-gray-100 text-gray-600 rounded text-[10px] font-medium uppercase tracking-wide">
                            {channel.purposeLabel}
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-gray-400">Facebook Messenger</p>
                    </div>
                  </div>
                  {isConnected && (
                    <span className="flex items-center gap-1 px-2.5 py-1 bg-green-100 text-green-700 rounded-full text-xs font-medium">
                      <div className="w-1.5 h-1.5 bg-green-500 rounded-full" />
                      {t("channels.statusActive")}
                    </span>
                  )}
                  {needsReconnect && !isErrored && (
                    <span className="flex items-center gap-1 px-2.5 py-1 bg-amber-100 text-amber-700 rounded-full text-xs font-medium">
                      <AlertCircle className="w-3 h-3" />
                      {t("channels.badge.reconnect")}
                    </span>
                  )}
                  {isErrored && isActionRequired && (
                    <span className="flex items-center gap-1 px-2.5 py-1 bg-amber-100 text-amber-800 rounded-full text-xs font-medium">
                      <AlertCircle className="w-3 h-3" />
                      {t("channels.badge.actionRequired", "Action Required")}
                    </span>
                  )}
                  {isErrored && !isActionRequired && (
                    <span className="flex items-center gap-1 px-2.5 py-1 bg-red-100 text-red-700 rounded-full text-xs font-medium">
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
                      <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-lg p-2.5 mb-4 text-xs text-amber-800">
                        <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                        <span>{label}</span>
                      </div>
                    );
                  })()}

                {!isConnected && needsReconnect && (
                  <button
                    onClick={() => handleReconnect(channel)}
                    style={{ backgroundColor: FB_BRAND }}
                    className="w-full py-2.5 text-white rounded-lg font-semibold text-sm flex items-center justify-center gap-2 hover:opacity-90 transition-opacity mb-3"
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
                        className="block text-[11px] font-medium text-gray-600 mb-1"
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
                        className="w-full px-2.5 py-1.5 border border-gray-200 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-400 disabled:opacity-60"
                      />
                    </div>

                    <ChannelHealthGrid channel={channel} className="mb-3" />

                    <div className="grid grid-cols-2 gap-2 mb-3">
                      <button
                        onClick={() => handleTestPipeline(channel.id)}
                        disabled={testingId === channel.id}
                        title={t("channels.actions.testTitle")}
                        className="flex items-center justify-center gap-1 px-2 py-1.5 border border-gray-300 text-gray-700 rounded-lg text-xs hover:bg-gray-50 disabled:opacity-60"
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
                        className="flex items-center justify-center gap-1 px-2 py-1.5 border border-gray-300 text-gray-700 rounded-lg text-xs hover:bg-gray-50"
                      >
                        <RefreshCw className="w-3.5 h-3.5" />
                        {t("channels.actions.refreshList", "Refresh list")}
                      </button>
                      <button
                        onClick={() => handleReconnect(channel)}
                        title={t("channels.actions.refreshPermissions")}
                        className="flex items-center justify-center gap-1 px-2 py-1.5 border border-blue-200 text-blue-700 rounded-lg text-xs hover:bg-blue-50"
                      >
                        <ShieldCheck className="w-3.5 h-3.5" />
                        {t("channels.actions.refreshPermissions", "Refresh permissions")}
                      </button>
                      <button
                        onClick={() => setConfirmDisconnect(channel)}
                        disabled={disconnectingId === channel.id}
                        className="flex items-center justify-center gap-1 px-2 py-1.5 border border-red-200 text-red-600 rounded-lg text-xs hover:bg-red-50 disabled:opacity-60"
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
                      className="pt-3 border-t border-gray-100"
                    >
                      <Collapsible.Trigger asChild>
                        <button className="w-full flex items-center justify-between text-xs text-gray-700 hover:text-gray-900">
                          <span className="flex items-center gap-1.5">
                            <ShieldCheck className="w-3.5 h-3.5 text-gray-500" />
                            <span className="font-medium">{t("channels.consent.activity")}</span>
                            {consentSummary && (
                              <span className="ml-1 text-gray-500">
                                {t("channels.consent.optInsCount", {
                                  count: consentSummary.counts.optIns,
                                })}
                              </span>
                            )}
                          </span>
                          {isConsentLoading ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin text-gray-400" />
                          ) : isConsentExpanded ? (
                            <ChevronUp className="w-3.5 h-3.5 text-gray-400" />
                          ) : (
                            <ChevronDown className="w-3.5 h-3.5 text-gray-400" />
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
                                  <div className="rounded bg-green-50 px-1.5 py-1.5">
                                    <p className="text-sm font-semibold text-green-700">
                                      {consentSummary.counts.optIns}
                                    </p>
                                    <p className="text-[9px] uppercase text-green-700/80">
                                      {t("channels.consent.optIns")}
                                    </p>
                                  </div>
                                  <div className="rounded bg-red-50 px-1.5 py-1.5">
                                    <p className="text-sm font-semibold text-red-700">
                                      {consentSummary.counts.optOuts}
                                    </p>
                                    <p className="text-[9px] uppercase text-red-700/80">
                                      {t("channels.consent.optOuts")}
                                    </p>
                                  </div>
                                  <div className="rounded bg-gray-100 px-1.5 py-1.5">
                                    <p className="text-sm font-semibold text-gray-600">
                                      {consentSummary.counts.deauthorized}
                                    </p>
                                    <p className="text-[9px] uppercase text-gray-500">
                                      {t("channels.consent.deauth")}
                                    </p>
                                  </div>
                                  <div className="rounded bg-gray-100 px-1.5 py-1.5">
                                    <p className="text-sm font-semibold text-gray-600">
                                      {consentSummary.counts.dataDeleted}
                                    </p>
                                    <p className="text-[9px] uppercase text-gray-500">
                                      {t("channels.consent.erased")}
                                    </p>
                                  </div>
                                </div>
                                {consentSummary.recentEvents.length === 0 ? (
                                  <p className="text-xs text-gray-400 italic">
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
                                        <span className="text-gray-500 truncate flex-1">
                                          {ev.source}
                                        </span>
                                        <span className="text-gray-400 flex-shrink-0">
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
        <div className="fixed inset-0 bg-gray-900/60 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg shadow-xl max-w-sm w-full p-6 space-y-4">
            <h3 className="font-semibold text-gray-900 text-lg">
              {t("channels.disconnectModal.title", { name: confirmDisconnect.displayName })}
            </h3>
            <p className="text-sm text-gray-600">{t("channels.disconnectModal.message")}</p>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setConfirmDisconnect(null)}
                className="px-4 py-2 text-sm text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
              >
                {t("common.cancel")}
              </button>
              <button
                onClick={() => handleDisconnect(confirmDisconnect)}
                className="px-4 py-2 text-sm text-white bg-red-600 rounded-lg hover:bg-red-700"
              >
                {t("channels.disconnectModal.confirm")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function NoMetaAssetsFound({
  onRetry,
  onCancel,
}: {
  onRetry: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-3 text-left">
      <div className="flex items-start gap-2">
        <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-700" />
        <div className="min-w-0">
          <p className="text-sm font-semibold text-amber-900">{t("channels.noPages.title")}</p>
          <p className="mt-1 text-xs text-amber-800">{t("channels.noPages.desc")}</p>
        </div>
      </div>

      <ol className="mt-3 list-decimal space-y-1 pl-5 text-xs text-amber-900">
        <li>{t("channels.noPages.step1")}</li>
        <li>{t("channels.noPages.step2")}</li>
        <li>{t("channels.noPages.step3")}</li>
        <li>{t("channels.noPages.step4")}</li>
      </ol>

      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        <a
          href="https://business.facebook.com/settings"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex flex-1 items-center justify-center rounded-lg border border-amber-300 bg-white px-3 py-2 text-xs font-semibold text-amber-900 hover:bg-amber-100"
        >
          {t("channels.noPages.openSettings")}
        </a>
        <button
          type="button"
          onClick={onRetry}
          className="flex-1 rounded-lg bg-amber-700 px-3 py-2 text-xs font-semibold text-white hover:bg-amber-800"
        >
          {t("channels.noPages.tryAgain")}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="flex-1 rounded-lg border border-amber-300 px-3 py-2 text-xs font-semibold text-amber-900 hover:bg-amber-100"
        >
          {t("common.cancel")}
        </button>
      </div>
    </div>
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
  const tone = neutral ? "text-gray-500" : ok ? "text-green-700" : "text-amber-700";
  return (
    <div className="flex items-center justify-between rounded bg-gray-50 px-2 py-1">
      <span className="text-gray-500">{label}</span>
      <span className={`font-medium ${tone}`}>{ok ? okText : badText}</span>
    </div>
  );
}