/**
 * PickupForm (local create/edit) unit contracts. Whole order-domain mocked.
 * Verifies the reused field set + BD-phone validation + the per-provider
 * directory (Pathao cascade / RedX area / Steadfast free-text), that it only
 * CRUDs the LOCAL row (no sync/link/activate), that onSaved carries the resolved
 * provider_meta, and that values are preserved on a failed save (§C5).
 */
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PickupForm from '../PickupForm';
import type { PickupLocation } from '@/api/types/order';

const mocks = vi.hoisted(() => ({
  createPickupLocation: vi.fn(),
  updatePickupLocation: vi.fn(),
  getPathaoCities: vi.fn(),
  getPathaoZones: vi.fn(),
  getPathaoAreas: vi.fn(),
  getProviderAreas: vi.fn(),
  syncProviderPickup: vi.fn(),
  activateDeliveryProvider: vi.fn(),
}));

vi.mock('@/api/domains/order', () => ({
  ...mocks,
  getPickupLocations: vi.fn(async () => []),
  getDeliverySettings: vi.fn(async () => ({ providers: [], settings: {} })),
}));
vi.mock('@shared/lib/http/errors', () => ({
  getErrorMessage: (error: unknown, fallback: string) => (error instanceof Error ? error.message : fallback),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => {
      const labels: Record<string, string> = {
        'common.cancel': 'Cancel',
        'common.bdPhoneInvalid': 'Enter a valid BD mobile number',
        'courier.pickup.name': 'Pickup name',
        'courier.pickup.namePlaceholder': 'Main pickup point',
        'courier.pickup.phone': 'Pickup phone',
        'courier.pickup.address': 'Pickup address',
        'courier.pickup.addressPlaceholder': 'Enter the complete pickup address',
        'courier.pickup.city': 'City',
        'courier.pickup.zone': 'Zone',
        'courier.pickup.area': 'Area',
        'courier.pickup.areaPlaceholder': 'Enter pickup area',
        'courier.pickup.selectCity': 'Select city',
        'courier.pickup.selectZone': 'Select zone',
        'courier.pickup.selectArea': 'Select area',
        'courier.pickup.errors.locationsLoadFailed': 'Could not load courier locations',
        'manageShop.deliverySettings.errors.fieldRequired': `${values?.field ?? 'Field'} is required`,
        'manageShop.deliverySettings.pickup.createLocation': 'Create location',
        'manageShop.deliverySettings.pickup.save': 'Save changes',
        'manageShop.deliverySettings.pickup.saving': 'Saving…',
        'manageShop.deliverySettings.pickup.errors.saveFailed': 'Could not save location',
        'manageShop.deliverySettings.pickup.createHeading': 'New pickup location',
        'manageShop.deliverySettings.pickup.editHeading': 'Edit pickup location',
        'manageShop.deliverySettings.pickup.providers.pathao': 'Pathao',
        'manageShop.deliverySettings.pickup.providers.redx': 'RedX',
        'manageShop.deliverySettings.pickup.providers.steadfast': 'Steadfast',
        'manageShop.deliverySettings.pickup.providers.manual': 'Manual',
      };
      if (key in labels) return labels[key];
      if (typeof values?.defaultValue === 'string') return values.defaultValue;
      return key;
    },
    i18n: { language: 'en' },
  }),
}));

const pathaoCity = { id: '1', city_id: 1, name: 'Dhaka' };
const pathaoZone = { id: '2', zone_id: 2, name: 'Mirpur' };
const pathaoArea = { id: '3', area_id: 3, name: 'Kallyanpur' };

