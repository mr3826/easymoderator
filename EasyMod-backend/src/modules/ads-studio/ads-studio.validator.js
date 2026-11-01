'use strict';

const Joi = require('joi');

const MAX_CSV_BYTES = 2 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RECOMMENDATION_CODES = ['SPEND_WITHOUT_LINK_CLICKS', 'LINK_CLICK_FOLLOWUP'];
const uuid = () => Joi.string().pattern(UUID);
const strictObject = (shape) => Joi.object(shape).unknown(false).strict();

const schemas = {
    listReports: { query: strictObject({}) },
    importReport: {
        body: Joi.string().max(MAX_CSV_BYTES).required().strict(),
    },
    getReport: {
        params: strictObject({ reportId: uuid().required() }),
        query: strictObject({}),
    },
    listDrafts: { query: strictObject({}) },
    createDraft: {
        body: strictObject({
            report_id: uuid().required(),
            campaign_metric_id: uuid().required(),
            recommendation_code: Joi.string().valid(...RECOMMENDATION_CODES).required(),
            title: Joi.string().min(1).max(120).optional(),
            objective: Joi.string().max(120).optional().allow(''),
            audience_notes: Joi.string().max(1000).optional().allow(''),
            creative_notes: Joi.string().max(2000).optional().allow(''),
            copy_draft: Joi.string().max(4000).optional().allow(''),
        }),
    },
    updateDraft: {
        params: strictObject({ draftId: uuid().required() }),
        body: strictObject({
            title: Joi.string().min(1).max(120).optional(),
            objective: Joi.string().max(120).optional().allow(''),
            audience_notes: Joi.string().max(1000).optional().allow(''),
            creative_notes: Joi.string().max(2000).optional().allow(''),
            copy_draft: Joi.string().max(4000).optional().allow(''),
        }).min(1),
    },
    approveDraft: {
        params: strictObject({ draftId: uuid().required() }),
        body: Joi.object().max(0).unknown(false).strict().default({}),
    },
};

function validate(schema) {
    return (req, res, next) => {
        const errors = [];
        for (const location of ['body', 'query', 'params']) {
            if (!schema[location]) continue;
            const result = schema[location].validate(req[location], {
                abortEarly: false,
                allowUnknown: false,
                convert: false,
                stripUnknown: false,
            });
            if (result.error) {
                errors.push(...result.error.details.map((detail) => ({
                    field: detail.path.join('.'),
                    location,
                    message: detail.message,
                })));
            } else {
                req[location] = result.value;
            }
        }
        if (errors.length) {
            return res.status(400).json({
                success: false,
                error: { code: 'VALIDATION_ERROR', message: 'Request validation failed', details: errors },
            });
        }
        return next();
    };
}

module.exports = { MAX_CSV_BYTES, RECOMMENDATION_CODES, schemas, validate };
