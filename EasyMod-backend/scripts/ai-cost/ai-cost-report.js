#!/usr/bin/env node
'use strict';

/**
 * AI cost report generator.
 *
 * Recomputes every scenario from src/modules/ai/pricing-table.json and writes:
 *   docs/ai-cost/AI_COST_MODEL.csv
 *   docs/ai-cost/AI_COST_MODEL.json
 *
 * When a provider changes prices: edit pricing-table.json (bump `version`,
 * `retrievedAt`, move the old entry into `history`), then re-run this. No cost
 * number anywhere in the docs is hand-typed.
 *
 *   node scripts/ai-cost/ai-cost-report.js            # write both files
 *   node scripts/ai-cost/ai-cost-report.js --stdout   # print the JSON instead
 *   node scripts/ai-cost/ai-cost-report.js --embeddings=openai
 */

const fs = require('fs');
const path = require('path');
const { calculateCost, PRICING, getFxRate } = require('../../src/modules/ai/cost.service');
const SC = require('./scenarios');

const { M, TOK, textTurn, faqBranchTurn, sentimentCall, queryEmbedding, op } = SC;

const OUT_DIR = path.resolve(__dirname, '../../../docs/ai-cost');
const FX = getFxRate();

// EMBEDDING_PROVIDER in the deployed env resolves to the local n-gram fallback
// (see AI_COST_AUDIT.md F-2). Override to price the openai path instead.
const EMBED_MODEL = process.argv.find((a) => a.startsWith('--embeddings='))?.split('=')[1] === 'openai'
    ? M.EMBED_OPENAI
    : M.EMBED_LOCAL;

// ── HISTORICAL cost fixture (ADR-0011) ──────────────────────────────────────
// These are the pre-2026-11-14 subscription inputs, retained so the archived AI
// cost analysis can be reproduced exactly. They are internal cost-model inputs,
// never a merchant-facing offer: the live price authority is the delivered-order
// commercial contract. The two retired tokens here are allowlisted per path in
// scripts/verify-claims/lib/allowlist.js with a matching reason.
const PLAN = {
    code: 'GROWTH',
    priceBdtMonthly: 999,
    priceBdtYearly: 9990,
    conversationsLimit: 500,
    topups: { PACK_100: [100, 250], PACK_300: [300, 500], PACK_700: [700, 1000] },
};

// ── Assumptions that are NOT measurable from the repo ───────────────────────
const ASSUMPTIONS = {
    fallbackRateBaseline: 0.05,
    productsAddedPerMonth: 15,
    productEditsPerMonth: 30,
    fixedInfraUsdPerMonth: 48,
    merchantsSharingInfra: 25,
    paymentFeePct: 0.025,
    vatPct: 0,
};

// ───────────────────────────────────────────────────────────────────────────
// Scenario definitions
// ───────────────────────────────────────────────────────────────────────────

/**
 * A photo message under the LOCKED architecture (AI_VISION_ENABLED unset).
 *
 * The customer still sends an image, but no image bytes reach a provider:
 * vision-policy.stripImageBlocks() removes them and the reply is grounded on the
 * caption text plus the DB product search. So a photo message costs exactly what
 * a text message of the same length costs — the ~1,064 image input tokens and
 * the separate 1,215-token extraction call are both gone.
 *
 * The one addition is the "you cannot see images" instruction the router appends
 * so the model does not pretend to have looked at the photo.
 */
const NO_VISION_NOTICE_TOKENS = 46;   // [T] countTokens on the appended block

const photoMessageTurn = (tier) => {
    const t = SC.textTurn(tier);
    return {
        ...t,
        operation: `chat_reply_photo_message_${tier}`,
        inputTokens: t.inputTokens + NO_VISION_NOTICE_TOKENS,
        imageCount: 0,
        notes: 'Customer sent a photo. AI_VISION_ENABLED is off, so image blocks are '
            + 'stripped before the provider call and the reply is grounded on the caption '
            + '+ DB product search. Zero image tokens, zero extraction call.',
    };
};

/**
 * A 20-message conversation = 10 customer messages + 10 AI replies.
 * Only CUSTOMER messages trigger model calls, and not all of them do:
 * greetings short-circuit on the regex fast-path and order-flow turns are a
 * deterministic step machine. Billing counts the CONVERSATION once, not the
 * messages (meta-webhook-events.handler.js:411).
 */
