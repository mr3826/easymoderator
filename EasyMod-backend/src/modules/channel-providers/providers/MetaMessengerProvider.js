/**
 * MetaMessengerProvider
 *
 * Concrete ChannelProvider for Facebook Messenger.
 * Talks to the Meta Graph API on behalf of a connected Page.
 *
 * All outbound sends MUST receive a PolicyDecision with allow=true.
 * When decision.augment.message_tag is set AND currently valid per
 * templateRequired.rule (twentyFourHourWindow augments a tag only for an
 * explicitly requested, permission-held, evidence-backed case), it is put on
 * the wire as the Send API `tag`; retired/unknown tags are never emitted.
 *
 * Every Graph API call atomically reserves its rate-limit slot immediately
 * beforehand via rateLimit.rule's reserveSendSlot() — see the send loop
 * below — and releases it if the send itself fails, so a slot Meta never
 * actually consumed doesn't count against the window.
 */

'use strict';

const axios = require('axios');
const crypto = require('crypto');
const ChannelProvider = require('../ChannelProvider');
const config = require('../../../config/config');
const { AppError } = require('../../../utils/AppError');
const { createLogger } = require('../../../utils/structured-logger');
const { reserveSendSlot, releaseSendSlot } = require('../../policy/rules/rateLimit.rule');
const { isAllowedMessageTag } = require('../../policy/rules/templateRequired.rule');
const { evaluatePageEligibility } = require('../meta-page-eligibility');
const {
    recordGraphError,
    sanitizeTasks,
} = require('../meta-discovery-canary');
const {
    PAGE_GRANT_MODE,
    interpretPageGrants,
    intersectPageGrants,
    grantAllowsPage,
    grantCanAuthorizePages,
} = require('../meta-page-grants');

const logger = createLogger('MetaMessengerProvider');

const GRAPH_VERSION = process.env.META_GRAPH_API_VERSION || 'v22.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

// The permissions this integration runs on. Under Facebook Login for Business
// these are OWNED BY THE META LOGIN CONFIGURATION (META_LOGIN_CONFIG_ID), not
// requested at runtime — Meta's guidance for a configuration-driven dialog is
// that `config_id` replaces `scope` and that `scope` should not be sent.
// This list is kept as the in-repo record of what that configuration must
// grant, and as the assertion target for the App Review surface tests. It is
// deliberately NOT put on the authorization URL. See
// docs/incidents/2026-09-22-meta-login-unavailable.md.
const CONFIGURATION_OWNED_PERMISSIONS = [
    'pages_show_list',
    'pages_messaging',
    'pages_manage_metadata'
];

// Meta Login Configuration IDs are numeric identifiers. Reject anything else
// rather than putting a malformed value on the wire, where it surfaces to the
// merchant as an opaque "Feature unavailable" dialog with nothing in our logs.
const LOGIN_CONFIG_ID_PATTERN = /^[0-9]{6,32}$/;

const WEBHOOK_FIELDS = [
    'messages'
];

const PAGE_FIELDS =
    'id,name,category,access_token,' +
    'picture{data{url}},' +
    'tasks';
const PAGE_HYDRATION_FIELDS =
    'id,name,category,picture{data{url}},tasks,access_token';
const PAGE_MINIMAL_FIELDS = 'id,name,access_token';
const PAGE_HYDRATION_CONCURRENCY = 5;
const GRANULAR_PERMISSION_ELIGIBILITY_SOURCE = 'GRANULAR_PERMISSIONS';
const META_TASK_ELIGIBILITY_SOURCE = 'META_TASKS';
const PAGE_TASK_AVAILABILITY = Object.freeze({ PRESENT: 'PRESENT', UNAVAILABLE: 'UNAVAILABLE' });

// Meta accepts appsecret_proof on every Graph call and *requires* it once
// "Require App Secret Proof for Server API calls" is switched on in the App
// Dashboard. Send it everywhere — page-token calls included — so flipping that
// setting can never break the Send API or the webhook subscription mid-review.
// Returns null (which axios drops from the query string) when either input is
// missing, so a misconfigured test env degrades instead of throwing.
function appsecretProof(token) {
    const secret = config.metaAppSecret || process.env.META_APP_SECRET;
    if (!secret || !token) return null;
    return crypto.createHmac('sha256', secret).update(token).digest('hex');
}

function requestSecrets(err) {
    const secretParamNames = new Set([
        'access_token',
        'input_token',
        'appsecret_proof',
        'client_secret',
        'fb_exchange_token',
    ]);
    const secrets = Object.entries(err?.config?.params || {})
        .filter(([name, value]) => secretParamNames.has(name) && typeof value === 'string' && value.length > 0)
        .map(([, value]) => value);
    try {
        const url = new URL(err?.config?.url || '');
        for (const name of secretParamNames) {
            const value = url.searchParams.get(name);
            if (value) secrets.push(value);
        }
    } catch (_) { /* URL is optional on mocked/non-Axios errors. */ }
    return [...new Set(secrets.flatMap((secret) => [secret, encodeURIComponent(secret)]))];
}

function redactRequestSecrets(value, err) {
    let safe = String(value || 'Unknown Meta API error');
    for (const secret of requestSecrets(err)) {
        safe = safe.split(secret).join('[REDACTED]');
    }
    return safe;
}

function metaError(err, context) {
    const msg = err.response?.data?.error?.message || err.message;
    const meta = err.response?.data?.error || {};
    const safeMsg = redactRequestSecrets(msg, err);
    logger.error(`${context} failed`, {
        metaCode: meta.code,
        metaSubcode: meta.error_subcode,
        metaMsg: safeMsg,
    });
    const appError = new AppError(`${context}: ${safeMsg}`, err.response?.status || 500);
    // Preserve an explicit application-level safety failure. A successful HTTP
    // response without Meta's message_id is not a transport/API error: it is an
    // unconfirmed delivery and must remain retry-visible to the caller.
    appError.code = err.code === 'PROVIDER_NO_ACK' ? err.code : 'META_API_ERROR';
    appError.details = {
        metaCode: meta.code || null,
        metaSubcode: meta.error_subcode || null,
        isTransient: meta.is_transient === true,
    };
    return appError;
}

function isOptionalTasksFieldError(err) {
    const graphError = err?.response?.data?.error || {};
    const message = String(graphError.message || err?.message || '');
    return Number(graphError.code) === 100 && /\btasks\b/i.test(message);
}

function hasNonEmptyAccessToken(page) {
    return typeof page?.access_token === 'string' && page.access_token.trim().length > 0;
}

