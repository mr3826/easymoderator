/**
 * Delivery-settings guardrails proof (mock-only, CI subset). Three-tab
 * Configuration/editor surface (§5.6/§5.9/§29): execution header with no CTA,
 * tablist contract, provider lifecycle with the activation-409 → Pickup-TAB
 * routing (EDIT when the provider already has a row, CREATE only when none),
 * provider-first pickup stores (explicit link, never first-match),
 * DELIVERY_PICKUP_AMBIGUOUS explicit candidate selection, merchant-confirmed
 * external store create, safe-delete confirm round with LOCALIZED blocker
 * names, cache-derived mapping honesty (round 3): pickup_mapping_status is
 * derived from the server's cached store listing — an explicit LINK extends it
 * ({store_id, source:'link'} + stamp), a MATCHED/AMBIGUOUS sync or an Import
 * replaces it with the listing read, PRESERVED/NO_MATCH claim nothing, and a
 * wired store with NO cache at all is 'unknown' — never green, never silently
 * 'confirmed'. Charges save in-tab, AI-default election + clear,
 * type-to-confirm disconnect, per-provider capability honesty mirroring
 * EasyMod-backend/src/modules/delivery/provider-capabilities.js exactly. Allowlist+abort discipline: invented backend calls fail here; courier
 * provider hosts are always aborted. Responsive: 390px + 360px (pickup tab)
 * no-horizontal-overflow + five bottom-nav links; axe on `.em-delivery` across
 * all three tabs under reducedMotion.
 */
import { test, expect, type Page, type Route } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const mockUser = { id: 'user-1', full_name: 'Test Owner', email: 'owner@shop.bd' };
const mockShop = { id: 'shop-1', unique_code: 'SHOP1', shop_name: 'My BD Shop', role: 'owner' };
const json = (data: unknown) => ({ success: true, data });

// Fixed stamp for every server cache write (deterministic Intl rendering).
const SYNC_STAMP = '2026-11-25T10:00:00.000Z';

// Round 3 (§A9): the capability table is PER PROVIDER — mirror
// EasyMod-backend/src/modules/delivery/provider-capabilities.js exactly. The
// shipped truth differs per courier; a shared fixture would lie.
const impl = () => ({ level: 'IMPLEMENTED_NOT_LIVE_VERIFIED' });
const unsupported = (reason: string, manual: string) => ({ level: 'UNSUPPORTED', reason_code: reason, manual_step_code: manual });
const capabilitiesFor = (provider: string) => {
    if (provider === 'steadfast') {
        return {
            version: 1,
            ceiling: 'IMPLEMENTED_NOT_LIVE_VERIFIED',
            // Steadfast books by text address — coverage cannot be answered.
            coverage: { level: 'UNKNOWN', reason_code: 'TEXT_ONLY_COVERAGE', manual_step_code: null },
            rate_quote: unsupported('NO_PROVIDER_API', 'RATE_SHOWN_AFTER_BOOKING'),
            create_parcel: impl(),
            tracking: impl(),
            cancel: unsupported('NO_PROVIDER_API', 'CANCEL_IN_PROVIDER_PORTAL'),
            edit: unsupported('NO_PROVIDER_API', 'EDIT_IN_PROVIDER_PORTAL'),
            settlement: impl(),
            // No store endpoints at all: pickup is always manual.
            pickup_store: unsupported('NO_PICKUP_STORE_API', 'CONFIGURE_PICKUP_MANUALLY'),
            last_verified_at: null,
        };
    }
    if (provider === 'redx') {
        return {
            version: 1,
            ceiling: 'IMPLEMENTED_NOT_LIVE_VERIFIED',
            coverage: impl(),
            rate_quote: impl(),
            create_parcel: impl(),
            tracking: impl(),
            cancel: impl(),
            edit: impl(),
            settlement: { level: 'UNKNOWN', reason_code: 'PAID_STATUS_DISCARDED', manual_step_code: 'RECONCILE_IN_PROVIDER_PORTAL' },
            pickup_store: { level: 'IMPLEMENTED_NOT_LIVE_VERIFIED', reason_code: 'ADAPTER_CONTRACT_UNVERIFIED' },
            last_verified_at: null,
        };
    }
    // pathao
    return {
        version: 1,
        ceiling: 'IMPLEMENTED_NOT_LIVE_VERIFIED',
        coverage: impl(),
        rate_quote: impl(),
        create_parcel: impl(),
        tracking: impl(),
        cancel: unsupported('NO_PROVIDER_API', 'CANCEL_IN_PROVIDER_PORTAL'),
        edit: unsupported('NO_PROVIDER_API', 'EDIT_IN_PROVIDER_PORTAL'),
        settlement: unsupported('NO_PAYOUT_API', 'RECONCILE_IN_PROVIDER_PORTAL'),
        pickup_store: impl(),
        last_verified_at: null,
    };
};

const providerStatus = (provider: string, overrides: Record<string, unknown> = {}) => ({
    provider,
    display_name: `${provider.charAt(0).toUpperCase()}${provider.slice(1)} Courier`,
    is_connected: false,
    is_active: false,
    is_sandbox: false,
    metadata: {},
    last_validated_at: null,
    connected_at: null,
    capabilities: capabilitiesFor(provider),
    ...overrides,
});

const settings = {
    default_delivery_charge: 60,
    cod_enabled: false,
    cod_charge: 0,
    non_refundable: false,
    area_pricing: [],
    weight_tiers: [],
};

const defaultLocations = () => ([
    {
        id: 'loc-a', display_name: 'HQ Warehouse', contact_name: 'Test Owner', phone: '01711000000',
        address: 'House 1, Dhanmondi', area_name: 'Dhanmondi', city_name: 'Dhaka', zone_name: 'Zone 1',
        provider: 'manual', provider_store_id: null, is_active: true, is_default: true, metadata: {},
    },
    {
        id: 'loc-b', display_name: 'North Hub', contact_name: 'Staff', phone: '01711000001',
        address: 'Road 9, Gulshan', area_name: 'Gulshan', city_name: 'Dhaka', zone_name: 'Zone 2',
        provider: 'pathao', provider_store_id: 's2', is_active: true, is_default: false, metadata: {},
    },
]);

const KNOWN_PATHS = new Set([
    '/api/csrf', '/api/auth/me', '/api/auth/signin', '/api/setup/status', '/api/subscription',
    '/api/notifications/in-app', '/api/commercial/claims', '/api/public/commercial-contract',
    '/api/shop/delivery/settings', '/api/shop/delivery/pickup-locations',

    // A6 W3: Phase 1 shell/dashboard read sources (D1 badges, D6 chip, D7 readiness).
    '/api/order/counts', '/api/conversation/needs-reply-count', '/api/product/stock-exceptions', '/api/shop/delivery/readiness', '/api/channels/meta',
]);
const KNOWN_PATTERNS = [
    /^\/api\/shop\/delivery\/(connect|disconnect|test|activate|deactivate|ai-default)$/,
    // Redesign (2026-11-25): pickup tab endpoints — must stay in lockstep with
    // src/api/domains/order.ts. Any NEW client call failing here needs a pattern.
    /^\/api\/shop\/delivery\/pickup-locations\/[\w-]+$/,                 // GET/PUT/PATCH/DELETE (:id) — DELETE may carry ?confirm=true
    /^\/api\/shop\/delivery\/pickup-locations\/[\w-]+\/default$/,        // POST/PUT set-default
    /^\/api\/shop\/delivery\/[\w-]+\/pickup$/,                           // POST/PUT explicit link (setProviderPickup)
    /^\/api\/shop\/delivery\/[\w-]+\/pickup\/store$/,                    // POST merchant-confirmed external create
    /^\/api\/shop\/delivery\/[\w-]+\/stores$/,                           // GET provider store list
    /^\/api\/shop\/delivery\/[\w-]+\/stores\/sync$/,                     // GET/POST selective import/upsert
    /^\/api\/shop\/delivery\/[\w-]+\/ai-default$/,                       // POST set / DELETE clear (per-provider form)
    /^\/api\/shop\/delivery\/[\w-]+\/pickup\/sync$/,
    /^\/api\/shop\/delivery\/pathao\/cities$/,
    /^\/api\/shop\/delivery\/pathao\/cities\/[\w-]+\/zones$/,
    /^\/api\/shop\/delivery\/pathao\/zones\/[\w-]+\/areas$/,
    /^\/api\/shop\/delivery\/[\w-]+\/areas$/,
    /^\/api\/notifications\/in-app\/[\w-]+\/read$/,
];

type RouteState = Awaited<ReturnType<typeof setupRoutes>>;

