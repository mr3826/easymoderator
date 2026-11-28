/**
 * Customer Service — Unit Tests
 * Tests customer CRUD, consent management, and segment filtering
 */

// ── Mocks ─────────────────────────────────────────────────────────────────────

jest.mock('../../entities', () => ({
    Customer: {
        findOne: jest.fn(),
        findAll: jest.fn(),
        findAndCountAll: jest.fn(),
        findOrCreate: jest.fn(),
        create: jest.fn(),
        update: jest.fn()
    },
    UserShop: { findOne: jest.fn() },
    Order: {
        findAll: jest.fn(),
        count: jest.fn()
    }
}));

// AppError is NOT mocked. The stub this replaced set `statusCode`, but the
// real class sets `status` — so assertions written against the stub passed
// while the same assertion against production behaviour would fail.
jest.mock('../../../utils/structured-logger', () => ({
    createLogger: jest.fn(() => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }))
}));

// ── Require after mocks ───────────────────────────────────────────────────────

const customerService = require('../customer.service');
const { Customer, UserShop, Order } = require('../../entities');
const { AppError } = require('../../../utils/AppError');

// ── Helpers ───────────────────────────────────────────────────────────────────

const makeCustomer = (overrides = {}) => ({
    id: 'cust-1',
    shop_id: 'shop-1',
    channel_type: 'messenger',
    channel_user_id: 'psid-abc',
    display_name: 'Test Customer',
    phone: '01711000000',
    metadata: {},
    update: jest.fn(async (data) => {
        Object.assign(cust, data);
        return cust;
    }),
    ...overrides
});

