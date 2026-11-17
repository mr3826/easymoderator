/**
 * Billing guardrails contracts (§8/§16/§18/§29 + ADR-0011 fail-closed pricing):
 * billing signal matrix, execution header without CTA, no price when the
 * contract cannot be validated, payment-banner roles, and invoice-table
 * semantics. Additive suite (real i18n en); the legacy Subscription /
 * BillingStandingBanner suites stay unchanged.
 */
import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Subscription from '../../Subscription';
import { deriveBillingSignal } from '../derive';
import { deriveUsageSummary, invoiceUsage, outcomeDateFor } from '../usage';
import { useCommercialContract, useClaimDecisions } from '@/api/domains/commercialContract';
import { getInvoices, getBillingLines, cancelInvoicePayment } from '@/api/domains/subscription';

vi.mock('@/api/domains/commercialContract', () => ({
  useCommercialContract: vi.fn(),
  useClaimDecisions: vi.fn(),
}));

vi.mock('@/api/domains/subscription', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/domains/subscription')>()),
  getInvoices: vi.fn(),
  getBillingLines: vi.fn(),
  payInvoice: vi.fn(),
  completeInvoicePayment: vi.fn(),
  cancelInvoicePayment: vi.fn(),
}));

vi.mock('@/features/auth/AuthProvider', () => ({ useOptionalAuth: () => null }));

vi.mock('@/app/lib/config', () => ({
  isBkashEnabled: () => false,
  buildApiUrl: (path: string) => `https://api.test${path}`,
  toApiRequestPath: (path: string) => path,
  isMarketingSurface: () => false,
  default: {
    apiBaseUrl: 'https://api.test', appUrl: 'https://app.test',
    marketingUrl: 'https://marketing.test', environment: 'development', bkashEnabled: false,
  },
}));

vi.mock('sonner', () => ({ toast: { error: vi.fn(), warning: vi.fn() } }));

vi.mock('lucide-react', () => {
  const Icon = () => <span aria-hidden="true" />;
  return {
    AlertCircle: Icon, CreditCard: Icon, Download: Icon, Eye: Icon, Loader2: Icon, ReceiptText: Icon,
    ChevronRight: Icon, BadgeCheck: Icon, CheckCircle2: Icon, Clock4: Icon, OctagonX: Icon, TriangleAlert: Icon,
  };
});

const REGISTRY_HASH = `sha256:${'c'.repeat(64)}`;
const INVOICE_ID = '0f9b5a2e-1c3d-4e5f-8a9b-0c1d2e3f4a5b';

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
    blockCourierBooking: true, pauseAutomatedAi: true, keepInboxReadable: true,
    keepHistoryReadable: true, deleteData: false,
  },
  description: { en: 'Delivered-order billing.', bn: 'ডেলিভারি-অর্ডার বিলিং।' },
  claims: [],
};

const INVOICES = [{
  id: INVOICE_ID, invoice_number: 'INV-1', billing_period: '2026-11', amount: 20,
  status: 'pending', invoice_type: 'delivered_order', created_at: '2026-11-14T00:00:00.000Z',
}];

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter><Subscription /></MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  window.history.replaceState({}, '', '/subscription');
  vi.mocked(getInvoices).mockResolvedValue(INVOICES as never);
  vi.mocked(getBillingLines).mockResolvedValue([] as never);
  vi.mocked(cancelInvoicePayment).mockResolvedValue({ success: true } as never);
  vi.mocked(useCommercialContract).mockReturnValue({ data: CONTRACT, isLoading: false, error: null } as never);
  vi.mocked(useClaimDecisions).mockReturnValue({
    data: { surface: 'subscription', locale: 'en', contractVersion: '1.0.0', registryHash: REGISTRY_HASH, decisions: [] },
    isLoading: false, error: null,
  } as never);
});

