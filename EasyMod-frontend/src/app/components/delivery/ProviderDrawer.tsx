/**
 * Right-side management drawer for one courier provider (guardrails §5.6/§12/§17/§18).
 *
 * Holds the heavier provider work the card delegates here: masked credentials
 * view + connect/reconnect form (per-provider required-field validation, sandbox
 * for Pathao/RedX only), a REAL connection test whose state stays Pending until
 * the server reload confirms `last_validated_at` (§8), activate/deactivate,
 * set/clear the AI default (gated on an ACTIVE connection), operational
 * readiness + missing requirements, and a danger Disconnect that requires a
 * type-to-confirm dialog before the irreversible call (§12). Stored secrets are
 * never shown — the masked rows render a fixed placeholder, not server data.
 *
 * The drawer is mounted only while open (so the card's reserved capability /
 * pickup testids never collide with anything here) and traps + restores focus
 * via {@link useDialogFocus}. Slide is 200–300ms on transform only; reduced
 * motion and unit tests collapse it (`initial={false}` when `!ANIMATE`).
 *
 * Because every provider mutation launches from inside this dialog, the tab's
 * current action `feedback` is passed in and rendered HERE (role=alert on
 * failure, role=status announced politely on success) — never only on the
 * card behind the aria-modal scrim (§17 inline-first inside dialogs, A8).
 */
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { motion, MotionConfig } from 'motion/react';
import {
  X,
  Star,
  Power,
  TestTube,
  Lock,
  TriangleAlert,
  ShieldCheck,
  CircleDashed,
} from 'lucide-react';
import type {
  DeliveryActivationStatus,
  DeliveryProvider,
  DeliveryProviderStatus,
  PickupLocationSummary,
  ProviderPickupMetadata,
} from '@/api/types/order';
import { EmButton } from '../dashboard/EmButton';
import { useDialogFocus } from '../inbox/useDialogFocus';
import type { ActionFeedback, ActionKind, ProviderConfig } from './ProvidersTab';

const ANIMATE = import.meta.env.MODE !== 'test';

const FOCUS_RING =
  'focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-em-focus-light focus-visible:transition-none';

const INPUT_CLASSES =
  `w-full min-h-11 border border-em-border-input rounded-lg bg-em-bg-surface px-3 py-2 text-sm text-em-text-primary focus:outline-none ${FOCUS_RING}`;

const MASK = '••••••••';

/**
 * A2c (bn-numerals rule): mirrors ProvidersTab — timestamps render through the
 * ACTIVE locale (same customers/customerDisplay.ts `localeFor` mapping,
 * bn → bn-BD, else en-US) via Intl.DateTimeFormat, never a locale-less
 * `toLocaleDateString()` that would show Latin month/digits on the Bangla UI.
 */
const localeFor = (language: string): string => (language.toLowerCase().startsWith('bn') ? 'bn-BD' : 'en-US');

const formatTimestamp = (value: string | null | undefined, language: string): string => {
  if (!value) return '—';
  const date = new Date(value);
  // Unparseable server value: show the raw string, never "Invalid Date".
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(localeFor(language), { dateStyle: 'medium', timeStyle: 'short' }).format(date);
};

export interface ProviderDrawerPayload {
  provider: DeliveryProvider;
  credentials: Record<string, string>;
  is_sandbox: boolean;
}

export interface PickupRequest {
  provider: DeliveryProvider;
  missing: string[];
  pickup: PickupLocationSummary | null;
  providerPickupMeta: ProviderPickupMetadata | null;
}