let cust;

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('CustomerService', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        cust = makeCustomer();
    });

    // ── findOrCreateCustomerByChannel ─────────────────────────────────────────
    // Named getOrCreateCustomer(shopId, data) when this suite was written, and
    // it returned the customer. It now takes userId first (every entry point
    // verifies shop access) and returns { customer, isNew }.

    describe('findOrCreateCustomerByChannel', () => {
        beforeEach(() => {
            UserShop.findOne.mockResolvedValue({ user_id: 'user-1', shop_id: 'shop-1', is_active: true });
        });

        it('returns existing customer when found by channel_user_id', async () => {
            Customer.findOrCreate.mockResolvedValue([cust, false]);
            const result = await customerService.findOrCreateCustomerByChannel('user-1', 'shop-1', {
                channel_type: 'messenger',
                channel_user_id: 'psid-abc',
                name: 'Test Customer'
            });
            expect(result.customer.id).toBe('cust-1');
            expect(result.isNew).toBe(false);
        });

        it('creates customer when not found', async () => {
            const newCustomer = makeCustomer({ id: 'cust-new' });
            Customer.findOrCreate.mockResolvedValue([newCustomer, true]);
            const result = await customerService.findOrCreateCustomerByChannel('user-1', 'shop-1', {
                channel_type: 'instagram',
                channel_user_id: 'igid-xyz'
            });
            expect(result.customer.id).toBe('cust-new');
            expect(result.isNew).toBe(true);
        });

        it('scopes the lookup to the shop, so two shops never share a customer row', async () => {
            Customer.findOrCreate.mockResolvedValue([cust, true]);
            await customerService.findOrCreateCustomerByChannel('user-1', 'shop-99', {
                channel_type: 'messenger',
                channel_user_id: 'psid-new'
            });
            // shop_id belongs in `where`, not `defaults`: in `defaults` it would
            // only apply on create, and an existing row for the same PSID under
            // another shop would be returned to this one.
            expect(Customer.findOrCreate).toHaveBeenCalledWith(expect.objectContaining({
                where: expect.objectContaining({
                    shop_id: 'shop-99',
                    channel_type: 'messenger',
                    channel_user_id: 'psid-new'
                })
            }));
        });

        it('refuses when the user has no access to the shop', async () => {
            UserShop.findOne.mockResolvedValue(null);
            await expect(
                customerService.findOrCreateCustomerByChannel('user-1', 'shop-not-mine', {
                    channel_type: 'messenger',
                    channel_user_id: 'psid-abc'
                })
            ).rejects.toMatchObject({ status: 403 });
            expect(Customer.findOrCreate).not.toHaveBeenCalled();
        });
    });

    // ── listCustomers ─────────────────────────────────────────────────────────
    // Named getCustomers(shopId, filters) when this suite was written, and it
    // returned Sequelize's raw { rows, count }.

    describe('listCustomers', () => {
        beforeEach(() => {
            UserShop.findOne.mockResolvedValue({ user_id: 'user-1', shop_id: 'shop-1', is_active: true });
        });

        it('returns paginated customer list for the shop', async () => {
            Customer.findAndCountAll.mockResolvedValue({ rows: [cust], count: 1 });
            const result = await customerService.listCustomers('user-1', 'shop-1', { page: 1, pageSize: 20 });
            expect(result.data).toHaveLength(1);
            expect(result.total).toBe(1);
            expect(Customer.findAndCountAll).toHaveBeenCalledWith(expect.objectContaining({
                where: expect.objectContaining({ shop_id: 'shop-1' })
            }));
        });

        it('returns empty list when no customers', async () => {
            Customer.findAndCountAll.mockResolvedValue({ rows: [], count: 0 });
            const result = await customerService.listCustomers('user-1', 'shop-1', {});
            expect(result.data).toEqual([]);
        });

        it('caps pageSize so one request cannot read the whole customer table', async () => {
            Customer.findAndCountAll.mockResolvedValue({ rows: [], count: 0 });
            await customerService.listCustomers('user-1', 'shop-1', { pageSize: 10000 });
            expect(Customer.findAndCountAll).toHaveBeenCalledWith(
                expect.objectContaining({ limit: 100 })
            );
        });
    });

    describe('updateCustomer', () => {
        beforeEach(() => {
            UserShop.findOne.mockResolvedValue({ user_id: 'user-1', shop_id: 'shop-1', is_active: true });
            Customer.findOne.mockResolvedValue(cust);
            cust.toJSON = jest.fn(() => ({
                id: cust.id,
                shop_id: cust.shop_id,
                email: 'existing@example.com'
            }));
        });

        it('persists an explicit null email within the authorized shop', async () => {
            await customerService.updateCustomer('cust-1', 'user-1', 'shop-1', { email: null });

            expect(Customer.findOne).toHaveBeenCalledWith({
                where: { id: 'cust-1', shop_id: 'shop-1' }
            });
            expect(cust.update).toHaveBeenCalledWith({ email: null });
        });

        it('does not write email when it is omitted from the update', async () => {
            await customerService.updateCustomer('cust-1', 'user-1', 'shop-1', { name: 'Updated Name' });

            expect(cust.update).toHaveBeenCalledWith({ name: 'Updated Name' });
        });

        it('rejects updates when the user does not have active shop access', async () => {
            UserShop.findOne.mockResolvedValue(null);

            await expect(
                customerService.updateCustomer('cust-1', 'user-1', 'shop-1', { email: null })
            ).rejects.toMatchObject({ status: 403 });

            expect(Customer.findOne).not.toHaveBeenCalled();
            expect(cust.update).not.toHaveBeenCalled();
        });
    });

    // ── getCustomerById ───────────────────────────────────────────────────────

    describe('getCustomerById', () => {
        beforeEach(() => {
            UserShop.findOne.mockResolvedValue({ user_id: 'user-1', shop_id: 'shop-1', is_active: true });
        });

        it('returns customer with order count when found', async () => {
            Customer.findOne.mockResolvedValue(cust);
            Order.count.mockResolvedValue(5);
            const result = await customerService.getCustomerById('cust-1', 'user-1', 'shop-1');
            expect(result).toBeDefined();
        });

        it('throws 404 when customer not found', async () => {
            Customer.findOne.mockResolvedValue(null);
            await expect(
                customerService.getCustomerById('nonexistent', 'user-1', 'shop-1')
            ).rejects.toMatchObject({ status: 404 });
        });
    });

    describe('deleteCustomer', () => {
        it('rejects a staff member before destructive customer deletion', async () => {
            UserShop.findOne.mockResolvedValue({
                user_id: 'user-1', shop_id: 'shop-1', is_active: true, role: 'staff',
            });
            cust.destroy = jest.fn();

            await expect(customerService.deleteCustomer('cust-1', 'user-1', 'shop-1'))
                .rejects.toMatchObject({ status: 403 });

            expect(Customer.findOne).not.toHaveBeenCalled();
            expect(cust.destroy).not.toHaveBeenCalled();
        });

        it('allows an owner to erase a customer and returns the existing audit snapshot', async () => {
            UserShop.findOne.mockResolvedValue({
                user_id: 'user-1', shop_id: 'shop-1', is_active: true, role: 'owner',
            });
            Customer.findOne.mockResolvedValue(cust);
            cust.destroy = jest.fn().mockResolvedValue(true);

            const result = await customerService.deleteCustomer('cust-1', 'user-1', 'shop-1');

            expect(cust.destroy).toHaveBeenCalledTimes(1);
            expect(result.deletedSnapshot).toEqual({ id: 'cust-1', channel_type: 'messenger' });
        });
    });

    // Note: campaign/marketing consent has moved to meta_channel_consent_events
    // (see consent.service.js). The old `updateCustomerConsent` / `getCustomersBySegment`
    // methods and `customer.metadata.marketing_opt_*` flags were removed in the
    // Meta integration redesign (Phase 5). Tests for those behaviours now live with
    // consent.service.
});