async function setupRoutes(page: Page, options: {
    providers?: unknown[];
    locations?: unknown[];
    settings?: Record<string, unknown>;
    /** 'explicit' → POST /:provider/pickup succeeds; 'ambiguous' → 409 with candidates. */
    linkMode?: 'explicit' | 'ambiguous';
    /** 'unmatched' → POST /:provider/stores/sync answers 409 DELIVERY_STORE_IDS_UNMATCHED. */
    syncMode?: 'ok' | 'unmatched';
    /** true → a CONFIRMED delete (default/in-use rows) still answers 409: the open dialog must keep blockers. */
    deleteBlockAfterConfirm?: boolean;
    /** Per-provider override of the courier's live store listing (default: two SAME-AREA pathao stores). */
    stores?: Record<string, Array<{ store_id: string; store_name?: string; address?: string; city_id?: number; zone_id?: number; area_id?: number }>>;
    /**
     * Round 3 (§A9): seed of integration.metadata.stores — the SERVER-side cached
     * listing pickup_mapping_status is computed against on GET /settings. Seeded
     * ids arrive as full-listing entries (no 'link' source). Absent = never
     * cached → a wired store derives 'unknown', NEVER confirmed/stale.
     */
    cache?: Record<string, string[]>;
} = {}) {
    const state = {
        signedIn: false,
        unexpected: [] as string[],
        activates: 0,
        disconnects: 0,
        aiDefaults: 0,
        aiDefaultClears: 0,
        pickupPosts: 0,
        pickupPuts: 0,
        pickupPutBodies: [] as Record<string, unknown>[],
        syncs: 0,
        syncBodies: [] as Record<string, unknown>[],
        linkBodies: [] as Record<string, unknown>[],
        storesGets: [] as string[],
        storesSyncs: [] as Record<string, unknown>[],
        createStoreBodies: [] as Record<string, unknown>[],
        deleteAttempts: [] as { path: string; search: string; confirmed: boolean }[],
        // Round 3 (§A9): the cached store listing is the authority for
        // pickup_mapping_status — empty/absent = NEVER cached → 'unknown'.
        // Entry shape mirrors integration.metadata.stores:
        // { store_id, source?: 'link' } (source:'link' = proved by an explicit
        // LINK / store-explicit sync; no source = came from a listing read).
        storesCache: Object.fromEntries(
            Object.entries(options.cache ?? {}).map(([provider, ids]) => [provider, ids.map((store_id) => ({ store_id }))]),
        ) as Record<string, Array<{ store_id: string; source?: string }>>,
        // Per-provider stamp of the last cache write (surfaces as
        // pickup_stores_synced_at on GET /settings).
        syncedAt: {} as Record<string, string>,
        defaultPosts: [] as string[],
        settingsPuts: [] as Record<string, unknown>[],
        linkMode: options.linkMode ?? 'explicit',
        syncMode: options.syncMode ?? 'ok',
        deleteBlockAfterConfirm: options.deleteBlockAfterConfirm ?? false,
        providers: options.providers ?? [providerStatus('pathao'), providerStatus('steadfast'), providerStatus('redx')],
        locations: (options.locations ?? defaultLocations()) as Record<string, unknown>[],
        settings: options.settings ?? settings,
    };
    // --- Round 3 (§A9) cache simulator (mirrors delivery.service writers of
    // integration.metadata.stores). GET /:provider/stores NEVER calls these. ---
    const upsertCache = (provider: string, storeId: string, source?: 'link') => {
        const existing = state.storesCache[provider] ?? [];
        if (!existing.some((store) => store.store_id === storeId)) {
            existing.push(source ? { store_id: storeId, source } : { store_id: storeId });
        }
        state.storesCache[provider] = existing;
        state.syncedAt[provider] = SYNC_STAMP;
    };
    const replaceCache = (provider: string, listing: Array<{ store_id: string }>) => {
        state.storesCache[provider] = listing.map((store) => ({ store_id: store.store_id }));
        state.syncedAt[provider] = SYNC_STAMP;
    };
    /**
     * The controller's GET /settings derivation: a wired store with an EMPTY
     * cache is 'unknown' (no comparison possible); with a cache it is
     * 'confirmed' iff the id is in it, else 'stale'. Unwired → null. NEVER
     * derived from wiring alone.
     */
    const derivedMapping = (p: Record<string, unknown>): string | null => {
        const wired = p.provider_store_id;
        if (wired === undefined || wired === null || String(wired) === '') return null;
        const cache = state.storesCache[String(p.provider)] ?? [];
        if (cache.length === 0) return 'unknown';
        return cache.some((store) => store.store_id === String(wired)) ? 'confirmed' : 'stale';
    };
    await page.route((url) => url.pathname.startsWith('/api/'), async (route: Route) => {
        const request = route.request();
        const url = new URL(request.url());
        const path = url.pathname;
        const method = request.method();
        const known = KNOWN_PATHS.has(path) || KNOWN_PATTERNS.some((p) => p.test(path));
        if (!known) {
            state.unexpected.push(`${method} ${path}`);
            return route.abort();
        }
        const body = (request.postDataJSON() || {}) as Record<string, unknown>;
        const ok = (data: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(json(data)) });

        if (path === '/api/order/counts' && method === 'GET') {
            return ok({ to_confirm: 0, to_pack: 0, booked: 0, in_transit: 0, needs_action: 0, returned: 0, delivered: 0, total: 0 });
        }
        if (path === '/api/conversation/needs-reply-count' && method === 'GET') {
            return ok({ count: 0, scanned: 0, cap: 200, coverageComplete: true, generated_at: '2026-01-01T00:00:00.000Z' });
        }
        if (path === '/api/product/stock-exceptions' && method === 'GET') {
            return ok({ outOfStock: 0, lowStock: 0, exceptions: 0, scanned: 0, cap: 1000, coverageComplete: true, generated_at: '2026-01-01T00:00:00.000Z' });
        }
        if (path === '/api/shop/delivery/readiness' && method === 'GET') {
            return ok({ provider: null, ready: false, connected: false, active: false, credentials_configured: false, provider_store_id: null, provider_store_count: 0, pickup_location_configured: false, pickup_enabled: false, pickup_summary: null, provider_pickup_meta: {}, pickup_locations_count: 0, missing: ['provider_not_connected'], missing_fields: ['provider_not_connected'], status: 'SETUP_INCOMPLETE', providers: [] });
        }
        if (path === '/api/channels/meta' && method === 'GET') return ok([]);

        if (path === '/api/csrf') return ok({ csrfToken: 'csrf-test' });
        if (path === '/api/auth/me') {
            if (!state.signedIn) return route.fulfill({ status: 401, json: { success: false } });
            return ok({ user: mockUser, currentShop: mockShop, allShops: [mockShop] });
        }
        if (path === '/api/auth/signin' && method === 'POST') {
            state.signedIn = true;
            return ok({ user: mockUser, currentShop: mockShop, allShops: [mockShop] });
        }
        if (path === '/api/setup/status') return ok({ complete: true });
        if (path === '/api/subscription') return ok({ plan: 'MERCHANT', status: 'active', contract: 'DELIVERED_ORDER' });
        if (path === '/api/commercial/claims') {
            const surface = url.searchParams.get('surface') ?? 'usage-banner';
            return ok({ surface, locale: 'en', contractVersion: '1.0.0', registryHash: `sha256:${'a'.repeat(64)}`, decisions: [] });
        }
        if (path === '/api/public/commercial-contract') {
            return ok({ contract_version: '1.0.0', contract_hash: `sha256:${'b'.repeat(64)}` });
        }
        if (path === '/api/notifications/in-app') return ok([]);

        if (path === '/api/shop/delivery/settings') {
            if (method === 'PUT') {
                state.settingsPuts.push(body);
                return ok(body);
            }
            // Round 3 (§A9): pickup_mapping_status + pickup_stores_synced_at are
            // COMPUTED from the cached listing on every read — static provider
            // overrides can never green the pill by themselves.
            return ok({
                providers: (state.providers as Record<string, unknown>[]).map((p) => ({
                    ...p,
                    pickup_mapping_status: derivedMapping(p),
                    pickup_stores_synced_at: state.syncedAt[String(p.provider)] ?? null,
                })),
                settings: state.settings,
                pickup_locations: state.locations,
            });
        }
        if (path === '/api/shop/delivery/activate' && method === 'POST') {
            state.activates += 1;
            const target = state.providers.find((p) => (p as { provider: string }).provider === body.provider) as Record<string, unknown>;
            if (state.activates === 1 && target && !target.setup_complete) {
                return route.fulfill({
                    status: 409,
                    contentType: 'application/json',
                    body: JSON.stringify({
                        success: false,
                        error: { code: 'DELIVERY_NOT_READY', details: { missing: ['pickup_not_enabled', 'pickup_location_not_configured'] }, reason: 'pickup_profile_required' },
                    }),
                });
            }
            if (target) {
                target.is_active = true;
                target.activation_status = 'ACTIVE';
                target.setup_complete = true;
            }
            return ok({ provider: body.provider, activation_status: 'ACTIVE' });
        }
        if (path === '/api/shop/delivery/ai-default' && method === 'POST') {
            state.aiDefaults += 1;
            state.providers = (state.providers as Record<string, unknown>[]).map((p) => ({ ...p, is_ai_default: p.provider === body.provider }));
            return ok({ provider: body.provider });
        }
        if (/^\/api\/shop\/delivery\/([\w-]+)\/ai-default$/.test(path) && method === 'DELETE') {
            state.aiDefaultClears += 1;
            const provider = /([\w-]+)\/ai-default$/.exec(path)?.[1];
            state.providers = (state.providers as Record<string, unknown>[]).map((p) => ({ ...p, is_ai_default: p.provider !== provider && p.is_ai_default === true }));
            return ok({ cleared: true });
        }
        if (path === '/api/shop/delivery/ai-default' && method === 'DELETE') {
            state.aiDefaultClears += 1;
            state.providers = (state.providers as Record<string, unknown>[]).map((p) => ({ ...p, is_ai_default: false }));
            return ok({ cleared: true });
        }
        if (path === '/api/shop/delivery/disconnect' && method === 'POST') {
            state.disconnects += 1;
            state.providers = (state.providers as Record<string, unknown>[]).map((p) => (
                p.provider === body.provider
                    ? { ...p, is_connected: false, is_active: false, activation_status: 'NOT_CONFIGURED', is_ai_default: false }
                    : p
            ));
            return ok({ disconnected: true });
        }
        if (path === '/api/shop/delivery/test' && method === 'POST') {
            const target = state.providers.find((p) => (p as { provider: string }).provider === body.provider) as Record<string, unknown>;
            if (target) target.last_validated_at = '2026-11-25T10:00:00.000Z';
            return ok({ valid: true });
        }
        if (path === '/api/shop/delivery/pickup-locations' && method === 'POST') {
            state.pickupPosts += 1;
            const created = { id: 'pickup-new', is_active: true, is_default: false, metadata: {}, ...body };
            state.locations = [...state.locations, created];
            return ok(created, 201);
        }
        if (path === '/api/shop/delivery/pickup-locations' && method === 'PUT') {
            // The redesign's LOCAL row update (deep-link EDIT path): id travels in
            // the body (PUT /pickup-locations alias), never a blind create.
            state.pickupPuts += 1;
            state.pickupPutBodies.push(body);
            state.locations = state.locations.map((l) => (l.id === body.id ? { ...l, ...body } : l));
            return ok(state.locations.find((l) => l.id === body.id) ?? { ...body });
        }
        if (path === '/api/shop/delivery/pickup-locations' && method === 'GET') {
            return ok(state.locations);
        }
        // Pickup-location :id routes (order matters: more specific default first).
        const defaultMatch = /^\/api\/shop\/delivery\/pickup-locations\/([\w-]+)\/default$/.exec(path);
        if (defaultMatch && (method === 'POST' || method === 'PUT')) {
            state.defaultPosts.push(defaultMatch[1]);
            state.locations = state.locations.map((l) => ({ ...l, is_default: l.id === defaultMatch[1] }));
            return ok(state.locations.find((l) => l.id === defaultMatch[1]));
        }
        const locationMatch = /^\/api\/shop\/delivery\/pickup-locations\/([\w-]+)$/.exec(path);
        if (locationMatch && method === 'DELETE') {
            const confirmed = url.searchParams.get('confirm') === 'true';
            state.deleteAttempts.push({ path, search: url.search, confirmed });
            if (!confirmed) {
                // Defensive only: the redesign UI NEVER fires DELETE without the
                // merchant confirming in the dialog (every call carries ?confirm=true).
                return route.fulfill({
                    status: 409,
                    contentType: 'application/json',
                    body: JSON.stringify({
                        success: false,
                        message: 'Pickup location is in use. Confirm the deletion to continue.',
                        code: 'PICKUP_LOCATION_DELETE_CONFIRMATION_REQUIRED',
                        details: {
                            location_id: locationMatch[1],
                            requires_confirmation: true,
                            blockers: [
                                { code: 'IS_SHOP_DEFAULT', message: 'This is the shop default pickup location. Choose another default first.' },
                                { code: 'IN_USE', message: 'This pickup location is the selected pickup for a courier integration.', providers: ['pathao'] },
                            ],
                        },
                    }),
                });
            }
            if (state.deleteBlockAfterConfirm && locationMatch[1] === 'loc-a') {
                // Late conflict: state changed since the dialog opened.
                return route.fulfill({
                    status: 409,
                    contentType: 'application/json',
                    body: JSON.stringify({
                        success: false,
                        message: 'Pickup location is in use. Confirm the deletion to continue.',
                        code: 'PICKUP_LOCATION_DELETE_CONFIRMATION_REQUIRED',
                        details: {
                            location_id: locationMatch[1],
                            requires_confirmation: true,
                            blockers: [
                                { code: 'IS_SHOP_DEFAULT', message: 'This is the shop default pickup location. Choose another default first.' },
                                { code: 'IN_USE', message: 'This pickup location is the selected pickup for a courier integration.', providers: ['redx'] },
                            ],
                        },
                    }),
                });
            }
            state.locations = state.locations.filter((l) => l.id !== locationMatch[1]);
            return ok({ id: locationMatch[1], deleted: true, released_providers: ['pathao'] });
        }
        // Provider store workspace. GET is a PURE READ (§A8 contract round 2):
        // only the courier listing + capability — no pickup_locations, no upsert,
        // and NO cache write (§A9 round 3: reads never refresh metadata.stores).
        const defaultStores = (provider: string) => (provider === 'pathao'
            // Two SAME-AREA stores: the UI must let the merchant choose — never first-match.
            ? [
                { store_id: 's1', store_name: 'Dhanmondi Hub A', city_id: 1, zone_id: 10, area_id: 100 },
                { store_id: 's2', store_name: 'Dhanmondi Hub B', city_id: 1, zone_id: 10, area_id: 100 },
            ]
            : [{ store_id: 'r1', store_name: 'RedX Gulshan Point', city_id: 7, area_id: 9 }]);
        const knownStores = (provider: string) => options.stores?.[provider] ?? defaultStores(provider);
        const pureStoresRead = (provider: string) => ok({
            provider,
            stores: knownStores(provider),
            capability: 'IMPLEMENTED_NOT_LIVE_VERIFIED',
        });
        const storesMatch = /^\/api\/shop\/delivery\/([\w-]+)\/stores$/.exec(path);
        if (storesMatch && method === 'GET') {
            state.storesGets.push(storesMatch[1]);
            return pureStoresRead(storesMatch[1]);
        }
        const storesSyncMatch = /^\/api\/shop\/delivery\/([\w-]+)\/stores\/sync$/.exec(path);
        if (storesSyncMatch && method === 'GET') {
            // GET /:provider/stores/sync is ALSO a pure read (controller §A9):
            // no rows, no metadata, no stores_synced_at stamp.
            return pureStoresRead(storesSyncMatch[1]);
        }
        if (storesSyncMatch && method === 'POST') {
            state.storesSyncs.push({ provider: storesSyncMatch[1], ...body });
            const provider = storesSyncMatch[1];
            const listing = knownStores(provider);
            const requested = Array.isArray(body.store_ids) ? body.store_ids.map((v: unknown) => String(v)) : null;
            if (requested) {
                const unmatched = requested.filter((id: string) => !listing.some((s) => s.store_id === id));
                if (state.syncMode === 'unmatched' || unmatched.length > 0) {
                    return route.fulfill({
                        status: 409,
                        contentType: 'application/json',
                        body: JSON.stringify({
                            success: false,
                            message: 'Some requested store ids were not found at the provider',
                            code: 'DELIVERY_STORE_IDS_UNMATCHED',
                            details: { provider, unmatched_store_ids: state.syncMode === 'unmatched' ? requested : unmatched },
                        }),
                    });
                }
            }
            // Import upserts mirrored rows keyed by (shop, provider, store id) —
            // repeated imports never duplicate. Returns the imported subset + the
            // refreshed local list. A 409 above claimed NOTHING (no cache write);
            // success caches the FULL listing read + stamps stores_synced_at (§A9).
            const toImport = requested ? listing.filter((s) => requested.includes(s.store_id)) : listing;
            for (const store of toImport) {
                const rowId = `loc-${store.store_id}`;
                if (!state.locations.some((l) => l.id === rowId)) {
                    state.locations = [...state.locations, {
                        id: rowId, display_name: store.store_name ?? store.store_id, phone: '01711000002',
                        address: store.address ?? 'Provider address', area_name: 'Dhanmondi', provider,
                        provider_store_id: store.store_id, is_active: true, is_default: false, metadata: { synced_from_provider: true },
                    }];
                }
            }
            replaceCache(provider, listing);
            return ok({ provider, stores: toImport, pickup_locations: state.locations, capability: 'IMPLEMENTED_NOT_LIVE_VERIFIED' });
        }
        const storeCreateMatch = /^\/api\/shop\/delivery\/([\w-]+)\/pickup\/store$/.exec(path);
        if (storeCreateMatch && method === 'POST') {
            state.createStoreBodies.push({ provider: storeCreateMatch[1], ...body });
            return ok({ provider: storeCreateMatch[1], created: true, store: { store_id: 's-created', store_name: body.name }, pickup_locations: state.locations }, 201);
        }
        const pickupLinkMatch = /^\/api\/shop\/delivery\/([\w-]+)\/pickup$/.exec(path);
        if (pickupLinkMatch && (method === 'POST' || method === 'PUT')) {
            state.linkBodies.push({ provider: pickupLinkMatch[1], ...body });
            if (state.linkMode === 'ambiguous') {
                return route.fulfill({
                    status: 409,
                    contentType: 'application/json',
                    body: JSON.stringify({
                        success: false,
                        message: 'Multiple provider pickup stores match this location. Select the intended store explicitly.',
                        code: 'DELIVERY_PICKUP_AMBIGUOUS',
                        details: {
                            provider: pickupLinkMatch[1],
                            pickup_location_id: body.pickup_location_id ?? null,
                            candidates: [
                                { store_id: 'alpha', store_name: 'Alpha Store', city_id: 1, zone_id: 10 },
                                { store_id: 'beta', store_name: 'Beta Store', city_id: 1, zone_id: 11 },
                            ],
                        },
                    }),
                });
            }
            // Mirrors delivery.service setPickupConfiguration's real return
            // shape: store_resolution is a SYNC-only field, not present here.
            // §A9 round 3: a successful explicit LINK with a store_id EXTENDS the
            // cached listing with a { store_id, source:'link' } entry + stamps
            // stores_synced_at — the provider accepted configuration for that id,
            // which is live evidence it exists. The post-action reload then DERIVES
            // 'confirmed' from the cache; no status is ever written directly.
            const linked = (state.providers as Record<string, unknown>[]).find((p) => p.provider === pickupLinkMatch[1]);
            if (linked) {
                linked.pickup_enabled = true;
                if (body.store_id !== undefined && body.store_id !== null && body.store_id !== '') {
                    linked.provider_store_id = String(body.store_id);
                    upsertCache(pickupLinkMatch[1], String(body.store_id), 'link');
                }
                linked.pickup_location_id = body.pickup_location_id ?? linked.pickup_location_id ?? null;
            }
            return ok({ provider: pickupLinkMatch[1], pickup_enabled: true, pickup_store_id: body.store_id ?? null, pickup_location_id: body.pickup_location_id ?? null });
        }
        const syncMatch = /^\/api\/shop\/delivery\/([\w-]+)\/pickup\/sync$/.exec(path);
        if (syncMatch && method === 'POST') {
            const provider = syncMatch[1];
            state.syncs += 1;
            state.syncBodies.push(body);
            const target = state.providers.find((p) => (p as { provider: string }).provider === provider) as Record<string, unknown> | undefined;
            if (target) target.setup_complete = true;
            // §A9 round 3 — cache semantics of the sync that READS the listing
            // (delivery.service.syncProviderPickup):
            //  • explicit store_id           → LINKED: EXTENDS the cache with a
            //    { store_id, source:'link' } entry + stamps stores_synced_at.
            //  • exactly one geographic match → MATCHED: REPLACES the cache with
            //    the full listing read + stamps.
            //  • >1 match                     → AMBIGUOUS 409 with candidates: the
            //    listing WAS genuinely read → REPLACES the cache (truth refresh),
            //    but confirms nothing — the merchant must pick.
            //  • no match / stale mapping     → PRESERVED or NO_MATCH: claims
            //    NOTHING — the cache keeps its previous (stale) content, and
            //    GET /settings keeps deriving 'stale' from it.
            const listing = knownStores(provider);
            const cleanId = (value: unknown): string | null => (value === undefined || value === null || String(value) === '' ? null : String(value));
            const requested = cleanId(body.store_id);
            const locRow = body.pickup_location_id != null
                ? state.locations.find((l) => String(l.id) === String(body.pickup_location_id))
                : null;
            // Mirror the service's id precedence: request > persisted ROW id >
            // persisted INTEGRATION id (delivery.service.syncProviderPickup).
            let storeId = requested ?? cleanId(locRow?.provider_store_id) ?? cleanId(target?.provider_store_id);
            let resolution = requested !== null ? 'LINKED' : storeId !== null ? 'PRESERVED' : 'UNRESOLVED';
            if (requested === null && (provider === 'pathao' || provider === 'redx') && locRow) {
                const meta = (body.provider_pickup_meta ?? {}) as Record<string, unknown>;
                const metaKeys = (['city_id', 'zone_id', 'area_id'] as const).filter((key) => meta[key] !== undefined && meta[key] !== null && meta[key] !== '');
                const matches = metaKeys.length > 0
                    ? listing.filter((store) => metaKeys.every((key) => String((store as Record<string, unknown>)[key]) === String(meta[key])))
                    : [];
                if (matches.length > 1) {
                    replaceCache(provider, listing);
                    return route.fulfill({
                        status: 409,
                        contentType: 'application/json',
                        body: JSON.stringify({
                            success: false,
                            message: 'Multiple provider pickup stores match this location. Select the intended store explicitly.',
                            code: 'DELIVERY_PICKUP_AMBIGUOUS',
                            details: {
                                provider,
                                pickup_location_id: body.pickup_location_id ?? null,
                                candidates: matches.map((store) => ({ ...store })),
                            },
                        }),
                    });
                }
                if (matches.length === 1) {
                    storeId = matches[0].store_id;
                    resolution = 'MATCHED';
                    replaceCache(provider, listing);
                } else {
                    resolution = storeId !== null ? 'PRESERVED' : 'NO_MATCH';
                }
            }
            if (target) {
                if (requested !== null) upsertCache(provider, requested, 'link');
                if (storeId !== null) {
                    target.provider_store_id = storeId;
                    target.pickup_enabled = true;
                }
                if (body.pickup_location_id !== undefined && body.pickup_location_id !== null) {
                    target.pickup_location_id = body.pickup_location_id;
                }
            }
            return ok({ store_resolution: resolution, pickup_enabled: true });
        }
        if (path === '/api/shop/delivery/pathao/cities') {
            return ok({ cities: [{ id: 1, name: 'Dhaka' }] });
        }
        if (/^\/api\/shop\/delivery\/pathao\/cities\/[\w-]+\/zones$/.test(path)) {
            return ok({ zones: [{ id: 10, city_id: 1, name: 'Dhanmondi Zone' }] });
        }
        if (/^\/api\/shop\/delivery\/pathao\/zones\/[\w-]+\/areas$/.test(path)) {
            return ok({ areas: [{ id: 100, zone_id: 10, name: 'Dhanmondi' }] });
        }
        return ok([]);
    });
    await page.route((url) => /pathao|packzy|redx/i.test(url.hostname), (route) => route.abort());
    return state;
}

