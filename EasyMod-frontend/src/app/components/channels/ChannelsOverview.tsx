/**
 * ChannelsOverview — merchant-facing channel workspace (ADR-0013 §9,
 * PROPOSED_ARCHITECTURE §4; header-removal contract C1).
 *
 * Every connected Page is shown with its identity, health and effective
 * automation state. Effective mode and warnings come from the resolver-backed
 * list endpoint so the badge never invents a state. Shop-level status lives
 * per-card (record chips), not in a page header.
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { AlertTriangle, ArrowRight, Link2, Plus } from "lucide-react";
import { motion, MotionConfig } from "motion/react";
import { listMetaChannels, type MetaChannel } from "@/api/domains/meta-channels";
import type { ChannelAutomationWarning } from "@/api/types/conversation";
import { authService } from "@/app/lib/auth";
import { fadeUp } from "@/lib/motion";
import { EmButton } from "../dashboard/EmButton";
import { PageHeader } from "../dashboard/PageHeader";
import ChannelConnectionManager, {
  ChannelHealthGrid,
  FacebookIcon,
} from "./ChannelConnectionManager";
import EmergencyStopCard from "./EmergencyStopCard";
import BusinessDefaultsSummaryCard from "./BusinessDefaultsSummaryCard";
import { useChannelSettingsSSE } from "./useChannelSettingsSSE";
import { BADGE_LABEL_KEYS, MODE_LABEL_KEYS, deriveChannelBadge } from "./channelAutomation";

const ANIMATE = import.meta.env.MODE !== "test";

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-em-focus-light focus-visible:transition-none";

/**
 * The list endpoint carries warnings additively (API_CONTRACT §2). Until the
 * backend change lands the field may be absent, so read it defensively.
 */
type ListedChannel = MetaChannel & { warnings?: ChannelAutomationWarning[] };

/**
 * Read warnings from the list row. `warnings` is additive and lands with the
 * backend change in parallel; until it is present, a stored override that
 * resolves to the business default is reported as clamped (the only mode
 * override the current resolver would not honour). Detail remains the place
 * for the full warning set.
 */
function warningsFromList(channel: ListedChannel): ChannelAutomationWarning[] {
  if (Array.isArray(channel.warnings)) return channel.warnings;
  if ((channel.override_count ?? 0) > 0 && channel.mode_source === "business_default") {
    return ["override_clamped_by_business"];
  }
  return [];
}

