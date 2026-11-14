'use strict';

// ADR-0013 §7 / TEST_STRATEGY §3 — business-hours truth table.
// Every row is pinned BEFORE the implementation is trusted: timezone-correct
// (Intl.formatToParts), both slot shapes, overnight ranges and fail-CLOSED
// malformed handling.

const rule = require('../rules/businessHours.rule');
const { AI_REPLY_MODES } = require('../../shop/ai-reply-mode');

jest.mock('../../shop/shop.entity', () => ({
    findByPk: jest.fn(),
}));
const Shop = require('../../shop/shop.entity');

const CLOSED_SCHEDULE = {};

// 2026-11-16 is a Monday.
const MONDAY = new Date('2026-11-16T03:30:00Z'); // 09:30 Asia/Dhaka (UTC+6)

describe('businessHours truth table (§3)', () => {
    afterEach(() => jest.clearAllMocks());

    const inside = (hours, now = MONDAY, options = {}) => rule.isInsideHours(hours, now, options);

    test('missing day key → CLOSED', () => {
        expect(inside({ tue: { open: '09:00', close: '18:00' } })).toBe(false);
    });

    test('empty object → CLOSED', () => {
        expect(inside({})).toBe(false);
    });

    test('empty array slot → CLOSED', () => {
        expect(inside({ mon: [] })).toBe(false);
    });

    test('valid object, now inside → OPEN', () => {
        expect(inside({ mon: { open: '09:00', close: '18:00' } })).toBe(true);
    });

    test('valid object, now outside → CLOSED', () => {
        expect(inside({ mon: { open: '11:00', close: '18:00' } })).toBe(false);
    });

    test('array of slots, inside ANY → OPEN', () => {
        expect(inside({
            mon: [
                { open: '08:00', close: '09:00' },
                { open: '09:15', close: '12:00' },
            ],
        })).toBe(true);
    });

    test('array of slots, inside NONE → CLOSED', () => {
        expect(inside({
            mon: [
                { open: '06:00', close: '07:00' },
                { open: '17:00', close: '18:00' },
            ],
        })).toBe(false);
    });

    test('overnight close < open, now after open → OPEN', () => {
        expect(inside({ mon: { open: '22:00', close: '02:00' } }, MONDAY, {}))
            .toBe(false); // Monday 09:30 is outside a 22:00–02:00 span
        expect(inside(
            { mon: { open: '22:00', close: '02:00' } },
            new Date('2026-11-16T17:00:00Z'), // 23:00 Dhaka
        )).toBe(true);
    });

    test('overnight close < open, now in the early-morning tail → OPEN', () => {
        // Monday 00:30 Dhaka is the tail of Sunday's 22:00 → 02:00 span.
        expect(inside(
            { sun: { open: '22:00', close: '02:00' } },
            new Date('2026-11-15T18:30:00Z'), // Monday 00:30 Dhaka
        )).toBe(true);
    });

    test.each([
        ['unparseable open', { mon: { open: '9am', close: '18:00' } }],
        ['unparseable close', { mon: { open: '09:00', close: 'later' } }],
        ['missing close', { mon: { open: '09:00' } }],
        ['numeric time', { mon: { open: 900, close: 1800 } }],
        ['slot is a string', { mon: '09:00-18:00' }],
        ['top-level is a string', 'garbage'],
        ['top-level is an array', []],
    ])('%s → CLOSED (fail-closed)', (_label, hours) => {
        expect(inside(hours)).toBe(false);
    });

    test('valid hours, no timezone, no shop timezone → Asia/Dhaka', () => {
        expect(inside({ mon: { open: '09:00', close: '18:00' } })).toBe(true);
        expect(inside(
            { mon: { open: '18:00', close: '19:00' } },
            new Date('2026-11-16T03:30:00Z'), // 09:30 Dhaka
        )).toBe(false);
    });

    test('valid hours, no timezone, Shop.timezone supplied → evaluate there', () => {
        const now = new Date('2026-11-16T03:30:00Z'); // 09:30 Dhaka = 22:30 previous day New York
        const hours = { mon: { open: '09:00', close: '18:00' } };
        expect(inside(hours, now, { defaultTimeZone: 'Asia/Dhaka' })).toBe(true);
        expect(inside(hours, now, { defaultTimeZone: 'America/New_York' })).toBe(false);
    });

    test('hours.timezone wins over the shop timezone', () => {
        const now = new Date('2026-11-16T14:00:00Z'); // 09:00 New York
        expect(inside(
            { timezone: 'America/New_York', mon: { open: '09:00', close: '18:00' } },
            now,
            { defaultTimeZone: 'Asia/Dhaka' },
        )).toBe(true);
    });

    test('invalid IANA timezone → CLOSED (never fail-open)', () => {
        expect(inside({ timezone: 'Mars/Olympus', mon: { open: '09:00', close: '18:00' } }))
            .toBe(false);
    });

    test('DST: same wall-clock schedule resolves correctly in EST and EDT', () => {
        const hours = { mon: { open: '09:00', close: '18:00' } };
        const winter = new Date('2026-01-15T14:00:00Z'); // 09:00 EST (UTC-5), Thursday
        const summer = new Date('2026-07-16T13:00:00Z'); // 09:00 EDT (UTC-4), Thursday
        expect(inside({ ...hours, thu: hours.mon }, winter, { defaultTimeZone: 'America/New_York' }))
            .toBe(true);
        expect(inside({ ...hours, thu: hours.mon }, summer, { defaultTimeZone: 'America/New_York' }))
            .toBe(true);
    });
});

