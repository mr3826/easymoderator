const DeliveryIntegration = require('./delivery-integration.entity');
const { COURIER_REGISTRY, normalizeStatus: registryNormalizeStatus } = require('./providers/provider.registry');
const pathaoTokenService = require('./pathao-token.service');
const pickupLocationService = require('./pickup-location.service');
const courierReadinessService = require('./courier-readiness.service');
const { AppError } = require('../../utils/AppError');
const { sequelize } = require('../../utils/database/database-setup');
const EventEmitter = require('events');

const safeProviderErrorCode = (error) => {
    const code = typeof error?.code === 'string' ? error.code.toUpperCase() : '';
    return /^[A-Z][A-Z0-9_:-]{0,63}$/.test(code) ? code : 'COURIER_PROVIDER_ERROR';
};

const isPlainObject = (value) => (
    value !== null && typeof value === 'object' && !Array.isArray(value)
);

const integrationMetadata = (integration) => (
    isPlainObject(integration?.metadata) ? integration.metadata : {}
);

const isTrue = (value) => value === true || value === 1 || value === 'true';

const safeProviderPickupMetadata = (metadata = {}) => {
    if (!isPlainObject(metadata)) return {};
    const safe = {};
    for (const key of ['city_id', 'zone_id', 'area_id', 'delivery_area_id', 'pickup_store_id', 'provider_store_id']) {
        if (metadata[key] !== undefined && metadata[key] !== null && metadata[key] !== '') {
            safe[key] = metadata[key];
        }
    }
    return safe;
};

const normalizedPickupValue = (value) => String(value ?? '').trim().toLowerCase();

const providerStoreMatchesPickup = (store, location, providerMeta) => {
    const expected = [
        ['city_id', providerMeta.city_id ?? location?.city_id],
        ['zone_id', providerMeta.zone_id ?? location?.zone_id],
        ['area_id', providerMeta.area_id ?? providerMeta.delivery_area_id ?? location?.area_id],
    ].filter(([, value]) => value !== undefined && value !== null && value !== '');
    const actual = (key) => store?.[key]
        ?? store?.[`${key.replace('_id', '')}Id`]
        ?? store?.[key.replace('_id', '')]?.id;
    if (expected.length > 0) {
        return expected.every(([key, value]) => normalizedPickupValue(actual(key)) === normalizedPickupValue(value));
    }

    const expectedName = normalizedPickupValue(location?.display_name || location?.name);
    const actualName = normalizedPickupValue(store?.store_name || store?.name || store?.storeName);
    return Boolean(expectedName && actualName && expectedName === actualName);
};

const hasAiDefaultFlag = (integration) => {
    const hasDatabaseFlag = integration
        && (Object.prototype.hasOwnProperty.call(integration, 'is_ai_default')
            || typeof integration.getDataValue === 'function');
    if (hasDatabaseFlag) return isTrue(integration.is_ai_default);
    return isTrue(integrationMetadata(integration).is_ai_default)
        || isTrue(integrationMetadata(integration).ai_default);
};

const setIntegrationValue = (integration, key, value) => {
    if (!integration) return;
    integration[key] = value;
    if (typeof integration.setDataValue === 'function') {
        try {
            integration.setDataValue(key, value);
        } catch (_) {
            // Current DeliveryIntegration predates the additive columns. The
            // metadata mirror below remains the compatible persisted value.
        }
    }
};

const safeIntegrationMetadata = (metadata = {}) => {
    if (!isPlainObject(metadata)) return {};
    const safe = {};
    for (const [key, value] of Object.entries(metadata)) {
        if (/(token|secret|password|credential|api[_-]?key|authorization|cookie|signature)/i.test(key)) continue;
        if (key === 'stores' && Array.isArray(value)) {
            safe.stores = value.map((store) => {
                if (!isPlainObject(store)) return null;
                const allowed = {};
                for (const storeKey of ['store_id', 'store_name', 'city_id', 'zone_id', 'area_id']) {
                    if (store[storeKey] !== undefined) allowed[storeKey] = store[storeKey];
                }
                return allowed;
            }).filter(Boolean);
            continue;
        }
        if (key === 'provider_pickup_meta') {
            safe.provider_pickup_meta = safeProviderPickupMetadata(value);
            continue;
        }
        if (isPlainObject(value) || Array.isArray(value)) continue;
        safe[key] = value;
    }
    if (Array.isArray(metadata.stores)) safe.stores = safe.stores || [];
    return safe;
};

