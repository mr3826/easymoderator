'use strict';

const {
    ALLOWED_FUNNEL_EVENTS,
    PUBLIC_FUNNEL_EVENTS,
    INTERNAL_FUNNEL_EVENTS,
} = require('../funnel-events.service');

const LANDING_EVENTS = [
    'page_view',
    'cta_click',
    'signup_click',
    'scroll_depth',
    'section_view',
    'mechanism_view',
    'faq_open',
    'calc_state',
    'calc_reset',
];

describe('contract-derived landing funnel events', () => {
    test.each(LANDING_EVENTS)('%s is allowed and anonymous-postable', (event) => {
        expect(ALLOWED_FUNNEL_EVENTS.has(event)).toBe(true);
        expect(PUBLIC_FUNNEL_EVENTS.has(event)).toBe(true);
        // Public events are by definition not server-only internal milestones.
        expect(INTERNAL_FUNNEL_EVENTS.has(event)).toBe(false);
    });

    test('existing public funnel events stay public', () => {
        expect(PUBLIC_FUNNEL_EVENTS.has('landing_view')).toBe(true);
        expect(PUBLIC_FUNNEL_EVENTS.has('signup_started')).toBe(true);
    });

    test('internal milestones still require a trusted server producer', () => {
        expect(INTERNAL_FUNNEL_EVENTS.has('first_order_captured')).toBe(true);
        expect(PUBLIC_FUNNEL_EVENTS.has('first_order_captured')).toBe(false);
    });
});