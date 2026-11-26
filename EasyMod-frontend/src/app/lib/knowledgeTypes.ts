// Knowledge types for AI training
export interface SocialLinks {
  facebook?: string;
  instagram?: string;
  whatsapp?: string;
  tiktok?: string;
  youtube?: string;
  website?: string;
}

export interface BusinessInfo {
  shopName: string;
  // Optional English display name. shopName (Bangla-first) remains THE single
  // authoritative identity synced with shops.shop_name; nameEn never flows back.
  nameEn?: string | null;
  tagline?: string | null;
  // Customer-facing contact email — strictly informational; account login
  // credentials are a different system entirely.
  email?: string | null;
  city?: string | null;
  address: string;
  location?: string;
  phone: string;
  openingHours: string;
  // Freeform owner-provided shop facts that should ground AI replies.
  additionalInfo?: string;
  // Collected on the Delivery Settings / Payment Settings pages (defaults:
  // delivery = whole Bangladesh, payment = Cash on Delivery). Kept optional for
  // back-compat with stored data; no longer edited in Business Info.
  deliveryAreas?: string[];
  paymentMethods?: string[];
  // Surfaced in the AI order-confirmation closing message.
  socialLinks?: SocialLinks;
}

export type FaqStatus = 'draft' | 'review' | 'published' | 'disabled' | 'archived';
export type FaqSyncStatus = 'pending' | 'synced' | 'failed' | 'pruned';

export interface FAQ {
  id: string;
  question: string;
  answer: string;
  category: string;
  confidence: number;
  source: string;
  active: boolean;
  usageCount: number;
  // Honest nullability (A5 contract): the client no longer fabricates
  // timestamps; the UI renders '—' for null.
  createdAt: string | null;
  updatedAt: string | null;
  // Extended lifecycle + knowledge-sync surface (2026-11-26 redesign).
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

export interface BrandingRules {
  tone: 'formal' | 'friendly' | 'casual';
  languagePreference: string;
  emojiUsage: 'none' | 'light' | 'moderate' | 'heavy';
  forbiddenPhrases: string[];
  escalationKeywords: string[];
  greetingStyle: string;
  closingStyle: string;
}

export interface KnowledgeExtraction {
  id: string;
  fileName: string;
  fileType: string;
  uploadedAt: string;
  status: 'processing' | 'review' | 'approved' | 'rejected';
  extractedData: {
    businessInfo?: Partial<BusinessInfo>;
    faqs?: FAQ[];
    branding?: Partial<BrandingRules>;
  };
  confidence: number;
  errors?: string[];
}

export interface KnowledgeGap {
  id: string;
  question: string;
  frequency: number;
  platform: string;
  language: string;
  firstAsked: string;
  lastAsked: string;
}
