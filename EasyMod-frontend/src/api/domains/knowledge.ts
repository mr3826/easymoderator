/**
 * Knowledge Base API Domain
 */

import { httpClient } from '@/shared/lib/http/client';
import type { ApiResponse } from '../types/common';
import type {
  FAQ,
  KnowledgeGap,
  BusinessInfo,
  BrandingRules,
  KnowledgeSummary,
  KnowledgeDocument,
  KnowledgeGapSuggestion,
  GapDismissReason,
  GapSuggestionPublishPayload,
  GapSuggestionStatus,
} from '../types/knowledge';
import { normalizeGapSuggestion } from '../types/knowledge';
import type { AxiosResponse } from 'axios';

/**
 * Get knowledge base summary including FAQs
 * @returns Promise resolving to knowledge summary object
 * @throws {Error} When knowledge summary retrieval fails
 * @example
 * ```typescript
 * const summary = await getKnowledgeSummary();
 * console.log('FAQs:', summary.faqs.length);
 * ```
 */
export async function getKnowledgeSummary(): Promise<KnowledgeSummary> {
  const response: AxiosResponse<ApiResponse<KnowledgeSummary>> = await httpClient.get('/api/knowledge');
  const data = response.data.data;
  return {
    ...data,
    faqs: (data?.faqs ?? []).map(mapFaqFromBackend),
  };
}

/**
 * Update business information for knowledge base
 * @param businessInfo - Business information to update
 * @returns Promise resolving to updated knowledge summary
 * @throws {Error} When business info update fails
 * @example
 * ```typescript
 * const updated = await updateBusinessInfo({ 
 *   name: 'My Business', 
 *   description: 'We sell products' 
 * });
 * ```
 */
export async function updateBusinessInfo(businessInfo: BusinessInfo): Promise<KnowledgeSummary> {
  const response: AxiosResponse<ApiResponse<KnowledgeSummary>> = await httpClient.put(
    '/api/knowledge/business-info',
    businessInfo
  );
  return response.data.data;
}

/**
 * Update branding rules for knowledge base
 * @param brandingRules - Branding configuration rules and guidelines
 * @returns Promise resolving to updated knowledge summary
 * @throws {Error} When branding rules update fails
 * @example
 * ```typescript
 * const updated = await updateBrandingRules({ 
 *   tone: 'professional', 
 *   prohibitedWords: ['spam', 'scam'] 
 * });
 * ```
 */
export async function updateBrandingRules(brandingRules: BrandingRules): Promise<KnowledgeSummary> {
  const response: AxiosResponse<ApiResponse<KnowledgeSummary>> = await httpClient.put(
    '/api/knowledge/branding',
    brandingRules
  );
  return response.data.data;
}

/**
 * Get all frequently asked questions
 * @returns Promise resolving to array of FAQs
 * @throws {Error} When FAQ retrieval fails
 * @example
 * ```typescript
 * const faqs = await listFaqs();
 * console.log('Total FAQs:', faqs.length);
 * ```
 */
export async function listFaqs(): Promise<FAQ[]> {
  const response: AxiosResponse<ApiResponse<FAQ[]>> = await httpClient.get('/api/knowledge/faqs');
  return (response.data.data ?? []).map(mapFaqFromBackend);
}

/**
 * Create new frequently asked question
 * @param faq - FAQ data without id, createdAt, and updatedAt
 * @returns Promise resolving to created FAQ object
 * @throws {Error} When FAQ creation fails due to validation or network issues
 * @example
 * ```typescript
 * const newFaq = await createFaq({ 
 *   question: 'What are your hours?', 
 *   answer: 'We are open 9-5 PM weekdays' 
 * });
 * ```
 */
// `category` is optional: the API resolves its single text column as
// `category || question`, so callers that mean "store this question" must be
// able to omit category entirely rather than send a value that overrides it.
export async function createFaq(
  faq: Omit<FAQ, 'id' | 'createdAt' | 'updatedAt' | 'category'> & { category?: string },
): Promise<FAQ> {
  const response: AxiosResponse<ApiResponse<FAQ>> = await httpClient.post('/api/knowledge/faqs', faq);
  return mapFaqFromBackend(response.data.data);
}

