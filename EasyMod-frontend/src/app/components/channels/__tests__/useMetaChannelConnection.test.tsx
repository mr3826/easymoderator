/**
 * Phase 1 P02 — connect-toast accuracy (D6) + health-grid truth (D2 FE pin).
 *
 * D6: a connect whose webhook verification failed returns the channel with
 * status ERROR + webhookWarning. The hook must NOT precede that warning with a
 * success toast — success fires only when the returned status is CONNECTED.
 *
 * D2 (FE side): the webhook health row is driven purely by
 * webhookLastVerifiedAt, so the backend clearing the stamp on revoke/expire/
 * disconnect renders "Not verified" — pinned here for the revoked shape.
 */
import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useMetaChannelConnection, OAUTH_NONCE_KEY } from '../useMetaChannelConnection';
import { ChannelHealthGrid } from '../ChannelConnectionManager';
import type { MetaChannel } from '@/api/domains/meta-channels';

const {
  mockListMetaChannels,
  mockInitiateMetaOAuth,
  mockHandleMetaOAuthCallback,
  mockConnectMetaAsset,
  mockToastSuccess,
  mockToastError,
  mockToastWarning,
} = vi.hoisted(() => ({
  mockListMetaChannels: vi.fn(),
  mockInitiateMetaOAuth: vi.fn(),
  mockHandleMetaOAuthCallback: vi.fn(),
  mockConnectMetaAsset: vi.fn(),
  mockToastSuccess: vi.fn(),
  mockToastError: vi.fn(),
  mockToastWarning: vi.fn(),
}));

vi.mock('@/api/domains/meta-channels', () => ({
  listMetaChannels: mockListMetaChannels,
  initiateMetaOAuth: mockInitiateMetaOAuth,
  handleMetaOAuthCallback: mockHandleMetaOAuthCallback,
  connectMetaAsset: mockConnectMetaAsset,
  pingMetaChannel: vi.fn(),
  disconnectMetaChannel: vi.fn(),
  reconnectMetaChannel: vi.fn(),
  getMetaChannelConsentSummary: vi.fn(),
  updateMetaChannelPurposeLabel: vi.fn(),
  channelQueryKeys: {
    list: () => ['channels'],
    settings: (id: string) => ['channel-settings', id],
  },
}));

vi.mock('sonner', () => ({
  toast: {
    success: mockToastSuccess,
    error: mockToastError,
    warning: mockToastWarning,
  },
}));

const NONCE = 'nonce-abc-123';
const WEBHOOK_WARNING = 'Webhook subscription could not be verified — action required.';

function channelFixture(overrides: Partial<MetaChannel> = {}): MetaChannel {
  return {
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
    ...overrides,
  };
}

const flushPromises = () => new Promise((r) => setTimeout(r, 0));

let lastBroadcastChannel: { onmessage: ((event: { data: unknown }) => void) | null } | null = null;

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/**
 * Drive the real OAuth handshake surface the hook listens to: initiate →
 * popup success message → page-select → connect the selected Pages.
 */
async function connectSelectedPages(pages: Array<{ id: string; name: string }>) {
  const rendered = renderHook(() => useMetaChannelConnection(), { wrapper });

  await act(async () => {
    rendered.result.current.handleConnect();
    await flushPromises();
  });

  await act(async () => {
    lastBroadcastChannel?.onmessage?.({
      data: { type: 'OAUTH_SUCCESS', code: 'code-1234567890', state: sessionStorage.getItem(OAUTH_NONCE_KEY) },
    });
    await flushPromises();
  });

  for (const page of pages) {
    await act(async () => {
      rendered.result.current.togglePageSelection(page.id);
    });
  }

  await act(async () => {
    await rendered.result.current.handleConnectPages();
    await flushPromises();
  });

  return rendered;
}

