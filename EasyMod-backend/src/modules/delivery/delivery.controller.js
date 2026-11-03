const DeliveryIntegration = require('./delivery-integration.entity');
const { COURIER_REGISTRY } = require('./providers/provider.registry');
const deliveryService = require('./delivery.service');
const { AppError } = require('../../utils/AppError');
const { Shop } = require('../entities');
const { mergeSettingsPreservingRtoConsent } = require('../shop/shop-settings.validator');
const { invalidateShopSettingsCaches } = require('../../utils/shop-settings-cache');
const pickupLocationService = require('./pickup-location.service');
const courierReadinessService = require('./courier-readiness.service');
const { getProviderCapabilities } = require('./provider-capabilities');

const DELIVERY_ZONES = ['inside_dhaka', 'sub_dhaka', 'outside_dhaka'];

const DEFAULT_DELIVERY_SETTINGS = {
    default_delivery_charge: 60,
    cod_enabled: false,
    cod_charge: 0,
    non_refundable: false,
    area_pricing: [
        { zone: 'inside_dhaka', charge: 60, cod_enabled: false },
        { zone: 'sub_dhaka', charge: 80, cod_enabled: false },
        { zone: 'outside_dhaka', charge: 120, cod_enabled: false }
    ],
    weight_tiers: []
};

const toNumber = (value, fallback) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
};

const normalizeAreaPricing = (areas) => {
    if (!Array.isArray(areas)) return [];

    return areas
        .map((entry) => ({
            zone: entry?.zone,
            charge: toNumber(entry?.charge, 0),
            cod_enabled: Boolean(entry?.cod_enabled)
        }))
        .filter((entry) => DELIVERY_ZONES.includes(entry.zone));
};

const normalizeWeightTiers = (tiers) => {
    if (!Array.isArray(tiers)) return [];

    return tiers
        .map((entry) => ({
            from_kg: toNumber(entry?.from_kg, 0),
            to_kg: toNumber(entry?.to_kg, 0),
            extra_charge: toNumber(entry?.extra_charge, 0)
        }))
        .filter((entry) => Number.isFinite(entry.from_kg) && Number.isFinite(entry.to_kg));
};

const applyDeliveryDefaults = (settings = {}) => {
    const normalizedAreas = normalizeAreaPricing(settings.area_pricing);
    const normalizedTiers = normalizeWeightTiers(settings.weight_tiers);

    return {
        default_delivery_charge: toNumber(settings.default_delivery_charge, DEFAULT_DELIVERY_SETTINGS.default_delivery_charge),
        cod_enabled: settings.cod_enabled ?? DEFAULT_DELIVERY_SETTINGS.cod_enabled,
        cod_charge: toNumber(settings.cod_charge, DEFAULT_DELIVERY_SETTINGS.cod_charge),
        non_refundable: settings.non_refundable ?? DEFAULT_DELIVERY_SETTINGS.non_refundable,
        area_pricing: normalizedAreas.length > 0 ? normalizedAreas : DEFAULT_DELIVERY_SETTINGS.area_pricing,
        weight_tiers: normalizedTiers.length > 0 ? normalizedTiers : DEFAULT_DELIVERY_SETTINGS.weight_tiers
    };
};

const serializeStore = (store) => {
    if (!store || typeof store !== 'object') return null;
    const safe = {};
    for (const key of ['store_id', 'store_name', 'city_id', 'zone_id', 'area_id']) {
        if (store[key] !== undefined) safe[key] = store[key];
    }
    return safe;
};

const serializeProviderMetadata = (metadata = {}) => {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return {};

    const safe = {};
    for (const key of [
        'store_id',
        'store_name',
        'pickup_store_id',
        'pickup_location_id',
        'pickup_enabled',
        'ai_default',
        'is_ai_default',
    ]) {
        if (metadata[key] !== undefined) safe[key] = metadata[key];
    }
    if (Array.isArray(metadata.stores)) {
        safe.stores = metadata.stores.map(serializeStore).filter(Boolean);
    }
    if (Number.isFinite(Number(metadata.balance))) {
        safe.balance = Number(metadata.balance);
    }
    return safe;
};

