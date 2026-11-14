import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ClaimDecision } from '@/api/types/commercial';
import Subscription from '@/app/components/Subscription';

const { mockUseCommercialContract, mockUseClaimDecisions, translations, mocks } = vi.hoisted(() => ({
  mockUseCommercialContract: vi.fn(),
  mockUseClaimDecisions: vi.fn(),
  translations: {
    'subscription.title': 'Billing',
    'subscription.subtitle': 'Delivered-order billing, invoices, and payment',
    'subscription.loading': 'Loading billing details...',
    'subscription.contractTitle': 'Commercial terms',
    'subscription.contractSubtitle': 'One price for every shop',
    'subscription.contractUnavailable': 'Commercial terms could not be loaded. No price is shown until they load.',
    'subscription.contractVersion': 'Contract version {{version}}',
    'subscription.perDeliveredOrder': 'per delivered order',
    'subscription.dueWithin': 'Due within {{days}} days of the invoice.',
    'subscription.zeroRatedNote': 'Returned or cancelled orders are billed at {{amount}}.',
    'subscription.capabilitiesTitle': 'Platform capabilities',
    'subscription.capabilitiesSubtitle': 'Only verified claims are shown.',
    'subscription.capabilityGroups.ai': 'AI replies',
    'subscription.capabilityGroups.courier': 'Couriers and COD',
    'subscription.capabilityGroups.voiceAndTools': 'Voice and add-ons',
    'subscription.invoicesTitle': 'Invoices',
    'subscription.invoiceColumns.id': 'Invoice ID',
    'subscription.invoiceColumns.period': 'Billing period',
    'subscription.invoiceColumns.type': 'Type',
    'subscription.invoiceColumns.amount': 'Amount',
    'subscription.invoiceColumns.status': 'Status',
    'subscription.invoiceColumns.action': 'Action',
    'subscription.invoiceTypes.delivered_order': 'Delivered orders',
    'subscription.status.paid': 'Paid',
    'subscription.status.pending': 'Pending',
    'subscription.status.overdue': 'Overdue',
    'subscription.payInvoice': 'Pay outstanding invoice',
    'subscription.pay': 'Pay',
    'subscription.paying': 'Starting...',
    'subscription.bkashUnavailable': 'bKash payment is not available right now.',
    'subscription.paymentCancelled': 'Payment was cancelled or not completed. Please try again.',
    'subscription.invoicePaymentSuccess': 'Payment successful! Your invoice has been paid.',
    'subscription.paymentVerifyFailed': 'Payment verification failed. Please contact support.',
    'subscription.invoicesLoadFailed': 'Failed to load invoices',
    'subscription.bkashStartFailed': 'Failed to start bKash payment',
    'subscription.viewBillingLines': 'Billing lines',
    'subscription.hideBillingLines': 'Hide lines',
    'subscription.billingLinesLoading': 'Loading billing lines...',
    'subscription.billingLinesUnavailable': 'Billing lines are not available for this invoice yet.',
    'subscription.billingLinesEmpty': 'This invoice has no billing lines.',
    'subscription.billingLineColumns.order': 'Order',
    'subscription.billingLineColumns.kind': 'Kind',
    'subscription.billingLineColumns.outcome': 'Outcome',
    'subscription.billingLineColumns.amount': 'Amount',
    'subscription.noInvoices': 'No invoices yet.',
    'subscription.invoiceDisclaimer': 'Amounts come from validated billing lines.',
    'subscription.viewInvoiceTitle': 'View / Print invoice',
    'subscription.downloadInvoiceTitle': 'Download invoice',
    'claims.billing.delivered_order.en': '৳10.00 per provider-confirmed delivered order.',
    'claims.billing.overdue_policy.en': 'If a bill is overdue, new courier bookings are blocked and automated replies pause.',
  } as Record<string, string>,
  mocks: {
    getInvoices: vi.fn(),
    getBillingLines: vi.fn(),
    payInvoice: vi.fn(),
    completeInvoicePayment: vi.fn(),
    cancelInvoicePayment: vi.fn(),
    isBkashEnabled: vi.fn(),
  },
}));

vi.mock('@/api/domains/commercialContract', () => ({
  useCommercialContract: mockUseCommercialContract,
  useClaimDecisions: mockUseClaimDecisions,
}));

