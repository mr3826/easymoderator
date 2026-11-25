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

const isPlainObject = (value) => (
    value !== null && typeof value === 'object' && !Array.isArray(value)
);

const serializeStore = (store) => {
    if (!store || typeof store !== 'object') return null;
    const safe = {};
    for (const key of ['store_id', 'id', 'store_name', 'name', 'address', 'phone', 'city_id', 'zone_id', 'area_id']) {
        if (store[key] !== undefined) safe[key] = store[key];
    }
    return safe;
};

/**
 * Interactive pickup errors carry a structured payload the merchant UI acts
 * on (candidate stores, confirmation preview, blockers, manual steps). The
 * global error serializer only whitelists details for a few legacy codes, so
 * these are answered directly instead of falling through to `next`.
 * DELIVERY_PROVIDER_MANUAL_PICKUP promises details.manual_step,
 * DELIVERY_PICKUP_STORE_CREATE_UNSUPPORTED promises
 * details.manual_step='CREATE_IN_PROVIDER_PORTAL', and
 * DELIVERY_PICKUP_SOURCE_REQUIRED mirrors DELIVERY_NOT_READY's details.missing
 * — all three must keep their details through the controller layer.
 */
const STRUCTURED_PICKUP_ERROR_CODES = new Set([
    'DELIVERY_PICKUP_AMBIGUOUS',
    'DELIVERY_PROVIDER_STORE_CONFIRMATION_REQUIRED',
    'PICKUP_LOCATION_DELETE_CONFIRMATION_REQUIRED',
    'DELIVERY_MUTATION_IN_PROGRESS',
    'DELIVERY_STORE_IDS_UNMATCHED',
    'DELIVERY_PROVIDER_MANUAL_PICKUP',
    'DELIVERY_PICKUP_STORE_CREATE_UNSUPPORTED',
    'DELIVERY_PICKUP_SOURCE_REQUIRED',
]);