const serializeProviderValidation = (validation = {}) => {
    const source = validation && typeof validation === 'object' ? validation : {};
    const safe = { valid: source.valid === true };
    if (Array.isArray(source.stores)) {
        safe.stores = source.stores.map(serializeStore).filter(Boolean);
    }
    if (source.balance !== undefined && Number.isFinite(Number(source.balance))) {
        safe.balance = Number(source.balance);
    }
    if (!safe.valid && typeof source.error === 'string') {
        safe.error = source.error;
    }
    return safe;
};

const forwardSafeProviderError = (next, error, message) => {
    if (error instanceof AppError) return next(error);
    return next(new AppError(message, 502));
};

const pickDeliverySettings = (payload = {}) => {
    const allowed = [
        'default_delivery_charge',
        'cod_enabled',
        'cod_charge',
        'non_refundable',
        'area_pricing',
        'weight_tiers'
    ];

    return allowed.reduce((acc, key) => {
        if (payload[key] !== undefined) {
            acc[key] = payload[key];
        }
        return acc;
    }, {});
};

const providerIsAiDefault = (integration) => {
    const hasDatabaseFlag = integration
        && (Object.prototype.hasOwnProperty.call(integration, 'is_ai_default')
            || typeof integration.getDataValue === 'function');
    if (hasDatabaseFlag) return integration.is_ai_default === true;
    const metadata = integration?.metadata && typeof integration.metadata === 'object'
        ? integration.metadata
        : {};
    return [integration?.is_ai_default, metadata.is_ai_default, metadata.ai_default]
        .some((value) => value === true || value === 1 || value === 'true');
};

const providerPickupState = (integration) => {
    const metadata = integration?.metadata && typeof integration.metadata === 'object'
        ? integration.metadata
        : {};
    let providerMeta = integration?.provider_pickup_meta
        ?? (metadata.provider_pickup_meta && typeof metadata.provider_pickup_meta === 'object'
            ? metadata.provider_pickup_meta
            : {});
    if (typeof providerMeta === 'string') {
        try { providerMeta = JSON.parse(providerMeta); } catch (_) { providerMeta = {}; }
    }
    const providerStoreId = integration?.provider_store_id
        ?? integration?.pickup_store_id
        ?? metadata.pickup_store_id
        ?? providerMeta.pickup_store_id
        ?? metadata.store_id
        ?? null;
    return {
        pickup_enabled: integration?.pickup_enabled ?? metadata.pickup_enabled ?? false,
        pickup_location_id: integration?.pickup_location_id ?? metadata.pickup_location_id ?? null,
        pickup_store_id: providerStoreId,
        provider_store_id: providerStoreId,
        provider_pickup_meta: {
            ...providerMeta,
            ...['city_id', 'zone_id', 'area_id', 'delivery_area_id', 'pickup_store_id']
                .reduce((acc, key) => {
                    if (metadata[key] !== undefined) acc[key] = metadata[key];
                    return acc;
                }, {}),
        },
    };
};

const getActivationStatus = (integration, readiness) => {
    if (!integration || !integration.is_connected) return 'NOT_CONFIGURED';
    if (integration.activation_error && !integration.is_active) return 'ACTION_REQUIRED';
    if (integration.activation_status === 'VALIDATING') return 'VALIDATING';
    if (integration.is_active && (!readiness || readiness.ready)) return 'ACTIVE';
    if (integration.is_active && readiness && !readiness.ready) return 'ACTION_REQUIRED';
    if (typeof integration.activation_status === 'string'
        && integration.activation_status
        && !['ACTIVE', 'NOT_CONFIGURED'].includes(integration.activation_status)) {
        return integration.activation_status;
    }
    return 'SETUP_INCOMPLETE';
};

