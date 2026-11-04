import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, HelpCircle, Loader2, Truck, X } from "lucide-react";
import { toast } from "sonner";
import { apiClient } from "@/api";
import type { Order, CourierBookingPayload, CourierEligibility } from "@/api/types/order";
import { useTranslation } from "react-i18next";
import { BDPhoneInput } from '@/shared/components/BDPhoneInput';
import { getErrorMessage } from "@shared/lib/http/errors";
import { isConfidenceHold } from "@/api/domains/order-confidence";
import { getExpectedCourierCollection } from "./orders/orderRules";

interface Props {
  order: Order;
  onClose: () => void;
  onBooked: (trackingId: string, provider: string) => void;
  paymentMethodCorrectionUnavailable?: boolean;
  /** RTO Shield v2 paused this booking; the order detail shows what to do. */
  onHeld?: () => void;
}

export default function CourierBookingModal({ order, onClose, onBooked, onHeld, paymentMethodCorrectionUnavailable = false }: Props) {
  const { t } = useTranslation();
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
  const destinationNotServiceable = eligibility?.decision === 'NOT_SERVICEABLE';
  // The server owns the policy. NOT_SERVICEABLE blocks the button only when the
  // response says enforcement is on; an older payload without the field fails
  // closed rather than silently unlocking a booking the server would refuse.
  const destinationBlocksBooking = destinationNotServiceable && eligibility?.enforced !== false;

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
  }, [order.id, provider]);

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
      toast.error(getErrorMessage(err, t('courier.errors.bookingFailed')));
    } finally {
      setBooking(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-gray-900/60 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6 space-y-4">
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
                onClick={() => setProvider(p)}
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