function pageEligibility(page, pageGrant) {
    const tasksReturned = Object.prototype.hasOwnProperty.call(page || {}, 'tasks');
    const eligibility = evaluatePageEligibility(page?.tasks);
    if (tasksReturned) {
        return {
            ...eligibility,
            eligibilitySource: META_TASK_ELIGIBILITY_SOURCE,
            taskAvailability: PAGE_TASK_AVAILABILITY.PRESENT,
        };
    }

    // When Meta rejects the optional tasks field, the verified pair of
    // Page-scoped permissions plus the exact Page access token is the same
    // authorization evidence already used by the portfolio fallback. Keep
    // that projection explicit instead of pretending Meta returned tasks.
    if (hasNonEmptyAccessToken(page) && grantCanAuthorizePages(pageGrant)) {
        return {
            tasks: eligibility.tasks,
            connectable: true,
            reason: null,
            eligibilitySource: GRANULAR_PERMISSION_ELIGIBILITY_SOURCE,
            taskAvailability: PAGE_TASK_AVAILABILITY.UNAVAILABLE,
        };
    }

    return {
        ...eligibility,
        taskAvailability: PAGE_TASK_AVAILABILITY.UNAVAILABLE,
    };
}

function hasPageTaskEvidence(page) {
    return Object.prototype.hasOwnProperty.call(page || {}, 'tasks');
}

function preservePageTaskEvidence(page, ...priorPages) {
    const evidencePages = [...priorPages, page].filter(hasPageTaskEvidence);
    if (evidencePages.length === 0) return page;

    // Any explicit rejection wins over an unavailable or later-sufficient
    // response. Credential retries may recover tokens, but cannot upgrade the
    // Page's authorization evidence.
    const rejectedEvidence = evidencePages.find((candidate) =>
        !evaluatePageEligibility(candidate.tasks).connectable);
    const selectedEvidence = rejectedEvidence || evidencePages[evidencePages.length - 1];
    return { ...page, tasks: selectedEvidence.tasks };
}

function canaryDiscoveryError(err, context, diagnostics) {
    recordGraphError(diagnostics, context, err);
    const graphError = err?.response?.data?.error || {};
    return new AppError(
        'Meta Page discovery failed during the authorized canary. Please retry Facebook authorization.',
        502,
        'META_PAGE_DISCOVERY_FAILED',
        {
            metaCode: Number.isInteger(graphError.code) ? graphError.code : null,
            metaSubcode: Number.isInteger(graphError.error_subcode) ? graphError.error_subcode : null,
        },
    );
}

function recordDebugTokenDiagnostics(diagnostics, debugData, appId, pageGrants) {
    if (!diagnostics) return;
    const granularScopes = Array.isArray(debugData?.granular_scopes) ? debugData.granular_scopes : [];
    const scopes = new Set(Array.isArray(debugData?.scopes) ? debugData.scopes : []);
    const expiresAt = Number(debugData?.expires_at);
    diagnostics.tokenValid = debugData?.is_valid === true
        ? 'YES'
        : debugData?.is_valid === false ? 'NO' : 'UNKNOWN';
    diagnostics.tokenAppIdMatches = debugData?.app_id === null || debugData?.app_id === undefined
        ? 'UNKNOWN'
        : String(debugData.app_id) === String(appId) ? 'YES' : 'NO';
    diagnostics.tokenExpirationStatus = Number.isFinite(expiresAt) && expiresAt > 0
        ? expiresAt * 1000 > Date.now() ? 'VALID' : 'EXPIRED'
        : 'UNKNOWN';

    for (const scopeName of ['pages_show_list', 'pages_messaging', 'pages_manage_metadata']) {
        const entry = granularScopes.find((scope) => scope?.scope === scopeName);
        const targetIds = Array.isArray(entry?.target_ids) ? entry.target_ids.map(String) : [];
        const grant = pageGrants?.[scopeName];
        diagnostics.granularScopes[scopeName] = {
            granted: scopes.has(scopeName) ? 'YES' : entry ? 'UNKNOWN' : 'NO',
            expectedPage: grant?.mode === PAGE_GRANT_MODE.ALL
                ? 'ALL'
                : grant?.mode === PAGE_GRANT_MODE.UNKNOWN
                    ? 'UNKNOWN'
                    : targetIds.includes(diagnostics.expectedPageId) ? 'YES' : 'NO',
            targetCount: targetIds.length,
            mode: grant?.mode || PAGE_GRANT_MODE.UNKNOWN,
        };
    }
    diagnostics.messagingGrantMode = pageGrants?.pages_messaging?.mode || PAGE_GRANT_MODE.UNKNOWN;
    diagnostics.metadataGrantMode = pageGrants?.pages_manage_metadata?.mode || PAGE_GRANT_MODE.UNKNOWN;
    diagnostics.showListGranted = pageGrants?.pages_show_list?.mode || PAGE_GRANT_MODE.UNKNOWN;
    if (pageGrants) {
        const operationalGrant = intersectPageGrants(
            pageGrants.pages_messaging,
            pageGrants.pages_manage_metadata,
        );
        diagnostics.operationalGrantMode = operationalGrant.mode;
        diagnostics.pageGrantMode = intersectPageGrants(
            operationalGrant,
            pageGrants.pages_show_list,
        ).mode;
    } else {
        diagnostics.operationalGrantMode = PAGE_GRANT_MODE.UNKNOWN;
        diagnostics.pageGrantMode = PAGE_GRANT_MODE.UNKNOWN;
    }
}

function recordPageCollectionDiagnostics(diagnostics, stageName, pages) {
    if (!diagnostics) return;
    const stage = diagnostics.meAccounts[stageName];
    const expectedPage = (Array.isArray(pages) ? pages : [])
        .find((page) => String(page?.id || '') === diagnostics.expectedPageId);
    stage.status = 'PASS';
    stage.pageCount = Array.isArray(pages) ? pages.length : 0;
    stage.expectedPage = expectedPage ? 'YES' : 'NO';
    stage.expectedPageToken = expectedPage
        ? hasNonEmptyAccessToken(expectedPage) ? 'YES' : 'NO'
        : 'UNKNOWN';
    if (expectedPage) {
        diagnostics.expectedPageTasks = sanitizeTasks(expectedPage.tasks);
        diagnostics.expectedPageEligible = Array.isArray(expectedPage.tasks)
            ? evaluatePageEligibility(expectedPage.tasks).connectable ? 'YES' : 'NO'
            : 'UNKNOWN';
        diagnostics.expectedPageEligibilitySource = Array.isArray(expectedPage.tasks) ? 'META_TASKS' : 'UNKNOWN';
    }
}

function retainPageCredential(pageCredentials, page) {
    if (!pageCredentials || typeof pageCredentials !== 'object') return;
    if (page?.id === null || page?.id === undefined || !hasNonEmptyAccessToken(page)) return;

    const pageId = String(page.id);
    pageCredentials[pageId] = {
        pageId,
        token: page.access_token,
        expiresAt: null,
    };
}

/**
 * Follow Graph cursors without reusing Meta's `paging.next` URL. Meta embeds
 * the user token in that URL, and using it would also drop the signed params
 * required when App Secret Proof is enabled.
 */