const setProviderActive = async (req, isActive, { enforceReadiness = false } = {}) => {
    const shopId = req.user.shopId;
    const provider = req.params.provider || req.body?.provider;
    const integration = await DeliveryIntegration.findOne({
        where: { shop_id: shopId, provider },
    });

    if (!integration) throw new AppError('Provider not found', 404, 'DELIVERY_PROVIDER_NOT_FOUND');
    if (!integration.is_connected) {
        throw new AppError('Provider must be connected before activation', 400, 'DELIVERY_PROVIDER_NOT_CONNECTED');
    }

            if (isActive && enforceReadiness) {
                const readiness = await courierReadinessService.getReadiness(shopId, provider);
        const missing = (readiness.missing || []).filter((item) => item !== 'provider_not_active');
        if (missing.length > 0) {
            integration.activation_status = 'ACTION_REQUIRED';
            integration.activation_error = 'Courier setup is incomplete';
            if (typeof integration.save === 'function') await integration.save();
            if (typeof deliveryService.persistIntegrationState === 'function') {
                await deliveryService.persistIntegrationState(integration, {
                    activation_status: integration.activation_status,
                    activation_error: integration.activation_error,
                });
            }
            throw new AppError(
                'Courier is not ready for activation',
                409,
                'DELIVERY_NOT_READY',
                { provider, missing, reason: 'pickup_profile_required' },
            );
        }
    }

    integration.is_active = isActive;
    integration.activation_status = isActive ? 'ACTIVE' : 'SETUP_INCOMPLETE';
    integration.activation_error = null;
    if (!isActive) {
        integration.metadata = {
            ...serializeProviderMetadata(integration.metadata),
            ai_default: false,
        };
        integration.is_ai_default = false;
    }
    await integration.save();
    if (typeof deliveryService.persistIntegrationState === 'function') {
        await deliveryService.persistIntegrationState(integration, {
            activation_status: integration.activation_status,
            activation_error: integration.activation_error,
            is_ai_default: integration.is_ai_default === true,
        });
    }
    return {
        provider: integration.provider,
        is_active: integration.is_active,
        activation_status: integration.activation_status,
        activation_error: integration.activation_error,
        is_ai_default: integration.is_ai_default === true,
    };
};

/**
 * Delivery Settings Controller
 */
class DeliveryController {
    /**
     * Get delivery settings for the shop
     */
    async getSettings(req, res, next) {
        try {
            const shopId = req.user.shopId;

            let integrations = await DeliveryIntegration.findAll({
                where: { shop_id: shopId },
                attributes: [
                    'id', 'provider', 'is_active', 'is_connected', 'is_sandbox', 'metadata',
                    'last_validated_at', 'created_at', 'pickup_location_id', 'provider_store_id',
                    'pickup_store_id', 'provider_pickup_meta', 'pickup_enabled', 'is_ai_default',
                    'activation_status', 'activation_error',
                ]
            });
            if (typeof deliveryService.enrichIntegrationState === 'function') {
                integrations = await deliveryService.enrichIntegrationState(shopId, integrations);
            }

            const shop = await Shop.findByPk(shopId, { attributes: ['id', 'settings'] });
            const deliverySettings = applyDeliveryDefaults(shop?.settings?.delivery || {});
            let pickupLocations = [];
            try {
                pickupLocations = await pickupLocationService.listPickupLocations(shopId);
            } catch (_) {
                // The additive table may not exist on an older local database;
                // provider settings remain readable until migrations complete.
            }

            const readinessByProvider = new Map(await Promise.all(
                Object.keys(COURIER_REGISTRY).map(async (providerName) => {
                    try {
                        return [providerName, await courierReadinessService.getReadiness(shopId, providerName)];
                    } catch (_) {
                        return [providerName, null];
                    }
                }),
            ));

            // Build provider list
            const providers = Object.keys(COURIER_REGISTRY).map(providerName => {
                const integration = integrations.find(i => i.provider === providerName);
                const providerMeta = COURIER_REGISTRY[providerName];
                const metadata = serializeProviderMetadata(integration?.metadata);
                const pickup = providerPickupState(integration);
                const readiness = readinessByProvider.get(providerName);
                const readinessMissing = Array.isArray(readiness?.missing)
                    ? readiness.missing.filter((missing) => missing !== 'provider_not_active')
                    : null;
                const pickupSummary = pickupLocations.find((location) => (
                    pickup.pickup_location_id && String(location.id) === String(pickup.pickup_location_id)
                )) || null;
                return {
                    provider: providerName,
                    display_name: `${providerMeta.label} Courier`,
                    is_connected: integration ? integration.is_connected : false,
                    is_active: integration ? integration.is_active : false,
                    is_sandbox: integration ? integration.is_sandbox === true : false,
                    metadata,
                    is_ai_default: providerIsAiDefault(integration),
                    ...pickup,
                    activation_status: getActivationStatus(integration, readiness),
                    activation_error: integration?.activation_error || null,
                    missing: readinessMissing
                        || (integration?.is_connected ? ['pickup_location'] : []),
                    setup_complete: Boolean(integration?.is_connected && readiness && readinessMissing
                        && readinessMissing.length === 0),
                    pickup_summary: pickupSummary,
                    // What this integration can actually do, capped at
                    // IMPLEMENTED_NOT_LIVE_VERIFIED. Served from one source so
                    // the settings screen cannot overstate a provider.
                    capabilities: getProviderCapabilities(providerName),
                    last_validated_at: integration ? integration.last_validated_at : null,
                    connected_at: integration ? integration.created_at : null
                };
            });

            res.json({
                success: true,
                data: {
                    providers,
                    settings: deliverySettings,
                    pickup_locations: pickupLocations,
                }
            });
        } catch (error) {
            next(error);
        }
    }

