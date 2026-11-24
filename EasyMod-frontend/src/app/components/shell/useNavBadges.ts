/**
 * Shared nav-badge data layer (Phase 1 mission D1; guardrails §15/§16).
 * ONE hook feeds the Orders / Inbox / Products badges on both the desktop
 * rail and the mobile tab bar, so the two surfaces can never drift.
 *
 * Authorities (doc 05 §1–§3 — one predicate per number, shared with the
 * destination pages):
 *  - Orders:   getOrderCounts().needs_action  ONLY (buckets are not provably
 *              disjoint, so nothing is summed; to_confirm stays on the
 *              dashboard worklist).
 *  - Inbox:    getNeedsReplyCount  (C1 shared needs-reply service).
 *  - Products: getStockExceptions  (C2 D2 predicate).
 *  - Customers badge is deliberately omitted (no honest shop-level source).
 *
 * Honesty rules (D1/D10, A9 attack items):
 *  - failure / 403 / abort → null → NO badge — a missing source is never
 *    rendered as "0";
 *  - count 0 → no badge either: absence of a badge is not a "0" claim and
 *    not an "all clear" claim — the dashboard keeps the exhaustive states;
 *  - display cap 99+; when the server says coverage is incomplete the pill
 *    is rendered as a LOWER BOUND ("N+") and the aria text inherits it;
 *    (incomplete coverage with count 0 makes no positive claim → no badge);
 *  - numbers are Intl-formatted at render time (Bangla numerals in bn —
 *    pre-pilot founder rule; no hand-written digits). The hook stores only
 *    RAW readings (count + coverage) and derives display/aria strings in a
 *    render-time memo keyed on the active locale, so a mid-session EN↔BN
 *    switch re-renders every badge immediately — a mid-session language
 *    change never leaves stale-locale strings until the next poll tick (DE-2);
 *  - 60s cadence, paused while the tab is hidden (document.visibilityState),
 *    AbortController cleanup on supersede/unmount, stale-settled results
 *    dropped by a generation counter (getOrderCounts takes no signal).
 *
 * Motion (design-motion-principles, frequency gate): badge swaps are
 * high-frequency passive data — no enter/exit animation here or in
 * ShellNavItem; the pill updates in place.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { getOrderCounts } from '@/api/domains/order';
import { getNeedsReplyCount } from '@/api/domains/conversation';
import { getStockExceptions } from '@/api/domains/product';

/** Shared shell polling cadence (nav badges + AI status chip). */
export const SHELL_POLL_MS = 60_000;
/** Display cap per mission D1: 99+ rather than wide unbounded pills. */
export const NAV_BADGE_DISPLAY_CAP = 99;

export interface NavBadge {
  /** Raw authoritative count (never rendered directly when > cap). */
  count: number;
  /** Locale-formatted pill text, capped 99+, '+' when a lower bound. */
  display: string;
  /** True when the server scan was not exhaustive — the number is a floor. */
  lowerBound: boolean;
  /** Screen-reader sentence from nav.badges.* with the formatted count. */
  aria: string;
}

export interface NavBadges {
  orders: NavBadge | null;
  inbox: NavBadge | null;
  products: NavBadge | null;
}

export const EMPTY_NAV_BADGES: NavBadges = { orders: null, inbox: null, products: null };

type CountReading = { count: number; coverageComplete: boolean };

/**
 * Locale-independent state kept across polls: raw server readings ONLY. The
 * display/aria strings are derived at render time from these readings, so an
 * EN→BN (or BN→EN) switch never surfaces stale-locale text (DE-2).
 */
type NavBadgeReadings = {
  orders: CountReading | null;
  inbox: CountReading | null;
  products: CountReading | null;
};

const EMPTY_NAV_BADGE_READINGS: NavBadgeReadings = {
  orders: null,
  inbox: null,
  products: null,
};

/**
 * The published aria templates interpolate {{count}} with the formatted
 * display string (doc 04 §6). i18next types `count` as a plural NUMBER, so
 * the string is routed into the interpolation slot via a structural cast —
 * interpolation only, no pluralization (the keys have no plural forms).
 */
export function tWithCountDisplay(t: TFunction, key: string, display: string): string {
  return t(key, { count: display } as unknown as { count: number });
}

