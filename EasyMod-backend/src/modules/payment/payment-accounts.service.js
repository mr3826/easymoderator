'use strict';

/**
 * Payment ACCOUNT service — canonical multi-account CRUD (contract §1, §2, §6).
 *
 * This is the "methods config API" behind the Payment Methods tab: a shop holds
 * MANY accounts keyed (shop_id, provider, account_type), each with its own
 * verification ladder level and an `is_preferred` DB truth. The legacy
 * single-row `payment.service.savePaymentConfig` stays intact for the compat
 * window (§1.4); every write here DUAL-WRITES the legacy `gateway` value and
 * keeps `shop.settings.bd` consistent (D-6: wallets[] + legacy mfs_* mirror).
 *
 * Ownership boundary (A5 foundation):
 *   - Storage + vocabulary + CRUD + preference + policy are A5 (this file).
 *   - Ladder TRANSITIONS (sandbox/certify, rate-limited credential checks) are
 *     A3. This file only defines the columns, the append-only record/read
 *     helpers, and the demotion-on-credential-change that the SAVE path owns (§2).
 *   - The self-MFS CLAIM create + merchant confirm flow are A4.
 * Routes never implement business logic; they dispatch here, and the A3/A4
 * functions are delegated to their own service modules (loaded lazily so this
 * module and its tests do not depend on files other roles still own).
 */
const { PaymentConfig, PaymentAccountVerification, UserShop, Shop } = require('../entities');
const { AppError } = require('../../utils/AppError');
const taxonomy = require('./payment-taxonomy');
const legacyService = require('./payment.service');

const {
    normalizeProvider,
    normalizeAccountType,
    legacyGatewayFor,
    providerFromCredentials,
    GATEWAY_ACCOUNT_TYPE,
    COD_ACCOUNT_TYPE,
    WALLET_ONLY_PROVIDERS,
    DEFAULT_CONFIGURED_LEVEL,
    DEMOTED_LEVEL,
} = taxonomy;

// Access the legacy service helpers LAZILY (inside call sites) so this module can
// be imported even when `payment.service` is a partial mock in tests. Resolving
// `_private` at module load would throw against `{ savePaymentConfig: fn }` mocks.
const sanitizeConfig = (v) => legacyService._private.sanitizePaymentConfigOptions(v);
const buildCredentialSummary = (v) => legacyService._private.buildCredentialSummary(v);
const validateSelfMfsCredentials = (v) => legacyService._private.validateSelfMfsCredentials(v);

// ── membership (mirrors payment.service.verifyShopAccess) ────────────────────
const verifyShopAccess = async (userId, shopId, { ownerOnly = false } = {}) => {
    const userShop = await UserShop.findOne({
        where: { user_id: userId, shop_id: shopId, is_active: true },
    });
    if (!userShop) {
        throw new AppError('You do not have access to this shop', 403);
    }
    if (ownerOnly && !['owner'].includes(String(userShop.role || '').toLowerCase())) {
        // Middleware already guards owner; this is defense-in-depth for service callers.
        // Membership row may not carry a role depending on caller — only enforce if present.
        if (userShop.role && !['owner'].includes(String(userShop.role).toLowerCase())) {
            throw new AppError('Only the shop owner can change payment account preference', 403, 'OWNER_ONLY');
        }
    }
    return userShop;
};

// ── canonical serialization (never echoes decrypted credentials) ──────────────
const serializeAccount = (account) => {
    if (!account) return null;
    const provider = account.provider || normalizeProvider(account.gateway) || null;
    const isWallet = provider && provider !== 'cod';
    const credentials = account.credentials; // getter → object | null
    return {
        id: account.id,
        shop_id: account.shop_id,
        provider,
        account_type: account.account_type || (provider === 'cod' ? COD_ACCOUNT_TYPE : null),
        // legacy compat value kept during the §1.4 window
        gateway: account.gateway || legacyGatewayFor(provider),
        is_enabled: Boolean(account.is_enabled),
        is_preferred: Boolean(account.is_preferred),
        verification_level: account.verification_level || 'unverified',
        // honest: automated checkout is only truly active at live_certified +
        // flag-on + creds. In this inert env (R-12) this is always false, so the
        // settings tab shows the real ladder level, never an implied "verified".
        automated_checkout_active: taxonomy.isAutomatable(account),
        provider_notice: isWallet && WALLET_ONLY_PROVIDERS.includes(provider)
            ? taxonomy.WALLET_ONLY_VERIFICATION_NOTICE : null,
        config: sanitizeConfig(account.config || {}),
        ...(isWallet ? { credential_summary: buildCredentialSummary({ credentials }) } : {}),
        created_at: account.created_at,
        updated_at: account.updated_at,
    };
};

