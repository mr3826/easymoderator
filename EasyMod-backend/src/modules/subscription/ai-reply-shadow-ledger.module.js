'use strict';

const routes = require('./ai-reply-shadow-ledger.routes');
const service = require('./ai-reply-shadow-ledger.service');

// Wire by mounting `routes` at /api/subscription/ai-reply-shadow-ledger.
// The message worker imports the service directly after durable send finalization.
module.exports = {
    routes,
    recordAcceptedAiReply: service.recordAcceptedAiReply,
    getShadowUsage: service.getShadowUsage,
};
