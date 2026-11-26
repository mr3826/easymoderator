/**
 * Delivery Settings — three-tab Configuration/editor redesign (mission 2026-11-24).
 *
 * Tabs: Courier Providers / Pickup Locations / Delivery Charges & Policies.
 * The page-level signal header is retired (header-removal C1/C2/C7): the sticky
 * AppBar owns the visible title, the h1 stays sr-only, per-provider status lives
 * on the provider cards, and the unsaved-charges indicator rides the tab strip.
 * General, area and weight pricing still live in ONE settings
 * object behind ONE PUT — the snapshot semantics, save-scope copy and weight-tier
 * validation are unchanged from the pre-tab page; only the affordance now sits in
 * the Charges tab. Providers/pickup mutations reload from the server so no success
 * is ever claimed before the server confirms it; unsaved charges edits are never
 * overwritten by that reload.
 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, X, AlertCircle } from 'lucide-react';
import { MotionConfig } from 'motion/react';
import * as orderApi from '@/api/domains/order';
import { PageHeader } from './dashboard/PageHeader';
import { getErrorMessage } from '@shared/lib/http/errors';
import ProvidersTab from './delivery/ProvidersTab';
import PickupTab from './delivery/PickupTab';
import { ChargesTab } from './delivery/ChargesTab';
import type {
  DeliveryProvider,
  DeliveryProviderStatus,
  DeliveryShopSettings,
  PickupLocation,
  PickupLocationSummary,
} from '@/api/types/order';

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

type DeliveryTab = 'providers' | 'pickup' | 'charges';

const TABS: { id: DeliveryTab; labelKey: string }[] = [
  { id: 'providers', labelKey: 'manageShop.deliverySettings.tabs.providers' },
  { id: 'pickup', labelKey: 'manageShop.deliverySettings.tabs.pickup' },
  { id: 'charges', labelKey: 'manageShop.deliverySettings.tabs.charges' },
];

interface PickupTargetPayload {
  provider: DeliveryProvider;
  missing: string[];
  pickup: PickupLocationSummary | null;
  providerPickupMeta: DeliveryProviderStatus['provider_pickup_meta'];
}

export default function DeliverySettings() {
  const { t } = useTranslation();
  const [providers, setProviders] = useState<DeliveryProviderStatus[]>([]);
  const [deliverySettings, setDeliverySettings] = useState<DeliveryShopSettings>(DEFAULT_DELIVERY_SETTINGS);
  const [pickupLocations, setPickupLocations] = useState<PickupLocation[]>([]);
  const [loading, setLoading] = useState(true);
  // The full-page skeleton is for the FIRST load only. Post-mutation reloads
  // refresh silently so the active tab — open drawer, fetched provider stores,
  // selection state — is never unmounted mid-workflow.
  const [booted, setBooted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);
  // Snapshot of the charges as last persisted, exactly as the pre-tab page
  // computed them: the Saved confirmation drops the moment the merchant edits.
  const [savedChargesSnapshot, setSavedChargesSnapshot] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<DeliveryTab>('providers');
  const [pickupFocus, setPickupFocus] = useState<DeliveryProvider | null>(null);

  const chargesSaved =
    savedChargesSnapshot !== null && savedChargesSnapshot === JSON.stringify(deliverySettings);
  const chargesDirty = !chargesSaved;

  // Server reloads must never clobber unsaved charges edits (Guardrails §2:
  // preserve draft content when work continues).
  const dirtyRef = useRef(false);
  // The FIRST successful load must hydrate persisted charges unconditionally —
  // nothing of the merchant's can be dirty yet, and refusing to hydrate there
  // would silently show defaults and let a save PUT them over real config
  // (A6 BLOCK-2). Draft-preservation applies to BACKGROUND refreshes only.
  const firstLoadRef = useRef(true);
  useEffect(() => {
    dirtyRef.current = chargesDirty;
  }, [chargesDirty]);

  useEffect(() => {
    if (!chargesDirty) return undefined;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [chargesDirty]);

  useEffect(() => {
    void loadDeliverySettings();
  }, []);

  const loadDeliverySettings = async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await orderApi.getDeliverySettings();
      setProviders(data.providers);
      if (firstLoadRef.current || !dirtyRef.current) {
        const persisted = applyDefaults(data.settings);
        setDeliverySettings(persisted);
        // A freshly loaded page IS the saved state — the snapshot seeds here so
        // the unsaved indicator never lies before the merchant has edited.
        setSavedChargesSnapshot(JSON.stringify(persisted));
      }
      // The unconditional-hydration guarantee applies only to a SUCCESSFUL
      // first load (A8b/A9b): after a failed first load we stay in
      // "never hydrated" mode so the next successful reload still hydrates
      // persisted charges rather than trusting a dirty-by-default guard.
      firstLoadRef.current = false;
      if (Array.isArray(data.pickup_locations)) {
        setPickupLocations(data.pickup_locations);
      }
    } catch (err: unknown) {
      setError(getErrorMessage(err, t('manageShop.deliverySettings.errors.loadFailed')));
      console.error('Failed to load delivery settings:', err);
    } finally {
      setLoading(false);
      setBooted(true);
    }
  };

  const handleChangeSettings = useCallback((next: DeliveryShopSettings) => {
    setDeliverySettings(next);
  }, []);

  const handleSaveSettings = useCallback(async () => {
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
      const persisted = applyDefaults(deliverySettings);
      setDeliverySettings(persisted);
      setSavedChargesSnapshot(JSON.stringify(persisted));
      setSuccessMessage(t('manageShop.deliverySettings.success.settingsSaved'));
    } catch (err: unknown) {
      setError(getErrorMessage(err, t('manageShop.deliverySettings.errors.saveFailed')));
      console.error('Failed to save delivery settings:', err);
    } finally {
      setSavingSettings(false);
    }
  }, [deliverySettings, t]);

  const routeToPickup = useCallback((target: PickupTargetPayload) => {
    setPickupFocus(target.provider);
    setActiveTab('pickup');
  }, []);

  const moveTabFocus = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number | null = null;
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % TABS.length;
    else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + TABS.length) % TABS.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = TABS.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    document.getElementById(`delivery-tab-${TABS[nextIndex].id}`)?.focus();
    setActiveTab(TABS[nextIndex].id);
  };

  if (loading && !booted) {
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

  return (
    <MotionConfig reducedMotion="user">
      <div className="em-delivery min-h-full p-4 md:p-6">
        <div className="mx-auto w-full max-w-[1440px] space-y-6">
          {/* Header-removal C1 amendment (unified title rule): signal badge,
              shop-name breadcrumb and count pills are retired. "Delivery
              Settings" is NOT the AppBar's name ("Delivery"), so the compact
              title stays visible; per-provider status lives on the provider
              cards, COD truth lives in Charges. */}
          <PageHeader title={t('manageShop.deliverySettings.title')} titleMode="compact" />

          {/* Success Message */}
          {successMessage && (
            <div role="status" className="p-4 bg-em-success-100 border border-em-success-700/20 rounded-xl flex items-center gap-2">
              <Check className="w-5 h-5 text-em-success-700" aria-hidden="true" />
              <p className="text-sm text-em-success-700">{successMessage}</p>
              <button
                onClick={() => setSuccessMessage(null)}
                aria-label={t('common.close')}
                className="ml-auto min-h-11 min-w-11 inline-flex items-center justify-center rounded-lg text-em-success-700 hover:text-em-success-700/80 focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-em-focus-light"
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
                className="ml-auto min-h-11 min-w-11 inline-flex items-center justify-center rounded-lg text-em-danger-700 hover:text-em-danger-700/80 focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-em-focus-light"
              >
                <X className="w-4 h-4" aria-hidden="true" />
              </button>
            </div>
          )}

          {/* The tab strip absorbs the header's one carried affordance: the
              amber unsaved-charges indicator rides its right edge (C2/C4). */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div
              role="tablist"
              aria-label={t('manageShop.deliverySettings.tabs.label')}
              className="flex gap-1 overflow-x-auto"
            >
              {TABS.map((tab, index) => (
                <button
                  key={tab.id}
                  id={`delivery-tab-${tab.id}`}
                  type="button"
                  role="tab"
                  data-testid={`delivery-tab-${tab.id}`}
                  aria-selected={activeTab === tab.id}
                  aria-controls={`delivery-panel-${tab.id}`}
                  tabIndex={activeTab === tab.id ? 0 : -1}
                  onClick={() => setActiveTab(tab.id)}
                  onKeyDown={(event) => moveTabFocus(event, index)}
                  className={`shrink-0 rounded-lg px-3 py-2 text-sm font-semibold ${
                    activeTab === tab.id
                      ? 'bg-em-violet-600 text-white'
                      : 'bg-em-bg-surface text-em-text-secondary hover:bg-em-violet-50'
                  }`}
                >
                  {t(tab.labelKey)}
                </button>
              ))}
            </div>
            {chargesDirty && (
              <span
                data-testid="delivery-charges-unsaved"
                className="shrink-0 whitespace-nowrap rounded-full border border-em-sunlight-500/40 bg-em-sunlight-100 px-3 py-1 text-xs font-medium text-em-sunlight-700"
              >
                {t('manageShop.deliverySettings.chargesUnsaved')}
              </span>
            )}
          </div>

          {activeTab === 'providers' && (
            <div role="tabpanel" id="delivery-panel-providers" aria-labelledby="delivery-tab-providers" tabIndex={-1}>
              <ProvidersTab
                providers={providers}
                settings={deliverySettings}
                onMutate={loadDeliverySettings}
                onCompletePickup={routeToPickup}
              />
            </div>
          )}

          {activeTab === 'pickup' && (
            <div role="tabpanel" id="delivery-panel-pickup" aria-labelledby="delivery-tab-pickup" tabIndex={-1}>
              <PickupTab
                providers={providers}
                locations={pickupLocations}
                onMutate={loadDeliverySettings}
                focusProvider={pickupFocus}
                onFocusConsumed={() => setPickupFocus(null)}
              />
            </div>
          )}

          {activeTab === 'charges' && (
            <div role="tabpanel" id="delivery-panel-charges" aria-labelledby="delivery-tab-charges" tabIndex={-1}>
              <ChargesTab
                settings={deliverySettings}
                onChange={handleChangeSettings}
                onSave={handleSaveSettings}
                onDirtyChange={() => {
                  /* dirty state is computed from the shared snapshot; the report exists for shell hooks */
                }}
                isDirty={chargesDirty}
                justSaved={chargesSaved && !savingSettings}
                errors={error}
                applyDefaults={applyDefaults}
              />
            </div>
          )}
        </div>
      </div>
    </MotionConfig>
  );
}
