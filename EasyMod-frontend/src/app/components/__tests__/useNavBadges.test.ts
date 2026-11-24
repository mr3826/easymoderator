/**
 * useNavBadges honesty + cadence contracts (mission D1/D10; doc 05 §1–§3).
 * Real i18n (setup.js pins en) so the nav.badges.* {{count}} interpolation
 * is proven end-to-end; domain sources are vi.mock'd (C1/C2 ship with A5 in
 * this wave, so mocks are the contract here).
 */
import { act, renderHook, waitFor } from '@testing-library/react';
// DE-2 regression: badge strings are DERIVED at render time from the raw
// readings the hook stores, so an EN→BN switch mid-session re-renders every
// badge (display + aria + Intl numerals) without remount or the next poll.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '@/i18n';
import { getOrderCounts } from '@/api/domains/order';
import { getNeedsReplyCount } from '@/api/domains/conversation';
import { getStockExceptions } from '@/api/domains/product';
import { buildNavBadge, useNavBadges } from '../shell/useNavBadges';

vi.mock('@/api/domains/order', () => ({ getOrderCounts: vi.fn() }));
vi.mock('@/api/domains/conversation', () => ({ getNeedsReplyCount: vi.fn() }));
vi.mock('@/api/domains/product', () => ({ getStockExceptions: vi.fn() }));

const counts = (needs_action: number) => ({
  total: 0, to_confirm: 0, to_pack: 0, booked: 0, in_transit: 0,
  needs_action, returned: 0, delivered: 0,
});
const reply = (count: number, coverageComplete = true) => ({
  count, scanned: count, cap: 200, coverageComplete, generated_at: '2026-11-24T10:00:00.000Z',
});
const stock = (exceptions: number, coverageComplete = true) => ({
  outOfStock: 0, lowStock: exceptions, exceptions, scanned: 10, cap: 1000,
  coverageComplete, generated_at: '2026-11-24T10:00:00.000Z',
});

function mockSources(values: {
  orders?: ReturnType<typeof counts> | Error;
  inbox?: ReturnType<typeof reply> | Error;
  products?: ReturnType<typeof stock> | Error;
}) {
  const settle = (v: unknown) => (v instanceof Error ? Promise.reject(v) : Promise.resolve(v));
  vi.mocked(getOrderCounts).mockImplementation(() => settle(values.orders ?? counts(0)) as never);
  vi.mocked(getNeedsReplyCount).mockImplementation((signal?: AbortSignal) => {
    capturedSignals.push(signal as AbortSignal);
    return settle(values.inbox ?? reply(0)) as never;
  });
  vi.mocked(getStockExceptions).mockImplementation((signal?: AbortSignal) => {
    capturedSignals.push(signal as AbortSignal);
    return settle(values.products ?? stock(0)) as never;
  });
}
let capturedSignals: AbortSignal[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  capturedSignals = [];
});
afterEach(() => {
  vi.useRealTimers();
});