const fillCore = (name = 'Warehouse North', phone = '01712345678', address = '123 Ring Road, Dhaka') => {
  fireEvent.change(screen.getByTestId('pickup-form-name'), { target: { value: name } });
  fireEvent.change(document.getElementById('pickup-form-phone') as HTMLElement, { target: { value: phone } });
  fireEvent.change(screen.getByTestId('pickup-form-address'), { target: { value: address } });
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getPathaoCities.mockResolvedValue([pathaoCity]);
  mocks.getPathaoZones.mockResolvedValue([pathaoZone]);
  mocks.getPathaoAreas.mockResolvedValue([pathaoArea]);
  mocks.getProviderAreas.mockResolvedValue([{ id: '9', area_id: 9, name: 'Gulshan' }]);
  mocks.createPickupLocation.mockResolvedValue({ id: 'new1', display_name: 'Warehouse North', phone: '01712345678', address: '123 Ring Road, Dhaka', area_name: 'Kallyanpur', is_default: false });
  mocks.updatePickupLocation.mockResolvedValue({ id: 'loc1', display_name: 'Warehouse North', phone: '01712345678', address: '123 Ring Road, Dhaka', area_name: 'Kallyanpur', is_default: true });
});

describe('PickupForm — Pathao cascade', () => {
  it('loads cities, drives city→zone→area, and emits provider ids via onSaved', async () => {
    const onSaved = vi.fn();
    render(<PickupForm provider="pathao" mode="create" onCancel={vi.fn()} onSaved={onSaved} />);
    await waitFor(() => expect(mocks.getPathaoCities).toHaveBeenCalled());

    fillCore();
    fireEvent.change(screen.getByLabelText('City'), { target: { value: '1' } });
    await waitFor(() => expect(mocks.getPathaoZones).toHaveBeenCalledWith(1));
    fireEvent.change(screen.getByLabelText('Zone'), { target: { value: '2' } });
    await waitFor(() => expect(mocks.getPathaoAreas).toHaveBeenCalledWith(2));
    fireEvent.change(screen.getByLabelText('Area'), { target: { value: '3' } });

    fireEvent.click(screen.getByTestId('pickup-form-save'));
    await waitFor(() => expect(mocks.createPickupLocation).toHaveBeenCalledWith(expect.objectContaining({
      display_name: 'Warehouse North',
      phone: '01712345678',
      address: '123 Ring Road, Dhaka',
      area_name: 'Kallyanpur',
      city_name: 'Dhaka',
      zone_name: 'Mirpur',
    })));
    // Only the LOCAL row is created here — never a sync/link/activate.
    expect(mocks.syncProviderPickup).not.toHaveBeenCalled();
    expect(mocks.activateDeliveryProvider).not.toHaveBeenCalled();
    // The provider ids ride back to the parent for an explicit sync/link action.
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({
      providerMeta: { city_id: 1, zone_id: 2, area_id: 3 },
    })));
  });
});

