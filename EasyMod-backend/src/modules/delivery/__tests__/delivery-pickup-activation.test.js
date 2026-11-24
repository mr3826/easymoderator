'use strict';

const path = require('path');

const pickupMigration = require(path.join(
    __dirname,
    '../../../database/migrations/20260828_001_shop_pickup_locations.js',
));
const integrationMigration = require(path.join(
    __dirname,
    '../../../database/migrations/20260828_002_delivery_integrations_pickup_and_ai_default.js',
));
const ShopPickupLocation = require('../shop-pickup-location.entity');
const pickupLocationService = require('../pickup-location.service');

describe('pickup migration contracts', () => {
    test('creates and reverses the pickup table and indexes', async () => {
        const queries = [];
        const sequelize = {
            getDialect: () => 'postgres',
            query: async (sql) => queries.push(sql),
        };

        expect(pickupMigration.name).toBe('20260828_001_shop_pickup_locations');
        await pickupMigration.up(sequelize);
        await pickupMigration.down(sequelize);

        const sql = queries.join('\n');
        expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS shop_pickup_locations/i);
        expect(sql).toMatch(/display_name/i);
        expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS idx_shop_pickup_locations_one_default/i);
        expect(sql).toMatch(/DROP TABLE IF EXISTS shop_pickup_locations CASCADE/i);
    });

    test('SQLite integration columns are added once and dropped once', async () => {
        let columns = [{ name: 'id' }];
        const queries = [];
        const sequelize = {
            getDialect: () => 'sqlite',
            query: async (sql) => {
                queries.push(sql);
                if (sql.includes('PRAGMA table_info')) return [columns];
                const add = sql.match(/ADD COLUMN\s+([a-z_]+)/i);
                if (add && !columns.some((column) => column.name === add[1])) columns.push({ name: add[1] });
                const drop = sql.match(/DROP COLUMN\s+([a-z_]+)/i);
                if (drop) columns = columns.filter((column) => column.name !== drop[1]);
                return [];
            },
        };

        expect(integrationMigration.name).toBe('20260828_002_delivery_integrations_pickup_and_ai_default');
        await integrationMigration.up(sequelize);
        await integrationMigration.up(sequelize);
        expect(columns.filter((column) => column.name === 'is_ai_default')).toHaveLength(1);
        expect(columns.filter((column) => column.name === 'pickup_location_id')).toHaveLength(1);
        expect(queries.filter((sql) => /ADD COLUMN/i.test(sql))).toHaveLength(8);

        await integrationMigration.down(sequelize);
        await integrationMigration.down(sequelize);
        expect(columns.some((column) => column.name === 'is_ai_default')).toBe(false);
        expect(columns.some((column) => column.name === 'provider_pickup_meta')).toBe(false);
        expect(queries.filter((sql) => /DROP COLUMN/i.test(sql))).toHaveLength(8);
    });

    test('Postgres enforces active AI defaults and backfills the previous provider choice', async () => {
        const queries = [];
        const sequelize = {
            getDialect: () => 'postgres',
            query: async (sql) => {
                queries.push(sql);
                if (/SELECT id, settings FROM shops/i.test(sql)) {
                    return [[{ id: 'shop-1', settings: { delivery_platform_priority: ['pathao'] } }]];
                }
                return [];
            },
        };

        await integrationMigration.up(sequelize);

        const sql = queries.join('\n');
        expect(sql).toMatch(/SELECT id, settings FROM shops/i);
        expect(sql).toMatch(/UPDATE delivery_integrations[\s\S]*is_ai_default = TRUE[\s\S]*NOT EXISTS/i);
        expect(sql).toMatch(/CHECK\s*\(\s*NOT is_ai_default OR \(is_active AND is_connected\)\s*\)/i);
        expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS idx_delivery_integrations_one_ai_default[\s\S]*WHERE is_ai_default = TRUE/i);
    });
});

