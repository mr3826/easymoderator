const orderValidator = require('../order.validator');

describe('order.validator', () => {
  describe('getOrders', () => {
    it('accepts every worklist bucket the UI can send', () => {
      for (const bucket of ['to_confirm', 'to_pack', 'booked', 'in_transit', 'needs_action', 'returned', 'delivered']) {
        const { error } = orderValidator.getOrders.query.validate({ delivery_bucket: bucket });
        expect(error).toBeUndefined();
      }
    });

    it('rejects an invented worklist bucket instead of silently ignoring it', () => {
      const { error } = orderValidator.getOrders.query.validate({ delivery_bucket: 'everything' });
      expect(error).toBeDefined();
    });

    // MW-V1: verified customer association.
    it('accepts a uuid customer_id filter', () => {
      const { error } = orderValidator.getOrders.query.validate({
        customer_id: '550e8400-e29b-41d4-a716-446655440000',
        limit: 3,
      });
      expect(error).toBeUndefined();
    });

    it('rejects a non-uuid customer_id (no name-shaped identity smuggling)', () => {
      const { error } = orderValidator.getOrders.query.validate({ customer_id: 'Rahim Uddin' });
      expect(error).toBeDefined();
    });

    // V6 contract port: Draft status filter used by Home.
    it('accepts the Draft status filter used by Home', () => {
      const result = orderValidator.getOrders.query.validate({
        order_status: 'draft',
        page: '1',
        limit: '100'
      });

      expect(result.error).toBeUndefined();
      expect(result.value).toMatchObject({ order_status: 'draft', page: 1, limit: 100 });
    });

    it('accepts the delivered status filter for the orders workspace', () => {
      const result = orderValidator.getOrders.query.validate({
        order_status: 'delivered',
        page: '1',
        limit: '100'
      });

      expect(result.error).toBeUndefined();
      expect(result.value).toMatchObject({ order_status: 'delivered', page: 1, limit: 100 });
    });
  });

  describe('updateOrder', () => {
    it('accepts REST path id with update body (no body orderId required)', () => {
      const paramsResult = orderValidator.updateOrder.params.validate({
        id: '550e8400-e29b-41d4-a716-446655440000'
      });
      const bodyResult = orderValidator.updateOrder.body.validate({
        order_status: 'confirmed'
      });

      expect(paramsResult.error).toBeUndefined();
      expect(bodyResult.error).toBeUndefined();
    });

    it('accepts a non-empty payment method for the owner/admin correction path', () => {
      const result = orderValidator.updateOrder.body.validate({ payment_method: 'cod' });

      expect(result.error).toBeUndefined();
      expect(result.value.payment_method).toBe('cod');
      expect(orderValidator.updateOrder.body.validate({ payment_method: ' ' }).error).toBeDefined();
    });

    it('accepts structured address and courier-area corrections', () => {
      const result = orderValidator.updateOrder.body.validate({
        delivery_address: {
          district: 'Dhaka',
          upazila: 'Dhanmondi',
          area: 'Dhanmondi',
          street_address: 'House 4, Road 12',
        },
        delivery_area: 'Dhanmondi',
      });

      expect(result.error).toBeUndefined();
      expect(result.value.delivery_address.area).toBe('Dhanmondi');
      expect(result.value.delivery_area).toBe('Dhanmondi');
    });

    it('does not let generic updates inject provider-specific destination records', () => {
      const result = orderValidator.updateOrder.body.validate({
        delivery_location: { provider_destination: { redx: { area_id: 999 } } },
      });

      expect(result.error).toBeDefined();
    });

    it('rejects empty update payload', () => {
      const bodyResult = orderValidator.updateOrder.body.validate({});
      expect(bodyResult.error).toBeDefined();
    });
  });

  describe('createOrder', () => {
    const base = {
      customer_name: 'Rahim',
      customer_phone: '01712345678',
      items: [{ product_id: '550e8400-e29b-41d4-a716-446655440000', quantity: 1, price: 250 }]
    };

    it('accepts the structured BD address object the manual-order form sends', () => {
      // Regression: the app posts delivery_address as an object; the validator used
      // to require a string, rejecting every manual order with a 400.
      const result = orderValidator.createOrder.body.validate({
        ...base,
        delivery_address: {
          division: 'Dhaka',
          district: 'Dhaka',
          upazila: 'Dhanmondi',
          street_address: 'House 12, Road 5',
          zone: 'inside_dhaka'
        }
      });
      expect(result.error).toBeUndefined();
    });

    it('still accepts a legacy free-text address string', () => {
      const result = orderValidator.createOrder.body.validate({
        ...base,
        delivery_address: 'House 12, Road 5, Dhanmondi, Dhaka'
      });
      expect(result.error).toBeUndefined();
    });

    it('accepts either payment method ID alias for service-side shop resolution', () => {
      const paymentMethodId = '550e8400-e29b-41d4-a716-446655440001';
      for (const alias of ['paymentMethodId', 'payment_method_id']) {
        expect(orderValidator.createOrder.body.validate({ ...base, [alias]: paymentMethodId }).error).toBeUndefined();
      }
    });

    it('rejects a non-address value type for delivery_address', () => {
      const result = orderValidator.createOrder.body.validate({
        ...base,
        delivery_address: 12345
      });
      expect(result.error).toBeDefined();
    });

    it('preserves draft and pending creation states while rejecting terminal states', () => {
      for (const order_status of ['draft', 'pending']) {
        expect(orderValidator.createOrder.body.validate({ ...base, order_status }).error).toBeUndefined();
      }
      for (const order_status of ['completed', 'fulfilled', 'cancelled']) {
        expect(orderValidator.createOrder.body.validate({ ...base, order_status }).error).toBeDefined();
      }
    });

    it('rejects client-supplied fulfilled, partial, or cancelled fulfillment values', () => {
      for (const fulfillment_status of ['fulfilled', 'partially_fulfilled', 'cancelled']) {
        const result = orderValidator.createOrder.body.validate({ ...base, fulfillment_status });
        expect(result.error).toBeDefined();
      }
    });
  });

  describe('fulfillment PATCH validation', () => {
    it('rejects client-supplied partial and cancelled fulfillment values', () => {
      for (const fulfillment_status of ['partially_fulfilled', 'cancelled']) {
        const result = orderValidator.updateOrder.body.validate({ fulfillment_status });
        expect(result.error).toBeDefined();
      }
    });

    it('accepts unfulfilled and fully fulfilled values for service-side evidence checks', () => {
      for (const fulfillment_status of ['unfulfilled', 'fulfilled']) {
        const result = orderValidator.updateOrder.body.validate({ fulfillment_status });
        expect(result.error).toBeUndefined();
      }
    });
  });

  describe('confirmCourierDestination', () => {
    const params = { orderId: '550e8400-e29b-41d4-a716-446655440000' };

    it('accepts a directory entry for a courier that has one', () => {
      const result = orderValidator.confirmCourierDestination.body.validate({
        provider: 'redx',
        area_id: 7,
        area_name: 'Mirpur',
        district: 'Dhaka',
      });

      expect(result.error).toBeUndefined();
      expect(result.value).toMatchObject({ provider: 'redx', area_id: 7 });
    });

    it('requires the courier, because ids from one courier are meaningless to another', () => {
      const result = orderValidator.confirmCourierDestination.body.validate({ area_id: 7 });
      expect(result.error).toBeDefined();
    });

    it('requires the area id itself', () => {
      const result = orderValidator.confirmCourierDestination.body.validate({ provider: 'pathao' });
      expect(result.error).toBeDefined();
    });

    it('rejects a courier the product does not support', () => {
      const result = orderValidator.confirmCourierDestination.body.validate({ provider: 'steadfast', area_id: 7 });
      expect(result.error).toBeDefined();
    });

    it('rejects unknown fields instead of storing them', () => {
      const result = orderValidator.confirmCourierDestination.body.validate({
        provider: 'redx',
        area_id: 7,
        provider_destination: { redx: { area_id: 999 } },
      });
      expect(result.error).toBeDefined();
    });

    it('requires a uuid order id in the path', () => {
      expect(orderValidator.confirmCourierDestination.params.validate(params).error).toBeUndefined();
      expect(orderValidator.confirmCourierDestination.params.validate({ orderId: 'order-1' }).error).toBeDefined();
    });
  });

  describe('legacyGet', () => {
    it('accepts id aliases', () => {
      const byOrderId = orderValidator.legacyGet.query.validate({
        order_id: '550e8400-e29b-41d4-a716-446655440000'
      });
      const byId = orderValidator.legacyGet.query.validate({
        id: '550e8400-e29b-41d4-a716-446655440000'
      });

      expect(byOrderId.error).toBeUndefined();
      expect(byId.error).toBeUndefined();
    });

    it('rejects missing ids', () => {
      const result = orderValidator.legacyGet.query.validate({});
      expect(result.error).toBeDefined();
    });
  });
});
