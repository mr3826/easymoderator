'use strict';

process.env.NODE_ENV = 'test';
process.env.API_URL = 'https://api.easymod.tech';
process.env.PUBLIC_ASSET_URL = 'https://assets.easymod.tech';

const grounding = require('src/modules/ai/grounding');
const { evaluateCandidate } = require('src/modules/ai/grounding/outbound-grounding.gate');

const SHOP = 'shop-a';
const OTHER_SHOP = 'shop-b';

const catalogProduct = (overrides = {}) => ({
    id: 'product-1',
    shop_id: SHOP,
    name: 'Classic Blue Denim Jacket',
    category: 'jacket',
    price: 3200,
    in_stock: true,
    track_quantity: false,
    quantity: 0,
    is_active: true,
    variants: [],
    images: [],
    tags: [],
    ai_material: 'cotton',
    ai_color: 'black',
    ...overrides,
});

const evidenceForProducts = (products) => {
    const evidence = grounding.emptyEvidence(SHOP);
    evidence.productStatus = grounding.ProductEvidenceStatus.VERIFIED;
    evidence.verifiedProducts = products.map(({ product, material }) => {
        const facts = grounding.buildFacts(product);
        if (material) facts.material = material;
        return {
            id: product.id,
            shopId: SHOP,
            name: product.name,
            nameBn: product.name_bn || null,
            facts,
            imageUrl: null,
        };
    });
    return evidence;
};

