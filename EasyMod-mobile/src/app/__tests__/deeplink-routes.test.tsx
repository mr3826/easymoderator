import path from 'node:path';

import { router } from 'expo-router';
import { act, renderRouter, screen } from 'expo-router/testing-library';

import i18n from '@/i18n';
import { setAccessToken, __resetTokenStoreForTests } from '@/auth/token-store';
import { queryClient } from '@/lib/queryClient';
import { openDeepLink, __resetDeepLinkDedupeForTests } from '@/lib/deeplink';
import { __resetPendingDeepLinkForTests } from '@/lib/pending-deeplink';
import { redirectSystemPath } from '../+native-intent';
import {
  __resetDeepLinkResolverForTests,
  __setDeepLinkResolverForTests,
  type DeepLinkResolution,
} from '@/lib/deeplink-entity';

/**
 * End-to-end coverage for the deep-link entity routes (Phase 2, Lane 4 — deep-link routing +
 * security; ADR M-007 Phase 2 correction / decision D7), exercising the real
 * `app/order/[id].tsx` / `app/conversation/[id].tsx` route files plus `_layout.tsx`'s auth gating
 * through Expo Router's own file-based matching — not a mock of the routing layer.
 *
 * There is no live push system yet (Phase 2b is gated — see ADR M-007's "Required follow-up").
 * Rather than fabricate a Firebase payload, every "notification tap" below is simulated the way a
 * future tap handler actually would: build the same `order`/`conversation` + id pair ADR M-007's
 * `data.entity`/`data.id` payload carries, and drive it through `openDeepLink` — the exact
 * function `@/lib/deeplink.ts` documents as "the single place a future notification-tap handler
 * (Phase 2b) should call to open a deep link."
 *
 * Every test below renders the full app root at `/` and waits for the signed-in Home tab before
 * simulating a tap — never a raw `initialUrl` straight into `order/[id]`/`conversation/[id]`.
 * That is deliberate, not incidental: `_layout.tsx`'s signed-in-only screens don't exist in the
 * navigator until `status` resolves from `'loading'`, so `renderRouter`'s one-shot `initialUrl`
 * resolution — which runs before that — has nothing to attach a direct deep-link URL to and
 * silently falls back to Home once the Stack finally mounts (a real "protected route direct deep
 * link" race, not a test artifact — confirmed by reproducing it against the actual `_layout.tsx`).
 * Fixing that race is a `_layout.tsx`/auth-bootstrap architecture change outside this lane's
 * scope (and, worse, touching it surfaced a second, unrelated pre-existing issue: `renderRouter`'s
 * test harness doesn't exclude `__tests__/*.test.ts(x)` files from its route discovery the way a
 * real Metro build does, so making the Stack eagerly resolve every sibling route on mount ends up
 * `require()`-ing test files as if they were screens). `openDeepLink` is the one real, working,
 * already-wired entry point for a tap arriving after the app is up — exactly what Phase 2b's tap
 * handler will call — so every test here drives through it, still against the real route files and
 * real navigator, without depending on the separately-broken cold-launch path.
 */
const APP_ROOT = path.resolve(__dirname, '..');

// `renderRouter` engages Jest fake timers, but the underlying auth-bootstrap and query promise
// chains still take real wall-clock CPU time to run; a generous test timeout keeps this suite
// reliable under heavy machine load without masking a genuine hang.
jest.setTimeout(30_000);

beforeEach(() => {
  // Matches the repo's existing reset convention (`auth-client.test.ts`): put every test-only
  // escape hatch back to its default *before* each test runs, so test order never matters.
  __resetTokenStoreForTests();
  __resetDeepLinkResolverForTests();
  __resetDeepLinkDedupeForTests();
  // `_layout.tsx` provides the app's one `queryClient` singleton (not a fresh instance per test),
  // so a cached `['deeplink', kind, id]` result from one test would otherwise silently serve a
  // later test's differently-configured resolver for the same id.
  queryClient.clear();

  // Every route here lives behind `_layout.tsx`'s `Stack.Protected guard={status === 'signedIn'}`
  // — a deep link opened while signed out must land on login first (untested here; that's the
  // auth lane's own coverage), so every test in *this* file starts from a real signed-in state
  // rather than reaching the entity screens some other way.
  setAccessToken('test-access-token');
});

