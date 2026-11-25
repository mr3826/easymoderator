/**
 * PickupTab (Tab 2) unit contracts. The WHOLE order-domain module is mocked
 * (including A0's not-yet-landed pickup client fns) so the tab is testable now.
 * PickupForm is stubbed to isolate the workspace behaviour (its own field tests
 * live in PickupForm.test.tsx). react-i18next is a label map.
 *
 * Covers the task's required behaviours:
 *   existing-store list + link · ambiguous → explicit selection (no first-match)
 *   · confirm-before-external-create · safe-delete ALWAYS confirms first (labeled
 *     Delete opens the dialog; DELETE fires only with confirm:true; cancel deletes
 *     nothing; server-confirmed success notice; late 409 re-surfaces blockers)
 *   · Fetch stores is a PURE READ (never consumes envelope pickup_locations) ·
 *     selective import 409 DELIVERY_STORE_IDS_UNMATCHED names the ids
 *   · stale mapping stays attention through Fetch and reloads are
 *     SERVER-authoritative — no local override: A5c refreshes the cached listing
 *     inside LINK/MATCHED, so green arrives with the fresh server status;
 *     PRESERVED/NO_MATCH = attention + hint naming Import→re-link; unknown+wired
 *     = attention "not verified" + hint, NEVER the green confirmed pill (§A9)
 *   · Edit re-targeting REMOUNTS the form on the new row (real PickupForm test)
 *   · focusProvider opens once per prop-driven open + onFocusConsumed · it opens
 *     EDIT on the provider's existing row (create only when none) · deep-link
 *     save shows the return-to-Providers WHERE-NEXT pointer
 *   · retry after failed sync · steadfast manual-only · create-then-sync is NOT a
 *     link/activate (separate actions).
 */