describe('billing signal derivation', () => {
  const t = (key: string, opts?: Record<string, unknown>) => (opts?.count !== undefined ? `${key}:${opts.count}` : key);
  it('maps error / loading / due / current / empty to distinct signals', () => {
    expect(deriveBillingSignal({ phase: 'error', invoiceCount: 0, outstandingCount: 0 }, t).kind).toBe('blocked');
    expect(deriveBillingSignal({ phase: 'loading', invoiceCount: 0, outstandingCount: 0 }, t).kind).toBe('pending');
    expect(deriveBillingSignal({ phase: 'ready', invoiceCount: 3, outstandingCount: 1 }, t).kind).toBe('attention');
    expect(deriveBillingSignal({ phase: 'ready', invoiceCount: 3, outstandingCount: 1 }, t).label).toContain('due');
    expect(deriveBillingSignal({ phase: 'ready', invoiceCount: 3, outstandingCount: 0 }, t).kind).toBe('healthy');
    expect(deriveBillingSignal({ phase: 'ready', invoiceCount: 0, outstandingCount: 0 }, t).kind).toBe('attention');
  });
});

describe('execution header', () => {
  it('shows title + signal + count pills and no header CTA', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId('billing-signal').textContent).toContain('Invoice due'));
    expect(screen.getByRole('heading', { level: 1, name: 'Billing' })).toBeInTheDocument();
    expect(screen.queryByTestId('dashboard-primary-action')).toBeNull();
    expect(screen.getByText(/Invoices: 1/)).toBeInTheDocument();
    expect(screen.getByText(/Due: 1/)).toBeInTheDocument();
  });

  it('fails closed: a rejected contract blocks the signal and shows no price', async () => {
    vi.mocked(useCommercialContract).mockReturnValue({ data: undefined, isLoading: false, error: new Error('rejected') } as never);
    renderPage();
    await waitFor(() => expect(screen.getByTestId('billing-signal').textContent).toContain('Terms unavailable'));
    expect(screen.queryByText('৳10.00')).not.toBeInTheDocument();
  });
});

describe('invoice table semantics', () => {
  it('labels the table and wires the billing-lines toggle to its panel', async () => {
    const user = userEvent.setup();
    renderPage();
    const table = await screen.findByRole('table', { name: 'Invoices' });
    expect(table.querySelectorAll('th[scope="col"]').length).toBe(6);
    const toggle = screen.getByRole('button', { name: /billing lines/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveAttribute('aria-controls', `billing-lines-${INVOICE_ID}`);
    await user.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute('aria-expanded', 'true'));
    expect(document.getElementById(`billing-lines-${INVOICE_ID}`)).not.toBeNull();
  });
});

describe('payment banners', () => {
  it('announces a cancelled checkout as an alert', async () => {
    window.history.pushState({}, '', '/subscription?paymentID=PAY-1&status=cancel');
    sessionStorage.setItem('easymod_pay_ctx', JSON.stringify({ kind: 'invoice', ref: INVOICE_ID }));
    renderPage();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/payment was cancelled/i);
    expect(sessionStorage.getItem('easymod_pay_ctx')).toBeNull();
  });
});

