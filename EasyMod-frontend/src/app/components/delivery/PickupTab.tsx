/**
 * Delivery Settings — Tab 2 "Pickup Locations" (provider-first workspace).
 * Guardrails §5.6/§8/§11/§12/§16/§17/§18/§19. Preservation §C rows C1–C16.
 *
 * Provider-first flow (never silently touches the outside world):
 *  1. Read the courier's OWN pickup stores (listProviderStores is a PURE READ —
 *     Pathao live, RedX honest, Steadfast manual-only). The import lives in
 *     POST /:provider/stores/sync (importProviderStores) only.
 *  2. IMPORT them as local rows, and LINK a chosen store to a location via
 *     setProviderPickup (the provider store id is the authoritative identity).
 *     IMPORT / LINK / CREATE(local) / UPDATE are SEPARATE actions — never conflated.
 *     A selective import that the courier cannot match answers 409
 *     DELIVERY_STORE_IDS_UNMATCHED — surfaced as a blocked pill naming the ids.
 *  3. Any EXTERNAL store create is merchant-confirmed first (createProviderStore
 *     only fires after an explicit confirm) — no auto-create on sync miss.
 *  4. Multiple matching stores never guess: a 409 DELIVERY_PICKUP_AMBIGUOUS with
 *     candidates opens an EXPLICIT selection dialog; the merchant must choose.
 *  5. Safe delete (§12): the labeled Delete ALWAYS opens the confirm dialog FIRST
 *     (enriched from local data — default star + provider rows referencing the
 *     location). No DELETE fires without a merchant confirm; the confirmed call
 *     sends confirm:true, and a late server 409 (another tab changed state)
 *     re-surfaces the blockers inside the open dialog. Success shows an inline
 *     role=status notice ONLY after the server confirms (§8).
 *  6. Mapping honesty is SERVER-authoritative: while the server flags
 *     pickup_mapping_status === 'stale' the pill stays attention — a successful
 *     store Fetch never flips it green. A5c makes an explicit LINK and a
 *     MATCHED/LINKED sync refresh the server's cached store listing, so after
 *     those actions this tab simply RELOADS and lets the fresh server state flip
 *     the pill — there is no local stale-override. pickup_mapping_status ===
 *     'unknown' (no cached listing to compare) with a wired store renders an
 *     ATTENTION "linked — not verified" pill + a Fetch/Import-then-link hint:
 *     the backend contract is that 'unknown' is NEVER reported as confirmed.
 *
 * Status is Pending while in flight and only flips to a confirmed label once the
 * server replies (§8); sync/link failures keep every entered value (§C5) and
 * expose a Retry. Steadfast (and an unconnected courier) is manual-only with an
 * honest message — no fake store list.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MotionConfig } from 'motion/react';
import {
  AlertCircle,
  Check,
  CheckCircle2,
  CircleDashed,
  Download,
  Info,
  Link2,
  Loader2,
  MapPin,
  Plus,
  RefreshCw,
  Star,
  Store,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import * as orderApi from '@/api/domains/order';
import type {
  DeliveryLocationOption,
  DeliveryProvider,
  DeliveryProviderStatus,
  PickupLocation,
  ProviderPickupMetadata,
} from '@/api/types/order';
import { getErrorMessage } from '@shared/lib/http/errors';
import { EmButton } from '../dashboard/EmButton';
import { useDialogFocus } from '../inbox/useDialogFocus';
import { optionId, optionLabel, providerId } from '../orders/directoryOptions';
import { BD_PHONE_REGEX, BDPhoneInput } from '@/shared/components/BDPhoneInput';
import PickupForm, { type PickupFormProvider, type PickupFormSaved } from './PickupForm';

// NEW client functions are added to the order domain by the integration (A0).
// They are referenced by their exact runtime name; this local augmentation keeps
// the file self-consistent + typed until then, without editing the shared module
// (same pattern ProvidersTab uses for `clearAiDefault`).
type OrderApiWithPickup = typeof orderApi & {
  listProviderStores: (provider: DeliveryProvider) => Promise<ProviderStoresEnvelope>;
  importProviderStores: (provider: DeliveryProvider, storeIds?: string[]) => Promise<ProviderStoresEnvelope>;
  setProviderPickup: (
    provider: DeliveryProvider,
    payload: { pickup_location_id?: string | null; store_id?: string; provider_pickup_meta?: ProviderPickupMetadata; enabled?: boolean },
  ) => Promise<ProviderPickupLinkResult>;
  createProviderStore: (
    provider: DeliveryProvider,
    payload: ExternalStorePayload,
    confirm: boolean,
  ) => Promise<CreateProviderStoreResult>;
  setDefaultPickupLocation: (locationId: string) => Promise<PickupLocation>;
  deletePickupLocation: (
    locationId: string,
    opts?: { confirm?: boolean },
  ) => Promise<{ id: string; deleted: boolean; released_providers?: string[] }>;
  retryPickupSync: (
    provider: DeliveryProvider,
    payload: { pickup_location_id?: string | null; store_id?: string; provider_pickup_meta?: ProviderPickupMetadata },
  ) => Promise<DeliveryProviderStatus>;
};
const api = orderApi as OrderApiWithPickup;

// --- Wire shapes (defined locally so this tab does not depend on A0's exact
// type additions; every read is tolerant). --------------------------------------
interface ProviderStoreView {
  store_id?: string;
  id?: string | number;
  store_name?: string;
  name?: string;
  address?: string;
  phone?: string;
  city_id?: string | number | null;
  zone_id?: string | number | null;
  area_id?: string | number | null;
  delivery_area_id?: string | number | null;
}
interface ProviderStoresEnvelope {
  provider?: DeliveryProvider;
  stores?: ProviderStoreView[];
  /**
   * LEGACY: the backend change landing in parallel makes GET /:provider/stores a
   * pure read that no longer upserts rows or returns pickup_locations — the
   * import (POST /:provider/stores/sync) owns row creation. The field is kept for
   * a tolerant read only and is NEVER consumed to overwrite the local list.
   */
  pickup_locations?: PickupLocation[];
  capability?: string;
  stores_synced_at?: string | null;
}
interface ProviderPickupLinkResult {
  store_resolution?: string;
  pickup_store_id?: string | number | null;
  pickup_enabled?: boolean;
}
interface ExternalStorePayload {
  name: string;
  address: string;
  contact_name?: string;
  phone?: string;
  city_id?: string | number | null;
  zone_id?: string | number | null;
  area_id?: string | number | null;
  enabled?: boolean;
}
interface CreateProviderStoreResult {
  provider?: string;
  created?: boolean;
  store?: ProviderStoreView;
  pickup_locations?: PickupLocation[];
  capability?: string;
}
interface DeleteBlocker {
  code?: string;
  message?: string;
  providers?: string[];
}
interface AmbiguousState {
  provider: DeliveryProvider;
  candidates: ProviderStoreView[];
  targetLocationId: string | null;
  meta: ProviderPickupMetadata;
}
interface DeleteState {
  location: PickupLocation;
  /** Blockers — seeded from LOCAL data on open, replaced by server blockers on a late 409. */
  blockers: DeleteBlocker[];
  /** Server message shown inside the dialog when a confirm-time 409 carries no structured blockers. */
  note?: string | null;
}
interface EditingState {
  mode: 'create' | 'edit';
  provider: PickupFormProvider;
  location?: PickupLocation | null;
  meta?: ProviderPickupMetadata | null;
}

type PillKind = 'healthy' | 'attention' | 'blocked' | 'pending' | 'review';

const FOCUS_RING =
  'focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-em-focus-light focus-visible:transition-none';

const PILL_CLASSES: Record<PillKind, string> = {
  healthy: 'bg-em-success-100 text-em-success-700',
  attention: 'bg-em-sunlight-100 text-em-sunlight-700',
  blocked: 'bg-em-danger-100 text-em-danger-700',
  pending: 'bg-em-info-100 text-em-info-700',
  review: 'bg-em-bg-muted text-em-text-secondary',
};

const PROVIDER_LABEL_KEYS: Record<PickupFormProvider, string> = {
  pathao: 'manageShop.deliverySettings.pickup.providers.pathao',
  steadfast: 'manageShop.deliverySettings.pickup.providers.steadfast',
  redx: 'manageShop.deliverySettings.pickup.providers.redx',
  manual: 'manageShop.deliverySettings.pickup.providers.manual',
};

// The three fixed couriers, in the same display order as Tab 1.
const WORKSPACE_PROVIDERS: DeliveryProvider[] = ['pathao', 'redx', 'steadfast'];

/** Bangla numerals for counts when the UI language is bn (§ numeral rule). */
const formatCount = (value: number, language?: string): string => {
  try {
    return new Intl.NumberFormat(language?.startsWith('bn') ? 'bn-BD' : 'en').format(value);
  } catch {
    return String(value);
  }
};

/**
 * Locale-aware timestamp (same pattern as customers/customerDisplay.ts): the
 * active i18n language drives Intl — bn renders Bangla numerals, else en-US.
 */