import '@testing-library/jest-dom';
import { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PickupTab from '../PickupTab';
import type { DeliveryProviderStatus, PickupLocation } from '@/api/types/order';

// Test-local switch: default keeps the stub form (workspace-action isolation);
// the Edit re-target test flips this to mount the REAL PickupForm so the
// remount-on-retarget + PUT-target pin is honest (§A9).
const formMode = vi.hoisted(() => ({ useReal: false }));
// Active i18n language, switchable per test (bn-BD numeral formatting, §A9).
const i18nState = vi.hoisted(() => ({ language: 'en' }));

const mocks = vi.hoisted(() => ({
  getPickupLocations: vi.fn(),
  createPickupLocation: vi.fn(),
  updatePickupLocation: vi.fn(),
  syncProviderPickup: vi.fn(),
  getProviderAreas: vi.fn(),
  getPathaoCities: vi.fn(),
  getPathaoZones: vi.fn(),
  getPathaoAreas: vi.fn(),
  listProviderStores: vi.fn(),
  importProviderStores: vi.fn(),
  setProviderPickup: vi.fn(),
  createProviderStore: vi.fn(),
  setDefaultPickupLocation: vi.fn(),
  deletePickupLocation: vi.fn(),
  retryPickupSync: vi.fn(),
  activateDeliveryProvider: vi.fn(),
}));

vi.mock('@/api/domains/order', () => ({
  ...mocks,
  getDeliverySettings: vi.fn(async () => ({ providers: [], settings: {} })),
  getOrders: vi.fn(async () => []),
  getOrderCounts: vi.fn(async () => ({})),
}));
vi.mock('@shared/lib/http/errors', () => ({
  getErrorMessage: (error: unknown, fallback: string) => (error instanceof Error ? error.message : fallback),
}));
// Stub the local create/edit form so the tab test stays on workspace actions.
// The stub mirrors the REAL form's useState-initializer semantics: it captures
// the mounted target ONCE, so a re-target without a key-based remount would keep
// showing the old row's identity — exactly the §A9 bug the remount must prevent.
vi.mock('../PickupForm', async (importOriginal) => {
  const actual = (await importOriginal()) as { default: unknown };
  function StubPickupForm({ provider, mode, initial, onSaved }: {
    provider: string;
    mode: string;
    initial?: { id?: string } | null;
    onSaved: (r: unknown) => void;
  }) {
    const [mountedTarget] = useState(`${mode}:${initial?.id ?? 'new'}`);
    return (
      <div role="dialog" aria-label={`pickup form ${mode}`}>
        <button type="button" data-testid="stub-form-save" onClick={() => onSaved({ location: { id: 'loc-new', display_name: 'New hub', provider_store_id: null }, providerMeta: { city_id: '5' } })}>stub save</button>
        <span data-testid="stub-form-provider">{provider}</span>
        <span data-testid="stub-form-mounted-target">{mountedTarget}</span>
      </div>
    );
  }
  return {
    get default() {
      return formMode.useReal ? actual.default : StubPickupForm;
    },
  };
});
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => {
      const labels: Record<string, string> = {
        'common.cancel': 'Cancel',
        'common.close': 'Close',
        'manageShop.deliverySettings.pickup.title': 'Pickup locations',
        'manageShop.deliverySettings.pickup.description': 'Manage where the courier collects parcels.',
        'manageShop.deliverySettings.pickup.addLocation': 'Add pickup location',
        'manageShop.deliverySettings.pickup.storePanel': 'Provider pickup stores',
        'manageShop.deliverySettings.pickup.localList': 'Saved pickup locations',
        'manageShop.deliverySettings.pickup.fetchStores': 'Fetch stores',
        'manageShop.deliverySettings.pickup.import': 'Import',
        'manageShop.deliverySettings.pickup.link': 'Link',
        'manageShop.deliverySettings.pickup.retry': 'Retry',
        'manageShop.deliverySettings.pickup.noStores': 'No stores loaded',
        'manageShop.deliverySettings.pickup.synced': `${values?.n ?? 0} stores available`,
        'manageShop.deliverySettings.pickup.storesFailed': 'Could not load stores',
        'manageShop.deliverySettings.pickup.storesSyncedAt': `Synced ${values?.date ?? ''}`,
        'manageShop.deliverySettings.pickup.notSyncedYet': 'Not synced yet',
        'manageShop.deliverySettings.pickup.manualOnly': `${values?.provider ?? ''} pickup is set up manually.`,
        'manageShop.deliverySettings.pickup.manualOnlyShort': 'Manual only',
        'manageShop.deliverySettings.pickup.connectFirst': 'Not connected',
        'manageShop.deliverySettings.pickup.connectFirstHelp': `Connect ${values?.provider ?? ''} to import stores.`,
        'manageShop.deliverySettings.pickup.unsupported': 'Not supported',
        'manageShop.deliverySettings.pickup.mapping.stale': 'Mapping needs review',
        'manageShop.deliverySettings.pickup.mapping.confirmed': 'Linked & confirmed',
        'manageShop.deliverySettings.pickup.mapping.unknown': 'Not linked yet',
        'manageShop.deliverySettings.pickup.mapping.unknownLinked': "Linked — not verified against the courier's store list",
        'manageShop.deliverySettings.pickup.mapping.unknownLinkedHint': `Never matched to ${values?.provider ?? ''}'s current store list — Fetch or Import, then Link again to verify.`,
        'manageShop.deliverySettings.pickup.linked': `Linked to ${values?.store ?? ''}`,
        'manageShop.deliverySettings.pickup.linkedBadge': 'Linked',
        'manageShop.deliverySettings.pickup.selectLocationFirst': 'Select a location first',
        'manageShop.deliverySettings.pickup.storeIdLabel': `Store ${values?.id ?? ''}`,
        'manageShop.deliverySettings.pickup.selectedForLink': 'Selected',
        'manageShop.deliverySettings.pickup.selectForLink': `Select ${values?.name ?? ''} for linking`,
        'manageShop.deliverySettings.pickup.linkedStoreId': `Provider store ${values?.id ?? ''}`,
        'manageShop.deliverySettings.pickup.edit': 'Edit',
        'manageShop.deliverySettings.pickup.delete': 'Delete',
        'manageShop.deliverySettings.pickup.createProviderStore': `Create store at ${values?.provider ?? ''}`,
        'manageShop.deliverySettings.pickup.importing': 'Importing…',
        'manageShop.deliverySettings.pickup.linking': 'Linking…',
        'manageShop.deliverySettings.pickup.syncing': 'Syncing…',
        'manageShop.deliverySettings.pickup.importDone': 'Stores imported',
        'manageShop.deliverySettings.pickup.noLocations': 'No pickup locations yet',
        'manageShop.deliverySettings.pickup.noLocationsHelp': 'Import from a provider or create one.',
        'manageShop.deliverySettings.pickup.loadingLocations': 'Loading locations…',
        'manageShop.deliverySettings.defaultBadge': 'Default',
        'manageShop.deliverySettings.setAsDefault': 'Set as default',
        'manageShop.deliverySettings.pickup.ambiguous.title': 'Multiple pickup stores match',
        'manageShop.deliverySettings.pickup.ambiguous.body': 'Choose the right store — EasyModerator will not guess.',
        'manageShop.deliverySettings.pickup.ambiguous.candidatesLabel': 'Matching stores',
        'manageShop.deliverySettings.pickup.ambiguous.choose': 'Use selected store',
        'manageShop.deliverySettings.pickup.deleteConfirm': `Delete ${values?.name ?? ''}?`,
        'manageShop.deliverySettings.pickup.deleteConfirmBody': 'This cannot be undone here.',
        'manageShop.deliverySettings.pickup.deleteConfirmAction': 'Delete anyway',
        'manageShop.deliverySettings.pickup.deleteBlockedDefault': 'This is your default pickup location.',
        'manageShop.deliverySettings.pickup.deleteBlockedInUse': 'In use by a courier integration.',
        'manageShop.deliverySettings.pickup.deleteBlockedInUseProviders': `In use by: ${values?.providers ?? ''}`,
        'manageShop.deliverySettings.pickup.deleteBlockedGeneric': 'Blocked.',
        'manageShop.deliverySettings.pickup.providers.pathao': 'Pathao Courier',
        'manageShop.deliverySettings.pickup.providers.redx': 'RedX Courier',
        'manageShop.deliverySettings.pickup.providers.steadfast': 'Steadfast Courier',
        'manageShop.deliverySettings.pickup.providers.manual': 'Manual',
        'manageShop.deliverySettings.pickup.external.title': `New store at ${values?.provider ?? ''}`,
        'manageShop.deliverySettings.pickup.external.impact': 'This creates a store directly at the courier.',
        'manageShop.deliverySettings.pickup.external.next': `Continue to confirm at ${values?.provider ?? ''}`,
        'manageShop.deliverySettings.pickup.external.confirmTitle': `Confirm new store at ${values?.provider ?? ''}`,
        'manageShop.deliverySettings.pickup.external.confirmBody': 'EasyModerator will create this store at the courier. This is not reversible here.',
        'manageShop.deliverySettings.pickup.external.confirmAction': `Create at ${values?.provider ?? ''}`,
        'manageShop.deliverySettings.pickup.statusPills.review': 'Review',
        'manageShop.deliverySettings.pickup.statusPills.pending': 'Pending',
        'manageShop.deliverySettings.pickup.statusPills.blocked': 'Attention needed',
        'manageShop.deliverySettings.pickup.storeCreateSyncing': 'Refreshing stores…',
        'manageShop.deliverySettings.pickup.deleted': `Deleted ${values?.name ?? ''}.`,
        'manageShop.deliverySettings.pickup.resolutions.MATCHED': 'Matched an existing store.',
        // PRESERVED/NO_MATCH honesty (§A9): the hint must NAME the fixing action.
        'manageShop.deliverySettings.pickup.staleStoreHint': 'Import to refresh the courier’s store list, then link again.',
        'manageShop.deliverySettings.pickup.unmatchedStores': `Not listed by courier: ${values?.ids ?? ''}`,
        'manageShop.deliverySettings.pickup.returnToProviders': 'Pickup saved — return to Courier Providers to Activate.',
        'manageShop.deliverySettings.errors.updateDefaultFailed': 'Could not update default',
        'manageShop.deliverySettings.pickup.errors.importFailed': 'Could not import these stores.',
        'manageShop.deliverySettings.pickup.errors.deleteBlocked': 'This location can’t be deleted.',
      };
      if (key in labels) return labels[key];
      if (typeof values?.defaultValue === 'string') return values.defaultValue;
      return key;
    },
    i18n: { get language() { return i18nState.language; } },
  }),
}));

