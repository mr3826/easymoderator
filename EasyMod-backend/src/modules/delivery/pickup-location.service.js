'use strict';

const ShopPickupLocation = require('./shop-pickup-location.entity');
const DeliveryIntegration = require('./delivery-integration.entity');
const { sequelize } = require('../../utils/database/database-setup');
const { AppError } = require('../../utils/AppError');
const { PROVIDER_NAMES = [] } = require('./providers/provider.registry');
const { Op } = require('sequelize');

const MAX_METADATA_DEPTH = 4;
const ALLOWED_PROVIDERS = new Set(['manual', ...PROVIDER_NAMES]);
const SENSITIVE_KEY = /(token|secret|password|credential|api[_-]?key|authorization|cookie|signature)/i;

const isPlainObject = (value) => (
    value !== null && typeof value === 'object' && !Array.isArray(value)
);

/** Remove secret-shaped keys before provider data reaches a JSON response or row. */
const sanitizeMetadata = (value, depth = 0) => {
    if (depth > MAX_METADATA_DEPTH) return undefined;
    if (Array.isArray(value)) {
        return value.map((entry) => sanitizeMetadata(entry, depth + 1)).filter((entry) => entry !== undefined);
    }
    if (!isPlainObject(value)) return value;

    const result = {};
    for (const [key, nested] of Object.entries(value)) {
        if (SENSITIVE_KEY.test(key)) continue;
        const safe = sanitizeMetadata(nested, depth + 1);
        if (safe !== undefined) result[key] = safe;
    }
    return result;
};

const asTrimmedString = (value, field, { required = false, max = 255 } = {}) => {
    if (value === undefined || value === null) {
        if (required) throw new AppError(`${field} is required`, 400, 'VALIDATION_ERROR');
        return value === null ? null : undefined;
    }
    if (typeof value !== 'string') {
        throw new AppError(`${field} must be a string`, 400, 'VALIDATION_ERROR');
    }
    const normalized = value.trim();
    if (required && !normalized) {
        throw new AppError(`${field} is required`, 400, 'VALIDATION_ERROR');
    }
    if (normalized.length > max) {
        throw new AppError(`${field} must be at most ${max} characters`, 400, 'VALIDATION_ERROR');
    }
    return normalized || (value === null ? null : '');
};

const asNullableInteger = (value, field) => {
    if (value === undefined || value === null || value === '') return value === null ? null : undefined;
    const number = Number(value);
    if (!Number.isInteger(number) || number < 0) {
        throw new AppError(`${field} must be a non-negative integer`, 400, 'VALIDATION_ERROR');
    }
    return number;
};

const asBoolean = (value, field) => {
    if (value === undefined) return undefined;
    if (typeof value !== 'boolean') {
        throw new AppError(`${field} must be a boolean`, 400, 'VALIDATION_ERROR');
    }
    return value;
};

const normalizeProvider = (value, required = false) => {
    if (value === undefined || value === null || value === '') {
        if (required) throw new AppError('provider is required', 400, 'VALIDATION_ERROR');
        return 'manual';
    }
    if (typeof value !== 'string') {
        throw new AppError('provider must be a string', 400, 'VALIDATION_ERROR');
    }
    const provider = value.trim().toLowerCase();
    if (!ALLOWED_PROVIDERS.has(provider)) {
        throw new AppError(`provider must be one of: ${[...ALLOWED_PROVIDERS].join(', ')}`, 400, 'VALIDATION_ERROR');
    }
    return provider;
};

const toDataValues = (location) => {
    if (!location) return null;
    if (location.dataValues && typeof location.dataValues === 'object') return location.dataValues;
    if (typeof location.toJSON === 'function') return location.toJSON();
    return location;
};

const serializePickupLocation = (location) => {
    const source = toDataValues(location);
    if (!source || typeof source !== 'object') return null;

    return {
        id: source.id,
        shop_id: source.shop_id,
        display_name: source.display_name ?? source.name ?? '',
        contact_name: source.contact_name ?? null,
        phone: source.phone ?? source.contact_phone ?? null,
        secondary_phone: source.secondary_phone ?? null,
        address: source.address,
        city_name: source.city_name ?? source.city ?? null,
        zone_name: source.zone_name ?? source.zone ?? null,
        area_name: source.area_name ?? source.area ?? '',
        postal_code: source.postal_code ?? null,
        city_id: source.city_id ?? null,
        zone_id: source.zone_id ?? null,
        area_id: source.area_id ?? null,
        provider: source.provider || 'manual',
        provider_store_id: source.provider_store_id ?? null,
        is_active: source.is_active !== false,
        is_default: source.is_default === true,
        metadata: sanitizeMetadata(source.metadata || {}),
        created_at: source.created_at ?? null,
        updated_at: source.updated_at ?? null,
    };
};