const enrichIntegrationFlags = async (shopId, integrations) => {
    if (!Array.isArray(integrations)) return integrations;
    const database = DeliveryIntegration.sequelize;
    if (!database || typeof database.query !== 'function') return integrations;

    try {
        const [rows] = await database.query(`
            SELECT id, provider, is_ai_default, pickup_location_id, pickup_store_id,
                   provider_store_id, pickup_enabled, provider_pickup_meta,
                   activation_status, activation_error
            FROM delivery_integrations
            WHERE shop_id = :shopId
        `, { replacements: { shopId } });
        const byId = new Map((rows || []).map((row) => [String(row.id), row]));
        return integrations.map((integration) => {
            const row = byId.get(String(integration.id));
            if (!row) return integration;
            for (const key of [
                'is_ai_default',
                'pickup_location_id',
                'pickup_store_id',
                'provider_store_id',
                'pickup_enabled',
                'provider_pickup_meta',
                'activation_status',
                'activation_error',
            ]) {
                if (row[key] !== undefined) integration[key] = row[key];
            }
            return integration;
        });
    } catch (_) {
        // Metadata remains the compatibility source for installations that
        // have not applied the additive columns yet.
        return integrations;
    }
};

const persistIntegrationState = async (integration, state = {}, transaction = null) => {
    const database = DeliveryIntegration.sequelize;
    if (!database || typeof database.query !== 'function' || !integration?.id) return;

    const allowed = [
        'pickup_location_id',
        'pickup_store_id',
        'provider_store_id',
        'provider_pickup_meta',
        'pickup_enabled',
        'is_ai_default',
        'activation_status',
        'activation_error',
    ];
    const updates = Object.fromEntries(
        allowed
            .filter((key) => Object.prototype.hasOwnProperty.call(state, key))
            .map((key) => [key, key === 'provider_pickup_meta'
                ? JSON.stringify(state[key] || {})
                : state[key]]),
    );
    const keys = Object.keys(updates);
    if (!keys.length) return;

    const dialect = typeof database.getDialect === 'function' ? database.getDialect() : null;
    const assignments = keys.map((key) => (
        key === 'provider_pickup_meta' && dialect === 'postgres'
            ? `${key} = CAST(:${key} AS JSONB)`
            : `${key} = :${key}`
    )).join(', ');
    const options = { replacements: { id: integration.id, ...updates } };
    if (transaction) options.transaction = transaction;
    try {
        await database.query(`UPDATE delivery_integrations SET ${assignments} WHERE id = :id`, options);
    } catch (error) {
        // The metadata mirror remains usable before migration 20260828_002 is
        // applied; other database failures must remain visible.
        if (/column .* does not exist|no such column|unknown column/i.test(String(error?.message || ''))) return;
        throw error;
    }
};

/**
 * Unified Delivery Service
 * Abstracts provider-specific logic and normalizes responses
 */
class DeliveryService extends EventEmitter {
    constructor() {
        super();
        this.providers = COURIER_REGISTRY;
    }

    /**
     * Get provider instance for a shop
     */
    async getProviderInstance(shopId, provider) {
        const integration = await DeliveryIntegration.findOne({
            where: {
                shop_id: shopId,
                provider: provider,
                is_active: true,
                is_connected: true
            }
        });

        if (!integration) {
            throw new Error(`No active ${provider} integration found for this shop`);
        }

        const entry = this.providers[provider];
        if (!entry) {
            throw new Error(`Unknown provider: ${provider}`);
        }

        const credentials = integration.credentials;
        if (provider === 'pathao') {
            return pathaoTokenService.createProvider(shopId, integration, entry.Provider);
        }
        return new entry.Provider(credentials, integration.is_sandbox === true);
    }