const status = (
  provider: 'pathao' | 'steadfast' | 'redx',
  overrides: Record<string, unknown> = {},
): DeliveryProviderStatus => ({
  provider,
  display_name: `${provider} Courier`,
  is_connected: true,
  is_active: false,
  is_sandbox: false,
  metadata: {},
  last_validated_at: null,
  connected_at: null,
  ...overrides,
} as DeliveryProviderStatus);

const location = (id: string, overrides: Partial<PickupLocation> = {}): PickupLocation => ({
  id,
  display_name: `Hub ${id}`,
  phone: '01712345678',
  address: `Address ${id}`,
  area_name: `Area ${id}`,
  is_default: false,
  ...overrides,
});

const conflict409 = (code: string, details: Record<string, unknown>) => ({
  response: { status: 409, data: { code, details } },
});

const renderTab = (providers: DeliveryProviderStatus[], opts = {}) =>
  render(<PickupTab providers={providers} onMutate={vi.fn(async () => {})} {...opts} />);

beforeEach(() => {
  vi.clearAllMocks();
  formMode.useReal = false;
  i18nState.language = 'en';
  mocks.getPathaoCities.mockResolvedValue([{ id: '1', city_id: 1, name: 'Dhaka' }]);
  mocks.getPathaoZones.mockResolvedValue([{ id: '2', zone_id: 2, name: 'Mirpur' }]);
  mocks.getPathaoAreas.mockResolvedValue([{ id: '3', area_id: 3, name: 'Kallyanpur' }]);
  mocks.getProviderAreas.mockResolvedValue([{ id: '9', area_id: 9, name: 'Gulshan' }]);
  mocks.getPickupLocations.mockResolvedValue([location('loc1', { is_default: true, provider: 'pathao' })]);
  mocks.listProviderStores.mockResolvedValue({ provider: 'pathao', stores: [], pickup_locations: [], capability: 'IMPLEMENTED_NOT_LIVE_VERIFIED' });
  mocks.setProviderPickup.mockResolvedValue({ store_resolution: 'LINKED', pickup_enabled: true });
  mocks.importProviderStores.mockResolvedValue({ provider: 'pathao', stores: [], pickup_locations: [] });
  mocks.syncProviderPickup.mockResolvedValue({ provider: 'pathao', store_resolution: 'MATCHED' });
  mocks.retryPickupSync.mockResolvedValue({ provider: 'pathao', store_resolution: 'MATCHED' });
  mocks.createProviderStore.mockResolvedValue({ provider: 'pathao', created: true, store: { store_id: 'new-s' } });
  mocks.setDefaultPickupLocation.mockResolvedValue(location('loc1', { is_default: true }));
  mocks.deletePickupLocation.mockResolvedValue({ id: 'loc1', deleted: true, released_providers: [] });
});

describe('PickupTab — provider-first store list + link', () => {
  it('fetches existing provider stores and renders each as a row (no auto-link)', async () => {
    mocks.listProviderStores.mockResolvedValueOnce({
      provider: 'pathao',
      stores: [
        { store_id: 's1', store_name: 'Dhanmondi Hub', city_id: 1, zone_id: 2 },
        { store_id: 's2', store_name: 'Gulshan Hub', city_id: 1, zone_id: 3 },
      ],
      pickup_locations: [],
      capability: 'IMPLEMENTED_NOT_LIVE_VERIFIED',
    });
    renderTab([status('pathao')]);
    fireEvent.click(screen.getByTestId('pickup-fetch-stores-pathao'));
    expect(await screen.findByTestId('pickup-store-row-pathao-s1')).toBeInTheDocument();
    expect(screen.getByTestId('pickup-store-row-pathao-s2')).toBeInTheDocument();
    // Nothing is linked until the merchant explicitly acts (§C13 — never first-match).
    expect(mocks.setProviderPickup).not.toHaveBeenCalled();
  });

  it('a successful pure Fetch on an unknown-wired mapping never paints the pill success-green (§A9)', async () => {
    mocks.listProviderStores.mockResolvedValueOnce({
      provider: 'pathao',
      stores: [{ store_id: 's9', store_name: 'Main Store' }],
      capability: 'IMPLEMENTED_NOT_LIVE_VERIFIED',
    });
    renderTab([status('pathao', { pickup_mapping_status: 'unknown', provider_store_id: 's9', pickup_enabled: true })]);
    fireEvent.click(screen.getByTestId('pickup-fetch-stores-pathao'));
    expect(await screen.findByTestId('pickup-store-row-pathao-s9')).toBeInTheDocument();
    const pill = screen.getByTestId('pickup-sync-status-pathao');
    // A listing read proves readability, NOT that the wired store matches:
    // success-green is reserved for a server-confirmed mapping (A6r3 defect pin).
    expect(pill.className).not.toContain('bg-em-success-100');
    expect(screen.getByTestId('pickup-unverified-hint-pathao')).toBeInTheDocument();
  });

  it('links a chosen store to the selected location with the authoritative id', async () => {
    mocks.listProviderStores.mockResolvedValueOnce({
      provider: 'pathao',
      stores: [{ store_id: 's1', store_name: 'Dhanmondi Hub', city_id: 1, zone_id: 2 }],
      pickup_locations: [],
    });
    renderTab([status('pathao')]);
    fireEvent.click(screen.getByTestId('pickup-fetch-stores-pathao'));
    fireEvent.click(await screen.findByTestId('pickup-store-link-pathao-s1'));
    await waitFor(() => expect(mocks.setProviderPickup).toHaveBeenCalledWith(
      'pathao',
      expect.objectContaining({ store_id: 's1', pickup_location_id: 'loc1', enabled: true }),
    ));
    expect(await screen.findByTestId('pickup-message-pathao')).toHaveTextContent('Linked to Dhanmondi Hub');
  });
});