describe('businessHours.rule evaluate', () => {
    test('NULL hours → always open (unchanged)', async () => {
        const result = await rule.evaluate({}, { settings: { automation_mode: 'AUTO', business_hours: null } });
        expect(result).toEqual({ allow: true, reason: 'NO_HOURS_CONFIG' });
    });

    test('transactional message bypasses hours regardless of mode', async () => {
        const result = await rule.evaluate({}, {
            messageType: 'transactional',
            settings: { automation_mode: 'AUTO', business_hours: CLOSED_SCHEDULE },
        });
        expect(result).toEqual({ allow: true, reason: 'TRANSACTIONAL_NOTIFICATION' });
    });

    test.each([AI_REPLY_MODES.AUTO, 'AI_ACTIVE'])('downgrades %s outside business hours', async (automationMode) => {
        const result = await rule.evaluate({}, {
            settings: { automation_mode: automationMode, business_hours: CLOSED_SCHEDULE },
        });
        expect(result).toEqual(expect.objectContaining({ allow: false, reason: 'SUGGEST_ONLY' }));
    });

    test.each([
        AI_REPLY_MODES.DRAFT,
        'AI_SUGGEST_ONLY',
        AI_REPLY_MODES.MANUAL,
        'HUMAN_ACTIVE',
    ])('does not downgrade %s outside business hours', async (automationMode) => {
        const result = await rule.evaluate({}, {
            settings: { automation_mode: automationMode, business_hours: CLOSED_SCHEDULE },
        });
        expect(result).toEqual(expect.objectContaining({ allow: true, reason: 'OUTSIDE_HOURS_NON_AI' }));
    });
});

describe('Shop.timezone fallback', () => {
    afterEach(() => jest.clearAllMocks());

    test('reads Shop.timezone when hours carries no timezone', async () => {
        Shop.findByPk.mockResolvedValueOnce({ id: 'shop-1', timezone: 'America/New_York' });
        await expect(rule.resolveShopTimeZone({ shopId: 'shop-1' }))
            .resolves.toBe('America/New_York');
        expect(Shop.findByPk).toHaveBeenCalledWith('shop-1', expect.objectContaining({
            attributes: ['id', 'timezone'],
        }));
    });

    test('an explicit ctx shopTimezone avoids the DB read', async () => {
        await expect(rule.resolveShopTimeZone({ shopId: 'shop-1', shopTimezone: 'Europe/London' }))
            .resolves.toBe('Europe/London');
        expect(Shop.findByPk).not.toHaveBeenCalled();
    });

    test('unreadable Shop row falls back to null → Asia/Dhaka at evaluation', async () => {
        Shop.findByPk.mockRejectedValueOnce(new Error('db down'));
        await expect(rule.resolveShopTimeZone({ shopId: 'shop-1' })).resolves.toBeNull();
    });
});