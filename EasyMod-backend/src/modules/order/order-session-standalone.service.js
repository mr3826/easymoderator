const { v4: uuidv4 } = require('uuid');
const { DataTypes, Op } = require('sequelize');
const { sequelize } = require('../../utils/database/database-setup');
const productSearch = require('../product/product-search.service');

// Lazy-loaded to avoid circular dependency at module init
const getOrderServiceImports = () => require('./order.service');
const ShopEntity = require('../shop/shop.entity');
const PaymentConfigEntity = require('../payment/payment-config.entity');
const CustomerEntity = require('../customer/customer.entity');
// P0-2: screenshot OCR verification is no longer wired into checkout —
// payment truth comes only from merchant confirmation or verified webhooks.
const { isNegatedMutation, isQuestionShaped } = require('../ai/intent/stage2-rules');
const { photoMatchEnabled } = require('../ai/vision-policy.service');
const courierDispatchClaims = require('../delivery/courier-dispatch-claim.service');
const finiteNumberOrNull = (value) => (
    value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value))
        ? Number(value)
        : null
);
const safeErrorCode = (error, fallback = 'ORDER_SESSION_ERROR') => {
    const code = typeof error?.code === 'string' ? error.code.toUpperCase() : '';
    if (/^[A-Z][A-Z0-9_:-]{0,63}$/.test(code)) return code;
    const status = Number(error?.status ?? error?.statusCode);
    return status >= 400 && status <= 599 ? `HTTP_${status}` : fallback;
};

const normalizeSessionChannel = (channel) => (
    channel === 'facebook' ? 'messenger' : (channel || 'messenger')
);

const isMetaSessionChannel = (channel) => ['messenger', 'instagram'].includes(normalizeSessionChannel(channel));

const customerScopeError = (message = 'Customer does not belong to this shop and Page') => {
    const error = new Error(message);
    error.statusCode = 403;
    error.code = 'CUSTOMER_SCOPE_MISMATCH';
    return error;
};

async function findScopedSessionCustomer({ shopId, customerId, customerChannelId, metaChannelId, channel }) {
    if (!customerId) return null;
    if (isMetaSessionChannel(channel) && !metaChannelId) {
        throw customerScopeError('Messenger/Instagram Page context is required for an order session');
    }
    if (typeof CustomerEntity.findOne !== 'function') {
        throw customerScopeError('Customer context is unavailable');
    }

    const where = {
        id: customerId,
        shop_id: shopId,
        channel_type: normalizeSessionChannel(channel),
        ...(customerChannelId ? { channel_user_id: String(customerChannelId) } : {}),
        ...(metaChannelId ? { meta_channel_id: metaChannelId } : {}),
    };
    const customer = await CustomerEntity.findOne({ where });
    if (!customer) throw customerScopeError();
    return customer;
}

async function resolveSessionCustomerId({ shopId, customerId, customerChannelId, metaChannelId, channel }) {
    if (isMetaSessionChannel(channel) && !metaChannelId) {
        throw customerScopeError('Messenger/Instagram Page context is required for an order session');
    }
    if (typeof CustomerEntity.findOne !== 'function') {
        if (customerId) throw customerScopeError('Customer context is unavailable');
        return null;
    }

    const where = {
        shop_id: shopId,
        channel_type: normalizeSessionChannel(channel),
        channel_user_id: String(customerChannelId),
        ...(metaChannelId ? { meta_channel_id: metaChannelId } : {}),
    };
    const customer = await CustomerEntity.findOne({ where });
    if (customerId && (!customer || String(customer.id) !== String(customerId))) {
        throw customerScopeError();
    }
    if (isMetaSessionChannel(channel) && !customer) throw customerScopeError();
    return customer?.id || customerId || null;
}

// Define OrderSession model directly
const OrderSession = sequelize.define('OrderSession', {
    id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true
    },
    shop_id: {
        type: DataTypes.UUID,
        allowNull: false
        // Removed foreign key constraint for now
    },
    customer_id: {
        type: DataTypes.UUID,
        allowNull: true
    },
    // Messenger/Instagram identifiers are Page-scoped; never resume a
    // session from another Meta channel owned by the same shop.
    meta_channel_id: {
        type: DataTypes.UUID,
        allowNull: true,
    },
    customer_channel_id: {
        type: DataTypes.STRING,
        allowNull: false
    },
    channel: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: 'messenger'
    },
    current_step: {
        type: DataTypes.STRING(50),
        allowNull: false,
        defaultValue: 'INITIAL'
    },
    step_data: {
        type: DataTypes.JSON,
        allowNull: true,
        defaultValue: {}
    },
    product_info: {
        type: DataTypes.JSON,
        allowNull: true,
        defaultValue: null
    },
    status: {
        // P+04: SUSPENDED preserves step_data (cart + collected fields) when a
        // human handoff or order-status interruption pauses the checkout.
        type: DataTypes.ENUM('ACTIVE', 'SUSPENDED', 'COMPLETED', 'CANCELLED', 'ABANDONED'),
        allowNull: false,
        defaultValue: 'ACTIVE'
    },
    automation_mode: {
        type: DataTypes.ENUM('FULL_AUTO', 'DRAFT', 'NOTIFY_ONLY'),
        allowNull: false,
        defaultValue: 'DRAFT'
    },
    confidence_threshold: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 60
    },
    last_activity_at: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW
    },
    expires_at: {
        type: DataTypes.DATE,
        allowNull: true
    },
    created_order_id: {
        type: DataTypes.UUID,
        allowNull: true
        // Removed foreign key constraint for now
    },
    final_summary: {
        type: DataTypes.TEXT,
        allowNull: true
    },
    metadata: {
        type: DataTypes.JSON,
        allowNull: true,
        defaultValue: {}
    }
}, {
    tableName: 'order_sessions',
    underscored: true,
    timestamps: true
});

// Table is managed by migrations — no sync needed here

// P+04: steps whose expected answer is identity data, never a question. A
// question-shaped answer here is routed back as a deferral (the pipeline
// answers it) instead of being stored as the field value. NOTES/ADD_MORE are
// intentionally NOT guarded — any text is a legitimate free-form value there.
const QUESTION_PROTECTED_STEPS = new Set([
    'COLLECTING_NAME', 'COLLECTING_PHONE', 'COLLECTING_ADDRESS', 'COLLECTING_ZONE',
]);

// ─── Delivery zone config ─────────────────────────────────────────────────────
const ZONE_KEYS = ['inside_dhaka', 'sub_dhaka', 'outside_dhaka'];
const ZONE_LABELS = {
    inside_dhaka:  { bn: 'ঢাকার ভেতরে', en: 'Inside Dhaka' },
    sub_dhaka:     { bn: 'ঢাকার কাছাকাছি', en: 'Sub-Dhaka' },
    outside_dhaka: { bn: 'ঢাকার বাইরে', en: 'Outside Dhaka' }
};
const DEFAULT_ZONE_CHARGES = { inside_dhaka: 60, sub_dhaka: 80, outside_dhaka: 120 };

// ─── Zone auto-detection keywords ─────────────────────────────────────────────
// Map a free-text address to a delivery zone so the bot can apply the charge
// itself instead of always asking "inside or outside Dhaka?" (founder 2026-06-13:
// detect from the address; only ask when unsure). Lowercased substring match —
// best-effort and fail-safe: no confident hit ⇒ fall back to asking.
const ZONE_AREA_KEYWORDS = {
    // Dhaka-city thanas / neighbourhoods → inside_dhaka
    inside_dhaka: [
        'mirpur', 'uttara', 'dhanmondi', 'dhanmandi', 'gulshan', 'banani', 'mohammadpur',
        'motijheel', 'badda', 'rampura', 'bashundhara', 'baridhara', 'tejgaon', 'farmgate',
        'mohakhali', 'malibagh', 'khilgaon', 'jatrabari', 'jatra bari', 'wari', 'lalbagh',
        'kotwali', 'paltan', 'shahbag', 'shahbagh', 'new market', 'newmarket', 'azimpur',
        'shyamoli', 'kalabagan', 'panthapath', 'kakrail', 'shantinagar', 'mugda', 'khilkhet',
        'cantonment', 'agargaon', 'kafrul', 'pallabi', 'kazipara', 'shewrapara', 'demra',
        'sabujbagh', 'hazaribagh', 'shyampur', 'gendaria', 'sutrapur', 'chawkbazar', 'bangshal',
        'nikunja', 'adabor', 'ramna', 'hatirjheel', 'gulistan', 'mouchak', 'banasree', 'banashree',
        'bashabo', 'maghbazar', 'moghbazar', 'kuril', 'vatara', 'jurain',
        'মিরপুর', 'উত্তরা', 'ধানমন্ডি', 'গুলশান', 'বনানী', 'মোহাম্মদপুর', 'মতিঝিল', 'বাড্ডা',
        'রামপুরা', 'বসুন্ধরা', 'বারিধারা', 'তেজগাঁও', 'ফার্মগেট', 'মহাখালী', 'মালিবাগ', 'খিলগাঁও',
        'যাত্রাবাড়ী', 'ওয়ারী', 'লালবাগ', 'পল্টন', 'শাহবাগ', 'আজিমপুর', 'শ্যামলী', 'কলাবাগান',
        'পান্থপথ', 'কাকরাইল', 'শান্তিনগর', 'মুগদা', 'খিলক্ষেত', 'ক্যান্টনমেন্ট', 'আগারগাঁও',
        'পল্লবী', 'বনশ্রী', 'বাসাবো', 'মগবাজার', 'গুলিস্তান',
    ],
    // Greater-Dhaka / suburbs → sub_dhaka
    sub_dhaka: [
        'savar', 'ashulia', 'keraniganj', 'dhamrai', 'nabinagar', 'tongi', 'gazipur',
        'narayanganj', 'fatullah', 'siddhirganj', 'rupganj', 'sonargaon', 'board bazar',
        'kaliakair', 'joydebpur', 'kanchpur', 'hemayetpur',
        'সাভার', 'আশুলিয়া', 'কেরানীগঞ্জ', 'ধামরাই', 'টঙ্গী', 'গাজীপুর', 'নারায়ণগঞ্জ',
        'ফতুল্লা', 'সিদ্ধিরগঞ্জ', 'রূপগঞ্জ', 'সোনারগাঁও', 'জয়দেবপুর',
    ],
    // Other districts / divisions → outside_dhaka
    outside_dhaka: [
        'chittagong', 'chattogram', 'sylhet', 'rajshahi', 'khulna', 'barisal', 'barishal',
        'rangpur', 'mymensingh', 'comilla', 'cumilla', 'kushtia', 'bogura', 'bogra', 'jessore',
        'jashore', 'dinajpur', 'cox', 'feni', 'noakhali', 'brahmanbaria', 'tangail', 'pabna',
        'sirajganj', 'narsingdi', 'faridpur', 'gopalganj', 'madaripur', 'shariatpur', 'jamalpur',
        'sherpur', 'netrokona', 'kishoreganj', 'manikganj', 'munshiganj', 'magura', 'jhenaidah',
        'chuadanga', 'meherpur', 'satkhira', 'bagerhat', 'narail', 'pirojpur', 'patuakhali',
        'bhola', 'barguna', 'gaibandha', 'kurigram', 'lalmonirhat', 'nilphamari', 'panchagarh',
        'thakurgaon', 'joypurhat', 'naogaon', 'natore', 'chapainawabganj', 'habiganj',
        'moulvibazar', 'sunamganj', 'lakshmipur', 'chandpur', 'khagrachari', 'rangamati', 'bandarban',
        'চট্টগ্রাম', 'সিলেট', 'রাজশাহী', 'খুলনা', 'বরিশাল', 'রংপুর', 'ময়মনসিংহ', 'কুমিল্লা',
        'কুষ্টিয়া', 'বগুড়া', 'যশোর', 'দিনাজপুর', 'কক্সবাজার', 'ফেনী', 'নোয়াখালী',
        'ব্রাহ্মণবাড়িয়া', 'টাঙ্গাইল', 'পাবনা', 'সিরাজগঞ্জ', 'নরসিংদী', 'ফরিদপুর', 'চাঁদপুর',
    ],
};
// Most-specific first: a named city neighbourhood wins over the generic word "Dhaka".
const ZONE_DETECT_ORDER = ['inside_dhaka', 'sub_dhaka', 'outside_dhaka'];

// ─── Payment gateway config ───────────────────────────────────────────────────
const GATEWAY_LABELS = {
    'cod':      { bn: 'ক্যাশ অন ডেলিভারি (COD)', en: 'Cash on Delivery (COD)' },
    'self-mfs': { bn: 'বিকাশ / নগদ (মোবাইল ব্যাংকিং)', en: 'bKash / Nagad (Mobile Banking)' }
};
// Payment status to use when creating the order per gateway
const GATEWAY_PAYMENT_STATUS = {
    'cod':      'unpaid',
    'self-mfs': 'pending'
};

// Reply in ONE language, matching the customer: Bengali for Bengali/Banglish/mixed,
// English only when the customer clearly writes English. (Founder feedback 2026-06-12:
// the order flow must never answer in Bengali AND English at once.)
const pickLang = (lang, bn, en) => (lang === 'en' ? en : bn);

const productInputPrompt = (lang, purpose = 'add') => {
    const photoEnabled = photoMatchEnabled();
    if (purpose === 'more') {
        return photoEnabled
            ? pickLang(lang, 'নাম লিখুন বা ছবি পাঠান', 'Send a name or photo')
            : pickLang(lang, 'পণ্যের নাম লিখুন', 'Send a product name');
    }
    if (purpose === 'not-found') {
        return photoEnabled
            ? pickLang(lang, 'পণ্যের নাম লিখুন বা ছবি পাঠান', 'Send the product name or a photo')
            : pickLang(lang, 'পণ্যের নাম লিখুন', 'Send the product name');
    }
    return photoEnabled
        ? pickLang(lang, 'নাম লিখুন বা ছবি পাঠান', 'Send the name or a photo')
        : pickLang(lang, 'পণ্যের নাম লিখুন', 'Send the product name');
};
const zoneLabel = (zone, lang) => (ZONE_LABELS[zone] ? pickLang(lang, ZONE_LABELS[zone].bn, ZONE_LABELS[zone].en) : zone);
const gatewayLabel = (gw, lang) => (GATEWAY_LABELS[gw] ? pickLang(lang, GATEWAY_LABELS[gw].bn, GATEWAY_LABELS[gw].en) : gw);