describe('PickupTab — ambiguous match forces explicit selection', () => {
  it('opens a candidate list and never auto-picks the first', async () => {
    mocks.listProviderStores.mockResolvedValueOnce({
      provider: 'pathao',
      stores: [{ store_id: 's1', store_name: 'Match A' }],
    });
    mocks.setProviderPickup.mockRejectedValueOnce(conflict409('DELIVERY_PICKUP_AMBIGUOUS', {
      provider: 'pathao',
      candidates: [
        { store_id: 'alpha', store_name: 'Alpha Store', city_id: 1 },
        { store_id: 'beta', store_name: 'Beta Store', city_id: 2 },
      ],
    }));
    renderTab([status('pathao')]);
    fireEvent.click(screen.getByTestId('pickup-fetch-stores-pathao'));
    fireEvent.click(await screen.findByTestId('pickup-store-link-pathao-s1'));

    // The explicit-selection dialog is open (assert on its unique rows, not the shared title).
    expect(await screen.findByTestId('pickup-ambiguous-option-alpha')).toBeInTheDocument();
    expect(screen.getByTestId('pickup-ambiguous-option-beta')).toBeInTheDocument();
    // No resolution happened on its own.
    expect(mocks.syncProviderPickup).not.toHaveBeenCalled();
    // Confirm is disabled until the merchant actually picks a candidate.
    expect(screen.getByTestId('pickup-ambiguous-confirm')).toBeDisabled();

    fireEvent.click(screen.getByTestId('pickup-ambiguous-option-beta'));
    await waitFor(() => expect(screen.getByTestId('pickup-ambiguous-confirm')).not.toBeDisabled());
    fireEvent.click(screen.getByTestId('pickup-ambiguous-confirm'));
    await waitFor(() => expect(mocks.syncProviderPickup).toHaveBeenCalledWith(
      'pathao',
      expect.objectContaining({ store_id: 'beta' }),
    ));
  });
});

describe('PickupTab — external store create requires explicit confirmation', () => {
  it('does not call the provider until the merchant confirms', async () => {
    renderTab([status('pathao')]);
    fireEvent.click(screen.getByTestId('pickup-create-external-pathao'));
    const dialog = await screen.findByRole('dialog', { name: /New store at Pathao Courier/ });
    expect(dialog).toBeInTheDocument();
    expect(mocks.createProviderStore).not.toHaveBeenCalled();

    fireEvent.change(screen.getByTestId('pickup-external-name'), { target: { value: 'Warehouse North' } });
    fireEvent.change(screen.getByTestId('pickup-external-address'), { target: { value: '123 Ring Road, Dhaka' } });
    // Moving to the confirm step still must not fire the create call.
    fireEvent.click(screen.getByTestId('pickup-external-request'));
    expect(await screen.findByText(/Confirm new store at Pathao Courier/)).toBeInTheDocument();
    expect(mocks.createProviderStore).not.toHaveBeenCalled();

    // Only the final confirm hits the provider, with confirm=true.
    fireEvent.click(screen.getByTestId('pickup-external-confirm'));
    await waitFor(() => expect(mocks.createProviderStore).toHaveBeenCalledWith(
      'pathao',
      expect.objectContaining({ name: 'Warehouse North', address: '123 Ring Road, Dhaka' }),
      true,
    ));
  });
});

