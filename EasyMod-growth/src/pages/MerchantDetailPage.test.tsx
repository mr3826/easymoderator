import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  adminApi,
  ApiError,
  merchantsApi,
  type Merchant360,
  type MerchantInsight,
} from '@/api/client';
import { usePermission } from '@/auth/usePermission';
import { MerchantDetailPage } from './MerchantDetailPage';

vi.mock('@/auth/usePermission', () => ({
  usePermission: vi.fn(),
}));

const reportApiError = vi.fn(() => false);
vi.mock('@/auth/GrowthAuthProvider', () => ({
  useGrowthAuth: () => ({ reportApiError }),
}));

const permissionMock = vi.mocked(usePermission);

const SHOP_ID = 'shop-1';

function makeMerchant360(): Merchant360 {
  return {
    overview: {
      shop: {
        id: SHOP_ID,
        shopName: 'Luna Tech',
        uniqueCode: 'LUNA1',
        isActive: true,
        timezone: 'Africa/Accra',
        createdAt: '2026-05-02T09:00:00.000Z',
      },
      owner: { id: 'user-1', name: 'Maya Osei', email: 'owner@lunatech.test', phone: '0170000000' },
      subscription: { planName: 'Growth', status: 'trialing', currentPeriodEnd: '2026-10-01T00:00:00.000Z' },
      usage: {
        conversationsUsed: 120,
        conversationsLimit: 500,
        effectiveConversationLimit: 620,
        topupBalance: 50,
      },
      onboarding: { completed: true },
      activation: { activatedAt: '2026-05-09T12:00:00.000Z', firstConversationId: null },
      ai: { configured: true, automationMode: 'auto', draftModeEnabled: false },
      lastActivityAt: '2026-09-10T08:30:00.000Z',
    },
    growth: {
      linkedProspects: [{
        prospectId: 'prospect-1',
        businessName: 'North Star Retail',
        status: 'converted',
        source: 'manual_entry',
        ownerUserId: null,
        linkedAt: '2026-05-08T10:00:00.000Z',
      }],
    },
    subscription: {
      plan: { code: 'growth', name: 'Growth', cycle: 'monthly', model: 'hybrid' },
      status: 'trialing',
      period: {
        start: '2026-09-01T00:00:00.000Z',
        end: '2026-10-01T00:00:00.000Z',
        nextBillingDate: '2026-10-01T00:00:00.000Z',
      },
      usage: {
        conversationsUsed: 120,
        conversationsLimit: 500,
        effectiveLimit: 620,
        topupBalance: 50,
      },
      invoices: [{
        id: 'inv-1',
        invoiceNumber: 'INV-1001',
        type: 'subscription',
        amount: 29,
        status: 'paid',
        dueDate: '2026-09-10T00:00:00.000Z',
        paidAt: '2026-09-05T00:00:00.000Z',
        createdAt: '2026-09-01T00:00:00.000Z',
      }],
      outstandingAmount: 0,
    },
    facebook: {
      channels: [{
        id: 'channel-1',
        displayName: 'Luna Facebook Page',
        platform: 'facebook',
        status: 'TOKEN_EXPIRED',
        tokenExpiresAt: '2026-09-01T00:00:00.000Z',
        webhookLastVerifiedAt: '2026-08-20T00:00:00.000Z',
        webhookSubscribedFields: ['messages'],
        lastError: 'Token expired during webhook replay '.repeat(6),
        connectedAt: '2026-05-03T00:00:00.000Z',
      }],
    },
    notes: [{
      id: 'note-1',
      targetType: 'shop',
      targetId: SHOP_ID,
      author: { userId: 'user-9', name: 'Jordan Mensah' },
      body: 'Onboarding incident reviewed with merchant.',
      createdAt: '2026-09-02T10:00:00.000Z',
      updatedAt: '2026-09-02T10:00:00.000Z',
    }],
  };
}

