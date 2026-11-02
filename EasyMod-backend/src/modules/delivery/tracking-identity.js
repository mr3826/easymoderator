'use strict';

const { PROVIDER_NAMES } = require('./providers/provider.registry');

const VALID_COURIER_PROVIDERS = new Set(PROVIDER_NAMES.map((provider) => provider.toLowerCase()));

const normalizeCourierProvider = (value) => {
    if (typeof value !== 'string') return null;
    const provider = value.trim().toLowerCase();
    return VALID_COURIER_PROVIDERS.has(provider) ? provider : null;
};

const normalizeTrackingId = (...values) => {
    const value = values.find((candidate) => typeof candidate === 'string' && candidate.trim());
    return value ? value.trim() : null;
};

const resolveCourierTrackingIdentity = (providerValue, ...trackingValues) => {
    const provider = normalizeCourierProvider(providerValue);
    const trackingNumber = normalizeTrackingId(...trackingValues);
    return provider && trackingNumber ? { provider, trackingNumber } : null;
};

const trackingUnavailableMessage = (code) => code === 'COURIER_DISPATCH_PROVIDER_UNAVAILABLE'
    ? 'Courier dispatch identity is unavailable. Do not book again; reconcile manually before retrying.'
    : 'Courier tracking is unavailable. Do not book again; reconcile with the provider before retrying.';

module.exports = {
    normalizeCourierProvider,
    normalizeTrackingId,
    resolveCourierTrackingIdentity,
    trackingUnavailableMessage,
};
