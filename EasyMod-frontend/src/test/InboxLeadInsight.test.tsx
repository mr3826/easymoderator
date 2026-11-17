import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import i18n from '@/i18n';
import UnifiedInbox from '@/app/components/UnifiedInbox';
import { apiClient } from '@/api';
import { toast } from 'sonner';
import type { Opportunity } from '@/api/types/customer-intelligence';

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  const React = await import('react');
  return {
    ...actual,
    useLocation: () => ({ pathname: '/', search: '', hash: '', state: null }),
    useNavigate: () => vi.fn(),
    useParams: () => ({}),
    // Harness-only anchor stand-in for the redesign's real <Link>s (no Router
    // in these renders); existing assertions unchanged.
    Link: ({ to, children, ...rest }: { to?: string; children?: import('react').ReactNode; [key: string]: unknown }) =>
      React.createElement(
        'a',
        { href: to ?? '#', ...rest } as import('react').AnchorHTMLAttributes<HTMLAnchorElement>,
        children,
      ),
  };
});

vi.mock('@/api', () => ({
  apiClient: {
    getShopAgents: vi.fn(),
    getConversations: vi.fn(),
    getMessages: vi.fn(),
    createMessage: vi.fn(),
    approveAiDraft: vi.fn(),
    dismissAiDraft: vi.fn(),
    markConversationRead: vi.fn(),
    updateConversation: vi.fn(),
    transcribeVoice: vi.fn(),
    getResponseTemplates: vi.fn(),
    createTemplate: vi.fn(),
    updateTemplate: vi.fn(),
    deleteTemplate: vi.fn(),
    createAuditLog: vi.fn(),
    getSubscription: vi.fn(),
  },
}));

const oppApi = vi.hoisted(() => ({
  getPilotStatus: vi.fn(),
  listCustomers360: vi.fn(),
  getCustomer360: vi.fn(),
  listOpportunities: vi.fn(),
  markOpportunityContacted: vi.fn(),
  dismissOpportunity: vi.fn(),
}));
vi.mock('@/api/domains/customer-intelligence', () => oppApi);

// P+03 action queue: default platform flag is off; keep the strip inert here.
vi.mock('@/api/domains/inbox', () => ({
  getInboxActions: vi.fn().mockResolvedValue({ featureDisabled: true }),
}));

vi.mock('@/app/lib/useSubscriptionFeatures', () => ({
  useSubscriptionFeatures: () => ({
    features: { image_understanding: true, advanced_ai: true, priority_support: true, custom_branding: false },
    planName: 'PRO',
    plan: null,
    loading: false,
  }),
}));
vi.mock('@/app/lib/useInboxSSE', () => ({ useInboxSSE: vi.fn() }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));

const opportunity = (overrides: Partial<Opportunity> = {}): Opportunity => ({
  id: 'op-1',
  status: 'OPEN',
  strength: 'HIGH',
  reasons: ['PURCHASE_INTENT'],
  signals: [],
  product_refs: [],
  customer_id: 'cust-1',
  conversation_id: 'conv-1',
  first_signal_at: '2026-10-24T08:00:00Z',
  last_signal_at: '2026-10-24T08:10:00Z',
  detected_at: '2026-10-24T08:10:05Z',
  actioned_at: null,
  converted_order_id: null,
  resolved_at: null,
  resolution_reason: null,
  recommended_action: { code: 'REPLY_IN_INBOX' },
  customer: { id: 'cust-1', name: 'Alice', channel_type: 'messenger' },
  ...overrides,
});

const baseConversation = (over: Record<string, unknown> = {}) => ({
  id: 'conv-1',
  customer_id: 'cust-1',
  customer: { id: 'cust-1', name: 'Alice' },
  channel: 'facebook',
  status: 'active',
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  ...over,
});

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

beforeEach(() => {
  vi.clearAllMocks();
  (apiClient.getResponseTemplates as any).mockResolvedValue([]);
  (apiClient.getMessages as any).mockResolvedValue({ messages: [], pagination: { page: 1, totalPages: 1 } });
  (apiClient.getShopAgents as any).mockResolvedValue([]);
  (apiClient.markConversationRead as any).mockResolvedValue({});
});