    /**
     * Get a connected provider even when the merchant has not activated it yet.
     * Provider catalogue/store reads use this path and never require a booking
     * provider to be active.
     */
    async getConnectedProviderInstance(shopId, provider) {
        const integration = await DeliveryIntegration.findOne({
            where: {
                shop_id: shopId,
                provider,
                is_connected: true,
            },
        });

        if (!integration) {
            throw new AppError(`No connected ${provider} integration found for this shop`, 400, 'DELIVERY_PROVIDER_NOT_CONNECTED');
        }

        const entry = this.providers[provider];
        if (!entry) throw new AppError(`Unknown provider: ${provider}`, 400, 'DELIVERY_PROVIDER_UNKNOWN');
        if (provider === 'pathao') {
            return pathaoTokenService.createProvider(shopId, integration, entry.Provider);
        }
        return new entry.Provider(integration.credentials, integration.is_sandbox === true);
    }

    /**
     * Get active delivery provider for a shop
     */
    async getActiveProvider(shopId) {
        const integrations = typeof DeliveryIntegration.findAll === 'function'
            ? await DeliveryIntegration.findAll({
                where: {
                    shop_id: shopId,
                    is_active: true,
                    is_connected: true,
                },
                order: [['updated_at', 'DESC'], ['id', 'DESC']],
            })
            : [await DeliveryIntegration.findOne({
                where: {
                    shop_id: shopId,
                    is_active: true,
                    is_connected: true,
                },
                order: [['updated_at', 'DESC']],
            })].filter(Boolean);

        await enrichIntegrationFlags(shopId, integrations);
        const explicitDefault = integrations.find(hasAiDefaultFlag);
        let integration = explicitDefault || null;

        // The older settings path stores delivery priority in the shop JSON.
        // Keep it as a fallback for existing shops while explicit defaults take
        // precedence for new activation flows.
        if (!integration) {
            try {
                const { Shop } = require('../entities');
                const shop = await Shop.findByPk(shopId, { attributes: ['settings'] });
                const priority = shop?.settings?.delivery_platform_priority;
                if (Array.isArray(priority)) {
                    integration = priority
                        .map((provider) => integrations.find((candidate) => candidate.provider === provider))
                        .find(Boolean) || null;
                }
            } catch (_) {
                // Fall back to the existing updated-at ordering below.
            }
        }
        integration = integration || integrations[0] || null;

        if (!integration) {
            return null;
        }

        return {
            provider: integration.provider,
            instance: await this.getProviderInstance(shopId, integration.provider),
            metadata: integration.metadata
        };
    }

    /** Return the explicitly selected provider used by AI courier actions. */
    async getAiDefaultProvider(shopId) {
        let integrations = typeof DeliveryIntegration.findAll === 'function'
            ? await DeliveryIntegration.findAll({
                where: { shop_id: shopId, is_active: true, is_connected: true },
                order: [['updated_at', 'DESC'], ['id', 'DESC']],
            })
            : [];
        await enrichIntegrationFlags(shopId, integrations);
        const integration = integrations.find(hasAiDefaultFlag);
        if (!integration) return null;

        return {
            provider: integration.provider,
            instance: await this.getProviderInstance(shopId, integration.provider),
            metadata: integration.metadata,
            pickup: await this.getPickupSummary(shopId, integration),
        };
    }

    /**
     * Resolve the AI courier without falling back to an arbitrary active
     * provider. An AI action must have an explicit default and a complete
     * pickup/provider readiness receipt.
     */
    async resolveAiDefaultProvider(shopId) {
        let integrations = typeof DeliveryIntegration.findAll === 'function'
            ? await DeliveryIntegration.findAll({
                where: { shop_id: shopId },
                order: [['updated_at', 'DESC'], ['id', 'DESC']],
            })
            : [];
        await enrichIntegrationFlags(shopId, integrations);
        const integration = integrations.find(hasAiDefaultFlag);
        if (!integration) {
            return {
                blocked: true,
                provider: null,
                reason: 'AI_DEFAULT_NOT_CONFIGURED',
                missing: ['ai_default_courier'],
            };
        }

        const readiness = await courierReadinessService.getReadiness(shopId, integration.provider);
        if (!readiness.ready) {
            return {
                blocked: true,
                provider: integration.provider,
                reason: 'COURIER_SETUP_REQUIRED',
                missing: readiness.missing,
                readiness,
            };
        }

        return {
            blocked: false,
            provider: integration.provider,
            instance: await this.getProviderInstance(shopId, integration.provider),
            pickup: readiness.pickup_summary || await this.getPickupSummary(shopId, integration),
            readiness,
            source: 'ai_default',
        };
    }