describe('ShopPickupLocation contracts', () => {
    test('models the required merchant pickup profile fields', () => {
        expect(ShopPickupLocation.rawAttributes.display_name.allowNull).toBe(false);
        expect(ShopPickupLocation.rawAttributes.address.allowNull).toBe(false);
        expect(ShopPickupLocation.rawAttributes.area_name.allowNull).toBe(false);
        expect(ShopPickupLocation.rawAttributes.is_default.defaultValue).toBe(false);
    });

    test('normalizes the public pickup payload and strips secret-shaped metadata', () => {
        const values = pickupLocationService.normalizeLocationInput({
            display_name: '  Main pickup  ',
            contact_name: 'Owner',
            phone: '01700000000',
            address: 'House 1, Dhaka',
            area_name: 'Dhanmondi',
            metadata: { city_id: 1, api_key: 'must-not-persist' },
        });

        expect(values).toMatchObject({
            display_name: 'Main pickup',
            contact_name: 'Owner',
            phone: '01700000000',
            area_name: 'Dhanmondi',
        });
        expect(values.metadata).toEqual({ city_id: 1 });
        expect(values.name).toBe('Main pickup');
    });

    test('serializes only shop-scoped pickup fields', () => {
        const serialized = pickupLocationService.serializePickupLocation({
            dataValues: {
                id: 'pickup-1',
                shop_id: 'shop-1',
                display_name: 'Main pickup',
                phone: '01700000000',
                address: 'Dhaka',
                area_name: 'Dhanmondi',
                metadata: { token: 'secret', visible: true },
            },
        });

        expect(serialized).toMatchObject({
            id: 'pickup-1',
            shop_id: 'shop-1',
            display_name: 'Main pickup',
            area_name: 'Dhanmondi',
        });
        expect(serialized.metadata).toEqual({ visible: true });
        expect(JSON.stringify(serialized)).not.toContain('secret');
    });
});

describe('Pathao token lifecycle', () => {
    test('refreshes once after a provider 401 and retries the same operation', async () => {
        await jest.isolateModulesAsync(async () => {
            const cacheRedis = {
                status: 'ready',
                set: jest.fn().mockResolvedValue('OK'),
                del: jest.fn().mockResolvedValue(1),
            };
            const integrationModel = { findOne: jest.fn() };
            let storeCalls = 0;

            class FakePathaoProvider {
                constructor(credentials, isSandbox) {
                    this.credentials = credentials;
                    this.isSandbox = isSandbox;
                }

                async refreshAccessToken() {
                    return {
                        access_token: 'new-access-token',
                        refresh_token: 'new-refresh-token',
                        expires_in: 3600,
                    };
                }

                async issueToken() {
                    return {
                        access_token: 'issued-access-token',
                        refresh_token: 'issued-refresh-token',
                        expires_in: 3600,
                    };
                }

                async getStores() {
                    storeCalls += 1;
                    if (storeCalls === 1) throw Object.assign(new Error('Unauthorized'), { response: { status: 401 } });
                    return [{ store_id: 'store-1', store_name: 'Main' }];
                }
            }

            jest.doMock('../../../config/redis', () => ({ cacheRedis }));
            jest.doMock('../delivery-integration.entity', () => ({}));
            jest.doMock('../providers/pathao.provider', () => FakePathaoProvider);

            const service = require('../pathao-token.service');
            const integration = {
                id: 'integration-1',
                is_sandbox: true,
                credentials: {
                    client_id: 'client',
                    client_secret: 'secret',
                    username: 'owner@example.com',
                    password: 'password',
                    access_token: 'old-access-token',
                    refresh_token: 'old-refresh-token',
                },
                save: jest.fn().mockResolvedValue(true),
            };

            const provider = await service.createProvider('shop-1', integration, FakePathaoProvider);
            await expect(provider.getStores()).resolves.toEqual([{ store_id: 'store-1', store_name: 'Main' }]);
            expect(integration.credentials.access_token).toBe('new-access-token');
            expect(integration.credentials.refresh_token).toBe('new-refresh-token');
            expect(integration.save).toHaveBeenCalledTimes(1);
            expect(cacheRedis.set).toHaveBeenCalledTimes(1);
            expect(new FakePathaoProvider(integration.credentials, true).isSandbox).toBe(true);
        });
    });

    test('a stale owner cannot release a newer live Redis token lock', async () => {
        await jest.isolateModulesAsync(async () => {
            const values = new Map();
            const cacheRedis = {
                status: 'ready',
                set: jest.fn(),
                eval: jest.fn(async (_script, _keyCount, key, lockValue) => {
                    if (values.get(key) !== lockValue) return 0;
                    values.delete(key);
                    return 1;
                }),
            };

            jest.doMock('../../../config/redis', () => ({ cacheRedis }));
            jest.doMock('../delivery-integration.entity', () => ({}));
            jest.doMock('../providers/pathao.provider', () => class FakePathaoProvider {});

            const service = require('../pathao-token.service');
            const key = service._private.tokenLockKey('shop-stale-lock');
            values.set(key, 'new-owner');

            await service._private.releaseLock('shop-stale-lock', 'stale-owner');

            expect(values.get(key)).toBe('new-owner');
            expect(cacheRedis.eval).toHaveBeenCalledWith(
                expect.stringContaining('redis.call("get", KEYS[1]) == ARGV[1]'),
                1,
                key,
                'stale-owner',
            );
        });
    });

    test('uses one Redis-guarded token issue for concurrent callers', async () => {
        await jest.isolateModulesAsync(async () => {
            const cacheRedis = {
                status: 'ready',
                set: jest.fn().mockResolvedValue('OK'),
                del: jest.fn().mockResolvedValue(1),
            };
            let issueCalls = 0;

            class FakePathaoProvider {
                constructor(credentials) {
                    this.credentials = credentials;
                }

                async issueToken() {
                    issueCalls += 1;
                    await new Promise((resolve) => setTimeout(resolve, 5));
                    return { access_token: 'issued-token', refresh_token: 'refresh-token', expires_in: 3600 };
                }
            }

            jest.doMock('../../../config/redis', () => ({ cacheRedis }));
            jest.doMock('../delivery-integration.entity', () => ({}));
            jest.doMock('../providers/pathao.provider', () => FakePathaoProvider);

            const service = require('../pathao-token.service');
            const integration = {
                id: 'integration-2',
                credentials: { client_id: 'client', client_secret: 'secret', username: 'owner@example.com', password: 'password' },
                save: jest.fn().mockResolvedValue(true),
            };

            await Promise.all([
                service.createProvider('shop-2', integration, FakePathaoProvider),
                service.createProvider('shop-2', integration, FakePathaoProvider),
            ]);
            expect(issueCalls).toBe(1);
            expect(cacheRedis.set).toHaveBeenCalledTimes(1);
            expect(integration.save).toHaveBeenCalledTimes(1);
        });
    });
});

