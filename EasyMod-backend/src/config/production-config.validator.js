'use strict';

const crypto = require('crypto');

const CORE_REQUIRED = [
    'DATABASE_URL',
    'REDIS_URL',
    'JWT_ACCESS_SECRET',
    'JWT_REFRESH_SECRET',
    'SESSION_SECRET',
    'CSRF_SECRET',
    'CORS_ORIGINS',
    'MARKETING_URL',
    'APP_URL',
    'API_URL',
    'PUBLIC_ASSET_URL',
    'FRONTEND_URL',
    'BASE_URL',
    'META_APP_ID',
    'META_APP_SECRET',
    'META_WEBHOOK_VERIFY_TOKEN',
    'META_OAUTH_REDIRECT_URI',
    // Facebook Login for Business is configuration-driven. Without this the
    // authorization dialog silently falls back to the classic-Login contract
    // Meta no longer honours for this app, which merchants see only as an
    // opaque "Feature unavailable" screen. Required so that drift between the
    // Meta dashboard and this deployment fails the deploy, not the merchant.
    // See docs/incidents/2026-09-22-meta-login-unavailable.md.
    'META_LOGIN_CONFIG_ID',
    'PAYMENT_ENCRYPTION_KEY',
    'DELIVERY_ENCRYPTION_KEY',
    'CHANNEL_ENCRYPTION_KEY',
    'PAYMENT_CALLBACK_HMAC_SECRET',
    'AI_ACTION_GATE_SECRET',
    // BKASH_WEBHOOK_SECRET is deliberately NOT core. It only guards the bKash
    // callback route, which is unreachable while the gateway is disabled, and
    // requiring it unconditionally pressures an operator into inventing a fake
    // credential to make the deploy pass. It is required with the rest of the
    // bKash set below whenever BKASH_ENABLED=true.
    //
    // POSTURE NOTE (Payment redesign §7 row 9, A0): after the §4.2 rewrite this
    // secret guards a DEPLOYMENT SHARED-SECRET TRANSPORT GATE inside
    // webhook.middleware.js (constant-time, 503 fail-closed when unset) — it is
    // NOT a provider signature scheme (the old "B1/B17 provider-signature"
    // claim was invented and is deleted). The callback body is a TRIGGER only:
    // settlement always requires the server-side Tokenized-v2 Query, so no
    // amount of webhook-secret strength is ever trusted as payment evidence.
    // Requirement semantics are unchanged (required iff BKASH_ENABLED=true) —
    // no new env var was introduced and existing pins stay authoritative.
    'RESEND_API_KEY',
    'EMAIL_FROM',
];
const BKASH_REQUIRED = [
    'BKASH_BASE_URL',
    'BKASH_USERNAME',
    'BKASH_PASSWORD',
    'BKASH_APP_KEY',
    'BKASH_APP_SECRET',
    'BKASH_WEBHOOK_SECRET',
    'BKASH_SANDBOX',
];
const TELEGRAM_REQUIRED = [
    'TELEGRAM_BOT_TOKEN',
    'TELEGRAM_BOT_USERNAME',
    'TELEGRAM_WEBHOOK_SECRET',
];
const LONG_SECRETS = [
    'JWT_ACCESS_SECRET',
    'JWT_REFRESH_SECRET',
    'SESSION_SECRET',
    'CSRF_SECRET',
    'META_APP_SECRET',
    'META_WEBHOOK_VERIFY_TOKEN',
    'PAYMENT_CALLBACK_HMAC_SECRET',
    'AI_ACTION_GATE_SECRET',
    'BKASH_WEBHOOK_SECRET',
    'TELEGRAM_WEBHOOK_SECRET',
];
const ENCRYPTION_KEYS = [
    'PAYMENT_ENCRYPTION_KEY',
    'DELIVERY_ENCRYPTION_KEY',
    'CHANNEL_ENCRYPTION_KEY',
];

function enabled(value) {
    return String(value || '').toLowerCase() === 'true';
}