describe('PickupTab — safe delete (§12 confirm-first)', () => {
  it('labeled Delete always opens the dialog FIRST — no DELETE fires before the confirm click', async () => {
    mocks.getPickupLocations.mockResolvedValue([location('loc2')]);
    renderTab([status('pathao')]);
    const rowButton = await screen.findByTestId('pickup-delete-loc2');
    // Visible label, not an icon-only affordance (§12).
    expect(rowButton).toHaveTextContent('Delete');

    fireEvent.click(rowButton);
    expect(await screen.findByText('Delete Hub loc2?')).toBeInTheDocument();
    // A clean row would have been destroyed server-side by an unconfirmed call —
    // nothing may hit DELETE before the merchant confirms.
    expect(mocks.deletePickupLocation).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('pickup-delete-confirm'));
    await waitFor(() => expect(mocks.deletePickupLocation).toHaveBeenCalledTimes(1));
    expect(mocks.deletePickupLocation).toHaveBeenCalledWith('loc2', { confirm: true });
    // Server-confirmed success → inline role=status feedback naming the row.
    const notice = await screen.findByTestId('pickup-delete-status');
    expect(notice).toHaveAttribute('role', 'status');
    expect(notice).toHaveTextContent('Deleted Hub loc2.');
    expect(screen.queryByText('Delete Hub loc2?')).not.toBeInTheDocument();
  });

  it('cancel deletes nothing and keeps the row', async () => {
    mocks.getPickupLocations.mockResolvedValue([location('loc2')]);
    renderTab([status('pathao')]);
    fireEvent.click(await screen.findByTestId('pickup-delete-loc2'));
    expect(await screen.findByText('Delete Hub loc2?')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('pickup-delete-cancel'));
    await waitFor(() => expect(screen.queryByText('Delete Hub loc2?')).not.toBeInTheDocument());
    expect(mocks.deletePickupLocation).not.toHaveBeenCalled();
    expect(screen.getByTestId('pickup-location-row-loc2')).toBeInTheDocument();
    expect(screen.queryByTestId('pickup-delete-status')).not.toBeInTheDocument();
  });

  it('enriches the dialog from LOCAL data: default star + provider wiring warn BEFORE any call', async () => {
    // loc1 is the shop default AND pathao's row references it via pickup_location_id.
    renderTab([status('pathao', { pickup_location_id: 'loc1' })]);
    fireEvent.click(await screen.findByTestId('pickup-delete-loc1'));
    expect(await screen.findByText('Delete Hub loc1?')).toBeInTheDocument();
    expect(screen.getByTestId('pickup-delete-blockers')).toHaveTextContent('This is your default pickup location.');
    // §A9: blockers name the merchant-facing provider label, not the raw enum.
    expect(screen.getByTestId('pickup-delete-blockers')).toHaveTextContent('In use by: Pathao Courier');
    expect(mocks.deletePickupLocation).not.toHaveBeenCalled();
  });

  it('a late server 409 on the confirmed delete re-surfaces its blockers in the open dialog', async () => {
    mocks.getPickupLocations.mockResolvedValue([location('loc2')]);
    mocks.deletePickupLocation.mockRejectedValue(
      conflict409('PICKUP_LOCATION_IN_USE', { blockers: [{ code: 'IN_USE', providers: ['redx'] }] }),
    );
    renderTab([status('pathao')]);
    fireEvent.click(await screen.findByTestId('pickup-delete-loc2'));
    await screen.findByText('Delete Hub loc2?');
    fireEvent.click(screen.getByTestId('pickup-delete-confirm'));

    // Only the confirmed call was made; the dialog stays OPEN with the SERVER blockers.
    await waitFor(() => expect(mocks.deletePickupLocation).toHaveBeenCalledWith('loc2', { confirm: true }));
    expect(mocks.deletePickupLocation).toHaveBeenCalledTimes(1);
    expect(await screen.findByTestId('pickup-delete-blockers')).toHaveTextContent('In use by: RedX Courier');
    expect(screen.getByText('Delete Hub loc2?')).toBeInTheDocument();
    expect(screen.queryByTestId('pickup-delete-status')).not.toBeInTheDocument();
  });

  it('a 409 without structured blockers shows the server message inside the dialog', async () => {
    mocks.getPickupLocations.mockResolvedValue([location('loc2')]);
    mocks.deletePickupLocation.mockRejectedValue(conflict409('PICKUP_LOCATION_DELETE_BLOCKED', {}));
    renderTab([status('pathao')]);
    fireEvent.click(await screen.findByTestId('pickup-delete-loc2'));
    await screen.findByText('Delete Hub loc2?');
    fireEvent.click(screen.getByTestId('pickup-delete-confirm'));
    expect(await screen.findByTestId('pickup-delete-error')).toHaveTextContent('This location can’t be deleted.');
    expect(screen.getByText('Delete Hub loc2?')).toBeInTheDocument();
  });
});

describe('PickupTab — sync failure + retry', () => {
  it('shows a blocked state after a failed store fetch and retries via sync', async () => {
    mocks.listProviderStores.mockRejectedValueOnce({ response: { status: 503, data: { code: 'DELIVERY_STORE_SYNC_FAILED', message: 'read ok, upsert failed' } } });
    renderTab([status('pathao')]);
    fireEvent.click(screen.getByTestId('pickup-fetch-stores-pathao'));
    const message = await screen.findByTestId('pickup-message-pathao');
    expect(message).toHaveTextContent('Could not load stores');

    // Retry action is now available and re-resolves via sync (no new endpoint).
    const retry = screen.getByTestId('pickup-retry-pathao');
    fireEvent.click(retry);
    await waitFor(() => expect(mocks.retryPickupSync).toHaveBeenCalledWith(
      'pathao',
      expect.objectContaining({ pickup_location_id: 'loc1' }),
    ));
  });
});

describe('PickupTab — create then sync (never a link/activate)', () => {
  it('after the form saves a local row it syncs but does not link or activate', async () => {
    renderTab([status('pathao')]);
    fireEvent.click(screen.getByTestId('pickup-add-location'));
    expect(await screen.findByTestId('stub-form-save')).toBeInTheDocument();
    // The default provider for the generic add is 'manual' — no provider sync runs.
    fireEvent.click(screen.getByTestId('stub-form-save'));
    await waitFor(() => expect(mocks.createPickupLocation).not.toHaveBeenCalled()); // form owns CRUD
    // manual provider → no pathao/redx sync fired.
    await waitFor(() => expect(mocks.syncProviderPickup).not.toHaveBeenCalled());
    expect(mocks.activateDeliveryProvider).not.toHaveBeenCalled();
    expect(mocks.setProviderPickup).not.toHaveBeenCalled();
  });
});

describe('PickupTab — Steadfast is manual-only', () => {
  it('renders an honest manual message with no store-fetch action', () => {
    renderTab([status('steadfast')]);
    const panel = screen.getByTestId('pickup-provider-panel-steadfast');
    expect(panel).toHaveTextContent('Steadfast Courier pickup is set up manually.');
    expect(screen.queryByTestId('pickup-fetch-stores-steadfast')).not.toBeInTheDocument();
    expect(mocks.listProviderStores).not.toHaveBeenCalledWith('steadfast');
  });
});