    /**
     * Update delivery settings for the shop
     */
    async updateSettings(req, res, next) {
        try {
            const shopId = req.user.shopId;
            const merged = await Shop.sequelize.transaction(async (transaction) => {
                const shop = await Shop.findByPk(shopId, { transaction, lock: transaction.LOCK?.UPDATE });
                if (!shop) throw new AppError('Shop not found', 404);

                const existingSettings = shop.settings || {};
                const existingDelivery = existingSettings.delivery || {};
                const incoming = pickDeliverySettings(req.body || {});
                const normalizedDelivery = applyDeliveryDefaults({
                    ...existingDelivery,
                    ...incoming,
                });
                const mergedSettings = mergeSettingsPreservingRtoConsent(existingSettings, {
                    delivery: {
                        ...existingDelivery,
                        ...normalizedDelivery,
                    },
                });

                await shop.update({ settings: mergedSettings }, { transaction });
                return mergedSettings.delivery;
            });
            await invalidateShopSettingsCaches(shopId);

            res.json({
                success: true,
                data: merged
            });
        } catch (error) {
            next(error);
        }
    }

    /**
     * Connect a delivery provider
     */
    async connectProvider(req, res, next) {
        try {
            const shopId = req.user.shopId;
            const { provider, credentials, is_sandbox = false, metadata = {} } = req.body;
            const isSandbox = is_sandbox === true;

            // Check if provider already exists
            let integration = await DeliveryIntegration.findOne({
                where: {
                    shop_id: shopId,
                    provider
                }
            });

            // Validate credentials with provider
            const providerMeta = COURIER_REGISTRY[provider];
            if (!providerMeta) {
                throw new AppError('Invalid provider', 400);
            }
            const ProviderClass = providerMeta.Provider;

            const providerInstance = new ProviderClass(credentials, isSandbox);
            const validation = await providerInstance.validateCredentials();
            const safeValidation = serializeProviderValidation(validation);

            if (!validation.valid) {
                return res.status(400).json({
                    success: false,
                    message: 'Credential validation failed',
                    error: 'Credential validation failed'
                });
            }

            // For Pathao, store the access and refresh tokens
            let finalCredentials = { ...credentials };
            if (provider === 'pathao' && validation.access_token) {
                finalCredentials.access_token = validation.access_token;
                finalCredentials.refresh_token = validation.refresh_token;
                if (validation.expires_at) finalCredentials.expires_at = validation.expires_at;
                if (validation.access_token_expires_at) {
                    finalCredentials.access_token_expires_at = validation.access_token_expires_at;
                }
            }

            // Update provider metadata if available
            let finalMetadata = serializeProviderMetadata({
                ...(integration ? serializeProviderMetadata(integration.metadata) : {}),
                ...metadata,
            });
            if (provider === 'pathao' && safeValidation.stores) {
                finalMetadata.stores = safeValidation.stores;
                // Set default store if only one exists
                if (safeValidation.stores.length === 1) {
                    finalMetadata.store_id = safeValidation.stores[0].store_id;
                }
            }
            if (provider === 'steadfast' && safeValidation.balance !== undefined) {
                finalMetadata.balance = safeValidation.balance;
            }

            if (integration) {
                // Update existing integration
                integration.credentials = finalCredentials;
                integration.is_connected = true;
                integration.is_sandbox = isSandbox;
                integration.metadata = finalMetadata;
                integration.last_validated_at = new Date();
                await integration.save();
            } else {
                // Create new integration
                integration = await DeliveryIntegration.create({
                    shop_id: shopId,
                    provider,
                    credentials: finalCredentials,
                    is_connected: true,
                    is_active: false, // Merchant needs to activate it
                    is_sandbox: isSandbox,
                    metadata: finalMetadata,
                    last_validated_at: new Date()
                });
            }

            integration.activation_status = integration.is_active ? 'ACTIVE' : 'SETUP_INCOMPLETE';
            integration.activation_error = null;
            if (typeof deliveryService.persistIntegrationState === 'function') {
                await deliveryService.persistIntegrationState(integration, {
                    activation_status: integration.activation_status,
                    activation_error: null,
                });
            }

            res.json({
                success: true,
                message: `${providerMeta.label} connected successfully`,
                data: {
                    provider: integration.provider,
                    is_connected: integration.is_connected,
                    is_active: integration.is_active,
                    is_sandbox: integration.is_sandbox === true,
                    metadata: serializeProviderMetadata(integration.metadata)
                }
            });
        } catch (error) {
            forwardSafeProviderError(next, error, 'Delivery provider connection failed');
        }
    }

