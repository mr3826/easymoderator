/**
 * MethodsTab — enable gating, single-preferred invariant, delete-with-confirm,
 * reload-from-server (never an optimistic "done"), and that provider rows expand
 * to their configured accounts (§1.1/§6/§7 row 3, D-8).
 */
import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import MethodsTab from '../MethodsTab';
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

const account = (o: Partial<PaymentAccountView> = {}): PaymentAccountView => ({
  id: 'x',
  shop_id: 's',
  provider: 'bkash',
  account_type: 'self',
  gateway: 'self-mfs',
  is_enabled: true,
  is_preferred: false,
  verification_level: 'configured_unverified',
  automated_checkout_active: false,
  credential_summary: { has_credentials: true, mfs_type: 'bkash', mfs_mode: 'self', mfs_number: '01711000000' },
  ...o,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(paymentApi.updatePaymentAccount).mockResolvedValue({ success: true, data: account() } as never);
  vi.mocked(paymentApi.savePaymentAccount).mockResolvedValue({ success: true, data: account() } as never);
  vi.mocked(paymentApi.deletePaymentAccount).mockResolvedValue({ success: true } as never);
  vi.mocked(paymentApi.setPreferredAccount).mockResolvedValue({ success: true, preferred_account_id: 'b' } as never);
});

async function renderWith(accounts: PaymentAccountView[]) {
  const onMutate = vi.fn(async () => {});
  render(<MethodsTab accounts={accounts} onMutate={onMutate} />);
  // COD row is always present; wait past the mount animation gate.
  await screen.findByTestId('method-row-cod');
  return onMutate;
}

