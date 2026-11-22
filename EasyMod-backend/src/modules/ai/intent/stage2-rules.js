'use strict';

const { resolveDomain } = require('../contracts/intent.contract');

const RULESET_VERSION = '1.1.0';

// Existing order-flow literals. Keep these sets in this module so every
// deterministic caller shares the exact same characterization surface.
const PURCHASE_PATTERNS = Object.freeze([
    // English
    'i want to order', 'want to order', 'i will order', 'place an order', 'place order',
    'confirm order', 'i want to buy', 'want to buy', 'buy it', 'buy this', 'purchase it',
    // Banglish
    'order korbo', 'order dibo', 'order korte chai', 'order dite chai', 'order confirm',
    'confirm korun', 'confirm koren', 'confirm koro', 'confirm kore din', 'confirm korlam',
    'nibo', 'nibe', 'nimu', 'nilam', 'kinbo', 'kinbe', 'kinte chai', 'kine nibo',
    // Bengali
    'অর্ডার কর', 'অর্ডার দিব', 'অর্ডার দে', 'অর্ডার কনফার্ম', 'কনফার্ম কর',
    'নিব', 'নিবো', 'নিলাম', 'কিনব', 'কিনবো', 'কিনতে চাই', 'নিতে চাই',
]);

const CHECKOUT_PATTERNS = Object.freeze([
    /\bconfirm\s+order\b(?!\s+for\b)(?:\s+(?:yes|now|please))?\b/i,
    /\byes\s+confirm(?:\s+(?:this|the))?\s+order\b/i,
    /\b(?:checkout(?:\s+(?:now|order))?|proceed\s+checkout)\b/i,
    /\border(?:\s+ta)?\s+confirm(?:\s+(?:korun|koren|koro|korlam))?\b/i,
    /ঠিক আছে\s+অর্ডার\s+কনফার্ম/i,
    /\bconfirm\s+korlam\b/i,
    /^\s*i\s+confirm\s*[!.?]*$/i,
    /^\s*yes\s+go\s+ahead\s*[!.?]*$/i,
]);

const normalizeForIntent = (text) => String(text || '').replace(/\b(?:oder|odar|ordar)\b/g, 'order');

const STATUS_HINTS = Object.freeze([
    'where is', 'status', 'track', 'tracking', 'kothay', 'কোথায়', 'কই', 'স্ট্যাটাস', 'ট্র্যাক', 'অবস্থা',
    'koi ', 'kobe pabo', 'kobe debe',
]);

