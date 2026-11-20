/**
 * MW-V1 Phase 3 — CustomerContextPanel contract tests (doc 04 rules).
 * Real i18n; domain modules mocked; router navigations captured.
 */
import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import i18n from '@/i18n';
import CustomerContextPanel from '@/app/components/inbox/CustomerContextPanel';
import type { Conversation } from '@/api/types/conversation';

const ciApi = vi.hoisted(() => ({ getPilotStatus: vi.fn(), getCustomer360: vi.fn() }));
const orderApi = vi.hoisted(() => ({ getOrders: vi.fn() }));
const crmApi = vi.hoisted(() => ({
  listCustomerNotes: vi.fn(), listCustomerTags: vi.fn(), listTagVocabulary: vi.fn(),
  createCustomerNote: vi.fn(), deleteCustomerNote: vi.fn(),
  setCustomerTags: vi.fn(), createTag: vi.fn(),
}));
const barrel = vi.hoisted(() => ({
  updateConversation: vi.fn(),
  getShopAgents: vi.fn(async () => [
    { id: 'staff-1', full_name: 'Nowrin Sultana', role: 'staff' },
    { id: 'staff-2', full_name: 'Rafiul Karim', role: 'staff' },
  ]),
}));
const authStub = vi.hoisted(() => ({
  getState: vi.fn(() => ({ user: { id: 'staff-1' }, currentShop: { role: 'staff' } })),
}));
const navigate = vi.hoisted(() => vi.fn());

vi.mock('@/api', () => ({ apiClient: barrel }));
vi.mock('@/app/lib/auth', () => ({ authService: authStub }));
vi.mock('@/api/domains/customer-intelligence', () => ciApi);
vi.mock('@/api/domains/order', () => orderApi);
vi.mock('@/api/domains/customer-crm', () => crmApi);
vi.mock('react-router-dom', () => ({ useNavigate: () => navigate }));

const conversation = (over: Partial<Conversation> = {}): Conversation => ({
  id: 'conv-1',
  customer_id: 'cust-1',
  customer: { id: 'cust-1', name: 'Rina Akter', channel_user_id: 'psid-1' },
  channel: 'facebook',
  title: 'Rina Akter',
  status: 'active',
  hitl: false,
  unreadCount: 0,
  lastMessage: 'hi',
  created_at: '2026-10-20T08:00:00Z',
  updated_at: '2026-10-25T08:00:00Z',
  ...over,
} as Conversation);

const detail360 = {
  customer: { name: 'Rina Akter', page: 'Azal Boutique', last_activity_at: '2026-10-25T08:00:00Z' },
  contactability: { platform: 'facebook', window_open: true, reason: '' },
  state: 'REPEAT_BUYER', state_reasons: [{ code: 'DELIVERED_COUNT', params: { count: 4 } }],
  summary: { total_orders: 6, delivered_orders: 4, returned_orders: 1, delivered_value: 8400, ordered_value: 12000 },
  rto_signal: { available: true, tier: 'verify', list: false, network: false },
  orders: [], conversations: [], opportunities: [], timeline: [],
};

beforeAll(async () => { await i18n.changeLanguage('en'); });

beforeEach(() => {
  vi.clearAllMocks();
  authStub.getState.mockReturnValue({ user: { id: 'staff-1' }, currentShop: { role: 'staff' } } as never);
  ciApi.getPilotStatus.mockResolvedValue({ customer_intelligence: false, order_confidence_mode: 'off' });
  orderApi.getOrders.mockResolvedValue([
    { id: 'o9', orderNumber: 'ORD-1001', status: 'processing', total: 1490, customerName: 'Rina Akter', customerId: 'cust-1' },
  ]);
  crmApi.listCustomerNotes.mockResolvedValue({ data: [], total: 0 });
  crmApi.listCustomerTags.mockResolvedValue({ data: [] });
  crmApi.listTagVocabulary.mockResolvedValue({
    data: [
      { id: 'tag-1', shop_id: 'shop-1', name: 'Wholesale inquiry' },
      { id: 'tag-2', shop_id: 'shop-1', name: 'Needs size help' },
    ],
  });
  crmApi.createCustomerNote.mockImplementation(async (_id: string, body: string) => ({
    id: 'note-new', shop_id: 'shop-1', customer_id: 'cust-1', body,
    author_id: 'staff-1', author_name: 'Nowrin Sultana',
    created_at: '2026-10-25T10:00:00Z', updated_at: '2026-10-25T10:00:00Z',
  }));
  crmApi.deleteCustomerNote.mockResolvedValue(undefined);
  crmApi.setCustomerTags.mockImplementation(async (_id: string, tagIds: string[]) => ({
    data: [{ id: 'tag-2', shop_id: 'shop-1', name: 'Needs size help' }].filter((x) => tagIds.includes(x.id)),
  }));
  barrel.updateConversation.mockResolvedValue({ id: 'conv-1', hitl: true, assignee_id: 'staff-1', assignee: { id: 'staff-1', name: 'Nowrin Sultana' } });
});