const respondStructuredPickupError = (res, error) => {
    if (!error || typeof error.code !== 'string' || !STRUCTURED_PICKUP_ERROR_CODES.has(error.code)) return false;
    if (!Number.isInteger(error.status)) return false;
    res.status(error.status).json({
        success: false,
        message: error.message,
        code: error.code,
        details: error.details || {},
    });
    return true;
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
        'stores_synced_at',
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
    // Staleness of the stored provider store mapping against the last store
    // listing we actually cached. The cache is refreshed ONLY by the explicit
    // POST /:provider/stores/sync import (and the initial Pathao connect);
    // GET /:provider/stores is a pure read and never re-caches, so
    // 'confirmed'/'stale' mean agreement/disagreement with the last explicit
    // import — the age of that import is surfaced honestly as
    // pickup_stores_synced_at below. 'unknown' means we have no cached
    // listing to compare against — it is never reported as confirmed.
    const storesCache = Array.isArray(metadata.stores)
        ? metadata.stores.filter((store) => isPlainObject(store))
        : [];
    let pickup_mapping_status = null;
    if (providerStoreId !== null && providerStoreId !== undefined && providerStoreId !== '') {
        pickup_mapping_status = storesCache.length > 0
            ? (storesCache.some((store) => String(store.store_id ?? store.id ?? '') === String(providerStoreId))
                ? 'confirmed'
                : 'stale')
            : 'unknown';
    }
    return {
        pickup_enabled: integration?.pickup_enabled ?? metadata.pickup_enabled ?? false,
        pickup_location_id: integration?.pickup_location_id ?? metadata.pickup_location_id ?? null,
        pickup_store_id: providerStoreId,
        provider_store_id: providerStoreId,
        pickup_mapping_status,
        pickup_stores_synced_at: typeof metadata.stores_synced_at === 'string' ? metadata.stores_synced_at : null,
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
     * Provider pickup store listing and import.
     *
     * GET /:provider/stores and GET /:provider/stores/sync are PURE READS:
     * they fetch the provider listing through the same adapter/normalizer
     * path, return canonical store records, and persist NOTHING — no pickup
     * rows, no metadata, no integration.save, no stores_synced_at. The UI's
     * "Fetch stores" action must never silently import the whole catalog;
     * the response deliberately omits pickup_locations entirely.
     *
     * POST /:provider/stores/sync remains the explicit Import action with
     * today's full behavior: read the listing, upsert local pickup rows
     * (optionally filtered by store_ids), cache the listing +
     * stores_synced_at into integration metadata, and return the imported
     * stores with their pickup_locations. That cache is what
     * pickup_mapping_status staleness in GET /settings is computed against,
     * so staleness now reflects the last explicit sync — capability honesty
     * preserved via metadata.stores / pickup_stores_synced_at.
     *
     * Steadfast has no store API and stays a manual 409 with manual_step.
     */
    async getProviderStores(req, res, next) {
        try {
            const shopId = req.user.shopId;
            const { provider } = req.params;

            if (provider !== 'pathao' && provider !== 'redx') {
                if (provider === 'steadfast') {
                    throw new AppError(
                        'Steadfast does not list pickup stores. Configure a manual pickup location instead.',
                        409,
                        'DELIVERY_PROVIDER_MANUAL_PICKUP',
                        { provider, manual_step: 'CONFIGURE_PICKUP_MANUALLY' },
                    );
                }
                throw new AppError('Provider does not support store management', 400, 'DELIVERY_PROVIDER_UNSUPPORTED');
            }

            const integration = await DeliveryIntegration.findOne({
                where: {
                    shop_id: shopId,
                    provider
                }
            });

            if (!integration || !integration.is_connected) {
                throw new AppError(`${provider} is not connected`, 400, 'DELIVERY_PROVIDER_NOT_CONNECTED');
            }

            const isImport = req.method === 'POST';
            // The pure read asks the service to canonicalize the Pathao raw
            // listing into the same { store_id, id, name, address, phone,
            // city_id, zone_id, area_id } shape RedX's normalized envelope
            // returns. POST/sync keeps the raw token-recovered listing and
            // today's exact persistence path.
            const stores = await deliveryService.getProviderStores(shopId, provider, { canonical: !isImport });
            const safeStores = (Array.isArray(stores) ? stores : []).map(serializeStore).filter(Boolean);

            if (!isImport) {
                return res.json({
                    success: true,
                    data: {
                        provider,
                        stores: safeStores,
                        // Listing reads are mocked-tested only; no live provider
                        // account has been exercised for either provider here.
                        capability: 'IMPLEMENTED_NOT_LIVE_VERIFIED',
                    },
                });
            }

            // Selective import (POST /:provider/stores/sync with store_ids):
            // mirror only the named stores. An id the provider did not return
            // is a conflict the UI must surface, never a silent drop. An
            // absent/empty store_ids keeps the full-listing sync.
            let storesToSync = safeStores;
            const requestedIds = Array.isArray(req.body?.store_ids)
                ? req.body.store_ids
                : null;
            if (requestedIds && requestedIds.length > 0) {
                const normalizeStoreId = (value) => String(value ?? '').trim().toLowerCase();
                const available = new Map();
                for (const store of safeStores) {
                    const canonicalId = store.store_id ?? store.id;
                    if (canonicalId !== undefined && canonicalId !== null) {
                        available.set(normalizeStoreId(canonicalId), store);
                    }
                }
                const seen = new Set();
                const requested = [];
                for (const raw of requestedIds) {
                    const norm = normalizeStoreId(raw);
                    if (!norm || seen.has(norm)) continue;
                    seen.add(norm);
                    requested.push({ raw: String(raw).trim(), norm });
                }
                const unmatched = requested.filter((entry) => !available.has(entry.norm)).map((entry) => entry.raw);
                if (unmatched.length > 0) {
                    throw new AppError(
                        'Some requested store ids were not found at the provider',
                        409,
                        'DELIVERY_STORE_IDS_UNMATCHED',
                        { provider, unmatched_store_ids: unmatched },
                    );
                }
                storesToSync = requested.map((entry) => available.get(entry.norm));
            }

            let pickupLocations = [];
            try {
                pickupLocations = await pickupLocationService.syncProviderStores(shopId, provider, storesToSync);
            } catch (syncError) {
                throw new AppError('Provider stores were read but could not be synchronized', 503, 'DELIVERY_STORE_SYNC_FAILED', {
                    cause: syncError?.code || syncError?.name || 'unknown',
                });
            }

            // Cache the listing and the time it was read so the settings
            // payload can distinguish a stale mapping from an unverified
            // one. This import (and the Pathao connect) is now the ONLY
            // writer of this cache — GET store reads are pure and never
            // refresh it, so stores_synced_at is the last explicit sync.
            integration.metadata = {
                ...serializeProviderMetadata(integration.metadata),
                stores: safeStores,
                stores_synced_at: new Date().toISOString(),
            };
            await integration.save();

            res.json({
                success: true,
                data: {
                    provider,
                    stores: storesToSync,
                    pickup_locations: pickupLocations,
                    // Listing reads are mocked-tested only; no live provider
                    // account has been exercised for either provider here.
                    capability: 'IMPLEMENTED_NOT_LIVE_VERIFIED',
                }
            });
        } catch (error) {
            if (respondStructuredPickupError(res, error)) return;
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
            // DELIVERY_PICKUP_SOURCE_REQUIRED carries the same details.missing
            // contract as DELIVERY_NOT_READY; it must survive this layer
            // instead of losing details to the global serializer whitelist.
            if (respondStructuredPickupError(res, error)) return;
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
            if (respondStructuredPickupError(res, error)) return;
            next(error);
        }
    }

    /**
     * Merchant-confirmed external pickup store creation. Without confirm=true
     * this never touches the provider; it answers with the preview the UI
     * must show.
     */
    async createProviderPickupStore(req, res, next) {
        try {
            const provider = req.params.provider || req.body?.provider;
            const data = await deliveryService.createProviderPickupStore(
                req.user.shopId,
                provider,
                req.body || {},
            );
            res.status(201).json({ success: true, data });
        } catch (error) {
            if (respondStructuredPickupError(res, error)) return;
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
            const confirm = req.query?.confirm === true || req.query?.confirm === 'true'
                || req.body?.confirm === true;
            const data = await pickupLocationService.deletePickupLocation(
                req.user.shopId,
                req.params.locationId,
                { confirm },
            );
            res.json({ success: true, data });
        } catch (error) {
            if (respondStructuredPickupError(res, error)) return;
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
            const storeSelector = metadata?.store_id ?? metadata?.pickup_store_id ?? metadata?.provider_store_id;
            if (storeSelector !== undefined && String(storeSelector).trim() !== '') {
                // Closing the metadata bypass: enabling pickup through this
                // path must pass the same readiness gate /activate enforces
                // (activation itself is not required here).
                const readiness = await courierReadinessService.getReadiness(shopId, provider);
                const missing = (readiness?.missing || []).filter((item) => item !== 'provider_not_active');
                if (missing.length > 0) {
                    throw new AppError(
                        'Courier is not ready for activation',
                        409,
                        'DELIVERY_NOT_READY',
                        { provider, missing, reason: 'pickup_setup_incomplete' },
                    );
                }
                integration.pickup_store_id = String(storeSelector);
                integration.provider_store_id = String(storeSelector);
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
