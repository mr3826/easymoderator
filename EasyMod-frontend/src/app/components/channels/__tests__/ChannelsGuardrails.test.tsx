/**
 * Channels-workspace guardrails contracts (§8/§17/§18 + header-removal C1/C6):
 * compact page title with no signal band (per-channel record chips carry the
 * state), and the emergency-stop confirm dialog focus trap + Escape +
 * labelled semantics. Additive suite (real i18n en); the legacy channels
 * suites stay unchanged.
 */
import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ChannelsOverview from '../ChannelsOverview';
import EmergencyStopCard from '../EmergencyStopCard';
import { listMetaChannels } from '@/api/domains/meta-channels';
import { getShopAISettings } from '@/api/domains/shop';

vi.mock('@/api/domains/meta-channels', () => ({
  listMetaChannels: vi.fn(),
  channelQueryKeys: { list: () => ['channels'], settings: (id: string) => ['channel-settings', id] },
}));

vi.mock('@/api/domains/shop', () => ({
  getShopAISettings: vi.fn(),
  emergencyStop: vi.fn(),
  emergencyResume: vi.fn(),
}));

vi.mock('@/app/lib/auth', () => ({
  authService: {
    getCurrentShop: vi.fn(() => ({ id: 'shop-1', role: 'owner', shop_name: 'Test Shop' })),
  },
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

const channelRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'c1',
  platform: 'facebook',
  status: 'CONNECTED',
  isHealthy: true,
  needsReconnect: false,
  displayName: 'Inherited Page',
  metaAssetId: 'p1',
  effective_mode: 'DRAFT',
  mode_source: 'business_default',
  override_count: 0,
  emergency_stop: { active: false },
  billing_ai_active: true,
  ...overrides,
});

function renderWithClient(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listMetaChannels).mockResolvedValue([] as never);
  vi.mocked(getShopAISettings).mockResolvedValue({ automation_mode: 'DRAFT', emergency_stop: { active: false } } as never);
});

describe('page chrome (header removal C1/C6)', () => {
  it('renders a compact title, no signal band, no header CTA and no shop-level pills when empty', async () => {
    renderWithClient(<ChannelsOverview />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Channels & Automation' })).toBeInTheDocument();
    // The removal itself is pinned: no page-level signal badge, no aggregate band.
    expect(screen.queryByTestId('channels-signal')).toBeNull();
    expect(screen.queryByTestId('dashboard-primary-action')).toBeNull();
    expect(screen.queryByText(/Connected:/)).toBeNull();
    expect(screen.queryByText(/Overrides:/)).toBeNull();
    // The empty-state guidance carries the connect path (onboarding copy stays).
    expect(await screen.findByRole('button', { name: 'Connect a Page' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'No channels connected' })).toBeInTheDocument();
  });

  it('reports connected channels and a stopped workspace honestly at record level', async () => {
    vi.mocked(listMetaChannels).mockResolvedValue([channelRow()] as never);
    const { unmount } = renderWithClient(<ChannelsOverview />);
    // Contextual truth survives in the card: health row + per-channel badge.
    await waitFor(() => expect(screen.getByTestId('channel-card-c1')).toHaveTextContent('Connected'));
    expect(screen.getByTestId('channel-badge-c1')).toHaveTextContent('Inherited');
    expect(screen.queryByTestId('channels-signal')).toBeNull();
    unmount();

    vi.mocked(listMetaChannels).mockResolvedValue([channelRow({ emergency_stop: { active: true } })] as never);
    renderWithClient(<ChannelsOverview />);
    await waitFor(() => expect(screen.getByTestId('channel-badge-c1')).toHaveTextContent('Stopped'));
  });
});

describe('emergency-stop confirm dialog', () => {
  it('is labelled, traps focus, and closes on Escape', async () => {
    renderWithClient(<EmergencyStopCard />);
    const stop = await screen.findByTestId('emergency-stop-button');
    fireEvent.click(stop);
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('aria-labelledby', 'emergency-stop-confirm-title');
    expect(screen.getByText('Stop all AI replies?')).toBeInTheDocument();
    // Focus moves into the dialog on open (first focusable = Cancel).
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('renders the active stop banner as an alert with a resume control', async () => {
    vi.mocked(getShopAISettings).mockResolvedValue({ automation_mode: 'MANUAL', emergency_stop: { active: true, source: 'merchant', prior_mode: 'AUTO' } } as never);
    renderWithClient(<EmergencyStopCard />);
    const banner = await screen.findByTestId('emergency-stop-banner');
    expect(banner).toHaveAttribute('role', 'alert');
    expect(banner).toHaveTextContent('AI replies are stopped');
    expect(screen.getByTestId('emergency-resume-button')).toBeInTheDocument();
  });
});
