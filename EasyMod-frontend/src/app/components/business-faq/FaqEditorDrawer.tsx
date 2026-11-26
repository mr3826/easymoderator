/**
 * FAQ editor drawer (A3, 02 §2). Desktop ≥768px: right-side drawer on the
 * ProviderDrawer pattern — scrim + 250 ms transform-only slide + status chip
 * header + `drawer-action-feedback` INSIDE the dialog (§17: the reply to the
 * merchant's action renders here, not behind the aria-modal scrim). Mobile:
 * same component, full-screen sheet, opacity swap instead of slide (editor
 * swap is none/instant per the contract — never a bounce).
 *
 * Honesty rules bound here:
 * - Both answer languages are first-class fields. Legacy single-language rows
 *   hydrate into their stored slot (bn data can never be silently dropped).
 * - The payload NEVER carries `category`, `confidence`, `usageCount` or
 *   `source` (contract F9/F3; server dual-writes category:=question itself).
 * - Save resolves BEFORE the row/toast is claimed (server row wins).
 * - `notes` + `keywords` are labeled internal-only with explicit helper text.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { motion, MotionConfig } from 'motion/react';
import { Plus, TriangleAlert, X } from 'lucide-react';
import { getErrorMessage } from '@shared/lib/http/errors';
import { EmButton } from '../dashboard/EmButton';
import { useDialogFocus } from '../inbox/useDialogFocus';
import {
  asFaqRow,
  EDITOR_SELECTABLE_STATUSES,
  editorSeed,
  faqApi,
  statusChipClasses,
  type FaqRow,
  type FaqStatus,
} from './faqModel';

const ANIMATE = import.meta.env.MODE !== 'test';

const FOCUS_RING =
  'focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-em-focus-light focus-visible:transition-none';

/** Desktop drawer vs mobile full-screen sheet (<768px). jsdom-safe: when
 *  matchMedia is unavailable the drawer behaves as the desktop variant. */
function useIsCompact(): boolean {
  const [compact, setCompact] = useState(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    return window.matchMedia('(max-width: 767px)').matches;
  });
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const mq = window.matchMedia('(max-width: 767px)');
    const onChange = () => setCompact(mq.matches);
    onChange();
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, []);
  return compact;
}

const INPUT_CLASSES =
  'w-full min-h-11 border border-em-border-input rounded-lg bg-em-bg-surface px-3 py-2 text-sm text-em-text-primary focus:outline-none';

/** Server validator bounds (knowledge.validator.js) — maxLength mirrors them
 *  so the UI never fights the server (§12 helper-visible limits). */
const QUESTION_MAX = 2000;
const TAG_MAX = 60;
const NOTES_MAX = 5000;
const KEYWORD_MAX_ITEMS = 32;
const KEYWORD_MAX_LENGTH = 80;

export interface FaqEditorDrawerProps {
  /** null → create a new FAQ; a row → edit it. */
  row: FaqRow | null;
  /** Distinct tags already in use, offered as free-text suggestions. */
  knownTags: string[];
  onClose: () => void;
  /** Called ONLY after the awaited server response resolves (never optimistic). */
  onSaved: (saved: FaqRow, mode: 'create' | 'update') => void;
}

