'use strict';

/**
 * WP-03 daily snapshot job — unit suite.
 *
 * Pins the three properties the contract depends on: dryRun persists nothing;
 * a real run writes exactly one aggregate-only AuditLog per AUTHORIZED shop
 * (action job:confidence-qualification-snapshot, resource_type shop) and is
 * idempotent via BaseJob's executionId lookup; Slack fires only on a
 * transition INTO QUALIFIED. The evaluator is real (pure); the rollup read is
 * stubbed — its SQL invariants belong to the rollup suites.
 */

process.env.NODE_ENV = 'test';

const mockRollup = jest.fn();
const mockShopFindAll = jest.fn();
const mockPilotFindAll = jest.fn();
const mockAuditCreate = jest.fn(async () => ({}));
const mockAuditFindOne = jest.fn();
const mockSendSlack = jest.fn(async () => true);

jest.mock('../../modules/ai/reply-confidence-rollup.service', () => ({
    getReplyConfidenceRollup: (...args) => mockRollup(...args),
}));
jest.mock('../../utils/ops-alert', () => ({
    sendSlack: mockSendSlack,
    opsAlert: jest.fn(async () => {}),
}));
jest.mock('../../utils/structured-logger', () => ({
    createLogger: jest.fn(() => ({
        warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn(),
    })),
}));
jest.mock('../../modules/entities', () => ({
    Shop: { findAll: (...args) => mockShopFindAll(...args) },
    ShopPilotFeatures: { findAll: (...args) => mockPilotFindAll(...args) },
    AuditLog: {
        create: (...args) => mockAuditCreate(...args),
        findOne: (...args) => mockAuditFindOne(...args),
    },
}));

const ConfidenceQualificationSnapshotJob = require('../confidence-qualification-snapshot.job');

const SHOP_A = '11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SHOP_B = '22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SHOP_SUSPENDED = '33333333-cccc-4ccc-8ccc-cccccccccccc';
const SHOP_STOPPED = '44444444-dddd-4ddd-8ddd-dddddddddddd';
const SHOP_NOT_ENROLLED = '55555555-eeee-4eee-8eee-eeeeeeeeeeee';

const HOUR_MS = 60 * 60 * 1000;
const RUN_DATE = new Date('2026-11-21T03:30:00.000Z');
const EXECUTION_ID = 'confidence-qualification-snapshot-2026-11-21';

const emptyRollup = () => ({
    hours: 168, turns: 3, truncated: false,
    missing: 3, suggestion: 0, delivered: 0, unscored: 0,
    wouldHold: 0, wouldHoldCovered: 0, wouldHoldUnknown: 3,
    scoreBuckets: { belowHalf: 0, halfToBelowThreeQuarters: 0, threeQuartersOrAbove: 0 },
    reasons: {}, retrieval: {}, retrievalCovered: 0, retrievalUnknown: 3, computeP95Ms: null,
    conversations: 0, firstEligibleObservedAt: null,
    scored: 0, eligible: 0, ineligible: 3,
});

const qualifiedRollup = () => ({
    ...emptyRollup(),
    turns: 31, missing: 1, suggestion: 14, delivered: 17, unscored: 0,
    conversations: 3,
    firstEligibleObservedAt: new Date(RUN_DATE.getTime() - 80 * HOUR_MS).toISOString(),
    scored: 31, eligible: 31, ineligible: 1,
});

/** BaseJob idempotency lookup and _previousVerdict share AuditLog.findOne. */
function routeFindOne({ previousVerdict = null } = {}) {
    mockAuditFindOne.mockImplementation(async ({ where }) => {
        if (where.resource_type === 'shop') {
            return previousVerdict === null
                ? null
                : { metadata: { verdict: previousVerdict } };
        }
        return null; // no existing execution yet
    });
}