const mountWith = async (conversation: any) => {
  (apiClient.getConversations as any).mockResolvedValue({
    data: [conversation],
    ai_reply_mode: 'MANUAL',
    pagination: { page: 1, totalPages: 1 },
  });
  render(<UnifiedInbox />);
  await waitFor(() => expect(screen.getAllByText('Alice').length).toBeGreaterThan(0));
};

describe('P+01 inbox lead intelligence', () => {
  it('shows the strength chip for a flagged conversation with a live opportunity', async () => {
    await mountWith(baseConversation({ open_opportunity: opportunity() }));
    const chip = screen.getByTestId('lead-chip');
    expect(chip).toHaveTextContent(/Strong interest/i);
  });

  it('shows no chip and no strip when there is no opportunity (flag off / none)', async () => {
    await mountWith(baseConversation({ open_opportunity: null }));
    expect(screen.queryByTestId('lead-chip')).toBeNull();
    fireEvent.click(screen.getAllByText('Alice')[0]);
    expect(screen.queryByTestId('inbox-lead-insight')).toBeNull();
  });

  it('opens the authoritative strip with reasons and lets the merchant mark contacted via the shared API', async () => {
    await mountWith(baseConversation({ open_opportunity: opportunity() }));
    fireEvent.click(screen.getByTestId('lead-chip'));

    const strip = await screen.findByTestId('inbox-lead-insight');
    // The strip renders the canonical opportunity article from the Customers
    // surface — same reasons, same actions, no inbox-side score.
    expect(within(strip).getByTestId('opportunity-op-1')).toBeInTheDocument();

    const contacted = await within(strip).findByRole('button', { name: /Mark contacted/i });
    oppApi.markOpportunityContacted.mockResolvedValue({
      status: 'ACTIONED', actioned_at: '2026-10-24T09:00:00Z',
      recommended_action: { code: 'WAIT_FOR_CUSTOMER_MESSAGE' },
    });
    fireEvent.click(contacted);

    await waitFor(() => expect(oppApi.markOpportunityContacted).toHaveBeenCalledWith('op-1'));
    expect(toast.success).toHaveBeenCalledWith('Marked as contacted');
    // still live (ACTIONED) — strip remains, chip remains
    expect(screen.getByTestId('inbox-lead-insight')).toBeInTheDocument();
    expect(screen.getByTestId('lead-chip')).toBeInTheDocument();
  });

  it('dismiss with reason clears the strip (terminal state is server-authoritative)', async () => {
    await mountWith(baseConversation({ open_opportunity: opportunity() }));
    fireEvent.click(screen.getByTestId('lead-chip'));
    const strip = await screen.findByTestId('inbox-lead-insight');
    expect(within(strip).getByText('Said they want to order')).toBeInTheDocument();

    fireEvent.click(within(strip).getAllByRole('button', { name: /^Dismiss$/i })[0]);
    oppApi.dismissOpportunity.mockResolvedValue({
      status: 'DISMISSED', resolved_at: '2026-10-24T09:00:00Z', resolution_reason: 'NOT_INTERESTED',
    });
    const dismissButtons = within(strip).getAllByRole('button', { name: /^Dismiss$/i });
    const confirm = dismissButtons[dismissButtons.length - 1];
    fireEvent.click(confirm);

    await waitFor(() => expect(oppApi.dismissOpportunity).toHaveBeenCalledWith('op-1', 'NOT_INTERESTED'));
    await waitFor(() => expect(screen.queryByTestId('inbox-lead-insight')).toBeNull());
    expect(screen.queryByTestId('lead-chip')).toBeNull();
  });

  it('on a server 409 conflict the strip does not fabricate success', async () => {
    await mountWith(baseConversation({ open_opportunity: opportunity() }));
    fireEvent.click(screen.getByTestId('lead-chip'));
    const strip = await screen.findByTestId('inbox-lead-insight');

    oppApi.markOpportunityContacted.mockRejectedValue(Object.assign(new Error('conflict'), { status: 409 }));
    fireEvent.click(within(strip).getByRole('button', { name: /Mark contacted/i }));

    await waitFor(() => expect(oppApi.markOpportunityContacted).toHaveBeenCalled());
    expect(toast.success).not.toHaveBeenCalled();
    expect(screen.getByTestId('inbox-lead-insight')).toBeInTheDocument();
  });
});