const formatStoresSyncedDate = (value: string, language?: string): string => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  try {
    return date.toLocaleString(language?.startsWith('bn') ? 'bn-BD' : 'en-US', {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  } catch {
    return value;
  }
};

/** The courier context a saved row was created under (anything unknown = manual). */
const rowProviderOf = (row: PickupLocation): PickupFormProvider =>
  row.provider === 'pathao' || row.provider === 'redx' || row.provider === 'steadfast'
    ? row.provider
    : 'manual';

/** Persisted provider ids for re-hydrating the edit cascade (§A8 chain). */
const rowMetaOf = (row: PickupLocation): ProviderPickupMetadata =>
  (row.metadata?.provider_pickup_meta as ProviderPickupMetadata | undefined) ?? {
    city_id: row.city_id,
    zone_id: row.zone_id,
    area_id: row.area_id,
  };

// --- Error parsing helpers (tolerant of the AppError → globalHandler envelope).
const isConflictError = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as {
    statusCode?: unknown; status?: unknown; type?: unknown; response?: { status?: unknown };
  };
  return candidate.statusCode === 409
    || candidate.status === 409
    || candidate.response?.status === 409
    || candidate.type === 'CONFLICT';
};

const getErrorCode = (error: unknown): string | undefined => {
  if (!error || typeof error !== 'object') return undefined;
  const e = error as {
    code?: unknown;
    data?: { code?: unknown };
    response?: { data?: { code?: unknown; error?: { code?: unknown } } };
  };
  const codes = [e.code, e.data?.code, e.response?.data?.code, e.response?.data?.error?.code];
  const found = codes.find((value): value is string => typeof value === 'string');
  return found;
};

const getErrorDetails = (error: unknown): Record<string, unknown> => {
  if (!error || typeof error !== 'object') return {};
  const e = error as {
    details?: unknown;
    data?: { details?: unknown };
    response?: { data?: { details?: unknown; candidates?: unknown; error?: { details?: unknown } } };
  };
  const found = [
    e.details,
    e.data?.details,
    e.response?.data?.details,
    e.response?.data?.error?.details,
  ].find((value): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value));
  if (found) return found;
  // Tolerant: candidates may sit at the top level of the body.
  const topCandidates = e.response?.data?.candidates;
  if (Array.isArray(topCandidates)) return { candidates: topCandidates };
  return {};
};

const readCandidates = (details: Record<string, unknown>): ProviderStoreView[] => {
  const raw = (details.candidates ?? details.stores) as unknown;
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is ProviderStoreView => Boolean(item) && typeof item === 'object');
};

const readBlockers = (details: Record<string, unknown>): DeleteBlocker[] => {
  const raw = details.blockers as unknown;
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is DeleteBlocker => Boolean(item) && typeof item === 'object');
};

const storeKey = (store: ProviderStoreView): string =>
  String(store.store_id ?? store.id ?? store.name ?? store.store_name ?? '');

const storeTitle = (store: ProviderStoreView): string =>
  store.store_name ?? store.name ?? store.store_id ?? store.id?.toString() ?? '';

const storeMeta = (store: ProviderStoreView): string => {
  const bits: string[] = [];
  if (store.address) bits.push(store.address);
  const loc = [store.city_id, store.zone_id, store.area_id]
    .filter((value) => value !== undefined && value !== null && value !== '')
    .join(' · ');
  if (loc) bits.push(`#${loc}`);
  return bits.join(' · ');
};

// Small label+icon signal pill (§8: never colour alone).
function SignalPill({ kind, label, testId, wrap }: { kind: PillKind; label: string; testId?: string; wrap?: boolean }) {
  const Icon = kind === 'healthy' ? CheckCircle2 : kind === 'blocked' ? TriangleAlert : kind === 'pending' ? CircleDashed : kind === 'attention' ? AlertCircle : MapPin;
  return (
    <span
      data-testid={testId}
      className={`inline-flex items-center gap-1 ${wrap ? 'whitespace-normal break-words' : 'whitespace-nowrap'} rounded-full px-2.5 py-0.5 text-xs font-medium ${PILL_CLASSES[kind]}`}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      {label}
    </span>
  );
}

export interface PickupTabProps {
  /** Provider rows from the shell (carry pickup_mapping_status, pickup_stores_synced_at, provider_store_id, pickup_enabled). */
  providers: DeliveryProviderStatus[];
  /** Optional seed from GET /settings; the tab self-fetches via getPickupLocations regardless. */
  locations?: PickupLocation[];
  /** Reload + re-derive the header signal after a server-confirmed mutation (shell-owned). */
  onMutate?: () => void | Promise<void>;
  /** Deep-link from Tab 1's "Complete pickup" — pre-opens the create form for a provider. */
  focusProvider?: DeliveryProvider | null;
  /**
   * Fired ONCE per prop-driven deep-link open, right after the create form opens,
   * so the shell can clear its pickupFocus flag (the form must not re-open on every
   * remount). Optional until A0 wires it — safe when absent (§A8).
   */
  onFocusConsumed?: () => void;
}