function conversationScenarios() {
    return {
        A_efficient: {
            label: 'A — Efficient',
            customerMessages: 10,
            aiReplies: 10,
            billableConversations: 1,
            imagesProcessed: 3,
            description: 'Short Banglish messages, concise replies, minimal retrieval, 3 images, no retries, no fallback.',
            ops: [
                op({ operation: 'greeting_regex_fastpath', model: M.LITE, requestCount: 0, measurementSource: SC.T, confidence: 'high', notes: 'intent-router.service.js:175 — zero model calls' }),
                textTurn('efficient'), queryEmbedding(EMBED_MODEL, TOK.EMB_QUERY_SHORT),
                photoMessageTurn('efficient'),
                textTurn('efficient'), queryEmbedding(EMBED_MODEL, TOK.EMB_QUERY_SHORT),
                textTurn('efficient'), queryEmbedding(EMBED_MODEL, TOK.EMB_QUERY_SHORT),
                photoMessageTurn('efficient'),
                faqBranchTurn(),
                faqBranchTurn(),
                photoMessageTurn('efficient'),
                op({ operation: 'order_flow_deterministic', model: M.LITE, requestCount: 0, measurementSource: SC.T, confidence: 'high', notes: 'order-flow.service.js step machine — zero model calls' }),
            ],
        },

        B_expected: {
            label: 'B — Expected average',
            customerMessages: 10,
            aiReplies: 10,
            billableConversations: 1,
            imagesProcessed: 3,
            description: 'Realistic Bengali/Banglish, normal history growth, 5 products + 4 RAG chunks retrieved, 3 images, one customer rephrase, no provider fallback.',
            ops: [
                op({ operation: 'greeting_regex_fastpath', model: M.LITE, requestCount: 0, measurementSource: SC.T, confidence: 'high', notes: 'zero model calls' }),
                textTurn('expected'), queryEmbedding(EMBED_MODEL), sentimentCall(),
                photoMessageTurn('expected'),
                textTurn('expected'), queryEmbedding(EMBED_MODEL), sentimentCall(),
                textTurn('expected'), queryEmbedding(EMBED_MODEL), sentimentCall(),
                photoMessageTurn('expected'),
                textTurn('expected'), queryEmbedding(EMBED_MODEL), sentimentCall(),
                faqBranchTurn(),
                photoMessageTurn('expected'),
                { ...textTurn('expected'), operation: 'chat_reply_customer_rephrase', retries: 1, notes: 'Customer rephrases after an unhelpful answer — a second full-price turn on the same question. NOTE: there is no regenerate button in the product; this models the real-world equivalent.' },
                op({ operation: 'order_flow_deterministic', model: M.LITE, requestCount: 0, measurementSource: SC.T, confidence: 'high', notes: 'zero model calls' }),
            ],
        },

        C_heavy: {
            label: 'C — Heavy but plausible',
            customerMessages: 10,
            aiReplies: 10,
            billableConversations: 1,
            imagesProcessed: 5,
            description: '50-FAQ shop, full 10-turn history, 5 photo messages (no vision), one gemini-lite failure falling back to gpt-4.1-mini, one duplicate webhook (deduped, free), one customer rephrase.',
            ops: [
                textTurn('heavy'), queryEmbedding(EMBED_MODEL), sentimentCall(TOK.USER_LONG),
                photoMessageTurn('heavy'),
                textTurn('heavy'), queryEmbedding(EMBED_MODEL), sentimentCall(TOK.USER_LONG),
                // gemini-lite 5xx (not billed) → gpt-4.1-mini answers the same turn.
                // gemini-pro is no longer in the automatic chain: it is limit=0 on the
                // free Gemini project and 8x the price on a paid one.
                { ...textTurn('heavy', M.OAI), operation: 'chat_reply_text_heavy_FALLBACK_openai', fallbackCalls: 1, confidence: 'medium', notes: 'gemini-lite returned 5xx (unbilled) and llm.service fell back to gpt-4.1-mini — 1.6x input, 1.07x output vs the primary. Cold cache assumed; a warm OpenAI prompt cache makes this CHEAPER than the primary.' },
                queryEmbedding(EMBED_MODEL), sentimentCall(TOK.USER_LONG),
                photoMessageTurn('heavy'),
                textTurn('heavy'), queryEmbedding(EMBED_MODEL), sentimentCall(TOK.USER_LONG),
                photoMessageTurn('heavy'),
                faqBranchTurn(),
                { ...textTurn('heavy'), operation: 'chat_reply_customer_rephrase', retries: 1, notes: 'Customer rephrases after an unhelpful answer — a second full-price turn' },
                op({ operation: 'duplicate_webhook_deduped', model: M.LITE, requestCount: 0, retries: 1, measurementSource: SC.T, confidence: 'high', notes: 'message-worker.js:292 claims the dedup key BEFORE any AI call — a redelivery costs $0' }),
                op({ operation: 'order_flow_deterministic', model: M.LITE, requestCount: 0, measurementSource: SC.T, confidence: 'high', notes: 'zero model calls' }),
            ],
        },
    };
}