// ── credential validation per account kind ──────────────────────────────────
const validateCredentialsForKind = ({ provider, accountType, credentials, isEnabled }) => {
    if (provider === 'cod') {
        return null; // cod is credential-free (§1.1)
    }
    if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) {
        if (isEnabled) throw new AppError('Wallet credentials are required to enable this account', 400);
        return credentials;
    }
    // bKash merchant_gateway stores tokenized-app credentials (app_key/app_secret/
    // username), NOT a personal mfs_number — so it is NOT validated as self-MFS.
    // The rate-limited provider credential CHECK is A3's ladder service (§2.1);
    // saving a gateway config here only requires the documented fields present.
    if (accountType === GATEWAY_ACCOUNT_TYPE) {
        if (!credentials.app_key || !credentials.app_secret || !credentials.username) {
            throw new AppError(
                'bKash merchant_gateway credentials require app_key, app_secret and username',
                400, 'GATEWAY_CREDENTIALS_INCOMPLETE',
            );
        }
        return { ...credentials, mfs_type: 'bkash', mfs_mode: 'business' };
    }
    // Wallet (self | business): mfs_type must match the chosen provider.
    const credsType = normalizeProvider(credentials.mfs_type);
    if (credsType && credsType !== provider) {
        throw new AppError(
            `credentials.mfs_type (${credsType}) does not match provider (${provider})`,
            400, 'MFS_TYPE_PROVIDER_MISMATCH',
        );
    }
    const normalized = validateSelfMfsCredentials({
        ...credentials,
        mfs_type: credsType || provider,
        mfs_mode: normalizeAccountType(credentials.mfs_mode || credentials.accountType, provider) || accountType,
    });
    if (normalizeProvider(normalized.mfs_type) !== provider) {
        throw new AppError(
            `credentials.mfs_type (${normalizeProvider(normalized.mfs_type)}) does not match provider (${provider})`,
            400, 'MFS_TYPE_PROVIDER_MISMATCH',
        );
    }
    return normalized;
};

// ── list ────────────────────────────────────────────────────────────────────
async function listPaymentAccounts(shopId, userId) {
    await verifyShopAccess(userId, shopId);
    const rows = await PaymentConfig.findAll({ where: { shop_id: shopId } });
    return rows.map(serializeAccount);
}

async function getPaymentAccount(shopId, userId, accountId) {
    await verifyShopAccess(userId, shopId);
    const account = await PaymentConfig.findOne({ where: { id: accountId, shop_id: shopId } });
    if (!account) throw new AppError('Payment account not found', 404);
    return serializeAccount(account);
}

