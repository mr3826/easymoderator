import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Edit2, ExternalLink, Lightbulb, MessageCircle, PenLine, Plus, RefreshCw, Send, Trash2, X } from "lucide-react";
import { motion, MotionConfig } from "motion/react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { apiClient } from "@/api";
import {
  dismissGapSuggestion,
  listGapSuggestions,
  publishGapSuggestion,
  reviewGapSuggestion,
} from "@/api/domains/knowledge";
import type { FAQ } from "@/api/types/knowledge";
import { GAP_SUGGESTION_SETTINGS_PATHS } from "@/api/types/knowledge";
import type { GapDismissReason, KnowledgeGapSuggestion } from "@/api/types/knowledge";
import { getErrorMessage } from "@shared/lib/http/errors";
import { fadeUp } from "@/lib/motion";
import { EmButton } from "./dashboard/EmButton";
import { PageHeader } from "./dashboard/PageHeader";
import { ResultBanner } from "./dashboard/ResultBanner";
import { useDialogFocus } from "./inbox/useDialogFocus";

const ANIMATE = import.meta.env.MODE !== "test";

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-em-focus-light focus-visible:transition-none";

const GAP_DISMISS_REASONS: GapDismissReason[] = [
  "NOT_USEFUL",
  "ALREADY_ANSWERED",
  "CONFIG_ONLY",
  "OUTDATED",
  "OTHER",
];

/** Action-side 409 (GAP_STATE_CONFLICT): the row moved on elsewhere — re-fetch, never claim success. */
function isGapStateConflict(error: unknown): boolean {
  const e = error as { statusCode?: number; code?: string; response?: { status?: number; data?: { error?: { code?: string } } } };
  const code = e?.code ?? e?.response?.data?.error?.code;
  const status = e?.statusCode ?? e?.response?.status;
  return code === "GAP_STATE_CONFLICT" || status === 409;
}

const createDraftFaq = (): FAQ => ({
  id: `draft-${Date.now()}`,
  question: "",
  answer: "",
  category: "General",
  confidence: 1,
  source: "manual",
  active: true,
  usageCount: 0,
  createdAt: "",
  updatedAt: "",
});

