'use strict';

/**
 * ADR-0013 §5 — the channel-automation resolver is the SOLE mode authority for
 * every send path.
 *
 * `getEffectiveAiReplyMode` remains the business-default reader for display and
 * consumer surfaces (admin, growth-os, shop AI settings GET). Automatic send
 * paths must consult `loadEffectiveChannelAutomation`/`resolveChannelAutomation`
 * only: a direct business-mode read there would ignore the narrow-only channel
 * override, the emergency stop and shop state.
 *
 * Static (grep-style) pin, matching the existing security-suite style. It is a
 * tripwire, not a runtime proof; behavioural coverage lives in the worker and
 * meta-e2e suites.
 */

const fs = require('fs');
const path = require('path');

const backendRoot = path.resolve(__dirname, '../../..');
const source = (relative) => fs.readFileSync(path.join(backendRoot, relative), 'utf8');

const SEND_PATH_FILES = [
    'src/jobs/message-worker.js',
    'src/modules/conversation/human-handoff.service.js',
    'src/modules/webhook/webhook.service.js',
];

describe('channel automation resolver boundary', () => {
    test.each(SEND_PATH_FILES)('%s does not call getEffectiveAiReplyMode directly', (relative) => {
        const file = source(relative);
        expect(file).not.toMatch(/\bgetEffectiveAiReplyMode\s*\(/);
    });

    test.each(SEND_PATH_FILES)('%s imports the channel-automation resolver', (relative) => {
        const file = source(relative);
        expect(file).toMatch(/require\(['"][^'"]*channel-automation\.resolver['"]\)/);
    });

    test('the worker consults the resolver at every enumerated enforcement site', () => {
        const worker = source('src/jobs/message-worker.js');

        // Guard 4 / candidate reuse / pre-policy / recovery use the pure resolver.
        expect(worker).toContain('const resolvedAutomation = resolveWorkerAutomation(');
        expect(worker).toContain('isAutoSendMode(guardEffectiveMode)');

        // Send guard + provider boundary + recovery use the tenant-asserted loader.
        expect(worker).toContain('loadEffectiveChannelAutomation(');

        // Boundary reads must not create rows or take a Shop row lock.
        expect(worker).toContain('loadEffectiveChannelAutomation(shopId, pinnedChannelId, { transaction })');
        expect(worker).not.toMatch(/loadEffectiveChannelAutomation\([^)]*createIfMissing/);
    });

    test('legacy Page mode columns are never read as automation authority', () => {
        const worker = source('src/jobs/message-worker.js');
        // `channelSettings.automation_mode` is only ever WRITTEN with the
        // effective mode (the worker settings object), never read into a mode.
        expect(worker).not.toMatch(/channelAISettings\.automation_mode/);
        expect(worker).not.toMatch(/channelSettings\.automation_mode\s*(?:\?\?|\|\|)/);
        expect(worker).not.toMatch(/jobChannel\.automation_mode/);
    });

    test('the boundary loader is called with the pinned conversation channel', () => {
        const worker = source('src/jobs/message-worker.js');
        expect(worker).toContain('const pinnedChannelId = conversation.meta_channel_id || fallbackChannelId;');
    });
});