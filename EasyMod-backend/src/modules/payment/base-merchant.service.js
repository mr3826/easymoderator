/**
 * Base Merchant Service — LEGACY in-process token-cache base for the old
 * v1.2.0 bKash checkout client (`bkash-merchant.service.js`).
 *
 * HONEST STATE (Payment Data Contract §7 rows 4–5, D-9):
 *  - NagadMerchantService and RocketMerchantService NEVER existed and never
 *    will — the official docs sweep found NO public official merchant API for
 *    either provider, so their automation is INTENTIONALLY ABSENT. The earlier
 *    wording in this docstring claimed this base eliminated duplication across
 *    three merchants; that was a phantom-class claim and is corrected here.
 *  - Nagad/Rocket payments run only through the self-MFS merchant-confirmation
 *    path (contract §3) — displayed as configured_unverified, never verified
 *    automatically (R-12).
 *  - The current official bKash product is Tokenized Checkout v2, implemented
 *    in `bkash-tokenized.service.js` with a Redis-backed token store and a
 *    ≤2-grants-per-hour budget (§2.1/§4). That client does NOT use this class.
 *  - `bkash-merchant.service.js` has ZERO production importers left after the
 *    §4.2 webhook rewrite; it remains only because its redaction test
 *    (`bkash-merchant.logs.test.js`) still imports it (D-9 rule: a file with a
 *    live importer stays). A future cleanup may retire the pair together.
 *
 * @module payment/base-merchant.service
 * @abstract
 */

const { AppError } = require('../../utils/AppError');
const { createLogger } = require('../../utils/structured-logger');

class BaseMerchantService {
  /**
   * Initialize base merchant service
   * 
   * @param {string} gatewayName - Human-readable gateway name (e.g., 'bKash', 'Nagad')
   * @param {string} baseUrl - Base URL for API requests
   */
  constructor(gatewayName, baseUrl) {
    this.gatewayName = gatewayName;
    this.baseUrl = baseUrl;
    this.cache = new Map();
    this.logger = createLogger(`Merchant-${gatewayName}`);
    this.TOKEN_CACHE_TTL = 50 * 60 * 1000; // 50 minutes
  }

  /**
   * Get or refresh cached OAuth token
   * 
   * Implements token caching with automatic expiration after TOKEN_CACHE_TTL.
   * If cached token exists and hasn't expired, returns it immediately.
   * Otherwise, calls the fetch function to get a fresh token.
   * 
   * @param {string} cacheKey - Unique cache key (typically `${gateway}_token_${shopId}`)
   * @param {Function} fetchTokenFn - Async function that fetches fresh token from gateway API
   * @returns {Promise<string>} OAuth token for gateway authentication
   * 
   * @throws {AppError} If token fetch fails or gateway is unreachable
   * 
   * @example
   * const token = await this.getCachedToken(`bkash_token_${shopId}`, async () => {
   *   const response = await axios.post(`${this.baseUrl}/v1.2.0/oauth/token`, data);
   *   return response.data.id_token;
   * });
   */
  async getCachedToken(cacheKey, fetchTokenFn) {
    // Check cache for valid token
    const cached = this.cache.get(cacheKey);

    if (cached && cached.expiresAt > Date.now()) {
      this.logger.debug('Token cache hit', {
        cacheKey,
        expiresIn: Math.round((cached.expiresAt - Date.now()) / 1000) + 's'
      });
      return cached.token;
    }

    if (cached) {
      this.logger.debug('Token cache expired, fetching fresh', { cacheKey });
    }

    try {
      this.logger.debug('Fetching fresh OAuth token', { cacheKey });
      const token = await fetchTokenFn();

      if (!token) {
        throw new Error('Token fetch returned empty result');
      }

      // Store in cache with expiration time
      const expiresAt = Date.now() + this.TOKEN_CACHE_TTL;
      this.cache.set(cacheKey, { token, expiresAt });

      this.logger.info('OAuth token cached successfully', {
        cacheKey,
        expiresAt: new Date(expiresAt).toISOString(),
        ttlMinutes: Math.round(this.TOKEN_CACHE_TTL / 60000)
      });

      return token;
    } catch (error) {
      this.logger.error('OAuth token fetch failed', {
        cacheKey,
        gateway: this.gatewayName,
        error: error.message,
        errorCode: error.code
      });

      throw new AppError(
        `Failed to authenticate with ${this.gatewayName}: ${error.message}`,
        500,
        'OAUTH_TOKEN_FETCH_FAILED'
      );
    }
  }

  /**
   * Clear cached token for a specific key
   * 
   * Use when credentials are updated or gateway connection is re-established.
   * 
   * @param {string} cacheKey - Cache key to clear
   */
  clearTokenCache(cacheKey) {
    const existed = this.cache.has(cacheKey);
    this.cache.delete(cacheKey);

    if (existed) {
      this.logger.info('Token cache cleared', { cacheKey, gateway: this.gatewayName });
    }
  }

  /**
   * Clear all cached tokens
   * 
   * Use for complete cache reset or service shutdown.
   */
  clearAllTokens() {
    const cacheSize = this.cache.size;
    this.cache.clear();
    this.logger.info('All cached tokens cleared', {
      gateway: this.gatewayName,
      tokensCleared: cacheSize
    });
  }

  /**
   * Get cache statistics
   * 
   * Returns information about current cache state.
   * 
   * @returns {Object} Cache statistics
   * @returns {number} .size - Number of cached tokens
   * @returns {Array<string>} .keys - Cache keys
   * @returns {Array<Date>} .expirations - Expiration times
   */
  getCacheStats() {
    const entries = Array.from(this.cache.entries());
    return {
      size: this.cache.size,
      keys: entries.map(([key]) => key),
      expirations: entries.map(([, { expiresAt }]) => ({
        expiresAt: new Date(expiresAt),
        ttlSeconds: Math.round((expiresAt - Date.now()) / 1000)
      }))
    };
  }
}

module.exports = BaseMerchantService;