/** Single-message events, isolated for question 1 and 2. */
function messageScenarios() {
    return {
        MSG_normal: {
            label: 'One normal AI-assisted customer message (text, expected shape)',
            ops: [textTurn('expected'), queryEmbedding(EMBED_MODEL), sentimentCall()],
        },
        MSG_normal_no_sentiment: {
            label: 'One normal customer message, short enough to skip the sentiment LLM',
            ops: [textTurn('efficient'), queryEmbedding(EMBED_MODEL, TOK.EMB_QUERY_SHORT)],
        },
        MSG_faq_branch: {
            label: 'One customer message answered from the FAQ branch',
            ops: [faqBranchTurn()],
        },
        MSG_greeting: {
            label: 'One greeting (regex fast-path)',
            ops: [op({ operation: 'greeting_regex_fastpath', model: M.LITE, requestCount: 0, measurementSource: SC.T, confidence: 'high', notes: 'zero model calls' })],
        },
        MSG_image: {
            label: 'One customer message with one image',
            ops: [photoMessageTurn('expected'), sentimentCall()],
        },
        MSG_fallback_pro: {
            label: 'One customer message where gemini-lite fails and gemini-pro answers',
            ops: [
                { ...textTurn('expected', M.PRO), operation: 'chat_reply_text_expected_FALLBACK_pro', fallbackCalls: 1 },
                queryEmbedding(EMBED_MODEL), sentimentCall(),
            ],
        },
        MSG_fallback_openai: {
            label: 'One customer message where BOTH Gemini tiers fail and gpt-4.1-mini answers',
            ops: [
                { ...op({ operation: 'chat_reply_text_expected_FALLBACK_openai', model: M.OAI, inputTokens: SC.MEASURED_EXPECTED_TURN_INPUT_OAI, outputTokens: TOK.OUT_TYPICAL, fallbackCalls: 2, measurementSource: SC.P, confidence: 'high', notes: 'Measured prompt_tokens=2125, cached_tokens=0 on a real gpt-4.1-mini call' }) },
                queryEmbedding(EMBED_MODEL), sentimentCall(),
            ],
        },
        MSG_worst_retry_path: {
            label: 'Worst reasonable path: all three providers billed for one turn',
            ops: [
                { ...textTurn('heavy'), operation: 'chat_reply_lite_billed_then_client_timeout', notes: 'Server completed and billed; the 30s client AbortSignal fired first, so llm.service treated it as a failure' },
                { ...textTurn('heavy', M.PRO), operation: 'chat_reply_pro_billed_then_timeout', fallbackCalls: 1 },
                op({ operation: 'chat_reply_openai_final', model: M.OAI, inputTokens: SC.MEASURED_EXPECTED_TURN_INPUT_OAI, outputTokens: TOK.OUT_LONG, fallbackCalls: 2, measurementSource: SC.P, confidence: 'medium' }),
                queryEmbedding(EMBED_MODEL), sentimentCall(TOK.USER_LONG),
            ],
        },
    };
}

/** Product ingestion (Phase 5). */
function productScenarios() {
    const visionOpenAI = (imageTokens, label) => op({
        operation: label,
        model: M.OAI,
        inputTokens: TOK.PRODUCT_AI_SYS + imageTokens + 20,
        outputTokens: TOK.PRODUCT_AI_OUT,
        imageCount: 1,
        measurementSource: SC.P,
        confidence: 'high',
        notes: 'product-ai.service.js:66 forces preferredProvider:"openai". Only images[0] is analysed — images 2-5 are never sent to any model.',
    });
    const embed = () => op({
        operation: 'embed_product_doc',
        model: EMBED_MODEL,
        embeddingTokens: TOK.EMB_PRODUCT_DOC,
        measurementSource: SC.T,
        confidence: 'high',
        notes: 'One embedding for the whole product. No chunking, no overlap (product-embedding.service.buildEmbeddingText)',
    });

    return {
        PROD_upload_asbuilt: {
            label: 'Product upload with 5 images — AS CURRENTLY SHIPPED',
            description: 'The Add Product form collects up to 5 File objects but never attaches them to the payload and there is no upload endpoint, so the product is created with no images. processProduct() returns early at "no images to process".',
            ops: [embed()],
        },
        PROD_upload_5img_intended: {
            label: 'Product upload with 5 images — INTENDED behaviour once upload is wired',
            description: 'Vision runs on image[0] only; the other four cost nothing in model tokens.',
            ops: [visionOpenAI(TOK.IMAGE_OPENAI_1080x1440, 'vision_product_attrs_1080x1440'), embed()],
        },
        PROD_upload_5img_compressed: {
            label: 'Product upload with 5 images — intended, images pre-compressed to 512px',
            ops: [visionOpenAI(TOK.IMAGE_OPENAI_512, 'vision_product_attrs_512'), embed()],
        },
        PROD_edit_text_only: {
            label: 'Simple text edit (name/price/description) — re-embed only',
            description: 'product.service.js:311 re-embeds unconditionally, even when nothing embeddable changed.',
            ops: [embed()],
        },
        PROD_edit_single_field: {
            label: 'One non-embedded field changes (e.g. quantity)',
            description: 'Still triggers a full re-embed — the code does not diff the embedding text.',
            ops: [embed()],
        },
        PROD_replace_one_image: {
            label: 'Replace one image',
            description: 'product.service.js:305 — ANY change to images/image_url re-runs the whole vision pipeline on images[0].',
            ops: [visionOpenAI(TOK.IMAGE_OPENAI_1080x1440, 'vision_product_attrs_1080x1440'), embed()],
        },
        PROD_replace_all_images: {
            label: 'Replace all five images',
            description: 'Identical cost to replacing one — still a single vision call on images[0].',
            ops: [visionOpenAI(TOK.IMAGE_OPENAI_1080x1440, 'vision_product_attrs_1080x1440'), embed()],
        },
        PROD_delete_recreate: {
            label: 'Delete then recreate the product',
            description: 'Delete costs one Qdrant DELETE (no model call); recreate pays full ingestion again.',
            ops: [visionOpenAI(TOK.IMAGE_OPENAI_1080x1440, 'vision_product_attrs_1080x1440'), embed()],
        },
        PROD_full_reindex_200: {
            label: 'Full shop reindex (reindex:qdrant, 200 products + 12 FAQs + business info)',
            description: 'Manual script only — not scheduled. Re-embeds every product; does NOT re-run vision.',
            ops: [
                op({ operation: 'embed_products_x200', model: EMBED_MODEL, requestCount: 200, embeddingTokens: TOK.EMB_PRODUCT_DOC * 200, measurementSource: SC.T, confidence: 'high' }),
                op({ operation: 'embed_faqs_x12', model: EMBED_MODEL, requestCount: 12, embeddingTokens: TOK.EMB_FAQ_DOC * 12, measurementSource: SC.T, confidence: 'high' }),
            ],
        },
    };
}

