'use strict';

/**
 * AI customer-message builders — pure, dependency-free.
 *
 * Three owner-configurable touches woven into the live AI reply pipeline:
 *   - Greeting: an auto-sent welcome on the FIRST AI reply of a conversation,
 *     carrying a fixed Meta AI-disclosure identifier the owner writes around.
 *   - Closing: a thank-you (+ launch-approved "follow us" links) appended to the order
 *     confirmation message.
 *   - Social block: the rendered list of the shop's social links.
 *
 * Kept pure so the wiring in message-worker / order-session stays thin and the
 * behaviour is fully unit-tested here. See
 * docs/superpowers/specs/2026-06-25-greeting-closing-social-design.md.
 */

const GENERIC_SHOP = { en: 'our shop', bn: 'আমাদের দোকান', mixed: 'amader shop' };

// Mandatory, owner-uneditable AI-disclosure (Meta Platform Policy — customers
// must know an automated system is replying). Clear TEXT, no icon. The owner's
// custom greeting text, if any, is appended AFTER this line.
const DISCLOSURE = {
    en: (shop) => `Hi, I'm the AI assistant from ${shop}.`,
    bn: (shop) => `হাই, আমি ${shop}-এর AI সহকারী।`,
    mixed: (shop) => `Hi, ami ${shop}-er AI assistant.`,
};

// Stable launch render order + display labels for the social-links block.
// Stored legacy links are ignored here to keep customer-facing messages aligned
// with the Messenger-only BD private-launch scope.
const SOCIAL_ORDER = [
    ['facebook', 'Facebook'],
    ['website', 'Website'],
];

const SOCIAL_HEADER = { en: 'Follow us:', bn: 'আমাদের ফলো করুন:', mixed: 'আমাদের ফলো করুন:' };

const resolveLang = (language) => (language === 'en' || language === 'bn' ? language : 'mixed');

/**
 * The static AI-disclosure identifier for a shop, in the reply language.
 * @param {string} shopName
 * @param {string} [language] - 'en' | 'bn' | 'mixed' (default mixed)
 * @returns {string}
 */
const buildDisclosure = (shopName, language) => {
    const lang = resolveLang(language);
    const shop = (shopName || '').trim() || GENERIC_SHOP[lang];
    return DISCLOSURE[lang](shop);
};

/**
 * The greeting prepended to the first AI reply: the MANDATORY AI-disclosure +
 * the owner's optional custom welcome text. The disclaimer is always present
 * (Meta compliance) — there is no on/off toggle for it; only the custom text is
 * owner-controlled.
 * @param {{shopName?:string, language?:string, greeting?:{custom_text?:string}}} params
 * @returns {string}
 */
const buildGreeting = ({ shopName, language, greeting } = {}) => {
    const disclosure = buildDisclosure(shopName, language);
    // ADR-0013: greeting.enabled (business default or channel override) controls
    // the owner's custom welcome only. The AI disclosure is mandatory (Meta
    // compliance) and is always present.
    if (greeting?.enabled === false) return disclosure;
    const custom = (greeting?.custom_text || '').trim();
    return custom ? `${disclosure}\n\n${custom}` : disclosure;
};

/**
 * Render the shop's social links (only the filled ones, stable order) under a
 * localized "Follow us:" header. Returns '' when nothing is set.
 * @param {Record<string,string>|null|undefined} socialLinks
 * @param {string} [language]
 * @returns {string}
 */
const renderSocialLinks = (socialLinks, language) => {
    if (!socialLinks || typeof socialLinks !== 'object') return '';
    const lines = [];
    for (const [key, label] of SOCIAL_ORDER) {
        const value = (socialLinks[key] || '').trim();
        if (value) lines.push(`${label}: ${value}`);
    }
    if (lines.length === 0) return '';
    return `${SOCIAL_HEADER[resolveLang(language)]}\n${lines.join('\n')}`;
};

/**
 * The closing appended to the order-confirmation message: owner custom text +
 * the social block (only if links are set). Returns '' when disabled or empty.
 * @param {{closing?:{enabled?:boolean, custom_text?:string}, socialLinks?:object, language?:string}} params
 * @returns {string}
 */
const buildClosing = ({ closing, socialLinks, language } = {}) => {
    if (!closing || closing.enabled === false) return '';
    const custom = (closing.custom_text || '').trim();
    const social = renderSocialLinks(socialLinks, language);
    return [custom, social].filter(Boolean).join('\n\n');
};

module.exports = { buildDisclosure, buildGreeting, renderSocialLinks, buildClosing };
