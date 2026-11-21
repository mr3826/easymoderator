#!/usr/bin/env node
'use strict';

/**
 * P0 acceptance matrix runner (WP-01/WP-02 evidence).
 *
 * Dependency-free Node. Executes the EXISTING suites that carry the P0-01…P0-08
 * acceptance criteria and the probe contract, then writes per-case evidence
 * (JSON + Markdown) mapping every case to: test files, harness class, run
 * output summary, and an honest classification.
 *
 * Classification vocabulary (never invent a new one, never upgrade a mocked
 * run to a live one):
 *   AUTOMATED_CONTRACT_PASS   — the case's required lanes ran green HERE:
 *                               real PostgreSQL / Redis / BullMQ (meta-e2e &
 *                               integration lanes), Graph transport mocked.
 *   CI_VERIFIED_PENDING       — a required lane could not run in this
 *                               environment (its disposable PG/Redis was not
 *                               reachable); it runs in the named CI job and
 *                               must not be counted as PASS until green there.
 *   LIVE_PROVIDER_PASS        — real Meta acknowledged the behavior.
 *                               AGENTS CANNOT PRODUCE THIS ROW; only the
 *                               founder's credential-gated live probe can.
 *   LIVE_PROVIDER_UNVERIFIED  — the live boundary is credential-blocked
 *                               (META_REVIEW_MERCHANT_PASSWORD is a founder-
 *                               held write-only secret; scripts/meta-live-e2e.js
 *                               covers 9 text-grounding steps only, not the
 *                               interactive webhook probe).
 *   ACCEPTANCE_FAIL           — a required lane ran and failed. Reported
 *                               loudly; the runner exits non-zero.
 *
 * Usage:
 *   node scripts/p0-acceptance-matrix.js [--run] [--lane=unit|integration|metae2e|all]
 *                                        [--out=<dir>] [--keep-going]
 *
 * --run actually executes suites (default: dry classification only, which
 * marks every run-dependent lane CI_VERIFIED_PENDING — never a fake PASS).
 *
 * Service env is resolved from the lane's canonical disposable endpoints, NOT
 * from the ambient shell (a host REDIS_URL pointing at an unrelated stack must
 * not poison evidence); --integration-url/--meta-url flags override for CI.
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

const BACKEND = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(BACKEND, '..');
const JEST_BIN = path.join(BACKEND, 'node_modules', 'jest', 'bin', 'jest.js');

// ── CLI ──────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const flag = (name, dflt = null) => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : dflt;
};
const RUN = argv.includes('--run');
const ONLY_LANE = flag('lane', 'all');
const KEEP_GOING = argv.includes('--keep-going');
const INTEGRATION_URL = flag('integration-url', 'postgres://e2e:e2e@127.0.0.1:55432/easymod_integration_test');
const INTEGRATION_REDIS = flag('integration-redis', 'redis://127.0.0.1:56379');
const META_URL = flag('meta-url', 'postgres://e2e:e2e@127.0.0.1:55433/easymod_meta_e2e');
const META_REDIS = flag('meta-redis', 'redis://127.0.0.1:56380');

function resolveOutDir() {
    const explicit = flag('out');
    if (explicit) return path.resolve(explicit);
    if (process.env.P0_MATRIX_OUT_DIR) return path.resolve(process.env.P0_MATRIX_OUT_DIR);
    const evidenceSibling = path.resolve(REPO_ROOT, '..', 'prod-evidence', 'assessments');
    if (fs.existsSync(path.dirname(evidenceSibling))) return evidenceSibling; // local evidence volume only
    return path.join(BACKEND, 'test-results', 'p0-acceptance-matrix');
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const parseUrl = (kind, url) => {
    try {
        const u = new URL(url);
        return { host: u.hostname, port: Number(u.port || (kind === 'pg' ? 5432 : 6379)) };
    } catch (_) {
        return null;
    }
};

const tcpReachable = ({ host, port }, timeoutMs = 800) => new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (v) => { sock.destroy(); resolve(v); };
    sock.setTimeout(timeoutMs);
    sock.on('connect', () => done(true));
    sock.on('timeout', () => done(false));
    sock.on('error', () => done(false));
});

function laneEnv(lane) {
    // Start from a CLEAN environment: jest setupFiles (tests/integration/env.js,
    // tests/meta-e2e/env.js) honor pre-set vars, so a host-level REDIS_URL
    // would silently retarget a lane. CI must pass explicit overrides instead.
    const env = {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        COMSPEC: process.env.COMSPEC,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
        HOME: process.env.HOME,
        USERPROFILE: process.env.USERPROFILE,
        APPDATA: process.env.APPDATA,
        LOCALAPPDATA: process.env.LOCALAPPDATA,
        NODE_ENV: 'test',
        CI: process.env.CI || '',
    };
    if (lane === 'integration') {
        env.DATABASE_URL = INTEGRATION_URL;
        env.REDIS_URL = INTEGRATION_REDIS;
    }
    if (lane === 'metae2e') {
        env.DATABASE_URL = META_URL;
        env.REDIS_URL = META_REDIS;
    }
    return env;
}

/** Memoized per-suite execution; returns a normalized result object. */
const suiteRuns = new Map();
function runSuite(suite) {
    if (suiteRuns.has(suite.key)) return suiteRuns.get(suite.key);
    const execute = async () => {
        if (suite.requires) {
            for (const svc of suite.requires) {
                const target = parseUrl(svc.kind, svc.url);
                if (!target || !(await tcpReachable(target))) {
                    return { status: 'SKIPPED_SERVICES', suite: suite.key, detail: `${svc.kind} ${target ? `${target.host}:${target.port}` : svc.url} unreachable` };
                }
            }
        }
        if (!fs.existsSync(JEST_BIN)) {
            return { status: 'SKIPPED_ENV', suite: suite.key, detail: 'jest binary not installed (no node_modules)' };
        }
        const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p0matrix-'));
        const outFile = path.join(outDir, 'result.json');
        const args = [
            JEST_BIN,
            ...(suite.config ? ['--config', suite.config] : []),
            '--runInBand', '--forceExit', '--coverage=false',
            '--json', `--outputFile=${outFile}`,
            ...suite.files,
        ];
        const startedAt = new Date().toISOString();
        const child = spawnSync(process.execPath, args, {
            cwd: BACKEND,
            env: laneEnv(suite.lane),
            encoding: 'utf8',
            maxBuffer: 128 * 1024 * 1024,
            timeout: suite.timeoutMs || 20 * 60 * 1000,
        });
        let parsed = null;
        try { parsed = JSON.parse(fs.readFileSync(outFile, 'utf8')); } catch (_) { /* keep raw */ }
        fs.rmSync(outDir, { recursive: true, force: true });
        if (!parsed) {
            return {
                status: child.error ? 'ERROR' : 'ACCEPTANCE_FAIL',
                suite: suite.key,
                detail: (child.error && child.error.message) || (child.stderr || '').slice(-2000),
                startedAt,
            };
        }
        const tests = (parsed.testResults || []).flatMap((f) => (f.assertionResults || [])
            .map((t) => ({ file: path.relative(BACKEND, f.name), name: t.fullName, status: t.status })));
        return {
            status: parsed.success ? 'PASS' : 'ACCEPTANCE_FAIL',
            suite: suite.key,
            numPassed: parsed.numPassedTests,
            numFailed: parsed.numFailedTests,
            numTotal: parsed.numTotalTests,
            failedTests: tests.filter((t) => t.status === 'failed').map((t) => `${t.file} :: ${t.name}`),
            startedAt,
            finishedAt: new Date().toISOString(),
        };
    };
    const p = execute();
    suiteRuns.set(suite.key, p);
    return p;
}