// Bengali (০-৯) + English digits, and the most common BD spoken quantities, → integer.
// Used by the COLLECTING_QUANTITY step so the bot verifies "koyta?" instead of
// silently assuming 1 piece (founder feedback 2026-06-12).
const BN_DIGITS = { '০': '0', '১': '1', '২': '2', '৩': '3', '৪': '4', '৫': '5', '৬': '6', '৭': '7', '৮': '8', '৯': '9' };
const QTY_WORDS = {
    ekta: 1, akta: 1, ektা: 1, একটা: 1, একটি: 1, ek: 1, এক: 1, one: 1, single: 1,
    duita: 2, duito: 2, dui: 2, duto: 2, দুইটা: 2, দুটি: 2, দুটো: 2, দুই: 2, two: 2,
    tinta: 3, tin: 3, তিনটা: 3, তিনটি: 3, তিন: 3, three: 3,
    charta: 4, char: 4, চারটা: 4, চারটি: 4, চার: 4, four: 4,
    pachta: 5, pach: 5, পাঁচটা: 5, পাঁচ: 5, five: 5,
};
const extractQuantity = (text) => {
    if (!text || typeof text !== 'string') return null;
    let t = text.toLowerCase().trim();
    // Normalise Bengali numerals to ASCII digits first.
    t = t.replace(/[০-৯]/g, (d) => BN_DIGITS[d] || d);
    // A bare/embedded number wins ("2", "2 ta", "2 piece", "ami 3 ta nibo").
    const num = t.match(/\d{1,2}/);
    if (num) {
        const n = parseInt(num[0], 10);
        if (n >= 1 && n <= 99) return n;
        return null;
    }
    // Otherwise look for a spoken-quantity word.
    for (const [word, value] of Object.entries(QTY_WORDS)) {
        if (new RegExp(`(^|\\s)${word}(\\s|$)`).test(t)) return value;
    }
    return null;
};