const normalizeLocationInput = (input = {}, { partial = false, requirePhone = !partial } = {}) => {
    if (!isPlainObject(input)) {
        throw new AppError('Pickup location must be an object', 400, 'VALIDATION_ERROR');
    }

    const values = {};
    const name = input.display_name ?? input.name ?? input.location_name ?? input.contact_name;
    const address = input.address ?? input.address_line;
    if (!partial || name !== undefined) values.display_name = asTrimmedString(name, 'display_name', { required: !partial, max: 255 });
    if (!partial || input.contact_name !== undefined) {
        values.contact_name = asTrimmedString(
            input.contact_name ?? name,
            'contact_name',
            { max: 255 },
        );
    }
    if (!partial || address !== undefined) values.address = asTrimmedString(address, 'address', { required: !partial, max: 2000 });

    const phone = input.phone ?? input.contact_phone;
    if (!partial || phone !== undefined) {
        values.phone = asTrimmedString(phone, 'phone', { required: requirePhone, max: 32 });
        if (values.phone && !/^01[3-9]\d{8}$/.test(values.phone.replace(/[-\s().]/g, ''))) {
            throw new AppError('phone must be a valid Bangladesh mobile number', 400, 'VALIDATION_ERROR');
        }
    }
    if (!partial || input.secondary_phone !== undefined || input.secondaryPhone !== undefined) {
        values.secondary_phone = asTrimmedString(input.secondary_phone ?? input.secondaryPhone, 'secondary_phone', { max: 32 });
    }

    const city = input.city_name ?? input.city;
    const zone = input.zone_name ?? input.zone;
    const area = input.area_name ?? input.area;
    if (!partial || city !== undefined) values.city_name = asTrimmedString(city, 'city_name', { max: 120 });
    if (!partial || zone !== undefined) values.zone_name = asTrimmedString(zone, 'zone_name', { max: 120 });
    if (!partial || area !== undefined) values.area_name = asTrimmedString(area, 'area_name', { required: !partial, max: 120 });
    if (!partial || input.postal_code !== undefined) values.postal_code = asTrimmedString(input.postal_code, 'postal_code', { max: 32 });

    const cityId = input.city_id ?? input.cityId;
    const zoneId = input.zone_id ?? input.zoneId;
    const areaId = input.area_id ?? input.areaId;
    if (!partial || cityId !== undefined) values.city_id = asNullableInteger(cityId, 'city_id');
    if (!partial || zoneId !== undefined) values.zone_id = asNullableInteger(zoneId, 'zone_id');
    if (!partial || areaId !== undefined) values.area_id = asNullableInteger(areaId, 'area_id');

    if (!partial || input.provider !== undefined) values.provider = normalizeProvider(input.provider);
    const providerStoreId = input.provider_store_id ?? input.providerStoreId ?? input.store_id;
    if (!partial || providerStoreId !== undefined) {
        values.provider_store_id = asTrimmedString(providerStoreId, 'provider_store_id', { max: 120 });
    }

    const isActive = input.is_active ?? input.isActive;
    const isDefault = input.is_default ?? input.isDefault;
    if (!partial || isActive !== undefined) values.is_active = asBoolean(isActive, 'is_active');
    if (!partial || isDefault !== undefined) values.is_default = asBoolean(isDefault, 'is_default');

    if (!partial || input.metadata !== undefined) {
        if (input.metadata !== undefined && !isPlainObject(input.metadata)) {
            throw new AppError('metadata must be an object', 400, 'VALIDATION_ERROR');
        }
        values.metadata = sanitizeMetadata(input.metadata || {});
    }

    // Keep the original pre-release column names populated when the table is
    // deployed from the additive migration. They are nullable compatibility
    // aliases and are never returned as a second public API shape.
    if (values.display_name !== undefined) values.name = values.display_name;
    if (values.phone !== undefined) values.contact_phone = values.phone;
    if (values.city_name !== undefined) values.city = values.city_name;
    if (values.zone_name !== undefined) values.zone = values.zone_name;
    if (values.area_name !== undefined) values.area = values.area_name;

    return values;
};

