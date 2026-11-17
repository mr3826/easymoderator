/**
 * ChannelOAuthFlowCard — the shared Facebook OAuth connect / reconnect surface
 * (ADR-0013 §9). Extracted from ChannelConnectionManager so the overview
 * connector and the per-channel detail "Refresh permissions" flow render the
 * ONE picker implementation (defect 3): the detail page previously borrowed the
 * hook's actions without the page-select UI, so a reconnect logged in and then
 * did nothing.
 *
 * Presentational only — all state and side effects live in
 * `useMetaChannelConnection`; callers pass the hook fields through.
 */
import { MessageSquare, AlertCircle, Loader2, Check } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { MetaChannel, MetaOAuthAsset } from "@/api/domains/meta-channels";
import type { ActiveOAuth } from "./useMetaChannelConnection";

// Facebook-only launch — Instagram was removed from product scope (2026-06-24).
export const FB_BRAND = "#1877F2";

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-em-focus-light focus-visible:transition-none";

export function FacebookIcon({ color = FB_BRAND, size = 22 }: { color?: string; size?: number }) {
  return <MessageSquare style={{ color, width: size, height: size }} />;
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
    <div className="rounded-lg border border-em-warning-600/30 bg-em-warning-100 px-3 py-3 text-left">
      <div className="flex items-start gap-2">
        <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-em-warning-700" />
        <div className="min-w-0">
          <p className="text-sm font-semibold text-em-warning-700">{t("channels.noPages.title")}</p>
          <p className="mt-1 text-xs text-em-warning-700">{t("channels.noPages.desc")}</p>
        </div>
      </div>

      <ol className="mt-3 list-decimal space-y-1 pl-5 text-xs text-em-warning-700">
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
          className={`inline-flex flex-1 min-h-11 items-center justify-center rounded-lg border border-em-warning-600/30 bg-em-bg-surface px-3 py-2 text-xs font-semibold text-em-warning-700 hover:bg-em-warning-100 ${FOCUS_RING}`}
        >
          {t("channels.noPages.openSettings")}
        </a>
        <button
          type="button"
          onClick={onRetry}
          className={`flex-1 min-h-11 rounded-lg bg-em-warning-700 px-3 py-2 text-xs font-semibold text-white hover:bg-em-warning-700/90 ${FOCUS_RING}`}
        >
          {t("channels.noPages.tryAgain")}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className={`flex-1 min-h-11 rounded-lg border border-em-warning-600/30 px-3 py-2 text-xs font-semibold text-em-warning-700 hover:bg-em-warning-100 ${FOCUS_RING}`}
        >
          {t("common.cancel")}
        </button>
      </div>
    </div>
  );
}

export interface ChannelOAuthFlowCardProps {
  activeOAuth: ActiveOAuth | null;
  availablePages: MetaOAuthAsset[];
  selectedPageIds: Set<string>;
  isConnectingPage: boolean;
  channels: MetaChannel[];
  onCancel: () => void;
  onRetryAssetLookup: () => void;
  onTogglePage: (pageId: string) => void;
  onConnectPages: () => Promise<void>;
}