describe('courier readiness and pickup sync contracts', () => {
    test('does not allow shop A to use shop B pickup location or provider store', async () => {
        await jest.isolateModulesAsync(async () => {
            const integration = {
                provider: 'pathao',
                is_connected: true,
                is_active: true,
                credentials: {
                    client_id: 'client',
                    client_secret: 'client-secret',
                    username: 'owner@example.com',
                    password: 'password',
                },
                pickup_location_id: 'pickup-shop-b',
                pickup_store_id: 'store-shop-b',
                provider_store_id: 'store-shop-b',
                pickup_enabled: true,
                provider_pickup_meta: { city_id: 1, zone_id: 2, area_id: 3 },
            };
            const DeliveryIntegration = {
                findOne: jest.fn().mockResolvedValue(integration),
            };
            const ShopPickupLocation = {
                findAll: jest.fn().mockResolvedValue([{
                    id: 'pickup-shop-a',
                    shop_id: 'shop-a',
                    provider: 'pathao',
                    provider_store_id: 'store-shop-a',
                    is_active: true,
                    is_default: true,
                }]),
            };

            jest.doMock('../../entities', () => ({ DeliveryIntegration, ShopPickupLocation }));
            jest.doMock('../pickup-location.service', () => ({
                serializePickupLocation: jest.fn((location) => location),
            }));

            const readinessService = require('../courier-readiness.service');
            const readiness = await readinessService.getReadiness('shop-a', 'pathao');

            expect(ShopPickupLocation.findAll).toHaveBeenCalledWith({
                where: { shop_id: 'shop-a', is_active: true },
                order: [['is_default', 'DESC'], ['created_at', 'ASC'], ['id', 'ASC']],
            });
            expect(readiness.ready).toBe(false);
            expect(readiness.missing).toContain('pickup_location_not_configured');

            integration.pickup_location_id = null;
            const rawStoreReadiness = await readinessService.getReadiness('shop-a', 'pathao');

            expect(rawStoreReadiness.ready).toBe(false);
            expect(rawStoreReadiness.missing).toContain('provider_store_not_synced');
            expect(rawStoreReadiness.missing).toContain('pickup_location_not_configured');
        });
    });

    test('keeps the local pickup selection when provider store sync fails', async () => {
        await jest.isolateModulesAsync(async () => {
            const provider = {
                getStores: jest.fn().mockRejectedValue(new Error('Pathao store lookup failed')),
            };
            const integration = {
                id: 'integration-1',
                provider: 'pathao',
                is_connected: true,
                is_active: false,
                pickup_location_id: 'pickup-1',
                pickup_store_id: null,
                provider_store_id: null,
                pickup_enabled: true,
                metadata: { pickup_location_id: 'pickup-1' },
                save: jest.fn().mockResolvedValue(true),
            };
            const DeliveryIntegration = {
                findOne: jest.fn().mockResolvedValue(integration),
                sequelize: { query: jest.fn().mockResolvedValue([]) },
            };
            const pickupLocationService = {
                getPickupLocation: jest.fn().mockResolvedValue({
                    id: 'pickup-1',
                    shop_id: 'shop-1',
                    provider: 'manual',
                    display_name: 'Main pickup',
                    address: 'Dhaka',
                    area_name: 'Dhanmondi',
                }),
                serializePickupLocation: jest.fn((location) => location),
            };

            jest.doMock('../delivery-integration.entity', () => DeliveryIntegration);
            jest.doMock('../../entities', () => ({
                DeliveryIntegration,
                ShopPickupLocation: {},
            }));
            jest.doMock('../pickup-location.service', () => pickupLocationService);
            jest.doMock('../pathao-token.service', () => ({
                createProvider: jest.fn().mockResolvedValue(provider),
            }));
            jest.doMock('../providers/provider.registry', () => ({
                COURIER_REGISTRY: { pathao: { Provider: class FakePathaoProvider {} } },
            }));

            const deliveryService = require('../delivery.service');

            await expect(deliveryService.syncProviderPickup('shop-1', 'pathao', {
                pickup_location_id: 'pickup-1',
            })).rejects.toThrow('Pathao store lookup failed');
            expect(pickupLocationService.getPickupLocation).toHaveBeenCalledWith('shop-1', 'pickup-1');
            expect(integration.pickup_location_id).toBe('pickup-1');
            expect(integration.save).not.toHaveBeenCalled();
        });
    });

    test('reuses the single matching provider store for the selected pickup', async () => {
        await jest.isolateModulesAsync(async () => {
            const provider = {
                getStores: jest.fn().mockResolvedValue([
                    { store_id: 'store-other', city_id: 9, zone_id: 9, area_id: 9 },
                    { store_id: 'store-selected', city_id: 1, zone_id: 2, area_id: 3 },
                ]),
                createStore: jest.fn(),
            };
            const integration = {
                id: 'integration-match',
                provider: 'pathao',
                is_connected: true,
                is_active: false,
                pickup_location_id: 'pickup-new',
                provider_store_id: 'store-old',
                pickup_store_id: 'store-old',
                pickup_enabled: true,
                metadata: { provider_store_id: 'store-old' },
                save: jest.fn().mockResolvedValue(true),
            };
            const DeliveryIntegration = {
                findOne: jest.fn().mockResolvedValue(integration),
                sequelize: { query: jest.fn().mockResolvedValue([]) },
            };
            const pickupLocationService = {
                getPickupLocation: jest.fn().mockResolvedValue({
                    id: 'pickup-new',
                    shop_id: 'shop-1',
                    provider: 'manual',
                    provider_store_id: null,
                    display_name: 'New pickup',
                    contact_name: 'Owner',
                    phone: '01700000000',
                    address: 'House 1, Dhaka',
                    area_name: 'Dhanmondi',
                    city_id: 1,
                    zone_id: 2,
                    area_id: 3,
                }),
                serializePickupLocation: jest.fn((location) => location),
            };

            jest.doMock('../delivery-integration.entity', () => DeliveryIntegration);
            jest.doMock('../../entities', () => ({ DeliveryIntegration, ShopPickupLocation: {} }));
            jest.doMock('../pickup-location.service', () => pickupLocationService);
            jest.doMock('../pathao-token.service', () => ({ createProvider: jest.fn().mockResolvedValue(provider) }));
            jest.doMock('../providers/provider.registry', () => ({
                COURIER_REGISTRY: { pathao: { Provider: class FakePathaoProvider {} } },
            }));

            const deliveryService = require('../delivery.service');
            const result = await deliveryService.syncProviderPickup('shop-1', 'pathao', {
                pickup_location_id: 'pickup-new',
                provider_pickup_meta: { city_id: 1, zone_id: 2, area_id: 3 },
            });

            expect(provider.getStores).toHaveBeenCalledTimes(1);
            expect(provider.createStore).not.toHaveBeenCalled();
            expect(integration.provider_store_id).toBe('store-selected');
            expect(result.store_resolution).toBe('MATCHED');
        });
    });

    test('requires explicit selection and returns candidates when multiple stores match', async () => {
        await jest.isolateModulesAsync(async () => {
            const provider = {
                getStores: jest.fn().mockResolvedValue([
                    { store_id: 'store-a', store_name: 'Warehouse A', city_id: 1, zone_id: 2, area_id: 3 },
                    { store_id: 'store-b', store_name: 'Warehouse B', city_id: 1, zone_id: 2, area_id: 3 },
                    { store_id: 'store-c', store_name: 'Elsewhere', city_id: 7, zone_id: 8, area_id: 9 },
                ]),
                createStore: jest.fn(),
            };
            const integration = {
                id: 'integration-ambiguous',
                provider: 'pathao',
                is_connected: true,
                is_active: false,
                pickup_location_id: null,
                provider_store_id: null,
                pickup_store_id: null,
                pickup_enabled: false,
                metadata: {},
                save: jest.fn().mockResolvedValue(true),
            };
            const DeliveryIntegration = {
                findOne: jest.fn().mockResolvedValue(integration),
                sequelize: { query: jest.fn().mockResolvedValue([]) },
            };
            const pickupLocationService = {
                getPickupLocation: jest.fn().mockResolvedValue({
                    id: 'pickup-amb',
                    shop_id: 'shop-1',
                    provider: 'manual',
                    provider_store_id: null,
                    display_name: 'Shared-area pickup',
                    address: 'House 2, Dhaka',
                    area_name: 'Dhanmondi',
                    city_id: 1,
                    zone_id: 2,
                    area_id: 3,
                }),
                serializePickupLocation: jest.fn((location) => location),
            };

            jest.doMock('../delivery-integration.entity', () => DeliveryIntegration);
            jest.doMock('../../entities', () => ({ DeliveryIntegration, ShopPickupLocation: {} }));
            jest.doMock('../pickup-location.service', () => pickupLocationService);
            jest.doMock('../pathao-token.service', () => ({ createProvider: jest.fn().mockResolvedValue(provider) }));
            jest.doMock('../providers/provider.registry', () => ({
                COURIER_REGISTRY: { pathao: { Provider: class FakePathaoProvider {} } },
            }));

            const deliveryService = require('../delivery.service');
            let captured;
            try {
                await deliveryService.syncProviderPickup('shop-1', 'pathao', {
                    pickup_location_id: 'pickup-amb',
                    provider_pickup_meta: { city_id: 1, zone_id: 2, area_id: 3 },
                });
            } catch (error) {
                captured = error;
            }

            expect(captured).toMatchObject({
                name: 'AppError',
                status: 409,
                code: 'DELIVERY_PICKUP_AMBIGUOUS',
            });
            expect(captured.details.candidates.map((candidate) => candidate.store_id)).toEqual(['store-a', 'store-b']);
            expect(captured.details.candidates[0]).toMatchObject({
                store_id: 'store-a',
                id: 'store-a',
                name: 'Warehouse A',
                city_id: 1,
                zone_id: 2,
                area_id: 3,
            });
            expect(provider.createStore).not.toHaveBeenCalled();
            expect(integration.save).not.toHaveBeenCalled();
        });
    });

    test('never auto-creates a provider store when nothing matches and preserves the old mapping', async () => {
        await jest.isolateModulesAsync(async () => {
            const provider = {
                getStores: jest.fn().mockResolvedValue([
                    { store_id: 'store-elsewhere', store_name: 'Other City Hub', city_id: 9, zone_id: 9, area_id: 9 },
                ]),
                createStore: jest.fn(),
            };
            const integration = {
                id: 'integration-no-match',
                provider: 'pathao',
                is_connected: true,
                is_active: false,
                pickup_location_id: 'pickup-moved',
                provider_store_id: 'store-old',
                pickup_store_id: 'store-old',
                pickup_enabled: true,
                metadata: { provider_store_id: 'store-old', pickup_location_id: 'pickup-moved' },
                save: jest.fn().mockResolvedValue(true),
            };
            const DeliveryIntegration = {
                findOne: jest.fn().mockResolvedValue(integration),
                sequelize: { query: jest.fn().mockResolvedValue([]) },
            };
            const pickupLocationService = {
                getPickupLocation: jest.fn().mockResolvedValue({
                    id: 'pickup-moved',
                    shop_id: 'shop-1',
                    provider: 'manual',
                    provider_store_id: null,
                    display_name: 'Moved pickup',
                    address: 'House 3, Dhaka',
                    area_name: 'Uttara',
                    city_id: 1,
                    zone_id: 2,
                    area_id: 3,
                }),
                serializePickupLocation: jest.fn((location) => location),
            };

            jest.doMock('../delivery-integration.entity', () => DeliveryIntegration);
            jest.doMock('../../entities', () => ({ DeliveryIntegration, ShopPickupLocation: {} }));
            jest.doMock('../pickup-location.service', () => pickupLocationService);
            jest.doMock('../pathao-token.service', () => ({ createProvider: jest.fn().mockResolvedValue(provider) }));
            jest.doMock('../providers/provider.registry', () => ({
                COURIER_REGISTRY: { pathao: { Provider: class FakePathaoProvider {} } },
            }));

            const deliveryService = require('../delivery.service');
            const result = await deliveryService.syncProviderPickup('shop-1', 'pathao', {
                pickup_location_id: 'pickup-moved',
                provider_pickup_meta: { city_id: 1, zone_id: 2, area_id: 3 },
            });

            // No external store is created just because the sync found no
            // geographic match, and the explicit old selection is preserved.
            expect(provider.createStore).not.toHaveBeenCalled();
            expect(result.store_resolution).toBe('NO_MATCH');
            expect(result.pickup_store_id).toBe('store-old');
            expect(integration.provider_store_id).toBe('store-old');
            expect(integration.pickup_location_id).toBe('pickup-moved');
        });
    });

    test('refuses to enable pickup without a location or provider store selected', async () => {
        await jest.isolateModulesAsync(async () => {
            const integration = {
                id: 'integration-empty',
                provider: 'pathao',
                is_connected: true,
                is_active: false,
                pickup_location_id: null,
                provider_store_id: null,
                pickup_store_id: null,
                pickup_enabled: false,
                metadata: {},
                save: jest.fn().mockResolvedValue(true),
            };
            const DeliveryIntegration = {
                findOne: jest.fn().mockResolvedValue(integration),
                sequelize: { query: jest.fn().mockResolvedValue([]) },
            };

            jest.doMock('../delivery-integration.entity', () => DeliveryIntegration);
            jest.doMock('../../entities', () => ({ DeliveryIntegration, ShopPickupLocation: {} }));
            jest.doMock('../pickup-location.service', () => ({
                getPickupLocation: jest.fn(),
                serializePickupLocation: jest.fn((location) => location),
            }));
            jest.doMock('../pathao-token.service', () => ({ createProvider: jest.fn() }));
            jest.doMock('../providers/provider.registry', () => ({
                COURIER_REGISTRY: { pathao: { Provider: class FakePathaoProvider {} } },
            }));

            const deliveryService = require('../delivery.service');
            await expect(deliveryService.setPickupConfiguration('shop-1', 'pathao', {}))
                .rejects.toMatchObject({ status: 409, code: 'DELIVERY_PICKUP_SOURCE_REQUIRED' });
            expect(integration.save).not.toHaveBeenCalled();
        });
    });

    test('requires concrete RedX credentials and delivery-area metadata', async () => {
        await jest.isolateModulesAsync(async () => {
            const DeliveryIntegration = {
                findOne: jest.fn().mockResolvedValue({
                    provider: 'redx',
                    is_connected: true,
                    is_active: true,
                    credentials: {},
                    pickup_location_id: 'pickup-redx',
                    provider_store_id: 'store-redx',
                    pickup_enabled: true,
                }),
            };
            const ShopPickupLocation = {
                findAll: jest.fn().mockResolvedValue([{
                    id: 'pickup-redx',
                    shop_id: 'shop-redx',
                    provider: 'redx',
                    provider_store_id: 'store-redx',
                    is_active: true,
                }]),
            };

            jest.doMock('../../entities', () => ({ DeliveryIntegration, ShopPickupLocation }));
            jest.doMock('../pickup-location.service', () => ({
                serializePickupLocation: jest.fn((location) => location),
            }));

            const readinessService = require('../courier-readiness.service');
            const readiness = await readinessService.getReadiness('shop-redx', 'redx');

            expect(readiness.ready).toBe(false);
            expect(readiness.missing).toEqual(expect.arrayContaining([
                'provider_credentials_unavailable',
                'pickup_area_id',
            ]));
        });
    });
});
