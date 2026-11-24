import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import * as ts from 'typescript';
import enApp from '../locales/en.json';
import bnApp from '../locales/bn.json';
import enPublic from '../locales/public/en.json';
import bnPublic from '../locales/public/bn.json';
import { combineLocale } from '../combineLocale';

const en = combineLocale(enApp, enPublic);
const bn = combineLocale(bnApp, bnPublic);
import i18n from '../index';

/**
 * i18next is configured without a missing-key handler, so an unknown key renders
 * as the literal key path. The Customers screen shipped 11 such keys and would
 * have shown merchants raw text like "customers.detail.phoneNumber" as a field
 * label. This test fails the build instead.
 */
const SRC = path.resolve(__dirname, '../..');

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, acc);
    else if (/\.(tsx|ts)$/.test(entry.name) && !/\.test\.|__tests__/.test(full)) acc.push(full);
  }
  return acc;
}

const hasKey = (obj: unknown, key: string): boolean => valueAt(obj, key) !== undefined;

const valueAt = (obj: unknown, key: string): unknown =>
  key.split('.').reduce<any>((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);

const keyPattern = /^[A-Za-z][\w-]*(?:\.[A-Za-z][\w-]*)+$/;
const translationFiles = sourceFiles(SRC);
// Variable names are file-local, so initializers resolve within their own file.
// A single global name map conflates unrelated declarations that happen to share
// a name (e.g. `decision` in Claim.tsx and BillingStandingBanner.tsx) and pulled
// key-shaped non-translation strings — claim registry ids and validator labels —
// into the used-key set as false positives.
const variableInitializers = new Map<string, Map<string, Array<{ initializer: ts.Expression; file: string }>>>();
const parsedFiles = new Map<string, ts.SourceFile>();

for (const file of translationFiles) {
  const src = fs.readFileSync(file, 'utf8');
  const source = ts.createSourceFile(
    file,
    src,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  parsedFiles.set(file, source);
  const fileVariables = new Map<string, Array<{ initializer: ts.Expression; file: string }>>();
  variableInitializers.set(file, fileVariables);
  const collectVariables = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.initializer) {
      const entries = fileVariables.get(node.name.text) ?? [];
      entries.push({ initializer: node.initializer, file });
      fileVariables.set(node.name.text, entries);
    }
    ts.forEachChild(node, collectVariables);
  };
  collectVariables(source);
}