// ───────────────────────────────────────────────────────────────────────────
// Costing
// ───────────────────────────────────────────────────────────────────────────

function costOps(ops) {
    const rows = [];
    const totals = {
        requestCount: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0,
        embeddingTokens: 0, imageCount: 0, retries: 0, fallbackCalls: 0, costUsd: 0,
        byProvider: {}, unknownCalls: 0,
    };

    for (const o of ops) {
        const c = calculateCost({
            model: o.model,
            inputTokens: o.inputTokens,
            cachedInputTokens: o.cachedInputTokens,
            outputTokens: o.outputTokens,
            reasoningTokens: o.reasoningTokens,
            embeddingTokens: o.embeddingTokens,
        });
        const multiplier = o.requestCount === 0 ? 0 : 1;
        const costUsd = c.costUsd == null ? null : c.costUsd * multiplier;
        if (costUsd == null) totals.unknownCalls++;

        const unitPrice = c.rates
            ? (o.embeddingTokens ? `${c.rates.input}/1M embed` : `${c.rates.input}in / ${c.rates.output}out per 1M`)
            : 'n/a';

        rows.push({
            operation: o.operation,
            provider: c.provider || 'local',
            model: o.model,
            requestCount: o.requestCount,
            inputTokens: o.requestCount ? o.inputTokens : 0,
            cachedInputTokens: o.requestCount ? o.cachedInputTokens : 0,
            outputTokens: o.requestCount ? o.outputTokens : 0,
            reasoningTokens: o.reasoningTokens,
            embeddingTokens: o.requestCount ? o.embeddingTokens : 0,
            imageCount: o.requestCount ? o.imageCount : 0,
            retries: o.retries,
            fallbackCalls: o.fallbackCalls,
            unitPrice,
            costUsd: costUsd ?? null,
            costBdt: costUsd == null ? null : costUsd * FX,
            measurementSource: o.measurementSource || SC.S,
            confidence: o.confidence || 'medium',
            notes: o.notes || '',
        });

        totals.requestCount += o.requestCount;
        for (const k of ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningTokens', 'embeddingTokens', 'imageCount']) {
            totals[k] += o.requestCount ? o[k] : 0;
        }
        totals.retries += o.retries;
        totals.fallbackCalls += o.fallbackCalls;
        totals.costUsd += costUsd || 0;

        const key = o.embeddingTokens ? `${c.provider || 'local'}-embedding` : (c.provider || 'local');
        totals.byProvider[key] = (totals.byProvider[key] || 0) + (costUsd || 0);
    }

    totals.costBdt = totals.costUsd * FX;
    return { rows, totals };
}

// ───────────────────────────────────────────────────────────────────────────
// Monthly unit economics
// ───────────────────────────────────────────────────────────────────────────

