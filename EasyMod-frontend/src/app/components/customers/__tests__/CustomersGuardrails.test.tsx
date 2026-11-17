/**
 * Customers-worklist guardrails contracts (§8/§17/§18/§29): worklist signal
 * matrix, execution header without CTA + tabpanel semantics (pilot), and the
 * legacy create-customer dialog focus trap + Escape + label. Additive suite
 * (real i18n en); the legacy Customers/Customer360/CustomerContextPanel suites
 * stay unchanged.
 */
import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Customers from '../../Customers';
import Customer360Page from '../Customer360Page';
import { deriveCustomersSignal } from '../derive';
import { listCustomers360, listOpportunities, getPilotStatus } from '@/api/domains/customer-intelligence';
import { apiClient } from '@/api';

vi.mock('@/api/domains/customer-intelligence', () => ({
  getPilotStatus: vi.fn(),
  listCustomers360: vi.fn(),
  getCustomer360: vi.fn(),
  listOpportunities: vi.fn(),
  markOpportunityContacted: vi.fn(),
  dismissOpportunity: vi.fn(),
}));

vi.mock('@/api', () => ({
  apiClient: {
    getCustomers: vi.fn(),
    getCustomer: vi.fn(),
    createCustomer: vi.fn(),
    deleteCustomer: vi.fn(),
  },
}));

vi.mock('@/features/auth/AuthProvider', () => ({
  useAuth: () => ({ currentShop: { id: 'shop-1', role: 'owner', shop_name: 'Test Shop' } }),
}));

vi.mock('../../RtoNetworkSettings', () => ({ default: () => null }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

const customer = (overrides: Record<string, unknown> = {}) => ({
  id: 'c-1',
  name: 'Rahim Uddin',
  phone: '01711111111',
  channel_type: 'messenger',
  state: 'REPEAT_BUYER',
  state_reasons: [],
  total_orders: 1,
  delivered_orders: 1,
  returned_orders: 0,
  delivered_value: 1000,
  last_activity_at: new Date().toISOString(),
  open_opportunity: null,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getPilotStatus).mockResolvedValue({ customer_intelligence: true, order_confidence_mode: 'off' } as never);
  vi.mocked(listCustomers360).mockResolvedValue({ data: [customer()], total: 1, page: 1, pageSize: 20 } as never);
  vi.mocked(listOpportunities).mockResolvedValue({ data: [], total: 0, page: 1, pageSize: 20 } as never);
  vi.mocked(apiClient.getCustomers).mockResolvedValue({ data: [], total: 0, page: 1, pageSize: 20 } as never);
});

describe('worklist signal derivation', () => {
  const t = (key: string, opts?: Record<string, unknown>) => (opts?.count !== undefined ? `${key}:${opts.count}` : key);
  it('maps error / loading / opportunities / active / empty to distinct signals', () => {
    expect(deriveCustomersSignal({ phase: 'error', totalCount: null, opportunityCount: null }, t).kind).toBe('blocked');
    expect(deriveCustomersSignal({ phase: 'loading', totalCount: null, opportunityCount: null }, t).kind).toBe('pending');
    expect(deriveCustomersSignal({ phase: 'ready', totalCount: 5, opportunityCount: 2 }, t).kind).toBe('attention');
    expect(deriveCustomersSignal({ phase: 'ready', totalCount: 5, opportunityCount: 2 }, t).label).toContain('opportunities');
    expect(deriveCustomersSignal({ phase: 'ready', totalCount: 5, opportunityCount: 0 }, t).kind).toBe('healthy');
    expect(deriveCustomersSignal({ phase: 'ready', totalCount: 0, opportunityCount: 0 }, t).kind).toBe('attention');
  });
});

describe('pilot execution header', () => {
  it('shows title + signal + pills, no header CTA, and a tabpanel', async () => {
    render(<MemoryRouter><Customer360Page /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId('customers-signal').textContent).toContain('Customers active'));
    expect(screen.getByRole('heading', { level: 1, name: 'Customers' })).toBeInTheDocument();
    expect(screen.queryByTestId('dashboard-primary-action')).toBeNull();
    expect(screen.getByText(/Total:/)).toBeInTheDocument();
    expect(screen.getByRole('tabpanel')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /opportunities/i })).toHaveAttribute('aria-controls', 'customers-tabpanel');
  });
});

describe('legacy create-customer dialog', () => {
  it('is labelled, traps focus, and closes on Escape', async () => {
    vi.mocked(getPilotStatus).mockResolvedValue({ customer_intelligence: false, order_confidence_mode: 'off' } as never);
    render(<MemoryRouter><Customers /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: 'Add Customer' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
