'use strict';

/**
 * Deployment render + preflight matrix (findings F-01, provider config, §10).
 *
 * Exercises the pure builder rather than the CLI so no file is written and no
 * value is printed. Proves:
 *   - PAYMENT_ENCRYPTION_KEY legacy/hex/missing handling preserves the runtime
 *     AES key and never emits the raw value.
 *   - bKash credentials are required only when enabled, and never rendered when
 *     disabled.
 *   - Telegram remains disabled unless explicitly enabled, and its credentials
 *     are required only for that opt-in integration.
 *   - Core secrets, alert sink, empty and placeholder values all fail closed.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    buildRenderedEnv,
    normalizePaymentEncryptionKey,
    validAcmeEmail,
    renderToFile,
} = require('../render-production-env');

const hex64 = (letter) => letter.repeat(64);

/** A raw GitHub-secret-style source env that renders to a valid production config. */
function validSource(overrides = {}) {
    return {
        // render inputs
        DB_USER: 'easymod_user',
        DB_PASSWORD: 'a-strong-db-password',
        DB_NAME: 'easymod',
        // core secrets
        JWT_ACCESS_SECRET: hex64('a'),
        JWT_REFRESH_SECRET: hex64('b'),
        SESSION_SECRET: hex64('c'),
        CSRF_SECRET: hex64('d'),
        PAYMENT_ENCRYPTION_KEY: 'legacy-non-hex-payment-key-value',
        DELIVERY_ENCRYPTION_KEY: hex64('2'),
        REDX_WEBHOOK_SECRET: hex64('r'),
        CHANNEL_ENCRYPTION_KEY: hex64('3'),
        PAYMENT_CALLBACK_HMAC_SECRET: hex64('g'),
        AI_ACTION_GATE_SECRET: hex64('i'),
        MARKETING_URL: 'https://easymod.tech',
        APP_URL: 'https://app.easymod.tech',
        API_URL: 'https://api.easymod.tech',
        PUBLIC_ASSET_URL: 'https://api.easymod.tech',
        CORS_ORIGINS: 'https://app.easymod.tech',
        FRONTEND_URL: 'https://app.easymod.tech',
        BASE_URL: 'https://api.easymod.tech',
        META_OAUTH_REDIRECT_URI: 'https://app.easymod.tech/channels/oauth-callback',
        META_LOGIN_CONFIG_ID: '1685388446490514',
        META_APP_ID: '1234567890',
        META_APP_SECRET: hex64('e'),
        META_WEBHOOK_VERIFY_TOKEN: hex64('f'),
        RESEND_API_KEY: 're_live_key',
        EMAIL_FROM: 'EasyModerator <no-reply@easymod.tech>',
        ACME_EMAIL: 'ops@example.com',
        SENTRY_DSN: 'https://public@example.ingest.sentry.io/1',
        OPENAI_API_KEY: 'sk-openai-test',
        // keep optional providers off so the fixture stays minimal
        BKASH_ENABLED: 'false',
        TELEGRAM_ENABLED: 'false',
        ...overrides,
    };
}

describe('PAYMENT_ENCRYPTION_KEY normalization (F-01)', () => {
    test('a legacy non-hex value renders as its sha256 digest — the runtime AES key is preserved', () => {
        const raw = 'legacy-non-hex-payment-key-value';
        const rendered = buildRenderedEnv(validSource({ PAYMENT_ENCRYPTION_KEY: raw }));

        const expected = crypto.createHash('sha256').update(raw).digest('hex');
        expect(rendered.PAYMENT_ENCRYPTION_KEY).toBe(expected);
        expect(rendered.PAYMENT_ENCRYPTION_KEY).toMatch(/^[a-f0-9]{64}$/);
    });

    test('the raw legacy value never appears in the rendered output', () => {
        const raw = 'legacy-non-hex-payment-key-value';
        const rendered = buildRenderedEnv(validSource({ PAYMENT_ENCRYPTION_KEY: raw }));
        expect(JSON.stringify(rendered)).not.toContain(raw);
    });

    test('an already-64-hex value passes through unchanged (no double hashing)', () => {
        const hex = hex64('1');
        const rendered = buildRenderedEnv(validSource({ PAYMENT_ENCRYPTION_KEY: hex }));
        expect(rendered.PAYMENT_ENCRYPTION_KEY).toBe(hex);
    });

    test('the normalized digest matches the runtime key derivation exactly', () => {
        // Mirror src/modules/payment/payment-config.entity.js#getEncryptionKey.
        const raw = 'some other legacy value';
        const runtimeKey = /^[a-f0-9]{64}$/i.test(raw)
            ? Buffer.from(raw, 'hex')
            : crypto.createHash('sha256').update(raw).digest();
        const normalized = normalizePaymentEncryptionKey(raw, {});
        expect(Buffer.from(normalized, 'hex').equals(runtimeKey)).toBe(true);
    });

    test('a missing payment key fails the preflight', () => {
        expect(() => buildRenderedEnv(validSource({ PAYMENT_ENCRYPTION_KEY: '' })))
            .toThrow(/PAYMENT_ENCRYPTION_KEY/);
    });
});