export default function PickupTab({ providers, locations, onMutate, focusProvider, onFocusConsumed }: PickupTabProps) {
  const { t, i18n } = useTranslation();

  const [list, setList] = useState<PickupLocation[]>(locations ?? []);
  const [loadingLocations, setLoadingLocations] = useState(false);
  /** True once the FIRST GET /pickup-locations has settled (deep-link decides on data). */
  const [locationsSettled, setLocationsSettled] = useState(false);
  const [locationsError, setLocationsError] = useState<string | null>(null);
  const [deleteNotice, setDeleteNotice] = useState<string | null>(null);
  const [nextStep, setNextStep] = useState<string | null>(null);

  const [storesByProvider, setStoresByProvider] = useState<Partial<Record<DeliveryProvider, ProviderStoreView[]>>>({});
  const [storesLoading, setStoresLoading] = useState<Partial<Record<DeliveryProvider, boolean>>>({});
  const [storesError, setStoresError] = useState<Partial<Record<DeliveryProvider, string | null>>>({});

  const [syncStatus, setSyncStatus] = useState<Partial<Record<DeliveryProvider, PillKind>>>({});
  const [syncMessage, setSyncMessage] = useState<Partial<Record<DeliveryProvider, string | null>>>({});

  const [selectedLocationId, setSelectedLocationId] = useState<string | null>(null);
  const [editing, setEditing] = useState<EditingState | null>(null);
  /**
   * Bumped on every openForm(); part of the mounted PickupForm's KEY so switching
   * the Edit target ALWAYS remounts the form with the new row's initial state
   * (locationId + fields). PickupForm's useState initializers only run on mount —
   * re-targeting without a remount would silently keep editing the OLD row (§A9).
   */
  const [formNonce, setFormNonce] = useState(0);
  const openForm = useCallback((next: EditingState) => {
    setFormNonce((nonce) => nonce + 1);
    setEditing(next);
  }, []);
  const [pending, setPending] = useState<string | null>(null);
  const [ambiguous, setAmbiguous] = useState<AmbiguousState | null>(null);
  const [deleteState, setDeleteState] = useState<DeleteState | null>(null);
  const [external, setExternal] = useState<{ provider: DeliveryProvider } | null>(null);

  // Suppress state updates that resolve after unmount — a pending sync/fetch
  // finishing past a test boundary must not re-enter React's act() flush.
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const loadLocations = useCallback(async () => {
    setLoadingLocations(true);
    setLocationsError(null);
    try {
      const rows = await orderApi.getPickupLocations();
      if (!alive.current) return;
      setList(Array.isArray(rows) ? rows : []);
      setSelectedLocationId((current) => {
        if (current && Array.isArray(rows) && rows.some((row) => row.id === current)) return current;
        return rows?.find((row) => row.is_default)?.id ?? rows?.[0]?.id ?? null;
      });
    } catch (err) {
      if (alive.current) setLocationsError(getErrorMessage(err, t('manageShop.deliverySettings.pickup.errors.loadFailed')));
    } finally {
      if (alive.current) {
        setLoadingLocations(false);
        setLocationsSettled(true);
      }
    }
  }, []);

  useEffect(() => {
    void loadLocations();
  }, []);

  // Deep-link open (§A8/§A9): the 409 "Complete pickup details" pointer must not
  // blindly open a blank CREATE form — when the provider already has a saved
  // pickup row, open EDIT on it (a second create would duplicate the row). The
  // decision waits for the first location load so the lookup runs against server
  // data, opens ONCE per prop-driven open, and tells the shell it was consumed
  // (re-opening on every remount is the shell's job to prevent by clearing
  // pickupFocus; the ref guard pins once-per-open here).
  const focusHandledRef = useRef<string | null>(null);
  const enteredViaFocusRef = useRef(Boolean(focusProvider));
  useEffect(() => {
    if (!focusProvider) {
      focusHandledRef.current = null;
      return;
    }
    if (focusHandledRef.current === focusProvider) return;
    if (!locationsSettled) return;
    focusHandledRef.current = focusProvider;
    if (!editing) {
      const existing = list.find((row) => rowProviderOf(row) === focusProvider);
      openForm(existing
        ? { mode: 'edit', provider: focusProvider, location: existing, meta: rowMetaOf(existing) }
        : { mode: 'create', provider: focusProvider });
    }
    onFocusConsumed?.();
  }, [focusProvider, onFocusConsumed, locationsSettled, list, editing, openForm]);

  // Shell-driven reload of the provider rows. There is deliberately NO local
  // stale-override to expire here: A5c refreshes the server's cached store
  // listing as part of the LINK / MATCHED-LINKED calls themselves, so the fresh
  // pickup_mapping_status coming back through `providers` IS the truth (§A9).
  const reload = useCallback(async () => {
    try {
      await onMutate?.();
    } catch {
      // Shell owns the load-error surface; keep last known state on a failed reload.
    }
  }, [onMutate]);

  const setProviderStatus = (provider: DeliveryProvider, kind: PillKind, message?: string | null) => {
    setSyncStatus((prev) => ({ ...prev, [provider]: kind }));
    if (message !== undefined) setSyncMessage((prev) => ({ ...prev, [provider]: message }));
  };

  const handleFetchStores = async (provider: DeliveryProvider) => {
    setStoresLoading((prev) => ({ ...prev, [provider]: true }));
    setStoresError((prev) => ({ ...prev, [provider]: null }));
    setProviderStatus(provider, 'pending', t('manageShop.deliverySettings.pickup.syncing'));
    try {
      // PURE READ (§A8): GET /:provider/stores now returns only the courier
      // listing — it never upserts local rows, so result.pickup_locations is NOT
      // consumed here. The local list refreshes via loadLocations() after an
      // IMPORT (sync) only.
      const result = await api.listProviderStores(provider);
      if (!alive.current) return;
      const stores = Array.isArray(result?.stores) ? result.stores : [];
      setStoresByProvider((prev) => ({ ...prev, [provider]: stores }));
      // §A9 false-green gate: a PURE listing read proves the listing is
      // readable, NOT that the wired store matches it. Success-green after a
      // read is only honest when the server already reports 'confirmed';
      // otherwise this is informational (the unknown-wired attention pill and
      // the unverified hint stay authoritative).
      const readConfirmed = mappingStatus(provider) === 'confirmed';
      setProviderStatus(
        provider,
        stores.length > 0 && readConfirmed ? 'healthy' : 'review',
        stores.length > 0
          ? t('manageShop.deliverySettings.pickup.synced', { n: formatCount(stores.length, i18n?.language) })
          : t('manageShop.deliverySettings.pickup.noStores'),
      );
      await reload();
    } catch (err) {
      if (!alive.current) return;
      const manual = getErrorCode(err) === 'DELIVERY_PROVIDER_MANUAL_PICKUP';
      const unsupported = getErrorCode(err) === 'DELIVERY_PROVIDER_UNSUPPORTED';
      setProviderStatus(provider, 'blocked', t('manageShop.deliverySettings.pickup.storesFailed'));
      setStoresError((prev) => ({
        ...prev,
        [provider]: manual
          ? t('manageShop.deliverySettings.pickup.manualOnly', { provider: t(PROVIDER_LABEL_KEYS[provider]) })
          : unsupported
            ? t('manageShop.deliverySettings.pickup.unsupported')
            : getErrorMessage(err, t('manageShop.deliverySettings.pickup.storesFailed')),
      }));
    } finally {
      if (alive.current) setStoresLoading((prev) => ({ ...prev, [provider]: false }));
    }
  };

  // IMPORT lives here only (POST /:provider/stores/sync). Per-row passes the
  // selected store's id (selective import); bulk omits ids. A structured 409
  // DELIVERY_STORE_IDS_UNMATCHED names the missing ids in a blocked pill (§A8).
  const handleImportStores = async (provider: DeliveryProvider, ids?: string[]) => {
    const key = `import:${provider}:${ids?.length ?? 'all'}`;
    setPending(key);
    setProviderStatus(provider, 'pending', t('manageShop.deliverySettings.pickup.importing'));
    try {
      await api.importProviderStores(provider, ids);
      await loadLocations();
      if (!alive.current) return;
      setProviderStatus(provider, 'healthy', t('manageShop.deliverySettings.pickup.importDone'));
      await reload();
    } catch (err) {
      if (alive.current) {
        if (getErrorCode(err) === 'DELIVERY_STORE_IDS_UNMATCHED') {
          const rawIds = getErrorDetails(err).unmatched_store_ids;
          const idList = Array.isArray(rawIds) ? rawIds.map((value) => String(value)).filter(Boolean).join(', ') : '';
          setProviderStatus(
            provider,
            'blocked',
            idList
              ? t('manageShop.deliverySettings.pickup.unmatchedStores', { ids: idList })
              : t('manageShop.deliverySettings.pickup.errors.importFailed'),
          );
        } else {
          setProviderStatus(provider, 'blocked', t('manageShop.deliverySettings.pickup.errors.importFailed'));
          setSyncMessage((prev) => ({ ...prev, [provider]: getErrorMessage(err, t('manageShop.deliverySettings.pickup.errors.importFailed')) }));
        }
      }
    } finally {
      if (alive.current) setPending(null);
    }
  };

  const runAmbiguous = (provider: DeliveryProvider, details: Record<string, unknown>, fallbackLocationId: string | null) => {
    const candidates = readCandidates(details);
    if (candidates.length === 0) return false;
    setAmbiguous({
      provider,
      candidates,
      targetLocationId: (details.pickup_location_id as string | undefined) ?? fallbackLocationId,
      meta: (details.provider_pickup_meta as ProviderPickupMetadata | undefined) ?? {},
    });
    setProviderStatus(provider, 'attention', t('manageShop.deliverySettings.pickup.ambiguous.needsSelection'));
    return true;
  };

  const handleLinkStore = async (provider: DeliveryProvider, store: ProviderStoreView) => {
    const storeId = store.store_id ?? (store.id != null ? String(store.id) : '');
    if (!storeId) return;
    const key = `link:${provider}:${storeId}`;
    setPending(key);
    setProviderStatus(provider, 'pending', t('manageShop.deliverySettings.pickup.linking'));
    try {
      const result = await api.setProviderPickup(provider, {
        store_id: storeId,
        pickup_location_id: selectedLocationId ?? undefined,
        enabled: true,
      });
      const resolution = result?.store_resolution;
      if (alive.current) {
        // The explicit LINK succeeded and (A5c) refreshed the server's cached
        // listing, so the reload below is what flips the pill to server-green.
        // No local stale-override: until the fresh status lands the pill stays
        // honest to the server (§A9).
        setProviderStatus(
          provider,
          'healthy',
          t(`manageShop.deliverySettings.pickup.resolutions.${resolution ?? 'LINKED'}`, { defaultValue: t('manageShop.deliverySettings.pickup.linked', { store: storeTitle(store) }) }),
        );
      }
      await loadLocations();
      await reload();
    } catch (err) {
      if (!alive.current) return;
      if (isConflictError(err) && runAmbiguous(provider, getErrorDetails(err), selectedLocationId)) {
        // Ambiguous → explicit selection; do NOT guess (§C13).
      } else {
        const code = getErrorCode(err);
        const message = code === 'DELIVERY_PICKUP_SOURCE_REQUIRED'
          ? t('manageShop.deliverySettings.pickup.errors.sourceRequired')
          : code === 'PICKUP_LOCATION_PROVIDER_MISMATCH'
            ? t('manageShop.deliverySettings.pickup.errors.providerMismatch')
            : code === 'DELIVERY_PROVIDER_NOT_CONNECTED'
              ? t('manageShop.deliverySettings.pickup.errors.notConnected')
              : getErrorMessage(err, t('manageShop.deliverySettings.pickup.errors.linkFailed'));
        setProviderStatus(provider, 'blocked', message);
      }
    } finally {
      if (alive.current) setPending(null);
    }
  };

  const resolveAmbiguous = async (store: ProviderStoreView) => {
    if (!ambiguous) return;
    const storeId = store.store_id ?? (store.id != null ? String(store.id) : '');
    const provider = ambiguous.provider;
    setPending(`resolve:${provider}`);
    try {
      await orderApi.syncProviderPickup(provider, {
        pickup_location_id: ambiguous.targetLocationId ?? undefined,
        store_id: storeId,
        provider_pickup_meta: ambiguous.meta,
      } as never);
      if (!alive.current) return;
      setAmbiguous(null);
      // Merchant-explicit store choice + successful re-sync resolves the mapping
      // SERVER-side (A5c refreshes the cached listing on MATCHED/LINKED), so the
      // reload below is what turns the pill green — not a local override (§A9).
      setProviderStatus(provider, 'healthy', t('manageShop.deliverySettings.pickup.linked', { store: storeTitle(store) }));
      await loadLocations();
      await reload();
    } catch (err) {
      if (alive.current) {
        setProviderStatus(provider, 'blocked', getErrorMessage(err, t('manageShop.deliverySettings.pickup.errors.ambiguousUnresolved')));
        setAmbiguous(null);
      }
    } finally {
      if (alive.current) setPending(null);
    }
  };

  const handleRetrySync = async (provider: DeliveryProvider) => {
    setPending(`retry:${provider}`);
    setProviderStatus(provider, 'pending', t('manageShop.deliverySettings.pickup.syncing'));
    try {
      const result = await api.retryPickupSync(provider, {
        pickup_location_id: selectedLocationId ?? undefined,
      });
      const resolution = (result as unknown as { store_resolution?: string })?.store_resolution;
      if (alive.current) {
        if (resolution === 'MATCHED' || resolution === 'LINKED') {
          // A5c refreshed the cached listing as part of this sync; the reload
          // below brings the SERVER's 'confirmed' — no local override (§A9).
          setProviderStatus(
            provider,
            'healthy',
            t(`manageShop.deliverySettings.pickup.resolutions.${resolution}`, { defaultValue: t('manageShop.deliverySettings.pickup.syncedCounts', { n: formatCount((storesByProvider[provider] ?? []).length, i18n?.language) }) }),
          );
        } else {
          // PRESERVED / NO_MATCH / anything unresolved: the wiring is NOT proven —
          // PRESERVED on retry means the wired store is not in the server's CACHE
          // (a stale mapping kept, not verified). Show ATTENTION naming the action
          // that fixes it — Import to refresh the listing, then link again — never
          // healthy green (§A8/§A9).
          setProviderStatus(provider, 'attention', t('manageShop.deliverySettings.pickup.staleStoreHint'));
        }
      }
      await loadLocations();
      await reload();
    } catch (err) {
      if (!alive.current) return;
      if (isConflictError(err) && runAmbiguous(provider, getErrorDetails(err), selectedLocationId)) {
        // handled by explicit selection
      } else {
        setProviderStatus(provider, 'blocked', getErrorMessage(err, t('manageShop.deliverySettings.pickup.errors.retryFailed')));
      }
    } finally {
      if (alive.current) setPending(null);
    }
  };

  const handleSetDefault = async (location: PickupLocation) => {
    if (!location.id) return;
    setPending(`default:${location.id}`);
    try {
      await api.setDefaultPickupLocation(location.id);
      await loadLocations();
      await reload();
    } catch (err) {
      if (alive.current) setLocationsError(getErrorMessage(err, t('manageShop.deliverySettings.errors.updateDefaultFailed')));
    } finally {
      if (alive.current) setPending(null);
    }
  };

  // §12 dangerous action: the backend DELETES a clean row immediately on an
  // unconfirmed call, so no DELETE may ever fire from the row itself. The labeled
  // Delete ALWAYS opens the confirm dialog first, pre-enriched from LOCAL data:
  // the shop-default star and any provider row wired to this location
  // (providers[].pickup_location_id) surface as in-use warnings up front.
  const openDeleteDialog = (location: PickupLocation) => {
    if (!location.id) return;
    const blockers: DeleteBlocker[] = [];
    if (location.is_default) blockers.push({ code: 'IS_SHOP_DEFAULT' });
    const referencedBy = providers
      .filter((item) => item.pickup_location_id != null && String(item.pickup_location_id) === String(location.id))
      .map((item) => item.provider);
    if (referencedBy.length > 0) blockers.push({ code: 'IN_USE', providers: referencedBy });
    setDeleteNotice(null);
    setDeleteState({ location, blockers });
  };

  const handleConfirmDelete = async () => {
    if (!deleteState?.location.id) return;
    const id = deleteState.location.id;
    const name = deleteState.location.display_name;
    setPending(`confirm-delete:${id}`);
    try {
      const result = await api.deletePickupLocation(id, { confirm: true });
      if (alive.current && result?.deleted !== false) {
        setDeleteState(null);
        setLocationsError(null);
        // Honest success (§8): the notice renders only after the server confirmed.
        setDeleteNotice(t('manageShop.deliverySettings.pickup.deleted', { name }));
      }
      await loadLocations();
      await reload();
    } catch (err) {
      if (!alive.current) return;
      if (isConflictError(err)) {
        // Another tab changed state since the dialog opened: keep it OPEN and
        // surface the server's blockers (or its message) inside the dialog.
        const serverBlockers = readBlockers(getErrorDetails(err));
        setDeleteState((prev) => (prev ? {
          ...prev,
          blockers: serverBlockers.length > 0 ? serverBlockers : prev.blockers,
          note: serverBlockers.length > 0 ? null : getErrorMessage(err, t('manageShop.deliverySettings.pickup.errors.deleteBlocked')),
        } : prev));
      } else {
        setDeleteState(null);
        setLocationsError(getErrorMessage(err, t('manageShop.deliverySettings.pickup.errors.deleteFailed')));
      }
    } finally {
      if (alive.current) setPending(null);
    }
  };

  const handleFormSaved = async ({ location, providerMeta }: PickupFormSaved) => {
    const provider = editing?.provider;
    setEditing(null);
    await loadLocations();
    if (!alive.current) return;
    if (location?.id) setSelectedLocationId(location.id);
    // "then sync" (§C3): wire the just-created/edited row's provider ids. This is
    // a SYNC (mapping), NOT a link/create/activate — CREATE(local) stays separate.
    if (provider === 'pathao' || provider === 'redx') {
      setProviderStatus(provider, 'pending', t('manageShop.deliverySettings.pickup.syncing'));
      try {
        const res = await orderApi.syncProviderPickup(provider, {
          pickup_location_id: location?.id ?? null,
          provider_pickup_meta: providerMeta,
        });
        if (!alive.current) return;
        const resolution = (res as unknown as { store_resolution?: string })?.store_resolution;
        // The row's own persisted provider_store_id / a MATCHED-LINKED resolution
        // is server-truth for THIS save; the reload below refreshes the mapping
        // status itself (A5c refreshes the cache on MATCHED/LINKED) (§A9).
        const confirmed = Boolean(location?.provider_store_id) || resolution === 'MATCHED' || resolution === 'LINKED';
        setProviderStatus(
          provider,
          confirmed ? 'healthy' : 'review',
          resolution
            ? t(`manageShop.deliverySettings.pickup.resolutions.${resolution}`, {
              defaultValue: t('manageShop.deliverySettings.pickup.syncedCounts', { n: formatCount((storesByProvider[provider] ?? []).length, i18n?.language) }),
            })
            : t('manageShop.deliverySettings.pickup.syncedCounts', { n: formatCount((storesByProvider[provider] ?? []).length, i18n?.language) }),
        );
        // Deep-link (409 "Complete pickup") WHERE-NEXT: once the row is saved and
        // server-confirmed synced, point back to Providers to finish activation (§A8).
        if (confirmed && enteredViaFocusRef.current && location?.id) {
          setNextStep(t('manageShop.deliverySettings.pickup.returnToProviders'));
        }
      } catch (err) {
        if (!alive.current) return;
        if (isConflictError(err) && runAmbiguous(provider, getErrorDetails(err), location?.id ?? null)) {
          // explicit selection required
        } else {
          setProviderStatus(provider, 'blocked', getErrorMessage(err, t('manageShop.deliverySettings.pickup.errors.syncFailed')));
        }
      }
    } else if (enteredViaFocusRef.current && location?.id) {
      // Manual/Steadfast rows carry no provider sync — a persisted row alone
      // completes the 409 pickup step.
      setNextStep(t('manageShop.deliverySettings.pickup.returnToProviders'));
    }
    await reload();
  };

  const statusFor = (provider: DeliveryProvider): DeliveryProviderStatus | undefined =>
    providers.find((item) => item.provider === provider);

  const mappingStatus = (provider: DeliveryProvider): string | null => {
    const extra = statusFor(provider) as (DeliveryProviderStatus & { pickup_mapping_status?: string | null }) | undefined;
    return extra?.pickup_mapping_status ?? null;
  };
  const storesSyncedAt = (provider: DeliveryProvider): string | null => {
    const extra = statusFor(provider) as (DeliveryProviderStatus & { pickup_stores_synced_at?: string | null }) | undefined;
    return extra?.pickup_stores_synced_at ?? null;
  };

  const derivedPill = (provider: DeliveryProvider): { kind: PillKind; label: string } => {
    const status = statusFor(provider);
    if (!status?.is_connected) {
      return { kind: 'review', label: t('manageShop.deliverySettings.pickup.connectFirst') };
    }
    if (provider === 'steadfast') {
      return { kind: 'review', label: t('manageShop.deliverySettings.pickup.manualOnlyShort') };
    }
    const stored = syncStatus[provider];
    const msg = syncMessage[provider];
    const mapping = mappingStatus(provider);
    // Server-flagged STALE outranks local optimistic state (§A8): a successful
    // store Fetch never flips it green, and after an explicit LINK / MATCHED
    // retry the RELOAD is what flips it (A5c refreshes the cached listing
    // server-side) — there is no local override (§A9). In-flight pending/blocked/
    // attention results still describe the action honestly.
    if (mapping === 'stale') {
      if (stored === 'pending') return { kind: 'pending', label: msg ?? t('manageShop.deliverySettings.pickup.statusPills.pending') };
      if (stored === 'blocked') return { kind: 'blocked', label: msg ?? t('manageShop.deliverySettings.pickup.statusPills.blocked') };
      if (stored === 'attention') return { kind: 'attention', label: msg ?? t('manageShop.deliverySettings.pickup.mapping.stale') };
      return { kind: 'attention', label: t('manageShop.deliverySettings.pickup.mapping.stale') };
    }
    if (stored) {
      return { kind: stored, label: msg ?? t(`manageShop.deliverySettings.pickup.statusPills.${stored}`) };
    }
    // GREEN is reserved for a server 'confirmed' (the in-session `stored` state
    // above is the explicit LINK/MATCHED result). A wired store the server has
    // never compared against a cached courier listing — 'unknown', or the field
    // absent on an older server — is an UNVERIFIED mapping: the backend contract
    // says 'unknown' is never reported as confirmed, so a green "Linked &
    // confirmed" pill here would be a false verification claim (§A9).
    if (mapping === 'confirmed') return { kind: 'healthy', label: t('manageShop.deliverySettings.pickup.mapping.confirmed') };
    if (status.pickup_enabled && status.provider_store_id) {
      return { kind: 'attention', label: t('manageShop.deliverySettings.pickup.mapping.unknownLinked') };
    }
    return { kind: 'review', label: t('manageShop.deliverySettings.pickup.mapping.unknown') };
  };

  /**
   * Wired to a provider store the server has NEVER verified against a cached
   * listing (pickup_mapping_status 'unknown', or absent on an older server).
   * Drives the always-visible hint naming the action that verifies it.
   */
  const unverifiedWired = (provider: DeliveryProvider): boolean => {
    const status = statusFor(provider);
    const mapping = mappingStatus(provider);
    return Boolean(
      status?.is_connected
      && provider !== 'steadfast'
      && status?.pickup_enabled
      && status?.provider_store_id
      && (mapping === null || mapping === 'unknown'),
    );
  };

  return (
    <MotionConfig reducedMotion="user">
      <div className="space-y-5">
        {/* Section header (no dashboard band; configuration/editor §5.6). */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h3 className="text-base font-semibold text-em-text-primary">
              {t('manageShop.deliverySettings.pickup.title')}
            </h3>
            <p className="mt-1 max-w-prose text-sm text-em-text-secondary">
              {t('manageShop.deliverySettings.pickup.description')}
            </p>
          </div>
          <EmButton
            variant="primary"
            className="gap-2 self-start"
            onClick={() => openForm({ mode: 'create', provider: 'manual' })}
            data-testid="pickup-add-location"
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            {t('manageShop.deliverySettings.pickup.addLocation')}
          </EmButton>
        </div>

        {/* Provider-first store panels (§C10/C11/C12/C14). */}
        <div className="space-y-4">
          <h4 className="text-sm font-semibold text-em-text-secondary">
            {t('manageShop.deliverySettings.pickup.storePanel')}
          </h4>
          <div className="grid gap-4 lg:grid-cols-2">
            {WORKSPACE_PROVIDERS.map((provider) => {
              const status = statusFor(provider);
              const isConnected = Boolean(status?.is_connected);
              const pill = derivedPill(provider);
              const stores = storesByProvider[provider] ?? [];
              const syncedAt = storesSyncedAt(provider);
              return (
                <section
                  key={provider}
                  data-testid={`pickup-provider-panel-${provider}`}
                  aria-label={t(PROVIDER_LABEL_KEYS[provider])}
                  className="min-w-0 rounded-xl border border-em-border bg-em-bg-surface p-4 sm:p-5"
                >
                  {/* flex-wrap + wrapping pill: honest long stale/unknown labels must never force horizontal overflow at 360/390 (§A8c/A9c). */}
                  <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
                    <div className="flex min-w-0 items-start gap-3">
                      <span className="inline-flex h-10 w-10 items-center justify-center rounded-lg bg-em-violet-100 text-em-violet-700">
                        <Store className="h-5 w-5" aria-hidden="true" />
                      </span>
                      <div>
                        <h5 className="text-sm font-semibold text-em-text-primary">{t(PROVIDER_LABEL_KEYS[provider])}</h5>
                        {syncedAt ? (
                          <p className="em-tabular mt-0.5 text-xs text-em-text-secondary">
                            {t('manageShop.deliverySettings.pickup.storesSyncedAt', { date: formatStoresSyncedDate(syncedAt, i18n?.language) })}
                          </p>
                        ) : (
                          <p className="mt-0.5 text-xs text-em-text-secondary">{t('manageShop.deliverySettings.pickup.notSyncedYet')}</p>
                        )}
                      </div>
                    </div>
                    <SignalPill kind={pill.kind} label={pill.label} testId={`pickup-sync-status-${provider}`} wrap />
                  </div>

                  {/* Steadfast: honest manual-only. Unconnected: connect-first hint. */}
                  {provider === 'steadfast' ? (
                    <p className="mt-4 rounded-lg border border-em-border bg-em-bg-muted px-3 py-2 text-sm text-em-text-secondary">
                      {t('manageShop.deliverySettings.pickup.manualOnly', { provider: t(PROVIDER_LABEL_KEYS.steadfast) })}
                    </p>
                  ) : !isConnected ? (
                    <p className="mt-4 rounded-lg border border-em-border bg-em-bg-muted px-3 py-2 text-sm text-em-text-secondary">
                      {t('manageShop.deliverySettings.pickup.connectFirstHelp', { provider: t(PROVIDER_LABEL_KEYS[provider]) })}
                    </p>
                  ) : (
                    <>
                      <div className="mt-4 flex flex-wrap items-center gap-2">
                        <EmButton
                          variant="secondary"
                          className="gap-2"
                          onClick={() => void handleFetchStores(provider)}
                          loading={storesLoading[provider]}
                          disabled={pending !== null}
                          data-testid={`pickup-fetch-stores-${provider}`}
                        >
                          <RefreshCw className="h-4 w-4" aria-hidden="true" />
                          {t('manageShop.deliverySettings.pickup.fetchStores')}
                        </EmButton>
                        {stores.length > 0 && (
                          <EmButton
                            variant="secondary"
                            className="gap-2"
                            onClick={() => void handleImportStores(provider)}
                            loading={pending === `import:${provider}:all`}
                            disabled={pending !== null}
                            data-testid={`pickup-import-stores-${provider}`}
                          >
                            <Download className="h-4 w-4" aria-hidden="true" />
                            {t('manageShop.deliverySettings.pickup.import')}
                          </EmButton>
                        )}
                        <EmButton
                          variant="ghost"
                          className="gap-2"
                          onClick={() => setExternal({ provider })}
                          data-testid={`pickup-create-external-${provider}`}
                        >
                          <Plus className="h-4 w-4" aria-hidden="true" />
                          {t('manageShop.deliverySettings.pickup.createProviderStore', { provider: t(PROVIDER_LABEL_KEYS[provider]) })}
                        </EmButton>
                        {(syncStatus[provider] === 'blocked' || syncStatus[provider] === 'attention' || mappingStatus(provider) === 'stale') && (
                          <EmButton
                            variant="attention"
                            className="gap-2"
                            onClick={() => void handleRetrySync(provider)}
                            loading={pending === `retry:${provider}`}
                            disabled={pending !== null}
                            data-testid={`pickup-retry-${provider}`}
                          >
                            <RefreshCw className="h-4 w-4" aria-hidden="true" />
                            {t('manageShop.deliverySettings.pickup.retry')}
                          </EmButton>
                        )}
                      </div>

                      {/* Never-verified wired mapping: name the action that fixes
                          it (Fetch/Import + re-link), not just the state (§A9).
                          Suppressed while an action message owns the feedback row. */}
                      {unverifiedWired(provider) && !storesLoading[provider]
                        && syncStatus[provider] !== 'pending' && syncStatus[provider] !== 'blocked' && (
                        <p
                          data-testid={`pickup-unverified-hint-${provider}`}
                          className="mt-3 flex items-start gap-1.5 rounded-lg border border-em-sunlight-700/20 bg-em-sunlight-100 px-3 py-2 text-sm text-em-sunlight-700"
                        >
                          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                          <span>
                            {t('manageShop.deliverySettings.pickup.mapping.unknownLinkedHint', { provider: t(PROVIDER_LABEL_KEYS[provider as PickupFormProvider]) })}
                          </span>
                        </p>
                      )}

                      {(storesError[provider] || syncMessage[provider]) && (() => {
                        const isError = Boolean(storesError[provider]) || syncStatus[provider] === 'blocked';
                        const tone = isError ? 'blocked' : syncStatus[provider] ?? 'review';
                        return (
                          <p
                            role={isError ? 'alert' : 'status'}
                            data-testid={`pickup-message-${provider}`}
                            className={`mt-3 flex items-start gap-1.5 text-sm ${
                              tone === 'blocked' ? 'text-em-danger-700'
                                : tone === 'healthy' ? 'text-em-success-700'
                                  : tone === 'pending' ? 'text-em-info-700'
                                    : tone === 'attention' ? 'text-em-sunlight-700'
                                      : 'text-em-text-secondary'
                            }`}
                          >
                            {storesLoading[provider] || tone === 'pending'
                              ? <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin" aria-hidden="true" />
                                : tone === 'healthy'
                                  ? <Check className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                                  : tone === 'blocked' || tone === 'attention'
                                    ? <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                                    : <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />}
                            <span>{storesError[provider] ?? syncMessage[provider]}</span>
                          </p>
                        );
                      })()}

                      {/* Provider store list — Import + Link per store (§C11). */}
                      <ul className="mt-3 space-y-2">
                        {stores.map((store) => {
                          const id = storeKey(store);
                          const alreadyLinked = status?.provider_store_id != null && String(status.provider_store_id) === id;
                          return (
                            <li
                              key={id}
                              data-testid={`pickup-store-row-${provider}-${id}`}
                              className="flex flex-col gap-2 rounded-lg border border-em-border bg-em-bg-muted px-3 py-2 sm:flex-row sm:items-center sm:justify-between"
                            >
                              <div className="min-w-0">
                                <p className="truncate text-sm font-medium text-em-text-primary">{storeTitle(store) || id}</p>
                                <p className="em-tabular truncate text-xs text-em-text-secondary">{storeMeta(store) || t('manageShop.deliverySettings.pickup.storeIdLabel', { id })}</p>
                              </div>
                              <div className="flex shrink-0 flex-wrap items-center gap-2">
                                {alreadyLinked && (
                                  <SignalPill kind="healthy" label={t('manageShop.deliverySettings.pickup.linkedBadge')} />
                                )}
                                <EmButton
                                  variant="ghost"
                                  className="min-h-11 px-2 text-sm gap-1.5"
                                  onClick={() => void handleImportStores(provider, [id])}
                                  loading={pending === `import:${provider}:1`}
                                  disabled={pending !== null}
                                  data-testid={`pickup-store-import-${provider}-${id}`}
                                >
                                  <Download className="h-4 w-4" aria-hidden="true" />
                                  {t('manageShop.deliverySettings.pickup.import')}
                                </EmButton>
                                <EmButton
                                  variant="secondary"
                                  className="min-h-11 px-2 text-sm gap-1.5"
                                  onClick={() => void handleLinkStore(provider, store)}
                                  loading={pending === `link:${provider}:${id}`}
                                  disabled={pending !== null || !selectedLocationId}
                                  title={selectedLocationId ? undefined : t('manageShop.deliverySettings.pickup.selectLocationFirst')}
                                  data-testid={`pickup-store-link-${provider}-${id}`}
                                >
                                  <Link2 className="h-4 w-4" aria-hidden="true" />
                                  {t('manageShop.deliverySettings.pickup.link')}
                                </EmButton>
                              </div>
                            </li>
                          );
                        })}
                        {stores.length === 0 && !storesLoading[provider] && (
                          <li className="rounded-lg border border-dashed border-em-border px-3 py-3 text-sm text-em-text-secondary">
                            {t('manageShop.deliverySettings.pickup.noStores')}
                          </li>
                        )}
                      </ul>
                    </>
                  )}
                </section>
              );
            })}
          </div>
        </div>

        {/* Local pickup locations list (§C7/C8/C9). */}
        <div className="space-y-3">
          <h4 className="text-sm font-semibold text-em-text-secondary">
            {t('manageShop.deliverySettings.pickup.localList')}
          </h4>

          {locationsError && (
            <p role="alert" data-testid="pickup-locations-error" className="flex items-start gap-1.5 text-sm text-em-danger-700">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <span>{locationsError}</span>
            </p>
          )}

          {/* Server-confirmed delete feedback (§17 inline first). */}
          {deleteNotice && (
            <p
              role="status"
              data-testid="pickup-delete-status"
              className="flex items-center gap-1.5 rounded-lg border border-em-success-700/20 bg-em-success-100 px-3 py-2 text-sm text-em-success-700"
            >
              <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span>{deleteNotice}</span>
            </p>
          )}

          {/* WHERE-NEXT pointer for the 409 "Complete pickup" deep-link flow (§A8). */}
          {nextStep && (
            <p
              role="status"
              data-testid="pickup-next-step"
              className="flex items-center gap-1.5 rounded-lg border border-em-success-700/20 bg-em-success-100 px-3 py-2 text-sm text-em-success-700"
            >
              <Check className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span>{nextStep}</span>
            </p>
          )}

          {editing && (
            <PickupForm
              // Key = target identity + open counter: switching Edit to another
              // row MUST remount the form so its useState initializers (row id +
              // every field) take the NEW row's values — a mounted form never
              // resets them (§A9, pinned by a unit test).
              key={`${editing.mode}:${editing.provider}:${editing.location?.id ?? 'new'}:${formNonce}`}
              provider={editing.provider}
              mode={editing.mode}
              initial={editing.location}
              initialMeta={editing.meta}
              onCancel={() => setEditing(null)}
              onSaved={handleFormSaved}
            />
          )}

          {loadingLocations && list.length === 0 ? (
            <div className="flex items-center gap-2 text-sm text-em-text-secondary">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              {t('manageShop.deliverySettings.pickup.loadingLocations')}
            </div>
          ) : list.length === 0 ? (
            <div className="rounded-xl border border-dashed border-em-border bg-em-bg-surface px-4 py-6 text-center">
              <MapPin className="mx-auto h-6 w-6 text-em-text-secondary" aria-hidden="true" />
              <p className="mt-2 text-sm font-medium text-em-text-primary">{t('manageShop.deliverySettings.pickup.noLocations')}</p>
              <p className="mx-auto mt-1 max-w-md text-sm text-em-text-secondary">{t('manageShop.deliverySettings.pickup.noLocationsHelp')}</p>
            </div>
          ) : (
            <ul className="space-y-2">
              {list.map((location) => {
                const isDefault = location.is_default;
                const isSelected = location.id === selectedLocationId;
                const locationProvider = rowProviderOf(location);
                return (
                  <li
                    key={location.id}
                    data-testid={`pickup-location-row-${location.id}`}
                    aria-current={isSelected ? 'true' : undefined}
                    className={`rounded-xl border bg-em-bg-surface p-4 ${isSelected ? 'border-em-violet-600' : 'border-em-border'}`}
                  >
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <button
                        type="button"
                        onClick={() => setSelectedLocationId(location.id ?? null)}
                        className={`min-w-0 flex-1 rounded-lg p-1 text-left ${FOCUS_RING}`}
                        aria-label={t('manageShop.deliverySettings.pickup.selectForLink', { name: location.display_name })}
                        data-testid={`pickup-location-select-${location.id}`}
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-semibold text-em-text-primary">{location.display_name}</span>
                          {isDefault && (
                            <span
                              data-testid={`pickup-location-default-${location.id}`}
                              className="inline-flex items-center gap-1 rounded-full bg-em-violet-100 px-2 py-0.5 text-xs font-medium text-em-violet-700"
                            >
                              <Star className="h-3 w-3 fill-current" aria-hidden="true" />
                              {t('manageShop.deliverySettings.defaultBadge')}
                            </span>
                          )}
                          <span className="inline-flex items-center gap-1 rounded-full bg-em-bg-muted px-2 py-0.5 text-xs font-medium text-em-text-secondary">
                            {t(PROVIDER_LABEL_KEYS[locationProvider])}
                          </span>
                          {isSelected && (
                            <span className="text-xs font-medium text-em-violet-700">{t('manageShop.deliverySettings.pickup.selectedForLink')}</span>
                          )}
                        </div>
                        <p className="em-tabular mt-1 text-sm text-em-text-secondary">
                          {[location.phone, location.area_name, location.city_name].filter(Boolean).join(' · ')}
                        </p>
                        {location.address && (
                          <p className="mt-0.5 text-xs text-em-text-secondary">{location.address}</p>
                        )}
                        {location.provider_store_id && (
                          <p className="em-tabular mt-1 text-xs text-em-text-secondary">
                            {t('manageShop.deliverySettings.pickup.linkedStoreId', { id: location.provider_store_id })}
                          </p>
                        )}
                      </button>
                      <div className="flex shrink-0 flex-wrap items-center gap-2">
                        {!isDefault && (
                          <EmButton
                            variant="ghost"
                            className="min-h-11 px-2 text-sm gap-1.5"
                            onClick={() => void handleSetDefault(location)}
                            loading={pending === `default:${location.id}`}
                            disabled={pending !== null}
                            data-testid={`pickup-set-default-${location.id}`}
                          >
                            <Star className="h-4 w-4" aria-hidden="true" />
                            {t('manageShop.deliverySettings.setAsDefault')}
                          </EmButton>
                        )}
                        <EmButton
                          variant="secondary"
                          className="min-h-11 px-3 text-sm"
                          onClick={() => openForm({
                            mode: 'edit',
                            provider: locationProvider,
                            location,
                            meta: rowMetaOf(location),
                          })}
                          disabled={pending !== null}
                          data-testid={`pickup-edit-${location.id}`}
                        >
                          {t('manageShop.deliverySettings.pickup.edit')}
                        </EmButton>
                        <EmButton
                          variant="danger"
                          className="min-h-11 px-3 text-sm gap-1.5"
                          onClick={() => openDeleteDialog(location)}
                          disabled={pending !== null}
                          data-testid={`pickup-delete-${location.id}`}
                        >
                          <Trash2 className="h-4 w-4" aria-hidden="true" />
                          {t('manageShop.deliverySettings.pickup.delete')}
                        </EmButton>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      {ambiguous && (
        <AmbiguousDialog
          state={ambiguous}
          language={i18n?.language}
          pending={pending === `resolve:${ambiguous.provider}`}
          onClose={() => setAmbiguous(null)}
          onChoose={resolveAmbiguous}
        />
      )}

      {deleteState && (
        <DeleteConfirmDialog
          state={deleteState}
          pending={pending === `confirm-delete:${deleteState.location.id}`}
          onCancel={() => setDeleteState(null)}
          onConfirm={() => void handleConfirmDelete()}
        />
      )}

      {external && (
        <ExternalCreateDialog
          provider={external.provider}
          language={i18n?.language}
          onClose={() => setExternal(null)}
          onCreated={async (created) => {
            setExternal(null);
            setProviderStatus(created, 'pending', t('manageShop.deliverySettings.pickup.storeCreateSyncing'));
            await handleFetchStores(created);
          }}
        />
      )}
    </MotionConfig>
  );
}

/* ------------------------------------------------------------------ *
 * Explicit-selection dialog for a 409 DELIVERY_PICKUP_AMBIGUOUS match.
 * Lists every candidate; the merchant MUST choose — never auto-picks
 * the first (§C13). Cancel is non-destructive and closes without linking.
 * ------------------------------------------------------------------ */
interface AmbiguousDialogProps {
  state: AmbiguousState;
  language?: string;
  pending: boolean;
  onClose: () => void;
  onChoose: (store: ProviderStoreView) => void | Promise<void>;
}
function AmbiguousDialog({ state, pending, onClose, onChoose }: AmbiguousDialogProps) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(ref, true);
  const [picked, setPicked] = useState<string | null>(null);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-em-midnight-950/60 p-4" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="pickup-ambiguous-title"
        className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-xl border border-em-border bg-em-bg-surface p-5 shadow-xl"
      >
        <div className="flex items-start gap-3">
          <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-em-sunlight-100 text-em-sunlight-700">
            <MapPin className="h-5 w-5" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h2 id="pickup-ambiguous-title" className="text-base font-semibold text-em-text-primary">
              {t('manageShop.deliverySettings.pickup.ambiguous.title')}
            </h2>
            <p className="mt-1 text-sm text-em-text-secondary">{t('manageShop.deliverySettings.pickup.ambiguous.body')}</p>
          </div>
        </div>

        <fieldset className="mt-4">
          <legend className="mb-2 text-xs font-semibold text-em-text-secondary">
            {t('manageShop.deliverySettings.pickup.ambiguous.candidatesLabel')}
          </legend>
          <div className="space-y-2">
            {state.candidates.map((store) => {
              const id = storeKey(store);
              return (
                <label
                  key={id}
                  data-testid={`pickup-ambiguous-option-${id}`}
                  className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 ${picked === id ? 'border-em-violet-600 bg-em-violet-50' : 'border-em-border bg-em-bg-muted'}`}
                >
                  <input
                    type="radio"
                    name="pickup-ambiguous"
                    value={id}
                    checked={picked === id}
                    onChange={() => setPicked(id)}
                    className="mt-1 h-4 w-4 shrink-0 accent-em-violet-600"
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-em-text-primary">{storeTitle(store) || id}</span>
                    <span className="em-tabular block text-xs text-em-text-secondary">{storeMeta(store) || id}</span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>

        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <EmButton variant="secondary" onClick={onClose}>{t('common.cancel')}</EmButton>
          <EmButton
            variant="primary"
            loading={pending}
            disabled={!picked || pending}
            onClick={() => {
              const chosen = state.candidates.find((store) => storeKey(store) === picked);
              if (chosen) void onChoose(chosen);
            }}
            data-testid="pickup-ambiguous-confirm"
          >
            {t('manageShop.deliverySettings.pickup.ambiguous.choose')}
          </EmButton>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Danger confirm for EVERY delete (§C9/C12, §12). The row's labeled
 * Delete always opens this dialog — pre-enriched from local data (shop
 * default / provider rows wired to the location) — and the DELETE fires
 * only after a deliberate confirm, with ?confirm=true. Cancel is the
 * focused/safe default; a late server 409 keeps the dialog open and
 * re-surfaces its blockers.
 * ------------------------------------------------------------------ */
interface DeleteConfirmDialogProps {
  state: DeleteState;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
}
function DeleteConfirmDialog({ state, pending, onCancel, onConfirm }: DeleteConfirmDialogProps) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(ref, true);
  const blockerLabel = (blocker: DeleteBlocker) => {
    if (blocker.code === 'IS_SHOP_DEFAULT') return t('manageShop.deliverySettings.pickup.deleteBlockedDefault');
    if (blocker.code === 'IN_USE') {
      // Server rows carry raw provider enums — show the merchant-facing labels
      // (§A9); unknown enums pass through untranslated rather than rendering
      // 'undefined'.
      const providers = Array.isArray(blocker.providers) && blocker.providers.length > 0
        ? blocker.providers
          .map((value) => {
            const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
            return normalized === 'pathao' || normalized === 'redx' || normalized === 'steadfast' || normalized === 'manual'
              ? t(PROVIDER_LABEL_KEYS[normalized as PickupFormProvider])
              : String(value ?? '');
          })
          .filter(Boolean)
          .join(', ')
        : '';
      return providers
        ? t('manageShop.deliverySettings.pickup.deleteBlockedInUseProviders', { providers })
        : t('manageShop.deliverySettings.pickup.deleteBlockedInUse');
    }
    return blocker.message ?? t('manageShop.deliverySettings.pickup.deleteBlockedGeneric');
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-em-midnight-950/60 p-4" onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div
        ref={ref}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="pickup-delete-title"
        aria-describedby="pickup-delete-desc"
        className="w-full max-w-md rounded-xl border border-em-border bg-em-bg-surface p-5 shadow-xl"
      >
        <div className="flex items-start gap-3">
          <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-em-danger-100 text-em-danger-700">
            <TriangleAlert className="h-5 w-5" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h2 id="pickup-delete-title" className="text-base font-semibold text-em-text-primary">
              {t('manageShop.deliverySettings.pickup.deleteConfirm', { name: state.location.display_name })}
            </h2>
            <p id="pickup-delete-desc" className="mt-1 text-sm text-em-text-secondary">
              {t('manageShop.deliverySettings.pickup.deleteConfirmBody')}
            </p>
          </div>
        </div>

        {state.blockers.length > 0 && (
          <ul className="mt-3 space-y-1 rounded-lg border border-em-sunlight-700/20 bg-em-sunlight-100 px-3 py-2 text-sm text-em-sunlight-700" data-testid="pickup-delete-blockers">
            {state.blockers.map((blocker, index) => (
              <li key={`${blocker.code ?? 'blocker'}-${index}`} className="flex items-start gap-1.5">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                <span>{blockerLabel(blocker)}</span>
              </li>
            ))}
          </ul>
        )}

        {state.note && (
          <p role="alert" data-testid="pickup-delete-error" className="mt-3 flex items-start gap-1.5 text-sm text-em-danger-700">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{state.note}</span>
          </p>
        )}

        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <EmButton variant="secondary" onClick={onCancel} data-testid="pickup-delete-cancel">{t('common.cancel')}</EmButton>
          <EmButton
            variant="danger"
            loading={pending}
            disabled={pending}
            onClick={() => void onConfirm()}
            data-testid="pickup-delete-confirm"
          >
            {t('manageShop.deliverySettings.pickup.deleteConfirmAction')}
          </EmButton>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Merchant-confirmed EXTERNAL store create (§C12). The dialog states the
 * impact and requires an explicit Confirm before any provider call — the
 * create endpoint is never hit until that button is pressed.
 * ------------------------------------------------------------------ */
interface ExternalCreateDialogProps {
  provider: DeliveryProvider;
  language?: string;
  onClose: () => void;
  onCreated: (provider: DeliveryProvider) => void | Promise<void>;
}
function ExternalCreateDialog({ provider, onClose, onCreated }: ExternalCreateDialogProps) {
  const { t, i18n } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(ref, true);
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [phone, setPhone] = useState('');
  const [cityId, setCityId] = useState('');
  const [zoneId, setZoneId] = useState('');
  const [areaId, setAreaId] = useState('');
  const [cities, setCities] = useState<DeliveryLocationOption[]>([]);
  const [zones, setZones] = useState<DeliveryLocationOption[]>([]);
  const [areas, setAreas] = useState<DeliveryLocationOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadZones = async (nextCityId: string) => {
    if (!nextCityId || !orderApi.getPathaoZones) return;
    try { setZones(await orderApi.getPathaoZones(providerId(nextCityId))); } catch { /* keep prior selection */ }
  };
  const loadAreas = async (nextZoneId: string) => {
    if (!nextZoneId || !orderApi.getPathaoAreas) return;
    try { setAreas(await orderApi.getPathaoAreas(providerId(nextZoneId))); } catch { /* keep prior selection */ }
  };

  useEffect(() => {
    let mounted = true;
    if (provider === 'pathao' && orderApi.getPathaoCities) {
      setLoading(true);
      void orderApi.getPathaoCities()
        .then((rows) => { if (mounted) setCities(rows); })
        .finally(() => { if (mounted) setLoading(false); });
    } else if (provider === 'redx' && orderApi.getProviderAreas) {
      setLoading(true);
      void orderApi.getProviderAreas('redx')
        .then((rows) => { if (mounted) setAreas(rows); })
        .finally(() => { if (mounted) setLoading(false); });
    }
    return () => { mounted = false; };
  }, [provider]);

  const ready = name.trim().length >= 2 && address.trim().length >= 3 && (!phone || BD_PHONE_REGEX.test(phone));

  const attemptCreate = async () => {
    setSubmitting(true);
    setError(null);
    const payload: ExternalStorePayload = {
      name: name.trim(),
      address: address.trim(),
      ...(phone ? { phone: phone.trim() } : {}),
      enabled: true,
    };
    if (provider === 'pathao') {
      if (cityId) payload.city_id = providerId(cityId);
      if (zoneId) payload.zone_id = providerId(zoneId);
      if (areaId) payload.area_id = providerId(areaId);
    } else if (provider === 'redx' && areaId) {
      payload.area_id = providerId(areaId);
    }
    try {
      await api.createProviderStore(provider, payload, true);
      await onCreated(provider);
    } catch (err) {
      const code = getErrorCode(err);
      setConfirming(false);
      setError(
        code === 'DELIVERY_PICKUP_STORE_CREATE_UNSUPPORTED'
          ? t('manageShop.deliverySettings.pickup.errors.createUnsupported')
          : code === 'DELIVERY_PICKUP_STORE_SYNC_FAILED'
            ? t('manageShop.deliverySettings.pickup.errors.createSyncFailed')
            : getErrorMessage(err, t('manageShop.deliverySettings.pickup.errors.createStoreFailed')),
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-em-midnight-950/60 p-4" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="pickup-external-title"
        className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-xl border border-em-border bg-em-bg-surface p-5 shadow-xl"
      >
        <h2 id="pickup-external-title" className="text-base font-semibold text-em-text-primary">
          {confirming
            ? t('manageShop.deliverySettings.pickup.external.confirmTitle', { provider: t(PROVIDER_LABEL_KEYS[provider]) })
            : t('manageShop.deliverySettings.pickup.external.title', { provider: t(PROVIDER_LABEL_KEYS[provider]) })}
        </h2>

        {error && (
          <p role="alert" data-testid="pickup-external-error" className="mt-2 flex items-start gap-1.5 text-sm text-em-danger-700">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{error}</span>
          </p>
        )}

        {confirming ? (
          <>
            <p className="mt-2 text-sm text-em-text-secondary">
              {t('manageShop.deliverySettings.pickup.external.confirmBody', { provider: t(PROVIDER_LABEL_KEYS[provider]) })}
            </p>
            <ul className="mt-3 space-y-1 rounded-lg border border-em-border bg-em-bg-muted px-3 py-2 text-sm text-em-text-primary">
              <li className="font-medium">{name}</li>
              <li className="text-em-text-secondary">{address}</li>
              {phone && <li className="em-tabular text-em-text-secondary">{phone}</li>}
            </ul>
            <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <EmButton variant="secondary" onClick={() => setConfirming(false)} data-testid="pickup-external-back">{t('common.cancel')}</EmButton>
              <EmButton
                variant="primary"
                loading={submitting}
                disabled={submitting}
                onClick={() => void attemptCreate()}
                data-testid="pickup-external-confirm"
              >
                {t('manageShop.deliverySettings.pickup.external.confirmAction', { provider: t(PROVIDER_LABEL_KEYS[provider]) })}
              </EmButton>
            </div>
          </>
        ) : (
          <>
            <p className="mt-1 text-sm text-em-text-secondary">{t('manageShop.deliverySettings.pickup.external.impact')}</p>
            <div className="mt-4 space-y-4">
              <label className="block">
                <span className="mb-1.5 block text-sm font-medium text-em-text-primary">
                  {t('courier.pickup.name')} <span className="text-em-danger-700" aria-hidden="true">*</span>
                </span>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  aria-required="true"
                  className={`min-h-11 w-full rounded-md border border-em-border-strong bg-em-bg-surface px-3 text-sm text-em-text-primary outline-none ${FOCUS_RING}`}
                  data-testid="pickup-external-name"
                />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-sm font-medium text-em-text-primary">
                  {t('courier.pickup.address')} <span className="text-em-danger-700" aria-hidden="true">*</span>
                </span>
                <textarea
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  rows={2}
                  aria-required="true"
                  className={`min-h-11 w-full rounded-md border border-em-border-strong bg-em-bg-surface px-3 py-2 text-sm text-em-text-primary outline-none ${FOCUS_RING}`}
                  data-testid="pickup-external-address"
                />
              </label>
              <BDPhoneInput id="pickup-external-phone" label={t('courier.pickup.phone')} value={phone} onChange={setPhone} />
              {provider === 'pathao' && (
                <div className="grid gap-3 sm:grid-cols-3">
                  <select
                    aria-label={t('courier.pickup.city')}
                    value={cityId}
                    disabled={loading}
                    onChange={(e) => { const v = e.target.value; setCityId(v); setZoneId(''); setAreaId(''); setZones([]); setAreas([]); void loadZones(v); }}
                    className={`min-h-11 w-full rounded-md border border-em-border-strong bg-em-bg-surface px-3 text-sm text-em-text-primary outline-none ${FOCUS_RING}`}
                    data-testid="pickup-external-city"
                  >
                    <option value="">{t('courier.pickup.selectCity')}</option>
                    {cities.map((option) => (
                      <option key={optionId(option, 'city')} value={optionId(option, 'city')}>{optionLabel(option, i18n?.language)}</option>
                    ))}
                  </select>
                  <select
                    aria-label={t('courier.pickup.zone')}
                    value={zoneId}
                    disabled={!cityId}
                    onChange={(e) => { const v = e.target.value; setZoneId(v); setAreaId(''); setAreas([]); void loadAreas(v); }}
                    className={`min-h-11 w-full rounded-md border border-em-border-strong bg-em-bg-surface px-3 text-sm text-em-text-primary outline-none ${FOCUS_RING}`}
                    data-testid="pickup-external-zone"
                  >
                    <option value="">{t('courier.pickup.selectZone')}</option>
                    {zones.map((option) => (
                      <option key={optionId(option, 'zone')} value={optionId(option, 'zone')}>{optionLabel(option, i18n?.language)}</option>
                    ))}
                  </select>
                  <select
                    aria-label={t('courier.pickup.area')}
                    value={areaId}
                    disabled={!zoneId}
                    onChange={(e) => setAreaId(e.target.value)}
                    className={`min-h-11 w-full rounded-md border border-em-border-strong bg-em-bg-surface px-3 text-sm text-em-text-primary outline-none ${FOCUS_RING}`}
                    data-testid="pickup-external-area"
                  >
                    <option value="">{t('courier.pickup.selectArea')}</option>
                    {areas.map((option) => (
                      <option key={optionId(option, 'area')} value={optionId(option, 'area')}>{optionLabel(option, i18n?.language)}</option>
                    ))}
                  </select>
                </div>
              )}
              {provider === 'redx' && (
                <select
                  aria-label={t('courier.pickup.area')}
                  value={areaId}
                  disabled={loading}
                  onChange={(e) => setAreaId(e.target.value)}
                  className={`min-h-11 w-full rounded-md border border-em-border-strong bg-em-bg-surface px-3 text-sm text-em-text-primary outline-none ${FOCUS_RING}`}
                  data-testid="pickup-external-area"
                >
                  <option value="">{t('courier.pickup.selectArea')}</option>
                  {areas.map((option) => (
                    <option key={optionId(option, 'area')} value={optionId(option, 'area')}>{optionLabel(option, i18n?.language)}</option>
                  ))}
                </select>
              )}
            </div>
            <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <EmButton variant="secondary" onClick={onClose} data-testid="pickup-external-cancel">{t('common.cancel')}</EmButton>
              <EmButton
                variant="primary"
                disabled={!ready}
                onClick={() => setConfirming(true)}
                data-testid="pickup-external-request"
              >
                {t('manageShop.deliverySettings.pickup.external.next', { provider: t(PROVIDER_LABEL_KEYS[provider]) })}
              </EmButton>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