const normalizeForCancel = (message) => String(message || '')
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[“”"]/g, ' ')
    .replace(/[,.!?;:।]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const EXACT_CANCEL_PHRASES = new Set([
    'cancel',
    'cancel order',
    'order cancel',
    'cancel korbo',
    'cancel koren',
    'cancel korun',
    'cancel koro',
    'cancel kor',
    'cancel kore din',
    'cancel chai',
    'cancel my order',
    'cancel my session',
    'cancel checkout',
    'order batil',
    'order baatil',
    'batil',
    'baatil',
    'বাতিল',
    'অর্ডার বাতিল',
]);

const CANCEL_PATTERNS = Object.freeze([
    /\border(?:\s+ta|\s+টা)?\s+(?:cancel|batil|baatil)\b/i,
    /\bcancel\s+(?:my\s+)?(?:order|session|checkout|korbo|koren|korun|koro|kor|kore\s+din|chai)\b/i,
    /\b(?:i\s+want\s+to|please|i'?d\s+like\s+to)\s+cancel\s+(?:(?:my|this|the)\s+)?(?:order|session|checkout)\b/i,
    /\b(?:don't|dont|do\s+not)\s+(?:want\s+)?(?:this\s+)?order\b/i,
    /অর্ডার\s*(?:টা|টি)?\s+বাতিল(?:\s+(?:করুন|করেন|করে দিন))?/i,
    /^বাতিল(?:\s+(?:করুন|করেন|করে দিন|করবো))?$/i,
]);

const PRODUCT_INTENT_KEYWORDS = Object.freeze([
    // English
    'available', 'price', 'cost', 'stock', 'buy', 'order', 'purchase',
    'want', 'need', 'looking', 'show', 'color', 'colour', 'size', 'delivery',
    'shipping', 'discount', 'offer', 'product', 'item', 'collection',
    // Banglish / Bengali (romanised)
    'ache', 'nai', 'daam', 'dam', 'lagbe', 'nibo', 'chai', 'dekhao',
    'pabo', 'koto', 'takar', 'taka', 'paoa', 'pawa', 'deliver', 'stock',
    // Bengali script
    'দাম', 'মূল্য', 'কত', 'টাকা', 'দেখান', 'দেখাও', 'আছে', 'নাই', 'নেই',
    'কিনব', 'কিনবো', 'লাগবে', 'চাই', 'অর্ডার', 'সাইজ', 'মাপ', 'রং', 'কালার',
    'স্টক', 'ডেলিভারি', 'ছাড়', 'অফার', 'প্রোডাক্ট', 'পাব', 'পাবো', 'নিব', 'নিবো',
]);

const NON_PRODUCT_CHATTER = /^(?:ok(?:ay)?|thanks?|thank\s*you|thx|tnx|dhonnobad|ধন্যবাদ|আচ্ছা|ঠিক\s*আছে|acha|thik\s*ache|bye|good\s*bye|ta\s*ta|allah\s*hafez|আল্লাহ\s*হাফেজ|hmm+|yes|no|হ্যাঁ|না|ji|জি)[\s!.,👍🙏😊❤️]*$/i;

const GREETING_PATTERN = /^(?:hi|hii+|hey+|hello+|yo|salam|assalam(?:u)?\s*alaikum|walaikum\s*assalam|nomoshkar|নমস্কার|আসসালামু\s*আলাইকুম|ওয়ালাইকুম\s*আসসালাম|হ্যালো|হাই|good\s*(?:morning|afternoon|evening|night))[\s!.,👋😊🙏]*$/i;

// New Bengali literals are collected here for Bangladesh Language QA review.
// No native-language review is claimed by this implementation.
const PENDING_BANGLA_LANGUAGE_QA_LITERALS = Object.freeze([
    'বন্ধ করুন', 'আর মেসেজ চাই না', 'মেসেজ বন্ধ',
    'মানুষের সাথে কথা বলতে চাই', 'একজন মানুষের সাথে কথা বলুন', 'কাস্টমার কেয়ার চাই',
    'ডেলিভারি চার্জ', 'ঢাকার বাইরে কত', 'কুরিয়ার দিয়ে এখন কত লাগবে', 'কুরিয়ার দিয়ে এখন কত লাগবে',
    'ডেলিভারি দেন', 'কোথায় ডেলিভারি দেন',
    'পেমেন্টটা গেছে', 'কি কি পেমেন্ট নেন', 'পেমেন্ট পদ্ধতি',
    'সাইজ', 'মাপ', 'রং', 'উপাদান', 'ব্র্যান্ড', 'বৈশিষ্ট্য',
    'অর্ডারটা বদলাতে চাই', 'অর্ডার ফেরত দিতে চাই', 'অভিযোগ করতে চাই', 'অর্ডার দেরি', 'এইটা নেব',
    'ঠিক আছে অর্ডার কনফার্ম', 'এই পণ্যটি কি আছে', 'নাই নাকি আছে', 'ভালো আছেন',
    'এই শার্টটা স্টকে আছে', 'কোন সাইজ স্টকে আছে', 'স্টক আছে',
]);

const STOP_OPT_OUT_PHRASES = Object.freeze([
    'stop', 'unsubscribe', 'opt out', 'do not message me', 'dont message me',
    'no more messages',
    ...PENDING_BANGLA_LANGUAGE_QA_LITERALS.slice(0, 3),
]);
const HUMAN_HANDOFF_PHRASES = Object.freeze([
    'real person', 'talk to a person', 'talk to human', 'talk to a human', 'connect me to customer care',
    'customer care chai', 'i need customer care', 'human please', 'human help', 'need a human',
    'i need an agent', 'let me speak with someone', 'shop team help me',
    // D-P2-06: phrasings actually observed from BD customers (word-boundary matched).
    'human agent', 'speak to a human', 'want to speak to someone', 'i want to talk to someone',
    'ekjon manus', 'manus er sathe', 'manusher sathe', 'manus kotha',
    ...PENDING_BANGLA_LANGUAGE_QA_LITERALS.slice(3, 6),
]);
const SHADOW_PURCHASE_PATTERNS = Object.freeze([
    'i would like this', 'please place this',
    PENDING_BANGLA_LANGUAGE_QA_LITERALS.find(literal => literal === 'এইটা নেব'),
]);

const POST_PURCHASE_REASON_RULES = Object.freeze([
    { reason: 'MODIFICATION', patterns: [/\b(?:change|modify|edit)\s+(?:(?:my|the)\s+)?order\b/i, /অর্ডারটা বদলাতে চাই/i] },
    { reason: 'RETURN', patterns: [/\b(?:return|send back)\b.*\border\b/i, /অর্ডার ফেরত দিতে চাই/i] },
    { reason: 'COMPLAINT', patterns: [
        /\b(?:i\s+(?:want|need)\s+to\s+complain|i\s+have\s+a\s+complaint|complain(?:t)?\s+about\s+(?:my\s+)?order)\b/i,
        /অভিযোগ করতে চাই/i,
    ] },
    { reason: 'DELAY', patterns: [
        /\b(?:late|delayed|delay)\b.*\b(?:order|delivery)\b/i,
        /\border\b.*\b(?:late|delayed|delay)\b/i,
        /অর্ডার দেরি/i,
    ] },
]);

const ATTRIBUTE_RULES = Object.freeze([
    { attribute: 'size', patterns: [/\bsize\b/i, /\b(?:s|m|l|xl|xxl)\s*size\b/i, /\bmaap\b/i, /সাইজ/i, /মাপ/i] },
    { attribute: 'color', patterns: [/\bcolou?r\b/i, /\bcolour\b/i, /\brong\b/i, /রং/i, /কালার/i] },
    { attribute: 'material', patterns: [/\bmaterial\b/i, /\bfabric\b/i, /\bcotton\b/i, /\bsilk\b/i, /উপাদান/i] },
    { attribute: 'brand', patterns: [/\bbrand\b/i, /ব্র্যান্ড/i] },
    { attribute: 'specification', patterns: [/\bspec(?:ification)?\b/i, /\bfeatures?\b/i, /বৈশিষ্ট্য/i] },
]);

const GENERAL_CHAT_PATTERNS = Object.freeze([
    /^how are you[!?]*$/i,
    /^ভালো আছেন[!?]*$/i,
    /^maybe confirm this[!?]*$/i,
]);

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const phraseMatches = (text, phrases) => phrases.some((phrase) => {
    if (/[^\u0000-\u007f]/.test(phrase)) return text.toLowerCase().includes(phrase.toLowerCase());
    const pattern = new RegExp(`(?:^|\\b)${escapeRegExp(phrase)}(?:$|\\b)`, 'i');
    return pattern.test(text);
});

const hasProductIntent = (message) => {
    const lower = String(message || '').toLowerCase();
    return PRODUCT_INTENT_KEYWORDS.some(keyword => lower.includes(keyword));
};

const hasPurchaseIntent = (message) => {
    if (!message || typeof message !== 'string') return false;
    const text = normalizeForIntent(message.toLowerCase().trim());
    if (/\b\d{5,8}\b/.test(text)) return false;
    if (STATUS_HINTS.some(hint => text.includes(hint))) return false;
    return PURCHASE_PATTERNS.some(pattern => text.includes(pattern));
};

// P+04: question-shaped utterance detector — keeps ordinary customer questions
// ("delivery charge koto?", "আপনার নাম কী?") from being captured as a checkout
// field value. Deliberately conservative: plain names, addresses, digits and
// zone words must NOT match, or we would stall real checkout answers.
const QUESTION_BANGLISH = /\b(?:koto|kemon|kena|keno|kothay|kotthay|kobe|kar|ki|kon|paba|parba|parben|cover)\b/i;
const QUESTION_BANGLA = ['কত', 'কেমন', 'কেন', 'কোথায়', 'কবে', 'কার', 'কোন', 'পাব'];
const isQuestionShaped = (message) => {
    const text = String(message || '').trim();
    if (!text) return false;
    if (text.includes('?')) return true;
    const lower = normalizeForIntent(text.toLowerCase());
    if (QUESTION_BANGLISH.test(lower)) return true;
    return QUESTION_BANGLA.some((marker) => text.includes(marker));
};

const isNegatedCancel = (message) => {
    const text = normalizeForIntent(String(message || '').toLowerCase().trim());
    return /\b(?:don't|dont|do\s+not|no)\b.*\bcancel\b.*\b(?:order|session|checkout)?\b/i.test(text)
        || /\bcancel\b.*\b(?:no|not|na|না)\b/i.test(text)
        || /বাতিল.*(?:না|নাই|নেই)/i.test(text);
};

const isOrderCancel = (message) => {
    if (!message || typeof message !== 'string') return false;
    const text = normalizeForCancel(message);
    if (isNegatedCancel(text)) return false;
    if (EXACT_CANCEL_PHRASES.has(text)) return true;
    return CANCEL_PATTERNS.some(pattern => pattern.test(text));
};

const isNegatedPurchase = (message) => {
    const text = normalizeForIntent(String(message || '').toLowerCase().trim());
    return /\b(?:don't|dont|do\s+not|never)\s+(?:want\s+to\s+)?(?:order|buy|purchase)\b/i.test(text)
        || /\b(?:order|buy|purchase)\s+(?:korbo|dibo|korte\s+chai|dite\s+chai)\s+na\b/i.test(text)
        || /(?:অর্ডার\s+(?:করব|করবো|দিব|দিবো|দে)|কিনব|কিনবো|নিব|নিবো)\s+না(?:\s|$)/i.test(text)
        || /\bna\s+hoile\b/i.test(text);
};

const isNegatedMutation = (message) => {
    const text = normalizeForIntent(String(message || '').toLowerCase().trim());
    return /\b(?:don't|dont|do\s+not|can't|cannot|na|nai|nei)\b.*\b(?:order|buy|purchase|confirm|checkout|proceed|add|remove|delete|change|edit|quantity|cart|cancel)\b/i.test(text)
        || /\bno\b.*\b(?:add|remove|delete|change|edit|quantity|cart)\b/i.test(text)
        || /\b(?:order|buy|purchase|confirm|checkout|proceed|add|remove|delete|change|edit|quantity|cart|cancel)\b.*\b(?:no|not|don't|dont|can't|cannot|na|nai|nei)\b/i.test(text)
        || /\bcancel\b.*\b(?:checkout|order|cart)\b/i.test(text)
        || /\b(?:confirm|checkout|proceed)\b.*\b(?:but|change|edit|instead|not)\b/i.test(text)
        || /(?:অর্ডার|কনফার্ম|চেকআউট|কার্ট|বাদ|সরাও|যোগ|বদল|পরিমাণ).*?(?:না|নাই|নেই)(?:\s|[!?.,;:]|$)/i.test(text);
};

const isShadowPurchase = (message) => {
    const text = String(message || '').toLowerCase();
    return SHADOW_PURCHASE_PATTERNS.some(pattern => text.includes(pattern.toLowerCase()));
};

const isCheckoutIntent = (message) => {
    const text = String(message || '').trim();
    return !isNegatedMutation(text) && CHECKOUT_PATTERNS.some(pattern => pattern.test(text));
};

const isGeneralChat = (message) => GENERAL_CHAT_PATTERNS.some(pattern => pattern.test(String(message || '').trim()));

const isAttributeQuestion = (message, attribute) => {
    if (!attribute) return false;
    const text = String(message || '');
    if (/^(?:size|colour?|material|fabric|brand|features?)(?:\s+please)?[!.?]*$/i.test(text.trim())) return true;
    return /[?]|\b(?:what|which|tell me|is|are)\b|\bki\b|কি|কী/i.test(text)
        || ATTRIBUTE_RULES.filter(rule => rule.patterns.some(pattern => pattern.test(text))).length > 1;
};

const extractAttribute = (text) => {
    const match = ATTRIBUTE_RULES.find(rule => rule.patterns.some(pattern => pattern.test(text)));
    return match?.attribute || null;
};

const extractProductReference = (text) => {
    const productWords = /\b(?:saree|shirt|dress|panjabi|kameez|bag|duffel|shoe|shoes|jacket|t-shirt|product|item)\b|(?:শাড়ি|জামা|জামার|পাঞ্জাবি|ড্রেস|শার্ট|ব্যাগ|পণ্য|কাপড়|কাপড়)/i;
    return productWords.test(text) ? text.trim() : null;
};

const extractVariant = (text) => {
    if (/\b(?:size|sizing)\b|সাইজ|মাপ/i.test(text)) return 'size';
    if (/\b(?:colou?r|shade)\b|রং|কালার/i.test(text)) return 'color';
    return null;
};

const hasStaticConfig = (staticConfigAvailable, intentId) => {
    if (staticConfigAvailable && typeof staticConfigAvailable === 'object') {
        return Boolean(staticConfigAvailable[intentId]
            ?? staticConfigAvailable.delivery
            ?? staticConfigAvailable.payment
            ?? staticConfigAvailable.all);
    }
    return staticConfigAvailable === true;
};

const classify = (text, options = {}) => {
    const value = String(text || '').trim();
    const language = options.language || 'unknown';
    const make = (intentId, slots = {}, matchedRule = intentId, requiresLiveLookup = false, confidence = 0.99) => ({
        intentId,
        domain: resolveDomain(intentId, { requiresLiveLookup }),
        slots,
        confidence,
        source: 'RULE',
        matchedRule: `${RULESET_VERSION}:${matchedRule}`,
    });

    if (!value) return make('GENERAL_CHAT_OR_UNKNOWN', { language }, 'empty', false, 0);
    if (phraseMatches(value, STOP_OPT_OUT_PHRASES)) return make('STOP_OPT_OUT', {}, 'stop_opt_out');
    if (phraseMatches(value, HUMAN_HANDOFF_PHRASES)
        || /^(?:human|customer\s+care)(?:\s+(?:please|help|chai))?$/i.test(value)) {
        return make('HUMAN_HANDOFF_REQUEST', {}, 'human_handoff');
    }
    const paymentEvidence = options.hasAttachment && /\b(?:payment|bkash|nagad|rocket|trx|transaction|receipt|screenshot)\b|পেমেন্ট|বিকাশ|নগদ/i.test(value);
    if (paymentEvidence) {
        return make('SELF_MFS_PAYMENT_VERIFICATION', {
            screenshot: true,
            expectedAmount: value.match(/\b\d+(?:\.\d{1,2})?\b/)?.[0] || null,
        }, 'self_mfs_payment');
    }
    if (options.hasAttachment) return make('PRODUCT_PHOTO_LOOKUP', { attachment: true, caption: value || null }, 'attachment');
    if (isOrderCancel(value)) return make('ORDER_SESSION_CANCEL', { activeSession: options.activeSession !== false }, 'order_cancel');

    const postPurchase = POST_PURCHASE_REASON_RULES.find(rule => rule.patterns.some(pattern => pattern.test(value)));
    if (postPurchase
        && !/\b(?:before|pre[- ]?purchase|not yet|haven't bought|have not bought)\b/i.test(value)
        && !/\b(?:don't|dont|do\s+not|no)\b.*\b(?:complain|return|change|modify|edit)\b/i.test(value)
        && !/(?:অর্ডার|অভিযোগ|ফেরত|বদলাতে).*না(?:\s|$)/i.test(value)) {
        return make('ORDER_POST_PURCHASE_REQUEST', { reason: postPurchase.reason }, `post_purchase_${postPurchase.reason.toLowerCase()}`);
    }

    if (/\b(?:angry|frustrated|terrible|unacceptable|ignored|ignoring|bad service|need help immediately)\b|খারাপ|বিরক্ত|সাহায্য করছেন না/i.test(value)) {
        return make('SENTIMENT_HANDOFF', { sentiment: 'negative' }, 'sentiment_handoff');
    }

    const orderReference = value.match(/\b\d{5,8}\b/)?.[0] || null;
    if (orderReference || STATUS_HINTS.some(hint => value.toLowerCase().includes(hint))) {
        return make('ORDER_STATUS_LOOKUP', { orderReference }, 'order_status');
    }

    if (options.activeSession === true && isCheckoutIntent(value)) {
        return make('ORDER_SESSION_CHECKOUT', { currentCheckoutSlot: value }, 'order_session_checkout');
    }

    const lower = value.toLowerCase();
    const paymentMethods = /\b(?:payment methods?|how can i pay|cash on delivery|cod|bkash|nagad|rocket)\b/i.test(value)
        || /কি কি পেমেন্ট নেন|পেমেন্ট পদ্ধতি/i.test(value);
    if (paymentMethods) return make('PAYMENT_METHODS', { topic: 'methods' }, 'payment_methods');
    const paymentLookup = /\b(?:payment|paid|transaction|trx)\b.*\b(?:status|gone|received|verified|latest|now)\b/i.test(value)
        || /পেমেন্টটা গেছে/i.test(value);
    if (paymentLookup) return make('PAYMENT_POLICY', { paymentTopic: 'status' }, 'payment_live', true);
    if (/\bpayment\b|পেমেন্ট|রিফান্ড|refund/i.test(value)) {
        return make('PAYMENT_POLICY', { paymentTopic: 'policy' }, 'payment_static', false);
    }

    const deliveryCharge = /\b(?:delivery|shipping|courier)\b.*\b(?:charge|cost|fee|price|how much|koto|now)\b/i.test(value)
        || /\b(?:charge|cost|fee)\b.*\bdelivery\b/i.test(value)
        || /ঢাকার বাইরে কত|ডেলিভারি চার্জ|কুরিয়ার দিয়ে এখন কত লাগবে|কুরিয়ার দিয়ে এখন কত লাগবে/i.test(value)
        || (/\bdelivery\b/i.test(value) && /\bkoto\b|\bhow much\b|\bprice\b/i.test(value));
    if (deliveryCharge) {
        const explicitLive = /\b(?:courier|now|current|calculate|quote|latest)\b/i.test(value)
            || /কুরিয়ার দিয়ে এখন|কুরিয়ার দিয়ে এখন/i.test(value);
        const requiresLiveLookup = explicitLive || !hasStaticConfig(options.staticConfigAvailable, 'DELIVERY_CHARGE');
        return make('DELIVERY_CHARGE', { destination: value }, requiresLiveLookup ? 'delivery_charge_live' : 'delivery_charge_static', requiresLiveLookup);
    }
    if (/\b(?:delivery|shipping|deliver|pathao|pathaben)\b|ডেলিভারি|কুরিয়ার|পাঠাবেন/i.test(value)) {
        const explicitLive = /\b(?:courier|provider|zone|current|now)\b/i.test(value)
            || /কুরিয়ার/i.test(value);
        const requiresLiveLookup = explicitLive || !hasStaticConfig(options.staticConfigAvailable, 'DELIVERY_POLICY');
        return make('DELIVERY_POLICY', { zoneOrLocation: value }, requiresLiveLookup ? 'delivery_policy_live' : 'delivery_policy_static', requiresLiveLookup);
    }

    if (!isNegatedMutation(value) && ( /\b(?:add|remove|change|edit)\b.*\b(?:cart|quantity|item|product)\b/i.test(value)
        || /\badd\s+(?:one\s+more|another|more)\b/i.test(value)
        || /\bquantity\s+change\b/i.test(value)
        || /\bcart\s+e\s+aro\b/i.test(value)
        || /\bcart\s+theke\b.*\b(?:bad|remove)\b/i.test(value)
        || /আরেকটা পণ্য যোগ|কার্ট থেকে.*বাদ/i.test(value))) {
        return make('CART_EDIT_OR_ADD_MORE', { productOrQuantityChange: value }, 'cart_edit');
    }
    if ((hasPurchaseIntent(value) || isShadowPurchase(value)) && !isNegatedPurchase(value) && !isNegatedMutation(value)) {
        return make('PURCHASE_INTENT_START', { productReference: extractProductReference(value) }, 'purchase_start');
    }
    if (isNegatedPurchase(value)) return make('GENERAL_CHAT_OR_UNKNOWN', { language }, 'negated_purchase', false, 0.98);
    if (isNegatedMutation(value)) return make('GENERAL_CHAT_OR_UNKNOWN', { language }, 'negated_mutation', false, 0.98);

    if (NON_PRODUCT_CHATTER.test(value) || isGeneralChat(value)) {
        return make('GENERAL_CHAT_OR_UNKNOWN', { language }, 'general_chat');
    }

    if (/\b(?:available|availability|in stock|stock|ache|nai)\b/i.test(value)
        || /পাওয়া যায়|স্টক|স্টকে|আছে|নাই|নেই/i.test(value)
        || /\b(?:do you have|can i get)\s+(?:this|the)\s+(?:item|product|one)\b/i.test(value)
        || /এই পণ্যটি কি আছে|নাই নাকি আছে/i.test(value)) {
        const variant = extractVariant(value);
        return make('PRODUCT_AVAILABILITY', {
            productReference: extractProductReference(value),
            ...(variant ? { variant } : {}),
        }, 'product_availability');
    }
    const attribute = extractAttribute(value);
    if (isAttributeQuestion(value, attribute)) {
        return make('PRODUCT_ATTRIBUTE', { attribute, productReference: extractProductReference(value) }, `attribute_${attribute}`);
    }
    if (hasProductIntent(value) || extractProductReference(value)) {
        return make('PRODUCT_INQUIRY', { productReference: extractProductReference(value) }, 'product_inquiry');
    }
    if (GREETING_PATTERN.test(value)) return make('GREETING', { language }, 'greeting');
    if (/\?|\b(?:how|what|when|where|which|why|কি|কী|কেন|কিভাবে)\b/i.test(value)) {
        return make('FAQ_KNOWLEDGE_QUESTION', { questionTopic: value }, 'faq_question');
    }
    return make('GENERAL_CHAT_OR_UNKNOWN', { language }, 'general', false, 0.5);
};

const isPlainGreeting = (message) => {
    if (!message || typeof message !== 'string') return false;
    const trimmed = message.trim();
    if (trimmed.length === 0 || trimmed.length > 40) return false;
    if (hasProductIntent(trimmed)) return false;
    return GREETING_PATTERN.test(trimmed);
};

module.exports = {
    ATTRIBUTE_RULES,
    CANCEL_PATTERNS,
    EXACT_CANCEL_PHRASES,
    GREETING_PATTERN,
    HUMAN_HANDOFF_PHRASES,
    NON_PRODUCT_CHATTER,
    PENDING_BANGLA_LANGUAGE_QA_LITERALS,
    PRODUCT_INTENT_KEYWORDS,
    PURCHASE_PATTERNS,
    RULESET_VERSION,
    STATUS_HINTS,
    STOP_OPT_OUT_PHRASES,
    SHADOW_PURCHASE_PATTERNS,
    classify,
    hasProductIntent,
    hasPurchaseIntent,
    isNegatedPurchase,
    isNegatedMutation,
    isNegatedCancel,
    isQuestionShaped,
    isOrderCancel,
    isShadowPurchase,
    isPlainGreeting,
    normalizeForCancel,
    normalizeForIntent,
    extractVariant,
};
