import { useId, useState, useRef } from "react";
import { useTranslation } from 'react-i18next';
import { Plus, X, ChevronDown, ChevronUp } from "lucide-react";
import type { ShopAISettings } from "@/api/types/dashboard";
import { DEFAULT_AI_REPLY_MODE, normalizeAiReplyMode, type AiReplyMode } from "@/api/types/conversation";
import { queryClient } from "@/app/lib/queryClient";
import type { TelegramNotificationStatus } from "@/api/types/notification";
import { getErrorMessage } from "@shared/lib/http/errors";
import { RadioGroup, RadioGroupItem } from "./ui/radio-group";
import { EmButton } from "./dashboard/EmButton";

// Explicit focus-visible outline (guardrails §18). The .em-automation scope
// rule covers the real app; these utilities keep the ring in router-less and
// provider-less unit renders too, and stop transition-all animating it.
const FOCUS_RING =
  'focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-em-focus-light focus-visible:transition-none';

const FIELD_CLASS =
  `min-h-11 w-full rounded-lg border border-em-border bg-em-bg-surface px-3 py-2 text-sm text-em-text-primary ${FOCUS_RING}`;

type NormalizedShopAISettings = Omit<ShopAISettings, 'automation_mode'> & {
  automation_mode: AiReplyMode;
};

const defaultAISettings: NormalizedShopAISettings = {
  automation_mode: DEFAULT_AI_REPLY_MODE,
  confidence_threshold: 75,
  auto_reply_enabled: false,
  max_auto_order_value: 5000,
  ask_email: false,
  primary_language: "mixed",
  required_fields: {
    customer_name: true,
    mobile_number: true,
    delivery_address: true,
    payment_method: true,
    email_address: false,
    special_instructions: false,
  },
  handoff_settings: {
    trigger_keywords: ["complain", "problem", "issue"],
    notification_channel: "in_app",
    cooldown_minutes: 30,
  },
  greeting: { enabled: true, custom_text: "আসসালামু আলাইকুম! 👋 কীভাবে সাহায্য করতে পারি?" },
  closing: { enabled: true, custom_text: "আমাদের সাথে কেনাকাটা করার জন্য ধন্যবাদ! 🛍️" },
};

type HandoffNotificationChannel = 'in_app' | 'telegram';

const autoReplyForMode = (mode: AiReplyMode) => mode === 'AUTO';

const normalizeNotificationChannel = (channel?: string | null): HandoffNotificationChannel =>
  channel === 'telegram' ? 'telegram' : 'in_app';

const mergeAISettings = (loaded?: Partial<ShopAISettings> | null): NormalizedShopAISettings => {
  const merged = {
    ...defaultAISettings,
    ...loaded,
    required_fields: { ...defaultAISettings.required_fields, ...(loaded?.required_fields || {}) },
    handoff_settings: { ...defaultAISettings.handoff_settings, ...(loaded?.handoff_settings || {}) },
    greeting: { ...defaultAISettings.greeting!, ...(loaded?.greeting || {}) },
    closing: { ...defaultAISettings.closing!, ...(loaded?.closing || {}) },
  };
  const automationMode = normalizeAiReplyMode(merged.automation_mode);
  return {
    ...merged,
    automation_mode: automationMode,
    auto_reply_enabled: autoReplyForMode(automationMode),
    handoff_settings: {
      ...merged.handoff_settings,
      notification_channel: normalizeNotificationChannel(merged.handoff_settings.notification_channel),
    },
  };
};

interface TagInputProps {
  label: string;
  values: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
  hint?: string;
}