async function loginAndGo(page: Page) {
    await page.goto('/signin');
    await page.getByLabel(/email/i).fill('owner@shop.bd');
    await page.getByLabel(/password/i).fill('Password123!');
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL(/\/(dashboard|inbox)/);
    await page.goto('/manage-shop/delivery-settings');
}

async function openTab(page: Page, tab: 'providers' | 'pickup' | 'charges') {
    await page.getByTestId(`delivery-tab-${tab}`).click();
    if (tab === 'charges') await expect(page.getByTestId('charges-tab')).toBeVisible();
    if (tab === 'pickup') await expect(page.getByTestId('pickup-add-location')).toBeVisible();
}

async function expectNoOverflow(page: Page) {
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
}

test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
        window.localStorage.setItem('easymod_lang', 'en');
        window.localStorage.setItem('easymod:business-setup:default:complete-dismissed', '1');
        window.localStorage.setItem('easymod:business-setup:shop-1:complete-dismissed', '1');
    });
});

test('execution header: title + channel signal + pills, no header CTA', async ({ page }) => {
    const state = await setupRoutes(page);
    await loginAndGo(page);
    await expect(page.getByRole('heading', { name: 'Delivery Settings', exact: true })).toBeVisible();
    await expect(page.getByTestId('delivery-signal')).toContainText('Couriers need setup');
    await expect(page.getByTestId('dashboard-primary-action')).toHaveCount(0);
    expect(state.unexpected).toEqual([]);
});