    /**
     * Mark exactly one connected and active provider as the AI default. The
     * metadata mirror keeps this usable until older installations receive the
     * additive integration columns; the migration provides those columns for
     * direct SQL/reporting consumers.
     */
    async setAiDefaultProvider(shopId, provider, enabled = true) {
        if (!shopId || !provider) throw new AppError('Shop ID and provider are required', 400, 'VALIDATION_ERROR');
        if (!this.providers[provider]) throw new AppError('Invalid provider', 400, 'DELIVERY_PROVIDER_UNKNOWN');
        if (typeof enabled !== 'boolean') throw new AppError('enabled must be a boolean', 400, 'VALIDATION_ERROR');

        return sequelize.transaction(async (transaction) => {
            const target = await DeliveryIntegration.findOne({
                where: { shop_id: shopId, provider },
                transaction,
                lock: transaction.LOCK?.UPDATE,
            });
            if (!target) throw new AppError('Provider not found', 404, 'DELIVERY_PROVIDER_NOT_FOUND');
            if (enabled && (!target.is_connected || !target.is_active)) {
                throw new AppError('Provider must be connected and active before it can be the AI default', 400, 'DELIVERY_PROVIDER_NOT_READY');
            }
            if (enabled) {
                const readiness = await courierReadinessService.getReadiness(shopId, provider);
                if (!readiness.ready) {
                    throw new AppError(
                        'Courier is not ready for AI activation',
                        409,
                        'DELIVERY_PROVIDER_SETUP_INCOMPLETE',
                        { provider, missing: readiness.missing },
                    );
                }
            }

            const integrations = typeof DeliveryIntegration.findAll === 'function'
                ? await DeliveryIntegration.findAll({ where: { shop_id: shopId }, transaction, lock: transaction.LOCK?.UPDATE })
                : [target];
            const targetMatches = (integration) => (
                target.id !== undefined && target.id !== null
                    ? integration.id === target.id
                    : integration.provider === target.provider
            );
            if (!integrations.some(targetMatches)) {
                integrations.push(target);
            }
            // Clear the old default before promoting a replacement so the
            // partial unique index remains valid during the transaction.
            for (const integration of integrations) {
                const metadata = {
                    ...safeIntegrationMetadata(integrationMetadata(integration)),
                    ai_default: false,
                };
                setIntegrationValue(integration, 'is_ai_default', false);
                integration.metadata = metadata;
                if (typeof integration.save === 'function') await integration.save({ transaction });
                await persistIntegrationState(integration, { is_ai_default: false }, transaction);
            }
            if (enabled) {
                const metadata = {
                    ...safeIntegrationMetadata(integrationMetadata(target)),
                    ai_default: true,
                };
                setIntegrationValue(target, 'is_ai_default', true);
                target.metadata = metadata;
                if (typeof target.save === 'function') await target.save({ transaction });
                await persistIntegrationState(target, { is_ai_default: true }, transaction);
            }

            return {
                provider,
                is_ai_default: enabled,
            };
        });
    }

