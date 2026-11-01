'use strict';

const express = require('express');
const {
    PlanCode,
    PRICING_TIERS,
    TOPUP_PACKS,
    PARTNER_ORDER_TIERS
} = require('../subscription/subscription.plans');

const router = express.Router();

const PLAN_DESCRIPTIONS = Object.freeze({
    [PlanCode.SHURU]: 'No monthly plan fee; the active allowance counts Messenger conversations.',
    [PlanCode.GROWTH]: 'Monthly subscription with conversation-only top-ups; see current values in the published catalog.',
    [PlanCode.PARTNER]: 'No upfront fee; approved Partnership shops are billed by delivered-order bands.'
});

const PLAN_DESCRIPTIONS_BN = Object.freeze({
    [PlanCode.SHURU]: 'মাসিক প্ল্যান ফি নেই; সক্রিয় সীমায় Messenger কথোপকথন গণনা হয়।',
    [PlanCode.GROWTH]: 'মাসিক সাবস্ক্রিপশন; top-up-এ কথোপকথন যোগ হয়। বর্তমান সীমা ও দাম লাইভ ক্যাটালগে দেখুন।',
    [PlanCode.PARTNER]: 'কোনো upfront subscription নেই; অনুমোদিত Partnership শপ delivered-order band অনুযায়ী বিল পায়।',
});

const PUBLIC_NAMES = Object.freeze({
    [PlanCode.SHURU]: 'Get Your Moderator',
    [PlanCode.GROWTH]: 'Moderator Plus',
    [PlanCode.PARTNER]: 'Partnership',
});

// The founder's 300/3,000 support targets use a distinct, non-billable shadow
// unit. They do not replace persisted conversation entitlements or top-ups.
const SHADOW_SUPPORT_ALLOWANCES = Object.freeze({
    [PlanCode.SHURU]: Object.freeze({
        amount: 300,
        unit: 'provider_accepted_ai_reply',
        period: 'utc_calendar_month',
        status: 'shadow_only',
        billable: false,
        enforced: false,
    }),
    [PlanCode.GROWTH]: Object.freeze({
        amount: 3000,
        unit: 'provider_accepted_ai_reply',
        period: 'utc_calendar_month',
        status: 'shadow_only',
        billable: false,
        enforced: false,
    }),
    [PlanCode.PARTNER]: null,
});

const toPublicPlan = (tier) => ({
    code: tier.code,
    name: tier.name,
    public_name: PUBLIC_NAMES[tier.code],
    description: PLAN_DESCRIPTIONS[tier.code],
    description_bn: PLAN_DESCRIPTIONS_BN[tier.code],
    billing_model: tier.billingModel,
    price_bdt_monthly: tier.priceBdtMonthly,
    price_bdt_yearly: tier.priceBdtYearly,
    conversations_limit: tier.conversationsLimit,
    orders_limit: tier.ordersLimit,
    products_limit: tier.productsLimit,
    can_purchase_topups: tier.canPurchaseTopups,
    per_order_charge_bdt: tier.perOrderChargeBdt,
    features: tier.features,
    topup_packs: tier.canPurchaseTopups ? Object.values(TOPUP_PACKS) : [],
    partner_order_tiers: tier.code === PlanCode.PARTNER ? PARTNER_ORDER_TIERS : [],
    support_reply_allowance: SHADOW_SUPPORT_ALLOWANCES[tier.code],
});

// Public by design: the marketing origin cannot call the authenticated
// subscription router, and prices/entitlements must have one server source.
router.get('/', (_req, res) => {
    res.json({
        success: true,
        data: Object.values(PRICING_TIERS).map(toPublicPlan)
    });
});

module.exports = router;
