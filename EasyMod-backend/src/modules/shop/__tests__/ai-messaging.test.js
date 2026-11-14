'use strict';

/**
 * ai-messaging — pure builders for the greeting (with Meta AI-disclosure),
 * the order-confirmation closing, and the social-links block. No DB, no I/O.
 */

const {
    buildDisclosure,
    buildGreeting,
    renderSocialLinks,
    buildClosing,
} = require('../ai-messaging');
const { DEFAULT_AI_SETTINGS } = require('../shop-defaults');
const { validateAISettings } = require('../shop-settings.validator');

describe('ai-messaging · buildDisclosure', () => {
    it('interpolates the shop name in English (clear text, no icon)', () => {
        expect(buildDisclosure('Rina Saree', 'en')).toBe(
            "Hi, I'm the AI assistant from Rina Saree."
        );
    });

    it('renders the Bangla disclosure', () => {
        expect(buildDisclosure('রিনা শাড়ি', 'bn')).toBe(
            'হাই, আমি রিনা শাড়ি-এর AI সহকারী।'
        );
    });

    it('falls back to mixed for unknown / missing language', () => {
        expect(buildDisclosure('Rina', 'klingon')).toBe(
            'Hi, ami Rina-er AI assistant.'
        );
        expect(buildDisclosure('Rina')).toBe(
            'Hi, ami Rina-er AI assistant.'
        );
    });

    it('uses a generic name when shopName is missing', () => {
        expect(buildDisclosure('', 'en')).toBe(
            "Hi, I'm the AI assistant from our shop."
        );
    });

    it('contains no bot icon and clearly discloses automation', () => {
        for (const lang of ['en', 'bn', 'mixed']) {
            const d = buildDisclosure('Shop', lang);
            expect(d).not.toMatch(/🤖/);
            expect(d.toLowerCase()).toMatch(/ai|স্বয়ংক্রিয়/);
        }
    });
});

describe('ai-messaging · buildGreeting', () => {
    const base = { shopName: 'Rina Saree', language: 'en' };
    const DISCLAIMER = "Hi, I'm the AI assistant from Rina Saree.";

    // ADR-0013 §2: greeting.enabled (business default or channel override)
    // controls the owner's custom welcome. The mandatory AI disclosure is
    // always present regardless. Deliberate amendment of the legacy no-op pin.
    it('keeps the mandatory disclaimer but drops the custom text when enabled=false', () => {
        expect(buildGreeting({ ...base, greeting: { enabled: false, custom_text: 'hi' } })).toBe(DISCLAIMER);
    });

    it('sends the custom text when enabled=true', () => {
        expect(buildGreeting({ ...base, greeting: { enabled: true, custom_text: 'hi' } })).toBe(
            `${DISCLAIMER}\n\nhi`
        );
    });

    it('returns the disclaimer alone when greeting config is missing', () => {
        expect(buildGreeting({ ...base })).toBe(DISCLAIMER);
    });

    it('combines the disclosure and the owner custom text', () => {
        const out = buildGreeting({ ...base, greeting: { custom_text: 'Welcome! How can I help?' } });
        expect(out).toBe(`${DISCLAIMER}\n\nWelcome! How can I help?`);
    });

    it('returns the disclosure alone when custom text is blank', () => {
        expect(buildGreeting({ ...base, greeting: { custom_text: '   ' } })).toBe(DISCLAIMER);
    });
});

describe('ai-messaging · renderSocialLinks', () => {
    it('returns empty string when no links are set', () => {
        expect(renderSocialLinks({}, 'en')).toBe('');
        expect(renderSocialLinks({ facebook: '', instagram: '   ' }, 'en')).toBe('');
        expect(renderSocialLinks(null, 'en')).toBe('');
    });

    it('renders only launch-approved filled links, in a stable order, under a header', () => {
        const out = renderSocialLinks(
            { facebook: 'https://fb.com/rina', whatsapp: '01711111111', website: 'https://rina.example' },
            'en'
        );
        expect(out).toBe(
            'Follow us:\nFacebook: https://fb.com/rina\nWebsite: https://rina.example'
        );
    });

    it('localizes the header for Bangla / mixed', () => {
        expect(renderSocialLinks({ facebook: 'https://fb.com/x' }, 'bn')).toBe(
            'আমাদের ফলো করুন:\nFacebook: https://fb.com/x'
        );
        expect(renderSocialLinks({ facebook: 'https://fb.com/x' }, 'mixed')).toBe(
            'আমাদের ফলো করুন:\nFacebook: https://fb.com/x'
        );
    });
});

describe('ai-messaging · buildClosing', () => {
    const socials = { facebook: 'https://fb.com/rina' };

    it('returns empty string when closing is disabled', () => {
        expect(buildClosing({ closing: { enabled: false, custom_text: 'thanks' }, socialLinks: socials, language: 'en' })).toBe('');
    });

    it('returns empty string when closing config is missing', () => {
        expect(buildClosing({ socialLinks: socials, language: 'en' })).toBe('');
    });

    it('returns the custom text alone when no social links are set', () => {
        expect(buildClosing({ closing: { enabled: true, custom_text: 'Thank you!' }, socialLinks: {}, language: 'en' })).toBe('Thank you!');
    });

    it('appends the social block after the custom text', () => {
        const out = buildClosing({ closing: { enabled: true, custom_text: 'Thank you!' }, socialLinks: socials, language: 'en' });
        expect(out).toBe('Thank you!\n\nFollow us:\nFacebook: https://fb.com/rina');
    });

    it('returns the social block alone when custom text is blank', () => {
        const out = buildClosing({ closing: { enabled: true, custom_text: '  ' }, socialLinks: socials, language: 'en' });
        expect(out).toBe('Follow us:\nFacebook: https://fb.com/rina');
    });

    it('returns empty string when enabled but nothing to say', () => {
        expect(buildClosing({ closing: { enabled: true, custom_text: '' }, socialLinks: {}, language: 'en' })).toBe('');
    });
});

describe('ai-messaging · seeded defaults', () => {
    it('ships an enabled greeting + closing with non-empty text', () => {
        expect(DEFAULT_AI_SETTINGS.greeting).toMatchObject({ enabled: true });
        expect(DEFAULT_AI_SETTINGS.greeting.custom_text.trim().length).toBeGreaterThan(0);
        expect(DEFAULT_AI_SETTINGS.closing).toMatchObject({ enabled: true });
        expect(DEFAULT_AI_SETTINGS.closing.custom_text.trim().length).toBeGreaterThan(0);
    });

    it('default greeting/closing pass the settings validator', () => {
        expect(() => validateAISettings({
            greeting: DEFAULT_AI_SETTINGS.greeting,
            closing: DEFAULT_AI_SETTINGS.closing,
        })).not.toThrow();
    });

    it('builds a non-empty greeting from the defaults (disclosure + text, no icon)', () => {
        const out = buildGreeting({ shopName: 'Rina', language: 'mixed', greeting: DEFAULT_AI_SETTINGS.greeting });
        expect(out).not.toContain('🤖');
        expect(out.length).toBeGreaterThan(buildDisclosure('Rina', 'mixed').length);
    });
});
