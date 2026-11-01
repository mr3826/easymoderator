import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AdminShopDetail from '../AdminShopDetail';

const mocks = vi.hoisted(() => ({
  getShop: vi.fn(),
  getShopChannels: vi.fn(),
  getShopBilling: vi.fn(),
  emergencyAiOff: vi.fn(),
  markReconnect: vi.fn(),
  addCredits: vi.fn(),
  setStatus: vi.fn(),
  getPilotFeatures: vi.fn(),
  setPilotFeatures: vi.fn(),
  useIsPlatformAdmin: vi.fn(),
}));

vi.mock('@/api/domains/admin', () => ({
  adminApi: {
    getShop: mocks.getShop,
    getShopChannels: mocks.getShopChannels,
    getShopBilling: mocks.getShopBilling,
    emergencyAiOff: mocks.emergencyAiOff,
    markReconnect: mocks.markReconnect,
    addCredits: mocks.addCredits,
    setStatus: mocks.setStatus,
    getPilotFeatures: mocks.getPilotFeatures,
    setPilotFeatures: mocks.setPilotFeatures,
  },
}));

const pilotFlags = (overrides = {}) => ({
  shop_id: 'shop-1',
  customer_intelligence: false,
  ads_studio: false,
  storefront: false,
  ai_reply_shadow_meter: false,
  ai_reply_shadow_meter_enabled_at: null,
  order_confidence_mode: 'off',
  order_confidence_config: { high_value_cod_threshold: 10000, address_min_length: 15 },
  updated_by: null,
  updated_at: null,
  ...overrides,
});

vi.mock('@/shared/lib/auth/useIsPlatformAdmin', () => ({
  useIsPlatformAdmin: mocks.useIsPlatformAdmin,
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useParams: () => ({ shopId: 'shop-1' }),
  };
});

describe('AdminShopDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getShop.mockResolvedValue({
      shop: { shopName: 'Demo Shop' },
      owner: { email: 'owner@example.com' },
       subscription: { planName: 'Shuru', status: 'active' },
      usage: { conversationsUsed: 1, conversationsLimit: 100 },
      onboarding: { completed: true },
    });
    mocks.getShopChannels.mockResolvedValue([{ id: 'ch-1', displayName: 'Main Page', platform: 'facebook', status: 'CONNECTED' }]);
    mocks.getShopBilling.mockResolvedValue({
       planName: 'Shuru',
      status: 'active',
      conversationsUsed: 1,
      conversationsLimit: 100,
      topupBalance: 0,
    });
    mocks.emergencyAiOff.mockResolvedValue({});
    mocks.markReconnect.mockResolvedValue({});
    mocks.addCredits.mockResolvedValue({});
    mocks.setStatus.mockResolvedValue({});
    mocks.getPilotFeatures.mockResolvedValue(pilotFlags());
    mocks.setPilotFeatures.mockImplementation(async (_id: string, body: Record<string, unknown>) => pilotFlags(body));
  });

  it('shows pilot controls read-only to SUPPORT_ADMIN', async () => {
    mocks.useIsPlatformAdmin.mockReturnValue({ loading: false, role: 'SUPPORT_ADMIN' });
    render(<AdminShopDetail />);
    fireEvent.click(screen.getByRole('button', { name: 'Orders & Courier' }));
    const section = await screen.findByTestId('admin-pilot-features');
    await waitFor(() => expect(section.querySelector('select')).toBeDisabled());
    expect(section.querySelector('input[type="checkbox"]')).toBeDisabled();
  });

  it('lets SUPER_ADMIN move Order Confidence to trial mode', async () => {
    mocks.useIsPlatformAdmin.mockReturnValue({ loading: false, role: 'SUPER_ADMIN' });
    render(<AdminShopDetail />);
    fireEvent.click(screen.getByRole('button', { name: 'Orders & Courier' }));
    const section = await screen.findByTestId('admin-pilot-features');
    await waitFor(() => expect(section.querySelector('select')).toBeEnabled());
    fireEvent.change(section.querySelector('select')!, { target: { value: 'shadow' } });
    await waitFor(() => expect(mocks.setPilotFeatures).toHaveBeenCalledWith('shop-1', { order_confidence_mode: 'shadow' }));
  });

  it('lets SUPER_ADMIN approve Ads Studio while keeping platform authorization explicit', async () => {
    mocks.useIsPlatformAdmin.mockReturnValue({ loading: false, role: 'SUPER_ADMIN' });
    render(<AdminShopDetail />);
    fireEvent.click(screen.getByRole('button', { name: 'Orders & Courier' }));
    const section = await screen.findByTestId('admin-founder-pilot-flags');
    const adsStudio = within(section).getByLabelText(/EasyModerator Ads Studio/);

    expect(adsStudio).not.toBeChecked();
    fireEvent.click(adsStudio);

    await waitFor(() => expect(mocks.setPilotFeatures).toHaveBeenCalledWith('shop-1', { ads_studio: true }));
  });

  it('keeps all founder pilot approval gates read-only to SUPPORT_ADMIN', async () => {
    mocks.useIsPlatformAdmin.mockReturnValue({ loading: false, role: 'SUPPORT_ADMIN' });
    render(<AdminShopDetail />);
    fireEvent.click(screen.getByRole('button', { name: 'Orders & Courier' }));
    const section = await screen.findByTestId('admin-founder-pilot-flags');
    await waitFor(() => expect(within(section).getAllByRole('checkbox')).toHaveLength(3));
    expect(within(section).getAllByRole('checkbox').every((checkbox) => (checkbox as HTMLInputElement).disabled)).toBe(true);
  });

  it('disables mutation controls for SUPPORT_ADMIN users', async () => {
    mocks.useIsPlatformAdmin.mockReturnValue({ loading: false, role: 'SUPPORT_ADMIN' });

    render(<AdminShopDetail />);

    fireEvent.click(screen.getByRole('button', { name: 'Channels' }));
    expect(await screen.findByRole('button', { name: 'Emergency: stop AI' })).toBeDisabled();
    expect(await screen.findByRole('button', { name: 'Mark reconnect' })).toBeDisabled();
    expect(screen.getByText('SUPER_ADMIN required for channel actions.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Billing' }));
    expect(screen.getByRole('button', { name: 'Add 50 credits' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Suspend/ })).toBeDisabled();
    expect(screen.getByText('SUPER_ADMIN required for billing actions.')).toBeInTheDocument();
  });

  it('allows SUPER_ADMIN users to trigger emergency AI stop', async () => {
    mocks.useIsPlatformAdmin.mockReturnValue({ loading: false, role: 'SUPER_ADMIN' });
    Object.defineProperty(window, 'confirm', {
      value: vi.fn(() => true),
      configurable: true,
    });

    render(<AdminShopDetail />);

    fireEvent.click(screen.getByRole('button', { name: 'Channels' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Emergency: stop AI' }));

    await waitFor(() => expect(mocks.emergencyAiOff).toHaveBeenCalledWith('shop-1'));
  });
});