describe('Docker production env-file serialization', () => {
    test('passes an optional previous channel-encryption key for rotation', () => {
        const rendered = buildRenderedEnv(validSource({
            CHANNEL_ENCRYPTION_KEY_PREVIOUS: hex64('4'),
        }));
        expect(rendered.CHANNEL_ENCRYPTION_KEY_PREVIOUS).toBe(hex64('4'));
    });

    test('passes the optional dedicated Redis queue database', () => {
        const rendered = buildRenderedEnv(validSource({ REDIS_QUEUE_DB: '13' }));
        expect(rendered.REDIS_QUEUE_DB).toBe('13');
    });

    test('writes raw KEY=value lines instead of literal JSON quote delimiters', async () => {
        const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'easymod-env-'));
        const outputPath = path.join(tempDir, '.env.prod');

        try {
            renderToFile(outputPath, validSource());
            const content = await fs.promises.readFile(outputPath, 'utf8');

            expect(content).toContain('API_URL=https://api.easymod.tech');
            expect(content).toContain('EMAIL_FROM=EasyModerator <no-reply@easymod.tech>');
            expect(content).not.toContain('API_URL="https://api.easymod.tech"');
        } finally {
            await fs.promises.rm(tempDir, { recursive: true, force: true });
        }
    });

    test('rejects newline-containing values before writing an env file', async () => {
        const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'easymod-env-'));
        const outputPath = path.join(tempDir, '.env.prod');

        try {
            expect(() => renderToFile(outputPath, validSource({ EMAIL_FROM: 'bad\nvalue' })))
                .toThrow(/EMAIL_FROM cannot contain newlines/);
        } finally {
            await fs.promises.rm(tempDir, { recursive: true, force: true });
        }
    });
});

describe('ACME_EMAIL (Caddy Let\'s Encrypt contact)', () => {
    test('renders the configured contact address', () => {
        const rendered = buildRenderedEnv(validSource({ ACME_EMAIL: ' ops@example.com ' }));
        expect(rendered.ACME_EMAIL).toBe('ops@example.com');
    });

    test('a missing ACME_EMAIL fails the render before deployment', () => {
        expect(() => buildRenderedEnv(validSource({ ACME_EMAIL: '' })))
            .toThrow(/ACME_EMAIL/);
    });

    test('a malformed ACME_EMAIL fails the render — an invalid contact is as silent as none', () => {
        for (const bad of ['not-an-email', 'ops@', '@example.com', 'ops @example.com', 'ops@example', 'bad\nvalue@example.com']) {
            expect(() => buildRenderedEnv(validSource({ ACME_EMAIL: bad })))
                .toThrow(/ACME_EMAIL must be a single valid email address/);
        }
    });

    test('validAcmeEmail trims valid addresses and passes through empty for required() to catch', () => {
        expect(validAcmeEmail('  acme+tls@easymod.tech ')).toBe('acme+tls@easymod.tech');
        expect(validAcmeEmail('')).toBe('');
    });
});