    /**
     * Disconnect a delivery provider
     */
    async disconnectProvider(req, res, next) {
        try {
            const shopId = req.user.shopId;
            const userId = req.userId;
            const { provider } = req.body;

            const integration = await DeliveryIntegration.findOne({
                where: {
                    shop_id: shopId,
                    provider
                }
            });

            if (!integration) {
                throw new AppError('Provider not found', 404);
            }

            // Deactivate and disconnect
            integration.is_active = false;
            integration.is_connected = false;
            integration.metadata = {
                ...serializeProviderMetadata(integration.metadata),
                ai_default: false,
                pickup_enabled: false,
            };
            integration.is_ai_default = false;
            integration.activation_status = 'NOT_CONFIGURED';
            integration.activation_error = null;
            await integration.save();
            if (typeof deliveryService.persistIntegrationState === 'function') {
                await deliveryService.persistIntegrationState(integration, {
                    is_ai_default: false,
                    pickup_enabled: false,
                    activation_status: 'NOT_CONFIGURED',
                    activation_error: null,
                });
            }

            res.json({
                success: true,
                message: `${COURIER_REGISTRY[provider]?.label || provider} disconnected successfully`
            });
        } catch (error) {
            next(error);
        }
    }

    /**
     * Toggle provider active status
     */
    async toggleProvider(req, res, next) {
        try {
            const isActive = req.body.is_active ?? req.body.isActive;
            if (typeof isActive !== 'boolean') {
                throw new AppError('is_active must be a boolean', 400, 'VALIDATION_ERROR');
            }
            const data = await setProviderActive(req, isActive, { enforceReadiness: isActive });

            res.json({
                success: true,
                message: `Provider ${isActive ? 'activated' : 'deactivated'} successfully`,
                data
            });
        } catch (error) {
            next(error);
        }
    }

    /** Explicit activation route; /toggle remains a compatibility alias. */
    async activateProvider(req, res, next) {
        try {
            const data = await setProviderActive(req, true, { enforceReadiness: true });
            res.json({ success: true, message: 'Provider activated successfully', data });
        } catch (error) {
            next(error);
        }
    }

    /** Explicit deactivation route; /toggle remains a compatibility alias. */
    async deactivateProvider(req, res, next) {
        try {
            const data = await setProviderActive(req, false);
            res.json({ success: true, message: 'Provider deactivated successfully', data });
        } catch (error) {
            next(error);
        }
    }