describe('CustomerContextPanel', () => {
  it('flag OFF: identity+orders render, ZERO customer-intelligence reads', async () => {
    render(<CustomerContextPanel conversation={conversation()} />);
    await waitFor(() => expect(screen.getByText('Rina Akter')).toBeInTheDocument());
    expect(ciApi.getCustomer360).not.toHaveBeenCalled();
    expect(screen.queryByText(/Delivered value/)).not.toBeInTheDocument();
    expect(orderApi.getOrders).toHaveBeenCalledWith({ customer_id: 'cust-1', limit: 3 });
  });

  it('flag ON: relationship + RTO facts appear with honest labels', async () => {
    ciApi.getPilotStatus.mockResolvedValue({ customer_intelligence: true, order_confidence_mode: 'off' });
    ciApi.getCustomer360.mockResolvedValue(detail360);
    render(<CustomerContextPanel conversation={conversation()} />);

    expect(await screen.findByText(/Delivered value/)).toBeInTheDocument();
    expect(screen.getByText(/৳?8,?400|8400/)).toBeInTheDocument();
    expect(screen.queryByText(/paid|received cash/i)).not.toBeInTheDocument();
    expect(screen.getByText(/delivery-risk/i)).toBeInTheDocument(); // neutral RTO wording
    expect(ciApi.getCustomer360).toHaveBeenCalledWith('cust-1');
  });

  it('order rows use authoritative status strings and canonical deep link', async () => {
    render(<CustomerContextPanel conversation={conversation()} />);
    const row = await screen.findByText('ORD-1001');
    expect(row.parentElement?.textContent).toContain('processing');
    fireEvent.click(screen.getByRole('button', { name: /open order/i }));
    expect(navigate).toHaveBeenCalledWith('/orders?orderId=o9');
  });

  it('360 failure degrades the relationship section only — operations stay usable', async () => {
    ciApi.getPilotStatus.mockResolvedValue({ customer_intelligence: true, order_confidence_mode: 'off' });
    ciApi.getCustomer360.mockRejectedValue(new Error('boom'));
    render(<CustomerContextPanel conversation={conversation()} />);

    expect(await screen.findByText(/couldn't load/i)).toBeInTheDocument();
    expect(screen.getByText('ORD-1001')).toBeInTheDocument();
  });

  it('conversation with no customer id: honest state, ZERO data calls beyond pilot status', async () => {
    render(<CustomerContextPanel conversation={conversation({ customer_id: null as unknown as string, customer: undefined })} />);
    await waitFor(() => expect(screen.getByText(/not linked/i)).toBeInTheDocument());
    expect(orderApi.getOrders).not.toHaveBeenCalled();
    expect(ciApi.getCustomer360).not.toHaveBeenCalled();
    expect(crmApi.listCustomerNotes).not.toHaveBeenCalled();
    expect(crmApi.listCustomerTags).not.toHaveBeenCalled();
  });

  it('switching conversations discards the slower previous load', async () => {
    const slow: { resolve?: (v: unknown) => void } = {};
    ciApi.getPilotStatus.mockResolvedValue({ customer_intelligence: true, order_confidence_mode: 'off' });
    ciApi.getCustomer360.mockImplementation((id: string) => {
      if (id === 'cust-1') return new Promise((r) => { slow.resolve = r; });
      return Promise.resolve({ ...detail360, summary: { ...detail360.summary, delivered_value: 999 } });
    });
    const { rerender } = render(<CustomerContextPanel conversation={conversation()} />);
    await screen.findByText('ORD-1001');
    rerender(<CustomerContextPanel conversation={conversation({ id: 'conv-2', customer_id: 'cust-2', customer: { name: 'Karim' } as never })} />);

    expect(await screen.findByText(/৳?999/)).toBeInTheDocument();
    slow.resolve?.(detail360); // late arrival for the PREVIOUS conversation must not overwrite
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByText(/৳?8,?400|8400/)).not.toBeInTheDocument();
  });

  // ─── MW-V1 Phase 4: ownership controls in the panel ───────────────────────
  const conflict = {
    response: {
      status: 409,
      data: { error: { code: 'HUMAN_TAKEOVER_CONFLICT', message: 'This conversation is already assigned to another team member' } },
    },
  };

  it('shows the current owner from the authoritative assignee fields', async () => {
    render(
      <CustomerContextPanel
        conversation={conversation({
          hitl: true,
          assignee_id: 'staff-2',
          assignee: { id: 'staff-2', name: 'Rafiul Karim' },
        } as never)}
      />,
    );
    expect(await screen.findByTestId('context-owner')).toHaveTextContent('Rafiul Karim');
  });

  it('unclaimed handoff: claim calls the canonical PATCH and bubbles the update', async () => {
    const onChanged = vi.fn();
    render(
      <CustomerContextPanel
        conversation={conversation({ hitl: true, assignee_id: null, assignee: null } as never)}
        onConversationChanged={onChanged}
      />,
    );
    fireEvent.click(await screen.findByTestId('context-claim'));
    await waitFor(() => expect(barrel.updateConversation).toHaveBeenCalledWith('conv-1', { hitl: true }));
    expect(onChanged).toHaveBeenCalledWith(expect.objectContaining({ assignee_id: 'staff-1' }));
    expect(screen.queryByTestId('context-force')).not.toBeInTheDocument();
  });

  it('already claimed by me: no claim button', async () => {
    render(<CustomerContextPanel conversation={conversation({ hitl: true, assignee_id: 'staff-1' } as never)} />);
    await screen.findByTestId('context-owner');
    expect(screen.queryByTestId('context-claim')).not.toBeInTheDocument();
  });

  it('409 as staff: server reason shown, no escalation offered', async () => {
    barrel.updateConversation.mockRejectedValue(conflict);
    render(<CustomerContextPanel conversation={conversation({ hitl: true, assignee_id: 'staff-9' } as never)} />);
    fireEvent.click(await screen.findByTestId('context-claim'));
    expect(await screen.findByText(/already assigned to another team member/i)).toBeInTheDocument();
    expect(screen.queryByTestId('context-force')).not.toBeInTheDocument();
    expect(barrel.updateConversation).toHaveBeenCalledTimes(1);
  });

  it('409 as owner: manager take-over offered and retries with force', async () => {
    authStub.getState.mockReturnValue({ user: { id: 'owner-1' }, currentShop: { role: 'owner' } } as never);
    barrel.updateConversation
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce({ id: 'conv-1', hitl: true, assignee_id: 'owner-1', assignee: { id: 'owner-1', name: 'Owner' } });
    render(<CustomerContextPanel conversation={conversation({ hitl: true, assignee_id: 'staff-9' } as never)} />);
    fireEvent.click(await screen.findByTestId('context-claim'));
    fireEvent.click(await screen.findByTestId('context-force'));
    await waitFor(() => expect(barrel.updateConversation).toHaveBeenCalledWith('conv-1', { hitl: true, force: true }));
  });

  it('assign picker lists active teammates and assigns by id', async () => {
    render(<CustomerContextPanel conversation={conversation({ hitl: true, assignee_id: null, assignee: null } as never)} />);
    fireEvent.click(await screen.findByTestId('context-assign-open'));
    const option = await screen.findByText(/Rafiul Karim/, {}, { timeout: 2000 });
    fireEvent.click(option);
    await waitFor(() => expect(barrel.updateConversation).toHaveBeenCalledWith('conv-1', { assignee_id: 'staff-2' }));
  });

  // ─── MW-V1 Phase 5/6: notes + tags editing ────────────────────────────────
  it('note composer: writes via the crm domain, refetches, and never auto-sends', async () => {
    const notes: Array<Record<string, unknown>> = [];
    crmApi.listCustomerNotes.mockImplementation(async () => ({ data: notes, total: notes.length }));
    crmApi.createCustomerNote.mockImplementation(async (_id: string, body: string) => {
      const note = { id: 'note-new', shop_id: 'shop-1', customer_id: 'cust-1', body, author_id: 'staff-1', author_name: 'Nowrin Sultana', created_at: '2026-10-25T10:00:00Z', updated_at: '2026-10-25T10:00:00Z' };
      notes.push(note);
      return note;
    });
    render(<CustomerContextPanel conversation={conversation()} />);
    fireEvent.click(await screen.findByTestId('note-add-open'));
    fireEvent.change(screen.getByTestId('note-composer'), { target: { value: 'morning calls preferred' } });
    fireEvent.click(screen.getByTestId('note-save'));

    await waitFor(() => expect(crmApi.createCustomerNote).toHaveBeenCalledWith('cust-1', 'morning calls preferred'));
    expect(await screen.findByText('morning calls preferred')).toBeInTheDocument();
    // nothing ever typed into notes reaches the message workflow
    expect(barrel.updateConversation).not.toHaveBeenCalled();
  });

  it('note delete is visible to the author only (staff), and calls the crm domain', async () => {
    crmApi.listCustomerNotes.mockResolvedValue({
      data: [
        { id: 'note-mine', shop_id: 'shop-1', customer_id: 'cust-1', body: 'mine', author_id: 'staff-1', author_name: 'Nowrin', created_at: null, updated_at: null },
        { id: 'note-theirs', shop_id: 'shop-1', customer_id: 'cust-1', body: 'theirs', author_id: 'staff-9', author_name: 'Other', created_at: null, updated_at: null },
      ],
      total: 2,
    });
    render(<CustomerContextPanel conversation={conversation()} />);
    await screen.findByText('mine');
    const deletes = screen.getAllByTestId('note-delete');
    expect(deletes).toHaveLength(1); // only my own note offers delete (role staff)
    fireEvent.click(deletes[0]);
    await waitFor(() => expect(crmApi.deleteCustomerNote).toHaveBeenCalledWith('cust-1', 'note-mine'));
  });

  it('tag picker: shows vocabulary, replaces the set, refetches', async () => {
    let tagsCall = 0;
    crmApi.listCustomerTags.mockImplementation(async () => {
      tagsCall += 1;
      return tagsCall === 1
        ? { data: [] }
        : { data: [{ id: 'tag-2', shop_id: 'shop-1', name: 'Needs size help' }] };
    });
    render(<CustomerContextPanel conversation={conversation()} />);
    fireEvent.click(await screen.findByTestId('tag-edit-open'));
    const choice = await screen.findByTestId('tag-choice-tag-2');
    fireEvent.click(choice);
    fireEvent.click(screen.getByTestId('tag-apply'));

    await waitFor(() => expect(crmApi.setCustomerTags).toHaveBeenCalledWith('cust-1', ['tag-2']));
    await waitFor(() => expect(screen.getByText('Needs size help')).toBeInTheDocument());
  });

  it('Create order button navigates to /orders prefilled with customer, conversation, and Page channel context', async () => {
    render(
      <CustomerContextPanel
        conversation={conversation({
          customer: { id: 'cust-1', name: 'Rina Akter', phone: '01712345678', channel_user_id: 'psid-1' },
          metaChannel: { id: 'mc-1', display_name: 'Azal Boutique', platform: 'facebook' },
        } as never)}
      />,
    );

    const createOrderBtn = await screen.findByTestId('context-create-order');
    fireEvent.click(createOrderBtn);

    expect(navigate).toHaveBeenCalledTimes(1);
    const dest = navigate.mock.calls[0][0] as string;
    expect(dest.startsWith('/orders?')).toBe(true);
    const params = new URLSearchParams(dest.split('?')[1]);
    expect(params.get('create')).toBe('1');
    expect(params.get('customerId')).toBe('cust-1');
    expect(params.get('customerName')).toBe('Rina Akter');
    expect(params.get('customerPhone')).toBe('01712345678');
    expect(params.get('conversationId')).toBe('conv-1');
    expect(params.get('channelId')).toBe('mc-1');
  });
});
