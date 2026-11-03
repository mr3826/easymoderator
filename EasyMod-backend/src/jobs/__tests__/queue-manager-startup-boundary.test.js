'use strict';

describe('QueueManager startup boundary', () => {
    let manager;
    let Worker;
    let startMessageWorker;
    let currentMessageWorker;

    beforeEach(() => {
        jest.resetModules();

        jest.doMock('bullmq', () => ({
            Queue: jest.fn().mockImplementation(() => ({
                on: jest.fn(),
                close: jest.fn().mockResolvedValue(undefined),
            })),
            Worker: jest.fn().mockImplementation(() => ({
                on: jest.fn(),
                waitUntilReady: jest.fn().mockResolvedValue(undefined),
                close: jest.fn().mockResolvedValue(undefined),
            })),
        }));
        jest.doMock('../../config/config', () => ({
            redisUrl: 'redis://rehearsal.test:6379',
            redisHost: 'rehearsal.test',
            redisPort: 6379,
            env: 'production',
        }));
        jest.doMock('../message-queue', () => ({
            connection: { host: 'rehearsal.test', port: 6379 },
            messageQueue: {
                on: jest.fn(),
                close: jest.fn().mockResolvedValue(undefined),
                getWaitingCount: jest.fn().mockResolvedValue(0),
                getActiveCount: jest.fn().mockResolvedValue(0),
                getCompletedCount: jest.fn().mockResolvedValue(0),
                getFailedCount: jest.fn().mockResolvedValue(0),
                getDelayedCount: jest.fn().mockResolvedValue(0),
            },
        }));
        jest.doMock('../index', () => {
            class NoopJob {
                async execute() { return {}; }
            }
            return {
                MonthlyUsageReset: NoopJob,
                InvoiceGenerator: NoopJob,
                FailedPaymentReconciler: NoopJob,
                DailySalesSummaryNotifier: NoopJob,
                CustomerWaitingNotifier: NoopJob,
                MetaTokenRefreshJob: NoopJob,
                PipelineCanaryJob: NoopJob,
                WebhookReceiptReconcilerJob: NoopJob,
                InboxDeliveryReconcilerJob: NoopJob,
                OpportunityDetectorJob: NoopJob,
                GapSuggesterJob: NoopJob,
                CourierReconciliationJob: NoopJob,
            };
        });
        startMessageWorker = jest.fn(() => ({
            on: jest.fn(),
            waitUntilReady: jest.fn().mockResolvedValue(undefined),
            close: jest.fn().mockResolvedValue(undefined),
        }));
        currentMessageWorker = null;
        jest.doMock('../message-worker', () => ({
            startWorker: startMessageWorker,
            getWorker: () => currentMessageWorker,
        }));

        manager = require('../queue-manager');
        ({ Worker } = jest.requireMock('bullmq'));
    });

    afterEach(() => {
        jest.resetModules();
        jest.dontMock('bullmq');
        jest.dontMock('../../config/config');
        jest.dontMock('../message-queue');
        jest.dontMock('../index');
        jest.dontMock('../message-worker');
    });

    test('loads queue metrics without starting background consumers', () => {
        expect(Worker).not.toHaveBeenCalled();
        expect(startMessageWorker).not.toHaveBeenCalled();
    });

    test('starts consumers only when the worker process explicitly requests it', () => {
        manager.startWorkers();
        const startedWorkerCount = Worker.mock.calls.length;

        expect(startedWorkerCount).toBeGreaterThan(0);
        expect(startMessageWorker).toHaveBeenCalledTimes(1);

        manager.startWorkers();
        expect(Worker).toHaveBeenCalledTimes(startedWorkerCount);
        expect(startMessageWorker).toHaveBeenCalledTimes(1);
    });

    test('reuses a message worker already started by its dedicated entrypoint', () => {
        currentMessageWorker = {
            on: jest.fn(),
            waitUntilReady: jest.fn().mockResolvedValue(undefined),
            close: jest.fn(),
        };

        manager.startWorkers();

        expect(manager.workers.messageProcessing).toBe(currentMessageWorker);
        expect(startMessageWorker).not.toHaveBeenCalled();
    });

    test('waits for every registered consumer before the worker reports ready', async () => {
        manager.startWorkers();
        const workers = Object.values(manager.workers);

        await manager.waitUntilReady();

        for (const worker of workers) {
            expect(worker.waitUntilReady).toHaveBeenCalledTimes(1);
        }
    });
});
