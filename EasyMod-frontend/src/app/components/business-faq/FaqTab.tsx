/**
 * Tab 2 — FAQs workspace (A3).
 *
 * The FAQ list IS the work surface (02 §2): search (server `POST
 * /api/knowledge/faq/search` while a query is typed, client filter otherwise —
 * the server search is published-only per contract), status filter chips with
 * accurate per-status counts, a category filter incl. Uncategorized, per-row
 * dual chips (lifecycle = server `status`, sync = `sync_status`), honest
 * created/updated timestamps (NULL → "—", never a fabricated date), replies
 * used (`use_count`), internal keyword chips labeled as not-customer-facing,
 * contextual row actions, safe bulk enable/disable with affected count +
 * partial-failure disclosure, and an owner-gated resync retry on failed rows.
 *
 * Honesty invariants pinned here:
 * - Save success is ONLY claimed after the awaited server response (F10/F14)
 *   and its copy says SAVED — never "live for AI". The sync chip carries the
 *   index truth: a fresh save returns `sync_status:'pending'` (A5 sync
 *   semantics), which renders "Syncing", never a green success.
 * - `confidence`/percent UI is REMOVED everywhere (F3 inverted pin).
 * - `notes` never render on any list surface (internal-only, contract §FAQ).
 * - The client never sends `category`/`confidence`/`usageCount`/`source`
 *   (F9/F3); category is dual-written server-side only.
 *
 * Integration note for A0: this tab renders its own §29 header (title +
 * `faq-signal` + pills) because every input lives in its list state (S11/F1/
 * F2); the shell's tablist sits above and the panel additionally carries
 * `.em-faqs` (also applied on this root so the existing axe include works
 * regardless of who carries it).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { motion, MotionConfig } from 'motion/react';
import { toast } from 'sonner';
import {
  Archive,
  Edit2,
  MessageCircle,
  Pause,
  Play,
  Plus,
  RefreshCw,
  RotateCw,
  Search,
  Send,
  Trash2,
  Undo2,
  X,
} from 'lucide-react';
import { authService } from '@/app/lib/auth';
import { getErrorMessage } from '@shared/lib/http/errors';
import { fadeUp } from '@/lib/motion';
import { EmButton } from '../dashboard/EmButton';
import { PageHeader } from '../dashboard/PageHeader';
import { ResultBanner } from '../dashboard/ResultBanner';
import { useDialogFocus } from '../inbox/useDialogFocus';
import { deriveFaqSignal } from '../faq/derive';
import FaqEditorDrawer from './FaqEditorDrawer';
import FaqGapSuggestions from './FaqGapSuggestions';
import {
  asFaqRow,
  canBulkDisable,
  canBulkEnable,
  clientFilter,
  countByStatus,
  distinctCategoryTags,
  faqApi,
  formatCount,
  formatDateTime,
  previewAnswer,
  sortFaqs,
  statusChipClasses,
  syncChipClasses,
  type FaqRow,
  type FaqStatus,
} from './faqModel';

const ANIMATE = import.meta.env.MODE !== 'test';

const FOCUS_RING =
  'focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-em-focus-light focus-visible:transition-none';

type StatusFilter = 'all' | FaqStatus;
const STATUS_FILTERS: StatusFilter[] = ['all', 'draft', 'review', 'published', 'disabled', 'archived'];

/** Server search is capped by `limit` (default 10); request generously so a
 *  query surfaces every match the merchant list can then hydrate. */

interface EditorState {
  mode: 'create' | 'edit';
  row: FaqRow | null;
}

