/**
 * Delivery Settings — Tab 2 create/edit form for ONE LOCAL pickup location
 * (guardrails §5.6/§12/§16/§17; preservation C1/C3/C5).
 *
 * Reuses the exact field set from `PickupDetailsModal`:
 *   display name · BD phone (`BDPhoneInput`/`BD_PHONE_REGEX`) · address
 *   · area, plus the per-provider directory control:
 *     Pathao   → city → zone → area cascade (native ids)
 *     RedX     → area select mapped to `provider_pickup_meta.delivery_area_id`
 *     Steadfast/manual → free-text area
 *
 * DELIBERATE SCOPE BOUNDARY (§ task "separate actions, never conflate"):
 * this form only CREATEs or UPDATEs the local `pickup_locations` row. It never
 * links a provider store, syncs, creates an external store or activates a
 * courier — those are distinct, explicit actions owned by {@link PickupTab}. On
 * a successful save it hands the saved row + the resolved
 * `ProviderPickupMetadata` back via `onSaved` so the parent can sync/link.
 * Field values are preserved on failure (test-pinned C5) — a failed save never
 * clears the inputs.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, MapPin, Loader2 } from 'lucide-react';
import * as orderApi from '@/api/domains/order';
import type {
  DeliveryLocationOption,
  DeliveryProvider,
  PickupLocation,
  PickupLocationPayload,
  ProviderPickupMetadata,
} from '@/api/types/order';
import { BD_PHONE_REGEX, BDPhoneInput } from '@/shared/components/BDPhoneInput';
import { getErrorMessage } from '@shared/lib/http/errors';
import { optionId, optionLabel, providerId } from '../orders/directoryOptions';

export type PickupFormProvider = DeliveryProvider | 'manual';

export interface PickupFormSaved {
  location: PickupLocation;
  providerMeta: ProviderPickupMetadata;
}

export interface PickupFormProps {
  provider: PickupFormProvider;
  mode: 'create' | 'edit';
  /** Local row to edit (id + existing values); absent for create. */
  initial?: PickupLocation | null;
  /** Existing provider ids so a cascade can be re-hydrated on edit. */
  initialMeta?: ProviderPickupMetadata | null;
  onCancel: () => void;
  /** Called only after the local row is server-persisted. */
  onSaved: (result: PickupFormSaved) => void | Promise<void>;
}

const FOCUS_RING =
  'focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-em-focus-light focus-visible:transition-none';

const SELECT_CLASSES =
  `min-h-11 w-full rounded-md border border-em-border-strong bg-em-bg-surface px-3 text-sm text-em-text-primary outline-none ${FOCUS_RING} disabled:opacity-60`;

/** Reads a persisted pickup row tolerantly (legacy aliases, summary vs full). */
const fieldOf = (
  row: PickupLocation | null | undefined,
  key: 'display_name' | 'phone' | 'address' | 'area_name' | 'city_name' | 'zone_name',
): string => {
  if (!row) return '';
  const legacy = row as PickupLocation & {
    name?: string | null;
    area?: string | null;
    pickup_address?: string | null;
  };
  if (key === 'display_name') return row.display_name ?? row.contact_name ?? legacy.name ?? '';
  if (key === 'area_name') return row.area_name ?? legacy.area ?? '';
  if (key === 'address') return row.address ?? legacy.pickup_address ?? '';
  return row[key] ?? '';
};