test('tab shell: three tabs, single mounted panel, arrow-key roving focus', async ({ page }) => {
    const state = await setupRoutes(page);
    await loginAndGo(page);
    await expect(page.getByRole('tablist')).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Courier Providers' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tabpanel', { name: 'Courier Providers' })).toBeVisible();

    await openTab(page, 'pickup');
    await expect(page.getByRole('heading', { name: 'Pickup locations', exact: true }).first()).toBeVisible();
    await expect(page.getByRole('tabpanel', { name: 'Courier Providers' })).toHaveCount(0);

    await openTab(page, 'charges');
    await expect(page.getByText('Saves the general, area and weight settings on this page.').first()).toBeVisible();

    await page.getByTestId('delivery-tab-providers').focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId('delivery-tab-pickup')).toHaveAttribute('aria-selected', 'true');

    // Home/End (§18 roving tablist): End → last tab focused+selected, Home → first.
    await page.keyboard.press('End');
    await expect(page.getByTestId('delivery-tab-charges')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('delivery-tab-charges')).toBeFocused();
    await page.keyboard.press('Home');
    await expect(page.getByTestId('delivery-tab-providers')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('delivery-tab-providers')).toBeFocused();
    expect(state.unexpected).toEqual([]);
});

test('activation 409 from the drawer routes to the Pickup tab, then create → sync → explicit re-activate', async ({ page }) => {
    const state = await setupRoutes(page, {
        providers: [
            providerStatus('pathao', { is_connected: true, is_active: false, activation_status: 'SETUP_INCOMPLETE', missing: ['pickup_not_enabled', 'pickup_location_not_configured'] }),
            providerStatus('steadfast'),
            providerStatus('redx'),
        ],
        // No pathao-context row exists → the deep-link opens CREATE (never an
        // EDIT on a stranger's row, never a second duplicate row).
        locations: [defaultLocations()[0]],
        // One store matches the created area → sync resolves MATCHED honestly.
        stores: { pathao: [{ store_id: 's1', store_name: 'Dhanmondi Hub', city_id: 1, zone_id: 10, area_id: 100 }] },
    });
    await loginAndGo(page);
    await expect(page.getByTestId('activation-status-pathao')).toContainText('Setup incomplete');

    await page.getByTestId('manage-pathao').click();
    const drawer = page.getByRole('dialog', { name: 'Manage Pathao Courier' });
    await expect(drawer).toBeVisible();
    await drawer.getByTestId('drawer-activate-pathao').click();

    // 409 → the shell switches to the Pickup tab with the create form for pathao.
    await expect(page.getByTestId('delivery-tab-pickup')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('heading', { name: 'New Pathao pickup location' })).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    const form = page.getByTestId('pickup-form');
    await form.getByTestId('pickup-form-name').fill('Test Owner');
    await form.getByLabel(/^Pickup phone/i).fill('01711000000');
    await form.getByTestId('pickup-form-address').fill('House 10, Road 2, Dhanmondi, Dhaka');
    await form.getByRole('combobox', { name: 'City', exact: true }).selectOption('1');
    await expect(form.getByRole('combobox', { name: 'Zone', exact: true })).toBeEnabled();
    await form.getByRole('combobox', { name: 'Zone', exact: true }).selectOption('10');
    await expect(form.getByRole('combobox', { name: 'Area', exact: true })).toBeEnabled();
    await form.getByRole('combobox', { name: 'Area', exact: true }).selectOption('100');
    await form.getByTestId('pickup-form-save').click();

    await expect.poll(() => state.pickupPosts).toBe(1);
    await expect.poll(() => state.syncs).toBe(1);
    expect(state.pickupPuts).toBe(0);
    expect(state.syncBodies[0]).toEqual(expect.objectContaining({ pickup_location_id: 'pickup-new' }));
    expect(state.syncBodies[0].provider_pickup_meta).toEqual({ city_id: 1, zone_id: 10, area_id: 100 });

    // §A9: the single geographic match resolved MATCHED — the sync REPLACED the
    // cached listing with what it genuinely read and stamped the freshness.
    expect(state.storesCache.pathao).toEqual([{ store_id: 's1' }]);
    expect(state.syncedAt.pathao).toBe(SYNC_STAMP);

    // WHERE-NEXT: once the deep-link pickup step is server-confirmed, the tab
    // points back to Providers to finish activation (§A8 round 2).
    await expect(page.getByTestId('pickup-next-step')).toContainText('Pickup saved — return to Courier Providers to Activate.');

    // Activation is now a SEPARATE explicit merchant action (§ "never conflate").
    await openTab(page, 'providers');
    await page.getByTestId('manage-pathao').click();
    await page.getByTestId('drawer-activate-pathao').click();
    await expect.poll(() => state.activates).toBe(2);
    await expect(page.getByTestId('activation-status-pathao')).toContainText('Active');

    // Close the drawer (success feedback rendered inside it), then re-visit
    // Pickup — the deep-link was CONSUMED: without a new 409 the create form
    // must NOT auto-open again (shell clears pickupFocus via onFocusConsumed).
    await page.getByRole('dialog', { name: 'Manage Pathao Courier' }).getByRole('button', { name: 'Close' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await openTab(page, 'pickup');
    await expect(page.getByTestId('pickup-add-location')).toBeVisible();
    await expect(page.getByTestId('pickup-form')).toHaveCount(0);
    expect(state.unexpected).toEqual([]);
});

test('pickup stores: explicit link of a chosen store — the first match is never used', async ({ page }) => {
    const state = await setupRoutes(page, {
        providers: [providerStatus('pathao', { is_connected: true, is_active: true, activation_status: 'ACTIVE', setup_complete: true }), providerStatus('redx', { is_connected: true })],
    });
    await loginAndGo(page);
    await openTab(page, 'pickup');

    await page.getByTestId('pickup-fetch-stores-pathao').click();
    await expect(page.getByTestId('pickup-store-row-pathao-s1')).toBeVisible();
    await expect(page.getByTestId('pickup-store-row-pathao-s2')).toBeVisible();
    // Listing alone must not create anything external or link anything.
    expect(state.createStoreBodies).toHaveLength(0);
    expect(state.linkBodies).toHaveLength(0);
    // PURE READ: GET /:provider/stores never mirrors rows — the saved list is
    // untouched by a Fetch (the pickup_locations field is not even returned).
    expect(state.storesSyncs).toHaveLength(0);
    await expect(page.getByTestId('pickup-location-row-loc-a')).toBeVisible();
    await expect(page.getByTestId('pickup-location-row-loc-b')).toBeVisible();
    await expect(page.getByTestId('pickup-location-row-loc-s1')).toHaveCount(0);

    // Both stores share one area (#1 · 10 · 100): the merchant picks the SECOND.
    await expect(page.getByTestId('pickup-store-row-pathao-s1').getByText('#1 · 10 · 100')).toBeVisible();
    await expect(page.getByTestId('pickup-store-row-pathao-s2').getByText('#1 · 10 · 100')).toBeVisible();
    await page.getByTestId('pickup-store-link-pathao-s2').click();
    await expect.poll(() => state.linkBodies.length).toBe(1);
    expect(state.linkBodies[0]).toEqual(expect.objectContaining({
        provider: 'pathao',
        store_id: 's2',
        pickup_location_id: 'loc-a',
        enabled: true,
    }));
    // resolution absent on the wire → UI resolves the real `resolutions.LINKED`
    // key ("Linked to the selected store."), never a guessed first store.
    await expect(page.getByTestId('pickup-message-pathao')).toContainText('Linked to the selected store.');
    expect(state.createStoreBodies).toHaveLength(0);

    // IMPORT is a separate explicit action: the per-row Import sends THIS id
    // only, and only then does a mirrored local row appear.
    await page.getByTestId('pickup-store-import-pathao-s1').click();
    await expect.poll(() => state.storesSyncs.length).toBe(1);
    expect(state.storesSyncs[0]).toEqual(expect.objectContaining({ provider: 'pathao', store_ids: ['s1'] }));
    await expect(page.getByTestId('pickup-location-row-loc-s1')).toBeVisible();
    expect(state.unexpected).toEqual([]);
});

test('selective import names the store ids the courier did not return (409 DELIVERY_STORE_IDS_UNMATCHED)', async ({ page }) => {
    const state = await setupRoutes(page, {
        providers: [providerStatus('pathao', { is_connected: true, is_active: true, activation_status: 'ACTIVE', setup_complete: true })],
        syncMode: 'unmatched',
    });
    await loginAndGo(page);
    await openTab(page, 'pickup');
    await page.getByTestId('pickup-fetch-stores-pathao').click();
    await page.getByTestId('pickup-store-import-pathao-s2').click();
    await expect.poll(() => state.storesSyncs.length).toBe(1);
    // Blocked pill quotes the missing ids honestly instead of a fake success…
    await expect(page.getByTestId('pickup-message-pathao')).toContainText('The courier did not return these store ids: s2.');
    await expect(page.getByTestId('pickup-location-row-loc-s2')).toHaveCount(0);
    // …and the failed import claims NOTHING on the server cache (§A9).
    expect(state.storesCache.pathao).toBeUndefined();
    expect(state.syncedAt.pathao).toBeUndefined();
    expect(state.unexpected).toEqual([]);
});

test('stale mapping stays honest: Fetch does not green it, unresolved Retry names the fix, an explicit Link does', async ({ page }) => {
    const state = await setupRoutes(page, {
        providers: [providerStatus('pathao', {
            is_connected: true, is_active: true, activation_status: 'ACTIVE', setup_complete: true,
            pickup_enabled: true, provider_store_id: 's999', pickup_location_id: 'loc-a',
        })],
        // §A9: staleness is cache-derived — the wired s999 sits in an older
        // cached listing the courier no longer returns → 'stale' from GET /settings.
        cache: { pathao: ['s9', 's998'] },
    });
    await loginAndGo(page);
    await openTab(page, 'pickup');

    // Server-flagged stale renders ATTENTION from the first paint (derived, not
    // a seeded status field — pickup_mapping_status no longer travels on the
    // provider fixture at all)…
    await expect(page.getByTestId('pickup-sync-status-pathao')).toContainText('Mapping needs review');
    // …a successful pure store Fetch never flips it green and NEVER re-caches…
    await page.getByTestId('pickup-fetch-stores-pathao').click();
    await expect(page.getByTestId('pickup-store-row-pathao-s2')).toBeVisible();
    await expect(page.getByTestId('pickup-sync-status-pathao')).toContainText('Mapping needs review');
    expect(state.storesCache.pathao).toEqual([{ store_id: 's9' }, { store_id: 's998' }]);
    // …and a Retry whose sync cannot prove the wiring (PRESERVED) shows the
    // honest next step, not a fake success — and claims NOTHING on the cache.
    await page.getByTestId('pickup-retry-pathao').click();
    await expect.poll(() => state.syncs).toBe(1);
    await expect(page.getByTestId('pickup-message-pathao')).toContainText('Import to refresh the courier’s store list, then link again.');
    expect(state.storesCache.pathao).toEqual([{ store_id: 's9' }, { store_id: 's998' }]);
    // The pill stays ATTENTION (sunlight, never the success color) — after the
    // retry its label is the action hint naming the fix, not a fake success.
    await expect(page.getByTestId('pickup-sync-status-pathao')).toHaveClass(/bg-em-sunlight-100/);
    await expect(page.getByTestId('pickup-sync-status-pathao')).not.toHaveClass(/bg-em-success-100/);
    // Only an explicit LINK of a chosen store resolves it — the provider accepted
    // configuration for s2, so the LINK EXTENDS the cache with a source:'link'
    // entry (§A9)…
    await page.getByTestId('pickup-store-link-pathao-s2').click();
    await expect.poll(() => state.linkBodies.length).toBe(1);
    expect(state.storesCache.pathao[2]).toEqual({ store_id: 's2', source: 'link' });
    expect(state.syncedAt.pathao).toBe(SYNC_STAMP);
    // …and after the server reload the mapping is no longer stale: the pill
    // flips to a healthy "Linked…" state and never says "Mapping needs review".
    await expect(page.getByTestId('pickup-sync-status-pathao')).toContainText('Linked');
    expect(await page.getByTestId('pickup-sync-status-pathao').textContent()).not.toContain('Mapping needs review');
    expect(state.createStoreBodies).toHaveLength(0);
    expect(state.unexpected).toEqual([]);
});

test('unknown state: a wired store never compared to the courier listing is "not verified", never green', async ({ page }) => {
    const state = await setupRoutes(page, {
        providers: [providerStatus('pathao', {
            is_connected: true, is_active: true, activation_status: 'ACTIVE', setup_complete: true,
            // Wired on the integration row, but the store listing cache is EMPTY
            // (§A9): confirmed is NEVER derived from wiring alone.
            pickup_enabled: true, provider_store_id: 's1', pickup_location_id: 'loc-a',
        })],
    });
    await loginAndGo(page);
    await openTab(page, 'pickup');

    const pill = page.getByTestId('pickup-sync-status-pathao');
    await expect(pill).toContainText('Linked — not verified against the courier’s store list');
    await expect(pill).not.toHaveClass(/bg-em-success-100/);
    await expect(page.getByTestId('pickup-unverified-hint-pathao')).toContainText('Never matched to Pathao’s current store list');
    await expect(page.getByTestId('pickup-provider-panel-pathao')).toContainText('Not synced yet');

    // Fetch is a PURE READ — it lists stores but proves nothing about the
    // mapping: NO cache write, the never-verified hint stays authoritative,
    // and (§A9b false-green gate, b2794483) the read renders in the NEUTRAL
    // review tone — pill and message never success-styled while unverified.
    await page.getByTestId('pickup-fetch-stores-pathao').click();
    await expect(page.getByTestId('pickup-store-row-pathao-s1')).toBeVisible();
    expect(state.storesCache.pathao).toBeUndefined();
    await expect(page.getByTestId('pickup-unverified-hint-pathao')).toBeVisible();
    expect(await pill.textContent()).not.toContain('Linked & confirmed');
    await expect(pill).not.toHaveClass(/bg-em-success-100/);
    await expect(pill).toContainText('2 stores available');
    await expect(pill).toHaveClass(/bg-em-bg-muted/);
    const message = page.getByTestId('pickup-message-pathao');
    await expect(message).toHaveAttribute('role', 'status');
    await expect(message).toHaveClass(/text-em-text-secondary/);
    await expect(message).not.toHaveClass(/text-em-danger-700|text-em-success-700/);
    // §A9 round-3 hardening: the read may carry the honest store-count message,
    // but the pill must NEVER be success-styled while unverified.
    await expect(pill).not.toHaveClass(/bg-em-success-100/);

    // Only an explicit LINK (provider accepted configuration for the id) verifies
    // it: the cache gains a source:'link' entry, stores_synced_at is stamped, the
    // hint disappears, and the freshness renders Intl-localized (§ en-US here).
    await page.getByTestId('pickup-store-link-pathao-s1').click();
    await expect.poll(() => state.linkBodies.length).toBe(1);
    expect(state.storesCache.pathao).toEqual([{ store_id: 's1', source: 'link' }]);
    expect(state.syncedAt.pathao).toBe(SYNC_STAMP);
    await expect(page.getByTestId('pickup-unverified-hint-pathao')).toHaveCount(0);
    expect(await pill.textContent()).not.toContain('not verified');
    // §A8/round 3: the cache stamp renders through Intl in the active locale
    // (en-US here) — never a raw ISO string.
    const panel = page.getByTestId('pickup-provider-panel-pathao');
    await expect(panel).toContainText(/Stores synced \w+ \d{1,2}, 2026, \d{1,2}:\d{2}/);
    expect(await panel.textContent()).not.toContain('2026-11-25T10:00:00.000Z');
    expect(state.unexpected).toEqual([]);
});

test('deep-link 409 opens EDIT when the provider already has a pickup row — never a duplicate create', async ({ page }) => {
    const state = await setupRoutes(page, {
        providers: [
            providerStatus('pathao', { is_connected: true, is_active: false, activation_status: 'SETUP_INCOMPLETE', missing: ['pickup_not_enabled'] }),
            providerStatus('steadfast'),
            providerStatus('redx'),
        ],
        // defaultLocations() carries loc-b (provider pathao) — the row the 409
        // must route the merchant to EDIT, not a blank CREATE next to it.
        stores: { pathao: [{ store_id: 's1', store_name: 'Dhanmondi Hub', city_id: 1, zone_id: 10, area_id: 100 }] },
    });
    await loginAndGo(page);
    await page.getByTestId('manage-pathao').click();
    await page.getByTestId('drawer-activate-pathao').click();

    await expect(page.getByTestId('delivery-tab-pickup')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('heading', { name: 'Edit Pathao pickup location' })).toBeVisible();
    const form = page.getByTestId('pickup-form');
    // The existing row's identity + values are loaded (§A9 form remount).
    await expect(form.getByTestId('pickup-form-name')).toHaveValue('North Hub');
    await expect(page.getByTestId('pickup-location-row-loc-b')).toBeVisible();

    await form.getByTestId('pickup-form-name').fill('North Hub Two');
    await form.getByTestId('pickup-form-save').click();
    await expect.poll(() => state.pickupPuts).toBe(1);
    expect(state.pickupPosts).toBe(0);                   // never a duplicate create
    expect(state.pickupPutBodies[0]).toEqual(expect.objectContaining({ id: 'loc-b', display_name: 'North Hub Two' }));
    // The edit→sync chain then completes the where-next pointer.
    await expect.poll(() => state.syncs).toBe(1);
    expect(state.syncBodies[0]).toEqual(expect.objectContaining({ pickup_location_id: 'loc-b' }));
    await expect(page.getByTestId('pickup-next-step')).toContainText('Pickup saved — return to Courier Providers to Activate.');
    await expect(page.getByTestId('pickup-location-row-loc-b')).toContainText('North Hub Two');
    expect(state.unexpected).toEqual([]);
});

test('ambiguous 409 lists every candidate and re-syncs only with the merchant-chosen store id', async ({ page }) => {
    const state = await setupRoutes(page, {
        providers: [providerStatus('pathao', { is_connected: true, is_active: true, activation_status: 'ACTIVE', setup_complete: true })],
        linkMode: 'ambiguous',
    });
    await loginAndGo(page);
    await openTab(page, 'pickup');
    await page.getByTestId('pickup-fetch-stores-pathao').click();
    await expect(page.getByTestId('pickup-store-row-pathao-s1')).toBeVisible();
    await page.getByTestId('pickup-store-link-pathao-s1').click();

    const dialog = page.getByRole('dialog', { name: 'Multiple pickup stores match' });
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId('pickup-ambiguous-option-alpha')).toBeVisible();
    await expect(page.getByTestId('pickup-ambiguous-option-beta')).toBeVisible();
    await expect(page.getByTestId('pickup-ambiguous-confirm')).toBeDisabled();
    // No resolution without an explicit choice, and no auto external create.
    expect(state.syncBodies).toHaveLength(0);
    expect(state.createStoreBodies).toHaveLength(0);

    await page.getByTestId('pickup-ambiguous-option-beta').click();
    await expect(page.getByTestId('pickup-ambiguous-confirm')).toBeEnabled();
    await page.getByTestId('pickup-ambiguous-confirm').click();

    await expect.poll(() => state.syncs).toBe(1);
    expect(state.syncBodies[0]).toEqual(expect.objectContaining({ store_id: 'beta' }));
    await expect(dialog).toHaveCount(0);
    expect(state.unexpected).toEqual([]);
});

test('external store create only fires after the explicit confirm step, with confirm=true', async ({ page }) => {
    const state = await setupRoutes(page, {
        providers: [providerStatus('pathao', { is_connected: true, is_active: true, activation_status: 'ACTIVE', setup_complete: true })],
    });
    await loginAndGo(page);
    await openTab(page, 'pickup');
    await page.getByTestId('pickup-create-external-pathao').click();
    const dialog = page.getByRole('dialog', { name: 'New store at Pathao' });
    await expect(dialog).toBeVisible();
    expect(state.createStoreBodies).toHaveLength(0);

    await page.getByTestId('pickup-external-name').fill('Warehouse North');
    await page.getByTestId('pickup-external-address').fill('123 Ring Road, Dhaka');
    await page.getByTestId('pickup-external-request').click();
    // Confirm screen shows exactly what will be created at the courier — still no call.
    await expect(page.getByRole('heading', { name: 'Create this store at Pathao?' })).toBeVisible();
    await expect(page.getByText('Warehouse North')).toBeVisible();
    expect(state.createStoreBodies).toHaveLength(0);

    await page.getByTestId('pickup-external-confirm').click();
    await expect.poll(() => state.createStoreBodies.length).toBe(1);
    expect(state.createStoreBodies[0]).toEqual(expect.objectContaining({
        name: 'Warehouse North',
        address: '123 Ring Road, Dhaka',
        confirm: true,
    }));
    // After a create the tab re-reads the store list (no fabricated row).
    await expect.poll(() => state.storesGets.filter((p) => p === 'pathao').length).toBeGreaterThanOrEqual(1);
    expect(state.unexpected).toEqual([]);
});

test('safe delete: labeled Delete always confirms first, nothing fires without confirm, success only after server reply', async ({ page }) => {
    const state = await setupRoutes(page, {
        // pathao integration is wired to loc-a: the dialog must surface that
        // IN_USE blocker from LOCAL data BEFORE any DELETE (§12). No status is
        // seeded (§A9): wiring + empty cache derives 'unknown', never confirmed.
        providers: [providerStatus('pathao', { is_connected: true, is_active: true, activation_status: 'ACTIVE', setup_complete: true, pickup_enabled: true, pickup_location_id: 'loc-a', provider_store_id: 's1' })],
    });
    await loginAndGo(page);
    await openTab(page, 'pickup');
    await expect(page.getByTestId('pickup-location-row-loc-a')).toBeVisible();

    await page.getByTestId('pickup-delete-loc-a').click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText('Delete “HQ Warehouse”?');
    await expect(page.getByTestId('pickup-delete-blockers')).toContainText('This is your default pickup location.');
    // §A9: blocker provider rows render as LOCALIZED merchant labels, never raw enums.
    await expect(page.getByTestId('pickup-delete-blockers')).toContainText('In use by: Pathao');
    // §12: the dialog is a GATE — zero DELETE calls exist at this point.
    expect(state.deleteAttempts).toHaveLength(0);

    await dialog.getByTestId('pickup-delete-cancel').click();
    await expect(dialog).toHaveCount(0);
    expect(state.deleteAttempts).toHaveLength(0);
    await expect(page.getByTestId('pickup-location-row-loc-a')).toBeVisible();

    // Confirm → exactly one DELETE, always with ?confirm=true; success is the
    // server's, never claimed before the reply (§8).
    await page.getByTestId('pickup-delete-loc-a').click();
    await page.getByTestId('pickup-delete-confirm').click();
    await expect.poll(() => state.deleteAttempts.length).toBe(1);
    expect(state.deleteAttempts[0].confirmed).toBe(true);
    expect(state.deleteAttempts[0].path).toBe('/api/shop/delivery/pickup-locations/loc-a');
    expect(state.deleteAttempts[0].search).toContain('confirm=true');
    await expect(page.getByTestId('pickup-location-row-loc-a')).toHaveCount(0);
    await expect(page.getByTestId('pickup-delete-status')).toContainText('Pickup location “HQ Warehouse” was deleted.');
    expect(state.unexpected).toEqual([]);
});

test('safe delete — late server conflict keeps the dialog open with the server blockers', async ({ page }) => {
    const state = await setupRoutes(page, {
        providers: [providerStatus('pathao', { is_connected: true, is_active: true, activation_status: 'ACTIVE', setup_complete: true })],
        deleteBlockAfterConfirm: true,
    });
    await loginAndGo(page);
    await openTab(page, 'pickup');
    await page.getByTestId('pickup-delete-loc-a').click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toBeVisible();
    await page.getByTestId('pickup-delete-confirm').click();
    // The confirmed DELETE 409s (another tab changed state): dialog STAYS open,
    // the server's blockers replace the local ones, nothing was deleted.
    await expect.poll(() => state.deleteAttempts.length).toBe(1);
    await expect(dialog).toBeVisible();
    // Late server 409: its raw 'redx' enum renders as the localized label too.
    await expect(page.getByTestId('pickup-delete-blockers')).toContainText('In use by: RedX');
    await expect(page.getByTestId('pickup-location-row-loc-a')).toBeVisible();
    await expect(page.getByTestId('pickup-delete-status')).toHaveCount(0);
    expect(state.unexpected).toEqual([]);
});

test('default switch posts the chosen location to the :id/default route', async ({ page }) => {
    const state = await setupRoutes(page, {
        providers: [providerStatus('pathao', { is_connected: true, is_active: true, activation_status: 'ACTIVE', setup_complete: true })],
    });
    await loginAndGo(page);
    await openTab(page, 'pickup');
    await page.getByTestId('pickup-set-default-loc-b').click();
    await expect.poll(() => state.defaultPosts).toEqual(['loc-b']);
    await expect(page.getByTestId('pickup-location-default-loc-b')).toBeVisible();
    expect(state.unexpected).toEqual([]);
});

test('charges tab: identical save affordance saves all six keys in one PUT with the Saved indicator', async ({ page }) => {
    const state = await setupRoutes(page);
    await loginAndGo(page);
    await openTab(page, 'charges');

    await expect(page.getByTestId('area-pricing-save')).toBeVisible();
    await expect(page.getByTestId('weight-charges-save')).toBeVisible();
    await expect(page.getByText('Saves the general, area and weight settings on this page.').first()).toBeVisible();

    await page.getByRole('spinbutton', { name: 'Default Delivery Charge' }).fill('75');
    await page.getByRole('button', { name: 'Save Settings' }).click();
    await expect.poll(() => state.settingsPuts.length).toBe(1);
    expect(state.settingsPuts[0]).toEqual(expect.objectContaining({ default_delivery_charge: 75 }));
    // The six persisted keys all travel in the single PUT.
    expect(Object.keys(state.settingsPuts[0] as object).sort()).toEqual([
        'area_pricing', 'cod_charge', 'cod_enabled', 'default_delivery_charge', 'non_refundable', 'weight_tiers',
    ]);
    await expect(page.getByText('Saved').first()).toBeVisible();
    expect(state.unexpected).toEqual([]);
});

test('charges tab: a zero charge is accepted, persisted as 0, and honestly explained (round 2 notes)', async ({ page }) => {
    const state = await setupRoutes(page, {
        settings: {
            ...settings,
            default_delivery_charge: 0,
            area_pricing: [{ zone: 'inside_dhaka', charge: 0, cod_enabled: false }],
        },
    });
    await loginAndGo(page);
    await openTab(page, 'charges');

    // Clean load of persisted zeros renders as zero (hydration pin) with the
    // honest "0 ≠ free delivery" notes — never a silent fallback to 60.
    await expect(page.getByRole('spinbutton', { name: 'Default Delivery Charge' })).toHaveValue('0');
    await expect(page.getByText('A charge of 0 is saved for your records and checkout display, but the assistant still quotes the platform default delivery charge')).toBeVisible();
    await expect(page.getByText('A charge of 0 is saved for your records and checkout display, but the assistant falls back to the platform default for that area')).toBeVisible();

    // Saving an unrelated edit persists the zeros verbatim (PUT carries 0, not
    // a silent default-to-60) — a checkbox flip makes the row legitimately dirty.
    await expect(page.getByTestId('area-pricing-save')).toBeDisabled();
    await page.getByRole('checkbox', { name: 'COD Allowed' }).click();
    await page.getByTestId('area-pricing-save').click();
    await expect.poll(() => state.settingsPuts.length).toBe(1);
    expect(state.settingsPuts[0]).toEqual(expect.objectContaining({ default_delivery_charge: 0 }));
    expect((state.settingsPuts[0] as { area_pricing: { charge: number }[] }).area_pricing[0].charge).toBe(0);
    expect(state.unexpected).toEqual([]);
});

test('AI default election moves the badge between active providers; clear removes it', async ({ page }) => {
    const state = await setupRoutes(page, {
        providers: [
            providerStatus('pathao', { is_connected: true, is_active: true, activation_status: 'ACTIVE', setup_complete: true, is_ai_default: true }),
            providerStatus('steadfast', { is_connected: true, is_active: true, activation_status: 'ACTIVE', setup_complete: true }),
        ],
    });
    await loginAndGo(page);
    const pathaoHeading = page.getByRole('heading', { name: 'Pathao Courier', exact: true });
    await expect(pathaoHeading.locator('..').getByText('AI Default', { exact: true })).toBeVisible();

    // Set: the affordance lives in the management drawer.
    await page.getByTestId('manage-steadfast').click();
    await page.getByTestId('drawer-set-ai-steadfast').click();
    await expect.poll(() => state.aiDefaults).toBe(1);
    const steadfastHeading = page.getByRole('heading', { name: 'Steadfast Courier', exact: true });
    await expect(steadfastHeading.locator('..').getByText('AI Default', { exact: true })).toBeVisible();
    await expect(pathaoHeading.locator('..').getByText('AI Default', { exact: true })).toHaveCount(0);
    // §17 inline-first: action feedback renders INSIDE the open drawer dialog,
    // only after the server reply (§8), with role=status for success.
    const drawer = page.getByRole('dialog', { name: 'Manage Steadfast Courier' });
    await expect(drawer.getByTestId('drawer-action-feedback')).toContainText('Steadfast Courier is now the AI default courier');
    await expect(drawer.getByTestId('drawer-action-feedback')).toHaveAttribute('role', 'status');

    // Clear (NEW-UI over the existing DELETE route). The drawer stays open after
    // the set action, so the clear affordance is right there in the same drawer.
    await page.getByTestId('drawer-clear-ai-steadfast').click();
    await expect.poll(() => state.aiDefaultClears).toBe(1);
    await expect(steadfastHeading.locator('..').getByText('AI Default', { exact: true })).toHaveCount(0);
    await expect(drawer.getByTestId('drawer-action-feedback')).toContainText('no longer the AI default courier');
    expect(state.unexpected).toEqual([]);
});

test('capability truth stays below the ceiling — per provider, mirrored EXACTLY from provider-capabilities.js', async ({ page }) => {
    await setupRoutes(page, {
        providers: [
            providerStatus('pathao', { is_connected: true }),
            providerStatus('steadfast', { is_connected: true }),
            providerStatus('redx', { is_connected: true }),
        ],
    });
    await loginAndGo(page);

    const steadfast = page.getByTestId('provider-capabilities-steadfast');
    await expect(steadfast).toContainText('Never verified with a live account.');
    await steadfast.locator('summary').click();
    // Steadfast: coverage UNKNOWN (text-only), quote UNSUPPORTED, parcel/tracking
    // implemented, cancel/edit UNSUPPORTED…
    await expect(page.getByTestId('capability-steadfast-coverage')).toHaveText('Cannot be checked');
    await expect(page.getByTestId('capability-steadfast-rate_quote')).toHaveText('Not supported');
    await expect(page.getByTestId('capability-steadfast-create_parcel')).toHaveText('Implemented, not live-verified');
    await expect(page.getByTestId('capability-steadfast-tracking')).toHaveText('Implemented, not live-verified');
    await expect(page.getByTestId('capability-steadfast-cancel')).toHaveText('Not supported');
    await expect(page.getByTestId('capability-steadfast-edit')).toHaveText('Not supported');
    // …and NO store API at all — the pickup-store row is UNSUPPORTED, not
    // implemented (§A9: steadfast pickup is manual, never a fake green row).
    await expect(page.getByTestId('capability-steadfast-pickup_store')).toHaveText('Not supported');
    await expect(steadfast).toContainText('This courier has no API for pickup stores.');
    await expect(steadfast).toContainText('Add your pickup location manually in the Pickup tab.');
    await expect(steadfast).toContainText('Cancel it in the courier');

    const pathao = page.getByTestId('provider-capabilities-pathao');
    await pathao.locator('summary').click();
    await expect(page.getByTestId('capability-pathao-coverage')).toHaveText('Implemented, not live-verified');
    await expect(page.getByTestId('capability-pathao-rate_quote')).toHaveText('Implemented, not live-verified');
    await expect(page.getByTestId('capability-pathao-create_parcel')).toHaveText('Implemented, not live-verified');
    await expect(page.getByTestId('capability-pathao-tracking')).toHaveText('Implemented, not live-verified');
    await expect(page.getByTestId('capability-pathao-cancel')).toHaveText('Not supported');
    await expect(page.getByTestId('capability-pathao-edit')).toHaveText('Not supported');
    await expect(page.getByTestId('capability-pathao-pickup_store')).toHaveText('Implemented, not live-verified');

    // RedX differs from both: cancel/edit and rate_quote ARE implemented per
    // provider-capabilities.js — a shared fixture would lie.
    const redx = page.getByTestId('provider-capabilities-redx');
    await redx.locator('summary').click();
    await expect(page.getByTestId('capability-redx-rate_quote')).toHaveText('Implemented, not live-verified');
    await expect(page.getByTestId('capability-redx-cancel')).toHaveText('Implemented, not live-verified');
    await expect(page.getByTestId('capability-redx-edit')).toHaveText('Implemented, not live-verified');
    // The unverified store-list envelope is named honestly.
    await expect(page.getByTestId('capability-redx-pickup_store')).toHaveText('Implemented, not live-verified');
    await expect(redx).toContainText(/store-list contract has not been confirmed with a live account/);

    // Ceiling: nothing anywhere may claim live verification.
    await expect(page.getByText('Live-verified', { exact: true })).toHaveCount(0);
});

test('disconnect requires a type-to-confirm danger dialog inside the provider drawer', async ({ page }) => {
    const state = await setupRoutes(page, {
        providers: [providerStatus('pathao', { is_connected: true, is_active: true, activation_status: 'ACTIVE', setup_complete: true })],
    });
    await loginAndGo(page);
    await page.getByTestId('manage-pathao').click();
    await page.getByTestId('disconnect-pathao').click();
    const dialog = page.getByRole('dialog', { name: /Are you sure you want to disconnect Pathao Courier/ });
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId('delivery-disconnect-confirm')).toBeDisabled();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    expect(state.disconnects).toBe(0);

    await page.getByTestId('disconnect-pathao').click();
    await dialog.getByLabel(/Type Pathao Courier to confirm/).fill('Pathao Courier');
    await expect(page.getByTestId('delivery-disconnect-confirm')).toBeEnabled();
    await page.getByTestId('delivery-disconnect-confirm').click();
    await expect.poll(() => state.disconnects).toBe(1);
    await expect(page.getByTestId('activation-status-pathao')).toContainText('Not configured');
    expect(state.unexpected).toEqual([]);
});

