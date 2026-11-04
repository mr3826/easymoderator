/**
 * CourierBookingModal — advertised boundary for destination coverage (D5-1).
 *
 * The server owns the enforcement policy and reports it as `enforced`. This
 * modal must never claim more than that: a NOT_SERVICEABLE verdict blocks the
 * Book button only when the server says enforcement is on, and an older
 * payload without the field fails closed.
 */
import '@testing-library/jest-dom';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import CourierBookingModal from '../CourierBookingModal';
import { apiClient } from '@/api';
import type { Order } from '@/api/types/order';

vi.mock('@/api', () => ({
  apiClient: {
    getCourierEligibility: vi.fn(),
    bookCourier: vi.fn(),
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
});