const normalizeAddMoreDecisionText = (text) => String(text || '')
    .replace(/[\u09E6-\u09EF]/g, (d) => BN_DIGITS[d] || d)
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[“”"]/g, ' ')
    .replace(/[,.!?;:।]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const BARE_CONFIRMATIONS = new Set([
    'yes', 'y', 'ok', 'okay', 'confirm', 'confirm korun', 'confirm koren',
    'confirm koro', 'order confirm', 'ha', 'haa', 'han', 'hae', 'ji', 'jwi',
    'জি', 'জ্বি', 'হ্যাঁ', 'ঠিক আছে', 'thik ache', 'thik ace', 'acha', 'accha',
    'আচ্ছা', 'done', 'hmm', 'হুম', 'কনফার্ম', 'কনফার্ম করুন',
]);

const CONFIRMATION_PHRASES = new Set([
    'order confirm korun',
    'order confirm koren',
    'order confirm koro',
    'ha nibo',
    'haa nibo',
    'confirm kore din',
    'confirm kore den',
    'yes please',
    'yes confirm',
    'send koro',
    'send koren',
    'pathao',
    'পাঠান',
    'দিন',
    'dien',
    'din',
    'nibo',
    'nibo bhai',
    'nilam',
    'নিব',
    'নিবো',
    'নিলাম',
    'order dibo',
    'order korbo',
    'order chai',
    'করব',
    'korbo',
    'agree',
    'জি',
    'জ্বি',
    'jwi',
]);

const NEGATION_TOKENS = new Set([
    'na', 'nah', 'nai', 'nei', 'না', 'নাই', 'নেই', "don't", 'dont', 'no',
]);

const normalizeConfirmationText = (text) => String(text || '')
    .normalize('NFC')
    .toLowerCase()
    .trim()
    .replace(/[\p{P}\p{S}\u200d]+$/gu, '')
    .replace(/\s+/g, ' ')
    .trim();

const containsConfirmationNegation = (normalized) => {
    const tokens = normalized.split(' ');
    return tokens.some(token => NEGATION_TOKENS.has(token)) || normalized.includes('do not');
};

const authorizeSessionMutation = async (session, actionType, payload, {
    conversationId,
    traceId,
    mutationsAllowed = true,
} = {}) => {
    const {
        canonicalJson,
        createProposedAction,
        deriveIdempotencyKey,
    } = require('../ai/contracts/action.contract');
    const { withEvidenceSnapshot } = require('../ai/contracts/evidence.contract');
    const { authorize } = require('../ai/action-gate');
    const tenantConversationId = conversationId || session.id;
    const tenantCustomerId = session.customer_id || session.customer_channel_id;
    const requestTraceId = traceId || `order-session:${session.id}:${actionType}`;
    const idempotencyKey = deriveIdempotencyKey([
        'order-session',
        actionType,
        session.shop_id,
        session.id,
        tenantConversationId,
        canonicalJson(payload),
    ]);
    const evidenceSnapshot = withEvidenceSnapshot({
        shopId: session.shop_id,
        conversationId: tenantConversationId,
        customerId: tenantCustomerId,
        sourceText: `${actionType}:${session.id}`,
    });
    const action = createProposedAction({
        requestedByAgent: 'OrderAgent',
        actionType,
        domain: 'ORDER',
        shopId: session.shop_id,
        conversationId: tenantConversationId,
        idempotencyKey,
        evidenceSnapshotHash: evidenceSnapshot.snapshotHash,
        payload,
    });
    const result = await authorize(action, {
        traceId: requestTraceId,
        tenant: {
            shopId: session.shop_id,
            channelId: session.channel || session.customer_channel_id,
            platform: 'META_MESSENGER',
            customerId: tenantCustomerId,
            conversationId: tenantConversationId,
        },
        tenantRecordsMatch: true,
        currentDomain: 'ORDER',
        domainHops: 0,
        expectedIdempotencyKey: idempotencyKey,
        idempotencyCommitted: false,
        evidenceSnapshot,
        materialStateRevalidated: true,
        customerConfirmationValid: true,
        merchantModeAllowsMutation: actionType === 'CREATE_ORDER' ? mutationsAllowed === true : true,
        costBudgetAvailable: true,
    });
    if (!result.authorized) throw new Error(`Action Gate denied ${actionType}: ${result.reasonCode}`);
    return {
        authorization: result.authorization,
        idempotencyKey,
        evidenceSnapshotHash: evidenceSnapshot.snapshotHash,
    };
};

const verifySessionMutationAuthorization = (session, actionType, gateResult) => {
    const { verifyAuthorization } = require('../ai/action-gate');
    if (!verifyAuthorization(gateResult.authorization, {
        actionType,
        shopId: session.shop_id,
        idempotencyKey: gateResult.idempotencyKey,
        evidenceSnapshotHash: gateResult.evidenceSnapshotHash,
    })) {
        throw new Error(`Action Gate authorization verification failed for ${actionType}`);
    }
};

class OrderSessionService {
    /**
     * Start a new order session
     */
    static async startOrderSession(data) {
        const {
            shop_id,
            customer_id,
            customer_channel_id,
            meta_channel_id = null,
            channel: inputChannel = null,
            platform = null,
            initial_message,
            entities = {},
            language = 'bn',            // 'bn' | 'en' | 'mixed' — single-language replies
            product_info: incomingProductInfo = null,
            product_candidates = null   // Fix 14: array of 2+ matching products → numbered picker
        } = data;
        let product_info = incomingProductInfo;
        const channel = inputChannel || platform || 'messenger';
        const resolvedCustomerId = await resolveSessionCustomerId({
            shopId: shop_id,
            customerId: customer_id,
            customerChannelId: customer_channel_id,
            metaChannelId: meta_channel_id,
            channel,
        });

        // Default AI settings
        const defaultAiSettings = {
            automation_mode: 'DRAFT',
            confidence_threshold: 60
        };

        // Check if there's already an active session for this customer
        const sessionWhere = {
            shop_id,
            customer_channel_id,
            status: 'ACTIVE',
            ...(resolvedCustomerId ? { customer_id: resolvedCustomerId } : {}),
        };
        const existingSession = await OrderSession.findOne({
            where: { ...sessionWhere, meta_channel_id: meta_channel_id || null },
            order: [['last_activity_at', 'DESC']],
        });

        if (existingSession) {
            // Resume existing session if it's not too old (24 hours)
            const hoursSinceLastActivity = (Date.now() - existingSession.last_activity_at) / (1000 * 60 * 60);
            if (hoursSinceLastActivity < 24) {
                return {
                    session_id: existingSession.id,
                    prompt: this.generateStepPrompt(existingSession.current_step, existingSession.step_data, existingSession.step_data?.language),
                    resumed: true
                };
            } else {
                // Mark old session as abandoned
                await existingSession.update({ status: 'ABANDONED' });
            }
        }

        // Fix 14: Multi-product candidates — start with SELECTING_PRODUCT step
        if (Array.isArray(product_candidates) && product_candidates.length >= 2) {
            const session = await OrderSession.create({
                id: uuidv4(),
                shop_id,
                customer_id: resolvedCustomerId,
                customer_channel_id,
                meta_channel_id,
                channel,
                current_step: 'SELECTING_PRODUCT',
                step_data: { initial_message, entities, language, product_candidates },
                product_info: null,
                automation_mode: 'DRAFT',
                confidence_threshold: 60,
                expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000)
            });
            return {
                session_id: session.id,
                prompt: OrderSessionService.buildProductSelectionPrompt(product_candidates, language),
                resumed: false
            };
        }

        // Stock gate: re-check live stock before starting order
        // product_info.id is set when the LLM identified a specific DB product
        if (product_info && product_info.id) {
            const stockCheck = await productSearch.checkStock(product_info.id, shop_id);
            if (!stockCheck.available) {
                return {
                    session_id: null,
                    prompt: this.buildOutOfStockPrompt(stockCheck.reason, product_info, language),
                    out_of_stock: true,
                    resumed: false
                };
            }
            // Refresh live price/stock from DB into product_info (prevents stale data)
            if (stockCheck.product) {
                product_info = {
                    ...product_info,
                    price:    stockCheck.product.price,
                    quantity: stockCheck.product.quantity,
                    stock_snapshot: stockCheck.product.track_quantity === true
                        ? finiteNumberOrNull(stockCheck.product.quantity)
                        : null,
                    track_quantity: stockCheck.product.track_quantity === true,
                    in_stock: stockCheck.product.in_stock
                };
            }
        }

        // Create new session
        const session = await OrderSession.create({
            id: uuidv4(),
            shop_id,
            customer_id: resolvedCustomerId,
            customer_channel_id,
            meta_channel_id,
            channel,
            // When we already know the product, jump straight to asking the quantity
            // ("koyta niben?") — the bot must verify pieces, not assume 1.
            current_step: product_info ? 'COLLECTING_QUANTITY' : 'PRODUCT_CONFIRMATION',
            step_data: {
                initial_message,
                entities,
                language,
                product_info
            },
            product_info,
            automation_mode: defaultAiSettings.automation_mode,
            confidence_threshold: defaultAiSettings.confidence_threshold,
            expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000) // 24 hours
        });

        return {
            session_id: session.id,
            prompt: this.generateStepPrompt(session.current_step, session.step_data, language),
            resumed: false
        };
    }

    /**
     * Process a step in the order flow
     */
    static async processStep(sessionId, shopId, answer, rawMessage = null, options = {}) {
        const session = await OrderSession.findOne({
            where: { id: sessionId, shop_id: shopId, status: 'ACTIVE' }
        });

        if (!session) {
            throw new Error('Order session not found or inactive');
        }

        // Update last activity
        await session.update({
            last_activity_at: new Date()
        });

        // Process current step
        const result = await this.handleCurrentStep(session, answer, rawMessage, options);

        return result;
    }

    /**
     * Handle the current step in the order flow
     */
    static async handleCurrentStep(session, answer, rawMessage, {
        mutationsAllowed = true,
        conversationId = null,
        traceId = null,
    } = {}) {
        const { current_step } = session;
        // Spread into a new object so Sequelize's dirty-tracking detects the change
        const step_data = { ...(session.step_data || {}) };
        const lang = step_data.language || 'bn'; // single-language replies (match the customer)
        let nextStep = current_step;
        let prompt = '';
        let completed = false;
        let createdOrder = null;

        if (QUESTION_PROTECTED_STEPS.has(current_step) && isQuestionShaped(answer)) {
            // Nothing is written; the bridge records awaiting_resume and the
            // normal pipeline answers from grounded evidence, then re-asks.
            return {
                session_id: session.id,
                prompt: this.generateStepPrompt(current_step, step_data, lang),
                current_step,
                step_data,
                question_deferred: true,
            };
        }

        switch (current_step) {
            case 'SELECTING_PRODUCT': {
                // Fix 14: customer picks from numbered product list
                const candidates = step_data.product_candidates || [];
                const pickedNum = parseInt(answer.trim(), 10);
                if (pickedNum >= 1 && pickedNum <= candidates.length) {
                    const chosen = candidates[pickedNum - 1];
                    // Stock check on chosen product
                    if (chosen.id) {
                        const stockCheck = await productSearch.checkStock(chosen.id, session.shop_id);
                        if (!stockCheck.available) {
                            await session.update({ status: 'CANCELLED' });
                            return {
                                session_id: session.id,
                                prompt: this.buildOutOfStockPrompt(stockCheck.reason, chosen, lang),
                                current_step: 'CANCELLED',
                                step_data,
                                completed: false,
                                cancelled: true
                            };
                        }
                        if (stockCheck.product) {
                            chosen.price    = stockCheck.product.price;
                            chosen.quantity = stockCheck.product.quantity;
                            chosen.stock_snapshot = stockCheck.product.track_quantity === true
                                ? finiteNumberOrNull(stockCheck.product.quantity)
                                : null;
                            chosen.track_quantity = stockCheck.product.track_quantity === true;
                            chosen.in_stock = stockCheck.product.in_stock;
                        }
                    }
                    await session.update({ product_info: chosen });
                    session.product_info = chosen;
                    nextStep = 'COLLECTING_QUANTITY';
                    prompt = pickLang(lang,
                        `"${chosen.name}" নির্বাচন করেছেন ✅\n\nকয়টা নিবেন?`,
                        `You selected "${chosen.name}" ✅\n\nHow many would you like?`);
                } else {
                    prompt = OrderSessionService.buildProductSelectionPrompt(candidates, lang) +
                        pickLang(lang,
                            '\n\nঅনুগ্রহ করে সঠিক নম্বরটি লিখুন।',
                            '\n\nPlease enter a valid number from the list above.');
                }
                break;
            }

            case 'PRODUCT_CONFIRMATION': {
                const confirmation = this.extractConfirmation(answer);
                if (confirmation) {
                    nextStep = 'COLLECTING_QUANTITY';
                    prompt = pickLang(lang, 'কয়টা নিবেন?', 'How many would you like?');
                } else {
                    prompt = pickLang(lang,
                        'পণ্যটি নিশ্চিত করুন। আপনি কি এই পণ্যটি অর্ডার করতে চান?',
                        'Please confirm the product. Do you want to order this item?');
                }
                break;
            }

            case 'COLLECTING_QUANTITY': {
                const qty = extractQuantity(answer);
                if (qty) {
                    // Verify the requested quantity is actually in stock NOW, before we
                    // walk the customer through name/phone/address only to fail at order
                    // creation with a scary generic error. checkStock without a quantity
                    // defaulted to 1, so "I want 3" of a 2-in-stock item sailed through.
                    const prod = session.product_info || {};
                    let quantityStockCheck = null;
                    if (prod.id) {
                        try {
                            quantityStockCheck = await productSearch.checkStock(prod.id, session.shop_id, qty);
                        } catch (_) {
                            prompt = pickLang(lang,
                                'দুঃখিত, স্টক এখন যাচাই করা যাচ্ছে না। একটু পরে আবার চেষ্টা করুন বা একজন বিক্রেতার সাহায্য নিন।',
                                'I cannot verify stock right now. Please try again shortly or ask a shop team member.');
                            break;
                        }
                        if (!quantityStockCheck.available) {
                            // Not enough units — tell them how many remain and re-ask. Stay on step.
                            prompt = typeof quantityStockCheck.quantity === 'number'
                                ? pickLang(lang,
                                    `দুঃখিত, এই মুহূর্তে স্টকে আছে ${quantityStockCheck.quantity}টি। কয়টা নিতে চান?`,
                                    `Sorry, only ${quantityStockCheck.quantity} in stock right now. How many would you like?`)
                                : pickLang(lang,
                                    'দুঃখিত, এই পণ্যটি এখন অর্ডার করা যাচ্ছে না। একজন বিক্রেতার সাহায্য নিন।',
                                    'Sorry, this product is not available to order right now. A shop team member can help.');
                            break;
                        }
                    }
                    // Quantity lives on product_info so the (last-configured) item
                    // is always available; the cart is the source of truth for the
                    // full multi-product order.
                    const currentStock = quantityStockCheck?.product?.quantity;
                    const pi = {
                        ...prod,
                        quantity: qty,
                        track_quantity: quantityStockCheck?.product?.track_quantity === true || prod.track_quantity === true,
                        stock_snapshot: quantityStockCheck?.product?.track_quantity === true
                            && finiteNumberOrNull(currentStock) !== null
                            ? finiteNumberOrNull(currentStock)
                            : (prod.stock_snapshot ?? null),
                    };
                    await session.update({ product_info: pi });
                    session.product_info = pi;

                    // Append the configured item to the cart, then offer add-another.
                    const cartItem = {
                        product_id: pi.id,
                        name: pi.name,
                        name_bn: pi.name_bn || null,
                        price: pi.price,
                        quantity: qty,
                        track_quantity: pi.track_quantity === true,
                        stock_snapshot: pi.track_quantity === true ? pi.stock_snapshot ?? null : null,
                    };
                    const cartGate = await authorizeSessionMutation(session, 'EDIT_PREORDER_CART', {
                        orderSessionId: session.id,
                        edit: 'add',
                        lineIndex: (step_data.cart || []).length,
                        quantity: qty,
                    }, { conversationId, traceId, mutationsAllowed });
                    verifySessionMutationAuthorization(session, 'EDIT_PREORDER_CART', cartGate);
                    step_data.cart = [...(step_data.cart || []), cartItem];
                    nextStep = 'ADD_MORE';
                    prompt = OrderSessionService.buildAddMorePrompt(pi, step_data.cart, lang);
                } else {
                    prompt = pickLang(lang,
                        'কয়টা পণ্য নিতে চান? সংখ্যায় লিখুন (যেমন: ১, ২, ৩)।',
                        'How many would you like? Please reply with a number (e.g. 1, 2, 3).');
                }
                break;
            }

            // Multi-product loop: after each item is carted we ask whether to add
            // another or proceed to checkout. "done"/"শেষ" → checkout; a bare
            // affirmation → ask which product; anything else is treated as the next
            // product to identify (name or photo).
            case 'ADD_MORE': {
                const addMoreCart = OrderSessionService.getCartItems(session, step_data);
                const addMoreEdit = OrderSessionService.detectCartEdit(answer, addMoreCart);
                if (addMoreEdit.action) {
                    ({ nextStep, prompt, completed } =
                        await OrderSessionService.applyCartEdit(session, step_data, addMoreEdit, addMoreCart, lang, {
                            conversationId,
                            traceId,
                            mutationsAllowed,
                        }));
                    break;
                }
                if (OrderSessionService.isCheckoutWord(answer)) {
                    OrderSessionService.logAddMoreCheckoutDecision(session, answer, addMoreCart);
                    nextStep = 'COLLECTING_NAME';
                    prompt = OrderSessionService.buildProceedToCheckoutPrompt(lang);
                    break;
                }
                if (OrderSessionService.isBareAddWord(answer)) {
                    nextStep = 'ADDING_PRODUCT';
                    prompt = pickLang(lang,
                        `কোন পণ্যটি যোগ করতে চান? ${productInputPrompt(lang)}।`,
                        `Which product would you like to add? ${productInputPrompt('en')}.`);
                    break;
                }
                // Treat the message as the next product(s) — one name, or several
                // in one go ("2 lawn and 1 dupatta") via free-text parsing.
                ({ nextStep, prompt } = await OrderSessionService.applyLineItems(session, step_data, answer, rawMessage, lang));
                break;
            }

            case 'ADDING_PRODUCT': {
                ({ nextStep, prompt } = await OrderSessionService.applyLineItems(session, step_data, answer, rawMessage, lang));
                break;
            }

            case 'COLLECTING_NAME': {
                const name = answer.trim();
                // Customers often echo a confirmation ("confirm korun", "ok") right
                // after the session starts — that's not their name. Exact-match only,
                // so real names containing these substrings ("Jia", "Hannan") pass.
                if (OrderSessionService.isBareConfirmationWord(name)) {
                    prompt = pickLang(lang, 'অনুগ্রহ করে আপনার নাম লিখুন।', 'Please write your name.');
                    break;
                }
                if (name.length >= 2 && name.length <= 50) {
                    step_data.name = name;
                    nextStep = 'COLLECTING_PHONE';
                    prompt = pickLang(lang, 'আপনার মোবাইল নম্বর কত?', "What's your mobile number?");
                } else {
                    prompt = pickLang(lang,
                        'অনুগ্রহ করে একটি বৈধ নাম দিন (২-৫০ অক্ষর)।',
                        'Please provide a valid name (2-50 characters).');
                }
                break;
            }

            case 'COLLECTING_PHONE': {
                const phone = this.extractPhoneNumber(answer);
                if (phone) {
                    step_data.phone = phone;
                    nextStep = 'COLLECTING_ADDRESS';
                    prompt = pickLang(lang, 'আপনার ডেলিভারির ঠিকানা কি?', "What's your delivery address?");
                } else {
                    prompt = pickLang(lang,
                        'অনুগ্রহ করে একটি বৈধ বাংলাদেশি মোবাইল নম্বর দিন (01xxxxxxxxx)।',
                        'Please provide a valid Bangladesh mobile number (01xxxxxxxxx).');
                }
                break;
            }

            case 'COLLECTING_ADDRESS': {
                const address = answer.trim();
                if (address.length >= 5) {
                    step_data.address = address;
                    // Load shop's configured delivery zones
                    const zones = await OrderSessionService.getShopDeliveryZones(session.shop_id);
                    step_data.delivery_zones = zones; // store for zone step validation
                    // Try to infer the zone from the address so we apply the charge
                    // ourselves; only ask the inside/outside question when unsure.
                    const detectedZone = OrderSessionService.detectZoneFromAddress(address, zones);
                    if (detectedZone) {
                        const adv = await OrderSessionService._advanceAfterZone(session, step_data, detectedZone, lang, true);
                        nextStep = adv.nextStep;
                        prompt = adv.prompt;
                    } else {
                        nextStep = 'COLLECTING_ZONE';
                        prompt = OrderSessionService.buildDeliveryZonePrompt(zones, lang);
                    }
                } else {
                    prompt = pickLang(lang,
                        'অনুগ্রহ করে ঠিকানা লিখুন (যেমন: মিরপুর ১০, উত্তরা ৬)।',
                        'Please write your delivery address (e.g. Mirpur 10, Uttara 6).');
                }
                break;
            }

            case 'COLLECTING_ZONE': {
                const zones = step_data.delivery_zones || await OrderSessionService.getShopDeliveryZones(session.shop_id);
                const zoneChoice = this.extractZoneChoice(answer, zones);
                if (zoneChoice) {
                    const adv = await OrderSessionService._advanceAfterZone(session, step_data, zoneChoice, lang, false);
                    nextStep = adv.nextStep;
                    prompt = adv.prompt;
                } else {
                    prompt = OrderSessionService.buildDeliveryZonePrompt(zones, lang) +
                        pickLang(lang,
                            '\n\nঅনুগ্রহ করে সঠিক নম্বর বা এলাকার নাম লিখুন।',
                            '\n\nPlease enter the correct number or area name.');
                }
                break;
            }

            case 'COLLECTING_PAYMENT': {
                const gateways = step_data.enabled_gateways || ['cod'];
                const gateway = this.extractPaymentGateway(answer, gateways);
                if (gateway) {
                    // P0-2: a self-MFS selection is an instruction to pay the
                    // merchant's number — never automated verification. Payment
                    // truth comes only from merchant confirmation or a verified
                    // gateway webhook; the OCR screenshot path is removed so no
                    // checkout flow can tell a customer "payment confirmed" from
                    // an image (see self-mfs-handler for merchant-side review).
                    step_data.payment_method = gateway;
                    nextStep = 'COLLECTING_NOTES';
                    prompt = pickLang(lang, 'কোনো বিশেষ নির্দেশনা আছে?', 'Any special instructions for your order?');
                } else {
                    prompt = OrderSessionService.buildPaymentPrompt(gateways, {
                        zone: step_data.delivery_zone,
                        charge: step_data.delivery_charge
                    }, lang) + pickLang(lang,
                        '\n\nঅনুগ্রহ করে সঠিক নম্বর বা পেমেন্ট পদ্ধতির নাম লিখুন।',
                        '\n\nPlease enter the correct number or payment method name.');
                }
                break;
            }

            case 'AWAITING_MFS_SCREENSHOT': {
                // Legacy recovery (P0-2): historical sessions may still carry
                // this step. The machine no longer verifies screenshots, so
                // return to the payment question with no claim about payment
                // status — nothing collected here marks anything paid.
                nextStep = 'COLLECTING_PAYMENT';
                prompt = OrderSessionService.buildPaymentPrompt(
                    step_data.enabled_gateways || ['cod'],
                    { zone: step_data.delivery_zone, charge: step_data.delivery_charge },
                    lang
                ) + pickLang(lang,
                    '\n\nপেমেন্ট নিশ্চিত করতে ব্যবসায়ীর সাথে সমন্বয় করুন।',
                    '\n\nThe merchant confirms payment before the order is marked paid.');
                break;
            }

            case 'COLLECTING_NOTES': {
                // A bare "no/na/nai" means "no special instructions" — store null, not the word.
                const rawNote = answer.trim();
                const isNoNote = /^(no|none|na|nah|nope|নাই|না|নেই|nai|nei)\.?$/i.test(rawNote);
                step_data.notes = (!rawNote || isNoNote) ? null : rawNote;
                nextStep = 'ORDER_SUMMARY';
                prompt = this.generateOrderSummary(session, step_data, lang);
                break;
            }

            case 'ORDER_SUMMARY': {
                // A per-line edit ("remove the dupatta", "saree 3 ta koro") takes
                // priority over confirmation. Only fall through to confirm when it
                // is not an edit.
                const summaryCart = OrderSessionService.getCartItems(session, step_data);
                const edit = OrderSessionService.detectCartEdit(answer, summaryCart);
                if (edit.action) {
                    ({ nextStep, prompt, completed } =
                        await OrderSessionService.applyCartEdit(session, step_data, edit, summaryCart, lang, {
                            conversationId,
                            traceId,
                            mutationsAllowed,
                        }));
                    break;
                }

                const orderConfirmation = this.extractConfirmation(answer);
                if (orderConfirmation) {
                    if (!mutationsAllowed) {
                        return {
                            session_id: session.id,
                            prompt: `${this.generateOrderSummary(session, step_data, lang)}\n\n` +
                                pickLang(
                                    lang,
                                    'একজন টিম সদস্য অর্ডারটি নিশ্চিত করবেন।',
                                    'A team member will confirm this order.'
                                ),
                            current_step: 'ORDER_SUMMARY',
                            state: 'AWAITING_CONFIRMATION',
                            step_data,
                            completed: false,
                            mutation_blocked: true,
                        };
                    }

                    const contractSummary = this.buildContractOrderSummary(session, step_data);
                    const confirmedSummaryHash = require('../ai/contracts/action.contract')
                        .confirmedSummaryHash(contractSummary);
                    step_data.confirmed_summary_hash = confirmedSummaryHash;

                    // Re-check stock for EVERY line in the cart before committing.
                    const cart = OrderSessionService.getCartItems(session, step_data);
                    let priceChanged = false;
                    let stockChanged = false;
                    for (const item of cart) {
                        if (!item.product_id) continue;
                        const stockCheck = await productSearch.checkStock(item.product_id, session.shop_id, item.quantity || 1);
                        if (!stockCheck.available) {
                            await session.update({ status: 'CANCELLED' });
                            return {
                                session_id: session.id,
                                prompt: this.buildOutOfStockPrompt(stockCheck.reason, item, lang),
                                current_step: 'CANCELLED',
                                step_data,
                                completed: false,
                                cancelled: true
                            };
                        }
                        const liveQuantity = finiteNumberOrNull(stockCheck.product?.quantity ?? stockCheck.quantity);
                        const isTracked = stockCheck.product?.track_quantity === true || item.track_quantity === true;
                        if (isTracked) {
                            const quotedQuantity = finiteNumberOrNull(item.stock_snapshot);
                            if (quotedQuantity === null || liveQuantity === null || quotedQuantity !== liveQuantity) {
                                stockChanged = true;
                            }
                            if (liveQuantity !== null) item.stock_snapshot = liveQuantity;
                        }
                        if (stockCheck.product?.price != null
                            && Number(stockCheck.product.price) !== Number(item.price)) {
                            item.price = stockCheck.product.price;
                            priceChanged = true;
                        }
                    }

                    if (priceChanged || stockChanged) step_data.cart = cart;

                    const {
                        createProposedAction,
                        deriveCreateOrderIdempotencyKey,
                        confirmedSummaryHash: hashSummary,
                    } = require('../ai/contracts/action.contract');
                    const { withEvidenceSnapshot } = require('../ai/contracts/evidence.contract');
                    const { authorize } = require('../ai/action-gate');
                    const { findOrderByIdempotencyKey } = require('./order-idempotency.service');
                    const { getMutationBudgetState } = require('../ai/cost.service');
                    const { Conversation } = require('../conversation/conversation.entity');
                    const freshSummaryHash = priceChanged || stockChanged
                        ? hashSummary(this.buildContractOrderSummary(session, step_data))
                        : confirmedSummaryHash;
                    const summaryEvidence = withEvidenceSnapshot({
                        shopId: session.shop_id,
                        sourceText: this.generateOrderSummary(session, step_data, lang),
                        summaryHash: freshSummaryHash,
                        productIds: cart.map(item => item.product_id).filter(Boolean),
                    });
                    const orderIdempotencyKey = deriveCreateOrderIdempotencyKey({
                        shopId: session.shop_id,
                        conversationId,
                        orderSessionId: session.id,
                        confirmedSummaryHash,
                    });
                    const matchingConversation = conversationId && session.customer_id
                        ? await Conversation.findOne({
                            where: {
                                id: conversationId,
                                shop_id: session.shop_id,
                                customer_id: session.customer_id,
                            },
                            attributes: ['id', 'shop_id', 'customer_id'],
                        }).catch(() => null)
                        : null;
                    const existingOrder = await findOrderByIdempotencyKey(session.shop_id, orderIdempotencyKey);
                    const budgetState = getMutationBudgetState({ estimatedCostUsd: 0 });
                    const tenantRecordsMatch = Boolean(
                        matchingConversation
                            && matchingConversation.shop_id === session.shop_id
                            && matchingConversation.customer_id === session.customer_id
                    );
                    const materialStateRevalidated = !priceChanged && !stockChanged;
                    const customerConfirmationValid = Boolean(
                        !priceChanged
                            && !stockChanged
                            && orderConfirmation
                            && confirmedSummaryHash === step_data.confirmed_summary_hash
                    );
                    const orderAction = createProposedAction({
                        requestedByAgent: 'OrderAgent',
                        actionType: 'CREATE_ORDER',
                        domain: 'ORDER',
                        shopId: session.shop_id,
                        conversationId,
                        idempotencyKey: orderIdempotencyKey,
                        evidenceSnapshotHash: summaryEvidence.snapshotHash,
                        payload: { orderSessionId: session.id, summaryHash: confirmedSummaryHash },
                        confirmation: {
                            summaryHash: confirmedSummaryHash,
                            confirmedBy: 'CUSTOMER',
                            orderSessionId: session.id,
                        },
                    });
                    const gateResult = await authorize(orderAction, {
                        traceId: traceId || conversationId || session.id,
                        taskId: session.id,
                        tenant: {
                            shopId: session.shop_id,
                            channelId: session.channel,
                            platform: 'META_MESSENGER',
                            customerId: session.customer_id,
                            conversationId,
                        },
                        tenantRecordsMatch,
                        currentDomain: 'ORDER',
                        domainHops: 0,
                        expectedIdempotencyKey: orderIdempotencyKey,
                        idempotencyCommitted: Boolean(existingOrder),
                        evidenceSnapshot: summaryEvidence,
                        materialStateRevalidated,
                        customerConfirmationValid,
                        merchantModeAllowsMutation: mutationsAllowed,
                        costBudgetAvailable: budgetState.available,
                    });
                    if (!gateResult.authorized) {
                        const confirmationInvalidated = priceChanged || stockChanged
                            || gateResult.reasonCode === 'material_state_revalidated'
                            || gateResult.reasonCode === 'customer_confirmation_valid';
                        return {
                            session_id: session.id,
                            prompt: `${this.generateOrderSummary(session, step_data, lang)}\n\n` +
                                pickLang(
                                    lang,
                                    confirmationInvalidated
                                        ? priceChanged && stockChanged
                                            ? 'দাম ও স্টকের অবস্থা পরিবর্তিত হয়েছে। নতুন সারসংক্ষেপটি আবার নিশ্চিত করুন।'
                                            : stockChanged
                                                ? 'স্টকের অবস্থা পরিবর্তিত হয়েছে, তবে চাওয়া পরিমাণ এখনো পাওয়া যাচ্ছে। নতুন সারসংক্ষেপটি আবার নিশ্চিত করুন।'
                                                : 'দাম পরিবর্তিত হয়েছে। নতুন সারসংক্ষেপটি আবার নিশ্চিত করুন।'
                                        : 'একজন টিম সদস্য অর্ডারটি নিশ্চিত করবেন।',
                                    confirmationInvalidated
                                        ? priceChanged && stockChanged
                                            ? 'Price and stock availability changed. Please confirm the updated order before placing it.'
                                            : stockChanged
                                                ? 'Stock availability changed, but your requested quantity is still available. Please confirm the updated order before placing it.'
                                                : 'The price changed. Please confirm the updated order before placing it.'
                                        : 'A team member will confirm this order.'
                                ),
                            current_step: 'ORDER_SUMMARY',
                            state: 'AWAITING_CONFIRMATION',
                            step_data,
                            completed: false,
                            mutation_blocked: true,
                            action_gate_reason: gateResult.reasonCode,
                        };
                    }

                    // Create the actual Order record
                    let order = null;
                    let orderPrompt;
                    try {
                        order = await OrderSessionService.createOrderFromSession(session, step_data, {
                            authorization: gateResult.authorization,
                            conversationId,
                            confirmedSummaryHash,
                            evidenceSnapshotHash: summaryEvidence.snapshotHash,
                        });
                        createdOrder = order;
                        orderPrompt = pickLang(lang,
                            `✅ অর্ডার সফলভাবে সম্পন্ন হয়েছে! অর্ডার নম্বর: ${order.order_number}`,
                            `✅ Order placed successfully! Order number: ${order.order_number}`);

                        // Issue the customer's invoice in the same confirmation message.
                        // Invoice failure must never un-confirm a created order.
                        try {
                            const { issueInvoiceForOrder } = require('../invoice/chat-invoice.service');
                            const { text: invoiceText } = await issueInvoiceForOrder(order, {
                                channel: session.channel || 'messenger',
                                items: cart.length ? cart.map(c => ({
                                    name: c.name,
                                    quantity: c.quantity || 1,
                                    price: c.price,
                                    total: (c.price || 0) * (c.quantity || 1)
                                })) : null
                            });
                            orderPrompt += `\n\n${invoiceText}`;
                        } catch (invErr) {
                            console.error('[OrderSession] Invoice generation failed', {
                                orderId: order.id,
                                errorCode: safeErrorCode(invErr, 'INVOICE_GENERATION_FAILED'),
                            });
                        }

                        // Append the shop's closing message (thank-you + "follow us"
                        // social links) to the confirmation. Best-effort — a failure
                        // here must never un-confirm an order that was already created.
                        try {
                            const closingText = await OrderSessionService.buildShopClosing(session.shop_id, lang);
                            if (closingText) orderPrompt += `\n\n${closingText}`;
                        } catch (closeErr) {
                            console.error('[OrderSession] Closing message failed', {
                                orderId: order.id,
                                errorCode: safeErrorCode(closeErr, 'SHOP_CLOSING_MESSAGE_FAILED'),
                            });
                        }
                    } catch (orderErr) {
                        // Surface genuine business rejections (out of stock, COD limit,
                        // RTO block, product not found) to the customer with their real
                        // reason. AppError exposes the HTTP code as `.status` (NOT
                        // `.statusCode`) — reading the wrong property made every 4xx look
                        // like a 5xx, so customers saw the scary "our team will contact
                        // you" generic instead of "only 2 left in stock". Log a stable
                        // code without copying customer or provider values into logs.
                        const errCode = orderErr.status ?? orderErr.statusCode;
                        console.error('[OrderSession] Order creation failed', {
                            sessionId: session.id,
                            orderId: order?.id || null,
                            errorCode: safeErrorCode(orderErr, errCode ? `HTTP_${errCode}` : 'ORDER_CREATE_FAILED'),
                        });
                        const userMsg = (errCode >= 400 && errCode < 500)
                            ? orderErr.message
                            : pickLang(lang,
                                'অর্ডার সম্পন্ন করা যায়নি। আমাদের টিম শীঘ্রই যোগাযোগ করবে।',
                                'Could not place order. Our team will contact you shortly.');
                        return {
                            session_id: session.id,
                            prompt: userMsg,
                            current_step: 'ORDER_SUMMARY',
                            step_data,
                            completed: false
                        };
                    }

                    await session.update({
                        status: 'COMPLETED',
                        created_order_id: order.id,
                        final_summary: this.generateOrderSummary(session, step_data)
                    });

                    // Enrich customer record with collected name + phone
                    if (session.customer_id) {
                        await OrderSessionService.enrichCustomer(
                            session.customer_id,
                            step_data.name,
                            step_data.phone,
                            {
                                shopId: session.shop_id,
                                channel: session.channel,
                                customerChannelId: session.customer_channel_id,
                                metaChannelId: session.meta_channel_id,
                            },
                        ).catch(() => {}); // non-blocking
                    }

                    // Courier booking is a separate material action. Resolve the
                    // configured AI default before asking the Action Gate for a
                    // BOOK_COURIER authorization. Readiness is a precondition,
                    // not a new gate check, so the gate contract stays unchanged.
                    let courierAuthorization = null;
                    let courierDispatchToReconcile = null;
                    let courierProvider = null;
                    let courierResolution = null;
                    try {
                        const orderService = getOrderServiceImports();
                        const hasReadinessResolver = typeof orderService.resolveCourierProvider === 'function';

                        if (hasReadinessResolver) {
                            courierResolution = await orderService.resolveCourierProvider(
                                session.shop_id,
                                { requireAiDefault: true }
                            );
                            if (courierResolution?.blocked || !courierResolution?.provider) {
                                await OrderSessionService.markCourierSetupRequired(
                                    order,
                                    session.shop_id,
                                    courierResolution || { reason: 'AI_DEFAULT_NOT_CONFIGURED' }
                                );
                            } else {
                                const courierOrderData = typeof orderService.buildCourierOrderData === 'function'
                                    ? orderService.buildCourierOrderData(order, {
                                        stepData: step_data,
                                        pickup: courierResolution.pickup,
                                    })
                                    : null;
                                const missingCourierFields = courierOrderData
                                    ? ['customer_name', 'customer_phone', 'delivery_address']
                                        .filter(field => !String(courierOrderData[field] || '').trim())
                                    : [];
                                if (missingCourierFields.length) {
                                    await OrderSessionService.markCourierSetupRequired(order, session.shop_id, {
                                        provider: courierResolution.provider,
                                        reason: 'COURIER_ORDER_DATA_INCOMPLETE',
                                        missing: missingCourierFields,
                                    });
                                } else {
                                    courierProvider = courierResolution.provider;
                                }
                            }
                        } else {
                            // Compatibility for focused tests that replace the
                            // order service with its pre-readiness surface.
                            courierProvider = 'active';
                        }

                        if (courierProvider) {
                            const { createProposedAction, deriveBookCourierIdempotencyKey } = require('../ai/contracts/action.contract');
                            const { authorize } = require('../ai/action-gate');
                            const existingCourierDispatch = await OrderSessionService.getCourierDispatchRecord(
                                order,
                                session.shop_id,
                                courierProvider
                            );
                            const dispatchAlreadyCommitted = String(existingCourierDispatch?.status || '').toUpperCase() === 'COMMITTED'
                                && (existingCourierDispatch.tracking_code || existingCourierDispatch.consignment_id);
                            if (dispatchAlreadyCommitted) {
                                // Reconcile/persist the committed local result without
                                // asking the Action Gate to authorize an already
                                // committed idempotency key.
                                courierDispatchToReconcile = existingCourierDispatch;
                            }
                            const courierIdempotencyKey = deriveBookCourierIdempotencyKey({
                                shopId: session.shop_id,
                                orderId: order.id,
                                provider: courierProvider,
                            });
                            const courierAction = createProposedAction({
                                requestedByAgent: 'OrderAgent',
                                actionType: 'BOOK_COURIER',
                                domain: 'COMMERCE_OPS',
                                shopId: session.shop_id,
                                conversationId,
                                idempotencyKey: courierIdempotencyKey,
                                evidenceSnapshotHash: summaryEvidence.snapshotHash,
                                payload: { orderId: order.id, provider: courierProvider },
                            });
                            const courierGate = dispatchAlreadyCommitted
                                ? { authorized: false, reasonCode: 'idempotency_committed' }
                                : await authorize(courierAction, {
                                traceId: traceId || conversationId || session.id,
                                taskId: session.id,
                                tenant: {
                                    shopId: session.shop_id,
                                    channelId: session.channel,
                                    platform: 'META_MESSENGER',
                                    customerId: session.customer_id || session.customer_channel_id,
                                    conversationId,
                                },
                                tenantRecordsMatch,
                                currentDomain: 'ORDER',
                                domainHops: 1,
                                expectedIdempotencyKey: courierIdempotencyKey,
                                idempotencyCommitted: String(existingCourierDispatch?.status || '').toUpperCase() === 'COMMITTED',
                                evidenceSnapshot: summaryEvidence,
                                materialStateRevalidated,
                                customerConfirmationValid,
                                merchantModeAllowsMutation: mutationsAllowed,
                                costBudgetAvailable: budgetState.available,
                            });
                            if (courierGate.authorized) {
                                courierAuthorization = courierGate.authorization;
                                courierResolution = courierResolution || {
                                    blocked: false,
                                    provider: courierProvider,
                                };
                            } else if (!dispatchAlreadyCommitted) {
                                await OrderSessionService.markCourierSetupRequired(order, session.shop_id, {
                                    provider: courierProvider,
                                    reason: `action_gate_denied:${courierGate.reasonCode}`,
                                });
                            }
                        }
                    } catch (courierGateErr) {
                        await OrderSessionService.markCourierSetupRequired(
                            order,
                            session.shop_id,
                            {
                                provider: courierProvider,
                                reason: `action_gate_failed:${courierGateErr.message}`,
                            }
                        );
                    }

                    if (courierAuthorization || courierDispatchToReconcile) {
                        setImmediate(() => OrderSessionService.dispatchParcelWithRetry(
                            order,
                            step_data,
                            session.shop_id,
                            {
                                authorization: courierAuthorization,
                                evidenceSnapshotHash: summaryEvidence.snapshotHash,
                                provider: courierProvider,
                                resolvedProvider: courierResolution,
                                dispatchRecord: courierDispatchToReconcile,
                                idempotencyKey: courierAuthorization?.idempotencyKey,
                            }
                        ));
                    }

                    completed = true;
                    prompt = orderPrompt;
                } else {
                    nextStep = 'ORDER_SUMMARY';
                    prompt = `${this.generateOrderSummary(session, step_data, lang)}\n\n` +
                        pickLang(lang, 'কী পরিবর্তন করতে চান, অথবা অর্ডার নিশ্চিত করতে একটি সম্পূর্ণ নিশ্চিতকরণ লিখুন?', 'What would you like to change, or write a full confirmation to place the order?');
                }
                break;
            }
        }

        // Update session with new step data
        await session.update({
            current_step: nextStep,
            step_data
        });

                    return {
                        session_id: session.id,
                        prompt,
                        current_step: nextStep,
                        step_data,
                        completed,
                        order: createdOrder ? {
                            id: createdOrder.id,
                            order_number: createdOrder.order_number,
                            order_status: createdOrder.order_status || 'confirmed',
                        } : null,
                    };
    }

    /**
     * Get active session for a customer
     */
    static async getActiveSession(shopId, customerChannelId, metaChannelId = null, customerId = null) {
        // Only resume a session that is still within its TTL. A session left stuck at
        // ORDER_SUMMARY (e.g. order creation kept failing) was otherwise resurfaced on
        // EVERY later message — the customer felt the bot was "stuck on old data" and
        // could never start fresh. Drop expired rows; keep legacy rows with null expiry.
        const where = {
                shop_id: shopId,
                customer_channel_id: customerChannelId,
                status: 'ACTIVE',
                ...(customerId ? { customer_id: customerId } : {}),
                [Op.or]: [
                    { expires_at: { [Op.gt]: new Date() } },
                    { expires_at: { [Op.is]: null } }
                ]
        };
        const session = await OrderSession.findOne({
            where: { ...where, meta_channel_id: metaChannelId || null },
            order: [['last_activity_at', 'DESC']],
        });
        return session;
    }

    /**
     * P+02: load a bound session for interaction resolution by id+shop —
     * INCLUDING terminal states, so the resolver can honestly reject stale
     * context instead of silently acting on it. Scoped by shop at query time.
     */
    static async getSessionForInteraction(sessionId, shopId) {
        return OrderSession.findOne({ where: { id: sessionId, shop_id: shopId } });
    }

    /**
     * Get session state
     */
    static async getSessionState(sessionId, shopId) {
        const session = await OrderSession.findOne({
            where: { id: sessionId, shop_id: shopId }
        });

        if (!session) {
            throw new Error('Session not found');
        }

        return {
            session_id: session.id,
            current_step: session.current_step,
            step_data: session.step_data,
            status: session.status,
            product_info: session.product_info
        };
    }

    /**
     * Cancel session
     */
    static async cancelSession(sessionId, shopId, mutationContext = {}) {
        // A SUSPENDED (P+04) cart is still a live interruption and may be
        // cancelled explicitly; it is the only way a suspended session ends.
        const session = await OrderSession.findOne({
            where: { id: sessionId, shop_id: shopId, status: { [Op.in]: ['ACTIVE', 'SUSPENDED'] } }
        });

        if (!session) {
            throw new Error('Session not found');
        }

        const gateResult = await authorizeSessionMutation(session, 'CANCEL_ORDER_SESSION', {
            orderSessionId: session.id,
        }, mutationContext);
        verifySessionMutationAuthorization(session, 'CANCEL_ORDER_SESSION', gateResult);
        await session.update({ status: 'CANCELLED' });
        return { success: true };
    }

    /**
     * P+04: resumable (SUSPENDED) session lookup with the same TTL discipline
     * as getActiveSession. Channel scope is mandatory — never cross Pages.
     */
    static async getResumableSession(shopId, customerChannelId, metaChannelId = null, customerId = null) {
        const where = {
            shop_id: shopId,
            customer_channel_id: customerChannelId,
            status: 'SUSPENDED',
            ...(customerId ? { customer_id: customerId } : {}),
            [Op.or]: [
                { expires_at: { [Op.gt]: new Date() } },
                { expires_at: { [Op.is]: null } },
            ],
        };
        return OrderSession.findOne({
            where: { ...where, meta_channel_id: metaChannelId || null },
            order: [['last_activity_at', 'DESC']],
        });
    }

    /**
     * P+04: pause a checkout for a human handoff / sentiment interruption.
     * Reversible state preservation (no data destroyed) — deliberately not an
     * Action Gate mutation; the destructive sibling (cancel) remains gated.
     */
    static async suspendSession(sessionId, shopId, { reason = 'handoff', conversationId = null } = {}) {
        const session = await OrderSession.findOne({
            where: { id: sessionId, shop_id: shopId, status: 'ACTIVE' },
        });
        if (!session) return { suspended: false };
        const step_data = {
            ...(session.step_data || {}),
            suspended_reason: reason,
            suspended_at: new Date().toISOString(),
        };
        // Conditional re-check inside the UPDATE closes the read->write race
        // with a concurrent cancel/resume (same fence as the interaction claim).
        const [updated] = await OrderSession.update(
            { status: 'SUSPENDED', step_data, last_activity_at: new Date() },
            { where: { id: sessionId, shop_id: shopId, status: 'ACTIVE' } },
        );
        if (!updated) return { suspended: false };
        return { suspended: true, current_step: session.current_step, conversation_id: conversationId };
    }

    /**
     * P+04: resume a suspended session — customer-driven (any new reply) or an
     * explicit resume word. Returns the preserved step's re-ask prompt.
     */
    static async resumeSession(sessionId, shopId, { conversationId = null } = {}) {
        const session = await OrderSession.findOne({
            where: { id: sessionId, shop_id: shopId, status: 'SUSPENDED' },
        });
        if (!session) return { resumed: false };
        const step_data = { ...(session.step_data || {}) };
        delete step_data.suspended_reason;
        delete step_data.suspended_at;
        delete step_data.awaiting_resume;
        const [updated] = await OrderSession.update(
            { status: 'ACTIVE', step_data, last_activity_at: new Date() },
            { where: { id: sessionId, shop_id: shopId, status: 'SUSPENDED' } },
        );
        if (!updated) return { resumed: false };
        return {
            resumed: true,
            current_step: session.current_step,
            prompt: this.generateStepPrompt(session.current_step, step_data, step_data.language || 'bn'),
        };
    }

    /**
     * P+04: an informational question interrupted the current step. Remember
     * exactly where the customer was and hand back a deterministic resume hint
     * the worker appends after the grounded answer. No field is written, no
     * status changes.
     */
    static async markAwaitingResume(sessionId, shopId, { step = null } = {}) {
        const session = await OrderSession.findOne({
            where: {
                id: sessionId,
                shop_id: shopId,
                status: { [Op.in]: ['ACTIVE', 'SUSPENDED'] },
            },
        });
        if (!session) return { deferred: false };
        const resumeStep = step || session.current_step;
        const step_data = { ...(session.step_data || {}), awaiting_resume: resumeStep };
        await session.update({ step_data });
        const lang = step_data.language || 'bn';
        const reask = this.generateStepPrompt(resumeStep, step_data, lang);
        const resume_hint = lang === 'en'
            ? `\n\n(Once we're done with this — your order is still in progress: ${reask})`
            : `\n\n(এই কথা শেষ হলে অর্ডার চালিয়ে নেব — এখন: ${reask})`;
        return { deferred: true, resume_step: resumeStep, resume_hint };
    }

    // ─── Delivery helpers ─────────────────────────────────────────────────────

    /**
     * Load shop's configured delivery zones (with charges) from shop settings.
     * Falls back to default BD zone pricing if not configured.
     */
    static async getShopDeliveryZones(shopId) {
        const shop = await ShopEntity.findByPk(shopId, { attributes: ['id', 'settings'] });
        const areaPricing = shop?.settings?.delivery?.area_pricing;

        if (Array.isArray(areaPricing) && areaPricing.length > 0) {
            return areaPricing
                .filter(z => ZONE_KEYS.includes(z.zone))
                .map(z => ({
                    zone: z.zone,
                    charge: Number(z.charge) || DEFAULT_ZONE_CHARGES[z.zone] || 0
                }));
        }

        // Default zones
        return ZONE_KEYS.map(zone => ({
            zone,
            charge: DEFAULT_ZONE_CHARGES[zone]
        }));
    }

    static buildDeliveryZonePrompt(zones, lang = 'bn') {
        const lines = zones.map((z, i) => `${i + 1}. ${zoneLabel(z.zone, lang)} — ৳${z.charge}`);
        const header = pickLang(lang, 'আপনার ডেলিভারি এলাকা নির্বাচন করুন:', 'Select your delivery area:');
        return `${header}\n${lines.join('\n')}`;
    }

    /**
     * Match customer input to a zone.
     * Accepts: position number (1/2/3), zone key, or label keywords.
     */
    static extractZoneChoice(answer, zones) {
        const t = answer.trim().toLowerCase();

        // Match by position number
        const num = parseInt(t, 10);
        if (!isNaN(num) && num >= 1 && num <= zones.length) {
            return zones[num - 1];
        }

        // Match by zone key or label keyword
        const keywords = {
            inside_dhaka:  ['inside', 'ভেতরে', 'dhaka inside', 'dhaka city', 'ঢাকা'],
            sub_dhaka:     ['sub', 'কাছাকাছি', 'sub-dhaka', 'near dhaka'],
            outside_dhaka: ['outside', 'বাইরে', 'outside dhaka', 'out of dhaka']
        };

        for (const zone of zones) {
            if (t === zone.zone) return zone;
            const kws = keywords[zone.zone] || [];
            if (kws.some(kw => t.includes(kw))) return zone;
        }

        return null;
    }

    /**
     * Best-effort infer the delivery zone from a free-text address so the bot can
     * apply the charge without asking. Returns the matching configured zone object
     * ({ zone, charge }) or null when the address gives no confident signal (→ ask).
     * A named Dhaka-city area beats the bare word "Dhaka"; only zones the shop has
     * actually configured are eligible.
     */
    static detectZoneFromAddress(address, zones) {
        if (!address || !Array.isArray(zones) || zones.length === 0) return null;
        const t = String(address).toLowerCase();
        const configured = new Set(zones.map(z => z.zone));
        for (const zoneKey of ZONE_DETECT_ORDER) {
            if (!configured.has(zoneKey)) continue;
            const kws = ZONE_AREA_KEYWORDS[zoneKey] || [];
            if (kws.some(kw => t.includes(kw))) {
                return zones.find(z => z.zone === zoneKey) || null;
            }
        }
        return null;
    }

    /**
     * Apply a chosen/detected delivery zone and move the flow forward: record the
     * zone + charge, load the shop's gateways, and route to payment (or straight to
     * notes when COD is the only option). Shared by the manual zone pick and the
     * address auto-detection so both behave identically.
     *
     * @param {boolean} detected — true when inferred from the address (we then name
     *        the zone so a wrong guess is visible and the buyer can correct it).
     * @returns {{ nextStep: string, prompt: string }}
     */
    static async _advanceAfterZone(session, stepData, zoneChoice, lang, detected = false) {
        stepData.delivery_zone = zoneChoice.zone;
        stepData.delivery_charge = zoneChoice.charge;
        const gateways = await OrderSessionService.getEnabledPaymentGateways(session.shop_id);
        stepData.enabled_gateways = gateways;

        const chargeLine = detected
            ? pickLang(lang,
                `ঠিকানা অনুযায়ী: ${zoneLabel(zoneChoice.zone, lang)}, ডেলিভারি চার্জ ৳${zoneChoice.charge}।`,
                `Based on your address: ${zoneLabel(zoneChoice.zone, lang)}, delivery charge ৳${zoneChoice.charge}.`)
            : pickLang(lang,
                `ডেলিভারি চার্জ ৳${zoneChoice.charge} (${zoneLabel(zoneChoice.zone, lang)})।`,
                `Delivery charge ৳${zoneChoice.charge} (${zoneLabel(zoneChoice.zone, lang)}).`);

        if (gateways.length <= 1) {
            // Only COD → don't ask "select a payment method", it's the sole option.
            stepData.payment_method = gateways[0] || 'cod';
            const ask = pickLang(lang,
                'পেমেন্ট: ক্যাশ অন ডেলিভারি (COD)।\nকোনো বিশেষ নির্দেশনা আছে? (না থাকলে "না" লিখুন)',
                'Payment: Cash on Delivery (COD).\nAny special instructions for your order? (type "no" if none)');
            return { nextStep: 'COLLECTING_NOTES', prompt: `${chargeLine}\n${ask}` };
        }
        // Multiple gateways → ask which. Pass null zoneChoice so buildPaymentPrompt
        // doesn't reprint the charge line we just showed.
        return {
            nextStep: 'COLLECTING_PAYMENT',
            prompt: `${chargeLine}\n` + OrderSessionService.buildPaymentPrompt(gateways, null, lang)
        };
    }

    // ─── Payment helpers ──────────────────────────────────────────────────────

    /**
     * Load shop's enabled payment gateways from PaymentConfig table.
     * Returns gateway IDs ordered by preference: cod first.
     * Falls back to ['cod'] if nothing is configured.
     */
    static async getEnabledPaymentGateways(shopId) {
        const configs = await PaymentConfigEntity.findAll({
            where: { shop_id: shopId, is_enabled: true },
            attributes: ['gateway']
        });

        if (configs.length === 0) return ['cod'];

        // Sort: cod first, then self-mfs
        const ORDER = ['cod', 'self-mfs'];
        return configs
            .map(c => c.gateway)
            .sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
    }

    static buildPaymentPrompt(gateways, zoneChoice, lang = 'bn') {
        const chargeNote = zoneChoice
            ? pickLang(lang,
                `ডেলিভারি চার্জ: ৳${zoneChoice.charge} (${zoneLabel(zoneChoice.zone, lang)})\n`,
                `Delivery charge: ৳${zoneChoice.charge} (${zoneLabel(zoneChoice.zone, lang)})\n`)
            : '';
        const lines = gateways.map((gw, i) => `${i + 1}. ${gatewayLabel(gw, lang)}`);
        const header = pickLang(lang, 'পেমেন্ট পদ্ধতি নির্বাচন করুন:', 'Select payment method:');
        return `${chargeNote}${header}\n${lines.join('\n')}`;
    }

    /**
     * Match customer input to an enabled gateway.
     * Accepts: position number, gateway key, or keyword (cod/cash/bkash/etc.)
     */
    static extractPaymentGateway(answer, gateways) {
        const t = answer.trim().toLowerCase();

        // Match by position number
        const num = parseInt(t, 10);
        if (!isNaN(num) && num >= 1 && num <= gateways.length) {
            return gateways[num - 1];
        }

        const keywordMap = {
            'cod':      ['cod', 'cash', 'ক্যাশ', 'cash on delivery'],
            'self-mfs': ['bkash', 'বিকাশ', 'nagad', 'নগদ', 'mfs', 'mobile', 'self-mfs', 'self mfs']
        };

        for (const gw of gateways) {
            if (t === gw) return gw;
            const kws = keywordMap[gw] || [];
            if (kws.some(kw => t.includes(kw))) return gw;
        }

        return null;
    }

    /**
     * Build the shop's order-confirmation closing message (owner thank-you text +
     * the shop's social links). Returns '' when the shop has disabled the closing
     * or has nothing to say. Falls back to the seeded default closing for shops
     * created before this feature (so the thank-you always appears).
     * @param {string} shopId
     * @param {string} language - reply language ('bn' | 'en' | 'mixed')
     * @returns {Promise<string>}
     */
    static async buildShopClosing(shopId, language) {
        const Shop = require('../shop/shop.entity');
        const { buildClosing } = require('../shop/ai-messaging');
        const { DEFAULT_AI_SETTINGS } = require('../shop/shop-defaults');
        const shop = await Shop.findByPk(shopId, { attributes: ['settings'] });
        const settings = shop?.settings || {};
        const closing = settings.ai?.closing || DEFAULT_AI_SETTINGS.closing;
        const socialLinks = settings.businessInfo?.socialLinks || {};
        return buildClosing({ closing, socialLinks, language });
    }

    // ─── Order creation ───────────────────────────────────────────────────────

    /**
     * Convert a completed order session into an Order record.
     * Uses createOrderInternal (no user auth required).
     */
    static async createOrderFromSession(session, stepData, {
        authorization,
        conversationId,
        confirmedSummaryHash,
        evidenceSnapshotHash,
    } = {}) {
        const { createOrderInternal } = getOrderServiceImports();
        const { deriveCreateOrderIdempotencyKey, confirmedSummaryHash: hashSummary } = require('../ai/contracts/action.contract');
        const { verifyAuthorization } = require('../ai/action-gate');
        const cart = OrderSessionService.getCartItems(session, stepData);

        if (!cart.length) {
            throw new Error('Cannot create order: no product linked to this session');
        }

        if (!conversationId) throw new Error('Conversation context is required to create an order');
        const scopedCustomer = await findScopedSessionCustomer({
            shopId: session.shop_id,
            customerId: session.customer_id,
            customerChannelId: session.customer_channel_id,
            metaChannelId: session.meta_channel_id,
            channel: session.channel,
        });
        const summaryHash = confirmedSummaryHash || stepData.confirmed_summary_hash || hashSummary(
            OrderSessionService.buildContractOrderSummary(session, stepData)
        );
        const idempotencyKey = deriveCreateOrderIdempotencyKey({
            shopId: session.shop_id,
            conversationId,
            orderSessionId: session.id,
            confirmedSummaryHash: summaryHash,
        });
        if (!verifyAuthorization(authorization, {
            actionType: 'CREATE_ORDER',
            shopId: session.shop_id,
            idempotencyKey,
            evidenceSnapshotHash,
        })) {
            throw new Error('Valid CREATE_ORDER authorization is required');
        }

        const orderData = {
            customer_id: scopedCustomer?.id || null,
            customer_name: stepData.name,
            customer_phone: stepData.phone,
            delivery_address: stepData.address,
            // The conversation collects one free-text address line, which no
            // courier directory can be matched against without a guess. Keep
            // it verbatim in the canonical destination carrier so the merchant
            // has the exact text to confirm a directory area against later.
            delivery_location: {
                full_address: stepData.address,
                source: 'chat',
            },
            delivery_zone: stepData.delivery_zone || null,
            channel: session.channel || 'chatbot',
            order_status: 'confirmed',
            // One entry per cart line. price omitted intentionally — the server
            // computes totals from the live catalog price.
            items: cart.map(c => ({
                product_id: c.product_id,
                quantity: c.quantity || 1
            })),
            delivery_fee: stepData.delivery_charge || 0,
            payment_status: GATEWAY_PAYMENT_STATUS[stepData.payment_method] || 'pending',
            payment_method: stepData.payment_method || null,
            note: stepData.notes || null,
            // Deterministic idempotency binds tenant, conversation, session, and
            // the exact customer-confirmed summary.
            idempotency_key: idempotencyKey,
        };

        return createOrderInternal(session.shop_id, orderData, idempotencyKey, {
            authorization,
            evidenceSnapshotHash,
        });
    }

    // ─── Customer enrichment ──────────────────────────────────────────────────

    /**
     * Update the Customer record with the name and phone collected during the session,
     * but only if the current values are missing/generic.
     */
    static async enrichCustomer(customerId, name, phone, scope = {}) {
        const customer = scope && (scope.shopId || scope.metaChannelId || scope.customerChannelId)
            && typeof CustomerEntity.findOne === 'function'
            ? await CustomerEntity.findOne({
                where: {
                    id: customerId,
                    ...(scope.shopId ? { shop_id: scope.shopId } : {}),
                    ...(scope.channel ? { channel_type: normalizeSessionChannel(scope.channel) } : {}),
                    ...(scope.customerChannelId ? { channel_user_id: String(scope.customerChannelId) } : {}),
                    ...(scope.metaChannelId ? { meta_channel_id: scope.metaChannelId } : {}),
                },
            })
            : await CustomerEntity.findByPk(customerId);
        if (!customer) return;

        const updates = {};
        // Update name only if it looks like the generic placeholder set by ConversationStateService
        if (name && (!customer.name || customer.name === 'Customer' || customer.name.startsWith('Customer '))) {
            updates.name = name;
        }
        if (phone && !customer.phone) {
            updates.phone = phone;
        }

        if (Object.keys(updates).length > 0) {
            await customer.update(updates);
        }
    }

    /**
     * Auto-dispatch a parcel to the shop's active courier after order confirmation.
     * Fire-and-forget — failures are logged but do not surface to the customer.
     *
     * @param {object} order — created Order record
     * @param {object} stepData — session step_data (has name, phone, address, total, notes)
     * @param {string} shopId
     */
    static async dispatchParcel(order, stepData, shopId, options = {}) {
        const orderService = getOrderServiceImports();
        if (typeof orderService.bookForOrder === 'function') {
            return orderService.bookForOrder(order, {
                shopId,
                stepData,
                provider: options.provider || null,
                resolvedProvider: options.resolvedProvider || null,
                authorization: options.authorization,
                evidenceSnapshotHash: options.evidenceSnapshotHash,
                idempotencyKey: options.idempotencyKey,
                requireAuthorization: true,
                throwOnError: true,
            });
        }

        const claimError = new Error('Canonical courier booking service is unavailable');
        claimError.code = 'COURIER_DISPATCH_CLAIM_UNAVAILABLE';
        throw claimError;
    }

    static async persistDeliveryResult(order, deliveryResult) {
        const trackingNumber = deliveryResult?.tracking_code || deliveryResult?.consignment_id;
        if (!trackingNumber) {
            throw new Error('Courier returned no tracking reference');
        }

        const provider = deliveryResult.provider || order?.delivery_provider;
        if (!provider) throw new Error('Courier returned no provider');
        const normalizedResult = {
            ...deliveryResult,
            provider,
            consignment_id: deliveryResult.consignment_id || trackingNumber,
            tracking_code: trackingNumber,
            status: deliveryResult.status || 'booked',
        };

        const existingConsignment = order?.delivery_consignment_id;
        const existingTracking = order?.delivery_tracking_code;
        if (existingConsignment || existingTracking) {
            const existingReferences = [existingConsignment, existingTracking].filter(Boolean);
            if (existingReferences.some(reference => reference !== trackingNumber
                && reference !== normalizedResult.consignment_id)) {
                throw new Error('Order already has a different courier tracking reference');
            }
            return normalizedResult;
        }

        // Some isolated callers mock the order model but do not load the
        // delivery-tracking model. Preserve the order-level result in that case;
        // a real application with the model loaded must create the tracking row.
        let entities = null;
        try {
            entities = require('../entities');
        } catch (_) {
            // The mocked database harness may not be able to initialize entities.
        }
        if (entities && typeof entities.DeliveryTracking?.create !== 'function') {
            if (typeof order?.update === 'function') {
                await order.update({
                    delivery_provider: provider,
                    delivery_consignment_id: normalizedResult.consignment_id,
                    delivery_tracking_code: normalizedResult.tracking_code,
                    delivery_status: normalizedResult.status,
                    delivery_dispatched_at: order.delivery_dispatched_at || new Date(),
                });
            }
            return normalizedResult;
        }

        const deliveryTrackingService = require('../delivery/delivery-tracking.service');
        try {
            await deliveryTrackingService.createTrackingRecord(order, normalizedResult);
        } catch (error) {
            if (!error.code) error.code = 'COURIER_RESULT_PERSIST_FAILED';
            throw error;
        }
        return normalizedResult;
    }

    static async getCourierDispatchRecord(order, shopId, provider) {
        let CourierDispatch = null;
        try {
            CourierDispatch = require('../entities').CourierDispatch;
        } catch (_) {
            try { CourierDispatch = require('../delivery/courier-dispatch.entity'); } catch (_) { /* unavailable */ }
        }
        if (!CourierDispatch || typeof CourierDispatch.findOne !== 'function') return null;
        return CourierDispatch.findOne({
            where: { shop_id: shopId, order_id: order.id, provider },
        });
    }

    static async claimCourierDispatch(order, shopId, provider) {
        const { deriveBookCourierIdempotencyKey } = require('../ai/contracts/action.contract');
        const idempotencyKey = deriveBookCourierIdempotencyKey({
            shopId,
            orderId: order.id,
            provider,
        });

        const orderService = getOrderServiceImports();
        if (typeof orderService.claimCourierDispatchRecord === 'function') {
            return orderService.claimCourierDispatchRecord(order, shopId, provider);
        }

        return courierDispatchClaims.claimCourierDispatch({
            shopId,
            orderId: order.id,
            provider,
            idempotencyKey,
        });
    }

    static async updateCourierDispatch(record, values, options = {}) {
        const orderService = getOrderServiceImports();
        if (typeof orderService.transitionCourierDispatchRecord === 'function') {
            return orderService.transitionCourierDispatchRecord(record, values, options);
        }

        return courierDispatchClaims.transitionCourierDispatch(record, values, options);
    }

    static async lookupExistingCourierOrder(shopId, orderNumber, order = null) {
        const deliveryService = require('../delivery/delivery.service');
        const orderService = getOrderServiceImports();
        let activeProvider;
        try {
            if (typeof orderService.resolveCourierProvider === 'function') {
                const resolved = await orderService.resolveCourierProvider(shopId, { requireAiDefault: true });
                if (resolved?.blocked) {
                    return {
                        state: 'blocked',
                        provider: resolved.provider || null,
                        reason: resolved.reason,
                    };
                }
                activeProvider = resolved;
            } else if (typeof deliveryService.resolveAiDefaultProvider === 'function') {
                const resolved = await deliveryService.resolveAiDefaultProvider(shopId);
                if (resolved?.blocked) {
                    return {
                        state: 'blocked',
                        provider: resolved.provider || null,
                        reason: resolved.reason || resolved.reasonCode,
                    };
                }
                activeProvider = resolved;
            } else if (process.env.NODE_ENV === 'test') {
                // Focused legacy fixtures replace order.service entirely. A
                // production process always has the readiness resolver.
                activeProvider = await deliveryService.getActiveProvider(shopId);
            } else {
                return {
                    state: 'unknown',
                    provider: null,
                    error: new Error('Courier readiness resolver is unavailable'),
                };
            }
        } catch (err) {
            return { state: 'unknown', provider: null, error: err };
        }

        if (!activeProvider?.provider || !activeProvider.instance) {
            return {
                state: 'unknown',
                provider: activeProvider?.provider || null,
                error: new Error('Active courier provider could not be resolved'),
            };
        }

        const { provider, instance } = activeProvider;
        const localDispatch = order
            ? await OrderSessionService.getCourierDispatchRecord(order, shopId, provider)
            : null;
        if (String(localDispatch?.status || '').toUpperCase() === 'COMMITTED'
            && (localDispatch.tracking_code || localDispatch.consignment_id)) {
            return {
                state: 'found',
                provider,
                record: localDispatch,
                result: {
                    provider,
                    consignment_id: localDispatch.consignment_id || localDispatch.tracking_code,
                    tracking_code: localDispatch.tracking_code || localDispatch.consignment_id,
                    status: 'booked',
                    invoice: orderNumber,
                },
            };
        }
        if (provider !== 'steadfast' || typeof instance.getOrderStatusByInvoice !== 'function') {
            return { state: 'unsupported', provider };
        }

        try {
            const response = await instance.getOrderStatusByInvoice(orderNumber);
            const consignmentId = response?.consignment_id || response?.consignmentId || null;
            const trackingCode = response?.tracking_code || response?.trackingCode || consignmentId;
            if (!trackingCode) {
                return {
                    state: 'unknown',
                    provider,
                    error: new Error('Courier status lookup returned no tracking reference'),
                };
            }
            return {
                state: 'found',
                provider,
                result: {
                    provider,
                    consignment_id: consignmentId || trackingCode,
                    tracking_code: trackingCode,
                    status: response.delivery_status || response.order_status || 'booked',
                    invoice: response.invoice || orderNumber,
                },
            };
        } catch (err) {
            const status = err?.status || err?.statusCode || err?.response?.status;
            if (status === 404 || err?.code === 'NOT_FOUND') {
                return { state: 'absent', provider };
            }
            return { state: 'unknown', provider, error: err };
        }
    }

    static async markDispatchIndeterminate(order, shopId, provider, reason, ownerToken) {
        const orderService = getOrderServiceImports();
        if (typeof orderService.markCourierDispatchIndeterminate === 'function') {
            return orderService.markCourierDispatchIndeterminate(
                order,
                shopId,
                provider,
                await OrderSessionService.getCourierDispatchRecord(order, shopId, provider),
                reason,
                ownerToken,
            );
        }

        try {
            const localDispatch = await OrderSessionService.getCourierDispatchRecord(order, shopId, provider);
            const transition = await OrderSessionService.updateCourierDispatch(
                localDispatch,
                { status: 'INDETERMINATE', error: reason },
                { ownerToken, expectedStatus: 'PENDING' },
            );
            if (!transition?.updated) return false;
        } catch (err) {
            console.error('[AutoParcel] Failed to update courier_dispatch indeterminate state', {
                orderId: order?.id || null,
                errorCode: safeErrorCode(err, 'DISPATCH_STATE_WRITE_FAILED'),
            });
            return false;
        }

        try {
            if (typeof order?.update === 'function') {
                await order.update({ delivery_status: 'dispatch_indeterminate' });
            } else {
                const { Order } = require('../entities');
                await Order.update(
                    { delivery_status: 'dispatch_indeterminate' },
                    { where: { id: order.id, shop_id: shopId } }
                );
            }
        } catch (err) {
            console.error('[AutoParcel] Failed to mark dispatch_indeterminate', {
                orderId: order?.id || null,
                errorCode: safeErrorCode(err, 'DISPATCH_MARKER_WRITE_FAILED'),
            });
        }

        try {
            const merchantNotificationService = require('../notification/merchant-notification.service');
            const { NOTIFICATION_EVENTS } = require('../notification/notification-events');
            await merchantNotificationService.notifyShop(
                shopId,
                NOTIFICATION_EVENTS.COURIER_BOOKING_FAILED,
                {
                    orderId: order?.id,
                    orderNumber: order?.order_number,
                    provider,
                    reason,
                    status: 'dispatch_indeterminate',
                },
                {
                    dedupeKey: `${order?.id || order?.order_number}:dispatch_indeterminate`,
                    dedupeTtlSeconds: 24 * 60 * 60,
                }
            );
        } catch (err) {
            console.error('[AutoParcel] Failed to notify dispatch_indeterminate', {
                orderId: order?.id || null,
                errorCode: safeErrorCode(err, 'DISPATCH_NOTIFICATION_FAILED'),
            });
        }
        return true;
    }

    static async markCourierSetupRequired(order, shopId, resolution = {}) {
        const orderService = getOrderServiceImports();
        if (typeof orderService.markCourierSetupRequired === 'function') {
            return orderService.markCourierSetupRequired(order, shopId, resolution);
        }

        try {
            if (typeof order?.update === 'function') {
                await order.update({ delivery_status: 'courier_setup_required' });
            }
        } catch (_) {
            // A delivery marker must never change the order confirmation result.
        }

        try {
            const merchantNotificationService = require('../notification/merchant-notification.service');
            const { NOTIFICATION_EVENTS } = require('../notification/notification-events');
            await merchantNotificationService.notifyShop(
                shopId,
                NOTIFICATION_EVENTS.COURIER_SETUP_REQUIRED || 'courier_setup_required',
                {
                    orderId: order?.id,
                    orderNumber: order?.order_number,
                    provider: resolution.provider || null,
                    reason: resolution.reason || 'COURIER_SETUP_REQUIRED',
                    missing: resolution.missing || [],
                    status: 'courier_setup_required',
                },
                {
                    dedupeKey: `${order?.id || order?.order_number}:courier_setup_required`,
                    dedupeTtlSeconds: 24 * 60 * 60,
                }
            );
        } catch (_) {
            // Notification delivery is best effort.
        }
        return {
            blocked: true,
            status: 'courier_setup_required',
            provider: resolution.provider || null,
            reason: resolution.reason || 'COURIER_SETUP_REQUIRED',
            missing: resolution.missing || [],
        };
    }

    /**
     * Dispatch one parcel attempt. An ambiguous provider result remains owned
     * by the durable claim until reconciliation explicitly makes another
     * attempt safe; a provider 404 is never treated as permission to bypass it.
     *
     * @param {object} order
     * @param {object} stepData
     * @param {string} shopId
     */
    static async dispatchParcelWithRetry(order, stepData, shopId, options = {}) {
        const orderService = getOrderServiceImports();
        let provider = options.provider && options.provider !== 'active' ? options.provider : null;
        let resolvedProvider = options.resolvedProvider || null;

        try {
            const deliveryService = require('../delivery/delivery.service');
            if (!resolvedProvider && typeof orderService.resolveCourierProvider === 'function') {
                resolvedProvider = await orderService.resolveCourierProvider(shopId, {
                    provider,
                    requireAiDefault: !provider,
                });
            } else if (!resolvedProvider && typeof deliveryService.resolveAiDefaultProvider === 'function' && !provider) {
                resolvedProvider = await deliveryService.resolveAiDefaultProvider(shopId);
            } else if (!resolvedProvider && process.env.NODE_ENV === 'test') {
                const activeProvider = await deliveryService.getActiveProvider(shopId);
                resolvedProvider = activeProvider
                    ? { ...activeProvider, blocked: false }
                    : {
                        blocked: true,
                        reason: 'AI_DEFAULT_NOT_CONFIGURED',
                        missing: ['ai_default_courier'],
                    };
            } else if (!resolvedProvider) {
                resolvedProvider = {
                    blocked: true,
                    reason: 'COURIER_READINESS_UNAVAILABLE',
                    missing: ['ai_default_courier'],
                };
            }

            if (resolvedProvider?.blocked || !resolvedProvider?.provider || resolvedProvider.provider === 'active') {
                await OrderSessionService.markCourierSetupRequired(
                    order,
                    shopId,
                    resolvedProvider || { reason: 'AI_DEFAULT_NOT_CONFIGURED' },
                );
                return null;
            }

            provider = resolvedProvider.provider;
            if (typeof orderService.buildCourierOrderData === 'function') {
                const courierOrderData = orderService.buildCourierOrderData(order, {
                    stepData,
                    pickup: resolvedProvider.pickup,
                });
                const missingCourierFields = ['customer_name', 'customer_phone', 'delivery_address']
                    .filter(field => !String(courierOrderData[field] || '').trim());
                if (missingCourierFields.length) {
                    await OrderSessionService.markCourierSetupRequired(order, shopId, {
                        provider,
                        reason: 'COURIER_ORDER_DATA_INCOMPLETE',
                        missing: missingCourierFields,
                    });
                    return null;
                }
            }

            const result = await OrderSessionService.dispatchParcel(order, stepData, shopId, {
                ...options,
                provider,
                resolvedProvider,
                idempotencyKey: options.idempotencyKey || require('../ai/contracts/action.contract')
                    .deriveBookCourierIdempotencyKey({ shopId, orderId: order.id, provider }),
            });
            return result?.blocked || result?.failed ? null : result;
        } catch (err) {
            if (err.code !== 'BOOK_COURIER_UNAUTHORIZED') {
                console.error('[AutoParcel] Courier dispatch stopped', {
                    orderId: order?.id || null,
                    errorCode: safeErrorCode(err, 'COURIER_DISPATCH_FAILED'),
                });
            }
            return null;
        }
    }

    // ─── Step prompt generator (used on session resume) ───────────────────────

    /**
     * Fix 14: Build a numbered product list prompt for multi-match selection.
     */
    static buildProductSelectionPrompt(candidates, lang = 'bn') {
        const lines = candidates.map((p, i) => {
            const stockNote = p.in_stock === false ? pickLang(lang, ' [স্টক নেই]', ' [Out of stock]') : '';
            const bnName = p.name_bn ? ` (${p.name_bn})` : '';
            return `${i + 1}. ${p.name}${bnName} — ৳${p.price}${stockNote}`;
        });
        const header = pickLang(lang,
            'একাধিক পণ্য পাওয়া গেছে। কোনটি চান তার নম্বর লিখুন:',
            "Multiple products found. Enter the number of the item you'd like to order:");
        return `${header}\n${lines.join('\n')}`;
    }

    static generateStepPrompt(step, stepData, lang) {
        const L = lang || stepData?.language || 'bn';
        const prompts = {
            'SELECTING_PRODUCT':    pickLang(L, 'পণ্য নির্বাচন করুন (নম্বর লিখুন)', 'Select a product (enter a number)'),
            'PRODUCT_CONFIRMATION': pickLang(L, 'আপনি কি এই পণ্যটি অর্ডার করতে চান?', 'Do you want to order this item?'),
            'COLLECTING_QUANTITY':  pickLang(L, 'কয়টা নিবেন?', 'How many would you like?'),
            'ADD_MORE':             pickLang(L,
                `আরো কিছু নিতে চান? ${productInputPrompt(L, 'more')}, না হলে "শেষ" লিখুন`,
                `Add another item? ${productInputPrompt('en', 'more')}, or type "done"`),
            'ADDING_PRODUCT':       pickLang(L,
                `কোন পণ্যটি যোগ করতে চান? ${productInputPrompt(L)}`,
                `Which product to add? ${productInputPrompt('en')}`),
            'COLLECTING_NAME':      pickLang(L, 'আপনার নাম কী?', "What's your name?"),
            'COLLECTING_PHONE':     pickLang(L, 'আপনার মোবাইল নম্বর কত?', "What's your mobile number?"),
            'COLLECTING_ADDRESS':   pickLang(L, 'আপনার ডেলিভারির ঠিকানা কি?', "What's your delivery address?"),
            'COLLECTING_ZONE':      pickLang(L, 'আপনার ডেলিভারি এলাকা নির্বাচন করুন', 'Select your delivery area'),
            'COLLECTING_PAYMENT':      pickLang(L, 'পেমেন্ট পদ্ধতি নির্বাচন করুন', 'Select payment method'),
            'AWAITING_MFS_SCREENSHOT': pickLang(L, 'পেমেন্ট পদ্ধতি নির্বাচন করুন', 'Select payment method'),
            'COLLECTING_NOTES':        pickLang(L, 'কোনো বিশেষ নির্দেশনা আছে?', 'Any special instructions?'),
            'ORDER_SUMMARY':        pickLang(L, 'অর্ডার নিশ্চিত করুন', 'Confirm order')
        };

        return prompts[step] || pickLang(L, 'পরবর্তী ধাপে যান', 'Proceed to next step');
    }

    // ─── Extraction helpers ───────────────────────────────────────────────────

    /**
     * True when the whole message is just a confirmation/acknowledgement word —
     * used to reject such answers where free text is expected (e.g. the name step).
     * Exact equality only; never substring (would reject real names like "Jia").
     */
    static isBareConfirmationWord(text) {
        return BARE_CONFIRMATIONS.has(normalizeConfirmationText(text));
    }

    static extractConfirmation(text) {
        const normalized = normalizeConfirmationText(text);
        if (!normalized || [...normalized].length === 1) return false;
        if (containsConfirmationNegation(normalized)) return false;
        return BARE_CONFIRMATIONS.has(normalized) || CONFIRMATION_PHRASES.has(normalized);
    }

    static extractPhoneNumber(text) {
        // Strip formatting characters before matching (Bangladeshi buyers often write 01711-123456)
        const cleaned = text.replace(/[\s\-().]/g, '');
        const phoneRegex = /(?:\+?880)?01[3-9]\d{8}/;
        const match = cleaned.match(phoneRegex);
        if (!match) return null;
        // Always return 11-digit local format
        return match[0].replace(/^\+?880/, '');
    }

    // ─── Out-of-stock prompt ──────────────────────────────────────────────────

    static buildOutOfStockPrompt(reason, productInfo, lang = 'bn') {
        const name = productInfo?.name || pickLang(lang, 'এই পণ্যটি', 'this item');
        return pickLang(lang,
            `দুঃখিত! "${name}" এখন ${reason || 'স্টক আউট'}। 😔\n\n` +
            `আমাদের অন্য পণ্যগুলো দেখতে চান? অথবা অন্য কোনো সাহায্য লাগলে জানান!`,
            `Sorry! "${name}" is currently ${reason || 'out of stock'}. 😔\n\n` +
            `Would you like to see our other products, or can I help you with something else?`);
    }

    // ─── Multi-product cart helpers ───────────────────────────────────────────

    /**
     * The order's line items. The cart (step_data.cart) is the source of truth;
     * for sessions created before multi-product (or any single-item flow) we fall
     * back to a one-item cart built from the last-configured product_info.
     */
    static getCartItems(session, stepData) {
        const cart = stepData?.cart;
        if (Array.isArray(cart) && cart.length) return cart;
        const p = session?.product_info;
        if (p && p.id) {
            return [{
                product_id: p.id,
                name: p.name,
                name_bn: p.name_bn || null,
                price: p.price,
                quantity: p.quantity || 1,
                track_quantity: p.track_quantity === true,
                stock_snapshot: p.track_quantity === true ? p.stock_snapshot ?? null : null,
            }];
        }
        return [];
    }

    /** Add-another prompt shown after an item is carted. */
    static buildAddMorePrompt(lastItem, cart, lang) {
        const count = Array.isArray(cart) ? cart.length : 0;
        return pickLang(lang,
            `"${lastItem.name}" কার্টে যোগ হয়েছে ✅ (মোট ${count}টি পণ্য)।\n\n` +
            `আরো কিছু নিতে চান? ${productInputPrompt(lang, 'more')}।\nআর কিছু না লাগলে "শেষ" লিখুন।`,
            `Added "${lastItem.name}" to your cart ✅ (${count} item${count > 1 ? 's' : ''}).\n\n` +
            `Want to add anything else? ${productInputPrompt('en', 'more')}.\nIf that's all, type "done".`);
    }

    /** Whole-message "finish / no more items" intent at the add-more step. */
    static isCheckoutWord(text) {
        const t = normalizeAddMoreDecisionText(text);
        if (isNegatedMutation(t)) return false;
        const DONE = new Set([
            'no', 'na', 'nah', 'nope', 'no more', 'done', 'finish', 'finished',
            'checkout', 'check out', 'complete', 'enough', 'bas', 'bus',
            "that's all", 'thats all', 'shesh', 'sesh', 'sesh koro',
            'no thanks', 'no thank you', 'no need', 'nothing else', 'not needed',
            'confirm', 'confirm this', 'confirmed', 'proceed', 'order confirm',
            'order korun', 'order koren', 'order koro', 'order ta confirm koren',
            'confirm kore den', 'confirm kore din', 'confirm koren', 'confirm korun',
            'শেষ', 'না', 'না ভাই', 'আর না', 'ar na', 'arna', 'ar lagbe na',
            'aro lagbe na', 'r lagbe na', 'lagbe na', 'lagbena', 'বাস',
            'হয়ে গেছে', 'হয়ে গেছে', 'এটুকুই', 'এইটাই', 'এইটাই দেন', 'ঠিক আছে',
        ]);
        if (DONE.has(t)) return true;

        const CHECKOUT_PATTERNS = [
            /\bno\b(?:\s+(?:thanks?|thank\s+you|need|more))?\b/i,
            /\bno\b.*\b(?:confirm|checkout|order|proceed)\b/i,
            /\b(?:confirm|confirmed|checkout|proceed)\b/i,
            /\border\s+(?:ta\s+)?confirm(?:\s+(?:koren|korun|koro|kore\s+din))?\b/i,
            /\border\s+(?:korun|koren|koro)\b/i,
            /\bconfirm\s*(?:this|kore\s+(?:den|din)|koren|korun|koro)?\b/i,
            /\b(?:that'?s\s+all|thats\s+all|nothing\s+else|no\s+need|not\s+needed|enough)\b/i,
            /\b(?:bas|bus|shesh|sesh)(?:\s+(?:koro|koren|korun))?\b/i,
            /\b(?:ar|r|aro)\s+(?:kichu\s+)?lagbe\s+na\b/i,
            /\blagbe\s*na\b|\blagbena\b/i,
            /\b(?:dorkar|darkar|dorcar)\s+(?:nai|nei|na)\b/i,
            /^না(?:\s+ভাই)?$/i,
            /না\s+.*(?:অর্ডার|কনফার্ম|এটুকুই)/i,
            /আর\s+(?:কিছু\s+)?লাগবে\s+না/i,
            /লাগবে\s+না/i,
            /দরকার\s+(?:নেই|নাই)/i,
            /^(?:শেষ|বাস|হয়ে গেছে|হয়ে গেছে|এটুকুই|এইটাই|এইটাই দেন|ঠিক আছে)$/i,
            /(?:কনফার্ম|অর্ডার\s+(?:করুন|করেন|কনফার্ম))/i,
        ];
        return CHECKOUT_PATTERNS.some(pattern => pattern.test(t));
    }

    static buildProceedToCheckoutPrompt(lang = 'bn') {
        return pickLang(lang,
            'ঠিক আছে, বর্তমান কার্টের পণ্যগুলো দিয়েই চেকআউট এগিয়ে নিচ্ছি। অনুগ্রহ করে আপনার নাম দিন।',
            "Okay, I'll continue checkout with the items currently in your cart. What's your name?");
    }

    static logAddMoreCheckoutDecision(session, originalMessage, cart = []) {
        console.info('[OrderSession] add_more_reply_proceed_to_confirm_order', {
            session_id: session?.id || null,
            shop_id: session?.shop_id || null,
            normalized_intent: 'proceed_to_confirm_order',
            original_message: String(originalMessage || '').slice(0, 300),
            cart_count: Array.isArray(cart) ? cart.length : 0,
        });
    }

    /** Whole-message "yes, add another (but I haven't named it yet)" intent. */
    static isBareAddWord(text) {
        const t = String(text || '').toLowerCase().trim();
        const ADD = new Set([
            'yes', 'y', 'add', 'add more', 'add another', 'more', 'aro', 'aaro',
            'ar', 'ar ekta', 'aro nibo', 'aro lagbe', 'aro chai',
            'আরো', 'আরও', 'হ্যাঁ', 'ha', 'haa', 'han', 'ji', 'জি',
        ]);
        return ADD.has(t);
    }

    /**
     * Identify the next product from a free-text name and/or a photo, reusing the
     * same search + image-match pipeline the session start uses.
     * @returns {Promise<{products: Array, wasFallback: boolean}>}
     */
    static async identifyProduct(shopId, query, rawMessage) {
        const result = await productSearch
            .searchForOrder({ shopId, query, limit: 5 })
            .catch(() => ({ products: [], wasFallback: true }));

        let products = result.products || [];
        let wasFallback = !!result.wasFallback;

        // When photo matching is explicitly enabled, use the image only after
        // text search comes up empty. The default path remains text-only.
        if ((wasFallback || !products.length) && rawMessage?.imageUrl && photoMatchEnabled()) {
            try {
                const { matchImageMessage } = require('../ai/image-product-matcher.service');
                const imageMatch = await matchImageMessage({ shopId, imageUrl: rawMessage.imageUrl, text: query });
                if (imageMatch.products?.length) {
                    products = imageMatch.products;
                    wasFallback = false;
                }
            } catch (_) { /* image matching is best-effort */ }
        }

        return { products, wasFallback };
    }

    /**
     * Resolve the customer's next-product message into a step transition:
     *   no/unsure match → stay on ADDING_PRODUCT and re-ask
     *   one match       → set product_info, go to COLLECTING_QUANTITY
     *   many matches    → seed candidates, go to SELECTING_PRODUCT
     * Mutates step_data.product_candidates when a picker is needed.
     */
    static async applyNextProduct(session, step_data, answer, rawMessage, lang) {
        const { products, wasFallback } = await OrderSessionService.identifyProduct(session.shop_id, answer, rawMessage);

        if (wasFallback || !products.length) {
            return {
                nextStep: 'ADDING_PRODUCT',
                prompt: pickLang(lang,
                    `এই নামে কোনো পণ্য খুঁজে পাইনি। ${productInputPrompt(lang, 'not-found')}, অথবা "শেষ" লিখুন।`,
                    `Could not find that product. ${productInputPrompt('en', 'not-found')}, or type "done".`),
            };
        }

        if (products.length === 1) {
            const p = products[0];
            let stock;
            try {
                stock = await productSearch.checkStock(p.id, session.shop_id);
            } catch (_) {
                return {
                    nextStep: 'ADDING_PRODUCT',
                    prompt: pickLang(lang,
                        'স্টক এখন যাচাই করা যাচ্ছে না। একটু পরে আবার চেষ্টা করুন বা একজন বিক্রেতার সাহায্য নিন।',
                        'I cannot verify stock right now. Please try again shortly or ask a shop team member.'),
                };
            }
            if (!stock.available) {
                return {
                    nextStep: 'ADDING_PRODUCT',
                    prompt: OrderSessionService.buildOutOfStockPrompt(stock.reason, p, lang),
                };
            }
            const pi = {
                id: p.id,
                name: p.name,
                name_bn: p.name_bn || null,
                price: stock.product?.price ?? p.price,
                quantity: 1,
                track_quantity: stock.product?.track_quantity === true || p.track_quantity === true,
                stock_snapshot: stock.product?.track_quantity === true
                    ? finiteNumberOrNull(stock.product.quantity)
                    : (p.track_quantity === true ? finiteNumberOrNull(p.quantity) : null),
            };
            await session.update({ product_info: pi });
            session.product_info = pi;
            return {
                nextStep: 'COLLECTING_QUANTITY',
                prompt: pickLang(lang,
                    `"${pi.name}" ✅\n\nকয়টা নিবেন?`,
                    `"${pi.name}" ✅\n\nHow many would you like?`),
            };
        }

        step_data.product_candidates = products.slice(0, 5).map(p => ({
            id: p.id,
            name: p.name,
            name_bn: p.name_bn || null,
            price: p.price,
            in_stock: p.in_stock,
        }));
        return {
            nextStep: 'SELECTING_PRODUCT',
            prompt: OrderSessionService.buildProductSelectionPrompt(step_data.product_candidates, lang),
        };
    }

    // ─── Free-text multi-item parsing ─────────────────────────────────────────

    /**
     * Split a single free-text message into multiple line items, e.g.
     * "2 lawn + 1 dupatta" → [{quantity:2, query:'lawn'}, {quantity:1, query:'dupatta'}].
     * Conservative by design: only splits on explicit "and"-style connectors
     * (never inside a product name) and returns [] for a single item so the
     * existing one-product flow is unchanged. The caller resolves each query and
     * falls back gracefully when a segment doesn't match exactly one product.
     */
    static parseLineItems(text) {
        if (!text || typeof text !== 'string') return [];
        const normalized = text.replace(/[০-৯]/g, (d) => BN_DIGITS[d] || d).trim();
        if (!normalized) return [];
        // Explicit connectors only. Word connectors require surrounding whitespace
        // so they are standalone words, not substrings of a product name. '+', ',',
        // '&', 'and', 'plus', Bengali 'আর', Banglish 'ar'.
        const CONNECTORS = /\s*\+\s*|\s*,\s*|\s*&\s*|\s+and\s+|\s+plus\s+|\s+আর\s+|\s+ar\s+/i;
        const segments = normalized.split(CONNECTORS).map((s) => s.trim()).filter(Boolean);
        if (segments.length < 2) return [];
        const items = [];
        for (const seg of segments) {
            const query = OrderSessionService.stripQuantityTokens(seg);
            if (!query) continue;
            items.push({ quantity: extractQuantity(seg) || 1, query });
        }
        return items.length >= 2 ? items : [];
    }

    /**
     * Strip a LEADING or TRAILING quantity expression from a segment, leaving the
     * product query. Only the ends are touched, so a number-word inside a product
     * name ("Azal Lawn Two Piece") survives. Trailing strips digits only — trailing
     * number-words are rare and would clip names like "Two Piece".
     */
    static stripQuantityTokens(seg) {
        const qw = Object.keys(QTY_WORDS).join('|');
        const unit = '(?:ta|ti|টা|টি|pcs?|pc)';
        let s = String(seg).replace(/[০-৯]/g, (d) => BN_DIGITS[d] || d).trim();
        s = s.replace(new RegExp(`^(?:\\d{1,2}|${qw})(?:\\s*${unit})?\\s+`, 'i'), '');
        s = s.replace(new RegExp(`\\s+\\d{1,2}(?:\\s*${unit})?$`, 'i'), '');
        return s.replace(/\s+/g, ' ').trim();
    }

    /**
     * Resolve a free-text message that may name several products at once and add
     * each resolved, in-stock line to the cart. Falls back to the single-product
     * path when the message isn't multi-item. Mutates step_data.cart.
     */
    static async applyLineItems(session, step_data, answer, rawMessage, lang) {
        const parsed = OrderSessionService.parseLineItems(answer);
        if (parsed.length < 2) {
            return OrderSessionService.applyNextProduct(session, step_data, answer, rawMessage, lang);
        }

        const added = [];
        const unresolved = [];
        for (const { quantity, query } of parsed) {
            const { products, wasFallback } = await OrderSessionService.identifyProduct(session.shop_id, query, null);
            if (wasFallback || products.length !== 1) { unresolved.push(query); continue; }
            const p = products[0];
            let stock;
            try {
                stock = await productSearch.checkStock(p.id, session.shop_id, quantity);
            } catch (_) {
                return {
                    nextStep: 'ADD_MORE',
                    prompt: pickLang(lang,
                        'স্টক যাচাই করা যাচ্ছে না, তাই এই পণ্যটি কার্টে যোগ করা হয়নি। একটু পরে আবার চেষ্টা করুন।',
                        `I could not verify stock, so "${p.name}" was not added. Please try again shortly.`),
                };
            }
            if (!stock.available) { unresolved.push(query); continue; }
            const item = {
                product_id: p.id,
                name: p.name,
                name_bn: p.name_bn || null,
                price: stock.product?.price ?? p.price,
                quantity,
                track_quantity: stock.product?.track_quantity === true || p.track_quantity === true,
                stock_snapshot: stock.product?.track_quantity === true
                    ? finiteNumberOrNull(stock.product.quantity)
                    : (p.track_quantity === true ? finiteNumberOrNull(p.stock_snapshot) : null),
            };
            const cartGate = await authorizeSessionMutation(session, 'EDIT_PREORDER_CART', {
                orderSessionId: session.id,
                edit: 'add',
                lineIndex: (step_data.cart || []).length,
                quantity,
            }, { mutationsAllowed: true });
            verifySessionMutationAuthorization(session, 'EDIT_PREORDER_CART', cartGate);
            step_data.cart = [...(step_data.cart || []), item];
            added.push(item);
        }

        if (!added.length) {
            // Nothing resolved cleanly — let the single-product path try the whole
            // message (e.g. a multi-word product name that contains "and").
            return OrderSessionService.applyNextProduct(session, step_data, answer, rawMessage, lang);
        }

        const last = added[added.length - 1];
        session.product_info = last;
        await session.update({ product_info: last });
        return {
            nextStep: 'ADD_MORE',
            prompt: OrderSessionService.buildMultiAddPrompt(added, unresolved, step_data.cart, lang),
        };
    }

    /** Add-more prompt after several items were carted in one message. */
    static buildMultiAddPrompt(added, unresolved, cart, lang) {
        const names = added.map((i) => `${i.name} x${i.quantity}`).join(', ');
        const count = Array.isArray(cart) ? cart.length : added.length;
        const missing = (unresolved && unresolved.length)
            ? pickLang(lang,
                `\n("${unresolved.join('", "')}" খুঁজে পাইনি — নাম লিখে আবার চেষ্টা করুন।)`,
                `\n(Couldn't find "${unresolved.join('", "')}" — try its name again.)`)
            : '';
        return pickLang(lang,
            `কার্টে যোগ হয়েছে ✅: ${names} (মোট ${count}টি পণ্য)।${missing}\n\n` +
            `আরো কিছু নিতে চান? ${productInputPrompt(lang, 'more')}।\nআর কিছু না লাগলে "শেষ" লিখুন।`,
            `Added to your cart ✅: ${names} (${count} item${count > 1 ? 's' : ''}).${missing}\n\n` +
            `Want to add anything else? ${productInputPrompt('en', 'more')}.\nIf that's all, type "done".`);
    }

    // ─── Per-line cart editing (at the summary) ───────────────────────────────

    /**
     * Recognise a per-line cart edit at the summary step. Matches the message
     * against the live cart's product names and returns the action to apply:
     *   { action: 'remove', index }              — drop a line
     *   { action: 'setqty', index, quantity }    — change a line's quantity
     *   { action: null }                         — not an edit (fall through)
     */
    static detectCartEdit(text, cart) {
        const NONE = { action: null };
        if (!text || !Array.isArray(cart) || !cart.length) return NONE;
        const t = String(text).replace(/[০-৯]/g, (d) => BN_DIGITS[d] || d).toLowerCase().trim();
        if (isNegatedMutation(t)) return NONE;

        const qty = extractQuantity(t);
        const QUANTITY_EDIT = /\b(quantity|qty|set|make|update|change|koro|koren|korun|kor|piece|pcs?)\b|পরিমাণ|সংখ্যা|করেন|করুন|করো|করে দিন|করে দেন/i;
        const idx = OrderSessionService._matchCartLine(t, cart);
        if (idx < 0) {
            if (cart.length === 1 && qty && QUANTITY_EDIT.test(t)) {
                return { action: 'setqty', index: 0, quantity: qty };
            }
            return NONE;
        }

        const REMOVE = /\b(remove|delete|cancel|drop|baad|hatao|chai na|lagbe na|lagbena)\b|বাদ|চাই না|লাগবে না|সরাও/i;
        if (REMOVE.test(t)) return { action: 'remove', index: idx };

        if (qty) return { action: 'setqty', index: idx, quantity: qty };
        return NONE;
    }

    /**
     * Index of the cart line a message references, or -1. A line matches when a
     * distinctive (≥3 char) token of its name/name_bn appears in the text. Two
     * lines matching → -1 so we never edit the wrong item.
     */
    static _matchCartLine(text, cart) {
        const tokensOf = (s) => String(s || '')
            .toLowerCase()
            .split(/[^a-z0-9ঀ-৿]+/)
            .filter((w) => w.length >= 3);
        let found = -1;
        for (let i = 0; i < cart.length; i++) {
            const names = [cart[i].name, cart[i].name_bn].filter(Boolean);
            const hit = names.some((n) => tokensOf(n).some((tok) => text.includes(tok)));
            if (hit) {
                if (found >= 0) return -1; // ambiguous
                found = i;
            }
        }
        return found;
    }

    /** Apply a detected cart edit and produce the next step + re-rendered summary. */
    static async applyCartEdit(session, step_data, edit, cart, lang, mutationContext = {}) {
        const gateResult = await authorizeSessionMutation(session, 'EDIT_PREORDER_CART', {
            orderSessionId: session.id,
            edit: edit.action,
            lineIndex: edit.index,
            quantity: edit.quantity || null,
        }, mutationContext);
        verifySessionMutationAuthorization(session, 'EDIT_PREORDER_CART', gateResult);
        if (edit.action === 'remove') {
            const newCart = cart.filter((_, i) => i !== edit.index);
            if (!newCart.length) {
                // Removed the last line — the cart is empty; ask what to order next.
                step_data.cart = [];
                session.product_info = null;
                await session.update({ product_info: null });
                return {
                    nextStep: 'ADDING_PRODUCT',
                    prompt: pickLang(lang,
                        `কার্ট এখন খালি। কোন পণ্যটি অর্ডার করতে চান? ${productInputPrompt(lang)}।`,
                        `Your cart is now empty. Which product would you like to order? ${productInputPrompt('en')}.`),
                    completed: false,
                };
            }
            step_data.cart = newCart;
        } else if (edit.action === 'setqty') {
            step_data.cart = cart.map((c, i) => (i === edit.index ? { ...c, quantity: edit.quantity } : c));
        }
        return {
            nextStep: 'ORDER_SUMMARY',
            prompt: OrderSessionService.generateOrderSummary(session, step_data, lang),
            completed: false,
        };
    }

    // ─── Order summary ────────────────────────────────────────────────────────

    static buildContractOrderSummary(session, stepData) {
        const cart = OrderSessionService.getCartItems(session, stepData);
        const deliveryCharge = Number(stepData.delivery_charge || 0);
        const items = cart.map(item => ({
            productId: item.product_id,
            variantId: item.variant_id || null,
            quantity: item.quantity || 1,
            unitPrice: item.price || 0,
            stockSnapshot: item.track_quantity === true ? finiteNumberOrNull(item.stock_snapshot) : null,
            lineTotal: (item.price || 0) * (item.quantity || 1),
        }));
        return {
            currency: 'BDT',
            customerName: stepData.name,
            customerPhone: stepData.phone,
            address: stepData.address,
            deliveryCharge,
            deliveryMethod: stepData.delivery_method || 'COURIER',
            paymentMethod: stepData.payment_method,
            items,
            total: items.reduce((sum, item) => sum + item.lineTotal, 0) + deliveryCharge,
        };
    }

    static generateOrderSummary(session, stepData, lang) {
        const L = lang || stepData?.language || 'bn';
        const cart = OrderSessionService.getCartItems(session, stepData);
        const { name, phone, address, delivery_zone, delivery_charge, payment_method, notes } = stepData;
        const zLabel = zoneLabel(delivery_zone, L) || 'N/A';
        const gLabel = gatewayLabel(payment_method, L) || 'N/A';
        const itemsTotal = cart.reduce((s, c) => s + (c.price || 0) * (c.quantity || 1), 0);
        const grandTotal = itemsTotal + (delivery_charge || 0);
        // One line per cart item; product names render the same in both languages.
        const itemLines = (cart.length
            ? cart.map(c => `📦 ${c.name || 'N/A'} x${c.quantity || 1} — ৳${(c.price || 0) * (c.quantity || 1)}`)
            : ['📦 N/A']
        ).join('\n');

        if (L === 'en') {
            return `✅ Order Summary:
${itemLines}
💰 Items: ৳${itemsTotal}
🚚 Delivery: ৳${delivery_charge || 0} (${zLabel})
💳 Payment: ${gLabel}
📍 Address: ${address}
👤 Name: ${name} | 📞 ${phone}
${notes ? `📝 Note: ${notes}\n` : ''}Total: ৳${grandTotal}

Type "YES" to confirm.`;
        }

        return `✅ অর্ডার সারসংক্ষেপ:
${itemLines}
💰 মোট পণ্য: ৳${itemsTotal}
🚚 ডেলিভারি: ৳${delivery_charge || 0} (${zLabel})
💳 পেমেন্ট: ${gLabel}
📍 ঠিকানা: ${address}
👤 নাম: ${name} | 📞 ${phone}
${notes ? `📝 নোট: ${notes}\n` : ''}সর্বমোট: ৳${grandTotal}

নিশ্চিত করতে "YES" লিখুন।`;
    }
}

module.exports = OrderSessionService;