async function paginateGraphCollection(url, params, diagnostics = null, stageName = null) {
    const items = [];
    let after = params?.after ?? null;
    const seenCursors = new Set();
    let requestCount = 0;

    while (true) {
        const response = await axios.get(url, {
            params: after !== null && after !== undefined && String(after).length > 0
                ? { ...params, after }
                : { ...params },
        });
        requestCount += 1;
        if (diagnostics && stageName) {
            diagnostics.meAccounts[stageName].httpStatus = Number.isInteger(response.status)
                ? response.status
                : 200;
            diagnostics.meAccounts[stageName].requestCount = requestCount;
        }
        const batch = Array.isArray(response.data?.data) ? response.data.data : [];
        items.push(...batch);

        const nextAfter = response.data?.paging?.cursors?.after;
        if (nextAfter === null || nextAfter === undefined || String(nextAfter).length === 0) {
            if (diagnostics && stageName) diagnostics.meAccounts[stageName].paginationCompleted = 'YES';
            break;
        }

        const cursor = String(nextAfter);
        if (cursor === String(after) || seenCursors.has(cursor)) {
            if (diagnostics && stageName) diagnostics.meAccounts[stageName].paginationCompleted = 'NO';
            break;
        }
        seenCursors.add(cursor);
        after = nextAfter;
    }

    return items;
}

async function mapWithConcurrency(values, concurrency, mapper) {
    const results = new Array(values.length);
    let nextIndex = 0;
    const workerCount = Math.min(concurrency, values.length);

    const worker = async () => {
        while (true) {
            const index = nextIndex++;
            if (index >= values.length) return;
            results[index] = await mapper(values[index], index);
        }
    };

    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return results;
}

async function hydratePageByIdMinimal(pageId, userToken, pageCredentials, diagnostics = null, priorPage = null) {
    try {
        const response = await axios.get(`${GRAPH_BASE}/${encodeURIComponent(pageId)}`, {
            params: {
                fields: PAGE_MINIMAL_FIELDS,
                access_token: userToken,
                appsecret_proof: appsecretProof(userToken),
            },
        });
        const page = preservePageTaskEvidence(response.data, priorPage);
        const pageIdMatches = String(page?.id) === String(pageId);
        const hasToken = pageIdMatches && hasNonEmptyAccessToken(page);
        if (diagnostics) {
            diagnostics.hydration.minimal.httpStatus = Number.isInteger(response.status) ? response.status : 200;
            diagnostics.hydration.minimal.status = hasToken ? 'PASS' : 'REJECTED';
            diagnostics.hydration.minimal.expectedPageToken = hasToken ? 'YES' : 'NO';
        }
        if (!hasToken) return { page: null, status: 'rejected' };

        retainPageCredential(pageCredentials, page);
        return { page, status: 'succeeded' };
    } catch (err) {
        if (diagnostics) {
            diagnostics.hydration.minimal.status = 'FAIL';
            recordGraphError(diagnostics, 'minimal_hydration', err);
        }
        return { page: null, status: 'failed' };
    }
}

async function hydratePageById(pageId, userToken, pageCredentials, diagnostics = null, sourcePage = null) {
    try {
        const response = await axios.get(`${GRAPH_BASE}/${encodeURIComponent(pageId)}`, {
            params: {
                fields: PAGE_HYDRATION_FIELDS,
                access_token: userToken,
                appsecret_proof: appsecretProof(userToken),
            },
        });
        const page = preservePageTaskEvidence(response.data, sourcePage);
        const isExpectedPage = diagnostics && String(pageId) === diagnostics.expectedPageId;
        if (String(page?.id) !== String(pageId)) {
            logger.warn('metaPageHydrationRejected', { pageId, reason: 'ID_MISMATCH' });
            if (isExpectedPage) {
                diagnostics.hydration.rich.httpStatus = Number.isInteger(response.status) ? response.status : 200;
                diagnostics.hydration.rich.status = 'REJECTED';
                diagnostics.hydration.rich.expectedPageToken = 'NO';
                diagnostics.hydration.rich.expectedPageTasks = [];
            }
            return { page: null, status: 'rejected' };
        }
        if (!hasNonEmptyAccessToken(page)) {
            logger.warn('metaPageHydrationRejected', { pageId, reason: 'ACCESS_TOKEN_MISSING' });
            if (isExpectedPage) {
                diagnostics.hydration.rich.httpStatus = Number.isInteger(response.status) ? response.status : 200;
                diagnostics.hydration.rich.status = 'REJECTED';
                diagnostics.hydration.rich.expectedPageToken = 'NO';
                diagnostics.hydration.rich.expectedPageTasks = sanitizeTasks(page.tasks);
                diagnostics.expectedPageTasks = sanitizeTasks(page.tasks);
                diagnostics.expectedPageEligible = evaluatePageEligibility(page.tasks).connectable ? 'YES' : 'NO';
            }
            return hydratePageByIdMinimal(pageId, userToken, pageCredentials, diagnostics, page);
        }
        retainPageCredential(pageCredentials, page);
        if (isExpectedPage) {
            diagnostics.hydration.rich.httpStatus = Number.isInteger(response.status) ? response.status : 200;
            diagnostics.hydration.rich.status = 'PASS';
            diagnostics.hydration.rich.expectedPageToken = 'YES';
            diagnostics.hydration.rich.expectedPageTasks = sanitizeTasks(page.tasks);
            diagnostics.expectedPageTasks = sanitizeTasks(page.tasks);
            diagnostics.expectedPageEligible = evaluatePageEligibility(page.tasks).connectable ? 'YES' : 'NO';
        }
        return { page, status: 'succeeded' };
    } catch (err) {
        // Never serialize the Graph error or request config: either can contain
        // the user token or its appsecret_proof.
        logger.warn('metaPageHydrationFailed', {
            pageId,
            metaCode: err.response?.data?.error?.code || null,
            metaSubcode: err.response?.data?.error?.error_subcode || null,
        });
        if (!isOptionalTasksFieldError(err)) {
            if (diagnostics && String(pageId) === diagnostics.expectedPageId) {
                diagnostics.hydration.rich.status = 'FAIL';
                recordGraphError(diagnostics, 'rich_hydration', err);
            }
            return { page: null, status: 'failed' };
        }
        if (diagnostics && String(pageId) === diagnostics.expectedPageId) {
            diagnostics.hydration.rich.status = 'FAIL';
            recordGraphError(diagnostics, 'rich_hydration', err);
        }
        return hydratePageByIdMinimal(pageId, userToken, pageCredentials, diagnostics, sourcePage);
    }
}

class MetaMessengerProvider extends ChannelProvider {

    get platform() { return 'facebook'; }

