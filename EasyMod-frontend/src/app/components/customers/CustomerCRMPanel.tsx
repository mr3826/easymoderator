import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Trash2 } from "lucide-react";
import {
  createCustomerNote,
  deleteCustomerNote,
  listCustomerNotes,
  listCustomerTags,
  listTagVocabulary,
  setCustomerTags,
} from "@/api/domains/customer-crm";
import type { CustomerNote, CustomerTag } from "@/api/types/crm";
import { authService } from "@/app/lib/auth";
import { getErrorMessage } from "@/shared/lib/http/errors";
import { EmButton } from "../dashboard/EmButton";

type LoadState<T> = { status: "loading" | "ready" | "error"; data: T };

export default function CustomerCRMPanel({ customerId }: { customerId: string }) {
  const { t } = useTranslation();
  const [notes, setNotes] = useState<LoadState<CustomerNote[]>>({ status: "loading", data: [] });
  const [tags, setTags] = useState<LoadState<CustomerTag[]>>({ status: "loading", data: [] });
  const [vocabulary, setVocabulary] = useState<CustomerTag[]>([]);
  const [vocabularyState, setVocabularyState] = useState<"loading" | "ready" | "error">("loading");
  const vocabularyRequestRef = useRef(0);
  const [noteDraft, setNoteDraft] = useState("");
  const [noteOpen, setNoteOpen] = useState(false);
  const [tagEditorOpen, setTagEditorOpen] = useState(false);
  const [draftTagIds, setDraftTagIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const authState = authService.getState();
  const myUserId = authState.user?.id ?? null;
  const privileged = ["owner", "admin"].includes(String(authState.currentShop?.role ?? "").toLowerCase());

  const reloadNotes = useCallback(async () => {
    setNotes((current) => ({ ...current, status: "loading" }));
    try {
      const result = await listCustomerNotes(customerId);
      setNotes({ status: "ready", data: result.data ?? [] });
    } catch {
      setNotes({ status: "error", data: [] });
    }
  }, [customerId]);

  const reloadTags = useCallback(async () => {
    setTags((current) => ({ ...current, status: "loading" }));
    try {
      const result = await listCustomerTags(customerId);
      setTags({ status: "ready", data: result.data ?? [] });
    } catch {
      setTags({ status: "error", data: [] });
    }
  }, [customerId]);

  const reloadVocabulary = useCallback(async () => {
    const request = ++vocabularyRequestRef.current;
    setVocabularyState("loading");
    try {
      const result = await listTagVocabulary();
      if (request !== vocabularyRequestRef.current) return;
      setVocabulary(result.data ?? []);
      setVocabularyState("ready");
    } catch {
      if (request !== vocabularyRequestRef.current) return;
      setVocabulary([]);
      setVocabularyState("error");
    }
  }, []);

  useEffect(() => {
    let stale = false;
    setNotes({ status: "loading", data: [] });
    setTags({ status: "loading", data: [] });
    setError(null);
    setVocabulary([]);
    setVocabularyState("loading");
    void listCustomerNotes(customerId)
      .then((result) => { if (!stale) setNotes({ status: "ready", data: result.data ?? [] }); })
      .catch(() => { if (!stale) setNotes({ status: "error", data: [] }); });
    void listCustomerTags(customerId)
      .then((result) => { if (!stale) setTags({ status: "ready", data: result.data ?? [] }); })
      .catch(() => { if (!stale) setTags({ status: "error", data: [] }); });
    void reloadVocabulary();
    return () => {
      stale = true;
      vocabularyRequestRef.current += 1;
    };
  }, [customerId, reloadVocabulary]);

  const saveNote = async () => {
    const body = noteDraft.trim();
    if (!body || busy) return;
    setBusy(true);
    setError(null);
    try {
      await createCustomerNote(customerId, body);
      setNoteDraft("");
      setNoteOpen(false);
      await reloadNotes();
    } catch (cause) {
      setError(getErrorMessage(cause, t("inbox.context.crmFailed")));
    } finally {
      setBusy(false);
    }
  };

  const removeNote = async (noteId: string) => {
    setBusy(true);
    setError(null);
    try {
      await deleteCustomerNote(customerId, noteId);
      await reloadNotes();
    } catch (cause) {
      setError(getErrorMessage(cause, t("inbox.context.crmFailed")));
    } finally {
      setBusy(false);
    }
  };

  const toggleTagEditor = () => {
    if (tagEditorOpen) {
      setTagEditorOpen(false);
      return;
    }
    setDraftTagIds(tags.data.map((tag) => tag.id));
    setTagEditorOpen(true);
    if (vocabularyState === "error") void reloadVocabulary();
  };

  const saveTags = async () => {
    setBusy(true);
    setError(null);
    try {
      await setCustomerTags(customerId, draftTagIds);
      setTagEditorOpen(false);
      await reloadTags();
    } catch (cause) {
      setError(getErrorMessage(cause, t("inbox.context.crmFailed")));
    } finally {
      setBusy(false);
    }
  };

  const loadMessage = t("customer360.retry");

  return (
    <section className="rounded-2xl border border-em-border bg-em-bg-surface p-4 shadow-sm md:p-5" data-testid="customer-crm">
      <h2 className="mb-4 text-base font-semibold text-em-text-primary">{t("customer360.crm.title", { defaultValue: "Customer notes and tags" })}</h2>

      <section aria-labelledby="customer-notes-heading" className="border-b border-em-border pb-4">
        <div className="mb-2 flex items-center justify-between gap-3">
          <h3 id="customer-notes-heading" className="text-sm font-semibold text-em-text-primary">{t("inbox.context.notes")}</h3>
          <button type="button" onClick={() => setNoteOpen((open) => !open)} aria-expanded={noteOpen} data-testid="customer-note-toggle" className="min-h-11 rounded-lg px-4 text-sm font-semibold text-em-violet-700 hover:bg-em-violet-50 focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-em-focus-light">
            {t("inbox.context.notesAdd")}
          </button>
        </div>
        {noteOpen && (
          <div className="mb-3 space-y-2">
            <label htmlFor="customer-note-draft" className="sr-only">{t("inbox.context.notes")}</label>
            <textarea
              id="customer-note-draft"
              value={noteDraft}
              onChange={(event) => setNoteDraft(event.target.value)}
              maxLength={4000}
              rows={3}
              className="min-h-24 w-full resize-y rounded-lg border border-em-border-input bg-em-bg-surface p-3 text-sm text-em-text-primary focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-em-focus-light"
            />
            <EmButton variant="primary" onClick={() => void saveNote()} disabled={!noteDraft.trim() || busy} loading={busy}>
              {t("inbox.context.notesAdd")}
            </EmButton>
          </div>
        )}
        {notes.status === "loading" && <p role="status" className="text-sm text-em-text-secondary">{t("customer360.loading")}</p>}
        {notes.status === "error" && (
          <div className="flex items-center gap-3 text-sm text-em-danger-700" role="alert">
            <span>{t("inbox.context.crmFailed")}</span>
            <EmButton variant="ghost" onClick={() => void reloadNotes()}>{loadMessage}</EmButton>
          </div>
        )}
        {notes.status === "ready" && notes.data.length === 0 && <p className="text-sm text-em-text-secondary">{t("inbox.context.notesEmpty")}</p>}
        {notes.status === "ready" && notes.data.length > 0 && (
          <ul className="space-y-2">
            {notes.data.map((note) => {
              const mayDelete = privileged || Boolean(myUserId && note.author_id === myUserId);
              return (
                <li key={note.id} className="flex items-start justify-between gap-3 rounded-lg bg-em-bg-muted p-3">
                  <div className="min-w-0">
                    <p className="whitespace-pre-wrap break-words text-sm text-em-text-primary">{note.body}</p>
                    <p className="mt-1 text-xs text-em-text-secondary">{note.author_name || "-"}{note.created_at ? ` | ${new Date(note.created_at).toLocaleString()}` : ""}</p>
                  </div>
                  {mayDelete && (
                    <button
                      type="button"
                      onClick={() => void removeNote(note.id)}
                      disabled={busy}
                      aria-label={t("inbox.context.noteDelete")}
                      className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-lg text-em-text-secondary hover:bg-em-danger-100 hover:text-em-danger-700 focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-em-focus-light disabled:opacity-50"
                    >
                      <Trash2 className="h-4 w-4" aria-hidden="true" />
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section aria-labelledby="customer-tags-heading" className="pt-4">
        <div className="mb-2 flex items-center justify-between gap-3">
          <h3 id="customer-tags-heading" className="text-sm font-semibold text-em-text-primary">{t("inbox.context.tags")}</h3>
          <button type="button" onClick={() => void toggleTagEditor()} aria-expanded={tagEditorOpen} data-testid="customer-tag-toggle" className="min-h-11 rounded-lg px-4 text-sm font-semibold text-em-violet-700 hover:bg-em-violet-50 focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-em-focus-light">
            {t("inbox.context.tagsEdit")}
          </button>
        </div>
        {tags.status === "loading" && <p role="status" className="text-sm text-em-text-secondary">{t("customer360.loading")}</p>}
        {tags.status === "error" && (
          <div className="flex items-center gap-3 text-sm text-em-danger-700" role="alert">
            <span>{t("inbox.context.crmFailed")}</span>
            <EmButton variant="ghost" onClick={() => void reloadTags()}>{loadMessage}</EmButton>
          </div>
        )}
        {tags.status === "ready" && tags.data.length === 0 && !tagEditorOpen && <p className="text-sm text-em-text-secondary">{t("inbox.context.tagsEmpty")}</p>}
        {tags.status === "ready" && tags.data.length > 0 && !tagEditorOpen && (
          <ul className="flex flex-wrap gap-2">
            {tags.data.map((tag) => <li key={tag.id} className="rounded-full border border-em-border bg-em-bg-muted px-3 py-1 text-xs text-em-text-primary">{tag.name}</li>)}
          </ul>
        )}
        {tagEditorOpen && (
          <div className="space-y-2" data-testid="customer-tag-editor">
            {vocabularyState === "loading" && <p role="status" className="text-sm text-em-text-secondary">{t("customer360.loading")}</p>}
            {vocabularyState === "error" && (
              <div role="alert" className="flex items-center gap-3 text-sm text-em-danger-700">
                <span>{t("inbox.context.crmFailed")}</span>
                <EmButton variant="ghost" onClick={() => void reloadVocabulary()}>{loadMessage}</EmButton>
              </div>
            )}
            {vocabularyState === "ready" && !vocabulary.length && <p className="text-sm text-em-text-secondary">{t("inbox.context.tagsNoVocabulary")}</p>}
            {vocabulary.map((tag) => (
              <label key={tag.id} className="flex min-h-11 items-center gap-2 text-sm text-em-text-primary">
                <input
                  type="checkbox"
                  checked={draftTagIds.includes(tag.id)}
                  onChange={(event) => setDraftTagIds((current) => event.target.checked
                    ? [...current, tag.id]
                    : current.filter((id) => id !== tag.id))}
                  className="h-4 w-4 accent-em-violet-600"
                />
                {tag.name}
              </label>
            ))}
            <EmButton variant="secondary" onClick={() => void saveTags()} disabled={busy || vocabularyState !== "ready" || vocabulary.length === 0} loading={busy} data-testid="customer-tags-apply">
              {t("inbox.context.tagsApply")}
            </EmButton>
          </div>
        )}
      </section>

      {error && <p role="alert" className="mt-3 text-sm text-em-danger-700">{error}</p>}
    </section>
  );
}