describe('PickupTab — Fetch is a pure read (§A8)', () => {
  it('never swaps envelope pickup_locations into the local list', async () => {
    mocks.listProviderStores.mockResolvedValueOnce({
      provider: 'pathao',
      stores: [{ store_id: 's1', store_name: 'Real Hub' }],
      // Legacy shape a pre-change server might still echo — must be ignored.
      pickup_locations: [{ id: 'phantom', display_name: 'Phantom Row', phone: '01700000000', address: 'x', area_name: 'y', is_default: false }],
    });
    renderTab([status('pathao')]);
    fireEvent.click(screen.getByTestId('pickup-fetch-stores-pathao'));
    expect(await screen.findByTestId('pickup-store-row-pathao-s1')).toBeInTheDocument();
    // The saved-locations list is owned by GET /pickup-locations (mount fetch),
    // never overwritten by the stores listing.
    expect(screen.queryByText('Phantom Row')).not.toBeInTheDocument();
    expect(screen.getByTestId('pickup-location-row-loc1')).toBeInTheDocument();
    expect(mocks.getPickupLocations).toHaveBeenCalledTimes(1); // mount only
  });

  it('a selective import the courier cannot match blocks with a pill naming the missing ids', async () => {
    mocks.listProviderStores.mockResolvedValueOnce({
      provider: 'pathao',
      stores: [{ store_id: 's1', store_name: 'Dhanmondi Hub' }],
    });
    mocks.importProviderStores.mockRejectedValueOnce(
      conflict409('DELIVERY_STORE_IDS_UNMATCHED', { unmatched_store_ids: ['s7'] }),
    );
    renderTab([status('pathao')]);
    fireEvent.click(screen.getByTestId('pickup-fetch-stores-pathao'));
    fireEvent.click(await screen.findByTestId('pickup-store-import-pathao-s1'));
    await waitFor(() => expect(mocks.importProviderStores).toHaveBeenCalledWith('pathao', ['s1']));
    const message = await screen.findByTestId('pickup-message-pathao');
    expect(message).toHaveTextContent('Not listed by courier: s7');
    expect(screen.getByTestId('pickup-sync-status-pathao')).toHaveTextContent('Not listed by courier: s7');
    expect(mocks.importProviderStores).not.toHaveBeenCalledWith('pathao', undefined);
  });
});

describe('PickupTab — stale mapping honesty (§A8)', () => {
  const staleStatus = status('pathao', {
    pickup_mapping_status: 'stale',
    provider_store_id: 's9',
    pickup_enabled: true,
  });

  it('a successful Fetch whose listing lacks the wired store keeps the pill at attention', async () => {
    mocks.listProviderStores.mockResolvedValueOnce({
      provider: 'pathao',
      stores: [{ store_id: 's1', store_name: 'Dhanmondi Hub' }],
    });
    renderTab([staleStatus]);
    expect(screen.getByTestId('pickup-sync-status-pathao')).toHaveTextContent('Mapping needs review');
    fireEvent.click(screen.getByTestId('pickup-fetch-stores-pathao'));
    expect(await screen.findByTestId('pickup-store-row-pathao-s1')).toBeInTheDocument();
    // Fetch success ≠ mapping healthy: the stale flag stays until Link/sync resolves it.
    expect(screen.getByTestId('pickup-sync-status-pathao')).toHaveTextContent('Mapping needs review');
    expect(mocks.setProviderPickup).not.toHaveBeenCalled();
  });

  it('retry resolving PRESERVED renders ATTENTION naming the fixing action (Import → re-link), not healthy green', async () => {
    mocks.retryPickupSync.mockResolvedValueOnce({ provider: 'pathao', store_resolution: 'PRESERVED' });
    renderTab([staleStatus]);
    const retry = screen.getByTestId('pickup-retry-pathao');
    fireEvent.click(retry);
    await waitFor(() => expect(mocks.retryPickupSync).toHaveBeenCalled());
    const message = await screen.findByTestId('pickup-message-pathao');
    // §A9: PRESERVED-on-retry means the wired store is NOT in the server CACHE —
    // the hint must name the action that fixes it, never a vague "link a store".
    expect(message).toHaveTextContent('Import to refresh the courier’s store list, then link again.');
    expect(screen.getByTestId('pickup-sync-status-pathao')).toHaveTextContent('Import to refresh');
  });

  it('retry resolving NO_MATCH renders ATTENTION naming Import-to-refresh, never a confirmed pill', async () => {
    mocks.retryPickupSync.mockResolvedValueOnce({ provider: 'pathao', store_resolution: 'NO_MATCH' });
    renderTab([staleStatus]);
    fireEvent.click(screen.getByTestId('pickup-retry-pathao'));
    const message = await screen.findByTestId('pickup-message-pathao');
    expect(message).toHaveTextContent('then link again.');
    expect(screen.getByTestId('pickup-sync-status-pathao')).not.toHaveTextContent('Linked & confirmed');
  });

  it('an explicit LINK never pre-empts the server: honest attention while stale, green only once the reload reports confirmed (§A9)', async () => {
    const onMutate = vi.fn(async () => {});
    mocks.listProviderStores.mockResolvedValueOnce({
      provider: 'pathao',
      stores: [{ store_id: 's1', store_name: 'Dhanmondi Hub' }],
    });
    mocks.setProviderPickup.mockResolvedValueOnce({ store_resolution: 'LINKED', pickup_enabled: true });
    const view = render(<PickupTab providers={[staleStatus]} onMutate={onMutate} />);
    fireEvent.click(screen.getByTestId('pickup-fetch-stores-pathao'));
    fireEvent.click(await screen.findByTestId('pickup-store-link-pathao-s1'));
    await waitFor(() => expect(mocks.setProviderPickup).toHaveBeenCalled());

    // The LINK result MESSAGE shows, but there is NO local stale-override: while
    // the server still reports the old mapping the pill stays at attention.
    const message = await screen.findByTestId('pickup-message-pathao');
    expect(message).toHaveTextContent('Linked to Dhanmondi Hub');
    expect(screen.getByTestId('pickup-sync-status-pathao')).toHaveTextContent('Mapping needs review');
    await waitFor(() => expect(onMutate).toHaveBeenCalled());

    // A5c refreshed the cached listing inside the LINK call — the reload brings
    // the SERVER 'confirmed' and that is what flips the pill green.
    view.rerender(
      <PickupTab
        providers={[status('pathao', { pickup_mapping_status: 'confirmed', provider_store_id: 's1', pickup_enabled: true })]}
        onMutate={onMutate}
      />,
    );
    await waitFor(() => expect(screen.getByTestId('pickup-sync-status-pathao')).not.toHaveTextContent('Mapping needs review'));
    expect(screen.getByTestId('pickup-sync-status-pathao')).toHaveTextContent('Linked to Dhanmondi Hub');
  });

  it('retry MATCHED reloads and flips green from SERVER truth, not from a local override', async () => {
    const onMutate = vi.fn(async () => {});
    mocks.retryPickupSync.mockResolvedValueOnce({ provider: 'pathao', store_resolution: 'MATCHED' });
    const view = render(<PickupTab providers={[staleStatus]} onMutate={onMutate} />);
    fireEvent.click(screen.getByTestId('pickup-retry-pathao'));
    await waitFor(() => expect(mocks.retryPickupSync).toHaveBeenCalled());
    const message = await screen.findByTestId('pickup-message-pathao');
    expect(message).toHaveTextContent('Matched an existing store.');
    // Server still says stale until its refreshed cache arrives via the reload.
    expect(screen.getByTestId('pickup-sync-status-pathao')).toHaveTextContent('Mapping needs review');
    await waitFor(() => expect(onMutate).toHaveBeenCalled());
    view.rerender(
      <PickupTab
        providers={[status('pathao', { pickup_mapping_status: 'confirmed', provider_store_id: 's9', pickup_enabled: true })]}
        onMutate={onMutate}
      />,
    );
    await waitFor(() => expect(screen.getByTestId('pickup-sync-status-pathao')).not.toHaveTextContent('Mapping needs review'));
  });
});