    async buildAuthUrl({ state, scopes, redirectUri }) {
        // Facebook Login for Business is configuration-driven: the dashboard
        // Login Configuration owns the permission set, and `config_id` selects
        // it. The legacy classic-Login contract (scope=..., no config_id) is
        // what produced the 2026-09-22 "Feature unavailable" outage, so there is
        // no fallback to it — a missing or malformed configuration ID fails
        // closed here, in every environment, rather than silently downgrading
        // the authorization contract. Production boot also refuses to start
        // without META_LOGIN_CONFIG_ID (production-config.validator.js).
        //
        // The base provider contract's `scopes` argument is intentionally
        // ignored: permissions are not negotiable at runtime under this product,
        // so a caller can neither broaden nor narrow the consent request.
        const configId = String(config.metaLoginConfigId || '').trim();
        if (!LOGIN_CONFIG_ID_PATTERN.test(configId)) {
            throw new AppError(
                'Facebook login is not configured. Set META_LOGIN_CONFIG_ID to the '
                + 'Meta Login Configuration ID for this app.',
                500,
                'META_LOGIN_CONFIG_ID_INVALID',
            );
        }

        // Parameter set per Meta's manual login flow + Facebook Login for
        // Business guidance for a USER access token configuration:
        //   - config_id replaces scope (scope is deliberately absent)
        //   - response_type=code is the manual flow's documented default and is
        //     what this server-side exchange needs
        //   - override_default_response_type is NOT sent: it is documented only
        //     for business integration system user (SUAT/BISU) configurations,
        //     which this app does not use for merchant login.
        const params = new URLSearchParams({
            client_id: config.metaAppId,
            redirect_uri: redirectUri || config.metaOAuthRedirectUri,
            config_id: configId,
            response_type: 'code',
            state
        });
        return `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth?${params}`;
    }

    async exchangeCode({ code, redirectUri, diagnostics = null }) {
        try {
            const short = await axios.get(`${GRAPH_BASE}/oauth/access_token`, {
                params: {
                    client_id: config.metaAppId,
                    client_secret: config.metaAppSecret,
                    redirect_uri: redirectUri || config.metaOAuthRedirectUri,
                    code
                }
            });
            const shortToken = short.data.access_token;

            // Extend to long-lived (~60 days)
            const long = await axios.get(`${GRAPH_BASE}/oauth/access_token`, {
                params: {
                    grant_type: 'fb_exchange_token',
                    client_id: config.metaAppId,
                    client_secret: config.metaAppSecret,
                    fb_exchange_token: shortToken,
                    appsecret_proof: appsecretProof(shortToken)
                }
            });

            const { access_token, expires_in } = long.data;
            return {
                userToken: access_token,
                expiresAt: expires_in ? new Date(Date.now() + expires_in * 1000) : null
            };
        } catch (err) {
            if (diagnostics) throw canaryDiscoveryError(err, 'exchangeCode', diagnostics);
            throw metaError(err, 'exchangeCode');
        }
    }

    async getPageGrants({ userToken, diagnostics = null }) {
        const appId = config.metaAppId || process.env.META_APP_ID;
        const appSecret = config.metaAppSecret || process.env.META_APP_SECRET;
        const appAccessToken = `${appId}|${appSecret}`;
        try {
            const resp = await axios.get(`${GRAPH_BASE}/debug_token`, {
                params: {
                    input_token: userToken,
                    access_token: appAccessToken,
                    appsecret_proof: appsecretProof(appAccessToken),
                },
            });
            const debugData = resp.data?.data || {};
            const pageGrants = interpretPageGrants(debugData, appId);
            if (diagnostics) {
                diagnostics.debugTokenHttpStatus = Number.isInteger(resp.status) ? resp.status : 200;
                recordDebugTokenDiagnostics(diagnostics, debugData, appId, pageGrants);
            }
            return pageGrants;
        } catch (err) {
            if (diagnostics) throw canaryDiscoveryError(err, 'debug_token', diagnostics);
            throw metaError(err, 'debugTokenGranularScopes');
        }
    }

    // Kept as a named provider method for callers that need the Messenger
    // grant specifically. The return value is now an explicit PageGrant, not
    // an ambiguous Set of target IDs.
    async getSelectedPageIds({ userToken, diagnostics = null }) {
        const pageGrants = await this.getPageGrants({ userToken, diagnostics });
        return pageGrants.pages_messaging;
    }