export default function FaqEditorDrawer({ row, knownTags, onClose, onSaved }: FaqEditorDrawerProps) {
  const { t } = useTranslation();
  const panelRef = useRef<HTMLDivElement>(null);
  useDialogFocus(panelRef, true);

  const isEdit = Boolean(row);
  const isCompact = useIsCompact();
  const seed = useMemo(() => editorSeed(row), [row]);
  const [question, setQuestion] = useState(seed.question);
  const [answerEn, setAnswerEn] = useState(seed.answerEn);
  const [answerBn, setAnswerBn] = useState(seed.answerBn);
  const [categoryTag, setCategoryTag] = useState(seed.categoryTag);
  const [keywords, setKeywords] = useState<string[]>(seed.keywords);
  const [keywordDraft, setKeywordDraft] = useState('');
  const [notes, setNotes] = useState(seed.notes);
  const [status, setStatus] = useState<FaqStatus>(seed.status);
  const [priority, setPriority] = useState(seed.priority);
  const [isSaving, setIsSaving] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  useEffect(() => {
    // The drawer mounts fresh per row; reset all local state from the seed.
    setQuestion(seed.question);
    setAnswerEn(seed.answerEn);
    setAnswerBn(seed.answerBn);
    setCategoryTag(seed.categoryTag);
    setKeywords(seed.keywords);
    setKeywordDraft('');
    setNotes(seed.notes);
    setStatus(seed.status);
    setPriority(seed.priority);
    setFeedback(null);
  }, [seed]);

  const titleId = 'faq-editor-title';

  const trimmedQuestion = question.trim();
  const hasAnswer = Boolean(answerEn.trim() || answerBn.trim());
  const priorityNumber = priority.trim() === '' ? null : Number(priority);
  const priorityValid = priorityNumber === null || (Number.isInteger(priorityNumber) && priorityNumber >= 0 && priorityNumber <= 1000);
  const canSubmit = Boolean(trimmedQuestion) && hasAnswer && priorityValid && !isSaving;

  const dirty =
    trimmedQuestion !== seed.question.trim() ||
    answerEn.trim() !== seed.answerEn.trim() ||
    answerBn.trim() !== seed.answerBn.trim() ||
    categoryTag.trim() !== seed.categoryTag.trim() ||
    notes.trim() !== seed.notes.trim() ||
    status !== seed.status ||
    priority !== seed.priority ||
    JSON.stringify(keywords) !== JSON.stringify(seed.keywords);

  const addKeyword = () => {
    const value = keywordDraft.trim().toLowerCase();
    if (!value || keywords.includes(value) || keywords.length >= KEYWORD_MAX_ITEMS) return;
    setKeywords((current) => [...current, value.slice(0, KEYWORD_MAX_LENGTH)]);
    setKeywordDraft('');
  };

  const save = async () => {
    if (!canSubmit) return;
    setFeedback(null);
    try {
      setIsSaving(true);
      const body: Record<string, unknown> = {};
      // Send ONLY changed fields (partial PATCH; absence never clears stored
      // bn/en data). The client never sends category/confidence/usageCount/source.
      if (trimmedQuestion !== seed.question.trim()) body.question = trimmedQuestion;
      if (answerEn.trim() !== seed.answerEn.trim()) body.answer_en = answerEn.trim();
      if (answerBn.trim() !== seed.answerBn.trim()) body.answer_bn = answerBn.trim();
      if (categoryTag.trim() !== seed.categoryTag.trim()) body.category_tag = categoryTag.trim() || null;
      if (notes.trim() !== seed.notes.trim()) body.notes = notes.trim() || null;
      if (JSON.stringify(keywords) !== JSON.stringify(seed.keywords)) body.keywords = keywords;
      if (status !== seed.status) body.status = status;
      if (priorityNumber !== null && priorityNumber !== (seed.priority === '' ? null : Number(seed.priority))) {
        body.priority = priorityNumber;
      }

      let saved: FaqRow;
      let mode: 'create' | 'update';
      if (row) {
        saved = asFaqRow(await faqApi.updateKnowledgeFaq(row.id, body));
        mode = 'update';
      } else {
        // Create always sends the required fields; answers both slots when set.
        saved = asFaqRow(
          await faqApi.createKnowledgeFaq({
            question: trimmedQuestion,
            ...(answerEn.trim() ? { answer_en: answerEn.trim() } : {}),
            ...(answerBn.trim() ? { answer_bn: answerBn.trim() } : {}),
            ...(categoryTag.trim() ? { category_tag: categoryTag.trim() } : {}),
            ...(keywords.length ? { keywords } : {}),
            ...(notes.trim() ? { notes: notes.trim() } : {}),
            status,
            ...(priorityNumber !== null ? { priority: priorityNumber } : {}),
          }),
        );
        mode = 'create';
      }
      onSaved(saved, mode);
    } catch (error: unknown) {
      setFeedback(getErrorMessage(error, t('manageShop.businessFaq.errors.save')));
    } finally {
      setIsSaving(false);
    }
  };

  const close = () => {
    if (!isSaving) onClose();
  };

  return (
    <MotionConfig reducedMotion="user">
      <div
        className="fixed inset-0 z-50 flex justify-end bg-em-midnight-950/60"
        onClick={(event) => {
          if (event.target === event.currentTarget) close();
        }}
      >
        <motion.div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          tabIndex={-1}
          data-testid="faq-editor-drawer"
          initial={ANIMATE ? (isCompact ? { opacity: 0 } : { x: '100%' }) : false}
          animate={ANIMATE ? (isCompact ? { opacity: 1 } : { x: 0 }) : undefined}
          transition={{ duration: 0.25, ease: [0.2, 0.8, 0.3, 1] }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              close();
            }
          }}
          className={`flex h-full flex-col bg-em-bg-surface shadow-xl ${
            isCompact ? 'w-full' : 'w-full max-w-md border-l border-em-border'
          }`}
        >
          {/* Drawer header: title + lifecycle chip of the row being edited. */}
          <div className="flex items-start justify-between gap-3 border-b border-em-border p-5">
            <div className="min-w-0">
              <h2 id={titleId} className="text-base font-semibold text-em-text-primary">
                {isEdit ? t('manageShop.faqs.modal.editTitle') : t('manageShop.faqs.modal.addTitle')}
              </h2>
              {row && (
                <span
                  className={`mt-1.5 inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${statusChipClasses[row.status]}`}
                >
                  {t(`manageShop.businessFaq.chip.status.${row.status}`)}
                </span>
              )}
            </div>
            <button
              type="button"
              onClick={close}
              aria-label={t('common.close')}
              className={`inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-lg text-em-text-secondary hover:bg-em-bg-muted ${FOCUS_RING}`}
            >
              <X className="h-5 w-5" aria-hidden="true" />
            </button>
          </div>

          {/* Drawer body */}
          <div className="flex-1 space-y-4 overflow-y-auto p-5">
            {/* Action feedback stays INSIDE the dialog (§17/A8). */}
            {feedback && (
              <p
                role="alert"
                className="flex items-start gap-1.5 rounded-lg bg-em-danger-100/60 px-3 py-2 text-sm text-em-danger-700"
                data-testid="drawer-action-feedback"
              >
                <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                <span>{feedback}</span>
              </p>
            )}

            <div className="block">
              {/* Helper text sits OUTSIDE the <label>: the field's accessible
                  name stays exactly the label (house query/test discipline). */}
              <label className="block">
                <span className="mb-1 block text-sm font-medium text-em-text-primary">
                  {t('manageShop.faqs.modal.questionLabel')}
                </span>
                <input
                  type="text"
                  value={question}
                  onChange={(event) => setQuestion(event.target.value)}
                  maxLength={QUESTION_MAX}
                  placeholder={t('manageShop.faqs.modal.questionPlaceholder')}
                  className={`${INPUT_CLASSES} ${FOCUS_RING}`}
                  aria-describedby="faq-editor-question-help"
                />
              </label>
              <span id="faq-editor-question-help" className="mt-1 block text-xs text-em-text-secondary">
                {t('manageShop.businessFaq.editor.questionHelp')}
              </span>
            </div>

            <label className="block">
              <span className="mb-1 block text-sm font-medium text-em-text-primary">
                {t('manageShop.businessFaq.editor.answerEn')}
              </span>
              <textarea
                value={answerEn}
                onChange={(event) => setAnswerEn(event.target.value)}
                rows={4}
                placeholder={t('manageShop.faqs.modal.answerPlaceholder')}
                className={`w-full rounded-lg border border-em-border-input bg-em-bg-surface px-3 py-2 text-sm text-em-text-primary focus:outline-none ${FOCUS_RING}`}
              />
            </label>

            <label className="block">
              <span className="mb-1 block text-sm font-medium text-em-text-primary">
                {t('manageShop.businessFaq.editor.answerBn')}
              </span>
              <textarea
                value={answerBn}
                onChange={(event) => setAnswerBn(event.target.value)}
                rows={4}
                placeholder={t('manageShop.businessFaq.editor.answerBnPlaceholder')}
                className={`w-full rounded-lg border border-em-border-input bg-em-bg-surface px-3 py-2 text-sm text-em-text-primary focus:outline-none ${FOCUS_RING}`}
              />
            </label>

            <div className="block">
              <label className="block">
                <span className="mb-1 block text-sm font-medium text-em-text-primary">
                  {t('manageShop.businessFaq.editor.categoryTag')}
                </span>
                <input
                  type="text"
                  list="faq-editor-tag-options"
                  value={categoryTag}
                  onChange={(event) => setCategoryTag(event.target.value)}
                  maxLength={TAG_MAX}
                  placeholder={t('manageShop.faqs.modal.categoryPlaceholder')}
                  className={`${INPUT_CLASSES} ${FOCUS_RING}`}
                  aria-describedby="faq-editor-tag-help"
                />
              </label>
              <datalist id="faq-editor-tag-options">
                {knownTags.map((tag) => (
                  <option key={tag} value={tag} />
                ))}
              </datalist>
              <span id="faq-editor-tag-help" className="mt-1 block text-xs text-em-text-secondary">
                {t('manageShop.businessFaq.editor.tagHelp')}
              </span>
            </div>

            <div className="block">
              <span className="mb-1 block text-sm font-medium text-em-text-primary" id="faq-editor-keywords-label">
                {t('manageShop.businessFaq.editor.keywords')}
              </span>
              {keywords.length > 0 && (
                <ul className="mb-2 flex flex-wrap gap-1.5" aria-labelledby="faq-editor-keywords-label">
                  {keywords.map((keyword) => (
                    <li key={keyword}>
                      {/* Whole chip is the remove control (≥44px tap target,
                          §18) with an explicit X affordance + aria-label. */}
                      <button
                        type="button"
                        aria-label={`${t('manageShop.businessFaq.editor.keywordsRemove')}: ${keyword}`}
                        onClick={() => setKeywords((current) => current.filter((item) => item !== keyword))}
                        className={`inline-flex min-h-11 items-center gap-1.5 rounded-full border border-em-border bg-em-bg-muted px-3 text-xs font-medium text-em-text-secondary hover:border-em-danger-700/40 hover:text-em-danger-700 ${FOCUS_RING}`}
                      >
                        {keyword}
                        <X className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={keywordDraft}
                  onChange={(event) => setKeywordDraft(event.target.value)}
                  maxLength={KEYWORD_MAX_LENGTH}
                  placeholder={t('manageShop.businessFaq.editor.keywordsPlaceholder')}
                  className={`${INPUT_CLASSES} ${FOCUS_RING}`}
                  aria-labelledby="faq-editor-keywords-label"
                  aria-describedby="faq-editor-keywords-help"
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      addKeyword();
                    }
                  }}
                />
                <EmButton
                  variant="secondary"
                  onClick={addKeyword}
                  disabled={!keywordDraft.trim() || keywords.length >= KEYWORD_MAX_ITEMS}
                  className="shrink-0 gap-1 px-3 text-xs"
                  aria-label={t('manageShop.businessFaq.editor.keywordsAdd')}
                >
                  <Plus className="h-4 w-4" aria-hidden="true" />
                </EmButton>
              </div>
              <span id="faq-editor-keywords-help" className="mt-1 block text-xs text-em-text-secondary">
                {t('manageShop.businessFaq.editor.keywordsHelp')}
              </span>
            </div>

            <div className="block">
              <label className="block">
                <span className="mb-1 block text-sm font-medium text-em-text-primary">
                  {t('manageShop.businessFaq.editor.notes')}
                </span>
                <textarea
                  value={notes}
                  onChange={(event) => setNotes(event.target.value)}
                  rows={3}
                  maxLength={NOTES_MAX}
                  placeholder={t('manageShop.businessFaq.editor.notesPlaceholder')}
                  className={`w-full rounded-lg border border-em-border-input bg-em-bg-surface px-3 py-2 text-sm text-em-text-primary focus:outline-none ${FOCUS_RING}`}
                  aria-describedby="faq-editor-notes-help"
                />
              </label>
              <span id="faq-editor-notes-help" className="mt-1 block text-xs text-em-text-secondary">
                {t('manageShop.businessFaq.editor.notesHelp')}
              </span>
            </div>

            {/* Archived rows: restore (→ disabled) is a row action and the ONLY
                exit; the status control stays locked here, never hidden data. */}
            {row?.status === 'archived' ? (
              <div className="block">
                <span className="mb-1 block text-sm font-medium text-em-text-primary">
                  {t('manageShop.businessFaq.editor.status')}
                </span>
                {/* The lifecycle chip lives in the drawer header — no duplicate. */}
                <p className="text-xs text-em-text-secondary" data-testid="faq-editor-status-locked">
                  {t('manageShop.businessFaq.editor.archivedLocked')}
                </p>
              </div>
            ) : (
              <div className="block">
                <label className="block">
                  <span className="mb-1 block text-sm font-medium text-em-text-primary">
                    {t('manageShop.businessFaq.editor.status')}
                  </span>
                  <select
                    value={status}
                    onChange={(event) => setStatus(event.target.value as FaqStatus)}
                    className={`${INPUT_CLASSES} ${FOCUS_RING}`}
                    aria-describedby="faq-editor-status-help"
                  >
                    {EDITOR_SELECTABLE_STATUSES.map((option) => (
                      <option key={option} value={option}>
                        {t(`manageShop.businessFaq.chip.status.${option}`)}
                      </option>
                    ))}
                  </select>
                </label>
                <span id="faq-editor-status-help" className="mt-1 block text-xs text-em-text-secondary">
                  {status === 'published'
                    ? t('manageShop.businessFaq.editor.publishedWarn')
                    : t('manageShop.businessFaq.editor.statusHelp')}
                </span>
              </div>
            )}

            <div className="block">
              <label className="block">
                <span className="mb-1 block text-sm font-medium text-em-text-primary">
                  {t('manageShop.businessFaq.editor.priority')}
                </span>
                <input
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={1000}
                  value={priority}
                  onChange={(event) => setPriority(event.target.value)}
                  className={`${INPUT_CLASSES} ${FOCUS_RING}`}
                  aria-describedby="faq-editor-priority-help"
                />
              </label>
              <span id="faq-editor-priority-help" className="mt-1 block text-xs text-em-text-secondary">
                {t('manageShop.businessFaq.editor.priorityHelp')}
              </span>
            </div>
          </div>

          {/* Footer: dirty-gated save; sync truth lands on the row afterwards
              (02: the drawer closes at `pending`, never claims "live"). */}
          <div className="flex flex-col gap-2 border-t border-em-border p-5 sm:flex-row sm:justify-end">
            <EmButton variant="secondary" onClick={close} disabled={isSaving}>
              {t('common.cancel')}
            </EmButton>
            <EmButton
              variant="primary"
              onClick={() => void save()}
              disabled={!dirty || !canSubmit}
              loading={isSaving}
              className="gap-2"
            >
              {isSaving ? t('manageShop.faqs.saving') : t('manageShop.faqs.save')}
            </EmButton>
          </div>
        </motion.div>
      </div>
    </MotionConfig>
  );
}