    /** Persist the selected local/provider pickup source for one integration. */
    async setPickupConfiguration(shopId, provider, input = {}) {
        if (!shopId || !provider) throw new AppError('Shop ID and provider are required', 400, 'VALIDATION_ERROR');
        const integration = await DeliveryIntegration.findOne({ where: { shop_id: shopId, provider } });
        if (!integration) throw new AppError('Provider not found', 404, 'DELIVERY_PROVIDER_NOT_FOUND');
        if (!integration.is_connected) {
            throw new AppError('Provider must be connected before pickup setup', 400, 'DELIVERY_PROVIDER_NOT_CONNECTED');
        }

        const locationId = input.pickup_location_id
            ?? input.location_id
            ?? input.locationId
            ?? null;
        const providerPickupMeta = safeProviderPickupMetadata(
            input.provider_pickup_meta ?? input.providerPickupMeta ?? {}
        );
        const requestedStoreId = input.store_id
            ?? input.storeId
            ?? input.provider_store_id
            ?? providerPickupMeta.pickup_store_id
            ?? providerPickupMeta.provider_store_id
            ?? null;
        const existingMetadata = integrationMetadata(integration);
        const fallbackStoreId = requestedStoreId
            ?? existingMetadata.store_id
            ?? existingMetadata.stores?.[0]?.store_id
            ?? null;
        const storeId = fallbackStoreId;
        const enabled = input.enabled ?? input.pickup_enabled ?? true;
        if (typeof enabled !== 'boolean') throw new AppError('enabled must be a boolean', 400, 'VALIDATION_ERROR');

        let location = null;
        if (locationId) location = await pickupLocationService.getPickupLocation(shopId, locationId);
        if (location && location.provider !== 'manual' && location.provider !== provider) {
            throw new AppError('Pickup location belongs to another provider', 400, 'PICKUP_LOCATION_PROVIDER_MISMATCH');
        }

        const metadata = {
            ...safeIntegrationMetadata(integrationMetadata(integration)),
            ...(locationId ? { pickup_location_id: locationId } : { pickup_location_id: null }),
            ...(storeId !== null && storeId !== undefined ? { pickup_store_id: String(storeId), store_id: String(storeId) } : {}),
            provider_pickup_meta: providerPickupMeta,
            pickup_enabled: enabled,
        };
        integration.metadata = metadata;
        setIntegrationValue(integration, 'pickup_location_id', locationId);
        setIntegrationValue(integration, 'pickup_store_id', storeId === null || storeId === undefined ? null : String(storeId));
        setIntegrationValue(integration, 'provider_store_id', storeId === null || storeId === undefined ? null : String(storeId));
        setIntegrationValue(integration, 'pickup_enabled', enabled);
        setIntegrationValue(integration, 'provider_pickup_meta', providerPickupMeta);
        if (typeof integration.save === 'function') await integration.save();
        await persistIntegrationState(integration, {
            pickup_location_id: locationId,
            pickup_store_id: storeId === null || storeId === undefined ? null : String(storeId),
            provider_store_id: storeId === null || storeId === undefined ? null : String(storeId),
            provider_pickup_meta: providerPickupMeta,
            pickup_enabled: enabled,
            activation_status: integration.is_active ? 'ACTIVE' : 'SETUP_INCOMPLETE',
            activation_error: null,
        });

        return {
            provider,
            pickup_enabled: enabled,
            pickup_location_id: locationId,
            pickup_store_id: storeId === null || storeId === undefined ? null : String(storeId),
            provider_pickup_meta: providerPickupMeta,
            pickup_summary: location ? pickupLocationService.serializePickupLocation(location) : null,
            activation_status: integration.is_active ? 'ACTIVE' : 'SETUP_INCOMPLETE',
            activation_error: null,
        };
    }