describe('correct shop resolved', () => {
  it('opens normally for an entity belonging to the signed-in user\'s current shop', async () => {
    __setDeepLinkResolverForTests(async (_kind, id) => ({ kind: 'found', id }));
    renderRouter(APP_ROOT, { initialUrl: '/' });
    await screen.findByText(i18n.t('mobile.tabs.home'));

    await act(async () => {
      openDeepLink('order', 'order-42');
    });

    expect(await screen.findByText(i18n.t('mobile.deeplink.order.foundTitle'))).toBeTruthy();
    expect(screen.getByText(i18n.t('mobile.deeplink.order.foundBody', { id: 'order-42' }))).toBeTruthy();
  });

  it('opens normally for a conversation too', async () => {
    __setDeepLinkResolverForTests(async (_kind, id) => ({ kind: 'found', id }));
    renderRouter(APP_ROOT, { initialUrl: '/' });
    await screen.findByText(i18n.t('mobile.tabs.home'));

    await act(async () => {
      openDeepLink('conversation', 'convo-42');
    });

    expect(await screen.findByText(i18n.t('mobile.deeplink.conversation.foundTitle'))).toBeTruthy();
    expect(
      screen.getByText(i18n.t('mobile.deeplink.conversation.foundBody', { id: 'convo-42' })),
    ).toBeTruthy();
  });
});

describe('unauthorized shop blocked', () => {
  it('shows the generic "not available" state for an id in a shop the user cannot access', async () => {
    const resolution: DeepLinkResolution = { kind: 'unavailable' };
    __setDeepLinkResolverForTests(async () => resolution);

    renderRouter(APP_ROOT, { initialUrl: '/' });
    await screen.findByText(i18n.t('mobile.tabs.home'));

    await act(async () => {
      openDeepLink('order', 'other-shops-order');
    });

    expect(await screen.findByText(i18n.t('mobile.deeplink.unavailable.title'))).toBeTruthy();
    expect(screen.getByText(i18n.t('mobile.deeplink.unavailable.message'))).toBeTruthy();

    // Never the "found" content, and never the requested id anywhere in the rendered text — an
    // id that resolves to another shop must not be distinguishable from one that never existed.
    expect(screen.queryByText(i18n.t('mobile.deeplink.order.foundTitle'))).toBeNull();
    expect(screen.queryByText(/other-shops-order/)).toBeNull();
  });
});

describe('stale/deleted entity handled safely', () => {
  it('shows the same "unavailable" state for a nonexistent/removed id — never a crash or blank screen', async () => {
    const resolution: DeepLinkResolution = { kind: 'unavailable' };
    __setDeepLinkResolverForTests(async () => resolution);

    renderRouter(APP_ROOT, { initialUrl: '/' });
    await screen.findByText(i18n.t('mobile.tabs.home'));

    await act(async () => {
      openDeepLink('conversation', 'deleted-convo');
    });

    // Byte-identical to the wrong-shop case above (same i18n keys, same `UnavailableBody`
    // component, no kind/id ever threaded into that branch) — that identity, not merely "some
    // error text appears", is what stops the screen state from being used to probe whether an id
    // exists in another shop versus never having existed at all.
    expect(await screen.findByText(i18n.t('mobile.deeplink.unavailable.title'))).toBeTruthy();
    expect(screen.getByText(i18n.t('mobile.deeplink.unavailable.message'))).toBeTruthy();
    expect(screen.queryByText(i18n.t('mobile.deeplink.conversation.foundTitle'))).toBeNull();
  });

  it('never crashes and never renders a blank screen while resolution is still pending', async () => {
    // A resolver that never settles during the assertion window stands in for "still loading" —
    // the screen must show the loading state, not throw or render nothing.
    __setDeepLinkResolverForTests(() => new Promise(() => {}));

    renderRouter(APP_ROOT, { initialUrl: '/' });
    await screen.findByText(i18n.t('mobile.tabs.home'));

    await act(async () => {
      openDeepLink('order', 'still-loading');
    });

    expect(await screen.findByTestId('deeplink-loading')).toBeTruthy();
  });
});