    async listManagedAssets({ userToken, pageCredentials, diagnostics = null }) {
        const pageGrants = await this.getPageGrants({ userToken, diagnostics });
        const operationalPageGrant = intersectPageGrants(
            pageGrants.pages_messaging,
            pageGrants.pages_manage_metadata,
        );
        const showListGrant = pageGrants.pages_show_list;
        const pageGrant = intersectPageGrants(operationalPageGrant, showListGrant);

        if (diagnostics) {
            diagnostics.operationalGrantMode = operationalPageGrant.mode;
            diagnostics.pageGrantMode = pageGrant.mode;
            diagnostics.messagingGrantMode = pageGrants.pages_messaging.mode;
            diagnostics.metadataGrantMode = pageGrants.pages_manage_metadata.mode;
            diagnostics.showListGranted = showListGrant.mode;
        }

        // /me/accounts is an authorized discovery edge only when the
        // pages_show_list permission itself is verified. A successful listing
        // never substitutes for the Messenger or Page-management grants.
        if (!grantCanAuthorizePages(showListGrant)
            || (showListGrant.mode === PAGE_GRANT_MODE.EXPLICIT && !showListGrant.pageIds.size)) {
            if (diagnostics) diagnostics.discoveryFailureReason = 'SHOW_LIST_PERMISSION_MISSING_OR_AMBIGUOUS';
            logger.info('metaAssetsListed', {
                META_PAGE_GRANT_MODE: pageGrant.mode,
                OPERATIONAL_PAGE_GRANT_MODE: operationalPageGrant.mode,
                MESSAGING_GRANT_MODE: pageGrants.pages_messaging.mode,
                METADATA_GRANT_MODE: pageGrants.pages_manage_metadata.mode,
                SHOW_LIST_GRANTED: showListGrant.mode,
                ME_ACCOUNTS_PAGE_COUNT: 0,
                AUTHORIZED_PAGE_COUNT: 0,
                PAGE_TOKEN_AVAILABLE_COUNT: 0,
                CONNECTABLE_PAGE_COUNT: 0,
                DISCOVERY_FAILURE_REASON: 'SHOW_LIST_PERMISSION_MISSING_OR_AMBIGUOUS',
            });
            return [];
        }

        if (!grantCanAuthorizePages(pageGrant)
            || (pageGrant.mode === PAGE_GRANT_MODE.EXPLICIT && !pageGrant.pageIds.size)) {
            if (diagnostics) {
                diagnostics.discoveryFailureReason = pageGrant.mode === PAGE_GRANT_MODE.EXPLICIT
                    ? 'REQUIRED_PAGE_GRANTS_HAVE_NO_INTERSECTION'
                    : pageGrant.reason || 'PAGE_GRANT_MISSING_OR_AMBIGUOUS';
            }
            logger.info('metaAssetsListed', {
                META_PAGE_GRANT_MODE: pageGrant.mode,
                OPERATIONAL_PAGE_GRANT_MODE: operationalPageGrant.mode,
                MESSAGING_GRANT_MODE: pageGrants.pages_messaging.mode,
                METADATA_GRANT_MODE: pageGrants.pages_manage_metadata.mode,
                SHOW_LIST_GRANTED: showListGrant.mode,
                ME_ACCOUNTS_PAGE_COUNT: 0,
                AUTHORIZED_PAGE_COUNT: 0,
                PAGE_TOKEN_AVAILABLE_COUNT: 0,
                CONNECTABLE_PAGE_COUNT: 0,
                DISCOVERY_FAILURE_REASON: diagnostics?.discoveryFailureReason || 'PAGE_GRANT_MISSING_OR_AMBIGUOUS',
            });
            return [];
        }

        // /me/accounts is the only discovery edge used in the Messenger-only
        // launch. Do not query Business Portfolio edges here: that requires the
        // removed business_management permission and expands App Review scope.
        const meAccountsRaw = [];
        try {
            meAccountsRaw.push(...await paginateGraphCollection(`${GRAPH_BASE}/me/accounts`, {
                fields: PAGE_FIELDS,
                limit: 100,
                access_token: userToken,
                appsecret_proof: appsecretProof(userToken),
            }, diagnostics, 'rich'));
            recordPageCollectionDiagnostics(diagnostics, 'rich', meAccountsRaw);
        } catch (err) {
            if (diagnostics) {
                diagnostics.meAccounts.rich.status = 'FAIL';
                recordGraphError(diagnostics, 'me_accounts_rich', err);
            }
            if (!isOptionalTasksFieldError(err)) {
                if (diagnostics) throw canaryDiscoveryError(err, 'me_accounts_rich', diagnostics);
                throw metaError(err, 'listManagedAssets:me/accounts');
            }
            try {
                const minimalPages = await paginateGraphCollection(`${GRAPH_BASE}/me/accounts`, {
                    fields: PAGE_MINIMAL_FIELDS,
                    limit: 100,
                    access_token: userToken,
                    appsecret_proof: appsecretProof(userToken),
                }, diagnostics, 'minimal');
                meAccountsRaw.push(...minimalPages);
                recordPageCollectionDiagnostics(diagnostics, 'minimal', minimalPages);
            } catch (minimalError) {
                if (diagnostics) {
                    recordGraphError(diagnostics, 'me_accounts_minimal', minimalError);
                    diagnostics.meAccounts.minimal.status = 'FAIL';
                    throw canaryDiscoveryError(err, 'me_accounts_rich', diagnostics);
                }
                throw metaError(err, 'listManagedAssets:me/accounts');
            }
        }

        const meAccountsById = new Map();
        for (const page of meAccountsRaw) {
            const pageId = page?.id === null || page?.id === undefined ? '' : String(page.id);
            if (!pageId) continue;
            const current = meAccountsById.get(pageId);
            if (!current) {
                meAccountsById.set(pageId, page);
                continue;
            }

            // Prefer whichever duplicate carries the Page token, while
            // retaining any explicit task rejection across both rows.
            const preferredPage = !hasNonEmptyAccessToken(current) && hasNonEmptyAccessToken(page)
                ? page
                : current;
            meAccountsById.set(
                pageId,
                preservePageTaskEvidence(preferredPage, current, page),
            );
        }

        const pagesById = new Map();
        const targetIdsNeedingHydration = new Set();
        for (const [pageId, page] of meAccountsById) {
            if (!grantAllowsPage(pageGrant, pageId)) continue;
            if (hasNonEmptyAccessToken(page)) {
                retainPageCredential(pageCredentials, page);
                pagesById.set(pageId, { ...page, source: 'ME_ACCOUNTS' });
            } else {
                targetIdsNeedingHydration.add(pageId);
            }
        }

        // Only EXPLICIT grants provide additional IDs that can be hydrated.
        // ALL is intentionally bounded by the Pages Meta actually returned by
        // /me/accounts; it never turns into a guessed-ID scan.
        if (pageGrant.mode === PAGE_GRANT_MODE.EXPLICIT) {
            for (const pageId of pageGrant.pageIds) {
                if (!hasNonEmptyAccessToken(meAccountsById.get(pageId))) {
                    targetIdsNeedingHydration.add(pageId);
                }
            }
        }
        const targetsNeedingHydration = [...targetIdsNeedingHydration];

        const hydrationResults = await mapWithConcurrency(
            targetsNeedingHydration,
            PAGE_HYDRATION_CONCURRENCY,
            (pageId) => hydratePageById(
                pageId,
                userToken,
                pageCredentials,
                diagnostics,
                meAccountsById.get(pageId),
            ),
        );
        const hydrationStats = {
            attempted: targetsNeedingHydration.length,
            succeeded: 0,
            failed: 0,
            rejected: 0,
        };
        hydrationResults.forEach((hydration, index) => {
            if (hydration.status === 'succeeded') {
                hydrationStats.succeeded += 1;
                pagesById.set(targetsNeedingHydration[index], {
                    ...hydration.page,
                    source: 'GRANULAR_TARGET',
                });
            } else if (hydration.status === 'failed') {
                hydrationStats.failed += 1;
            } else {
                hydrationStats.rejected += 1;
            }
        });

        const visiblePages = [...pagesById.values()]
            .filter((page) => grantAllowsPage(pageGrant, page.id) && hasNonEmptyAccessToken(page));

        const result = visiblePages.map((p) => {
            const eligibility = pageEligibility(p, pageGrant);
            return {
                id: String(p.id),
                name: p.name,
                category: p.category || null,
                pictureUrl: p.picture?.data?.url || p.picture?.url || null,
                tasks: eligibility.tasks,
                connectable: eligibility.connectable,
                reason: eligibility.reason,
                ...(eligibility.eligibilitySource
                    ? { eligibilitySource: eligibility.eligibilitySource }
                    : {}),
                taskAvailability: eligibility.taskAvailability,
            };
        });

        if (diagnostics) {
            const expectedPage = visiblePages.find((page) => String(page.id) === diagnostics.expectedPageId);
            const expectedAsset = result.find((page) => page.id === diagnostics.expectedPageId);
            if (expectedPage) {
                diagnostics.expectedPageTasks = sanitizeTasks(expectedPage.tasks);
                diagnostics.expectedPageEligible = expectedAsset
                    ? expectedAsset.connectable ? 'YES' : 'NO'
                    : 'NO';
                diagnostics.expectedPageEligibilitySource = expectedAsset?.eligibilitySource || 'UNKNOWN';
            }
        }

        const pageTokenAvailableCount = visiblePages.filter((page) => hasNonEmptyAccessToken(page)).length;
        const connectablePageCount = result.filter((page) => page.connectable === true).length;
        const discoveryFailureReason = result.length > 0
            ? null
            : meAccountsRaw.length === 0
                ? pageGrant.mode === PAGE_GRANT_MODE.ALL
                    ? 'ALL_PAGES_GRANT_NO_DISCOVERABLE_PAGES'
                    : 'NO_DISCOVERABLE_AUTHORIZED_PAGES'
                : pageTokenAvailableCount === 0
                    ? 'DISCOVERED_PAGES_HAVE_NO_PAGE_TOKEN'
                    : connectablePageCount === 0
                        ? 'DISCOVERED_PAGES_NOT_ELIGIBLE'
                        : 'NO_AUTHORIZED_PAGES';
        if (diagnostics) {
            diagnostics.meAccountsPageCount = meAccountsRaw.length;
            diagnostics.authorizedPageCount = visiblePages.length;
            diagnostics.pageTokenAvailableCount = pageTokenAvailableCount;
            diagnostics.connectablePageCount = connectablePageCount;
            diagnostics.discoveryFailureReason = discoveryFailureReason;
        }

        logger.info('metaAssetsListed', {
            META_PAGE_GRANT_MODE: pageGrant.mode,
            OPERATIONAL_PAGE_GRANT_MODE: operationalPageGrant.mode,
            MESSAGING_GRANT_MODE: pageGrants.pages_messaging.mode,
            METADATA_GRANT_MODE: pageGrants.pages_manage_metadata.mode,
            SHOW_LIST_GRANTED: showListGrant.mode,
            ME_ACCOUNTS_PAGE_COUNT: meAccountsRaw.length,
            AUTHORIZED_PAGE_COUNT: visiblePages.length,
            PAGE_TOKEN_AVAILABLE_COUNT: pageTokenAvailableCount,
            CONNECTABLE_PAGE_COUNT: connectablePageCount,
            DISCOVERY_FAILURE_REASON: discoveryFailureReason,
            source_me_accounts: meAccountsRaw.length,
            source_owned_pages: 0,
            source_client_pages: 0,
            portfolioAttempted: false,
            portfolioError: null,
            source_granular_target: hydrationStats.succeeded,
            selected_target_ids: pageGrant.mode === PAGE_GRANT_MODE.EXPLICIT ? pageGrant.pageIds.size : 0,
            filtered_unselected_pages: meAccountsRaw.filter((page) => !grantAllowsPage(pageGrant, page?.id)).length,
            hydration_attempted: hydrationStats.attempted,
            hydration_succeeded: hydrationStats.succeeded,
            hydration_failed: hydrationStats.failed,
            hydration_rejected: hydrationStats.rejected,
            deduped: result.length,
        });

        return result;
    }