// ── create / update by canonical key (shop, provider, account_type) ──────────
async function savePaymentAccount(shopId, userId, payload = {}) {
    await verifyShopAccess(userId, shopId);

    const provider = normalizeProvider(payload.provider);
    if (!provider) {
        throw new AppError(
            `provider must be one of: ${taxonomy.PROVIDERS.join(', ')}`,
            400, 'INVALID_PROVIDER',
        );
    }
    const accountType = normalizeAccountType(payload.account_type, provider);
    if (!accountType) {
        throw new AppError('account_type is required and must be a valid kind', 400, 'INVALID_ACCOUNT_TYPE');
    }
    // merchant_gateway is bKash-only (§1.1).
    if (accountType === GATEWAY_ACCOUNT_TYPE && provider !== 'bkash') {
        throw new AppError('merchant_gateway accounts are only supported for bKash', 400, 'GATEWAY_PROVIDER_UNSUPPORTED');
    }
    const isEnabled = payload.is_enabled === undefined ? undefined : Boolean(payload.is_enabled);

    const normalizedCredentials = validateCredentialsForKind({
        provider, accountType, credentials: payload.credentials, isEnabled: isEnabled === true,
    });

    const existing = await PaymentConfig.findOne({
        where: { shop_id: shopId, provider, account_type: accountType },
    });

    let account;
    if (existing) {
        const credentialsChanged = normalizedCredentials
            && JSON.stringify(normalizedCredentials) !== JSON.stringify(existing.credentials);
        if (isEnabled !== undefined) existing.is_enabled = isEnabled;
        if (normalizedCredentials) {
            existing.credentials = normalizedCredentials;
            // §2 credential-change invalidation: demote the ladder on credential write.
            if (credentialsChanged) existing.verification_level = DEMOTED_LEVEL;
            else if (!existing.verification_level || existing.verification_level === 'unverified') {
                if (existing.is_enabled) existing.verification_level = DEFAULT_CONFIGURED_LEVEL;
            }
        } else if (isEnabled && (!existing.credentials || Object.keys(existing.credentials).length === 0)) {
            // enabling a wallet with no stored credentials must not pass (§7 row 3).
            if (provider !== 'cod') throw new AppError('Cannot enable a wallet account without credentials', 400);
        }
        if (payload.config !== undefined) existing.config = payload.config;
        existing.provider = provider;
        existing.account_type = accountType;
        existing.gateway = legacyGatewayFor(provider); // §1.4 dual-write
        await existing.save();
        account = existing;

        if (credentialsChanged) {
            await appendVerificationRecord({
                paymentAccountId: account.id, level: DEMOTED_LEVEL, method: 'configured',
                performedByUserId: userId, providerEnvironment: 'unknown',
                evidence: { reason: 'credentials_changed' },
            });
        }
    } else {
        let verificationLevel = 'unverified';
        if (isEnabled && provider !== 'cod' && normalizedCredentials) {
            verificationLevel = DEFAULT_CONFIGURED_LEVEL; // §2 save path: locally validated, no provider contact
        }
        account = await PaymentConfig.create({
            shop_id: shopId,
            provider,
            account_type: accountType,
            gateway: legacyGatewayFor(provider), // §1.4 dual-write
            is_enabled: isEnabled === true,
            is_preferred: false,
            verification_level: verificationLevel,
            credentials: provider === 'cod' ? null : (normalizedCredentials || null),
            config: payload.config || {},
        });
        if (verificationLevel === DEFAULT_CONFIGURED_LEVEL) {
            await appendVerificationRecord({
                paymentAccountId: account.id, level: DEFAULT_CONFIGURED_LEVEL, method: 'configured',
                performedByUserId: userId, providerEnvironment: 'unknown',
                evidence: { reason: 'created_with_validated_credentials' },
            });
        }
    }

    await syncBdFromAccounts(shopId).catch(() => {}); // D-6 mirror; non-fatal (§3.4)
    return serializeAccount(account);
}

async function updatePaymentAccount(shopId, userId, accountId, patch = {}) {
    await verifyShopAccess(userId, shopId);
    const account = await PaymentConfig.findOne({ where: { id: accountId, shop_id: shopId } });
    if (!account) throw new AppError('Payment account not found', 404);

    const provider = account.provider || normalizeProvider(account.gateway);
    const accountType = account.account_type || (provider === 'cod' ? COD_ACCOUNT_TYPE : null);

    if (patch.credentials !== undefined && patch.credentials !== null) {
        const normalized = validateCredentialsForKind({
            provider,
            accountType,
            credentials: patch.credentials,
            isEnabled: patch.is_enabled !== undefined ? Boolean(patch.is_enabled) : account.is_enabled,
        });
        const changed = JSON.stringify(normalized || {}) !== JSON.stringify(account.credentials || {});
        account.credentials = normalized;
        if (changed) {
            account.verification_level = DEMOTED_LEVEL; // §2
            await appendVerificationRecord({
                paymentAccountId: account.id, level: DEMOTED_LEVEL, method: 'configured',
                performedByUserId: userId, providerEnvironment: 'unknown',
                evidence: { reason: 'credentials_changed' },
            });
        }
    }
    if (patch.config !== undefined) account.config = patch.config;
    if (patch.is_enabled !== undefined) {
        const nextEnabled = Boolean(patch.is_enabled);
        if (nextEnabled && provider !== 'cod' && (!account.credentials || Object.keys(account.credentials).length === 0)) {
            throw new AppError('Cannot enable a wallet account without credentials', 400);
        }
        account.is_enabled = nextEnabled;
    }
    account.gateway = legacyGatewayFor(account.provider || provider); // keep dual-write
    await account.save();
    await syncBdFromAccounts(shopId).catch(() => {});
    return serializeAccount(account);
}