export default function FaqTab({ className }: { className?: string }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language || 'bn';

  const [faqs, setFaqs] = useState<FaqRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyFaqId, setBusyFaqId] = useState<string | null>(null);

  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');

  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [bulkMode, setBulkMode] = useState<'enable' | 'disable' | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);

  const [editor, setEditor] = useState<EditorState | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<FaqRow | null>(null);
  const [gapOpenCount, setGapOpenCount] = useState(0);

  const deleteRef = useRef<HTMLDivElement>(null);
  useDialogFocus(deleteRef, Boolean(deleteTarget));

  // S11 abort discipline (house rule): every async settle is guarded by mount
  // state AND a request token, so a slow response never clobbers newer state.
  const mountedRef = useRef(true);
  const requestIdRef = useRef(0);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadFaqs = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    try {
      setIsLoading(true);
      setLoadError(null);
      const rows = (await faqApi.listKnowledgeFaqs()).map(asFaqRow);
      if (!mountedRef.current || requestId !== requestIdRef.current) return;
      setFaqs(rows);
    } catch (error: unknown) {
      if (!mountedRef.current || requestId !== requestIdRef.current) return;
      setLoadError(getErrorMessage(error, t('manageShop.faqs.errors.load')));
    } finally {
      if (mountedRef.current && requestId === requestIdRef.current) setIsLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void loadFaqs();
  }, []);

  // Search is CLIENT-SIDE over the loaded worklist (02 §2; A8 MAJOR #2):
  // drafts, needs-review and paused rows must stay findable while the
  // merchant types — the published-only server search hid exactly the rows
  // that need fixing and made them look lost. clientFilter below does the
  // debounced-free filtering over question/answers/category_tag for ALL
  // statuses. No server round-trip on typing.

  const isOwner = authService.getCurrentShop()?.role?.toLowerCase() === 'owner';

  const counts = useMemo(() => countByStatus(faqs), [faqs]);
  const categoryTags = useMemo(() => distinctCategoryTags(faqs), [faqs]);

  const orderedRows = useMemo(() => sortFaqs(faqs), [faqs]);

  const visibleRows = useMemo(() => {
    let rows = orderedRows;
    // A8 minor #2 resolution: ONE denominator — "All" counts and shows every
    // row including archived (archived rows are reachable, not vanished),
    // matching the "Total FAQs" pill and the toolbar summary.
    if (statusFilter !== 'all') rows = rows.filter((row) => row.status === statusFilter);
    if (categoryFilter !== 'all') {
      rows = rows.filter((row) =>
        categoryFilter === '__uncategorized__' ? row.category_tag === null : row.category_tag === categoryFilter,
      );
    }
    // Single filtering path: client-side across ALL statuses (A8 MAJOR #2).
    rows = clientFilter(rows, query, '');
    return rows;
  }, [orderedRows, statusFilter, categoryFilter, query]);

  const selectedRows = useMemo(() => faqs.filter((row) => selected.has(row.id)), [faqs, selected]);
  const enableTargets = useMemo(() => selectedRows.filter(canBulkEnable), [selectedRows]);
  const disableTargets = useMemo(() => selectedRows.filter(canBulkDisable), [selectedRows]);
  const filtersActive = Boolean(query.trim()) || statusFilter !== 'all' || categoryFilter !== 'all';
  const filtersEmpty =
    !isLoading && !loadError && faqs.length > 0 && visibleRows.length === 0 && filtersActive;

  const upsertRow = (row: FaqRow) =>
    setFaqs((current) => (current.some((item) => item.id === row.id)
      ? current.map((item) => (item.id === row.id ? row : item))
      : [row, ...current]));

  const toggleSelected = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const clearBulk = () => {
    setSelected(new Set());
    setBulkMode(null);
  };

  const runTransition = async (
    faq: FaqRow,
    action: 'status' | 'archive' | 'restore' | 'resync',
    to?: FaqStatus,
  ) => {
    try {
      setBusyFaqId(faq.id);
      let updated: FaqRow;
      let toastKey: string;
      if (action === 'archive') {
        updated = asFaqRow(await faqApi.archiveKnowledgeFaq(faq.id));
        toastKey = 'manageShop.businessFaq.archived';
      } else if (action === 'restore') {
        updated = asFaqRow(await faqApi.restoreKnowledgeFaq(faq.id));
        toastKey = 'manageShop.businessFaq.restored';
      } else if (action === 'resync') {
        updated = asFaqRow(await faqApi.resyncKnowledgeFaq(faq.id));
        toastKey = 'manageShop.businessFaq.resynced';
      } else {
        updated = asFaqRow(await faqApi.updateKnowledgeFaq(faq.id, { status: to }));
        toastKey =
          to === 'published'
            ? faq.status === 'disabled'
              ? 'manageShop.faqs.activated'
              : 'manageShop.businessFaq.published'
            : 'manageShop.faqs.deactivated';
      }
      if (!mountedRef.current) return;
      upsertRow(updated);
      toast.success(t(toastKey));
    } catch (error: unknown) {
      toast.error(getErrorMessage(error, t('manageShop.faqs.errors.update')));
    } finally {
      if (mountedRef.current) setBusyFaqId(null);
    }
  };

  const runBulk = async (mode: 'enable' | 'disable') => {
    const targets = mode === 'enable' ? enableTargets : disableTargets;
    if (targets.length === 0) return;
    setBulkBusy(true);
    const results = await Promise.allSettled(
      targets.map((faq) => faqApi.updateKnowledgeFaq(faq.id, { status: mode === 'enable' ? 'published' : 'disabled' })),
    );
    const ok = results.filter((result) => result.status === 'fulfilled').length;
    const failed = results.length - ok;
    // Server-confirmed result: reload the authoritative list, never a local
    // optimistic flip (§13 partial-failure disclosure follows).
    if (mountedRef.current) {
      clearBulk();
      await loadFaqs();
      if (failed > 0) {
        toast.error(t('manageShop.businessFaq.bulk.partial', {
          ok: formatCount(ok, lang),
          failed: formatCount(failed, lang),
        }));
      } else {
        toast.success(t('manageShop.businessFaq.bulk.done', { count: ok, formatted: formatCount(ok, lang) }));
      }
    }
    setBulkBusy(false);
  };

  const handleEditorSaved = (saved: FaqRow) => {
    upsertRow(saved);
    setEditor(null);
    // "Saved" wording only — the sync chip (pending from the response) tells
    // the real index story; never claim "live for AI" from a save (F18).
    toast.success(t('manageShop.businessFaq.savedToast'));
  };

  const handleDeleteFaq = async () => {
    if (!deleteTarget) return;
    const faq = deleteTarget;
    try {
      setBusyFaqId(faq.id);
      await faqApi.deleteKnowledgeFaq(faq.id);
      if (!mountedRef.current) return;
      setFaqs((current) => current.filter((item) => item.id !== faq.id));
      setSelected((current) => {
        const next = new Set(current);
        next.delete(faq.id);
        return next;
      });
      setDeleteTarget(null);
      toast.success(t('manageShop.faqs.deleted'));
    } catch (error: unknown) {
      toast.error(getErrorMessage(error, t('manageShop.faqs.errors.delete')));
    } finally {
      if (mountedRef.current) setBusyFaqId(null);
    }
  };

  const phase = loadError ? 'error' : isLoading ? 'loading' : faqs.length === 0 ? 'empty' : 'ready';
  const signal = deriveFaqSignal(
    { phase, openGapCount: gapOpenCount, activeCount: counts.published, totalCount: faqs.length },
    t,
  );
  const shopName = authService.getCurrentShop()?.shop_name || t('manageShop.faqs.title');
  const repliesUsed = faqs.reduce((sum, row) => sum + (row.use_count || 0), 0);

  const syncChip = (faq: FaqRow) => {
    const failed = faq.sync_status === 'failed';
    return (
      <>
        {faq.status === 'published' ? (
          <span
            data-testid={`faq-sync-chip-${faq.id}`}
            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${syncChipClasses[faq.sync_status]}`}
            title={
              faq.sync_status === 'synced' && faq.synced_at
                ? `${t('manageShop.businessFaq.chip.sync.synced')} · ${formatDateTime(faq.synced_at, lang)}`
                : undefined
            }
          >
            {t(`manageShop.businessFaq.chip.sync.${faq.sync_status}`)}
          </span>
        ) : (
          // Ineligible rows cannot claim a green 'Synced': the honest story is
          // 'not in the reply index' (A8 minor #1). Lifecycle chip + Publish is the action.
          <span
            data-testid={`faq-sync-chip-${faq.id}`}
            className="inline-flex items-center gap-1 rounded-full border border-em-border bg-em-bg-muted px-2 py-0.5 text-xs font-medium text-em-text-secondary"
            title={t('manageShop.businessFaq.chip.sync.notIndexedHelp')}
          >
            {t('manageShop.businessFaq.chip.sync.notIndexed')}
          </span>
        )}
        {/* Failed = saved but NOT live for replies. Retry is a labeled 44px
            button (§18), owner-only per contract, and re-runs via resync. */}
        {failed && isOwner && (
          <EmButton
            variant="ghost"
            data-testid={`faq-resync-${faq.id}`}
            onClick={() => void runTransition(faq, 'resync')}
            disabled={busyFaqId === faq.id}
            loading={busyFaqId === faq.id}
            aria-label={`${t('manageShop.businessFaq.sync.retry')}: ${faq.question}`}
            className="gap-1 px-2 text-xs"
          >
            <RotateCw className="h-3.5 w-3.5" aria-hidden="true" />
            {t('manageShop.businessFaq.sync.retry')}
          </EmButton>
        )}
      </>
    );
  };

  return (
    <MotionConfig reducedMotion="user">
      <div className={`em-faqs min-h-full ${className ?? ''}`}>
        <div className="mx-auto w-full max-w-[1440px] space-y-6">
          {/* Execution-page header (§29): title + signal + factual pills only. */}
          <motion.div variants={fadeUp} initial={ANIMATE ? 'hidden' : false} animate="visible">
            <PageHeader
              title={t('manageShop.faqs.title')}
              breadcrumb={[{ label: shopName }]}
              signal={signal}
              signalTestId="faq-signal"
              signalAnnounce={false}
              meta={
                <div className="flex flex-wrap items-center gap-2">
                  <span className="em-tabular whitespace-nowrap rounded-full border border-em-border bg-em-bg-muted px-3 py-1 text-xs font-medium text-em-text-secondary">
                    {t('manageShop.businessFaq.metrics.published')}: {formatCount(counts.published, lang)}
                  </span>
                  <span className="em-tabular whitespace-nowrap rounded-full border border-em-border bg-em-bg-muted px-3 py-1 text-xs font-medium text-em-text-secondary">
                    {t('manageShop.faqs.metrics.total')}: {formatCount(faqs.length, lang)}
                  </span>
                  <span className="em-tabular whitespace-nowrap rounded-full border border-em-border bg-em-bg-muted px-3 py-1 text-xs font-medium text-em-text-secondary">
                    {t('manageShop.businessFaq.metrics.repliesUsed')}: {formatCount(repliesUsed, lang)}
                  </span>
                </div>
              }
            />
          </motion.div>

          <FaqGapSuggestions onOpenCountChange={setGapOpenCount} />

          <motion.section
            variants={fadeUp}
            initial={ANIMATE ? 'hidden' : false}
            animate="visible"
            className="rounded-xl border border-em-border bg-em-bg-surface"
          >
            {/* Worklist toolbar: search + filters + refresh + the single
                screen-level primary (hidden on loadError — F6). */}
            <div className="flex flex-col gap-3 border-b border-em-border p-4 md:flex-row md:items-center md:justify-between">
              <div className="min-w-0">
                <h3 className="font-semibold text-em-text-primary">{t('manageShop.faqs.manageTitle')}</h3>
                <p className="em-tabular text-sm text-em-text-secondary">
                  {t('manageShop.businessFaq.metrics.countsSummary', {
                    published: formatCount(counts.published, lang),
                    total: formatCount(faqs.length, lang),
                  })}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative flex-1 md:flex-none">
                  <Search
                    className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-em-text-secondary"
                    aria-hidden="true"
                  />
                  <input
                    id="faq-search"
                    type="search"
                    data-testid="faq-search"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={t('manageShop.businessFaq.searchPlaceholder')}
                    aria-label={t('manageShop.businessFaq.searchAria')}
                    className={`min-h-11 w-full rounded-lg border border-em-border-strong bg-em-bg-surface py-2 pl-9 pr-12 text-sm text-em-text-primary focus:outline-none md:w-64 ${FOCUS_RING}`}
                  />
                  {query && (
                    <button
                      type="button"
                      onClick={() => setQuery('')}
                      aria-label={t('common.close')}
                      className={`absolute right-0 top-1/2 inline-flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-lg text-em-text-secondary hover:bg-em-bg-muted ${FOCUS_RING}`}
                    >
                      <X className="h-4 w-4" aria-hidden="true" />
                    </button>
                  )}
                </div>
                <label className="sr-only" htmlFor="faq-filter-category">
                  {t('manageShop.businessFaq.filter.categoryLabel')}
                </label>
                <select
                  id="faq-filter-category"
                  data-testid="faq-filter-category"
                  value={categoryFilter}
                  onChange={(event) => setCategoryFilter(event.target.value)}
                  className={`min-h-11 rounded-lg border border-em-border-strong bg-em-bg-surface px-3 text-sm text-em-text-primary ${FOCUS_RING}`}
                >
                  <option value="all">{t('manageShop.businessFaq.filter.category.all')}</option>
                  {categoryTags.map((tag) => (
                    <option key={tag} value={tag}>
                      {tag}
                    </option>
                  ))}
                  <option value="__uncategorized__">{t('manageShop.businessFaq.filter.category.none')}</option>
                </select>
                <EmButton variant="secondary" onClick={() => void loadFaqs()} disabled={isLoading} className="gap-2">
                  <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} aria-hidden="true" />
                  {t('manageShop.faqs.refresh')}
                </EmButton>
                {!loadError && faqs.length > 0 && (
                  <EmButton
                    variant="primary"
                    onClick={() => setEditor({ mode: 'create', row: null })}
                    className="gap-2"
                    data-testid="faq-add"
                  >
                    <Plus className="h-4 w-4" aria-hidden="true" />
                    {t('manageShop.faqs.addFaq')}
                  </EmButton>
                )}
              </div>
            </div>

            {/* Status filter chips with accurate counts (F17). */}
            {!loadError && !isLoading && faqs.length > 0 && (
              <div className="flex flex-wrap gap-2 overflow-x-auto border-b border-em-border px-4 py-3" role="group" aria-label={t('manageShop.businessFaq.filter.label')}>
                {STATUS_FILTERS.map((filter) => {
                  const active = statusFilter === filter;
                  const count = filter === 'all' ? counts.all : counts[filter];
                  return (
                    <button
                      key={filter}
                      type="button"
                      id={`faq-filter-${filter}`}
                      data-testid={`faq-filter-${filter}`}
                      aria-pressed={active}
                      onClick={() => setStatusFilter(filter)}
                      className={`em-tabular min-h-11 whitespace-nowrap rounded-full border px-3 text-xs font-medium ${
                        active
                          ? 'border-em-violet-600 bg-em-violet-50 text-em-violet-700'
                          : 'border-em-border bg-em-bg-muted text-em-text-secondary hover:text-em-text-primary'
                      } ${FOCUS_RING}`}
                    >
                      {filter === 'all'
                        ? t('manageShop.businessFaq.filter.all')
                        : t(`manageShop.businessFaq.filter.status.${filter}`)}{' '}
                      ({formatCount(count, lang)})
                    </button>
                  );
                })}
              </div>
            )}

            {loadError && (
              <ResultBanner
                className="m-4"
                status="error"
                title={t('manageShop.faqs.errors.load')}
                description={loadError}
                nextAction={{ label: t('manageShop.faqs.refresh'), onClick: () => void loadFaqs() }}
              />
            )}


            {isLoading ? (
              <div className="space-y-3 p-4" aria-label={t('manageShop.faqs.loading')}>
                {[0, 1, 2].map((row) => (
                  <div key={row} className="animate-pulse space-y-2 rounded-xl border border-em-border bg-em-bg-muted/60 p-4">
                    <div className="h-4 w-2/3 rounded bg-em-border" />
                    <div className="h-3 w-full rounded bg-em-border" />
                    <div className="h-3 w-1/3 rounded bg-em-border" />
                  </div>
                ))}
              </div>
            ) : loadError ? null : visibleRows.length === 0 && !filtersActive ? (
              <div className="px-4 py-12 text-center">
                {faqs.length === 0 ? (
                  <>
                    <MessageCircle className="mx-auto mb-3 h-12 w-12 text-em-border-strong" aria-hidden="true" />
                    <h4 className="text-base font-semibold text-em-text-primary">{t('manageShop.faqs.emptyTitle')}</h4>
                    <p className="mx-auto mt-1 max-w-md text-sm text-em-text-secondary">{t('manageShop.faqs.emptyDescription')}</p>
                    <EmButton
                      variant="primary"
                      onClick={() => setEditor({ mode: 'create', row: null })}
                      className="mt-4 gap-2"
                      data-testid="faq-add"
                    >
                      <Plus className="h-4 w-4" aria-hidden="true" />
                      {t('manageShop.faqs.addFaq')}
                    </EmButton>
                  </>
                ) : (
                  // Only archived rows exist outside the default filter — a
                  // factual pointer, not a fabricated "no answers" claim.
                  <>
                    <h4 className="text-sm font-semibold text-em-text-primary">{t('manageShop.businessFaq.onlyArchived')}</h4>
                    <EmButton
                      variant="secondary"
                      className="mt-3 gap-2"
                      onClick={() => setStatusFilter('archived')}
                    >
                      <Archive className="h-4 w-4" aria-hidden="true" />
                      {t('manageShop.businessFaq.filter.status.archived')}
                    </EmButton>
                  </>
                )}
              </div>
            ) : filtersEmpty ? (
              <div className="px-4 py-10 text-center">
                <h4 className="text-sm font-semibold text-em-text-primary">{t('manageShop.businessFaq.filter.noResults')}</h4>
                <EmButton
                  variant="secondary"
                  className="mt-3"
                  onClick={() => {
                    setQuery('');
                    setStatusFilter('all');
                    setCategoryFilter('all');
                  }}
                >
                  {t('manageShop.businessFaq.filter.clear')}
                </EmButton>
              </div>
            ) : (
              <div className="divide-y divide-em-border">
                {visibleRows.map((faq) => {
                  const isBusy = busyFaqId === faq.id;
                  const preview = previewAnswer(faq);
                  const displayQuestion = faq.question || faq.category || '';
                  return (
                    <article key={faq.id} data-testid={`faq-row-${faq.id}`} className="p-4">
                      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                        <div className="flex min-w-0 flex-1 gap-3">
                          <label className="mt-1 inline-flex min-h-11 min-w-11 shrink-0 cursor-pointer items-center justify-center" title={t('manageShop.businessFaq.bulk.select')}>
                            <input
                              type="checkbox"
                              checked={selected.has(faq.id)}
                              onChange={() => toggleSelected(faq.id)}
                              className="h-5 w-5 rounded border-em-border-strong accent-em-violet-600"
                              aria-label={`${t('manageShop.businessFaq.bulk.select')}: ${displayQuestion}`}
                            />
                          </label>
                          <div className="min-w-0 flex-1">
                            <div className="mb-2 flex flex-wrap items-center gap-2">
                              <h4 className="text-sm font-semibold text-em-text-primary md:text-base">{displayQuestion}</h4>
                              <span
                                data-testid={`faq-status-chip-${faq.id}`}
                                className={`rounded-full border px-2 py-0.5 text-xs font-semibold ${statusChipClasses[faq.status]}`}
                              >
                                {t(`manageShop.businessFaq.chip.status.${faq.status}`)}
                              </span>
                              {syncChip(faq)}
                              {faq.category_tag && (
                                <span className="rounded-full bg-em-violet-50 px-2.5 py-0.5 text-xs font-medium text-em-violet-700">
                                  {faq.category_tag}
                                </span>
                              )}
                            </div>
                            <p className="line-clamp-2 text-sm leading-6 text-em-text-primary">
                              {preview.text || <span className="text-em-text-secondary">{t('manageShop.businessFaq.notSet')}</span>}
                            </p>
                            {faq.keywords.length > 0 && (
                              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                                <span className="text-xs font-medium text-em-text-secondary">{t('manageShop.businessFaq.keywordsLabel')}</span>
                                {faq.keywords.map((keyword) => (
                                  <span
                                    key={keyword}
                                    className="rounded bg-em-bg-muted px-1.5 py-0.5 text-xs text-em-text-secondary"
                                  >
                                    {keyword}
                                  </span>
                                ))}
                              </div>
                            )}
                            <div className="em-tabular mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-em-text-secondary">
                              <span>{t('manageShop.businessFaq.repliesUsed', { count: faq.use_count, formatted: formatCount(faq.use_count, lang) })}</span>
                              <span>{t('manageShop.businessFaq.time.created', { value: formatDateTime(faq.created_at, lang) })}</span>
                              <span>{t('manageShop.businessFaq.time.updated', { value: formatDateTime(faq.updated_at, lang) })}</span>
                              {faq.source && <span>{t('manageShop.faqs.source', { source: faq.source })}</span>}
                            </div>
                          </div>
                        </div>
                        <div className="flex shrink-0 flex-wrap gap-2 md:justify-end">
                          <EmButton
                            variant="secondary"
                            onClick={() => setEditor({ mode: 'edit', row: faq })}
                            className="gap-1 px-3 text-xs"
                            aria-label={`${t('manageShop.faqs.edit')}: ${displayQuestion}`}
                          >
                            <Edit2 className="h-4 w-4" aria-hidden="true" />
                            {t('manageShop.faqs.edit')}
                          </EmButton>
                          {faq.status === 'published' && (
                            <EmButton
                              variant="secondary"
                              onClick={() => void runTransition(faq, 'status', 'disabled')}
                              disabled={isBusy}
                              loading={isBusy}
                              className="gap-1 px-3 text-xs"
                              aria-label={`${t('manageShop.faqs.deactivate')}: ${displayQuestion}`}
                            >
                              <Pause className="h-4 w-4" aria-hidden="true" />
                              {t('manageShop.faqs.deactivate')}
                            </EmButton>
                          )}
                          {faq.status === 'disabled' && (
                            <EmButton
                              variant="secondary"
                              onClick={() => void runTransition(faq, 'status', 'published')}
                              disabled={isBusy}
                              loading={isBusy}
                              className="gap-1 px-3 text-xs"
                              aria-label={`${t('manageShop.faqs.activate')}: ${displayQuestion}`}
                            >
                              <Play className="h-4 w-4" aria-hidden="true" />
                              {t('manageShop.faqs.activate')}
                            </EmButton>
                          )}
                          {(faq.status === 'draft' || faq.status === 'review') && (
                            <EmButton
                              variant="secondary"
                              onClick={() => void runTransition(faq, 'status', 'published')}
                              disabled={isBusy}
                              loading={isBusy}
                              className="gap-1 px-3 text-xs"
                              aria-label={`${t('manageShop.businessFaq.publish')}: ${displayQuestion}`}
                            >
                              <Send className="h-4 w-4" aria-hidden="true" />
                              {t('manageShop.businessFaq.publish')}
                            </EmButton>
                          )}
                          {faq.status !== 'archived' ? (
                            <EmButton
                              variant="ghost"
                              data-testid={`faq-archive-${faq.id}`}
                              onClick={() => void runTransition(faq, 'archive')}
                              disabled={isBusy}
                              className="gap-1 px-3 text-xs"
                              aria-label={`${t('manageShop.businessFaq.archive')}: ${displayQuestion}`}
                            >
                              <Archive className="h-4 w-4" aria-hidden="true" />
                              {t('manageShop.businessFaq.archive')}
                            </EmButton>
                          ) : (
                            <EmButton
                              variant="ghost"
                              data-testid={`faq-restore-${faq.id}`}
                              onClick={() => void runTransition(faq, 'restore')}
                              disabled={isBusy}
                              className="gap-1 px-3 text-xs"
                              aria-label={`${t('manageShop.businessFaq.restore')}: ${displayQuestion}`}
                            >
                              <Undo2 className="h-4 w-4" aria-hidden="true" />
                              {t('manageShop.businessFaq.restore')}
                            </EmButton>
                          )}
                          {isOwner && (
                            <button
                              type="button"
                              onClick={() => setDeleteTarget(faq)}
                              disabled={isBusy}
                              className={`inline-flex h-11 w-11 items-center justify-center rounded-lg text-em-text-secondary hover:bg-em-danger-100 hover:text-em-danger-700 disabled:opacity-60 ${FOCUS_RING}`}
                              title={t('manageShop.faqs.delete')}
                              aria-label={`${t('manageShop.faqs.delete')}: ${displayQuestion}`}
                            >
                              <Trash2 className="h-4 w-4" aria-hidden="true" />
                            </button>
                          )}
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}

            {/* Bulk bar: enable/disable only, affected count disclosed, inline
                two-step confirm, server-confirmed outcome + partial failure. */}
            {!loadError && !isLoading && selected.size > 0 && (
              <div
                data-testid="faq-bulk-bar"
                className="sticky bottom-0 flex flex-wrap items-center justify-between gap-2 border-t border-em-border bg-em-bg-surface px-4 py-3"
              >
                <span className="em-tabular text-sm text-em-text-secondary">
                  {t('manageShop.businessFaq.bulk.selected', { count: selected.size, formatted: formatCount(selected.size, lang) })}
                </span>
                {bulkMode === null ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <EmButton
                      variant="secondary"
                      data-testid="faq-bulk-enable"
                      onClick={() => setBulkMode('enable')}
                      disabled={enableTargets.length === 0}
                    >
                      {t('manageShop.businessFaq.bulk.enable')} ({formatCount(enableTargets.length, lang)})
                    </EmButton>
                    <EmButton
                      variant="secondary"
                      data-testid="faq-bulk-disable"
                      onClick={() => setBulkMode('disable')}
                      disabled={disableTargets.length === 0}
                    >
                      {t('manageShop.businessFaq.bulk.disable')} ({formatCount(disableTargets.length, lang)})
                    </EmButton>
                    <EmButton variant="ghost" onClick={clearBulk}>
                      {t('manageShop.businessFaq.bulk.clear')}
                    </EmButton>
                  </div>
                ) : (
                  <div className="flex flex-wrap items-center gap-2">
                    <span role="status" aria-live="polite" className="text-sm text-em-text-primary">
                      {t(`manageShop.businessFaq.bulk.${bulkMode}Confirm`, {
                        count: (bulkMode === 'enable' ? enableTargets : disableTargets).length,
                        formatted: formatCount((bulkMode === 'enable' ? enableTargets : disableTargets).length, lang),
                      })}
                    </span>
                    <EmButton
                      variant="primary"
                      data-testid="faq-bulk-confirm"
                      loading={bulkBusy}
                      onClick={() => void runBulk(bulkMode)}
                    >
                      {t('common.confirm')}
                    </EmButton>
                    <EmButton variant="secondary" onClick={() => setBulkMode(null)} disabled={bulkBusy}>
                      {t('common.cancel')}
                    </EmButton>
                  </div>
                )}
              </div>
            )}
          </motion.section>
        </div>

        {editor && (
          <FaqEditorDrawer
            key={`${editor.mode}-${editor.row?.id ?? 'new'}`}
            row={editor.mode === 'edit' ? editor.row : null}
            knownTags={categoryTags}
            onClose={() => setEditor(null)}
            onSaved={handleEditorSaved}
          />
        )}

        {/* Danger delete confirm (F11 verbatim): archive stays the primary
            retirement affordance; hard delete + deletePoint is owner-only. */}
        {deleteTarget && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-em-midnight-950/60 p-4"
            onClick={(event) => {
              if (event.target === event.currentTarget) setDeleteTarget(null);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setDeleteTarget(null);
            }}
          >
            <div
              ref={deleteRef}
              role="dialog"
              aria-modal="true"
              aria-labelledby="faq-delete-title"
              className="w-full max-w-md rounded-xl bg-em-bg-surface p-5 shadow-xl md:p-6"
            >
              <h3 id="faq-delete-title" className="text-lg font-semibold text-em-text-primary">
                {t('faqSettings.confirmTitle')}
              </h3>
              <p className="mt-2 text-sm text-em-text-secondary">{t('manageShop.faqs.confirmDelete')}</p>
              <p className="mt-2 text-sm text-em-text-secondary">{t('manageShop.businessFaq.deleteArchiveHint')}</p>
              <p className="mt-2 truncate text-sm font-semibold text-em-text-primary">
                {deleteTarget.question || deleteTarget.category || ''}
              </p>
              <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:justify-end">
                <EmButton variant="secondary" onClick={() => setDeleteTarget(null)}>
                  {t('common.cancel')}
                </EmButton>
                <EmButton
                  variant="danger"
                  onClick={() => void handleDeleteFaq()}
                  disabled={busyFaqId === deleteTarget.id}
                  loading={busyFaqId === deleteTarget.id}
                  data-testid="faq-delete-confirm"
                >
                  {t('manageShop.faqs.delete')}
                </EmButton>
              </div>
            </div>
          </div>
        )}
      </div>
    </MotionConfig>
  );
}