    /**
     * Test provider connection
     */
    async testConnection(req, res, next) {
        try {
            const shopId = req.user.shopId;
            const { provider } = req.body;

            const integration = await DeliveryIntegration.findOne({
                where: {
                    shop_id: shopId,
                    provider
                }
            });

            if (!integration || !integration.is_connected) {
                throw new AppError('Provider not connected', 400);
            }

            const providerMeta = COURIER_REGISTRY[provider];
            if (!providerMeta) {
                throw new AppError('Invalid provider', 400);
            }
            const ProviderClass = providerMeta.Provider;

            const providerInstance = new ProviderClass(
                integration.credentials,
                integration.is_sandbox === true
            );
            const validation = await providerInstance.validateCredentials();
            const safeValidation = serializeProviderValidation(validation);

            if (!validation.valid) {
                return res.status(400).json({
                    success: false,
                    message: 'Connection test failed',
                    error: 'Connection test failed'
                });
            }

            // Update last validated time
            integration.last_validated_at = new Date();
            await integration.save();

            res.json({
                success: true,
                message: 'Connection test successful',
                data: safeValidation
            });
        } catch (error) {
            forwardSafeProviderError(next, error, 'Delivery provider test failed');
        }
    }

    /**
     * Get provider stores (Pathao only)
     */
    async getProviderStores(req, res, next) {
        try {
            const shopId = req.user.shopId;
            const { provider } = req.params;

            if (provider !== 'pathao') {
                throw new AppError('Only Pathao supports store management', 400);
            }

            const integration = await DeliveryIntegration.findOne({
                where: {
                    shop_id: shopId,
                    provider: 'pathao'
                }
            });

            if (!integration || !integration.is_connected) {
                throw new AppError('Pathao not connected', 400);
            }

            const stores = await deliveryService.getProviderStores(shopId, 'pathao');
            const safeStores = (Array.isArray(stores) ? stores : []).map(serializeStore).filter(Boolean);

            let pickupLocations = [];
            try {
                pickupLocations = await pickupLocationService.syncProviderStores(shopId, 'pathao', safeStores);
            } catch (syncError) {
                throw new AppError('Provider stores were read but could not be synchronized', 503, 'DELIVERY_STORE_SYNC_FAILED', {
                    cause: syncError?.code || syncError?.name || 'unknown',
                });
            }

            // Update metadata with latest stores
            integration.metadata = {
                ...serializeProviderMetadata(integration.metadata),
                stores: safeStores
            };
            await integration.save();

            res.json({
                success: true,
                data: {
                    stores: safeStores,
                    pickup_locations: pickupLocations,
                }
            });
        } catch (error) {
            forwardSafeProviderError(next, error, 'Delivery provider store lookup failed');
        }
    }

    /** Return readiness without exposing credentials or provider payloads. */
    async getProviderReadiness(req, res, next) {
        try {
            const readiness = await courierReadinessService.getReadiness(
                req.user.shopId,
                req.params.provider || null,
            );
            res.json({ success: true, data: readiness });
        } catch (error) {
            next(error);
        }
    }

    /** Return the currently selected AI/default courier, if any. */
    async getAiDefaultProvider(req, res, next) {
        try {
            const selected = await deliveryService.getAiDefaultProvider(req.user.shopId);
            res.json({
                success: true,
                data: selected
                    ? {
                        provider: selected.provider,
                        metadata: serializeProviderMetadata(selected.metadata),
                    }
                    : null,
            });
        } catch (error) {
            next(error);
        }
    }

    /** Set or clear the provider used by AI courier actions. */
    async setAiDefaultProvider(req, res, next) {
        try {
            const provider = req.params.provider || req.body?.provider;
            const enabled = req.body?.enabled
                ?? req.body?.is_ai_default
                ?? req.body?.is_default
                ?? true;
            const data = await deliveryService.setAiDefaultProvider(req.user.shopId, provider, enabled);
            res.json({ success: true, data });
        } catch (error) {
            next(error);
        }
    }

    async clearAiDefaultProvider(req, res, next) {
        try {
            const provider = req.params.provider || req.body?.provider;
            const data = await deliveryService.setAiDefaultProvider(req.user.shopId, provider, false);
            res.json({ success: true, data });
        } catch (error) {
            next(error);
        }
    }

    /** Select a local pickup location or provider store for an integration. */
    async setPickupConfiguration(req, res, next) {
        try {
            const provider = req.params.provider || req.body?.provider;
            const data = await deliveryService.setPickupConfiguration(
                req.user.shopId,
                provider,
                req.body || {},
            );
            res.json({ success: true, data });
        } catch (error) {
            next(error);
        }
    }

    async syncProviderPickup(req, res, next) {
        try {
            const provider = req.params.provider || req.body?.provider;
            const data = await deliveryService.syncProviderPickup(
                req.user.shopId,
                provider,
                req.body || {},
            );
            res.json({ success: true, data });
        } catch (error) {
            next(error);
        }
    }