describe('duplicate tap remains idempotent', () => {
  it('driving the same deep-link twice in quick succession causes no duplicate navigation, network call, or glitch', async () => {
    const resolverSpy = jest.fn(async (): Promise<DeepLinkResolution> => ({ kind: 'found', id: 'order-99' }));
    __setDeepLinkResolverForTests(resolverSpy);

    const rendered = renderRouter(APP_ROOT, { initialUrl: '/' });

    // The imperative `router` has nothing to act on until the signed-in app shell has actually
    // mounted (status starts at 'loading' while the auth bootstrap effect runs) — wait for Home
    // before simulating a tap, exactly as a real notification tap could only ever arrive once the
    // app is up.
    await screen.findByText(i18n.t('mobile.tabs.home'));

    // Two "notification taps" for the same order, milliseconds apart — exactly what a duplicate
    // FCM redelivery or a double tap on the same notification produces. `openDeepLink` (not
    // `router.push` directly) is the real entry point a future tap handler calls.
    await act(async () => {
      openDeepLink('order', 'order-99');
      openDeepLink('order', 'order-99');
    });

    expect(await screen.findByText(i18n.t('mobile.deeplink.order.foundTitle'))).toBeTruthy();
    // No visible glitch: exactly one copy of the screen's content, not two overlaid/duplicated.
    expect(screen.getAllByText(i18n.t('mobile.deeplink.order.foundTitle'))).toHaveLength(1);
    // No duplicate network call: the resolver backing the query ran exactly once.
    expect(resolverSpy).toHaveBeenCalledTimes(1);
    // No duplicate navigation: only one stack entry was pushed — going back once returns all the
    // way to where the taps originated, not through a second identical order screen.
    expect(rendered.getPathname()).toBe('/order/order-99');
    await act(async () => {
      router.back();
    });
    expect(rendered.getPathname()).toBe('/');
    expect(router.canGoBack()).toBe(false);
  });

  it('a later, deliberate re-open of the same item after the window elapses is not treated as a duplicate', async () => {
    const resolverSpy = jest.fn(async (): Promise<DeepLinkResolution> => ({ kind: 'found', id: 'order-100' }));
    __setDeepLinkResolverForTests(resolverSpy);

    renderRouter(APP_ROOT, { initialUrl: '/' });
    await screen.findByText(i18n.t('mobile.tabs.home'));

    await act(async () => {
      openDeepLink('order', 'order-100');
    });
    expect(await screen.findByText(i18n.t('mobile.deeplink.order.foundTitle'))).toBeTruthy();

    await act(async () => {
      router.back();
    });

    // Real time, not the dedupe window's synthetic clock — this is a genuinely later, separate
    // open of the same item (e.g. the merchant tapped the same order card again), which must
    // still navigate.
    let opened = false;
    await act(async () => {
      opened = openDeepLink('order', 'order-100', Date.now() + 60_000);
    });
    expect(opened).toBe(true);
  });
});

// Audit P1-5: the cold-launch race described at the top of this file. `+native-intent.ts` parks
// the inbound link and routes Home; `_layout.tsx` replays it through `openDeepLink` once auth has
// resolved, so these tests start exactly where the native layer leaves off.
describe('inbound links that arrive before the signed-in shell exists', () => {
  beforeEach(() => {
    __resetPendingDeepLinkForTests();
  });

  it('opens a cold-launch entity link after auth bootstrap instead of falling back to Home', async () => {
    __setDeepLinkResolverForTests(async (_kind, id) => ({ kind: 'found', id }));
    expect(redirectSystemPath!({ path: 'easymodmerchantdev://order/order-cold', initial: true })).toBe('/');

    const rendered = renderRouter(APP_ROOT, { initialUrl: '/' });

    expect(await screen.findByText(i18n.t('mobile.deeplink.order.foundTitle'))).toBeTruthy();
    expect(rendered.getPathname()).toBe('/order/order-cold');
  });

  it('keeps a link that arrives while signed out and opens it only after sign-in', async () => {
    __setDeepLinkResolverForTests(async (_kind, id) => ({ kind: 'found', id }));
    act(() => setAccessToken(null));
    expect(redirectSystemPath!({ path: '/conversation/convo-after-login', initial: true })).toBe('/');

    const rendered = renderRouter(APP_ROOT, { initialUrl: '/' });
    expect(await screen.findByTestId('login-submit')).toBeTruthy();
    expect(screen.queryByText(i18n.t('mobile.deeplink.conversation.foundTitle'))).toBeNull();

    await act(async () => {
      setAccessToken('signed-in-after-link');
    });

    expect(await screen.findByText(i18n.t('mobile.deeplink.conversation.foundTitle'))).toBeTruthy();
    expect(rendered.getPathname()).toBe('/conversation/convo-after-login');
  });

  it('opens a link that arrives while the signed-in app is already running (warm link)', async () => {
    __setDeepLinkResolverForTests(async (_kind, id) => ({ kind: 'found', id }));
    const rendered = renderRouter(APP_ROOT, { initialUrl: '/' });
    await screen.findByText(i18n.t('mobile.tabs.home'));

    // Expo Router's order for a warm link (build/link/linking.js): it awaits redirectSystemPath,
    // and only then navigates to the path it returned. Parking the link commits React (and the
    // replay effect) first, so the replay must not be undone by that later navigation to `/`.
    let href: string | null = null;
    act(() => {
      href = redirectSystemPath!({ path: 'easymodmerchantdev://order/order-warm', initial: false }) as string;
    });
    expect(href).toBe('/');
    act(() => {
      router.navigate(href!);
    });

    expect(await screen.findByText(i18n.t('mobile.deeplink.order.foundTitle'))).toBeTruthy();
    expect(rendered.getPathname()).toBe('/order/order-warm');
  });
});