beforeEach(() => {
    jest.clearAllMocks();
    mockShopFindAll.mockResolvedValue([
        { id: SHOP_A, is_active: true, ai_emergency_stop: false },
        { id: SHOP_B, is_active: true, ai_emergency_stop: false },
        { id: SHOP_SUSPENDED, is_active: false, ai_emergency_stop: false },
        { id: SHOP_STOPPED, is_active: true, ai_emergency_stop: true },
        { id: SHOP_NOT_ENROLLED, is_active: true, ai_emergency_stop: false },
    ]);
    mockPilotFindAll.mockResolvedValue([
        { shop_id: SHOP_A, customer_intelligence: true, interaction_choices: false,
            action_queue: false, knowledge_suggestions: false, ads_studio: false,
            storefront: false, ai_reply_shadow_meter: false, order_confidence_mode: 'shadow' },
        { shop_id: SHOP_B, customer_intelligence: false, interaction_choices: false,
            action_queue: false, knowledge_suggestions: false, ads_studio: false,
            storefront: false, ai_reply_shadow_meter: false, order_confidence_mode: 'off' },
        { shop_id: SHOP_SUSPENDED, customer_intelligence: true, interaction_choices: false,
            action_queue: false, knowledge_suggestions: false, ads_studio: false,
            storefront: false, ai_reply_shadow_meter: false, order_confidence_mode: 'off' },
        { shop_id: SHOP_STOPPED, customer_intelligence: true, interaction_choices: false,
            action_queue: false, knowledge_suggestions: false, ads_studio: false,
            storefront: false, ai_reply_shadow_meter: false, order_confidence_mode: 'off' },
        // SHOP_NOT_ENROLLED has no pilot row at all.
    ]);
    routeFindOne();
    mockRollup.mockResolvedValue(emptyRollup());
});

const perShopRows = () => mockAuditCreate.mock.calls
    .map(([row]) => row)
    .filter((row) => row.resource_type === 'shop');

describe('dryRun persists nothing', () => {
    test('no AuditLog.create at all — neither per-shop nor job-level', async () => {
        const result = await new ConfidenceQualificationSnapshotJob()
            .execute({ dryRun: true, runDate: RUN_DATE });

        expect(result.status).toBe('success');
        expect(mockAuditCreate).not.toHaveBeenCalled();
        expect(mockSendSlack).not.toHaveBeenCalled();
        expect(result.result.dryRun).toBe(true);
        expect(result.result.shopsAuthorized).toBe(1); // only SHOP_A passes the proxy
        expect(result.result.snapshotsWritten).toBe(0);
    });

    test('dryRun still reads the rollup for the authorized shop only', async () => {
        await new ConfidenceQualificationSnapshotJob()
            .execute({ dryRun: true, runDate: RUN_DATE });
        expect(mockRollup).toHaveBeenCalledTimes(1);
        expect(mockRollup).toHaveBeenCalledWith(SHOP_A, 168);
    });
});