describe('PickupTab — unknown mapping is never "confirmed" (§A9)', () => {
  it('renders unknown + wired as ATTENTION with a "not verified" label + fetch/import hint, never the green pill', () => {
    renderTab([status('pathao', { pickup_mapping_status: 'unknown', provider_store_id: 's9', pickup_enabled: true })]);
    const pill = screen.getByTestId('pickup-sync-status-pathao');
    expect(pill).toHaveTextContent("Linked — not verified against the courier's store list");
    expect(pill).not.toHaveTextContent('Linked & confirmed');
    // The hint names the action that VERIFIES it: Fetch/Import + re-link.
    const hint = screen.getByTestId('pickup-unverified-hint-pathao');
    expect(hint).toHaveTextContent("Never matched to Pathao Courier's current store list");
    expect(hint).toHaveTextContent('Link again to verify');
  });

  it('a wired row whose mapping field is absent (older server) is likewise not confirmed', () => {
    renderTab([status('pathao', { provider_store_id: 's9', pickup_enabled: true })]);
    const pill = screen.getByTestId('pickup-sync-status-pathao');
    expect(pill).not.toHaveTextContent('Linked & confirmed');
    expect(pill).toHaveTextContent('not verified');
    expect(screen.getByTestId('pickup-unverified-hint-pathao')).toBeInTheDocument();
  });

  it('renders a successful pure-fetch message on a stale mapping as neutral status, never an error alert (§A8c)', async () => {
    mocks.listProviderStores.mockResolvedValueOnce({
      provider: 'pathao',
      stores: [{ store_id: 's9', store_name: 'Main Store' }],
      capability: 'IMPLEMENTED_NOT_LIVE_VERIFIED',
    });
    renderTab([status('pathao', { pickup_mapping_status: 'stale', provider_store_id: 's9', pickup_enabled: true })]);
    fireEvent.click(screen.getByTestId('pickup-fetch-stores-pathao'));
    const message = await screen.findByTestId('pickup-message-pathao');
    expect(message).toHaveAttribute('role', 'status');
    expect(message.className).not.toContain('text-em-danger-700');
    expect(message).toHaveTextContent('1 stores available');
    const pill = screen.getByTestId('pickup-sync-status-pathao');
    expect(pill).toHaveTextContent('Mapping needs review');
    expect(pill.className).toContain('break-words');
  });

  it('keeps green derived state reserved for a server-confirmed mapping', () => {
    renderTab([status('pathao', { pickup_mapping_status: 'confirmed', provider_store_id: 's9', pickup_enabled: true })]);
    expect(screen.getByTestId('pickup-sync-status-pathao')).toHaveTextContent('Linked & confirmed');
    expect(screen.queryByTestId('pickup-unverified-hint-pathao')).not.toBeInTheDocument();
  });
});

