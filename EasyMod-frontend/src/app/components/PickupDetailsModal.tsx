import { useEffect, useState } from 'react';
import { AlertCircle, Loader2, MapPin, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import * as orderApi from '@/api/domains/order';
import type {
  DeliveryLocationOption,
  DeliveryProvider,
  PickupLocation,
  PickupLocationPayload,
  PickupLocationSummary,
  ProviderPickupMetadata,
} from '@/api/types/order';
import { BD_PHONE_REGEX, BDPhoneInput } from '@/shared/components/BDPhoneInput';
import { Input } from '@/app/components/ui/input';
import { Textarea } from '@/app/components/ui/textarea';
import { getErrorMessage } from '@shared/lib/http/errors';
import { optionId, optionLabel, providerId } from '@/app/components/orders/directoryOptions';

export interface PickupDetailsModalProps {
  provider: DeliveryProvider;
  missing: string[];
  initialPickup?: PickupLocationSummary | PickupLocation | null;
  providerPickupMeta?: ProviderPickupMetadata | null;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}

const normalizeMissing = (missing: string[]) => missing
  .filter((item): item is string => typeof item === 'string')
  .map((item) => item.toLowerCase().replace(/[.\s-]+/g, '_'));

const hasMissingField = (missing: string[], aliases: string[]) => {
  if (missing.length === 0) return true;
  if (missing.some((item) => /pickup|store|location/.test(item))) return true;
  return missing.some((item) => aliases.some((alias) => item === alias || item.includes(alias)));
};

const pickupValue = (
  pickup: PickupLocationSummary | PickupLocation | null,
  key: 'display_name' | 'phone' | 'address' | 'area_name' | 'city_name' | 'zone_name',
) => {
  if (!pickup) return '';
  const legacy = pickup as PickupLocationSummary & { name?: string | null; area?: string | null; pickup_address?: string | null };
  if (key === 'display_name') return pickup.display_name ?? pickup.contact_name ?? legacy.name ?? '';
  if (key === 'area_name') return pickup.area_name ?? legacy.area ?? '';
  if (key === 'address') return pickup.address ?? legacy.pickup_address ?? '';
  return pickup[key] ?? '';
};

function PickupDetailsModal({
  provider,
  missing: rawMissing,
  initialPickup,
  providerPickupMeta,
  onClose,
  onSaved,
}: PickupDetailsModalProps) {
  const { t, i18n } = useTranslation();
  const missing = normalizeMissing(rawMissing);
  const pickup = initialPickup ?? null;
  const initialMeta = providerPickupMeta ?? {};

  const [locationId, setLocationId] = useState(pickup?.id ?? '');
  const [pickupName, setPickupName] = useState(pickupValue(pickup, 'display_name'));
  const [phone, setPhone] = useState(pickupValue(pickup, 'phone'));
  const [address, setAddress] = useState(pickupValue(pickup, 'address'));
  const [areaName, setAreaName] = useState(pickupValue(pickup, 'area_name'));
  const [cityName, setCityName] = useState(pickupValue(pickup, 'city_name'));
  const [zoneName, setZoneName] = useState(pickupValue(pickup, 'zone_name'));
  const [cityId, setCityId] = useState(String(initialMeta.city_id ?? ''));
  const [zoneId, setZoneId] = useState(String(initialMeta.zone_id ?? ''));
  const [areaId, setAreaId] = useState(String(initialMeta.area_id ?? initialMeta.delivery_area_id ?? ''));
  const [cities, setCities] = useState<DeliveryLocationOption[]>([]);
  const [zones, setZones] = useState<DeliveryLocationOption[]>([]);
  const [areas, setAreas] = useState<DeliveryLocationOption[]>([]);
  const [loadingLocations, setLoadingLocations] = useState(false);
  const [locationError, setLocationError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const showName = hasMissingField(missing, ['pickup_name', 'display_name', 'contact_name', 'pickup_profile', 'pickup_location']);
  const showPhone = hasMissingField(missing, ['pickup_phone', 'phone', 'pickup_location']);
  const showAddress = hasMissingField(missing, ['pickup_address', 'address', 'pickup_location']);
  const showArea = hasMissingField(missing, ['pickup_area', 'area', 'area_name', 'delivery_area', 'pickup_location']);
  const showPathaoLocations = provider === 'pathao' && (
    showArea || hasMissingField(missing, ['pickup_city', 'city', 'city_id', 'pickup_zone', 'zone', 'zone_id'])
  );

  const hydratePickup = (next: PickupLocationSummary | PickupLocation) => {
    setLocationId(next.id ?? '');
    setPickupName(pickupValue(next, 'display_name'));
    setPhone(pickupValue(next, 'phone'));
    setAddress(pickupValue(next, 'address'));
    setAreaName(pickupValue(next, 'area_name'));
    setCityName(pickupValue(next, 'city_name'));
    setZoneName(pickupValue(next, 'zone_name'));
  };

  useEffect(() => {
    if (pickup || !orderApi.getPickupLocations) return;
    let mounted = true;
    void orderApi.getPickupLocations()
      .then((locations) => {
        if (!mounted) return;
        const defaultLocation = locations.find((location) => location.is_default) ?? locations[0];
        if (defaultLocation) hydratePickup(defaultLocation);
      })
      .catch(() => {
        // The activation response still supplies enough context to complete a new profile.
      });
    return () => {
      mounted = false;
    };
  }, [pickup]);

  const loadPathaoZones = async (nextCityId: string) => {
    if (!nextCityId || !orderApi.getPathaoZones) return;
    try {
      setLoadingLocations(true);
      setLocationError(null);
      setZones(await orderApi.getPathaoZones(providerId(nextCityId)));
    } catch (err) {
      setLocationError(getErrorMessage(err, t('courier.pickup.errors.locationsLoadFailed')));
    } finally {
      setLoadingLocations(false);
    }
  };

  const loadPathaoAreas = async (nextZoneId: string) => {
    if (!nextZoneId || !orderApi.getPathaoAreas) return;
    try {
      setLoadingLocations(true);
      setLocationError(null);
      setAreas(await orderApi.getPathaoAreas(providerId(nextZoneId)));
    } catch (err) {
      setLocationError(getErrorMessage(err, t('courier.pickup.errors.locationsLoadFailed')));
    } finally {
      setLoadingLocations(false);
    }
  };

  useEffect(() => {
    if (showPathaoLocations) {
      let mounted = true;
      if (!orderApi.getPathaoCities) return () => {
        mounted = false;
      };
      setLoadingLocations(true);
      setLocationError(null);
      void orderApi.getPathaoCities()
        .then((nextCities) => {
          if (!mounted) return;
          setCities(nextCities);
          const selected = nextCities.find((option) => optionId(option, 'city') === cityId)
            ?? nextCities.find((option) => optionLabel(option, i18n?.language) === cityName);
          if (selected) {
            const selectedId = optionId(selected, 'city');
            setCityId(selectedId);
            setCityName(optionLabel(selected, i18n?.language));
            void loadPathaoZones(selectedId);
          }
        })
        .catch((err) => {
          if (mounted) setLocationError(getErrorMessage(err, t('courier.pickup.errors.locationsLoadFailed')));
        })
        .finally(() => {
          if (mounted) setLoadingLocations(false);
        });
      return () => {
        mounted = false;
      };
    }

    if (provider === 'redx' && showArea) {
      let mounted = true;
      if (!orderApi.getProviderAreas) return () => {
        mounted = false;
      };
      setLoadingLocations(true);
      setLocationError(null);
      void orderApi.getProviderAreas('redx')
        .then((nextAreas) => {
          if (mounted) setAreas(nextAreas);
        })
        .catch((err) => {
          if (mounted) setLocationError(getErrorMessage(err, t('courier.pickup.errors.locationsLoadFailed')));
        })
        .finally(() => {
          if (mounted) setLoadingLocations(false);
        });
      return () => {
        mounted = false;
      };
    }
    return undefined;
  }, [provider, showArea, showPathaoLocations]);

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

  const handleSave = async () => {
    if (saving) return;
    if ((showName && !pickupName.trim())
      || (showPhone && (!phone.trim() || !BD_PHONE_REGEX.test(phone)))
      || (showAddress && !address.trim())
      || (showArea && !areaName.trim())) {
      setError(t('courier.pickup.errors.fieldsRequired'));
      return;
    }

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
      const savedId = (saved?.id ?? locationId) || null;
      if (!locationId && saved?.id) setLocationId(saved.id);

      await orderApi.syncProviderPickup(provider, {
        pickup_location_id: savedId,
        provider_pickup_meta: providerMeta,
      });
      await orderApi.activateDeliveryProvider(provider);
      await onSaved();
      onClose();
    } catch (err) {
      setError(getErrorMessage(err, t('courier.pickup.errors.syncFailed')));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-gray-900/60 p-4"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose();
      }}
    >
      <div
        className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-xl border border-gray-200 bg-white p-5 shadow-xl md:p-6"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pickup-details-title"
      >
        <div className="mb-5 flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="rounded-lg bg-blue-50 p-2 text-blue-700">
              <MapPin className="h-5 w-5" />
            </div>
            <div>
              <h2 id="pickup-details-title" className="text-lg font-semibold text-gray-900">
                {t('courier.pickup.title')}
              </h2>
              <p className="mt-1 text-sm text-gray-500">{t('courier.pickup.description')}</p>
            </div>
          </div>
          <button type="button" onClick={onClose} className="rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700" aria-label={t('common.close')}>
            <X className="h-5 w-5" />
          </button>
        </div>

        {(error || locationError) && (
          <div className="mb-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error ?? locationError}</span>
          </div>
        )}

        <div className="space-y-4">
          {showName && (
            <label className="block">
              <span className="mb-1.5 block text-sm font-medium text-gray-700">
                {t('courier.pickup.name')} <span className="text-red-500">*</span>
              </span>
              <Input
                value={pickupName}
                onChange={(event) => setPickupName(event.target.value)}
                placeholder={t('courier.pickup.namePlaceholder')}
                autoComplete="organization"
              />
            </label>
          )}

          {showPhone && (
            <BDPhoneInput
              id="pickup-phone"
              label={t('courier.pickup.phone')}
              value={phone}
              onChange={setPhone}
              required
            />
          )}

          {showPathaoLocations && (
            <div className="grid gap-4 sm:grid-cols-3">
              <label className="block">
                <span className="mb-1.5 block text-sm font-medium text-gray-700">{t('courier.pickup.city')}</span>
                <select
                  aria-label={t('courier.pickup.city')}
                  value={cityId}
                  onChange={(event) => handleCityChange(event.target.value)}
                  disabled={loadingLocations && cities.length === 0}
                  className="h-9 w-full rounded-md border border-input bg-input-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] disabled:opacity-60"
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
                <span className="mb-1.5 block text-sm font-medium text-gray-700">{t('courier.pickup.zone')}</span>
                <select
                  aria-label={t('courier.pickup.zone')}
                  value={zoneId}
                  onChange={(event) => handleZoneChange(event.target.value)}
                  disabled={!cityId || (loadingLocations && zones.length === 0)}
                  className="h-9 w-full rounded-md border border-input bg-input-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] disabled:opacity-60"
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
                <span className="mb-1.5 block text-sm font-medium text-gray-700">{t('courier.pickup.area')}</span>
                <select
                  aria-label={t('courier.pickup.area')}
                  value={areaId}
                  onChange={(event) => handleAreaChange(event.target.value)}
                  disabled={!zoneId || (loadingLocations && areas.length === 0)}
                  className="h-9 w-full rounded-md border border-input bg-input-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] disabled:opacity-60"
                >
                  <option value="">{t('courier.pickup.selectArea')}</option>
                  {areas.map((option) => (
                    <option key={optionId(option, 'area')} value={optionId(option, 'area')}>
                      {optionLabel(option, i18n?.language)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}

          {provider === 'redx' && showArea && (
            <label className="block">
              <span className="mb-1.5 block text-sm font-medium text-gray-700">
                {t('courier.pickup.area')} <span className="text-red-500">*</span>
              </span>
              <select
                aria-label={t('courier.pickup.area')}
                value={areaId}
                onChange={(event) => handleAreaChange(event.target.value)}
                disabled={loadingLocations && areas.length === 0}
                className="h-9 w-full rounded-md border border-input bg-input-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] disabled:opacity-60"
              >
                <option value="">{t('courier.pickup.selectArea')}</option>
                {areas.map((option) => (
                  <option key={optionId(option, 'area')} value={optionId(option, 'area')}>
                    {optionLabel(option, i18n?.language)}
                  </option>
                ))}
              </select>
            </label>
          )}

          {provider !== 'pathao' && provider !== 'redx' && showArea && (
            <label className="block">
              <span className="mb-1.5 block text-sm font-medium text-gray-700">
                {t('courier.pickup.area')} <span className="text-red-500">*</span>
              </span>
              <Input
                value={areaName}
                onChange={(event) => setAreaName(event.target.value)}
                placeholder={t('courier.pickup.areaPlaceholder')}
              />
            </label>
          )}

          {showAddress && (
            <label className="block">
              <span className="mb-1.5 block text-sm font-medium text-gray-700">
                {t('courier.pickup.address')} <span className="text-red-500">*</span>
              </span>
              <Textarea
                value={address}
                onChange={(event) => setAddress(event.target.value)}
                placeholder={t('courier.pickup.addressPlaceholder')}
                rows={3}
              />
            </label>
          )}
        </div>

        <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button type="button" onClick={onClose} className="min-h-10 rounded-lg border border-gray-300 px-4 text-sm font-semibold text-gray-700 hover:bg-gray-50">
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving}
            className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 text-sm font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            {saving ? t('courier.pickup.saving') : t('courier.pickup.saveValidate')}
          </button>
        </div>
      </div>
    </div>
  );
}

export default PickupDetailsModal;
