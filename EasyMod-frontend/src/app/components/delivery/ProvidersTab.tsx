/**
 * Delivery Settings — Tab 1 "Courier Providers" (guardrails §5.6/§8/§11/§16/§17).
 *
 * Three fixed provider cards (Pathao, Steadfast, RedX) carry the record-level
 * signal (activation chip, environment chip, connected dot, last-tested, AI
 * default star, pickup summary/missing, capability truth) and ONE contextual
 * primary action each (Connect when not connected, Manage when connected).
 * The heavier management work (credentials, real connection test, activate /
 * deactivate, set/clear AI default, disconnect, operational readiness) lives in
 * the right-side {@link ProviderDrawer}, which is mounted only while open so the
 * reserved card testids stay unique. This tab never renders a second page-wide
 * status — the `delivery-signal` belongs to the shell (A0).
 *
 * Data is owned by the shell: `providers`/`settings` arrive as props and every
 * mutation calls `onMutate()` so the shell reloads and re-derives the header
 * signal from the server reply — never an optimistic local "done" (§4/§8).
 */
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MotionConfig } from 'motion/react';
import {
  Truck,
  Package,
  MapPin,
  Star,
  Check,
  AlertCircle,
  Settings2,
  PlugZap,
} from 'lucide-react';
import * as orderApi from '@/api/domains/order';
import type {
  CourierCapabilityEntry,
  DeliveryActivationStatus,
  DeliveryProvider,
  DeliveryProviderCapabilities,
  DeliveryProviderStatus,
  DeliveryShopSettings,
  PathaoCredentials,
  PickupLocationSummary,
  ProviderPickupMetadata,
  RedxCredentials,
  SteadfastCredentials,
} from '@/api/types/order';
import { getErrorMessage } from '@shared/lib/http/errors';
import { EmButton } from '../dashboard/EmButton';
import PickupDetailsModal from '../PickupDetailsModal';
import ProviderDrawer, { type ProviderDrawerPayload } from './ProviderDrawer';

// `clearAiDefault` is added to the order domain by the integration (A0). It is
// referenced by its exact runtime name; the local augmentation keeps this file
// self-consistent until then without touching the shared client module.
type OrderApiWithClear = typeof orderApi & {
  clearAiDefault: (provider?: DeliveryProvider) => Promise<DeliveryProviderStatus>;
};
const api = orderApi as OrderApiWithClear;

export interface ProviderConfig {
  provider: DeliveryProvider;
  display_name: string;
  description: string;
  logo: string;
  fields: {
    name: keyof PathaoCredentials | keyof SteadfastCredentials | keyof RedxCredentials;
    label: string;
    type: 'text' | 'password' | 'email';
    placeholder: string;
    required: boolean;
  }[];
}

// Fixed display order preserved from the current page: Pathao, Steadfast, RedX.
const PROVIDER_CONFIGS: ProviderConfig[] = [
  {
    provider: 'pathao',
    display_name: 'Pathao Courier',
    description: 'Fast and reliable delivery across Bangladesh',
    logo: '🚚',
    fields: [
      { name: 'client_id', label: 'Client ID', type: 'text', placeholder: 'Enter your Pathao Client ID', required: true },
      { name: 'client_secret', label: 'Client Secret', type: 'password', placeholder: 'Enter your Pathao Client Secret', required: true },
      { name: 'username', label: 'Username (Email)', type: 'email', placeholder: 'merchant@example.com', required: true },
      { name: 'password', label: 'Password', type: 'password', placeholder: 'Enter your Pathao account password', required: true },
    ],
  },
  {
    provider: 'steadfast',
    display_name: 'Steadfast Courier',
    description: 'Trusted delivery partner for e-commerce',
    logo: '📦',
    fields: [
      { name: 'api_key', label: 'API Key', type: 'text', placeholder: 'Enter your Steadfast API Key', required: true },
      { name: 'secret_key', label: 'Secret Key', type: 'password', placeholder: 'Enter your Steadfast Secret Key', required: true },
    ],
  },
  {
    provider: 'redx',
    display_name: 'RedX Courier',
    description: 'Nationwide delivery support with RedX tracking',
    logo: '📍',
    fields: [
      { name: 'api_key', label: 'API Key', type: 'password', placeholder: 'Enter your RedX API Key', required: true },
    ],
  },
];

