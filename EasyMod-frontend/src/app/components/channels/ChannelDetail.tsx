/**
 * ChannelDetail — per-Page operating configuration (ADR-0013 §9,
 * PROPOSED_ARCHITECTURE §4).
 *
 * Tabs: Reply behavior · AI behavior · Order handling · Operating rules ·
 * Advanced. Overrides are narrow-only: the UI only ever offers modes at or
 * below the business ceiling. Editing is OWNER-only (server requireOwner);
 * MANAGER/STAFF see a read-only view with an accurate reason.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { AlertTriangle, ArrowLeft, CheckCircle2, Loader2, Plus, Trash2, Unplug } from "lucide-react";
import { toast } from "sonner";
import {
  channelQueryKeys,
  getMetaChannelSettings,
  listMetaChannels,
  updateMetaChannelPurposeLabel,
  updateMetaChannelSettings,
  type ChannelAutomationGreeting,
  type ChannelAutomationOverridesPatch,
  type MetaChannelSettingsPatch,
} from "@/api/domains/meta-channels";
import { getShopAISettings } from "@/api/domains/shop";
import type { AiReplyMode } from "@/api/types/conversation";
import { authService } from "@/app/lib/auth";
import { getErrorMessage } from "@shared/lib/http/errors";
import { ChannelHealthGrid } from "./ChannelConnectionManager";
import ChannelOAuthFlowCard from "./ChannelOAuthFlowCard";
import { useMetaChannelConnection } from "./useMetaChannelConnection";
import {
  BADGE_LABEL_KEYS,
  DAYS,
  DEFAULT_HOUR_SLOT,
  MODE_LABEL_KEYS,
  MODE_SOURCE_LABEL_KEYS,
  allowedOverrideModes,
  deriveChannelBadge,
  editableHoursAreClosed,
  editableToHours,
  hoursLookMalformed,
  hoursToEditable,
  type DayKey,
  type EditableHours,
} from "./channelAutomation";
import { OverrideControl } from "./OverrideControl";
import { useChannelSettingsSSE } from "./useChannelSettingsSSE";
import { useDialogFocus } from "../inbox/useDialogFocus";

type TabId = "reply" | "ai" | "orders" | "rules" | "advanced";

const TABS: { id: TabId; labelKey: string }[] = [
  { id: "reply", labelKey: "manageShop.channels.detail.tabs.reply" },
  { id: "ai", labelKey: "manageShop.channels.detail.tabs.ai" },
  { id: "orders", labelKey: "manageShop.channels.detail.tabs.orders" },
  { id: "rules", labelKey: "manageShop.channels.detail.tabs.rules" },
  { id: "advanced", labelKey: "manageShop.channels.detail.tabs.advanced" },
];

const TIMEZONES = [
  "Asia/Dhaka",
  "Asia/Kolkata",
  "Asia/Karachi",
  "Asia/Dubai",
  "Asia/Bangkok",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Europe/London",
  "America/New_York",
  "UTC",
];

export default function ChannelDetail() {
  const { channelId } = useParams<{ channelId: string }>();
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const isOwner = authService.getCurrentShop()?.role?.toLowerCase() === "owner";
  useChannelSettingsSSE();
  const [activeTab, setActiveTab] = useState<TabId>("reply");
  const [saveError, setSaveError] = useState<string | null>(null);
  const modeSectionRef = useRef<HTMLDivElement | null>(null);
  const confidenceSectionRef = useRef<HTMLDivElement | null>(null);
  const greetingSectionRef = useRef<HTMLDivElement | null>(null);
  const disconnectDialogRef = useRef<HTMLDivElement | null>(null);

  const channelsQuery = useQuery({
    queryKey: channelQueryKeys.list(),
    queryFn: listMetaChannels,
  });
  const channel = (channelsQuery.data ?? []).find((row) => row.id === channelId) ?? null;

  const settingsQuery = useQuery({
    queryKey: channelQueryKeys.settings(channelId ?? ""),
    queryFn: () => getMetaChannelSettings(channelId as string),
    enabled: Boolean(channelId),
  });
  const settings = settingsQuery.data;

  const businessQuery = useQuery({
    queryKey: ["shop-ai-settings"],
    queryFn: getShopAISettings,
  });
  const business = businessQuery.data;

  const mutation = useMutation({
    mutationFn: (patch: MetaChannelSettingsPatch) =>
      updateMetaChannelSettings(channelId as string, patch),
    onSuccess: (data) => {
      queryClient.setQueryData(channelQueryKeys.settings(channelId ?? ""), data);
      void queryClient.invalidateQueries({ queryKey: channelQueryKeys.list() });
      setSaveError(null);
    },
    onError: (error) => {
      setSaveError(getErrorMessage(error, t("manageShop.channels.detail.saveError")));
    },
  });

  const [purposeLabel, setPurposeLabel] = useState("");
  const [savingLabel, setSavingLabel] = useState(false);
  const [confidenceDraft, setConfidenceDraft] = useState("80");
  const [greetingDraft, setGreetingDraft] = useState<ChannelAutomationGreeting>({
    enabled: false,
    custom_text: "",
  });
  const [hours, setHours] = useState<{ timezone: string; days: EditableHours }>(() =>
    hoursToEditable(null),
  );
  const [confirmingClosedHours, setConfirmingClosedHours] = useState(false);

  // Any edit to the schedule invalidates a pending "save anyway" confirmation.
  useEffect(() => {
    setConfirmingClosedHours(false);
  }, [hours]);

  useEffect(() => {
    if (!settings) return;
    setPurposeLabel(settings.purposeLabel ?? "");
    setConfidenceDraft(
      String(
        settings.overrides?.confidence_threshold ??
          settings.effective?.confidence_threshold ??
          80,
      ),
    );
    setGreetingDraft(
      settings.overrides?.greeting ??
        settings.effective?.greeting ?? { enabled: false, custom_text: "" },
    );
    setHours(hoursToEditable(settings.businessHours as never));
  }, [settings]);

  const connection = useMetaChannelConnection();
  useDialogFocus(disconnectDialogRef, Boolean(connection.confirmDisconnect));

  // "Refresh permissions" starts an OAuth round-trip whose completion UI lives
  // in the Advanced tab; switch there so the picker is never invisible (defect 3).
  useEffect(() => {
    if (connection.activeOAuth) setActiveTab("advanced");
  }, [connection.activeOAuth]);

  const effectiveMode: AiReplyMode = settings?.effective?.automation_mode ?? "MANUAL";
  const modeSource = settings?.mode_source ?? "fail_closed";
  const warnings = settings?.warnings ?? [];
  const ceilingMode: AiReplyMode | null = business?.automation_mode ?? null;
  const allowedModes = useMemo(() => allowedOverrideModes(ceilingMode), [ceilingMode]);
  const badge = deriveChannelBadge({
    emergencyStop: settings?.emergency_stop ?? channel?.emergency_stop,
    billingAiActive: settings?.billing_ai_active ?? channel?.billing_ai_active,
    modeSource,
    warnings,
  });

  const overrides = settings?.overrides ?? {};
  const modeOverridden = overrides.automation_mode !== undefined;
  const confidenceOverridden = overrides.confidence_threshold !== undefined;
  const greetingOverridden = overrides.greeting !== undefined;

  const emergencyStopActive =
    settings?.emergency_stop?.active === true || channel?.emergency_stop?.active === true;
  const forcedModeSource = modeSource === "emergency_stop" || modeSource === "shop_inactive";
  // A forced source (stop / inactive shop) must never seed a stored override:
  // the override would persist after the forced state ends. Existing overrides
  // stay editable/revertable; only starting a new one is blocked.
  const modeSeedBlocked = forcedModeSource && !modeOverridden;
  const hoursClosed = useMemo(() => editableHoursAreClosed(hours.days), [hours.days]);

  const saveHoursNow = () => {
    mutation.mutate(
      { businessHours: editableToHours(hours.timezone, hours.days) },
      { onSuccess: () => setConfirmingClosedHours(false) },
    );
  };

  const handleHoursSave = () => {
    if (hoursClosed) {
      setConfirmingClosedHours(true);
      return;
    }
    saveHoursNow();
  };

  const saveOverride = (override: ChannelAutomationOverridesPatch, onDone?: () => void) => {
    mutation.mutate(
      { overrides: override },
      {
        onSuccess: () => onDone?.(),
      },
    );
  };

  const handlePurposeLabelSave = async () => {
    if (!channel) return;
    try {
      setSavingLabel(true);
      await updateMetaChannelPurposeLabel(
        channel.id,
        purposeLabel.trim() ? purposeLabel.trim().slice(0, 64) : null,
      );
      void queryClient.invalidateQueries({ queryKey: channelQueryKeys.list() });
      toast.success(t("channels.label.updated", { label: purposeLabel.trim() }));
    } catch (error) {
      toast.error(getErrorMessage(error, t("channels.label.updateFailed")));
    } finally {
      setSavingLabel(false);
    }
  };

  if (!channelId) {
    return null;
  }

  if (channelsQuery.isLoading || settingsQuery.isLoading) {
    return (
      <div className="em-channels flex min-h-full items-center justify-center p-8" role="status">
        <Loader2 className="h-6 w-6 animate-spin text-em-violet-700" aria-hidden="true" />
        <span className="ml-2 text-sm text-em-text-secondary">
          {t("manageShop.channels.loadingDetail")}
        </span>
      </div>
    );
  }

  if (channelsQuery.isError || settingsQuery.isError || !channel || !settings) {
    return (
      <div className="em-channels min-h-full p-4 md:p-6">
        <div className="mx-auto max-w-3xl space-y-4">
          <Link
            to="/manage-shop/channels"
            className="inline-flex items-center gap-1.5 text-sm font-medium text-em-violet-700 hover:underline"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            {t("manageShop.channels.detail.back")}
          </Link>
          <div className="flex items-center gap-3 rounded-xl border border-em-danger-700/20 bg-em-danger-100 p-4 text-sm text-em-danger-700">
            <AlertTriangle className="h-5 w-5 shrink-0" aria-hidden="true" />
            <p className="flex-1">{t("manageShop.channels.loadError")}</p>
            <button
              type="button"
              onClick={() => {
                void channelsQuery.refetch();
                void settingsQuery.refetch();
              }}
              className="shrink-0 rounded-lg bg-em-danger-700 px-3 py-1.5 text-white"
            >
              {t("manageShop.channels.retry")}
            </button>
          </div>
        </div>
      </div>
    );
  }

  const orderedModes = allowedModes.includes(effectiveMode)
    ? allowedModes
    : [effectiveMode, ...allowedModes];

  return (
    <div className="em-channels min-h-full p-4 md:p-6">
      <div className="mx-auto max-w-3xl space-y-5">
        <Link
          to="/manage-shop/channels"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-em-violet-700 hover:underline"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          {t("manageShop.channels.detail.back")}
        </Link>

        <header className="rounded-xl border border-em-border bg-em-bg-surface p-4 md:p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="truncate text-lg font-bold text-em-text-primary md:text-xl">
                  {channel.displayName}
                </h1>
                {channel.purposeLabel && (
                  <span className="rounded bg-em-bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-em-text-secondary">
                    {channel.purposeLabel}
                  </span>
                )}
                <span className="rounded-full bg-em-violet-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-em-violet-700">
                  {t(BADGE_LABEL_KEYS[badge])}
                </span>
              </div>
              <div className="mt-2 space-y-1">
                <p
                  data-testid="channel-effective-mode"
                  aria-live="polite"
                  className="text-sm text-em-text-primary"
                >
                  {t("manageShop.channels.effectiveMode")}:{" "}
                  <span className="font-semibold">{t(MODE_LABEL_KEYS[effectiveMode])}</span>
                </p>
                <p data-testid="channel-mode-source" className="text-xs text-em-text-secondary">
                  {t("manageShop.channels.modeSource")}:{" "}
                  {t(MODE_SOURCE_LABEL_KEYS[modeSource])}
                </p>
              </div>
            </div>
            <ChannelHealthGrid channel={channel} />
          </div>

          {(warnings.includes("override_clamped_by_business") ||
            warnings.includes("invalid_override_value") ||
            hoursLookMalformed(settings.businessHours)) && (
            <ul className="mt-3 space-y-1 text-xs text-em-warning-700">
              {warnings.includes("override_clamped_by_business") && (
                <li className="flex items-start gap-1.5">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  {t("manageShop.channels.warnings.clamped")}
                </li>
              )}
              {warnings.includes("invalid_override_value") && (
                <li className="flex items-start gap-1.5">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  {t("manageShop.channels.warnings.invalidOverride")}
                </li>
              )}
              {hoursLookMalformed(settings.businessHours) && (
                <li className="flex items-start gap-1.5">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  {t("manageShop.channels.warnings.malformedHours")}
                </li>
              )}
            </ul>
          )}

          {settings.emergency_stop?.active && (
            <p className="mt-3 rounded-lg border border-em-danger-700/20 bg-em-danger-100 p-2 text-xs text-em-danger-700">
              {t("emergencyStop.activeDesc")}
            </p>
          )}
        </header>

        {!isOwner && (
          <p className="rounded-xl border border-em-border bg-em-bg-surface p-3 text-xs text-em-text-secondary">
            {t("manageShop.channels.detail.ownerOnly")}
          </p>
        )}

        {emergencyStopActive && (
          <p
            role="status"
            data-testid="channel-overrides-locked-by-stop"
            className="rounded-xl border border-em-danger-700/20 bg-em-danger-100 p-3 text-xs text-em-danger-700"
          >
            {t("manageShop.channels.detail.emergencyStopLocksOverrides")}
          </p>
        )}

        <div role="tablist" aria-label={t("manageShop.channels.detail.tabsLabel")} className="flex gap-1 overflow-x-auto">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              id={`channel-tab-${tab.id}`}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              aria-controls={`channel-panel-${tab.id}`}
              onClick={() => setActiveTab(tab.id)}
              className={`shrink-0 rounded-lg px-3 py-2 text-xs font-semibold ${
                activeTab === tab.id
                  ? "bg-em-violet-600 text-white"
                  : "bg-em-bg-surface text-em-text-secondary hover:bg-em-violet-50"
              }`}
            >
              {t(tab.labelKey)}
            </button>
          ))}
        </div>

        {saveError && (
          <p role="alert" className="rounded-lg border border-em-danger-700/20 bg-em-danger-100 p-3 text-sm text-em-danger-700">
            {saveError}
          </p>
        )}

        {activeTab === "reply" && (
          <section role="tabpanel" id="channel-panel-reply" aria-labelledby="channel-tab-reply" className="space-y-3" aria-label={t("manageShop.channels.detail.tabs.reply")}>
            <OverrideControl
              ref={modeSectionRef}
              label={t("manageShop.channels.detail.modeLabel")}
              overridden={modeOverridden}
              canEdit={isOwner && !emergencyStopActive && !modeSeedBlocked}
              readOnlyReason={
                isOwner && emergencyStopActive
                  ? t("manageShop.channels.detail.emergencyStopLocksOverrides")
                  : isOwner && modeSeedBlocked
                    ? t("manageShop.channels.detail.modeForcedNoSeed")
                    : undefined
              }
              effective={t(MODE_LABEL_KEYS[effectiveMode])}
              source={t(MODE_SOURCE_LABEL_KEYS[modeSource])}
              onStartOverride={() => {
                // Never persist a stop-forced effective mode as an override.
                if (forcedModeSource) return;
                saveOverride({ automation_mode: effectiveMode });
              }}
              onRevert={() =>
                saveOverride({ automation_mode: null }, () => modeSectionRef.current?.focus())
              }
              revertTestId="channel-override-revert-automation_mode"
              saving={mutation.isPending}
              error={saveError}
            >
              <div
                data-testid="channel-mode-override"
                role="radiogroup"
                aria-label={t("manageShop.channels.detail.modeLabel")}
                className="space-y-1.5"
              >
                {orderedModes.map((mode) => (
                  <label
                    key={mode}
                    className="flex items-center gap-2 rounded-lg border border-em-border px-2.5 py-1.5 text-sm text-em-text-primary"
                  >
                    <input
                      type="radio"
                      name="channel-mode-override"
                      value={mode}
                      checked={(overrides.automation_mode ?? effectiveMode) === mode}
                      disabled={mutation.isPending}
                      onChange={() => saveOverride({ automation_mode: mode })}
                    />
                    {t(MODE_LABEL_KEYS[mode])}
                  </label>
                ))}
              </div>
              <p className="text-xs text-em-text-secondary">
                {t("manageShop.channels.detail.narrowOnly")}
              </p>
            </OverrideControl>
          </section>
        )}

        {activeTab === "ai" && (
          <section role="tabpanel" id="channel-panel-ai" aria-labelledby="channel-tab-ai" className="space-y-3" aria-label={t("manageShop.channels.detail.tabs.ai")}>
            <OverrideControl
              ref={confidenceSectionRef}
              label={t("manageShop.channels.detail.confidenceLabel")}
              overridden={confidenceOverridden}
              canEdit={isOwner && !emergencyStopActive}
              readOnlyReason={
                isOwner && emergencyStopActive
                  ? t("manageShop.channels.detail.emergencyStopLocksOverrides")
                  : undefined
              }
              effective={`${settings.effective.confidence_threshold}%`}
              source={t(MODE_SOURCE_LABEL_KEYS[modeSource])}
              onStartOverride={() =>
                saveOverride({
                  confidence_threshold: settings.effective.confidence_threshold,
                })
              }
              onRevert={() =>
                saveOverride({ confidence_threshold: null }, () =>
                  confidenceSectionRef.current?.focus(),
                )
              }
              revertTestId="channel-override-revert-confidence_threshold"
              saving={mutation.isPending}
              error={saveError}
            >
              <div className="flex items-end gap-2">
                <label className="flex-1 text-xs text-em-text-secondary">
                  {t("manageShop.channels.detail.confidenceLabel")}
                  <input
                    type="number"
                    min={0}
                    max={100}
                    value={confidenceDraft}
                    disabled={mutation.isPending}
                    onChange={(event) => setConfidenceDraft(event.target.value)}
                    className="mt-1 block w-full rounded-lg border border-em-border px-2.5 py-1.5 text-sm"
                  />
                </label>
                <button
                  type="button"
                  disabled={mutation.isPending}
                  onClick={() => {
                    const value = Number(confidenceDraft);
                    if (!Number.isFinite(value) || value < 0 || value > 100) {
                      setSaveError(t("manageShop.channels.detail.invalidThreshold"));
                      return;
                    }
                    saveOverride({ confidence_threshold: value });
                  }}
                  className="rounded-lg bg-em-violet-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-60"
                >
                  {t("manageShop.channels.detail.save")}
                </button>
              </div>
            </OverrideControl>

            <OverrideControl
              ref={greetingSectionRef}
              label={t("manageShop.channels.detail.greetingLabel")}
              overridden={greetingOverridden}
              canEdit={isOwner && !emergencyStopActive}
              readOnlyReason={
                isOwner && emergencyStopActive
                  ? t("manageShop.channels.detail.emergencyStopLocksOverrides")
                  : undefined
              }
              effective={
                settings.effective.greeting?.enabled
                  ? settings.effective.greeting.custom_text ||
                    t("manageShop.channels.detail.enabled")
                  : t("manageShop.channels.detail.disabled")
              }
              source={t(MODE_SOURCE_LABEL_KEYS[modeSource])}
              onStartOverride={() =>
                saveOverride({ greeting: { ...settings.effective.greeting } })
              }
              onRevert={() =>
                saveOverride({ greeting: null }, () => greetingSectionRef.current?.focus())
              }
              revertTestId="channel-override-revert-greeting"
              saving={mutation.isPending}
              error={saveError}
            >
              <div className="space-y-2">
                <label className="flex items-center gap-2 text-sm text-em-text-primary">
                  <input
                    type="checkbox"
                    checked={greetingDraft.enabled}
                    disabled={mutation.isPending}
                    onChange={(event) =>
                      setGreetingDraft((prev) => ({ ...prev, enabled: event.target.checked }))
                    }
                  />
                  {t("manageShop.channels.detail.greetingEnabled")}
                </label>
                <textarea
                  maxLength={500}
                  rows={3}
                  value={greetingDraft.custom_text}
                  disabled={mutation.isPending}
                  onChange={(event) =>
                    setGreetingDraft((prev) => ({ ...prev, custom_text: event.target.value }))
                  }
                  className="block w-full rounded-lg border border-em-border px-2.5 py-1.5 text-sm"
                  placeholder={t("manageShop.channels.detail.greetingPlaceholder")}
                />
                <button
                  type="button"
                  disabled={mutation.isPending}
                  onClick={() => saveOverride({ greeting: { ...greetingDraft } })}
                  className="rounded-lg bg-em-violet-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-60"
                >
                  {t("manageShop.channels.detail.save")}
                </button>
                <p className="text-[11px] text-em-text-secondary">
                  {t("manageShop.channels.detail.greetingDisclosure")}
                </p>
              </div>
            </OverrideControl>

            <ReadOnlyBusinessRows
              rows={[
                {
                  label: t("manageShop.channels.detail.language"),
                  value: business?.primary_language || t("manageShop.channels.detail.unavailable"),
                },
                {
                  label: t("manageShop.channels.detail.closing"),
                  value: business?.closing?.enabled
                    ? business.closing.custom_text
                    : t("manageShop.channels.detail.disabled"),
                },
              ]}
            />
          </section>
        )}

        {activeTab === "orders" && (
          <section role="tabpanel" id="channel-panel-orders" aria-labelledby="channel-tab-orders" className="space-y-3" aria-label={t("manageShop.channels.detail.tabs.orders")}>
            <div className="rounded-xl border border-em-border bg-em-bg-surface p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold text-em-text-primary">
                    {t("manageShop.channels.detail.orderCreation")}
                  </h3>
                  <p className="mt-1 text-xs text-em-text-secondary">
                    {t("manageShop.channels.detail.orderCreationDesc")}
                  </p>
                </div>
                <label className="flex shrink-0 items-center gap-2 text-xs text-em-text-secondary">
                  <input
                    type="checkbox"
                    data-testid="channel-allow-order-creation"
                    checked={settings.allowOrderCreation !== false}
                    disabled={!isOwner || mutation.isPending}
                    onChange={(event) =>
                      mutation.mutate({ allowOrderCreation: event.target.checked })
                    }
                  />
                  {settings.allowOrderCreation !== false
                    ? t("manageShop.channels.detail.enabled")
                    : t("manageShop.channels.detail.disabled")}
                </label>
              </div>
              {!isOwner && (
                <p className="mt-2 text-xs text-em-text-secondary">
                  {t("manageShop.channels.detail.ownerOnly")}
                </p>
              )}
            </div>

            <ReadOnlyBusinessRows
              note={t("manageShop.channels.detail.deadSetting")}
              rows={[
                {
                  label: t("manageShop.channels.detail.maxAutoOrderValue"),
                  value:
                    business?.max_auto_order_value === undefined
                      ? t("manageShop.channels.detail.unavailable")
                      : String(business.max_auto_order_value),
                },
              ]}
            />
          </section>
        )}

        {activeTab === "rules" && (
          <section
            role="tabpanel"
            id="channel-panel-rules"
            aria-labelledby="channel-tab-rules"
            className="space-y-3 rounded-xl border border-em-border bg-em-bg-surface p-4"
            aria-label={t("manageShop.channels.detail.tabs.rules")}
          >
            <div>
              <h3 className="text-sm font-semibold text-em-text-primary">
                {t("manageShop.channels.detail.businessHours")}
              </h3>
              <p className="mt-1 text-xs text-em-text-secondary">
                {t("manageShop.channels.detail.businessHoursDesc")}
              </p>
            </div>

            <label className="block text-xs text-em-text-secondary">
              {t("manageShop.channels.detail.timezone")}
              <select
                value={hours.timezone}
                disabled={!isOwner || mutation.isPending}
                onChange={(event) =>
                  setHours((prev) => ({ ...prev, timezone: event.target.value }))
                }
                className="mt-1 block w-full rounded-lg border border-em-border bg-em-bg-surface px-2.5 py-1.5 text-sm"
              >
                <option value="">{t("manageShop.channels.detail.timezoneDefault")}</option>
                {TIMEZONES.map((tz) => (
                  <option key={tz} value={tz}>
                    {tz}
                  </option>
                ))}
              </select>
            </label>

            <div className="space-y-2">
              {DAYS.map((day: DayKey) => {
                const dayHours = hours.days[day];
                const dayLabel = t(`manageShop.channels.days.${day}`);
                const dayDisabled = !isOwner || mutation.isPending;
                return (
                  <div
                    key={day}
                    className="rounded-lg border border-em-border px-2.5 py-1.5 text-xs"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <label className="flex w-20 items-center gap-1.5 font-medium uppercase text-em-text-secondary">
                        <input
                          type="checkbox"
                          checked={dayHours.enabled}
                          disabled={dayDisabled}
                          onChange={(event) =>
                            setHours((prev) => ({
                              ...prev,
                              days: {
                                ...prev.days,
                                [day]: { ...prev.days[day], enabled: event.target.checked },
                              },
                            }))
                          }
                        />
                        {dayLabel}
                      </label>
                      <button
                        type="button"
                        aria-label={t("manageShop.channels.detail.addSlot", { day: dayLabel })}
                        disabled={dayDisabled}
                        onClick={() =>
                          setHours((prev) => ({
                            ...prev,
                            days: {
                              ...prev.days,
                              [day]: {
                                enabled: true,
                                slots: [...prev.days[day].slots, { ...DEFAULT_HOUR_SLOT }],
                              },
                            },
                          }))
                        }
                        className="inline-flex items-center rounded border border-em-border p-1 text-em-violet-700 disabled:opacity-50"
                      >
                        <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                    </div>
                    <div className="mt-1 space-y-1">
                      {dayHours.slots.map((slot, index) => (
                        <div key={index} className="flex flex-wrap items-center gap-2">
                          <input
                            type="time"
                            aria-label={t("manageShop.channels.detail.openTime", {
                              day: dayLabel,
                              index: index + 1,
                            })}
                            value={slot.open}
                            disabled={!dayHours.enabled || dayDisabled}
                            onChange={(event) =>
                              setHours((prev) => ({
                                ...prev,
                                days: {
                                  ...prev.days,
                                  [day]: {
                                    ...prev.days[day],
                                    slots: prev.days[day].slots.map((current, slotIndex) =>
                                      slotIndex === index
                                        ? { ...current, open: event.target.value }
                                        : current,
                                    ),
                                  },
                                },
                              }))
                            }
                            className="rounded border border-em-border px-2 py-1"
                          />
                          <span className="text-em-text-secondary" aria-hidden="true">
                            →
                          </span>
                          <input
                            type="time"
                            aria-label={t("manageShop.channels.detail.closeTime", {
                              day: dayLabel,
                              index: index + 1,
                            })}
                            value={slot.close}
                            disabled={!dayHours.enabled || dayDisabled}
                            onChange={(event) =>
                              setHours((prev) => ({
                                ...prev,
                                days: {
                                  ...prev.days,
                                  [day]: {
                                    ...prev.days[day],
                                    slots: prev.days[day].slots.map((current, slotIndex) =>
                                      slotIndex === index
                                        ? { ...current, close: event.target.value }
                                        : current,
                                    ),
                                  },
                                },
                              }))
                            }
                            className="rounded border border-em-border px-2 py-1"
                          />
                          <button
                            type="button"
                            aria-label={t("manageShop.channels.detail.removeSlot", {
                              day: dayLabel,
                              index: index + 1,
                            })}
                            disabled={dayHours.slots.length <= 1 || dayDisabled}
                            onClick={() =>
                              setHours((prev) => ({
                                ...prev,
                                days: {
                                  ...prev.days,
                                  [day]: {
                                    ...prev.days[day],
                                    slots: prev.days[day].slots.filter(
                                      (_current, slotIndex) => slotIndex !== index,
                                    ),
                                  },
                                },
                              }))
                            }
                            className="inline-flex items-center rounded border border-em-border p-1 text-em-danger-700 disabled:opacity-40"
                          >
                            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>

            <p className="text-[11px] text-em-warning-700">
              {t("manageShop.channels.detail.hoursFailClosed")}
            </p>

            {isOwner && hoursClosed && (
              <p
                role="alert"
                data-testid="channel-hours-closed-warning"
                className="rounded-lg border border-em-warning-600/30 bg-em-warning-100 p-2 text-[11px] font-medium text-em-warning-700"
              >
                {t("manageShop.channels.detail.hoursClosedWarning")}
              </p>
            )}

            {isOwner && hoursClosed && confirmingClosedHours && (
              <div
                role="alertdialog"
                aria-labelledby="channel-hours-closed-title"
                data-testid="channel-hours-closed-confirm"
                onKeyDown={(e) => {
                  if (e.key === "Escape") setConfirmingClosedHours(false);
                }}
                className="space-y-2 rounded-lg border border-em-danger-700/20 bg-em-danger-100 p-3 text-xs text-em-danger-700"
              >
                <p id="channel-hours-closed-title" className="font-semibold">
                  {t("manageShop.channels.detail.hoursClosedConfirmTitle")}
                </p>
                <p>{t("manageShop.channels.detail.hoursClosedConfirm")}</p>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => setConfirmingClosedHours(false)}
                    className="rounded-lg border border-em-border bg-em-bg-surface px-3 py-1.5 text-xs font-medium text-em-text-primary"
                  >
                    {t("common.cancel")}
                  </button>
                  <button
                    type="button"
                    data-testid="channel-hours-closed-confirm-save"
                    disabled={mutation.isPending}
                    onClick={saveHoursNow}
                    className="rounded-lg bg-em-danger-700 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-60"
                  >
                    {t("manageShop.channels.detail.hoursClosedSaveAnyway")}
                  </button>
                </div>
              </div>
            )}

            {isOwner ? (
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  data-testid="channel-hours-save"
                  disabled={mutation.isPending}
                  onClick={handleHoursSave}
                  className="rounded-lg bg-em-violet-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-60"
                >
                  {t("manageShop.channels.detail.save")}
                </button>
                <button
                  type="button"
                  disabled={mutation.isPending}
                  onClick={() => mutation.mutate({ businessHours: null })}
                  className="rounded-lg border border-em-border px-3 py-1.5 text-xs font-medium text-em-text-primary disabled:opacity-60"
                >
                  {t("manageShop.channels.detail.alwaysActive")}
                </button>
              </div>
            ) : (
              <p className="text-xs text-em-text-secondary">
                {t("manageShop.channels.detail.ownerOnly")}
              </p>
            )}
          </section>
        )}

        {activeTab === "advanced" && (
          <section role="tabpanel" id="channel-panel-advanced" aria-labelledby="channel-tab-advanced" className="space-y-3" aria-label={t("manageShop.channels.detail.tabs.advanced")}>
            <div className="rounded-xl border border-em-border bg-em-bg-surface p-4">
              <label className="block text-xs font-medium text-em-text-secondary">
                {t("manageShop.channels.detail.purposeLabel")}
                <div className="mt-1 flex gap-2">
                  <input
                    type="text"
                    maxLength={64}
                    value={purposeLabel}
                    disabled={savingLabel}
                    onChange={(event) => setPurposeLabel(event.target.value)}
                    className="min-w-0 flex-1 rounded-lg border border-em-border px-2.5 py-1.5 text-sm"
                  />
                  <button
                    type="button"
                    disabled={savingLabel}
                    onClick={() => void handlePurposeLabelSave()}
                    className="rounded-lg bg-em-violet-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-60"
                  >
                    {savingLabel ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                    ) : (
                      t("manageShop.channels.detail.save")
                    )}
                  </button>
                </div>
              </label>
            </div>

            <div className="rounded-xl border border-em-border bg-em-bg-surface p-4">
              <h3 className="text-sm font-semibold text-em-text-primary">
                {t("manageShop.channels.detail.connection")}
              </h3>
              <dl
                data-testid="channel-connection-diagnostics"
                className="mt-3 grid grid-cols-1 gap-2 rounded-lg border border-em-border bg-em-bg-muted p-3 text-xs sm:grid-cols-2"
              >
                <div>
                  <dt className="text-em-text-secondary">{t("manageShop.channels.detail.statusLabel")}</dt>
                  <dd className="mt-0.5 font-medium text-em-text-primary">
                    {channel.status}
                    {channel.needsReconnect && (
                      <span className="ml-2 rounded bg-em-warning-100 px-1.5 py-0.5 text-[11px] font-medium text-em-warning-700">
                        {t("manageShop.channels.detail.reconnectRequired")}
                      </span>
                    )}
                  </dd>
                </div>
                <div>
                  <dt className="text-em-text-secondary">{t("manageShop.channels.detail.permissionsLabel")}</dt>
                  <dd className="mt-0.5 font-mono text-[11px] text-em-text-primary">
                    {t("manageShop.channels.detail.permissionsScopes")}
                  </dd>
                </div>
                <div>
                  <dt className="text-em-text-secondary">{t("manageShop.channels.detail.webhookFieldsLabel")}</dt>
                  <dd className="mt-0.5 font-medium text-em-text-primary">
                    {channel.webhookSubscribedFields?.length
                      ? channel.webhookSubscribedFields.join(", ")
                      : t("channels.health.notVerified")}
                  </dd>
                </div>
                <div>
                  <dt className="text-em-text-secondary">{t("manageShop.channels.detail.webhookVerifiedLabel")}</dt>
                  <dd className="mt-0.5 text-em-text-primary">
                    {channel.webhookLastVerifiedAt
                      ? new Date(channel.webhookLastVerifiedAt).toLocaleString()
                      : t("channels.health.notVerified")}
                  </dd>
                </div>
                {channel.tokenExpiresAt && (
                  <div>
                    <dt className="text-em-text-secondary">{t("manageShop.channels.detail.tokenExpiryLabel")}</dt>
                    <dd className="mt-0.5 text-em-text-primary">
                      {new Date(channel.tokenExpiresAt).toLocaleDateString()}
                      {new Date(channel.tokenExpiresAt).getTime() - Date.now() < 7 * 24 * 60 * 60 * 1000 && (
                        <span className="ml-2 rounded bg-em-warning-100 px-1.5 py-0.5 text-[11px] font-medium text-em-warning-700">
                          {t("manageShop.channels.detail.tokenExpiringSoon")}
                        </span>
                      )}
                    </dd>
                  </div>
                )}
                {channel.lastError && (
                  <div className="sm:col-span-2">
                    <dt className="text-em-text-secondary">{t("manageShop.channels.detail.lastErrorLabel")}</dt>
                    <dd className="mt-0.5 text-em-danger-700">{channel.lastError}</dd>
                  </div>
                )}
              </dl>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void connection.handleTestPipeline(channel.id)}
                  disabled={connection.testingId === channel.id}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-em-border px-3 py-1.5 text-xs font-medium text-em-text-primary disabled:opacity-60"
                >
                  {connection.testingId === channel.id && (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                  )}
                  {t("channels.actions.test")}
                </button>
                <button
                  type="button"
                  onClick={() => void connection.handleReconnect(channel)}
                  className="rounded-lg border border-em-border px-3 py-1.5 text-xs font-medium text-em-text-primary"
                >
                  {t("channels.actions.refreshPermissions")}
                </button>
                <button
                  type="button"
                  data-testid="channel-disconnect-button"
                  onClick={() => connection.setConfirmDisconnect(channel)}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 px-3 py-1.5 text-xs font-medium text-em-danger-700"
                >
                  <Unplug className="h-3.5 w-3.5" aria-hidden="true" />
                  {t("channels.actions.disconnect")}
                </button>
              </div>

              {connection.activeOAuth && (
                <div className="mt-3">
                  <ChannelOAuthFlowCard
                    activeOAuth={connection.activeOAuth}
                    availablePages={connection.availablePages}
                    selectedPageIds={connection.selectedPageIds}
                    isConnectingPage={connection.isConnectingPage}
                    channels={connection.channels}
                    onCancel={connection.handleCancelOAuth}
                    onRetryAssetLookup={connection.handleRetryOAuthAssetLookup}
                    onTogglePage={connection.togglePageSelection}
                    onConnectPages={connection.handleConnectPages}
                  />
                </div>
              )}
            </div>

            {Array.isArray(settings.deprecated_fields) && settings.deprecated_fields.length > 0 && (
              <div className="rounded-xl border border-em-border bg-em-bg-muted p-4 text-xs text-em-text-secondary">
                <p className="font-semibold text-em-text-primary">
                  {t("manageShop.channels.detail.deprecatedTitle")}
                </p>
                <p className="mt-1">{t("manageShop.channels.detail.deprecatedDesc")}</p>
                <ul className="mt-1 list-disc pl-5">
                  {settings.deprecated_fields.map((field) => (
                    <li key={field}>
                      <code>{field}</code>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <ReadOnlyBusinessRows
              rows={[
                {
                  label: t("manageShop.channels.detail.handoff"),
                  value: t("manageShop.channels.detail.businessOnly"),
                },
                {
                  label: t("manageShop.channels.detail.escalation"),
                  value: t("manageShop.channels.detail.businessOnly"),
                },
              ]}
            />
          </section>
        )}

        {connection.confirmDisconnect && (
          <div
            ref={disconnectDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="channel-detail-disconnect-title"
            onKeyDown={(e) => {
              if (e.key === "Escape") connection.setConfirmDisconnect(null);
            }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-em-midnight-950/60 p-4"
          >
            <div className="w-full max-w-sm space-y-4 rounded-xl border border-em-border bg-em-bg-surface p-6 shadow-xl">
              <h3 id="channel-detail-disconnect-title" className="text-lg font-semibold text-em-text-primary">
                {t("channels.disconnectModal.title", {
                  name: connection.confirmDisconnect.displayName,
                })}
              </h3>
              <p className="text-sm text-em-text-secondary">{t("channels.disconnectModal.message")}</p>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => connection.setConfirmDisconnect(null)}
                  className="min-h-11 rounded-lg border border-em-border-strong bg-em-bg-surface px-4 py-2 text-sm text-em-text-primary hover:bg-em-bg-muted"
                >
                  {t("common.cancel")}
                </button>
                <button
                  type="button"
                  onClick={() => void connection.handleDisconnect(connection.confirmDisconnect!)}
                  className="min-h-11 rounded-lg bg-em-danger-700 px-4 py-2 text-sm font-semibold text-white hover:bg-em-danger-700/90"
                >
                  {t("channels.disconnectModal.confirm")}
                </button>
              </div>
            </div>
          </div>
        )}

        {badge === "stopped" && (
          <p className="flex items-center gap-1.5 text-xs text-em-danger-700">
            <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
            {t("emergencyStop.activeDesc")}
          </p>
        )}
      </div>
    </div>
  );
}

function ReadOnlyBusinessRows({
  rows,
  note,
}: {
  rows: { label: string; value: string }[];
  note?: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="rounded-xl border border-em-border bg-em-bg-muted p-4">
      <dl className="space-y-1.5 text-sm">
        {rows.map((row) => (
          <div key={row.label} className="flex items-start justify-between gap-3">
            <dt className="text-em-text-secondary">{row.label}</dt>
            <dd className="text-right font-medium text-em-text-primary">{row.value}</dd>
          </div>
        ))}
      </dl>
      {note && <p className="mt-2 text-[11px] text-em-text-secondary">{note}</p>}
      <Link
        to="/manage-shop/automation"
        className="mt-2 inline-block text-xs font-semibold text-em-violet-700 hover:underline"
      >
        {t("manageShop.channels.detail.editAtBusiness")}
      </Link>
    </div>
  );
}