describe('product evidence trust boundaries', () => {
    test.each(['W32 hobe?', 'সাইজ ৪৪'])('recognizes waist and Bengali numeric size follow-ups: %s', message => {
        expect(grounding.askedAttributes(message)).toContain('size');
        expect(grounding.isAttributeOnlyQuery(message)).toBe(true);
    });

    test('Bengali greetings and merchant honorifics do not become product identity claims', () => {
        const evidence = grounding.resolveProductEvidence({
            shopId: SHOP,
            message: 'আসসালামু আলাইকুম। কালো পাঞ্জাবি আছে আপনাদের?',
            candidates: [catalogProduct({
                name: 'Premium Black Panjabi',
                name_bn: 'প্রিমিয়াম কালো পাঞ্জাবি',
                category: 'panjabi',
                aliases: ['black panjabi'],
                ai_color: 'black',
                quantity: 3,
                track_quantity: true,
            })],
        });

        expect(evidence.productStatus).toBe(grounding.ProductEvidenceStatus.VERIFIED);
        expect(evidence.unmatchedTerms).toEqual([]);
        expect(evidence.askedAttributes).toContain('stock');
    });

    test('a candidate explicitly owned by a different shop cannot verify here', () => {
        const evidence = grounding.resolveProductEvidence({
            shopId: SHOP,
            message: 'Classic Blue Denim Jacket price?',
            candidates: [catalogProduct({ shop_id: OTHER_SHOP })],
        });

        expect(evidence.productStatus).toBe(grounding.ProductEvidenceStatus.NOT_FOUND);
        expect(evidence.verifiedProducts).toEqual([]);
    });

    test('a candidate without an explicit tenant owner cannot verify', () => {
        const evidence = grounding.resolveProductEvidence({
            shopId: SHOP,
            message: 'Classic Blue Denim Jacket price?',
            candidates: [catalogProduct({ shop_id: null })],
        });

        expect(evidence.productStatus).toBe(grounding.ProductEvidenceStatus.NOT_FOUND);
        expect(evidence.verifiedProducts).toEqual([]);
    });

    test('an unknown fabric claim is rejected when the material term also appears in the product name', () => {
        const evidence = grounding.resolveProductEvidence({
            shopId: SHOP,
            message: 'chiffon kurti ache?',
            candidates: [catalogProduct({
                name: 'Chiffon Kurti',
                category: 'kurti',
                price: 1390,
                ai_material: null,
            })],
        });
        const verdict = evaluateCandidate({
            candidate: 'Chiffon Kurti — ৳1390. Eta pure chiffon fabric.',
            evidence,
            language: 'mixed',
        });

        expect(evidence.askedAttributes).not.toContain('material');
        expect(verdict.decision).toBe(grounding.GroundingDecision.SAFE_FALLBACK);
        expect(verdict.reasonCode).toBe(grounding.ReasonCode.PRODUCT_ATTRIBUTE_UNKNOWN);
        expect(verdict.text).toMatch(/material|fabric/i);
        expect(verdict.text).not.toMatch(/pure chiffon fabric/i);
    });

    test('a product name containing an unrecorded material term is not rejected by itself', () => {
        const evidence = grounding.resolveProductEvidence({
            shopId: SHOP,
            message: 'chiffon kurti ache?',
            candidates: [catalogProduct({
                name: 'Chiffon Kurti',
                category: 'kurti',
                price: 1390,
                ai_material: null,
            })],
        });
        const verdict = evaluateCandidate({
            candidate: 'Chiffon Kurti ache — ৳1390.',
            evidence,
            language: 'mixed',
        });

        expect(verdict.decision).toBe(grounding.GroundingDecision.SEND);
        expect(verdict.text).toBe('Chiffon Kurti ache — ৳1390.');
    });

    test('a different product title cannot authorize an unknown material claim', () => {
        const unknown = catalogProduct({ id: 'unknown', name: 'Blue Kurti', ai_material: null });
        const knownTitle = catalogProduct({ id: 'known-title', name: 'Pure Chiffon Fabric' });
        const evidence = evidenceForProducts([
            { product: unknown },
            { product: knownTitle, material: { state: grounding.FactState.KNOWN, value: 'cotton' } },
        ]);
        const verdict = evaluateCandidate({
            candidate: 'Blue Kurti is Pure Chiffon Fabric.',
            evidence,
            language: 'en',
            modelGenerated: true,
        });

        expect(verdict.decision).toBe(grounding.GroundingDecision.SAFE_FALLBACK);
        expect(verdict.reasonCode).toBe(grounding.ReasonCode.PRODUCT_ATTRIBUTE_UNKNOWN);
    });

    test('a known material claim about its named product is not blocked by another unknown product', () => {
        const unknown = catalogProduct({ id: 'unknown', name: 'Blue Kurti', ai_material: null });
        const known = catalogProduct({ id: 'known', name: 'Cotton Shirt' });
        const evidence = evidenceForProducts([
            { product: unknown },
            { product: known, material: { state: grounding.FactState.KNOWN, value: 'cotton' } },
        ]);
        const verdict = evaluateCandidate({
            candidate: 'Cotton Shirt is cotton.',
            evidence,
            language: 'en',
            modelGenerated: true,
        });

        expect(verdict.decision).toBe(grounding.GroundingDecision.SEND);
    });

    test('a known first product does not authorize an unknown material claim about a later product', () => {
        const known = catalogProduct({ id: 'known', name: 'Cotton Shirt' });
        const unknown = catalogProduct({ id: 'unknown', name: 'Blue Kurti', ai_material: null });
        const evidence = evidenceForProducts([
            { product: known, material: { state: grounding.FactState.KNOWN, value: 'cotton' } },
            { product: unknown },
        ]);
        const verdict = evaluateCandidate({
            candidate: 'Cotton Shirt is listed alongside Blue Kurti made of pure chiffon.',
            evidence,
            language: 'en',
            modelGenerated: true,
        });

        expect(verdict.decision).toBe(grounding.GroundingDecision.SAFE_FALLBACK);
        expect(verdict.reasonCode).toBe(grounding.ReasonCode.PRODUCT_ATTRIBUTE_UNKNOWN);
    });

    test('a material modifier immediately before a later unknown product stays bound to that product', () => {
        const known = catalogProduct({ id: 'known', name: 'Cotton Shirt' });
        const unknown = catalogProduct({ id: 'unknown', name: 'Blue Kurti', ai_material: null });
        const evidence = evidenceForProducts([
            { product: known, material: { state: grounding.FactState.KNOWN, value: 'cotton' } },
            { product: unknown },
        ]);
        const verdict = evaluateCandidate({
            candidate: 'Cotton Shirt is listed alongside our pure chiffon Blue Kurti.',
            evidence,
            language: 'en',
            modelGenerated: true,
        });

        expect(verdict.decision).toBe(grounding.GroundingDecision.SAFE_FALLBACK);
        expect(verdict.reasonCode).toBe(grounding.ReasonCode.PRODUCT_ATTRIBUTE_UNKNOWN);
    });

    test('an unsupported material modifier cannot hide inside the leading word of an unknown product title', () => {
        const unknown = catalogProduct({ id: 'unknown', name: 'Chiffon Kurti', ai_material: null });
        const evidence = evidenceForProducts([{ product: unknown }]);
        const verdict = evaluateCandidate({
            candidate: 'Pure Chiffon Kurti.',
            evidence,
            language: 'en',
            modelGenerated: true,
        });

        expect(verdict.decision).toBe(grounding.GroundingDecision.SAFE_FALLBACK);
        expect(verdict.reasonCode).toBe(grounding.ReasonCode.PRODUCT_ATTRIBUTE_UNKNOWN);
    });

    test('a known product assertion cannot hide an unsupported modifier split across the next product title', () => {
        const known = catalogProduct({ id: 'known', name: 'Cotton Shirt' });
        const unknown = catalogProduct({ id: 'unknown', name: 'Chiffon Kurti', ai_material: null });
        const evidence = evidenceForProducts([
            { product: known, material: { state: grounding.FactState.KNOWN, value: 'cotton' } },
            { product: unknown },
        ]);
        const verdict = evaluateCandidate({
            candidate: 'Cotton Shirt is made of cotton and Pure Chiffon Kurti.',
            evidence,
            language: 'en',
            modelGenerated: true,
        });

        expect(verdict.decision).toBe(grounding.GroundingDecision.SAFE_FALLBACK);
        expect(verdict.reasonCode).toBe(grounding.ReasonCode.PRODUCT_ATTRIBUTE_UNKNOWN);
    });

    test.each([
        ['khanti', 'খাঁটি'],
        ['bishuddho', 'বিশুদ্ধ'],
        ['shatobhag', 'শতভাগ'],
        ['Bengali digits 100 percent', '১০০%'],
    ])('an unsupported Bengali material modifier cannot hide in an unknown title (%s)', (_label, modifier) => {
        const unknown = catalogProduct({ id: 'unknown', name: 'শিফন কুর্তি', ai_material: null });
        const evidence = evidenceForProducts([{ product: unknown }]);
        const verdict = evaluateCandidate({
            candidate: `${modifier} শিফন কুর্তি।`,
            evidence,
            language: 'bn',
            modelGenerated: true,
        });

        expect(verdict.decision).toBe(grounding.GroundingDecision.SAFE_FALLBACK);
        expect(verdict.reasonCode).toBe(grounding.ReasonCode.PRODUCT_ATTRIBUTE_UNKNOWN);
    });

    test('a Bengali material word in an unknown product title alone remains allowed', () => {
        const unknown = catalogProduct({ id: 'unknown', name: 'শিফন কুর্তি', ai_material: null });
        const evidence = evidenceForProducts([{ product: unknown }]);
        const verdict = evaluateCandidate({
            candidate: 'শিফন কুর্তি আছে।',
            evidence,
            language: 'bn',
            modelGenerated: true,
        });

        expect(verdict.decision).toBe(grounding.GroundingDecision.SEND);
    });

    test('a supported material assertion does not transfer into a Bengali material title', () => {
        const known = catalogProduct({ id: 'known', name: 'Cotton Shirt' });
        const unknown = catalogProduct({ id: 'unknown', name: 'শিফন কুর্তি', ai_material: null });
        const evidence = evidenceForProducts([
            { product: known, material: { state: grounding.FactState.KNOWN, value: 'cotton' } },
            { product: unknown },
        ]);
        const verdict = evaluateCandidate({
            candidate: 'Cotton Shirt is made of cotton and শিফন কুর্তি।',
            evidence,
            language: 'mixed',
            modelGenerated: true,
        });

        expect(verdict.decision).toBe(grounding.GroundingDecision.SEND);
    });

    test('a Bengali material modifier before a generic unknown title remains blocked', () => {
        const known = catalogProduct({ id: 'known', name: 'Cotton Shirt' });
        const unknown = catalogProduct({ id: 'unknown', name: 'Blue Kurti', ai_material: null });
        const evidence = evidenceForProducts([
            { product: known, material: { state: grounding.FactState.KNOWN, value: 'cotton' } },
            { product: unknown },
        ]);
        const verdict = evaluateCandidate({
            candidate: 'Cotton Shirt is listed alongside our খাঁটি শিফন Blue Kurti.',
            evidence,
            language: 'mixed',
            modelGenerated: true,
        });

        expect(verdict.decision).toBe(grounding.GroundingDecision.SAFE_FALLBACK);
        expect(verdict.reasonCode).toBe(grounding.ReasonCode.PRODUCT_ATTRIBUTE_UNKNOWN);
    });

    test('a supported material assertion before a later product name stays with the first product', () => {
        const known = catalogProduct({ id: 'known', name: 'Cotton Shirt' });
        const unknown = catalogProduct({ id: 'unknown', name: 'Blue Kurti', ai_material: null });
        const evidence = evidenceForProducts([
            { product: known, material: { state: grounding.FactState.KNOWN, value: 'cotton' } },
            { product: unknown },
        ]);
        const verdict = evaluateCandidate({
            candidate: 'Cotton Shirt is made of cotton whereas Blue Kurti has no recorded material.',
            evidence,
            language: 'en',
            modelGenerated: true,
        });

        expect(verdict.decision).toBe(grounding.GroundingDecision.SEND);
    });

    test('a completed material assertion ending with a product relation does not transfer to the next product', () => {
        const known = catalogProduct({ id: 'known', name: 'Cotton Shirt' });
        const unknown = catalogProduct({ id: 'unknown', name: 'Blue Kurti', ai_material: null });
        const evidence = evidenceForProducts([
            { product: known, material: { state: grounding.FactState.KNOWN, value: 'cotton' } },
            { product: unknown },
        ]);
        const verdict = evaluateCandidate({
            candidate: 'Cotton Shirt is made of cotton next to Blue Kurti.',
            evidence,
            language: 'en',
            modelGenerated: true,
        });

        expect(verdict.decision).toBe(grounding.GroundingDecision.SEND);
    });

    test('another product title containing a material word alone is not an unsupported material assertion', () => {
        const known = catalogProduct({ id: 'known', name: 'Cotton Shirt' });
        const unknown = catalogProduct({ id: 'unknown', name: 'Chiffon Kurti', ai_material: null });
        const evidence = evidenceForProducts([
            { product: known, material: { state: grounding.FactState.KNOWN, value: 'cotton' } },
            { product: unknown },
        ]);
        const verdict = evaluateCandidate({
            candidate: 'Cotton Shirt is listed alongside Chiffon Kurti.',
            evidence,
            language: 'en',
            modelGenerated: true,
        });

        expect(verdict.decision).toBe(grounding.GroundingDecision.SEND);
    });

    test('a duplicate product title remains unknown when one matching row has no material fact', () => {
        const known = catalogProduct({ id: 'known', name: 'Blue Kurti' });
        const unknown = catalogProduct({ id: 'unknown', name: 'Blue Kurti', ai_material: null });
        const evidence = evidenceForProducts([
            { product: known, material: { state: grounding.FactState.KNOWN, value: 'cotton' } },
            { product: unknown },
        ]);
        const verdict = evaluateCandidate({
            candidate: 'Blue Kurti is chiffon.',
            evidence,
            language: 'en',
            modelGenerated: true,
        });

        expect(verdict.decision).toBe(grounding.GroundingDecision.SAFE_FALLBACK);
        expect(verdict.reasonCode).toBe(grounding.ReasonCode.PRODUCT_ATTRIBUTE_UNKNOWN);
    });

    test.each([
        ['short title first', ['Kurti', 'Chiffon Kurti']],
        ['long title first', ['Chiffon Kurti', 'Kurti']],
    ])('longest exact product title is preserved when %s in evidence', (_order, names) => {
        const products = names.map((name, index) => ({
            product: catalogProduct({
                id: `overlap-${index}`,
                name,
                ai_material: null,
            }),
            ...(name === 'Chiffon Kurti'
                ? { material: { state: grounding.FactState.KNOWN, value: 'cotton' } }
                : {}),
        }));
        const evidence = evidenceForProducts(products);
        const verdict = evaluateCandidate({
            candidate: 'Chiffon Kurti is available.',
            evidence,
            language: 'en',
            modelGenerated: true,
        });

        expect(verdict.decision).toBe(grounding.GroundingDecision.SEND);
    });

    test('context product rows are filtered by explicit tenant owner', () => {
        const evidence = grounding.resolveContextualAttributeEvidence({
            shopId: SHOP,
            message: 'cotton?',
            contextProducts: [catalogProduct({ shop_id: OTHER_SHOP })],
        });

        expect(evidence.productStatus).toBe(grounding.ProductEvidenceStatus.NONE);
        expect(evidence.verifiedProducts).toEqual([]);
    });

    test('merchant-provided aliases resolve a supported spelling without fuzzy inference', () => {
        const evidence = grounding.resolveProductEvidence({
            shopId: SHOP,
            message: 'Premium Black Punjabi price?',
            candidates: [catalogProduct({
                name: 'Premium Black Panjabi',
                aliases: ['Punjabi'],
            })],
        });

        expect(evidence.productStatus).toBe(grounding.ProductEvidenceStatus.VERIFIED);
        expect(evidence.verifiedProducts[0].name).toBe('Premium Black Panjabi');
    });

    test('AI-derived material and color stay uncertain rather than merchant facts', () => {
        const facts = grounding.buildFacts(catalogProduct());

        expect(facts.material.state).toBe(grounding.FactState.UNCERTAIN);
        expect(facts.color.state).toBe(grounding.FactState.UNCERTAIN);
    });

    test('size is represented under the attribute key consumed by grounding', () => {
        const facts = grounding.buildFacts(catalogProduct());

        expect(facts.size.state).toBe(grounding.FactState.UNKNOWN);
        expect(facts.size.value).toBeNull();
    });

    test('variant price is accepted only for the explicitly named option', () => {
        const evidence = grounding.resolveProductEvidence({
            shopId: SHOP,
            message: 'Classic Blue Denim Jacket XL size price?',
            candidates: [catalogProduct({
                variants: [{ id: 'variant-xl', option_name: 'Size', option_value: 'XL', price: 3300, quantity: 2, is_active: true }],
            })],
        });

        const namedOption = evaluateCandidate({
            candidate: 'Classic Blue Denim Jacket XL size is 3300 taka.',
            evidence,
            language: 'en',
        });
        const mismatchedOption = evaluateCandidate({
            candidate: 'Classic Blue Denim Jacket L size is 3300 taka.',
            evidence,
            language: 'en',
        });

        expect(namedOption.decision).toBe(grounding.GroundingDecision.SEND);
        expect(mismatchedOption.decision).toBe(grounding.GroundingDecision.SAFE_FALLBACK);
        expect(mismatchedOption.reasonCode).toBe(grounding.ReasonCode.UNSUPPORTED_PRICE_CLAIM);
    });

    test('XXL size labels are not mistaken for foreign currency codes', () => {
        const evidence = grounding.resolveProductEvidence({
            shopId: SHOP,
            message: 'Classic Blue Denim Jacket XXL size price?',
            candidates: [catalogProduct({
                variants: [{ id: 'variant-xxl', option_name: 'Size', option_value: 'XXL', price: 3300, quantity: 2, is_active: true }],
            })],
        });

        expect(evaluateCandidate({
            candidate: 'Classic Blue Denim Jacket size XXL 3,300 taka.', evidence, language: 'en',
        }).decision).toBe(grounding.GroundingDecision.SEND);
    });

    test('unequal variant prices require an explicitly named variant for the price claim', () => {
        const evidence = grounding.resolveProductEvidence({
            shopId: SHOP,
            message: 'Classic Blue Denim Jacket price?',
            candidates: [catalogProduct({
                variants: [
                    { id: 'variant-m', option_name: 'Size', option_value: 'M', price: 3200, quantity: 2, is_active: true },
                    { id: 'variant-xl', option_name: 'Size', option_value: 'XL', price: 3300, quantity: 1, is_active: true },
                ],
            })],
        });

        const unscoped = evaluateCandidate({ candidate: '3,200 taka', evidence, language: 'en' });
        const selected = evaluateCandidate({ candidate: 'XL size costs ৳3,300.', evidence, language: 'en' });
        const mismatched = evaluateCandidate({ candidate: 'XL size costs ৳3,200.', evidence, language: 'en' });

        expect(unscoped.decision).toBe(grounding.GroundingDecision.SAFE_FALLBACK);
        expect(selected.decision).toBe(grounding.GroundingDecision.SEND);
        expect(mismatched.decision).toBe(grounding.GroundingDecision.SAFE_FALLBACK);
    });

    test('a generic product-name price claim remains valid when its price is unambiguous', () => {
        const evidence = grounding.resolveProductEvidence({
            shopId: SHOP,
            message: 'Classic Blue Denim Jacket price?',
            candidates: [catalogProduct()],
        });

        expect(evaluateCandidate({
            candidate: 'The jacket costs ৳3,200.', evidence, language: 'en',
        }).decision).toBe(grounding.GroundingDecision.SEND);
        expect(evaluateCandidate({
            candidate: 'The jacket costs 3,200 BDT.', evidence, language: 'en',
        }).decision).toBe(grounding.GroundingDecision.SEND);
    });

    test('a missing parent and variant price stays unknown instead of becoming zero', () => {
        const facts = grounding.buildFacts(catalogProduct({
            price: null,
            variants: [{ id: 'variant-32', option_name: 'Size', option_value: '32', price: null, quantity: 1, is_active: true }],
        }));

        expect(facts.price).toEqual({ state: grounding.FactState.UNKNOWN, value: null });
        expect(facts.variants[0].price).toEqual({ state: grounding.FactState.UNKNOWN, value: null });
    });

    test('a delivery fee cannot authorize a different product price', () => {
        const evidence = grounding.resolveProductEvidence({
            shopId: SHOP,
            message: 'Classic Blue Denim Jacket price?',
            candidates: [catalogProduct()],
        });
        grounding.withPolicyText(evidence, 'Delivery charge inside Dhaka is 60 taka.');

        const verdict = evaluateCandidate({
            candidate: 'Classic Blue Denim Jacket er price 60 taka.',
            evidence,
            language: 'mixed',
        });

        expect(verdict.decision).toBe(grounding.GroundingDecision.SAFE_FALLBACK);
        expect(verdict.reasonCode).toBe(grounding.ReasonCode.UNSUPPORTED_PRICE_CLAIM);
    });

    test('a nearby delivery fee cannot authorize a same-valued jacket price', () => {
        const evidence = grounding.resolveProductEvidence({
            shopId: SHOP,
            message: 'Classic Blue Denim Jacket price?',
            candidates: [catalogProduct()],
        });
        grounding.withPolicyText(evidence, 'Delivery charge is 60 taka.');

        const verdict = evaluateCandidate({
            candidate: 'Classic Blue Denim Jacket price 60 taka, delivery charge 60 taka.',
            evidence,
            language: 'en',
        });

        expect(verdict.decision).toBe(grounding.GroundingDecision.SAFE_FALLBACK);
        expect(verdict.reasonCode).toBe(grounding.ReasonCode.UNSUPPORTED_PRICE_CLAIM);
    });

    test('a separately labeled policy fee stays valid after a verified product price', () => {
        const evidence = grounding.resolveProductEvidence({
            shopId: SHOP,
            message: 'Classic Blue Denim Jacket price?',
            candidates: [catalogProduct()],
        });
        grounding.withPolicyText(evidence, 'Delivery fee is ৳60.');

        for (const candidate of [
            'Classic Blue Denim Jacket price is ৳3,200 + ৳60 delivery fee.',
            'Classic Blue Denim Jacket costs ৳3,200 plus ৳60 delivery fee.',
            'Classic Blue Denim Jacket price is ৳3,200 and ৳60 delivery fee.',
        ]) {
            expect(evaluateCandidate({ candidate, evidence, language: 'en' }).decision)
                .toBe(grounding.GroundingDecision.SEND);
        }
    });

    test('delivery fee in the same sentence cannot become a product price', () => {
        const evidence = grounding.resolveProductEvidence({
            shopId: SHOP,
            message: 'Classic Blue Denim Jacket price?',
            candidates: [catalogProduct()],
        });
        grounding.withPolicyText(evidence, 'Delivery fee is ৳60.');

        const verdict = evaluateCandidate({
            candidate: 'Classic Blue Denim Jacket price is ৳60 including delivery.',
            evidence,
            language: 'en',
        });

        expect(verdict.decision).toBe(grounding.GroundingDecision.SAFE_FALLBACK);
        expect(verdict.reasonCode).toBe(grounding.ReasonCode.UNSUPPORTED_PRICE_CLAIM);
    });

    test('a delivery-fee label cannot reclassify a nearby product price or cost', () => {
        const evidence = grounding.resolveProductEvidence({
            shopId: SHOP,
            message: 'Classic Blue Denim Jacket price?',
            candidates: [catalogProduct()],
        });
        grounding.withPolicyText(evidence, 'Delivery fee is ৳60.');

        for (const candidate of [
            'Classic Blue Denim Jacket price with delivery cost is ৳60.',
            'Jacket price after delivery fee is ৳60.',
            'Classic Blue Denim Jacket costs ৳60 with delivery fee.',
            'Classic Blue Denim Jacket is only ৳60 with delivery fee.',
            'Jacket is ৳60 including delivery fee.',
            'Red Handbag is only ৳60 with delivery fee.',
            'The jacket will be ৳60 with delivery fee.',
            'Jacket will be on sale for ৳60 with delivery fee.',
            'Jacket is on sale for ৳60 with delivery fee.',
            'Classic Blue Denim Jacket selling for ৳60 with delivery fee.',
            'Classic Blue Denim Jacket listed for ৳60 with delivery fee.',
            'Classic Blue Denim Jacket is priced at ৳60 with delivery fee.',
            'Jacket ৳60 with delivery fee.',
            'Classic Blue Denim Jacket: ৳60 (delivery fee extra).',
            'Classic Blue Denim Jacket — ৳60 + delivery fee.',
            'Jacket: 60 taka delivery fee included.',
            'Jacket. 60 with delivery fee.',
            'The jacket. It is 60 with delivery fee.',
        ]) {
            const verdict = evaluateCandidate({ candidate, evidence, language: 'en' });
            expect({ candidate, decision: verdict.decision }).toEqual({
                candidate,
                decision: grounding.GroundingDecision.SAFE_FALLBACK,
            });
            expect(verdict.reasonCode).toBe(grounding.ReasonCode.UNSUPPORTED_PRICE_CLAIM);
        }
    });

    test('an amount that is equally valid as product price and fee needs explicit separation', () => {
        const evidence = grounding.resolveProductEvidence({
            shopId: SHOP,
            message: 'Classic Blue Denim Jacket price?',
            candidates: [catalogProduct({ price: 60 })],
        });
        grounding.withPolicyText(evidence, 'Delivery fee is ৳60.');

        for (const candidate of [
            'Jacket. 60 with delivery fee.',
            'The jacket. It is 60 with delivery fee.',
        ]) {
            const verdict = evaluateCandidate({ candidate, evidence, language: 'en' });
            expect(verdict.decision).toBe(grounding.GroundingDecision.SAFE_FALLBACK);
            expect(verdict.reasonCode).toBe(grounding.ReasonCode.UNSUPPORTED_PRICE_CLAIM);
        }
    });

    test('product price and stock claims stay bound to the verified product identity', () => {
        const evidence = grounding.resolveProductEvidence({
            shopId: SHOP,
            message: 'Classic Blue Denim Jacket price?',
            candidates: [catalogProduct()],
        });

        for (const candidate of [
            'The Red Handbag costs ৳3,200.',
            'The Red Handbag is available in stock.',
        ]) {
            const verdict = evaluateCandidate({ candidate, evidence, language: 'en' });
            expect(verdict.decision).toBe(grounding.GroundingDecision.SAFE_FALLBACK);
        }

        expect(evaluateCandidate({
            candidate: '৳3,200', evidence, language: 'en',
        }).decision).toBe(grounding.GroundingDecision.SEND);
    });

    test.each([
        'Olive Cargo Pant is available in size 32.',
        'Olive Cargo Pant is currently out of stock in all available sizes (30, 32, 34, and 36).',
    ])('blocks an availability claim when the named catalog product is only a partial match: %s', candidate => {
        const evidence = grounding.resolveProductEvidence({
            shopId: SHOP,
            message: 'Can I wear this cargo pant in a smart-casual office setup? What is the cut?',
            candidates: [catalogProduct({
                id: 'v12-b-cargo',
                name: 'Olive Cargo Pant',
                category: 'trousers',
                ai_color: 'olive',
                track_quantity: true,
                quantity: 0,
            })],
        });

        expect(evidence.productStatus).toBe(grounding.ProductEvidenceStatus.NOT_FOUND);
        expect(evidence.verifiedProducts).toEqual([]);
        expect(evidence.relatedProducts.map(product => product.id)).toContain('v12-b-cargo');

        const verdict = evaluateCandidate({ candidate, evidence, language: 'en' });
        expect(verdict.decision).toBe(grounding.GroundingDecision.SAFE_FALLBACK);
        expect(verdict.reasonCode).toBe(grounding.ReasonCode.PRODUCT_NOT_FOUND);
        expect(verdict.text).not.toMatch(/available in size|out of stock/i);
    });

    test.each([
        'We do have Olive Cargo Pant.',
        'What we do have is Olive Cargo Pant.',
        'We have Olive Cargo Pant.',
        'We do have a black cargo pant.',
    ])('blocks a bare positive related-product claim when only a partial match exists: %s', candidate => {
        const evidence = grounding.resolveProductEvidence({
            shopId: SHOP,
            message: 'Can I wear this cargo pant in a smart-casual office setup? What is the cut?',
            candidates: [catalogProduct({
                id: 'v12-b-cargo',
                name: 'Olive Cargo Pant',
                category: 'trousers',
                ai_color: 'olive',
                track_quantity: true,
                quantity: 0,
            })],
        });

        expect(evidence.productStatus).toBe(grounding.ProductEvidenceStatus.NOT_FOUND);
        const verdict = evaluateCandidate({ candidate, evidence, language: 'en', modelGenerated: true });
        expect(verdict.decision).toBe(grounding.GroundingDecision.SAFE_FALLBACK);
        expect(verdict.reasonCode).toBe(grounding.ReasonCode.PRODUCT_NOT_FOUND);
    });

    test('a bare amount is ambiguous when multiple verified products are present', () => {
        const evidence = grounding.resolveProductEvidence({
            shopId: SHOP,
            message: 'denim jacket price?',
            candidates: [
                catalogProduct({ price: 3200 }),
                catalogProduct({ id: 'product-2', name: 'Premium Blue Denim Jacket', price: 3200 }),
            ],
        });

        const verdict = evaluateCandidate({ candidate: '৳3,200', evidence, language: 'en' });
        expect(verdict.decision).toBe(grounding.GroundingDecision.SAFE_FALLBACK);
    });

    test('a price from another verified product cannot be attributed to this one', () => {
        const jacket = catalogProduct();
        const panjabi = catalogProduct({
            id: 'product-2',
            name: 'Premium Black Panjabi',
            category: 'panjabi',
            price: 2500,
            variants: [],
        });
        const evidence = grounding.emptyEvidence(SHOP);
        evidence.productStatus = grounding.ProductEvidenceStatus.VERIFIED;
        evidence.verifiedProducts = [jacket, panjabi].map(product => ({
            id: product.id,
            shopId: SHOP,
            name: product.name,
            facts: grounding.buildFacts(product),
            imageUrl: null,
        }));

        const verdict = evaluateCandidate({
            candidate: 'Premium Black Panjabi er dam 3200 taka.',
            evidence,
            language: 'mixed',
        });

        expect(verdict.decision).toBe(grounding.GroundingDecision.SAFE_FALLBACK);
        expect(verdict.reasonCode).toBe(grounding.ReasonCode.UNSUPPORTED_PRICE_CLAIM);
    });

    test('a size is not claimed available when its active variant has no stock', () => {
        const evidence = grounding.resolveProductEvidence({
            shopId: SHOP,
            message: 'Classic Blue Denim Jacket size XL available?',
            candidates: [catalogProduct({
                variants: [{ id: 'variant-xl', option_name: 'Size', option_value: 'XL', price: null, quantity: 0, is_active: true }],
            })],
        });

        const verdict = evaluateCandidate({
            candidate: 'XL size available ache.',
            evidence,
            language: 'mixed',
        });

        expect(verdict.decision).toBe(grounding.GroundingDecision.SAFE_FALLBACK);
        expect(verdict.reasonCode).toBe(grounding.ReasonCode.PRODUCT_ATTRIBUTE_UNKNOWN);
    });

    test('a supported delivery assertion does not hide an unavailable variant claim', () => {
        const evidence = grounding.resolveProductEvidence({
            shopId: SHOP,
            message: 'Classic Blue Denim Jacket size XL available?',
            candidates: [catalogProduct({
                variants: [{ id: 'variant-xl', option_name: 'Size', option_value: 'XL', price: null, quantity: 0, is_active: true }],
            })],
        });
        grounding.withPolicyText(evidence, 'Delivery: available nationwide across Bangladesh.');

        const verdict = evaluateCandidate({
            candidate: 'XL size available (delivery options are available).',
            evidence,
            language: 'mixed',
        });

        expect(verdict.decision).toBe(grounding.GroundingDecision.SAFE_FALLBACK);
        expect(verdict.reasonCode).toBe(grounding.ReasonCode.PRODUCT_ATTRIBUTE_UNKNOWN);
    });

    test('a truthful product-level not-available reply is accepted', () => {
        const evidence = grounding.resolveProductEvidence({
            shopId: SHOP,
            message: 'Classic Blue Denim Jacket available?',
            candidates: [catalogProduct({ in_stock: false })],
        });
        const verdict = evaluateCandidate({
            candidate: 'Classic Blue Denim Jacket is not available.',
            evidence,
            language: 'en',
            modelGenerated: true,
        });

        expect(verdict.decision).toBe(grounding.GroundingDecision.SEND);
    });

    test('delivery availability is not treated as product stock', () => {
        const evidence = grounding.resolveProductEvidence({
            shopId: SHOP,
            message: 'Classic Blue Denim Jacket available?',
            candidates: [catalogProduct({ in_stock: false })],
        });
        grounding.withPolicyText(evidence, 'Delivery is available nationwide across Bangladesh.');
        const verdict = evaluateCandidate({
            candidate: 'Delivery is available nationwide across Bangladesh.',
            evidence,
            language: 'en',
            modelGenerated: true,
        });

        expect(verdict.decision).toBe(grounding.GroundingDecision.SEND);
    });

    test('a mixed product and delivery information denial is not exempted as delivery-only', () => {
        const evidence = grounding.resolveProductEvidence({
            shopId: SHOP,
            message: 'chiffon saree ache?',
            candidates: [],
        });
        grounding.withPolicyText(evidence, 'Delivery is available nationwide across Bangladesh for all products.');

        const mixed = evaluateCandidate({
            candidate: 'বর্তমানে কোনো পণ্য বা ডেলিভারির তথ্য নেই।',
            evidence,
            language: 'bn',
            modelGenerated: true,
        });
        expect(mixed.decision).toBe(grounding.GroundingDecision.SAFE_FALLBACK);
        expect(mixed.reasonCode).toBe(grounding.ReasonCode.PRODUCT_NOT_FOUND);

        const deliveryOnly = evaluateCandidate({
            candidate: 'Delivery is available nationwide across Bangladesh for all products.',
            evidence,
            language: 'en',
            modelGenerated: true,
        });
        expect(deliveryOnly.decision).toBe(grounding.GroundingDecision.SEND);
    });

    test.each([
        'There are no products, and delivery is available nationwide.',
        'We do not have any products, but delivery is available nationwide.',
        'We do not have this product, but delivery is available nationwide.',
        'Our catalog is empty, but delivery is available nationwide.',
        'ক্যাটালগে কোনো পণ্য নেই, তবে সারাদেশে ডেলিভারি আছে।',
        'আমাদের কোনো পণ্য নেই, তবে সারাদেশে ডেলিভারি আছে।',
    ])('rejects a store-wide catalog absence claim when product evidence is NOT_FOUND: %s', candidate => {
        const evidence = grounding.resolveProductEvidence({
            shopId: SHOP,
            message: 'chiffon saree ache?',
            candidates: [],
        });
        grounding.withPolicyText(evidence,
            'Delivery is available nationwide. Delivery is available nationwide for all products.');

        const verdict = evaluateCandidate({ candidate, evidence, language: 'mixed', modelGenerated: true });
        expect(verdict.decision).toBe(grounding.GroundingDecision.SAFE_FALLBACK);
        expect(verdict.reasonCode).toBe(grounding.ReasonCode.PRODUCT_NOT_FOUND);
    });

    test.each([
        'We could not find that item, but delivery is available nationwide.',
        'Delivery is available nationwide for all products.',
    ])('preserves a specific not-found statement or supported delivery policy: %s', candidate => {
        const evidence = grounding.resolveProductEvidence({
            shopId: SHOP,
            message: 'chiffon saree ache?',
            candidates: [],
        });
        grounding.withPolicyText(evidence,
            'Delivery is available nationwide. Delivery is available nationwide for all products.');

        const verdict = evaluateCandidate({ candidate, evidence, language: 'mixed', modelGenerated: true });
        expect(verdict.decision).toBe(grounding.GroundingDecision.SEND);
    });

    test.each(['while', 'whereas', 'although', 'though', 'তবে', 'যদিও'])(
        'supported delivery availability cannot mask an unsupported stock claim joined by %s', connector => {
        const evidence = grounding.resolveProductEvidence({
            shopId: SHOP,
            message: 'Can I wear this cargo pant in a smart-casual office setup? What is the cut?',
            candidates: [catalogProduct({
                id: 'v12-b-cargo', name: 'Olive Cargo Pant', category: 'trousers', ai_color: 'olive',
            })],
        });
        grounding.withPolicyText(evidence, 'Delivery is available nationwide across Bangladesh.');
        const verdict = evaluateCandidate({
            candidate: `Delivery is available nationwide across Bangladesh ${connector} Olive Cargo Pant is out of stock in all sizes.`,
            evidence,
            language: 'en',
            modelGenerated: true,
        });

        expect(verdict.decision).toBe(grounding.GroundingDecision.SAFE_FALLBACK);
        expect(verdict.reasonCode).toBe(grounding.ReasonCode.PRODUCT_NOT_FOUND);
        expect(verdict.text).not.toMatch(/Olive Cargo Pant is out of stock/i);
    });

    test('mixed exact variant states validate independently within one reply', () => {
        const evidence = grounding.resolveProductEvidence({
            shopId: SHOP,
            message: 'Classic Blue Denim Jacket size M and XL available?',
            candidates: [catalogProduct({
                variants: [
                    { id: 'variant-m', option_name: 'Size', option_value: 'M', quantity: 1, is_active: true },
                    { id: 'variant-xl', option_name: 'Size', option_value: 'XL', quantity: 0, is_active: true },
                ],
            })],
        });
        const verdict = evaluateCandidate({
            candidate: 'M is available, but XL is unavailable.',
            evidence,
            language: 'en',
            modelGenerated: true,
        });

        expect(verdict.decision).toBe(grounding.GroundingDecision.SEND);
    });

    test('unknown arbitrary size values are not treated as product-level availability', () => {
        const evidence = grounding.resolveProductEvidence({
            shopId: SHOP,
            message: 'Classic Blue Denim Jacket size 42 available?',
            candidates: [catalogProduct({
                variants: [{ id: 'variant-xl', option_name: 'Size', option_value: 'XL', quantity: 1, is_active: true }],
            })],
        });
        const verdict = evaluateCandidate({
            candidate: 'Size 42 is available.',
            evidence,
            language: 'en',
            modelGenerated: true,
        });

        expect(verdict.decision).toBe(grounding.GroundingDecision.SAFE_FALLBACK);
        expect(verdict.reasonCode).toBe(grounding.ReasonCode.PRODUCT_ATTRIBUTE_UNKNOWN);
    });

    test('an unrelated unknown fact does not excuse an unsupported delivery timeline', () => {
        const evidence = grounding.resolveProductEvidence({
            shopId: SHOP,
            message: 'Classic Blue Denim Jacket price?',
            candidates: [catalogProduct()],
        });
        const verdict = evaluateCandidate({
            candidate: 'We will deliver tomorrow, but the material is unknown.',
            evidence,
            language: 'en',
            modelGenerated: true,
        });

        expect(verdict.decision).toBe(grounding.GroundingDecision.SAFE_FALLBACK);
        expect(verdict.reasonCode).toBe(grounding.ReasonCode.UNSUPPORTED_DOMAIN_CLAIM);
    });

    test('another tenant upload URL cannot be presented as this product media', () => {
        const evidence = grounding.resolveProductEvidence({
            shopId: SHOP,
            message: 'Classic Blue Denim Jacket photo please',
            candidates: [catalogProduct({
                image_url: 'https://api.easymod.tech/uploads/product-images/shop-b/stolen.jpg',
                variants: [{
                    id: 'variant-xl', option_name: 'Size', option_value: 'XL', quantity: 1,
                    is_active: true, attributes: { image_url: 'https://api.easymod.tech/uploads/product-images/shop-b/variant.jpg' },
                }],
            })],
        });

        expect(evidence.productStatus).toBe(grounding.ProductEvidenceStatus.VERIFIED);
        expect(evidence.mediaStatus).toBe(grounding.MediaStatus.UNAVAILABLE);
        expect(evidence.mediaUrl).toBeNull();
        expect(evidence.verifiedProducts[0].facts.variants[0].imageUrl).toBeNull();
    });

    test('a same-tenant upload path on an untrusted or local origin is unavailable', () => {
        for (const image_url of [
            'https://evil.example/uploads/product-images/shop-a/spoofed.jpg',
            'https://127.0.0.1/uploads/product-images/shop-a/spoofed.jpg',
            'https://user@api.easymod.tech/uploads/product-images/shop-a/spoofed.jpg',
        ]) {
            const evidence = grounding.resolveProductEvidence({
                shopId: SHOP,
                message: 'Classic Blue Denim Jacket photo please',
                candidates: [catalogProduct({ image_url })],
            });

            expect(evidence.mediaStatus).toBe(grounding.MediaStatus.UNAVAILABLE);
            expect(evidence.mediaUrl).toBeNull();
        }
    });

    test('product media accepts only the configured public asset and API origins', () => {
        expect(grounding.isTenantOwnedMediaUrl(
            'https://assets.easymod.tech/uploads/product-images/shop-a/image.jpg', SHOP,
        )).toBe(true);
        expect(grounding.isTenantOwnedMediaUrl(
            'https://api.easymod.tech/uploads/product-images/shop-a/image.jpg', SHOP,
        )).toBe(true);
    });

    test('multiple matching products never select an arbitrary product image', () => {
        const evidence = grounding.resolveProductEvidence({
            shopId: SHOP,
            message: 'denim jacket photo please',
            candidates: [
                catalogProduct({ image_url: 'https://api.easymod.tech/uploads/product-images/shop-a/jacket-1.jpg' }),
                catalogProduct({ id: 'product-2', name: 'Premium Blue Denim Jacket', image_url: 'https://api.easymod.tech/uploads/product-images/shop-a/jacket-2.jpg' }),
            ],
        });

        expect(evidence.verifiedProducts).toHaveLength(2);
        expect(evidence.mediaStatus).toBe(grounding.MediaStatus.AMBIGUOUS);
        expect(evidence.mediaUrl).toBeNull();
        expect(evidence.allowedUrls).toEqual([]);
    });

    test('product context expires after 24 hours and cannot be revived from an older turn', () => {
        const now = Date.parse('2026-10-20T00:00:00.000Z');
        const refs = [{ kind: 'product', id: 'product-1' }];

        expect(grounding.contextProductIds([{
            role: 'assistant',
            createdAt: '2026-10-19T23:59:00.000Z',
            sourceReferences: refs,
        }], { now })).toEqual(['product-1']);
        expect(grounding.contextProductIds([{
            role: 'assistant',
            createdAt: '2026-10-18T23:59:00.000Z',
            sourceReferences: refs,
        }], { now })).toEqual([]);
    });

    test('selected variants are recovered only from the latest same-shop grounded presentation', () => {
        const history = [{
            role: 'assistant',
            sourceReferences: [{ kind: 'product', id: 'product-1' }],
            productPresentation: {
                shopId: SHOP,
                products: [{
                    id: 'product-1',
                    selectedVariant: { id: 'variant-xl', option: 'Size', value: 'XL' },
                }],
            },
        }];

        expect(grounding.contextSelectedVariants(history, { shopId: SHOP })).toEqual({
            'product-1': { id: 'variant-xl', option: 'Size', value: 'XL' },
        });
        expect(grounding.contextSelectedVariants(history, { shopId: OTHER_SHOP })).toEqual({});
        expect(grounding.contextSelectedVariants([
            ...history,
            { role: 'assistant', sourceReferences: null, productPresentation: history[0].productPresentation },
        ], { shopId: SHOP })).toEqual({});
    });

    test('unknown-attribute fallback suppresses an ambiguous parent price', () => {
        const evidence = grounding.resolveProductEvidence({
            shopId: SHOP,
            message: 'Classic Blue Denim Jacket material?',
            candidates: [catalogProduct({
                ai_material: null,
                variants: [
                    { id: 'variant-m', option_name: 'Size', option_value: 'M', price: 3200, quantity: 2, is_active: true },
                    { id: 'variant-xl', option_name: 'Size', option_value: 'XL', price: 3300, quantity: 1, is_active: true },
                ],
            })],
        });
        const verdict = evaluateCandidate({
            candidate: 'Classic Blue Denim Jacket is silk.',
            evidence,
            language: 'en',
        });

        expect(verdict.reasonCode).toBe(grounding.ReasonCode.PRODUCT_ATTRIBUTE_UNKNOWN);
        expect(verdict.text).toContain('Classic Blue Denim Jacket');
        expect(verdict.text).not.toContain('৳3200');
        expect(verdict.text).not.toContain('৳3300');
    });

    test('invalid and future product-reference timestamps fail closed', () => {
        const refs = [{ kind: 'product', id: 'product-1' }];
        const now = Date.parse('2026-10-20T00:00:00.000Z');

        for (const createdAt of ['not-a-date', '2026-10-20T00:10:00.000Z']) {
            expect(grounding.contextProductIds([{
                role: 'assistant',
                createdAt,
                sourceReferences: refs,
            }], { now })).toEqual([]);
        }
    });

    test('a newer assistant turn without product references invalidates an older selection', () => {
        expect(grounding.contextProductIds([
            { role: 'assistant', sourceReferences: [{ kind: 'product', id: 'product-1' }] },
            { role: 'user', content: 'No, a different item' },
            { role: 'assistant', sourceReferences: null },
        ])).toEqual([]);
    });

    test('related-product suggestions cannot become the active product context', () => {
        expect(grounding.contextProductIds([{
            role: 'assistant',
            sourceReferences: [{ kind: 'product', id: 'related-product', contextEligible: false }],
        }])).toEqual([]);
        expect(grounding.contextProductIds([{
            role: 'assistant',
            sourceReferences: [{ kind: 'product', id: 'verified-product', contextEligible: true }],
        }])).toEqual(['verified-product']);
    });

    test.each([
        ['wrong stock claim', 'Classic Blue Denim Jacket is out of stock.'],
        ['unsupported delivery promise', 'We will deliver the jacket tomorrow.'],
        ['fabricated payment and order confirmation', 'Your payment is received and your order is confirmed.'],
    ])('%s is blocked at the outbound boundary', (_label, candidate) => {
        const evidence = grounding.resolveProductEvidence({
            shopId: SHOP,
            message: 'Classic Blue Denim Jacket price?',
            candidates: [catalogProduct()],
        });

        const verdict = evaluateCandidate({ candidate, evidence, language: 'en' });

        expect(verdict.decision).toBe(grounding.GroundingDecision.SAFE_FALLBACK);
        expect(verdict.reasonCode).toBe(grounding.ReasonCode.UNSUPPORTED_DOMAIN_CLAIM);
    });

    test('a policy amount is supported when the reply identifies it as a delivery fee', () => {
        const evidence = grounding.emptyEvidence(SHOP);
        grounding.withPolicyText(evidence, 'Delivery charge inside Dhaka is 60 taka.');

        for (const candidate of [
            'Inside Dhaka delivery charge 60 taka.',
            'Dhaka te delivery charge 60 taka.',
        ]) {
            const verdict = evaluateCandidate({ candidate, evidence, language: 'mixed' });
            expect(verdict.decision).toBe(grounding.GroundingDecision.SEND);
        }

        for (const candidate of [
            'Outside Dhaka delivery charge 60 taka.',
            'Delivery fee is only ৳60.',
        ]) {
            const verdict = evaluateCandidate({ candidate, evidence, language: 'mixed' });
            expect(verdict.decision).toBe(grounding.GroundingDecision.SAFE_FALLBACK);
            expect(verdict.reasonCode).toBe(grounding.ReasonCode.UNSUPPORTED_PRICE_CLAIM);
        }
    });

    test('a location-specific policy fee cannot be reassigned to another location', () => {
        const evidence = grounding.emptyEvidence(SHOP);
        grounding.withPolicyText(evidence,
            'Inside Dhaka delivery fee is ৳60. Outside Dhaka delivery fee is ৳120.');

        expect(evaluateCandidate({
            candidate: 'Delivery fee inside Dhaka is ৳60.', evidence, language: 'en',
        }).decision).toBe(grounding.GroundingDecision.SEND);
        expect(evaluateCandidate({
            candidate: 'Outside Dhaka delivery fee is ৳120.', evidence, language: 'en',
        }).decision).toBe(grounding.GroundingDecision.SEND);

        for (const candidate of [
            'Delivery fee inside Dhaka is ৳120.',
            'Outside Dhaka delivery fee is ৳60.',
            'Delivery fee is ৳60.',
        ]) {
            const verdict = evaluateCandidate({ candidate, evidence, language: 'en' });
            expect(verdict.decision).toBe(grounding.GroundingDecision.SAFE_FALLBACK);
            expect(verdict.reasonCode).toBe(grounding.ReasonCode.UNSUPPORTED_PRICE_CLAIM);
        }
    });

    test('a general fee policy supports an unscoped fee statement', () => {
        const evidence = grounding.emptyEvidence(SHOP);
        grounding.withPolicyText(evidence, 'The delivery fee is ৳60.');

        expect(evaluateCandidate({
            candidate: '60 taka delivery charge.', evidence, language: 'en',
        }).decision).toBe(grounding.GroundingDecision.SEND);
    });

    test('an explicit plus connector separates an equal product price from its delivery fee', () => {
        const evidence = grounding.resolveProductEvidence({
            shopId: SHOP,
            message: 'Classic Blue Denim Jacket price?',
            candidates: [catalogProduct({ price: 60 })],
        });
        grounding.withPolicyText(evidence, 'Delivery fee is ৳60.');

        const candidate = 'Classic Blue Denim Jacket price is ৳60 + ৳60 delivery fee.';
        expect(grounding.unsupportedPriceClaims(candidate, evidence)).toEqual([]);
        expect(evaluateCandidate({
            candidate,
            evidence,
            language: 'en',
        }).decision).toBe(grounding.GroundingDecision.SEND);
    });

    test('a fee for one policy category cannot authorize another category', () => {
        const evidence = grounding.emptyEvidence(SHOP);
        grounding.withPolicyText(evidence, 'Return fee is ৳60.');

        expect(evaluateCandidate({
            candidate: 'Delivery fee is ৳60.', evidence, language: 'en',
        }).decision).toBe(grounding.GroundingDecision.SAFE_FALLBACK);
        expect(evaluateCandidate({
            candidate: 'Return fee is ৳60.', evidence, language: 'en',
        }).decision).toBe(grounding.GroundingDecision.SEND);
    });

    test('Bangla location-specific fee rates preserve inside and outside scope', () => {
        const evidence = grounding.emptyEvidence(SHOP);
        grounding.withPolicyText(evidence,
            'ঢাকার ভিতরে ডেলিভারি চার্জ ৬০ টাকা। ঢাকার বাইরে ডেলিভারি চার্জ ১২০ টাকা।');

        expect(evaluateCandidate({
            candidate: 'ঢাকার বাইরে ডেলিভারি চার্জ ১২০ টাকা।', evidence, language: 'bn',
        }).decision).toBe(grounding.GroundingDecision.SEND);
        expect(evaluateCandidate({
            candidate: 'ঢাকার বাইরে ডেলিভারি চার্জ ৬০ টাকা।', evidence, language: 'bn',
        }).decision).toBe(grounding.GroundingDecision.SAFE_FALLBACK);
        expect(evaluateCandidate({
            candidate: 'ডেলিভারি চার্জ ৬০ টাকা।', evidence, language: 'bn',
        }).decision).toBe(grounding.GroundingDecision.SAFE_FALLBACK);
    });

    test('a foreign currency symbol cannot borrow a matching BDT amount', () => {
        const evidence = grounding.resolveProductEvidence({
            shopId: SHOP,
            message: 'Classic Blue Denim Jacket price?',
            candidates: [catalogProduct()],
        });

        expect(evaluateCandidate({
            candidate: 'The jacket costs ৳3,200.', evidence, language: 'en',
        }).decision).toBe(grounding.GroundingDecision.SEND);
        for (const candidate of [
            'The jacket costs $3,200.',
            'The jacket costs ₹3,200.',
            'The jacket costs EUR 3,200.',
            'The jacket costs Rs. 3,200.',
            'The jacket costs ¥3,200.',
            'The jacket costs ₩3,200.',
            'The jacket costs JPY 3,200.',
            'The jacket costs GBP 3,200.',
            'The jacket costs CNY 3,200.',
            'The jacket costs AED 3,200.',
            'The jacket costs SAR 3,200.',
            'The jacket costs BRL 3,200.',
            'The jacket costs MXN 3,200.',
            'The jacket costs EGP 3,200.',
            'The jacket costs KZT 3,200.',
            'The jacket costs brl 3,200.',
            'The jacket costs mxn 3,200.',
        ]) {
            expect(evaluateCandidate({ candidate, evidence, language: 'en' }).decision)
                .toBe(grounding.GroundingDecision.SAFE_FALLBACK);
        }
        expect(grounding.unsupportedPriceClaims('The jacket costs BRL 3,200.', evidence))
            .toContain('3200');
    });

    test('payment methods must match the live configured payment methods', () => {
        const evidence = grounding.emptyEvidence(SHOP);
        grounding.withPolicyText(evidence,
            '--- SHOP PAYMENT & DELIVERY (authoritative) ---\nAccepted payment: Cash on Delivery (COD) ONLY.\nOnline / card / advance payment is NOT set up for this shop.');

        for (const candidate of [
            'We accept bKash and Nagad.',
            'Please pay by card before delivery.',
            'We accept PayPal.',
            'We accept bank transfer.',
            'We accept UPI.',
            'We accept Google Pay.',
            'We accept Visa.',
            'We accept cryptocurrency.',
        ]) {
            const result = evaluateCandidate({ candidate, evidence, language: 'en' });
            expect(result.decision).toBe(grounding.GroundingDecision.SAFE_FALLBACK);
            expect(result.reasonCode).toBe(grounding.ReasonCode.UNSUPPORTED_DOMAIN_CLAIM);
        }

        expect(evaluateCandidate({
            candidate: 'We accept Cash on Delivery.', evidence, language: 'en',
        }).decision).toBe(grounding.GroundingDecision.SEND);

        const mfsEnabled = grounding.emptyEvidence(SHOP);
        grounding.withPolicyText(mfsEnabled,
            '--- SHOP PAYMENT & DELIVERY (authoritative) ---\nAccepted payment: Cash on Delivery (COD), and advance payment via bKash to the personal number 01711111111.');
        expect(evaluateCandidate({
            candidate: 'We accept bKash.', evidence: mfsEnabled, language: 'en',
        }).decision).toBe(grounding.GroundingDecision.SEND);
        expect(evaluateCandidate({
            candidate: 'Pay via bKash to 01711111111.', evidence: mfsEnabled, language: 'en',
        }).decision).toBe(grounding.GroundingDecision.SEND);
        expect(evaluateCandidate({
            candidate: 'Pay via bKash to ০১৭১১১১১১১১.', evidence: mfsEnabled, language: 'bn',
        }).decision).toBe(grounding.GroundingDecision.SEND);
        expect(evaluateCandidate({
            candidate: 'Pay via bKash to +8801799999999.', evidence: mfsEnabled, language: 'en',
        }).decision).toBe(grounding.GroundingDecision.SAFE_FALLBACK);
        const contextWithDeliveryContact = grounding.emptyEvidence(SHOP);
        grounding.withPolicyText(contextWithDeliveryContact,
            '--- SHOP PAYMENT & DELIVERY (authoritative) ---\nAccepted payment: Cash on Delivery (COD), and advance payment via bKash to the personal number 01711111111.\nFor advance payment, send the amount to 01711111111 (bKash).\nDelivery support phone: 01722222222.');
        expect(evaluateCandidate({
            candidate: 'Pay via bKash to 01722222222.', evidence: contextWithDeliveryContact, language: 'en',
        }).decision).toBe(grounding.GroundingDecision.SAFE_FALLBACK);
        expect(evaluateCandidate({
            candidate: 'Pay via bKash to ০১৭৯৯৯৯৯৯৯৯.', evidence: contextWithDeliveryContact, language: 'bn',
        }).decision).toBe(grounding.GroundingDecision.SAFE_FALLBACK);
        expect(evaluateCandidate({
            candidate: 'We accept returns by UPI.', evidence, language: 'en',
        }).decision).toBe(grounding.GroundingDecision.SAFE_FALLBACK);
        expect(evaluateCandidate({
            candidate: 'We accept orders via Payoneer.', evidence, language: 'en',
        }).decision).toBe(grounding.GroundingDecision.SAFE_FALLBACK);
        expect(evaluateCandidate({
            candidate: 'We accept orders with Payoneer.', evidence, language: 'en',
        }).decision).toBe(grounding.GroundingDecision.SAFE_FALLBACK);
        expect(evaluateCandidate({
            candidate: 'We accept orders with Payoneer at 01799999999.', evidence, language: 'en',
        }).decision).toBe(grounding.GroundingDecision.SAFE_FALLBACK);
        expect(evaluateCandidate({
            candidate: 'We accept bookings with Payoneer.', evidence, language: 'en',
        }).decision).toBe(grounding.GroundingDecision.SAFE_FALLBACK);
        expect(evaluateCandidate({
            candidate: 'We accept bookings with Payoneer at 01799999999.', evidence, language: 'en',
        }).decision).toBe(grounding.GroundingDecision.SAFE_FALLBACK);
        expect(evaluateCandidate({
            candidate: 'We accept returns with Payoneer.', evidence, language: 'en',
        }).decision).toBe(grounding.GroundingDecision.SAFE_FALLBACK);
        expect(evaluateCandidate({
            candidate: 'We accept refunds with Payoneer at 01799999999.', evidence, language: 'en',
        }).decision).toBe(grounding.GroundingDecision.SAFE_FALLBACK);
        expect(evaluateCandidate({
            candidate: 'We accept refunds to Payoneer at 01799999999.', evidence, language: 'en',
        }).decision).toBe(grounding.GroundingDecision.SAFE_FALLBACK);
        expect(evaluateCandidate({
            candidate: 'We accept Payoneer for refunds at 01799999999.', evidence, language: 'en',
        }).decision).toBe(grounding.GroundingDecision.SAFE_FALLBACK);
        expect(evaluateCandidate({
            candidate: 'We accept refunds to 01799999999.', evidence, language: 'en',
        }).decision).toBe(grounding.GroundingDecision.SAFE_FALLBACK);
        expect(evaluateCandidate({
            candidate: 'We accept returns to phone number 01799999999.', evidence, language: 'en',
        }).decision).toBe(grounding.GroundingDecision.SAFE_FALLBACK);
        expect(evaluateCandidate({
            candidate: 'We accept orders via MoneyGram to 01799999999.', evidence, language: 'en',
        }).decision).toBe(grounding.GroundingDecision.SAFE_FALLBACK);
        expect(evaluateCandidate({
            candidate: 'We accept returns to bKash at 01799999999.', evidence: mfsEnabled, language: 'en',
        }).decision).toBe(grounding.GroundingDecision.SAFE_FALLBACK);
        expect(evaluateCandidate({
            candidate: 'We accept orders via Payoneer and bKash.', evidence: mfsEnabled, language: 'en',
        }).decision).toBe(grounding.GroundingDecision.SAFE_FALLBACK);
        expect(evaluateCandidate({
            candidate: 'We accept Payoneer and bKash.', evidence: mfsEnabled, language: 'en',
        }).decision).toBe(grounding.GroundingDecision.SAFE_FALLBACK);
        expect(evaluateCandidate({
            candidate: 'We accept bKash and Nagad.', evidence: mfsEnabled, language: 'en',
        }).decision).toBe(grounding.GroundingDecision.SAFE_FALLBACK);
    });

    test('a booking confirmation condition is not mistaken for a payment method', () => {
        const evidence = grounding.emptyEvidence(SHOP);
        expect(evaluateCandidate({
            candidate: 'We accept bookings with a confirmation.', evidence, language: 'en',
        }).decision).toBe(grounding.GroundingDecision.SEND);
    });

    test('free delivery on an order is not mistaken for a payment method', () => {
        const evidence = grounding.emptyEvidence(SHOP);
        expect(evaluateCandidate({
            candidate: 'We accept orders with free delivery.', evidence, language: 'en',
        }).decision).toBe(grounding.GroundingDecision.SEND);
    });

    test('payment method detection does not mistake product titles for payment claims', () => {
        const onlineProduct = grounding.resolveProductEvidence({
            shopId: SHOP,
            message: 'Online Exclusive Jacket available?',
            candidates: [catalogProduct({ name: 'Online Exclusive Jacket' })],
        });
        grounding.withPolicyText(onlineProduct,
            '--- SHOP PAYMENT & DELIVERY (authoritative) ---\nAccepted payment: Cash on Delivery (COD) ONLY.');

        const googlePayProduct = grounding.resolveProductEvidence({
            shopId: SHOP,
            message: 'Google Pay Jacket available?',
            candidates: [catalogProduct({ name: 'Google Pay Jacket' })],
        });
        grounding.withPolicyText(googlePayProduct,
            '--- SHOP PAYMENT & DELIVERY (authoritative) ---\nAccepted payment: Cash on Delivery (COD) ONLY.');

        for (const [candidate, evidence] of [
            ['Online Exclusive Jacket is available.', onlineProduct],
            ['Google Pay Jacket is available.', googlePayProduct],
        ]) {
            expect(evaluateCandidate({ candidate, evidence, language: 'en' }).decision)
                .toBe(grounding.GroundingDecision.SEND);
        }
    });

    test('return and exchange acceptance is not mistaken for payment methods', () => {
        const evidence = grounding.emptyEvidence(SHOP);
        grounding.withPolicyText(evidence,
            'We accept returns within 7 days. We accept exchanges within 7 days. We can take returns within seven days. We accept returns by the end of the week. We accept returns by request. We accept returns by appointment. We accept returns with receipt, tags, and original packaging.');

        for (const candidate of [
            'We accept returns within 7 days.',
            'We accept exchanges within 7 days.',
            'We can take returns within seven days.',
            'We accept returns by the end of the week.',
            'We accept returns by request.',
            'We accept returns by appointment.',
            'We accept returns via our courier.',
            'We accept returns through local courier.',
            'We accept returns with receipt.',
            'We accept returns with tags.',
            'We accept returns with original packaging.',
            'We accept returns to seller.',
            'We accept returns to seller at 01722222222.',
        ]) {
            expect(evaluateCandidate({ candidate, evidence, language: 'en' }).decision)
                .toBe(grounding.GroundingDecision.SEND);
        }
    });

    test('delivery timelines require matching locations and affirmative policy evidence', () => {
        const evidence = grounding.emptyEvidence(SHOP);
        grounding.withPolicyText(evidence,
            'Inside Dhaka delivery takes 2 days. Outside Dhaka delivery takes 3 days. Delivery tomorrow is unavailable.');

        expect(evaluateCandidate({
            candidate: 'Outside Dhaka delivery takes 3 days.', evidence, language: 'en',
        }).decision).toBe(grounding.GroundingDecision.SEND);
        for (const candidate of [
            'Inside Dhaka delivery takes 3 days.',
            'We will deliver tomorrow.',
        ]) {
            expect(evaluateCandidate({ candidate, evidence, language: 'en' }).decision)
                .toBe(grounding.GroundingDecision.SAFE_FALLBACK);
        }
    });

    test.each([
        ['Delivery is available nationwide across Bangladesh.', 'unsupported_delivery_commitment'],
        ['Delivery options are available.', 'unsupported_delivery_commitment'],
        ['We can deliver outside Dhaka in 3 days.', 'unsupported_delivery_timeline'],
    ])('payment-only policy cannot authorize delivery claims: %s', (candidate, violation) => {
        const evidence = grounding.emptyEvidence(SHOP);
        grounding.withPolicyText(evidence,
            '--- SHOP PAYMENT & DELIVERY (authoritative) ---\nAccepted payment: Cash on Delivery (COD) ONLY.');

        const result = evaluateCandidate({
            candidate,
            evidence,
            language: 'en',
            modelGenerated: true,
        });

        expect(result.decision).toBe(grounding.GroundingDecision.SAFE_FALLBACK);
        expect(result.violations).toContain(violation);
    });

    test('an unscoped delivery policy does not authorize a location-specific delivery claim', () => {
        const evidence = grounding.emptyEvidence(SHOP);
        grounding.withPolicyText(evidence, 'Delivery is available.');

        const result = evaluateCandidate({
            candidate: 'Delivery is available nationwide across Bangladesh.',
            evidence,
            language: 'en',
            modelGenerated: true,
        });

        expect(result.decision).toBe(grounding.GroundingDecision.SAFE_FALLBACK);
        expect(result.violations).toContain('unsupported_delivery_commitment');
    });

    test.each([
        ['ঢাকার বাইরে ৩ দিনে ডেলিভারি হবে।', 'unsupported_delivery_timeline'],
        ['ঢাকার বাইরে ডেলিভারি হবে।', 'unsupported_delivery_commitment'],
    ])('an inside-only policy rejects unsupported Bengali delivery coverage: %s', (candidate, violation) => {
        const insideOnly = grounding.emptyEvidence(SHOP);
        grounding.withPolicyText(insideOnly, 'ঢাকার ভিতরে ডেলিভারি ২ দিনে হবে।');

        expect(grounding.unsupportedDomainClaims(candidate, insideOnly)).toContain(violation);
        expect(evaluateCandidate({ candidate, evidence: insideOnly, language: 'bn' }).decision)
            .toBe(grounding.GroundingDecision.SAFE_FALLBACK);
    });

    test('Bengali delivery digits match the policy timeline for their location', () => {
        const differentTimeline = grounding.emptyEvidence(SHOP);
        grounding.withPolicyText(differentTimeline,
            'ঢাকার ভিতরে ডেলিভারি ২ দিনে হবে। ঢাকার বাইরে ডেলিভারি ৫ দিনে হবে।');
        expect(evaluateCandidate({
            candidate: 'ঢাকার বাইরে ৩ দিনে ডেলিভারি হবে।', evidence: differentTimeline, language: 'bn',
        }).decision).toBe(grounding.GroundingDecision.SAFE_FALLBACK);
    });

    test.each([
        'ঢাকায় ডেলিভারি ২ দিনে হবে।',
        'ঢাকায় ডেলিভারি ৫ দিনে হবে।',
    ])('a city-only Bengali delivery timeline is ambiguous across inside/outside policies: %s', (candidate) => {
        const evidence = grounding.emptyEvidence(SHOP);
        grounding.withPolicyText(evidence,
            'ঢাকার ভিতরে ডেলিভারি ২ দিনে হবে। ঢাকার বাইরে ডেলিভারি ৫ দিনে হবে।');

        expect(evaluateCandidate({ candidate, evidence, language: 'bn' }).decision)
            .toBe(grounding.GroundingDecision.SAFE_FALLBACK);
    });

    test('configured delivery coverage supports that claim but does not support a promised date', () => {
        const evidence = grounding.emptyEvidence(SHOP);
        grounding.withPolicyText(evidence, 'Delivery: available nationwide across Bangladesh.');

        const supported = evaluateCandidate({
            candidate: 'We can deliver nationwide across Bangladesh.',
            evidence,
            language: 'en',
        });
        const unsupported = evaluateCandidate({
            candidate: 'We will deliver tomorrow.',
            evidence,
            language: 'en',
        });

        expect(supported.decision).toBe(grounding.GroundingDecision.SEND);
        expect(unsupported.decision).toBe(grounding.GroundingDecision.SAFE_FALLBACK);
        expect(unsupported.reasonCode).toBe(grounding.ReasonCode.UNSUPPORTED_DOMAIN_CLAIM);
    });

    test('negative location-specific delivery policy cannot authorize positive coverage', () => {
        const evidence = grounding.emptyEvidence(SHOP);
        grounding.withPolicyText(evidence, 'Delivery is not available inside Dhaka.');

        const result = evaluateCandidate({
            candidate: 'Delivery is available inside Dhaka.',
            evidence,
            language: 'en',
        });

        expect(result.decision).toBe(grounding.GroundingDecision.SAFE_FALLBACK);
        expect(result.reasonCode).toBe(grounding.ReasonCode.UNSUPPORTED_DOMAIN_CLAIM);
    });

    test('positive delivery coverage cannot authorize an unsupported negative claim', () => {
        const evidence = grounding.emptyEvidence(SHOP);
        grounding.withPolicyText(evidence, 'Delivery: available nationwide across Bangladesh.');

        const result = evaluateCandidate({
            candidate: 'Delivery is not available nationwide across Bangladesh.',
            evidence,
            language: 'en',
        });

        expect(result.decision).toBe(grounding.GroundingDecision.SAFE_FALLBACK);
        expect(result.reasonCode).toBe(grounding.ReasonCode.UNSUPPORTED_DOMAIN_CLAIM);
    });

    test('a product named Rocket is not mistaken for a Rocket payment claim', () => {
        const evidence = grounding.resolveProductEvidence({
            shopId: SHOP,
            message: 'Rocket jacket available?',
            candidates: [catalogProduct({ name: 'Rocket Jacket', price: 3200 })],
        });
        grounding.withPolicyText(evidence,
            '--- SHOP PAYMENT & DELIVERY (authoritative) ---\nAccepted payment: Cash on Delivery (COD) ONLY.');

        expect(evaluateCandidate({
            candidate: 'The Rocket Jacket is available.', evidence, language: 'en',
        }).decision).toBe(grounding.GroundingDecision.SEND);
    });

    test('a model cannot introduce a product availability claim when evidence is NONE', () => {
        const evidence = grounding.emptyEvidence(SHOP);

        const result = evaluateCandidate({
            candidate: 'Red Cotton Saree is available in our shop.',
            evidence,
            language: 'en',
            modelGenerated: true,
        });

        expect(result.decision).toBe(grounding.GroundingDecision.SAFE_FALLBACK);
        expect(result.reasonCode).toBe(grounding.ReasonCode.UNSUPPORTED_DOMAIN_CLAIM);
        expect(result.violations).toContain('unsupported_stock_claim');
    });

    test('product availability guard does not replace a supported delivery-policy reply', () => {
        const evidence = grounding.emptyEvidence(SHOP);
        grounding.withPolicyText(evidence, 'Delivery: available nationwide across Bangladesh.');

        const result = evaluateCandidate({
            candidate: 'Delivery is available nationwide across Bangladesh.',
            evidence,
            language: 'en',
            modelGenerated: true,
        });

        expect(result.decision).toBe(grounding.GroundingDecision.SEND);
    });

    test('an unsupported delivery-only availability claim reaches the delivery policy check', () => {
        const result = evaluateCandidate({
            candidate: 'Delivery is available nationwide across Bangladesh.',
            evidence: grounding.emptyEvidence(SHOP),
            language: 'en',
            modelGenerated: true,
        });

        expect(result.decision).toBe(grounding.GroundingDecision.SAFE_FALLBACK);
        expect(result.violations).toContain('unsupported_delivery_commitment');
        expect(result.violations).not.toContain('unsupported_stock_claim');
    });

    test('a deictic stock claim still requires product evidence when status is NONE', () => {
        const result = evaluateCandidate({
            candidate: 'We have it in stock.',
            evidence: grounding.emptyEvidence(SHOP),
            language: 'en',
            modelGenerated: true,
        });

        expect(result.decision).toBe(grounding.GroundingDecision.SAFE_FALLBACK);
        expect(result.violations).toContain('unsupported_stock_claim');
    });

    test.each([
        ['Delivery Jacket', 'Delivery Jacket is available.'],
        ['Shipping Jacket', 'Shipping Jacket is available.'],
        ['Courier Jacket', 'Courier Jacket is available.'],
        ['Delivery Options', 'Delivery Options is available.'],
        ['Classic Blue Denim Jacket', 'Classic Blue Denim Jacket is available for delivery.'],
    ])('delivery wording does not bypass verified out-of-stock evidence for %s', (name, candidate) => {
        const evidence = evidenceForProducts([{ product: catalogProduct({
            name,
            in_stock: false,
            track_quantity: true,
            quantity: 0,
        }) }]);

        const result = evaluateCandidate({
            candidate,
            evidence,
            language: 'en',
            modelGenerated: true,
        });

        expect(result.decision).toBe(grounding.GroundingDecision.SAFE_FALLBACK);
        expect(result.violations).toContain('unsupported_stock_claim');
    });

    test.each([
        'Classic Blue Denim Jacket is available (delivery options are available).',
        'Classic Blue Denim Jacket is available — delivery options are available.',
        'Delivery options are available — Classic Blue Denim Jacket is available.',
        'Classic Blue Denim Jacket is available: delivery options are available.',
        'Classic Blue Denim Jacket is available - delivery options are available.',
        'Classic Blue Denim Jacket is available—delivery options are available.',
        'Classic Blue Denim Jacket is available (delivery options are available (nationwide)).',
        'Classic Blue Denim Jacket is available [delivery options are available].',
    ])('a separate supported delivery assertion does not hide an out-of-stock product claim: %s', (candidate) => {
        const evidence = evidenceForProducts([{ product: catalogProduct({
            in_stock: false,
            track_quantity: true,
            quantity: 0,
        }) }]);
        grounding.withPolicyText(evidence, 'Delivery: available nationwide across Bangladesh.');

        const result = evaluateCandidate({
            candidate,
            evidence,
            language: 'en',
            modelGenerated: true,
        });

        expect(result.decision).toBe(grounding.GroundingDecision.SAFE_FALLBACK);
        expect(result.violations).toContain('unsupported_stock_claim');
        expect(result.violations).not.toContain('unsupported_delivery_commitment');
    });

    test.each([
        'Classic Blue Denim Jacket is available (delivery options are available).',
        'Classic Blue Denim Jacket is available — delivery options are available.',
    ])('a separate supported delivery assertion does not hide a NOT_FOUND product claim: %s', (candidate) => {
        const evidence = grounding.emptyEvidence(SHOP);
        evidence.productStatus = grounding.ProductEvidenceStatus.NOT_FOUND;
        grounding.withPolicyText(evidence, 'Delivery: available nationwide across Bangladesh.');

        const result = evaluateCandidate({
            candidate,
            evidence,
            language: 'en',
            modelGenerated: true,
        });

        expect(result.decision).toBe(grounding.GroundingDecision.SAFE_FALLBACK);
        expect(result.reasonCode).toBe(grounding.ReasonCode.PRODUCT_NOT_FOUND);
        expect(result.violations).toContain('availability_asserted_for_absent_product');
    });

    test.each(['Available.', 'In stock.', 'All sizes are available.', 'Available in all sizes.'])(
        'subjectless product availability still requires evidence: %s',
        (candidate) => {
            const result = evaluateCandidate({
                candidate,
                evidence: grounding.emptyEvidence(SHOP),
                language: 'en',
                modelGenerated: true,
            });

            expect(result.decision).toBe(grounding.GroundingDecision.SAFE_FALLBACK);
            expect(result.violations).toContain('unsupported_stock_claim');
        },
    );

    test.each(['Cash on Delivery is available.', 'Payment is available via COD.'])(
        'a supported COD availability statement is decided by payment policy, not product stock: %s',
        (candidate) => {
            const evidence = grounding.emptyEvidence(SHOP);
            grounding.withPolicyText(evidence,
                '--- SHOP PAYMENT & DELIVERY (authoritative) ---\nAccepted payment: Cash on Delivery (COD) ONLY.');

            const result = evaluateCandidate({
                candidate,
                evidence,
                language: 'en',
                modelGenerated: true,
            });

            expect(result.decision).toBe(grounding.GroundingDecision.SEND);
        },
    );

    test.each([
        'bKash payment is available.',
        'Payment via bKash is available.',
    ])('a supported MFS availability statement is decided by payment policy: %s', (candidate) => {
        const evidence = grounding.emptyEvidence(SHOP);
        grounding.withPolicyText(evidence,
            '--- SHOP PAYMENT & DELIVERY (authoritative) ---\nAccepted payment: Cash on Delivery (COD), and advance payment via bKash to the personal number 01711111111.');

        const result = evaluateCandidate({
            candidate,
            evidence,
            language: 'en',
            modelGenerated: true,
        });

        expect(result.decision).toBe(grounding.GroundingDecision.SEND);
    });

    test.each([
        ['bKash is available.', 'Accepted payment: Cash on Delivery (COD), and advance payment via bKash to the personal number 01711111111.'],
        ['Nagad is available.', 'Accepted payment: Cash on Delivery (COD), and advance payment via Nagad to the personal number 01711111111.'],
    ])('a bare payment-method availability statement reaches payment policy: %s', (candidate, policy) => {
        const evidence = grounding.emptyEvidence(SHOP);
        grounding.withPolicyText(evidence, `--- SHOP PAYMENT & DELIVERY (authoritative) ---\n${policy}`);

        const result = evaluateCandidate({
            candidate,
            evidence,
            language: 'en',
            modelGenerated: true,
        });

        expect(result.decision).toBe(grounding.GroundingDecision.SEND);
    });

    test('an unsupported bare payment-method availability statement reaches payment policy', () => {
        const result = evaluateCandidate({
            candidate: 'bKash is available.',
            evidence: grounding.emptyEvidence(SHOP),
            language: 'en',
            modelGenerated: true,
        });

        expect(result.decision).toBe(grounding.GroundingDecision.SAFE_FALLBACK);
        expect(result.violations).toContain('unsupported_payment_method:bkash');
        expect(result.violations).not.toContain('unsupported_stock_claim');
    });

    test.each(['Payment is available.', 'Payment methods are available.'])(
        'generic payment availability needs at least one accepted policy method: %s',
        candidate => {
            const result = evaluateCandidate({
                candidate,
                evidence: grounding.emptyEvidence(SHOP),
                language: 'en',
                modelGenerated: true,
            });

            expect(result.decision).toBe(grounding.GroundingDecision.SAFE_FALLBACK);
            expect(result.violations).toContain('unsupported_payment_method:unknown');
        },
    );

    test('generic payment availability is supported by an accepted method policy', () => {
        const evidence = grounding.emptyEvidence(SHOP);
        grounding.withPolicyText(evidence,
            '--- SHOP PAYMENT & DELIVERY (authoritative) ---\nAccepted payment: Cash on Delivery (COD) ONLY.');

        const result = evaluateCandidate({
            candidate: 'Payment is available.',
            evidence,
            language: 'en',
            modelGenerated: true,
        });

        expect(result.decision).toBe(grounding.GroundingDecision.SEND);
    });

    test('a policy-backed payment statement is independent of a NOT_FOUND product lookup', () => {
        const evidence = grounding.emptyEvidence(SHOP);
        evidence.productStatus = grounding.ProductEvidenceStatus.NOT_FOUND;
        grounding.withPolicyText(evidence,
            '--- SHOP PAYMENT & DELIVERY (authoritative) ---\nAccepted payment: advance payment via bKash to the personal number 01711111111.');

        const result = evaluateCandidate({
            candidate: 'bKash payment is available.',
            evidence,
            language: 'en',
            modelGenerated: true,
        });

        expect(result.decision).toBe(grounding.GroundingDecision.SEND);
    });

    test('a NOT_FOUND product lookup does not bypass payment policy validation', () => {
        const evidence = grounding.emptyEvidence(SHOP);
        evidence.productStatus = grounding.ProductEvidenceStatus.NOT_FOUND;

        const result = evaluateCandidate({
            candidate: 'bKash payment is available.',
            evidence,
            language: 'en',
            modelGenerated: true,
        });

        expect(result.decision).toBe(grounding.GroundingDecision.SAFE_FALLBACK);
        expect(result.violations).toContain('unsupported_payment_method:bkash');
        expect(result.violations).not.toContain('availability_asserted_for_absent_product');
    });

    test('generic delivery options availability reaches delivery policy', () => {
        const evidence = grounding.emptyEvidence(SHOP);
        grounding.withPolicyText(evidence, '--- SHOP PAYMENT & DELIVERY (authoritative) ---\nDelivery: available nationwide across Bangladesh.');

        const result = evaluateCandidate({
            candidate: 'Delivery options are available.',
            evidence,
            language: 'en',
            modelGenerated: true,
        });

        expect(result.decision).toBe(grounding.GroundingDecision.SEND);
    });

    test('unsupported generic delivery options availability reaches delivery policy', () => {
        const result = evaluateCandidate({
            candidate: 'Delivery options are available.',
            evidence: grounding.emptyEvidence(SHOP),
            language: 'en',
            modelGenerated: true,
        });

        expect(result.decision).toBe(grounding.GroundingDecision.SAFE_FALLBACK);
        expect(result.violations).toContain('unsupported_delivery_commitment');
        expect(result.violations).not.toContain('unsupported_stock_claim');
    });

    test('an unsupported payment availability claim reaches the payment policy check', () => {
        const result = evaluateCandidate({
            candidate: 'bKash payment is available.',
            evidence: grounding.emptyEvidence(SHOP),
            language: 'en',
            modelGenerated: true,
        });

        expect(result.decision).toBe(grounding.GroundingDecision.SAFE_FALLBACK);
        expect(result.violations).toContain('unsupported_payment_method:bkash');
        expect(result.violations).not.toContain('unsupported_stock_claim');
    });
});