describe('Meta discovery canary environment gate', () => {
    test('renders the canary disabled with empty shop, Page and expiry by default', () => {
        const rendered = buildRenderedEnv(validSource());

        expect(rendered.META_DISCOVERY_CANARY_ENABLED).toBe('false');
        expect(rendered.META_DISCOVERY_CANARY_SHOP_ID).toBe('');
        expect(rendered.META_DISCOVERY_CANARY_PAGE_ID).toBe('');
        expect(rendered.META_DISCOVERY_CANARY_EXPIRES_AT).toBe('');
    });

    test('renders an explicitly configured, time-bounded canary without secrets', () => {
        const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
        const rendered = buildRenderedEnv(validSource({
            META_DISCOVERY_CANARY_ENABLED: 'true',
            META_DISCOVERY_CANARY_SHOP_ID: 'shop-kutir',
            META_DISCOVERY_CANARY_PAGE_ID: '1362174360316889',
            META_DISCOVERY_CANARY_EXPIRES_AT: expiresAt,
        }));

        expect(rendered).toMatchObject({
            META_DISCOVERY_CANARY_ENABLED: 'true',
            META_DISCOVERY_CANARY_SHOP_ID: 'shop-kutir',
            META_DISCOVERY_CANARY_PAGE_ID: '1362174360316889',
            META_DISCOVERY_CANARY_EXPIRES_AT: expiresAt,
        });
        expect(rendered).not.toHaveProperty('META_DISCOVERY_CANARY_TOKEN');
    });

    test('rejects an enabled canary with missing, malformed, or expired settings', () => {
        expect(() => buildRenderedEnv(validSource({
            META_DISCOVERY_CANARY_ENABLED: 'true',
        }))).toThrow(/META_DISCOVERY_CANARY_SHOP_ID/);
        expect(() => buildRenderedEnv(validSource({
            META_DISCOVERY_CANARY_ENABLED: 'true',
            META_DISCOVERY_CANARY_SHOP_ID: 'shop-kutir',
            META_DISCOVERY_CANARY_PAGE_ID: 'page-name',
            META_DISCOVERY_CANARY_EXPIRES_AT: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        }))).toThrow(/META_DISCOVERY_CANARY_PAGE_ID/);
        expect(() => buildRenderedEnv(validSource({
            META_DISCOVERY_CANARY_ENABLED: 'true',
            META_DISCOVERY_CANARY_SHOP_ID: 'shop-kutir',
            META_DISCOVERY_CANARY_PAGE_ID: '1362174360316889',
            META_DISCOVERY_CANARY_EXPIRES_AT: new Date(Date.now() - 1).toISOString(),
        }))).toThrow(/must be in the future/);
    });
});

describe('bKash provider posture (§6)', () => {
    test('disabled with no bKash secrets renders a valid config', () => {
        const rendered = buildRenderedEnv(validSource({ BKASH_ENABLED: 'false' }));
        expect(rendered.BKASH_ENABLED).toBe('false');
    });

    test('disabled never renders any merchant credential', () => {
        const rendered = buildRenderedEnv(validSource({
            BKASH_ENABLED: 'false',
            BKASH_APP_KEY: 'should-not-be-rendered',
            BKASH_APP_SECRET: 'should-not-be-rendered',
        }));
        expect(rendered).not.toHaveProperty('BKASH_APP_KEY');
        expect(rendered).not.toHaveProperty('BKASH_APP_SECRET');
        expect(rendered).not.toHaveProperty('BKASH_WEBHOOK_SECRET');
        expect(JSON.stringify(rendered)).not.toContain('should-not-be-rendered');
    });

    test('enabled with a missing credential fails the preflight', () => {
        expect(() => buildRenderedEnv(validSource({
            BKASH_ENABLED: 'true',
            BKASH_BASE_URL: 'https://tokenized.pay.bka.sh',
            BKASH_USERNAME: 'user',
            BKASH_PASSWORD: 'pass',
            // BKASH_APP_KEY missing
            BKASH_APP_SECRET: 'secret',
            BKASH_WEBHOOK_SECRET: hex64('h'),
            BKASH_SANDBOX: 'false',
        }))).toThrow(/BKASH_APP_KEY/);
    });

    test('enabled with the full set and live sandbox renders a valid config', () => {
        const rendered = buildRenderedEnv(validSource({
            BKASH_ENABLED: 'true',
            BKASH_BASE_URL: 'https://tokenized.pay.bka.sh',
            BKASH_USERNAME: 'user',
            BKASH_PASSWORD: 'pass',
            BKASH_APP_KEY: 'app-key',
            BKASH_APP_SECRET: 'app-secret',
            BKASH_WEBHOOK_SECRET: hex64('h'),
            BKASH_SANDBOX: 'false',
        }));
        expect(rendered.BKASH_ENABLED).toBe('true');
        expect(rendered.BKASH_APP_KEY).toBe('app-key');
    });
});

