/**
 * i18n completeness pin for the Products & Customers redesign surfaces.
 *
 * Why this exists: the component tests mock react-i18next as a key-passthrough
 * (t('products.x') -> 'products.x'), so they verify structure but can never
 * prove that a referenced key RESOLVES in the shipped locale files. The
 * redesigned Products/Categories surfaces shipped 15 such references
 * (products.addProduct, products.import, products.sort.*, products.view.*,
 * products.emptyResults, categories.detail.parentCategory/status/
 * createSubcategoryButton) that rendered as raw keys to merchants — visible
 * only in screenshots. This test reads the REAL en.json/bn.json and the real
 * component sources and fails if any statically-referenced mission key is
 * missing from either locale, or if the two locales drift.
 *
 * It is deliberately scoped to the mission namespaces; the repo-wide legacy
 * key inventory stays under the existing locale-parity suites.
 */
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import en from '../../../../i18n/locales/en.json';
import bn from '../../../../i18n/locales/bn.json';

const MISSION_NS = /^(products|categories|customers|customer)\./;

// Pure technical tokens may legitimately be identical across locales (SKU,
// CSV, BDT, ...). Anything with letters in words must differ.
const TECHNICAL_VALUE = /^[A-Za-z0-9+._/%@–—-]+$/;

const COMPONENT_ROOTS = [
    join(dirname(fileURLToPath(import.meta.url)), '..', '..'), // src/app/components
];

const MISSION_COMPONENT_FILES = [
    'Products.tsx',
    'ProductDetails.tsx',
    'AddProduct.tsx',
    'ProductFormFields.tsx',
    'Categories.tsx',
    'CategoryDetails.tsx',
    'SubcategoryDetails.tsx',
    'Customers.tsx',
    'products/ProductDeleteDialog.tsx',
    'products/productForm.ts',
    'customers/Customer360Page.tsx',
    'customers/CustomerDetailPage.tsx',
    'customers/CustomerCRMPanel.tsx',
    'customers/CustomerRecordDialogs.tsx',
    'customers/OpportunityCard.tsx',
    'customers/customerDisplay.ts',
];

const resolve = (tree: unknown, dotted: string): unknown =>
    dotted.split('.').reduce<unknown>((node, part) => {
        if (node && typeof node === 'object' && part in (node as Record<string, unknown>)) {
            return (node as Record<string, unknown>)[part];
        }
        return undefined;
    }, tree);

// Captures every mission-namespace string literal (t('a.b'), but ALSO keys
// inside ternaries the components pass to t(), e.g.
// t(isCreate ? 'categories.detail.createFailed' : '…updateFailed') — a
// t(call)-anchored regex misses those. Template-literal/dynamic keys cannot
// be resolved statically and stay excluded on purpose.
const STATIC_KEY_RE = /['"]((?:products|categories|customers|customer)\.[A-Za-z0-9_.]+)['"]/g;

function collectKeys(): Map<string, string[]> {
    const keys = new Map<string, string[]>();
    for (const root of COMPONENT_ROOTS) {
        for (const rel of MISSION_COMPONENT_FILES) {
            const file = join(root, rel);
            if (!statSync(file, { throwIfNoEntry: false })) {
                throw new Error(`Mission component missing: ${rel}`);
            }
            const source = readFileSync(file, 'utf8');
            for (const match of source.matchAll(STATIC_KEY_RE)) {
                const key = match[1];
                if (!MISSION_NS.test(key)) continue;
                keys.set(key, [...(keys.get(key) ?? []), rel]);
            }
        }
    }
    return keys;
}

describe('Products & Customers i18n completeness (real locale files)', () => {
    const keys = collectKeys();

    it('references a non-empty mission key set', () => {
        expect(keys.size).toBeGreaterThan(100);
    });

    it.each([...keys.entries()])(
        'resolves %s in both en and bn',
        (key: string, files: string[]) => {
            const enValue = resolve(en, key);
            const bnValue = resolve(bn, key);
            expect(
                typeof enValue === 'string' && enValue.trim().length > 0,
                `${key} missing from en.json (referenced by ${files.join(', ')})`,
            ).toBe(true);
            expect(
                typeof bnValue === 'string' && bnValue.trim().length > 0,
                `${key} missing from bn.json (referenced by ${files.join(', ')})`,
            ).toBe(true);
            // The prior incident also had English text parked in bn values.
            if (!TECHNICAL_VALUE.test(String(enValue))) {
                expect(bnValue, `${key} bn value is not translated: ${bnValue}`).not.toBe(enValue);
            }
        },
    );
});
