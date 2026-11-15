/**
 * Degraded-data honesty for the action queue: partial=true surfaces a labeled
 * banner only when the queue is renderable; fail-closed empty DOM still wins
 * for flag-off / empty / malformed payloads.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { getInboxActions } from '@/api/domains/inbox';
import { ActionQueuePanel } from '../ActionQueuePanel';

vi.mock('@/api/domains/inbox', () => ({ getInboxActions: vi.fn() }));
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => vi.fn() };
});

const item = {
  bucket: 1,
  item_key: 'hitl:conv-1',
  reason_code: 'HITL_REQUIRED',
  source: { type: 'conversation', id: 'conv-1' },
  conversation_id: 'conv-1',
  customer_id: 'cust-1',
  status: 'awaiting_human',
  owner: null,
  next_action: { type: 'open_conversation' },
  grounded_deadline: null,
  since: '2026-10-24T08:00:00Z',
};

const payload = (partial: boolean, items: unknown[] = [item]) => ({
  featureDisabled: false,
  data: { items, generated_at: '2026-10-25T01:00:00Z', partial, counts: { total: items.length, views: { attention: items.length } } },
});

beforeEach(() => vi.clearAllMocks());

describe('action queue partial honesty', () => {
  it('labels a partially-failed queue without dropping items', async () => {
    vi.mocked(getInboxActions).mockResolvedValue(payload(true) as never);
    render(<ActionQueuePanel />);
    const banner = await screen.findByTestId('action-queue-partial');
    expect(banner.getAttribute('role')).toBe('status');
    expect(banner.textContent).toContain('Some action sources could not load');
    expect(screen.getAllByTestId('action-item')).toHaveLength(1);
  });
  it('stays empty-DOM when partial but nothing renderable (fail-closed wins)', async () => {
    vi.mocked(getInboxActions).mockResolvedValue(payload(true, []) as never);
    const { container } = render(<ActionQueuePanel />);
    await waitFor(() => expect(getInboxActions).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
  it('shows no banner when the queue is complete', async () => {
    vi.mocked(getInboxActions).mockResolvedValue(payload(false) as never);
    render(<ActionQueuePanel />);
    await screen.findByTestId('action-queue');
    expect(screen.queryByTestId('action-queue-partial')).toBeNull();
  });
  it('still renders nothing when the feature flag is off', async () => {
    vi.mocked(getInboxActions).mockResolvedValue({ featureDisabled: true } as never);
    const { container } = render(<ActionQueuePanel />);
    await waitFor(() => expect(getInboxActions).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});