describe('Telegram provider posture', () => {
    test('unset or false keeps Telegram disabled without Telegram secrets', () => {
        const rendered = buildRenderedEnv(validSource({
            TELEGRAM_ENABLED: undefined,
            TELEGRAM_BOT_TOKEN: '',
            TELEGRAM_BOT_USERNAME: '',
            TELEGRAM_WEBHOOK_SECRET: '',
        }));

        expect(rendered.TELEGRAM_ENABLED).toBe('false');
        expect(rendered).not.toHaveProperty('TELEGRAM_BOT_TOKEN');
        expect(rendered).not.toHaveProperty('TELEGRAM_BOT_USERNAME');
        expect(rendered).not.toHaveProperty('TELEGRAM_WEBHOOK_SECRET');
    });

    test('explicit enablement requires every Telegram credential', () => {
        expect(() => buildRenderedEnv(validSource({
            TELEGRAM_ENABLED: 'true',
            TELEGRAM_BOT_TOKEN: '',
            TELEGRAM_BOT_USERNAME: 'easymod_bot',
            TELEGRAM_WEBHOOK_SECRET: 'secret',
        }))).toThrow(/TELEGRAM_BOT_TOKEN/);
    });

    test('explicit enablement renders the complete Telegram section', () => {
        const rendered = buildRenderedEnv(validSource({
            TELEGRAM_ENABLED: 'true',
            TELEGRAM_BOT_TOKEN: 'bot-token',
            TELEGRAM_BOT_USERNAME: 'easymod_bot',
            TELEGRAM_WEBHOOK_SECRET: hex64('h'),
        }));

        expect(rendered.TELEGRAM_ENABLED).toBe('true');
        expect(rendered.TELEGRAM_BOT_TOKEN).toBe('bot-token');
        expect(rendered.TELEGRAM_BOT_USERNAME).toBe('easymod_bot');
        expect(rendered.TELEGRAM_WEBHOOK_SECRET).toBe(hex64('h'));
    });
});

describe('core secret / alert sink fail-closed (§10)', () => {
    test('missing CSRF_SECRET fails', () => {
        expect(() => buildRenderedEnv(validSource({ CSRF_SECRET: '' }))).toThrow(/CSRF_SECRET/);
    });

    test('no backend alert sink (neither Sentry nor Slack) fails', () => {
        expect(() => buildRenderedEnv(validSource({ SENTRY_DSN: '', SLACK_ALERT_WEBHOOK_URL: '' })))
            .toThrow(/SENTRY_DSN\|SLACK_ALERT_WEBHOOK_URL/);
    });

    test('Slack-only alert sink is accepted', () => {
        const rendered = buildRenderedEnv(validSource({
            SENTRY_DSN: '',
            SLACK_ALERT_WEBHOOK_URL: 'https://hooks.slack.com/services/T/B/x',
        }));
        expect(rendered.SLACK_ALERT_WEBHOOK_URL).toContain('hooks.slack.com');
    });

    test('an empty required secret fails', () => {
        expect(() => buildRenderedEnv(validSource({ JWT_ACCESS_SECRET: '' }))).toThrow(/JWT_ACCESS_SECRET/);
    });

    test('a missing Action Gate secret is reported as a render input', () => {
        expect(() => buildRenderedEnv(validSource({ AI_ACTION_GATE_SECRET: '' })))
            .toThrow(/^Missing deployment environment variables: AI_ACTION_GATE_SECRET$/);
    });

    test('a placeholder secret value fails', () => {
        expect(() => buildRenderedEnv(validSource({ SESSION_SECRET: 'change_in_production_please_00000' })))
            .toThrow(/SESSION_SECRET/);
    });

    test('a missing render input fails before any secret work', () => {
        expect(() => buildRenderedEnv(validSource({ MARKETING_URL: '' })))
            .toThrow(/MARKETING_URL/);
    });
});