export default function PickupForm({
  provider,
  mode,
  initial,
  initialMeta,
  onCancel,
  onSaved,
}: PickupFormProps) {
  const { t, i18n } = useTranslation();
  const meta = initialMeta ?? {};

  const [locationId, setLocationId] = useState(initial?.id ?? '');
  const [pickupName, setPickupName] = useState(fieldOf(initial, 'display_name'));
  const [phone, setPhone] = useState(fieldOf(initial, 'phone'));
  const [address, setAddress] = useState(fieldOf(initial, 'address'));
  const [areaName, setAreaName] = useState(fieldOf(initial, 'area_name'));
  const [cityName, setCityName] = useState(fieldOf(initial, 'city_name'));
  const [zoneName, setZoneName] = useState(fieldOf(initial, 'zone_name'));
  const [cityId, setCityId] = useState(String(meta.city_id ?? ''));
  const [zoneId, setZoneId] = useState(String(meta.zone_id ?? ''));
  const [areaId, setAreaId] = useState(String(meta.area_id ?? meta.delivery_area_id ?? ''));
  const [cities, setCities] = useState<DeliveryLocationOption[]>([]);
  const [zones, setZones] = useState<DeliveryLocationOption[]>([]);
  const [areas, setAreas] = useState<DeliveryLocationOption[]>([]);
  const [loadingLocations, setLoadingLocations] = useState(false);
  const [locationError, setLocationError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{ name?: string; phone?: string; address?: string; area?: string }>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Suppress state updates that resolve after unmount (keeps tests + real
  // teardown from re-entering React's act() flush).
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const showPathaoCascade = provider === 'pathao';
  const showRedxAreas = provider === 'redx';

  const loadPathaoZones = async (nextCityId: string) => {
    if (!nextCityId || !orderApi.getPathaoZones) return;
    try {
      setLoadingLocations(true);
      setLocationError(null);
      const nextZones = await orderApi.getPathaoZones(providerId(nextCityId));
      if (!alive.current) return;
      setZones(nextZones);
    } catch (err) {
      if (alive.current) setLocationError(getErrorMessage(err, t('courier.pickup.errors.locationsLoadFailed')));
    } finally {
      if (alive.current) setLoadingLocations(false);
    }
  };

  const loadPathaoAreas = async (nextZoneId: string) => {
    if (!nextZoneId || !orderApi.getPathaoAreas) return;
    try {
      setLoadingLocations(true);
      setLocationError(null);
      const nextAreas = await orderApi.getPathaoAreas(providerId(nextZoneId));
      if (!alive.current) return;
      setAreas(nextAreas);
    } catch (err) {
      if (alive.current) setLocationError(getErrorMessage(err, t('courier.pickup.errors.locationsLoadFailed')));
    } finally {
      if (alive.current) setLoadingLocations(false);
    }
  };

  // Hydrate the directory for the provider context (Pathao cascade, RedX areas).
  // On EDIT the cascade is chained for the PERSISTED ids (city→zone→area) so the
  // zone AND area selects show the stored values instead of blank placeholders;
  // interactive city/zone changes keep the existing reset-cascade behaviour (§A8).
  useEffect(() => {
    let mounted = true;
    if (showPathaoCascade) {
      if (!orderApi.getPathaoCities) return () => { mounted = false; };
      setLoadingLocations(true);
      setLocationError(null);
      void (async () => {
        try {
          const nextCities = await orderApi.getPathaoCities();
          if (!mounted) return;
          setCities(nextCities);
          const selected = nextCities.find((option) => optionId(option, 'city') === cityId)
            ?? nextCities.find((option) => optionLabel(option, i18n?.language) === cityName);
          if (!selected) return;
          const selectedCityId = optionId(selected, 'city');
          setCityId(selectedCityId);
          setCityName(optionLabel(selected, i18n?.language));
          if (!zoneId || !orderApi.getPathaoZones) return;
          const nextZones = await orderApi.getPathaoZones(providerId(selectedCityId));
          if (!mounted) return;
          setZones(nextZones);
          const zoneMatch = nextZones.find((option) => optionId(option, 'zone') === zoneId)
            ?? nextZones.find((option) => optionLabel(option, i18n?.language) === zoneName);
          if (!zoneMatch) return;
          const hydratedZoneId = optionId(zoneMatch, 'zone');
          setZoneId(hydratedZoneId);
          setZoneName(optionLabel(zoneMatch, i18n?.language));
          if (!areaId || !orderApi.getPathaoAreas) return;
          const nextAreas = await orderApi.getPathaoAreas(providerId(hydratedZoneId));
          if (!mounted) return;
          setAreas(nextAreas);
          const areaMatch = nextAreas.find((option) => optionId(option, 'area') === areaId)
            ?? nextAreas.find((option) => optionLabel(option, i18n?.language) === areaName);
          if (areaMatch) {
            setAreaId(optionId(areaMatch, 'area'));
            setAreaName(optionLabel(areaMatch, i18n?.language));
          }
        } catch (err) {
          if (mounted) setLocationError(getErrorMessage(err, t('courier.pickup.errors.locationsLoadFailed')));
        } finally {
          if (mounted) setLoadingLocations(false);
        }
      })();
    } else if (showRedxAreas) {
      if (!orderApi.getProviderAreas) return () => { mounted = false; };
      setLoadingLocations(true);
      setLocationError(null);
      void orderApi.getProviderAreas('redx')
        .then((nextAreas) => {
          if (!mounted) return;
          setAreas(nextAreas);
          const selected = nextAreas.find((option) => optionId(option, 'area') === areaId)
            ?? nextAreas.find((option) => optionLabel(option, i18n?.language) === areaName);
          if (selected) {
            setAreaId(optionId(selected, 'area'));
            setAreaName(optionLabel(selected, i18n?.language));
          }
        })
        .catch((err) => {
          if (mounted) setLocationError(getErrorMessage(err, t('courier.pickup.errors.locationsLoadFailed')));
        })
        .finally(() => {
          if (mounted) setLoadingLocations(false);
        });
    }
    return () => {
      mounted = false;
    };
    // Re-run only when the provider directory context changes.
  }, [provider]);

  const handleCityChange = (value: string) => {
    const selected = cities.find((option) => optionId(option, 'city') === value);
    setCityId(value);
    setCityName(selected ? optionLabel(selected, i18n?.language) : '');
    setZoneId('');
    setZoneName('');
    setAreaId('');
    setAreaName('');
    setZones([]);
    setAreas([]);
    void loadPathaoZones(value);
  };

  const handleZoneChange = (value: string) => {
    const selected = zones.find((option) => optionId(option, 'zone') === value);
    setZoneId(value);
    setZoneName(selected ? optionLabel(selected, i18n?.language) : '');
    setAreaId('');
    setAreaName('');
    setAreas([]);
    void loadPathaoAreas(value);
  };

  const handleAreaChange = (value: string) => {
    const selected = areas.find((option) => optionId(option, 'area') === value);
    setAreaId(value);
    setAreaName(selected ? optionLabel(selected, i18n?.language) : '');
  };

  const validate = (): boolean => {
    const next: typeof fieldErrors = {};
    if (!pickupName.trim()) next.name = t('manageShop.deliverySettings.errors.fieldRequired', { field: t('courier.pickup.name') });
    if (!phone.trim()) next.phone = t('manageShop.deliverySettings.errors.fieldRequired', { field: t('courier.pickup.phone') });
    else if (!BD_PHONE_REGEX.test(phone)) next.phone = t('common.bdPhoneInvalid');
    if (!address.trim()) next.address = t('manageShop.deliverySettings.errors.fieldRequired', { field: t('courier.pickup.address') });
    if (!areaName.trim()) next.area = t('manageShop.deliverySettings.errors.fieldRequired', { field: t('courier.pickup.area') });
    setFieldErrors(next);
    return Object.keys(next).length === 0;
  };

  const handleSubmit = async () => {
    if (saving) return;
    if (!validate()) return;

    const payload: PickupLocationPayload = {
      display_name: pickupName.trim(),
      contact_name: pickupName.trim(),
      phone: phone.trim(),
      address: address.trim(),
      area_name: areaName.trim(),
      ...(cityName ? { city_name: cityName } : {}),
      ...(zoneName ? { zone_name: zoneName } : {}),
    };
    const providerMeta: ProviderPickupMetadata = {};
    if (provider === 'pathao') {
      if (cityId) providerMeta.city_id = providerId(cityId);
      if (zoneId) providerMeta.zone_id = providerId(zoneId);
      if (areaId) providerMeta.area_id = providerId(areaId);
    } else if (provider === 'redx' && areaId) {
      providerMeta.delivery_area_id = providerId(areaId);
    }

    try {
      setSaving(true);
      setError(null);
      const saved = locationId
        ? await orderApi.updatePickupLocation(locationId, payload)
        : await orderApi.createPickupLocation(payload);
      if (!alive.current) return;
      if (!locationId && saved?.id) setLocationId(saved.id);
      await onSaved({ location: saved, providerMeta });
    } catch (err) {
      // Preserve every entered value (§C5) — only surface the failure inline.
      if (alive.current) setError(getErrorMessage(err, t('manageShop.deliverySettings.pickup.errors.saveFailed')));
    } finally {
      if (alive.current) setSaving(false);
    }
  };

  const isFreeTextArea = provider === 'steadfast' || provider === 'manual';
  const areaOptions = useMemo(() => areas, [areas]);

  return (
    <div
      className="space-y-4 rounded-xl border border-em-border bg-em-bg-muted p-4 sm:p-5"
      data-testid="pickup-form"
      role="group"
      aria-label={mode === 'edit'
        ? t('manageShop.deliverySettings.pickup.editHeading', { provider: t(`manageShop.deliverySettings.pickup.providers.${provider}`) })
        : t('manageShop.deliverySettings.pickup.createHeading', { provider: t(`manageShop.deliverySettings.pickup.providers.${provider}`) })}
    >
      <div className="flex items-center gap-2">
        <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-em-violet-100 text-em-violet-700">
          <MapPin className="h-4 w-4" aria-hidden="true" />
        </span>
        <h4 className="text-sm font-semibold text-em-text-primary">
          {mode === 'edit'
            ? t('manageShop.deliverySettings.pickup.editHeading', { provider: t(`manageShop.deliverySettings.pickup.providers.${provider}`) })
            : t('manageShop.deliverySettings.pickup.createHeading', { provider: t(`manageShop.deliverySettings.pickup.providers.${provider}`) })}
        </h4>
      </div>

      {(error || locationError) && (
        <div className="flex items-start gap-2 rounded-lg border border-em-danger-700/20 bg-em-danger-100 px-3 py-2 text-sm text-em-danger-700" role="alert" data-testid="pickup-form-error">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{error ?? locationError}</span>
        </div>
      )}

      {/* Name */}
      <label className="block">
        <span className="mb-1.5 block text-sm font-medium text-em-text-primary">
          {t('courier.pickup.name')} <span className="text-em-danger-700" aria-hidden="true">*</span>
        </span>
        <input
          type="text"
          value={pickupName}
          onChange={(event) => setPickupName(event.target.value)}
          placeholder={t('courier.pickup.namePlaceholder')}
          autoComplete="organization"
          aria-required="true"
          aria-invalid={fieldErrors.name ? true : undefined}
          aria-describedby={fieldErrors.name ? 'pickup-form-name-error' : undefined}
          className={`min-h-11 w-full rounded-md border border-em-border-strong bg-em-bg-surface px-3 text-sm text-em-text-primary outline-none ${FOCUS_RING} ${fieldErrors.name ? 'border-em-danger-700' : ''}`}
          data-testid="pickup-form-name"
        />
        {fieldErrors.name && (
          <p id="pickup-form-name-error" role="alert" className="mt-1 text-xs text-em-danger-700">{fieldErrors.name}</p>
        )}
      </label>

      {/* Phone (BD) */}
      <BDPhoneInput
        id="pickup-form-phone"
        label={t('courier.pickup.phone')}
        value={phone}
        onChange={setPhone}
        required
        error={fieldErrors.phone}
      />

      {/* Address */}
      <label className="block">
        <span className="mb-1.5 block text-sm font-medium text-em-text-primary">
          {t('courier.pickup.address')} <span className="text-em-danger-700" aria-hidden="true">*</span>
        </span>
        <textarea
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          placeholder={t('courier.pickup.addressPlaceholder')}
          rows={3}
          aria-required="true"
          aria-invalid={fieldErrors.address ? true : undefined}
          aria-describedby={fieldErrors.address ? 'pickup-form-address-error' : undefined}
          className={`min-h-11 w-full rounded-md border border-em-border-strong bg-em-bg-surface px-3 py-2 text-sm text-em-text-primary outline-none ${FOCUS_RING} ${fieldErrors.address ? 'border-em-danger-700' : ''}`}
          data-testid="pickup-form-address"
        />
        {fieldErrors.address && (
          <p id="pickup-form-address-error" role="alert" className="mt-1 text-xs text-em-danger-700">{fieldErrors.address}</p>
        )}
      </label>

      {/* Provider-specific directory + area */}
      {showPathaoCascade && (
        <div className="grid gap-4 sm:grid-cols-3">
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-em-text-primary">{t('courier.pickup.city')}</span>
            <select
              aria-label={t('courier.pickup.city')}
              value={cityId}
              onChange={(event) => handleCityChange(event.target.value)}
              disabled={loadingLocations && cities.length === 0}
              className={SELECT_CLASSES}
              data-testid="pickup-form-city"
            >
              <option value="">{t('courier.pickup.selectCity')}</option>
              {cities.map((option) => (
                <option key={optionId(option, 'city')} value={optionId(option, 'city')}>
                  {optionLabel(option, i18n?.language)}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-em-text-primary">{t('courier.pickup.zone')}</span>
            <select
              aria-label={t('courier.pickup.zone')}
              value={zoneId}
              onChange={(event) => handleZoneChange(event.target.value)}
              disabled={!cityId || (loadingLocations && zones.length === 0)}
              className={SELECT_CLASSES}
              data-testid="pickup-form-zone"
            >
              <option value="">{t('courier.pickup.selectZone')}</option>
              {zones.map((option) => (
                <option key={optionId(option, 'zone')} value={optionId(option, 'zone')}>
                  {optionLabel(option, i18n?.language)}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-em-text-primary">
              {t('courier.pickup.area')} <span className="text-em-danger-700" aria-hidden="true">*</span>
            </span>
            <select
              aria-label={t('courier.pickup.area')}
              value={areaId}
              onChange={(event) => handleAreaChange(event.target.value)}
              disabled={!zoneId || (loadingLocations && areaOptions.length === 0)}
              aria-invalid={fieldErrors.area ? true : undefined}
              aria-describedby={fieldErrors.area ? 'pickup-form-area-error' : undefined}
              className={`${SELECT_CLASSES} ${fieldErrors.area ? 'border-em-danger-700' : ''}`}
              data-testid="pickup-form-area"
            >
              <option value="">{t('courier.pickup.selectArea')}</option>
              {areaOptions.map((option) => (
                <option key={optionId(option, 'area')} value={optionId(option, 'area')}>
                  {optionLabel(option, i18n?.language)}
                </option>
              ))}
            </select>
            {fieldErrors.area && !areaId && (
              <p id="pickup-form-area-error" role="alert" className="mt-1 text-xs text-em-danger-700">{fieldErrors.area}</p>
            )}
          </label>
        </div>
      )}

      {showRedxAreas && (
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-em-text-primary">
            {t('courier.pickup.area')} <span className="text-em-danger-700" aria-hidden="true">*</span>
          </span>
          <select
            aria-label={t('courier.pickup.area')}
            value={areaId}
            onChange={(event) => handleAreaChange(event.target.value)}
            disabled={loadingLocations && areaOptions.length === 0}
            aria-invalid={fieldErrors.area ? true : undefined}
            aria-describedby={fieldErrors.area ? 'pickup-form-area-error' : undefined}
            className={`${SELECT_CLASSES} ${fieldErrors.area ? 'border-em-danger-700' : ''}`}
            data-testid="pickup-form-area"
          >
            <option value="">{t('courier.pickup.selectArea')}</option>
            {areaOptions.map((option) => (
              <option key={optionId(option, 'area')} value={optionId(option, 'area')}>
                {optionLabel(option, i18n?.language)}
              </option>
            ))}
          </select>
          {fieldErrors.area && (
            <p id="pickup-form-area-error" role="alert" className="mt-1 text-xs text-em-danger-700">{fieldErrors.area}</p>
          )}
        </label>
      )}

      {isFreeTextArea && (
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-em-text-primary">
            {t('courier.pickup.area')} <span className="text-em-danger-700" aria-hidden="true">*</span>
          </span>
          <input
            type="text"
            value={areaName}
            onChange={(event) => setAreaName(event.target.value)}
            placeholder={t('courier.pickup.areaPlaceholder')}
            aria-required="true"
            aria-invalid={fieldErrors.area ? true : undefined}
            aria-describedby={fieldErrors.area ? 'pickup-form-area-error' : undefined}
            className={`min-h-11 w-full rounded-md border border-em-border-strong bg-em-bg-surface px-3 text-sm text-em-text-primary outline-none ${FOCUS_RING} ${fieldErrors.area ? 'border-em-danger-700' : ''}`}
            data-testid="pickup-form-area"
          />
          {fieldErrors.area && (
            <p id="pickup-form-area-error" role="alert" className="mt-1 text-xs text-em-danger-700">{fieldErrors.area}</p>
          )}
        </label>
      )}

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          className={`min-h-11 rounded-lg border border-em-border-strong bg-em-bg-surface px-4 text-sm font-semibold text-em-text-primary hover:bg-em-bg-muted ${FOCUS_RING}`}
          data-testid="pickup-form-cancel"
        >
          {t('common.cancel')}
        </button>
        <button
          type="button"
          onClick={() => void handleSubmit()}
          disabled={saving}
          aria-busy={saving || undefined}
          className={`inline-flex min-h-11 items-center gap-2 rounded-lg bg-em-violet-600 px-4 text-sm font-semibold text-white hover:bg-em-violet-700 disabled:opacity-70 ${FOCUS_RING}`}
          data-testid="pickup-form-save"
        >
          {saving && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
          {saving
            ? t('manageShop.deliverySettings.pickup.saving')
            : (mode === 'edit'
              ? t('manageShop.deliverySettings.pickup.save')
              : t('manageShop.deliverySettings.pickup.createLocation'))}
        </button>
      </div>
    </div>
  );
}