export default function FaqSettings() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [faqs, setFaqs] = useState<FAQ[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [busyFaqId, setBusyFaqId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editingFaq, setEditingFaq] = useState<FAQ | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<FAQ | null>(null);
  const [gapSuggestions, setGapSuggestions] = useState<KnowledgeGapSuggestion[] | null>(null);
  const [gapBusyId, setGapBusyId] = useState<string | null>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const deleteRef = useRef<HTMLDivElement>(null);
  useDialogFocus(editorRef, Boolean(editingFaq));
  useDialogFocus(deleteRef, Boolean(deleteTarget));

  const loadFaqs = async () => {
    try {
      setIsLoading(true);
      setLoadError(null);
      setFaqs(await apiClient.listKnowledgeFaqs());
    } catch (error: any) {
      setLoadError(getErrorMessage(error, t("manageShop.faqs.errors.load")));
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void loadFaqs();
  }, []);

  // P+05: single fetch on mount; FEATURE_DISABLED/409/404 (and any other load
  // failure) leave `gapSuggestions` null, so the section renders nothing.
  const loadGapSuggestions = async () => {
    try {
      const result = await listGapSuggestions();
      setGapSuggestions(result.featureDisabled ? null : result.data);
    } catch {
      setGapSuggestions(null);
    }
  };

  useEffect(() => {
    void loadGapSuggestions();
  }, []);

  const handleGapStartAuthoring = async (suggestion: KnowledgeGapSuggestion) => {
    if (suggestion.status !== "OPEN") return;
    try {
      await reviewGapSuggestion(suggestion.id);
      setGapSuggestions((current) =>
        current?.map((item) => (item.id === suggestion.id ? { ...item, status: "IN_REVIEW" as const } : item)) ?? current
      );
    } catch (error: unknown) {
      if (isGapStateConflict(error)) await loadGapSuggestions();
    }
  };

  const handleGapPublish = async (suggestion: KnowledgeGapSuggestion, question: string, answer: string) => {
    try {
      setGapBusyId(suggestion.id);
      await publishGapSuggestion(suggestion.id, { question: question.trim(), answer: answer.trim() });
      setGapSuggestions((current) => current?.filter((item) => item.id !== suggestion.id) ?? current);
      toast.success(t("faqSettings.gaps.published"));
    } catch (error: unknown) {
      if (isGapStateConflict(error)) {
        toast.error(t("faqSettings.gaps.refreshed"));
        await loadGapSuggestions();
      } else {
        toast.error(getErrorMessage(error, t("faqSettings.gaps.actionFailed")));
      }
    } finally {
      setGapBusyId(null);
    }
  };

  const handleGapDismiss = async (suggestion: KnowledgeGapSuggestion, reason: GapDismissReason) => {
    try {
      setGapBusyId(suggestion.id);
      await dismissGapSuggestion(suggestion.id, reason);
      setGapSuggestions((current) => current?.filter((item) => item.id !== suggestion.id) ?? current);
      toast.success(t("faqSettings.gaps.dismissed"));
    } catch (error: unknown) {
      if (isGapStateConflict(error)) {
        toast.error(t("faqSettings.gaps.refreshed"));
        await loadGapSuggestions();
      } else {
        toast.error(getErrorMessage(error, t("faqSettings.gaps.actionFailed")));
      }
    } finally {
      setGapBusyId(null);
    }
  };

  const openGapSettings = (path: string) => navigate(path);

  const stats = useMemo(() => {
    const active = faqs.filter((faq) => faq.active).length;
    const used = faqs.reduce((sum, faq) => sum + (faq.usageCount || 0), 0);
    return { active, total: faqs.length, used };
  }, [faqs]);

  const isExistingFaq = Boolean(editingFaq && faqs.some((faq) => faq.id === editingFaq.id));
  const canSave = Boolean(editingFaq?.question.trim() && editingFaq?.answer.trim());

  const handleToggleFaq = async (faq: FAQ) => {
    try {
      setBusyFaqId(faq.id);
      const updated = await apiClient.updateKnowledgeFaq(faq.id, { active: !faq.active });
      setFaqs((current) => current.map((item) => (item.id === faq.id ? updated : item)));
      toast.success(updated.active ? t("manageShop.faqs.activated") : t("manageShop.faqs.deactivated"));
    } catch (error: any) {
      toast.error(getErrorMessage(error, t("manageShop.faqs.errors.update")));
    } finally {
      setBusyFaqId(null);
    }
  };

  const handleDeleteFaq = async () => {
    if (!deleteTarget) return;
    const faq = deleteTarget;
    try {
      setBusyFaqId(faq.id);
      await apiClient.deleteKnowledgeFaq(faq.id);
      setFaqs((current) => current.filter((item) => item.id !== faq.id));
      setDeleteTarget(null);
      toast.success(t("manageShop.faqs.deleted"));
    } catch (error: any) {
      toast.error(getErrorMessage(error, t("manageShop.faqs.errors.delete")));
    } finally {
      setBusyFaqId(null);
    }
  };

  const handleSaveFaq = async () => {
    if (!editingFaq) return;
    if (!canSave) {
      toast.error(t("manageShop.faqs.validationError"));
      return;
    }

    // `faq_responses` has ONE text column and the API resolves it as
    // `category || question`. Sending a category therefore overwrote the
    // merchant's question with "General" — and that wrong text then reached the
    // RAG index and the AI prompt. Send the question only and let the server
    // fall through to it, exactly as the gap-publish flow already does.
    const payload = {
      question: editingFaq.question.trim(),
      answer: editingFaq.answer.trim(),
      active: editingFaq.active,
      confidence: editingFaq.confidence || 1,
      source: editingFaq.source || "manual",
      usageCount: editingFaq.usageCount || 0,
    };

    try {
      setIsSaving(true);
      if (isExistingFaq) {
        const updated = await apiClient.updateKnowledgeFaq(editingFaq.id, payload);
        setFaqs((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      } else {
        const created = await apiClient.createKnowledgeFaq(payload);
        setFaqs((current) => [created, ...current]);
      }
      setEditingFaq(null);
      toast.success(t("manageShop.faqs.saved"));
    } catch (error: any) {
      toast.error(getErrorMessage(error, t("manageShop.faqs.errors.save")));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <MotionConfig reducedMotion="user">
      <div className="em-faqs min-h-full p-4 md:p-6">
        <div className="mx-auto w-full max-w-[1440px] space-y-6">
          {/* Header-removal C1 (legacy page): signal band, shop-name breadcrumb
              and metric pills retired — the gap-suggestions card below still
              carries the open-gap truth, and the toolbar keeps the primary. */}
          <PageHeader title={t("manageShop.faqs.title")} titleMode="srOnly" />

          {gapSuggestions && gapSuggestions.length > 0 && (
            <motion.section
              variants={fadeUp}
              initial={ANIMATE ? "hidden" : false}
              animate="visible"
              className="rounded-xl border border-em-sunlight-600/30 bg-em-bg-surface"
              data-testid="gap-suggestions"
            >
              <div className="flex items-start gap-3 border-b border-em-border p-4">
                <div className="rounded-lg bg-em-sunlight-100 p-2 text-em-sunlight-700">
                  <Lightbulb className="h-5 w-5" aria-hidden="true" />
                </div>
                <div className="min-w-0">
                  <h3 className="font-semibold text-em-text-primary">{t("faqSettings.gaps.title")}</h3>
                  <p className="text-sm text-em-text-secondary">{t("faqSettings.gaps.subtitle")}</p>
                </div>
              </div>
              <div className="divide-y divide-em-border">
                {gapSuggestions.map((suggestion) => (
                  <GapSuggestionCard
                    key={suggestion.id}
                    suggestion={suggestion}
                    busy={gapBusyId === suggestion.id}
                    onAuthor={() => handleGapStartAuthoring(suggestion)}
                    onPublish={(question, answer) => handleGapPublish(suggestion, question, answer)}
                    onDismiss={(reason) => handleGapDismiss(suggestion, reason)}
                    onOpenSettings={openGapSettings}
                  />
                ))}
              </div>
            </motion.section>
          )}

          <motion.section
            variants={fadeUp}
            initial={ANIMATE ? "hidden" : false}
            animate="visible"
            className="rounded-xl border border-em-border bg-em-bg-surface"
          >
            <div className="flex flex-col gap-3 border-b border-em-border p-4 md:flex-row md:items-center md:justify-between">
              <div>
                <h3 className="font-semibold text-em-text-primary">{t("manageShop.faqs.manageTitle")}</h3>
                <p className="em-tabular text-sm text-em-text-secondary">
                  {t("manageShop.faqs.faqCount", { active: stats.active, total: stats.total })}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <EmButton
                  variant="secondary"
                  onClick={() => void loadFaqs()}
                  disabled={isLoading}
                  className="gap-2"
                >
                  <RefreshCw className={`h-4 w-4 ${isLoading ? "animate-spin" : ""}`} aria-hidden="true" />
                  {t("manageShop.faqs.refresh")}
                </EmButton>
                {!loadError && faqs.length > 0 && (
                  <EmButton
                    variant="primary"
                    onClick={() => setEditingFaq(createDraftFaq())}
                    className="gap-2"
                    data-testid="faq-add"
                  >
                    <Plus className="h-4 w-4" aria-hidden="true" />
                    {t("manageShop.faqs.addFaq")}
                  </EmButton>
                )}
              </div>
            </div>

            {loadError && (
              <ResultBanner
                className="m-4"
                status="error"
                title={t("manageShop.faqs.errors.load")}
                description={loadError}
                nextAction={{ label: t("manageShop.faqs.refresh"), onClick: () => void loadFaqs() }}
              />
            )}

            {isLoading ? (
              <div className="space-y-3 p-4" aria-label={t("manageShop.faqs.loading")}>
                {[0, 1, 2].map((row) => (
                  <div key={row} className="animate-pulse space-y-2 rounded-xl border border-em-border bg-em-bg-muted/60 p-4">
                    <div className="h-4 w-2/3 rounded bg-em-border" />
                    <div className="h-3 w-full rounded bg-em-border" />
                    <div className="h-3 w-1/3 rounded bg-em-border" />
                  </div>
                ))}
              </div>
            ) : faqs.length === 0 ? (
              <div className="px-4 py-12 text-center">
                <MessageCircle className="mx-auto mb-3 h-12 w-12 text-em-border-strong" aria-hidden="true" />
                <h4 className="text-base font-semibold text-em-text-primary">{t("manageShop.faqs.emptyTitle")}</h4>
                <p className="mx-auto mt-1 max-w-md text-sm text-em-text-secondary">{t("manageShop.faqs.emptyDescription")}</p>
                {!loadError && (
                  <EmButton
                    variant="primary"
                    onClick={() => setEditingFaq(createDraftFaq())}
                    className="mt-4 gap-2"
                    data-testid="faq-add"
                  >
                    <Plus className="h-4 w-4" aria-hidden="true" />
                    {t("manageShop.faqs.addFaq")}
                  </EmButton>
                )}
              </div>
            ) : (
              <div className="divide-y divide-em-border">
                {faqs.map((faq) => {
                  const isBusy = busyFaqId === faq.id;
                  return (
                    <article key={faq.id} className="p-4">
                      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                        <div className="min-w-0 flex-1">
                          <div className="mb-2 flex flex-wrap items-center gap-2">
                            <h4 className="text-sm font-semibold text-em-text-primary md:text-base">{faq.question}</h4>
                            <span
                              className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                                faq.active ? "bg-em-success-100 text-em-success-700" : "bg-em-bg-muted text-em-text-secondary"
                              }`}
                            >
                              {faq.active ? t("manageShop.faqs.status.active") : t("manageShop.faqs.status.inactive")}
                            </span>
                            {/* No category pill: the API returns category and
                                question as the same value, so it only duplicated
                                the heading above. */}
                          </div>
                          <p className="text-sm leading-6 text-em-text-primary">{faq.answer}</p>
                          <div className="em-tabular mt-2 flex flex-wrap gap-3 text-xs text-em-text-secondary">
                            <span>{t("manageShop.faqs.source", { source: faq.source })}</span>
                            <span>{t("manageShop.faqs.usedTimes", { count: faq.usageCount || 0 })}</span>
                            <span>{t("manageShop.faqs.confidence", { percent: Math.round((faq.confidence || 1) * 100) })}</span>
                          </div>
                        </div>
                        <div className="flex shrink-0 flex-wrap gap-2 md:justify-end">
                          <EmButton
                            variant="secondary"
                            onClick={() => void handleToggleFaq(faq)}
                            disabled={isBusy}
                            loading={isBusy}
                            className="px-3 text-xs"
                          >
                            {faq.active ? t("manageShop.faqs.deactivate") : t("manageShop.faqs.activate")}
                          </EmButton>
                          <button
                            type="button"
                            onClick={() => setEditingFaq(faq)}
                            className={`inline-flex h-11 w-11 items-center justify-center rounded-lg text-em-text-secondary hover:bg-em-violet-50 hover:text-em-violet-700 ${FOCUS_RING}`}
                            title={t("manageShop.faqs.edit")}
                            aria-label={t("manageShop.faqs.edit")}
                          >
                            <Edit2 className="h-4 w-4" aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            onClick={() => setDeleteTarget(faq)}
                            disabled={isBusy}
                            className={`inline-flex h-11 w-11 items-center justify-center rounded-lg text-em-text-secondary hover:bg-em-danger-100 hover:text-em-danger-700 disabled:opacity-60 ${FOCUS_RING}`}
                            title={t("manageShop.faqs.delete")}
                            aria-label={t("manageShop.faqs.delete")}
                          >
                            <Trash2 className="h-4 w-4" aria-hidden="true" />
                          </button>
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </motion.section>
        </div>

        {editingFaq && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-em-midnight-950/60 p-4"
            onClick={(event) => {
              if (event.target === event.currentTarget) setEditingFaq(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") setEditingFaq(null);
            }}
          >
            <div
              ref={editorRef}
              role="dialog"
              aria-modal="true"
              aria-labelledby="faq-editor-title"
              className="w-full max-w-2xl rounded-xl bg-em-bg-surface p-5 shadow-xl md:p-6"
            >
              <h3 id="faq-editor-title" className="mb-5 text-xl font-semibold text-em-text-primary">
                {isExistingFaq ? t("manageShop.faqs.modal.editTitle") : t("manageShop.faqs.modal.addTitle")}
              </h3>

              <div className="space-y-4">
                <label className="block">
                  <span className="mb-2 block text-sm font-medium text-em-text-primary">
                    {t("manageShop.faqs.modal.questionLabel")}
                  </span>
                  <input
                    type="text"
                    value={editingFaq.question}
                    onChange={(event) => setEditingFaq({ ...editingFaq, question: event.target.value })}
                    className={`min-h-11 w-full rounded-lg border border-em-border-strong bg-em-bg-surface px-4 py-2 text-sm text-em-text-primary focus:outline-none ${FOCUS_RING}`}
                    placeholder={t("manageShop.faqs.modal.questionPlaceholder")}
                  />
                </label>
                <label className="block">
                  <span className="mb-2 block text-sm font-medium text-em-text-primary">
                    {t("manageShop.faqs.modal.answerLabel")}
                  </span>
                  <textarea
                    value={editingFaq.answer}
                    onChange={(event) => setEditingFaq({ ...editingFaq, answer: event.target.value })}
                    rows={5}
                    className={`w-full rounded-lg border border-em-border-strong bg-em-bg-surface px-4 py-2 text-sm text-em-text-primary focus:outline-none ${FOCUS_RING}`}
                    placeholder={t("manageShop.faqs.modal.answerPlaceholder")}
                  />
                </label>
                {/* The separate Category input was removed: the API stores the
                    question and the category in the SAME column, so offering two
                    fields for one value was the defect. Real categories need a
                    schema change, not a second input. */}
              </div>

              <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-end">
                <EmButton variant="secondary" onClick={() => setEditingFaq(null)}>
                  {t("common.cancel")}
                </EmButton>
                <EmButton
                  variant="primary"
                  onClick={() => void handleSaveFaq()}
                  disabled={isSaving || !canSave}
                  loading={isSaving}
                  className="gap-2"
                >
                  {isSaving ? t("manageShop.faqs.saving") : t("manageShop.faqs.save")}
                </EmButton>
              </div>
            </div>
          </div>
        )}

        {deleteTarget && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-em-midnight-950/60 p-4"
            onClick={(event) => {
              if (event.target === event.currentTarget) setDeleteTarget(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") setDeleteTarget(null);
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
                {t("faqSettings.confirmTitle")}
              </h3>
              <p className="mt-2 text-sm text-em-text-secondary">{t("manageShop.faqs.confirmDelete")}</p>
              <p className="mt-2 truncate text-sm font-semibold text-em-text-primary">{deleteTarget.question}</p>
              <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:justify-end">
                <EmButton variant="secondary" onClick={() => setDeleteTarget(null)}>
                  {t("common.cancel")}
                </EmButton>
                <EmButton
                  variant="danger"
                  onClick={() => void handleDeleteFaq()}
                  disabled={busyFaqId === deleteTarget.id}
                  loading={busyFaqId === deleteTarget.id}
                  data-testid="faq-delete-confirm"
                >
                  {t("manageShop.faqs.delete")}
                </EmButton>
              </div>
            </div>
          </div>
        )}
      </div>
    </MotionConfig>
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
  const [answer, setAnswer] = useState("");
  const [reason, setReason] = useState<GapDismissReason>("NOT_USEFUL");

  const settingsPath = GAP_SUGGESTION_SETTINGS_PATHS[suggestion.authoritative_action];
  const canPublish = Boolean(question.trim() && answer.trim());

  return (
    <article data-testid={`gap-suggestion-${suggestion.id}`} className="p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="basis-full min-w-0 text-sm font-semibold text-em-text-primary md:basis-auto md:text-base">
          {suggestion.display_question}
        </h4>
        <span className="em-tabular rounded-full bg-em-sunlight-100 px-2.5 py-1 text-xs font-semibold text-em-sunlight-700">
          {t("faqSettings.gaps.askedTimes", { count: suggestion.evidence_count })}
        </span>
        <span className="rounded-full bg-em-violet-50 px-2.5 py-1 text-xs font-semibold text-em-violet-700">
          {t(`faqSettings.gaps.domain.${suggestion.owner_domain}`)}
        </span>
        {suggestion.status === "IN_REVIEW" && (
          <span className="rounded-full bg-em-midnight-100 px-2.5 py-1 text-xs font-medium text-em-midnight-700">
            {t("faqSettings.gaps.status.IN_REVIEW")}
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
            {t("faqSettings.gaps.openSettings")}
          </EmButton>
        ) : (
          <EmButton
            variant={authoring ? "secondary" : "primary"}
            onClick={() => {
              if (!authoring) void onAuthor();
              setAuthoring((open) => !open);
            }}
            aria-expanded={authoring}
            disabled={busy}
            className="gap-2"
          >
            <PenLine className="h-4 w-4" aria-hidden="true" />
            {t("faqSettings.gaps.writeAnswer")}
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
          {t("faqSettings.gaps.dismiss")}
        </EmButton>
      </div>

      {authoring && !settingsPath && (
        <div className="mt-3 space-y-3 rounded-xl border border-em-border bg-em-bg-muted p-3">
          <label className="block text-sm text-em-text-primary">
            <span className="mb-1 block font-medium">{t("faqSettings.gaps.questionLabel")}</span>
            <input
              type="text"
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              className={`min-h-11 w-full rounded-lg border border-em-border-strong bg-em-bg-surface px-3 py-2 text-sm text-em-text-primary focus:outline-none ${FOCUS_RING}`}
            />
          </label>
          <label className="block text-sm text-em-text-primary">
            <span className="mb-1 block font-medium">{t("faqSettings.gaps.answerLabel")}</span>
            <textarea
              value={answer}
              onChange={(event) => setAnswer(event.target.value)}
              rows={4}
              placeholder={t("faqSettings.gaps.answerPlaceholder")}
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
            {t("faqSettings.gaps.publish")}
          </EmButton>
        </div>
      )}

      {dismissOpen && (
        <div className="mt-3 flex flex-col gap-2 rounded-xl border border-em-border bg-em-bg-muted p-3 sm:flex-row sm:items-end">
          <label className="flex-1 text-sm text-em-text-primary">
            <span className="mb-1 block font-medium">{t("faqSettings.gaps.dismissTitle")}</span>
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
            {t("faqSettings.gaps.dismissConfirm")}
          </EmButton>
        </div>
      )}
    </article>
  );
}