function monthlyModel(convCostUsd, opts) {
    const { conversations, fallbackRate, convCostFallbackUsd, productAddUsd, productEditUsd } = opts;
    const base = conversations * convCostUsd;
    // A fallback turn replaces one of ~6 billed turns in a conversation, so the
    // uplift is (fallback conversation cost - normal) applied at the fallback rate.
    const fallbackUplift = conversations * fallbackRate * Math.max(0, convCostFallbackUsd - convCostUsd);
    const products = ASSUMPTIONS.productsAddedPerMonth * productAddUsd
        + ASSUMPTIONS.productEditsPerMonth * productEditUsd;
    const aiVariable = base + fallbackUplift + products;
    const infraAttributable = conversations * INFRA_PER_CONVERSATION_USD;
    return {
        conversations,
        fallbackRate,
        conversationsUsd: base,
        fallbackUpliftUsd: fallbackUplift,
        productIngestionUsd: products,
        aiVariableUsd: aiVariable,
        infraAttributableUsd: infraAttributable,
        totalVariableUsd: aiVariable + infraAttributable,
        totalVariableBdt: (aiVariable + infraAttributable) * FX,
        costPerConversationUsd: conversations ? (aiVariable + infraAttributable) / conversations : 0,
        costPerConversationBdt: conversations ? ((aiVariable + infraAttributable) / conversations) * FX : 0,
    };
}

/**
 * Marginal infra per conversation. Everything runs on one fixed-price droplet,
 * so the true marginal cost of one more conversation is dominated by storage
 * growth and egress, both tiny. Derived, not guessed:
 *   ~20 rows in messages/conversations at ~1.5 KB total, one Qdrant query (no
 *   new vector), a handful of Redis keys that expire, and the Meta attachment
 *   download (counted separately under imagesProcessed).
 */
const INFRA_PER_CONVERSATION_USD = 0.00002;

// ───────────────────────────────────────────────────────────────────────────
// Assembly
// ───────────────────────────────────────────────────────────────────────────

