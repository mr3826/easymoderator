'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { assertProductionConfig } = require('../src/config/production-config.validator');
const { serializeRenderedEnvValue } = require('../src/config/rendered-env');
const { assertValidCanaryEnvironment } = require('../src/modules/channel-providers/meta-discovery-canary');

const RENDER_INPUT_REQUIRED = ['DB_USER', 'DB_PASSWORD', 'DB_NAME'];

function enabledFlag(value) {
    return String(value || '').toLowerCase() === 'true';
}

/**
 * Render a runtime switch that the backend reads as `=== 'true'`. Any value
 * other than the two literals would silently mean "off" at runtime (or, for
 * "TRUE", look on in the repository settings while being off in production),
 * so it fails the render instead. Unset renders the default.
 */
function strictBooleanFlag(value, name, defaultValue) {
    const raw = value === undefined || value === null || value === '' ? defaultValue : String(value);
    if (raw !== 'true' && raw !== 'false') {
        throw new Error(`${name} must be exactly "true" or "false"`);
    }
    return raw;
}

/**
 * ACME_EMAIL must be a single, syntactically valid email address. Caddy would
 * accept almost anything here and Let's Encrypt would silently drop renewal
 * notices sent to a malformed address, so the render fails closed instead —
 * an invalid contact is indistinguishable from no contact once deployed.
 * Empty values are handled by required(); this only validates what is present.
 */
function validAcmeEmail(value) {
    if (!value) return value;
    const trimmed = String(value).trim();
    if (/[\r\n]/.test(trimmed) || !/^[^@\s]+@[^@\s.]+(\.[^@\s.]+)+$/.test(trimmed)) {
        throw new Error('ACME_EMAIL must be a single valid email address (e.g. ops@example.com)');
    }
    return trimmed;
}

/**
 * Register a derived secret with the Actions log scrubber. The transformed key
 * is not itself a GitHub secret, so without this it would not be masked if it
 * ever leaked into a stack trace. No-op outside Actions so a local render never
 * writes a control command to a terminal.
 */
function maskInActions(value, source) {
    if (value && source.GITHUB_ACTIONS === 'true') {
        process.stdout.write(`::add-mask::${value}\n`);
    }
}

/**
 * PAYMENT_ENCRYPTION_KEY compatibility (finding F-01).
 *
 * The runtime derives its AES key as:
 *     /^[a-f0-9]{64}$/i.test(v) ? Buffer.from(v,'hex') : sha256(v)
 * (src/modules/payment/payment-config.entity.js). The production secret is not
 * 64 hex characters, so the effective key today is sha256(secret).
 *
 * The preflight requires 64 hex. Setting a NEW random hex key would satisfy the
 * preflight and silently change the derived key — AES-256-CBC has no auth tag,
 * so every stored merchant credential would decrypt to garbage rather than
 * error. Instead we compute the SAME digest the runtime already computes and
 * write that. The bytes are identical; nothing re-encrypts; the GitHub secret
 * is never modified.
 *
 * A value that is already 64 hex passes through untouched.
 *
 * Follow-up (not this change): a real rotation needs a decrypt-old /
 * re-encrypt-new migration onto AES-256-GCM. Tracked in
 * docs/launch-readiness/2026-07-26-remediation/04_PAYMENT_KEY_COMPATIBILITY.md.
 */
function normalizePaymentEncryptionKey(raw, source = process.env) {
    const value = String(raw ?? '');
    if (!value) return '';
    if (/^[a-f0-9]{64}$/i.test(value)) return value;
    const normalized = crypto.createHash('sha256').update(value).digest('hex');
    maskInActions(normalized, source);
    return normalized;
}

/**
 * Build the full rendered production environment object from a source env.
 * Pure apart from the Actions mask side-effect; never touches the filesystem.
 * Throws if a render input or the production config validator is unsatisfied.
 */