export interface ProviderDrawerProps {
  config: ProviderConfig;
  status: DeliveryProviderStatus;
  activationStatus: DeliveryActivationStatus;
  isAiDefault: boolean;
  missing: string[];
  pickupSummary: PickupLocationSummary | null;
  pending: ActionKind | null;
  /**
   * Current action result for THIS provider (A8): connect/test/activate/AI/
   * disconnect all launch from inside this dialog, so their success/error copy
   * must render here — near the action area, not on the card behind the
   * aria-modal scrim. The card keeps a secondary copy for card-scope flows.
   */
  feedback?: ActionFeedback | null;
  onClose: () => void;
  onConnect: (payload: ProviderDrawerPayload) => void | Promise<void>;
  onTest: (provider: DeliveryProvider) => void | Promise<void>;
  onActivate: (provider: DeliveryProvider) => void | Promise<void>;
  onDeactivate: (provider: DeliveryProvider) => void | Promise<void>;
  onSetAiDefault: (provider: DeliveryProvider) => void | Promise<void>;
  onClearAiDefault: (provider: DeliveryProvider) => void | Promise<void>;
  onDisconnect: (provider: DeliveryProvider) => void | Promise<void>;
  onCompletePickup: (payload: PickupRequest) => void;
}

export default function ProviderDrawer({
  config,
  status,
  activationStatus,
  isAiDefault,
  missing,
  pickupSummary,
  pending,
  feedback = null,
  onClose,
  onConnect,
  onTest,
  onActivate,
  onDeactivate,
  onSetAiDefault,
  onClearAiDefault,
  onDisconnect,
  onCompletePickup,
}: ProviderDrawerProps) {
  const { t, i18n } = useTranslation();
  const panelRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLDivElement>(null);
  const isConnected = status.is_connected;
  const isActive = activationStatus === 'ACTIVE';
  const hasSandbox = config.provider === 'pathao' || config.provider === 'redx';

  const [showForm, setShowForm] = useState(!isConnected);
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [isSandbox, setIsSandbox] = useState(hasSandbox && status.is_sandbox === true);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [confirmText, setConfirmText] = useState('');
  const [showConfirm, setShowConfirm] = useState(false);

  useDialogFocus(panelRef, true);
  useDialogFocus(confirmRef, showConfirm);

  const titleId = `provider-drawer-title-${config.provider}`;

  const close = () => {
    if (showConfirm) {
      setShowConfirm(false);
      return;
    }
    onClose();
  };

  const submitConnect = () => {
    const errors: Record<string, string> = {};
    for (const field of config.fields) {
      if (field.required && !credentials[field.name]?.trim()) {
        errors[field.name] = t('manageShop.deliverySettings.errors.fieldRequired', { field: field.label });
      }
    }
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;
    void onConnect({ provider: config.provider, credentials, is_sandbox: hasSandbox ? isSandbox : false });
  };

  const confirmReady = confirmText.trim().toLowerCase() === config.display_name.trim().toLowerCase();

  const requestDisconnect = () => {
    setConfirmText('');
    setShowConfirm(true);
  };

  const sectionClass = 'border-t border-em-border pt-4 first:border-t-0 first:pt-0';
  const headingClass = 'flex items-center gap-2 text-sm font-semibold text-em-text-primary';

  return (
    <MotionConfig reducedMotion="user">
      <div
        className="fixed inset-0 z-50 flex justify-end bg-em-midnight-950/60"
        onClick={(event) => { if (event.target === event.currentTarget) close(); }}
      >
        <motion.div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          tabIndex={-1}
          initial={ANIMATE ? { x: '100%' } : false}
          animate={ANIMATE ? { x: 0 } : undefined}
          transition={{ duration: 0.25, ease: [0.2, 0.8, 0.3, 1] }}
          onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); close(); } }}
          className="flex h-full w-full max-w-md flex-col border-l border-em-border bg-em-bg-surface shadow-xl"
        >
          {/* Drawer header */}
          <div className="flex items-start justify-between gap-3 border-b border-em-border p-5">
            <div>
              <h2 id={titleId} className="text-base font-semibold text-em-text-primary">
                {t('manageShop.deliverySettings.providers.drawerTitle', { provider: config.display_name })}
              </h2>
              <p className="mt-1 flex items-center gap-1.5 text-xs text-em-text-secondary">
                <span
                  className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium ${
                    isActive ? 'bg-em-success-100 text-em-success-700' : 'bg-em-bg-muted text-em-text-secondary'
                  }`}
                >
                  {isActive
                    ? <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
                    : <CircleDashed className="h-3.5 w-3.5" aria-hidden="true" />}
                  {t(`manageShop.deliverySettings.statuses.${activationStatus.toLowerCase().replace(/_(.)/g, (_, c) => c.toUpperCase())}`)}
                </span>
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label={t('common.close')}
              className={`inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg text-em-text-secondary hover:bg-em-bg-muted ${FOCUS_RING}`}
            >
              <X className="h-5 w-5" aria-hidden="true" />
            </button>
          </div>

          {/* Drawer body */}
          <div className="flex-1 space-y-4 overflow-y-auto p-5">
            {/* Action feedback (A8): the reply to the merchant's last drawer
                action renders here, inside the dialog — error as role=alert,
                success as role=status announced politely via aria-live. */}
            {feedback && (
              <p
                role={feedback.kind === 'error' ? 'alert' : 'status'}
                aria-live={feedback.kind === 'error' ? undefined : 'polite'}
                className={`flex items-start gap-1.5 rounded-lg px-3 py-2 text-sm ${
                  feedback.kind === 'error' ? 'bg-em-danger-100/60 text-em-danger-700' : 'bg-em-success-100 text-em-success-700'
                }`}
                data-testid="drawer-action-feedback"
              >
                {feedback.kind === 'error'
                  ? <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  : <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />}
                <span>{feedback.text}</span>
              </p>
            )}

            {/* Credentials — masked view never exposes stored secrets; form is for entry only. */}
            <section className={sectionClass} aria-labelledby={`drawer-creds-${config.provider}`}>
              <h3 id={`drawer-creds-${config.provider}`} className={headingClass}>
                <Lock className="h-4 w-4 text-em-text-secondary" aria-hidden="true" />
                {t('manageShop.deliverySettings.providers.credentialsTitle')}
              </h3>

              {isConnected && !showForm && (
                <div className="mt-3 space-y-2">
                  <p className="text-xs text-em-text-secondary">
                    {t('manageShop.deliverySettings.providers.credentialsStored')}
                  </p>
                  <ul className="space-y-1.5">
                    {config.fields.map((field) => (
                      <li key={field.name} className="flex items-center justify-between gap-2 text-sm">
                        <span className="text-em-text-secondary">{field.label}</span>
                        <span className="em-tabular font-mono text-em-text-primary" aria-label={t('manageShop.deliverySettings.providers.maskedValue')}>
                          {MASK}
                        </span>
                      </li>
                    ))}
                  </ul>
                  <EmButton
                    variant="secondary"
                    className="mt-1"
                    onClick={() => { setShowForm(true); setFieldErrors({}); }}
                  >
                    {t('manageShop.deliverySettings.providers.reconnect')}
                  </EmButton>
                </div>
              )}

              {(!isConnected || showForm) && (
                <div className="mt-3 space-y-4">
                  <p className="text-sm text-em-text-secondary">
                    {t('manageShop.deliverySettings.enterCredentials', { provider: config.display_name })}
                  </p>
                  {config.fields.map((field) => (
                    <div key={field.name}>
                      <label htmlFor={`drawer-${config.provider}-${field.name}`} className="mb-1 block text-sm font-medium text-em-text-primary">
                        {field.label}
                        {field.required && <span className="ml-1 text-em-danger-700">*</span>}
                      </label>
                      <input
                        id={`drawer-${config.provider}-${field.name}`}
                        type={field.type}
                        value={credentials[field.name] || ''}
                        onChange={(e) => setCredentials((prev) => ({ ...prev, [field.name]: e.target.value }))}
                        placeholder={field.placeholder}
                        aria-invalid={fieldErrors[field.name] ? true : undefined}
                        aria-describedby={fieldErrors[field.name] ? `drawer-${config.provider}-${field.name}-error` : undefined}
                        className={`${INPUT_CLASSES} ${fieldErrors[field.name] ? 'border-em-danger-700' : ''}`}
                      />
                      {fieldErrors[field.name] && (
                        <p id={`drawer-${config.provider}-${field.name}-error`} role="alert" className="mt-1 text-xs text-em-danger-700">
                          {fieldErrors[field.name]}
                        </p>
                      )}
                    </div>
                  ))}

                  {hasSandbox && (
                    <div className="flex min-h-11 items-center gap-2">
                      <input
                        type="checkbox"
                        id={`sandbox-${config.provider}`}
                        checked={isSandbox}
                        onChange={(e) => setIsSandbox(e.target.checked)}
                        className="h-5 w-5 rounded border-em-border-strong accent-em-violet-600"
                      />
                      <label htmlFor={`sandbox-${config.provider}`} className="text-sm text-em-text-primary">
                        {t('manageShop.deliverySettings.useSandbox')}
                      </label>
                    </div>
                  )}

                  <div className="flex flex-wrap items-center gap-3">
                    <EmButton
                      variant="primary"
                      onClick={submitConnect}
                      loading={pending === 'connect'}
                      disabled={pending === 'connect'}
                      data-testid={`drawer-save-connect-${config.provider}`}
                    >
                      {t('manageShop.deliverySettings.saveConnect')}
                    </EmButton>
                    {isConnected && (
                      <EmButton
                        variant="secondary"
                        onClick={() => { setShowForm(false); setFieldErrors({}); setCredentials({}); }}
                      >
                        {t('common.cancel')}
                      </EmButton>
                    )}
                  </div>
                </div>
              )}
            </section>

            {isConnected && (
              <>
                {/* Test connection — Pending while in flight, confirmed only from the reload (§8). */}
                <section className={sectionClass} aria-labelledby={`drawer-test-${config.provider}`}>
                  <h3 id={`drawer-test-${config.provider}`} className={headingClass}>
                    <TestTube className="h-4 w-4 text-em-text-secondary" aria-hidden="true" />
                    {t('manageShop.deliverySettings.testConnection')}
                  </h3>
                  <p className="mt-1 em-tabular text-xs text-em-text-secondary">
                    {status.last_validated_at
                      ? t('manageShop.deliverySettings.lastTested', { date: formatTimestamp(status.last_validated_at, i18n.language) })
                      : t('manageShop.deliverySettings.providers.notTested')}
                  </p>
                  {pending === 'test' && (
                    <p role="status" className="mt-1 flex items-center gap-1.5 text-xs text-em-info-700">
                      <CircleDashed className="h-3.5 w-3.5" aria-hidden="true" />
                      {t('manageShop.deliverySettings.providers.pendingTest', { provider: config.display_name })}
                    </p>
                  )}
                  <EmButton
                    variant="secondary"
                    className="mt-2"
                    onClick={() => void onTest(config.provider)}
                    loading={pending === 'test'}
                    disabled={pending !== null}
                    data-testid={`drawer-test-${config.provider}`}
                  >
                    {t('manageShop.deliverySettings.testConnection')}
                  </EmButton>
                </section>

                {/* Activation */}
                <section className={sectionClass} aria-labelledby={`drawer-activation-${config.provider}`}>
                  <h3 id={`drawer-activation-${config.provider}`} className={headingClass}>
                    <Power className="h-4 w-4 text-em-text-secondary" aria-hidden="true" />
                    {t('manageShop.deliverySettings.providers.activationTitle')}
                  </h3>
                  <EmButton
                    variant={isActive ? 'secondary' : 'primary'}
                    className="mt-2 gap-2"
                    onClick={() => void (isActive ? onDeactivate(config.provider) : onActivate(config.provider))}
                    loading={pending === 'toggle'}
                    disabled={pending !== null}
                    data-testid={`drawer-${isActive ? 'deactivate' : 'activate'}-${config.provider}`}
                  >
                    <Power className="h-4 w-4" aria-hidden="true" />
                    {isActive ? t('manageShop.deliverySettings.deactivate') : t('manageShop.deliverySettings.activate')}
                  </EmButton>
                </section>

                {/* AI default — set only when active and not already default; clear only when a default is set. */}
                <section className={sectionClass} aria-labelledby={`drawer-ai-${config.provider}`}>
                  <h3 id={`drawer-ai-${config.provider}`} className={headingClass}>
                    <Star className="h-4 w-4 text-em-text-secondary" aria-hidden="true" />
                    {t('manageShop.deliverySettings.providers.aiTitle')}
                  </h3>
                  <p className="mt-1 text-xs text-em-text-secondary">
                    {t('manageShop.deliverySettings.providers.aiHelp')}
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-3">
                    {isActive && !isAiDefault && (
                      <EmButton
                        variant="secondary"
                        className="gap-2"
                        onClick={() => void onSetAiDefault(config.provider)}
                        loading={pending === 'ai-set'}
                        disabled={pending !== null}
                        data-testid={`drawer-set-ai-${config.provider}`}
                      >
                        <Star className="h-4 w-4" aria-hidden="true" />
                        {t('manageShop.deliverySettings.setAsAiDefault')}
                      </EmButton>
                    )}
                    {isAiDefault && (
                      <EmButton
                        variant="secondary"
                        onClick={() => void onClearAiDefault(config.provider)}
                        loading={pending === 'ai-clear'}
                        disabled={pending !== null}
                        data-testid={`drawer-clear-ai-${config.provider}`}
                      >
                        {t('manageShop.deliverySettings.providers.clearDefault')}
                      </EmButton>
                    )}
                  </div>
                </section>

                {/* Operational readiness / missing requirements */}
                <section className={sectionClass} aria-labelledby={`drawer-ready-${config.provider}`}>
                  <h3 id={`drawer-ready-${config.provider}`} className={headingClass}>
                    <ShieldCheck className="h-4 w-4 text-em-text-secondary" aria-hidden="true" />
                    {t('manageShop.deliverySettings.providers.readyTitle')}
                  </h3>
                  {missing.length === 0 ? (
                    <p className="mt-1 text-sm text-em-success-700">
                      {t('manageShop.deliverySettings.providers.readyOk')}
                    </p>
                  ) : (
                    <div className="mt-1">
                      <p className="text-sm text-em-sunlight-700">
                        {t('manageShop.deliverySettings.providers.readyMissing')}
                      </p>
                      <ul className="mt-1 list-inside list-disc text-xs text-em-text-secondary">
                        {missing.map((item) => <li key={item} className="em-tabular">{item}</li>)}
                      </ul>
                      <button
                        type="button"
                        onClick={() => onCompletePickup({ provider: config.provider, missing, pickup: pickupSummary, providerPickupMeta: status.provider_pickup_meta ?? null })}
                        className={`mt-2 inline-flex min-h-11 items-center text-sm font-semibold text-em-violet-700 hover:text-em-violet-900 hover:underline ${FOCUS_RING}`}
                        data-testid={`drawer-complete-pickup-${config.provider}`}
                      >
                        {t('manageShop.deliverySettings.completePickupDetails')}
                      </button>
                    </div>
                  )}
                </section>

                {/* Capability evidence — honest ceiling only; per-op truth stays on the card. */}
                {status.capabilities && (
                  <section className={sectionClass} aria-labelledby={`drawer-evidence-${config.provider}`}>
                    <h3 id={`drawer-evidence-${config.provider}`} className={headingClass}>
                      <ShieldCheck className="h-4 w-4 text-em-text-secondary" aria-hidden="true" />
                      {t('manageShop.deliverySettings.providers.evidenceTitle')}
                    </h3>
                    <p className="mt-1 text-xs text-em-sunlight-700">
                      {t(`manageShop.deliverySettings.capabilities.level.${status.capabilities.ceiling === 'LIVE_VERIFIED' ? 'implementedNotLiveVerified' : status.capabilities.ceiling === 'UNKNOWN' ? 'unknown' : status.capabilities.ceiling === 'UNSUPPORTED' ? 'unsupported' : 'implementedNotLiveVerified'}`)}
                    </p>
                    <p className="mt-1 text-xs text-em-text-secondary">
                      {status.capabilities.last_verified_at
                        ? t('manageShop.deliverySettings.capabilities.lastVerified', { date: formatTimestamp(status.capabilities.last_verified_at, i18n.language) })
                        : t('manageShop.deliverySettings.capabilities.neverVerified')}
                    </p>
                  </section>
                )}

                {/* Danger zone — irreversible: type-to-confirm before disconnect (§12). */}
                <section className={`${sectionClass} rounded-lg border border-em-danger-700/20 bg-em-danger-100/40 p-4`} aria-labelledby={`drawer-danger-${config.provider}`}>
                  <h3 id={`drawer-danger-${config.provider}`} className="flex items-center gap-2 text-sm font-semibold text-em-danger-700">
                    <TriangleAlert className="h-4 w-4" aria-hidden="true" />
                    {t('manageShop.deliverySettings.providers.dangerTitle')}
                  </h3>
                  <EmButton
                    variant="danger"
                    className="mt-2 gap-2"
                    onClick={requestDisconnect}
                    loading={pending === 'disconnect'}
                    disabled={pending !== null}
                    data-testid={`disconnect-${config.provider}`}
                  >
                    <X className="h-4 w-4" aria-hidden="true" />
                    {t('common.disconnect')}
                  </EmButton>
                </section>
              </>
            )}
          </div>
        </motion.div>

        {/* Type-to-confirm disconnect modal — Cancel is the safe default focus (§12). */}
        {showConfirm && (
          <div
            className="fixed inset-0 z-[60] flex items-center justify-center bg-em-midnight-950/60 p-4"
            onClick={(event) => { if (event.target === event.currentTarget) setShowConfirm(false); }}
          >
            <div
              ref={confirmRef}
              role="dialog"
              aria-modal="true"
              aria-labelledby={`disconnect-title-${config.provider}`}
              onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); setShowConfirm(false); } }}
              className="w-full max-w-md rounded-xl bg-em-bg-surface p-5 shadow-xl md:p-6"
            >
              <h3 id={`disconnect-title-${config.provider}`} className="text-lg font-semibold text-em-text-primary">
                {t('manageShop.deliverySettings.disconnectConfirm', { provider: config.display_name })}
              </h3>
              <p className="mt-2 text-sm text-em-text-secondary">
                {t('manageShop.deliverySettings.disconnectConfirmBody')}
              </p>
              <label htmlFor={`disconnect-type-${config.provider}`} className="mt-4 block text-sm font-medium text-em-text-primary">
                {t('manageShop.deliverySettings.providers.typeToConfirm', { provider: config.display_name })}
              </label>
              <input
                id={`disconnect-type-${config.provider}`}
                type="text"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder={config.display_name}
                className={`${INPUT_CLASSES} mt-1`}
                autoComplete="off"
              />
              <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:justify-end">
                <EmButton variant="secondary" onClick={() => setShowConfirm(false)}>
                  {t('common.cancel')}
                </EmButton>
                <EmButton
                  variant="danger"
                  disabled={!confirmReady || pending === 'disconnect'}
                  loading={pending === 'disconnect'}
                  onClick={() => { setShowConfirm(false); void onDisconnect(config.provider); }}
                  data-testid="delivery-disconnect-confirm"
                >
                  {t('common.disconnect')}
                </EmButton>
              </div>
            </div>
          </div>
        )}
      </div>
    </MotionConfig>
  );
}