const clearOtherDefaults = async (shopId, locationId, transaction) => {
    await ShopPickupLocation.update(
        { is_default: false },
        {
            where: {
                shop_id: shopId,
                is_default: true,
                ...(locationId ? { id: { [Op.ne]: locationId } } : {}),
            },
            transaction,
        },
    );
};

const listPickupLocations = async (shopId, { includeInactive = false } = {}) => {
    if (!shopId) throw new AppError('Shop ID is required', 400, 'VALIDATION_ERROR');
    const where = { shop_id: shopId };
    if (!includeInactive) where.is_active = true;

    const locations = await ShopPickupLocation.findAll({
        where,
        order: [['is_default', 'DESC'], ['created_at', 'ASC'], ['id', 'ASC']],
    });
    return locations.map(serializePickupLocation);
};

const getPickupLocation = async (shopId, locationId) => {
    if (!shopId || !locationId) throw new AppError('Shop ID and pickup location ID are required', 400, 'VALIDATION_ERROR');
    const location = await ShopPickupLocation.findOne({
        where: { id: locationId, shop_id: shopId },
    });
    if (!location) throw new AppError('Pickup location not found', 404, 'PICKUP_LOCATION_NOT_FOUND');
    return location;
};

const createPickupLocation = async (shopId, input) => {
    if (!shopId) throw new AppError('Shop ID is required', 400, 'VALIDATION_ERROR');
    const values = normalizeLocationInput(input);

    return sequelize.transaction(async (transaction) => {
        if (values.is_default) await clearOtherDefaults(shopId, null, transaction);
        const location = await ShopPickupLocation.create({ shop_id: shopId, ...values }, { transaction });
        return serializePickupLocation(location);
    });
};

const updatePickupLocation = async (shopId, locationId, input) => {
    if (!shopId || !locationId) throw new AppError('Shop ID and pickup location ID are required', 400, 'VALIDATION_ERROR');
    const values = normalizeLocationInput(input, { partial: true });
    if (Object.keys(values).length === 0) {
        throw new AppError('At least one pickup location field is required', 400, 'VALIDATION_ERROR');
    }

    return sequelize.transaction(async (transaction) => {
        const location = await ShopPickupLocation.findOne({
            where: { id: locationId, shop_id: shopId },
            transaction,
            lock: transaction.LOCK?.UPDATE,
        });
        if (!location) throw new AppError('Pickup location not found', 404, 'PICKUP_LOCATION_NOT_FOUND');

        if (values.is_default) await clearOtherDefaults(shopId, locationId, transaction);
        if (values.is_active === false && values.is_default === undefined && location.is_default) {
            values.is_default = false;
        }
        await location.update(values, { transaction });
        return serializePickupLocation(location);
    });
};

/**
 * Safe pickup location deletion.
 *
 * A location is refused (409, confirm-required payload) while it is either
 *   - the shop default, or
 *   - the selected pickup of a connected courier integration, directly by
 *     pickup_location_id or through the provider store row it links to.
 *
 * Orders and dispatches are never cascaded: courier_dispatch rows and order
 * delivery snapshots keep their own data regardless of this row. Deleting an
 * in-use row (only after confirm=true) leaves the integration column linked
 * to NULL (FK SET NULL) so order/dispatch history remains intact.
 */
