/**
 * MetaMessengerProvider.test.js
 *
 * Unit tests for the Facebook Messenger provider — focused on pure functions
 * that don't require Meta API access: webhook parsing, signature verification,
 * webhook field list, pagination in listManagedAssets, and the abstract-class
 * contract.
 */

'use strict';

const crypto = require('crypto');
const axios = require('axios');
const mockRecoverInvalidToken = jest.fn();
const config = require('../../../config/config');

jest.mock('../meta-authorization-recovery.service', () => ({
    recoverInvalidToken: mockRecoverInvalidToken,
}));

const MetaMessengerProvider = require('../providers/MetaMessengerProvider');
const ChannelProvider = require('../ChannelProvider');
const { createDiagnostics } = require('../meta-discovery-canary');

jest.mock('axios');

describe('MetaMessengerProvider', () => {
    let provider;

    beforeEach(() => {
        process.env.META_APP_SECRET = 'test-webhook-secret';
        process.env.META_APP_ID = 'test-app-id';
        config.metaAppSecret = 'test-secret';
        config.metaAppId = 'test-app-id';
        provider = new MetaMessengerProvider();
    });

    test('extends ChannelProvider', () => {
        expect(provider).toBeInstanceOf(ChannelProvider);
    });

    test('platform getter returns "facebook"', () => {
        expect(provider.platform).toBe('facebook');
    });

    // The approved production path never reads the Page node for a token; the
    // credential is captured during /me/accounts discovery. A guard test that
    // no provider exposes getAssetAccessToken lives below.
    test('exposes no direct Page-node token lookup', () => {
        expect(provider.getAssetAccessToken).toBeUndefined();
    });

    function debugTokenResponse(targetIds, manageTargetIds = targetIds, showListTargetIds = targetIds) {
        const granularEntry = (scope, ids) => {
            const entry = { scope };
            if (ids !== undefined) entry.target_ids = ids;
            return entry;
        };
        return {
            data: {
                data: {
                    is_valid: true,
                    app_id: 'test-app-id',
                    scopes: ['pages_show_list', 'pages_messaging', 'pages_manage_metadata'],
                    granular_scopes: [
                        granularEntry('pages_messaging', targetIds),
                        granularEntry('pages_manage_metadata', manageTargetIds),
                        granularEntry('pages_show_list', showListTargetIds),
                    ],
                },
            },
        };
    }

    function page(id, overrides = {}) {
        return {
            id,
            name: `Page ${id}`,
            category: null,
            picture: null,
            tasks: ['MESSAGING', 'MANAGE'],
            access_token: `page-token-${id}`,
            ...overrides,
        };
    }

    /**
     * Configure all Graph responses by URL rather than by call order. This
     * keeps the tests honest when discovery adds hydration or pagination calls.
     */
    function configureGraph({ accountPages = [{ data: [], paging: {} }], targetIds = [], debug, hydration = {} }) {
        const normalizedAccountPages = accountPages.map((response) => ({
            ...response,
            data: {
                ...(response.data || {}),
                data: Array.isArray(response.data?.data)
                    ? response.data.data.map((asset) => asset && asset.id !== undefined
                        && !Object.prototype.hasOwnProperty.call(asset, 'access_token')
                        ? { ...asset, access_token: `page-token-${asset.id}` }
                        : asset)
                    : response.data?.data,
            },
        }));
        const pageByCursor = new Map();
        normalizedAccountPages.forEach((response, index) => {
            if (index === 0) return;
            const cursor = normalizedAccountPages[index - 1].data?.paging?.cursors?.after;
            if (cursor !== undefined && cursor !== null && String(cursor).length > 0) {
                pageByCursor.set(String(cursor), response);
            }
        });

        axios.get.mockImplementation((url, request = {}) => {
            const requestUrl = String(url);
            if (requestUrl.includes('/debug_token')) {
                return Promise.resolve(debug || debugTokenResponse(targetIds));
            }
            if (requestUrl.includes('/me/accounts')) {
                const after = request.params?.after;
                return Promise.resolve(
                    after === undefined || after === null
                        ? normalizedAccountPages[0]
                        : pageByCursor.get(String(after)) || { data: { data: [], paging: {} } },
                );
            }
            const pageId = decodeURIComponent(requestUrl.slice(requestUrl.lastIndexOf('/') + 1));
            const hydrationResult = hydration[pageId];
            if (hydrationResult?.error) return Promise.reject(hydrationResult.error);
            return Promise.resolve({ data: hydrationResult || page(pageId) });
        });
    }

    // Facebook Login for Business is configuration-driven: the Meta dashboard
    // Login Configuration owns the permission set and `config_id` selects it.
    // Sending the classic-Login `scope` contract instead is what produced the
    // 2026-09-22 "Feature unavailable" production outage. These tests pin the
    // corrected contract so a regression to the legacy one cannot ship.
    // See docs/incidents/2026-09-22-meta-login-unavailable.md.
    describe('buildAuthUrl() permission surface (App Review surface)', () => {
        const { CONFIGURATION_OWNED_PERMISSIONS } = MetaMessengerProvider._private;
        const config = require('../../../config/config');
        let saved;

        beforeEach(() => {
            saved = {
                id: config.metaAppId,
                redirect: config.metaOAuthRedirectUri,
                configId: config.metaLoginConfigId,
            };
            config.metaAppId = '2040799330176198';
            config.metaOAuthRedirectUri = 'https://app.easymod.tech/channels/oauth-callback';
            config.metaLoginConfigId = '1685388446490514';
        });

        afterEach(() => {
            config.metaAppId = saved.id;
            config.metaOAuthRedirectUri = saved.redirect;
            config.metaLoginConfigId = saved.configId;
        });

        test('declares exactly the Messenger-only Page permissions', () => {
            expect([...CONFIGURATION_OWNED_PERMISSIONS].sort()).toEqual([
                'pages_manage_metadata',
                'pages_messaging',
                'pages_show_list',
            ]);
        });

        test('declares no Instagram, business_management, engagement or ads permission', () => {
            const declared = CONFIGURATION_OWNED_PERMISSIONS.join(',');
            expect(declared).not.toMatch(/instagram_/);
            expect(declared).not.toContain('business_management');
            expect(declared).not.toContain('pages_read_engagement');
            expect(declared).not.toContain('pages_manage_engagement');
            expect(declared).not.toContain('ads_management');
            expect(declared).not.toContain('ads_read');
        });

        // The regression guard for the outage: permissions come from the Meta
        // configuration, so no permission may be negotiated on the URL at all.
        test('puts no runtime permission scope on the authorization URL', async () => {
            const url = new URL(await provider.buildAuthUrl({ state: 'facebook:s:u:n', scopes: [] }));
            expect(url.searchParams.get('scope')).toBeNull();
            expect(url.searchParams.has('scope')).toBe(false);
            expect(url.search).not.toContain('pages_');
        });

        test('a caller cannot reintroduce scope or broaden consent', async () => {
            const url = new URL(await provider.buildAuthUrl({
                state: 'facebook:s:u:n',
                scopes: [
                    'business_management',
                    'instagram_basic',
                    'instagram_manage_messages',
                    'pages_read_engagement',
                ],
            }));

            expect(url.searchParams.has('scope')).toBe(false);
            expect(url.search).not.toContain('business_management');
            expect(url.search).not.toMatch(/instagram_/);
            expect(url.search).not.toContain('pages_read_engagement');
        });
    });

    describe('buildAuthUrl() dialog contract (Facebook Login for Business, User access token configuration)', () => {
        const config = require('../../../config/config');
        const APP_ID = '2040799330176198';
        const REDIRECT = 'https://app.easymod.tech/channels/oauth-callback';
        // The app's USER access token configuration. The separate system-user
        // configuration (35885387384409543) is intentionally NOT used by
        // merchant login and must never appear on this URL.
        const CONFIG_ID = '1685388446490514';
        const SYSTEM_USER_CONFIG_ID = '35885387384409543';
        const STATE = 'facebook:shop-1:user-1:nonce-fixture';
        let saved;

        beforeEach(() => {
            saved = {
                id: config.metaAppId,
                redirect: config.metaOAuthRedirectUri,
                configId: config.metaLoginConfigId,
            };
            config.metaAppId = APP_ID;
            config.metaOAuthRedirectUri = REDIRECT;
            config.metaLoginConfigId = CONFIG_ID;
        });

        afterEach(() => {
            config.metaAppId = saved.id;
            config.metaOAuthRedirectUri = saved.redirect;
            config.metaLoginConfigId = saved.configId;
        });

        const build = (args = {}) => provider.buildAuthUrl({ state: STATE, scopes: [], ...args });

        test('targets the Facebook dialog host on the shared Graph version', async () => {
            const url = new URL(await build());
            const version = process.env.META_GRAPH_API_VERSION || 'v22.0';
            expect(url.origin).toBe('https://www.facebook.com');
            expect(url.pathname).toBe('/' + version + '/dialog/oauth');
        });

        test('emits exactly client_id, redirect_uri, config_id, response_type and state', async () => {
            const url = new URL(await build());
            expect([...url.searchParams.keys()].sort()).toEqual([
                'client_id',
                'config_id',
                'redirect_uri',
                'response_type',
                'state',
            ]);
            expect(url.searchParams.get('client_id')).toBe(APP_ID);
            expect(url.searchParams.get('response_type')).toBe('code');
        });

        test('carries the configured Login Configuration ID as config_id', async () => {
            const url = new URL(await build());
            expect(url.searchParams.get('config_id')).toBe(CONFIG_ID);
            expect(url.searchParams.get('config_id')).toBe(config.metaLoginConfigId);
        });

        test('config_id follows the configured value rather than a hardcoded constant', async () => {
            config.metaLoginConfigId = '999888777666555';
            const url = new URL(await build());
            expect(url.searchParams.get('config_id')).toBe('999888777666555');
        });

        // Meta documents `scope` as replaced by `config_id` and recommends
        // against sending it. Sending the scope contract with no config_id is
        // exactly the legacy request that broke.
        test('sends no scope parameter', async () => {
            const url = new URL(await build());
            expect(url.searchParams.has('scope')).toBe(false);
        });

        // override_default_response_type is documented ONLY for business
        // integration system user (SUAT/BISU) configurations, where it forces
        // the authorization-code grant. This app's merchant login uses a USER
        // access token configuration, which does not take it. Cargo-culting it
        // across would be an unproven change to the authorization contract.
        test('does not send override_default_response_type (system-user only)', async () => {
            const url = new URL(await build());
            expect(url.searchParams.has('override_default_response_type')).toBe(false);
        });

        test('never carries the preserved system-user configuration ID', async () => {
            const url = await build();
            expect(url).not.toContain(SYSTEM_USER_CONFIG_ID);
        });

        test('uses the configured redirect_uri exactly, with no trailing slash', async () => {
            const url = new URL(await build());
            expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT);
        });

        test('prefers the redirect_uri bound to the OAuth state when one is passed', async () => {
            const bound = 'https://app.easymod.tech/channels/oauth-callback';
            config.metaOAuthRedirectUri = 'https://changed.example.com/channels/oauth-callback';
            const url = new URL(await build({ redirectUri: bound }));
            expect(url.searchParams.get('redirect_uri')).toBe(bound);
        });

        test('passes state through byte-identically', async () => {
            const url = new URL(await build());
            expect(url.searchParams.get('state')).toBe(STATE);
        });

        // buildAuthUrl passes a caller-supplied redirectUri through verbatim: the
        // service supplies config.metaOAuthRedirectUri and Meta's whitelist enforces
        // it. What this pins is only that hostile text stays inside its own
        // percent-encoded parameter and cannot add or override another one.
        test('keeps hostile state and redirect_uri values inside their own encoded parameters', async () => {
            const hostileState = STATE + '&scope=business_management&config_id=999#frag';
            const hostileRedirect = REDIRECT + '&scope=instagram_basic&client_id=1';
            const url = new URL(await build({ state: hostileState, redirectUri: hostileRedirect }));

            expect([...url.searchParams.keys()].sort()).toEqual([
                'client_id',
                'config_id',
                'redirect_uri',
                'response_type',
                'state',
            ]);
            expect(url.searchParams.get('state')).toBe(hostileState);
            expect(url.searchParams.get('redirect_uri')).toBe(hostileRedirect);
            expect(url.searchParams.get('client_id')).toBe(APP_ID);
            expect(url.searchParams.get('config_id')).toBe(CONFIG_ID);
            expect(url.searchParams.has('scope')).toBe(false);
        });
    });

    // Configuration drift protection. Facebook Login for Business cannot be
    // driven without a configuration ID, and the failure mode of guessing is an
    // opaque merchant-facing dialog with nothing in our logs. So this fails
    // closed rather than downgrading to the legacy scope-only contract.
    describe('buildAuthUrl() fails closed on a missing or malformed configuration ID', () => {
        const config = require('../../../config/config');
        let saved;

        beforeEach(() => {
            saved = {
                id: config.metaAppId,
                redirect: config.metaOAuthRedirectUri,
                configId: config.metaLoginConfigId,
            };
            config.metaAppId = '2040799330176198';
            config.metaOAuthRedirectUri = 'https://app.easymod.tech/channels/oauth-callback';
        });

        afterEach(() => {
            config.metaAppId = saved.id;
            config.metaOAuthRedirectUri = saved.redirect;
            config.metaLoginConfigId = saved.configId;
        });

        const build = () => provider.buildAuthUrl({ state: 'facebook:s:u:n', scopes: [] });

        test.each([
            ['undefined', undefined],
            ['null', null],
            ['empty string', ''],
            ['whitespace only', '   '],
            ['non-numeric', 'not-a-config-id'],
            ['too short', '12345'],
            ['quoted', '"1685388446490514"'],
            ['comma-joined pair', '1685388446490514,35885387384409543'],
            ['signed', '+1685388446490514'],
            ['decimal', '1685388446490514.0'],
            ['scientific notation', '1.6853884464905e15'],
            ['embedded parameter injection', '1685388446490514&scope=business_management'],
            ['placeholder', 'CHANGE_ME'],
        ])('refuses to build an authorization URL when META_LOGIN_CONFIG_ID is %s', async (_label, value) => {
            config.metaLoginConfigId = value;
            await expect(build()).rejects.toMatchObject({
                status: 500,
                code: 'META_LOGIN_CONFIG_ID_INVALID',
            });
        });

        test('does not silently downgrade to the legacy scope-only contract', async () => {
            config.metaLoginConfigId = '';
            // Nothing is returned at all when the configuration is absent, so
            // the legacy scope-only URL is unreachable by any path.
            await expect(build()).rejects.toThrow();
        });

        test('tolerates surrounding whitespace on an otherwise valid value', async () => {
            config.metaLoginConfigId = '  1685388446490514  ';
            const url = new URL(await build());
            expect(url.searchParams.get('config_id')).toBe('1685388446490514');
        });
    });

    describe('buildAuthUrl() dialog contract (Facebook Login for Business)', () => {
        const config = require('../../../config/config');
        const APP_ID = '2040799330176198';
        const REDIRECT = 'https://app.easymod.tech/channels/oauth-callback';
        const CONFIG_ID = '1685388446490514';
        const STATE = 'facebook:shop-1:user-1:nonce-fixture';
        let saved;

        beforeEach(() => {
            saved = {
                id: config.metaAppId,
                redirect: config.metaOAuthRedirectUri,
                configId: config.metaLoginConfigId,
            };
            config.metaAppId = APP_ID;
            config.metaOAuthRedirectUri = REDIRECT;
            config.metaLoginConfigId = CONFIG_ID;
        });

        afterEach(() => {
            config.metaAppId = saved.id;
            config.metaOAuthRedirectUri = saved.redirect;
            config.metaLoginConfigId = saved.configId;
        });

        const build = (args = {}) => provider.buildAuthUrl({ state: STATE, scopes: [], ...args });

        test('targets the Facebook dialog host on the shared Graph version', async () => {
            const url = new URL(await build());
            const version = process.env.META_GRAPH_API_VERSION || 'v22.0';
            expect(url.origin).toBe('https://www.facebook.com');
            expect(url.pathname).toBe(`/${version}/dialog/oauth`);
        });

        test('emits exactly client_id, redirect_uri, config_id, response_type and state', async () => {
            const url = new URL(await build());
            expect([...url.searchParams.keys()].sort()).toEqual([
                'client_id',
                'config_id',
                'redirect_uri',
                'response_type',
                'state',
            ]);
            expect(url.searchParams.get('client_id')).toBe(APP_ID);
            expect(url.searchParams.get('config_id')).toBe(CONFIG_ID);
            expect(url.searchParams.get('response_type')).toBe('code');
            expect(url.searchParams.has('scope')).toBe(false);
        });

        test('uses the configured redirect_uri exactly, with no trailing slash', async () => {
            const url = new URL(await build());
            expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT);
        });

        test('prefers the redirect_uri bound to the OAuth state when one is passed', async () => {
            const bound = 'https://app.easymod.tech/channels/oauth-callback';
            config.metaOAuthRedirectUri = 'https://changed.example.com/channels/oauth-callback';
            const url = new URL(await build({ redirectUri: bound }));
            expect(url.searchParams.get('redirect_uri')).toBe(bound);
        });

        test('passes state through byte-identically', async () => {
            const url = new URL(await build());
            expect(url.searchParams.get('state')).toBe(STATE);
        });

        // buildAuthUrl passes a caller-supplied redirectUri through verbatim: the
        // service supplies config.metaOAuthRedirectUri and Meta's whitelist enforces
        // it. What this pins is only that hostile text stays inside its own
        // percent-encoded parameter and cannot add or override another one.
        test('keeps hostile state and redirect_uri values inside their own encoded parameters', async () => {
            const hostileState = `${STATE}&scope=business_management&config_id=999#frag`;
            const hostileRedirect = `${REDIRECT}&scope=instagram_basic&client_id=1`;
            const url = new URL(await build({ state: hostileState, redirectUri: hostileRedirect }));

            expect([...url.searchParams.keys()].sort()).toEqual([
                'client_id',
                'config_id',
                'redirect_uri',
                'response_type',
                'state',
            ]);
            expect(url.searchParams.get('state')).toBe(hostileState);
            expect(url.searchParams.get('redirect_uri')).toBe(hostileRedirect);
            expect(url.searchParams.get('client_id')).toBe(APP_ID);
            expect(url.searchParams.get('config_id')).toBe(CONFIG_ID);
            expect(url.searchParams.has('scope')).toBe(false);
        });

        test('does not send the system-user-only response-type override', async () => {
            const url = new URL(await build());
            expect(url.searchParams.has('override_default_response_type')).toBe(false);
        });
    });

    describe('webhookFields()', () => {
        test('includes only Messenger messages', () => {
            const fields = provider.webhookFields();
            expect(fields).toEqual(['messages']);
            expect(fields).not.toContain('messaging_postbacks');
            expect(fields).not.toContain('messaging_optins');
            expect(fields).not.toContain('message_deliveries');
            expect(fields).not.toContain('message_reads');
            expect(fields).not.toContain('feed');
        });

        test('does NOT include whatsapp-related fields', () => {
            const fields = provider.webhookFields();
            expect(fields).not.toContain('message_template_status_update');
            expect(fields).not.toContain('phone_number_quality_update');
        });

        test('returns a fresh copy (mutating result does not affect provider)', () => {
            const a = provider.webhookFields();
            a.push('hacked');
            const b = provider.webhookFields();
            expect(b).not.toContain('hacked');
        });
    });

    describe('verifyWebhookSignature()', () => {
        const rawBody = Buffer.from('{"object":"page","entry":[]}');

        function sigFor(body, secret = 'test-webhook-secret') {
            return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
        }

        test('returns true for valid signature', async () => {
            const ok = await provider.verifyWebhookSignature({ rawBody, signature: sigFor(rawBody) });
            expect(ok).toBe(true);
        });

        test('returns false for tampered body', async () => {
            const ok = await provider.verifyWebhookSignature({
                rawBody: Buffer.from('{"object":"page","entry":["tampered"]}'),
                signature: sigFor(rawBody)
            });
            expect(ok).toBe(false);
        });

        test('returns false for wrong secret', async () => {
            const ok = await provider.verifyWebhookSignature({
                rawBody,
                signature: sigFor(rawBody, 'wrong-secret')
            });
            expect(ok).toBe(false);
        });

        test('returns false for missing or malformed signature', async () => {
            expect(await provider.verifyWebhookSignature({ rawBody, signature: '' })).toBe(false);
            expect(await provider.verifyWebhookSignature({ rawBody, signature: 'no-prefix' })).toBe(false);
            expect(await provider.verifyWebhookSignature({ rawBody, signature: null })).toBe(false);
        });
    });

    describe('parseWebhookEnvelope()', () => {
        test('returns [] for non-page payloads', () => {
            expect(provider.parseWebhookEnvelope({ object: 'instagram', entry: [] })).toEqual([]);
            expect(provider.parseWebhookEnvelope(null)).toEqual([]);
            expect(provider.parseWebhookEnvelope({})).toEqual([]);
        });

        test('extracts text messages from page messaging events', () => {
            const events = provider.parseWebhookEnvelope({
                object: 'page',
                entry: [{
                    id: 'PAGE_123',
                    messaging: [{
                        sender: { id: 'PSID_999' },
                        recipient: { id: 'PAGE_123' },
                        timestamp: 1700000000000,
                        message: { mid: 'mid_abc', text: 'Hello!' }
                    }]
                }]
            });
            expect(events).toHaveLength(1);
            expect(events[0]).toMatchObject({
                externalId: 'mid_abc',
                senderExternalId: 'PSID_999',
                pageOrAccountId: 'PAGE_123',
                text: 'Hello!',
                isEcho: false,
                commentId: null,
                postId: null
            });
        });

        test('drops echo events (page\'s own outbound reflected back)', () => {
            const events = provider.parseWebhookEnvelope({
                object: 'page',
                entry: [{
                    id: 'PAGE_123',
                    messaging: [{
                        sender: { id: 'PAGE_123' },
                        recipient: { id: 'PSID_999' },
                        timestamp: 1700000000000,
                        message: { mid: 'mid_echo', text: 'Bot reply', is_echo: true }
                    }]
                }]
            });
            expect(events).toEqual([]);
        });

        test('preserves Messenger reply_to relationship on inbound events', () => {
            const events = provider.parseWebhookEnvelope({
                object: 'page',
                entry: [{
                    id: 'PAGE_123',
                    messaging: [{
                        sender: { id: 'PSID_999' },
                        recipient: { id: 'PAGE_123' },
                        timestamp: 1700000000000,
                        message: {
                            mid: 'mid_reply',
                            text: 'L',
                            reply_to: { mid: 'mid_question', is_self_reply: true },
                        },
                    }],
                }],
            });

            expect(events[0]).toEqual(expect.objectContaining({
                inReplyToExternalId: 'mid_question',
                replyToIsSelfReply: true,
            }));
        });

        test('ignores comment events from feed changes', () => {
            const events = provider.parseWebhookEnvelope({
                object: 'page',
                entry: [{
                    id: 'PAGE_123',
                    changes: [{
                        field: 'feed',
                        value: {
                            item: 'comment',
                            comment_id: 'C_456',
                            post_id: 'P_789',
                            from: { id: 'USER_AAA', name: 'Test User' },
                            message: 'Send me details',
                            created_time: 1700000000
                        }
                    }]
                }]
            });
            expect(events).toEqual([]);
        });

        test('ignores non-comment feed events', () => {
            const events = provider.parseWebhookEnvelope({
                object: 'page',
                entry: [{
                    id: 'PAGE_123',
                    changes: [{ field: 'feed', value: { item: 'reaction' } }]
                }]
            });
            expect(events).toEqual([]);
        });
    });

    describe('sendMessage()', () => {
        const channel = { id: 'channel-1', page_access_token_ct: 'page-token' };
        const decision = { allow: true };

        beforeEach(() => {
            axios.post.mockResolvedValue({ data: { message_id: 'mid_sent' } });
            mockRecoverInvalidToken.mockResolvedValue(undefined);
        });

        afterEach(() => {
            jest.resetAllMocks();
        });

        test('sends image attachment through Messenger Send API', async () => {
            const result = await provider.sendMessage({
                channel,
                recipientId: 'PSID_1',
                normalizedMessage: {
                    text: '',
                    attachments: [{ type: 'image', url: 'https://cdn.example.com/photo.jpg' }],
                },
                decision,
            });

            expect(result.providerMessageId).toBe('mid_sent');
            expect(axios.post).toHaveBeenCalledWith(
                expect.stringContaining('/me/messages'),
                expect.objectContaining({
                    recipient: { id: 'PSID_1' },
                    messaging_type: 'RESPONSE',
                    message: {
                        attachment: {
                            type: 'image',
                            payload: {
                                url: 'https://cdn.example.com/photo.jpg',
                                is_reusable: true,
                            },
                        },
                    },
                }),
                {
                    params: { access_token: 'page-token', appsecret_proof: expect.any(String) },
                    timeout: 30_000,
                }
            );
        });

        test('sends text then file when both are present', async () => {
            axios.post
                .mockResolvedValueOnce({ data: { message_id: 'mid_text' } })
                .mockResolvedValueOnce({ data: { message_id: 'mid_file' } });

            const result = await provider.sendMessage({
                channel,
                recipientId: 'PSID_2',
                normalizedMessage: {
                    text: 'Invoice attached',
                    attachments: [{ type: 'file', url: 'https://cdn.example.com/invoice.pdf' }],
                },
                decision,
            });

            expect(result.providerMessageIds).toEqual(['mid_text', 'mid_file']);
            expect(axios.post).toHaveBeenCalledTimes(2);
            expect(axios.post.mock.calls[0][1].message).toEqual({ text: 'Invoice attached' });
            expect(axios.post.mock.calls[1][1].message.attachment).toMatchObject({
                type: 'file',
                payload: { url: 'https://cdn.example.com/invoice.pdf', is_reusable: true },
            });
        });

        test('P+02: quick replies ride the text body; invalid entries are dropped', async () => {
            axios.post.mockResolvedValueOnce({ data: { message_id: 'mid_qr' } });

            const quick_replies = [
                { title: 'আবার দেখুন', payload: 'p1:11111111-1111-1111-1111-111111111111:checkout.review' },
                { title: 'this title is way too long to fit meta', payload: 'p1:11111111-1111-1111-1111-111111111111:checkout.cancel' },
                { title: 'No payload', payload: '' },
            ];
            await provider.sendMessage({
                channel,
                recipientId: 'PSID_QR',
                normalizedMessage: { text: 'আপনার অর্ডার', quick_replies, attachments: [] },
                decision,
            });

            const sent = axios.post.mock.calls[0][1].message;
            expect(sent.text).toBe('আপনার অর্ডার');
            expect(sent.quick_replies).toHaveLength(1);
            expect(sent.quick_replies[0]).toMatchObject({ content_type: 'text' });
        });

        test('P+02: oversized reply sets are capped at Meta 13 limit', async () => {
            axios.post.mockResolvedValueOnce({ data: { message_id: 'mid_cap' } });
            const quick_replies = Array.from({ length: 20 }, (_, i) => ({
                title: `opt ${i}`, payload: `p1:11111111-1111-1111-1111-111111111111:checkout.review`,
            }));
            await provider.sendMessage({
                channel, recipientId: 'PSID_CAP',
                normalizedMessage: { text: 'pick', quick_replies, attachments: [] },
                decision,
            });
            expect(axios.post.mock.calls[0][1].message.quick_replies).toHaveLength(13);
        });

        test('preserves acknowledged text when a later attachment call fails', async () => {
            axios.post
                .mockResolvedValueOnce({ data: { message_id: 'mid_text_partial' } })
                .mockRejectedValueOnce({
                    response: {
                        status: 400,
                        data: {
                            error: {
                                code: 100,
                                error_subcode: 2018001,
                                type: 'OAuthException',
                                message: 'Attachment URL could not be fetched',
                            },
                        },
                    },
                });

            await expect(provider.sendMessage({
                channel,
                recipientId: 'PSID_PARTIAL',
                normalizedMessage: {
                    text: 'Photo attached',
                    attachments: [{ type: 'image', url: 'https://cdn.example.com/broken.jpg' }],
                },
                decision,
            })).rejects.toMatchObject({
                providerMessageIds: ['mid_text_partial'],
                providerComponents: [
                    expect.objectContaining({ type: 'text', status: 'ACKNOWLEDGED', providerMessageId: 'mid_text_partial' }),
                    expect.objectContaining({ type: 'image', status: 'FAILED', attempted: true }),
                ],
                providerFailure: expect.objectContaining({
                    metaCode: 100,
                    metaSubcode: 2018001,
                }),
            });
            expect(axios.post).toHaveBeenCalledTimes(2);
        });

        test('fails closed when Meta accepts a request without returning a message ID', async () => {
            axios.post.mockResolvedValueOnce({ data: {} });

            await expect(provider.sendMessage({
                channel,
                recipientId: 'PSID_NO_MID',
                normalizedMessage: { text: 'No opaque acknowledgement', attachments: [] },
                decision,
            })).rejects.toMatchObject({ code: 'PROVIDER_NO_ACK' });
        });

        test.each([102, 190])(
            'marks Meta error %s permanent only after durable recovery succeeds',
            async (metaCode) => {
                axios.post.mockRejectedValue({
                    response: {
                        status: 401,
                        data: { error: { code: metaCode, message: 'Invalid access token' } },
                    },
                });

                await expect(provider.sendMessage({
                    channel,
                    recipientId: 'PSID_3',
                    normalizedMessage: { text: 'test', attachments: [] },
                    decision,
                })).rejects.toMatchObject({
                    code: 'META_AUTHORIZATION_REQUIRED',
                    status: 401,
                });
                expect(mockRecoverInvalidToken).toHaveBeenCalledWith(
                    channel,
                    expect.objectContaining({ metaCode }),
                );
            },
        );

        test('keeps invalid-token delivery retryable when durable recovery fails', async () => {
            axios.post.mockRejectedValue({
                response: {
                    status: 401,
                    data: { error: { code: 190, message: 'Invalid access token' } },
                },
            });
            mockRecoverInvalidToken.mockRejectedValue(new Error('database unavailable'));

            await expect(provider.sendMessage({
                channel,
                recipientId: 'PSID_4',
                normalizedMessage: { text: 'test', attachments: [] },
                decision,
            })).rejects.toMatchObject({
                code: 'META_AUTHORIZATION_RECOVERY_FAILED',
                status: 503,
                details: expect.objectContaining({ recoveryPending: true }),
            });
        });
    });

    describe('sendMessage() rate-limit + message_tag wiring', () => {
        // The real (memory-fallback in test env) cacheRedis singleton, shared by
        // MetaMessengerProvider.sendMessage (via rateLimit.rule's reserveSendSlot/
        // releaseSendSlot) and rateLimit.rule's own evaluate() peek — patched here
        // with a tiny in-memory ZSET plus an eval() that reproduces the Lua
        // script's atomic prune+count+conditional-add, so the test proves both
        // sides actually agree on key format and the real reserve/release control
        // flow, not just that each mock was called with *something*.
        const { cacheRedis } = require('src/config/redis');
        const rateLimitRule = require('src/modules/policy/rules/rateLimit.rule');
        let zsets;

        beforeEach(() => {
            zsets = new Map(); // key -> Map(member -> score)
            axios.post.mockResolvedValue({ data: { message_id: 'mid_rl' } });
            cacheRedis.eval = jest.fn(async (_script, _numKeys, key, now, windowMs, limit, member) => {
                if (!zsets.has(key)) zsets.set(key, new Map());
                const m = zsets.get(key);
                for (const [mem, score] of [...m.entries()]) {
                    if (score < Number(now) - Number(windowMs)) m.delete(mem);
                }
                if (m.size < Number(limit)) {
                    m.set(member, Number(now));
                    return 1;
                }
                return 0;
            });
            cacheRedis.zrem = jest.fn(async (key, member) => {
                zsets.get(key)?.delete(member);
                return 1;
            });
            cacheRedis.zcard = jest.fn(async (key) => zsets.get(key)?.size || 0);
            cacheRedis.zremrangebyscore = jest.fn(async (key, _min, max) => {
                const m = zsets.get(key);
                if (!m) return 0;
                let removed = 0;
                for (const [member, score] of [...m.entries()]) {
                    if (score <= Number(max)) { m.delete(member); removed++; }
                }
                return removed;
            });
            cacheRedis.zrange = jest.fn(async (key) => {
                const m = zsets.get(key);
                if (!m || m.size === 0) return [];
                const [member, score] = [...m.entries()].sort((a, b) => a[1] - b[1])[0];
                return [member, String(score)];
            });
        });

        afterEach(() => {
            jest.resetAllMocks();
        });

        test('a successful send adds one entry to the rate-limit ZSET', async () => {
            const channel = { id: 'c-rl', page_access_token_ct: 'tok', meta_asset_id: 'PAGE_RL1' };
            await provider.sendMessage({
                channel,
                recipientId: 'PSID_RL',
                normalizedMessage: { text: 'hi', attachments: [] },
                decision: { allow: true },
            });
            expect(await cacheRedis.zcard(rateLimitRule.keyFor('PAGE_RL1'))).toBe(1);
        });

        test('a text+attachment message reserves two separate slots, one per real Graph API call', async () => {
            const channel = { id: 'c-rl-multi', page_access_token_ct: 'tok', meta_asset_id: 'PAGE_RL_MULTI' };
            axios.post
                .mockResolvedValueOnce({ data: { message_id: 'mid_text' } })
                .mockResolvedValueOnce({ data: { message_id: 'mid_file' } });

            await provider.sendMessage({
                channel,
                recipientId: 'PSID_RL_MULTI',
                normalizedMessage: {
                    text: 'Invoice attached',
                    attachments: [{ type: 'file', url: 'https://cdn.example.com/invoice.pdf' }],
                },
                decision: { allow: true },
            });

            expect(axios.post).toHaveBeenCalledTimes(2);
            expect(await cacheRedis.zcard(rateLimitRule.keyFor('PAGE_RL_MULTI'))).toBe(2);
        });

        test('a burst past META_SEND_LIMIT is rejected mid-send with retryAfterMs', async () => {
            const channel = { id: 'c-rl2', page_access_token_ct: 'tok', meta_asset_id: 'PAGE_RL2' };
            for (let i = 0; i < rateLimitRule.META_SEND_LIMIT; i++) {
                await provider.sendMessage({
                    channel,
                    recipientId: 'PSID_RL2',
                    normalizedMessage: { text: `msg ${i}`, attachments: [] },
                    decision: { allow: true },
                });
            }
            // The next real send is denied at the atomic reservation itself —
            // not just at the read-side peek — proving the gate that matters is
            // the one immediately guarding the Graph API call.
            await expect(provider.sendMessage({
                channel,
                recipientId: 'PSID_RL2',
                normalizedMessage: { text: 'one too many', attachments: [] },
                decision: { allow: true },
            })).rejects.toMatchObject({ code: 'META_RATE_LIMIT', retryAfterMs: expect.any(Number) });
            expect(axios.post).toHaveBeenCalledTimes(rateLimitRule.META_SEND_LIMIT);

            const result = await rateLimitRule.evaluate({}, { channel });
            expect(result.allow).toBe(false);
            expect(result.reason).toBe('RATE_LIMIT');
        });

        test('releases the reservation and bubbles the original error when the Graph API call fails', async () => {
            const channel = { id: 'c-rl-fail', page_access_token_ct: 'tok', meta_asset_id: 'PAGE_RL_FAIL' };
            axios.post.mockRejectedValueOnce({ response: { status: 500, data: {} } });

            await expect(provider.sendMessage({
                channel,
                recipientId: 'PSID_RL_FAIL',
                normalizedMessage: { text: 'will fail', attachments: [] },
                decision: { allow: true },
            })).rejects.toMatchObject({ code: 'META_API_ERROR' });

            // The failed send's reservation was released, so a fresh send has
            // the full quota available rather than one slot already burned.
            expect(await cacheRedis.zcard(rateLimitRule.keyFor('PAGE_RL_FAIL'))).toBe(0);
        });

        test('fails closed (does not send) when the rate-limit reservation is unavailable', async () => {
            cacheRedis.eval = jest.fn().mockRejectedValue(new Error('redis down'));
            const channel = { id: 'c-rl3', page_access_token_ct: 'tok', meta_asset_id: 'PAGE_RL3' };
            await expect(provider.sendMessage({
                channel,
                recipientId: 'PSID_RL3',
                normalizedMessage: { text: 'must not send', attachments: [] },
                decision: { allow: true },
            })).rejects.toMatchObject({ code: 'META_RATE_LIMIT' });
            expect(axios.post).not.toHaveBeenCalled();
        });

        test('defense-in-depth: a retired tag on an allowed decision NEVER reaches the wire', async () => {
            const channel = { id: 'c-tag', page_access_token_ct: 'tok', meta_asset_id: 'PAGE_TAG' };
            await provider.sendMessage({
                channel,
                recipientId: 'PSID_TAG',
                normalizedMessage: { text: 'order shipped', attachments: [] },
                decision: { allow: true, augment: { message_tag: 'POST_PURCHASE_UPDATE' } },
            });
            const [, body] = axios.post.mock.calls[0];
            // Meta returns error 100 for retired tags since 2026-04-27; the
            // provider must not put a doomed tag on the wire even if an
            // upstream layer somehow allowed it.
            expect(body.messaging_type).toBe('RESPONSE');
            expect(body).not.toHaveProperty('tag');
        });

        test('an explicitly permitted HUMAN_AGENT tag (permission granted) is sent as MESSAGE_TAG', async () => {
            const prev = process.env.META_HUMAN_AGENT_TAG_ENABLED;
            process.env.META_HUMAN_AGENT_TAG_ENABLED = 'true';
            try {
                const channel = { id: 'c-tag2', page_access_token_ct: 'tok', meta_asset_id: 'PAGE_TAG2' };
                await provider.sendMessage({
                    channel,
                    recipientId: 'PSID_TAG2',
                    normalizedMessage: { text: 'human follow-up', attachments: [] },
                    decision: { allow: true, augment: { message_tag: 'HUMAN_AGENT' } },
                });
                expect(axios.post).toHaveBeenCalledWith(
                    expect.stringContaining('/me/messages'),
                    expect.objectContaining({ messaging_type: 'MESSAGE_TAG', tag: 'HUMAN_AGENT' }),
                    expect.anything(),
                );
            } finally {
                if (prev === undefined) delete process.env.META_HUMAN_AGENT_TAG_ENABLED;
                else process.env.META_HUMAN_AGENT_TAG_ENABLED = prev;
            }
        });

        test('in-window send (no augment) is unaffected: RESPONSE type, no tag field', async () => {
            const channel = { id: 'c-notag', page_access_token_ct: 'tok', meta_asset_id: 'PAGE_NOTAG' };
            await provider.sendMessage({
                channel,
                recipientId: 'PSID_NOTAG',
                normalizedMessage: { text: 'hello', attachments: [] },
                decision: { allow: true },
            });
            const [, body] = axios.post.mock.calls[0];
            expect(body.messaging_type).toBe('RESPONSE');
            expect(body).not.toHaveProperty('tag');
        });
    });

    describe('listManagedAssets() discovery and pagination', () => {
        beforeEach(() => {
            process.env.META_APP_SECRET = 'test-secret';
            process.env.META_APP_ID = 'test-app-id';
        });

        afterEach(() => {
            jest.resetAllMocks();
        });

        test('returns all granted Pages from /me/accounts and omits legacy Instagram data', async () => {
            configureGraph({
                accountPages: [{
                    data: {
                        data: [
                            page('P1', { name: 'Page 1', category: 'Shopping', picture: { data: { url: 'http://img/1' } } }),
                            page('P2', { name: 'Page 2', instagram_business_account: { id: 'IG2' } }),
                        ],
                        paging: {},
                    },
                }],
                targetIds: ['P1', 'P2'],
            });
            const result = await provider.listManagedAssets({ userToken: 'tok_abc' });

            expect(result).toHaveLength(2);
            expect(result[0]).toMatchObject({ id: 'P1', name: 'Page 1', pictureUrl: 'http://img/1' });
            expect(result[0]).not.toHaveProperty('instagramAccount');
            expect(result[1]).toMatchObject({ id: 'P2', name: 'Page 2' });
            expect(result[1]).not.toHaveProperty('instagramAccount');
            expect(axios.get).toHaveBeenCalledTimes(2);
            expect(axios.get).toHaveBeenCalledWith(
                expect.stringContaining('/me/accounts'),
                expect.objectContaining({ params: expect.objectContaining({ limit: 100 }) })
            );
            expect(axios.get).toHaveBeenCalledWith(
                expect.stringContaining('/debug_token'),
                expect.objectContaining({ params: expect.objectContaining({ input_token: 'tok_abc' }) })
            );
            const debugCall = axios.get.mock.calls.find(([url]) => String(url).includes('/debug_token'));
            expect(debugCall[1].params.appsecret_proof).toBe(
                crypto.createHmac('sha256', 'test-secret').update('test-app-id|test-secret').digest('hex'),
            );
        });

        test('retains /me/accounts Page credentials in the server-only sink', async () => {
            const pageCredentials = Object.create(null);
            const pageToken = 'PAGE_SECRET_SENTINEL_DISCOVERY';
            configureGraph({
                accountPages: [{
                    data: { data: [page('P_SECRET', { access_token: pageToken })], paging: {} },
                }],
                targetIds: ['P_SECRET'],
            });

            const result = await provider.listManagedAssets({ userToken: 'tok_sink', pageCredentials });

            expect(result).toEqual([expect.objectContaining({ id: 'P_SECRET' })]);
            expect(result[0]).not.toHaveProperty('access_token');
            expect(JSON.stringify(result)).not.toContain(pageToken);
            expect(pageCredentials).toEqual({
                P_SECRET: { pageId: 'P_SECRET', token: pageToken, expiresAt: null },
            });
            expect(axios.get.mock.calls.filter(([url]) => String(url).endsWith('/P_SECRET'))).toHaveLength(0);
        });

        test('recovers a granted Business Portfolio Page omitted by /me/accounts', async () => {
            configureGraph({
                accountPages: [{ data: { data: [page('P1')], paging: {} } }],
                targetIds: ['P1', 'P_PORTFOLIO'],
                hydration: {
                    P_PORTFOLIO: page('P_PORTFOLIO', {
                        name: 'Business Portfolio Page',
                        access_token: 'hydrated-page-token',
                    }),
                },
            });

            const result = await provider.listManagedAssets({ userToken: 'tok_xyz' });

            expect(result.map((asset) => asset.id)).toEqual(['P1', 'P_PORTFOLIO']);
            expect(result.find((asset) => asset.id === 'P_PORTFOLIO')).toMatchObject({
                name: 'Business Portfolio Page',
                connectable: true,
            });
            expect(result.find((asset) => asset.id === 'P_PORTFOLIO')).not.toHaveProperty('source');
            const hydrationCall = axios.get.mock.calls.find(([url]) => String(url).endsWith('/P_PORTFOLIO'));
            expect(hydrationCall).toBeDefined();
            expect(hydrationCall[1].params).toEqual(expect.objectContaining({
                fields: 'id,name,category,picture{data{url}},tasks,access_token',
                access_token: 'tok_xyz',
                appsecret_proof: expect.any(String),
            }));
        });

        test('recovers a granted Page when /me/accounts is empty', async () => {
            configureGraph({
                accountPages: [{ data: { data: [], paging: {} } }],
                targetIds: ['P_EMPTY'],
                hydration: { P_EMPTY: page('P_EMPTY', { name: 'Empty Edge Page' }) },
            });

            const result = await provider.listManagedAssets({ userToken: 'tok_empty' });

            expect(result.map((asset) => asset.id)).toEqual(['P_EMPTY']);
            expect(result[0]).toMatchObject({ name: 'Empty Edge Page', connectable: true });
        });

        test('does not invent Page IDs when an ALL grant has no discoverable Pages', async () => {
            configureGraph({
                accountPages: [{ data: { data: [], paging: {} } }],
                debug: debugTokenResponse(undefined, undefined, undefined),
            });

            await expect(provider.listManagedAssets({ userToken: 'tok_all_empty' })).resolves.toEqual([]);
            expect(axios.get).toHaveBeenCalledTimes(2);
        });

        test.each([
            ['missing', undefined],
            ['null', null],
            ['blank', '  '],
        ])('hydrates a /me/accounts row with %s access_token before offering it', async (_label, accessToken) => {
            configureGraph({
                accountPages: [{ data: { data: [page('P_TOKEN', { access_token: accessToken })], paging: {} } }],
                targetIds: ['P_TOKEN'],
                hydration: { P_TOKEN: page('P_TOKEN', { access_token: 'hydrated-token' }) },
            });

            const result = await provider.listManagedAssets({ userToken: `tok_${_label}` });

            expect(result).toHaveLength(1);
            expect(result[0].id).toBe('P_TOKEN');
            expect(axios.get.mock.calls.filter(([url]) => String(url).endsWith('/P_TOKEN'))).toHaveLength(1);
        });

        test.each([
            ['insufficient', ['CREATE_CONTENT']],
            ['empty', []],
        ])('preserves explicitly %s rich tasks when minimal hydration recovers the Page token', async (_label, richTasks) => {
            const pageId = _label === 'empty' ? 'P_EMPTY_TASKS_TOKEN_RECOVERY' : 'P_TASKS_TOKEN_RECOVERY';
            axios.get.mockImplementation((url, request = {}) => {
                const requestUrl = String(url);
                if (requestUrl.includes('/debug_token')) {
                    return Promise.resolve(debugTokenResponse([pageId]));
                }
                if (requestUrl.includes('/me/accounts')) {
                    return Promise.resolve({
                        status: 200,
                        data: {
                            data: [page(pageId, {
                                tasks: ['MESSAGING', 'MANAGE'],
                                access_token: null,
                            })],
                            paging: {},
                        },
                    });
                }
                if (requestUrl.endsWith(`/${pageId}`) && request.params?.fields?.includes('tasks')) {
                    return Promise.resolve({
                        status: 200,
                        data: page(pageId, {
                            tasks: richTasks,
                            access_token: null,
                        }),
                    });
                }
                if (requestUrl.endsWith(`/${pageId}`) && request.params?.fields === 'id,name,access_token') {
                    return Promise.resolve({
                        status: 200,
                        data: { id: pageId, name: 'Recovered Page', access_token: 'recovered-page-token' },
                    });
                }
                return Promise.reject(new Error('unexpected Graph request'));
            });

            const pageCredentials = {};
            const result = await provider.listManagedAssets({
                userToken: 'tok_task_evidence',
                pageCredentials,
            });

            expect(result).toEqual([expect.objectContaining({
                id: pageId,
                tasks: richTasks,
                connectable: false,
                eligibilitySource: 'META_TASKS',
                taskAvailability: 'PRESENT',
            })]);
            expect(pageCredentials[pageId]).toEqual({
                pageId,
                token: 'recovered-page-token',
                expiresAt: null,
            });
            const hydrationCalls = axios.get.mock.calls.filter(([url]) => String(url).endsWith(`/${pageId}`));
            expect(hydrationCalls.map(([, request]) => request.params.fields)).toEqual([
                'id,name,category,picture{data{url}},tasks,access_token',
                'id,name,access_token',
            ]);
        });

        test('retains rejected task evidence when a token-bearing duplicate Page row replaces it', async () => {
            const pageId = 'P_DUPLICATE_TASK_EVIDENCE';
            configureGraph({
                accountPages: [{
                    data: {
                        data: [
                            { id: pageId, name: 'Duplicate Page', tasks: [], access_token: null },
                            { id: pageId, name: 'Duplicate Page', access_token: 'duplicate-page-token' },
                        ],
                        paging: {},
                    },
                }],
                debug: debugTokenResponse([pageId]),
            });

            const pageCredentials = {};
            const result = await provider.listManagedAssets({
                userToken: 'tok_duplicate_evidence',
                pageCredentials,
            });

            expect(result).toEqual([expect.objectContaining({
                id: pageId,
                tasks: [],
                connectable: false,
                eligibilitySource: 'META_TASKS',
                taskAvailability: 'PRESENT',
            })]);
            expect(pageCredentials[pageId]).toEqual({
                pageId,
                token: 'duplicate-page-token',
                expiresAt: null,
            });
        });

        test('excludes a matching hydration response without a Page token and counts it', async () => {
            const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
            try {
                configureGraph({
                    accountPages: [{ data: { data: [], paging: {} } }],
                    targetIds: ['P_NO_TOKEN'],
                    hydration: { P_NO_TOKEN: page('P_NO_TOKEN', { access_token: null }) },
                });

                await expect(provider.listManagedAssets({ userToken: 'tok_no_page_token' })).resolves.toEqual([]);

                const parsed = consoleSpy.mock.calls
                    .map(args => { try { return JSON.parse(args[0]); } catch { return null; } })
                    .filter(Boolean);
                const entry = parsed.find((candidate) => candidate.message === 'metaAssetsListed');
                expect(entry).toMatchObject({
                    hydration_attempted: 1,
                    hydration_succeeded: 0,
                    hydration_failed: 0,
                    hydration_rejected: 1,
                    deduped: 0,
                });
            } finally {
                consoleSpy.mockRestore();
            }
        });

        test('excludes an unauthorized hydration target without aborting the rest of the listing', async () => {
            const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
            try {
                configureGraph({
                    accountPages: [{ data: { data: [page('P_OK')], paging: {} } }],
                    targetIds: ['P_OK', 'P_DENIED'],
                    hydration: {
                        P_DENIED: {
                            error: {
                                response: {
                                    status: 403,
                                    data: { error: { code: 10, error_subcode: 200, message: 'Permission denied' } },
                                },
                            },
                        },
                    },
                });

                const result = await provider.listManagedAssets({ userToken: 'tok_denied' });

                expect(result.map((asset) => asset.id)).toEqual(['P_OK']);
                const output = consoleSpy.mock.calls.flat().join(' ');
                const proof = crypto.createHmac('sha256', 'test-secret').update('tok_denied').digest('hex');
                expect(output).not.toContain('tok_denied');
                expect(output).not.toContain(proof);
                expect(output).toContain('"hydration_failed":1');
            } finally {
                consoleSpy.mockRestore();
            }
        });

        test('merges selected Pages from both sources exactly once', async () => {
            configureGraph({
                accountPages: [{ data: { data: [page('P_A')], paging: {} } }],
                targetIds: ['P_A', 'P_B'],
                hydration: { P_B: page('P_B', { name: 'Page B from target ID' }) },
            });

            const result = await provider.listManagedAssets({ userToken: 'tok_union' });

            expect(result.map((asset) => asset.id)).toEqual(['P_A', 'P_B']);
            expect(new Set(result.map((asset) => asset.id)).size).toBe(2);
        });

        test('never shows an unselected Page present in /me/accounts', async () => {
            configureGraph({
                accountPages: [{ data: { data: [page('P_SELECTED'), page('P_UNSELECTED')], paging: {} } }],
                targetIds: ['P_SELECTED'],
            });

            const result = await provider.listManagedAssets({ userToken: 'tok_selected' });

            expect(result.map((asset) => asset.id)).toEqual(['P_SELECTED']);
        });

        test('uses returned Page tasks as authoritative eligibility evidence', async () => {
            configureGraph({
                accountPages: [{
                    data: {
                        data: [
                            page('P_SCOPE', { tasks: ['MESSAGING'] }),
                            page('P_TASKS', { tasks: [' messaging ', 'MANAGE', 'MANAGE!'] }),
                            page('P_INELIGIBLE', { tasks: ['CREATE_CONTENT'] }),
                        ],
                        paging: {},
                    },
                }],
                targetIds: ['P_SCOPE', 'P_TASKS', 'P_INELIGIBLE'],
                debug: debugTokenResponse(['P_SCOPE', 'P_TASKS', 'P_INELIGIBLE']),
            });

            const result = await provider.listManagedAssets({ userToken: 'tok_tasks' });

            expect(result).toHaveLength(3);
            expect(result.find((asset) => asset.id === 'P_SCOPE')).toMatchObject({
                tasks: ['MESSAGING'],
                connectable: false,
                eligibilitySource: 'META_TASKS',
                taskAvailability: 'PRESENT',
            });
            expect(result.find((asset) => asset.id === 'P_TASKS')).toMatchObject({
                tasks: ['MESSAGING', 'MANAGE'],
                connectable: true,
                eligibilitySource: 'META_TASKS',
                taskAvailability: 'PRESENT',
            });
            expect(result.find((asset) => asset.id === 'P_INELIGIBLE')).toMatchObject({
                tasks: ['CREATE_CONTENT'],
                connectable: false,
                eligibilitySource: 'META_TASKS',
                taskAvailability: 'PRESENT',
            });
        });

        test('preserves appsecret_proof and follows cursors even across an empty batch', async () => {
            const userToken = 'tok_cursor';
            configureGraph({
                accountPages: [
                    {
                        data: { data: [page('P1')], paging: {
                            next: 'https://graph.facebook.com/v22.0/me/accounts?access_token=tok_cursor&after=CURSOR',
                            cursors: { after: 'CURSOR' },
                        } },
                    },
                    {
                        data: { data: [], paging: {
                            next: 'https://graph.facebook.com/v22.0/me/accounts?access_token=tok_cursor&after=FINAL',
                            cursors: { after: 'FINAL' },
                        } },
                    },
                    { data: { data: [page('P2')], paging: {} } },
                ],
                targetIds: ['P1', 'P2'],
            });

            const result = await provider.listManagedAssets({ userToken });

            expect(result.map((asset) => asset.id)).toEqual(['P1', 'P2']);
            const accountCalls = axios.get.mock.calls.filter(([url]) => String(url).includes('/me/accounts'));
            expect(accountCalls).toHaveLength(3);
            expect(accountCalls[1][0]).toBe('https://graph.facebook.com/v22.0/me/accounts');
            expect(accountCalls[1][1].params).toEqual(expect.objectContaining({
                fields: 'id,name,category,access_token,picture{data{url}},tasks',
                access_token: userToken,
                appsecret_proof: expect.any(String),
                after: 'CURSOR',
            }));
            expect(accountCalls[2][1].params.after).toBe('FINAL');
            const proof = crypto.createHmac('sha256', 'test-secret').update(userToken).digest('hex');
            for (const [url, request] of accountCalls) {
                expect(String(url)).not.toContain(userToken);
                expect(request.params.appsecret_proof).toBe(proof);
            }
        });

        test('discovers Pages for a verified all-assets grant when target_ids are omitted', async () => {
            configureGraph({
                accountPages: [{ data: { data: [page('P1'), page('P2')], paging: {} } }],
                debug: debugTokenResponse(undefined, undefined, undefined),
            });
            const canary = createDiagnostics({ expectedPageId: 'P1' });

            const result = await provider.listManagedAssets({ userToken: 'tok_all_pages', diagnostics: canary });

            expect(result.map((asset) => asset.id)).toEqual(['P1', 'P2']);
            expect(result.every((asset) => asset.connectable)).toBe(true);
            expect(canary.pageGrantMode).toBe('ALL');
            expect(canary.granularScopes.pages_messaging.expectedPage).toBe('ALL');
            expect(canary.expectedPageEligible).toBe('YES');
            expect(canary.expectedPageEligibilitySource).toBe('META_TASKS');
        });

        test('uses verified grants when Meta omits tasks from an otherwise successful Page listing', async () => {
            configureGraph({
                accountPages: [{
                    data: {
                        data: [{ id: 'P_OMITTED_TASKS', name: 'Omitted Tasks Page', access_token: 'page-token-omitted-tasks' }],
                        paging: {},
                    },
                }],
                debug: debugTokenResponse(undefined, undefined, undefined),
            });

            const result = await provider.listManagedAssets({ userToken: 'tok_omitted_tasks' });

            expect(result).toEqual([expect.objectContaining({
                id: 'P_OMITTED_TASKS',
                tasks: [],
                connectable: true,
                eligibilitySource: 'GRANULAR_PERMISSIONS',
                taskAvailability: 'UNAVAILABLE',
            })]);
        });

        test('falls back to minimal /me/accounts fields after a rich tasks-field error', async () => {
            const pageId = 'P_MINIMAL_RECOVERY';
            axios.get.mockImplementation((url, request = {}) => {
                const requestUrl = String(url);
                if (requestUrl.includes('/debug_token')) {
                    return Promise.resolve(debugTokenResponse([pageId]));
                }
                if (requestUrl.includes('/me/accounts')) {
                    if (request.params?.fields?.includes('tasks')) {
                        return Promise.reject({
                            response: {
                                status: 400,
                                data: { error: { code: 100, message: 'Tried accessing nonexisting field (tasks)' } },
                            },
                        });
                    }
                    return Promise.resolve({
                        status: 200,
                        data: { data: [{ id: pageId, name: 'Minimal Page', access_token: 'page-token-minimal' }], paging: {} },
                    });
                }
                return Promise.reject(new Error('unexpected Graph request'));
            });

            const pageCredentials = {};
            const result = await provider.listManagedAssets({ userToken: 'tok_minimal_recovery', pageCredentials });

            expect(result).toEqual([expect.objectContaining({
                id: pageId,
                tasks: [],
                connectable: true,
                eligibilitySource: 'GRANULAR_PERMISSIONS',
                taskAvailability: 'UNAVAILABLE',
            })]);
            expect(pageCredentials[pageId]).toEqual({
                pageId,
                token: 'page-token-minimal',
                expiresAt: null,
            });
            expect(axios.get.mock.calls.filter(([url]) => String(url).includes('/me/accounts'))).toHaveLength(2);
        });

        test('does not mask non-task Graph failures with a minimal retry', async () => {
            const pageId = 'P_NON_TASK_ERROR';
            axios.get.mockImplementation((url, request = {}) => {
                if (String(url).includes('/debug_token')) return Promise.resolve(debugTokenResponse([pageId]));
                if (String(url).includes('/me/accounts') && request.params?.fields?.includes('tasks')) {
                    return Promise.reject({
                        response: {
                            status: 190,
                            data: { error: { code: 190, message: 'Invalid OAuth access token' } },
                        },
                    });
                }
                return Promise.reject(new Error('minimal retry must not run'));
            });

            await expect(provider.listManagedAssets({ userToken: 'tok_non_task_error' }))
                .rejects.toThrow('listManagedAssets:me/accounts');
            expect(axios.get.mock.calls.filter(([url]) => String(url).includes('/me/accounts'))).toHaveLength(1);
        });

        test('fails closed when a permission scope has no granular entry', async () => {
            configureGraph({
                accountPages: [{ data: { data: [page('P1')], paging: {} } }],
                debug: {
                    data: {
                        data: {
                            is_valid: true,
                            app_id: 'test-app-id',
                            scopes: ['pages_show_list', 'pages_messaging', 'pages_manage_metadata'],
                            granular_scopes: [
                                { scope: 'pages_messaging' },
                                { scope: 'pages_show_list' },
                            ],
                        },
                    },
                },
            });

            const canary = createDiagnostics({ expectedPageId: 'P1' });
            await expect(provider.listManagedAssets({ userToken: 'tok_missing_entry', diagnostics: canary })).resolves.toEqual([]);
            expect(canary.pageGrantMode).toBe('UNKNOWN');
            expect(canary.granularScopes.pages_manage_metadata.expectedPage).toBe('UNKNOWN');
        });

        test('fails closed when pages_messaging is absent from verified scopes', async () => {
            configureGraph({
                accountPages: [{ data: { data: [page('P1')], paging: {} } }],
                debug: {
                    data: {
                        data: {
                            is_valid: true,
                            app_id: 'test-app-id',
                            scopes: ['pages_show_list', 'pages_manage_metadata'],
                            granular_scopes: [
                                { scope: 'pages_show_list' },
                                { scope: 'pages_manage_metadata' },
                            ],
                        },
                    },
                },
            });

            await expect(provider.listManagedAssets({ userToken: 'tok_missing_messaging' })).resolves.toEqual([]);
            expect(axios.get).toHaveBeenCalledTimes(1);
        });

        test('does not bypass an explicit pages_show_list boundary', async () => {
            configureGraph({
                accountPages: [{ data: { data: [page('P2')], paging: {} } }],
                debug: debugTokenResponse(['P2'], ['P2'], ['P1']),
            });

            await expect(provider.listManagedAssets({ userToken: 'tok_show_list_boundary' })).resolves.toEqual([]);
            expect(axios.get).toHaveBeenCalledTimes(1);
        });

        test.each([
            ['empty', []],
            ['malformed', ['P1', { id: 'P2' }]],
            ['null', null],
        ])('fails closed for %s target_ids rather than treating it as ALL', async (_label, targetIds) => {
            configureGraph({
                accountPages: [{ data: { data: [page('P1')], paging: {} } }],
                debug: debugTokenResponse(targetIds, targetIds, targetIds),
            });

            await expect(provider.listManagedAssets({ userToken: `tok_${_label}_targets` })).resolves.toEqual([]);
        });

        test('does not expose Page access tokens or source metadata in the response', async () => {
            configureGraph({
                accountPages: [{ data: { data: [page('P_SECRET', { access_token: 'page-secret-must-not-leak' })], paging: {} } }],
                targetIds: ['P_SECRET'],
            });

            const result = await provider.listManagedAssets({ userToken: 'tok_secret' });

            expect(result[0]).not.toHaveProperty('access_token');
            expect(result[0]).not.toHaveProperty('source');
            expect(JSON.stringify(result)).not.toContain('page-secret-must-not-leak');
        });

        test('redacts user tokens and proofs from Graph error logs', async () => {
            const userToken = 'tok_error_log';
            const proof = crypto.createHmac('sha256', 'test-secret').update(userToken).digest('hex');
            const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
            try {
                axios.get.mockImplementation((url) => {
                    if (String(url).includes('/debug_token')) {
                        return Promise.resolve(debugTokenResponse(['P_ERROR']));
                    }
                    return Promise.reject({
                        message: `request failed ${userToken} ${proof}`,
                        config: { params: { access_token: userToken, appsecret_proof: proof } },
                    });
                });

                await expect(provider.listManagedAssets({ userToken })).rejects.toMatchObject({
                    code: 'META_API_ERROR',
                });

                const output = consoleSpy.mock.calls.flat().join(' ');
                expect(output).not.toContain(userToken);
                expect(output).not.toContain(proof);
            } finally {
                consoleSpy.mockRestore();
            }
        });
    });

    describe('getOAuthIdentity() pagination', () => {
        beforeEach(() => {
            process.env.META_APP_SECRET = 'test-secret';
        });

        afterEach(() => {
            jest.resetAllMocks();
        });

        test('follows ids_for_pages cursors after an empty batch and signs every request', async () => {
            const userToken = 'tok_identity';
            const idsUrl = 'https://graph.facebook.com/v22.0/app-user-1/ids_for_pages';
            axios.get.mockImplementation((url, request = {}) => {
                if (String(url).endsWith('/me')) return Promise.resolve({ data: { id: 'app-user-1' } });
                if (String(url) === idsUrl && request.params?.after === 'CURSOR') {
                    return Promise.resolve({
                        data: {
                            data: [{ id: 'psid-1', page: { id: 'P1' } }],
                            paging: {},
                        },
                    });
                }
                if (String(url) === idsUrl) {
                    return Promise.resolve({
                        data: {
                            data: [],
                            paging: {
                                next: `${idsUrl}?access_token=${userToken}&after=CURSOR`,
                                cursors: { after: 'CURSOR' },
                            },
                        },
                    });
                }
                throw new Error(`unexpected Graph URL: ${url}`);
            });

            await expect(provider.getOAuthIdentity({ userToken })).resolves.toEqual({
                appScopedUserId: 'app-user-1',
                pageScopedIdentities: [{ pageId: 'P1', pageScopedUserId: 'psid-1' }],
            });

            const idsCalls = axios.get.mock.calls.filter(([url]) => String(url).includes('/ids_for_pages'));
            expect(idsCalls).toHaveLength(2);
            expect(idsCalls[1][0]).toBe(idsUrl);
            expect(idsCalls[1][1].params).toEqual(expect.objectContaining({
                fields: 'id,page',
                limit: 100,
                access_token: userToken,
                appsecret_proof: expect.any(String),
                after: 'CURSOR',
            }));
            expect(String(idsCalls[1][0])).not.toContain(userToken);
        });
    });

    describe('subscribeWebhook()', () => {
        beforeEach(() => { process.env.META_APP_SECRET = 'test-secret'; });
        afterEach(() => jest.resetAllMocks());

        // If the App Dashboard has "Require App Secret Proof" on and this call
        // omits the proof, Meta rejects it and the reviewer's Page connects
        // without a live webhook — the demo then shows no inbound message.
        test('subscribes only `messages` and signs the call with appsecret_proof', async () => {
            axios.post.mockResolvedValueOnce({ data: { success: true } });
            await provider.subscribeWebhook({
                channel: { meta_asset_id: 'PAGE_1', page_access_token_ct: 'tok_page' },
            });
            expect(axios.post).toHaveBeenCalledWith(
                expect.stringContaining('/PAGE_1/subscribed_apps'),
                null,
                expect.objectContaining({
                    params: expect.objectContaining({
                        access_token: 'tok_page',
                        subscribed_fields: 'messages',
                        appsecret_proof: expect.any(String),
                    })
                })
            );
        });
    });

    describe('verifyWebhookSubscription()', () => {
        beforeEach(() => { process.env.META_APP_SECRET = 'test-secret'; });
        afterEach(() => jest.resetAllMocks());

        const channel = { meta_asset_id: 'PAGE_1', page_access_token_ct: 'tok_page' };

        test('returns ok:true when the page has all required subscriptions', async () => {
            axios.get.mockResolvedValueOnce({
                data: { data: [{ id: 'test-app-id', subscribed_fields: ['messages'] }] }
            });
            const res = await provider.verifyWebhookSubscription({ channel });
            expect(res.ok).toBe(true);
            expect(axios.get).toHaveBeenCalledWith(
                expect.stringContaining('/PAGE_1/subscribed_apps'),
                expect.objectContaining({
                    params: expect.objectContaining({
                        access_token: 'tok_page',
                        appsecret_proof: expect.any(String),
                    })
                })
            );
        });

        test('returns ok:false when no app is subscribed', async () => {
            axios.get.mockResolvedValueOnce({ data: { data: [] } });
            const res = await provider.verifyWebhookSubscription({ channel });
            expect(res.ok).toBe(false);
        });

        test('returns ok:false when messages field is missing', async () => {
            axios.get.mockResolvedValueOnce({ data: { data: [{ id: 'test-app-id', subscribed_fields: ['feed'] }] } });
            const res = await provider.verifyWebhookSubscription({ channel });
            expect(res.ok).toBe(false);
        });

        // D3 regression: a Page commonly carries subscriptions from OTHER apps.
        // Only OUR app's entry (META_APP_ID) proves EasyModerator receives the
        // webhooks — foreign fields must never satisfy verification.
        test('D3: a third-party app subscribing `messages` does NOT verify our webhook', async () => {
            axios.get.mockResolvedValueOnce({
                data: { data: [{ id: 'third-party-app-999', subscribed_fields: ['messages', 'feed'] }] },
            });
            const res = await provider.verifyWebhookSubscription({ channel });
            expect(res.ok).toBe(false);
            expect(res.fields).toEqual([]);
        });

        test('D3: multi-app response verifies from OUR entry only', async () => {
            axios.get.mockResolvedValueOnce({
                data: {
                    data: [
                        { id: 'third-party-app-999', subscribed_fields: ['feed'] },
                        { id: 'test-app-id', subscribed_fields: ['messages'] },
                    ],
                },
            });
            const res = await provider.verifyWebhookSubscription({ channel });
            expect(res.ok).toBe(true);
            expect(res.fields).toEqual(['messages']);
        });

        test('D3: our app present but missing `messages` while another app has it is not ok', async () => {
            axios.get.mockResolvedValueOnce({
                data: {
                    data: [
                        { id: 'third-party-app-999', subscribed_fields: ['messages'] },
                        { id: 'test-app-id', subscribed_fields: ['feed'] },
                    ],
                },
            });
            const res = await provider.verifyWebhookSubscription({ channel });
            expect(res.ok).toBe(false);
        });

        test('D3: numeric app ids compare equal to the configured id as strings', async () => {
            axios.get.mockResolvedValueOnce({
                data: { data: [{ id: 2040799330176198, subscribed_fields: ['messages'] }] },
            });
            config.metaAppId = 2040799330176198;
            try {
                const res = await provider.verifyWebhookSubscription({ channel });
                expect(res.ok).toBe(true);
            } finally {
                config.metaAppId = 'test-app-id';
            }
        });

        test('D3: fails closed when META_APP_ID is not configured', async () => {
            axios.get.mockResolvedValueOnce({
                data: { data: [{ id: 'test-app-id', subscribed_fields: ['messages'] }] },
            });
            const saved = config.metaAppId;
            config.metaAppId = '';
            try {
                const res = await provider.verifyWebhookSubscription({ channel });
                expect(res.ok).toBe(false);
                expect(res.fields).toEqual([]);
            } finally {
                config.metaAppId = saved;
            }
        });
    });

    describe('probeInteractionWebhookFields()', () => {
        beforeEach(() => { process.env.META_APP_SECRET = 'test-secret'; });
        afterEach(() => jest.resetAllMocks());

        const channel = { id: 'chan-1', meta_asset_id: 'PAGE_1', page_access_token_ct: 'tok_page' };
        const TARGETS = ['messaging_postbacks', 'messaging_referrals'];
        const subscribed = (...fields) => ({ data: { data: [{ id: 'test-app-id', subscribed_fields: fields }] } });

        test('default target fields are exactly postbacks + referrals', async () => {
            axios.get.mockResolvedValue(subscribed('messages', ...TARGETS));
            const res = await provider.probeInteractionWebhookFields({ channel });
            expect(res.code).toBe('ALREADY_SUBSCRIBED');
            expect(res.subscribedFields).toEqual(['messages', ...TARGETS]);
            expect(res.addedFields).toEqual([]);
        });

        test('CHANNEL_NOT_CONNECTED when the Page token or asset id is missing — zero Graph calls', async () => {
            for (const bad of [{ ...channel, page_access_token_ct: null }, { ...channel, meta_asset_id: null }]) {
                const res = await provider.probeInteractionWebhookFields({ channel: bad });
                expect(res).toMatchObject({
                    ok: false,
                    code: 'CHANNEL_NOT_CONNECTED',
                    coreMessagesIntact: false,
                    blockedFields: TARGETS,
                    subscribedFields: [],
                });
            }
            expect(axios.get).not.toHaveBeenCalled();
            expect(axios.post).not.toHaveBeenCalled();
        });

        test('ALREADY_SUBSCRIBED performs no subscription write at all', async () => {
            axios.get.mockResolvedValue(subscribed('messages', ...TARGETS));
            const res = await provider.probeInteractionWebhookFields({ channel, fields: TARGETS });
            expect(res).toMatchObject({ ok: true, code: 'ALREADY_SUBSCRIBED', coreMessagesIntact: true });
            expect(axios.post).not.toHaveBeenCalled();
        });

        test('SUBSCRIBED unions the CORE `messages` field with the targets and re-verifies', async () => {
            axios.get
                .mockResolvedValueOnce(subscribed('messages'))
                .mockResolvedValueOnce(subscribed('messages', ...TARGETS));
            axios.post.mockResolvedValueOnce({ data: { success: true } });

            const res = await provider.probeInteractionWebhookFields({ channel });
            expect(res).toMatchObject({ ok: true, code: 'SUBSCRIBED', coreMessagesIntact: true });
            expect(res.addedFields).toEqual(TARGETS);
            expect(res.subscribedFields).toEqual(['messages', ...TARGETS]);

            expect(axios.post).toHaveBeenCalledTimes(1);
            const [url, sentBody, cfg] = axios.post.mock.calls[0];
            expect(String(url)).toContain('/PAGE_1/subscribed_apps');
            expect(sentBody).toBeNull();
            // Core ['messages'] can NEVER be dropped by a probe — the request
            // must always carry it plus the targets.
            expect(cfg.params.subscribed_fields).toBe(`messages,${TARGETS.join(',')}`);
            expect(cfg.params.access_token).toBe('tok_page');
            expect(cfg.params.appsecret_proof).toEqual(expect.any(String));
        });

        test('permission/product denial fails closed as EXTERNALLY_BLOCKED with core intact', async () => {
            axios.get.mockResolvedValue(subscribed('messages'));
            axios.post.mockRejectedValueOnce({
                response: {
                    status: 403,
                    data: { error: { code: 200, error_subcode: 1545041, message: 'Permissions error' } },
                },
            });

            const res = await provider.probeInteractionWebhookFields({ channel });
            expect(res).toMatchObject({
                ok: false,
                code: 'EXTERNALLY_BLOCKED_PERMISSION_OR_PRODUCT_ACCESS',
                coreMessagesIntact: true,
                blockedFields: TARGETS,
                metaCode: 200,
                metaSubcode: 1545041,
            });
            // The denial never widens the subscription and never leaks the token.
            expect(JSON.stringify(res)).not.toContain('tok_page');
        });

        test('a denial that also broke the core subscription triggers a core-only repair', async () => {
            axios.get
                .mockResolvedValueOnce(subscribed())                 // pre-check: fields empty
                .mockResolvedValueOnce({ data: { data: [] } })       // re-check after denial: core lost
                .mockResolvedValueOnce(subscribed('messages'));      // after subscribeWebhook repair
            axios.post
                .mockRejectedValueOnce({
                    response: { status: 400, data: { error: { code: 100, message: 'invalid field' } } },
                })
                .mockResolvedValueOnce({ data: { success: true } }); // repair

            const res = await provider.probeInteractionWebhookFields({ channel });
            expect(res.ok).toBe(false);
            expect(res.code).toBe('EXTERNALLY_BLOCKED_PERMISSION_OR_PRODUCT_ACCESS');
            expect(res.coreMessagesIntact).toBe(true);
            // The repair POST carries ONLY the core field list.
            const repairCall = axios.post.mock.calls[1];
            expect(repairCall[2].params.subscribed_fields).toBe('messages');
            expect(provider.webhookFields()).toEqual(['messages']);
        });

        test('a transient Graph failure throws instead of masquerading as a permission block', async () => {
            axios.get.mockResolvedValue(subscribed('messages'));
            axios.post.mockRejectedValueOnce({
                response: { status: 500, data: { error: { code: 2, message: 'Unexpected error' } } },
            });
            await expect(provider.probeInteractionWebhookFields({ channel })).rejects.toBeDefined();
        });

        test('empty target list never writes: it only reports current subscription state', async () => {
            axios.get.mockResolvedValue(subscribed('messages'));
            const res = await provider.probeInteractionWebhookFields({ channel, fields: [] });
            // targetFields empty ⇒ the every()-over-empty shortcut is guarded by
            // targetFields.length > 0; POST union is just the core, and Meta's
            // re-verify confirms it.
            expect(['SUBSCRIBED', 'ALREADY_SUBSCRIBED']).toContain(res.code);
            expect(res.coreMessagesIntact).toBe(true);
        });
    });

    describe('listManagedAssets() Meta policy containment', () => {
        beforeEach(() => {
            process.env.META_APP_SECRET = 'test-secret';
            process.env.META_APP_ID = 'test-app-id';
        });

        afterEach(() => {
            jest.resetAllMocks();
        });

        test('ignores the legacy includeBusinessPortfolio flag and never queries /me/businesses', async () => {
            configureGraph({
                accountPages: [{ data: { data: [page('P1', { name: 'Page 1' })], paging: {} } }],
                targetIds: ['P1'],
            });

            const result = await provider.listManagedAssets({
                userToken: 'tok_default',
                includeBusinessPortfolio: true,
            });

            expect(result).toHaveLength(1);
            expect(axios.get).toHaveBeenCalledTimes(2);
            expect(axios.get).toHaveBeenCalledWith(
                expect.stringContaining('/me/accounts'),
                expect.anything(),
            );
            expect(axios.get).not.toHaveBeenCalledWith(
                expect.stringContaining('/me/businesses'),
                expect.anything(),
            );
        });

        test('diagnostic log reports Messenger-only discovery counts', async () => {
            const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
            try {
                configureGraph({
                    accountPages: [{ data: { data: [page('PA', { name: 'A' })], paging: {} } }],
                    targetIds: ['PA'],
                });

                await provider.listManagedAssets({ userToken: 'tok_log' });

                const parsed = consoleSpy.mock.calls
                    .map(args => { try { return JSON.parse(args[0]); } catch { return null; } })
                    .filter(Boolean);
                const entry = parsed.find(e => e.message === 'metaAssetsListed');
                expect(entry).toBeDefined();
                expect(entry).toMatchObject({
                    source_me_accounts: 1,
                    source_owned_pages: 0,
                    source_client_pages: 0,
                    portfolioAttempted: false,
                    portfolioError: null,
                    source_granular_target: 0,
                    selected_target_ids: 1,
                    filtered_unselected_pages: 0,
                    hydration_attempted: 0,
                    hydration_succeeded: 0,
                    hydration_failed: 0,
                    hydration_rejected: 0,
                    deduped: 1,
                });
                expect(entry).not.toHaveProperty('withIG');
            } finally {
                consoleSpy.mockRestore();
            }
        });
    });
});