// Capability display order — the server owns the values; the client only lists
// them so an unavailable action is never hidden silently. `pickup_store` is
// declared per provider by the backend (pathao/redx IMPLEMENTED_NOT_LIVE_VERIFIED,
// steadfast UNSUPPORTED with a manual pickup step), so it must render here.
const CAPABILITY_OPERATIONS = ['coverage', 'rate_quote', 'create_parcel', 'tracking', 'cancel', 'edit', 'pickup_store'] as const;

// Tolerant read: older payloads (and the shared client type) may not carry an
// operation the server has since started declaring — a missing row is skipped,
// never rendered as a fabricated entry.
const getCapabilityEntry = (
  capabilities: DeliveryProviderCapabilities | null | undefined,
  operation: string,
): CourierCapabilityEntry | undefined => {
  const value = (capabilities as unknown as Record<string, unknown> | undefined)?.[operation];
  return value && typeof value === 'object' ? value as CourierCapabilityEntry : undefined;
};

const CAPABILITY_LEVEL_KEYS: Record<string, string> = {
  UNSUPPORTED: 'unsupported',
  UNKNOWN: 'unknown',
  IMPLEMENTED_NOT_LIVE_VERIFIED: 'implementedNotLiveVerified',
  LIVE_VERIFIED: 'liveVerified',
};

const ACTIVATION_STATUS_LABELS: Record<DeliveryActivationStatus, string> = {
  NOT_CONFIGURED: 'manageShop.deliverySettings.statuses.notConfigured',
  SETUP_INCOMPLETE: 'manageShop.deliverySettings.statuses.setupIncomplete',
  VALIDATING: 'manageShop.deliverySettings.statuses.validating',
  ACTIVE: 'manageShop.deliverySettings.statuses.active',
  ACTION_REQUIRED: 'manageShop.deliverySettings.statuses.actionRequired',
};

const ACTIVATION_STATUS_CLASSES: Record<DeliveryActivationStatus, string> = {
  NOT_CONFIGURED: 'bg-em-bg-muted text-em-text-secondary',
  SETUP_INCOMPLETE: 'bg-em-sunlight-100 text-em-sunlight-700',
  VALIDATING: 'bg-em-info-100 text-em-info-700',
  ACTIVE: 'bg-em-success-100 text-em-success-700',
  ACTION_REQUIRED: 'bg-em-danger-100 text-em-danger-700',
};

const PROVIDER_ICONS: Record<DeliveryProvider, typeof Truck> = {
  pathao: Truck,
  steadfast: Package,
  redx: MapPin,
};

const FOCUS_RING =
  'focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-em-focus-light focus-visible:transition-none';

const normalizeActivationStatus = (status: DeliveryProviderStatus | undefined): DeliveryActivationStatus => {
  const rawStatus = typeof status?.activation_status === 'string'
    ? (status.activation_status.toUpperCase() as DeliveryActivationStatus)
    : undefined;
  if (rawStatus && rawStatus in ACTIVATION_STATUS_LABELS) return rawStatus;
  if (!status?.is_connected) return 'NOT_CONFIGURED';
  if (status.is_active) return 'ACTIVE';
  return 'SETUP_INCOMPLETE';
};

const isProviderAiDefault = (status: DeliveryProviderStatus | undefined): boolean => {
  if (!status) return false;
  if (Object.prototype.hasOwnProperty.call(status, 'is_ai_default')) return status.is_ai_default === true;
  return status.metadata?.is_ai_default === true || status.metadata?.ai_default === true;
};

const getProviderMissing = (status: DeliveryProviderStatus | undefined): string[] => {
  if (!status) return [];
  const legacyMissing = (status as DeliveryProviderStatus & { missing_fields?: unknown }).missing_fields;
  if (Array.isArray(status.missing)) return status.missing.filter((value): value is string => typeof value === 'string');
  if (Array.isArray(legacyMissing)) return legacyMissing.filter((value): value is string => typeof value === 'string');
  return [];
};

const normalizePickupSummary = (pickup: PickupLocationSummary): PickupLocationSummary => {
  const legacy = pickup as PickupLocationSummary & {
    name?: string | null;
    area?: string | null;
    pickup_address?: string | null;
  };
  return {
    ...pickup,
    display_name: pickup.display_name ?? pickup.contact_name ?? legacy.name,
    area_name: pickup.area_name ?? legacy.area,
    address: pickup.address ?? legacy.pickup_address,
  };
};