describe('PickupForm — validation + value preservation', () => {
  it('blocks save and shows inline errors when required fields are empty', async () => {
    const onSaved = vi.fn();
    render(<PickupForm provider="steadfast" mode="create" onCancel={vi.fn()} onSaved={onSaved} />);
    fireEvent.click(screen.getByTestId('pickup-form-save'));
    expect((await screen.findAllByRole('alert')).length).toBeGreaterThan(0);
    expect(mocks.createPickupLocation).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('rejects an invalid BD phone number before calling the API', async () => {
    const onSaved = vi.fn();
    render(<PickupForm provider="steadfast" mode="create" onCancel={vi.fn()} onSaved={onSaved} />);
    fillCore('Warehouse North', '01234', 'Some address');
    fireEvent.change(screen.getByTestId('pickup-form-area'), { target: { value: 'Old Dhaka' } });
    fireEvent.click(screen.getByTestId('pickup-form-save'));
    expect(await screen.findByText('Enter a valid BD mobile number')).toBeInTheDocument();
    expect(mocks.createPickupLocation).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('preserves entered values when the save fails', async () => {
    mocks.createPickupLocation.mockRejectedValueOnce(new Error('boom: backend rejected'));
    const onSaved = vi.fn();
    render(<PickupForm provider="steadfast" mode="create" onCancel={vi.fn()} onSaved={onSaved} />);
    fillCore('Warehouse North', '01712345678', '123 Ring Road');
    fireEvent.change(screen.getByTestId('pickup-form-area'), { target: { value: 'Old Dhaka' } });
    fireEvent.click(screen.getByTestId('pickup-form-save'));

    expect(await screen.findByTestId('pickup-form-error')).toHaveTextContent('boom: backend rejected');
    // §C5 — inputs must keep their values after a failure.
    expect((screen.getByTestId('pickup-form-name') as HTMLInputElement).value).toBe('Warehouse North');
    expect((screen.getByTestId('pickup-form-address') as HTMLTextAreaElement).value).toBe('123 Ring Road');
    expect((screen.getByTestId('pickup-form-area') as HTMLInputElement).value).toBe('Old Dhaka');
    expect(onSaved).not.toHaveBeenCalled();
  });
});

describe('PickupForm — Steadfast manual + RedX area', () => {
  it('renders a free-text area for Steadfast and sends no provider ids', async () => {
    const onSaved = vi.fn();
    render(<PickupForm provider="steadfast" mode="create" onCancel={vi.fn()} onSaved={onSaved} />);
    expect(screen.queryByLabelText('City')).not.toBeInTheDocument();
    expect(mocks.getPathaoCities).not.toHaveBeenCalled();
    expect(screen.getByTestId('pickup-form-area')).toBeInTheDocument();

    fillCore();
    fireEvent.change(screen.getByTestId('pickup-form-area'), { target: { value: 'Old Dhaka' } });
    fireEvent.click(screen.getByTestId('pickup-form-save'));
    await waitFor(() => expect(mocks.createPickupLocation).toHaveBeenCalled());
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ providerMeta: {} })));
  });

  it('maps a selected RedX area to delivery_area_id', async () => {
    const onSaved = vi.fn();
    render(<PickupForm provider="redx" mode="create" onCancel={vi.fn()} onSaved={onSaved} />);
    await waitFor(() => expect(mocks.getProviderAreas).toHaveBeenCalledWith('redx'));
    fillCore();
    fireEvent.change(screen.getByLabelText('Area'), { target: { value: '9' } });
    fireEvent.click(screen.getByTestId('pickup-form-save'));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({
      providerMeta: { delivery_area_id: 9 },
    })));
  });
});

