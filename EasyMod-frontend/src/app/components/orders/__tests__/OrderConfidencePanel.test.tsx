import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '@/i18n';
import type { OrderConfidenceDecision } from '@/api/types/customer-intelligence';

const api = vi.hoisted(() => ({
  getOrderConfidence: vi.fn(),
  verifyOrderConfidence: vi.fn(),
  approveOrderConfidence: vi.fn(),
}));
const auth = vi.hoisted(() => ({ role: 'staff' }));

vi.mock('@/api/domains/order-confidence', async () => {
  const actual = await vi.importActual<typeof import('@/api/domains/order-confidence')>('@/api/domains/order-confidence');
  return { ...actual, ...api };
});
vi.mock('../../../../features/auth/AuthProvider', () => ({
  useAuth: () => ({ currentShop: { id: 'shop-1', role: auth.role } }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

import OrderConfidencePanel from '../OrderConfidencePanel';

const decision = (overrides: Partial<OrderConfidenceDecision> = {}): OrderConfidenceDecision => ({
  order_id: 'o-1',
  mode: 'enforce',
  decision: 'VERIFY',
  effective_state: 'VERIFY',
  bookable: true,
  required_action: 'VERIFY',
  reasons: [
    { code: 'ADDRESS_TOO_SHORT', severity: 'VERIFY', source: 'ORDER', evidence: { length: 9, minimum: 15 } },
    { code: 'NEW_CUSTOMER', severity: 'INFO', source: 'ORDER_HISTORY', evidence: { previous_orders: 0 } },
  ],
  rules_version: 'order-confidence/1.0.0',
  evaluated_at: '2026-09-27T10:00:00Z',
  decision_version: 4,
  resolution: null,
  gate: { last_result: 'HELD', last_at: '2026-09-27T10:00:00Z', held_count: 1 },
  history: [{ at: '2026-09-27T10:00:00Z', event: 'HELD', decision: 'VERIFY' }],
  ...overrides,
});

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

beforeEach(() => {
  vi.clearAllMocks();
  auth.role = 'staff';
});

describe('OrderConfidencePanel', () => {
  it('renders nothing for shops without the pilot', async () => {
    api.getOrderConfidence.mockResolvedValue({ order_id: 'o-1', mode: 'off', decision: null });
    const { container } = render(<OrderConfidencePanel orderId="o-1" />);
    await waitFor(() => expect(api.getOrderConfidence).toHaveBeenCalled());
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('keeps confidence unavailable after a lookup error and retries explicitly', async () => {
    api.getOrderConfidence
      .mockRejectedValueOnce(new Error('network unavailable'))
      .mockResolvedValueOnce(decision({ decision: 'READY', effective_state: 'READY', required_action: 'NONE' }));
    render(<OrderConfidencePanel orderId="o-1" />);

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not check this order/i);
    expect(screen.queryByTestId('order-confidence-decision')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByTestId('order-confidence-decision')).toHaveTextContent('Ready to ship');
    expect(api.getOrderConfidence).toHaveBeenCalledTimes(2);
  });

  it('explains a VERIFY decision with its evidence and separates context', async () => {
    api.getOrderConfidence.mockResolvedValue(decision());
    render(<OrderConfidencePanel orderId="o-1" />);
    expect(await screen.findByTestId('order-confidence-decision')).toHaveTextContent('Needs verification');
    expect(screen.getByText('Courier booking is paused until this order is checked.')).toBeInTheDocument();
    expect(screen.getByTestId('order-confidence-reasons')).toHaveTextContent('Address looks incomplete (9 characters)');
    expect(screen.getByTestId('order-confidence-reasons')).not.toHaveTextContent('First order');
    expect(screen.getByText(/Context: First order from this number/)).toBeInTheDocument();
  });

  it('records a verification with the decision version the merchant saw', async () => {
    api.getOrderConfidence.mockResolvedValue(decision());
    api.verifyOrderConfidence.mockResolvedValue(decision({
      effective_state: 'READY', required_action: 'NONE',
      resolution: { type: 'VERIFIED', level: 'VERIFY', method: 'CHAT', note: null, resolved_by: 'u', resolved_at: '2026-09-27T10:05:00Z', applies: true, stale: false },
    }));
    render(<OrderConfidencePanel orderId="o-1" />);
    fireEvent.change(await screen.findByRole('combobox'), { target: { value: 'CHAT' } });
    fireEvent.click(screen.getByTestId('order-confidence-submit'));
    await waitFor(() => expect(api.verifyOrderConfidence).toHaveBeenCalledWith('o-1', { decision_version: 4, method: 'CHAT' }));
    expect(await screen.findByTestId('order-confidence-decision')).toHaveTextContent('Cleared for booking');
  });

  it('refreshes to the new decision when the order changed in the meantime (409)', async () => {
    api.getOrderConfidence.mockResolvedValue(decision());
    api.verifyOrderConfidence.mockRejectedValue({
      statusCode: 409, code: 'DECISION_CHANGED',
      details: { decision: decision({ decision: 'MANUAL_REVIEW', effective_state: 'MANUAL_REVIEW', required_action: 'APPROVE', decision_version: 5 }) },
    });
    render(<OrderConfidencePanel orderId="o-1" />);
    fireEvent.click(await screen.findByTestId('order-confidence-submit'));
    expect(await screen.findByTestId('order-confidence-decision')).toHaveTextContent('Needs owner review');
    // staff cannot approve: the form is replaced by guidance
    expect(screen.getByTestId('order-confidence-approve-help')).toBeInTheDocument();
    expect(screen.queryByTestId('order-confidence-submit')).not.toBeInTheDocument();
  });

  it('lets an owner approve MANUAL_REVIEW only with a written reason', async () => {
    auth.role = 'owner';
    api.getOrderConfidence.mockResolvedValue(decision({
      decision: 'MANUAL_REVIEW', effective_state: 'MANUAL_REVIEW', required_action: 'APPROVE',
      reasons: [{ code: 'REPEATED_RETURNS', severity: 'REVIEW', source: 'ORDER_HISTORY', evidence: { returned: 2, delivered: 0 } }],
    }));
    api.approveOrderConfidence.mockResolvedValue(decision({ effective_state: 'READY', required_action: 'NONE' }));
    render(<OrderConfidencePanel orderId="o-1" />);
    expect(await screen.findByTestId('order-confidence-reasons')).toHaveTextContent('2 returned vs 0 delivered before');
    const submit = screen.getByTestId('order-confidence-submit');
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Called — confirmed address' } });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    await waitFor(() => expect(api.approveOrderConfidence).toHaveBeenCalledWith('o-1', {
      decision_version: 4, note: 'Called — confirmed address',
    }));
  });

  it('shows the trial-mode note in shadow mode and a stale clearance warning', async () => {
    api.getOrderConfidence.mockResolvedValue(decision({
      mode: 'shadow',
      resolution: { type: 'APPROVED', level: 'MANUAL_REVIEW', method: null, note: 'ok', resolved_by: 'u', resolved_at: null, applies: false, stale: true },
    }));
    render(<OrderConfidencePanel orderId="o-1" />);
    expect(await screen.findByText(/Trial mode/)).toBeInTheDocument();
    expect(screen.getByText(/edited after it was cleared/)).toBeInTheDocument();
  });

  it('says so when the order cannot be booked at all', async () => {
    api.getOrderConfidence.mockResolvedValue(decision({
      decision: 'MANUAL_REVIEW', effective_state: 'MANUAL_REVIEW', bookable: false, required_action: 'NOT_BOOKABLE',
      reasons: [{ code: 'ORDER_CANCELLED', severity: 'BLOCK', source: 'ORDER', evidence: {} }],
    }));
    render(<OrderConfidencePanel orderId="o-1" />);
    expect(await screen.findByText('This order cannot be booked.')).toBeInTheDocument();
    expect(screen.queryByTestId('order-confidence-submit')).not.toBeInTheDocument();
  });
});