function build() {
    const conversations = conversationScenarios();
    const messages = messageScenarios();
    const products = productScenarios();

    const costed = { conversations: {}, messages: {}, products: {} };
    const csvRows = [];

    const addGroup = (groupKey, defs) => {
        for (const [id, def] of Object.entries(defs)) {
            const { rows, totals } = costOps(def.ops);
            costed[groupKey][id] = {
                id,
                label: def.label,
                description: def.description || null,
                customerMessages: def.customerMessages ?? null,
                aiReplies: def.aiReplies ?? null,
                billableConversations: def.billableConversations ?? null,
                imagesProcessed: def.imagesProcessed ?? null,
                operations: rows,
                totals,
                costPerCustomerMessageUsd: def.customerMessages ? totals.costUsd / def.customerMessages : null,
                costPerAiReplyUsd: def.aiReplies ? totals.costUsd / def.aiReplies : null,
                costPerBillableConversationUsd: def.billableConversations ? totals.costUsd / def.billableConversations : null,
            };
            for (const r of rows) csvRows.push({ scenario: id, ...r });
        }
    };

    addGroup('conversations', conversations);
    addGroup('messages', messages);
    addGroup('products', products);

    // ── Monthly scenarios ───────────────────────────────────────────────────
    const convA = costed.conversations.A_efficient.totals.costUsd;
    const convB = costed.conversations.B_expected.totals.costUsd;
    const convC = costed.conversations.C_heavy.totals.costUsd;
    const prodAdd = costed.products.PROD_upload_asbuilt.totals.costUsd;
    const prodAddIntended = costed.products.PROD_upload_5img_intended.totals.costUsd;
    const prodEdit = costed.products.PROD_edit_text_only.totals.costUsd;

    const VOLUMES = [50, 100, 300, 500, 1000];
    const FALLBACK_RATES = [0.05, 0.10, 0.25];

    const monthly = {};
    for (const [tier, convCost] of [['efficient', convA], ['expected', convB], ['heavy', convC]]) {
        monthly[tier] = {};
        for (const rate of FALLBACK_RATES) {
            monthly[tier][`fallback_${Math.round(rate * 100)}pct`] = VOLUMES.map((v) =>
                monthlyModel(convCost, {
                    conversations: v,
                    fallbackRate: rate,
                    convCostFallbackUsd: convCost + (costed.messages.MSG_fallback_pro.totals.costUsd - costed.messages.MSG_normal.totals.costUsd),
                    productAddUsd: prodAdd,
                    productEditUsd: prodEdit,
                }));
        }
    }

    // Image-heavy merchant: every conversation looks like scenario C.
    monthly.image_heavy_merchant = {
        fallback_10pct: VOLUMES.map((v) => monthlyModel(convC, {
            conversations: v,
            fallbackRate: 0.10,
            convCostFallbackUsd: convC + (costed.messages.MSG_fallback_pro.totals.costUsd - costed.messages.MSG_normal.totals.costUsd),
            productAddUsd: prodAddIntended,
            productEditUsd: prodEdit,
        })),
    };

    // ── Plan economics ──────────────────────────────────────────────────────
    const revenueUsdMonthly = PLAN.priceBdtMonthly / FX;
    const includedConversations = PLAN.conversationsLimit;

    // A fallback turn escalates gemini-lite → gemini-pro for ONE turn in the
    // conversation. Uplift is measured, not assumed.
    const fallbackUpliftPerConv = costed.messages.MSG_fallback_pro.totals.costUsd
        - costed.messages.MSG_normal.totals.costUsd;
    const effectiveConvCost = (base, fallbackRate) => base + fallbackRate * fallbackUpliftPerConv;

    const infraShare = ASSUMPTIONS.fixedInfraUsdPerMonth / ASSUMPTIONS.merchantsSharingInfra;

    const marginAt = (baseConvUsd, convCount, productUsd, fallbackRate) => {
        const perConv = effectiveConvCost(baseConvUsd, fallbackRate);
        const variable = convCount * perConv + convCount * INFRA_PER_CONVERSATION_USD + productUsd;
        const grossUsd = revenueUsdMonthly - variable;
        return {
            conversations: convCount,
            fallbackRate,
            effectiveCostPerConversationUsd: perConv,
            effectiveCostPerConversationBdt: perConv * FX,
            variableCostUsd: variable,
            variableCostBdt: variable * FX,
            revenueUsdMonthly,
            revenueBdtMonthly: PLAN.priceBdtMonthly,
            grossMarginUsd: grossUsd,
            grossMarginPct: (grossUsd / revenueUsdMonthly) * 100,
            grossMarginAfterInfraUsd: grossUsd - infraShare,
            grossMarginAfterInfraPct: ((grossUsd - infraShare) / revenueUsdMonthly) * 100,
            fixedInfraShareUsd: infraShare,
        };
    };

    const productMonthlyUsd = ASSUMPTIONS.productsAddedPerMonth * prodAdd + ASSUMPTIONS.productEditsPerMonth * prodEdit;
    const breakEven = (baseConvUsd, fallbackRate, extraFixedUsd = 0, revenue = revenueUsdMonthly) =>
        Math.floor((revenue - productMonthlyUsd - extraFixedUsd)
            / (effectiveConvCost(baseConvUsd, fallbackRate) + INFRA_PER_CONVERSATION_USD));

    const byFallback = (baseConvUsd, convCount) => Object.fromEntries(
        [0, 0.05, 0.10, 0.25].map((r) => [`fallback_${Math.round(r * 100)}pct`, marginAt(baseConvUsd, convCount, productMonthlyUsd, r)]));

    const planEconomics = {
        plan: PLAN,
        fx: { usdPerBdt: FX, asOf: PRICING.fx.asOf, source: PRICING.fx.source },
        revenueUsdMonthly,
        includedConversations,
        planHeadlineBdtPerConversation: PLAN.priceBdtMonthly / PLAN.conversationsLimit,
        fallbackUpliftPerConversationUsd: fallbackUpliftPerConv,
        atPlanLimit: {
            efficient: byFallback(convA, PLAN.conversationsLimit),
            expected: byFallback(convB, PLAN.conversationsLimit),
            heavy: byFallback(convC, PLAN.conversationsLimit),
        },
        breakEvenConversations: {
            efficient_5pct: breakEven(convA, 0.05),
            expected_0pct: breakEven(convB, 0),
            expected_5pct: breakEven(convB, 0.05),
            expected_10pct: breakEven(convB, 0.10),
            expected_25pct: breakEven(convB, 0.25),
            heavy_5pct: breakEven(convC, 0.05),
            heavy_25pct: breakEven(convC, 0.25),
            imageHeavy_10pct: breakEven(convC, 0.10),
            expected_after_fixed_infra: breakEven(convB, 0.05, infraShare),
            expected_after_psp_and_vat: breakEven(convB, 0.05, infraShare,
                (revenueUsdMonthly * (1 - ASSUMPTIONS.paymentFeePct)) / (1 + ASSUMPTIONS.vatPct)),
        },
        // Top-ups are sold at a DISCOUNT to the base plan's per-conversation rate,
        // so they are the thinnest part of the pricing surface. Priced against all
        // three usage tiers because a merchant who buys a top-up is, by definition,
        // a heavy user.
        topupEconomics: Object.fromEntries(Object.entries(PLAN.topups).map(([code, [convs, bdt]]) => {
            const revUsd = bdt / FX;
            const tier = (base, rate) => {
                const cost = convs * effectiveConvCost(base, rate);
                return { costUsd: cost, costBdt: cost * FX, grossMarginPct: ((revUsd - cost) / revUsd) * 100 };
            };
            return [code, {
                conversations: convs,
                priceBdt: bdt,
                revenueUsd: revUsd,
                effectiveBdtPerConversation: bdt / convs,
                vsBasePlanBdtPerConversation: PLAN.priceBdtMonthly / PLAN.conversationsLimit,
                efficient: tier(convA, 0.05),
                expected: tier(convB, 0.05),
                heavy: tier(convC, 0.05),
                heavy_25pct_fallback: tier(convC, 0.25),
            }];
        })),
    };

    // ── Sensitivity (Phase 8) ───────────────────────────────────────────────
    const sensitivity = sensitivityModel(convB, costed);

    return {
        generatedAt: new Date().toISOString(),
        pricingVersion: PRICING.version,
        pricingRetrievedAt: PRICING.retrievedAt,
        fx: PRICING.fx,
        embeddingModelPriced: EMBED_MODEL,
        assumptions: { ...ASSUMPTIONS, infraPerConversationUsd: INFRA_PER_CONVERSATION_USD },
        scenarios: costed,
        monthly,
        planEconomics,
        sensitivity,
        csvRows,
    };
}

