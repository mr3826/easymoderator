import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import Subscription from '@/app/components/Subscription';
import { apiClient } from '@/api';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'en' },
    t: (key: string, options?: any) => {
      if (options?.returnObjects) {
        if (key === 'subscription.planFeatures') return ['Messenger replies', 'Order capture'];
        return [];
      }
      const map: Record<string, string> = {
        'subscription.title': 'Plan & Billing',
        'subscription.subtitle': 'Choose a plan',
        'subscription.currentPlan': 'Current plan',
        'subscription.plansTitle': 'Plans',
        'subscription.plansSubtitle': 'Choose a plan',
        'subscription.growthIntentNotice': 'You asked to review Moderator Plus.',
        'subscription.growthIntentViewPlan': 'View Moderator Plus plan',
        'subscription.bkashUnavailable': 'bKash unavailable',
        'subscription.usageTitle': 'This period usage',
        'subscription.usageSubtitle': 'Usage',
        'subscription.conversationsUsed': 'Customer conversations',
        'subscription.ordersCreated': 'Orders Created',
        'subscription.productsUsed': 'Products Used',
        'subscription.planIncludes': 'Plan includes',
        'subscription.billingTitle': 'Billing Summary',
        'subscription.basePlan': 'Base Plan Price',
        'subscription.invoicesTitle': 'Invoices',
        'subscription.invoiceColumns.id': 'ID',
        'subscription.invoiceColumns.period': 'Period',
        'subscription.invoiceColumns.type': 'Type',
        'subscription.invoiceColumns.amount': 'Amount',
        'subscription.invoiceColumns.status': 'Status',
        'subscription.invoiceColumns.action': 'Action',
        'subscription.paid': 'Paid',
        'subscription.pending': 'Pending',
        'subscription.topupBalanceLabel': 'Top-up balance',
        'common.active': 'Active',
      };
      if (key === 'subscription.includedConversations') return `Included allowance: ${options?.count}`;
      return map[key] || key;
    },
  }),
}));

vi.mock('@/api', () => ({
  apiClient: {
    getSubscription: vi.fn().mockResolvedValue({
      subscription: {
        plan_code: 'SHURU',
        plan_name: 'Shuru',        plan_price: 0,
        billing_cycle: 'monthly',
        status: 'active',
        conversations_limit: 100,
        conversations_used: 10,
        topup_balance: 0,
        current_period_start: '2024-01-01T00:00:00.000Z',
        current_period_end: '2024-02-01T00:00:00.000Z',
        next_billing_date: '2024-02-01T00:00:00.000Z',
        features: {},
      },
      effective_conversation_limit: 100,
      conversation_quota_exhausted: false,
      period: { start: '2024-01-01T00:00:00.000Z', end: '2024-02-01T00:00:00.000Z' },
      usage: {
        conversations: { used: 10, limit: 100, included_limit: 100, topup_balance: 0, status: 'safe', percentage: 10 },
        orders: { used: 5, limit: -1, status: 'safe', percentage: 0 },
        products: { used: 20, limit: -1, status: 'safe', percentage: 0 },
      },
      partner_eligibility: { delivered_orders_30d: 0, minimum_delivered_orders: 300, eligible: false },
      extra_usage: { conversations: 0, charge: 0 },
    }),
    getSubscriptionInvoices: vi.fn().mockResolvedValue([
      { id: 'inv-1', invoice_number: 'INV-1', billing_period: 'Jan 2024', amount: 0, status: 'paid', invoice_type: 'subscription', created_at: '2024-01-01' },
    ]),
    getSubscriptionPlans: vi.fn().mockResolvedValue([]),
    getTopupPacks: vi.fn().mockResolvedValue([]),
    subscribeToPlan: vi.fn(),
    payInvoice: vi.fn(),
    renewSubscription: vi.fn(),
    completeTopup: vi.fn(),
    completeInvoicePayment: vi.fn(),
    cancelInvoicePayment: vi.fn().mockResolvedValue({ success: true, invoice_id: 'inv-1', status: 'pending' }),
  },
}));

vi.mock('@/app/lib/auth', () => ({ authService: { getCurrentShopId: vi.fn().mockReturnValue('shop-1') } }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), warning: vi.fn() } }));
vi.mock('@/app/components/ui/progress', () => ({ Progress: ({ value }: any) => <div data-testid="progress" data-value={value} /> }));
vi.mock('lucide-react', () => {
  const Icon = () => <span />;
  return {
    AlertCircle: Icon, Check: Icon, CheckCircle2: Icon, CreditCard: Icon, Download: Icon,
    Eye: Icon, MessageSquare: Icon, Package: Icon, ShoppingCart: Icon, TrendingUp: Icon,
  };
});

const renderWithRouter = () => render(<BrowserRouter><Subscription /></BrowserRouter>);