    /** Compatibility name used by the provider-specific pickup setup route. */
    async syncProviderPickup(shopId, provider, input = {}) {
        const locationId = input.pickup_location_id
            ?? input.location_id
            ?? input.locationId
            ?? null;
        const location = locationId
            ? await pickupLocationService.getPickupLocation(shopId, locationId)
            : null;
        const integration = await DeliveryIntegration.findOne({ where: { shop_id: shopId, provider } });
        if (!integration) throw new AppError('Provider not found', 404, 'DELIVERY_PROVIDER_NOT_FOUND');
        if (!integration.is_connected) {
            throw new AppError('Provider must be connected before pickup setup', 400, 'DELIVERY_PROVIDER_NOT_CONNECTED');
        }

        const existingMetadata = integrationMetadata(integration);
        const inputProviderMeta = safeProviderPickupMetadata(input.provider_pickup_meta ?? input.providerPickupMeta ?? {});
        const providerPickupMeta = {
            ...safeProviderPickupMetadata(existingMetadata.provider_pickup_meta),
            ...inputProviderMeta,
        };
        let storeId = input.store_id
            ?? input.storeId
            ?? input.provider_store_id
            ?? inputProviderMeta.pickup_store_id
            ?? inputProviderMeta.provider_store_id
            ?? location?.provider_store_id
            ?? (!locationId ? (
                providerPickupMeta.pickup_store_id
                ?? providerPickupMeta.provider_store_id
                ?? existingMetadata.provider_store_id
                ?? existingMetadata.pickup_store_id
                ?? existingMetadata.store_id
            ) : null)
            ?? null;

        if (!storeId && (provider === 'pathao' || provider === 'redx') && location) {
            const instance = await this.getConnectedProviderInstance(shopId, provider);
            const storePayload = {
                name: location.display_name,
                store_name: location.display_name,
                contact_name: location.contact_name,
                phone: location.phone,
                address: location.address,
                city_id: providerPickupMeta.city_id ?? location.city_id,
                zone_id: providerPickupMeta.zone_id ?? location.zone_id,
                area_id: providerPickupMeta.area_id ?? providerPickupMeta.delivery_area_id ?? location.area_id,
            };
            let stores = [];
            if (provider === 'pathao' && typeof instance.getStores === 'function') {
                stores = await instance.getStores();
            } else if (provider === 'redx') {
                const listStores = instance.listPickupStores || instance.getPickupStores;
                if (typeof listStores === 'function') stores = await listStores.call(instance);
            }
            if (!Array.isArray(stores)) {
                stores = stores?.stores || stores?.data?.stores || stores?.data || [];
            }
            const matchingStore = stores.find((store) => providerStoreMatchesPickup(store, location, providerPickupMeta));
            storeId = matchingStore?.store_id ?? matchingStore?.id ?? null;
            if (!storeId) {
                const createStore = provider === 'pathao'
                    ? instance.createStore
                    : instance.createPickupStore;
                if (typeof createStore !== 'function') {
                    throw new AppError('Provider pickup store is required', 409, 'DELIVERY_PICKUP_STORE_REQUIRED');
                }
                const created = await createStore.call(instance, storePayload);
                const createdData = created?.data && typeof created.data === 'object' ? created.data : created;
                storeId = createdData?.store_id ?? createdData?.id ?? createdData?.pickup_store_id ?? null;
            }
            if (!storeId) {
                throw new AppError('Provider did not return a pickup store', 502, 'DELIVERY_PICKUP_STORE_SYNC_FAILED');
            }
        }

        if (storeId !== null && storeId !== undefined) {
            providerPickupMeta.pickup_store_id = storeId;
            providerPickupMeta.provider_store_id = storeId;
        }
        return this.setPickupConfiguration(shopId, provider, {
            ...input,
            pickup_location_id: locationId,
            store_id: storeId,
            provider_pickup_meta: providerPickupMeta,
        });
    }

    async getPickupSummary(shopId, integration) {
        const locationId = integration?.pickup_location_id
            ?? integrationMetadata(integration).pickup_location_id;
        if (!locationId) return null;
        try {
            const location = await pickupLocationService.getPickupLocation(shopId, locationId);
            return pickupLocationService.serializePickupLocation(location);
        } catch (_) {
            return null;
        }
    }

    async persistIntegrationState(integration, state = {}) {
        return persistIntegrationState(integration, state);
    }

    async enrichIntegrationState(shopId, integrations) {
        return enrichIntegrationFlags(shopId, integrations);
    }

    /** Run a connected provider's store endpoint with Pathao token recovery. */
    async getProviderStores(shopId, provider = 'pathao') {
        if (provider !== 'pathao') throw new AppError('Only Pathao supports store management', 400, 'DELIVERY_PROVIDER_UNSUPPORTED');
        const instance = await this.getConnectedProviderInstance(shopId, provider);
        if (typeof instance.getStores !== 'function') throw new AppError('Provider does not support store lookup', 400, 'DELIVERY_PROVIDER_UNSUPPORTED');
        return instance.getStores();
    }