describe('useNavBadges honesty', () => {
  it('maps each source to its authority and aria sentence', async () => {
    mockSources({ orders: counts(4), inbox: reply(3), products: stock(2) });
    const { result } = renderHook(() => useNavBadges());
    await waitFor(() => expect(result.current.orders).not.toBeNull());
    expect(result.current.orders).toMatchObject({ count: 4, display: '4', lowerBound: false });
    expect(result.current.orders?.aria).toBe('4 orders need action');
    expect(result.current.inbox?.aria).toBe('3 messages need a reply');
    expect(result.current.products?.display).toBe('2');
    expect(result.current.products?.aria).toBe('2 products have stock exceptions');
  });

  it('renders NO badge on failure or restriction — never a zero pill', async () => {
    mockSources({
      orders: new Error('403'),
      inbox: new Error('restricted'),
      products: new Error('boom'),
    });
    const { result } = renderHook(() => useNavBadges());
    await waitFor(() => expect(getStockExceptions).toHaveBeenCalled());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(result.current).toEqual({ orders: null, inbox: null, products: null });
  });

  // A9 partial-failure: honesty is PER SOURCE. One endpoint blip hides its
  // own badge and must never blank the other sources' last-known-good
  // readings (no cross-source cascade).
  it('keeps healthy Orders/Products badges across a partial (inbox-only) failure', async () => {
    vi.useFakeTimers();
    mockSources({ orders: counts(4), inbox: reply(3), products: stock(2) });
    const { result } = renderHook(() => useNavBadges());
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(result.current.orders?.display).toBe('4');
    expect(result.current.inbox?.display).toBe('3');
    expect(result.current.products?.display).toBe('2');

    // Next poll tick: ONLY the inbox source fails.
    mockSources({ orders: counts(4), inbox: new Error('503'), products: stock(2) });
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(result.current.orders?.display).toBe('4'); // persists
    expect(result.current.products?.display).toBe('2'); // persists
    expect(result.current.inbox).toBeNull(); // the failed source hides alone
  });

  it('a hanging source never blocks the healthy sources from rendering', async () => {
    mockSources({ orders: counts(4), products: stock(2) });
    vi.mocked(getNeedsReplyCount).mockImplementation(() => new Promise(() => {}) as never);
    const { result } = renderHook(() => useNavBadges());
    await waitFor(() => expect(result.current.orders).not.toBeNull());
    expect(result.current.products?.display).toBe('2');
    expect(result.current.inbox).toBeNull();
  });

  it('renders NO badge for a true zero either (absence claims nothing)', async () => {
    mockSources({ orders: counts(0), inbox: reply(0), products: stock(0) });
    const { result } = renderHook(() => useNavBadges());
    await waitFor(() => expect(getOrderCounts).toHaveBeenCalled());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(result.current.orders).toBeNull();
    expect(result.current.inbox).toBeNull();
    expect(result.current.products).toBeNull();
  });

  it('caps display at 99+ and keeps the raw count for decisions', async () => {
    mockSources({ orders: counts(150), inbox: reply(99), products: stock(100) });
    const { result } = renderHook(() => useNavBadges());
    await waitFor(() => expect(result.current.orders).not.toBeNull());
    expect(result.current.orders?.display).toBe('99+');
    expect(result.current.orders?.count).toBe(150);
    expect(result.current.orders?.aria).toBe('99+ orders need action');
    // 99 is below the cap — shown exactly.
    expect(result.current.inbox?.display).toBe('99');
    expect(result.current.products?.display).toBe('99+');
  });

  it('marks incomplete server coverage as a lower bound with honest aria', async () => {
    mockSources({ inbox: reply(5, false) });
    const { result } = renderHook(() => useNavBadges());
    await waitFor(() => expect(result.current.inbox).not.toBeNull());
    expect(result.current.inbox).toMatchObject({ display: '5+', lowerBound: true });
    expect(result.current.inbox?.aria).toBe('5+ messages need a reply');
  });

  it('formats counts with Bangla numerals in bn (pre-pilot Intl rule)', async () => {
    await i18n.changeLanguage('bn');
    try {
      mockSources({ orders: counts(4) });
      const { result } = renderHook(() => useNavBadges());
      await waitFor(() => expect(result.current.orders).not.toBeNull());
      expect(result.current.orders?.display).toBe('৪');
      expect(result.current.orders?.aria).toBe('৪টি অর্ডারে ব্যবস্থা দরকার');
    } finally {
      await i18n.changeLanguage('en');
    }
  });

  it('re-renders display/aria strings in the new locale when the language switches mid-session (DE-2)', async () => {
    mockSources({ orders: counts(4), inbox: reply(12, false) });
    const { result } = renderHook(() => useNavBadges());
    await waitFor(() => expect(result.current.orders).not.toBeNull());
    // Strings established under EN, fetched exactly once.
    expect(result.current.orders?.display).toBe('4');
    expect(result.current.orders?.aria).toBe('4 orders need action');
    expect(result.current.inbox?.display).toBe('12+');
    const fetches = vi.mocked(getOrderCounts).mock.calls.length;

    // Mid-session switch WITHOUT remount — react-i18next's languageChanged
    // subscription re-renders the hook, which re-derives the strings.
    await act(async () => { await i18n.changeLanguage('bn'); });
    try {
      // No remount, no extra poll: the badge objects are DERIVED at render
      // time from the stored raw readings, so the active locale wins now.
      expect(vi.mocked(getOrderCounts).mock.calls.length).toBe(fetches);
      expect(result.current.orders?.display).toBe('৪');
      expect(result.current.orders?.aria).toBe('৪টি অর্ডারে ব্যবস্থা দরকার');
      expect(result.current.inbox?.display).toBe('১২+');
      expect(result.current.inbox?.aria).toBe('১২+টি মেসেজের উত্তর দরকার');
      // Honesty semantics are locale-independent and survive the switch.
      expect(result.current.orders?.count).toBe(4);
      expect(result.current.inbox?.lowerBound).toBe(true);

      // Switching BACK is just as immediate (strings track either direction).
      await act(async () => { await i18n.changeLanguage('en'); });
      expect(result.current.orders?.display).toBe('4');
      expect(result.current.orders?.aria).toBe('4 orders need action');
    } finally {
      await i18n.changeLanguage('en');
    }
  });
});

