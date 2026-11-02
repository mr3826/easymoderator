import { describe, expect, it } from 'vitest';
import { getExpectedCourierCollection } from '../orderRules';

describe('getExpectedCourierCollection', () => {
  it('uses the order total only for explicit pending or unpaid COD', () => {
    expect(getExpectedCourierCollection({ total: 1250, payment_method: 'COD', payment_status: 'pending' })).toBe(1250);
    expect(getExpectedCourierCollection({ total: 1250, payment_method: 'cash_on_delivery', payment_status: 'unpaid' })).toBe(1250);
  });

  it('shows zero for paid orders and explicit non-COD methods', () => {
    expect(getExpectedCourierCollection({ total: 1250, payment_status: 'paid' })).toBe(0);
    expect(getExpectedCourierCollection({ total: 1250, payment_method: 'self-mfs', payment_status: 'pending' })).toBe(0);
  });

  it('shows unknown for partial COD, missing methods, and unsupported COD statuses', () => {
    expect(getExpectedCourierCollection({ total: 1250, payment_method: 'cod', payment_status: 'partially_paid' })).toBeNull();
    expect(getExpectedCourierCollection({ total: 1250, payment_status: 'unpaid' })).toBeNull();
    expect(getExpectedCourierCollection({ total: 1250, payment_method: 'cod', payment_status: undefined })).toBeNull();
  });
});