function buildRenderedEnv(source = process.env) {
    const missingRequiredInputs = new Set();
    const required = (name) => {
        const value = source[name] || '';
        if (!value) missingRequiredInputs.add(name);
        return value;
    };
    const requiredOneOf = (names) => {
        const value = names.map(name => source[name] || '').find(Boolean) || '';
        if (!value) names.forEach(name => missingRequiredInputs.add(name));
        return value;
    };
    const marketingUrl = required('MARKETING_URL');
    const appUrl = requiredOneOf(['APP_URL', 'FRONTEND_URL']);
    const apiUrl = requiredOneOf(['API_URL', 'BASE_URL']);
    const publicAssetUrl = requiredOneOf(['PUBLIC_ASSET_URL', 'PUBLIC_BASE_URL', 'API_URL', 'BASE_URL']);

    const missingRenderInputs = RENDER_INPUT_REQUIRED.filter((name) => !source[name]);
    if (missingRenderInputs.length) {
        throw new Error(
            `Missing deployment environment variables: ${missingRenderInputs.sort().join(', ')}`,
        );
    }

    // Provider credentials are only rendered when their provider is on. A
    // disabled gateway must not put merchant credentials into .env.prod at all.
    const bkashSection = enabledFlag(source.BKASH_ENABLED)
        ? {
            BKASH_ENABLED: 'true',
            BKASH_BASE_URL: required('BKASH_BASE_URL'),
            BKASH_USERNAME: required('BKASH_USERNAME'),
            BKASH_PASSWORD: required('BKASH_PASSWORD'),
            BKASH_APP_KEY: required('BKASH_APP_KEY'),
            BKASH_APP_SECRET: required('BKASH_APP_SECRET'),
            BKASH_WEBHOOK_SECRET: required('BKASH_WEBHOOK_SECRET'),
            BKASH_SANDBOX: source.BKASH_SANDBOX || 'false',
        }
        : { BKASH_ENABLED: 'false' };

    // Telegram is an optional integration. Facebook/Messenger is the launch
    // path, so an unset flag must not turn a historical Telegram credential
    // requirement into a production cutover blocker. When explicitly enabled,
    // fail closed until all three Telegram values are supplied.
    const telegramSection = enabledFlag(source.TELEGRAM_ENABLED)
        ? {
            TELEGRAM_ENABLED: 'true',
            TELEGRAM_BOT_TOKEN: required('TELEGRAM_BOT_TOKEN'),
            TELEGRAM_BOT_USERNAME: required('TELEGRAM_BOT_USERNAME'),
            TELEGRAM_WEBHOOK_SECRET: required('TELEGRAM_WEBHOOK_SECRET'),
        }
        : { TELEGRAM_ENABLED: 'false' };

    const rendered = {
        NODE_ENV: 'production',
        PORT: source.PORT || '3000',
        LOG_LEVEL: source.LOG_LEVEL || 'info',
        DATABASE_URL: `postgresql://${encodeURIComponent(required('DB_USER'))}:${encodeURIComponent(required('DB_PASSWORD'))}@postgres:5432/${encodeURIComponent(required('DB_NAME'))}`,
        DB_USER: required('DB_USER'),
        DB_PASSWORD: required('DB_PASSWORD'),
        DB_NAME: required('DB_NAME'),
        POSTGRES_USER: required('DB_USER'),
        POSTGRES_PASSWORD: required('DB_PASSWORD'),
        POSTGRES_DB: required('DB_NAME'),
        REDIS_URL: source.REDIS_URL || 'redis://redis:6379',
        ...(source.REDIS_QUEUE_DB ? { REDIS_QUEUE_DB: source.REDIS_QUEUE_DB } : {}),
        REDIS_HOST: 'redis',
        REDIS_PORT: '6379',
        DB_SSL: source.DB_SSL || 'false',
        JWT_ACCESS_SECRET: required('JWT_ACCESS_SECRET'),
        JWT_REFRESH_SECRET: required('JWT_REFRESH_SECRET'),
        JWT_ACCESS_EXPIRES_IN: source.JWT_ACCESS_EXPIRES_IN || '1d',
        JWT_REFRESH_EXPIRES_IN: source.JWT_REFRESH_EXPIRES_IN || '30d',
        SESSION_SECRET: required('SESSION_SECRET'),
        CSRF_SECRET: required('CSRF_SECRET'),
        PAYMENT_ENCRYPTION_KEY: normalizePaymentEncryptionKey(source.PAYMENT_ENCRYPTION_KEY, source),
        DELIVERY_ENCRYPTION_KEY: required('DELIVERY_ENCRYPTION_KEY'),
        REDX_WEBHOOK_SECRET: required('REDX_WEBHOOK_SECRET'),
        REDX_REQUEST_TIMEOUT_MS: source.REDX_REQUEST_TIMEOUT_MS || '10000',
        CHANNEL_ENCRYPTION_KEY: required('CHANNEL_ENCRYPTION_KEY'),
        ...(source.CHANNEL_ENCRYPTION_KEY_PREVIOUS
            ? { CHANNEL_ENCRYPTION_KEY_PREVIOUS: source.CHANNEL_ENCRYPTION_KEY_PREVIOUS }
            : {}),
        PAYMENT_CALLBACK_HMAC_SECRET: required('PAYMENT_CALLBACK_HMAC_SECRET'),
        AI_ACTION_GATE_SECRET: required('AI_ACTION_GATE_SECRET'),
        MARKETING_URL: marketingUrl,
        APP_URL: appUrl,
        API_URL: apiUrl,
        PUBLIC_ASSET_URL: publicAssetUrl,
        CORS_ORIGINS: required('CORS_ORIGINS'),
        FRONTEND_URL: appUrl,
        BASE_URL: apiUrl,
        PUBLIC_BASE_URL: publicAssetUrl,
        ...(source.COOKIE_DOMAIN ? { COOKIE_DOMAIN: source.COOKIE_DOMAIN } : {}),
        ...(source.LEGACY_COOKIE_DOMAIN ? { LEGACY_COOKIE_DOMAIN: source.LEGACY_COOKIE_DOMAIN } : {}),
        META_OAUTH_REDIRECT_URI: required('META_OAUTH_REDIRECT_URI'),
        META_APP_ID: required('META_APP_ID'),
        META_APP_SECRET: required('META_APP_SECRET'),
        // Facebook Login for Business configuration ID. Public, but
        // environment-specific — rendered from the repository variable so a
        // deployment can never inherit a developer's configuration.
        META_LOGIN_CONFIG_ID: required('META_LOGIN_CONFIG_ID'),
        META_WEBHOOK_VERIFY_TOKEN: required('META_WEBHOOK_VERIFY_TOKEN'),
        META_DISCOVERY_CANARY_ENABLED: strictBooleanFlag(
            source.META_DISCOVERY_CANARY_ENABLED,
            'META_DISCOVERY_CANARY_ENABLED',
            'false',
        ),
        META_DISCOVERY_CANARY_SHOP_ID: source.META_DISCOVERY_CANARY_SHOP_ID || '',
        META_DISCOVERY_CANARY_PAGE_ID: source.META_DISCOVERY_CANARY_PAGE_ID || '',
        META_DISCOVERY_CANARY_EXPIRES_AT: source.META_DISCOVERY_CANARY_EXPIRES_AT || '',
        META_USER_PROFILE_ENABLED: source.META_USER_PROFILE_ENABLED || 'false',
        ...bkashSection,
        ...telegramSection,
        OPENAI_API_KEY: source.OPENAI_API_KEY || '',
        GEMINI_API_KEY: source.GEMINI_API_KEY || '',
        GOOGLE_GEMINI_API_KEY: source.GEMINI_API_KEY || '',
        // Image understanding. Customer-photo product matching is opt-in; the
        // production default stays off until provider terms and owner approval
        // are documented. The strict allowlist makes malformed values fail the
        // deployment render instead of silently enabling or disabling a path.
        AI_PHOTO_MATCH_ENABLED: strictBooleanFlag(source.AI_PHOTO_MATCH_ENABLED, 'AI_PHOTO_MATCH_ENABLED', 'false'),
        AI_VISION_ENABLED: source.AI_VISION_ENABLED || 'false',
        // Growth OS remains authorization-gated, but it must still be explicitly
        // enabled by the production operator. A missing repository variable
        // must not turn on a new internal surface during an unrelated deploy.
        GROWTH_OS_ENABLED: strictBooleanFlag(source.GROWTH_OS_ENABLED, 'GROWTH_OS_ENABLED', 'false'),
        DOMAIN_AGENT_RUNTIME_ENABLED: strictBooleanFlag(source.DOMAIN_AGENT_RUNTIME_ENABLED, 'DOMAIN_AGENT_RUNTIME_ENABLED', 'false'),
        AI_ORDER_MUTATIONS_ENABLED: strictBooleanFlag(source.AI_ORDER_MUTATIONS_ENABLED, 'AI_ORDER_MUTATIONS_ENABLED', 'false'),
        AI_COURIER_BOOKING_ENABLED: strictBooleanFlag(source.AI_COURIER_BOOKING_ENABLED, 'AI_COURIER_BOOKING_ENABLED', 'false'),
        AI_PAYMENT_ACCEPTANCE_ENABLED: strictBooleanFlag(source.AI_PAYMENT_ACCEPTANCE_ENABLED, 'AI_PAYMENT_ACCEPTANCE_ENABLED', 'false'),
        AI_SUPPORT_CASE_ENABLED: strictBooleanFlag(source.AI_SUPPORT_CASE_ENABLED, 'AI_SUPPORT_CASE_ENABLED', 'false'),
        // Mobile API (ADR M-010): /api/auth/native/*, /api/mobile/* and every
        // native (sid) token. Off unless the MOBILE_API_ENABLED repository
        // variable is exactly "true"; rollback is setting it back to "false"
        // and redeploying (docs/deployment/MOBILE_API_ACTIVATION_RUNBOOK.md). The Wave 3
        // MOBILE_* switches are deliberately not rendered, so no repository
        // setting can turn them on in production.
        MOBILE_API_ENABLED: strictBooleanFlag(source.MOBILE_API_ENABLED, 'MOBILE_API_ENABLED', 'false'),
        EMBEDDING_PROVIDER: source.EMBEDDING_PROVIDER || '',
        EMBEDDING_MODEL: source.EMBEDDING_MODEL || '',
        OPENAI_EMBEDDING_MODEL: source.OPENAI_EMBEDDING_MODEL || '',
        GEMINI_EMBEDDING_MODEL: source.GEMINI_EMBEDDING_MODEL || '',
        EMBEDDING_SPACE_VERSION: source.EMBEDDING_SPACE_VERSION || '',
        GEMINI_EMBEDDING_SPACE_VERSION: source.GEMINI_EMBEDDING_SPACE_VERSION || '',
        OPENAI_EMBEDDING_SPACE_VERSION: source.OPENAI_EMBEDDING_SPACE_VERSION || '',
        QDRANT_URL: source.QDRANT_URL || 'http://qdrant:6333',
        QDRANT_API_KEY: source.QDRANT_API_KEY || '',
        QDRANT_COLLECTION: source.QDRANT_COLLECTION || '',
        QDRANT_FALLBACK_COLLECTION: source.QDRANT_FALLBACK_COLLECTION || '',
        QDRANT_VECTOR_SIZE: source.QDRANT_VECTOR_SIZE || '384',
        SENTRY_DSN: source.SENTRY_DSN || '',
        SLACK_ALERT_WEBHOOK_URL: source.SLACK_ALERT_WEBHOOK_URL || '',
        RESEND_API_KEY: required('RESEND_API_KEY'),
        EMAIL_FROM: required('EMAIL_FROM'),
        // Caddy's Let's Encrypt account contact (Caddyfile `email {$ACME_EMAIL}`
        // via docker-compose.prod.yml). Rendered from the ACME_EMAIL repository
        // variable so no real address is committed; a missing or malformed value
        // fails the render — and therefore the deployment — before the host is
        // ever touched. An empty ACME contact silently loses renewal-failure
        // notices (2026-11-13 audit finding).
        ACME_EMAIL: validAcmeEmail(required('ACME_EMAIL')),
        SEED_ADMIN_EMAIL: source.SEED_ADMIN_EMAIL || 'admin@easymod.tech',
        SEED_ADMIN_PASSWORD: source.SEED_ADMIN_PASSWORD || '',
        SEED_ADMIN_NAME: source.SEED_ADMIN_NAME || 'EasyMod Admin',
        SEED_ADMIN_PHONE: source.SEED_ADMIN_PHONE || '01700000000',
        SEED_ADMIN_SHOP: source.SEED_ADMIN_SHOP || 'EasyModerator Review Shop',
        SEED_ADMIN_PLATFORM_ROLE: 'SUPER_ADMIN',
        SEED_ADMIN_PAID_MONTHS: '12',
        ALLOW_SELF_SIGNED_TLS: source.ALLOW_SELF_SIGNED_TLS || 'false',
        BODY_SIZE_LIMIT: source.BODY_SIZE_LIMIT || '35mb',
        PRODUCT_IMAGE_QUOTA_BYTES: source.PRODUCT_IMAGE_QUOTA_BYTES || '104857600',
        MEDIA_FETCH_ALLOWED_HOSTS: source.MEDIA_FETCH_ALLOWED_HOSTS || '',
        START_EMBEDDED_WORKERS: 'false',
        RUN_MIGRATIONS_ON_STARTUP: 'false',
        MAX_LOGIN_ATTEMPTS: '5',
        LOGIN_LOCKOUT_MINUTES: '15',
    };

    const missingInputs = [...new Set([
        ...missingRenderInputs,
        ...missingRequiredInputs,
    ])].sort();
    if (missingInputs.length) {
        throw new Error(`Missing deployment environment variables: ${missingInputs.join(', ')}`);
    }

    assertValidCanaryEnvironment(rendered);

    // Fail before writing anything if the config is unsafe.
    assertProductionConfig(rendered);
    return rendered;
}

function renderToFile(outputPath, source = process.env) {
    const rendered = buildRenderedEnv(source);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(
        outputPath,
        `${Object.entries(rendered).map(([name, value]) => `${name}=${serializeRenderedEnvValue(value, name)}`).join('\n')}\n`,
        { mode: 0o600 },
    );
    return rendered;
}

module.exports = {
    buildRenderedEnv,
    normalizePaymentEncryptionKey,
    validAcmeEmail,
    renderToFile,
    RENDER_INPUT_REQUIRED,
};

// CLI entry point — only runs when invoked directly, so tests can import the
// pure functions without triggering a file write or a process-wide throw.
if (require.main === module) {
    const outputPath = path.resolve(process.argv[2] || '.env.prod');
    const rendered = renderToFile(outputPath, process.env);
    // Never print the values — count only.
    console.log(`Production environment preflight passed (${Object.keys(rendered).length} variables rendered).`);
}