    async getOAuthIdentity({ userToken }) {
        let appScopedUserId;
        try {
            const me = await axios.get(`${GRAPH_BASE}/me`, {
                params: {
                    fields: 'id',
                    access_token: userToken,
                    appsecret_proof: appsecretProof(userToken),
                },
            });
            appScopedUserId = me.data?.id ? String(me.data.id) : null;
        } catch (err) {
            throw metaError(err, 'getOAuthIdentity:me');
        }

        if (!appScopedUserId) {
            throw new AppError(
                'Meta OAuth identity response did not include an app-scoped user ID',
                502,
                'META_IDENTITY_UNAVAILABLE',
            );
        }

        const pageScopedIdentities = [];
        try {
            const identities = await paginateGraphCollection(`${GRAPH_BASE}/${appScopedUserId}/ids_for_pages`, {
                fields: 'id,page',
                limit: 100,
                access_token: userToken,
                appsecret_proof: appsecretProof(userToken),
            });
            for (const item of identities) {
                const pageId = item?.page?.id || item?.page_id || item?.page?.data?.id;
                if (pageId && item?.id) {
                    pageScopedIdentities.push({
                        pageId: String(pageId),
                        pageScopedUserId: String(item.id),
                    });
                }
            }
        } catch (err) {
            // Meta does not expose this edge for every app/user combination.
            // Keep the verified app-scoped identity for deauthorization, but do
            // not invent a Page-scoped customer identity for deletion.
            logger.warn('getOAuthIdentity: ids_for_pages unavailable', {
                metaCode: err.response?.data?.error?.code,
            });
        }

        return { appScopedUserId, pageScopedIdentities };
    }

    async refreshAssetToken({ channel }) {
        // Page Access Tokens derived from a long-lived User Access Token survive as long as
        // the user token. To refresh, exchange the current page token as the fb_exchange_token.
        const currentToken = channel.page_access_token_ct;  // entity getter decrypts
        if (!currentToken) throw new Error('refreshAssetToken: channel has no token');
        try {
            const resp = await axios.get(`${GRAPH_BASE}/oauth/access_token`, {
                params: {
                    grant_type: 'fb_exchange_token',
                    client_id: config.metaAppId,
                    client_secret: config.metaAppSecret,
                    fb_exchange_token: currentToken,
                    appsecret_proof: appsecretProof(currentToken)
                }
            });
            const { access_token, expires_in } = resp.data;
            return {
                token: access_token,
                expiresAt: expires_in ? new Date(Date.now() + expires_in * 1000) : null
            };
        } catch (err) {
            throw metaError(err, 'refreshAssetToken');
        }
    }

    async revokeAsset({ channel }) {
        // Meta auto-revokes on user-side deauth. Best-effort unsubscribe is handled
        // separately via unsubscribeWebhook. No revoke endpoint to call here.
        return;
    }

    webhookFields() {
        return [...WEBHOOK_FIELDS];
    }

    async subscribeWebhook({ channel }) {
        const token = channel.page_access_token_ct;
        if (!token) throw new Error('subscribeWebhook: channel has no token');
        try {
            await axios.post(
                `${GRAPH_BASE}/${channel.meta_asset_id}/subscribed_apps`,
                null,
                {
                    params: {
                        access_token: token,
                        appsecret_proof: appsecretProof(token),
                        subscribed_fields: this.webhookFields().join(',')
                    }
                }
            );
        } catch (err) {
            throw metaError(err, 'subscribeWebhook');
        }
    }

    async unsubscribeWebhook({ channel }) {
        const token = channel.page_access_token_ct;
        if (!token) return { ok: true, skipped: true };
        try {
            await axios.delete(
                `${GRAPH_BASE}/${channel.meta_asset_id}/subscribed_apps`,
                { params: { access_token: token, appsecret_proof: appsecretProof(token) } }
            );
            return { ok: true };
        } catch (err) {
            logger.warn('unsubscribeWebhook failed', {
                channelId: channel.id,
                metaCode: err.response?.data?.error?.code || null,
                metaSubcode: err.response?.data?.error?.error_subcode || null,
            });
            return { ok: false, error: metaError(err, 'unsubscribeWebhook') };
        }
    }