function makeInsight(): MerchantInsight {
  return {
    shopId: SHOP_ID,
    merchantName: 'Luna Tech',
    signupDate: '2026-05-02T09:00:00.000Z',
    planName: 'Growth',
    subscriptionStatus: 'trialing',
    activation: { activatedAt: '2026-05-09T12:00:00.000Z', state: 'activated' },
    facebook: { connected: true },
    linkedProspects: [{
      prospectId: 'prospect-1',
      businessName: 'North Star Retail',
      status: 'converted',
      source: 'manual_entry',
      createdAt: '2026-04-20T00:00:00.000Z',
    }],
  };
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={[`/merchants/${SHOP_ID}`]}>
      <Routes>
        <Route path="/merchants/:shopId" element={<MerchantDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('MerchantDetailPage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    sessionStorage.clear();
  });

  it('renders the full 360 view with mutation controls for Super Admins', async () => {
    permissionMock.mockReturnValue(true);
    vi.spyOn(merchantsApi, 'detail').mockResolvedValue(makeMerchant360());

    renderPage();

    expect(await screen.findByRole('heading', { name: 'Luna Tech' })).toBeInTheDocument();
    expect(screen.getByText('owner@lunatech.test')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Meta / Facebook channels' })).toBeInTheDocument();
    expect(screen.getByText('Luna Facebook Page')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Suspend merchant' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Grant credits' })).toBeInTheDocument();
    expect(screen.getByText('Onboarding incident reviewed with merchant.')).toBeInTheDocument();
    expect(screen.getByText(/By Jordan Mensah/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'North Star Retail' })).toHaveAttribute('href', '/prospects/prospect-1');
  });

  it('renders the single MERCHANT tier, never a retired plan name', async () => {
    permissionMock.mockReturnValue(true);
    vi.spyOn(merchantsApi, 'detail').mockResolvedValue(makeMerchant360());

    renderPage();

    expect(await screen.findByRole('heading', { name: 'Luna Tech' })).toBeInTheDocument();
    expect(screen.getAllByText('MERCHANT').length).toBeGreaterThan(0);
    expect(screen.queryByText('Growth')).not.toBeInTheDocument();
  });

  it('requires a reason and second confirm click before suspending a merchant', async () => {
    const user = userEvent.setup();
    permissionMock.mockReturnValue(true);
    const detail = vi.spyOn(merchantsApi, 'detail').mockResolvedValue(makeMerchant360());
    const setStatus = vi.spyOn(adminApi, 'setMerchantStatus').mockResolvedValue({
      before: { isActive: true },
      after: { isActive: false },
    });

    renderPage();
    await screen.findByRole('button', { name: 'Suspend merchant' });

    await user.click(screen.getByRole('button', { name: 'Suspend merchant' }));
    expect(setStatus).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('A reason is required to suspend this merchant.');

    await user.type(screen.getByLabelText('Reason for status change (required, max 300 chars)'), 'Fraud investigation FR-118');
    await user.click(screen.getByRole('button', { name: 'Suspend merchant' }));
    expect(setStatus).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Confirm suspend' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Confirm suspend' }));
    await waitFor(() => expect(setStatus).toHaveBeenCalledWith(SHOP_ID, {
      active: false,
      reason: 'Fraud investigation FR-118',
    }));
    expect(await screen.findByText('Merchant suspended.')).toBeInTheDocument();
    expect(screen.getByText('Before')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View audit trail' })).toHaveAttribute('href', '/audit');
    await waitFor(() => expect(detail).toHaveBeenCalledTimes(2));
  });

  it('reuses a pending credit key after the page is reloaded', async () => {
    const user = userEvent.setup();
    permissionMock.mockReturnValue(true);
    vi.spyOn(merchantsApi, 'detail').mockResolvedValue(makeMerchant360());
    const grantCredits = vi.spyOn(adminApi, 'grantMerchantCredits').mockResolvedValue({
      before: { topupBalance: 50 },
      after: { topupBalance: 60 },
    });

    const firstRender = renderPage();
    await screen.findByRole('button', { name: 'Grant credits' });
    fireEvent.change(screen.getByLabelText('Amount (whole number, 1 to 100,000)'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('Reason for the credit grant (required, max 300 chars)'), { target: { value: 'Recovery credit' } });
    await user.click(screen.getByRole('button', { name: 'Grant credits' }));
    const pending = JSON.parse(sessionStorage.getItem(`growth-os:pending-credit-operation:${SHOP_ID}`) || '{}');
    expect(pending.key).toEqual(expect.any(String));
    firstRender.unmount();

    renderPage();
    await screen.findByRole('button', { name: 'Grant credits' });
    fireEvent.change(screen.getByLabelText('Amount (whole number, 1 to 100,000)'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('Reason for the credit grant (required, max 300 chars)'), { target: { value: 'Recovery credit' } });
    await user.click(screen.getByRole('button', { name: 'Grant credits' }));
    await user.click(screen.getByRole('button', { name: 'Confirm grant credits' }));

    await waitFor(() => expect(grantCredits).toHaveBeenCalledWith(SHOP_ID, {
      amount: 10,
      reason: 'Recovery credit',
    }, pending.key));
  });

  it('renders the masked insight view for growth users with no mutation controls at all', async () => {
    permissionMock.mockReturnValue(false);
    vi.spyOn(merchantsApi, 'detail').mockResolvedValue(makeInsight());

    renderPage();

    expect(await screen.findByText(/Limited, masked merchant context for growth work/)).toBeInTheDocument();
    expect(screen.getByText('Facebook connected')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'North Star Retail' })).toHaveAttribute('href', '/prospects/prospect-1');
    expect(screen.queryByText('owner@lunatech.test')).not.toBeInTheDocument();
    expect(screen.queryByText('Owner email')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /suspend|reactivate|grant credits|disable ai/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Administrative actions' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Internal notes' })).not.toBeInTheDocument();
    expect(screen.queryByText('Effective limit')).not.toBeInTheDocument();
  });

  it('shows the server error and retry when the merchant detail cannot load', async () => {
    permissionMock.mockReturnValue(true);
    vi.spyOn(merchantsApi, 'detail').mockRejectedValue(new ApiError('Merchant record not found.', 404));

    renderPage();

    expect(await screen.findByRole('heading', { name: 'Merchant unavailable' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Merchant record not found.');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});
