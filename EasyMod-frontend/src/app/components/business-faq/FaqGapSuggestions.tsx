/**
 * Gap-suggestions section (F15 — KEPT UNTOUCHED). Behavior is copied verbatim
 * from the legacy FaqSettings: single fetch on mount, FEATURE_DISABLED / 404 /
 * 409 render NOTHING, one authoritative next step per domain (Product/Payment/
 * Delivery deep-links; Policy/Other author inline), merchant-authored publish
 * through the existing FAQ authority, dismiss reasons, and 409
 * GAP_STATE_CONFLICT → refetch + "refreshed" error toast, NEVER a success
 * claim. Chat Settings, AI modes and the gap ops themselves are frozen scope —
 * this file only relocates the existing section into the FAQ tab panel.
 *
 * The gap clients are imported DIRECTLY from `@/api/domains/knowledge` (the
 * existing pin per 03 §1), not through the apiClient facade.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { ExternalLink, Lightbulb, PenLine, Send, X } from 'lucide-react';
import { motion } from 'motion/react';
import { toast } from 'sonner';
import {
  dismissGapSuggestion,
  listGapSuggestions,
  publishGapSuggestion,
  reviewGapSuggestion,
} from '@/api/domains/knowledge';
import { GAP_SUGGESTION_SETTINGS_PATHS } from '@/api/types/knowledge';
import type { GapDismissReason, KnowledgeGapSuggestion } from '@/api/types/knowledge';
import { getErrorMessage } from '@shared/lib/http/errors';
import { fadeUp } from '@/lib/motion';
import { EmButton } from '../dashboard/EmButton';

const ANIMATE = import.meta.env.MODE !== 'test';

const FOCUS_RING =
  'focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-em-focus-light focus-visible:transition-none';

const GAP_DISMISS_REASONS: GapDismissReason[] = [
  'NOT_USEFUL',
  'ALREADY_ANSWERED',
  'CONFIG_ONLY',
  'OUTDATED',
  'OTHER',
];

function isGapStateConflict(error: unknown): boolean {
  const e = error as { statusCode?: number; code?: string; response?: { status?: number; data?: { error?: { code?: string } } } };
  const code = e?.code ?? e?.response?.data?.error?.code;
  const status = e?.statusCode ?? e?.response?.status;
  return code === 'GAP_STATE_CONFLICT' || status === 409;
}

interface FaqGapSuggestionsProps {
  /** Reports the OPEN count up so the tab header signal stays truthful (F1). */
  onOpenCountChange?: (count: number) => void;
}

