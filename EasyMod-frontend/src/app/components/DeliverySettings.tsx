import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Truck, Check, X, AlertCircle, Power, TestTube, Star, Package, MapPin } from 'lucide-react';
import { motion, MotionConfig } from 'motion/react';
import * as orderApi from '@/api/domains/order';
import { fadeUp } from '@/lib/motion';
import { EmButton } from './dashboard/EmButton';
import { PageHeader } from './dashboard/PageHeader';
import { useDialogFocus } from './inbox/useDialogFocus';
import { deriveDeliverySignal } from './delivery/derive';
import { authService } from '@/app/lib/auth';
import { getErrorMessage } from '@shared/lib/http/errors';
import type {
  DeliveryActivationStatus,
  DeliveryProvider, 
  DeliveryProviderStatus, 
  DeliveryShopSettings,
  PickupLocationSummary,
  PathaoCredentials, 
  SteadfastCredentials,
  RedxCredentials
} from '@/api/types/order';
import PickupDetailsModal from './PickupDetailsModal';

const ANIMATE = import.meta.env.MODE !== 'test';

interface ProviderConfig {
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

const PROVIDER_CONFIGS: ProviderConfig[] = [
  {
    provider: 'pathao',
    display_name: 'Pathao Courier',
    description: 'Fast and reliable delivery across Bangladesh',
    logo: '🚚',
    fields: [
      {
        name: 'client_id',
        label: 'Client ID',
        type: 'text',
        placeholder: 'Enter your Pathao Client ID',
        required: true
      },
      {
        name: 'client_secret',
        label: 'Client Secret',
        type: 'password',
        placeholder: 'Enter your Pathao Client Secret',
        required: true
      },
      {
        name: 'username',
        label: 'Username (Email)',
        type: 'email',
        placeholder: 'merchant@example.com',
        required: true
      },
      {
        name: 'password',
        label: 'Password',
        type: 'password',
        placeholder: 'Enter your Pathao account password',
        required: true
      }
    ]
  },
  {
    provider: 'steadfast',
    display_name: 'Steadfast Courier',
    description: 'Trusted delivery partner for e-commerce',
    logo: '📦',
    fields: [
      {
        name: 'api_key',
        label: 'API Key',
        type: 'text',
        placeholder: 'Enter your Steadfast API Key',
        required: true
      },
      {
        name: 'secret_key',
        label: 'Secret Key',
        type: 'password',
        placeholder: 'Enter your Steadfast Secret Key',
        required: true
      }
    ]
  },
  {
    provider: 'redx',
    display_name: 'RedX Courier',
    description: 'Nationwide delivery support with RedX tracking',
    logo: '📍',
    fields: [
      {
        name: 'api_key',
        label: 'API Key',
        type: 'password',
        placeholder: 'Enter your RedX API Key',
        required: true
      }
    ]
  }
];

// Capability display order. The server owns the values; the client only
// chooses how to present them, so an unsupported action is never hidden
// silently — it is listed with its reason and the manual alternative.
const CAPABILITY_OPERATIONS = ['coverage', 'rate_quote', 'create_parcel', 'tracking', 'cancel', 'edit'] as const;

const CAPABILITY_LEVEL_KEYS: Record<string, string> = {
  UNSUPPORTED: 'unsupported',
  UNKNOWN: 'unknown',
  IMPLEMENTED_NOT_LIVE_VERIFIED: 'implementedNotLiveVerified',
  LIVE_VERIFIED: 'liveVerified',
};

const DEFAULT_DELIVERY_SETTINGS: DeliveryShopSettings = {
  default_delivery_charge: 60,
  cod_enabled: false,
  cod_charge: 0,
  non_refundable: false,
  area_pricing: [
    { zone: 'inside_dhaka', charge: 60, cod_enabled: false },
    { zone: 'sub_dhaka', charge: 80, cod_enabled: false },
    { zone: 'outside_dhaka', charge: 120, cod_enabled: false }
  ],
  weight_tiers: [
    { from_kg: 0, to_kg: 1, extra_charge: 0 }
  ]
};

const applyDefaults = (settings?: Partial<DeliveryShopSettings> | null): DeliveryShopSettings => {
  const safe = settings || {};
  const areaPricing = Array.isArray(safe.area_pricing) && safe.area_pricing.length > 0
    ? safe.area_pricing
    : DEFAULT_DELIVERY_SETTINGS.area_pricing;
  const weightTiers = Array.isArray(safe.weight_tiers) && safe.weight_tiers.length > 0
    ? safe.weight_tiers
    : DEFAULT_DELIVERY_SETTINGS.weight_tiers;

  return {
    default_delivery_charge: Number.isFinite(Number(safe.default_delivery_charge))
      ? Number(safe.default_delivery_charge)
      : DEFAULT_DELIVERY_SETTINGS.default_delivery_charge,
    cod_enabled: safe.cod_enabled ?? DEFAULT_DELIVERY_SETTINGS.cod_enabled,
    cod_charge: Number.isFinite(Number(safe.cod_charge))
      ? Number(safe.cod_charge)
      : DEFAULT_DELIVERY_SETTINGS.cod_charge,
    non_refundable: safe.non_refundable ?? DEFAULT_DELIVERY_SETTINGS.non_refundable,
    area_pricing: areaPricing.map((entry) => ({
      zone: entry.zone || 'inside_dhaka',
      charge: Number.isFinite(Number(entry.charge)) ? Number(entry.charge) : 0,
      cod_enabled: Boolean(entry.cod_enabled)
    })),
    weight_tiers: weightTiers.map((entry) => ({
      from_kg: Number.isFinite(Number(entry.from_kg)) ? Number(entry.from_kg) : 0,
      to_kg: Number.isFinite(Number(entry.to_kg)) ? Number(entry.to_kg) : 0,
      extra_charge: Number.isFinite(Number(entry.extra_charge)) ? Number(entry.extra_charge) : 0
    }))
  };
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

const INPUT_CLASSES =
  `w-full min-h-11 border border-em-border-strong rounded-lg bg-em-bg-surface px-3 py-2 text-sm text-em-text-primary focus:outline-none ${FOCUS_RING}`;

const normalizeActivationStatus = (status: DeliveryProviderStatus | undefined): DeliveryActivationStatus => {
  const rawStatus = typeof status?.activation_status === 'string'
    ? status.activation_status.toUpperCase() as DeliveryActivationStatus
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

export default function DeliverySettings() {
  const { t } = useTranslation();
  const areaZoneOptions = [
    { value: 'inside_dhaka', label: t('manageShop.deliverySettings.zoneInsideDhaka') },
    { value: 'sub_dhaka', label: t('manageShop.deliverySettings.zoneSubDhaka') },
    { value: 'outside_dhaka', label: t('manageShop.deliverySettings.zoneOutsideDhaka') }
  ];
  const [providers, setProviders] = useState<DeliveryProviderStatus[]>([]);
  const [deliverySettings, setDeliverySettings] = useState<DeliveryShopSettings>(DEFAULT_DELIVERY_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connectingProvider, setConnectingProvider] = useState<DeliveryProvider | null>(null);
  const [disconnectingProvider, setDisconnectingProvider] = useState<DeliveryProvider | null>(null);
  const [testingProvider, setTestingProvider] = useState<DeliveryProvider | null>(null);
  const [togglingProvider, setTogglingProvider] = useState<DeliveryProvider | null>(null);
  const [showCredentialsForm, setShowCredentialsForm] = useState<DeliveryProvider | null>(null);
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [isSandbox, setIsSandbox] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);
  const [settingAiDefaultProvider, setSettingAiDefaultProvider] = useState<DeliveryProvider | null>(null);
  const [pickupModal, setPickupModal] = useState<{
    provider: DeliveryProvider;
    missing: string[];
    pickup: PickupLocationSummary | null;
    providerPickupMeta: DeliveryProviderStatus['provider_pickup_meta'];
  } | null>(null);
  const [disconnectTarget, setDisconnectTarget] = useState<DeliveryProvider | null>(null);
  const disconnectRef = useRef<HTMLDivElement>(null);
  useDialogFocus(disconnectRef, Boolean(disconnectTarget));

  // Load delivery settings on mount
  useEffect(() => {
    void loadDeliverySettings();
  }, []);

  const handleSetAiDefault = async (provider: DeliveryProvider) => {
    try {
      setSettingAiDefaultProvider(provider);
      setError(null);
      setSuccessMessage(null);
      await orderApi.setAiDefaultDeliveryProvider(provider);
      const config = PROVIDER_CONFIGS.find(c => c.provider === provider);
      setSuccessMessage(t('manageShop.deliverySettings.aiDefaultSuccess', { provider: config?.display_name }));
      await loadDeliverySettings();
    } catch (err: any) {
      setError(getErrorMessage(err, t('manageShop.deliverySettings.errors.aiDefaultFailed')));
    } finally {
      setSettingAiDefaultProvider(null);
    }
  };

  const loadDeliverySettings = async () => {
    try {
      setLoading(true);
      setError(null);
      const settings = await orderApi.getDeliverySettings();
      setProviders(settings.providers);
      const pathaoStatus = settings.providers.find((provider) => provider.provider === 'pathao');
      setIsSandbox(pathaoStatus?.is_sandbox === true);
      setDeliverySettings(applyDefaults(settings.settings));
    } catch (err: any) {
      setError(getErrorMessage(err, t('manageShop.deliverySettings.errors.loadFailed')));
      console.error('Failed to load delivery settings:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleSaveSettings = async () => {
    try {
      setSavingSettings(true);
      setError(null);
      setSuccessMessage(null);

      const invalidWeightTier = deliverySettings.weight_tiers.some((tier) => tier.from_kg >= tier.to_kg);
      if (invalidWeightTier) {
        setError(t('manageShop.deliverySettings.errors.invalidWeightTiers'));
        return;
      }

      await orderApi.updateDeliverySettings(deliverySettings);
      setDeliverySettings(applyDefaults(deliverySettings));
      setSuccessMessage(t('manageShop.deliverySettings.success.settingsSaved'));
    } catch (err: any) {
      setError(getErrorMessage(err, t('manageShop.deliverySettings.errors.saveFailed')));
      console.error('Failed to save delivery settings:', err);
    } finally {
      setSavingSettings(false);
    }
  };

  const updateSetting = (key: keyof DeliveryShopSettings, value: any) => {
    setDeliverySettings((prev) => ({
      ...prev,
      [key]: value
    }));
  };

  const updateAreaPricing = (index: number, key: 'zone' | 'charge' | 'cod_enabled', value: any) => {
    setDeliverySettings((prev) => {
      const next = [...prev.area_pricing];
      next[index] = {
        ...next[index],
        [key]: value
      };
      return {
        ...prev,
        area_pricing: next
      };
    });
  };

  const addAreaPricing = () => {
    setDeliverySettings((prev) => ({
      ...prev,
      area_pricing: [
        ...prev.area_pricing,
        { zone: 'inside_dhaka', charge: 0, cod_enabled: false }
      ]
    }));
  };

  const removeAreaPricing = (index: number) => {
    setDeliverySettings((prev) => ({
      ...prev,
      area_pricing: prev.area_pricing.filter((_, idx) => idx !== index)
    }));
  };

  const updateWeightTier = (index: number, key: 'from_kg' | 'to_kg' | 'extra_charge', value: any) => {
    setDeliverySettings((prev) => {
      const next = [...prev.weight_tiers];
      next[index] = {
        ...next[index],
        [key]: value
      };
      return {
        ...prev,
        weight_tiers: next
      };
    });
  };

  const addWeightTier = () => {
    setDeliverySettings((prev) => ({
      ...prev,
      weight_tiers: [
        ...prev.weight_tiers,
        { from_kg: 0, to_kg: 1, extra_charge: 0 }
      ]
    }));
  };

  const removeWeightTier = (index: number) => {
    setDeliverySettings((prev) => ({
      ...prev,
      weight_tiers: prev.weight_tiers.filter((_, idx) => idx !== index)
    }));
  };

  const handleConnect = async (provider: DeliveryProvider) => {
    try {
      setConnectingProvider(provider);
      setError(null);
      setSuccessMessage(null);

      const config = PROVIDER_CONFIGS.find(c => c.provider === provider);
      if (!config) return;

      // Validate all required fields
      for (const field of config.fields) {
        if (field.required && !credentials[field.name]) {
          throw new Error(t('manageShop.deliverySettings.errors.fieldRequired', { field: field.label }));
        }
      }

       await orderApi.connectDeliveryProvider({
        provider,
        credentials: credentials as any,
        is_sandbox: isSandbox
      });

      setSuccessMessage(t('manageShop.deliverySettings.success.connected', { provider: config.display_name }));
      setShowCredentialsForm(null);
      setCredentials({});
      await loadDeliverySettings();
    } catch (err: any) {
      setError(getErrorMessage(err, t('manageShop.deliverySettings.errors.connectFailed')));
      console.error('Failed to connect provider:', err);
    } finally {
      setConnectingProvider(null);
    }
  };

  const handleDisconnect = async (provider: DeliveryProvider) => {
    const config = PROVIDER_CONFIGS.find(c => c.provider === provider);
    try {
      setDisconnectingProvider(provider);
      setError(null);
      setSuccessMessage(null);

       await orderApi.disconnectDeliveryProvider(provider);

      setSuccessMessage(t('manageShop.deliverySettings.success.disconnected', { provider: config?.display_name }));
      await loadDeliverySettings();
    } catch (err: any) {
      setError(getErrorMessage(err, t('manageShop.deliverySettings.errors.disconnectFailed')));
      console.error('Failed to disconnect provider:', err);
    } finally {
      setDisconnectingProvider(null);
    }
  };

  const handleToggle = async (provider: DeliveryProvider, currentStatus: DeliveryActivationStatus) => {
    const activating = currentStatus !== 'ACTIVE';
    try {
      setTogglingProvider(provider);
      setError(null);
      setSuccessMessage(null);

      if (activating) {
        await orderApi.activateDeliveryProvider(provider);
      } else {
        await orderApi.deactivateDeliveryProvider(provider);
      }

      const config = PROVIDER_CONFIGS.find(c => c.provider === provider);
      setSuccessMessage(activating
        ? t('manageShop.deliverySettings.success.activated', { provider: config?.display_name })
        : t('manageShop.deliverySettings.success.deactivated', { provider: config?.display_name }));
      await loadDeliverySettings();
    } catch (err: any) {
      if (activating && isConflictError(err)) {
        const providerStatus = providers.find((item) => item.provider === provider);
        setPickupModal({
          provider,
          missing: getConflictMissing(err, getProviderMissing(providerStatus)),
          pickup: getPickupSummary(providerStatus),
          providerPickupMeta: providerStatus?.provider_pickup_meta ?? null,
        });
        return;
      }
      setError(getErrorMessage(err, t('manageShop.deliverySettings.errors.toggleFailed')));
      console.error('Failed to toggle provider:', err);
    } finally {
      setTogglingProvider(null);
    }
  };

  const handleTest = async (provider: DeliveryProvider) => {
    try {
      setTestingProvider(provider);
      setError(null);
      setSuccessMessage(null);

      await orderApi.testDeliveryConnection(provider);

      const config = PROVIDER_CONFIGS.find(c => c.provider === provider);
      setSuccessMessage(t('manageShop.deliverySettings.success.testSuccess', { provider: config?.display_name }));
    } catch (err: any) {
      setError(getErrorMessage(err, t('manageShop.deliverySettings.errors.testFailed')));
      console.error('Connection test failed:', err);
    } finally {
      setTestingProvider(null);
    }
  };

  const openCredentialsForm = (provider: DeliveryProvider) => {
    setShowCredentialsForm(provider);
    setCredentials({});
    setIsSandbox(providers.find((item) => item.provider === provider)?.is_sandbox === true);
    setError(null);
    setSuccessMessage(null);
  };

  if (loading) {
    return (
      <div className="em-delivery min-h-full p-4 md:p-6">
        <div className="mx-auto w-full max-w-[1440px] space-y-4" aria-label={t('manageShop.deliverySettings.title')}>
          {[0, 1, 2].map((row) => (
            <div key={row} className="animate-pulse space-y-3 rounded-xl border border-em-border bg-em-bg-surface p-6">
              <div className="h-5 w-1/3 rounded bg-em-bg-muted" />
              <div className="h-3 w-2/3 rounded bg-em-bg-muted" />
              <div className="h-9 w-40 rounded bg-em-bg-muted" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  const activeCount = providers.filter((provider) => normalizeActivationStatus(provider) === 'ACTIVE').length;
  const connectedCount = providers.filter((provider) => provider.is_connected).length;
  const signal = deriveDeliverySignal(
    { phase: error ? 'error' : 'ready', providers, activeCount, connectedCount },
    t,
  );
  const shopName = authService.getCurrentShop()?.shop_name || t('manageShop.deliverySettings.title');

  return (
    <MotionConfig reducedMotion="user">
    <div className="em-delivery min-h-full p-4 md:p-6">
      <div className="mx-auto w-full max-w-[1440px] space-y-6">
      {/* Execution-page header (§29): title + signal + factual pills only. */}
      <motion.div variants={fadeUp} initial={ANIMATE ? 'hidden' : false} animate="visible">
        <PageHeader
          title={t('manageShop.deliverySettings.title')}
          breadcrumb={[{ label: shopName }]}
          signal={signal}
          signalTestId="delivery-signal"
          signalAnnounce={false}
          meta={
            <div className="flex flex-wrap items-center gap-2">
              <span className="em-tabular whitespace-nowrap rounded-full border border-em-border bg-em-bg-muted px-3 py-1 text-xs font-medium text-em-text-secondary">
                {t('manageShop.deliverySettings.statuses.active')}: {activeCount}
              </span>
              <span className="em-tabular whitespace-nowrap rounded-full border border-em-border bg-em-bg-muted px-3 py-1 text-xs font-medium text-em-text-secondary">
                {t('manageShop.deliverySettings.connected')}: {connectedCount}
              </span>
              <span className="whitespace-nowrap rounded-full border border-em-border bg-em-bg-muted px-3 py-1 text-xs font-medium text-em-text-secondary">
                {t('manageShop.deliverySettings.enableCOD')}: {deliverySettings.cod_enabled ? t('manageShop.deliverySettings.statuses.active') : t('manageShop.deliverySettings.statuses.notConfigured')}
              </span>
            </div>
          }
        />
      </motion.div>

      {/* Success Message */}
      {successMessage && (
        <div role="status" className="p-4 bg-em-success-100 border border-em-success-700/20 rounded-xl flex items-center gap-2">
          <Check className="w-5 h-5 text-em-success-700" aria-hidden="true" />
          <p className="text-sm text-em-success-700">{successMessage}</p>
          <button
            onClick={() => setSuccessMessage(null)}
            aria-label={t('common.close')}
            className={`ml-auto min-h-11 min-w-11 inline-flex items-center justify-center text-em-success-700 hover:text-em-success-700/80 ${FOCUS_RING}`}
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>
      )}

      {/* Error Message */}
      {error && (
        <div role="alert" className="p-4 bg-em-danger-100 border border-em-danger-700/20 rounded-xl flex items-center gap-2">
          <AlertCircle className="w-5 h-5 text-em-danger-700" aria-hidden="true" />
          <p className="text-sm text-em-danger-700">{error}</p>
          <button
            onClick={() => setError(null)}
            aria-label={t('common.close')}
            className={`ml-auto min-h-11 min-w-11 inline-flex items-center justify-center text-em-danger-700 hover:text-em-danger-700/80 ${FOCUS_RING}`}
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>
      )}

      {/* Delivery Charges */}
      <div className="space-y-6">
        <div className="border border-em-border rounded-xl bg-em-bg-surface p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-em-text-primary">{t('manageShop.deliverySettings.generalSettings')}</h2>
            <EmButton
              variant="primary"
              onClick={handleSaveSettings}
              disabled={savingSettings}
              loading={savingSettings}
              className="gap-2"
            >
              {t('manageShop.deliverySettings.saveSettings')}
            </EmButton>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-em-text-primary mb-1">
                {t('manageShop.deliverySettings.defaultCharge')}
              </label>
              <input
                type="number"
                aria-label={t('manageShop.deliverySettings.defaultCharge')}
                value={deliverySettings.default_delivery_charge}
                onChange={(e) => updateSetting('default_delivery_charge', Number(e.target.value) || 0)}
                className={INPUT_CLASSES}
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-em-text-primary mb-1">
                {t('manageShop.deliverySettings.codCharge')}
              </label>
              <input
                type="number"
                aria-label={t('manageShop.deliverySettings.codCharge')}
                value={deliverySettings.cod_charge}
                onChange={(e) => updateSetting('cod_charge', Number(e.target.value) || 0)}
                disabled={!deliverySettings.cod_enabled}
                className={`${INPUT_CLASSES} disabled:bg-em-bg-muted disabled:text-em-text-disabled`}
              />
            </div>
          </div>

          <div className="mt-4 flex flex-wrap gap-6">
            <label className="inline-flex min-h-11 items-center gap-2 text-sm text-em-text-primary">
              <input
                type="checkbox"
                checked={deliverySettings.cod_enabled}
                onChange={(e) => updateSetting('cod_enabled', e.target.checked)}
                className="h-5 w-5 rounded border-em-border-strong accent-em-violet-600"
              />
              {t('manageShop.deliverySettings.enableCOD')}
            </label>

            <label className="inline-flex min-h-11 items-center gap-2 text-sm text-em-text-primary">
              <input
                type="checkbox"
                checked={deliverySettings.non_refundable}
                onChange={(e) => updateSetting('non_refundable', e.target.checked)}
                className="h-5 w-5 rounded border-em-border-strong accent-em-violet-600"
              />
              {t('manageShop.deliverySettings.nonRefundable')}
            </label>
          </div>
        </div>

        <div className="border border-em-border rounded-xl bg-em-bg-surface p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-em-text-primary">{t('manageShop.deliverySettings.areaBasedPricing')}</h2>
            <button
              onClick={addAreaPricing}
              className={`min-h-11 rounded-lg px-3 text-sm font-semibold text-em-violet-700 hover:bg-em-violet-50 ${FOCUS_RING}`}
            >
              {t('manageShop.deliverySettings.addArea')}
            </button>
          </div>

          <div className="space-y-3">
            {deliverySettings.area_pricing.map((area, index) => (
              <div key={`${area.zone}-${index}`} className="grid grid-cols-1 md:grid-cols-12 gap-3 items-center">
                <div className="md:col-span-4">
                  <select
                    aria-label={`${t('manageShop.deliverySettings.areaBasedPricing')} ${index + 1}`}
                    value={area.zone}
                    onChange={(e) => updateAreaPricing(index, 'zone', e.target.value)}
                    className={INPUT_CLASSES}
                  >
                    {areaZoneOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="md:col-span-4">
                  <input
                    type="number"
                    aria-label={`${t('manageShop.deliverySettings.extraCharge')} ${index + 1}`}
                    value={area.charge}
                    onChange={(e) => updateAreaPricing(index, 'charge', Number(e.target.value) || 0)}
                    className={INPUT_CLASSES}
                    placeholder={t('manageShop.deliverySettings.extraCharge')}
                  />
                </div>
                <div className="md:col-span-3">
                  <label className="inline-flex min-h-11 items-center gap-2 text-sm text-em-text-primary">
                    <input
                      type="checkbox"
                      checked={area.cod_enabled}
                      onChange={(e) => updateAreaPricing(index, 'cod_enabled', e.target.checked)}
                      className="h-5 w-5 rounded border-em-border-strong accent-em-violet-600"
                    />
                    {t('manageShop.deliverySettings.codAllowed')}
                  </label>
                </div>
                <div className="md:col-span-1 flex justify-end">
                  <button
                    onClick={() => removeAreaPricing(index)}
                    className={`min-h-11 min-w-11 inline-flex items-center justify-center text-em-text-secondary hover:text-em-danger-700 ${FOCUS_RING}`}
                    aria-label={t('manageShop.deliverySettings.removeArea')}
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="border border-em-border rounded-xl bg-em-bg-surface p-6">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold text-em-text-primary">{t('manageShop.deliverySettings.weightCharges')}</h2>
              <span
                className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-em-border-strong text-xs font-semibold text-em-text-secondary"
                title={t('manageShop.deliverySettings.weightTierTooltip')}
              >
                ?
              </span>
            </div>
            <button
              onClick={addWeightTier}
              className={`min-h-11 rounded-lg px-3 text-sm font-semibold text-em-violet-700 hover:bg-em-violet-50 ${FOCUS_RING}`}
            >
              {t('manageShop.deliverySettings.addTier')}
            </button>
          </div>

          <div className="mb-4 rounded-lg border border-em-info-700/20 bg-em-info-100 px-4 py-3 text-sm text-em-info-700">
            {t('manageShop.deliverySettings.weightTierInfo')}
          </div>

          <div className="space-y-3">
            {deliverySettings.weight_tiers.map((tier, index) => (
              <div key={`tier-${index}`} className="grid grid-cols-1 md:grid-cols-12 gap-3 items-center">
                <div className="md:col-span-3">
                  <input
                    type="number"
                    aria-label={`${t('manageShop.deliverySettings.weightFrom')} ${index + 1}`}
                    value={tier.from_kg}
                    onChange={(e) => updateWeightTier(index, 'from_kg', Number(e.target.value) || 0)}
                    className={INPUT_CLASSES}
                    placeholder={t('manageShop.deliverySettings.weightFrom')}
                  />
                </div>
                <div className="md:col-span-3">
                  <input
                    type="number"
                    aria-label={`${t('manageShop.deliverySettings.weightTo')} ${index + 1}`}
                    value={tier.to_kg}
                    onChange={(e) => updateWeightTier(index, 'to_kg', Number(e.target.value) || 0)}
                    className={INPUT_CLASSES}
                    placeholder={t('manageShop.deliverySettings.weightTo')}
                  />
                </div>
                <div className="md:col-span-4">
                  <input
                    type="number"
                    aria-label={`${t('manageShop.deliverySettings.extraCharge')} ${index + 1}`}
                    value={tier.extra_charge}
                    onChange={(e) => updateWeightTier(index, 'extra_charge', Number(e.target.value) || 0)}
                    className={INPUT_CLASSES}
                    placeholder={t('manageShop.deliverySettings.extraCharge')}
                  />
                </div>
                <div className="md:col-span-2 flex justify-end">
                  <button
                    onClick={() => removeWeightTier(index)}
                    className={`min-h-11 min-w-11 inline-flex items-center justify-center text-em-text-secondary hover:text-em-danger-700 ${FOCUS_RING}`}
                    aria-label={t('manageShop.deliverySettings.removeTier')}
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))}

            {deliverySettings.weight_tiers.length === 0 && (
              <p className="text-sm text-em-text-secondary">{t('manageShop.deliverySettings.noTiers')}</p>
            )}
          </div>
        </div>
      </div>

      {/* Provider Cards */}
      <div className="space-y-4">
        {PROVIDER_CONFIGS.map((config) => {
          const providerStatus = providers.find(p => p.provider === config.provider);
          const isConnected = providerStatus?.is_connected || false;
          const activationStatus = normalizeActivationStatus(providerStatus);
          const isActive = activationStatus === 'ACTIVE';
          const isAiDefault = isProviderAiDefault(providerStatus);
          const missing = getProviderMissing(providerStatus);
          const pickupSummary = getPickupSummary(providerStatus);
          const isConnecting = connectingProvider === config.provider;
          const isDisconnecting = disconnectingProvider === config.provider;
          const isTesting = testingProvider === config.provider;
          const isToggling = togglingProvider === config.provider;
          const showingForm = showCredentialsForm === config.provider;

          return (
            <div key={config.provider} className="border border-em-border rounded-xl bg-em-bg-surface overflow-hidden">
              {/* Provider Header */}
              <div className="p-6">
                <div className="flex items-start justify-between">
                  <div className="flex items-start gap-4">
                    <div className="w-12 h-12 flex items-center justify-center bg-em-violet-100 text-em-violet-700 rounded-lg">
                      {(() => {
                        const ProviderIcon = PROVIDER_ICONS[config.provider];
                        return <ProviderIcon className="h-6 w-6" aria-hidden="true" />;
                      })()}
                    </div>
                    <div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <h3 className="text-lg font-semibold text-em-text-primary">{config.display_name}</h3>
                        {isAiDefault && (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-em-violet-100 text-em-violet-700">
                            <Star className="w-3 h-3 fill-current" aria-hidden="true" />
                            {t('manageShop.deliverySettings.aiDefaultBadge')}
                          </span>
                        )}
                      </div>
                      <p className="text-sm text-em-text-secondary mt-1">{config.description}</p>
                      {isConnected && (
                        <div className="flex items-center gap-4 mt-2 flex-wrap">
                          <div className="flex items-center gap-1.5">
                            <div className="w-2 h-2 rounded-full bg-em-success-700"></div>
                            <span className="text-xs text-em-text-secondary">{t('manageShop.deliverySettings.connected')}</span>
                          </div>
                          {providerStatus?.last_validated_at && (
                            <span className="em-tabular text-xs text-em-text-secondary">
                              {t('manageShop.deliverySettings.lastTested', { date: new Date(providerStatus.last_validated_at).toLocaleDateString() })}
                            </span>
                          )}
                          {(config.provider === 'pathao' || config.provider === 'redx') && (
                            <span
                              data-testid={`${config.provider}-environment`}
                              className="text-xs font-medium text-em-violet-700"
                            >
                              {providerStatus?.is_sandbox ? 'Sandbox' : 'Production'}
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  </div>

                  <span
                    data-testid={`activation-status-${config.provider}`}
                    className={`inline-flex items-center px-3 py-1 rounded-full text-xs font-medium ${ACTIVATION_STATUS_CLASSES[activationStatus]}`}
                  >
                    {t(ACTIVATION_STATUS_LABELS[activationStatus])}
                  </span>
                </div>

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
                        <button
                          type="button"
                          onClick={() => setPickupModal({
                            provider: config.provider,
                            missing,
                            pickup: pickupSummary,
                            providerPickupMeta: providerStatus?.provider_pickup_meta ?? null,
                          })}
                          className={`shrink-0 self-start min-h-11 text-left text-sm font-semibold text-em-violet-700 hover:text-em-violet-900 hover:underline ${FOCUS_RING}`}
                        >
                          {t('manageShop.deliverySettings.completePickupDetails')}
                        </button>
                      )}
                    </div>
                  </div>
                )}

                {/* Capability truth */}
                {providerStatus?.capabilities && (
                  <details
                    data-testid={`provider-capabilities-${config.provider}`}
                    className="mt-4 rounded-lg border border-em-border bg-em-bg-surface px-4 py-3"
                  >
                    <summary className={`cursor-pointer min-h-11 text-sm font-semibold text-em-text-primary ${FOCUS_RING}`}>
                      {t('manageShop.deliverySettings.capabilities.title')}
                      <span className="ml-2 text-xs font-normal font-medium text-em-sunlight-700">
                        {t(`manageShop.deliverySettings.capabilities.level.${CAPABILITY_LEVEL_KEYS[providerStatus.capabilities.ceiling] || 'unknown'}`)}
                      </span>
                    </summary>
                    <dl className="mt-3 space-y-2">
                      {CAPABILITY_OPERATIONS.map((operation) => {
                        const entry = providerStatus.capabilities?.[operation];
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

                {/* Actions */}
                <div className="flex flex-wrap items-center gap-3 mt-6">
                  {!isConnected && (
                    <EmButton
                      variant="primary"
                      onClick={() => openCredentialsForm(config.provider)}
                      disabled={isConnecting}
                      loading={isConnecting}
                    >
                      {t('common.connect')}
                    </EmButton>
                  )}

                  {isConnected && isActive && !isAiDefault && (
                    <EmButton
                      variant="secondary"
                      onClick={() => void handleSetAiDefault(config.provider)}
                      disabled={settingAiDefaultProvider === config.provider}
                      loading={settingAiDefaultProvider === config.provider}
                      className="gap-2"
                    >
                      <Star className="w-4 h-4" aria-hidden="true" />
                      {t('manageShop.deliverySettings.setAsAiDefault')}
                    </EmButton>
                  )}

                  {isConnected && (
                    <>
                      <EmButton
                        variant={isActive ? 'secondary' : 'primary'}
                        onClick={() => void handleToggle(config.provider, activationStatus)}
                        disabled={isToggling}
                        loading={isToggling}
                        className="gap-2"
                      >
                        <Power className="w-4 h-4" aria-hidden="true" />
                        {isActive ? t('manageShop.deliverySettings.deactivate') : t('manageShop.deliverySettings.activate')}
                      </EmButton>

                      <EmButton
                        variant="secondary"
                        onClick={() => handleTest(config.provider)}
                        disabled={isTesting}
                        loading={isTesting}
                        className="gap-2"
                      >
                        <TestTube className="w-4 h-4" aria-hidden="true" />
                        {t('manageShop.deliverySettings.testConnection')}
                      </EmButton>

                      <EmButton
                        variant="danger"
                        onClick={() => setDisconnectTarget(config.provider)}
                        disabled={isDisconnecting}
                        className="gap-2"
                        data-testid={`disconnect-${config.provider}`}
                      >
                        <X className="w-4 h-4" aria-hidden="true" />
                        {t('common.disconnect')}
                      </EmButton>
                    </>
                  )}
                </div>
              </div>

              {/* Credentials Form */}
              {showingForm && (
                <div className="border-t border-em-border bg-em-bg-muted p-6">
                  <h4 className="text-sm font-semibold text-em-text-primary mb-4">
                    {t('manageShop.deliverySettings.enterCredentials', { provider: config.display_name })}
                  </h4>

                  <div className="space-y-4">
                    {config.fields.map((field) => (
                      <div key={field.name}>
                        <label className="block text-sm font-medium text-em-text-primary mb-1">
                          {field.label}
                          {field.required && <span className="text-em-danger-700 ml-1">*</span>}
                        </label>
                        <input
                          type={field.type}
                          value={credentials[field.name] || ''}
                          onChange={(e) => setCredentials({ ...credentials, [field.name]: e.target.value })}
                          placeholder={field.placeholder}
                          className={INPUT_CLASSES}
                        />
                      </div>
                    ))}

                    {(config.provider === 'pathao' || config.provider === 'redx') && (
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

                    <div className="flex items-center gap-3 pt-2">
                      <EmButton
                        variant="primary"
                        onClick={() => handleConnect(config.provider)}
                        disabled={isConnecting}
                        loading={isConnecting}
                      >
                        {t('manageShop.deliverySettings.saveConnect')}
                      </EmButton>
                      <EmButton
                        variant="secondary"
                        onClick={() => {
                          setShowCredentialsForm(null);
                          setCredentials({});
                        }}
                      >
                        {t('common.cancel')}
                      </EmButton>
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {pickupModal && (
        <PickupDetailsModal
          provider={pickupModal.provider}
          missing={pickupModal.missing}
          initialPickup={pickupModal.pickup}
          providerPickupMeta={pickupModal.providerPickupMeta}
          onClose={() => setPickupModal(null)}
          onSaved={async () => {
            await loadDeliverySettings();
            const config = PROVIDER_CONFIGS.find((item) => item.provider === pickupModal.provider);
            setSuccessMessage(t('manageShop.deliverySettings.pickupSaved', { provider: config?.display_name }));
          }}
        />
      )}

      {disconnectTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-em-midnight-950/60 p-4"
          onClick={(event) => {
            if (event.target === event.currentTarget) setDisconnectTarget(null);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setDisconnectTarget(null);
          }}
        >
          <div
            ref={disconnectRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="delivery-disconnect-title"
            className="w-full max-w-md rounded-xl bg-em-bg-surface p-5 shadow-xl md:p-6"
          >
            <h3 id="delivery-disconnect-title" className="text-lg font-semibold text-em-text-primary">
              {t('manageShop.deliverySettings.disconnectConfirm', {
                provider: PROVIDER_CONFIGS.find((item) => item.provider === disconnectTarget)?.display_name,
              })}
            </h3>
            <p className="mt-2 text-sm text-em-text-secondary">
              {t('manageShop.deliverySettings.disconnectConfirmBody')}
            </p>
            <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:justify-end">
              <EmButton variant="secondary" onClick={() => setDisconnectTarget(null)}>
                {t('common.cancel')}
              </EmButton>
              <EmButton
                variant="danger"
                onClick={() => {
                  const target = disconnectTarget;
                  setDisconnectTarget(null);
                  void handleDisconnect(target);
                }}
                loading={disconnectingProvider === disconnectTarget}
                data-testid="delivery-disconnect-confirm"
              >
                {t('common.disconnect')}
              </EmButton>
            </div>
          </div>
        </div>
      )}
      </div>
    </div>
    </MotionConfig>
  );
}