vi.mock('@/api/domains/subscription', async (importOriginal) => ({
  // Keep the real module's remaining exports (the legacy api object in
  // @/api/index.ts reads them at import time) and stub only what this page uses.
  ...(await importOriginal<typeof import('@/api/domains/subscription')>()),
  getInvoices: mocks.getInvoices,
  getBillingLines: mocks.getBillingLines,
  payInvoice: mocks.payInvoice,
  completeInvoicePayment: mocks.completeInvoicePayment,
  cancelInvoicePayment: mocks.cancelInvoicePayment,
}));

// ClaimProvider tolerates rendering outside AuthProvider; stubbing the optional
// auth hook keeps this unit test from bootstrapping the real auth service.
vi.mock('@/features/auth/AuthProvider', () => ({
  useOptionalAuth: () => null,
}));

vi.mock('@/app/lib/config', () => ({
  isBkashEnabled: mocks.isBkashEnabled,
  buildApiUrl: (path: string) => `https://api.test${path}`,
  // Transitive imports still pull in shared/lib/http/client, which reads the
  // config module's default object and toApiRequestPath at import time.
  toApiRequestPath: (path: string) => path,
  isMarketingSurface: () => false,
  default: {
    apiBaseUrl: 'https://api.test',
    appUrl: 'https://app.test',
    marketingUrl: 'https://marketing.test',
    environment: 'development',
    bkashEnabled: false,
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'en' },
    t: (key: string, options?: unknown) => {
      const template = translations[key];
      if (typeof template === 'string') {
        if (options && typeof options === 'object') {
          return template.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String((options as Record<string, unknown>)[name] ?? ''));
        }
        return template;
      }
      if (typeof options === 'string') return options;
      return key;
    },
  }),
}));

vi.mock('sonner', () => ({ toast: { error: vi.fn(), warning: vi.fn() } }));

vi.mock('lucide-react', () => {
  const Icon = () => <span aria-hidden="true" />;
  return {
    AlertCircle: Icon,
    CreditCard: Icon,
    Download: Icon,
    Eye: Icon,
    Loader2: Icon,
    ReceiptText: Icon,
  };
});

const REGISTRY_HASH = `sha256:${'c'.repeat(64)}`;

const CONTRACT = {
  contract_version: '1.0.0',
  contract_hash: `sha256:${'d'.repeat(64)}`,
  registry_hash: REGISTRY_HASH,
  model: 'DELIVERED_ORDER',
  currency: 'BDT',
  trigger: 'ORDER_DELIVERED_PROVIDER_CONFIRMED',
  unit_price_bdt: 10,
  unit_price_minor: 1000,
  zero_rated_outcomes: ['RETURNED', 'CANCELLED', 'DRAFT', 'CONFIRMED', 'BOOKED', 'IN_TRANSIT', 'FAILED'],
  subscription_fee_bdt: 0,
  setup_fee_bdt: 0,
  monthly_minimum_bdt: 0,
  conversation_entitlement: null,
  cycle: 'MONTHLY',
  payment: 'POSTPAID',
  due_days: 7,
  on_overdue: {
    blockCourierBooking: true,
    pauseAutomatedAi: true,
    keepInboxReadable: true,
    keepHistoryReadable: true,
    deleteData: false,
  },
  description: { en: 'Delivered-order billing.', bn: 'ডেলিভারি-অর্ডার বিলিং।' },
  claims: [],
};

const INVOICE_ID = '0f9b5a2e-1c3d-4e5f-8a9b-0c1d2e3f4a5b';

const INVOICES = [
  {
    id: INVOICE_ID,
    invoice_number: 'INV-1',
    billing_period: '2026-11',
    amount: 20,
    status: 'pending',
    invoice_type: 'delivered_order',
    created_at: '2026-11-14T00:00:00.000Z',
  },
];

const LINES = [
  {
    id: 'line-1',
    invoiceId: INVOICE_ID,
    orderId: 'order-1',
    lineKind: 'DELIVERED_ORDER',
    outcome: 'DELIVERED',
    unitPriceMinor: 1000,
    amountMinor: 1000,
    currency: 'BDT',
    contractVersion: '1.0.0',
    createdAt: '2026-11-14T00:00:00.000Z',
  },
];

