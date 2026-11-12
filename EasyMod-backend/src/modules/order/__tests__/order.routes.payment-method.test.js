'use strict';

const mockRouter = {
  use: jest.fn(),
  get: jest.fn(),
  post: jest.fn(),
  put: jest.fn(),
  patch: jest.fn(),
  delete: jest.fn(),
};
const mockValidate = jest.fn();
const mockOrderController = new Proxy({}, { get: () => jest.fn() });
const mockOrderValidator = new Proxy({}, { get: () => ({}) });

jest.mock('express', () => ({ Router: () => mockRouter }));
jest.mock('../order.controller', () => mockOrderController);
jest.mock('../order.validator', () => mockOrderValidator);
jest.mock('../../helpers', () => ({ validate: () => mockValidate }));
jest.mock('../../../middleware/auth.middleware', () => ({ authenticate: jest.fn() }));
jest.mock('../../../middleware/shop-access.middleware', () => ({ verifyShopAccess: jest.fn() }));

require('../order.routes');

describe('order payment correction authorization', () => {

  it.each(['payment_method', 'payment_status'])(
    'requires owner/admin authorization when the REST update includes %s',
    (field) => {
      const patchCall = mockRouter.patch.mock.calls.find(([path]) => path === '/:id');
      expect(patchCall).toBeDefined();

      const requireOwnerForPaymentCorrection = patchCall[2];
      const next = jest.fn();
      const requestWithoutMethod = { body: { note: 'internal note' } };
      requireOwnerForPaymentCorrection(requestWithoutMethod, {}, next);
      expect(next).toHaveBeenCalledWith();

      const staffNext = jest.fn();
      requireOwnerForPaymentCorrection({
        body: { [field]: field === 'payment_method' ? 'cod' : 'paid' },
        userRole: 'staff',
      }, {}, staffNext);
      expect(staffNext).toHaveBeenCalledTimes(1);
      expect(staffNext.mock.calls[0][0]).toMatchObject({ status: 403 });

      const ownerNext = jest.fn();
      requireOwnerForPaymentCorrection({
        body: { [field]: field === 'payment_method' ? 'cod' : 'paid' },
        userRole: 'owner',
      }, {}, ownerNext);
      expect(ownerNext).toHaveBeenCalledWith();
    },
  );

  it('applies the same owner/admin gate to the legacy update route', () => {
    const updateCall = mockRouter.post.mock.calls.find(([path]) => path === '/update');
    expect(updateCall).toBeDefined();
    expect(updateCall[2]).toBe(mockRouter.patch.mock.calls.find(([path]) => path === '/:id')?.[2]);
  });
});
