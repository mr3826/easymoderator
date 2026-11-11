import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, HelpCircle, Loader2, MapPin, Truck, X } from "lucide-react";
import { toast } from "sonner";
import { apiClient } from "@/api";
import type {
  Order,
  CourierBookingPayload,
  CourierEligibility,
  ConfirmCourierDestinationPayload,
  DeliveryLocationOption,
} from "@/api/types/order";
import { useTranslation } from "react-i18next";
import { BDPhoneInput } from '@/shared/components/BDPhoneInput';
import { getErrorMessage } from "@shared/lib/http/errors";
import { isConfidenceHold } from "@/api/domains/order-confidence";
import { getExpectedCourierCollection } from "./orders/orderRules";
import { optionId, optionLabel, providerId } from "./orders/directoryOptions";

interface Props {
  order: Order;
  onClose: () => void;
  onBooked: (trackingId: string, provider: string) => void;
  paymentMethodCorrectionUnavailable?: boolean;
  /** RTO Shield v2 paused this booking; the order detail shows what to do. */
  onHeld?: () => void;
}

/**
 * Server error codes from the courier-destination contract, mapped to the
 * copy that names the real problem and the merchant's next action. The same
 * map serves the confirm call and a failed booking.
 */
const DELIVERY_AREA_ERROR_KEYS: Record<string, string> = {
  COURIER_DESTINATION_CONFIRM_REQUIRED: 'courier.deliveryArea.errors.confirmRequired',
  COURIER_DESTINATION_SELECTION_INCOMPLETE: 'courier.deliveryArea.errors.selectionIncomplete',
  COURIER_DESTINATION_INVALID_SELECTION: 'courier.deliveryArea.errors.invalidSelection',
  COURIER_DESTINATION_RESOLUTION_DISABLED: 'courier.deliveryArea.errors.directoryUnavailable',
  COURIER_DIRECTORY_UNAVAILABLE: 'courier.deliveryArea.errors.directoryUnavailable',
  COURIER_PROVIDER_REQUIRED: 'courier.deliveryArea.errors.providerRequired',
  COURIER_DESTINATION_NOT_REQUIRED: 'courier.deliveryArea.errors.notRequired',
  COURIER_DISPATCH_ACTIVE: 'courier.deliveryArea.errors.dispatchActive',
  COURIER_DESTINATION_CONTRADICTED: 'courier.deliveryArea.errors.contradicted',
  COURIER_DESTINATION_PAYLOAD_INVALID: 'courier.deliveryArea.errors.payloadInvalid',
};

const errorCodeOf = (err: unknown): string | null => {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return null;
};

const isForbidden = (err: unknown): boolean => {
  if (!err || typeof err !== 'object') return false;
  const { statusCode, type, code } = err as { statusCode?: number; type?: string; code?: string };
  return statusCode === 403 || type === 'FORBIDDEN' || code === 'FORBIDDEN';
};