// This file is a strict allowlist: a variable absent from it cannot be set in
// production by any repo secret, no matter what the code default says. A kill
// switch that silently cannot be thrown is worse than no kill switch.
describe('production safety switches retain their intended defaults', () => {
    test('the production example keeps live-money and out-of-scope channel defaults off', () => {
        const examplePath = path.resolve(__dirname, '../../../.env.prod.example');
        const example = fs.readFileSync(examplePath, 'utf8');
        expect(example).toMatch(/^BKASH_ENABLED=false\s*$/m);
        expect(example).toMatch(/^TELEGRAM_ENABLED=false\s*$/m);
        expect(example).toMatch(/^AI_PHOTO_MATCH_ENABLED=false\s*$/m);
        expect(example).toMatch(/^AI_VISION_ENABLED=false\s*$/m);
    });

    test('both render with their intended defaults when unset', () => {
        const env = buildRenderedEnv(validSource());
        expect(env.AI_PHOTO_MATCH_ENABLED).toBe('false');  // customer photos: opt-in
        expect(env.AI_VISION_ENABLED).toBe('false');       // merchant images: off
        expect(env.GROWTH_OS_ENABLED).toBe('false');
        expect(env.DOMAIN_AGENT_RUNTIME_ENABLED).toBe('false');
        expect(env.AI_ORDER_MUTATIONS_ENABLED).toBe('false');
        expect(env.AI_COURIER_BOOKING_ENABLED).toBe('false');
        expect(env.AI_PAYMENT_ACCEPTANCE_ENABLED).toBe('false');
        expect(env.AI_SUPPORT_CASE_ENABLED).toBe('false');
    });

    test('AI_PHOTO_MATCH_ENABLED=false actually reaches .env.prod', () => {
        const env = buildRenderedEnv(validSource({ AI_PHOTO_MATCH_ENABLED: 'false' }));
        expect(env.AI_PHOTO_MATCH_ENABLED).toBe('false');
    });

    test('customer photo matching can only be enabled with the exact true literal', () => {
        const env = buildRenderedEnv(validSource({ AI_PHOTO_MATCH_ENABLED: 'true' }));
        expect(env.AI_PHOTO_MATCH_ENABLED).toBe('true');
        expect(() => buildRenderedEnv(validSource({ AI_PHOTO_MATCH_ENABLED: 'TRUE' })))
            .toThrow(/AI_PHOTO_MATCH_ENABLED/);
        expect(() => buildRenderedEnv(validSource({ AI_PHOTO_MATCH_ENABLED: 'yes' })))
            .toThrow(/AI_PHOTO_MATCH_ENABLED/);
    });

    test('vision can be turned on deliberately', () => {
        const env = buildRenderedEnv(validSource({ AI_VISION_ENABLED: 'true' }));
        expect(env.AI_VISION_ENABLED).toBe('true');
    });

    test('AI commerce kill switches are settable only by explicit literal flags', () => {
        const env = buildRenderedEnv(validSource({
            DOMAIN_AGENT_RUNTIME_ENABLED: 'true',
            AI_ORDER_MUTATIONS_ENABLED: 'true',
            AI_COURIER_BOOKING_ENABLED: 'true',
            AI_PAYMENT_ACCEPTANCE_ENABLED: 'true',
            AI_SUPPORT_CASE_ENABLED: 'true',
        }));
        expect(env).toMatchObject({
            DOMAIN_AGENT_RUNTIME_ENABLED: 'true',
            AI_ORDER_MUTATIONS_ENABLED: 'true',
            AI_COURIER_BOOKING_ENABLED: 'true',
            AI_PAYMENT_ACCEPTANCE_ENABLED: 'true',
            AI_SUPPORT_CASE_ENABLED: 'true',
        });
        expect(() => buildRenderedEnv(validSource({ AI_ORDER_MUTATIONS_ENABLED: 'TRUE' })))
            .toThrow(/AI_ORDER_MUTATIONS_ENABLED/);
        expect(() => buildRenderedEnv(validSource({ AI_PAYMENT_ACCEPTANCE_ENABLED: 'yes' })))
            .toThrow(/AI_PAYMENT_ACCEPTANCE_ENABLED/);
    });
});