/**
 * Update existing FAQ
 * @param faqId - ID of FAQ to update
 * @param updates - Partial FAQ data with fields to update
 * @returns Promise resolving to updated FAQ object
 * @throws {Error} When FAQ update fails due to invalid ID or permissions
 * @example
 * ```typescript
 * const updated = await updateFaq('faq123', { answer: 'Updated answer' });
 * ```
 */
export async function updateFaq(faqId: string, updates: Partial<FAQ>): Promise<FAQ> {
  const response: AxiosResponse<ApiResponse<FAQ>> = await httpClient.patch(
    `/api/knowledge/faqs/${faqId}`,
    updates
  );
  return mapFaqFromBackend(response.data.data);
}

/**
 * Delete FAQ by ID
 * @param faqId - ID of FAQ to delete
 * @returns Promise resolving to deletion message
 * @throws {Error} When FAQ deletion fails due to invalid ID or permissions
 * @example
 * ```typescript
 * const result = await deleteFaq('faq123');
 * console.log(result.message);
 * ```
 */
export async function deleteFaq(faqId: string): Promise<{ message: string }> {
  const response: AxiosResponse<ApiResponse<{ message: string }>> = await httpClient.delete(
    `/api/knowledge/faqs/${faqId}`
  );
  return response.data.data ?? { message: 'FAQ deleted' };
}

/**
 * Get knowledge gaps analysis
 * @returns Promise resolving to array of knowledge gaps
 * @throws {Error} When knowledge gaps retrieval fails
 * @example
 * ```typescript
 * const gaps = await listKnowledgeGaps();
 * console.log('Knowledge gaps:', gaps.length);
 * ```
 */
export async function listKnowledgeGaps(): Promise<KnowledgeGap[]> {
  const response: AxiosResponse<ApiResponse<KnowledgeGap[]>> = await httpClient.get('/api/knowledge/gaps');
  return response.data.data ?? [];
}

/**
 * P+05 Merchant Knowledge-Gap-Suggestions
 * Backend: EasyMod-backend knowledge gap-suggestions routes (flag `knowledge_suggestions`).
 *
 * The endpoint answers 409 FEATURE_DISABLED (or 404 on older deployments) while
 * the shop flag is off, so the list call unwraps that into a first-class result
 * shape — the section being hidden is the normal state, not an error. Review /
 * dismiss / publish surface their 409 GAP_STATE_CONFLICT as an exception so the
 * caller can re-fetch the server-authoritative list.
 */

export type GapSuggestionsResult =
  | { featureDisabled: false; data: KnowledgeGapSuggestion[] }
  | { featureDisabled: true };

type MaybeApiError = {
  // NormalizedApiError (what httpClient throws)
  statusCode?: number;
  code?: string;
  // raw axios shape (defensive)
  response?: { status?: number; data?: { error?: { code?: string } } };
};

/** Feature off, endpoint unrouted, or a 409 from the list gate — all mean "render nothing". */
export function isGapSuggestionsDisabled(error: unknown): boolean {
  const e = error as MaybeApiError;
  const code = e?.code ?? e?.response?.data?.error?.code;
  if (code === 'FEATURE_DISABLED') return true;
  const status = e?.statusCode ?? e?.response?.status;
  return status === 404 || status === 409;
}

/**
 * List open gap suggestions for this shop.
 * @returns `{ featureDisabled: true }` when the flag is off; normalized rows otherwise.
 * @throws {Error} Any other API error.
 */
export async function listGapSuggestions(): Promise<GapSuggestionsResult> {
  try {
    const response: AxiosResponse<ApiResponse<unknown[]>> = await httpClient.get(
      '/api/knowledge/gap-suggestions'
    );
    return { featureDisabled: false, data: (response.data.data ?? []).map(normalizeGapSuggestion) };
  } catch (error) {
    if (isGapSuggestionsDisabled(error)) return { featureDisabled: true };
    throw error;
  }
}

/**
 * Claim a suggestion for authoring (OPEN -> IN_REVIEW).
 * @throws When the row already moved on (409 GAP_STATE_CONFLICT).
 */
export async function reviewGapSuggestion(id: string): Promise<{ status: GapSuggestionStatus }> {
  const response: AxiosResponse<ApiResponse<{ status: GapSuggestionStatus }>> = await httpClient.post(
    `/api/knowledge/gap-suggestions/${id}/review`
  );
  return response.data.data;
}

