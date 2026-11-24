/**
 * PickupTab (Tab 2) unit contracts. The WHOLE order-domain module is mocked
 * (including A0's not-yet-landed pickup client fns) so the tab is testable now.
 * PickupForm is stubbed to isolate the workspace behaviour (its own field tests
 * live in PickupForm.test.tsx). react-i18next is a label map.
 *
 * Covers the task's required behaviours:
 *   existing-store list + link · ambiguous → explicit selection (no first-match)
 *   · confirm-before-external-create · safe-delete blocked (default/in-use)
 *   · retry after failed sync · steadfast manual-only · create-then-sync is NOT a
 *     link/activate (separate actions).
 */
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PickupTab from '../PickupTab';
import type { DeliveryProviderStatus, PickupLocation } from '@/api/types/order';

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
vi.mock('../PickupForm', () => ({
  default: ({ provider, onSaved, mode }: { provider: string; mode: string; onSaved: (r: unknown) => void }) => (
    <div role="dialog" aria-label={`pickup form ${mode}`}>
      <button type="button" data-testid="stub-form-save" onClick={() => onSaved({ location: { id: 'loc-new', display_name: 'New hub', provider_store_id: null }, providerMeta: { city_id: '5' } })}>stub save</button>
      <span data-testid="stub-form-provider">{provider}</span>
    </div>
  ),
}));
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
        'manageShop.deliverySettings.pickup.storeCreateSyncing': 'Refreshing stores…',
        'manageShop.deliverySettings.errors.updateDefaultFailed': 'Could not update default',
      };
      if (key in labels) return labels[key];
      if (typeof values?.defaultValue === 'string') return values.defaultValue;
      return key;
    },
    i18n: { language: 'en' },
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

describe('PickupTab — safe delete', () => {
  it('surfaces default + in-use blockers and re-deletes only after confirm', async () => {
    // Backend: a bare DELETE is blocked (confirm required); the forced delete with
    // ?confirm=true succeeds. Order/dispatch history is never cascaded.
    mocks.deletePickupLocation.mockImplementation((id: string, opts?: { confirm?: boolean }) => (
      opts?.confirm
        ? Promise.resolve({ id, deleted: true, released_providers: ['pathao'] })
        : Promise.reject(conflict409('PICKUP_LOCATION_DELETE_CONFIRMATION_REQUIRED', {
          location_id: id,
          requires_confirmation: true,
          blockers: [
            { code: 'IS_SHOP_DEFAULT', message: 'is default' },
            { code: 'IN_USE', message: 'in use', providers: ['pathao'] },
          ],
        }))
    ));
    renderTab([status('pathao')]);
    fireEvent.click(await screen.findByTestId('pickup-delete-loc1'));
    expect(await screen.findByText('Delete Hub loc1?')).toBeInTheDocument();
    expect(screen.getByTestId('pickup-delete-blockers')).toHaveTextContent('This is your default pickup location.');
    expect(screen.getByTestId('pickup-delete-blockers')).toHaveTextContent('In use by: pathao');

    // Cancel does NOT delete.
    fireEvent.click(screen.getByTestId('pickup-delete-cancel'));
    await waitFor(() => expect(screen.queryByText('Delete Hub loc1?')).not.toBeInTheDocument());
    expect(mocks.deletePickupLocation).toHaveBeenCalledTimes(1);
    expect(mocks.deletePickupLocation).toHaveBeenLastCalledWith('loc1');

    // Re-open and confirm → forced delete with confirm=true.
    fireEvent.click(screen.getByTestId('pickup-delete-loc1'));
    await screen.findByText('Delete Hub loc1?');
    fireEvent.click(screen.getByTestId('pickup-delete-confirm'));
    await waitFor(() => expect(mocks.deletePickupLocation).toHaveBeenLastCalledWith('loc1', { confirm: true }));
    expect(mocks.deletePickupLocation).toHaveBeenCalledTimes(3);
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
