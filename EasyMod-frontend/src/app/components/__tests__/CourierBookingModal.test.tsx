/**
 * CourierBookingModal — advertised boundary for destination coverage (D5-1).
 *
 * The server owns the enforcement policy and reports it as `enforced`. This
 * modal must never claim more than that: a NOT_SERVICEABLE verdict blocks the
 * Book button only when the server says enforcement is on, and an older
 * payload without the field fails closed.
 */
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import CourierBookingModal from '../CourierBookingModal';
import { apiClient } from '@/api';
import type { Order } from '@/api/types/order';

vi.mock('@/api', () => ({
  apiClient: {
    getCourierEligibility: vi.fn(),
    bookCourier: vi.fn(),
    confirmCourierDestination: vi.fn(),
    getProviderAreas: vi.fn(),
    getPathaoCities: vi.fn(),
    getPathaoZones: vi.fn(),
    getPathaoAreas: vi.fn(),
  },
}));

const { tMock } = vi.hoisted(() => ({
  tMock: (key: string, opts?: Record<string, unknown>) => {
    if (opts && typeof opts === 'object') {
      const vals = Object.values(opts).filter((v) => v != null).join(' ');
      if (vals) return `${key} ${vals}`;
    }
    return key;
  },
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: tMock }),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

vi.mock('@/api/domains/order-confidence', () => ({
  isConfidenceHold: () => false,
}));

const order: Order = {
  id: 'order-1',
  customerName: 'Rahim',
  customerPhone: '01711111111',
  deliveryAddress: 'Road 1, Mirpur, Dhaka',
  items: [{ productId: 'p1', productName: 'Red Saree', quantity: 2, price: 625 }],
  total: 1250,
  status: 'confirmed',
  channel: 'whatsapp',
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
  payment_method: 'COD',
  payment_status: 'unpaid',
  delivery_status: 'unfulfilled',
};

const eligibility = (overrides: Record<string, unknown> = {}) => ({
  provider: 'redx',
  decision: 'NOT_SERVICEABLE' as const,
  reason_code: 'NO_AREA_MATCH',
  source: 'order_destination' as const,
  checked_at: '2026-11-04T00:00:00.000Z',
  ttl_seconds: 300,
  ...overrides,
});

const renderModal = () => render(
  <CourierBookingModal order={order} onClose={vi.fn()} onBooked={vi.fn()} />,
);

const bookButton = () => screen.getByRole('button', { name: /courier\.bookButton/ });

describe('CourierBookingModal destination coverage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (apiClient.getCourierEligibility as any).mockResolvedValue(eligibility({ enforced: false }));
    (apiClient.confirmCourierDestination as any).mockResolvedValue({});
    (apiClient.getProviderAreas as any).mockResolvedValue([]);
    (apiClient.getPathaoCities as any).mockResolvedValue([]);
    (apiClient.getPathaoZones as any).mockResolvedValue([]);
    (apiClient.getPathaoAreas as any).mockResolvedValue([]);
  });

  it('keeps Book available and shows advisory copy when enforcement is off', async () => {
    renderModal();

    await waitFor(() => expect(screen.getByText(/courier\.eligibility\.notServiceableAdvisory/)).toBeInTheDocument());
    expect(bookButton()).toBeEnabled();
    expect(screen.queryByText(/courier\.eligibility\.notServiceable\b/)).not.toBeInTheDocument();
  });

  it('disables Book and shows the blocking copy when enforcement is on', async () => {
    (apiClient.getCourierEligibility as any).mockResolvedValue(eligibility({ enforced: true }));
    renderModal();

    await waitFor(() => expect(screen.getByText(/courier\.eligibility\.notServiceable\b/)).toBeInTheDocument());
    expect(bookButton()).toBeDisabled();
    expect(screen.queryByText(/notServiceableAdvisory/)).not.toBeInTheDocument();
  });

  it('fails closed when the response predates the enforced field', async () => {
    (apiClient.getCourierEligibility as any).mockResolvedValue(eligibility());
    renderModal();

    await waitFor(() => expect(screen.getByText(/courier\.eligibility\.notServiceable\b/)).toBeInTheDocument());
    expect(bookButton()).toBeDisabled();
  });

  it('does not block a SERVICEABLE verdict', async () => {
    (apiClient.getCourierEligibility as any).mockResolvedValue(eligibility({ decision: 'SERVICEABLE', reason_code: 'AREA_MATCHED' }));
    renderModal();

    await waitFor(() => expect(screen.getByText(/courier\.eligibility\.serviceable/)).toBeInTheDocument());
    expect(bookButton()).toBeEnabled();
  });

  it('confirms a REDX area using only the selected REDX directory id', async () => {
    (apiClient.getProviderAreas as any).mockResolvedValue([
      { area_id: 77, name: 'Mirpur 10', district_name: 'Dhaka', postcode: '1216' },
    ]);
    renderModal();

    fireEvent.click(screen.getByRole('button', { name: 'redx' }));
    fireEvent.click(await screen.findByRole('option', { name: /Mirpur 10/ }));
    fireEvent.click(screen.getByRole('button', { name: /courier\.deliveryArea\.confirmButton/ }));

    await waitFor(() => expect(apiClient.confirmCourierDestination).toHaveBeenCalledWith('order-1', {
      provider: 'redx',
      area_id: 77,
      area_name: 'Mirpur 10',
      district: 'Dhaka',
      postcode: '1216',
    }));
    expect(apiClient.getProviderAreas).toHaveBeenCalledWith('redx');
  });

  it('confirms a Pathao destination with its city, zone, and area ids', async () => {
    (apiClient.getPathaoCities as any).mockResolvedValue([{ city_id: 11, city_name: 'Dhaka' }]);
    (apiClient.getPathaoZones as any).mockResolvedValue([{ zone_id: 22, zone_name: 'Mirpur Zone' }]);
    (apiClient.getPathaoAreas as any).mockResolvedValue([{ area_id: 33, area_name: 'Mirpur 10' }]);
    renderModal();

    fireEvent.click(screen.getByRole('button', { name: 'pathao' }));
    fireEvent.change(await screen.findByRole('combobox', { name: 'courier.pickup.city' }), { target: { value: '11' } });
    await waitFor(() => expect(apiClient.getPathaoZones).toHaveBeenCalledWith(11));
    fireEvent.change(screen.getByRole('combobox', { name: 'courier.pickup.zone' }), { target: { value: '22' } });
    await waitFor(() => expect(apiClient.getPathaoAreas).toHaveBeenCalledWith(22));
    fireEvent.change(screen.getByRole('combobox', { name: 'courier.pickup.area' }), { target: { value: '33' } });
    fireEvent.click(screen.getByRole('button', { name: /courier\.deliveryArea\.confirmButton/ }));

    await waitFor(() => expect(apiClient.confirmCourierDestination).toHaveBeenCalledWith('order-1', {
      provider: 'pathao',
      area_id: 33,
      area_name: 'Mirpur 10',
      zone_id: 22,
      zone_name: 'Mirpur Zone',
      city_id: 11,
      city_name: 'Dhaka',
    }));
  });
});