export default function ChannelsOverview() {
  const { t } = useTranslation();
  const [showConnector, setShowConnector] = useState(false);
  const isOwner = authService.getCurrentShop()?.role?.toLowerCase() === "owner";
  useChannelSettingsSSE();

  const channelsQuery = useQuery({
    queryKey: ["channels"],
    queryFn: listMetaChannels,
  });

  const channels = ((channelsQuery.data ?? []) as ListedChannel[]).filter(
    (channel) => channel.platform === "facebook" && channel.status !== "DISCONNECTED",
  );

  return (
    <MotionConfig reducedMotion="user">
    <div className="em-channels min-h-full p-4 md:p-6">
      <div className="mx-auto w-full max-w-[1440px] space-y-6">
        <motion.div variants={fadeUp} initial={ANIMATE ? "hidden" : false} animate="visible">
          {/* Slim title only (C1): per-channel identity, health, overrides and
              stop state live on the cards below, never as a shop-level band. */}
          <PageHeader title={t("manageShop.channels.title")} />
        </motion.div>

        <BusinessDefaultsSummaryCard />

        {channelsQuery.isLoading && (
          <div className="grid gap-4 md:grid-cols-2" role="status">
            {[0, 1].map((i) => (
              <div
                key={i}
                className="animate-pulse rounded-xl border border-em-border bg-em-bg-surface p-5"
              >
                <div className="mb-3 flex items-center gap-3">
                  <div className="h-11 w-11 rounded-full bg-em-bg-muted" />
                  <div className="flex-1">
                    <div className="mb-2 h-4 w-32 rounded bg-em-bg-muted" />
                    <div className="h-3 w-20 rounded bg-em-bg-muted" />
                  </div>
                </div>
                <div className="h-3 w-full rounded bg-em-bg-muted" />
              </div>
            ))}
            <span className="sr-only">{t("manageShop.channels.loading")}</span>
          </div>
        )}

        {channelsQuery.isError && (
          <div role="alert" className="flex flex-wrap items-center gap-3 rounded-xl border border-em-danger-700/20 bg-em-danger-100 p-4 text-sm text-em-danger-700">
            <AlertTriangle className="h-5 w-5 shrink-0" aria-hidden="true" />
            <p className="flex-1">{t("manageShop.channels.loadError")}</p>
            <EmButton variant="secondary" onClick={() => void channelsQuery.refetch()}>
              {t("manageShop.channels.retry")}
            </EmButton>
          </div>
        )}

        {!channelsQuery.isLoading && !channelsQuery.isError && channels.length === 0 && (
          <div className="rounded-xl border border-dashed border-em-border-strong bg-em-bg-surface p-6 text-center">
            <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-em-violet-100">
              <Link2 className="h-6 w-6 text-em-violet-700" aria-hidden="true" />
            </div>
            <h2 className="text-base font-semibold text-em-text-primary">
              {t("manageShop.channels.empty.title")}
            </h2>
            <p className="mx-auto mt-1 max-w-md text-sm text-em-text-secondary">
              {t("manageShop.channels.empty.desc")}
            </p>
            {!showConnector && (
              <EmButton variant="primary" onClick={() => setShowConnector(true)} className="mt-4 gap-2">
                {t("manageShop.channels.empty.cta")}
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </EmButton>
            )}
          </div>
        )}

        {showConnector && (
          <div className="rounded-xl border border-em-border bg-em-bg-surface">
            <ChannelConnectionManager embedded />
          </div>
        )}

        {channels.length > 0 && (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {channels.map((channel) => {
              const warnings = warningsFromList(channel);
              const badge = deriveChannelBadge({
                emergencyStop: channel.emergency_stop,
                billingAiActive: channel.billing_ai_active,
                modeSource: channel.mode_source,
                warnings,
              });
              const effectiveMode = channel.effective_mode ?? "MANUAL";
              const tokenExpiryWarning =
                channel.tokenExpiresAt &&
                new Date(channel.tokenExpiresAt).getTime() - Date.now() < 14 * 86_400_000;

              return (
                <article
                  key={channel.id}
                  data-testid={`channel-card-${channel.id}`}
                  className="rounded-xl border border-em-border bg-em-bg-surface p-4 shadow-sm md:p-5"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-3">
                      <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-em-violet-100">
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
                          <h2 className="truncate text-sm font-semibold text-em-text-primary">
                            {channel.displayName}
                          </h2>
                          {channel.purposeLabel && (
                            <span className="rounded bg-em-bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-em-text-secondary">
                              {channel.purposeLabel}
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-em-text-secondary">
                          {t("manageShop.channels.connector.platform")}
                        </p>
                      </div>
                    </div>
                    <span
                      data-testid={`channel-badge-${channel.id}`}
                      className="shrink-0 rounded-full bg-em-violet-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-em-violet-700"
                    >
                      {t(BADGE_LABEL_KEYS[badge])}
                    </span>
                  </div>

                  <div className="mt-3 flex items-center gap-2 text-sm">
                    <span className="text-em-text-secondary">
                      {t("manageShop.channels.effectiveMode")}:
                    </span>
                    <span className="font-semibold text-em-text-primary">
                      {t(MODE_LABEL_KEYS[effectiveMode])}
                    </span>
                  </div>

                  <ChannelHealthGrid channel={channel} className="mt-3" />

                  {(tokenExpiryWarning ||
                    warnings.includes("override_clamped_by_business")) && (
                    <ul className="mt-3 space-y-1 text-xs text-em-warning-700">
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
                    </ul>
                  )}

                  <div className="mt-4 flex items-center justify-between">
                    <span className="em-tabular text-xs text-em-text-secondary">
                      {t("manageShop.channels.overrideCount", {
                        count: channel.override_count ?? 0,
                      })}
                    </span>
                    <Link
                      to={`/manage-shop/channels/${channel.id}`}
                      className={`inline-flex min-h-11 items-center gap-1 rounded-lg border border-em-border-strong px-3 py-1.5 text-xs font-semibold text-em-violet-700 hover:bg-em-violet-50 ${FOCUS_RING}`}
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

        {channels.length > 0 && !showConnector && !channelsQuery.isLoading && !channelsQuery.isError && (
          <div className="pt-1">
            <EmButton
              variant="secondary"
              data-testid="channels-add-another"
              onClick={() => setShowConnector(true)}
              className="gap-2"
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              {t("channels.connectCard.addAnother")}
            </EmButton>
          </div>
        )}

        {!isOwner && channels.length > 0 && (
          <p className="text-xs text-em-text-secondary">
            {t("manageShop.channels.detail.ownerOnly")}
          </p>
        )}

        {/* Emergency stop sits at the foot of the workspace (founder request):
            the channel work comes first. An active stop is still observable
            without scrolling to this card: every affected channel row carries
            its own "Stopped" badge from the resolver-backed list. */}
        <EmergencyStopCard />
      </div>
    </div>
    </MotionConfig>
  );
}
