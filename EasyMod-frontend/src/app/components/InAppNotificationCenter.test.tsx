import '@testing-library/jest-dom';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import InAppNotificationCenter from './InAppNotificationCenter';
import type { OwnerNotification } from '@/api/types/notification';

const { mockGetInAppNotifications, mockMarkInAppNotificationRead, mockRespondToPaymentConfirmation, mockToastError, mockGetCurrentShop } = vi.hoisted(() => ({
  mockGetInAppNotifications: vi.fn(),
  mockMarkInAppNotificationRead: vi.fn(),
  mockRespondToPaymentConfirmation: vi.fn(),
  mockToastError: vi.fn(),
  mockGetCurrentShop: vi.fn(),
}));

// The owner-gate reads the app's auth singleton (the same getCurrentShop()?.role
// idiom PoliciesTab/BusinessAutomationDefaults use) — default every existing
// case to an OWNER session, and flip it per-test for the staff pin.
vi.mock('../lib/auth', () => ({
  authService: { getCurrentShop: mockGetCurrentShop },
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: mockToastError },
}));

vi.mock('lucide-react', () => {
  const Icon = () => null;
  return { Bell: Icon, CheckCircle2: Icon, Loader2: Icon };
});

vi.mock('@/api/domains/notification', () => ({
  getInAppNotifications: mockGetInAppNotifications,
  markInAppNotificationRead: mockMarkInAppNotificationRead,
  respondToPaymentConfirmation: mockRespondToPaymentConfirmation,
}));

// NormalizedApiError is what the http client throws — NOT an Error instance.
// These pins prove the banner surfaces the SERVER message verbatim even for
// that shape (getErrorMessage path), which an `error instanceof Error` check
// would silently swallow.
const apiError = (message: string, code: string, statusCode = 409) =>
  Object.assign(new Error(''), { type: 'CONFLICT', statusCode, message, code, timestamp: new Date().toISOString() });

function notification(overrides: Partial<OwnerNotification> = {}): OwnerNotification {
  return {
    id: 'notification-1',
    shop_id: 'shop-1',
    type: 'escalation',
    customer_message: 'Customer needs help',
    customer_data: { title: 'Escalation' },
    status: 'pending',
    created_at: '2026-07-23T10:00:00.000Z',
    ...overrides,
  };
}

const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();

function claimNotification(overrides: Record<string, unknown> = {}): OwnerNotification {
  return notification({
    type: 'payment_confirmation',
    customer_message: 'Paid 250 via bKash, TrxID 9B7XQ2LM',
    customer_data: {
      orderId: 'order-9',
      transactionId: '9B7XQ2LM',
      claimAmount: 250,
      amountKind: 'full',
      walletNumber: '01711000000',
    },
    expires_at: future,
    ...overrides,
  } as Partial<OwnerNotification>);
}

async function openPanel() {
  render(<InAppNotificationCenter />);
  fireEvent.click(screen.getByLabelText('Notifications'));
  await waitFor(() => expect(mockGetInAppNotifications).toHaveBeenCalled());
}