describe('PickupForm — edit mode', () => {
  it('hydrates an existing row and PUTs the same id (never re-creates)', async () => {
    const onSaved = vi.fn();
    const initial: PickupLocation = { id: 'loc1', display_name: 'Existing Hub', phone: '01799999999', address: 'Old address', area_name: 'Mirpur', is_default: true };
    render(<PickupForm provider="pathao" mode="edit" initial={initial} initialMeta={{ city_id: 1, zone_id: 2, area_id: 3 }} onCancel={vi.fn()} onSaved={onSaved} />);
    await waitFor(() => expect(mocks.getPathaoCities).toHaveBeenCalled());
    expect((screen.getByTestId('pickup-form-name') as HTMLInputElement).value).toBe('Existing Hub');
    expect((screen.getByTestId('pickup-form-address') as HTMLTextAreaElement).value).toBe('Old address');

    fireEvent.change(screen.getByTestId('pickup-form-name'), { target: { value: 'Renamed Hub' } });
    fireEvent.click(screen.getByTestId('pickup-form-save'));
    await waitFor(() => expect(mocks.updatePickupLocation).toHaveBeenCalledWith('loc1', expect.objectContaining({ display_name: 'Renamed Hub' })));
    expect(mocks.createPickupLocation).not.toHaveBeenCalled();
  });

  it('edit hydration chains city→zone→AREA so the Area select shows the persisted area (§A8)', async () => {
    const onSaved = vi.fn();
    const initial: PickupLocation = {
      id: 'loc1', display_name: 'Existing Hub', phone: '01799999999', address: 'Old address',
      area_name: 'Kallyanpur', city_name: 'Dhaka', zone_name: 'Mirpur', is_default: true,
    };
    render(<PickupForm provider="pathao" mode="edit" initial={initial} initialMeta={{ city_id: 1, zone_id: 2, area_id: 3 }} onCancel={vi.fn()} onSaved={onSaved} />);
    // Loading cities for the persisted city must CASCADE to zones AND areas.
    await waitFor(() => expect(mocks.getPathaoZones).toHaveBeenCalledWith(1));
    await waitFor(() => expect(mocks.getPathaoAreas).toHaveBeenCalledWith(2));
    const areaSelect = screen.getByTestId('pickup-form-area') as HTMLSelectElement;
    await waitFor(() => expect(areaSelect.value).toBe('3'));
    // The stored area is a real, selected option — not a blank placeholder.
    expect(Array.from(areaSelect.options).map((o) => o.textContent)).toContain('Kallyanpur');
    expect(areaSelect.options[areaSelect.selectedIndex]?.textContent).toContain('Kallyanpur');

    // Saving the edit keeps the hydrated ids on the way back to the parent.
    fireEvent.click(screen.getByTestId('pickup-form-save'));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({
      providerMeta: { city_id: 1, zone_id: 2, area_id: 3 },
    })));
  });

  it('interactive city change after hydration still resets the zone/area cascade', async () => {
    const onSaved = vi.fn();
    const initial: PickupLocation = {
      id: 'loc1', display_name: 'Existing Hub', phone: '01799999999', address: 'Old address',
      area_name: 'Kallyanpur', city_name: 'Dhaka', zone_name: 'Mirpur', is_default: true,
    };
    render(<PickupForm provider="pathao" mode="edit" initial={initial} initialMeta={{ city_id: 1, zone_id: 2, area_id: 3 }} onCancel={vi.fn()} onSaved={onSaved} />);
    const areaSelect = screen.getByTestId('pickup-form-area') as HTMLSelectElement;
    await waitFor(() => expect(areaSelect.value).toBe('3'));
    const zoneSelect = screen.getByTestId('pickup-form-zone') as HTMLSelectElement;
    expect(zoneSelect.value).toBe('2');

    // Clearing the city must wipe zone + area selections (unchanged reset rule).
    fireEvent.change(screen.getByLabelText('City'), { target: { value: '' } });
    await waitFor(() => {
      expect((screen.getByTestId('pickup-form-zone') as HTMLSelectElement).value).toBe('');
      expect((screen.getByTestId('pickup-form-area') as HTMLSelectElement).value).toBe('');
    });
  });

  it('a wrong persisted zone id leaves the zone/area blank instead of guessing', async () => {
    const onSaved = vi.fn();
    const initial: PickupLocation = {
      id: 'loc1', display_name: 'Existing Hub', phone: '01799999999', address: 'Old address',
      area_name: 'Kallyanpur', city_name: 'Dhaka', is_default: true,
    };
    mocks.getPathaoZones.mockResolvedValueOnce([{ id: '8', zone_id: 8, name: 'Uttara' }]);
    render(<PickupForm provider="pathao" mode="edit" initial={initial} initialMeta={{ city_id: 1, zone_id: 2, area_id: 3 }} onCancel={vi.fn()} onSaved={onSaved} />);
    await waitFor(() => expect(mocks.getPathaoZones).toHaveBeenCalledWith(1));
    // Zone '2' is not in the directory — the select stays BLANK (no auto-guess of
    // '8') and the areas leg is never fired.
    await waitFor(() => expect(screen.getByTestId('pickup-form-zone')).toBeInTheDocument());
    expect((screen.getByTestId('pickup-form-zone') as HTMLSelectElement).value).toBe('');
    expect(mocks.getPathaoAreas).not.toHaveBeenCalled();
  });
});
