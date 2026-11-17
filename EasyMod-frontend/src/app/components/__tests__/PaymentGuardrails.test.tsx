/**
 * Payment-settings guardrails contracts (§8/§11/§16/§18/§29): channel signal
 * matrix, execution header without CTA, switch semantics + credential gating,
 * test-then-save order with secret hygiene, default election, advance-rule
 * state, banner roles/dismiss, and merchant-mode capability honesty. Additive
 * suite; the legacy PaymentSettings suite stays unchanged (real i18n en here).
 */
import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import PaymentSettings from '../PaymentSettings';
import { derivePaymentSignal } from '../payment/derive';
import { apiClient } from '@/api';

vi.mock('@/api', () => ({
  apiClient: {
    getPaymentConfig: vi.fn(),
    updatePaymentConfig: vi.fn(),
    testPaymentConnection: vi.fn(),
    getShop: vi.fn(),
    updateShop: vi.fn(),
    getAISettings: vi.fn(async () => ({ success: true, data: {} })),
    get: vi.fn(),
    put: vi.fn(),
  },
}));

vi.mock('@/app/lib/auth', () => ({
  authService: {
    getCurrentShop: vi.fn(() => ({ id: 'shop-1', unique_code: 'SHOP1', shop_name: 'My BD Shop' })),
    getCurrentShopId: vi.fn(() => 'shop-1'),
    getUser: vi.fn(() => ({ id: 'user-1' })),
  },
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const configRow = (overrides: Record<string, unknown> = {}) => ({
  gateway: 'self-mfs',
  is_enabled: false,
  credential_summary: {
    has_credentials: true,
    mfs_type: 'bkash',
    mfs_mode: 'self',
    mfs_number: '01711000000',
  },
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(apiClient.getPaymentConfig).mockResolvedValue({ success: true, data: [] } as never);
  vi.mocked(apiClient.getShop).mockResolvedValue({ success: true, data: { id: 'shop-1' } } as never);
  vi.mocked(apiClient.get).mockResolvedValue({ data: { data: { payment: [], delivery: [] } } } as never);
  vi.mocked(apiClient.put).mockResolvedValue({ data: { data: { payment: [], delivery: [] } } } as never);
  vi.mocked(apiClient.testPaymentConnection).mockResolvedValue({ success: true, data: {} } as never);
  vi.mocked(apiClient.updatePaymentConfig).mockResolvedValue({ success: true, data: {} } as never);
  vi.mocked(apiClient.updateShop).mockResolvedValue({ success: true, data: {} } as never);
});

async function renderPage(configs: unknown[] = []) {
  vi.mocked(apiClient.getPaymentConfig).mockResolvedValue({ success: true, data: configs } as never);
  render(<PaymentSettings />);
  // Skeletons gate the cards until the load lands; wait for a gateway card.
  return screen.findByTestId('gateway-card-cod');
}

describe('payment signal derivation', () => {
  const t = (key: string, opts?: Record<string, unknown>) =>
    opts?.count !== undefined ? `${key}:${opts.count}` : key;

  it('maps error / loading / enabled / none to distinct signals', () => {
    expect(derivePaymentSignal({ phase: 'error', enabledCount: 0 }, t).kind).toBe('blocked');
    expect(derivePaymentSignal({ phase: 'loading', enabledCount: 0 }, t).kind).toBe('pending');
    expect(derivePaymentSignal({ phase: 'ready', enabledCount: 2 }, t).kind).toBe('healthy');
    expect(derivePaymentSignal({ phase: 'ready', enabledCount: 0 }, t).kind).toBe('attention');
    expect(derivePaymentSignal({ phase: 'ready', enabledCount: 2 }, t).reason).toContain(':2');
  });
});

describe('execution header', () => {
  it('shows title + signal + factual pills and no header CTA', async () => {
    await renderPage();
    const signal = await screen.findByTestId('payment-signal');
    await waitFor(() => expect(signal.textContent).toContain('Accepting payments'));
    expect(screen.getByRole('heading', { level: 1, name: 'Payment Settings' })).toBeInTheDocument();
    expect(screen.queryByTestId('dashboard-primary-action')).toBeNull();
    expect(screen.getByText(/Enabled methods:/)).toBeInTheDocument();
    expect(screen.getByText(/Advance rule:/)).toBeInTheDocument();
  });

  it('surfaces a blocked signal and alert when the load fails', async () => {
    vi.mocked(apiClient.getPaymentConfig).mockRejectedValue(new Error('boom'));
    render(<PaymentSettings />);
    await waitFor(() => expect(screen.getByTestId('payment-signal').textContent).toContain('Configuration unavailable'));
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('drops to attention when no method is enabled', async () => {
    await renderPage();
    fireEvent.click(screen.getByRole('switch', { name: 'Cash on Delivery' }));
    await waitFor(() => expect(screen.getByTestId('payment-signal').textContent).toContain('No method enabled'));
  });
});

describe('gateway switches', () => {
  it('gates non-COD activation behind saved credentials with a reason', async () => {
    await renderPage();
    const bkash = screen.getByRole('switch', { name: 'bKash' });
    expect(bkash).toBeDisabled();
    expect(bkash).toHaveAttribute('title', 'Save configuration first');
    expect(screen.getByRole('switch', { name: 'Cash on Delivery' })).toBeEnabled();
  });

  it('exposes switch semantics and enables a saved gateway', async () => {
    await renderPage([configRow({ is_enabled: true })]);
    const bkash = screen.getByRole('switch', { name: 'bKash' });
    expect(bkash).toBeEnabled();
    expect(bkash).toHaveAttribute('aria-checked', 'true');
  });
});

describe('save flow', () => {
  it('tests the connection before saving and never echoes secrets', async () => {
    await renderPage([configRow()]);
    fireEvent.click(screen.getByTestId('gateway-expand-bkash'));
    const phone = await screen.findByDisplayValue('01711000000');
    expect(phone).toHaveAttribute('type', 'tel');

    // Merchant secrets stay blank — the summary contract never returns them.
    fireEvent.click(screen.getByRole('button', { name: 'Merchant API' }));
    expect(screen.getByLabelText('App Secret')).toHaveValue('');
    expect(screen.getByLabelText('App Key')).toHaveValue('');
    fireEvent.click(screen.getByRole('button', { name: /Self MFS/i }));

    fireEvent.click(screen.getByRole('button', { name: 'Save bKash' }));
    await waitFor(() => expect(apiClient.updatePaymentConfig).toHaveBeenCalled());
    expect(apiClient.testPaymentConnection).toHaveBeenCalledWith({
      gateway: 'self-mfs',
      credentials: { mfs_type: 'bkash', mfs_number: '01711000000', mfs_mode: 'self' },
    });
    const testOrder = vi.mocked(apiClient.testPaymentConnection).mock.invocationCallOrder[0];
    const saveOrder = vi.mocked(apiClient.updatePaymentConfig).mock.invocationCallOrder[0];
    expect(testOrder).toBeLessThan(saveOrder);
    expect(apiClient.updatePaymentConfig).toHaveBeenCalledWith({
      gateway: 'self-mfs',
      credentials: { mfs_type: 'bkash', mfs_number: '01711000000', mfs_mode: 'self' },
      config: {},
    });
  });

  it('states merchant-mode truth without claiming automated checkout', async () => {
    await renderPage([configRow()]);
    fireEvent.click(screen.getByTestId('gateway-expand-bkash'));
    fireEvent.click(await screen.findByRole('button', { name: 'Merchant API' }));
    expect(screen.getByText(/Automated checkout is not active yet/i)).toBeInTheDocument();
    expect(screen.queryByText(/Automated checkout via official merchant API/i)).toBeNull();
  });
});

describe('default election', () => {
  it('PUTs the reordered platform priority and confirms', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { data: { payment: ['cod'], delivery: [] } } } as never);
    await renderPage([configRow({ is_enabled: true })]);
    fireEvent.click(screen.getByRole('button', { name: /Set Default/i }));
    await waitFor(() => expect(apiClient.put).toHaveBeenCalledWith('/shop/platform-priority', {
      payment: ['bkash', 'cod'],
      delivery: [],
    }));
    expect(await screen.findByRole('status')).toHaveTextContent('bKash set as default payment method');
  });
});

describe('advance rules and message', () => {
  it('enables the percentage input only when selected and persists the rule', async () => {
    await renderPage();
    expect(screen.getByRole('radio', { name: /No Payment/i })).toBeChecked();
    fireEvent.click(screen.getByRole('radio', { name: /^Percentage/i }));
    expect(screen.getByRole('radio', { name: /^Percentage/i })).toBeChecked();
    expect(screen.getByLabelText('Percentage')).toBeEnabled();
    expect(screen.getByLabelText('Fixed Amount')).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Update Payment Info' }));
    await waitFor(() => expect(apiClient.updateShop).toHaveBeenCalled());
    const [, payload] = vi.mocked(apiClient.updateShop).mock.calls[0];
    expect(JSON.parse((payload as { payment_methods: string }).payment_methods).advancePaymentRule).toBe('percentage');
  });
});

describe('banners', () => {
  it('renders an alert with a labelled dismiss that clears it', async () => {
    vi.mocked(apiClient.updatePaymentConfig).mockRejectedValue(new Error('Network error'));
    await renderPage([configRow()]);
    fireEvent.click(screen.getByTestId('gateway-expand-bkash'));
    fireEvent.click(await screen.findByRole('button', { name: 'Save bKash' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/error/i);
    fireEvent.click(within(alert).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });
});