    /** Read provider area hierarchy through the same connected/token-safe path. */
    async getProviderAreas(shopId, provider, { cityId = null, zoneId = null } = {}) {
        if (provider === 'redx') {
            const instance = await this.getConnectedProviderInstance(shopId, provider);
            const filters = {};
            if (cityId !== null && cityId !== undefined) filters.city_id = cityId;
            if (zoneId !== null && zoneId !== undefined) filters.zone_id = zoneId;
            if (typeof instance.listAreas === 'function') return instance.listAreas(filters);
            if (typeof instance.getAreas === 'function') return instance.getAreas(filters);
            throw new AppError('Provider does not support area lookup', 400, 'DELIVERY_PROVIDER_UNSUPPORTED');
        }
        if (provider !== 'pathao') {
            const { KnownArea } = require('../entities');
            if (KnownArea && typeof KnownArea.findAll === 'function') {
                const areas = await KnownArea.findAll({
                    where: { shop_id: shopId },
                    order: [['area_name', 'ASC'], ['id', 'ASC']],
                });
                return areas.map((area) => ({
                    id: area.id,
                    area_id: area.id,
                    name: area.area_name,
                    name_bn: area.area_name_bn || undefined,
                    zone_type: area.zone_type,
                }));
            }
            throw new AppError('Provider does not support area lookup', 400, 'DELIVERY_PROVIDER_UNSUPPORTED');
        }
        const instance = await this.getConnectedProviderInstance(shopId, provider);
        if (zoneId !== null && zoneId !== undefined) {
            if (typeof instance.getAreas !== 'function') throw new AppError('Provider does not support area lookup', 400, 'DELIVERY_PROVIDER_UNSUPPORTED');
            return instance.getAreas(zoneId);
        }
        if (cityId !== null && cityId !== undefined) {
            if (typeof instance.getZones !== 'function') throw new AppError('Provider does not support zone lookup', 400, 'DELIVERY_PROVIDER_UNSUPPORTED');
            return instance.getZones(cityId);
        }
        if (typeof instance.getCities !== 'function') throw new AppError('Provider does not support city lookup', 400, 'DELIVERY_PROVIDER_UNSUPPORTED');
        return instance.getCities();
    }

    /**
     * Normalize order payload based on provider — delegates to registry
     */
    normalizeOrderPayload(provider, orderData, providerMetadata = {}) {
        const entry = this.providers[provider];
        if (!entry) throw new Error(`Unknown provider: ${provider}`);
        return entry.normalizePayload(orderData, providerMetadata);
    }

    /**
     * Normalize order response to internal format — delegates to registry
     */
    normalizeOrderResponse(provider, response) {
        const entry = this.providers[provider];
        if (!entry) throw new Error(`Unknown provider: ${provider}`);
        const fields = entry.normalizeResponse(response);
        return {
            provider,
            success: true,
            consignment_id: null,
            tracking_code: null,
            status: null,
            delivery_fee: null,
            raw_response: response,
            ...fields
        };
    }

    /**
     * Normalize delivery status to internal format — delegates to registry status map
     */
    normalizeDeliveryStatus(provider, status) {
        const entry = this.providers[provider];
        const map = entry ? entry.statusMap : {};
        if (typeof registryNormalizeStatus === 'function') return registryNormalizeStatus(status, map);
        return map[status] || String(status || '').toLowerCase();
    }

