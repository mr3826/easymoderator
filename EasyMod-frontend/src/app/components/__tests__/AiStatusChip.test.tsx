/**
 * AiStatusChip — the full D6 state matrix against doc 05 §7, including the
 * A9 attack items: billing fail-closed (never a confident AUTO without a
 * live AI entitlement) and emergency-stop precedence over everything.
 * The chip is READ-ONLY: every state is one link to /manage-shop/channels
 * and the suite pins that no control (button/toggle) ever appears.
 */
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AiStatusChip, { resolveAiChipState, type AiChipState } from '../shell/AiStatusChip';
import { listMetaChannels, type MetaChannel } from '@/api/domains/meta-channels';

vi.mock('@/api/domains/meta-channels', () => ({ listMetaChannels: vi.fn() }));

type ChannelSeed = Partial<MetaChannel> & Pick<MetaChannel, 'status'>;

const channel = (seed: ChannelSeed): MetaChannel => ({
  id: `ch-${Math.random().toString(36).slice(2)}`,
  shopId: 'shop-a',
  platform: 'facebook',
  metaAssetId: 'asset-1',
  displayName: 'Page',
  pictureUrl: null,
  isHealthy: seed.status === 'CONNECTED',
  needsReconnect: false,
  lastError: null,
  tokenExpiresAt: null,
  tokenLastRefreshedAt: null,
  webhookSubscribedFields: [],
  webhookLastVerifiedAt: null,
  connectedAt: null,
  disconnectedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  purposeLabel: null,
  ...seed,
} as MetaChannel);

const EXPECTED: Record<AiChipState, { label: string; aria: string }> = {
  unavailable: { label: 'Status unavailable', aria: 'AI reply status could not be loaded. This is not the same as AI being off.' },
  notConnected: { label: 'Not connected', aria: 'No Meta channel is connected, so AI reply is off.' },
  emergencyStop: { label: 'Emergency stop active', aria: 'Emergency stop is active — all AI replies are paused.' },
  reconnectRequired: { label: 'Reconnect required', aria: 'A channel needs to be reconnected before AI or messaging can run.' },
  auto: { label: 'AI auto-reply on', aria: 'AI is sending replies automatically on at least one channel.' },
  draft: { label: 'AI drafts replies', aria: 'AI is preparing reply drafts for you to approve.' },
  manual: { label: 'Manual replies', aria: 'Replies are sent manually only.' },
  mixed: { label: 'AI modes vary by channel', aria: 'AI reply modes differ across your channels.' },
};

