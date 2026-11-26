const { AppError } = require('../utils/AppError');

/**
 * Generic Joi validation middleware factory.
 * Usage: router.post('/path', validate(mySchema), handler)
 * or:    router.post('/path', validate({ body: bodySchema, params: paramsSchema, query: querySchema }), handler)
 */
function validate(schemaOrMap) {
    return (req, res, next) => {
        const map = schemaOrMap && typeof schemaOrMap.validate === 'function'
            ? { body: schemaOrMap }
            : schemaOrMap;

        const errors = [];
        for (const [key, schema] of Object.entries(map)) {
            if (!schema) continue;
            const { error, value } = schema.validate(req[key], {
                abortEarly: false,
                stripUnknown: key === 'body',
                allowUnknown: key !== 'body'
            });
            if (error) {
                errors.push(...error.details.map(d => d.message));
            } else {
                req[key] = value;
            }
        }
        if (errors.length) {
            // F-7 (A9-R2): boundary-shape rejections carry an honest
            // VALIDATION_ERROR code (was the AppError default INTERNAL_ERROR
            // on a 400, which mislabeled client payload faults as server
            // faults for every validated route).
            return next(new AppError(errors.join('; '), 400, 'VALIDATION_ERROR'));
        }
        next();
    };
}

module.exports = validate;