export default function ChannelOAuthFlowCard({
  activeOAuth,
  availablePages,
  selectedPageIds,
  isConnectingPage,
  channels,
  onCancel,
  onRetryAssetLookup,
  onTogglePage,
  onConnectPages,
}: ChannelOAuthFlowCardProps) {
  const { t } = useTranslation();
  if (!activeOAuth) return null;

  // Only healthy channels block adding the SAME Page again. Reconnect-required
  // channels stay selectable so OAuth can heal the existing row in place, and —
  // founder decision — the reconnect TARGET stays selectable even when healthy
  // (re-consent refreshes the token / broadens grants). New connect
  // (`reconnectTargetId === null`) keeps the healthy-dedupe.
  const alreadyConnectedAssetIds = new Set(
    channels.filter((channel) => channel.isHealthy).map((channel) => channel.metaAssetId),
  );
  const reconnectRequiredAssetIds = new Set(
    channels.filter((channel) => channel.needsReconnect).map((channel) => channel.metaAssetId),
  );
  const reconnectTargetId = activeOAuth.reconnectAssetId ?? null;
  const selectedPageCount = availablePages.filter(
    (page) =>
      page.connectable === true &&
      selectedPageIds.has(page.id) &&
      (!alreadyConnectedAssetIds.has(page.id) || page.id === reconnectTargetId),
  ).length;

  const isReconnectMode = Boolean(activeOAuth.reconnectAssetId);

  return (
    <div className="rounded-xl border-2 border-em-violet-300 bg-em-violet-50 p-5 space-y-3">
      <div className="flex items-center gap-2">
        <div className="w-7 h-7 rounded-full bg-em-bg-surface border-2 border-em-violet-300 flex items-center justify-center">
          <MessageSquare className="w-3.5 h-3.5" style={{ color: FB_BRAND }} />
        </div>
        <h3 className="font-semibold text-em-text-primary">
          {isReconnectMode ? t("channels.reconnectPage") : t("channels.connectCard.title")}
        </h3>
      </div>

      {activeOAuth.step === "connecting" && (
        <div className="text-center py-4">
          <Loader2 className="w-7 h-7 animate-spin mx-auto mb-2 text-em-violet-600" />
          <p className="text-sm text-em-text-secondary">{t("channels.connectCard.loginPopup")}</p>
          <button
            onClick={onCancel}
            className={`mt-2 text-xs text-em-text-secondary hover:text-em-text-primary underline ${FOCUS_RING}`}
          >
            {t("common.cancel")}
          </button>
        </div>
      )}

      {activeOAuth.step === "page-select" && (
        <div>
          <p className="text-xs text-em-text-secondary mb-3">
            {isReconnectMode
              ? t("channels.connectCard.reconnectHint")
              : t("channels.connectCard.selectPagesHint")}
          </p>
          {availablePages.length === 0 ? (
            <NoMetaAssetsFound onRetry={onRetryAssetLookup} onCancel={onCancel} />
          ) : (
            <div className="space-y-2 max-h-72 overflow-y-auto">
              {availablePages.map((page) => {
                const isAlreadyConnected = alreadyConnectedAssetIds.has(page.id);
                const needsReconnect =
                  !isAlreadyConnected && reconnectRequiredAssetIds.has(page.id);
                const isOutsideReconnectTarget = isReconnectMode && page.id !== reconnectTargetId;
                const isConnectable = page.connectable === true;
                const isTargetReconnect = isAlreadyConnected && page.id === reconnectTargetId;
                const isDisabled =
                  (isAlreadyConnected && !isTargetReconnect) || !isConnectable || isOutsideReconnectTarget;
                return (
                  <label
                    key={page.id}
                    className={`flex items-center gap-3 p-2.5 rounded-lg border-2 transition-colors ${
                      isDisabled
                        ? !isConnectable
                          ? "border-em-warning-600/30 bg-em-warning-100 cursor-not-allowed opacity-80"
                          : "border-em-border bg-em-bg-muted cursor-not-allowed opacity-70"
                        : selectedPageIds.has(page.id)
                          ? "border-em-violet-600 bg-em-bg-surface cursor-pointer"
                          : "border-em-border bg-em-bg-surface hover:bg-em-bg-muted cursor-pointer"
                    }`}
                  >
                    <input
                      type="checkbox"
                      className="w-4 h-4 accent-em-violet-600"
                      checked={selectedPageIds.has(page.id)}
                      disabled={isDisabled}
                      aria-describedby={
                        !isConnectable ? `page-task-reason-${page.id}` : undefined
                      }
                      onChange={() => onTogglePage(page.id)}
                    />
                    {page.pictureUrl ? (
                      <img
                        src={page.pictureUrl}
                        alt={page.name}
                        className="w-8 h-8 rounded-full object-cover"
                      />
                    ) : (
                      <div className="w-8 h-8 rounded-full bg-em-violet-100 flex items-center justify-center">
                        <FacebookIcon size={14} />
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-em-text-primary text-sm truncate">{page.name}</p>
                      <p className="text-[10px] uppercase tracking-wide text-em-text-secondary">
                        Facebook Page
                      </p>
                      {!isConnectable && (
                        <p
                          id={`page-task-reason-${page.id}`}
                          className="text-[10px] text-em-warning-700"
                        >
                          {t("channels.connectCard.pageTaskRequired")}
                        </p>
                      )}
                    </div>
                    {isAlreadyConnected && (
                      <span className="flex items-center gap-1 text-[10px] font-medium text-em-success-700 bg-em-success-100 px-1.5 py-0.5 rounded-full flex-shrink-0">
                        <Check className="w-3 h-3" />
                        {t("channels.health.connected")}
                      </span>
                    )}
                    {needsReconnect && (
                      <span className="flex items-center gap-1 text-[10px] font-medium text-em-warning-700 bg-em-warning-100 px-1.5 py-0.5 rounded-full flex-shrink-0">
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
              onClick={onCancel}
              className={`flex-1 min-h-11 px-3 py-2 border border-em-border-strong rounded-lg text-xs text-em-text-primary hover:bg-em-bg-muted ${FOCUS_RING}`}
            >
              {t("common.cancel")}
            </button>
            <button
              onClick={onConnectPages}
              disabled={selectedPageCount === 0 || isConnectingPage}
              className={`flex-1 min-h-11 px-3 py-2 bg-em-violet-600 text-white rounded-lg text-xs font-semibold hover:bg-em-violet-700 disabled:opacity-50 flex items-center justify-center gap-1.5 ${FOCUS_RING}`}
            >
              {isConnectingPage && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              {t("channels.connectCard.connectCount", { count: selectedPageCount })}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