// ── Suites (lane membership mirrors package.json exactly) ───────────────────

const S = {
    unitInteractions: {
        key: 'unit:interactions', lane: 'unit', files: [
            'src/modules/interactions/__tests__/interactions.service.test.js',
            'src/modules/integration/__tests__/meta-webhook-postback-referral-durability.test.js',
        ],
    },
    unitStockPolicy: {
        key: 'unit:product-card-stock-policy', lane: 'unit', files: [
            'src/modules/conversation/__tests__/conversation.product-card.stock-policy.test.js',
        ],
    },
    unitR3Probe: {
        key: 'unit:r3-messenger-ux-probe', lane: 'unit', files: [
            'src/modules/integration/__tests__/r3-messenger-ux.test.js',
        ],
    },
    unitProviderProbe: {
        key: 'unit:MetaMessengerProvider', lane: 'unit', files: [
            'src/modules/channel-providers/__tests__/MetaMessengerProvider.test.js',
        ],
    },
    unitCsrf: {
        key: 'unit:csrf-middleware', lane: 'unit', files: [
            'src/middleware/__tests__/csrf-middleware.test.js',
        ],
    },
    unitReplyMode: {
        key: 'unit:message-worker.reply-mode', lane: 'unit', files: [
            'src/jobs/__tests__/message-worker.reply-mode.test.js',
        ],
    },
    metae2ePostback: {
        key: 'metae2e:postback-referral', lane: 'metae2e',
        config: 'jest.meta-e2e.config.js',
        files: ['tests/meta-e2e/postback-referral.test.js'],
        requires: [{ kind: 'pg', url: META_URL }, { kind: 'redis', url: META_REDIS }],
    },
    metae2eFull: {
        key: 'metae2e:meta-e2e-full', lane: 'metae2e',
        config: 'jest.meta-e2e.config.js',
        files: ['tests/meta-e2e/meta-e2e.test.js'],
        requires: [{ kind: 'pg', url: META_URL }, { kind: 'redis', url: META_REDIS }],
    },
    integrationProductCard: {
        key: 'integration:product-card', lane: 'integration',
        config: 'jest.integration.config.js',
        files: ['src/modules/conversation/__tests__/conversation.product-card.integration.test.js'],
        requires: [{ kind: 'pg', url: INTEGRATION_URL }, { kind: 'redis', url: INTEGRATION_REDIS }],
    },
    integrationPilotplus: {
        key: 'integration:pilotplus-v1', lane: 'integration',
        config: 'jest.integration.config.js',
        files: ['src/modules/interactions/__tests__/pilotplus-v1.integration.test.js'],
        requires: [{ kind: 'pg', url: INTEGRATION_URL }, { kind: 'redis', url: INTEGRATION_REDIS }],
    },
    integrationTenantIsolation: {
        key: 'integration:channel-settings-tenant-isolation', lane: 'integration',
        config: 'jest.integration.config.js',
        files: ['src/modules/channel-providers/__tests__/channel-settings.tenant-isolation.integration.test.js'],
        requires: [{ kind: 'pg', url: INTEGRATION_URL }, { kind: 'redis', url: INTEGRATION_REDIS }],
    },
    integrationProbeContract: {
        key: 'integration:meta-channel-probe-contract', lane: 'integration',
        config: 'jest.integration.config.js',
        files: ['src/modules/channel-providers/__tests__/meta-channel-probe.contract.integration.test.js'],
        requires: [{ kind: 'pg', url: INTEGRATION_URL }, { kind: 'redis', url: INTEGRATION_REDIS }],
    },
};

