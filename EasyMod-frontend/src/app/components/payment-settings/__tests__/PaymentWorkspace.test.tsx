/**
 * PaymentWorkspace shell — tab wiring (roving + Home/End), the ONE policy PUT
 * with a server-confirmed reload, accounts reload without clobbering an unsaved
 * draft, and bn-first i18n through existing locale keys. Whole payment domain
 * mocked; no HTTP, no live-provider claim (R-12).
 */
import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import PaymentWorkspace from '../PaymentWorkspace';
import * as paymentApi from '@/api/domains/payment';
import i18n from '@/i18n';
import type { PaymentAccountView } from '../taxonomy';

vi.mock('@/api/domains/payment', () => ({
  getPaymentConfig: vi.fn(),
  updatePaymentConfig: vi.fn(),
  testPaymentConnection: vi.fn(),
  deletePaymentConfig: vi.fn(),
  getPaymentAccounts: vi.fn(),
  savePaymentAccount: vi.fn(),
  updatePaymentAccount: vi.fn(),
  deletePaymentAccount: vi.fn(),
  setPreferredAccount: vi.fn(),
  verifyPaymentAccountCredentials: vi.fn(),
  certifyLiveAccount: vi.fn(),
  getPaymentPolicy: vi.fn(),
  updatePaymentPolicy: vi.fn(),
}));

vi.mock('@/app/lib/auth', () => ({
  authService: {
    getCurrentShop: vi.fn(() => ({ id: 'shop-1', shop_name: 'My BD Shop' })),
    getCurrentShopId: vi.fn(() => 'shop-1'),
    getUser: vi.fn(() => ({ id: 'user-1' })),
  },
}));

const account = (o: Partial<PaymentAccountView> = {}): PaymentAccountView => ({
  id: 'a1',
  shop_id: 's',
  provider: 'bkash',
  account_type: 'self',
  gateway: 'self-mfs',
  is_enabled: true,
  is_preferred: true,
  verification_level: 'configured_unverified',
  automated_checkout_active: false,
  credential_summary: { has_credentials: true, mfs_type: 'bkash', mfs_mode: 'self', mfs_number: '01711000000' },
  ...o,
});

const noPolicy = { advance_policy: 'none', advance_value: null, payment_message: '' };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(paymentApi.getPaymentAccounts).mockResolvedValue({ success: true, data: [account()] } as never);
  vi.mocked(paymentApi.getPaymentPolicy).mockResolvedValue({ success: true, data: noPolicy } as never);
  vi.mocked(paymentApi.updatePaymentPolicy).mockResolvedValue({ success: true, data: { advance_policy: 'percentage', advance_value: 50, payment_message: '' } } as never);
  vi.mocked(paymentApi.savePaymentAccount).mockResolvedValue({ success: true, data: account() } as never);
  vi.mocked(paymentApi.updatePaymentAccount).mockResolvedValue({ success: true, data: account() } as never);
});

afterEach(async () => {
  await i18n.changeLanguage('en');
});

function renderShell() {
  render(
    <MemoryRouter>
      <PaymentWorkspace />
    </MemoryRouter>,
  );
  return screen.findByTestId('method-row-cod');
}

describe('PaymentWorkspace', () => {
  it('shows the execution header with the reused channel signal and factual pills', async () => {
    await renderShell();
    const signal = await screen.findByTestId('payment-signal');
    expect(signal).toHaveTextContent('Accepting payments');
    expect(screen.getByRole('heading', { level: 1, name: 'Payment Settings' })).toBeInTheDocument();
    expect(screen.queryByTestId('dashboard-primary-action')).toBeNull();
    expect(screen.getByText(/Preferred:/)).toBeInTheDocument();
  });

  it('moves between tabs with roving focus + Home/End (tablist contract)', async () => {
    await renderShell();
    const methods = screen.getByTestId('payment-tab-methods');
    const policies = screen.getByTestId('payment-tab-policies');
    expect(methods).toHaveAttribute('aria-selected', 'true');
    expect(methods).toHaveAttribute('tabindex', '0');
    expect(policies).toHaveAttribute('tabindex', '-1');

    fireEvent.keyDown(methods, { key: 'ArrowRight' });
    await waitFor(() => expect(policies).toHaveAttribute('aria-selected', 'true'));
    // wrap back
    fireEvent.keyDown(policies, { key: 'ArrowRight' });
    await waitFor(() => expect(methods).toHaveAttribute('aria-selected', 'true'));
    fireEvent.keyDown(methods, { key: 'End' });
    await waitFor(() => expect(policies).toHaveAttribute('aria-selected', 'true'));
    fireEvent.keyDown(policies, { key: 'Home' });
    await waitFor(() => expect(methods).toHaveAttribute('aria-selected', 'true'));
  });

  it('persists the policy through exactly one PUT and reloads the confirmation from the server', async () => {
    await renderShell();
    fireEvent.click(screen.getByTestId('payment-tab-policies'));
    await screen.findByTestId('policies-tab');

    fireEvent.click(screen.getByLabelText(/^Percentage/i));
    fireEvent.click(screen.getByTestId('policy-save'));

    await waitFor(() => expect(paymentApi.updatePaymentPolicy).toHaveBeenCalledTimes(1));
    expect(paymentApi.updatePaymentPolicy).toHaveBeenCalledWith({
      advance_policy: 'percentage',
      advance_value: 50,
      payment_message: '',
    });
    await waitFor(() => expect(screen.getByTestId('policies-tab').textContent).toMatch(/saved/i));
  });

  it('reloads accounts from the server on a method mutation (never an optimistic done)', async () => {
    await renderShell();
    expect(paymentApi.getPaymentAccounts).toHaveBeenCalledTimes(1);
    // enable COD (no cod row yet) → save + reloadAccounts → accounts fetched again
    const codSwitch = screen.getByTestId('method-row-cod').querySelector('[role="switch"]') as HTMLElement;
    fireEvent.click(codSwitch);
    await waitFor(() => expect(paymentApi.savePaymentAccount).toHaveBeenCalled());
    await waitFor(() => expect(paymentApi.getPaymentAccounts).toHaveBeenCalledTimes(2));
  });

  it('renders every provider label through i18n — Bangla for COD AND the merged new keys (bn-first, no raw-key leak)', async () => {
    await renderShell();
    // codName is an existing en+bn key: switching to bn must translate it.
    await i18n.changeLanguage('bn');
    await waitFor(() => expect(screen.getByText('ক্যাশ অন ডেলিভারি')).toBeInTheDocument());
    // nagadName/rocketName merged into en.json + bn.json by integration (A2 Q4) —
    // under bn they render their Bangla values, proving the locale owner landed
    // them and the component no longer needs its English fallback here.
    expect(screen.getByText('নগদ')).toBeInTheDocument();
    expect(screen.getByText('রকেট')).toBeInTheDocument();
    expect(screen.queryByText(/paymentSettings\.tabs|paymentSettings\.accountTypes/)).not.toBeInTheDocument();
  });
});