/** Pure mapping so cap/lower-bound honesty is unit-testable without React. */
export function buildNavBadge(
  reading: CountReading | null,
  ariaKey: string,
  t: TFunction,
  numberFormat: Intl.NumberFormat,
): NavBadge | null {
  if (reading === null || !Number.isFinite(reading.count) || reading.count <= 0) return null;
  const lowerBound = !reading.coverageComplete;
  const capped = reading.count > NAV_BADGE_DISPLAY_CAP;
  const display = `${numberFormat.format(Math.min(reading.count, NAV_BADGE_DISPLAY_CAP))}${capped || lowerBound ? '+' : ''}`;
  return { count: reading.count, display, lowerBound, aria: tWithCountDisplay(t, ariaKey, display) };
}

/**
 * Visibility-aware polling shared by the shell's passive read-models (D1
 * badges, D6 AI chip): run immediately while visible, keep a 60s interval,
 * pause while the tab is hidden, resume + refresh when it becomes visible
 * again. `tick` is read through a ref so interval identity never churns
 * when react-i18next hands back a fresh callback (documented flake trap).
 */
export function useShellPolling(tick: () => void, intervalMs: number): void {
  const tickRef = useRef(tick);
  tickRef.current = tick;

  useEffect(() => {
    let timer: number | undefined;
    const run = () => tickRef.current();
    const start = () => {
      if (timer !== undefined) return;
      run();
      timer = window.setInterval(run, intervalMs);
    };
    const stop = () => {
      if (timer === undefined) return;
      window.clearInterval(timer);
      timer = undefined;
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') start();
      else stop();
    };
    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [intervalMs]);
}

export function useNavBadges(): NavBadges {
  const { t, i18n } = useTranslation();
  // DE-2: state is locale-independent RAW data only (count + coverage); the
  // display/aria strings are derived at render time below, so a mid-session
  // language switch re-renders every badge in the active locale immediately
  // instead of waiting for the next poll tick or a remount.
  const [readings, setReadings] = useState<NavBadgeReadings>(EMPTY_NAV_BADGE_READINGS);
  const generationRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const refresh = useCallback(() => {
    // Supersede any in-flight pass: abort the signal-taking sources and bump
    // the generation so an already-settled getOrderCounts answer is dropped.
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const generation = ++generationRef.current;

    void Promise.allSettled([
      getOrderCounts(),
      getNeedsReplyCount(controller.signal),
      getStockExceptions(controller.signal),
    ]).then(([orderResult, replyResult, stockResult]) => {
      if (generation !== generationRef.current || controller.signal.aborted) return;

      const ordersReading: CountReading | null =
        orderResult.status === 'fulfilled'
          // Bucket counts are exact server numbers — full coverage.
          ? { count: orderResult.value.needs_action, coverageComplete: true }
          : null;
      const inboxReading: CountReading | null =
        replyResult.status === 'fulfilled'
          ? { count: replyResult.value.count, coverageComplete: replyResult.value.coverageComplete }
          : null;
      const productsReading: CountReading | null =
        stockResult.status === 'fulfilled'
          // D2: exceptions = outOfStock + lowStock, disjoint by construction.
          ? { count: stockResult.value.exceptions, coverageComplete: stockResult.value.coverageComplete }
          : null;

      // Raw structured readings — no locale strings stored (DE-2).
      setReadings({
        orders: ordersReading,
        inbox: inboxReading,
        products: productsReading,
      });
    });
  }, []);

  useShellPolling(refresh, SHELL_POLL_MS);

  useEffect(() => () => {
    generationRef.current += 1;
    abortRef.current?.abort();
  }, []);

  // DERIVE at render time: react-i18next re-renders this hook on
  // languageChanged, so `language`/`numberFormat`/`t` all track the active
  // locale immediately; honesty rules (null/0 → no badge, 99+/N+ caps, bn
  // Intl numerals) live in the pure buildNavBadge mapping, unchanged.
  const language = i18n?.resolvedLanguage || i18n?.language || 'en';
  const numberFormat = useMemo(
    () => new Intl.NumberFormat(
      language.toLowerCase().startsWith('bn') ? 'bn-BD' : 'en',
      { useGrouping: false },
    ),
    [language],
  );

  return useMemo<NavBadges>(
    () => ({
      orders: buildNavBadge(readings.orders, 'nav.badges.orders', t, numberFormat),
      inbox: buildNavBadge(readings.inbox, 'nav.badges.inbox', t, numberFormat),
      products: buildNavBadge(readings.products, 'nav.badges.products', t, numberFormat),
    }),
    [readings, t, numberFormat],
  );
}