describe('InAppNotificationCenter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCurrentShop.mockReturnValue({ id: 'shop-1', role: 'owner' });
    mockMarkInAppNotificationRead.mockResolvedValue(undefined);
    mockRespondToPaymentConfirmation.mockResolvedValue({ success: true, message: 'Payment approved successfully', orderId: 'order-9' });
  });

  it('marks an ordinary pending notification read', async () => {
    mockGetInAppNotifications.mockResolvedValue([notification()]);
    await openPanel();

    fireEvent.click(await screen.findByLabelText('Mark notification read'));

    await waitFor(() => expect(mockMarkInAppNotificationRead).toHaveBeenCalledWith('notification-1'));
    await waitFor(() => expect(screen.queryByLabelText('Mark notification read')).not.toBeInTheDocument());
  });

  it('never offers generic mark-read for a payment confirmation', async () => {
    mockGetInAppNotifications.mockResolvedValue([
      notification({ type: 'payment_confirmation', customer_data: { title: 'Payment', orderId: 'order-9' } }),
    ]);
    await openPanel();

    await screen.findByText('Payment');
    expect(screen.queryByLabelText('Mark notification read')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Review' })).toHaveAttribute(
      'href',
      '/orders?orderId=order-9',
    );
    expect(mockMarkInAppNotificationRead).not.toHaveBeenCalled();
  });

  it('surfaces a rejected mark-read instead of failing silently', async () => {
    mockGetInAppNotifications.mockResolvedValue([notification()]);
    mockMarkInAppNotificationRead.mockRejectedValue(new Error('Notification not found'));
    await openPanel();

    fireEvent.click(await screen.findByLabelText('Mark notification read'));

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith('Notification not found'));
    // Row stays pending and is resynced from the server rather than optimistically completed.
    expect(await screen.findByLabelText('Mark notification read')).toBeInTheDocument();
    expect(mockGetInAppNotifications).toHaveBeenCalledTimes(3);
  });

  // ── F2: merchant claim review via the real owner-action endpoint ────────────

  it('renders APPROVE/REJECT on a payment confirmation carrying the evidence context', async () => {
    mockGetInAppNotifications.mockResolvedValue([claimNotification()]);
    await openPanel();

    const row = await screen.findByTestId('approve-notification-1');
    expect(row).toBeEnabled();
    expect(screen.getByTestId('reject-notification-1')).toBeEnabled();
    // Evidence line: the number shown to the customer + the claim they filed.
    const evidence = screen.getByTestId('confirmation-evidence-notification-1');
    expect(evidence).toHaveTextContent('9B7XQ2LM');
    expect(evidence).toHaveTextContent('250');
    expect(evidence).toHaveTextContent('01711000000');
  });

  it('approve happy path: calls the owner-action endpoint and renders the server verdict verbatim', async () => {
    const completed = claimNotification({ status: 'completed', owner_response: 'approve' });
    mockGetInAppNotifications
      .mockResolvedValueOnce([claimNotification()]) // mount
      .mockResolvedValueOnce([claimNotification()]) // panel open
      .mockResolvedValueOnce([completed]);          // resync after server success
    mockRespondToPaymentConfirmation.mockResolvedValue({ success: true, message: 'Payment approved successfully', orderId: 'order-9' });
    await openPanel();

    fireEvent.click(await screen.findByTestId('approve-notification-1'));

    await waitFor(() => expect(mockRespondToPaymentConfirmation).toHaveBeenCalledWith('notification-1', 'approve'));
    const banner = await screen.findByTestId('confirmation-result-notification-1');
    // The server's own words, verbatim — not an app-invented "paid" claim.
    expect(banner).toHaveTextContent('Payment approved successfully');
    expect(banner).toHaveAttribute('role', 'status');
    // Resynced from the server: the row now reads Completed with no action buttons.
    await waitFor(() => expect(screen.getByTestId('completed-chip-notification-1')).toBeInTheDocument());
    expect(screen.queryByTestId('approve-notification-1')).not.toBeInTheDocument();
  });

  it('reject calls the same endpoint with reject and renders the server verdict VERBATIM', async () => {
    mockGetInAppNotifications.mockResolvedValue([claimNotification()]);
    // The real service builds `Payment ${response}d successfully` — for reject
    // that is the (misspelled) "Payment rejectd successfully". The client must
    // render the server's words unchanged; the i18n title carries correct copy.
    mockRespondToPaymentConfirmation.mockResolvedValue({ success: true, message: 'Payment rejectd successfully', orderId: 'order-9' });
    await openPanel();

    fireEvent.click(await screen.findByTestId('reject-notification-1'));

    await waitFor(() => expect(mockRespondToPaymentConfirmation).toHaveBeenCalledWith('notification-1', 'reject'));
    const banner = await screen.findByTestId('confirmation-result-notification-1');
    expect(banner).toHaveTextContent('Payment rejectd successfully');
    expect(banner).toHaveTextContent('Payment rejected'); // i18n title, server text untouched
  });

  it('surfaces a 409 refusal VERBATIM (CLAIM_AMOUNT_BELOW_ORDER_TOTAL) and resyncs the row', async () => {
    // Message is the REAL server copy from owner-notification.service.js
    // (F1/BLOCK guard, landed 2026-11-26); the component renders whatever the
    // server says for ANY non-2xx — no status-code special-casing client-side.
    mockGetInAppNotifications.mockResolvedValue([claimNotification()]);
    mockRespondToPaymentConfirmation.mockRejectedValue(apiError(
      'Claimed payment is below the order total — approving would settle a partial payment as fully paid. Collect the remaining amount first (a new claim) or reject.',
      'CLAIM_AMOUNT_BELOW_ORDER_TOTAL',
      409,
    ));
    await openPanel();

    fireEvent.click(await screen.findByTestId('approve-notification-1'));

    const banner = await screen.findByTestId('confirmation-result-notification-1');
    expect(banner).toHaveAttribute('role', 'alert');
    expect(banner).toHaveTextContent('Claimed payment is below the order total');
    expect(banner).toHaveTextContent('Collect the remaining amount first (a new claim) or reject.');
    // Nothing was settled — the refusal is stated, not swallowed, and the rows
    // are resynced from the server afterwards (mount, open, error-resync).
    expect(mockGetInAppNotifications).toHaveBeenCalledTimes(3);
  });

  it('surfaces an already-completed refusal verbatim without touching the row locally', async () => {
    mockGetInAppNotifications.mockResolvedValue([claimNotification()]);
    mockRespondToPaymentConfirmation.mockRejectedValue(apiError('Payment confirmation has already been completed', 'INTERNAL_ERROR', 409));
    await openPanel();

    fireEvent.click(await screen.findByTestId('approve-notification-1'));

    const banner = await screen.findByTestId('confirmation-result-notification-1');
    expect(banner).toHaveTextContent('Payment confirmation has already been completed');
  });

  it('shows a loading state while the action is in flight and blocks double-submit', async () => {
    let resolveAction: (value: { success: boolean; message: string }) => void = () => {};
    mockRespondToPaymentConfirmation.mockReturnValue(new Promise((resolve) => { resolveAction = resolve; }));
    mockGetInAppNotifications.mockResolvedValue([claimNotification()]);
    await openPanel();

    const approve = await screen.findByTestId('approve-notification-1');
    const reject = screen.getByTestId('reject-notification-1');
    fireEvent.click(approve);
    await waitFor(() => expect(mockRespondToPaymentConfirmation).toHaveBeenCalledWith('notification-1', 'approve'));
    expect(approve).toBeDisabled();
    expect(reject).toBeDisabled();
    // Clicking again while pending must not fire a second owner action.
    fireEvent.click(reject);
    expect(mockRespondToPaymentConfirmation).toHaveBeenCalledTimes(1);

    resolveAction({ success: true, message: 'Payment approved successfully' });
    await waitFor(() => expect(screen.getByTestId('confirmation-result-notification-1')).toBeInTheDocument());
  });

  // ── F3/D-4: expired surfacing stays honest AND actionable ──────────────────

  it('shows the Expired chip + copy for a lapsed deadline yet keeps both buttons functional (D-4)', async () => {
    mockGetInAppNotifications.mockResolvedValue([claimNotification({ expires_at: past })]);
    await openPanel();

    expect(await screen.findByTestId('expired-chip-notification-1')).toHaveTextContent('Expired');
    expect(screen.getByTestId('expired-copy-notification-1')).toHaveTextContent('Nothing was changed automatically');
    const approve = screen.getByTestId('approve-notification-1');
    const reject = screen.getByTestId('reject-notification-1');
    expect(approve).toBeEnabled();
    expect(reject).toBeEnabled();

    // And they still drive the real endpoint for an expired row.
    fireEvent.click(approve);
    await waitFor(() => expect(mockRespondToPaymentConfirmation).toHaveBeenCalledWith('notification-1', 'approve'));
    await waitFor(() => expect(screen.getByTestId('confirmation-result-notification-1')).toHaveTextContent('Payment approved successfully'));
  });

  it('renders server-reported status "expired" honestly, buttons still enabled', async () => {
    mockGetInAppNotifications.mockResolvedValue([claimNotification({ status: 'expired', expires_at: past })]);
    await openPanel();

    expect(await screen.findByTestId('expired-chip-notification-1')).toHaveTextContent('Expired');
    expect(screen.getByTestId('approve-notification-1')).toBeEnabled();
    expect(screen.getByTestId('reject-notification-1')).toBeEnabled();
  });

  // ── F3 (A8 round-2): the action endpoint is owner-only (403 for staff) ──────

  it('shows a non-owner NO live buttons — only the claim row plus the owner-only note', async () => {
    mockGetCurrentShop.mockReturnValue({ id: 'shop-1', role: 'staff' });
    mockGetInAppNotifications.mockResolvedValue([claimNotification()]);
    await openPanel();

    // The row itself stays readable for staff (evidence + link to review)…
    const evidence = await screen.findByTestId('confirmation-evidence-notification-1');
    expect(evidence).toHaveTextContent('9B7XQ2LM');
    expect(evidence).toHaveTextContent('01711000000');
    // …but the always-403 affordance is not rendered to them at all…
    expect(screen.queryByTestId('approve-notification-1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('reject-notification-1')).not.toBeInTheDocument();
    // …with the app's owner-only reason stated instead (ownerOnly copy family).
    expect(screen.getByTestId('claim-owner-only-notification-1')).toHaveTextContent(
      'Only the shop owner can approve or reject payment confirmations',
    );
    expect(mockRespondToPaymentConfirmation).not.toHaveBeenCalled();
  });

  it('keeps approve/reject live for the owner (the note never renders)', async () => {
    mockGetInAppNotifications.mockResolvedValue([claimNotification()]);
    await openPanel();

    expect(await screen.findByTestId('approve-notification-1')).toBeEnabled();
    expect(screen.getByTestId('reject-notification-1')).toBeEnabled();
    expect(screen.queryByTestId('claim-owner-only-notification-1')).not.toBeInTheDocument();
  });
});