const deletePickupLocation = async (shopId, locationId, { confirm = false } = {}) => {
    if (!shopId || !locationId) throw new AppError('Shop ID and pickup location ID are required', 400, 'VALIDATION_ERROR');

    return sequelize.transaction(async (transaction) => {
        const location = await ShopPickupLocation.findOne({
            where: { id: locationId, shop_id: shopId },
            transaction,
            lock: transaction.LOCK?.UPDATE,
        });
        if (!location) throw new AppError('Pickup location not found', 404, 'PICKUP_LOCATION_NOT_FOUND');

        const source = toDataValues(location);
        const blockers = [];
        if (source.is_default === true) {
            blockers.push({
                code: 'IS_SHOP_DEFAULT',
                message: 'This is the shop default pickup location. Choose another default first.',
            });
        }

        const referencedProviders = [];
        if (DeliveryIntegration && typeof DeliveryIntegration.findAll === 'function') {
            const integrations = await DeliveryIntegration.findAll({
                where: { shop_id: shopId },
                transaction,
            });
            const providerStoreId = source.provider_store_id ?? null;
            const provider = source.provider ?? 'manual';
            for (const integration of integrations) {
                const values = toDataValues(integration);
                const selectedByLocation = String(values.pickup_location_id ?? '') === String(locationId);
                const selectedByStore = providerStoreId !== null
                    && providerStoreId !== undefined
                    && String(providerStoreId) !== ''
                    && values.pickup_enabled === true
                    && values.provider === provider
                    && String(values.provider_store_id ?? values.pickup_store_id ?? '') === String(providerStoreId);
                if ((selectedByLocation || selectedByStore) && values.provider) {
                    referencedProviders.push(values.provider);
                }
            }
        }
        if (referencedProviders.length > 0) {
            blockers.push({
                code: 'IN_USE',
                message: 'This pickup location is the selected pickup for a courier integration.',
                providers: Array.from(new Set(referencedProviders)),
            });
        }

        if (blockers.length > 0 && confirm !== true) {
            throw new AppError(
                'Pickup location is in use. Confirm the deletion to continue.',
                409,
                'PICKUP_LOCATION_DELETE_CONFIRMATION_REQUIRED',
                {
                    location_id: locationId,
                    requires_confirmation: true,
                    blockers,
                },
            );
        }

        await location.destroy({ transaction });
        return {
            id: locationId,
            deleted: true,
            released_providers: Array.from(new Set(referencedProviders)),
        };
    });
};

const syncProviderStores = async (shopId, provider, stores) => {
    if (!shopId) throw new AppError('Shop ID is required', 400, 'VALIDATION_ERROR');
    const normalizedProvider = normalizeProvider(provider, true);
    if (normalizedProvider === 'manual') {
        throw new AppError('A provider is required to sync pickup stores', 400, 'VALIDATION_ERROR');
    }
    if (!Array.isArray(stores)) {
        throw new AppError('Provider stores must be an array', 502, 'DELIVERY_PROVIDER_INVALID_RESPONSE');
    }

    return sequelize.transaction(async (transaction) => {
        const synced = [];
        for (const store of stores) {
            if (!isPlainObject(store)) continue;
            const storeId = store.store_id ?? store.id ?? store.storeId;
            if (storeId === undefined || storeId === null || String(storeId).trim() === '') continue;

            const storeName = store.store_name ?? store.name ?? `${normalizedProvider} pickup store`;
            const address = store.address
                || store.address_line
                || [store.area_name, store.zone_name, store.city_name].filter(Boolean).join(', ')
                || String(storeName).trim();
            const values = normalizeLocationInput({
                name: String(storeName).trim(),
                address: String(address).trim(),
                contact_phone: store.contact_phone ?? store.phone ?? '',
                city: store.city ?? store.city_name ?? null,
                zone: store.zone ?? store.zone_name ?? null,
                 area: store.area
                     ?? store.area_name
                     ?? store.zone_name
                     ?? store.city_name
                     ?? String(storeName).trim(),
                city_id: store.city_id ?? null,
                zone_id: store.zone_id ?? null,
                area_id: store.area_id ?? null,
                provider: normalizedProvider,
                provider_store_id: String(storeId),
                is_active: true,
                is_default: false,
                metadata: {
                    synced_from_provider: true,
                    provider_store_id: String(storeId),
                },
            }, { requirePhone: false });
            delete values.is_default;

            let location = await ShopPickupLocation.findOne({
                where: {
                    shop_id: shopId,
                    provider: normalizedProvider,
                    provider_store_id: String(storeId),
                },
                transaction,
                lock: transaction.LOCK?.UPDATE,
            });

            if (location) {
                await location.update(values, { transaction });
            } else {
                location = await ShopPickupLocation.create({
                    shop_id: shopId,
                    ...values,
                    is_default: false,
                }, { transaction });
            }
            synced.push(serializePickupLocation(location));
        }
        return synced;
    });
};

const setDefaultPickupLocation = async (shopId, locationId) => updatePickupLocation(shopId, locationId, { is_default: true });

module.exports = {
    listPickupLocations,
    getPickupLocation,
    createPickupLocation,
    updatePickupLocation,
    deletePickupLocation,
    syncProviderStores,
    setDefaultPickupLocation,
    normalizeLocationInput,
    sanitizeMetadata,
    serializePickupLocation,
};