function isPlaceholder(value) {
    const normalized = String(value || '').toLowerCase();
    return !normalized
        || normalized.includes('change_me')
        || normalized.includes('change-me')
        || normalized.includes('change_in_production')
        || normalized.includes('change-in-production')
        || normalized.includes('replace_me')
        || normalized.includes('replace-me')
        || normalized.includes('placeholder')
        || normalized.startsWith('your-')
        || normalized.startsWith('your_')
        || normalized === 'db_url'
        || normalized.includes('example')
        || normalized === 'secret';
}

function validateProductionConfig(env = process.env) {
    if (!['production', 'staging'].includes(env.NODE_ENV)) {
        return { valid: true, missing: [], invalid: [], requirements: [] };
    }

    const requirements = [...CORE_REQUIRED];
    if (enabled(env.BKASH_ENABLED)) requirements.push(...BKASH_REQUIRED);
    const telegramConfigured = enabled(env.TELEGRAM_ENABLED)
        || TELEGRAM_REQUIRED.some((name) => Boolean(env[name]));
    if (telegramConfigured) requirements.push(...TELEGRAM_REQUIRED);

    const uniqueRequirements = [...new Set(requirements)];
    const missing = uniqueRequirements.filter((name) => !env[name]);
    const invalid = [];

    for (const name of uniqueRequirements) {
        if (env[name] && isPlaceholder(env[name])) invalid.push(name);
    }
    for (const name of LONG_SECRETS) {
        if (env[name] && (env[name].length < 32 || isPlaceholder(env[name]))) {
            invalid.push(name);
        }
    }
    for (const name of ENCRYPTION_KEYS) {
        if (env[name] && !/^[a-f0-9]{64}$/i.test(env[name])) invalid.push(name);
    }
    const originNames = [
        'MARKETING_URL',
        'APP_URL',
        'API_URL',
        'PUBLIC_ASSET_URL',
        'PUBLIC_BASE_URL',
        'FRONTEND_URL',
        'BASE_URL',
    ];
    for (const name of [...originNames, 'META_OAUTH_REDIRECT_URI']) {
        if (!env[name]) continue;
        try {
            const parsed = new URL(env[name]);
            if (parsed.protocol !== 'https:') invalid.push(name);
            if (originNames.includes(name)
                && (parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password)) {
                invalid.push(name);
            }
        } catch (_) {
            invalid.push(name);
        }
    }
    if (env.APP_URL && env.FRONTEND_URL && env.APP_URL !== env.FRONTEND_URL) {
        invalid.push('FRONTEND_URL');
    }
    if (env.API_URL && env.BASE_URL && env.API_URL !== env.BASE_URL) {
        invalid.push('BASE_URL');
    }
    if (env.PUBLIC_ASSET_URL && env.PUBLIC_BASE_URL
        && env.PUBLIC_ASSET_URL !== env.PUBLIC_BASE_URL) {
        invalid.push('PUBLIC_BASE_URL');
    }
    if (env.MARKETING_URL && env.APP_URL && env.MARKETING_URL === env.APP_URL) {
        invalid.push('APP_URL');
    }
    if (env.APP_URL && env.API_URL && env.APP_URL === env.API_URL) {
        invalid.push('API_URL');
    }
    if (env.APP_URL && env.META_OAUTH_REDIRECT_URI) {
        try {
            const callback = new URL(env.META_OAUTH_REDIRECT_URI);
            if (callback.origin !== new URL(env.APP_URL).origin
                || callback.pathname !== '/channels/oauth-callback') {
                invalid.push('META_OAUTH_REDIRECT_URI');
            }
        } catch (_) {
            invalid.push('META_OAUTH_REDIRECT_URI');
        }
    }
    if (env.APP_URL && env.CORS_ORIGINS) {
        const allowedOrigins = env.CORS_ORIGINS.split(',').map((value) => value.trim());
        if (!allowedOrigins.includes(env.APP_URL)) invalid.push('CORS_ORIGINS');
        // The marketing site is deliberately excluded from the global
        // credentialed allowlist. Its public endpoints use route-local CORS.
        if (env.MARKETING_URL && allowedOrigins.includes(env.MARKETING_URL)) invalid.push('CORS_ORIGINS');
        if (allowedOrigins.includes('*')) invalid.push('CORS_ORIGINS');
        if (enabled(env.GROWTH_OS_ENABLED)
            && !allowedOrigins.includes(env.GROWTH_APP_URL || 'https://growth.easymod.tech')) {
            invalid.push('CORS_ORIGINS');
        }
    }
    // Meta Login Configuration IDs are numeric. A transposed, quoted or
    // partially-pasted value is accepted by nothing downstream and would only
    // show up as a broken login dialog in production.
    // The same shape is enforced at runtime by LOGIN_CONFIG_ID_PATTERN in
    // MetaMessengerProvider.js and by the readiness preflight. It is repeated
    // rather than shared because this validator is imported by
    // render-production-env.js, which must not pull in the provider's axios and
    // Redis dependencies; keep the three in step.
    if (env.META_LOGIN_CONFIG_ID && !/^[0-9]{6,32}$/.test(env.META_LOGIN_CONFIG_ID.trim())) {
        invalid.push('META_LOGIN_CONFIG_ID');
    }
    // The canonical app/API split does not need parent-domain cookies. Keeping
    // auth cookies host-only to api.easymod.tech limits cross-subdomain impact.
    if (env.COOKIE_DOMAIN) invalid.push('COOKIE_DOMAIN');
    if (env.GROWTH_OS_ENABLED !== undefined
        && !['true', 'false'].includes(String(env.GROWTH_OS_ENABLED))) {
        invalid.push('GROWTH_OS_ENABLED');
    }
    if (env.BKASH_SANDBOX && !['true', 'false'].includes(env.BKASH_SANDBOX)) {
        invalid.push('BKASH_SANDBOX');
    }
    if (enabled(env.BKASH_ENABLED) && env.BKASH_SANDBOX !== 'false') {
        invalid.push('BKASH_SANDBOX');
    }
    // config.js reads the mobile API switch as `=== 'true'`. Refuse anything
    // else so a production deploy never boots in a state the operator did not
    // actually choose (ADR M-010).
    if (env.MOBILE_API_ENABLED !== undefined && !['true', 'false'].includes(env.MOBILE_API_ENABLED)) {
        invalid.push('MOBILE_API_ENABLED');
    }
    // The device-E2E fixture controls reset shops and sessions. They already
    // refuse to register outside NODE_ENV=test; a deployed environment that
    // carries either setting is misconfigured and must not boot.
    for (const name of ['MOBILE_E2E_FIXTURES_ENABLED', 'MOBILE_E2E_FIXTURES_TOKEN']) {
        if (env[name] !== undefined) invalid.push(name);
    }
    if (!env.SENTRY_DSN && !env.SLACK_ALERT_WEBHOOK_URL) {
        missing.push('SENTRY_DSN|SLACK_ALERT_WEBHOOK_URL');
    }
    if (!env.OPENAI_API_KEY && !env.GEMINI_API_KEY) {
        missing.push('OPENAI_API_KEY|GEMINI_API_KEY');
    }

    // Exercise all three AES keys without exposing them.
    for (const name of ENCRYPTION_KEYS) {
        if (!env[name] || invalid.includes(name)) continue;
        try {
            const key = Buffer.from(env[name], 'hex');
            const cipher = crypto.createCipheriv('aes-256-gcm', key, Buffer.alloc(12));
            cipher.update('preflight');
            cipher.final();
        } catch (_) {
            invalid.push(name);
        }
    }

    return {
        valid: missing.length === 0 && invalid.length === 0,
        missing: [...new Set(missing)].sort(),
        invalid: [...new Set(invalid)].sort(),
        requirements: uniqueRequirements.sort(),
    };
}

function assertProductionConfig(env = process.env) {
    const result = validateProductionConfig(env);
    if (!result.valid) {
        const parts = [];
        if (result.missing.length) parts.push(`missing: ${result.missing.join(', ')}`);
        if (result.invalid.length) parts.push(`invalid: ${result.invalid.join(', ')}`);
        throw new Error(`Unsafe production configuration (${parts.join('; ')})`);
    }
    return result;
}

module.exports = {
    assertProductionConfig,
    validateProductionConfig,
    _private: {
        BKASH_REQUIRED,
        CORE_REQUIRED,
        ENCRYPTION_KEYS,
        TELEGRAM_REQUIRED,
        enabled,
        isPlaceholder,
    },
};