// ── The matrix ───────────────────────────────────────────────────────────────

const CASES = [
    {
        id: 'P0-01',
        title: 'Quick-reply postback intake → durable receipt PROCESSED + interaction CONSUMED',
        authority: 'src/modules/interactions/interaction.contract.js:70-85; interactions.service.js:148-252; message-worker.js:3981-4027',
        harness: 'signed webhook → real BullMQ drain-and-invoke → worker settlement; Graph transport captured',
        suites: [S.metae2ePostback, S.unitInteractions],
        refs: ['tests/meta-e2e/postback-referral.test.js (P0-01)', 'src/modules/interactions/__tests__/interactions.service.test.js:94-336', 'src/modules/integration/__tests__/meta-webhook-postback-referral-durability.test.js'],
        notes: 'postback allowlist is p1:<uuid>:<option> only; card product:<id>:q:<idx> payloads terminal-skip POSTBACK_NOT_ALLOWLISTED.',
    },
    {
        id: 'P0-02',
        title: 'Referral capture: referral_source/referral_source_type=m_me/referral_captured_at + sanitizer',
        authority: 'src/modules/integration/meta-webhook-events.handler.js:1486-1560, 846-858, 1588-1593',
        harness: 'real webhook → real PG conversation rows; sanitizer rejects @/http/://phone/8+digits/>64 chars',
        suites: [S.metae2ePostback, S.unitInteractions],
        refs: ['tests/meta-e2e/postback-referral.test.js (P0-02)', 'src/modules/integration/__tests__/r3-messenger-ux.test.js:610-648'],
        notes: 'WP-01 found the first-touch pure-referral insert omitted NOT NULL conversations.role (receipt stuck RETRY_PENDING); fixed in meta-webhook-events.handler.js alongside this suite — see commit body.',
    },
    {
        id: 'P0-03',
        title: 'Redelivery dedupe on page-scoped payload-hash identity; shared postback.mid does not conflate taps',
        authority: 'src/modules/integration/meta-webhook-receipt.service.js:70-103',
        harness: 'double POST of identical signed envelope + two taps sharing one outbound mid',
        suites: [S.metae2ePostback, S.unitInteractions, S.integrationPilotplus],
        refs: ['tests/meta-e2e/postback-referral.test.js (P0-03)', 'tests/meta-e2e/meta-e2e.test.js:111-124', 'src/modules/interactions/__tests__/pilotplus-v1.integration.test.js:97-224 (real-PG concurrent double-tap)'],
        notes: 'postback.mid names the OUTBOUND button message and is never the event identity; kernel CAS SENT→EXECUTING→CONSUMED makes replays no-ops.',
    },
    {
        id: 'P0-04',
        title: 'Product card renders DB price + In stock(n)/Available on the Graph wire',
        authority: 'src/modules/conversation/conversation.controller.js:1537-1703; MetaMessengerProvider.js:1155-1189',
        harness: 'real route+policy engine+Redis guard, Graph HTTP captured',
        suites: [S.integrationProductCard, S.unitStockPolicy, S.unitR3Probe],
        refs: ['src/modules/conversation/__tests__/conversation.product-card.integration.test.js (P0-04)', 'src/modules/conversation/__tests__/conversation.product-card.stock-policy.test.js'],
        notes: 'subtitle ৳<price> · In stock (n) | Available comes ONLY from server rows; client price fields are 400-rejected by the validator.',
    },
    {
        id: 'P0-05',
        title: 'in_stock=false with quantity>0 → 409 OUT_OF_STOCK before any message exists',
        authority: 'conversation.controller.js:1583-1590; stock-status-guard.service.js:58-61',
        harness: 'same real-stack lane',
        suites: [S.integrationProductCard, S.unitStockPolicy],
        refs: ['src/modules/conversation/__tests__/conversation.product-card.integration.test.js (P0-05)'],
        notes: 'mobile quick-update shape (explicit false + positive qty) is the realized case.',
    },
    {
        id: 'P0-06',
        title: 'Edit → send cache invalidation: card-send invalidates the stock guard BEFORE reading',
        authority: 'conversation.controller.js:1576-1584',
        harness: 'real Redis guard warmed with stale value, then merchant edit, then card send',
        suites: [S.integrationProductCard],
        refs: ['src/modules/conversation/__tests__/conversation.product-card.integration.test.js (P0-06)'],
        notes: 'Defined P0-06 (repeat CARD action) HOLDS. REGISTER ITEM 5 (deferred, nonblocking, NO source change): the product-API edit path does not call stock-guard invalidation, so AI-chat enrichWithStock can show a stale label ≤STOCK_CACHE_TTL_SECONDS=300s after an edit. Proposed deferred fix: invalidate(shopId, productId) in product.controller update path.',
    },
    {
        id: 'P0-07',
        title: 'Cross-shop product/conversation isolation: 404 no leakage, JWT shopId is the only selector, staff allowed, no admin bypass',
        authority: 'conversation.controller.js:1563-1575; shop-access.middleware.js; meta-channel.controller.js:35-42',
        harness: 'real authenticate+verifyShopAccess against real PG membership rows',
        suites: [S.integrationProductCard, S.integrationTenantIsolation, S.integrationProbeContract],
        refs: ['src/modules/conversation/__tests__/conversation.product-card.integration.test.js (P0-07)', 'src/modules/channel-providers/__tests__/channel-settings.tenant-isolation.integration.test.js', 'src/modules/channel-providers/__tests__/meta-channel-probe.contract.integration.test.js'],
        notes: 'platform-admin (SUPPORT_ADMIN) JWT without membership is 403 — asserted on the probe route.',
    },
    {
        id: 'P0-08',
        title: 'AUTO/DRAFT/MANUAL reply modes, channel-override clamp, emergency stop',
        authority: 'src/modules/channel-providers/channel-automation.resolver.js:181-262',
        harness: 'EXISTING coverage kept as-is (reference row)',
        suites: [S.metae2eFull, S.unitReplyMode],
        refs: ['tests/meta-e2e/meta-e2e.test.js:628-764 (REPLY-MODE), :766-903 (CHANNEL-OVERRIDE clamp + 400 INVALID_OVERRIDE_WIDENING), :905-974 (EMERGENCY-STOP)', 'src/jobs/__tests__/message-worker.reply-mode.test.js', 'FE mock specs ai-reply-mode.spec.ts + channel-automation.spec.ts run in CI frontend-e2e lane (not executed by this runner)'],
        notes: 'FE Playwright specs are mock-only (page.route auth intercepts) and are classified via the CI frontend-e2e lane, not this node runner.',
    },
    {
        id: 'PROBE',
        title: 'probe-interaction-fields contract: flag-off 409, ownership 404, UNSUPPORTED_PLATFORM, CSRF chain, provider codes',
        authority: 'meta-channel.controller.js:526-558; MetaMessengerProvider.js:985-1069; csrf-middleware.js:290-301; app.js:161',
        harness: 'unit (mocked axios/DB per r3 pattern) + integration real-auth chain + csrf direct-middleware production-env',
        suites: [S.unitProviderProbe, S.unitR3Probe, S.unitCsrf, S.integrationProbeContract],
        refs: ['src/modules/channel-providers/__tests__/MetaMessengerProvider.test.js (probeInteractionWebhookFields: CHANNEL_NOT_CONNECTED/ALREADY_SUBSCRIBED/SUBSCRIBED+addedFields/EXTERNALLY_BLOCKED+core-repair/transient-throw/empty-targets)', 'src/modules/integration/__tests__/r3-messenger-ux.test.js tests 1,7,8', 'src/middleware/__tests__/csrf-middleware.test.js (WP-02 probe CSRF block)', 'src/modules/channel-providers/__tests__/meta-channel-probe.contract.integration.test.js'],
        notes: 'core WEBHOOK_FIELDS ["messages"] never weakened (union, never replace); token never in any response body; read-back via POST /:channelId/test-webhook persists webhook_subscribed_fields.',
    },
    {
        id: 'LIVE',
        title: 'Live Meta delivery of postback/referral + webhook-field subscription against Meta',
        authority: 'scripts/meta-live-e2e.js (9 text-grounding steps only)',
        harness: 'BLOCKED_EXTERNAL — requires merchant password exclusively in META_REVIEW_MERCHANT_PASSWORD (founder-held, write-only, not agent-readable)',
        suites: [],
        refs: ['EasyMod-backend/scripts/meta-live-e2e.js', 'docs/testing/META_E2E_TEST_SETUP.md'],
        fixed: 'LIVE_PROVIDER_UNVERIFIED',
        notes: 'No automated lane here may be reported as LIVE_PROVIDER_PASS: mocked Graph transport ≠ real Meta delivery.',
    },
];

