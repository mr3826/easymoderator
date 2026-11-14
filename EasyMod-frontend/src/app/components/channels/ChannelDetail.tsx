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
import { AlertTriangle, ArrowLeft, CheckCircle2, Loader2, Unplug } from "lucide-react";
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
import { useMetaChannelConnection } from "./useMetaChannelConnection";
import {
  BADGE_LABEL_KEYS,
  DAYS,
  MODE_LABEL_KEYS,
  MODE_SOURCE_LABEL_KEYS,
  allowedOverrideModes,
  deriveChannelBadge,
  editableToHours,
  hoursLookMalformed,
  hoursToEditable,
  type DayKey,
  type EditableHours,
} from "./channelAutomation";
import { OverrideControl } from "./OverrideControl";
import { useChannelSettingsSSE } from "./useChannelSettingsSSE";

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
      <div className="ca-scope flex min-h-full items-center justify-center bg-[var(--ca-surface-muted)] p-8" role="status">
        <Loader2 className="h-6 w-6 animate-spin text-[var(--ca-violet-deep)]" aria-hidden="true" />
        <span className="ml-2 text-sm text-[var(--ca-ink-muted)]">
          {t("manageShop.channels.loadingDetail")}
        </span>
      </div>
    );
  }

  if (channelsQuery.isError || settingsQuery.isError || !channel || !settings) {
    return (
      <div className="ca-scope min-h-full bg-[var(--ca-surface-muted)] p-4 md:p-8">
        <div className="mx-auto max-w-3xl space-y-4">
          <Link
            to="/manage-shop/channels"
            className="inline-flex items-center gap-1.5 text-sm font-medium text-[var(--ca-violet-deep)] hover:underline"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            {t("manageShop.channels.detail.back")}
          </Link>
          <div className="flex items-center gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
            <AlertTriangle className="h-5 w-5 shrink-0" aria-hidden="true" />
            <p className="flex-1">{t("manageShop.channels.loadError")}</p>
            <button
              type="button"
              onClick={() => {
                void channelsQuery.refetch();
                void settingsQuery.refetch();
              }}
              className="shrink-0 rounded-lg bg-red-600 px-3 py-1.5 text-white"
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
    <div className="ca-scope min-h-full bg-[var(--ca-surface-muted)] p-4 md:p-8">
      <div className="mx-auto max-w-3xl space-y-5">
        <Link
          to="/manage-shop/channels"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-[var(--ca-violet-deep)] hover:underline"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          {t("manageShop.channels.detail.back")}
        </Link>

        <header className="rounded-xl border border-[var(--ca-border)] bg-white p-4 md:p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="truncate text-lg font-bold text-[var(--ca-ink)] md:text-xl">
                  {channel.displayName}
                </h1>
                {channel.purposeLabel && (
                  <span className="rounded bg-[var(--ca-surface-sunken)] px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[var(--ca-ink-muted)]">
                    {channel.purposeLabel}
                  </span>
                )}
                <span className="rounded-full bg-[var(--ca-violet-soft)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--ca-violet-deep)]">
                  {t(BADGE_LABEL_KEYS[badge])}
                </span>
              </div>
              <div className="mt-2 space-y-1">
                <p
                  data-testid="channel-effective-mode"
                  aria-live="polite"
                  className="text-sm text-[var(--ca-ink)]"
                >
                  {t("manageShop.channels.effectiveMode")}:{" "}
                  <span className="font-semibold">{t(MODE_LABEL_KEYS[effectiveMode])}</span>
                </p>
                <p data-testid="channel-mode-source" className="text-xs text-[var(--ca-ink-muted)]">
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
            <ul className="mt-3 space-y-1 text-xs text-amber-700">
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
            <p className="mt-3 rounded-lg border border-red-200 bg-red-50 p-2 text-xs text-red-800">
              {t("emergencyStop.activeDesc")}
            </p>
          )}
        </header>

        {!isOwner && (
          <p className="rounded-xl border border-[var(--ca-border)] bg-white p-3 text-xs text-[var(--ca-ink-muted)]">
            {t("manageShop.channels.detail.ownerOnly")}
          </p>
        )}

        <div role="tablist" aria-label={t("manageShop.channels.detail.tabsLabel")} className="flex gap-1 overflow-x-auto">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`shrink-0 rounded-lg px-3 py-2 text-xs font-semibold ${
                activeTab === tab.id
                  ? "bg-[var(--ca-violet)] text-white"
                  : "bg-white text-[var(--ca-ink-muted)] hover:bg-[var(--ca-violet-soft)]"
              }`}
            >
              {t(tab.labelKey)}
            </button>
          ))}
        </div>

        {saveError && (
          <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            {saveError}
          </p>
        )}

        {activeTab === "reply" && (
          <section className="space-y-3" aria-label={t("manageShop.channels.detail.tabs.reply")}>
            <OverrideControl
              ref={modeSectionRef}
              label={t("manageShop.channels.detail.modeLabel")}
              overridden={modeOverridden}
              canEdit={isOwner}
              effective={t(MODE_LABEL_KEYS[effectiveMode])}
              source={t(MODE_SOURCE_LABEL_KEYS[modeSource])}
              onStartOverride={() =>
                saveOverride({ automation_mode: effectiveMode })
              }
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
                    className="flex items-center gap-2 rounded-lg border border-[var(--ca-border)] px-2.5 py-1.5 text-sm text-[var(--ca-ink)]"
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
              <p className="text-xs text-[var(--ca-ink-soft)]">
                {t("manageShop.channels.detail.narrowOnly")}
              </p>
            </OverrideControl>
          </section>
        )}

        {activeTab === "ai" && (
          <section className="space-y-3" aria-label={t("manageShop.channels.detail.tabs.ai")}>
            <OverrideControl
              ref={confidenceSectionRef}
              label={t("manageShop.channels.detail.confidenceLabel")}
              overridden={confidenceOverridden}
              canEdit={isOwner}
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
                <label className="flex-1 text-xs text-[var(--ca-ink-muted)]">
                  {t("manageShop.channels.detail.confidenceLabel")}
                  <input
                    type="number"
                    min={0}
                    max={100}
                    value={confidenceDraft}
                    disabled={mutation.isPending}
                    onChange={(event) => setConfidenceDraft(event.target.value)}
                    className="mt-1 block w-full rounded-lg border border-[var(--ca-border)] px-2.5 py-1.5 text-sm"
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
                  className="rounded-lg bg-[var(--ca-violet)] px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-60"
                >
                  {t("manageShop.channels.detail.save")}
                </button>
              </div>
            </OverrideControl>

            <OverrideControl
              ref={greetingSectionRef}
              label={t("manageShop.channels.detail.greetingLabel")}
              overridden={greetingOverridden}
              canEdit={isOwner}
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
                <label className="flex items-center gap-2 text-sm text-[var(--ca-ink)]">
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
                  className="block w-full rounded-lg border border-[var(--ca-border)] px-2.5 py-1.5 text-sm"
                  placeholder={t("manageShop.channels.detail.greetingPlaceholder")}
                />
                <button
                  type="button"
                  disabled={mutation.isPending}
                  onClick={() => saveOverride({ greeting: { ...greetingDraft } })}
                  className="rounded-lg bg-[var(--ca-violet)] px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-60"
                >
                  {t("manageShop.channels.detail.save")}
                </button>
                <p className="text-[11px] text-[var(--ca-ink-soft)]">
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
          <section className="space-y-3" aria-label={t("manageShop.channels.detail.tabs.orders")}>
            <div className="rounded-xl border border-[var(--ca-border)] bg-white p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold text-[var(--ca-ink)]">
                    {t("manageShop.channels.detail.orderCreation")}
                  </h3>
                  <p className="mt-1 text-xs text-[var(--ca-ink-muted)]">
                    {t("manageShop.channels.detail.orderCreationDesc")}
                  </p>
                </div>
                <label className="flex shrink-0 items-center gap-2 text-xs text-[var(--ca-ink-muted)]">
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
                <p className="mt-2 text-xs text-[var(--ca-ink-soft)]">
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
            className="space-y-3 rounded-xl border border-[var(--ca-border)] bg-white p-4"
            aria-label={t("manageShop.channels.detail.tabs.rules")}
          >
            <div>
              <h3 className="text-sm font-semibold text-[var(--ca-ink)]">
                {t("manageShop.channels.detail.businessHours")}
              </h3>
              <p className="mt-1 text-xs text-[var(--ca-ink-muted)]">
                {t("manageShop.channels.detail.businessHoursDesc")}
              </p>
            </div>

            <label className="block text-xs text-[var(--ca-ink-muted)]">
              {t("manageShop.channels.detail.timezone")}
              <select
                value={hours.timezone}
                disabled={!isOwner || mutation.isPending}
                onChange={(event) =>
                  setHours((prev) => ({ ...prev, timezone: event.target.value }))
                }
                className="mt-1 block w-full rounded-lg border border-[var(--ca-border)] bg-white px-2.5 py-1.5 text-sm"
              >
                <option value="">{t("manageShop.channels.detail.timezoneDefault")}</option>
                {TIMEZONES.map((tz) => (
                  <option key={tz} value={tz}>
                    {tz}
                  </option>
                ))}
              </select>
            </label>

            <div className="space-y-1.5">
              {DAYS.map((day: DayKey) => {
                const slot = hours.days[day];
                return (
                  <div key={day} className="flex flex-wrap items-center gap-2 text-xs">
                    <label className="flex w-20 items-center gap-1.5 font-medium uppercase text-[var(--ca-ink-muted)]">
                      <input
                        type="checkbox"
                        checked={slot.enabled}
                        disabled={!isOwner || mutation.isPending}
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
                      {t(`manageShop.channels.days.${day}`)}
                    </label>
                    <input
                      type="time"
                      value={slot.open}
                      disabled={!slot.enabled || !isOwner || mutation.isPending}
                      onChange={(event) =>
                        setHours((prev) => ({
                          ...prev,
                          days: {
                            ...prev.days,
                            [day]: { ...prev.days[day], open: event.target.value },
                          },
                        }))
                      }
                      className="rounded border border-[var(--ca-border)] px-2 py-1"
                    />
                    <span className="text-[var(--ca-ink-soft)]">→</span>
                    <input
                      type="time"
                      value={slot.close}
                      disabled={!slot.enabled || !isOwner || mutation.isPending}
                      onChange={(event) =>
                        setHours((prev) => ({
                          ...prev,
                          days: {
                            ...prev.days,
                            [day]: { ...prev.days[day], close: event.target.value },
                          },
                        }))
                      }
                      className="rounded border border-[var(--ca-border)] px-2 py-1"
                    />
                  </div>
                );
              })}
            </div>

            <p className="text-[11px] text-amber-700">
              {t("manageShop.channels.detail.hoursFailClosed")}
            </p>

            {isOwner ? (
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  data-testid="channel-hours-save"
                  disabled={mutation.isPending}
                  onClick={() =>
                    mutation.mutate({ businessHours: editableToHours(hours.timezone, hours.days) })
                  }
                  className="rounded-lg bg-[var(--ca-violet)] px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-60"
                >
                  {t("manageShop.channels.detail.save")}
                </button>
                <button
                  type="button"
                  disabled={mutation.isPending}
                  onClick={() => mutation.mutate({ businessHours: null })}
                  className="rounded-lg border border-[var(--ca-border)] px-3 py-1.5 text-xs font-medium text-[var(--ca-ink)] disabled:opacity-60"
                >
                  {t("manageShop.channels.detail.alwaysActive")}
                </button>
              </div>
            ) : (
              <p className="text-xs text-[var(--ca-ink-soft)]">
                {t("manageShop.channels.detail.ownerOnly")}
              </p>
            )}
          </section>
        )}

        {activeTab === "advanced" && (
          <section className="space-y-3" aria-label={t("manageShop.channels.detail.tabs.advanced")}>
            <div className="rounded-xl border border-[var(--ca-border)] bg-white p-4">
              <label className="block text-xs font-medium text-[var(--ca-ink-muted)]">
                {t("manageShop.channels.detail.purposeLabel")}
                <div className="mt-1 flex gap-2">
                  <input
                    type="text"
                    maxLength={64}
                    value={purposeLabel}
                    disabled={savingLabel}
                    onChange={(event) => setPurposeLabel(event.target.value)}
                    className="min-w-0 flex-1 rounded-lg border border-[var(--ca-border)] px-2.5 py-1.5 text-sm"
                  />
                  <button
                    type="button"
                    disabled={savingLabel}
                    onClick={() => void handlePurposeLabelSave()}
                    className="rounded-lg bg-[var(--ca-violet)] px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-60"
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

            <div className="rounded-xl border border-[var(--ca-border)] bg-white p-4">
              <h3 className="text-sm font-semibold text-[var(--ca-ink)]">
                {t("manageShop.channels.detail.connection")}
              </h3>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void connection.handleTestPipeline(channel.id)}
                  disabled={connection.testingId === channel.id}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--ca-border)] px-3 py-1.5 text-xs font-medium text-[var(--ca-ink)] disabled:opacity-60"
                >
                  {connection.testingId === channel.id && (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                  )}
                  {t("channels.actions.test")}
                </button>
                <button
                  type="button"
                  onClick={() => void connection.handleReconnect(channel)}
                  className="rounded-lg border border-[var(--ca-border)] px-3 py-1.5 text-xs font-medium text-[var(--ca-ink)]"
                >
                  {t("channels.actions.refreshPermissions")}
                </button>
                <button
                  type="button"
                  data-testid="channel-disconnect-button"
                  onClick={() => connection.setConfirmDisconnect(channel)}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 px-3 py-1.5 text-xs font-medium text-red-600"
                >
                  <Unplug className="h-3.5 w-3.5" aria-hidden="true" />
                  {t("channels.actions.disconnect")}
                </button>
              </div>
            </div>

            {Array.isArray(settings.deprecated_fields) && settings.deprecated_fields.length > 0 && (
              <div className="rounded-xl border border-[var(--ca-border)] bg-[var(--ca-surface-muted)] p-4 text-xs text-[var(--ca-ink-muted)]">
                <p className="font-semibold text-[var(--ca-ink)]">
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
            role="dialog"
            aria-modal="true"
            className="fixed inset-0 z-50 flex items-center justify-center bg-gray-900/60 p-4"
          >
            <div className="w-full max-w-sm space-y-4 rounded-lg bg-white p-6 shadow-xl">
              <h3 className="text-lg font-semibold text-gray-900">
                {t("channels.disconnectModal.title", {
                  name: connection.confirmDisconnect.displayName,
                })}
              </h3>
              <p className="text-sm text-gray-600">{t("channels.disconnectModal.message")}</p>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => connection.setConfirmDisconnect(null)}
                  className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm text-gray-700"
                >
                  {t("common.cancel")}
                </button>
                <button
                  type="button"
                  onClick={() => void connection.handleDisconnect(connection.confirmDisconnect!)}
                  className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white"
                >
                  {t("channels.disconnectModal.confirm")}
                </button>
              </div>
            </div>
          </div>
        )}

        {badge === "stopped" && (
          <p className="flex items-center gap-1.5 text-xs text-destructive">
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
    <div className="rounded-xl border border-[var(--ca-border)] bg-[var(--ca-surface-muted)] p-4">
      <dl className="space-y-1.5 text-sm">
        {rows.map((row) => (
          <div key={row.label} className="flex items-start justify-between gap-3">
            <dt className="text-[var(--ca-ink-muted)]">{row.label}</dt>
            <dd className="text-right font-medium text-[var(--ca-ink)]">{row.value}</dd>
          </div>
        ))}
      </dl>
      {note && <p className="mt-2 text-[11px] text-[var(--ca-ink-soft)]">{note}</p>}
      <Link
        to="/manage-shop/automation"
        className="mt-2 inline-block text-xs font-semibold text-[var(--ca-violet-deep)] hover:underline"
      >
        {t("manageShop.channels.detail.editAtBusiness")}
      </Link>
    </div>
  );
}