'use strict';

const PUBLIC_ADDONS = Object.freeze([
    {
        code: 'ADS_STUDIO',
        name: 'EasyModerator Ads Studio',
        category: 'advertising',
        availability: 'pilot_approval_required',
        billing_terms: 'not_activated',
        price_bdt_monthly: null,
        summary: 'Import a Meta Ads report, inspect its campaign metrics, get report-grounded suggestions, and prepare an explicitly approved draft.',
        limits: [
            'Merchant-supplied CSV only; no direct Meta Ads account connection is currently claimed.',
            'Draft approval does not publish campaigns or change spend.',
            'No EasyModerator order attribution, ROAS, or profit calculation.',
            'No Messenger promotional broadcasts.',
        ],
    },
    {
        code: 'STOREFRONT',
        name: 'EasyModerator Storefront',
        category: 'commerce',
        availability: 'pilot_approval_required',
        billing_terms: 'not_activated',
        price_bdt_monthly: null,
        summary: 'Publish selected shop products and accept validated cash-on-delivery orders into the existing EasyModerator workspace.',
        limits: [
            'Uses the shop catalog, variants, inventory, customer, and order records.',
            'COD only; no online payment verification or courier automation is claimed.',
            'Pilot access is merchant- and platform-gated.',
        ],
    },
]);

function getPublicAddonCatalog() {
    return PUBLIC_ADDONS.map((addon) => ({ ...addon, limits: [...addon.limits] }));
}

module.exports = { PUBLIC_ADDONS, getPublicAddonCatalog };