describe('usage derivation (pure)', () => {
  const meta = (delivered: number, zero: number) => ({
    deliveredCount: delivered, zeroRatedCount: zero, grossMinor: delivered * 1000, creditMinor: 0, netMinor: delivered * 1000,
  });

  it('sums only invoices that carry usable metadata', () => {
    const summary = deriveUsageSummary([
      { amount: 64000, status: 'pending', metadata: meta(64, 9) },
      { amount: 12000, status: 'paid', metadata: meta(12, 3) },
      { amount: 5000, status: 'overdue', metadata: null },
    ]);
    expect(summary.hasDetail).toBe(true);
    expect(summary.periodsCovered).toBe(2);
    expect(summary.deliveredCount).toBe(76);
    expect(summary.zeroRatedCount).toBe(12);
    // Outstanding counts pending + overdue only, regardless of metadata.
    expect(summary.outstandingMinor).toBe(69000);
  });

  it('fails closed when no invoice has detail, and rejects malformed counts', () => {
    expect(deriveUsageSummary([{ amount: 1000, status: 'pending', metadata: null }]).hasDetail).toBe(false);
    expect(invoiceUsage({ deliveredCount: -1, zeroRatedCount: 0 })).toBeNull();
    expect(invoiceUsage({ deliveredCount: 'many', zeroRatedCount: 0 })).toBeNull();
    expect(invoiceUsage(undefined)).toBeNull();
  });

  it('reads the real outcome date from the frozen line list, not the API createdAt', () => {
    const metadata = { lines: [{ orderId: 'order-1', occurredAt: '2026-10-12' }] };
    expect(outcomeDateFor(metadata, 'order-1')).toBe('2026-10-12');
    expect(outcomeDateFor(metadata, 'order-unknown')).toBeNull();
    expect(outcomeDateFor({ lines: 'nope' }, 'order-1')).toBeNull();
    expect(outcomeDateFor(null, 'order-1')).toBeNull();
  });
});

describe('usage on the billing page', () => {
  const USAGE_INVOICE = {
    id: INVOICE_ID,
    invoice_number: 'INV-2',
    billing_period: '2026-10',
    billing_period_start: '2026-10-01T00:00:00.000Z',
    billing_period_end: '2026-11-01T00:00:00.000Z',
    amount: 640,
    status: 'pending',
    invoice_type: 'delivered_order',
    created_at: '2026-11-01T00:00:00.000Z',
    due_date: '2026-11-08T12:00:00.000Z',
    metadata: {
      deliveredCount: 64,
      zeroRatedCount: 9,
      grossMinor: 64000,
      creditMinor: 0,
      netMinor: 64000,
      lines: [{ orderId: 'order-1', kind: 'billable', outcome: 'DELIVERED', amountMinor: 1000, occurredAt: '2026-10-12' }],
    },
  };

  it('says so honestly when no invoice carries usage detail', async () => {
    renderPage();
    expect(await screen.findByText(/Usage detail is available for invoices issued under the current contract/i)).toBeInTheDocument();
    expect(screen.queryByText('Delivered orders billed')).toBeNull();
  });

  it('shows billed usage, period bounds, due date and the real outcome date', async () => {
    vi.mocked(getInvoices).mockResolvedValue([USAGE_INVOICE] as never);
    vi.mocked(getBillingLines).mockResolvedValue([{
      id: 'line-1', invoiceId: INVOICE_ID, orderId: 'order-1', lineKind: 'DELIVERED_ORDER',
      outcome: 'DELIVERED', unitPriceMinor: 1000, amountMinor: 1000, currency: 'BDT',
      contractVersion: '1.0.0', createdAt: '2026-11-01T00:00:00.000Z',
    }] as never);
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByText('Delivered orders billed')).toBeInTheDocument();
    expect(screen.getByText('64')).toBeInTheDocument();
    expect(screen.getByText('9')).toBeInTheDocument();
    expect(screen.getByText(/Delivered billed: 64/)).toBeInTheDocument();
    // Period bounds are inclusive: the stored end is exclusive.
    expect(screen.getByText(/1 Oct – 31 Oct/)).toBeInTheDocument();
    expect(screen.getByText(/64 delivered · 9 zero-rated/)).toBeInTheDocument();
    expect(screen.getByText(/Due 8 Nov 2026/)).toBeInTheDocument();
    // The invoices table keeps its six columns; detail rides inside existing cells.
    const table = screen.getByRole('table', { name: 'Invoices' });
    expect(table.querySelectorAll('th[scope="col"]').length).toBe(6);

    await user.click(screen.getByRole('button', { name: /billing lines/i }));
    expect(await screen.findByText('12 Oct 2026')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Outcome date' })).toBeInTheDocument();
  });
});
