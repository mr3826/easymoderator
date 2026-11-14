import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ChannelsOverview from '@/app/components/channels/ChannelsOverview';
import type { MetaChannel } from '@/api/domains/meta-channels';
import type { ChannelAutomationWarning } from '@/api/types/conversation';

type ListedChannel = MetaChannel & { warnings?: ChannelAutomationWarning[] };

const metaApi = vi.hoisted(() => ({
  listMetaChannels: vi.fn(),
  getMetaChannelSettings: vi.fn(),
}));
const shopApi = vi.hoisted(() => ({
  getShopAISettings: vi.fn(),
  emergencyStop: vi.fn(),
  emergencyResume: vi.fn(),
}));
const auth = vi.hoisted(() => ({ getCurrentShop: vi.fn() }));

vi.mock('@/api/domains/meta-channels', () => metaApi);
vi.mock('@/api/domains/shop', () => shopApi);
vi.mock('@/app/lib/auth', () => ({ authService: auth }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock('@/app/components/channels/useMetaChannelConnection', () => ({
  useMetaChannelConnection: () => ({
    channels: [],
    isLoading: false,
    loadError: null,
    fetchChannels: vi.fn(),
    activeOAuth: null,
    availablePages: [],
    selectedPageIds: new Set(),
    isConnectingPage: false,
    handleConnect: vi.fn(),
    handleCancelOAuth: vi.fn(),
    handleRetryOAuthAssetLookup: vi.fn(),
    togglePageSelection: vi.fn(),
    handleConnectPages: vi.fn(),
    testingId: null,
    disconnectingId: null,
    confirmDisconnect: null,
    setConfirmDisconnect: vi.fn(),
    handleTestPipeline: vi.fn(),
    handleDisconnect: vi.fn(),
    handleReconnect: vi.fn(),
    consentByChannelId: {},
    expandedConsentChannelId: null,
    loadingConsentId: null,
    handleToggleConsent: vi.fn(),
    savingLabelId: null,
    handleSavePurposeLabel: vi.fn(),
    permissionsExpanded: false,
    setPermissionsExpanded: vi.fn(),
  }),
}));

const baseChannel = (id: string, over: Partial<ListedChannel> = {}): ListedChannel => ({
  id,
  shopId: 'shop-1',
  platform: 'facebook',
  metaAssetId: `page-${id}`,
  displayName: `Page ${id}`,
  pictureUrl: null,
  status: 'CONNECTED',
  isHealthy: true,
  needsReconnect: false,
  lastError: null,
  tokenExpiresAt: null,
  tokenLastRefreshedAt: null,
  webhookSubscribedFields: ['messages'],
  webhookLastVerifiedAt: new Date().toISOString(),
  connectedAt: null,
  disconnectedAt: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  purposeLabel: null,
  effective_mode: 'MANUAL',
  mode_source: 'business_default',
  override_count: 0,
  emergency_stop: { active: false, at: null, by: null, source: null, prior_mode: null },
  billing_ai_active: true,
  ...over,
});

const renderOverview = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ChannelsOverview />
      </MemoryRouter>
    </QueryClientProvider>,
  );
};

describe('ChannelsOverview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.getCurrentShop.mockReturnValue({ role: 'owner' });
    shopApi.getShopAISettings.mockResolvedValue({
      automation_mode: 'AUTO',
      emergency_stop: { active: false, at: null, by: null, source: null, prior_mode: null },
    });
  });

  it('shows the Inherited / Overridden / Clamped / STOPPED / PAUSED-billing badges', async () => {
    metaApi.listMetaChannels.mockResolvedValue([
      baseChannel('inherit'),
      baseChannel('override', { mode_source: 'channel_override', override_count: 1 }),
      baseChannel('clamped', { warnings: ['override_clamped_by_business'] }),
      baseChannel('stopped', {
        emergency_stop: { active: true, at: null, by: null, source: 'merchant', prior_mode: 'AUTO' },
      }),
      baseChannel('billing', { billing_ai_active: false }),
    ]);

    renderOverview();

    await waitFor(() => {
      expect(screen.getByTestId('channel-badge-inherit')).toHaveTextContent('Inherited');
      expect(screen.getByTestId('channel-badge-override')).toHaveTextContent('Overridden');
      expect(screen.getByTestId('channel-badge-clamped')).toHaveTextContent('Clamped');
      expect(screen.getByTestId('channel-badge-stopped')).toHaveTextContent('Stopped');
      expect(screen.getByTestId('channel-badge-billing')).toHaveTextContent('Paused');
    });
    // Warnings come from the list payload; no per-channel settings GET.
    expect(screen.getByTestId('channel-card-clamped')).toHaveTextContent(
      'A stored channel override is clamped by the business default.',
    );
    expect(metaApi.getMetaChannelSettings).not.toHaveBeenCalled();
  });

  it('renders an empty state with a connect call to action', async () => {
    metaApi.listMetaChannels.mockResolvedValue([]);
    renderOverview();

    expect(await screen.findByText('No channels connected')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Connect a Page/i })).toBeInTheDocument();
  });

  it('renders an error with retry that refetches', async () => {
    metaApi.listMetaChannels.mockRejectedValueOnce(new Error('boom'));
    renderOverview();

    expect(await screen.findByText(/Channels could not load/i)).toBeInTheDocument();
    metaApi.listMetaChannels.mockResolvedValue([baseChannel('c1')]);
    screen.getByRole('button', { name: /Retry/i }).click();
    await waitFor(() => expect(metaApi.listMetaChannels).toHaveBeenCalledTimes(2));
  });

  it('links each card to its channel detail', async () => {
    metaApi.listMetaChannels.mockResolvedValue([baseChannel('c1')]);
    renderOverview();

    const link = await screen.findByRole('link', { name: /Manage/i });
    expect(link).toHaveAttribute('href', '/manage-shop/channels/c1');
  });
});