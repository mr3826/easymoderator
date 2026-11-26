/**
 * Local model + contract bindings for the FAQ tab (A3).
 *
 * The rich FAQ serialization, the API client names and the locale keys are
 * owned by A0/A5 (docs/business-faq-redesign/00_A0_DATA_CONTRACT.md +
 * 03_REUSE_AND_CLIENT_MAP.md). This file BINDS to those names — it never
 * edits `src/api/*`. `faqApi` types the facade surface exactly as the
 * contract defines it; the cast is a temporary seam A0 can drop the moment
 * `src/api/index.ts` exposes `archiveKnowledgeFaq / restoreKnowledgeFaq /
 * resyncKnowledgeFaq / searchKnowledgeFaqs` and the rich `FAQ` shape.
 *
 * Mapper rule (01 F5): NOTHING here fabricates timestamps or confidence.
 * NULL `updated_at`/`synced_at` pass through and the UI renders "—".
 */
import { apiClient } from '@/api';

export type FaqStatus = 'draft' | 'review' | 'published' | 'disabled' | 'archived';
export type FaqSyncStatus = 'pending' | 'synced' | 'failed' | 'pruned';

/** Merchant-list row = the full `formatFaq` serialization (contract §FAQ side). */
export interface FaqRow {
  id: string;
  question: string;
  category_tag: string | null;
  answers: { en: string | null; bn: string | null };
  keywords: string[];
  notes: string | null;
  status: FaqStatus;
  is_active: boolean;
  priority: number | null;
  use_count: number;
  created_at: string | null;
  /** Honest timestamp: NULL means never edited — render "—", never a lie. */
  updated_at: string | null;
  sync_status: FaqSyncStatus;
  sync_version: number;
  synced_at: string | null;
  // Legacy aliases the server still emits (old readers only — the UI binds
  // to the new fields above; `confidence` must NEVER be rendered).
  answer?: string;
  category?: string;
  template_en?: string | null;
  template_bn?: string | null;
  source?: string;
  active?: boolean;
  usageCount?: number;
  createdAt?: string | null;
  updatedAt?: string | null;
}

/** POST/PATCH body per contract. No `category`, no `confidence`, no
 *  `usageCount`, no `source` — the client never sends legacy shadow fields. */
export interface FaqMutationPayload {
  question?: string;
  answer_en?: string;
  answer_bn?: string;
  category_tag?: string | null;
  keywords?: string[];
  notes?: string | null;
  status?: FaqStatus;
  priority?: number;
}

export interface FaqKnowledgeApi {
  listKnowledgeFaqs: () => Promise<FaqRow[]>;
  createKnowledgeFaq: (payload: FaqMutationPayload) => Promise<FaqRow>;
  updateKnowledgeFaq: (id: string, payload: FaqMutationPayload) => Promise<FaqRow>;
  archiveKnowledgeFaq: (id: string) => Promise<FaqRow>;
  restoreKnowledgeFaq: (id: string) => Promise<FaqRow>;
  resyncKnowledgeFaq: (id: string) => Promise<FaqRow>;
  deleteKnowledgeFaq: (id: string) => Promise<{ message: string }>;
  /** POST /api/knowledge/faq/search — published-only projections; A0 wraps the
   *  `{ success, data, total }` envelope into the array (or returns it — the
   *  tab normalizes both shapes defensively). */
  searchKnowledgeFaqs: (
    query: string,
    options?: { category_tag?: string | null; limit?: number; signal?: AbortSignal },
  ) => Promise<unknown>;
}

export const faqApi = apiClient as unknown as FaqKnowledgeApi;

/**
 * Status machine mirrored from the server (A5 §Status machine) purely to
 * choose CONTEXTUAL affordances — the server stays authoritative and its 409
 * is surfaced verbatim via error copy. Never used to fake a local success.
 */
export const FAQ_TRANSITIONS: Record<FaqStatus, FaqStatus[]> = {
  draft: ['review', 'published', 'archived'],
  review: ['draft', 'published', 'archived'],
  published: ['disabled', 'archived'],
  disabled: ['published', 'archived'],
  archived: ['disabled'],
};

export const FAQ_STATUSES: FaqStatus[] = ['draft', 'review', 'published', 'disabled', 'archived'];
/** The status control in the editor: archived is NOT selectable — archive is
 *  a row action and restore (→ disabled) is its only exit. */
export const EDITOR_SELECTABLE_STATUSES: FaqStatus[] = ['draft', 'review', 'published', 'disabled'];