export default function FaqGapSuggestions({ onOpenCountChange }: FaqGapSuggestionsProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [suggestions, setSuggestions] = useState<KnowledgeGapSuggestion[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = async () => {
    try {
      const result = await listGapSuggestions();
      setSuggestions(result.featureDisabled ? null : result.data);
    } catch {
      setSuggestions(null);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    const open = (suggestions ?? []).filter((s) => s.status === 'OPEN').length;
    onOpenCountChange?.(open);
  }, [suggestions, onOpenCountChange]);

  const handleAuthor = async (suggestion: KnowledgeGapSuggestion) => {
    if (suggestion.status !== 'OPEN') return;
    try {
      await reviewGapSuggestion(suggestion.id);
      setSuggestions((current) =>
        current?.map((item) => (item.id === suggestion.id ? { ...item, status: 'IN_REVIEW' as const } : item)) ?? current,
      );
    } catch (error: unknown) {
      if (isGapStateConflict(error)) await load();
    }
  };

  const handlePublish = async (suggestion: KnowledgeGapSuggestion, question: string, answer: string) => {
    try {
      setBusyId(suggestion.id);
      await publishGapSuggestion(suggestion.id, { question: question.trim(), answer: answer.trim() });
      setSuggestions((current) => current?.filter((item) => item.id !== suggestion.id) ?? current);
      toast.success(t('faqSettings.gaps.published'));
    } catch (error: unknown) {
      if (isGapStateConflict(error)) {
        toast.error(t('faqSettings.gaps.refreshed'));
        await load();
      } else {
        toast.error(getErrorMessage(error, t('faqSettings.gaps.actionFailed')));
      }
    } finally {
      setBusyId(null);
    }
  };

  const handleDismiss = async (suggestion: KnowledgeGapSuggestion, reason: GapDismissReason) => {
    try {
      setBusyId(suggestion.id);
      await dismissGapSuggestion(suggestion.id, reason);
      setSuggestions((current) => current?.filter((item) => item.id !== suggestion.id) ?? current);
      toast.success(t('faqSettings.gaps.dismissed'));
    } catch (error: unknown) {
      if (isGapStateConflict(error)) {
        toast.error(t('faqSettings.gaps.refreshed'));
        await load();
      } else {
        toast.error(getErrorMessage(error, t('faqSettings.gaps.actionFailed')));
      }
    } finally {
      setBusyId(null);
    }
  };

  if (!suggestions || suggestions.length === 0) return null;

  return (
    <motion.section
      variants={fadeUp}
      initial={ANIMATE ? 'hidden' : false}
      animate="visible"
      className="rounded-xl border border-em-sunlight-600/30 bg-em-bg-surface"
      data-testid="gap-suggestions"
    >
      <div className="flex items-start gap-3 border-b border-em-border p-4">
        <div className="rounded-lg bg-em-sunlight-100 p-2 text-em-sunlight-700">
          <Lightbulb className="h-5 w-5" aria-hidden="true" />
        </div>
        <div className="min-w-0">
          <h3 className="font-semibold text-em-text-primary">{t('faqSettings.gaps.title')}</h3>
          <p className="text-sm text-em-text-secondary">{t('faqSettings.gaps.subtitle')}</p>
        </div>
      </div>
      <div className="divide-y divide-em-border">
        {suggestions.map((suggestion) => (
          <GapSuggestionCard
            key={suggestion.id}
            suggestion={suggestion}
            busy={busyId === suggestion.id}
            onAuthor={() => handleAuthor(suggestion)}
            onPublish={(question, answer) => handlePublish(suggestion, question, answer)}
            onDismiss={(reason) => handleDismiss(suggestion, reason)}
            onOpenSettings={(path) => navigate(path)}
          />
        ))}
      </div>
    </motion.section>
  );
}

interface GapSuggestionCardProps {
  suggestion: KnowledgeGapSuggestion;
  busy: boolean;
  onAuthor: () => void | Promise<void>;
  onPublish: (question: string, answer: string) => void | Promise<void>;
  onDismiss: (reason: GapDismissReason) => void | Promise<void>;
  onOpenSettings: (path: string) => void;
}

/**
 * P+05 compact action card: the question customers keep asking, how often it
 * was asked, and the ONE authoritative next step for its domain — either
 * navigate to the settings page that already answers it, or author the FAQ
 * answer inline. Nothing here is AI-generated; the merchant writes everything.
 */
function GapSuggestionCard({ suggestion, busy, onAuthor, onPublish, onDismiss, onOpenSettings }: GapSuggestionCardProps) {
  const { t } = useTranslation();
  const [authoring, setAuthoring] = useState(false);
  const [dismissOpen, setDismissOpen] = useState(false);
  const [question, setQuestion] = useState(suggestion.display_question);
  const [answer, setAnswer] = useState('');
  const [reason, setReason] = useState<GapDismissReason>('NOT_USEFUL');

  const settingsPath = GAP_SUGGESTION_SETTINGS_PATHS[suggestion.authoritative_action];
  const canPublish = Boolean(question.trim() && answer.trim());

  return (
    <article data-testid={`gap-suggestion-${suggestion.id}`} className="p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="basis-full min-w-0 text-sm font-semibold text-em-text-primary md:basis-auto md:text-base">
          {suggestion.display_question}
        </h4>
        <span className="em-tabular rounded-full bg-em-sunlight-100 px-2.5 py-1 text-xs font-semibold text-em-sunlight-700">
          {t('faqSettings.gaps.askedTimes', { count: suggestion.evidence_count })}
        </span>
        <span className="rounded-full bg-em-violet-50 px-2.5 py-1 text-xs font-semibold text-em-violet-700">
          {t(`faqSettings.gaps.domain.${suggestion.owner_domain}`)}
        </span>
        {suggestion.status === 'IN_REVIEW' && (
          <span className="rounded-full bg-em-midnight-100 px-2.5 py-1 text-xs font-medium text-em-midnight-700">
            {t('faqSettings.gaps.status.IN_REVIEW')}
          </span>
        )}
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {settingsPath ? (
          <EmButton
            variant="primary"
            data-testid="gap-open-settings"
            onClick={() => onOpenSettings(settingsPath)}
            className="gap-2"
          >
            <ExternalLink className="h-4 w-4" aria-hidden="true" />
            {t('faqSettings.gaps.openSettings')}
          </EmButton>
        ) : (
          <EmButton
            variant={authoring ? 'secondary' : 'primary'}
            onClick={() => {
              if (!authoring) void onAuthor();
              setAuthoring((open) => !open);
            }}
            aria-expanded={authoring}
            disabled={busy}
            className="gap-2"
          >
            <PenLine className="h-4 w-4" aria-hidden="true" />
            {t('faqSettings.gaps.writeAnswer')}
          </EmButton>
        )}
        <EmButton
          variant="secondary"
          onClick={() => setDismissOpen((open) => !open)}
          aria-expanded={dismissOpen}
          disabled={busy}
          className="gap-2"
        >
          <X className="h-4 w-4" aria-hidden="true" />
          {t('faqSettings.gaps.dismiss')}
        </EmButton>
      </div>

      {authoring && !settingsPath && (
        <div className="mt-3 space-y-3 rounded-xl border border-em-border bg-em-bg-muted p-3">
          <label className="block text-sm text-em-text-primary">
            <span className="mb-1 block font-medium">{t('faqSettings.gaps.questionLabel')}</span>
            <input
              type="text"
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              className={`min-h-11 w-full rounded-lg border border-em-border-strong bg-em-bg-surface px-3 py-2 text-sm text-em-text-primary focus:outline-none ${FOCUS_RING}`}
            />
          </label>
          <label className="block text-sm text-em-text-primary">
            <span className="mb-1 block font-medium">{t('faqSettings.gaps.answerLabel')}</span>
            <textarea
              value={answer}
              onChange={(event) => setAnswer(event.target.value)}
              rows={4}
              placeholder={t('faqSettings.gaps.answerPlaceholder')}
              className={`w-full rounded-lg border border-em-border-strong bg-em-bg-surface px-3 py-2 text-sm text-em-text-primary focus:outline-none ${FOCUS_RING}`}
            />
          </label>
          <EmButton
            variant="primary"
            data-testid="gap-publish"
            onClick={() => void onPublish(question, answer)}
            disabled={busy || !canPublish}
            loading={busy}
            className="w-full gap-2 sm:w-auto"
          >
            <Send className="h-4 w-4" aria-hidden="true" />
            {t('faqSettings.gaps.publish')}
          </EmButton>
        </div>
      )}

      {dismissOpen && (
        <div className="mt-3 flex flex-col gap-2 rounded-xl border border-em-border bg-em-bg-muted p-3 sm:flex-row sm:items-end">
          <label className="flex-1 text-sm text-em-text-primary">
            <span className="mb-1 block font-medium">{t('faqSettings.gaps.dismissTitle')}</span>
            <select
              value={reason}
              onChange={(event) => setReason(event.target.value as GapDismissReason)}
              className={`min-h-11 w-full rounded-lg border border-em-border-strong bg-em-bg-surface px-3 text-sm text-em-text-primary ${FOCUS_RING}`}
            >
              {GAP_DISMISS_REASONS.map((code) => (
                <option key={code} value={code}>
                  {t(`faqSettings.gaps.dismissReasons.${code}`)}
                </option>
              ))}
            </select>
          </label>
          <EmButton
            variant="danger"
            data-testid="gap-dismiss-confirm"
            onClick={() => void onDismiss(reason)}
            disabled={busy}
            loading={busy}
          >
            {t('faqSettings.gaps.dismissConfirm')}
          </EmButton>
        </div>
      )}
    </article>
  );
}