/** Recompute scenario B under one lever at a time. */
function sensitivityModel(baselineUsd, costed) {
    const b = costed.conversations.B_expected;
    const lever = (name, transform, note) => {
        const ops = conversationScenarios().B_expected.ops.map(transform);
        const { totals } = costOps(ops);
        return {
            lever: name,
            baselineUsd,
            newUsd: totals.costUsd,
            deltaUsd: totals.costUsd - baselineUsd,
            savingPct: ((baselineUsd - totals.costUsd) / baselineUsd) * 100,
            note,
        };
    };

    const scaleOut = (f) => (o) => ({ ...o, outputTokens: Math.round(o.outputTokens * f) });
    const scaleGrounding = (f) => (o) => (o.operation?.startsWith('chat_reply_text') || o.operation?.startsWith('chat_reply_image'))
        ? { ...o, inputTokens: Math.round(o.inputTokens - TOK.GROUND_5P_4RAG * (1 - f)) } : o;

    return [
        lever('output_minus_25pct', scaleOut(0.75), 'Tighten the persona reply-length rule from "1-3 sentences" to "1-2".'),
        lever('rag_context_minus_25pct', scaleGrounding(0.75), 'limit 4 → 3 RAG chunks and 5 → 4 products.'),
        lever('history_summarised_at_4_turns', (o) => (o.operation?.startsWith('chat_reply_text') || o.operation?.startsWith('chat_reply_image'))
            ? { ...o, inputTokens: o.inputTokens - (TOK.HIST_8 - TOK.HIST_4) } : o,
            'Replace turns 1-6 with a running summary. Saves little: history is only ~6% of the prompt.'),
        lever('prompt_caching_working', (o) => (o.model === M.LITE && o.inputTokens > 1000)
            ? { ...o, cachedInputTokens: TOK.SYS_TEXT_5FAQ } : o,
            'Requires a >=4096-token cacheable prefix on a live model. Today the cache is never created.'),
        lever('image_path_uses_top5_faqs', (o) => o.operation?.startsWith('chat_reply_image')
            ? { ...o, inputTokens: o.inputTokens - (TOK.SYS_IMAGE_FULLFAQ_12 - TOK.SYS_TEXT_5FAQ) } : o,
            'One-line change: pass relevantFaqs on the image path too (ai-chatbot.controller.js:267).'),
        lever('drop_second_image_send', (o) => o.operation?.startsWith('chat_reply_image')
            ? { ...o, inputTokens: o.inputTokens - TOK.IMAGE_GEMINI, imageCount: 0 } : o,
            'Reuse the phase-1 extraction result instead of re-attaching the image to the final call.'),
        lever('sentiment_keyword_only', (o) => o.operation === 'sentiment_classify' ? { ...o, requestCount: 0 } : o,
            'Drop the LLM sentiment tier; keep the keyword classifier.'),
        lever('no_customer_rephrase', (o) => o.operation === 'chat_reply_customer_rephrase' ? { ...o, requestCount: 0 } : o,
            'Every answer lands first time — the ceiling on answer-quality improvements.'),
        lever('images_compressed_to_384px', (o) => o.imageCount
            ? { ...o, inputTokens: o.inputTokens + (TOK.IMAGE_GEMINI_384 - TOK.IMAGE_GEMINI) * o.imageCount } : o,
            'MEASURED NEGATIVE: Gemini 3.1 Flash-Lite charges 1090 tokens for 384x384 vs 1064 for 1080x1440. Compression makes it WORSE.'),
    ];
}

// ───────────────────────────────────────────────────────────────────────────
// Output
// ───────────────────────────────────────────────────────────────────────────

