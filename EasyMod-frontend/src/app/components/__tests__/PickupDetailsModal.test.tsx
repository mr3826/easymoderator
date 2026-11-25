/**
 * PickupDetailsModal — preserved-component contracts (tabbed-shell era).
 *
 * The redesign moved the primary pickup workspace to the Pickup TAB
 * (`delivery/PickupTab.tsx` + `delivery/PickupForm.tsx`), but the modal is kept
 * verbatim as the ProvidersTab fallback whenever the shell has not wired tab
 * routing (see DeliveryGuardrails.test.tsx "still falls back to the legacy
 * PickupDetailsModal…"). These tests pin the modal's own preserved behaviour:
 * §C5 value-preservation on sync failure and the RedX `delivery_area_id`
 * metadata chain — the same guarantees PickupForm/PickupTab now carry in-tab.
 */
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PickupDetailsModal from '../PickupDetailsModal';

const mocks = vi.hoisted(() => ({
  getPickupLocations: vi.fn(),
  createPickupLocation: vi.fn(),
  updatePickupLocation: vi.fn(),
  syncProviderPickup: vi.fn(),
  activateDeliveryProvider: vi.fn(),
  getPathaoCities: vi.fn(),
  getPathaoZones: vi.fn(),
  getPathaoAreas: vi.fn(),
  getProviderAreas: vi.fn(),
}));

vi.mock('@/api/domains/order', () => mocks);
vi.mock('@shared/lib/http/errors', () => ({
  getErrorMessage: (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback,
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => ({
      'courier.pickup.title': 'Pickup details',
      'courier.pickup.description': 'Tell us where the courier should collect your orders.',
      'courier.pickup.name': 'Pickup name',
      'courier.pickup.namePlaceholder': 'Main pickup point',
      'courier.pickup.phone': 'Pickup phone',
      'courier.pickup.city': 'City',
      'courier.pickup.zone': 'Zone',
      'courier.pickup.area': 'Area',
      'courier.pickup.areaPlaceholder': 'Enter pickup area',
      'courier.pickup.address': 'Pickup address',
      'courier.pickup.addressPlaceholder': 'Enter the complete pickup address',
      'courier.pickup.selectCity': 'Select city',
      'courier.pickup.selectZone': 'Select zone',
      'courier.pickup.selectArea': 'Select area',
      'courier.pickup.saveValidate': 'Save and validate',
      'courier.pickup.saving': 'Saving and validating...',
      'courier.pickup.errors.fieldsRequired': 'Complete all required pickup details',
      'courier.pickup.errors.locationsLoadFailed': 'Could not load courier locations',
      'courier.pickup.errors.syncFailed': 'Could not validate pickup details',
      'common.close': 'Close',
      'common.cancel': 'Cancel',
    }[key] || key),
    i18n: { language: 'en' },
  }),
}));

describe('PickupDetailsModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getPickupLocations.mockResolvedValue([]);
    mocks.createPickupLocation.mockResolvedValue({ id: 'pickup-1' });
    mocks.updatePickupLocation.mockResolvedValue({ id: 'pickup-1' });
    mocks.syncProviderPickup.mockResolvedValue(undefined);
    mocks.activateDeliveryProvider.mockResolvedValue(undefined);
    mocks.getPathaoCities.mockResolvedValue([]);
    mocks.getPathaoZones.mockResolvedValue([]);
    mocks.getPathaoAreas.mockResolvedValue([]);
    mocks.getProviderAreas.mockResolvedValue([]);
  });

  it('preserves entered values and keeps the modal open when provider sync fails', async () => {
    const onClose = vi.fn();
    const onSaved = vi.fn();
    mocks.syncProviderPickup.mockRejectedValueOnce(new Error('Provider sync failed'));

    render(
      <PickupDetailsModal
        provider="steadfast"
        missing={['pickup_name', 'pickup_phone', 'pickup_area', 'pickup_address']}
        onClose={onClose}
        onSaved={onSaved}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText('Main pickup point'), { target: { value: 'Warehouse' } });
    fireEvent.change(screen.getByPlaceholderText('01XXX-XXX-XXX'), { target: { value: '01712345678' } });
    fireEvent.change(screen.getByPlaceholderText('Enter pickup area'), { target: { value: 'Mirpur' } });
    fireEvent.change(screen.getByPlaceholderText('Enter the complete pickup address'), { target: { value: 'Road 1, Mirpur' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save and validate' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Provider sync failed'));
    expect(screen.getByDisplayValue('Warehouse')).toBeInTheDocument();
    expect(screen.getByDisplayValue('01712-345-678')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Mirpur')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Road 1, Mirpur')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
    expect(mocks.activateDeliveryProvider).not.toHaveBeenCalled();
  });

  it('loads and submits a RedX area selection as provider metadata', async () => {
    mocks.getProviderAreas.mockResolvedValueOnce([{ id: 9, name: 'Mirpur' }]);
    const onSaved = vi.fn();

    render(
      <PickupDetailsModal
        provider="redx"
        missing={['pickup_name', 'pickup_phone', 'pickup_area', 'pickup_address']}
        onClose={vi.fn()}
        onSaved={onSaved}
      />,
    );

    await waitFor(() => expect(mocks.getProviderAreas).toHaveBeenCalledWith('redx'));
    fireEvent.change(screen.getByPlaceholderText('Main pickup point'), { target: { value: 'Warehouse' } });
    fireEvent.change(screen.getByPlaceholderText('01XXX-XXX-XXX'), { target: { value: '01712345678' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Area' }), { target: { value: '9' } });
    fireEvent.change(screen.getByPlaceholderText('Enter the complete pickup address'), { target: { value: 'Road 1, Mirpur' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save and validate' }));

    await waitFor(() => expect(mocks.syncProviderPickup).toHaveBeenCalledWith('redx', expect.objectContaining({
      provider_pickup_meta: { delivery_area_id: 9 },
    })));
    expect(onSaved).toHaveBeenCalledTimes(1);
  });
});