async function deletePaymentAccount(shopId, userId, accountId) {
    await verifyShopAccess(userId, shopId);
    const account = await PaymentConfig.findOne({ where: { id: accountId, shop_id: shopId } });
    if (!account) throw new AppError('Payment account not found', 404);
    await account.destroy();
    await syncBdFromAccounts(shopId).catch(() => {});
    return { success: true, message: 'Payment account deleted' };
}

// ── preference (D-8: DB truth, exactly one per shop, owner writes) ────────────
async function setPreferredAccount(shopId, userId, accountId) {
    await verifyShopAccess(userId, shopId, { ownerOnly: true });
    const account = await PaymentConfig.findOne({ where: { id: accountId, shop_id: shopId } });
    if (!account) throw new AppError('Payment account not found', 404);
    if (!account.is_enabled) {
        throw new AppError('Only an enabled account can be set as preferred', 409, 'PREFERRED_ACCOUNT_DISABLED');
    }

    if (typeof PaymentConfig.sequelize?.transaction === 'function') {
        await PaymentConfig.sequelize.transaction(async (transaction) => {
            await PaymentConfig.update(
                { is_preferred: false },
                { where: { shop_id: shopId }, transaction },
            );
            await PaymentConfig.update(
                { is_preferred: true },
                { where: { id: accountId, shop_id: shopId }, transaction },
            );
        });
    } else {
        // Fallback for mocked models without a transaction surface.
        await PaymentConfig.update({ is_preferred: false }, { where: { shop_id: shopId } });
        account.is_preferred = true;
        await account.save();
    }

    await syncBdFromAccounts(shopId).catch(() => {}); // legacy mfs_* mirror = preferred (§6)
    return { success: true, preferred_account_id: accountId };
}

async function getPreferredAccount(shopId, { provider } = {}) {
    const where = { shop_id: shopId, is_preferred: true, is_enabled: true };
    const normalizedProvider = normalizeProvider(provider);
    if (normalizedProvider) where.provider = normalizedProvider;
    return PaymentConfig.findOne({ where });
}

// ── verification record read/write helpers (§2; A5 owns storage, A3 the ladder) ─
async function appendVerificationRecord({
    paymentAccountId, level, method, evidence, performedByUserId, providerEnvironment,
}) {
    if (!PaymentAccountVerification || typeof PaymentAccountVerification.create !== 'function') {
        return null;
    }
    return PaymentAccountVerification.create({
        payment_account_id: paymentAccountId,
        level,
        method: method || null,
        evidence: evidence || null,
        performed_by_user_id: performedByUserId || null,
        provider_environment: providerEnvironment || null,
    });
}

async function readVerificationRecords(accountId, shopId) {
    if (!PaymentAccountVerification) return [];
    const where = { payment_account_id: accountId };
    // tenant safety: only records whose account belongs to this shop.
    if (shopId) {
        const account = await PaymentConfig.findOne({ where: { id: accountId, shop_id: shopId } });
        if (!account) throw new AppError('Payment account not found', 404);
    }
    return PaymentAccountVerification.findAll({ where, order: [['created_at', 'DESC']] });
}

/**
 * Raw ladder-level setter for the A3 verification service to call after it
 * validates a transition. A5 exposes the write primitive; A3 enforces the rules
 * (§2 "transitions ONLY via A3"). Not wired to any route directly.
 */
async function writeLadderLevel(accountId, level) {
    const account = await PaymentConfig.findByPk(accountId);
    if (!account) throw new AppError('Payment account not found', 404);
    account.verification_level = level;
    await account.save();
    return serializeAccount(account);
}