const CSV_COLUMNS = [
    'scenario', 'operation', 'provider', 'model', 'requestCount', 'inputTokens', 'cachedInputTokens',
    'outputTokens', 'reasoningTokens', 'embeddingTokens', 'imageCount', 'retries', 'fallbackCalls',
    'unitPrice', 'costUsd', 'costBdt', 'measurementSource', 'confidence', 'notes',
];

const csvCell = (v) => {
    if (v == null) return '';
    const s = typeof v === 'number'
        ? (Number.isInteger(v) ? String(v) : v.toFixed(8))
        : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function toCsv(rows) {
    return [CSV_COLUMNS.join(','), ...rows.map((r) => CSV_COLUMNS.map((c) => csvCell(r[c])).join(','))].join('\n');
}

function main() {
    const model = build();

    if (process.argv.includes('--stdout')) {
        process.stdout.write(`${JSON.stringify(model, null, 2)}\n`);
        return;
    }

    fs.mkdirSync(OUT_DIR, { recursive: true });
    const { csvRows, ...json } = model;
    fs.writeFileSync(path.join(OUT_DIR, 'AI_COST_MODEL.csv'), `${toCsv(csvRows)}\n`);
    fs.writeFileSync(path.join(OUT_DIR, 'AI_COST_MODEL.json'), `${JSON.stringify(json, null, 2)}\n`);

    const c = json.scenarios.conversations;
    const m = json.scenarios.messages;
    const p = json.scenarios.products;
    const usd = (n) => (n == null ? 'n/a' : `$${n.toFixed(6)}`);
    const bdt = (n) => (n == null ? 'n/a' : `৳${(n * FX).toFixed(4)}`);

    console.log(`\nPricing table ${json.pricingVersion} (retrieved ${json.pricingRetrievedAt}) · FX 1 USD = ${FX} BDT`);
    console.log(`Embeddings priced as: ${json.embeddingModelPriced}\n`);
    console.log('PER-MESSAGE');
    for (const [k, v] of Object.entries(m)) console.log(`  ${k.padEnd(28)} ${usd(v.totals.costUsd).padStart(12)}  ${bdt(v.totals.costUsd).padStart(11)}   ${v.totals.requestCount} calls`);
    console.log('\nPER 20-MESSAGE CONVERSATION (= 1 billable conversation)');
    for (const [k, v] of Object.entries(c)) console.log(`  ${k.padEnd(28)} ${usd(v.totals.costUsd).padStart(12)}  ${bdt(v.totals.costUsd).padStart(11)}   ${v.totals.requestCount} calls, ${v.totals.inputTokens} in / ${v.totals.outputTokens} out`);
    console.log('\nPRODUCT INGESTION');
    for (const [k, v] of Object.entries(p)) console.log(`  ${k.padEnd(32)} ${usd(v.totals.costUsd).padStart(12)}  ${bdt(v.totals.costUsd).padStart(11)}`);
    console.log('\nMONTHLY (expected conversation, 5% fallback)');
    for (const r of json.monthly.expected.fallback_5pct) {
        console.log(`  ${String(r.conversations).padStart(5)} conv  AI $${r.aiVariableUsd.toFixed(4)}  total $${r.totalVariableUsd.toFixed(4)}  = ৳${r.totalVariableBdt.toFixed(2)}  (৳${r.costPerConversationBdt.toFixed(4)}/conv)`);
    }
    const pe = json.planEconomics;
    console.log(`\nGROWTH plan: ৳${pe.plan.priceBdtMonthly}/mo = $${pe.revenueUsdMonthly.toFixed(2)} for ${pe.includedConversations} conversations`);
    console.log(`  Headline ৳${pe.planHeadlineBdtPerConversation.toFixed(2)}/conv at the included allowance`);
    for (const tier of ['efficient', 'expected', 'heavy']) {
        const r = pe.atPlanLimit[tier].fallback_5pct;
        const r25 = pe.atPlanLimit[tier].fallback_25pct;
        console.log(`  ${pe.plan.conversationsLimit} conv ${tier.padEnd(9)} @5% fallback: $${r.variableCostUsd.toFixed(4)} → GM ${r.grossMarginPct.toFixed(1)}% (after infra ${r.grossMarginAfterInfraPct.toFixed(1)}%) | @25%: GM ${r25.grossMarginPct.toFixed(1)}%`);
    }
    console.log('  Break-even conversations/month:');
    for (const [k, v] of Object.entries(pe.breakEvenConversations)) console.log(`    ${k.padEnd(30)} ${v}`);
    console.log(`\nWrote ${path.join(OUT_DIR, 'AI_COST_MODEL.csv')}`);
    console.log(`Wrote ${path.join(OUT_DIR, 'AI_COST_MODEL.json')}\n`);
}

if (require.main === module) main();

module.exports = { build, toCsv, CSV_COLUMNS, PLAN, ASSUMPTIONS, INFRA_PER_CONVERSATION_USD };