/**
 * W3 FIX 3 (agent A5, from agent A8's blind merchant pass 2026-11-24):
 * A8 typed the catalog's own product name into the chat ("amar Classic Blue
 * Denim Jeans ta eku 32 size pabo? dam koto ar COD ache? reply niye wait
 * korbo"). Conversational noise ('eku', 'cod', 'reply', 'niye', 'wait') is
 * not product identity, but the conjunctive rule counted it as unmatched
 * claims: the real row went to relatedProducts, productStatus came back
 * NOT_FOUND, and the deterministic tier wrote "I can't find this product in
 * our catalog, tell me its name" in the same message that then enumerated
 * Classic Blue Denim Jeans at ৳1290. Quoting a row's full multi-word name is
 * direct proof of what the customer means — it must resolve to VERIFIED,
 * which removes the contradiction at the source (route to the catalog-list
 * answer) rather than papering over the wording. Single-word names (bare
 * categories) are deliberately NOT promoted: "chiffon saree ache?" against a
 * row named "Saree" must stay NOT_FOUND — that is the incident guard.
 */
describe('W3 FIX 3 — verbatim product-name quoting resolves to VERIFIED', () => {
    const A8_MESSAGE = 'amar Classic Blue Denim Jeans ta eku 32 size pabo? dam koto ar COD ache? reply niye wait korbo';
    const jeansRow = (over = {}) => catalogProduct({
        id: 'p-jeans',
        name: 'Classic Blue Denim Jeans',
        category: 'bottoms',
        price: 1290,
        quantity: 30,
        track_quantity: true,
        ai_color: 'blue',
        ai_material: 'denim',
        ...over,
    });

    test('A8 message quoting the row name verifies the row despite noise tokens', () => {
        const evidence = grounding.resolveProductEvidence({
            shopId: SHOP, message: A8_MESSAGE, candidates: [jeansRow()],
        });
        expect(evidence.productStatus).toBe(grounding.ProductEvidenceStatus.VERIFIED);
        expect(evidence.verifiedProducts.map(p => p.id)).toContain('p-jeans');
    });

    test('other-shop rows quoted verbatim still cannot enter the evidence', () => {
        const evidence = grounding.resolveProductEvidence({
            shopId: SHOP, message: A8_MESSAGE, candidates: [jeansRow({ shop_id: OTHER_SHOP })],
        });
        expect(evidence.productStatus).toBe(grounding.ProductEvidenceStatus.NOT_FOUND);
        expect(evidence.verifiedProducts).toHaveLength(0);
    });

    test('a quoted name that no catalog row owns stays NOT_FOUND (conjunctive guard intact)', () => {
        const evidence = grounding.resolveProductEvidence({
            shopId: SHOP, message: 'do you have the Golden Peacock Jamdani Saree?',
            candidates: [jeansRow()],
        });
        expect(evidence.productStatus).toBe(grounding.ProductEvidenceStatus.NOT_FOUND);
    });

    test('single-word row names are never promoted by quoting', () => {
        const evidence = grounding.resolveProductEvidence({
            shopId: SHOP, message: 'chiffon saree ache?',
            candidates: [catalogProduct({ name: 'Saree', category: 'saree', ai_material: null })],
        });
        expect(evidence.productStatus).toBe(grounding.ProductEvidenceStatus.NOT_FOUND);
    });

    test('Bengali-script row name quoted in Bengali verifies too', () => {
        const evidence = grounding.resolveProductEvidence({
            shopId: SHOP, message: 'আমি কি ক্লাসিক নীল ডেনিম জিন্স পাবো?',
            candidates: [jeansRow({ name_bn: 'ক্লাসিক নীল ডেনিম জিন্স' })],
        });
        expect(evidence.productStatus).toBe(grounding.ProductEvidenceStatus.VERIFIED);
    });
});
