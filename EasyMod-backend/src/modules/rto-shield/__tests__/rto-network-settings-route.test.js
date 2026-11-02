'use strict';

const mockRouter = {
  use: jest.fn(),
  get: jest.fn(),
  put: jest.fn(),
  post: jest.fn(),
  delete: jest.fn(),
};
const mockAuthenticate = jest.fn();
const mockVerifyShopAccess = jest.fn();
const mockRequireOwnerOrAdmin = jest.fn();
const mockController = {
  getSettings: jest.fn(),
  updateSettings: jest.fn(),
};
const mockSchema = { body: { validate: jest.fn() } };

jest.mock('express', () => ({ Router: () => mockRouter }));
jest.mock('../../../middleware/auth.middleware', () => ({ authenticate: mockAuthenticate }));
jest.mock('../../../middleware/shop-access.middleware', () => ({ verifyShopAccess: mockVerifyShopAccess }));
jest.mock('../../../middleware/shop-permission.middleware', () => ({ requireOwnerOrAdmin: mockRequireOwnerOrAdmin }));
jest.mock('../rto-shield.controller', () => mockController);
jest.mock('../rto-shield.validator', () => ({
  addEntrySchema: mockSchema,
  checkPhoneSchema: mockSchema,
  bulkImportSchema: mockSchema,
  listSchema: mockSchema,
  whitelistSchema: mockSchema,
  networkStatsSchema: mockSchema,
  networkSettingsSchema: mockSchema,
}));

require('../rto-shield.routes');

describe('RTO network settings route authorization', () => {
  it('requires shop owner/admin authorization before accepting consent changes', () => {
    const updateCall = mockRouter.put.mock.calls.find(([path]) => path === '/settings');

    expect(updateCall).toBeDefined();
    expect(updateCall?.[1]).toBe(mockRequireOwnerOrAdmin);
    expect(updateCall?.at(-1)).toBe(mockController.updateSettings);
  });

  it('keeps settings readable by authenticated shop members', () => {
    const getCall = mockRouter.get.mock.calls.find(([path]) => path === '/settings');

    expect(getCall).toBeDefined();
    expect(getCall?.at(-1)).toBe(mockController.getSettings);
    expect(getCall).not.toContain(mockRequireOwnerOrAdmin);
  });
});