// ── shop.settings.bd sync (D-6): wallets[] + legacy mfs_* mirror the preferred ─
async function syncBdFromAccounts(shopId) {
    const wallets = [];
    const rows = await PaymentConfig.findAll({ where: { shop_id: shopId, is_enabled: true } });
    for (const row of rows) {
        const provider = row.provider || normalizeProvider(row.gateway);
        if (!provider || provider === 'cod') continue;
        const creds = row.credentials || {};
        const number = creds.mfs_number || creds.phone || null;
        if (!number) continue;
        const accountType = row.account_type
            || (normalizeAccountType(creds.mfs_mode, provider) || (provider === 'cod' ? COD_ACCOUNT_TYPE : 'self'));
        wallets.push({
            provider,
            account_type: accountType,
            number,
            mfs_mode: accountType === GATEWAY_ACCOUNT_TYPE ? 'business' : (accountType || 'self'),
            is_preferred: Boolean(row.is_preferred),
        });
    }

    const preferred = wallets.find((w) => w.is_preferred) || wallets[0] || null;

    const { mergeSettingsPreservingRtoConsent } = require('../shop/shop-settings.validator');
    const { invalidateShopSettingsCaches } = require('../../utils/shop-settings-cache');

    await Shop.sequelize.transaction(async (transaction) => {
        const shop = await Shop.findByPk(shopId, { transaction, lock: transaction.LOCK?.UPDATE });
        if (!shop) return;
        const bd = shop.settings?.bd || {};
        const nextBd = {
            ...bd,
            wallets,
            // legacy mirror keys = preferred wallet (self-mfs-handler + owner-notification read these)
            mfs_type: preferred ? preferred.provider : null,
            mfs_number: preferred ? preferred.number : null,
            mfs_mode: preferred ? preferred.mfs_mode : null,
        };
        const merged = mergeSettingsPreservingRtoConsent(shop.settings || {}, { bd: nextBd });
        await shop.update({ settings: merged }, { transaction });
    });
    await invalidateShopSettingsCaches(shopId);
    return wallets;
}

// ── A3/A4 dispatch (routes call these; implementations owned by A3/A4) ────────
// Filenames fixed here so A3/A4 fill implementations WITHOUT touching routes.
async function verifyPaymentAccount(shopId, userId, accountId) {
    return delegate('./payment-verification.service', 'verifyPaymentAccount', [shopId, userId, accountId], {
        owner: 'A3',
        note: 'bKash merchant credential check (rate-limited, no ladder promotion); Nagad/Rocket self|business → format-valid only (R-12)',
    });
}
async function certifyLiveAccount(shopId, userId, accountId, evidence) {
    return delegate('./payment-verification.service', 'certifyLiveAccount', [shopId, userId, accountId, evidence], {
        owner: 'A3',
        note: 'owner-only live_certified record + AuditLog (§2.3); never self-declared',
    });
}
async function refundPaymentTransaction(shopId, userId, transactionId, payload) {
    return delegate('./payment-verification.service', 'refundPaymentTransaction', [shopId, userId, transactionId, payload], {
        owner: 'A3',
        note: 'merchant_gateway v2 refund only (§4.5); owner role + audit',
    });
}
async function createSelfMfsClaim(shopId, userId, payload) {
    return delegate('./payment-claim.service', 'createSelfMfsClaim', [shopId, userId, payload], {
        owner: 'A4',
        note: 'trxId claim → pending PaymentTransaction + merchant notify (§3.2); never auto-confirm',
    });
}

function notImplemented({ owner, note }) {
    return new AppError(
        `Payment automation pending (${owner} service not implemented). ${note}`,
        501, 'PAYMENT_SERVICE_NOT_IMPLEMENTED',
    );
}

function lazyRequire(modulePath) {
    try {
        // Resolve lazily so a not-yet-created owner module never breaks import.
        // eslint-disable-next-line global-require, import/no-dynamic-require
        return require(modulePath);
    } catch (err) {
        if (err && (err.code === 'MODULE_NOT_FOUND' || /Cannot find module/.test(err.message))) return null;
        throw err;
    }
}

async function delegate(modulePath, fnName, args, meta) {
    const mod = lazyRequire(modulePath);
    if (!mod || typeof mod[fnName] !== 'function') {
        throw notImplemented(meta);
    }
    return mod[fnName](...args);
}

module.exports = {
    listPaymentAccounts,
    getPaymentAccount,
    savePaymentAccount,
    updatePaymentAccount,
    deletePaymentAccount,
    setPreferredAccount,
    getPreferredAccount,
    appendVerificationRecord,
    readVerificationRecords,
    writeLadderLevel,
    syncBdFromAccounts,
    serializeAccount,
    // A3/A4 dispatch
    verifyPaymentAccount,
    certifyLiveAccount,
    refundPaymentTransaction,
    createSelfMfsClaim,
    _private: { verifyShopAccess, validateCredentialsForKind, delegate, lazyRequire },
};
