import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ChannelDetail from '@/app/components/channels/ChannelDetail';
import type { MetaChannel } from '@/api/domains/meta-channels';

const metaApi = vi.hoisted(() => ({
  listMetaChannels: vi.fn(),
  getMetaChannelSettings: vi.fn(),
  updateMetaChannelSettings: vi.fn(),
  updateMetaChannelPurposeLabel: vi.fn(),
}));
const shopApi = vi.hoisted(() => ({ getShopAISettings: vi.fn() }));
const auth = vi.hoisted(() => ({ getCurrentShop: vi.fn() }));

vi.mock('@/api/domains/meta-channels', () => ({
  ...metaApi,
  channelQueryKeys: {
    list: () => ['channels'],
    settings: (channelId: string) => ['channel-settings', channelId],
  },
}));
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

const channel: MetaChannel = {
  id: 'c1',
  shopId: 'shop-1',
  platform: 'facebook',
  metaAssetId: 'page-1',
  displayName: 'Page One',
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
  effective_mode: 'DRAFT',
  mode_source: 'channel_override',
  override_count: 1,
  billing_ai_active: true,
};

const makeSettings = (over: Record<string, unknown> = {}) => ({
  confidenceThresholdSend: 0.75,
  confidenceThresholdSuggest: 0.5,
  businessHours: null,
  allowOrderCreation: true,
  purposeLabel: null,
  overrides: { automation_mode: 'DRAFT' },
  effective: {
    automation_mode: 'DRAFT',
    confidence_threshold: 80,
    greeting: { enabled: false, custom_text: '' },
    business_hours: null,
    allow_order_creation: true,
    purpose_label: null,
  },
  mode_source: 'channel_override',
  warnings: [],
  emergency_stop: { active: false, at: null, by: null, source: null, prior_mode: null },
  billing_ai_active: true,
  deprecated_fields: ['confidenceThresholdSend', 'confidenceThresholdSuggest'],
  ...over,
});

const renderDetail = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/manage-shop/channels/c1']}>
        <Routes>
          <Route path="/manage-shop/channels/:channelId" element={<ChannelDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
};