describe('useNavBadges cadence', () => {
  it('polls on a 60s cadence while visible', async () => {
    vi.useFakeTimers();
    mockSources({ orders: counts(1) });
    renderHook(() => useNavBadges());
    expect(getOrderCounts).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(getOrderCounts).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(getOrderCounts).toHaveBeenCalledTimes(3);
  });

  it('pauses while the tab is hidden and refreshes immediately when visible again', async () => {
    vi.useFakeTimers();
    const visibility = { state: 'visible' };
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => visibility.state,
    });
    mockSources({ orders: counts(1) });
    renderHook(() => useNavBadges());
    expect(getOrderCounts).toHaveBeenCalledTimes(1);

    visibility.state = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    await act(async () => { await vi.advanceTimersByTimeAsync(180_000); });
    expect(getOrderCounts).toHaveBeenCalledTimes(1); // parked, not polled

    visibility.state = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    expect(getOrderCounts).toHaveBeenCalledTimes(2); // immediate catch-up
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(getOrderCounts).toHaveBeenCalledTimes(3); // cadence resumed
  });

  it('aborts in-flight C1/C2 reads on unmount and on supersede', async () => {
    vi.useFakeTimers();
    mockSources({ orders: counts(1) });
    const { unmount } = renderHook(() => useNavBadges());
    expect(capturedSignals.length).toBeGreaterThanOrEqual(2);
    const first = capturedSignals[0];
    expect(first?.aborted).toBe(false);

    unmount();
    expect(first?.aborted).toBe(true);

    // Second mount: a later poll supersedes the previous controller.
    mockSources({ orders: counts(2) });
    renderHook(() => useNavBadges());
    const before = capturedSignals.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(capturedSignals.length).toBeGreaterThan(before);
    expect(capturedSignals[before - 1]?.aborted).toBe(true);
  });
});

describe('buildNavBadge (pure honesty mapping)', () => {
  const nf = new Intl.NumberFormat('en', { useGrouping: false });
  const t = ((key: string, opts?: { count?: unknown }) => `${String(opts?.count)}|${key}`) as never;

  it('returns null for a failed or non-finite source', () => {
    expect(buildNavBadge(null, 'nav.badges.orders', t, nf)).toBeNull();
    expect(buildNavBadge({ count: Number.NaN, coverageComplete: true }, 'nav.badges.orders', t, nf)).toBeNull();
  });

  it('refuses the "0 with incomplete coverage" pseudo-claim', () => {
    expect(buildNavBadge({ count: 0, coverageComplete: false }, 'nav.badges.inbox', t, nf)).toBeNull();
  });
});