describe('real run — one aggregate-only AuditLog per authorized shop', () => {
    test('suspended, emergency-stopped and un-enrolled shops are skipped', async () => {
        const result = await new ConfidenceQualificationSnapshotJob()
            .execute({ runDate: RUN_DATE });

        expect(result.status).toBe('success');
        const rows = perShopRows();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            action: 'job:confidence-qualification-snapshot',
            resource_type: 'shop',
            resource_id: SHOP_A,
            shop_id: SHOP_A,
            user_id: null,
            ip_address: 'system',
        });
        expect(rows[0].metadata).toMatchObject({
            executionId: EXECUTION_ID,
            contractVersion: 'confidence-observation-v1',
            windowHours: 168,
            verdict: 'OBSERVATION_PENDING', // zero eligible observations
            firstEligibleObservedAt: null,
            denominators: { scored: 0, unscored: 0, eligible: 0, ineligible: 3, conversations: 0 },
        });
        // BaseJob's own aggregate job-level row is also written (existing pattern).
        const jobLevel = mockAuditCreate.mock.calls.map(([r]) => r)
            .filter((r) => r.resource_type === 'job');
        expect(jobLevel).toHaveLength(1);
        expect(jobLevel[0].metadata).toMatchObject({ executionId: EXECUTION_ID });
        expect(result.result.shopsAuthorized).toBe(1);
        expect(result.result.snapshotsWritten).toBe(1);
    });

    test('persisted metadata is aggregate-only — zero PII in the serialized row', async () => {
        await new ConfidenceQualificationSnapshotJob().execute({ runDate: RUN_DATE });
        const serialized = JSON.stringify(perShopRows());
        expect(serialized).not.toMatch(/psid|token_ct|access_token|customer_name|customer_phone|email|page_access|sender_id|"content"|shop_name|unique_code/i);
    });

    test('a failed rollup read is recorded honestly as INSUFFICIENT_EVIDENCE, not a pass', async () => {
        mockRollup.mockRejectedValueOnce(new Error('statement timeout'));
        await new ConfidenceQualificationSnapshotJob().execute({ runDate: RUN_DATE });
        const rows = perShopRows();
        expect(rows).toHaveLength(1);
        expect(rows[0].metadata.verdict).toBe('INSUFFICIENT_EVIDENCE');
        expect(rows[0].metadata.reportSummary.turns).toBeNull();
    });

    test('QUALIFIED transition pages Slack exactly once with aggregate-only text', async () => {
        mockRollup.mockResolvedValue(qualifiedRollup());
        routeFindOne({ previousVerdict: 'OBSERVATION_PENDING' });
        const result = await new ConfidenceQualificationSnapshotJob()
            .execute({ runDate: RUN_DATE });
        expect(perShopRows()[0].metadata.verdict).toBe('QUALIFIED');
        expect(mockSendSlack).toHaveBeenCalledTimes(1);
        expect(mockSendSlack.mock.calls[0][0]).toContain('QUALIFIED');
        expect(JSON.stringify(mockSendSlack.mock.calls)).not.toMatch(/psid|access_token|customer_name|email|sender_id/i);
        expect(result.result.qualifiedTransitions).toBe(1);
    });

    test('already-QUALIFIED yesterday → no repeat page', async () => {
        mockRollup.mockResolvedValue(qualifiedRollup());
        routeFindOne({ previousVerdict: 'QUALIFIED' });
        await new ConfidenceQualificationSnapshotJob().execute({ runDate: RUN_DATE });
        expect(mockSendSlack).not.toHaveBeenCalled();
    });

    test('dryRun never pages even on a qualifying window', async () => {
        mockRollup.mockResolvedValue(qualifiedRollup());
        await new ConfidenceQualificationSnapshotJob()
            .execute({ dryRun: true, runDate: RUN_DATE });
        expect(mockSendSlack).not.toHaveBeenCalled();
        expect(mockAuditCreate).not.toHaveBeenCalled();
    });
});

describe('idempotency via BaseJob executionId (AuditLog-backed)', () => {
    test('a second execute for the same UTC day skips the run without re-reading or re-writing', async () => {
        await new ConfidenceQualificationSnapshotJob().execute({ runDate: RUN_DATE });
        expect(mockAuditCreate).toHaveBeenCalledTimes(2); // 1 shop + 1 job-level

        // Now an execution already exists for this executionId:
        mockAuditFindOne.mockImplementation(async ({ where }) => (
            where.metadata ? { created_at: new Date(), metadata: { executionId: EXECUTION_ID } } : null
        ));
        mockShopFindAll.mockClear();
        mockAuditCreate.mockClear();

        const second = await new ConfidenceQualificationSnapshotJob()
            .execute({ runDate: RUN_DATE });
        expect(second.status).toBe('skipped');
        expect(second.reason).toBe('already_executed');
        expect(mockShopFindAll).not.toHaveBeenCalled();
        expect(mockAuditCreate).not.toHaveBeenCalled();
    });
});