export default function CourierBookingModal({ order, onClose, onBooked, onHeld, paymentMethodCorrectionUnavailable = false }: Props) {
  const { t, i18n } = useTranslation();
  const [provider, setProvider] = useState<'pathao' | 'steadfast' | 'redx'>('steadfast');
  const [recipientName, setRecipientName] = useState(order.customerName);
  const [recipientPhone, setRecipientPhone] = useState(order.customerPhone || '');
  const [recipientAddress, setRecipientAddress] = useState(order.deliveryAddress || '');
  const paymentMethod = order.payment_method?.trim().toLowerCase().replace(/[\s-]+/g, '_');
  const isCod = paymentMethod === 'cod' || paymentMethod === 'cash' || paymentMethod === 'cash_on_delivery';
  const paymentStatus = order.payment_status?.trim().toLowerCase();
  const codDueIsUnknown = isCod && paymentStatus === 'partially_paid';
  const paymentMethodIsMissing = !paymentMethod && paymentStatus !== 'paid';
  const expectedCollection = getExpectedCourierCollection(order);
  const deliveryStatus = order.delivery_status?.trim().toLowerCase();
  const hasCourierRecord = Boolean(
    order.delivery_tracking_code
    || order.delivery_consignment_id
    || order.delivery_dispatched_at
    || (deliveryStatus && !['unfulfilled', 'not_booked'].includes(deliveryStatus))
  );
  const canCorrectMissingMethod = !paymentMethodCorrectionUnavailable && !hasCourierRecord
    && ['draft', 'pending', 'confirmed', 'processing'].includes(order.status);
  const bookingBlocked = expectedCollection === null;
  const bookingBlockMessage = codDueIsUnknown
    ? t('orders.partialCodDueUnknown')
    : paymentMethodIsMissing
      ? t(hasCourierRecord || paymentMethodCorrectionUnavailable
        ? 'orders.paymentMethodCorrectionLockedByCourier'
        : canCorrectMissingMethod ? 'orders.bookingMethodUnavailable' : 'orders.bookingMethodCorrectionUnavailable')
      : bookingBlocked
        ? t('orders.paymentStatusCollectionUnknown')
        : null;
  const [itemDescription, setItemDescription] = useState(
    order.items.map((i) => `${i.productName} x${i.quantity}`).join(', ')
  );
  const [booking, setBooking] = useState(false);
  const [eligibility, setEligibility] = useState<CourierEligibility | null>(null);
  const [checkingEligibility, setCheckingEligibility] = useState(false);
  // Bumped after a confirmed destination so the eligibility pre-check re-runs
  // exactly like a provider change — the server stays the only source of truth.
  const [eligibilityNonce, setEligibilityNonce] = useState(0);
  const destinationNotServiceable = eligibility?.decision === 'NOT_SERVICEABLE';
  // The server owns the policy. NOT_SERVICEABLE blocks the button only when the
  // response says enforcement is on; an older payload without the field fails
  // closed rather than silently unlocking a booking the server would refuse.
  const destinationBlocksBooking = destinationNotServiceable && eligibility?.enforced !== false;

  // --- Delivery-area confirmation (redx/pathao only; steadfast books by text
  // --- address and must never get a fabricated coverage verdict here) ---
  const supportsDirectory = provider === 'redx' || provider === 'pathao';
  const [areaPickerOpen, setAreaPickerOpen] = useState(false);
  const [redxAreas, setRedxAreas] = useState<DeliveryLocationOption[]>([]);
  const [areaSearch, setAreaSearch] = useState('');
  const [selectedAreaId, setSelectedAreaId] = useState('');
  const [cities, setCities] = useState<DeliveryLocationOption[]>([]);
  const [zones, setZones] = useState<DeliveryLocationOption[]>([]);
  const [pathaoAreas, setPathaoAreas] = useState<DeliveryLocationOption[]>([]);
  const [cityId, setCityId] = useState('');
  const [zoneId, setZoneId] = useState('');
  const [pathaoAreaId, setPathaoAreaId] = useState('');
  const [directoryLoading, setDirectoryLoading] = useState(false);
  const [directoryError, setDirectoryError] = useState<string | null>(null);
  const [confirmingArea, setConfirmingArea] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  // The picker is reachable for every non-serviceable verdict and can always be
  // opened by hand, so a merchant is never stuck without a way to fix a 409.
  const areaPickerVisible = supportsDirectory
    && (areaPickerOpen || checkingEligibility || (eligibility !== null && eligibility.decision !== 'SERVICEABLE'));

  const directoryErrorCopy = (err: unknown): string => {
    const code = errorCodeOf(err);
    const mappedKey = code ? DELIVERY_AREA_ERROR_KEYS[code] : undefined;
    if (mappedKey) return t(mappedKey, { provider });
    if (isForbidden(err)) return t('courier.deliveryArea.errors.ownerOnly');
    if (code === 'DELIVERY_PROVIDER_NOT_CONNECTED') return t('courier.deliveryArea.errors.notConnected', { provider });
    return t('courier.deliveryArea.errors.loadFailed', { provider });
  };

  const confirmErrorCopy = (err: unknown): string => {
    const code = errorCodeOf(err);
    const mappedKey = code ? DELIVERY_AREA_ERROR_KEYS[code] : undefined;
    if (mappedKey) return t(mappedKey, { provider });
    if (code === 'DELIVERY_PROVIDER_NOT_CONNECTED') return t('courier.deliveryArea.errors.notConnected', { provider });
    return getErrorMessage(err, t('courier.deliveryArea.errors.confirmFailed'));
  };

  const resetAreaPicker = () => {
    setAreaPickerOpen(false);
    setRedxAreas([]);
    setAreaSearch('');
    setSelectedAreaId('');
    setCities([]);
    setZones([]);
    setPathaoAreas([]);
    setCityId('');
    setZoneId('');
    setPathaoAreaId('');
    setDirectoryError(null);
    setConfirmError(null);
  };

  const selectProvider = (next: 'pathao' | 'steadfast' | 'redx') => {
    resetAreaPicker();
    setProvider(next);
  };

  const loadPathaoZones = async (nextCityId: string) => {
    if (!nextCityId) return;
    try {
      setDirectoryLoading(true);
      setDirectoryError(null);
      setZones(await apiClient.getPathaoZones(providerId(nextCityId)));
    } catch (err) {
      setDirectoryError(directoryErrorCopy(err));
    } finally {
      setDirectoryLoading(false);
    }
  };

  const loadPathaoAreas = async (nextZoneId: string) => {
    if (!nextZoneId) return;
    try {
      setDirectoryLoading(true);
      setDirectoryError(null);
      setPathaoAreas(await apiClient.getPathaoAreas(providerId(nextZoneId)));
    } catch (err) {
      setDirectoryError(directoryErrorCopy(err));
    } finally {
      setDirectoryLoading(false);
    }
  };

  useEffect(() => {
    if (!areaPickerVisible) return;
    let cancelled = false;
    setDirectoryLoading(true);
    setDirectoryError(null);
    if (provider === 'redx') {
      apiClient.getProviderAreas('redx')
        .then((options) => {
          if (cancelled) return;
          setRedxAreas(options);
          // Prefill the search with the order's district, but only when the
          // directory actually carries district names — otherwise the filter
          // would silently hide everything.
          const district = order.delivery_address?.district?.trim();
          const carriesDistricts = options.some((option) => option.district_name != null);
          if (district && carriesDistricts) setAreaSearch(district);
        })
        .catch((err) => { if (!cancelled) setDirectoryError(directoryErrorCopy(err)); })
        .finally(() => { if (!cancelled) setDirectoryLoading(false); });
    } else if (provider === 'pathao') {
      apiClient.getPathaoCities()
        .then((options) => { if (!cancelled) setCities(options); })
        .catch((err) => { if (!cancelled) setDirectoryError(directoryErrorCopy(err)); })
        .finally(() => { if (!cancelled) setDirectoryLoading(false); });
    }
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [areaPickerVisible, provider]);

  const filteredRedxAreas = useMemo(() => {
    const query = areaSearch.trim().toLowerCase();
    if (!query) return redxAreas;
    return redxAreas.filter((option) =>
      [option.name, option.name_bn, option.district_name, option.postcode].some(
        (value) => value != null && String(value).toLowerCase().includes(query),
      ));
  }, [redxAreas, areaSearch]);

  const handleCityChange = (value: string) => {
    setCityId(value);
    setZoneId('');
    setPathaoAreaId('');
    setZones([]);
    setPathaoAreas([]);
    void loadPathaoZones(value);
  };

  const handleZoneChange = (value: string) => {
    setZoneId(value);
    setPathaoAreaId('');
    setPathaoAreas([]);
    void loadPathaoAreas(value);
  };

  const canConfirmArea = provider === 'redx'
    ? selectedAreaId !== ''
    : provider === 'pathao' && cityId !== '' && zoneId !== '' && pathaoAreaId !== '';

  const handleConfirmArea = async () => {
    if (!supportsDirectory || confirmingArea) return;
    const language = i18n?.language;
    let payload: ConfirmCourierDestinationPayload | null = null;
    if (provider === 'redx') {
      const selected = redxAreas.find((option) => optionId(option, 'area') === selectedAreaId);
      if (!selected) {
        setConfirmError(t('courier.deliveryArea.errors.selectionIncomplete'));
        return;
      }
      const district = typeof selected.district_name === 'string' ? selected.district_name : undefined;
      const postcode = selected.postcode != null ? String(selected.postcode) : undefined;
      payload = {
        provider: 'redx',
        area_id: providerId(selectedAreaId),
        area_name: optionLabel(selected, language),
        ...(district ? { district } : {}),
        ...(postcode ? { postcode } : {}),
      };
    } else if (provider === 'pathao') {
      const city = cities.find((option) => optionId(option, 'city') === cityId);
      const zone = zones.find((option) => optionId(option, 'zone') === zoneId);
      const area = pathaoAreas.find((option) => optionId(option, 'area') === pathaoAreaId);
      if (!city || !zone || !area) {
        setConfirmError(t('courier.deliveryArea.errors.selectionIncomplete'));
        return;
      }
      payload = {
        provider: 'pathao',
        area_id: providerId(pathaoAreaId),
        area_name: optionLabel(area, language),
        zone_id: providerId(zoneId),
        zone_name: optionLabel(zone, language),
        city_id: providerId(cityId),
        city_name: optionLabel(city, language),
      };
    }
    if (!payload) return;
    try {
      setConfirmingArea(true);
      setConfirmError(null);
      await apiClient.confirmCourierDestination(order.id, payload);
      toast.success(t('courier.deliveryArea.confirmed', { provider }));
      setAreaPickerOpen(false);
      // Same effect as a provider change: the server re-decides coverage.
      setEligibilityNonce((nonce) => nonce + 1);
    } catch (err) {
      setConfirmError(confirmErrorCopy(err));
    } finally {
      setConfirmingArea(false);
    }
  };

  // Pre-flight only: the server decides again during booking, so a stale or
  // missing answer here can never let an unsupported parcel through.
  useEffect(() => {
    let cancelled = false;
    setCheckingEligibility(true);
    setEligibility(null);
    apiClient.getCourierEligibility(order.id, provider)
      .then((result) => {
        if (!cancelled) setEligibility(result);
      })
      .catch(() => {
        // A failed pre-check is "could not check", never "serviceable".
        if (!cancelled) {
          setEligibility({
            provider,
            decision: 'CHECK_UNAVAILABLE',
            reason_code: 'REQUEST_FAILED',
            source: 'order_destination',
            checked_at: new Date().toISOString(),
            ttl_seconds: 0,
          });
        }
      })
      .finally(() => {
        if (!cancelled) setCheckingEligibility(false);
      });
    return () => { cancelled = true; };
  }, [order.id, provider, eligibilityNonce]);

  const eligibilityMessage = (() => {
    if (checkingEligibility) return t('courier.eligibility.checking', { provider });
    switch (eligibility?.decision) {
      case 'SERVICEABLE':
        return t('courier.eligibility.serviceable', { provider });
      case 'NOT_SERVICEABLE':
        return destinationBlocksBooking
          ? t('courier.eligibility.notServiceable', { provider })
          : t('courier.eligibility.notServiceableAdvisory', { provider });
      case 'UNCERTAIN':
        return t('courier.eligibility.uncertain', { provider });
      case 'CHECK_UNAVAILABLE':
        return t('courier.eligibility.unavailable');
      default:
        return null;
    }
  })();

  const handleBook = async () => {
    if (bookingBlocked || destinationBlocksBooking) return;
    if (!recipientName.trim() || !recipientPhone.trim() || !recipientAddress.trim()) {
      toast.error(t('courier.errors.fieldsRequired'));
      return;
    }
    try {
      setBooking(true);
      const payload: CourierBookingPayload = {
        provider,
        recipient_name: recipientName,
        recipient_phone: recipientPhone,
        recipient_address: recipientAddress,
        item_description: itemDescription || undefined,
      };
      const result = await apiClient.bookCourier(order.id, payload);
      toast.success(t('courier.bookingSuccess', { trackingId: result.tracking_id }));
      onBooked(result.tracking_id, result.provider);
      onClose();
    } catch (err: any) {
      if (isConfidenceHold(err)) {
        toast.warning(t('orderConfidence.bookingHeld'));
        onHeld?.();
        onClose();
        return;
      }
      const code = errorCodeOf(err);
      const mappedKey = code ? DELIVERY_AREA_ERROR_KEYS[code] : undefined;
      if (mappedKey) {
        // Name the real problem and the next action — and open the picker for
        // the two codes the merchant resolves by choosing an area right here.
        toast.error(t(mappedKey, { provider }));
        if (code === 'COURIER_DESTINATION_CONTRADICTED' || code === 'COURIER_DESTINATION_PAYLOAD_INVALID') {
          setAreaPickerOpen(true);
        }
        return;
      }
      toast.error(getErrorMessage(err, t('courier.errors.bookingFailed')));
    } finally {
      setBooking(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-gray-900/60 p-4">
      <div className="my-auto max-h-[calc(100dvh-2rem)] w-full max-w-md space-y-4 overflow-y-auto overscroll-contain rounded-xl bg-white p-6 shadow-xl">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Truck className="w-5 h-5 text-green-600" />
            <h2 className="text-lg font-semibold text-gray-900">{t('courier.modalTitle')}</h2>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Provider Selection */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">{t('courier.provider')}</label>
          <div className="grid grid-cols-3 gap-2">
            {(['pathao', 'steadfast', 'redx'] as const).map((p) => (
              <button
                key={p}
                onClick={() => selectProvider(p)}
                className={`py-2 px-3 rounded-lg border text-sm font-medium capitalize transition-colors ${
                  provider === p
                    ? 'bg-green-600 text-white border-green-600'
                    : 'bg-white text-gray-700 border-gray-300 hover:border-green-500'
                }`}
              >
                {p}
              </button>
            ))}
          </div>
          {eligibilityMessage && (
            <div
              role={destinationBlocksBooking ? 'alert' : 'status'}
              className={`mt-2 flex items-start gap-2 rounded-lg border p-2 text-xs ${
                destinationBlocksBooking
                  ? 'border-red-200 bg-red-50 text-red-800'
                  : eligibility?.decision === 'SERVICEABLE'
                    ? 'border-green-200 bg-green-50 text-green-800'
                    : 'border-amber-200 bg-amber-50 text-amber-900'
              }`}
            >
              {checkingEligibility ? (
                <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin" />
              ) : destinationBlocksBooking ? (
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              ) : eligibility?.decision === 'SERVICEABLE' ? (
                <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              ) : (
                <HelpCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              )}
              <span>{eligibilityMessage}</span>
            </div>
          )}
        </div>

        {/* Delivery area — the courier's own directory, confirmed per order.
            Never rendered for steadfast: it books by text address and must not
            get a fabricated coverage verdict. */}
        {supportsDirectory && (
          <div className="rounded-lg border border-gray-200 p-3">
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-start gap-2">
                <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-green-600" />
                <div>
                  <h3 className="text-sm font-medium text-gray-700">{t('courier.deliveryArea.title')}</h3>
                  <p className="mt-0.5 text-xs text-gray-500">{t('courier.deliveryArea.description', { provider })}</p>
                </div>
              </div>
              {!areaPickerVisible && (
                <button
                  type="button"
                  onClick={() => setAreaPickerOpen(true)}
                  className="shrink-0 text-xs font-medium text-green-700 underline underline-offset-2 hover:text-green-800"
                >
                  {t('courier.deliveryArea.change')}
                </button>
              )}
            </div>

            {areaPickerVisible && (
              <div className="mt-3 space-y-2">
                {directoryError && (
                  <div role="alert" className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-2 text-xs text-red-800">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>{directoryError}</span>
                  </div>
                )}
                {confirmError && (
                  <div role="alert" className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-2 text-xs text-red-800">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>{confirmError}</span>
                  </div>
                )}

                {provider === 'redx' && (
                  directoryLoading ? (
                    <p className="flex items-center gap-2 text-xs text-gray-500">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      {t('courier.deliveryArea.loading', { provider })}
                    </p>
                  ) : !directoryError && (
                    <>
                      <input
                        type="search"
                        value={areaSearch}
                        onChange={(e) => setAreaSearch(e.target.value)}
                        placeholder={t('courier.deliveryArea.searchPlaceholder')}
                        aria-label={t('courier.deliveryArea.searchPlaceholder')}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                      />
                      {filteredRedxAreas.length === 0 ? (
                        <p className="text-xs text-gray-500">{t('courier.deliveryArea.noResults')}</p>
                      ) : (
                        <div
                          role="listbox"
                          aria-label={t('courier.deliveryArea.title')}
                          className="max-h-40 space-y-1 overflow-y-auto rounded-lg border border-gray-200 p-1"
                        >
                          {filteredRedxAreas.map((option) => {
                            const id = optionId(option, 'area');
                            const selected = id === selectedAreaId;
                            const detail = [option.district_name, option.postcode]
                              .filter((value) => value != null && value !== '')
                              .map((value) => String(value))
                              .join(' · ');
                            return (
                              <button
                                key={id}
                                type="button"
                                role="option"
                                aria-selected={selected}
                                onClick={() => setSelectedAreaId(id)}
                                className={`w-full rounded-md px-2 py-1.5 text-left text-sm ${
                                  selected ? 'bg-green-600 text-white' : 'text-gray-700 hover:bg-green-50'
                                }`}
                              >
                                {optionLabel(option, i18n?.language)}
                                {detail && (
                                  <span className={`block text-xs ${selected ? 'text-green-100' : 'text-gray-500'}`}>{detail}</span>
                                )}
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </>
                  )
                )}

                {provider === 'pathao' && (
                  directoryLoading && cities.length === 0 ? (
                    <p className="flex items-center gap-2 text-xs text-gray-500">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      {t('courier.deliveryArea.loading', { provider })}
                    </p>
                  ) : !directoryError && (
                    <div className="grid grid-cols-3 gap-2">
                      <label className="block">
                        <span className="mb-1 block text-xs font-medium text-gray-600">{t('courier.pickup.city')}</span>
                        <select
                          aria-label={t('courier.pickup.city')}
                          value={cityId}
                          onChange={(e) => handleCityChange(e.target.value)}
                          className="h-9 w-full rounded-md border border-gray-300 bg-white px-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
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
                        <span className="mb-1 block text-xs font-medium text-gray-600">{t('courier.pickup.zone')}</span>
                        <select
                          aria-label={t('courier.pickup.zone')}
                          value={zoneId}
                          onChange={(e) => handleZoneChange(e.target.value)}
                          disabled={!cityId}
                          className="h-9 w-full rounded-md border border-gray-300 bg-white px-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 disabled:opacity-60"
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
                        <span className="mb-1 block text-xs font-medium text-gray-600">{t('courier.pickup.area')}</span>
                        <select
                          aria-label={t('courier.pickup.area')}
                          value={pathaoAreaId}
                          onChange={(e) => setPathaoAreaId(e.target.value)}
                          disabled={!zoneId}
                          className="h-9 w-full rounded-md border border-gray-300 bg-white px-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 disabled:opacity-60"
                        >
                          <option value="">{t('courier.pickup.selectArea')}</option>
                          {pathaoAreas.map((option) => (
                            <option key={optionId(option, 'area')} value={optionId(option, 'area')}>
                              {optionLabel(option, i18n?.language)}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                  )
                )}

                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={() => void handleConfirmArea()}
                    disabled={confirmingArea || !canConfirmArea}
                    className="flex items-center gap-2 rounded-lg bg-green-600 px-3 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {confirmingArea && <Loader2 className="h-4 w-4 animate-spin" />}
                    {confirmingArea ? t('courier.deliveryArea.confirming') : t('courier.deliveryArea.confirmButton')}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Recipient Info */}
        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">{t('courier.recipientName')}</label>
            <input
              type="text"
              value={recipientName}
              onChange={(e) => setRecipientName(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
            />
          </div>
          <div>
            <BDPhoneInput
              label={t('courier.recipientPhone')}
              value={recipientPhone}
              onChange={setRecipientPhone}
              id="courier-recipient-phone"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">{t('courier.recipientAddress')}</label>
            <textarea
              value={recipientAddress}
              onChange={(e) => setRecipientAddress(e.target.value)}
              rows={2}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
            />
          </div>
          <div role={bookingBlockMessage ? 'alert' : 'note'} className={bookingBlockMessage ? 'rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs font-medium text-amber-900' : 'rounded-lg bg-gray-50 p-3 text-xs text-gray-600'}>
            {bookingBlockMessage || t('orders.courierCollectionServerDetermined')}
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">{t('courier.itemDescription')}</label>
            <input
              type="text"
              value={itemDescription}
              onChange={(e) => setItemDescription(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
            />
          </div>
        </div>

        <div className="flex gap-3 justify-end pt-2">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={handleBook}
            disabled={booking || bookingBlocked || destinationBlocksBooking}
            className="px-4 py-2 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700 flex items-center gap-2 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {booking ? <Loader2 className="w-4 h-4 animate-spin" /> : <Truck className="w-4 h-4" />}
            {t('courier.bookButton')}
          </button>
        </div>
      </div>
    </div>
  );
}