function renderChip() {
  return render(
    <MemoryRouter>
      <AiStatusChip />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('resolveAiChipState (pure matrix)', () => {
  const AUTO = channel({ status: 'CONNECTED', effective_mode: 'AUTO', billing_ai_active: true });
  const DRAFT = channel({ status: 'CONNECTED', effective_mode: 'DRAFT', billing_ai_active: true });
  const MANUAL = channel({ status: 'CONNECTED', effective_mode: 'MANUAL', billing_ai_active: true });

  it('maps every contract state', () => {
    expect(resolveAiChipState(null)).toBe('unavailable');
    expect(resolveAiChipState([])).toBe('notConnected');
    expect(resolveAiChipState([AUTO, DRAFT, MANUAL])).toBe('mixed');
    expect(resolveAiChipState([MANUAL, MANUAL])).toBe('manual');
    expect(resolveAiChipState([DRAFT])).toBe('draft');
    expect(resolveAiChipState([AUTO])).toBe('auto');
  });

  it('lets an active emergency stop override every mode reading (safety first)', () => {
    expect(resolveAiChipState([
      channel({ status: 'CONNECTED', effective_mode: 'AUTO', billing_ai_active: true, emergency_stop: { active: true, at: '2026-11-24T00:00:00.000Z', by: 'u1', source: 'merchant', prior_mode: 'AUTO' } }),
    ])).toBe('emergencyStop');
    // …even ahead of reconnectRequired.
    expect(resolveAiChipState([
      channel({ status: 'TOKEN_EXPIRED', needsReconnect: true }),
      channel({ status: 'CONNECTED', effective_mode: 'DRAFT', emergency_stop: { active: true, at: null, by: null, source: 'admin', prior_mode: null } }),
    ])).toBe('emergencyStop');
  });

  it('demands reconnect when nothing is connected — or when any owned channel needs it', () => {
    expect(resolveAiChipState([channel({ status: 'TOKEN_EXPIRED' }), channel({ status: 'DISCONNECTED' })])).toBe('reconnectRequired');
    expect(resolveAiChipState([AUTO, channel({ status: 'TOKEN_EXPIRED', needsReconnect: true })])).toBe('reconnectRequired');
  });

  it('fails closed on billing: an AUTO payload without a live AI entitlement is never shown as AUTO', () => {
    expect(resolveAiChipState([channel({ status: 'CONNECTED', effective_mode: 'AUTO', billing_ai_active: false })])).toBe('mixed');
    expect(resolveAiChipState([channel({ status: 'CONNECTED', effective_mode: 'AUTO', billing_ai_active: true }), channel({ status: 'CONNECTED', effective_mode: 'AUTO', billing_ai_active: false })])).toBe('mixed');
    // An absent flag is treated as not-active too (trust, but verify).
    expect(resolveAiChipState([channel({ status: 'CONNECTED', effective_mode: 'AUTO' })])).toBe('mixed');
  });

  it('treats unknown/missing modes as mixed, never guesses a healthy state', () => {
    expect(resolveAiChipState([channel({ status: 'CONNECTED' })])).toBe('mixed');
    expect(resolveAiChipState([channel({ status: 'CONNECTED' }), MANUAL])).toBe('mixed');
  });
});

describe('AiStatusChip rendering', () => {
  const cases: Array<{ name: string; channels: MetaChannel[] | null; state: AiChipState }> = [
    { name: 'fetch failure', channels: null, state: 'unavailable' },
    { name: 'no channels', channels: [], state: 'notConnected' },
    { name: 'emergency stop', channels: [channel({ status: 'CONNECTED', effective_mode: 'AUTO', billing_ai_active: true, emergency_stop: { active: true, at: null, by: null, source: 'merchant', prior_mode: null } })], state: 'emergencyStop' },
    { name: 'reconnect required', channels: [channel({ status: 'TOKEN_EXPIRED', needsReconnect: true })], state: 'reconnectRequired' },
    { name: 'auto', channels: [channel({ status: 'CONNECTED', effective_mode: 'AUTO', billing_ai_active: true })], state: 'auto' },
    { name: 'draft', channels: [channel({ status: 'CONNECTED', effective_mode: 'DRAFT', billing_ai_active: true })], state: 'draft' },
    { name: 'manual', channels: [channel({ status: 'CONNECTED', effective_mode: 'MANUAL', billing_ai_active: false })], state: 'manual' },
    { name: 'mixed', channels: [channel({ status: 'CONNECTED', effective_mode: 'AUTO', billing_ai_active: true }), channel({ status: 'CONNECTED', effective_mode: 'MANUAL', billing_ai_active: true })], state: 'mixed' },
  ];

  for (const { name, channels, state } of cases) {
    it(`renders the ${state} state for ${name} — icon + label, no toggle, linking to Channels`, async () => {
      if (channels === null) {
        vi.mocked(listMetaChannels).mockRejectedValue(new Error('500'));
      } else {
        vi.mocked(listMetaChannels).mockResolvedValue(channels);
      }
      renderChip();
      const expected = EXPECTED[state];
      const chip = await screen.findByRole('link', { name: expected.aria });
      expect(chip).toHaveAttribute('href', '/manage-shop/channels');
      expect(chip).toHaveAttribute('data-testid', 'ai-status-chip');
      expect(chip).toHaveAttribute('data-state', state);
      // Every state carries a visible label AND an icon (never color alone).
      expect(chip).toHaveTextContent(expected.label);
      expect(chip.querySelector('svg')).not.toBeNull();
      // D6 hard rule: the chip is read-only — no button/toggle anywhere in it.
      expect(chip.querySelectorAll('button, [role="switch"], [role="checkbox"]')).toHaveLength(0);
      expect(screen.queryAllByRole('button')).toHaveLength(0);
    });
  }

  // A9: absence of shape = failed source, not proven-empty. The two paths
  // must never collapse into each other: [] is a VERIFIED zero-channel list
  // (notConnected); a malformed 200 payload says nothing at all (unavailable).
  it('malformed non-array success payloads map to unavailable, never notConnected', async () => {
    for (const payload of [{ success: true }, null, undefined, { data: [] }]) {
      vi.mocked(listMetaChannels).mockResolvedValue(payload as never);
      const { unmount } = renderChip();
      const chip = await screen.findByRole('link', { name: EXPECTED.unavailable.aria });
      expect(chip).toHaveAttribute('data-state', 'unavailable');
      unmount();
    }
  });

  it('renders nothing before the first read settles (absence, not a guess)', async () => {
    let release: (value: MetaChannel[]) => void = () => {};
    vi.mocked(listMetaChannels).mockReturnValue(new Promise((resolve) => { release = resolve; }));
    renderChip();
    expect(screen.queryByTestId('ai-status-chip')).not.toBeInTheDocument();
    release([]);
    expect(await screen.findByRole('link', { name: EXPECTED.notConnected.aria })).toBeInTheDocument();
  });

  it('refreshes on the same 60s visibility-aware cadence as the badges', async () => {
    vi.useFakeTimers();
    vi.mocked(listMetaChannels).mockResolvedValue([]);
    renderChip();
    expect(listMetaChannels).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByTestId('ai-status-chip')).toHaveAttribute('data-state', 'notConnected');
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(listMetaChannels).toHaveBeenCalledTimes(2);
  });
});
