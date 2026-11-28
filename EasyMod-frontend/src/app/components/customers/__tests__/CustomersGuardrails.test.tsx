/**
 * Customers-worklist guardrails contracts (§8/§17/§18 + header-removal
 * C1/C6): header band retired on both pilot and legacy surfaces (no signal
 * badge, no header CTA) with counts relocated to the tab strip / search
 * toolbar, plus tabpanel semantics (pilot) and the legacy create-customer
 * dialog focus trap + Escape + label. Additive suite (real i18n en); the
 * legacy Customers/Customer360/CustomerContextPanel suites stay unchanged.
 */
import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Customers from '../../Customers';
import Customer360Page from '../Customer360Page';
import { listCustomers360, listOpportunities, getPilotStatus, getCustomerOverview } from '@/api/domains/customer-intelligence';
import { apiClient } from '@/api';

vi.mock('@/api/domains/customer-intelligence', () => ({
  getPilotStatus: vi.fn(),
  getCustomerOverview: vi.fn(),
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
    updateCustomer: vi.fn(),
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
  vi.mocked(getCustomerOverview).mockResolvedValue({
    total_records: 1, buyers: 1, repeat_buyers: 0, new_buyers: 1, open_opportunities: 0, scanned_orders: 1, total_linked_orders: 1, order_scan_cap: 100,
    coverage_complete: true, definitions: { buyers: 'buyers', repeat_buyers: 'repeat', new_buyers: 'new', open_opportunities: 'open' },
  } as never);
  vi.mocked(listCustomers360).mockResolvedValue({ data: [customer()], total: 1, page: 1, pageSize: 20 } as never);
  vi.mocked(listOpportunities).mockResolvedValue({ data: [], total: 0, page: 1, pageSize: 20 } as never);
  vi.mocked(apiClient.getCustomers).mockResolvedValue({ data: [], total: 0, page: 1, pageSize: 20 } as never);
});

describe('pilot page header (header-removal C1/C6)', () => {
  it('keeps the compact visible title, drops the signal band, counts live in the tab strip', async () => {
    render(<MemoryRouter><Customer360Page /></MemoryRouter>);
    // C4: the list total is honest on the 'all' tab badge (were header pills).
    await waitFor(() => expect(screen.getByTestId('customers-tab-all').textContent).toContain('1'));
    // C1: record-page style compact heading stays visible for orientation.
    expect(screen.getByRole('heading', { level: 1, name: 'Customers' })).toBeInTheDocument();
    // C6: the page-level signal badge must NOT exist any more.
    expect(screen.queryByTestId('customers-signal')).toBeNull();
    expect(screen.queryByTestId('dashboard-primary-action')).toBeNull();
    expect(screen.queryByText(/Total:/)).toBeNull();
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