describe('PickupTab — 409 deep-link focus (focusProvider) (§A8/§A9)', () => {
  it('opens the form once per prop-driven open and reports consumption exactly once', async () => {
    const onFocusConsumed = vi.fn();
    const view = render(
      <PickupTab providers={[status('pathao')]} onMutate={vi.fn(async () => {})} focusProvider="pathao" onFocusConsumed={onFocusConsumed} />,
    );
    expect(await screen.findByTestId('stub-form-provider')).toHaveTextContent('pathao');
    expect(onFocusConsumed).toHaveBeenCalledTimes(1);

    // A re-render with the same deep-link must NOT re-open or re-report.
    view.rerender(
      <PickupTab providers={[status('pathao')]} onMutate={vi.fn(async () => {})} focusProvider="pathao" onFocusConsumed={onFocusConsumed} />,
    );
    expect(onFocusConsumed).toHaveBeenCalledTimes(1);
  });

  it('opens EDIT on the provider\'s existing saved row — never a duplicate-blank create (§A9)', async () => {
    const onFocusConsumed = vi.fn();
    render(
      <PickupTab providers={[status('pathao')]} onMutate={vi.fn(async () => {})} focusProvider="pathao" onFocusConsumed={onFocusConsumed} />,
    );
    // The default fixture already has a pathao row (loc1) → EDIT opens on IT,
    // mounted with loc1's identity (mode:row id captured at mount).
    expect(await screen.findByRole('dialog', { name: 'pickup form edit' })).toBeInTheDocument();
    expect(screen.getByTestId('stub-form-mounted-target')).toHaveTextContent('edit:loc1');
    expect(screen.queryByRole('dialog', { name: 'pickup form create' })).not.toBeInTheDocument();
    expect(onFocusConsumed).toHaveBeenCalledTimes(1);
  });

  it('still opens a create deep-link form when no saved row exists for that provider', async () => {
    render(
      <PickupTab providers={[status('redx')]} onMutate={vi.fn(async () => {})} focusProvider="redx" />,
    );
    expect(await screen.findByRole('dialog', { name: 'pickup form create' })).toBeInTheDocument();
    expect(screen.getByTestId('stub-form-mounted-target')).toHaveTextContent('create:new');
  });

  it('a fresh deep-link after the shell cleared it opens again and reports once more', async () => {
    const onFocusConsumed = vi.fn();
    const view = render(
      <PickupTab providers={[status('pathao')]} onMutate={vi.fn(async () => {})} focusProvider="pathao" onFocusConsumed={onFocusConsumed} />,
    );
    await screen.findByTestId('stub-form-provider');
    expect(onFocusConsumed).toHaveBeenCalledTimes(1);

    view.rerender(
      <PickupTab providers={[status('pathao')]} onMutate={vi.fn(async () => {})} focusProvider={null} onFocusConsumed={onFocusConsumed} />,
    );
    expect(onFocusConsumed).toHaveBeenCalledTimes(1);

    view.rerender(
      <PickupTab providers={[status('pathao')]} onMutate={vi.fn(async () => {})} focusProvider="redx" onFocusConsumed={onFocusConsumed} />,
    );
    expect(onFocusConsumed).toHaveBeenCalledTimes(2);
  });

  it('without focusProvider the create form stays closed', () => {
    renderTab([status('pathao')]);
    expect(screen.queryByTestId('stub-form-provider')).not.toBeInTheDocument();
  });

  it('after the focus-driven save+sync shows the WHERE-NEXT pointer back to Providers', async () => {
    render(
      <PickupTab providers={[status('pathao')]} onMutate={vi.fn(async () => {})} focusProvider="pathao" />,
    );
    fireEvent.click(await screen.findByTestId('stub-form-save'));
    await waitFor(() => expect(mocks.syncProviderPickup).toHaveBeenCalled());
    const pointer = await screen.findByTestId('pickup-next-step');
    expect(pointer).toHaveAttribute('role', 'status');
    expect(pointer).toHaveTextContent('Pickup saved — return to Courier Providers to Activate.');
  });

  it('no pointer on a plain save (not entered via deep-link), even when the sync leg runs', async () => {
    renderTab([status('pathao')]);
    // Edit the pathao-owned row so the save also runs the provider SYNC leg —
    // the WHERE-NEXT pointer must stay silent without the 409 deep-link context.
    fireEvent.click(await screen.findByTestId('pickup-edit-loc1'));
    fireEvent.click(await screen.findByTestId('stub-form-save'));
    await waitFor(() => expect(mocks.syncProviderPickup).toHaveBeenCalled());
    expect(screen.queryByTestId('pickup-next-step')).not.toBeInTheDocument();
  });
});

describe('PickupTab — Edit re-target remounts the form (REAL PickupForm, §A9)', () => {
  it('Edit(A) then Edit(B) shows B\'s values and PUTs B — never the previously targeted A', async () => {
    formMode.useReal = true;
    mocks.getPickupLocations.mockResolvedValue([
      location('locA'),
      location('locB', { display_name: 'Hub Beta', phone: '01888888888' }),
    ]);
    mocks.updatePickupLocation.mockResolvedValue(location('locB', { display_name: 'Hub Beta', phone: '01888888888' }));
    renderTab([status('pathao')]);

    fireEvent.click(await screen.findByTestId('pickup-edit-locA'));
    await waitFor(() => expect((screen.getByTestId('pickup-form-name') as HTMLInputElement).value).toBe('Hub locA'));
    expect((screen.getByTestId('pickup-form-address') as HTMLTextAreaElement).value).toBe('Address locA');

    // Re-target WHILE the form is open: the mounted form's useState initializers
    // never re-run, so only the key-based remount can show row B here.
    fireEvent.click(screen.getByTestId('pickup-edit-locB'));
    await waitFor(() => expect((screen.getByTestId('pickup-form-name') as HTMLInputElement).value).toBe('Hub Beta'));
    expect((screen.getByTestId('pickup-form-address') as HTMLTextAreaElement).value).toBe('Address locB');

    fireEvent.click(screen.getByTestId('pickup-form-save'));
    await waitFor(() => expect(mocks.updatePickupLocation).toHaveBeenCalledTimes(1));
    expect(mocks.updatePickupLocation).toHaveBeenCalledWith('locB', expect.objectContaining({ display_name: 'Hub Beta' }));
    expect(mocks.updatePickupLocation.mock.calls[0][0]).not.toBe('locA');
  });
});

describe('PickupTab — locale-aware stores-synced timestamp (§A9)', () => {
  it('formats with the active i18n language — Bangla (bn-BD) numerals for bn', async () => {
    i18nState.language = 'bn';
    renderTab([status('pathao', { pickup_stores_synced_at: '2026-11-24T09:30:00Z' })]);
    const panel = await screen.findByTestId('pickup-provider-panel-pathao');
    const text = panel.textContent ?? '';
    expect(text).toMatch(/[০-৯]/); // Bengali digits from Intl bn-BD
    expect(text).not.toMatch(/[0-9]/); // no leaked Western digits
  });

  it('formats en-US for the default language', async () => {
    renderTab([status('pathao', { pickup_stores_synced_at: '2026-11-24T09:30:00Z' })]);
    const panel = await screen.findByTestId('pickup-provider-panel-pathao');
    expect(panel.textContent).toMatch(/Nov 24, 2026/);
  });
});