function TagInput({ label, values, onChange, placeholder, hint }: TagInputProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState("");
  const inputId = useId();

  const add = () => {
    const v = draft.trim();
    if (v && !values.includes(v)) onChange([...values, v]);
    setDraft("");
  };

  return (
    <div>
      <label htmlFor={inputId} className="mb-1 block text-sm font-medium text-em-text-primary">{label}</label>
      {hint && <p className="mb-2 text-xs text-em-text-secondary">{hint}</p>}
      <div className="mb-2 flex flex-wrap gap-2">
        {values.map((v) => (
          <span key={v} className="flex items-center gap-1 rounded-full bg-em-violet-100 px-2 py-1 text-xs text-em-violet-700">
            {v}
            <button
              type="button"
              onClick={() => onChange(values.filter((x) => x !== v))}
              aria-label={t('manageShop.aiSettings.removeKeyword', { value: v })}
              className={`inline-flex min-h-11 min-w-11 items-center justify-center rounded-full text-em-violet-700 hover:bg-em-violet-50 ${FOCUS_RING}`}
            >
              <X className="h-3 w-3" aria-hidden="true" />
            </button>
          </span>
        ))}
      </div>
      <div className="flex gap-2">
        <input
          id={inputId}
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
          placeholder={placeholder}
          className={`flex-1 ${FIELD_CLASS}`}
        />
        <button
          type="button"
          onClick={add}
          aria-label={t('manageShop.aiSettings.addKeyword')}
          className={`inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg bg-em-violet-600 text-white hover:bg-em-violet-700 ${FOCUS_RING}`}
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

interface AISettingsFormProps {
  initialData?: Partial<ShopAISettings> | null;
  onSave: (data: ShopAISettings) => Promise<ShopAISettings | void>;
  telegramStatus?: TelegramNotificationStatus | null;
}

export default function AISettingsForm({ initialData, onSave, telegramStatus = null }: AISettingsFormProps) {
  const { t } = useTranslation();
  const [aiSettings, setAISettings] = useState<NormalizedShopAISettings>(() => mergeAISettings(initialData));
  const [savedAISettings, setSavedAISettings] = useState<NormalizedShopAISettings>(() => mergeAISettings(initialData));
  const [showHandoffSection, setShowHandoffSection] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [notice, setNotice] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const aiTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showNotice = (type: "success" | "error", message: string) => {
    if (aiTimerRef.current) clearTimeout(aiTimerRef.current);
    setNotice({ type, message });
    if (type === "success") aiTimerRef.current = setTimeout(() => setNotice(null), 3000);
  };

  const isDirty = JSON.stringify(aiSettings) !== JSON.stringify(savedAISettings);
  const telegramConnected = Boolean(telegramStatus?.connected || telegramStatus?.status === 'connected');
  const handleAutomationModeChange = (value: string) => {
    const automationMode = normalizeAiReplyMode(value);
    setAISettings((previous) => ({
      ...previous,
      automation_mode: automationMode,
      auto_reply_enabled: autoReplyForMode(automationMode),
    }));
  };

  const handleSave = async () => {
    try {
      setIsSaving(true);
      const settingsForSave = {
        ...aiSettings,
        auto_reply_enabled: autoReplyForMode(aiSettings.automation_mode),
        // Preserve any previously-stored scalar untouched while the retired
        // unconsumed field controls remain hidden from merchants.
        ask_email: aiSettings.ask_email,
      };
      const persistedSettings = await onSave(settingsForSave);
      try {
        await queryClient.invalidateQueries({ queryKey: ["conversations"] });
      } catch {
        // A cache refresh failure must not turn a successful settings write into an error.
      }
      const nextSettings = persistedSettings && Object.keys(persistedSettings).length > 0
        ? mergeAISettings(persistedSettings)
        : settingsForSave;
      setAISettings(nextSettings);
      setSavedAISettings(nextSettings);
      showNotice("success", t('manageShop.aiSettings.saveSuccess'));
    } catch (error: any) {
      showNotice("error", getErrorMessage(error, t('manageShop.aiSettings.saveError')));
    } finally {
      setIsSaving(false);
    }
  };

  const noticeClass = (type: "success" | "error") =>
    type === "success"
      ? "rounded-lg border border-em-success-700/20 bg-em-success-100 px-4 py-3 text-sm text-em-success-700"
      : "rounded-lg border border-em-danger-700/20 bg-em-danger-100 px-4 py-3 text-sm text-em-danger-700";

  const closingEnabled = Boolean(aiSettings.closing?.enabled);

  return (
    <section aria-labelledby="ai-settings-title">
      <h2 id="ai-settings-title" className="mb-1 text-base font-semibold text-em-text-primary">{t('manageShop.aiSettings.title')}</h2>
      <p className="mb-4 text-sm text-em-text-secondary">
        {t('manageShop.aiSettings.subtitle')}
      </p>

      {notice && (
        <div
          role={notice.type === "success" ? "status" : "alert"}
          className={`mb-4 ${noticeClass(notice.type)}`}
        >
          {notice.message}
        </div>
      )}

      <div className="space-y-6">
        <div>
          <label id="ai-reply-mode-label" className="mb-2 block text-sm font-medium text-em-text-primary">{t('manageShop.aiSettings.automationModeLabel')}</label>
          <RadioGroup
            value={aiSettings.automation_mode}
            onValueChange={handleAutomationModeChange}
            aria-labelledby="ai-reply-mode-label"
            data-testid="ai-reply-mode"
            className="grid grid-cols-1 gap-3 md:grid-cols-3"
          >
            {([
              {
                mode: 'MANUAL' as AiReplyMode,
                title: t('manageShop.aiSettings.mode.manualTitle'),
                desc: t('manageShop.aiSettings.mode.manualDesc'),
              },
              {
                mode: 'DRAFT' as AiReplyMode,
                title: t('manageShop.aiSettings.mode.draftTitle'),
                desc: t('manageShop.aiSettings.mode.draftDesc'),
              },
              {
                mode: 'AUTO' as AiReplyMode,
                title: t('manageShop.aiSettings.mode.autoTitle'),
                desc: t('manageShop.aiSettings.mode.autoDesc'),
              },
            ]).map((option) => {
              const active = aiSettings.automation_mode === option.mode;
              const optionId = `ai-reply-mode-${option.mode.toLowerCase()}`;
              return (
                <div
                  key={option.mode}
                  className={`relative min-h-24 rounded-xl border p-4 text-left transition-colors ${
                    active ? 'border-em-violet-600 bg-em-violet-50' : 'border-em-border bg-em-bg-surface hover:border-em-border-strong'
                  }`}
                >
                  <RadioGroupItem
                    id={optionId}
                    value={option.mode}
                    data-testid={optionId}
                    aria-label={option.title}
                    className="absolute left-4 top-4"
                  />
                  <label htmlFor={optionId} className="block min-h-16 cursor-pointer pl-7">
                    <p className="mb-0.5 text-xs font-bold uppercase tracking-wider text-em-text-secondary">{option.mode}</p>
                    <p className="mb-1 text-sm font-bold text-em-text-primary">{option.title}</p>
                    <p className="text-xs text-em-text-secondary">{option.desc}</p>
                  </label>
                </div>
              );
            })}
          </RadioGroup>
        </div>

        <div>
          <label id="ai-language-label" className="mb-2 block text-sm font-medium text-em-text-primary">{t('manageShop.aiSettings.languageLabel')}</label>
          <p className="mb-2 text-xs text-em-text-secondary">{t('manageShop.aiSettings.languageHint')}</p>
          <div role="group" aria-labelledby="ai-language-label" className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            {([
              { value: 'mixed' as const, label: t('manageShop.aiSettings.language.mixed') },
              { value: 'bn' as const, label: t('manageShop.aiSettings.language.bn') },
              { value: 'en' as const, label: t('manageShop.aiSettings.language.en') },
            ]).map((lang) => (
              <button
                key={lang.value}
                type="button"
                aria-pressed={aiSettings.primary_language === lang.value}
                onClick={() => setAISettings({ ...aiSettings, primary_language: lang.value })}
                className={`min-h-12 rounded-lg border px-3 text-sm font-medium ${FOCUS_RING} ${
                  aiSettings.primary_language === lang.value
                    ? 'border-em-violet-600 bg-em-violet-50 text-em-violet-700'
                    : 'border-em-border text-em-text-primary hover:bg-em-bg-muted'
                }`}
              >
                <span className="font-bold">{lang.value}</span>
                {' — '}
                <span className="text-xs">{lang.label}</span>
              </button>
            ))}
          </div>
        </div>

        <div>
          <label htmlFor="confidence-threshold" className="mb-1 flex min-h-11 items-center gap-1 text-sm font-medium text-em-text-primary">
            {t('manageShop.aiSettings.confidenceLabel')} <span className="font-semibold text-em-violet-700">{aiSettings.confidence_threshold}%</span>
          </label>
          <p className="mb-2 text-xs text-em-text-secondary">{t('manageShop.aiSettings.confidenceHint')}</p>
          <input
            id="confidence-threshold"
            type="range"
            min={0}
            max={100}
            step={5}
            value={aiSettings.confidence_threshold}
            aria-valuetext={`${aiSettings.confidence_threshold}%`}
            onChange={(e) => setAISettings({ ...aiSettings, confidence_threshold: Number(e.target.value) })}
            className={`w-full accent-em-violet-600 ${FOCUS_RING}`}
          />
          <div className="mt-1 flex justify-between text-xs text-em-text-secondary">
            <span>{t('manageShop.aiSettings.confidenceCautious')}</span><span>{t('manageShop.aiSettings.confidenceBalanced')}</span><span>{t('manageShop.aiSettings.confidenceIndependent')}</span>
          </div>
          <p className="mt-2 rounded-lg border border-em-info-700/20 bg-em-info-100 px-3 py-2 text-xs text-em-info-700">
            {t('manageShop.aiSettings.confidenceRealityNote')}
          </p>
        </div>

        {/* The standalone "Ask customer for email" toggle was removed (founder
            decision): it duplicated the "Email address" option in Required
            Order Fields below, and the two could contradict each other. The
            legacy `ask_email` scalar is now derived from that checkbox on save
            (see handleSave) rather than carried as a hidden second source. */}

        <div className="space-y-4 border-t border-em-border pt-6">
          <div>
            <label className="mb-2 block text-sm font-medium text-em-text-primary">{t('manageShop.aiSettings.greetingLabel')} <span className="font-normal text-em-text-secondary">{t('manageShop.aiSettings.greetingHint')}</span></label>
            <div className="mb-2 rounded-md bg-em-bg-muted px-3 py-2 text-xs text-em-text-secondary">
              <span className="font-semibold text-em-text-primary">{t('manageShop.aiSettings.disclosurePrefix')} </span>
              <span className="font-medium text-em-text-primary">{t('manageShop.aiSettings.disclosureText')}</span>
              <span> {t('manageShop.aiSettings.disclosureSuffix')}</span>
            </div>
            <textarea
              rows={2}
              aria-label={t('manageShop.aiSettings.greetingLabel')}
              value={aiSettings.greeting?.custom_text || ""}
              onChange={(e) => setAISettings({ ...aiSettings, greeting: { ...aiSettings.greeting!, custom_text: e.target.value } })}
              placeholder={t('manageShop.aiSettings.greetingPlaceholder')}
              className={FIELD_CLASS}
            />
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between gap-3">
              <label className="block text-sm font-medium text-em-text-primary">{t('manageShop.aiSettings.closingLabel')} <span className="font-normal text-em-text-secondary">{t('manageShop.aiSettings.closingHint')}</span></label>
              <button
                type="button"
                role="switch"
                aria-checked={closingEnabled}
                aria-label={t('manageShop.aiSettings.closingLabel')}
                onClick={() => setAISettings({ ...aiSettings, closing: { ...aiSettings.closing!, enabled: !aiSettings.closing?.enabled } })}
                className={`inline-flex min-h-11 shrink-0 select-none items-center gap-2 rounded-lg px-1 disabled:cursor-not-allowed ${FOCUS_RING}`}
              >
                <span className={`relative inline-flex h-6 w-10 shrink-0 items-center rounded-full transition-colors ${closingEnabled ? "bg-em-violet-600" : "bg-em-border-strong"}`}>
                  <span className={`absolute left-1 top-1 h-4 w-4 rounded-full bg-em-bg-surface shadow transition-transform ${closingEnabled ? "translate-x-4" : ""}`} />
                </span>
                <span aria-hidden="true" className="text-xs text-em-text-secondary">{closingEnabled ? t('manageShop.aiSettings.toggleOn') : t('manageShop.aiSettings.toggleOff')}</span>
              </button>
            </div>
            <textarea
              rows={2}
              aria-label={t('manageShop.aiSettings.closingLabel')}
              value={aiSettings.closing?.custom_text || ""}
              onChange={(e) => setAISettings({ ...aiSettings, closing: { ...aiSettings.closing!, custom_text: e.target.value } })}
              placeholder={t('manageShop.aiSettings.closingPlaceholder')}
              className={FIELD_CLASS}
            />
            <p className="mt-1 text-xs text-em-text-secondary">{t('manageShop.aiSettings.closingSocialNote')}</p>
          </div>
        </div>

        <div className="rounded-lg border border-em-border">
          <button
            type="button"
            id="handoff-toggle"
            aria-expanded={showHandoffSection}
            aria-controls={showHandoffSection ? "handoff-panel" : undefined}
            onClick={() => setShowHandoffSection(!showHandoffSection)}
            className={`flex min-h-11 w-full items-center justify-between rounded-lg px-4 py-3 text-sm font-medium text-em-text-primary hover:bg-em-bg-muted ${FOCUS_RING}`}
          >
            <span>{t('manageShop.aiSettings.handoffTitle')}</span>
            {showHandoffSection ? <ChevronUp className="h-4 w-4" aria-hidden="true" /> : <ChevronDown className="h-4 w-4" aria-hidden="true" />}
          </button>
          {showHandoffSection && (
            <div id="handoff-panel" role="region" aria-labelledby="handoff-toggle" className="space-y-4 border-t border-em-border px-4 pb-4 pt-4">
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <div>
                  <label htmlFor="notification-channel" className="mb-1 block text-sm font-medium text-em-text-primary">{t('manageShop.aiSettings.notificationChannel')}</label>
                  <select
                    id="notification-channel"
                    value={aiSettings.handoff_settings.notification_channel}
                    onChange={(e) => setAISettings({
                      ...aiSettings,
                      handoff_settings: { ...aiSettings.handoff_settings, notification_channel: e.target.value as HandoffNotificationChannel }
                    })}
                    className={FIELD_CLASS}
                  >
                    <option value="in_app">{t('manageShop.aiSettings.notifInApp')}</option>
                    <option value="telegram">{t('manageShop.aiSettings.notifTelegram')}</option>
                  </select>
                  <p className="mt-1 text-xs text-em-text-secondary">{t('manageShop.aiSettings.notificationChannelHint')}</p>
                  {aiSettings.handoff_settings.notification_channel === 'telegram' && (
                    <p className={`mt-1 text-xs ${telegramConnected ? 'text-em-success-700' : 'text-em-warning-700'}`}>
                      {telegramConnected
                        ? t('manageShop.aiSettings.telegramConnected')
                        : t('manageShop.aiSettings.telegramDisconnected')}
                    </p>
                  )}
                </div>
                <div>
                  <label htmlFor="cooldown-minutes" className="mb-1 block text-sm font-medium text-em-text-primary">{t('manageShop.aiSettings.cooldownLabel')}</label>
                  <input
                    id="cooldown-minutes"
                    type="number"
                    min={0}
                    max={1440}
                    value={aiSettings.handoff_settings.cooldown_minutes}
                    onChange={(e) => setAISettings({
                      ...aiSettings,
                      handoff_settings: { ...aiSettings.handoff_settings, cooldown_minutes: Number(e.target.value) }
                    })}
                    className={FIELD_CLASS}
                  />
                </div>
              </div>
              <TagInput
                label={t('manageShop.aiSettings.triggerKeywordsLabel')}
                hint={t('manageShop.aiSettings.triggerKeywordsHint')}
                values={aiSettings.handoff_settings.trigger_keywords}
                onChange={(v) => setAISettings({ ...aiSettings, handoff_settings: { ...aiSettings.handoff_settings, trigger_keywords: v } })}
                placeholder={t('manageShop.aiSettings.triggerKeywordsPlaceholder')}
              />
            </div>
          )}
        </div>
      </div>

      <EmButton
        variant="primary"
        onClick={handleSave}
        disabled={isSaving || !isDirty}
        loading={isSaving}
        className="mt-6"
      >
        {isSaving ? t('common.saving') : t('manageShop.aiSettings.saveButton')}
      </EmButton>
    </section>
  );
}
