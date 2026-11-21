/**
 * redis-client URL validation — Unit Tests
 *
 * Defect: validateRedisUrl() only accepted localhost/127.0.0.1 or literal
 * 4-part private IPs, so the single-label compose hostname `redis`
 * (redis://redis:6379, the rendered production URL) fell through to the
 * "REDIS_URL appears public" warning — a false positive on a bridge-internal
 * Docker network alias that is never publicly routable.
 *
 * Fix: single-label hostnames (no dots, not IPv6 literals) are internal.
 * Dotted public FQDNs and public IPs must still warn.
 */

'use strict';

// Mutable config mock so each test picks its environment.
const mockConfig = { env: 'production', redisUrl: '', redisPassword: '' };
jest.mock('../../config/config', () => mockConfig);

// Never open a connection: constructor mock records its arguments and
// returns an EventEmitter-shaped stub.
const mockRedisInstance = {
    status: 'wait',
    on: jest.fn(),
    quit: jest.fn(async () => 'OK'),
};
const mockRedisCtor = jest.fn(() => mockRedisInstance);
jest.mock('ioredis', () => mockRedisCtor);

const { validateRedisUrl } = require('../redis-client');

describe('validateRedisUrl (production)', () => {
    let warnSpy;

    beforeEach(() => {
        mockConfig.env = 'production';
        warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        warnSpy.mockRestore();
    });

    const publicWarnings = () => warnSpy.mock.calls.filter(
        (args) => String(args[0]).includes('REDIS_URL appears public')
    );

    it('does not warn for the compose network alias redis://redis:6379', () => {
        validateRedisUrl('redis://redis:6379');
        expect(publicWarnings()).toHaveLength(0);
    });

    it('does not warn for other single-label internal hostnames', () => {
        validateRedisUrl('redis://cache:6379');
        validateRedisUrl('redis://REDIS:6379'); // hostname is lowercased
        expect(publicWarnings()).toHaveLength(0);
    });

    it('does not warn for localhost', () => {
        validateRedisUrl('redis://localhost:6379');
        expect(publicWarnings()).toHaveLength(0);
    });

    it('does not warn for 127.0.0.1', () => {
        validateRedisUrl('redis://127.0.0.1:6379');
        expect(publicWarnings()).toHaveLength(0);
    });

    it.each([
        ['10.0.0.5', '10.0.0.0/8'],
        ['172.16.0.9', '172.16.0.0/12 lower bound'],
        ['172.31.255.1', '172.16.0.0/12 upper bound'],
        ['192.168.1.10', '192.168.0.0/16'],
    ])('does not warn for private IP %s (%s)', (ip) => {
        validateRedisUrl(`redis://${ip}:6379`);
        expect(publicWarnings()).toHaveLength(0);
    });

    it('warns for a public IP (203.0.113.5)', () => {
        validateRedisUrl('redis://203.0.113.5:6379');
        expect(publicWarnings()).toHaveLength(1);
    });

    it('warns for an IP just outside the private range (172.32.0.1)', () => {
        validateRedisUrl('redis://172.32.0.1:6379');
        expect(publicWarnings()).toHaveLength(1);
    });

    it('warns for a public FQDN (cache.example.com)', () => {
        validateRedisUrl('redis://cache.example.com:6379');
        expect(publicWarnings()).toHaveLength(1);
    });

    it('still warns for a public FQDN behind TLS (rediss://)', () => {
        validateRedisUrl('rediss://cache.example.com:6379');
        expect(publicWarnings()).toHaveLength(1);
    });

    it('does not warn for a single-label alias behind TLS (rediss://)', () => {
        validateRedisUrl('rediss://redis:6379');
        expect(publicWarnings()).toHaveLength(0);
    });

    it('keeps warning for public IPv6 literals (not single-label hostnames)', () => {
        validateRedisUrl('redis://[2001:db8::1]:6379');
        expect(publicWarnings()).toHaveLength(1);
    });

    // Dotless IPv4 forms: getaddrinfo resolves these to 203.0.113.5 (public),
    // so they must NOT be treated as internal single-label aliases.
    it.each([
        ['3405803781', 'integer IPv4'],
        ['0xcb007105', 'hex IPv4'],
        ['0XCB007105', 'hex IPv4 (uppercase prefix)'],
    ])('warns for dotless IPv4 form %s (%s)', (host) => {
        validateRedisUrl(`redis://${host}:6379`);
        expect(publicWarnings()).toHaveLength(1);
    });

    it('warns for a trailing-dot public FQDN (cache.example.com.)', () => {
        validateRedisUrl('redis://cache.example.com.:6379');
        expect(publicWarnings()).toHaveLength(1);
    });

    it('warns for a public host behind userinfo (redis://user@host)', () => {
        validateRedisUrl('redis://user@cache.example.com:6379');
        expect(publicWarnings()).toHaveLength(1);
    });

    it('warns for an empty host (redis://)', () => {
        validateRedisUrl('redis://');
        expect(publicWarnings()).toHaveLength(1);
    });

    it('does not warn for an uppercase single-label alias without a port', () => {
        validateRedisUrl('redis://REDIS');
        expect(publicWarnings()).toHaveLength(0);
    });

    it('does not warn outside production', () => {
        mockConfig.env = 'development';
        validateRedisUrl('redis://cache.example.com:6379');
        expect(publicWarnings()).toHaveLength(0);
    });

    it('ignores missing or unparseable URLs without throwing', () => {
        expect(() => validateRedisUrl(undefined)).not.toThrow();
        expect(() => validateRedisUrl('')).not.toThrow();
        expect(() => validateRedisUrl('not a url')).not.toThrow();
        expect(publicWarnings()).toHaveLength(0);
    });
});

describe('getRedisClient TLS/password semantics (unchanged by the hostname fix)', () => {
    let warnSpy;

    beforeEach(() => {
        jest.resetModules();
        jest.clearAllMocks();
        mockConfig.env = 'production';
        mockConfig.redisUrl = '';
        mockConfig.redisPassword = '';
        mockRedisInstance.status = 'wait';
        warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        warnSpy.mockRestore();
    });

    it('enables TLS for rediss:// URLs', () => {
        mockConfig.redisUrl = 'rediss://cache.example.com:6379';
        mockConfig.redisPassword = 'secret';
        const { getRedisClient } = require('../redis-client');
        getRedisClient();
        expect(mockRedisCtor).toHaveBeenCalledWith(
            'rediss://cache.example.com:6379',
            expect.objectContaining({
                tls: { rejectUnauthorized: false },
                password: 'secret',
            })
        );
    });

    it('passes REDIS_PASSWORD through for non-TLS URLs', () => {
        mockConfig.redisUrl = 'redis://redis:6379';
        mockConfig.redisPassword = 'secret';
        const { getRedisClient } = require('../redis-client');
        getRedisClient();
        expect(mockRedisCtor).toHaveBeenCalledWith(
            'redis://redis:6379',
            expect.objectContaining({ password: 'secret' })
        );
        const options = mockRedisCtor.mock.calls[0][1];
        expect(options.tls).toBeUndefined();
    });

    it('still recommends REDIS_PASSWORD for non-TLS production Redis without one', () => {
        mockConfig.redisUrl = 'redis://redis:6379';
        const { getRedisClient } = require('../redis-client');
        getRedisClient();
        expect(warnSpy.mock.calls.some(
            (args) => String(args[0]).includes('REDIS_PASSWORD recommended')
        )).toBe(true);
    });
});