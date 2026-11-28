import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '@/i18n';
import type { Customer360Detail, Customer360ListItem, Opportunity } from '@/api/types/customer-intelligence';
import { formatMoney } from '../customerDisplay';

const api = vi.hoisted(() => ({
  getPilotStatus: vi.fn(),
  getCustomerOverview: vi.fn(),
  listCustomers360: vi.fn(),
  getCustomer360: vi.fn(),
  listOpportunities: vi.fn(),
  markOpportunityContacted: vi.fn(),
  dismissOpportunity: vi.fn(),
}));
const legacyApi = vi.hoisted(() => ({
  getCustomers: vi.fn(),
  getCustomer: vi.fn(),
  createCustomer: vi.fn(),
  updateCustomer: vi.fn(),
  deleteCustomer: vi.fn(),
}));
const crmApi = vi.hoisted(() => ({
  listCustomerNotes: vi.fn(),
  createCustomerNote: vi.fn(),
  deleteCustomerNote: vi.fn(),
  listCustomerTags: vi.fn(),
  listTagVocabulary: vi.fn(),
  setCustomerTags: vi.fn(),
}));
const auth = vi.hoisted(() => ({ role: 'owner', userId: 'staff-1' }));
vi.mock('@/api/domains/customer-intelligence', () => api);
vi.mock('@/api', () => ({ apiClient: legacyApi }));
vi.mock('@/api/domains/customer-crm', () => crmApi);
vi.mock('@/features/auth/AuthProvider', () => ({ useAuth: () => ({ currentShop: { role: auth.role } }) }));
vi.mock('@/app/lib/auth', () => ({ authService: { getState: () => ({ user: { id: auth.userId }, currentShop: { role: auth.role } }) } }));
vi.mock('../../RtoNetworkSettings', () => ({ default: () => null }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

import Customer360Page from '../Customer360Page';
import CustomerDetailPage from '../CustomerDetailPage';

const customer = (overrides: Partial<Customer360ListItem> = {}): Customer360ListItem => ({
  id: 'c-1',
  name: 'Rahim Uddin',
  phone: '01711111111',
  email: null,
  channel_type: 'messenger',
  profile_pic: null,
  first_seen_at: '2026-09-01T00:00:00Z',
  state: 'REPEAT_BUYER',
  state_reasons: [{ code: 'MULTIPLE_DELIVERIES', params: { delivered: 3 } }],
  total_orders: 4,
  delivered_orders: 3,
  returned_orders: 0,
  delivered_value: 4500,
  last_order_at: '2026-09-20T00:00:00Z',
  last_activity_at: new Date().toISOString(),
  open_opportunity: null,
  ...overrides,
});

const lowerBoundMoney = (value: number) => `${formatMoney(value, 'en').replace(/\u00a0/g, ' ')}+`;

const opportunity = (overrides: Partial<Opportunity> = {}): Opportunity => ({
  id: 'op-1',
  status: 'OPEN',
  strength: 'HIGH',
  reasons: ['PURCHASE_INTENT', 'ASKED_DELIVERY_CHARGE'],
  signals: [],
  product_refs: [{ product_id: 'p-1', name: 'Black Panjabi', quantity: 2 }],
  customer_id: 'c-2',
  conversation_id: 'conv-9',
  first_signal_at: '2026-09-27T08:00:00Z',
  last_signal_at: '2026-09-27T08:10:00Z',
  detected_at: '2026-09-27T09:00:00Z',
  actioned_at: null,
  converted_order_id: null,
  resolved_at: null,
  resolution_reason: null,
  recommended_action: { code: 'REPLY_IN_INBOX', window_closes_at: '2026-09-28T08:10:00Z' },
  customer: { id: 'c-2', name: 'Karim', channel_type: 'messenger' },
  ...overrides,
});

const renderAt = (path: string) => render(
  <MemoryRouter initialEntries={[path]}>
    <Routes>
      <Route path="/customers" element={<Customer360Page />} />
      <Route path="/customers/:customerId" element={<CustomerDetailPage />} />
      <Route path="/inbox" element={<p>inbox page</p>} />
      <Route path="/orders" element={<p>orders page</p>} />
    </Routes>
  </MemoryRouter>,
);

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

beforeEach(() => {
  vi.clearAllMocks();
  auth.role = 'owner';
  api.getPilotStatus.mockResolvedValue({ customer_intelligence: true, order_confidence_mode: 'off' });
  api.getCustomerOverview.mockResolvedValue({
    total_records: 41, buyers: 12, repeat_buyers: 4, new_buyers: 8, open_opportunities: 3,
    scanned_orders: 300, total_linked_orders: 900, order_scan_cap: 500, coverage_complete: false,
    definitions: { buyers: 'At least one delivered order', repeat_buyers: 'At least two delivered orders', new_buyers: 'One delivered order', open_opportunities: 'Open opportunities' },
  });
  api.listOpportunities.mockResolvedValue({ data: [], total: 0, page: 1, pageSize: 20 });
  legacyApi.getCustomers.mockResolvedValue({ data: [], total: 0, page: 1, pageSize: 20 });
  legacyApi.getCustomer.mockResolvedValue({ id: 'c-legacy', name: 'Legacy Customer', number: '01712345678', email: null, channel: 'manual', created_at: '2026-10-01T00:00:00Z' });
  legacyApi.createCustomer.mockResolvedValue({ id: 'c-new', name: 'New Customer', number: '01722222222', email: null, channel: 'manual' });
  legacyApi.updateCustomer.mockResolvedValue({ id: 'c-1', name: 'Rahim Uddin', number: '01711111111', email: 'rahim@example.com', channel: 'messenger' });
  legacyApi.deleteCustomer.mockResolvedValue(undefined);
  crmApi.listCustomerNotes.mockResolvedValue({ data: [], total: 0 });
  crmApi.createCustomerNote.mockImplementation(async (_id: string, body: string) => ({ id: 'note-1', shop_id: 'shop-1', customer_id: 'c-1', body, author_id: auth.userId, author_name: 'Staff', created_at: '2026-10-20T10:00:00Z', updated_at: '2026-10-20T10:00:00Z' }));
  crmApi.deleteCustomerNote.mockResolvedValue(undefined);
  crmApi.listCustomerTags.mockResolvedValue({ data: [] });
  crmApi.listTagVocabulary.mockResolvedValue({ data: [{ id: 'tag-1', shop_id: 'shop-1', name: 'VIP' }] });
  crmApi.setCustomerTags.mockImplementation(async (_id: string, tagIds: string[]) => ({ data: [{ id: 'tag-1', shop_id: 'shop-1', name: 'VIP' }].filter((tag) => tagIds.includes(tag.id)) }));
});

describe('Customer 360 list', () => {
  it('shows each customer with a neutral state, order counts and delivered value', async () => {
    api.listCustomers360.mockResolvedValue({
      data: [
        customer(),
        customer({ id: 'c-3', name: 'Salma', state: 'AT_RISK', state_reasons: [{ code: 'RETURNS_NOT_LESS_THAN_DELIVERIES', params: { returned: 2, delivered: 1 } }] }),
      ],
      total: 2, page: 1, pageSize: 20,
    });
    renderAt('/customers');
    const table = await screen.findByTestId('customer-table');
    const row = within(table).getByTestId('customer-row-c-1');
    expect(row).toHaveTextContent('Rahim Uddin');
    expect(row).toHaveTextContent('Repeat buyer');
    expect(row).toHaveTextContent('3 delivered of 4');
    expect(row).toHaveTextContent('4,500');
    // "Return history", never an accusation.
    expect(within(table).getByTestId('customer-row-c-3')).toHaveTextContent('Return history');
    expect(screen.queryByText(/fraud/i)).not.toBeInTheDocument();
  });

  it('searches on the server with the typed term', async () => {
    api.listCustomers360.mockResolvedValue({ data: [], total: 0, page: 1, pageSize: 20 });
    renderAt('/customers');
    await screen.findByText(/No customers yet/);
    fireEvent.change(screen.getByLabelText('Search by name'), { target: { value: 'Rahim' } });
    await waitFor(() => expect(api.listCustomers360).toHaveBeenLastCalledWith(expect.objectContaining({ search: 'Rahim', pageSize: 20 })));
    expect(await screen.findByText('No customers match your search.')).toBeInTheDocument();
  });

  it('filters by name, phone, and localized channel on the server with 20-row pagination', async () => {
    api.listCustomers360.mockResolvedValue({ data: [], total: 0, page: 1, pageSize: 20 });
    renderAt('/customers');
    await screen.findByText(/No customers yet/);

    fireEvent.change(screen.getByLabelText('Search by name'), { target: { value: 'Rahim' } });
    fireEvent.change(screen.getByLabelText('Search by phone'), { target: { value: '01711111111' } });
    fireEvent.change(screen.getByLabelText('All Channels'), { target: { value: 'instagram' } });
    await waitFor(() => expect(api.listCustomers360).toHaveBeenLastCalledWith({
      page: 1, pageSize: 20, search: 'Rahim', phone: '01711111111', channel_type: 'instagram',
    }));
  });

  it('moves to the next 20-customer server page', async () => {
    api.listCustomers360.mockResolvedValue({ data: [customer()], total: 25, page: 1, pageSize: 20 });
    renderAt('/customers');
    await screen.findByTestId('customer-table');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(api.listCustomers360).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2, pageSize: 20 })));
  });

  it('renders the actual overview values and reports overview failure without zero placeholders', async () => {
    api.listCustomers360.mockResolvedValue({ data: [customer()], total: 1, page: 1, pageSize: 20 });
    const { unmount } = renderAt('/customers');
    expect(await screen.findByText('Customer overview')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('customer-overview')).toHaveTextContent('41'));
    expect(screen.getByTestId('customer-overview')).toHaveTextContent('300');
    unmount();

    api.getCustomerOverview.mockRejectedValue(new Error('overview unavailable'));
    renderAt('/customers');
    expect(await screen.findByRole('alert')).toHaveTextContent('Customer overview is unavailable. Counts are not shown.');
    expect(within(screen.getByTestId('customer-overview')).queryByText('0')).not.toBeInTheDocument();
  });

  it('shows an error with a working retry', async () => {
    api.listCustomers360.mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ data: [customer()], total: 1, page: 1, pageSize: 20 });
    renderAt('/customers');
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    expect(await screen.findByTestId('customer-row-c-1')).toBeInTheDocument();
  });

  it('opens the customer detail from a row', async () => {
    api.listCustomers360.mockResolvedValue({ data: [customer()], total: 1, page: 1, pageSize: 20 });
    api.getCustomer360.mockReturnValue(new Promise(() => {}));
    renderAt('/customers');
    const row = await screen.findByTestId('customer-row-c-1');
    fireEvent.click(within(row).getByRole('button', { name: 'Rahim Uddin' }));
    expect(await screen.findByText('Back to customers')).toBeInTheDocument();
    expect(api.getCustomer360).toHaveBeenCalledWith('c-1');
  });

  it('opens the customer edit dialog from the 360 row action', async () => {
    api.listCustomers360.mockResolvedValue({ data: [customer()], total: 1, page: 1, pageSize: 20 });
    renderAt('/customers');
    const row = await screen.findByTestId('customer-row-c-1');

    fireEvent.click(within(row).getByRole('button', { name: 'Edit' }));

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Rahim Uddin')).toBeInTheDocument();
  });

  it('opens a named delete confirmation from the 360 row action', async () => {
    api.listCustomers360.mockResolvedValue({ data: [customer()], total: 1, page: 1, pageSize: 20 });
    renderAt('/customers');
    const row = await screen.findByTestId('customer-row-c-1');
    fireEvent.click(within(row).getByRole('button', { name: 'Delete Customer' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Delete Rahim Uddin? This action cannot be undone.')).toBeInTheDocument();
  });

  it('marks per-customer order summaries as lower bounds when a page scan is capped', async () => {
    api.listCustomers360.mockResolvedValue({
      data: [customer({
        delivered_orders: 2,
        total_orders: 600,
        order_coverage: { scanned: 500, total: 600, cap: 5000, complete: false },
      })],
      total: 1,
      page: 1,
      pageSize: 20,
    });
    renderAt('/customers');
    const row = await screen.findByTestId('customer-row-c-1');
    expect(row).toHaveTextContent('2+ delivered of 600');
    expect(row).toHaveTextContent('500 of 600 linked orders scanned');
    expect(row).toHaveTextContent(lowerBoundMoney(4500));
  });

  it('creates, edits, and deletes customer records through legacy CRUD while the pilot list stays on Customer 360', async () => {
    api.listCustomers360.mockResolvedValue({ data: [customer()], total: 1, page: 1, pageSize: 20 });
    renderAt('/customers');
    await screen.findByTestId('customer-table');

    fireEvent.click(screen.getByRole('button', { name: 'Add Customer' }));
    const channelSelect = screen.getByLabelText(/^Channel/);
    expect(within(channelSelect).queryByRole('option', { name: 'Instagram' })).not.toBeInTheDocument();
    expect(within(channelSelect).queryByRole('option', { name: 'Messenger' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'New Customer' } });
    fireEvent.change(screen.getByLabelText(/Phone Number/), { target: { value: '01722222222' } });
    fireEvent.change(screen.getByLabelText(/^Channel/), { target: { value: 'manual' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(legacyApi.createCustomer).toHaveBeenCalledWith({
      name: 'New Customer', number: '01722222222', email: undefined, channel: 'manual',
    }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    const row = await screen.findByTestId('customer-row-c-1');
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
    fireEvent.click(within(row).getByRole('button', { name: 'Edit' }));
    await screen.findByRole('dialog');
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Rahim Edited' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(legacyApi.updateCustomer).toHaveBeenCalledWith('c-1', {
      name: 'Rahim Edited', number: '01711111111', email: null,
    }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    const updatedRow = await screen.findByTestId('customer-row-c-1');
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
    fireEvent.click(within(updatedRow).getByRole('button', { name: 'Delete Customer' }));
    const deleteDialog = await screen.findByRole('dialog');
    fireEvent.click(within(deleteDialog).getByRole('button', { name: 'Delete Customer' }));
    await waitFor(() => expect(legacyApi.deleteCustomer).toHaveBeenCalledWith('c-1'));
  });

  it('surfaces duplicate phone conflicts from customer edits', async () => {
    api.listCustomers360.mockResolvedValue({ data: [customer()], total: 1, page: 1, pageSize: 20 });
    legacyApi.updateCustomer.mockRejectedValue({ statusCode: 409, type: 'CONFLICT', message: 'Conflict. This resource already exists.' });
    renderAt('/customers');
    await screen.findByTestId('customer-table');
    fireEvent.click((await screen.findAllByRole('button', { name: 'Edit' }))[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('A customer with this phone number already exists.');
  });
});

describe('Sales opportunities', () => {
  it('lists open opportunities with plain-language reasons and the next manual step', async () => {
    api.listOpportunities.mockResolvedValue({ data: [opportunity()], total: 1, page: 1, pageSize: 20 });
    renderAt('/customers?tab=opportunities');
    const card = await screen.findByTestId('opportunity-op-1');
    expect(card).toHaveTextContent('Karim');
    expect(card).toHaveTextContent('Strong interest');
    expect(card).toHaveTextContent('Said they want to order');
    expect(card).toHaveTextContent('Asked about delivery charge');
    expect(card).toHaveTextContent('Black Panjabi × 2');
    expect(within(card).getByTestId('opportunity-recommended-action')).toHaveTextContent('Reply in the Inbox before');
    expect(screen.getByTestId('customers-tab-opportunities')).toHaveTextContent('1');
  });

  it('marks an opportunity contacted through the API', async () => {
    api.listOpportunities.mockResolvedValue({ data: [opportunity()], total: 1, page: 1, pageSize: 20 });
    api.markOpportunityContacted.mockResolvedValue(opportunity({ status: 'ACTIONED' }));
    renderAt('/customers?tab=opportunities');
    fireEvent.click(await screen.findByRole('button', { name: /Mark contacted/ }));
    await waitFor(() => expect(api.markOpportunityContacted).toHaveBeenCalledWith('op-1'));
    expect(await screen.findByText('Contacted')).toBeInTheDocument();
  });

  it('dismisses with a reason and removes the card', async () => {
    api.listOpportunities.mockResolvedValue({ data: [opportunity()], total: 1, page: 1, pageSize: 20 });
    api.dismissOpportunity.mockResolvedValue(opportunity({ status: 'DISMISSED' }));
    renderAt('/customers?tab=opportunities');
    const card = await screen.findByTestId('opportunity-op-1');
    fireEvent.click(within(card).getByRole('button', { name: /Dismiss/ }));
    fireEvent.change(within(card).getByRole('combobox'), { target: { value: 'ALREADY_HANDLED' } });
    fireEvent.click(within(card).getAllByRole('button', { name: 'Dismiss' }).pop()!);
    await waitFor(() => expect(api.dismissOpportunity).toHaveBeenCalledWith('op-1', 'ALREADY_HANDLED'));
    await waitFor(() => expect(screen.queryByTestId('opportunity-op-1')).not.toBeInTheDocument());
  });

  it('never offers a follow-up for a customer who opted out', async () => {
    api.listOpportunities.mockResolvedValue({
      data: [opportunity({ recommended_action: { code: 'DO_NOT_CONTACT' } })], total: 1, page: 1, pageSize: 20,
    });
    renderAt('/customers?tab=opportunities');
    const card = await screen.findByTestId('opportunity-op-1');
    expect(card).toHaveTextContent('This customer asked not to be messaged.');
    expect(within(card).queryByRole('button', { name: /Open conversation/ })).not.toBeInTheDocument();
  });

  it('opens the conversation in the Inbox — the send itself happens there', async () => {
    api.listOpportunities.mockResolvedValue({ data: [opportunity()], total: 1, page: 1, pageSize: 20 });
    renderAt('/customers?tab=opportunities');
    fireEvent.click(await screen.findByRole('button', { name: /Open conversation/ }));
    expect(await screen.findByText('inbox page')).toBeInTheDocument();
  });

  it('explains the empty state', async () => {
    renderAt('/customers?tab=opportunities');
    expect(await screen.findByText(/No open sales opportunities right now/)).toBeInTheDocument();
  });
});

describe('Customer detail', () => {
  const detail = (): Customer360Detail => ({
    customer: {
      id: 'c-1', name: 'Rahim Uddin', phone: '01711111111', email: null, channel_type: 'messenger',
      profile_pic: null, first_seen_at: '2026-09-01T00:00:00Z', last_activity_at: '2026-09-26T00:00:00Z',
      last_inbound_at: '2026-09-26T00:00:00Z', page: { id: 'pg', name: 'Rahim Fashion', platform: 'facebook' },
    },
    contactability: { platform: 'facebook', window_open: false, window_closes_at: null, reason: 'OUTSIDE_24H_WINDOW' },
    state: 'REPEAT_BUYER',
    state_reasons: [{ code: 'MULTIPLE_DELIVERIES', params: { delivered: 2 } }],
    state_rules_version: 'customer-state/1.0.0',
    summary: {
      total_orders: 3, delivered_orders: 2, returned_orders: 0, cancelled_orders: 1, in_progress_orders: 0,
      ordered_value: 3000, delivered_value: 3000, first_order_at: '2026-09-02T00:00:00Z',
      last_order_at: '2026-09-20T00:00:00Z', last_delivered_at: '2026-09-22T00:00:00Z',
    },
    rto_signal: { available: true, tier: 'clear', risk_score: 0, list: null, network: null },
    orders: [
      { id: 'o-1', order_number: 'ORD-1', created_at: '2026-09-20T00:00:00Z', total: 2000, order_status: 'delivered', payment_status: 'pending', delivery_status: 'delivered', delivery_provider: 'pathao', outcome: 'DELIVERED', link: 'CUSTOMER', confidence: { decision: 'READY', resolution: null, last_gate_result: 'ALLOWED', outcome: 'DELIVERED' } },
      { id: 'o-2', order_number: 'ORD-2', created_at: '2026-09-10T00:00:00Z', total: 500, order_status: 'cancelled', payment_status: 'pending', delivery_status: null, delivery_provider: null, outcome: 'CANCELLED', link: 'PHONE_MATCH', confidence: null },
    ],
    conversations: [
      { id: 'conv-1', channel: 'messenger', status: 'open', started_at: '2026-09-20T10:00:00Z', last_activity_at: '2026-09-26T10:00:00Z', customer_messages: 2 },
    ],
    opportunities: [],
    timeline: [
      { type: 'ORDER_DELIVERED', at: '2026-09-22T00:00:00Z', order_id: 'o-1', order_number: 'ORD-1' },
      { type: 'ORDER_CANCELLED', at: '2026-09-11T00:00:00Z', order_id: 'o-2', order_number: 'ORD-2', approximate_time: true },
    ],
  });

  it('shows the commerce summary, delivery signal, orders and history for this customer', async () => {
    api.getCustomer360.mockResolvedValue(detail());
    renderAt('/customers/c-1');
    expect(await screen.findByRole('heading', { name: 'Rahim Uddin' })).toBeInTheDocument();
    expect(screen.getByTestId('customer-state')).toHaveTextContent('Repeat buyer');
    expect(screen.getByTestId('commerce-summary')).toHaveTextContent('Values are the recorded order totals.');
    expect(screen.getByTestId('rto-signal')).toHaveTextContent('No return-risk signal');
    const orders = screen.getByTestId('customer-orders');
    expect(orders).toHaveTextContent('#ORD-1');
    expect(orders).toHaveTextContent('Ready to ship');
    expect(within(orders).getByText('Matched by phone')).toBeInTheDocument();
    const timeline = screen.getByTestId('customer-timeline');
    expect(timeline).toHaveTextContent('Order #ORD-1 delivered');
    expect(timeline).toHaveTextContent('approximate time');
    expect(screen.getByTestId('reply-window')).toHaveTextContent('Reply window closed');
    expect(screen.getByTestId('customer-conversations')).toHaveTextContent('2 customer messages');
    expect(screen.getByTestId('customer-crm')).toHaveTextContent('Private notes');
  });

  it('marks detail totals and lifecycle context as partial when order history is capped', async () => {
    const customerDetail = detail();
    api.getCustomer360.mockResolvedValue({
      ...customerDetail,
      summary: {
        ...customerDetail.summary,
        ordered_value: 5000,
        delivered_value: 3000,
        order_coverage: { scanned: 500, total: 700, cap: 500, complete: false },
      },
    });
    renderAt('/customers/c-1');

    expect(await screen.findByRole('heading', { name: 'Rahim Uddin' })).toBeInTheDocument();
    expect(screen.getByText(/Order history is partial: 500 of 700 linked orders scanned/)).toBeInTheDocument();
    expect(screen.getByTestId('commerce-summary')).toHaveTextContent('2+');
    expect(screen.getByTestId('commerce-summary')).toHaveTextContent(lowerBoundMoney(5000));
    expect(screen.getByTestId('commerce-summary')).toHaveTextContent(lowerBoundMoney(3000));
  });

  it('opens an order from the customer', async () => {
    api.getCustomer360.mockResolvedValue(detail());
    renderAt('/customers/c-1');
    fireEvent.click(await screen.findByRole('button', { name: '#ORD-1' }));
    expect(await screen.findByText('orders page')).toBeInTheDocument();
  });

  it('shows not-found for a customer outside this shop', async () => {
    api.getCustomer360.mockRejectedValue({ statusCode: 404, type: 'NOT_FOUND' });
    renderAt('/customers/other');
    expect(await screen.findByText('Customer not found.')).toBeInTheDocument();
  });

  it('opens returned conversations in the Inbox without starting a message', async () => {
    api.getCustomer360.mockResolvedValue(detail());
    renderAt('/customers/c-1');
    const conversations = await screen.findByTestId('customer-conversations');
    fireEvent.click(within(conversations).getByRole('button', { name: /Open conversation/ }));
    expect(await screen.findByText('inbox page')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('adds a private note and applies CRM tags through the customer CRM APIs', async () => {
    api.getCustomer360.mockResolvedValue(detail());
    const savedNotes: Array<{ id: string; body: string }> = [];
    let savedTagIds: string[] = [];
    crmApi.listCustomerNotes.mockImplementation(async () => ({
      data: savedNotes.map((note) => ({
        ...note, shop_id: 'shop-1', customer_id: 'c-1', author_id: auth.userId,
        author_name: 'Staff', created_at: '2026-10-20T10:00:00Z', updated_at: '2026-10-20T10:00:00Z',
      })),
      total: savedNotes.length,
    }));
    crmApi.createCustomerNote.mockImplementation(async (_id: string, body: string) => {
      const note = { id: 'note-new', body };
      savedNotes.push(note);
      return { ...note, shop_id: 'shop-1', customer_id: 'c-1', author_id: auth.userId, author_name: 'Staff', created_at: '2026-10-20T10:00:00Z', updated_at: '2026-10-20T10:00:00Z' };
    });
    crmApi.deleteCustomerNote.mockImplementation(async (_id: string, noteId: string) => {
      const index = savedNotes.findIndex((note) => note.id === noteId);
      if (index >= 0) savedNotes.splice(index, 1);
    });
    crmApi.listCustomerTags.mockImplementation(async () => ({ data: savedTagIds.includes('tag-1') ? [{ id: 'tag-1', shop_id: 'shop-1', name: 'VIP' }] : [] }));
    crmApi.setCustomerTags.mockImplementation(async (_id: string, ids: string[]) => {
      savedTagIds = ids;
      return { data: savedTagIds.includes('tag-1') ? [{ id: 'tag-1', shop_id: 'shop-1', name: 'VIP' }] : [] };
    });
    renderAt('/customers/c-1');
    const crm = await screen.findByTestId('customer-crm');
    fireEvent.click(within(crm).getByTestId('customer-note-toggle'));
    fireEvent.change(within(crm).getByRole('textbox', { name: 'Private notes' }), { target: { value: 'Call before packing' } });
    fireEvent.click(within(crm).getAllByRole('button', { name: 'Add note' })[1]);
    await waitFor(() => expect(crmApi.createCustomerNote).toHaveBeenCalledWith('c-1', 'Call before packing'));
    expect(await within(crm).findByText('Call before packing')).toBeInTheDocument();
    fireEvent.click(within(crm).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(crmApi.deleteCustomerNote).toHaveBeenCalledWith('c-1', 'note-new'));
    expect(await within(crm).findByText('No notes yet.')).toBeInTheDocument();

    fireEvent.click(within(crm).getByTestId('customer-tag-toggle'));
    const editor = await within(crm).findByTestId('customer-tag-editor');
    fireEvent.click(within(editor).getByRole('checkbox', { name: 'VIP' }));
    fireEvent.click(within(editor).getByTestId('customer-tags-apply'));
    await waitFor(() => expect(crmApi.setCustomerTags).toHaveBeenCalledWith('c-1', ['tag-1']));
    expect(await within(crm).findByText('VIP')).toBeInTheDocument();
  });

  it('routes flag-off customer detail URLs to the legacy customer drawer', async () => {
    api.getPilotStatus.mockResolvedValue({ customer_intelligence: false, order_confidence_mode: 'off' });
    api.getCustomer360.mockReset();
    renderAt('/customers/c-legacy');
    expect(await screen.findByRole('dialog', { name: 'Customer Details' })).toBeInTheDocument();
    expect(legacyApi.getCustomer).toHaveBeenCalledWith('c-legacy');
    expect(api.getCustomer360).not.toHaveBeenCalled();
  });
});