/**
 * Dismiss a suggestion with a merchant-chosen reason (terminal, server-authoritative).
 * @throws When the row already moved on (409 GAP_STATE_CONFLICT).
 */
export async function dismissGapSuggestion(
  id: string,
  reason: GapDismissReason
): Promise<{ status: string }> {
  const response: AxiosResponse<ApiResponse<{ status: string }>> = await httpClient.post(
    `/api/knowledge/gap-suggestions/${id}/dismiss`,
    { reason }
  );
  return response.data.data;
}

/**
 * Publish the merchant-authored answer through the existing FAQ authority.
 * @param payload - Question/answer (plus optional category/priority/is_active).
 * @returns The created FAQ id and PUBLISHED status.
 * @throws When the row already moved on (409 GAP_STATE_CONFLICT).
 */
export async function publishGapSuggestion(
  id: string,
  payload: GapSuggestionPublishPayload
): Promise<{ faq_id: string; status: string }> {
  const response: AxiosResponse<ApiResponse<{ faq_id: string; status: string }>> = await httpClient.post(
    `/api/knowledge/gap-suggestions/${id}/publish`,
    payload
  );
  return response.data.data;
}

/**
 * Get all knowledge documents
 * @returns Promise resolving to array of knowledge documents
 * @throws {Error} When document retrieval fails
 * @example
 * ```typescript
 * const documents = await listDocuments();
 * console.log('Documents:', documents.length);
 * ```
 */
export async function listDocuments(): Promise<KnowledgeDocument[]> {
  const response: AxiosResponse<ApiResponse<KnowledgeDocument[]>> = await httpClient.get(
    '/api/knowledge/documents'
  );
  return response.data.data ?? [];
}

/**
 * Create new knowledge document
 * @param document - Document data including name, content type, size, URL, and text content
 * @returns Promise resolving to created document object
 * @throws {Error} When document creation fails due to validation or network issues
 * @example
 * ```typescript
 * const newDoc = await createDocument({ 
 *   name: 'Product Guide', 
 *   text: 'How to use our products...', 
 *   contentType: 'text/markdown' 
 * });
 * ```
 */
/**
 * Create new knowledge document
 * @param document - Document data including name, content type, size, URL, text, tags, and source
 * @returns Promise resolving to created document object
 * @throws {Error} When document creation fails due to validation or network issues
 * @example
 * ```typescript
 * const newDoc = await createDocument({ 
 *   name: 'Product Guide', 
 *   text: 'How to use our products...', 
 *   contentType: 'text/markdown',
 *   tags: ['products', 'guide'] 
 * });
 * ```
 */
export async function createDocument(document: {
  name: string;
  contentType?: string;
  size?: number;
  url?: string;
  text?: string;
  tags?: string[];
  source?: string;
}): Promise<KnowledgeDocument> {
  const response: AxiosResponse<ApiResponse<KnowledgeDocument>> = await httpClient.post(
    '/api/knowledge/documents',
    document
  );
  return response.data.data;
}

/**
 * Map FAQ data from backend format to frontend format
 * @param faq - FAQ data from backend API response
 * @returns Formatted FAQ object with consistent field types
 * @example
 * ```typescript
 * const formatted = mapFaqFromBackend(backendData);
 * console.log('FAQ ID:', formatted.id);
 * ```
 */
function mapFaqFromBackend(faq: unknown): FAQ {
  const f = faq as Record<string, unknown>;
  return {
    id: String(f.id ?? ''),
    question: String(f.question ?? f.category ?? ''),
    answer: String(f.answer ?? f.template_en ?? ''),
    category: String(f.category ?? f.question ?? 'General'),
    confidence: typeof f.confidence === 'number' && Number.isFinite(f.confidence) ? f.confidence : 0.9,
    source: (f.source as FAQ['source']) ?? 'manual',
    active: (f.active ?? f.is_active) as boolean ?? true,
    usageCount: typeof f.usageCount === 'number' ? f.usageCount : 0,
    createdAt: String(f.createdAt ?? f.created_at ?? new Date().toISOString()),
    updatedAt: String(f.updatedAt ?? f.updated_at ?? f.created_at ?? new Date().toISOString()),
  };
}

