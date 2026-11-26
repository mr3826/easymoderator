/**
 * Orders-worklist guardrails contracts (§8/§17/§18 + header-removal C1/C6):
 * header band retired (sr-only h1, no signal badge, no header CTA) with the
 * honest bucket counts relocated to the toolbar, create-order dialog focus
 * trap + Escape + label, and the payment-reconciliation alert honesty
 * (role + copy, never a settlement claim). Additive suite (real i18n en);
 * the legacy Orders/Courier/Confidence suites stay unchanged.
 */
import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Orders from '../../Orders';
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
    cancelOrder: vi.fn(),
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

describe('page header (header-removal C1/C6)', () => {
  it('renders only the sr-only h1 and no header CTA; honest counts live in the toolbar', async () => {
    renderOrders();
    await waitFor(() => expect(screen.getByTestId('orders-bucket-count-all').textContent).toBe('1'));
    // C1: AppBar owns the visible name; the h1 keeps its accessible name.
    expect(screen.getByRole('heading', { level: 1, name: 'Orders' })).toBeInTheDocument();
    // C6: the page-level signal badge must NOT exist any more.
    expect(screen.queryByTestId('orders-signal')).toBeNull();
    expect(screen.queryByTestId('dashboard-primary-action')).toBeNull();
    // The retired meta pills' facts were already in the bucket toolbar (C4).
    expect(screen.getByTestId('orders-bucket-count-all')).toHaveTextContent('1');
    expect(screen.getByTestId('orders-bucket-count-needs_action')).toHaveTextContent('0');
    expect(screen.queryByText(/Total:/)).toBeNull();
    expect(screen.queryByText(/Needs action:/)).toBeNull();
  });

  it('surfaces needs-action through the bucket count when the server aggregate says so', async () => {
    vi.mocked(apiClient.getOrderCounts).mockResolvedValue(counts({ total: 4, needs_action: 2 }) as never);
    renderOrders();
    await waitFor(() => expect(screen.getByTestId('orders-bucket-count-needs_action').textContent).toBe('2'));
    await waitFor(() => expect(screen.getByTestId('orders-bucket-count-all').textContent).toBe('4'));
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

describe('cancellation uses the cancel endpoint', () => {
  it('calls cancelOrder, never the generic status update that always answers 409', async () => {
    // Regression: ORDER_STATUS_TRANSITIONS has no path to 'cancelled', so routing
    // Cancel through updateOrder threw 409 every time and left the order active
    // with its stock unrestored.
    const source = order();
    vi.mocked(apiClient.getOrders).mockResolvedValue([source] as never);
    vi.mocked(apiClient.cancelOrder).mockResolvedValue({ ...source, status: 'cancelled' } as never);
    renderOrders();
    const detailButtons = await screen.findAllByRole('button', { name: /view detail/i });
    fireEvent.click(detailButtons[0]);
    const panel = await screen.findByTestId('order-detail-panel');
    fireEvent.click(within(panel).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(apiClient.cancelOrder).toHaveBeenCalledWith(source.id));
    expect(apiClient.updateOrder).not.toHaveBeenCalled();
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
