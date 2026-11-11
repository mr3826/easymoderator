import type { DeliveryLocationOption } from '@/api/types/order';

/**
 * Shared helpers for the courier directory pickers (pickup details and the
 * booking modal's delivery-area section). Extracted verbatim from
 * PickupDetailsModal so both pickers read option ids/labels the same way.
 */

export const optionId = (option: DeliveryLocationOption, kind: 'city' | 'zone' | 'area'): string =>
  String(option[`${kind}_id`] ?? option.id ?? '');

export const optionLabel = (option: DeliveryLocationOption, language?: string): string => {
  const kindNames = [option.city_name, option.zone_name, option.area_name];
  const localizedName = language?.startsWith('bn')
    ? option.name_bn ?? option.city_name_bn ?? option.zone_name_bn ?? option.area_name_bn
    : undefined;
  return String(localizedName ?? option.name ?? option.label ?? kindNames.find(Boolean) ?? option.id);
};

/** Directory ids go back to the provider in their native type when numeric. */
export const providerId = (value: string): string | number => (/^\d+$/.test(value) ? Number(value) : value);