    /**
     * Create delivery order
     */
    async createDeliveryOrder(shopId, orderData, preferredProvider = null) {
        try {
            let provider = preferredProvider;
            let providerInstance;
            let metadata = {};

            if (!provider) {
                // Get active provider
                const activeProvider = await this.getActiveProvider(shopId);
                if (!activeProvider) {
                    throw new Error('No active delivery provider configured');
                }
                provider = activeProvider.provider;
                providerInstance = activeProvider.instance;
                metadata = activeProvider.metadata;
            } else {
                providerInstance = await this.getProviderInstance(shopId, provider);
                const integration = await DeliveryIntegration.findOne({
                    where: { shop_id: shopId, provider }
                });
                metadata = integration?.metadata || {};
            }

            // Normalize payload
            const normalizedPayload = this.normalizeOrderPayload(provider, orderData, metadata);

            // Create order with provider
            const response = await providerInstance.createOrder(normalizedPayload);

            // Normalize response
            const normalizedResponse = this.normalizeOrderResponse(provider, response);

            // Emit event for n8n integration
            this.emit('order_dispatched', {
                shop_id: shopId,
                order_number: orderData.order_number,
                provider,
                consignment_id: normalizedResponse.consignment_id,
                tracking_code: normalizedResponse.tracking_code,
                status: normalizedResponse.status,
                timestamp: new Date()
            });

            return normalizedResponse;
        } catch (error) {
            // Emit failure event
            this.emit('order_dispatch_failed', {
                shop_id: shopId,
                order_number: orderData.order_number,
                provider: preferredProvider,
                error: safeProviderErrorCode(error),
                timestamp: new Date()
            });

            try {
                const merchantNotificationService = require('../notification/merchant-notification.service');
                const { NOTIFICATION_EVENTS } = require('../notification/notification-events');
                merchantNotificationService.notifyShop(
                    shopId,
                    NOTIFICATION_EVENTS.COURIER_BOOKING_FAILED,
                    {
                        orderId: orderData.id,
                        orderNumber: orderData.order_number,
                        provider: preferredProvider,
                        error: safeProviderErrorCode(error)
                    },
                    { dedupeKey: `${orderData.id || orderData.order_number || Date.now()}:${preferredProvider || 'active'}` }
                ).catch(() => {});
            } catch (_) { /* delivery failure is already being thrown */ }

            throw error;
        }
    }

    /**
     * Get delivery order status
     */
    async getDeliveryStatus(shopId, provider, reference) {
        try {
            const providerInstance = await this.getProviderInstance(shopId, provider);
            const statusResponse = await providerInstance.getOrderStatus(reference);

            const normalizedStatus = this.normalizeDeliveryStatus(
                provider,
                statusResponse.order_status || statusResponse.delivery_status
            );

            return {
                provider,
                reference,
                status: normalizedStatus,
                raw_status: statusResponse.order_status || statusResponse.delivery_status,
                updated_at: statusResponse.updated_at || new Date(),
                raw_response: statusResponse
            };
        } catch (error) {
            throw new Error(`Failed to get delivery status: ${error.message}`);
        }
    }

    /**
     * Update delivery status and emit events
     */
    async updateDeliveryStatus(shopId, orderNumber, provider, reference) {
        try {
            const statusData = await this.getDeliveryStatus(shopId, provider, reference);

            // Emit status change event for n8n
            this.emit('delivery_status_updated', {
                shop_id: shopId,
                order_number: orderNumber,
                provider,
                status: statusData.status,
                raw_status: statusData.raw_status,
                timestamp: new Date()
            });

            // Emit specific events based on status
            if (statusData.status === 'delivered') {
                this.emit('order_delivered', {
                    shop_id: shopId,
                    order_number: orderNumber,
                    provider,
                    timestamp: new Date()
                });
            }

            if (statusData.status.includes('cancelled') || statusData.status === 'returned') {
                this.emit('order_failed', {
                    shop_id: shopId,
                    order_number: orderNumber,
                    provider,
                    status: statusData.status,
                    timestamp: new Date()
                });
            }

            return statusData;
        } catch (error) {
            throw new Error(`Failed to update delivery status: ${error.message}`);
        }
    }

    /**
     * Calculate delivery price
     */
    async calculateDeliveryPrice(shopId, provider, pricePayload) {
        try {
            const providerInstance = await this.getProviderInstance(shopId, provider);
            
            if (typeof providerInstance.calculatePrice !== 'function') {
                return null; // Provider doesn't support price calculation
            }

            return await providerInstance.calculatePrice(pricePayload);
        } catch (error) {
            throw new Error(`Failed to calculate delivery price: ${error.message}`);
        }
    }
}

// Export singleton instance
module.exports = new DeliveryService();