describe('ChannelDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.getCurrentShop.mockReturnValue({ role: 'owner' });
    metaApi.listMetaChannels.mockResolvedValue([channel]);
    metaApi.getMetaChannelSettings.mockResolvedValue(makeSettings());
    metaApi.updateMetaChannelSettings.mockImplementation((_id: string, patch: Record<string, unknown>) =>
      Promise.resolve(
        makeSettings(
          patch?.overrides && 'automation_mode' in (patch.overrides as object)
            ? (patch.overrides as Record<string, unknown>).automation_mode === null
              ? { overrides: {}, mode_source: 'business_default', effective: { ...makeSettings().effective, automation_mode: 'DRAFT' } }
              : { overrides: patch.overrides }
            : {},
        ),
      ),
    );
    metaApi.updateMetaChannelPurposeLabel.mockResolvedValue(channel);
    shopApi.getShopAISettings.mockResolvedValue({
      automation_mode: 'DRAFT',
      primary_language: 'bn',
      closing: { enabled: true, custom_text: 'ধন্যবাদ' },
      max_auto_order_value: 5000,
      emergency_stop: { active: false, at: null, by: null, source: null, prior_mode: null },
    });
  });

  it('shows the effective mode (aria-live) and its source', async () => {
    renderDetail();
    const effective = await screen.findByTestId('channel-effective-mode');
    expect(effective).toHaveAttribute('aria-live', 'polite');
    expect(effective).toHaveTextContent('Drafts for review');
    expect(screen.getByTestId('channel-mode-source')).toHaveTextContent('Channel override');
  });

  it('offers only narrow-only modes (never AUTO under a DRAFT ceiling)', async () => {
    renderDetail();
    await screen.findByTestId('channel-mode-override');

    expect(screen.getByRole('radio', { name: 'Drafts for review' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Manual replies only' })).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: 'Automatic replies' })).not.toBeInTheDocument();
  });

  it('saves a narrower override', async () => {
    renderDetail();
    await screen.findByTestId('channel-mode-override');
    fireEvent.click(screen.getByRole('radio', { name: 'Manual replies only' }));

    await waitFor(() =>
      expect(metaApi.updateMetaChannelSettings).toHaveBeenCalledWith('c1', {
        overrides: { automation_mode: 'MANUAL' },
      }),
    );
  });

  it('reverts to inherit with a null PATCH and returns focus to the section', async () => {
    renderDetail();
    const revert = await screen.findByTestId('channel-override-revert-automation_mode');
    fireEvent.click(revert);

    await waitFor(() =>
      expect(metaApi.updateMetaChannelSettings).toHaveBeenCalledWith('c1', {
        overrides: { automation_mode: null },
      }),
    );
    await waitFor(() => expect(document.activeElement).toHaveAttribute('tabindex', '-1'));
  });

  it('is read-only for a manager with an accurate reason', async () => {
    auth.getCurrentShop.mockReturnValue({ role: 'manager' });
    renderDetail();

    await screen.findByTestId('channel-effective-mode');
    expect(screen.queryByTestId('channel-mode-override')).not.toBeInTheDocument();
    expect(screen.getAllByText(/Only the shop owner can change channel automation/i).length).toBeGreaterThan(0);
  });

  it('never renders the legacy dead thresholds as live controls', async () => {
    renderDetail();
    await screen.findByTestId('channel-effective-mode');

    fireEvent.click(screen.getByRole('tab', { name: 'AI behavior' }));
    expect(await screen.findByText('Confidence threshold')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('0.75')).not.toBeInTheDocument();
    expect(screen.queryByText(/confidenceThresholdSend/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Advanced' }));
    expect(await screen.findByText('Deprecated settings')).toBeInTheDocument();
    expect(screen.getByText('confidenceThresholdSend')).toBeInTheDocument();
  });

  it('saves business hours in the canonical day-slot shape with overnight ranges', async () => {
    renderDetail();
    await screen.findByTestId('channel-effective-mode');
    fireEvent.click(screen.getByRole('tab', { name: 'Operating rules' }));

    const mondayLabel = screen.getByText('Mon').closest('label');
    fireEvent.click(mondayLabel!.querySelector('input')!);
    const timeInputs = document.querySelectorAll('input[type="time"]');
    fireEvent.change(timeInputs[1], { target: { value: '02:00' } });
    fireEvent.click(screen.getByTestId('channel-hours-save'));

    await waitFor(() => {
      const patch = metaApi.updateMetaChannelSettings.mock.calls[
        metaApi.updateMetaChannelSettings.mock.calls.length - 1
      ]?.[1] as { businessHours: Record<string, { open: string; close: string }> };
      expect(patch.businessHours.mon).toEqual({ open: '09:00', close: '02:00' });
    });
  });

  it('renders every stored slot, adds a slot, and saves the canonical array shape', async () => {
    metaApi.getMetaChannelSettings.mockResolvedValue(
      makeSettings({
        businessHours: {
          timezone: 'Asia/Dhaka',
          mon: [
            { open: '09:00', close: '12:00' },
            { open: '14:00', close: '18:00' },
          ],
        },
      }),
    );
    renderDetail();
    await screen.findByTestId('channel-effective-mode');
    fireEvent.click(screen.getByRole('tab', { name: 'Operating rules' }));

    expect(screen.getByLabelText('Opening time for Mon, slot 1')).toHaveValue('09:00');
    expect(screen.getByLabelText('Opening time for Mon, slot 2')).toHaveValue('14:00');

    fireEvent.click(screen.getByRole('button', { name: 'Add time slot for Mon' }));
    fireEvent.change(screen.getByLabelText('Opening time for Mon, slot 3'), {
      target: { value: '19:00' },
    });
    fireEvent.change(screen.getByLabelText('Closing time for Mon, slot 3'), {
      target: { value: '21:00' },
    });
    fireEvent.click(screen.getByTestId('channel-hours-save'));

    await waitFor(() => {
      const patch = metaApi.updateMetaChannelSettings.mock.calls[
        metaApi.updateMetaChannelSettings.mock.calls.length - 1
      ]?.[1] as { businessHours: Record<string, unknown> };
      expect(patch.businessHours).toEqual({
        timezone: 'Asia/Dhaka',
        mon: [
          { open: '09:00', close: '12:00' },
          { open: '14:00', close: '18:00' },
          { open: '19:00', close: '21:00' },
        ],
      });
    });
  });

  it('removes a slot with the accessible remove control', async () => {
    metaApi.getMetaChannelSettings.mockResolvedValue(
      makeSettings({
        businessHours: {
          mon: [
            { open: '09:00', close: '12:00' },
            { open: '14:00', close: '18:00' },
          ],
        },
      }),
    );
    renderDetail();
    await screen.findByTestId('channel-effective-mode');
    fireEvent.click(screen.getByRole('tab', { name: 'Operating rules' }));

    fireEvent.click(screen.getByRole('button', { name: 'Remove time slot 2 for Mon' }));
    expect(screen.queryByLabelText('Opening time for Mon, slot 2')).not.toBeInTheDocument();
    // The last remaining slot cannot be removed (an empty day is "closed").
    expect(screen.getByRole('button', { name: 'Remove time slot 1 for Mon' })).toBeDisabled();

    fireEvent.click(screen.getByTestId('channel-hours-save'));

    await waitFor(() => {
      const patch = metaApi.updateMetaChannelSettings.mock.calls[
        metaApi.updateMetaChannelSettings.mock.calls.length - 1
      ]?.[1] as { businessHours: Record<string, unknown> };
      expect(patch.businessHours).toEqual({
        mon: { open: '09:00', close: '12:00' },
      });
    });
  });

  it('warns about a closed-hours save and requires explicit confirmation', async () => {
    renderDetail();
    await screen.findByTestId('channel-effective-mode');
    fireEvent.click(screen.getByRole('tab', { name: 'Operating rules' }));

    expect(screen.getByTestId('channel-hours-closed-warning')).toHaveTextContent(
      /automatic AI replies will be paused at all times/i,
    );

    fireEvent.click(screen.getByTestId('channel-hours-save'));
    expect(metaApi.updateMetaChannelSettings).not.toHaveBeenCalled();
    expect(screen.getByTestId('channel-hours-closed-confirm')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByTestId('channel-hours-closed-confirm')).not.toBeInTheDocument();
    expect(metaApi.updateMetaChannelSettings).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('channel-hours-save'));
    fireEvent.click(screen.getByTestId('channel-hours-closed-confirm-save'));

    await waitFor(() =>
      expect(metaApi.updateMetaChannelSettings).toHaveBeenCalledWith('c1', { businessHours: {} }),
    );
  });

  it('saves a normal day-enabled schedule without a confirmation step', async () => {
    renderDetail();
    await screen.findByTestId('channel-effective-mode');
    fireEvent.click(screen.getByRole('tab', { name: 'Operating rules' }));

    // Stored hours are NULL (always active); saving this all-disabled editor
    // state would instead save CLOSED every day, so the warning is honest.
    expect(screen.getByTestId('channel-hours-closed-warning')).toBeInTheDocument();
    const mondayLabel = screen.getByText('Mon').closest('label');
    fireEvent.click(mondayLabel!.querySelector('input')!);
    expect(screen.queryByTestId('channel-hours-closed-warning')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('channel-hours-save'));
    expect(screen.queryByTestId('channel-hours-closed-confirm')).not.toBeInTheDocument();

    await waitFor(() =>
      expect(metaApi.updateMetaChannelSettings).toHaveBeenCalledWith('c1', {
        businessHours: { mon: { open: '09:00', close: '18:00' } },
      }),
    );
  });

  it('locks override editing while the emergency stop is active', async () => {
    metaApi.getMetaChannelSettings.mockResolvedValue(
      makeSettings({
        overrides: {},
        mode_source: 'emergency_stop',
        effective: { ...makeSettings().effective, automation_mode: 'MANUAL' },
        emergency_stop: {
          active: true,
          at: new Date().toISOString(),
          by: 'user-1',
          source: 'merchant',
          prior_mode: 'DRAFT',
        },
      }),
    );
    renderDetail();
    await screen.findByTestId('channel-effective-mode');

    expect(screen.getByTestId('channel-overrides-locked-by-stop')).toHaveTextContent(
      /Automation is locked while the emergency stop is active/i,
    );
    expect(screen.queryByRole('button', { name: 'Override for this channel' })).not.toBeInTheDocument();
    expect(screen.getByTestId('channel-read-only-reason')).toHaveTextContent(
      /emergency stop is active/i,
    );

    fireEvent.click(screen.getByRole('tab', { name: 'AI behavior' }));
    expect(screen.queryByRole('button', { name: 'Override for this channel' })).not.toBeInTheDocument();
    expect(metaApi.updateMetaChannelSettings).not.toHaveBeenCalled();
  });

  it('hides a stored override editor while the emergency stop is active', async () => {
    metaApi.getMetaChannelSettings.mockResolvedValue(
      makeSettings({
        mode_source: 'emergency_stop',
        effective: { ...makeSettings().effective, automation_mode: 'MANUAL' },
        emergency_stop: {
          active: true,
          at: new Date().toISOString(),
          by: 'user-1',
          source: 'merchant',
          prior_mode: 'DRAFT',
        },
      }),
    );
    renderDetail();
    await screen.findByTestId('channel-effective-mode');

    expect(screen.queryByTestId('channel-mode-override')).not.toBeInTheDocument();
    expect(screen.queryByTestId('channel-override-revert-automation_mode')).not.toBeInTheDocument();
    expect(metaApi.updateMetaChannelSettings).not.toHaveBeenCalled();
  });

  it('never seeds a channel override from a forced mode source', async () => {
    metaApi.getMetaChannelSettings.mockResolvedValue(
      makeSettings({
        overrides: {},
        mode_source: 'shop_inactive',
        effective: { ...makeSettings().effective, automation_mode: 'MANUAL' },
      }),
    );
    renderDetail();
    await screen.findByTestId('channel-effective-mode');

    expect(screen.queryByRole('button', { name: 'Override for this channel' })).not.toBeInTheDocument();
    expect(screen.getByTestId('channel-read-only-reason')).toHaveTextContent(
      /cannot be started from it/i,
    );
    expect(metaApi.updateMetaChannelSettings).not.toHaveBeenCalled();
  });
});