describe('Subscription', () => {
  it('renders Get Your Moderator details and effective usage metrics', async () => {
    renderWithRouter();
    await waitFor(() => expect(screen.getAllByText('Get Your Moderator').length).toBeGreaterThan(0));
    expect(screen.getByText('Plan & Billing')).toBeInTheDocument();
    expect(screen.getAllByTestId('progress')).toHaveLength(3);
    expect(screen.getByText(/Included allowance: 100/)).toBeInTheDocument();
    expect(screen.getByText('Top-up balance: 0')).toBeInTheDocument();
    expect(screen.queryByText(/\{\{count\}\}/)).not.toBeInTheDocument();
  });

  it('displays invoice history without exposing a payment button when bKash is disabled', async () => {
    renderWithRouter();
    await waitFor(() => expect(screen.getByText('Jan 2024')).toBeInTheDocument());
    expect(screen.getByText('Paid')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Pay with bKash/i })).not.toBeInTheDocument();
  });

  it('releases a cancelled invoice checkout before showing the cancellation state', async () => {
    vi.mocked(apiClient.cancelInvoicePayment).mockClear();
    window.history.pushState({}, '', '/subscription?paymentID=PAY-1&status=cancel');
    sessionStorage.setItem('easymod_pay_ctx', JSON.stringify({ kind: 'invoice', ref: 'inv-1' }));

    renderWithRouter();

    await waitFor(() => {
      expect(apiClient.cancelInvoicePayment).toHaveBeenCalledWith('inv-1', 'PAY-1');
    });
    expect(await screen.findByText('subscription.paymentCancelled')).toBeInTheDocument();
    expect(sessionStorage.getItem('easymod_pay_ctx')).toBeNull();

    window.history.replaceState({}, '', '/subscription');
  });

  it('shows the fixed Growth review notice while keeping the plan change gated', async () => {
    vi.mocked(apiClient.getSubscriptionPlans).mockResolvedValue([
      {
        id: 'shuru', code: 'SHURU', name: 'Shuru', publicName: 'Get Your Moderator',
        description: 'No monthly plan fee.', descriptionBn: 'মাসিক ফি নেই.', monthlyPrice: 0, yearlyPrice: 0,
        billingModel: 'flat_monthly', canPurchaseTopups: false,
        limits: { conversations: 100, orders: -1, products: -1 }, features: {}, highlights: [],
        supportReplyAllowance: { amount: 300, unit: 'provider_accepted_ai_reply', period: 'utc_calendar_month', status: 'shadow_only', billable: false, enforced: false },
      },
      {
        id: 'growth', code: 'GROWTH', name: 'Growth', publicName: 'Moderator Plus',
        description: 'Monthly plan.', descriptionBn: 'মাসিক প্ল্যান.', monthlyPrice: 999, yearlyPrice: 9990,
        billingModel: 'flat_monthly', canPurchaseTopups: true,
        limits: { conversations: 500, orders: -1, products: -1 }, features: {}, highlights: [],
        supportReplyAllowance: { amount: 3000, unit: 'provider_accepted_ai_reply', period: 'utc_calendar_month', status: 'shadow_only', billable: false, enforced: false },
        topupPacks: [{ code: 'PACK_100', conversations: 100, priceBdt: 250 }],
      },
      {
        id: 'partner', code: 'PARTNER', name: 'Partner', publicName: 'Partnership',
        description: 'Delivered-order billing.', descriptionBn: 'Delivered-order billing.', monthlyPrice: 0, yearlyPrice: 0,
        billingModel: 'per_order', canPurchaseTopups: false,
        limits: { conversations: -1, orders: -1, products: -1 }, features: {}, highlights: [],
        supportReplyAllowance: null, partnerOrderTiers: [{ minOrders: 300, maxOrders: 999, rateBdt: 15 }],
      },
    ] as any);
    window.history.pushState({}, '', '/subscription?intent=growth-upgrade&lang=en');
    renderWithRouter();

    expect(await screen.findByRole('status')).toHaveTextContent('You asked to review Moderator Plus.');
    expect(screen.getByRole('link', { name: 'View Moderator Plus plan' })).toHaveAttribute('href', '#growth-plan');
    expect(await screen.findByRole('button', { name: 'bKash unavailable' })).toBeDisabled();

    window.history.replaceState({}, '', '/subscription');
    vi.mocked(apiClient.getSubscriptionPlans).mockResolvedValue([]);
  });

  it('does not show pinned plan or top-up values when the live catalog is unavailable', async () => {
    vi.mocked(apiClient.getSubscriptionPlans).mockResolvedValue([]);
    renderWithRouter();

    expect(await screen.findByRole('alert')).toHaveTextContent('subscription.planCatalogUnavailable');
    expect(screen.queryByText('৳999')).not.toBeInTheDocument();
    expect(screen.queryByText(/100 conversations.*৳250 per pack/i)).not.toBeInTheDocument();
    expect(apiClient.getTopupPacks).not.toHaveBeenCalled();
  });
});