const decision = (claimId: string, textKey: string): ClaimDecision => ({
  claimId,
  available: true,
  render: 'claim',
  textKey,
  locale: 'en',
  surface: 'subscription',
  scope: { claimedProviders: null, verifiedProviders: null, match: true, text: null },
  interpolation: {},
  mode: 'enforce',
  predicate: {
    code_present: true,
    merchant_enabled: true,
    production_verified: true,
    deprecated: false,
    internal_only: false,
    scope_match: true,
  },
  wouldBlock: false,
  contractVersion: '1.0.0',
  registryHash: REGISTRY_HASH,
});

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Subscription />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Subscription billing page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    window.history.replaceState({}, '', '/subscription');
    mocks.isBkashEnabled.mockReturnValue(false);
    mocks.getInvoices.mockResolvedValue(INVOICES);
    mocks.getBillingLines.mockResolvedValue(LINES);
    mocks.cancelInvoicePayment.mockResolvedValue({ success: true, invoice_id: INVOICE_ID, status: 'pending' });
    mocks.completeInvoicePayment.mockResolvedValue({ success: true, invoice_id: INVOICE_ID, status: 'paid' });
    mockUseCommercialContract.mockReturnValue({ data: CONTRACT, isLoading: false, error: null });
    mockUseClaimDecisions.mockReturnValue({
      data: {
        surface: 'subscription',
        locale: 'en',
        contractVersion: '1.0.0',
        registryHash: REGISTRY_HASH,
        decisions: [
          decision('billing.delivered_order', 'claims.billing.delivered_order.en'),
          decision('billing.overdue_policy', 'claims.billing.overdue_policy.en'),
        ],
      },
      isLoading: false,
      error: null,
    });
  });

  it('renders the contract price and claim copy instead of retired plan pricing', async () => {
    renderPage();

    expect(await screen.findByText('৳10.00')).toBeInTheDocument();
    expect(screen.getAllByText(/per delivered order/).length).toBeGreaterThan(0);
    expect(screen.getByText(translations['claims.billing.delivered_order.en'])).toBeInTheDocument();
    expect(screen.getByText(translations['claims.billing.overdue_policy.en'])).toBeInTheDocument();
    expect(screen.getByText('Contract version 1.0.0')).toBeInTheDocument();

    expect(screen.queryByText(/moderator/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/partnership/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/৳999/)).not.toBeInTheDocument();
    expect(screen.queryByText(/top-?up/i)).not.toBeInTheDocument();
  });

  it('fails closed: shows no price when the contract cannot be validated', async () => {
    mockUseCommercialContract.mockReturnValue({ data: undefined, isLoading: false, error: new Error('rejected') });

    renderPage();

    expect(await screen.findByText(translations['subscription.contractUnavailable'])).toBeInTheDocument();
    expect(screen.queryByText('৳10.00')).not.toBeInTheDocument();
  });

  it('lists delivered-order invoices and loads their billing lines on demand', async () => {
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByText('INV-1')).toBeInTheDocument();
    expect(screen.getByText('Delivered orders')).toBeInTheDocument();
    expect(screen.getByText('৳20.00')).toBeInTheDocument();
    expect(mocks.getBillingLines).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /billing lines/i }));

    await waitFor(() => expect(mocks.getBillingLines).toHaveBeenCalledWith(INVOICE_ID));
    expect(await screen.findByText('order-1')).toBeInTheDocument();
    expect(screen.getByText('DELIVERED_ORDER')).toBeInTheDocument();
  });

  it('releases a cancelled invoice checkout before showing the cancellation state', async () => {
    window.history.pushState({}, '', '/subscription?paymentID=PAY-1&status=cancel');
    sessionStorage.setItem('easymod_pay_ctx', JSON.stringify({ kind: 'invoice', ref: INVOICE_ID }));

    renderPage();

    await waitFor(() => {
      expect(mocks.cancelInvoicePayment).toHaveBeenCalledWith(INVOICE_ID, 'PAY-1');
    });
    expect(await screen.findByText(translations['subscription.paymentCancelled'])).toBeInTheDocument();
    expect(sessionStorage.getItem('easymod_pay_ctx')).toBeNull();
  });
});