// ── Classification ───────────────────────────────────────────────────────────

const LANE_PASS_CLASS = 'AUTOMATED_CONTRACT_PASS';

async function main() {
    const rev = spawnSync('git', ['-C', REPO_ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim() || 'UNKNOWN';
    const generatedAt = new Date().toISOString();

    const suiteResults = new Map();
    for (const suite of Object.values(S)) {
        const wanted = ONLY_LANE === 'all' || suite.lane === ONLY_LANE;
        if (!wanted) { suiteResults.set(suite.key, { status: 'NOT_SELECTED', suite: suite.key }); continue; }
        if (!RUN) { suiteResults.set(suite.key, { status: 'NOT_RUN', suite: suite.key }); continue; }
        const res = await runSuite(suite);
        suiteResults.set(suite.key, res);
        if (res.status === 'ACCEPTANCE_FAIL' && !KEEP_GOING) {
            console.error(`\n[p0-matrix] ${res.suite} FAILED — classification will be ACCEPTANCE_FAIL (${(res.failedTests || []).length} failing tests listed in the evidence file)`);
        }
    }

    const cases = CASES.map((c) => {
        const lanes = c.suites.map((s) => ({ key: s.key, lane: s.lane, result: suiteResults.get(s.key) || { status: 'NOT_SELECTED' } }));
        let classification;
        if (c.fixed) classification = c.fixed;
        else if (lanes.some((l) => ['ACCEPTANCE_FAIL', 'ERROR'].includes(l.result.status))) classification = 'ACCEPTANCE_FAIL';
        else if (!RUN) classification = 'CI_VERIFIED_PENDING';
        else if (lanes.every((l) => l.result.status === 'PASS')) classification = LANE_PASS_CLASS;
        else classification = 'CI_VERIFIED_PENDING'; // skipped-for-services lanes pending CI
        return { ...c, classification, lanes };
    });

    const outDir = resolveOutDir();
    fs.mkdirSync(outDir, { recursive: true });

    const json = {
        kind: 'easymoderator.p0-acceptance-matrix',
        version: 1,
        generatedAt,
        revision: rev,
        executed: RUN,
        selectedLane: ONLY_LANE,
        semantics: 'AUTOMATED_CONTRACT_PASS requires real PG/Redis(/BullMQ) with mocked Graph transport; mocked runs are NEVER LIVE_PROVIDER_PASS.',
        suites: Object.fromEntries([...suiteResults.entries()].map(([k, v]) => [k, v])),
        cases: cases.map((c) => ({
            id: c.id, title: c.title, authority: c.authority, harness: c.harness,
            classification: c.classification, notes: c.notes, refs: c.refs,
            lanes: c.lanes.map((l) => ({ key: l.key, lane: l.lane, status: l.result.status, numPassed: l.result.numPassed ?? null, numFailed: l.result.numFailed ?? null })),
        })),
    };
    fs.writeFileSync(path.join(outDir, 'p0-acceptance-matrix.json'), JSON.stringify(json, null, 2));

    const md = [];
    md.push('# P0 Acceptance Matrix — WP-01/WP-02');
    md.push('');
    md.push(`- revision: \`${rev}\``);
    md.push(`- generated: ${generatedAt}`);
    md.push(`- suites executed in this run: ${RUN ? 'yes' : `no (dry classification; lane filter ${ONLY_LANE})`}`);
    md.push('- mocked Graph transport ≠ real Meta delivery; no row below is or implies `LIVE_PROVIDER_PASS`.');
    md.push('');
    md.push('| Case | Classification | Suites | Evidence |');
    md.push('|---|---|---|---|');
    for (const c of cases) {
        const suites = c.lanes.map((l) => `${l.key}:${l.result.status}`).join('<br>') || '—';
        const refs = c.refs.map((r) => `\`${r}\``).join('<br>');
        md.push(`| ${c.id} — ${c.title} | **${c.classification}** | ${suites} | ${refs} |`);
    }
    md.push('');
    md.push('## Notes');
    for (const c of cases) {
        if (c.notes) md.push(`- **${c.id}**: ${c.notes}`);
    }
    md.push('');
    md.push('## Deferred / open items carried in this matrix');
    md.push('- Register item 5 (nonblocking): product-API edit path does not invalidate the stock guard; AI-chat `enrichWithStock` may serve a stale label ≤300s. Defined P0-06 (card path) holds and is asserted green. Deferred proposal: call `stockStatusGuard.invalidate(shopId, productId)` on the product update controller path — requires its own source-change gate; NOT changed by this tests-only PR3.');
    md.push('- Live provider boundary (`LIVE`): `LIVE_PROVIDER_UNVERIFIED` — merchant password exclusively env `META_REVIEW_MERCHANT_PASSWORD` (founder-held write-only). Founder UAT recipe: run the Meta probe from an authenticated merchant session (`POST /api/channels/meta/:channelId/probe-interaction-fields` then `POST .../test-webhook` read-back).');
    md.push('- FE Playwright mock specs (ai-reply-mode, channel-automation; optional composer-popover) run in the CI frontend-e2e 21-spec filter — their status lives in that lane, not here.');
    md.push('');
    md.push('## Honest failures');
    const failed = [...suiteResults.values()].filter((r) => ['ACCEPTANCE_FAIL', 'ERROR'].includes(r.status));
    if (!failed.length) md.push('- none in this run.');
    for (const f of failed) {
        md.push(`- ${f.suite}: ${(f.failedTests || [f.detail || '']).join('; ')}`);
    }
    md.push('');
    fs.writeFileSync(path.join(outDir, 'p0-acceptance-matrix.md'), md.join('\n'));

    console.log(`p0-acceptance-matrix: revision ${rev} executed=${RUN}`);
    for (const c of cases) {
        console.log(`  ${c.id.padEnd(6)} ${c.classification.padEnd(26)} ${c.lanes.map((l) => `${l.key}=${l.result.status}`).join(' ')}`);
    }
    console.log(`  evidence → ${path.join(outDir, 'p0-acceptance-matrix.json')}`);
    console.log(`             ${path.join(outDir, 'p0-acceptance-matrix.md')}`);

    const anyFail = [...suiteResults.values()].some((r) => ['ACCEPTANCE_FAIL', 'ERROR'].includes(r.status));
    process.exitCode = anyFail ? 1 : 0;
}

main().catch((err) => {
    console.error('[p0-matrix] runner error:', err);
    process.exit(2);
});