export const canTransition = (from: FaqStatus, to: FaqStatus): boolean =>
  FAQ_TRANSITIONS[from]?.includes(to) ?? false;

/** Rows whose current state allows a bulk Enable (→ published). */
export const canBulkEnable = (row: FaqRow): boolean => canTransition(row.status, 'published');
/** Rows whose current state allows a bulk Disable (published → disabled). */
export const canBulkDisable = (row: FaqRow): boolean => canTransition(row.status, 'disabled');

/** Normalize one server row defensively (covers projection rows from search). */
export function asFaqRow(raw: unknown): FaqRow {
  const r = (raw ?? {}) as Partial<FaqRow> & Record<string, unknown>;
  // A9 minor: never fabricate 'published' from a missing status — mirror the
  // server's own fallback (is_active === false means disabled, not published).
  const status = (typeof r.status === 'string'
    ? r.status
    : r.is_active === false
      ? 'disabled'
      : 'published') as FaqStatus;
  const answers =
    r.answers && typeof r.answers === 'object'
      ? { en: (r.answers as FaqRow['answers']).en ?? null, bn: (r.answers as FaqRow['answers']).bn ?? null }
      : { en: (r.template_en as string | undefined) ?? (r.answer as string | undefined) ?? null, bn: (r.template_bn as string | null | undefined) ?? null };
  return {
    id: String(r.id ?? ''),
    question: String(r.question ?? r.category ?? ''),
    category_tag: typeof r.category_tag === 'string' && r.category_tag ? r.category_tag : null,
    answers,
    keywords: Array.isArray(r.keywords) ? r.keywords.map(String) : [],
    notes: typeof r.notes === 'string' && r.notes ? r.notes : null,
    status: FAQ_STATUSES.includes(status) ? status : 'published',
    is_active: r.is_active !== false,
    priority: typeof r.priority === 'number' ? r.priority : null,
    use_count: typeof r.use_count === 'number' ? r.use_count : typeof r.usageCount === 'number' ? r.usageCount : 0,
    // NULL passes through untouched — the UI renders "—" (01 F5).
    created_at: r.created_at ?? (r.createdAt as string | null) ?? null,
    updated_at: r.updated_at ?? (r.updatedAt as string | null) ?? null,
    sync_status: (['pending', 'synced', 'failed', 'pruned'] as FaqSyncStatus[]).includes(r.sync_status as FaqSyncStatus)
      ? (r.sync_status as FaqSyncStatus)
      : 'pending',
    sync_version: typeof r.sync_version === 'number' ? r.sync_version : 0,
    synced_at: r.synced_at ?? null,
    source: typeof r.source === 'string' ? r.source : undefined,
    answer: typeof r.answer === 'string' ? r.answer : undefined,
    usageCount: typeof r.usageCount === 'number' ? r.usageCount : undefined,
    active: typeof r.active === 'boolean' ? r.active : undefined,
  };
}

/** Normalize the search response: array OR `{ data: [...] }` envelope. */
export function asFaqRows(raw: unknown): FaqRow[] {
  const list = Array.isArray(raw) ? raw : (raw as { data?: unknown[] })?.data;
  return Array.isArray(list) ? list.map(asFaqRow) : [];
}

/* ── Locale-aware formatting (delivery's proven localeFor pattern) ────────── */

/** bn → bn-BD (Bangla digits), everything else en-US. One-line copy of the
 *  ProviderDrawer/customerDisplay pattern per 03 §1. */
export const localeFor = (language: string): string =>
  language.toLowerCase().startsWith('bn') ? 'bn-BD' : 'en-US';

