/**
 * Knowledge Base types
 */

export type FaqStatus = 'draft' | 'review' | 'published' | 'disabled' | 'archived';
export type FaqSyncStatus = 'pending' | 'synced' | 'failed' | 'pruned';

export interface FAQ {
  id: string;
  question: string;
  answer: string;
  category: string;
  confidence: number;
  source: 'manual' | 'ai' | 'import';
  active: boolean;
  usageCount: number;
  // Honest nullability: never fabricated by the client (A5 contract).
  createdAt: string | null;
  updatedAt: string | null;
  status?: FaqStatus;
  category_tag?: string | null;
  answers?: { en?: string | null; bn?: string | null };
  keywords?: string[];
  notes?: string | null;
  sync_status?: FaqSyncStatus;
  sync_version?: number;
  synced_at?: string | null;
  use_count?: number;
  priority?: number;
}

/** Write payload for POST/PATCH /api/knowledge/faqs (A5 contract). */
export interface FaqWritePayload {
  question?: string;
  answer?: string;
  answer_en?: string;
  answer_bn?: string;
  template_en?: string;
  template_bn?: string;
  /** Legacy alias — server maps it to the question ONLY when question is
   *  absent; it can never overwrite an existing question. */
  category?: string;
  category_tag?: string | null;
  keywords?: string[];
  notes?: string | null;
  status?: FaqStatus;
  priority?: number;
  active?: boolean;
  confidence?: number;
  usageCount?: number;
  source?: string;
}

export interface KnowledgeGap {
  id: number;
  question: string;
  platform: string;
  language: string;
  frequency?: number;
  created_at: string;
}

export interface BusinessInfo {
  name?: string;
  description?: string;
  contact_email?: string;
  contact_phone?: string;
  website?: string;
  address?: string;
  hours?: string;
  [key: string]: string | undefined;
}

export interface BrandingRules {
  tone?: 'professional' | 'friendly' | 'casual';
  language_style?: string;
  greeting_template?: string;
  signature_template?: string;
  restricted_phrases?: string[];
  required_disclaimers?: string[];
}

export interface KnowledgeSummary {
  faqs: FAQ[];
  business_info: BusinessInfo;
  branding_rules: BrandingRules;
  documents: unknown[];
  gaps: KnowledgeGap[];
}

export interface KnowledgeDocument {
  id: string;
  name: string;
  contentType?: string;
  fileType?: string;
  size?: number;
  url?: string;
  text?: string;
  tags?: string[];
  source?: string;
  created_at?: string;
}

/**
 * P+05 Merchant Knowledge-Gap-Suggestions.
 * Backend: GET/POST /api/knowledge/gap-suggestions (flag `knowledge_suggestions`).
 * Publish routes through the existing FAQ authority — the answer is always
 * merchant-authored, never AI-generated.
 */

export type GapSuggestionDomain = 'PAYMENT' | 'DELIVERY' | 'PRODUCT' | 'POLICY' | 'OTHER';
export type GapSuggestionStatus = 'OPEN' | 'IN_REVIEW';
export type GapDismissReason = 'NOT_USEFUL' | 'ALREADY_ANSWERED' | 'CONFIG_ONLY' | 'OUTDATED' | 'OTHER';
export type GapAuthoritativeAction =
  | 'open_payment_settings'
  | 'open_delivery_settings'
  | 'open_product_catalog'
  | 'author_faq';

/** Display/config map: primary action → in-app page path (null = inline authoring, no navigation). */
export const GAP_SUGGESTION_SETTINGS_PATHS: Record<GapAuthoritativeAction, string | null> = {
  open_payment_settings: '/manage-shop/payment-settings',
  open_delivery_settings: '/manage-shop/delivery-settings',
  open_product_catalog: '/products',
  author_faq: null,
};

const GAP_DOMAIN_ALIASES: Record<string, GapSuggestionDomain> = {
  PAYMENT: 'PAYMENT',
  DELIVERY: 'DELIVERY',
  SHIPPING: 'DELIVERY',
  PRODUCT: 'PRODUCT',
  PRODUCTS: 'PRODUCT',
  POLICY: 'POLICY',
  POLICIES: 'POLICY',
  OTHER: 'OTHER',
};

/** Each domain's safest action when the wire value is unknown — POLICY/OTHER author FAQs. */
export const GAP_DOMAIN_DEFAULT_ACTION: Record<GapSuggestionDomain, GapAuthoritativeAction> = {
  PAYMENT: 'open_payment_settings',
  DELIVERY: 'open_delivery_settings',
  PRODUCT: 'open_product_catalog',
  POLICY: 'author_faq',
  OTHER: 'author_faq',
};

const GAP_ACTION_ALIASES: Record<string, GapAuthoritativeAction> = {
  open_payment_settings: 'open_payment_settings',
  open_delivery_settings: 'open_delivery_settings',
  open_product_catalog: 'open_product_catalog',
  author_faq: 'author_faq',
};

export interface KnowledgeGapSuggestion {
  id: string;
  display_question: string;
  owner_domain: GapSuggestionDomain;
  status: GapSuggestionStatus;
  evidence_count: number;
  first_seen_at: string;
  last_seen_at: string;
  resolved_faq_id: string | null;
  published_at: string | null;
  authoritative_action: GapAuthoritativeAction;
}

export interface GapSuggestionPublishPayload {
  question: string;
  answer: string;
  category?: string;
  priority?: number;
  is_active?: boolean;
}

/** Normalize current and legacy API values, failing closed (OTHER domain, OPEN status, derived action). */
export function normalizeGapSuggestion(raw: unknown): KnowledgeGapSuggestion {
  const r = (raw ?? {}) as Record<string, unknown>;
  const owner_domain: GapSuggestionDomain =
    typeof r.owner_domain === 'string'
      ? GAP_DOMAIN_ALIASES[r.owner_domain.trim().toUpperCase()] ?? 'OTHER'
      : 'OTHER';
  const authoritative_action: GapAuthoritativeAction =
    typeof r.authoritative_action === 'string'
      ? GAP_ACTION_ALIASES[r.authoritative_action.trim()] ?? GAP_DOMAIN_DEFAULT_ACTION[owner_domain]
      : GAP_DOMAIN_DEFAULT_ACTION[owner_domain];
  return {
    id: String(r.id ?? ''),
    display_question: String(r.display_question ?? r.question ?? '').trim(),
    owner_domain,
    status: r.status === 'IN_REVIEW' ? 'IN_REVIEW' : 'OPEN',
    evidence_count:
      typeof r.evidence_count === 'number' && Number.isFinite(r.evidence_count) && r.evidence_count >= 0
        ? Math.floor(r.evidence_count)
        : 0,
    first_seen_at: String(r.first_seen_at ?? r.created_at ?? ''),
    last_seen_at: String(r.last_seen_at ?? r.first_seen_at ?? r.created_at ?? ''),
    resolved_faq_id: r.resolved_faq_id == null ? null : String(r.resolved_faq_id),
    published_at: r.published_at == null ? null : String(r.published_at),
    authoritative_action,
  };
}