const getPickupSummary = (status: DeliveryProviderStatus | undefined): PickupLocationSummary | null => {
  if (!status) return null;
  if (status.pickup_summary) return normalizePickupSummary(status.pickup_summary);
  const legacyPickup = (status as DeliveryProviderStatus & { pickup?: PickupLocationSummary | null }).pickup;
  return legacyPickup ? normalizePickupSummary(legacyPickup) : null;
};

const isConflictError = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as {
    statusCode?: unknown;
    status?: unknown;
    type?: unknown;
    response?: { status?: unknown };
  };
  return candidate.statusCode === 409
    || candidate.status === 409
    || candidate.response?.status === 409
    || candidate.type === 'CONFLICT';
};

const getConflictMissing = (error: unknown, fallback: string[]): string[] => {
  if (!error || typeof error !== 'object') return fallback;
  const candidate = error as {
    missing?: unknown;
    details?: { missing?: unknown; missing_fields?: unknown };
    data?: { missing?: unknown; details?: { missing?: unknown } };
    response?: { data?: { missing?: unknown; details?: { missing?: unknown }; error?: { details?: { missing?: unknown } } } };
  };
  const values = [
    candidate.missing,
    candidate.details?.missing,
    candidate.details?.missing_fields,
    candidate.data?.missing,
    candidate.data?.details?.missing,
    candidate.response?.data?.missing,
    candidate.response?.data?.details?.missing,
    candidate.response?.data?.error?.details?.missing,
  ];
  const found = values.find((value): value is unknown[] => Array.isArray(value));
  return found?.filter((value): value is string => typeof value === 'string') ?? fallback;
};

export type ActionKind = 'connect' | 'test' | 'toggle' | 'ai-set' | 'ai-clear' | 'disconnect';

/**
 * Current action result without the provider scope — handed to the open drawer
 * so feedback for drawer-launched actions (connect/test/activate/AI/disconnect)
 * renders INSIDE the dialog instead of only on the card behind the scrim (A8).
 */
export interface ActionFeedback {
  kind: 'success' | 'error';
  text: string;
}

interface InlineFeedback extends ActionFeedback {
  provider: DeliveryProvider;
}

interface PickupTarget {
  provider: DeliveryProvider;
  missing: string[];
  pickup: PickupLocationSummary | null;
  providerPickupMeta: ProviderPickupMetadata | null;
}

export interface ProvidersTabProps {
  providers: DeliveryProviderStatus[];
  settings?: DeliveryShopSettings;
  /** Reload + re-derive after a server-confirmed mutation (shell-owned fetch). */
  onMutate?: () => void | Promise<void>;
  /**
   * Preferred redesign path: routing the merchant to the Pickup tab when pickup
   * details are required. When absent (e.g. while the shell is being wired) this
   * tab falls back to the existing PickupDetailsModal so the flow is preserved.
   */
  onCompletePickup?: (payload: PickupTarget) => void;
}

