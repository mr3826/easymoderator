/**
 * ChannelsOverview — merchant-facing channel workspace (ADR-0013 §9,
 * PROPOSED_ARCHITECTURE §4).
 *
 * Every connected Page is shown with its identity, health and effective
 * automation state. Effective mode/warnings come from the resolver-backed
 * settings endpoint so the badge never invents a state.
 */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { AlertTriangle, ArrowRight, Link2 } from "lucide-react";
import { getMetaChannelSettings, listMetaChannels } from "@/api/domains/meta-channels";
import { authService } from "@/app/lib/auth";
import ChannelConnectionManager, {
  ChannelHealthGrid,
  FacebookIcon,
} from "./ChannelConnectionManager";
import EmergencyStopCard from "./EmergencyStopCard";
import BusinessDefaultsSummaryCard from "./BusinessDefaultsSummaryCard";
import { useChannelSettingsSSE } from "./useChannelSettingsSSE";
import {
  BADGE_LABEL_KEYS,
  MODE_LABEL_KEYS,
  deriveChannelBadge,
  hoursLookMalformed,
} from "./channelAutomation";

export default function ChannelsOverview() {
  const { t } = useTranslation();
  const [showConnector, setShowConnector] = useState(false);
  const isOwner = authService.getCurrentShop()?.role?.toLowerCase() === "owner";
  useChannelSettingsSSE();

  const channelsQuery = useQuery({
    queryKey: ["channels"],
    queryFn: listMetaChannels,
  });

  const channels = (channelsQuery.data ?? []).filter(
    (channel) => channel.platform === "facebook" && channel.status !== "DISCONNECTED",
  );

  // The list endpoint carries effective mode, stop and billing. Warnings
  // (clamped override / malformed hours) live on the per-channel settings
  // payload; fetch them batched through react-query's shared cache.
  const settingsQueries = useQueries({
    queries: channels.map((channel) => ({
      queryKey: ["channel-settings", channel.id],
      queryFn: () => getMetaChannelSettings(channel.id),
      staleTime: 30_000,
    })),
  });

  const warningsByChannel = useMemo(() => {
    const map: Record<string, string[]> = {};
    channels.forEach((channel, index) => {
      const settings = settingsQueries[index]?.data;
      map[channel.id] = settings?.warnings ?? [];
    });
    return map;
  }, [channels, settingsQueries]);

  return (
    <div className="ca-scope min-h-full bg-[var(--ca-surface-muted)] p-4 md:p-8">
      <div className="mx-auto max-w-5xl space-y-5">
        <header className="space-y-1">
          <h1 className="text-xl font-bold text-[var(--ca-ink)] md:text-2xl">
            {t("manageShop.channels.title")}
          </h1>
          <p className="text-sm text-[var(--ca-ink-muted)]">{t("manageShop.channels.subtitle")}</p>
        </header>

        <EmergencyStopCard />
        <BusinessDefaultsSummaryCard />

        {channelsQuery.isLoading && (
          <div className="grid gap-4 md:grid-cols-2" role="status">
            {[0, 1].map((i) => (
              <div
                key={i}
                className="animate-pulse rounded-xl border border-[var(--ca-border)] bg-white p-5"
              >
                <div className="mb-3 flex items-center gap-3">
                  <div className="h-11 w-11 rounded-full bg-[var(--ca-surface-sunken)]" />
                  <div className="flex-1">
                    <div className="mb-2 h-4 w-32 rounded bg-[var(--ca-surface-sunken)]" />
                    <div className="h-3 w-20 rounded bg-[var(--ca-surface-sunken)]" />
                  </div>
                </div>
                <div className="h-3 w-full rounded bg-[var(--ca-surface-muted)]" />
              </div>
            ))}
            <span className="sr-only">{t("manageShop.channels.loading")}</span>
          </div>
        )}

        {channelsQuery.isError && (
          <div className="flex items-center gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
            <AlertTriangle className="h-5 w-5 shrink-0" aria-hidden="true" />
            <p className="flex-1">{t("manageShop.channels.loadError")}</p>
            <button
              type="button"
              onClick={() => void channelsQuery.refetch()}
              className="shrink-0 rounded-lg bg-red-600 px-3 py-1.5 text-white"
            >
              {t("manageShop.channels.retry")}
            </button>
          </div>
        )}

        {!channelsQuery.isLoading && !channelsQuery.isError && channels.length === 0 && (
          <div className="rounded-xl border border-dashed border-[var(--ca-border)] bg-white p-6 text-center">
            <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-[var(--ca-violet-soft)]">
              <Link2 className="h-6 w-6 text-[var(--ca-violet-deep)]" aria-hidden="true" />
            </div>
            <h2 className="text-base font-semibold text-[var(--ca-ink)]">
              {t("manageShop.channels.empty.title")}
            </h2>
            <p className="mx-auto mt-1 max-w-md text-sm text-[var(--ca-ink-muted)]">
              {t("manageShop.channels.empty.desc")}
            </p>
            {!showConnector && (
              <button
                type="button"
                onClick={() => setShowConnector(true)}
                className="mt-4 inline-flex min-h-10 items-center gap-2 rounded-lg bg-[var(--ca-violet)] px-4 py-2 text-sm font-semibold text-white hover:bg-[var(--ca-violet-deep)]"
              >
                {t("manageShop.channels.empty.cta")}
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </button>
            )}
          </div>
        )}

        {showConnector && (
          <div className="rounded-xl border border-[var(--ca-border)] bg-white">
            <ChannelConnectionManager embedded />
          </div>
        )}

        {channels.length > 0 && (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {channels.map((channel, index) => {
              const settings = settingsQueries[index]?.data;
              const warnings = warningsByChannel[channel.id] ?? [];
              const badge = deriveChannelBadge({
                emergencyStop: settings?.emergency_stop ?? channel.emergency_stop,
                billingAiActive:
                  settings?.billing_ai_active ?? channel.billing_ai_active,
                modeSource: settings?.mode_source ?? channel.mode_source,
                warnings,
              });
              const effectiveMode =
                settings?.effective?.automation_mode ??
                channel.effective_mode ??
                "MANUAL";
              const tokenExpiryWarning =
                channel.tokenExpiresAt &&
                new Date(channel.tokenExpiresAt).getTime() - Date.now() < 14 * 86_400_000;

              return (
                <article
                  key={channel.id}
                  data-testid={`channel-card-${channel.id}`}
                  className="rounded-xl border border-[var(--ca-border)] bg-white p-4 shadow-sm md:p-5"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-3">
                      <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[var(--ca-violet-soft)]">
                        {channel.pictureUrl ? (
                          <img
                            src={channel.pictureUrl}
                            alt={channel.displayName}
                            className="h-11 w-11 rounded-full object-cover"
                          />
                        ) : (
                          <FacebookIcon />
                        )}
                      </div>
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <h2 className="truncate text-sm font-semibold text-[var(--ca-ink)]">
                            {channel.displayName}
                          </h2>
                          {channel.purposeLabel && (
                            <span className="rounded bg-[var(--ca-surface-sunken)] px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[var(--ca-ink-muted)]">
                              {channel.purposeLabel}
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-[var(--ca-ink-soft)]">
                          {t("manageShop.channels.connector.platform")}
                        </p>
                      </div>
                    </div>
                    <span
                      data-testid={`channel-badge-${channel.id}`}
                      className="shrink-0 rounded-full bg-[var(--ca-violet-soft)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--ca-violet-deep)]"
                    >
                      {t(BADGE_LABEL_KEYS[badge])}
                    </span>
                  </div>

                  <div className="mt-3 flex items-center gap-2 text-sm">
                    <span className="text-[var(--ca-ink-muted)]">
                      {t("manageShop.channels.effectiveMode")}:
                    </span>
                    <span className="font-semibold text-[var(--ca-ink)]">
                      {t(MODE_LABEL_KEYS[effectiveMode])}
                    </span>
                  </div>

                  <ChannelHealthGrid channel={channel} className="mt-3" />

                  {(tokenExpiryWarning ||
                    warnings.includes("override_clamped_by_business") ||
                    hoursLookMalformed(settings?.businessHours)) && (
                    <ul className="mt-3 space-y-1 text-xs text-amber-700">
                      {tokenExpiryWarning && (
                        <li className="flex items-start gap-1.5">
                          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                          {t("manageShop.channels.warnings.tokenExpiry")}
                        </li>
                      )}
                      {warnings.includes("override_clamped_by_business") && (
                        <li className="flex items-start gap-1.5">
                          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                          {t("manageShop.channels.warnings.clamped")}
                        </li>
                      )}
                      {hoursLookMalformed(settings?.businessHours) && (
                        <li className="flex items-start gap-1.5">
                          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                          {t("manageShop.channels.warnings.malformedHours")}
                        </li>
                      )}
                    </ul>
                  )}

                  <div className="mt-4 flex items-center justify-between">
                    <span className="text-xs text-[var(--ca-ink-soft)]">
                      {t("manageShop.channels.overrideCount", {
                        count: settings
                          ? Object.keys(settings.overrides ?? {}).length
                          : channel.override_count ?? 0,
                      })}
                    </span>
                    <Link
                      to={`/manage-shop/channels/${channel.id}`}
                      className="inline-flex min-h-9 items-center gap-1 rounded-lg border border-[var(--ca-border)] px-3 py-1.5 text-xs font-semibold text-[var(--ca-violet-deep)] hover:bg-[var(--ca-violet-soft)]"
                    >
                      {t("manageShop.channels.manage")}
                      <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                    </Link>
                  </div>
                </article>
              );
            })}
          </div>
        )}

        {!isOwner && channels.length > 0 && (
          <p className="text-xs text-[var(--ca-ink-soft)]">
            {t("manageShop.channels.detail.ownerOnly")}
          </p>
        )}
      </div>
    </div>
  );
}