/** NULL/blank → honest em dash; unparseable raw string stays visible. */
export function formatDateTime(value: string | null | undefined, language: string): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(localeFor(language), { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

export function formatCount(value: number, language: string): string {
  return new Intl.NumberFormat(localeFor(language)).format(Number.isFinite(value) ? value : 0);
}

const parseTime = (value: string | null | undefined): number | null => {
  if (!value) return null;
  const n = Date.parse(value);
  return Number.isNaN(n) ? null : n;
};

/**
 * Default order per 02 §2: updated_at DESC, NULL-safe (never-edited rows
 * after edited ones, ordered by their created date), stable beyond that.
 */
export function sortFaqs(rows: FaqRow[]): FaqRow[] {
  return [...rows].sort((a, b) => {
    const ua = parseTime(a.updated_at);
    const ub = parseTime(b.updated_at);
    if (ua === null && ub === null) return (parseTime(b.created_at) ?? 0) - (parseTime(a.created_at) ?? 0);
    if (ua === null) return 1;
    if (ub === null) return -1;
    return ub - ua;
  });
}

/* ── Row text hydration helpers ───────────────────────────────────────────── */

/** Customer-visible answer preview: bn-first (the product default language),
 *  never notes/keywords. Empty → the caller renders `notSet` ("—"). */
export function previewAnswer(row: FaqRow): { text: string; lang: 'bn' | 'en' | null } {
  const bn = row.answers?.bn?.trim();
  const en = row.answers?.en?.trim();
  if (bn) return { text: bn, lang: 'bn' };
  if (en) return { text: en, lang: 'en' };
  const legacy = (row.answer ?? '').trim();
  if (legacy) return { text: legacy, lang: 'en' };
  return { text: '', lang: null };
}

/** Editor hydration preserving single-language legacy rows (A5 contract:
 *  an `answer`-only update must never drop bn; we seed BOTH slots). */
export function editorSeed(row: FaqRow | null): {
  question: string;
  answerEn: string;
  answerBn: string;
  categoryTag: string;
  keywords: string[];
  notes: string;
  status: FaqStatus;
  priority: string;
} {
  if (!row) {
    return { question: '', answerEn: '', answerBn: '', categoryTag: '', keywords: [], notes: '', status: 'draft', priority: '' };
  }
  return {
    question: row.question ?? '',
    answerEn: row.answers?.en ?? row.answer ?? '',
    answerBn: row.answers?.bn ?? '',
    categoryTag: row.category_tag ?? '',
    keywords: [...(row.keywords ?? [])],
    notes: row.notes ?? '',
    status: row.status,
    priority: row.priority == null ? '' : String(row.priority),
  };
}

/** Per-status counts for the filter chips + header pills (accurate against
 *  the merchant list — no fabricated totals). "All" = non-archived rows. */
export function countByStatus(rows: FaqRow[]): Record<FaqStatus, number> & { all: number } {
  const counts: Record<FaqStatus, number> & { all: number } = {
    all: 0,
    draft: 0,
    review: 0,
    published: 0,
    disabled: 0,
    archived: 0,
  };
  for (const row of rows) {
    counts[row.status] += 1;
    // A8 minor #2: 'All' is ONE denominator with the Total pill — EVERY row
    // including archived; archived stay visible and restorable in the list.
    counts.all += 1;
  }
  return counts;
}

/** Distinct non-null category tags present in the list (for the select). */
export function distinctCategoryTags(rows: FaqRow[]): string[] {
  const set = new Set<string>();
  for (const row of rows) if (row.category_tag) set.add(row.category_tag);
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

/** Client filter over the CURRENT working set (list or search results):
 *  question / either answer slot / category tag — never notes/keywords. */
export function clientFilter(rows: FaqRow[], query: string, category: string): FaqRow[] {
  const q = query.trim().toLowerCase();
  return rows.filter((row) => {
    if (category === '__uncategorized__' ? row.category_tag !== null : (category && row.category_tag !== category)) {
      return false;
    }
    if (!q) return true;
    const haystack = [row.question, row.answers?.en, row.answers?.bn, row.answer, row.category_tag]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return haystack.includes(q);
  });
}

/* ── Chip styling (existing tokens only, text-labeled — never color-only) ── */

export const statusChipClasses: Record<FaqStatus, string> = {
  draft: 'bg-em-bg-muted text-em-text-secondary border-em-border',
  review: 'bg-em-violet-50 text-em-violet-700 border-em-violet-600/20',
  published: 'bg-em-success-100 text-em-success-700 border-em-success-700/20',
  disabled: 'bg-em-midnight-100 text-em-midnight-700 border-em-border',
  archived: 'bg-em-midnight-100 text-em-midnight-700 border-em-border',
};

export const syncChipClasses: Record<FaqSyncStatus, string> = {
  pending: 'bg-em-info-100 text-em-info-700 border-em-info-700/20',
  synced: 'bg-em-success-100 text-em-success-700 border-em-success-700/20',
  failed: 'bg-em-danger-100 text-em-danger-700 border-em-danger-700/20',
  pruned: 'bg-em-bg-muted text-em-text-secondary border-em-border',
};

// Signal derivation lives in ../faq/derive.ts (KEPT as-is per 03 §1): FaqTab
// passes `activeCount = publishedCount` + its OWN list phase only, so the
// tab signal never fabricates a cross-tab state (§8 lists rule).