    async verifyWebhookSubscription({ channel }) {
        const token = channel.page_access_token_ct;
        const targetId = channel.meta_asset_id;
        if (!token) return { ok: false, fields: [] };
        try {
            const resp = await axios.get(`${GRAPH_BASE}/${targetId}/subscribed_apps`, {
                params: { access_token: token, appsecret_proof: appsecretProof(token) }
            });
            const apps = resp.data?.data || [];
            // D3: a Page can carry webhook subscriptions from OTHER apps. Only
            // OUR app's subscription (META_APP_ID — the app subscribeWebhook
            // binds) proves EasyModerator will actually receive events. A
            // third-party app that subscribed `messages` must never satisfy
            // verification: if our app is absent this fails closed.
            const ourAppId = String(config.metaAppId ?? '').trim();
            const ours = ourAppId
                ? apps.find((a) => a && String(a.id ?? '') === ourAppId)
                : null;
            const fields = ours?.subscribed_fields || [];
            const requiredFields = this.webhookFields();
            return {
                ok: Boolean(ours) && requiredFields.every(field => fields.includes(field)),
                fields
            };
        } catch (err) {
            logger.warn('verifyWebhookSubscription failed', {
                channelId: channel.id,
                targetId,
                metaCode: err.response?.data?.error?.code || null,
                metaSubcode: err.response?.data?.error?.error_subcode || null,
            });
            return { ok: false, fields: [] };
        }
    }

    /**
     * Explicitly probe whether Meta permits optional interactive Messenger webhook
     * fields (`messaging_postbacks`, `messaging_referrals`) on this Page.
     * Core `WEBHOOK_FIELDS` (`['messages']`) is never weakened or replaced: every
     * subscription call includes `this.webhookFields()` and any Meta permission /
     * product-access rejection fails closed with EXTERNALLY_BLOCKED_PERMISSION_OR_PRODUCT_ACCESS.
     */
    async probeInteractionWebhookFields({
        channel,
        fields = ['messaging_postbacks', 'messaging_referrals'],
    }) {
        const token = channel?.page_access_token_ct;
        const targetId = channel?.meta_asset_id;
        const targetFields = Array.isArray(fields)
            ? Array.from(new Set(fields.map((f) => String(f || '').trim()).filter(Boolean)))
            : ['messaging_postbacks', 'messaging_referrals'];
        if (!token || !targetId) {
            return {
                ok: false,
                code: 'CHANNEL_NOT_CONNECTED',
                coreMessagesIntact: false,
                blockedFields: targetFields,
                subscribedFields: [],
            };
        }

        const existing = await this.verifyWebhookSubscription({ channel });
        if (targetFields.length > 0 && targetFields.every((f) => existing.fields.includes(f))) {
            return {
                ok: true,
                code: 'ALREADY_SUBSCRIBED',
                coreMessagesIntact: existing.ok,
                subscribedFields: existing.fields,
                addedFields: [],
            };
        }

        const requestedFields = Array.from(new Set([...this.webhookFields(), ...targetFields]));
        try {
            await axios.post(
                `${GRAPH_BASE}/${targetId}/subscribed_apps`,
                null,
                {
                    params: {
                        access_token: token,
                        appsecret_proof: appsecretProof(token),
                        subscribed_fields: requestedFields.join(','),
                    },
                },
            );
            const after = await this.verifyWebhookSubscription({ channel });
            return {
                ok: true,
                code: 'SUBSCRIBED',
                coreMessagesIntact: after.ok,
                subscribedFields: after.fields,
                addedFields: targetFields.filter((f) => !existing.fields.includes(f)),
            };
        } catch (err) {
            const metaCode = err.response?.data?.error?.code ?? null;
            const metaSubcode = err.response?.data?.error?.error_subcode ?? null;
            const httpStatus = err.response?.status ?? null;
            const isPermissionOrProductBlock = httpStatus === 400
                || httpStatus === 403
                || [10, 100, 190, 200, 230].includes(Number(metaCode));
            if (!isPermissionOrProductBlock) {
                throw metaError(err, 'probeInteractionWebhookFields');
            }

            logger.warn('probeInteractionWebhookFields blocked by Meta permission/product access', {
                channelId: channel.id,
                targetId,
                metaCode,
                metaSubcode,
                httpStatus,
            });
            let coreCheck = await this.verifyWebhookSubscription({ channel });
            if (!coreCheck.ok) {
                await this.subscribeWebhook({ channel }).catch(() => {});
                coreCheck = await this.verifyWebhookSubscription({ channel });
            }
            return {
                ok: false,
                code: 'EXTERNALLY_BLOCKED_PERMISSION_OR_PRODUCT_ACCESS',
                coreMessagesIntact: coreCheck.ok,
                blockedFields: targetFields,
                subscribedFields: coreCheck.fields || [],
                metaCode,
                metaSubcode,
            };
        }
    }