// §A8c/§A9c round-4 fixtures: the mobile lanes must carry the TWO LONG honest
// pills — pathao STALE (wired 's999' absent from the seeded cache → 'Mapping
// needs review') and redx UNKNOWN-WIRED (pickup_enabled + 'rx-55', cache never
// written → 'Linked — not verified against the courier's store list'). At
// 390/360 these wrap (SignalPill break-words + flex-wrap header, commit
// b2794483) instead of forcing horizontal overflow.
const longPillProviders = () => [
    providerStatus('pathao', {
        is_connected: true, is_active: true, activation_status: 'ACTIVE', setup_complete: true,
        pickup_enabled: true, provider_store_id: 's999', pickup_location_id: 'loc-a',
    }),
    providerStatus('steadfast'),
    providerStatus('redx', {
        is_connected: true, is_active: true, activation_status: 'ACTIVE', setup_complete: true,
        pickup_enabled: true, provider_store_id: 'rx-55',
    }),
];

test('390px: no horizontal overflow + five mobile destinations + wrapped long honest pills', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const state = await setupRoutes(page, {
        providers: longPillProviders(),
        cache: { pathao: ['s1', 's2'] },
    });
    await loginAndGo(page);
    await expect(page.getByTestId('delivery-signal')).toBeVisible();
    const mobile = page.locator('nav[aria-label="Workspace navigation"]').nth(1);
    await expect(mobile.getByRole('link')).toHaveCount(5);
    await expectNoOverflow(page);

    // The long attention labels render in full on the Pickup tab at 390.
    await openTab(page, 'pickup');
    const stalePill = page.getByTestId('pickup-sync-status-pathao');
    await expect(stalePill).toBeVisible();
    await expect(stalePill).toContainText('Mapping needs review');
    const unknownPill = page.getByTestId('pickup-sync-status-redx');
    await expect(unknownPill).toBeVisible();
    await expect(unknownPill).toContainText('Linked — not verified against the courier’s store list');
    await expectNoOverflow(page);
    expect(state.unexpected).toEqual([]);
});