    async listPickupLocations(req, res, next) {
        try {
            const includeInactive = req.query.include_inactive === 'true'
                || req.query.includeInactive === 'true';
            const data = await pickupLocationService.listPickupLocations(req.user.shopId, { includeInactive });
            res.json({ success: true, data });
        } catch (error) {
            next(error);
        }
    }

    async getPickupLocation(req, res, next) {
        try {
            const data = await pickupLocationService.getPickupLocation(req.user.shopId, req.params.locationId);
            res.json({ success: true, data: pickupLocationService.serializePickupLocation(data) });
        } catch (error) {
            next(error);
        }
    }

    async createPickupLocation(req, res, next) {
        try {
            const data = await pickupLocationService.createPickupLocation(req.user.shopId, req.body || {});
            res.status(201).json({ success: true, data });
        } catch (error) {
            next(error);
        }
    }

    async updatePickupLocation(req, res, next) {
        try {
            const data = await pickupLocationService.updatePickupLocation(
                req.user.shopId,
                req.params.locationId || req.body?.id,
                req.body || {},
            );
            res.json({ success: true, data });
        } catch (error) {
            next(error);
        }
    }

    async deletePickupLocation(req, res, next) {
        try {
            const data = await pickupLocationService.deletePickupLocation(req.user.shopId, req.params.locationId);
            res.json({ success: true, data });
        } catch (error) {
            next(error);
        }
    }

    async setDefaultPickupLocation(req, res, next) {
        try {
            const data = await pickupLocationService.setDefaultPickupLocation(
                req.user.shopId,
                req.params.locationId,
            );
            res.json({ success: true, data });
        } catch (error) {
            next(error);
        }
    }

    async getProviderCities(req, res, next) {
        try {
            const data = await deliveryService.getProviderAreas(req.user.shopId, req.params.provider);
            res.json({ success: true, data });
        } catch (error) {
            next(error);
        }
    }

    async getProviderZones(req, res, next) {
        try {
            const cityId = req.params.cityId ?? req.query.city_id ?? req.query.cityId;
            if (cityId === undefined || !/^\d+$/.test(String(cityId))) {
                throw new AppError('city_id must be a non-negative integer', 400, 'VALIDATION_ERROR');
            }
            const data = await deliveryService.getProviderAreas(req.user.shopId, req.params.provider, { cityId: Number(cityId) });
            res.json({ success: true, data });
        } catch (error) {
            next(error);
        }
    }

    async getProviderAreas(req, res, next) {
        try {
            const zoneId = req.params.zoneId ?? req.query.zone_id ?? req.query.zoneId;
            if (zoneId === undefined) {
                const data = await deliveryService.getProviderAreas(req.user.shopId, req.params.provider);
                res.json({ success: true, data });
                return;
            }
            if (!/^\d+$/.test(String(zoneId))) {
                throw new AppError('zone_id must be a non-negative integer', 400, 'VALIDATION_ERROR');
            }
            const data = await deliveryService.getProviderAreas(req.user.shopId, req.params.provider, { zoneId: Number(zoneId) });
            res.json({ success: true, data });
        } catch (error) {
            next(error);
        }
    }

    /**
     * Update provider metadata (e.g., selected store)
     */
    async updateMetadata(req, res, next) {
        try {
            const shopId = req.user.shopId;
            const { provider } = req.params;
            const { metadata } = req.body;

            const integration = await DeliveryIntegration.findOne({
                where: {
                    shop_id: shopId,
                    provider
                }
            });

            if (!integration) {
                throw new AppError('Provider not found', 404);
            }

            integration.metadata = serializeProviderMetadata({
                ...integration.metadata,
                ...metadata
            });
            if (metadata?.store_id !== undefined) {
                integration.pickup_store_id = String(metadata.store_id);
                integration.pickup_enabled = true;
            }
            await integration.save();

            res.json({
                success: true,
                message: 'Metadata updated successfully',
                data: {
                    metadata: serializeProviderMetadata(integration.metadata)
                }
            });
        } catch (error) {
            next(error);
        }
    }
}

module.exports = new DeliveryController();
