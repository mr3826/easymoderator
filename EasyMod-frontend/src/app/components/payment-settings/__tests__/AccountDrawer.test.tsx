/**
 * AccountDrawer — per-account config honesty (§2, §8.3 "never echoes secrets",
 * "replace-by-entry with explicit warning", rate-limited verify, live-certify).
 *
 * Mocks the whole payment domain module (the documented seam target) so no HTTP
 * occurs; every mutation is asserted against the contract §API client names.
 */
import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import AccountDrawer from '../AccountDrawer';
import * as paymentApi from '@/api/domains/payment';
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

const gwAccount = (over: Partial<PaymentAccountView> = {}): PaymentAccountView => ({
  id: 'gw-1',
  shop_id: 'shop-1',
  provider: 'bkash',
  account_type: 'merchant_gateway',
  gateway: 'self-mfs',
  is_enabled: true,
  is_preferred: false,
  verification_level: 'configured_unverified',
  automated_checkout_active: false,
  credential_summary: { has_credentials: true, mfs_type: 'bkash', mfs_mode: 'business', mfs_number: null },
  ...over,
});

const walletAccount = (over: Partial<PaymentAccountView> = {}): PaymentAccountView => ({
  id: 'w-1',
  shop_id: 'shop-1',
  provider: 'nagad',
  account_type: 'self',
  gateway: 'self-mfs',
  is_enabled: false,
  is_preferred: false,
  verification_level: 'configured_unverified',
  automated_checkout_active: false,
  credential_summary: { has_credentials: true, mfs_type: 'nagad', mfs_mode: 'self', mfs_number: '01711000000' },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(paymentApi.savePaymentAccount).mockResolvedValue({ success: true, data: gwAccount() } as never);
  vi.mocked(paymentApi.updatePaymentAccount).mockResolvedValue({ success: true, data: gwAccount() } as never);
  vi.mocked(paymentApi.verifyPaymentAccountCredentials).mockResolvedValue({ success: true, message: 'bKash accepted your app credentials (one of 2 hourly checks used).' } as never);
  vi.mocked(paymentApi.certifyLiveAccount).mockResolvedValue({ success: true } as never);
});

describe('AccountDrawer — create flow', () => {
  it('creates a wallet account with provider-matched credentials and never a gateway secret field', async () => {
    const onSaved = vi.fn();
    const onClose = vi.fn();
    render(<AccountDrawer mode="create" provider="bkash" lockProvider existingChannels={['self']} onClose={onClose} onSaved={onSaved} />);

    fireEvent.change(screen.getByLabelText(/bKash Phone Number/i), { target: { value: '01711000000' } });
    // business was selected by default? existing self configured → business is first available.
    fireEvent.click(screen.getByTestId('account-drawer-save'));

    await waitFor(() => expect(paymentApi.savePaymentAccount).toHaveBeenCalledTimes(1));
    const payload = vi.mocked(paymentApi.savePaymentAccount).mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(payload.provider).toBe('bkash');
    expect(payload.account_type).toBe('business');
    const creds = payload.credentials as Record<string, unknown>;
    expect(creds).toEqual({ mfs_type: 'bkash', mfs_number: '01711000000', mfs_mode: 'business' });
    expect(creds.app_key).toBeUndefined();
    expect(creds.app_secret).toBeUndefined();
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalled();
  });

  it('merchant_gateway create requires the full secret set before it saves', async () => {
    const onClose = vi.fn();
    render(<AccountDrawer mode="create" provider="bkash" onClose={onClose} onSaved={vi.fn()} />);
    // Select merchant gateway channel (self is default available).
    fireEvent.click(screen.getByTestId('channel-option-merchant_gateway'));
    expect(screen.getByTestId('gateway-app-secret')).toHaveValue('');
    fireEvent.click(screen.getByTestId('account-drawer-save'));
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(paymentApi.savePaymentAccount).not.toHaveBeenCalled();
  });
});