test('360px pickup tab: wrapped store workspace, honest pills and forms reflow without horizontal overflow', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    const state = await setupRoutes(page, {
        providers: longPillProviders(),
        cache: { pathao: ['s1', 's2'] },
    });
    await loginAndGo(page);
    await openTab(page, 'pickup');
    await expect(page.getByTestId('pickup-provider-panel-pathao')).toBeVisible();
    await expect(page.getByTestId('pickup-provider-panel-redx')).toBeVisible();
    await expect(page.getByTestId('pickup-location-row-loc-a')).toBeVisible();
    // Full pill text present + visible (wrapping, never clipped by overflow).
    const stalePill = page.getByTestId('pickup-sync-status-pathao');
    await expect(stalePill).toBeVisible();
    await expect(stalePill).toContainText('Mapping needs review');
    const unknownPill = page.getByTestId('pickup-sync-status-redx');
    await expect(unknownPill).toBeVisible();
    await expect(unknownPill).toContainText('Linked — not verified against the courier’s store list');
    await expect(page.getByTestId('pickup-unverified-hint-redx')).toBeVisible();
    await expectNoOverflow(page);
    await page.getByTestId('pickup-add-location').click();
    await expect(page.getByTestId('pickup-form')).toBeVisible();
    await expectNoOverflow(page);
    expect(state.unexpected).toEqual([]);
});

test('axe: no critical or serious violations in the delivery surface across all three tabs', async ({ page }) => {
    await setupRoutes(page, {
        providers: [
            providerStatus('pathao', { is_connected: true, is_active: true, activation_status: 'ACTIVE', setup_complete: true }),
            providerStatus('steadfast'),
            providerStatus('redx', { is_connected: true }),
        ],
    });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await loginAndGo(page);
    await expect(page.getByTestId('delivery-signal')).toBeVisible();
    await page.waitForTimeout(800);

    for (const tab of ['providers', 'pickup', 'charges'] as const) {
        if (tab !== 'providers') await openTab(page, tab);
        // Let the tab panel settle (pickup self-fetches locations + store panels).
        await page.waitForTimeout(400);
        const results = await new AxeBuilder({ page }).include('.em-delivery').analyze();
        const bad = results.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
        expect(bad, `axe violations on the ${tab} tab`).toEqual([]);
    }
});
