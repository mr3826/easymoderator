'use strict';

const fs = require('fs');
const path = require('path');

const backendRoot = path.resolve(__dirname, '../../..');
const aiRoot = path.join(backendRoot, 'src', 'modules', 'ai');
const workerPath = path.join(backendRoot, 'src', 'jobs', 'message-worker.js');

const collectJavaScript = (directory) => fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return collectJavaScript(fullPath);
    return entry.name.endsWith('.js') ? [fullPath] : [];
});

const relativeSource = (file) => path.relative(backendRoot, file).replace(/\\/g, '/');

describe('AI mutation import boundary', () => {
    test('AI modules and the message worker do not import mutation services directly', () => {
        const files = [...collectJavaScript(aiRoot), workerPath];
        const forbidden = /require\(['"](?:\.\.\/)+(?:order|payment|delivery|customer|consent)\/[^'"]*(?:service|controller)\.js['"]\)/g;
        const violations = [];

        for (const file of files) {
            const source = fs.readFileSync(file, 'utf8');
            for (const match of source.matchAll(forbidden)) {
                violations.push(`${relativeSource(file)}: ${match[0]}`);
            }
        }

        expect(violations).toEqual([]);
    });

    test('the worker derives mutation permission from the resolved effective mode and a fresh channel order permission', () => {
        const source = fs.readFileSync(workerPath, 'utf8');

        // ADR-0013 §7: permission is no longer the business-mode literal. It is
        // (a) the EFFECTIVE resolved mode for this turn and (b) a fresh channel
        // re-read of allow_order_creation immediately before each mutation seam.
        expect(source).toMatch(
            /const\s+resolveMutationsAllowed\s*=\s*async\s*\(effectiveMode,\s*channel\)\s*=>\s*\{[\s\S]*?if\s*\(!isAutoSendMode\(effectiveMode\)\)\s*return\s+false;[\s\S]*?const\s+latest\s*=\s*await\s+getChannelAISettings\(channel\);[\s\S]*?return\s+latest\.allow_order_creation\s*!==\s*false;/,
        );

        // Both mutation seams (interaction kernel and order flow) re-resolve
        // immediately before the call and pass the fresh decision in.
        expect(source).toMatch(
            /const\s+interactionsMutationsAllowed\s*=\s*await\s+resolveMutationsAllowed\(guardEffectiveMode,\s*jobChannel\);/,
        );
        expect(source).toContain('mutationsAllowed: interactionsMutationsAllowed');
        expect(source).toMatch(
            /const\s+orderFlowMutationsAllowed\s*=\s*await\s+resolveMutationsAllowed\(guardEffectiveMode,\s*jobChannel\);/,
        );
        expect(source).toContain('mutationsAllowed: orderFlowMutationsAllowed');

        // The effective mode must come from the resolver, never a direct
        // business-mode literal at the seam.
        expect(source).not.toContain('mutationsAllowed: isAutoSendMode(businessMode)');
        expect(source).toContain('const guardEffectiveMode = resolvedAutomation.mode;');

        // Trace/context propagation into the order seam is unchanged.
        expect(source).toContain('conversationId,');
        expect(source).toContain('traceId: job.id || effExternalId || conversationId');
    });
});
