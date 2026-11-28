const CustomerValidator = require('../customer.validator');

const editSchemas = [
    ['legacy update', CustomerValidator.updateCustomer, {
        customerId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'
    }],
    ['RESTful update', CustomerValidator.updateCustomerById, {}]
];

describe.each(editSchemas)('%s customer validator', (_name, schema, basePayload) => {
    it('accepts an explicit null email to clear the customer email', () => {
        const { error, value } = schema.validate({ ...basePayload, email: null });

        expect(error).toBeUndefined();
        expect(value.email).toBeNull();
    });

    it('accepts an omitted email without adding it to the validated update', () => {
        const { error, value } = schema.validate({ ...basePayload, name: 'Updated Name' });

        expect(error).toBeUndefined();
        expect(Object.hasOwn(value, 'email')).toBe(false);
    });

    it('rejects a malformed non-empty email', () => {
        const { error } = schema.validate({ ...basePayload, email: 'not-an-email' });

        expect(error).toBeDefined();
    });
});

describe('create customer email validation', () => {
    it('continues to reject null email values', () => {
        const { error } = CustomerValidator.createCustomer.validate({
            name: 'Test Customer',
            email: null,
            number: '01712345678',
            channel: 'manual'
        });

        expect(error).toBeDefined();
    });
});