const usedKeysResult = (() => {
  const found = new Map<string, string>();
  // Keys called with { returnObjects: true } intentionally resolve to
  // arrays/objects (e.g. dashboard.setup.welcomeBullets); every other used
  // key must be a string or i18next renders its internal
  // "returned an object instead of string" error verbatim (A8 F-6(b)).
  const returnObjects = new Set<string>();
  const addKey = (key: string, file: string, allowObject = false) => {
    if (!found.has(key)) found.set(key, path.relative(SRC, file).replace(/\\/g, '/'));
    if (allowObject) returnObjects.add(key);
  };
  const collectDynamicKeys = (node: ts.Node, seen: Set<ts.Expression>, file: string, allowObject = false) => {
    if (ts.isStringLiteralLike(node)) {
      if (keyPattern.test(node.text)) addKey(node.text, node.getSourceFile().fileName, allowObject);
      return;
    }
    if (ts.isIdentifier(node)) {
      for (const declaration of variableInitializers.get(file)?.get(node.text) ?? []) {
        if (seen.has(declaration.initializer)) continue;
        seen.add(declaration.initializer);
        collectDynamicKeys(declaration.initializer, seen, declaration.file, allowObject);
      }
    }
    ts.forEachChild(node, (child) => collectDynamicKeys(child, seen, file, allowObject));
  };

  const usesReturnObjects = (options: ts.Expression | undefined): boolean =>
    !!options && ts.isObjectLiteralExpression(options)
    && options.properties.some((property) => ts.isPropertyAssignment(property)
      && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
      && property.name.getText().replace(/['"]/g, '') === 'returnObjects'
      && property.initializer.kind === ts.SyntaxKind.TrueKeyword);

  for (const [file, source] of parsedFiles) {
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)
        && ts.isIdentifier(node.expression)
        && node.expression.text === 't'
        && node.arguments[0]) {
        const argument = node.arguments[0];
        const allowObject = usesReturnObjects(node.arguments[1]);
        if (ts.isStringLiteralLike(argument)) addKey(argument.text, file, allowObject);
        else collectDynamicKeys(argument, new Set(), file, allowObject);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { usedKeys: found, returnObjectsKeys: returnObjects };
})();
const { usedKeys, returnObjectsKeys } = usedKeysResult;

describe('translation coverage', () => {
  it('finds translation keys to check', () => {
    expect(usedKeys.size).toBeGreaterThan(100);
  });

  it('defines every t() key used in source in en.json', () => {
    const missing = [...usedKeys.entries()]
      .filter(([key]) => !hasKey(en, key))
      .map(([key, file]) => `${key} (${file})`);
    expect(missing).toEqual([]);
  });

  it('defines every t() key used in source in bn.json', () => {
    const missing = [...usedKeys.entries()]
      .filter(([key]) => !hasKey(bn, key))
      .map(([key, file]) => `${key} (${file})`);
    expect(missing).toEqual([]);
  });

  it('resolves every plain-used t() key to a string, not an object node', () => {
    // i18next renders its own failure text verbatim when t() is called on an
    // object node ("key 'x.y' returned an object instead of string.") —
    // exactly how A8 saw internals on the channel detail screen (F-6(b)).
    const offenders = [...usedKeys.entries()]
      .filter(([key]) => !returnObjectsKeys.has(key))
      .filter(([key]) => {
        const enValue = valueAt(en, key);
        const bnValue = valueAt(bn, key);
        const bad = (v: unknown) => v !== undefined && typeof v !== 'string';
        return bad(enValue) || bad(bnValue);
      })
      .map(([key, file]) => `${key} (${file})`);
    expect(offenders).toEqual([]);
  });

  // A8 fix-5: real-i18next proof that commerceSignals.dayCount pluralizes
  // from the raw numeric `count` (dayCount_one/_other) while the template
  // interpolates the locale-formatted {{displayCount}}. bn's Intl cardinal
  // categories are [one, other] (verified: Intl.PluralRules('bn').select(1)
  // === 'one'), so bn ships BOTH forms with the same uninflected noun text.
  it('pluralizes dayCount from count while rendering displayCount digits', async () => {
    const previousLanguage = i18n.language;
    const key = 'dashboard.pulse.commerceSignals.dayCount';
    try {
      await i18n.changeLanguage('en');
      expect(i18n.t(key, { day: '2026-11-24', count: 1, displayCount: '1' })).toBe('2026-11-24 UTC · 1 order');
      expect(i18n.t(key, { day: '2026-11-24', count: 4, displayCount: '4' })).toBe('2026-11-24 UTC · 4 orders');
      await i18n.changeLanguage('bn');
      expect(i18n.t(key, { day: '2026-11-24', count: 1, displayCount: '১' })).toBe('2026-11-24 UTC · ১টি অর্ডার');
      expect(i18n.t(key, { day: '2026-11-24', count: 4, displayCount: '৪' })).toBe('2026-11-24 UTC · ৪টি অর্ডার');
      // A non-numeric count (legacy call sites) must not throw: it falls
      // back to the base form, still interpolating displayCount.
      expect(i18n.t(key, { day: '2026-11-24', count: undefined, displayCount: '৫' })).toBe('2026-11-24 UTC · ৫টি অর্ডার');
    } finally {
      await i18n.changeLanguage(previousLanguage);
    }
  });

  it('keeps the document language synchronized with the selected UI language', async () => {
    const previousLanguage = i18n.language;
    const previousStoredLanguage = window.localStorage.getItem('easymod_lang');
    const languageDetector = i18n.services.languageDetector as any;
    const previousCacheLanguage = languageDetector?.cacheUserLanguage;
    if (languageDetector) languageDetector.cacheUserLanguage = () => {};
    try {
      await i18n.changeLanguage('en');
      expect(document.documentElement.lang).toBe('en');
      await i18n.changeLanguage('bn');
      expect(document.documentElement.lang).toBe('bn');
    } finally {
      if (languageDetector && previousCacheLanguage) languageDetector.cacheUserLanguage = previousCacheLanguage;
      await i18n.changeLanguage(previousLanguage);
      if (previousStoredLanguage === null) window.localStorage.removeItem('easymod_lang');
      else window.localStorage.setItem('easymod_lang', previousStoredLanguage);
    }
  });
});
