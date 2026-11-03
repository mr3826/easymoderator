'use strict';

/**
 * The courier reconciliation job must be schedulable from the worker process
 * (queue-manager) while staying OFF until an operator explicitly enables it:
 * the Steadfast payments pull is an external call whose account semantics have
 * not been live-verified (docs/mobile/COD_CAPABILITY_AUDIT.md), so the weekly
 * schedule is gated on COURIER_RECON_JOBS_ENABLED and fail-closed in production.
 */

const ORIGINAL_ENV = { ...process.env };

const buildManager = () => {
    jest.resetModules();

    jest.doMock('bullmq', () => ({
        Queue: jest.fn().mockImplementation((name) => ({
            name,
            on: jest.fn(),
            add: jest.fn().mockResolvedValue({ id: 'job-1' }),
            upsertJobScheduler: jest.fn().mockResolvedValue(undefined),
            close: jest.fn().mockResolvedValue(undefined),
        })),
        Worker: jest.fn().mockImplementation(() => ({
            on: jest.fn(),
            waitUntilReady: jest.fn().mockResolvedValue(undefined),
            close: jest.fn().mockResolvedValue(undefined),
        })),
    }));
    jest.doMock('../../config/config', () => ({
        redisUrl: 'redis://test:6379',
        redisHost: 'test',
        redisPort: 6379,
        env: 'test',
    }));
    jest.doMock('../message-queue', () => ({
        connection: { host: 'test', port: 6379 },
        messageQueue: { on: jest.fn(), close: jest.fn().mockResolvedValue(undefined) },
    }));
    jest.doMock('../index', () => {
        class NoopJob { async execute() { return {}; } }
        return new Proxy({}, { get: () => NoopJob });
    });

    const manager = require('../queue-manager');
    return manager;
};

afterEach(() => {
    jest.resetModules();
    jest.dontMock('bullmq');
    jest.dontMock('../../config/config');
    jest.dontMock('../message-queue');
    jest.dontMock('../index');
    process.env = { ...ORIGINAL_ENV };
});

test('does not register the weekly courier schedule by default in production', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.COURIER_RECON_JOBS_ENABLED;
    const manager = buildManager();

    await manager.scheduleJobs();

    expect(manager.queues.courierReconciliation.upsertJobScheduler).not.toHaveBeenCalled();
});

test('registers the weekly schedule when the operator enables the flag', async () => {
    process.env.NODE_ENV = 'production';
    process.env.COURIER_RECON_JOBS_ENABLED = 'true';
    const manager = buildManager();

    await manager.scheduleJobs();

    expect(manager.queues.courierReconciliation.upsertJobScheduler).toHaveBeenCalledWith(
        'courier-reconciliation',
        { pattern: '0 3 * * 0', tz: 'UTC' },
        expect.objectContaining({ name: 'run' })
    );
});

test('manual trigger enqueues through the courier reconciliation queue', async () => {
    process.env.NODE_ENV = 'production';
    const manager = buildManager();

    await manager.triggerJob('courier_reconciliation', { dryRun: true });

    expect(manager.queues.courierReconciliation.add).toHaveBeenCalledWith(
        'run',
        expect.objectContaining({ dryRun: true }),
        expect.any(Object)
    );
});