describe('useMetaChannelConnection — connect toasts (D6)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    lastBroadcastChannel = null;
    mockListMetaChannels.mockResolvedValue([]);
    mockInitiateMetaOAuth.mockResolvedValue({
      redirectUrl: `https://app.example.test/oauth/callback?state=${NONCE}`,
      state: NONCE,
    });
    vi.spyOn(window, 'open').mockReturnValue({ closed: false, close: vi.fn() } as unknown as Window);
    Object.defineProperty(globalThis, 'BroadcastChannel', {
      configurable: true,
      writable: true,
      value: class {
        onmessage: ((event: { data: unknown }) => void) | null = null;
        constructor() {
          lastBroadcastChannel = this;
        }
        close = vi.fn();
        postMessage = vi.fn();
      },
    });
  });

  it('fires NO success toast when the returned channel is ERROR with a webhook warning', async () => {
    mockHandleMetaOAuthCallback.mockResolvedValue({
      pages: [{ id: 'page-1', name: 'Page One', category: null, pictureUrl: null, tasks: [], connectable: true, reason: null }],
      tempToken: 'tmp-1',
      reconnectChannelId: null,
      reconnectAssetId: null,
    });
    // Webhook failed backend-side: status ERROR + warning sentence.
    mockConnectMetaAsset.mockResolvedValue({
      ...channelFixture({ status: 'ERROR', isHealthy: false, needsReconnect: true, webhookLastVerifiedAt: null }),
      webhookWarning: WEBHOOK_WARNING,
    });

    await connectSelectedPages([{ id: 'page-1', name: 'Page One' }]);

    expect(mockConnectMetaAsset).toHaveBeenCalledTimes(1);
    expect(mockToastSuccess).not.toHaveBeenCalled();
    expect(mockToastWarning).toHaveBeenCalledWith(WEBHOOK_WARNING, { duration: 12000 });
  });

  it('fires the action-required warning even when the backend carries no warning sentence', async () => {
    mockHandleMetaOAuthCallback.mockResolvedValue({
      pages: [{ id: 'page-1', name: 'Page One', category: null, pictureUrl: null, tasks: [], connectable: true, reason: null }],
      tempToken: 'tmp-1',
      reconnectChannelId: null,
      reconnectAssetId: null,
    });
    mockConnectMetaAsset.mockResolvedValue({
      ...channelFixture({ status: 'ERROR', webhookLastVerifiedAt: null }),
      webhookWarning: null,
    });

    await connectSelectedPages([{ id: 'page-1', name: 'Page One' }]);

    expect(mockToastSuccess).not.toHaveBeenCalled();
    const warningText = String(mockToastWarning.mock.calls[0]?.[0] ?? '');
    expect(warningText.length).toBeGreaterThan(0);
    expect(warningText).not.toBe(WEBHOOK_WARNING); // generic guidance, not the raw sentence
  });

  it('shows success for a CONNECTED result and keeps the delayed warning for a warning+CONNECTED shape', async () => {
    mockHandleMetaOAuthCallback.mockResolvedValue({
      pages: [{ id: 'page-1', name: 'Page One', category: null, pictureUrl: null, tasks: [], connectable: true, reason: null }],
      tempToken: 'tmp-1',
      reconnectChannelId: null,
      reconnectAssetId: null,
    });
    mockConnectMetaAsset.mockResolvedValue({
      ...channelFixture(),
      webhookWarning: WEBHOOK_WARNING,
    });

    await connectSelectedPages([{ id: 'page-1', name: 'Page One' }]);

    expect(mockToastSuccess).toHaveBeenCalledTimes(1);
    expect(mockToastWarning).not.toHaveBeenCalled(); // still delayed at this point
    await waitFor(() => {
      expect(mockToastWarning).toHaveBeenCalledWith(WEBHOOK_WARNING, { duration: 12000 });
    }, { timeout: 1500 });
  });

  it('a mixed multi-Page connect (one CONNECTED, one ERROR) never claims blanket success', async () => {
    mockHandleMetaOAuthCallback.mockResolvedValue({
      pages: [
        { id: 'page-1', name: 'Page One', category: null, pictureUrl: null, tasks: [], connectable: true, reason: null },
        { id: 'page-2', name: 'Page Two', category: null, pictureUrl: null, tasks: [], connectable: true, reason: null },
      ],
      tempToken: 'tmp-1',
      reconnectChannelId: null,
      reconnectAssetId: null,
    });
    mockConnectMetaAsset
      .mockResolvedValueOnce({ ...channelFixture(), webhookWarning: null })
      .mockResolvedValueOnce({
        ...channelFixture({ id: 'mc-2', metaAssetId: 'page-2', status: 'ERROR', webhookLastVerifiedAt: null }),
        webhookWarning: WEBHOOK_WARNING,
      });

    await connectSelectedPages([
      { id: 'page-1', name: 'Page One' },
      { id: 'page-2', name: 'Page Two' },
    ]);

    expect(mockConnectMetaAsset).toHaveBeenCalledTimes(2);
    expect(mockToastSuccess).not.toHaveBeenCalled();
    expect(mockToastWarning).toHaveBeenCalledWith(WEBHOOK_WARNING, { duration: 12000 });
  });
});

describe('ChannelHealthGrid — webhook row truth (D2 FE contract)', () => {
  it('renders the webhook row as Not verified once the stamp is cleared', () => {
    render(
      <ChannelHealthGrid
        channel={channelFixture({
          status: 'REVOKED',
          isHealthy: false,
          needsReconnect: true,
          webhookLastVerifiedAt: null,
          webhookSubscribedFields: [],
        })}
      />,
    );

    expect(screen.getByTestId('channel-health-grid')).toBeInTheDocument();
    expect(screen.getAllByText('Not verified').length).toBe(1);
    expect(screen.queryByText('Active')).not.toBeInTheDocument();
  });

  it('still renders Active for a verified CONNECTED channel', () => {
    render(<ChannelHealthGrid channel={channelFixture()} />);

    expect(screen.getAllByText('Active').length).toBe(1);
    expect(screen.queryByText('Not verified')).not.toBeInTheDocument();
  });
});