describe('Facebook Login for Business configuration (2026-09-22 incident)', () => {
    // The deploy must carry the Meta Login Configuration ID. Without it the
    // authorization dialog reverts to the classic-Login contract, which this
    // app's Meta configuration no longer honours — the merchant-visible
    // "Feature unavailable" outage. Catch it at render time, not in production.
    test('a missing META_LOGIN_CONFIG_ID fails the render', () => {
        const source = validSource();
        delete source.META_LOGIN_CONFIG_ID;

        expect(() => buildRenderedEnv(source))
            .toThrow(/META_LOGIN_CONFIG_ID/);
    });

    test('a malformed META_LOGIN_CONFIG_ID fails the render', () => {
        expect(() => buildRenderedEnv(validSource({ META_LOGIN_CONFIG_ID: 'CHANGE_ME' })))
            .toThrow(/META_LOGIN_CONFIG_ID/);
    });

    test('the configured value reaches .env.prod verbatim', () => {
        const rendered = buildRenderedEnv(validSource());
        expect(rendered.META_LOGIN_CONFIG_ID).toBe('1685388446490514');
    });
});

describe('mobile API switch (ADR M-010)', () => {
    test('defaults off when the repository variable is unset or empty', () => {
        expect(buildRenderedEnv(validSource()).MOBILE_API_ENABLED).toBe('false');
        expect(buildRenderedEnv(validSource({ MOBILE_API_ENABLED: '' })).MOBILE_API_ENABLED).toBe('false');
    });

    test('an explicit "true" reaches .env.prod, and "false" rolls it back', () => {
        expect(buildRenderedEnv(validSource({ MOBILE_API_ENABLED: 'true' })).MOBILE_API_ENABLED).toBe('true');
        expect(buildRenderedEnv(validSource({ MOBILE_API_ENABLED: 'false' })).MOBILE_API_ENABLED).toBe('false');
    });

    test.each(['TRUE', 'True', '1', 'yes', 'enabled', 'true '])(
        'refuses the ambiguous value %j instead of shipping a silently-off switch',
        (value) => {
            expect(() => buildRenderedEnv(validSource({ MOBILE_API_ENABLED: value })))
                .toThrow(/MOBILE_API_ENABLED must be exactly "true" or "false"/);
        },
    );

    test('never renders the Wave 3 switches or the device-E2E fixture controls', () => {
        const env = buildRenderedEnv(validSource({
            MOBILE_API_ENABLED: 'true',
            MOBILE_PUSH_ENABLED: 'true',
            MOBILE_ORDER_MUTATIONS_ENABLED: 'true',
            MOBILE_COURIER_ACTIONS_ENABLED: 'true',
            MOBILE_AI_DRAFTS_ENABLED: 'true',
            MOBILE_E2E_FIXTURES_ENABLED: 'true',
            MOBILE_E2E_FIXTURES_TOKEN: 'x'.repeat(40),
        }));
        expect(Object.keys(env).filter((name) => name.startsWith('MOBILE_'))).toEqual(['MOBILE_API_ENABLED']);
    });
});

describe('Meta profile enrichment switch', () => {
    test('defaults off and can be enabled deliberately', () => {
        expect(buildRenderedEnv(validSource()).META_USER_PROFILE_ENABLED).toBe('false');
        expect(buildRenderedEnv(validSource({ META_USER_PROFILE_ENABLED: 'true' })).META_USER_PROFILE_ENABLED)
            .toBe('true');
    });
});

describe('Qdrant embedding dimension is rendered from the repository contract', () => {
    test('defaults to the Gemini-compatible 384 dimensions', () => {
        expect(buildRenderedEnv(validSource()).QDRANT_VECTOR_SIZE).toBe('384');
    });

    test('preserves an explicit configured dimension', () => {
        expect(buildRenderedEnv(validSource({ QDRANT_VECTOR_SIZE: '768' })).QDRANT_VECTOR_SIZE)
            .toBe('768');
    });

    test('renders provider-bound fallback collection and space versions', () => {
        const env = buildRenderedEnv(validSource({
            QDRANT_FALLBACK_COLLECTION: 'knowledge_documents_openai_candidate',
            EMBEDDING_SPACE_VERSION: 'global-v1',
            GEMINI_EMBEDDING_SPACE_VERSION: 'gemini-v2',
            OPENAI_EMBEDDING_SPACE_VERSION: 'openai-v1',
        }));
        expect(env.QDRANT_FALLBACK_COLLECTION).toBe('knowledge_documents_openai_candidate');
        expect(env.EMBEDDING_SPACE_VERSION).toBe('global-v1');
        expect(env.GEMINI_EMBEDDING_SPACE_VERSION).toBe('gemini-v2');
        expect(env.OPENAI_EMBEDDING_SPACE_VERSION).toBe('openai-v1');
    });
});
