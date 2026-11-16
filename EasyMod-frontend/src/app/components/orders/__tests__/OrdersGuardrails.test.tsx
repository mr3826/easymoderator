/**
 * Orders-worklist guardrails contracts (§8/§17/§18/§29): worklist signal matrix,
 * execution header without CTA, create-order dialog focus trap + Escape + label,
 * and the payment-reconciliation alert honesty (role + copy, never a settlement
 * claim). Additive suite (real i18n en); the legacy Orders/Courier/Confidence
 * suites stay unchanged.
 */
import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Orders from '../../Orders';
import { deriveOrdersSignal } from '../derive';
import { apiClient } from '@/api';

const navigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => navigate };
});

vi.mock('@/api', () => ({
  apiClient: {
    getOrders: vi.fn(),
    getOrderCounts: vi.fn(),
    getProducts: vi.fn(),
    getPaymentConfig: vi.fn(),
    getOrder: vi.fn(),
    getConversations: vi.fn(),
    getMessages: vi.fn(),
    createOrder: vi.fn(),
    updateOrder: vi.fn(),
    confirmOrder: vi.fn(),
  },
}));

vi.mock('../OrderConfidencePanel', () => ({ default: () => null }));
vi.mock('@/features/auth/AuthProvider', () => ({
  useAuth: () => ({ currentShop: { id: 'shop-1', role: 'owner', shop_name: 'Test Shop' } }),
}));

const order = (overrides: Record<string, unknown> = {}) => ({
  id: 'o1',
  orderNumber: 'ORD-1001',
  customerName: 'Rahim Uddin',
  customerPhone: '01712345678',
  deliveryAddress: 'Mirpur 10, Dhaka',
  items: [{ productId: 'p1', productName: 'Azal Lawn cap', quantity: 1, price: 1200 }],
  total: 1200,
  status: 'confirmed',
  channel: 'facebook',
  payment_method: 'cod',
  payment_status: 'pending',
  createdAt: '2026-10-20T08:00:00Z',
  ...overrides,
});

const counts = (overrides: Record<string, unknown> = {}) => ({
  total: 1, to_confirm: 0, to_pack: 1, booked: 0, in_transit: 0, needs_action: 0, returned: 0, delivered: 0,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(apiClient.getOrders).mockResolvedValue([order()] as never);
  vi.mocked(apiClient.getOrderCounts).mockResolvedValue(counts() as never);
  vi.mocked(apiClient.getProducts).mockResolvedValue([] as never);
  vi.mocked(apiClient.getPaymentConfig).mockResolvedValue({ success: true, data: [{ gateway: 'cod', is_enabled: true }] } as never);
  vi.mocked(apiClient.getConversations).mockResolvedValue({ data: [], total: 0, page: 1, pageSize: 1 } as never);
  vi.mocked(apiClient.getMessages).mockResolvedValue({ messages: [], pagination: { page: 1, totalPages: 1 } } as never);
});

function renderOrders() {
  return render(<MemoryRouter><Orders /></MemoryRouter>);
}

describe('worklist signal derivation', () => {
  const t = (key: string, opts?: Record<string, unknown>) => (opts?.count !== undefined ? `${key}:${opts.count}` : key);
  it('maps error / loading / needs-action / flowing / empty to distinct signals', () => {
    expect(deriveOrdersSignal({ phase: 'error', totalCount: null, needsActionCount: null }, t).kind).toBe('blocked');
    expect(deriveOrdersSignal({ phase: 'loading', totalCount: null, needsActionCount: null }, t).kind).toBe('pending');
    expect(deriveOrdersSignal({ phase: 'ready', totalCount: 5, needsActionCount: 2 }, t).kind).toBe('attention');
    expect(deriveOrdersSignal({ phase: 'ready', totalCount: 5, needsActionCount: 2 }, t).label).toContain('needsAction');
    expect(deriveOrdersSignal({ phase: 'ready', totalCount: 5, needsActionCount: 0 }, t).kind).toBe('healthy');
    expect(deriveOrdersSignal({ phase: 'ready', totalCount: 0, needsActionCount: 0 }, t).kind).toBe('attention');
    expect(deriveOrdersSignal({ phase: 'ready', totalCount: null, needsActionCount: null }, t).kind).toBe('attention');
  });
});

describe('execution header', () => {
  it('shows title + signal + factual pills and no header CTA', async () => {
    renderOrders();
    await waitFor(() => expect(screen.getByTestId('orders-signal').textContent).toContain('Orders flowing'));
    expect(screen.getByRole('heading', { level: 1, name: 'Orders' })).toBeInTheDocument();
    expect(screen.queryByTestId('dashboard-primary-action')).toBeNull();
    expect(screen.getByText(/Total:/)).toBeInTheDocument();
    expect(screen.getByText(/Needs action:/)).toBeInTheDocument();
  });

  it('surfaces needs-action when the server aggregate says so', async () => {
    vi.mocked(apiClient.getOrderCounts).mockResolvedValue(counts({ total: 4, needs_action: 2 }) as never);
    renderOrders();
    await waitFor(() => expect(screen.getByTestId('orders-signal').textContent).toContain('Orders need action'));
  });
});

describe('create-order dialog', () => {
  it('is labelled, traps focus, and closes on Escape', async () => {
    renderOrders();
    fireEvent.click(await screen.findByRole('button', { name: /create order/i }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('aria-labelledby', 'create-order-title');
    expect(screen.getByTestId('create-order-modal')).toBe(dialog);
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});

describe('payment reconciliation honesty', () => {
  it('renders the COD reconciliation alert and never claims settlement', async () => {
    vi.mocked(apiClient.getOrders).mockResolvedValue([order({
      metadata: { payment_reconciliation: { required: true, code: 'COD_COURIER_COLLECTION_REVIEW_REQUIRED' } },
    })] as never);
    renderOrders();
    const detailButtons = await screen.findAllByRole('button', { name: /view detail/i });
    fireEvent.click(detailButtons[0]);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('COD collection needs reconciliation');
    expect(alert).toHaveTextContent(/does not confirm that the order total was collected or that COD is settled/i);
    expect(screen.queryByText(/settled COD|cash received|courier settlement/i)).toBeNull();
  });
});