    async verifyWebhookSignature({ rawBody, signature }) {
        if (!signature || typeof signature !== 'string' || !signature.startsWith('sha256=')) {
            return false;
        }
        const expected = 'sha256=' + crypto
            .createHmac('sha256', process.env.META_APP_SECRET || config.metaAppSecret)
            .update(rawBody)
            .digest('hex');
        // timingSafeEqual requires equal-length buffers
        const sigBuf = Buffer.from(signature);
        const expBuf = Buffer.from(expected);
        return sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf);
    }

    parseWebhookEnvelope(payload) {
        if (!payload || payload.object !== 'page' || !Array.isArray(payload.entry)) return [];

        const events = [];
        for (const entry of payload.entry) {
            const pageId = entry.id;

            // Messaging events
            for (const evt of entry.messaging || []) {
                const msg = evt.message;
                if (!msg) continue;
                const isEcho = msg.is_echo === true;
                if (isEcho) continue;  // drop echoes (page's own outbound reflected back)

                events.push({
                    externalId: msg.mid || null,
                    senderExternalId: evt.sender?.id || null,
                    pageOrAccountId: pageId,
                    text: msg.text || null,
                    inReplyToExternalId: msg.reply_to?.mid || null,
                    replyToIsSelfReply: msg.reply_to?.is_self_reply === true,
                    attachments: (msg.attachments || []).map(a => ({
                        type: a.type || 'file',
                        url: a.payload?.url,
                        payload: a.payload
                    })),
                    isEcho: false,
                    commentId: null,
                    postId: null,
                    occurredAt: evt.timestamp || Date.now(),
                    raw: evt
                });
            }

            // Page feed/comment changes are intentionally ignored for launch.
            // EasyModerator only handles customer-initiated Messenger DMs.
        }
        return events;
    }

    async sendMessage({ channel, recipientId, normalizedMessage, decision }) {
        if (!decision || decision.allow !== true) {
            throw new Error('sendMessage: PolicyDecision missing or denied');
        }
        const token = channel.page_access_token_ct;
        if (!token) throw new Error('sendMessage: channel has no token');

        const attachments = Array.isArray(normalizedMessage.attachments)
            ? normalizedMessage.attachments.filter(a => a?.url)
            : [];
        const rawQuickReplies = Array.isArray(normalizedMessage.quick_replies)
            ? normalizedMessage.quick_replies
            : [];
        // P+02: Meta accepts up to 13 quick replies, title <= 20 chars, payload <= 1000 chars.
        const quickReplies = rawQuickReplies
            .filter(qr => typeof qr?.title === 'string' && qr.title.trim()
                && qr.title.trim().length <= 20
                && typeof qr?.payload === 'string' && qr.payload.length
                && qr.payload.length <= 1000)
            .slice(0, 13)
            .map(qr => ({ title: qr.title.trim(), content_type: 'text', payload: qr.payload }));
        const bodies = [];
        if (normalizedMessage.text?.trim()) {
            const messageBody = { text: normalizedMessage.text.trim() };
            if (quickReplies.length) messageBody.quick_replies = quickReplies;
            bodies.push({
                recipient: { id: recipientId },
                message: messageBody,
            });
        }
        if (normalizedMessage.product_card && typeof normalizedMessage.product_card === 'object') {
            const rawCard = normalizedMessage.product_card;
            const title = typeof rawCard.title === 'string' ? rawCard.title.trim().slice(0, 80) : '';
            if (!title) {
                throw new Error('sendMessage: product_card title is required');
            }
            const cardElement = { title };
            if (typeof rawCard.subtitle === 'string' && rawCard.subtitle.trim()) {
                cardElement.subtitle = rawCard.subtitle.trim().slice(0, 80);
            }
            if (typeof rawCard.image_url === 'string' && rawCard.image_url.trim()) {
                try {
                    const parsedUrl = new URL(rawCard.image_url.trim());
                    if (parsedUrl.protocol === 'https:') {
                        cardElement.image_url = parsedUrl.toString();
                    }
                } catch (_) { /* ignore malformed image URL */ }
            }
            const cardMessage = {
                attachment: {
                    type: 'template',
                    payload: {
                        template_type: 'generic',
                        elements: [cardElement],
                    },
                },
            };
            if (!normalizedMessage.text?.trim() && quickReplies.length) {
                cardMessage.quick_replies = quickReplies;
            }
            bodies.push({
                recipient: { id: recipientId },
                message: cardMessage,
            });
        }
        for (const attachment of attachments) {
            const type = attachment.type === 'image' ? 'image' : 'file';
            bodies.push({
                recipient: { id: recipientId },
                message: {
                    attachment: {
                        type,
                        payload: {
                            url: attachment.url,
                            is_reusable: true,
                        }
                    }
                }
            });
        }
        if (bodies.length === 0) {
            throw new Error('sendMessage: text or attachment is required');
        }
        for (const body of bodies) {
            // Defense-in-depth: only a CURRENTLY-valid tag may reach the wire.
            // Meta returns error 100 for retired tags (since 2026-04-27), and
            // policy (templateRequired.rule) is the enforcement point — this
            // guard keeps any stale allow-path from firing doomed requests.
            const wireTag = decision.augment?.message_tag;
            if (wireTag && isAllowedMessageTag(wireTag)) {
                body.messaging_type = 'MESSAGE_TAG';
                body.tag = wireTag;
            } else {
                body.messaging_type = 'RESPONSE';
            }
        }

        const providerMessageIds = [];
        const providerComponents = bodies.map((body, index) => ({
            index,
            type: body.message?.attachment?.type || 'text',
            attempted: false,
            status: 'PENDING',
            providerMessageId: null,
        }));
        const attachProviderState = (error) => {
            error.providerMessageIds = [...providerMessageIds];
            error.providerComponents = providerComponents.map((component) => ({ ...component }));
            error.providerFailure = {
                code: error.code || null,
                status: error.status || error.response?.status || null,
                metaCode: error.details?.metaCode || error.response?.data?.error?.code || null,
                metaSubcode: error.details?.metaSubcode || error.response?.data?.error?.error_subcode || null,
            };
            return error;
        };

        try {
            for (const [index, body] of bodies.entries()) {
                const component = providerComponents[index];
                const reservation = await reserveSendSlot(channel.meta_asset_id);
                if (!reservation.allowed) {
                    const rateLimitError = new Error('Meta send rate limit reached');
                    rateLimitError.code = 'META_RATE_LIMIT';
                    rateLimitError.retryAfterMs = reservation.retryAfterMs;
                    component.status = 'FAILED';
                    component.failureCode = rateLimitError.code;
                    attachProviderState(rateLimitError);
                    throw rateLimitError;
                }
                component.attempted = true;
                try {
                    const resp = await axios.post(
                        `${GRAPH_BASE}/me/messages`,
                        body,
                        {
                            params: { access_token: token, appsecret_proof: appsecretProof(token) },
                            timeout: 30_000,
                        }
                    );
                    const providerMessageId = resp.data?.message_id;
                    if (!providerMessageId) {
                        const error = new Error('Meta did not return a provider message ID');
                        error.code = 'PROVIDER_NO_ACK';
                        throw error;
                    }
                    const normalizedProviderMessageId = String(providerMessageId);
                    providerMessageIds.push(normalizedProviderMessageId);
                    component.status = 'ACKNOWLEDGED';
                    component.providerMessageId = normalizedProviderMessageId;
                } catch (sendErr) {
                    component.status = 'FAILED';
                    component.failureCode = sendErr.code || sendErr.response?.data?.error?.code || null;
                    await releaseSendSlot(channel.meta_asset_id, reservation.member);
                    throw sendErr;
                }
            }
            return {
                providerMessageId: providerMessageIds[providerMessageIds.length - 1] || null,
                providerMessageIds,
                providerComponents,
            };
        } catch (err) {
            if (err.code === 'META_RATE_LIMIT') {
                throw attachProviderState(err);
            }
            const normalized = metaError(err, 'sendMessage');
            if ([102, 190].includes(Number(normalized.details?.metaCode))) {
                try {
                    await require('../meta-authorization-recovery.service')
                        .recoverInvalidToken(channel, normalized.details);
                } catch (recoveryError) {
                    logger.error('Invalid Meta token recovery failed', {
                        channelId: channel.id,
                        error: recoveryError.message,
                    });
                    // Do not convert the message into an unrecoverable job until
                    // the durable channel/token recovery transition succeeds.
                    normalized.code = 'META_AUTHORIZATION_RECOVERY_FAILED';
                    normalized.status = 503;
                    normalized.details = {
                        ...normalized.details,
                        recoveryPending: true,
                    };
                    throw normalized;
                }
                normalized.code = 'META_AUTHORIZATION_REQUIRED';
                normalized.status = 401;
            }
            throw attachProviderState(normalized);
        }
    }

}

module.exports = MetaMessengerProvider;
module.exports._private = {
    pageEligibility,
    interpretPageGrants,
    intersectPageGrants,
    // Exported so the App Review surface tests can assert the permission
    // set this integration declares, now that it is no longer observable
    // on the authorization URL.
    CONFIGURATION_OWNED_PERMISSIONS,
    LOGIN_CONFIG_ID_PATTERN,
};
