/**
 * ChannelConnectionManager — extraction-parity + moved ChatSettings pin
 * (TEST_STRATEGY §4: the "no Page-level AI control" pin now lives here).
 */
import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import ChannelConnectionManager, {
  ChannelHealthGrid,
} from '@/app/components/channels/ChannelConnectionManager';
import type { MetaChannel } from '@/api/domains/meta-channels';

const channel: MetaChannel = {
  id: 'mc-1',
  shopId: 'shop-1',
  platform: 'facebook',
  metaAssetId: 'page-1',
  displayName: 'My Facebook Page',
  pictureUrl: null,
  status: 'CONNECTED',
  isHealthy: true,
  needsReconnect: false,
  lastError: null,
  tokenExpiresAt: null,
  tokenLastRefreshedAt: new Date().toISOString(),
  webhookSubscribedFields: ['messages'],
  webhookLastVerifiedAt: new Date().toISOString(),
  connectedAt: new Date().toISOString(),
  disconnectedAt: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  purposeLabel: null,
};

vi.mock('@/api/domains/meta-channels', () => ({
  listMetaChannels: vi.fn().mockResolvedValue([]),
  initiateMetaOAuth: vi.fn(),
  handleMetaOAuthCallback: vi.fn(),
  connectMetaAsset: vi.fn(),
  pingMetaChannel: vi.fn(),
  disconnectMetaChannel: vi.fn(),
  reconnectMetaChannel: vi.fn(),
  getMetaChannelConsentSummary: vi.fn(),
  updateMetaChannelPurposeLabel: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

import { listMetaChannels } from '@/api/domains/meta-channels';

describe('ChannelConnectionManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listMetaChannels).mockResolvedValue([channel]);
  });

  it('renders the connection surface without a Page-level AI participation control', async () => {
    render(<ChannelConnectionManager />);

    expect(await screen.findByText('Channel Settings')).toBeInTheDocument();
    expect(screen.queryByText(/Page AI participation/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/AI will not draft or send replies for this Page/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/automatic replies for this Page/i)).not.toBeInTheDocument();
    // The labeled narrow-only override lives on the channel detail surface,
    // never on the connection manager.
    expect(screen.queryByTestId('channel-mode-override')).not.toBeInTheDocument();
  });

  it('renders the health grid for a healthy channel without behaviour change', async () => {
    render(<ChannelConnectionManager />);

    await waitFor(() => {
      expect(screen.getByTestId('channel-health-grid')).toBeInTheDocument();
      expect(screen.getAllByText('Connected').length).toBeGreaterThan(0);
      expect(screen.getAllByText('Active').length).toBeGreaterThan(0);
      expect(screen.getAllByText('Valid').length).toBeGreaterThan(0);
    });
  });

  it('hides the header when embedded', async () => {
    render(<ChannelConnectionManager embedded />);
    await screen.findByTestId('channel-health-grid');
    expect(screen.queryByText('Channel Settings')).not.toBeInTheDocument();
  });

  it('ChannelHealthGrid is pure presentation and takes a channel', () => {
    render(<ChannelHealthGrid channel={{ ...channel, status: 'TOKEN_EXPIRED', tokenExpiresAt: new Date(Date.now() - 1000).toISOString() }} />);
    expect(screen.getByTestId('channel-health-grid')).toBeInTheDocument();
    expect(screen.getByText('Expired')).toBeInTheDocument();
  });
});