export default function ProvidersTab({ providers, onMutate, onCompletePickup }: ProvidersTabProps) {
  const { t } = useTranslation();
  const [drawerFor, setDrawerFor] = useState<DeliveryProvider | null>(null);
  const [pending, setPending] = useState<{ provider: DeliveryProvider; kind: ActionKind } | null>(null);
  const [feedback, setFeedback] = useState<InlineFeedback | null>(null);
  const [pickupFallback, setPickupFallback] = useState<PickupTarget | null>(null);

  const reload = useCallback(async () => {
    try {
      await onMutate?.();
    } catch {
      // The shell owns the load error surface; a failed reload keeps the last
      // known server state visible rather than pretending the action reverted.
    }
  }, [onMutate]);

  const begin = (provider: DeliveryProvider, kind: ActionKind) => {
    setPending({ provider, kind });
    setFeedback(null);
  };
  const finish = () => setPending(null);

  const routeToPickup = useCallback((target: PickupTarget) => {
    if (onCompletePickup) {
      onCompletePickup(target);
      return;
    }
    setPickupFallback(target);
  }, [onCompletePickup]);

  const handleConnect = async (payload: ProviderDrawerPayload) => {
    const config = PROVIDER_CONFIGS.find((item) => item.provider === payload.provider);
    begin(payload.provider, 'connect');
    try {
      await orderApi.connectDeliveryProvider({
        provider: payload.provider,
        credentials: payload.credentials as never,
        is_sandbox: payload.is_sandbox,
      });
      setFeedback({
        provider: payload.provider,
        kind: 'success',
        text: t('manageShop.deliverySettings.success.connected', { provider: config?.display_name }),
      });
      await reload();
    } catch (err) {
      setFeedback({
        provider: payload.provider,
        kind: 'error',
        text: getErrorMessage(err, t('manageShop.deliverySettings.errors.connectFailed')),
      });
    } finally {
      finish();
    }
  };

  const handleTest = async (provider: DeliveryProvider) => {
    const config = PROVIDER_CONFIGS.find((item) => item.provider === provider);
    begin(provider, 'test');
    // Pending first (§8): the drawer shows "Testing…" while in flight. The card
    // only reflects a *server-confirmed* last-tested time once `onMutate` reloads
    // and the re-read provider carries `last_validated_at` — never an optimistic
    // local stamp.
    try {
      await orderApi.testDeliveryConnection(provider);
      setFeedback({
        provider,
        kind: 'success',
        text: t('manageShop.deliverySettings.success.testSuccess', { provider: config?.display_name }),
      });
      await reload();
    } catch (err) {
      setFeedback({
        provider,
        kind: 'error',
        text: getErrorMessage(err, t('manageShop.deliverySettings.errors.testFailed')),
      });
    } finally {
      finish();
    }
  };

  const handleActivate = async (provider: DeliveryProvider) => {
    const config = PROVIDER_CONFIGS.find((item) => item.provider === provider);
    const status = providers.find((item) => item.provider === provider);
    begin(provider, 'toggle');
    try {
      await orderApi.activateDeliveryProvider(provider);
      setFeedback({
        provider,
        kind: 'success',
        text: t('manageShop.deliverySettings.success.activated', { provider: config?.display_name }),
      });
      await reload();
    } catch (err) {
      if (isConflictError(err)) {
        setFeedback({
          provider,
          kind: 'error',
          text: t('manageShop.deliverySettings.providers.activateNeedsPickup'),
        });
        routeToPickup({
          provider,
          missing: getConflictMissing(err, getProviderMissing(status)),
          pickup: getPickupSummary(status),
          providerPickupMeta: status?.provider_pickup_meta ?? null,
        });
        return;
      }
      setFeedback({
        provider,
        kind: 'error',
        text: getErrorMessage(err, t('manageShop.deliverySettings.errors.toggleFailed')),
      });
    } finally {
      finish();
    }
  };

  const handleDeactivate = async (provider: DeliveryProvider) => {
    const config = PROVIDER_CONFIGS.find((item) => item.provider === provider);
    begin(provider, 'toggle');
    try {
      await orderApi.deactivateDeliveryProvider(provider);
      setFeedback({
        provider,
        kind: 'success',
        text: t('manageShop.deliverySettings.success.deactivated', { provider: config?.display_name }),
      });
      await reload();
    } catch (err) {
      setFeedback({
        provider,
        kind: 'error',
        text: getErrorMessage(err, t('manageShop.deliverySettings.errors.toggleFailed')),
      });
    } finally {
      finish();
    }
  };

  const handleSetAiDefault = async (provider: DeliveryProvider) => {
    const config = PROVIDER_CONFIGS.find((item) => item.provider === provider);
    begin(provider, 'ai-set');
    try {
      await orderApi.setAiDefaultDeliveryProvider(provider);
      setFeedback({
        provider,
        kind: 'success',
        text: t('manageShop.deliverySettings.aiDefaultSuccess', { provider: config?.display_name }),
      });
      await reload();
    } catch (err) {
      setFeedback({
        provider,
        kind: 'error',
        text: getErrorMessage(err, t('manageShop.deliverySettings.errors.aiDefaultFailed')),
      });
    } finally {
      finish();
    }
  };

  const handleClearAiDefault = async (provider: DeliveryProvider) => {
    const config = PROVIDER_CONFIGS.find((item) => item.provider === provider);
    begin(provider, 'ai-clear');
    try {
      await api.clearAiDefault(provider);
      setFeedback({
        provider,
        kind: 'success',
        text: t('manageShop.deliverySettings.providers.clearDefaultSuccess', { provider: config?.display_name }),
      });
      await reload();
    } catch (err) {
      setFeedback({
        provider,
        kind: 'error',
        text: getErrorMessage(err, t('manageShop.deliverySettings.providers.errors.clearDefaultFailed')),
      });
    } finally {
      finish();
    }
  };

  const handleDisconnect = async (provider: DeliveryProvider) => {
    const config = PROVIDER_CONFIGS.find((item) => item.provider === provider);
    begin(provider, 'disconnect');
    try {
      await orderApi.disconnectDeliveryProvider(provider);
      setFeedback({
        provider,
        kind: 'success',
        text: t('manageShop.deliverySettings.success.disconnected', { provider: config?.display_name }),
      });
      if (drawerFor === provider) setDrawerFor(null);
      await reload();
    } catch (err) {
      setFeedback({
        provider,
        kind: 'error',
        text: getErrorMessage(err, t('manageShop.deliverySettings.errors.disconnectFailed')),
      });
    } finally {
      finish();
    }
  };

  const openDrawer = (provider: DeliveryProvider) => {
    setFeedback(null);
    setDrawerFor(provider);
  };

  const cardFeedback = feedback ? (
    <p
      role={feedback.kind === 'error' ? 'alert' : 'status'}
      className={`flex items-start gap-1.5 text-sm ${
        feedback.kind === 'error' ? 'text-em-danger-700' : 'text-em-success-700'
      }`}
      data-testid={`provider-feedback-${feedback.provider}`}
    >
      {feedback.kind === 'error'
        ? <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        : <Check className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />}
      <span>{feedback.text}</span>
    </p>
  ) : null;

  return (
    <MotionConfig reducedMotion="user">
      <div className="space-y-4">
        {PROVIDER_CONFIGS.map((config) => {
          const providerStatus = providers.find((p) => p.provider === config.provider);
          const isConnected = providerStatus?.is_connected || false;
          const activationStatus = normalizeActivationStatus(providerStatus);
          const isAiDefault = isProviderAiDefault(providerStatus);
          const missing = getProviderMissing(providerStatus);
          const pickupSummary = getPickupSummary(providerStatus);
          const lastTestedValue = providerStatus?.last_validated_at ?? null;
          const ProviderIcon = PROVIDER_ICONS[config.provider];
          const showFeedback = feedback?.provider === config.provider ? cardFeedback : null;

          return (
            <div key={config.provider} className="rounded-xl border border-em-border bg-em-bg-surface p-6">
              {/* Identity + record-level signal chips (§8: label + icon, never colour alone). */}
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-4">
                  <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-em-violet-100 text-em-violet-700">
                    <ProviderIcon className="h-6 w-6" aria-hidden="true" />
                  </div>
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-lg font-semibold text-em-text-primary">{config.display_name}</h3>
                      {isAiDefault && (
                        <span
                          className="inline-flex items-center gap-1 rounded-full bg-em-violet-100 px-2 py-0.5 text-xs font-semibold text-em-violet-700"
                          data-testid={`ai-default-badge-${config.provider}`}
                        >
                          <Star className="h-3 w-3 fill-current" aria-hidden="true" />
                          {t('manageShop.deliverySettings.aiDefaultBadge')}
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-sm text-em-text-secondary">{config.description}</p>
                    {isConnected && (
                      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
                        <span className="inline-flex items-center gap-1.5 text-xs text-em-text-secondary">
                          <Check className="h-3.5 w-3.5 text-em-success-700" aria-hidden="true" />
                          {t('manageShop.deliverySettings.connected')}
                        </span>
                        {lastTestedValue ? (
                          <span className="em-tabular text-xs text-em-text-secondary">
                            {t('manageShop.deliverySettings.lastTested', { date: new Date(lastTestedValue).toLocaleDateString() })}
                          </span>
                        ) : (
                          <span className="text-xs text-em-text-secondary">
                            {t('manageShop.deliverySettings.providers.notTested')}
                          </span>
                        )}
                        {(config.provider === 'pathao' || config.provider === 'redx') ? (
                          <span data-testid={`${config.provider}-environment`} className="text-xs font-medium text-em-violet-700">
                            {t(providerStatus?.is_sandbox
                              ? 'manageShop.deliverySettings.providers.environmentSandbox'
                              : 'manageShop.deliverySettings.providers.environmentProduction')}
                          </span>
                        ) : (
                          <span
                            data-testid="steadfast-environment"
                            className="text-xs font-medium text-em-text-secondary"
                            title={t('manageShop.deliverySettings.providers.steadfastNoSandbox')}
                          >
                            {t('manageShop.deliverySettings.providers.environmentProduction')}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                </div>

                <span
                  data-testid={`activation-status-${config.provider}`}
                  className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-3 py-1 text-xs font-medium ${ACTIVATION_STATUS_CLASSES[activationStatus]}`}
                >
                  {activationStatus === 'ACTIVE'
                    ? <Check className="h-3.5 w-3.5" aria-hidden="true" />
                    : <AlertCircle className="h-3.5 w-3.5" aria-hidden="true" />}
                  {t(ACTIVATION_STATUS_LABELS[activationStatus])}
                </span>
              </div>

              {/* Pickup strip + activation error (record-level, inline-first §17). */}
              {isConnected && (
                <div className="mt-4 rounded-lg border border-em-border bg-em-bg-muted px-4 py-3">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <p className="text-xs font-semibold text-em-text-secondary">
                        {t('manageShop.deliverySettings.pickupDetails')}
                      </p>
                      {pickupSummary ? (
                        <p className="mt-1 text-sm text-em-text-primary" data-testid={`pickup-summary-${config.provider}`}>
                          {[pickupSummary.display_name, pickupSummary.area_name, pickupSummary.address].filter(Boolean).join(' · ')}
                        </p>
                      ) : (
                        <p className="mt-1 text-sm text-em-sunlight-700" data-testid={`pickup-missing-${config.provider}`}>
                          {t('manageShop.deliverySettings.pickupMissing')}
                        </p>
                      )}
                      {providerStatus?.activation_error && (
                        <p className="mt-2 flex items-start gap-1.5 text-sm text-em-danger-700" role="alert">
                          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                          <span>{providerStatus.activation_error}</span>
                        </p>
                      )}
                    </div>
                    {missing.length > 0 && (
                      <EmButton
                        variant="ghost"
                        className={`shrink-0 self-start justify-start px-2 text-sm font-semibold ${FOCUS_RING}`}
                        onClick={() => routeToPickup({
                          provider: config.provider,
                          missing,
                          pickup: pickupSummary,
                          providerPickupMeta: providerStatus?.provider_pickup_meta ?? null,
                        })}
                      >
                        {t('manageShop.deliverySettings.completePickupDetails')}
                      </EmButton>
                    )}
                  </div>
                </div>
              )}

              {/* Capability truth — testids live here on the card, never duplicated in the drawer. */}
              {providerStatus?.capabilities && (
                <details
                  data-testid={`provider-capabilities-${config.provider}`}
                  className="mt-4 rounded-lg border border-em-border bg-em-bg-surface px-4 py-3"
                >
                  <summary className={`min-h-11 cursor-pointer text-sm font-semibold text-em-text-primary ${FOCUS_RING}`}>
                    {t('manageShop.deliverySettings.capabilities.title')}
                    <span className="ml-2 text-xs font-medium font-normal text-em-sunlight-700">
                      {t(`manageShop.deliverySettings.capabilities.level.${CAPABILITY_LEVEL_KEYS[providerStatus.capabilities.ceiling] || 'unknown'}`)}
                    </span>
                  </summary>
                  <dl className="mt-3 space-y-2">
                    {CAPABILITY_OPERATIONS.map((operation) => {
                      const entry = getCapabilityEntry(providerStatus.capabilities, operation);
                      if (!entry) return null;
                      const tone = entry.level === 'UNSUPPORTED'
                        ? 'text-em-danger-700'
                        : entry.level === 'UNKNOWN'
                          ? 'text-em-sunlight-700'
                          : 'text-em-text-primary';
                      return (
                        <div key={operation} className="flex flex-col gap-1 border-t border-em-border pt-2 first:border-t-0 first:pt-0 sm:flex-row sm:items-start sm:justify-between">
                          <dt className="text-xs font-medium text-em-text-secondary">
                            {t(`manageShop.deliverySettings.capabilities.operation.${operation}`)}
                          </dt>
                          <dd className="text-xs sm:max-w-[60%] sm:text-right">
                            <span className={`font-semibold ${tone}`} data-testid={`capability-${config.provider}-${operation}`}>
                              {t(`manageShop.deliverySettings.capabilities.level.${CAPABILITY_LEVEL_KEYS[entry.level] || 'unknown'}`)}
                            </span>
                            {entry.reason_code && (
                              <p className="mt-0.5 text-em-text-secondary">
                                {t(`manageShop.deliverySettings.capabilities.reason.${entry.reason_code}`, { defaultValue: '' })}
                              </p>
                            )}
                            {entry.manual_step_code && (
                              <p className="mt-0.5 text-em-text-secondary">
                                {t(`manageShop.deliverySettings.capabilities.manualStep.${entry.manual_step_code}`, { defaultValue: '' })}
                              </p>
                            )}
                          </dd>
                        </div>
                      );
                    })}
                  </dl>
                  <p className="mt-3 text-xs text-em-text-secondary">
                    {providerStatus.capabilities.last_verified_at
                      ? t('manageShop.deliverySettings.capabilities.lastVerified', { date: new Date(providerStatus.capabilities.last_verified_at).toLocaleDateString() })
                      : t('manageShop.deliverySettings.capabilities.neverVerified')}
                  </p>
                </details>
              )}

              {/* One contextual primary action per card: Connect (idle) / Manage (wired). */}
              <div className="mt-6 flex flex-wrap items-center gap-3">
                {showFeedback}
                <span className="ml-auto">
                  {!isConnected ? (
                    <EmButton
                      variant="primary"
                      onClick={() => openDrawer(config.provider)}
                      className="gap-2"
                      data-testid={`connect-${config.provider}`}
                    >
                      <PlugZap className="h-4 w-4" aria-hidden="true" />
                      {t('common.connect')}
                    </EmButton>
                  ) : (
                    <EmButton
                      variant="primary"
                      onClick={() => openDrawer(config.provider)}
                      className="gap-2"
                      data-testid={`manage-${config.provider}`}
                    >
                      <Settings2 className="h-4 w-4" aria-hidden="true" />
                      {t('manageShop.deliverySettings.providers.manage')}
                    </EmButton>
                  )}
                </span>
              </div>
            </div>
          );
        })}

        {drawerFor && (() => {
          const config = PROVIDER_CONFIGS.find((item) => item.provider === drawerFor);
          const status = providers.find((item) => item.provider === drawerFor);
          if (!config || !status) return null;
          return (
            <ProviderDrawer
              config={config}
              status={status}
              activationStatus={normalizeActivationStatus(status)}
              isAiDefault={isProviderAiDefault(status)}
              missing={getProviderMissing(status)}
              pickupSummary={getPickupSummary(status)}
              pending={pending && pending.provider === drawerFor ? pending.kind : null}
              feedback={feedback && feedback.provider === drawerFor
                ? { kind: feedback.kind, text: feedback.text }
                : null}
              onClose={() => setDrawerFor(null)}
              onConnect={handleConnect}
              onTest={handleTest}
              onActivate={handleActivate}
              onDeactivate={handleDeactivate}
              onSetAiDefault={handleSetAiDefault}
              onClearAiDefault={handleClearAiDefault}
              onDisconnect={handleDisconnect}
              onCompletePickup={routeToPickup}
            />
          );
        })()}

        {/* Fallback pickup flow — used only when the shell has not wired tab routing. */}
        {pickupFallback && (
          <PickupDetailsModal
            provider={pickupFallback.provider}
            missing={pickupFallback.missing}
            initialPickup={pickupFallback.pickup}
            providerPickupMeta={pickupFallback.providerPickupMeta}
            onClose={() => setPickupFallback(null)}
            onSaved={async () => {
              await reload();
              const config = PROVIDER_CONFIGS.find((item) => item.provider === pickupFallback.provider);
              setFeedback({
                provider: pickupFallback.provider,
                kind: 'success',
                text: t('manageShop.deliverySettings.pickupSaved', { provider: config?.display_name }),
              });
            }}
          />
        )}
      </div>
    </MotionConfig>
  );
}