describe('MethodsTab', () => {
  it('renders a single COD row and a row per wallet provider', async () => {
    await renderWith([]);
    expect(screen.getByTestId('method-row-cod')).toBeInTheDocument();
    for (const p of ['bkash', 'nagad', 'rocket']) {
      expect(screen.getByTestId(`method-row-${p}`)).toBeInTheDocument();
    }
  });

  it('expands a provider to its configured accounts', async () => {
    await renderWith([account({ id: 'a1' })]);
    expect(screen.queryByTestId('account-card-a1')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('expand-bkash'));
    expect(await screen.findByTestId('account-card-a1')).toBeInTheDocument();
  });

  it('gates a credential-less wallet behind enable, and never implies verification', async () => {
    await renderWith([account({ id: 'a1', is_enabled: false, credential_summary: { has_credentials: false, mfs_type: 'bkash', mfs_mode: 'self', mfs_number: null } })]);
    fireEvent.click(screen.getByTestId('expand-bkash'));
    const card = await screen.findByTestId('account-card-a1');
    const sw = within(card).getByRole('switch');
    expect(sw).toBeDisabled();
    expect(sw).toHaveAttribute('title', 'Save configuration first');
    // honesty: enabling a wallet still never says "verified"
    expect(within(card).getByTestId('verification-chip-a1')).not.toHaveTextContent(/verified with provider/i);
  });

  it('enables a configured wallet and reloads from the server (no optimistic success)', async () => {
    const onMutate = await renderWith([account({ id: 'a1', is_enabled: true })]);
    fireEvent.click(screen.getByTestId('expand-bkash'));
    const card = await screen.findByTestId('account-card-a1');
    fireEvent.click(within(card).getByRole('switch'));
    await waitFor(() => expect(paymentApi.updatePaymentAccount).toHaveBeenCalledWith('a1', { is_enabled: false }));
    await waitFor(() => expect(onMutate).toHaveBeenCalled());
  });

  it('creates the single COD row on first enable', async () => {
    await renderWith([]);
    const sw = within(screen.getByTestId('method-row-cod')).getByRole('switch');
    expect(sw).toBeEnabled();
    fireEvent.click(sw);
    await waitFor(() => expect(paymentApi.savePaymentAccount).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'cod', account_type: 'standard', is_enabled: true }),
    ));
  });

  it('enforces a single preferred account per shop and only sends the elected id (D-8)', async () => {
    await renderWith([
      account({ id: 'a', is_preferred: true }),
      account({ id: 'b', is_preferred: false }),
    ]);
    fireEvent.click(screen.getByTestId('expand-bkash'));
    const aCard = await screen.findByTestId('account-card-a');
    const bCard = await screen.findByTestId('account-card-b');
    // exactly one preferred badge in the whole tab
    expect(screen.queryAllByTestId(/preferred-star-/)).toHaveLength(1);
    expect(within(aCard).getByTestId('preferred-toggle-a')).toHaveAttribute('aria-checked', 'true');
    expect(within(aCard).getByTestId('preferred-toggle-a')).toBeDisabled();
    // electing the other one hits the preferred endpoint for b only; server clears a.
    fireEvent.click(within(bCard).getByTestId('preferred-toggle-b'));
    await waitFor(() => expect(paymentApi.setPreferredAccount).toHaveBeenCalledTimes(1));
    expect(paymentApi.setPreferredAccount).toHaveBeenCalledWith('b');
  });

  it('disables the preferred toggle on a not-yet-enabled account (409-prevention)', async () => {
    await renderWith([account({ id: 'b', is_enabled: false })]);
    fireEvent.click(screen.getByTestId('expand-bkash'));
    const card = await screen.findByTestId('account-card-b');
    const star = within(card).getByTestId('preferred-toggle-b');
    expect(star).toBeDisabled();
    expect(star).toHaveAttribute('title', 'Enable this account before setting it preferred');
  });

  it('deletes only after an explicit confirm; cancel never calls the API', async () => {
    await renderWith([account({ id: 'a1' })]);
    fireEvent.click(screen.getByTestId('expand-bkash'));
    const card = await screen.findByTestId('account-card-a1');
    fireEvent.click(within(card).getByTestId('delete-a1'));
    const dialog = await screen.findByRole('dialog', { name: /Delete this payment account/i });
    // cancel
    fireEvent.click(within(dialog).getByRole('button', { name: /Cancel/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(paymentApi.deletePaymentAccount).not.toHaveBeenCalled();
    // now confirm
    fireEvent.click(within(card).getByTestId('delete-a1'));
    const dialog2 = await screen.findByRole('dialog', { name: /Delete this payment account/i });
    fireEvent.click(within(dialog2).getByTestId('confirm-delete-account'));
    await waitFor(() => expect(paymentApi.deletePaymentAccount).toHaveBeenCalledWith('a1'));
  });

  it('surfaces a server error from a mutation instead of silently succeeding', async () => {
    vi.mocked(paymentApi.updatePaymentAccount).mockRejectedValueOnce(new Error('boom'));
    await renderWith([account({ id: 'a1', is_enabled: true })]);
    fireEvent.click(screen.getByTestId('expand-bkash'));
    const card = await screen.findByTestId('account-card-a1');
    fireEvent.click(within(card).getByRole('switch'));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  // F4: the delete dialog must state TRUE semantics — pending/unclosed payment
  // records block deletion server-side (409 ACCOUNT_IN_USE), and the orders/
  // transactions FK is ON DELETE SET NULL, so historical attribution survives
  // as transaction RECORDS while the link to this account entry is LOST. The
  // old copy promised "Existing orders keep their payment attribution" — never
  // say that when the link becomes NULL.
  it('states the honest delete semantics (resolve pending records first; link lost, never "keeps attribution")', async () => {
    await renderWith([account({ id: 'a1' })]);
    fireEvent.click(screen.getByTestId('expand-bkash'));
    const card = await screen.findByTestId('account-card-a1');
    fireEvent.click(within(card).getByTestId('delete-a1'));
    const body = await screen.findByTestId('delete-account-body');
    expect(body).toHaveTextContent('pending or unclosed payment records cannot be deleted until those are resolved');
    expect(body).toHaveTextContent('no longer link to this account entry');
    expect(body).not.toHaveTextContent(/keep their payment attribution/i);
  });

  it('surfaces a 409 ACCOUNT_IN_USE refusal VERBATIM instead of pretending the delete happened', async () => {
    // NormalizedApiError shape (what the http client throws) — the component
    // renders the server's message unchanged, whatever wording the backend
    // ships for the guard.
    // Verbatim from payment-accounts.service.js:357-362 (guard landed 2026-11-26).
    vi.mocked(paymentApi.deletePaymentAccount).mockRejectedValueOnce(Object.assign(new Error(''), {
      type: 'CONFLICT',
      statusCode: 409,
      code: 'ACCOUNT_IN_USE',
      message: 'This payment account still has 1 unsettled payment transaction(s). Settle them (approve/reject) first, or disable the account instead of deleting it.',
      timestamp: new Date().toISOString(),
    }));
    const onMutate = await renderWith([account({ id: 'a1' })]);
    fireEvent.click(screen.getByTestId('expand-bkash'));
    const card = await screen.findByTestId('account-card-a1');
    fireEvent.click(within(card).getByTestId('delete-a1'));
    const dialog = await screen.findByRole('dialog', { name: /Delete this payment account/i });
    fireEvent.click(within(dialog).getByTestId('confirm-delete-account'));
    await waitFor(() => expect(paymentApi.deletePaymentAccount).toHaveBeenCalledWith('a1'));
    const alert = await screen.findByRole('alert');
    // Verbatim server wording, not a generic failure toast.
    expect(alert).toHaveTextContent('still has 1 unsettled payment transaction(s). Settle them (approve/reject) first, or disable the account instead of deleting it.');
    // A refusal is a refusal: the tab never claims the account was deleted,
    // and it never optimistically drops the row (no reload, no success state).
    expect(alert).not.toHaveTextContent(/Account deleted/i);
    expect(screen.getByTestId('account-card-a1')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(onMutate).not.toHaveBeenCalled();
  });
});