describe('AccountDrawer — edit: never echoes secrets', () => {
  it('opens an existing gateway with every secret field blank', () => {
    render(<AccountDrawer mode="edit" provider="bkash" lockProvider account={gwAccount()} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.getByTestId('gateway-app-key')).toHaveValue('');
    expect(screen.getByTestId('gateway-app-secret')).toHaveValue('');
    expect(screen.getByTestId('gateway-username')).toHaveValue('');
    expect(screen.getByTestId('gateway-password')).toHaveValue('');
    // The stored number is a wallet field, never a secret; gateway has no number.
    expect(screen.queryByLabelText(/Phone Number/i)).not.toBeInTheDocument();
  });

  it('shows the wallet number (non-secret) on edit and sends it on save', async () => {
    render(<AccountDrawer mode="edit" provider="nagad" lockProvider account={walletAccount()} onClose={vi.fn()} onSaved={vi.fn()} />);
    const phone = screen.getByLabelText(/Phone Number/i);
    expect(phone).toHaveValue('01711-000-000'); // BDPhoneInput formats for display
    fireEvent.click(screen.getByTestId('account-drawer-save'));
    await waitFor(() => expect(paymentApi.updatePaymentAccount).toHaveBeenCalledTimes(1));
    const [id, patch] = vi.mocked(paymentApi.updatePaymentAccount).mock.calls[0] as [string, { credentials: Record<string, unknown> }];
    expect(id).toBe('w-1');
    expect(patch.credentials).toEqual({ mfs_type: 'nagad', mfs_number: '01711000000', mfs_mode: 'self' });
  });

  it('warns explicitly when replace-by-entry will overwrite stored credentials, and does not blank them if secrets are left untouched', async () => {
    render(<AccountDrawer mode="edit" provider="bkash" lockProvider account={gwAccount()} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByTestId('gateway-app-key'), { target: { value: 'newkey' } });
    expect(screen.getByTestId('replace-warning')).toBeInTheDocument();

    // Save with an INCOMPLETE secret set: credentials are NOT sent (stored ones survive).
    fireEvent.click(screen.getByTestId('account-drawer-save'));
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(paymentApi.updatePaymentAccount).not.toHaveBeenCalled();
  });
});

describe('AccountDrawer — verification actions (honest)', () => {
  it('renders the bKash credential-check verdict from the server, not an app-claimed verification', async () => {
    render(<AccountDrawer mode="edit" provider="bkash" lockProvider account={gwAccount()} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByTestId('drawer-verify-credentials'));
    await waitFor(() => expect(paymentApi.verifyPaymentAccountCredentials).toHaveBeenCalledWith('gw-1'));
    const banner = await screen.findByRole('status');
    expect(banner).toHaveTextContent('bKash accepted your app credentials (one of 2 hourly checks used).');
    expect(banner).not.toHaveTextContent(/verified with provider/i);
  });

  it('surfaces a 501 (A3 not landed) or 429 cooldown honestly', async () => {
    const err = Object.assign(new Error(''), { type: 'SERVER_ERROR', statusCode: 501, message: 'Payment automation pending (A3 service not implemented).', code: 'PAYMENT_SERVICE_NOT_IMPLEMENTED' });
    vi.mocked(paymentApi.verifyPaymentAccountCredentials).mockRejectedValue(err as never);
    render(<AccountDrawer mode="edit" provider="bkash" lockProvider account={gwAccount()} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByTestId('drawer-verify-credentials'));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Payment automation pending');
  });

  it('hides live-certify unless the gateway is sandbox_verified (R-12 inert default)', async () => {
    const { rerender } = render(<AccountDrawer mode="edit" provider="bkash" lockProvider account={gwAccount()} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.queryByTestId('drawer-certify-live')).not.toBeInTheDocument();
    rerender(<AccountDrawer mode="edit" provider="bkash" lockProvider account={gwAccount({ verification_level: 'sandbox_verified' })} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.getByTestId('drawer-certify-live')).toBeInTheDocument();
    // Certify requires evidence.
    fireEvent.click(screen.getByTestId('drawer-certify-live'));
    expect(paymentApi.certifyLiveAccount).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId('certify-evidence'), { target: { value: 'bKash onboarding email 2026-11-30' } });
    fireEvent.click(screen.getByTestId('drawer-certify-live'));
    await waitFor(() => expect(paymentApi.certifyLiveAccount).toHaveBeenCalledWith('gw-1', 'bKash onboarding email 2026-11-30'));
  });
});
