/**
 * CustomerContextPanel — MW-V1 Phase 3 (docs 03/04).
 * Desktop persistent column / mobile sheet answering: who is this customer,
 * what happened, what's open right now. READ-ONLY here; ownership controls
 * live in the thread actions beside it. Every association is the verified
 * shop-scoped customer id from the conversation row — never a name.
 * Gated insights (relationship, RTO, opportunities) require the
 * customer_intelligence flag AND issue ZERO gated requests while it is off.
 * Stale per-conversation loads are aborted; failures degrade to honest
 * unavailable lines without touching the message workflow.
 */
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ExternalLink, StickyNote, Tags, X } from "lucide-react";
import { apiClient } from "@/api";
import { getPilotStatus, getCustomer360 } from "@/api/domains/customer-intelligence";
import { getOrders } from "@/api/domains/order";
import { listCustomerNotes, listCustomerTags, createCustomerNote, deleteCustomerNote, listTagVocabulary, setCustomerTags } from "@/api/domains/customer-crm";
import { authService } from "@/app/lib/auth";
import type { Customer360Detail, CustomerState } from "@/api/types/customer-intelligence";
import type { CustomerNote, CustomerTag } from "@/api/types/crm";
import type { Conversation } from "@/api/types/conversation";
import type { Order } from "@/api/types/order";
import { formatMoney, formatRelative, initialOf, stateStyles } from "../customers/customerDisplay";
import { Badge } from "@/app/components/ui/badge";

const STATE_LABEL_KEYS: Record<CustomerState, string> = {
  NEW: "customer360.states.NEW",
  INTERESTED: "customer360.states.INTERESTED",
  BUYER: "customer360.states.BUYER",
  REPEAT_BUYER: "customer360.states.REPEAT_BUYER",
  AT_RISK: "customer360.states.AT_RISK",
  INACTIVE: "customer360.states.INACTIVE",
};

const RTO_LABEL_KEYS: Record<string, string> = {
  clear: "inbox.context.rto.clear",
  verify: "inbox.context.rto.verify",
  block: "inbox.context.rto.block",
};

type Section<T> = { status: "idle" | "loading" | "ready" | "error"; data: T | null };

interface Props {
  conversation: Conversation;
  onClose?: () => void;
  /** Canonical PATCH result bubbled so the thread/list converge instantly. */
  onConversationChanged?: (updated: Conversation) => void;
}

export default function CustomerContextPanel({ conversation, onClose, onConversationChanged }: Props) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const customerId = conversation.customer_id ?? conversation.customer?.id ?? null;

  const [ciEnabled, setCiEnabled] = useState<boolean | null>(null);
  const [relationship, setRelationship] = useState<Section<Customer360Detail>>({ status: "idle", data: null });
  const [orders, setOrders] = useState<Section<Order[]>>({ status: "idle", data: null });
  const [notes, setNotes] = useState<Section<CustomerNote[]>>({ status: "idle", data: null });
  const [tags, setTags] = useState<Section<CustomerTag[]>>({ status: "idle", data: null });
  const [vocabulary, setVocabulary] = useState<CustomerTag[]>([]);

  // Notes + tags are re-pullable after a mutation. isStale is supplied by the
  // owning effect so a late response for a PREVIOUS conversation is dropped.
  const reloadNotes = (id: string, isStale: () => boolean) => {
    setNotes({ status: "loading", data: null });
    void listCustomerNotes(id, { limit: 3 })
      .then((page) => { if (!isStale()) setNotes({ status: "ready", data: page.data }); })
      .catch(() => { if (!isStale()) setNotes({ status: "error", data: null }); });
  };
  const reloadTags = (id: string, isStale: () => boolean) => {
    setTags({ status: "loading", data: null });
    void listCustomerTags(id)
      .then((page) => { if (!isStale()) setTags({ status: "ready", data: page.data }); })
      .catch(() => { if (!isStale()) setTags({ status: "error", data: null }); });
  };

  const requestIdRef = useRef(0);

  // Notes/tags mutation state (MW-V1 Phase 5/6).
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteDraft, setNoteDraft] = useState("");
  const [tagEditOpen, setTagEditOpen] = useState(false);
  const [draftTagIds, setDraftTagIds] = useState<string[]>([]);
  const [crmBusy, setCrmBusy] = useState(false);
  const [crmError, setCrmError] = useState<string | null>(null);

  const authState = authService.getState();
  const myUserId = authState.user?.id ?? null;
  const privileged = ["owner", "admin"].includes(String(authState.currentShop?.role ?? "").toLowerCase());

  // captures the CURRENT request generation so a mutation re-pull that lands
  // after a conversation switch is discarded, exactly like the main effect.
  const currentStale = () => {
    const rid = requestIdRef.current;
    return () => rid !== requestIdRef.current;
  };

  const crmMessage = (e: unknown, fallback: string) =>
    (e as { response?: { data?: { error?: { message?: string } } } })?.response?.data?.error?.message || fallback;

  const submitNote = async () => {
    const body = noteDraft.trim();
    if (!body || !customerId) return;
    setCrmBusy(true); setCrmError(null);
    try {
      await createCustomerNote(customerId, body);
      setNoteDraft(""); setNoteOpen(false);
      reloadNotes(customerId, currentStale());
    } catch (e) {
      setCrmError(crmMessage(e, t("inbox.context.crmFailed")));
    } finally {
      setCrmBusy(false);
    }
  };

  const removeNote = async (noteId: string) => {
    if (!customerId) return;
    setCrmBusy(true); setCrmError(null);
    try {
      await deleteCustomerNote(customerId, noteId);
      reloadNotes(customerId, currentStale());
    } catch (e) {
      setCrmError(crmMessage(e, t("inbox.context.crmFailed")));
    } finally {
      setCrmBusy(false);
    }
  };

  const openTagEdit = async () => {
    if (tagEditOpen) { setTagEditOpen(false); return; }
    setDraftTagIds((tags.data ?? []).map((tag) => tag.id));
    setTagEditOpen(true);
    if (!vocabulary.length) {
      try { setVocabulary((await listTagVocabulary()).data ?? []); }
      catch { setVocabulary([]); }
    }
  };

  const applyTags = async () => {
    if (!customerId) return;
    setCrmBusy(true); setCrmError(null);
    try {
      await setCustomerTags(customerId, draftTagIds);
      setTagEditOpen(false);
      reloadTags(customerId, currentStale());
    } catch (e) {
      setCrmError(crmMessage(e, t("inbox.context.crmFailed")));
    } finally {
      setCrmBusy(false);
    }
  };

  useEffect(() => {
    const requestId = ++requestIdRef.current;
    const controller = new AbortController();
    const stale = () => requestId !== requestIdRef.current;

    // No-cache discipline: switching conversations resets before loading.
    setRelationship({ status: "idle", data: null });
    setOrders({ status: "idle", data: null });
    setNotes({ status: "idle", data: null });
    setTags({ status: "idle", data: null });

    void (async () => {
      let enabled = ciEnabled;
      if (enabled === null) {
        try {
          const status = await getPilotStatus();
          enabled = status.customer_intelligence;
        } catch { enabled = false; }
        if (stale() || controller.signal.aborted) return;
        setCiEnabled(enabled);
      }
      if (!customerId) return; // honest: unlinked conversation

      // Operations (always authorized for the shop; id-scoped)
      setOrders({ status: "loading", data: null });
      void getOrders({ customer_id: customerId, limit: 3 })
        .then((rows) => { if (!stale() && !controller.signal.aborted) setOrders({ status: "ready", data: rows ?? [] }); })
        .catch(() => { if (!stale()) setOrders({ status: "error", data: null }); });

      // CRM reads (re-pullable after note/tag mutations)
      reloadNotes(customerId, stale);
      reloadTags(customerId, stale);
      setVocabulary([]);

      // Gated insights: NOT fetched while the platform flag is off.
      if (enabled) {
        setRelationship({ status: "loading", data: null });
        void getCustomer360(customerId)
          .then((detail) => { if (!stale() && !controller.signal.aborted) setRelationship({ status: "ready", data: detail }); })
          .catch(() => { if (!stale()) setRelationship({ status: "error", data: null }); });
      }
    })();

    return () => { controller.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerId, conversation.id]);

  const name = conversation.customer?.name || conversation.title || t("customer360.unknownName");

  return (
    <aside
      data-testid="customer-context-panel"
      aria-label={t("inbox.context.title")}
      className="w-full xl:w-80 shrink-0 overflow-y-auto border-l border-em-border bg-em-bg-surface p-4 space-y-4"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-em-text-primary">{t("inbox.context.title")}</h2>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label={t("common.close")}
            data-testid="context-close"
            className="inline-flex h-11 w-11 items-center justify-center rounded-lg text-em-text-secondary hover:bg-em-bg-muted"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        )}
      </div>
      {/* Identity — always basic-authorized */}
      <section aria-label={t("inbox.context.identity")}>
        <div className="flex items-center gap-2">
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-em-violet-100 text-sm font-bold text-em-violet-700" aria-hidden="true">
            {initialOf(name)}
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-em-text-primary">{name}</p>
            <p className="text-xs text-em-text-secondary">
              {conversation.channel}
              {conversation.metaChannel?.displayName ? ` · ${conversation.metaChannel.displayName}` : ""}
              {conversation.updated_at ? ` · ${formatRelative(conversation.updated_at, i18n.language)}` : ""}
            </p>
            {customerId && (
              <a
                href={`/customers?customerId=${encodeURIComponent(customerId)}`}
                onClick={(event) => {
                  event.preventDefault();
                  navigate(`/customers?customerId=${encodeURIComponent(customerId)}`);
                }}
                className="mt-1 inline-flex min-h-11 items-center gap-1 text-xs font-medium text-em-violet-700 hover:underline"
              >
                {t("inbox.context.viewProfile")}
                <ExternalLink className="h-3 w-3" aria-hidden="true" />
              </a>
            )}
          </div>
        </div>
        {!customerId && (
          <p className="mt-2 text-xs text-em-text-secondary" data-testid="context-no-link">
            {t("inbox.context.noLink")}
          </p>
        )}
      </section>

      {/* Ownership — canonical PATCH claim/assign; server is the source of truth. */}
      <OwnershipBlock conversation={conversation} onChanged={onConversationChanged} />

      {customerId && ciEnabled && (
        <PanelSection label={t("inbox.context.relationship")} section={relationship} empty={null}>
          {(d) => (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge className={`${stateStyles[d.state]} text-xs`}>{t(STATE_LABEL_KEYS[d.state])}</Badge>
                {d.rto_signal?.available && (
                  <Badge variant="outline" className="text-xs">
                    {t(RTO_LABEL_KEYS[String(d.rto_signal.tier)] || "inbox.context.rto.clear")}
                  </Badge>
                )}
              </div>
              <dl className="grid grid-cols-2 gap-1 text-xs text-em-text-secondary">
                <dt className="font-bn">{t("inbox.context.deliveredOrders")}</dt>
                <dd className="text-right tabular-nums">{d.summary.delivered_orders ?? d.summary.total_orders ?? 0}</dd>
                <dt className="font-bn">{t("inbox.context.deliveredValue")}</dt>
                <dd className="text-right tabular-nums">{formatMoney(d.summary.delivered_value ?? 0, i18n.language)}</dd>
              </dl>
            </div>
          )}
        </PanelSection>
      )}

      {customerId && (
        <PanelSection label={t("inbox.context.operations")} section={orders} empty={t("inbox.context.noOrders")}>
          {(rows) => (
            <ul className="space-y-1.5">
              {rows.map((o) => (
                <li key={o.id} className="flex items-center gap-2 text-xs">
                  <button
                    type="button"
                    onClick={() => navigate(`/orders?orderId=${encodeURIComponent(o.id)}`)}
                    className="min-w-0 flex-1 truncate text-left font-medium text-em-text-primary hover:underline"
                    data-testid="context-order-row"
                  >
                    {o.orderNumber} <span className="text-em-text-secondary">· {o.status}</span>
                  </button>
                  <button
                    type="button"
                    aria-label={`${t("inbox.context.openOrder")} ${o.orderNumber}`}
                    onClick={() => navigate(`/orders?orderId=${encodeURIComponent(o.id)}`)}
                    className="inline-flex min-h-11 min-w-11 items-center justify-center text-em-violet-700 hover:underline"
                  >
                    <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                    <span className="sr-only">{t("inbox.context.openOrder")}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </PanelSection>
      )}

      {customerId && (
        <section aria-label={t("inbox.context.notes")} className="border-t border-em-border pt-3">
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-em-text-secondary">
              {t("inbox.context.notes")}
            </h3>
            <button
              type="button"
              data-testid="note-add-open"
              onClick={() => setNoteOpen((o) => !o)}
              aria-expanded={noteOpen}
              className="text-xs font-medium text-em-violet-700 hover:underline"
            >
              {t("inbox.context.notesAdd")}
            </button>
          </div>
          {noteOpen && (
            <div className="mb-2">
              <textarea
                data-testid="note-composer"
                value={noteDraft}
                maxLength={2000}
                rows={3}
                aria-label={t("inbox.context.notes")}
                onChange={(e) => setNoteDraft(e.target.value)}
                className="w-full rounded-lg border border-em-border-strong p-2 text-xs"
              />
              <button
                type="button"
                data-testid="note-save"
                disabled={crmBusy || !noteDraft.trim()}
                onClick={() => void submitNote()}
                className="mt-1 min-h-11 rounded-lg border border-em-border-strong bg-em-bg-surface px-3 py-1.5 text-xs font-semibold text-em-text-primary hover:bg-em-bg-muted disabled:opacity-50"
              >
                {t("inbox.context.notesSave")}
              </button>
            </div>
          )}
          {notes.status === "loading" && <p className="text-xs text-em-text-secondary">{t("inbox.context.loading")}</p>}
          {notes.status === "error" && <p className="text-xs text-em-text-secondary">{t("inbox.context.unavailable")}</p>}
          {notes.status === "ready" && (notes.data?.length ?? 0) === 0 && (
            <p className="text-xs text-em-text-secondary">{t("inbox.context.notesEmpty")}</p>
          )}
          {notes.status === "ready" && (notes.data ?? []).length > 0 && (
            <ul className="space-y-1.5">
              {notes.data!.map((n) => (
                <li key={n.id} className="rounded-lg bg-em-bg-muted p-2 text-xs text-em-text-primary border border-em-border">
                  <p className="whitespace-pre-line">{n.body}</p>
                  <p className="mt-1 flex items-center justify-between text-xs text-em-text-secondary">
                    <span>
                      <StickyNote className="mr-1 inline h-3 w-3" aria-hidden="true" />
                      {n.author_name} · {n.created_at ? formatRelative(n.created_at, i18n.language) : ""}
                    </span>
                    {(String(n.author_id) === String(myUserId) || privileged) && (
                      <button
                        type="button"
                        data-testid="note-delete"
                        aria-label={`${t("inbox.context.noteDelete")} ${n.author_name ?? ""}`}
                        disabled={crmBusy}
                        onClick={() => void removeNote(n.id)}
                        className="inline-flex min-h-11 items-center text-em-danger-700 hover:underline disabled:opacity-50"
                      >
                        {t("inbox.context.noteDelete")}
                      </button>
                    )}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {customerId && (
        <section aria-label={t("inbox.context.tags")} className="border-t border-em-border pt-3">
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-em-text-secondary">
              {t("inbox.context.tags")}
            </h3>
            <button
              type="button"
              data-testid="tag-edit-open"
              onClick={() => void openTagEdit()}
              aria-expanded={tagEditOpen}
              className="text-xs font-medium text-em-violet-700 hover:underline"
            >
              {t("inbox.context.tagsEdit")}
            </button>
          </div>
          {tags.status === "ready" && (tags.data?.length ?? 0) === 0 && !tagEditOpen && (
            <p className="text-xs text-em-text-secondary">{t("inbox.context.tagsEmpty")}</p>
          )}
          {tags.status === "ready" && (tags.data?.length ?? 0) > 0 && !tagEditOpen && (
            <div className="flex flex-wrap gap-1.5">
              {tags.data!.map((tag) => (
                <Badge key={tag.id} variant="secondary" className="text-xs">
                  <Tags className="mr-1 h-3 w-3" aria-hidden="true" />{tag.name}
                </Badge>
              ))}
            </div>
          )}
          {tagEditOpen && (
            <div className="mt-1 space-y-1" data-testid="tag-editor">
              {vocabulary.length === 0 && (
                <p className="text-xs text-em-text-secondary">{t("inbox.context.tagsNoVocabulary")}</p>
              )}
              {vocabulary.map((tag) => {
                const active = draftTagIds.includes(tag.id);
                return (
                  <button
                    key={tag.id}
                    type="button"
                    data-testid={`tag-choice-${tag.id}`}
                    aria-pressed={active}
                    onClick={() => setDraftTagIds((prev) => (active ? prev.filter((x) => x !== tag.id) : [...prev, tag.id]))}
                    className={`block w-full min-h-11 rounded-lg px-2 py-1.5 text-left text-xs ${
                      active ? "bg-em-midnight-900 text-white" : "bg-em-bg-muted text-em-text-primary hover:bg-em-border/60"
                    }`}
                  >
                    {tag.name}
                    {typeof tag.usage_count === "number" ? ` · ${tag.usage_count}` : ""}
                  </button>
                );
              })}
              <div className="flex gap-1.5">
                <button
                  type="button"
                  data-testid="tag-apply"
                  disabled={crmBusy}
                  onClick={() => void applyTags()}
                  className="min-h-11 rounded-lg border border-em-border-strong bg-em-bg-surface px-3 py-1.5 text-xs font-semibold text-em-text-primary hover:bg-em-bg-muted disabled:opacity-50"
                >
                  {t("inbox.context.tagsApply")}
                </button>
                <button
                  type="button"
                  onClick={() => setTagEditOpen(false)}
                  className="rounded-lg bg-em-bg-muted px-3 py-1.5 text-xs text-em-text-primary"
                >
                  {t("common.cancel")}
                </button>
              </div>
            </div>
          )}
          {crmError && <p role="alert" className="mt-1 text-xs text-em-danger-700">{crmError}</p>}
        </section>
      )}
    </aside>
  );
}

interface AgentLike { id: string; full_name?: string; name?: string; role?: string | null }

/**
 * MW-V1 Phase 4: who owns this conversation, right now. Every action is the
 * canonical PATCH (claim == takeover; assignment verified shop-side). On 409
 * the SERVER reason is displayed verbatim and optimistic state is NOT applied;
 * privileged members additionally get the manager take-over (force) retry —
 * staff never see it, and the server enforces regardless.
 */
function OwnershipBlock({ conversation, onChanged }: {
  conversation: Conversation;
  onChanged?: (updated: Conversation) => void;
}) {
  const { t } = useTranslation();
  const state = authService.getState();
  const me = state.user?.id ?? null;
  const role = String(state.currentShop?.role ?? "").toLowerCase();
  const privileged = role === "owner" || role === "admin";

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflicted, setConflicted] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  const [agents, setAgents] = useState<AgentLike[] | null>(null);

  const ownerName = conversation.assignee?.name || null;

  const mutate = async (patch: Record<string, unknown>, force = false) => {
    setBusy(true); setError(null); setConflicted(false);
    try {
      const updated = await apiClient.updateConversation(
        conversation.id, force ? { ...patch, force: true } : patch,
      );
      onChanged?.(updated);
      return true;
    } catch (err) {
      const e = err as { response?: { data?: { error?: { code?: string; message?: string } } }; message?: string };
      const code = e?.response?.data?.error?.code;
      // The httpClient normalizes errors (normalizeApiError) onto `.message`,
      // dropping the raw axios `.response`; mirror the thread takeover handler
      // so the authoritative conflict reason surfaces, never a fabricated one.
      const message = e?.response?.data?.error?.message
        || (typeof e?.message === "string" && e.message && !/request failed|status code/i.test(e.message) ? e.message : "");
      if (code === "HUMAN_TAKEOVER_CONFLICT" || code === "HANDOFF_RESOLUTION_CONFLICT" || /assigned to another/i.test(message)) setConflicted(true);
      setError(message || t("inbox.context.owner.failed"));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const openAssign = () => {
    setAssignOpen((o) => !o);
    if (!agents) {
      void apiClient.getShopAgents()
        .then((rows) => setAgents((rows ?? []) as unknown as AgentLike[]))
        .catch(() => setAgents([]));
    }
  };

  return (
    <section aria-label={t("inbox.context.owner.title")} className="border-t border-em-border pt-3">
      <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-em-text-secondary">
        {t("inbox.context.owner.title")}
      </h3>
      <p className="text-xs text-em-text-primary" data-testid="context-owner">
        {conversation.assignee_id || ownerName
          ? t("inbox.assignedTo", { name: ownerName || t("inbox.context.owner.teammate") })
          : conversation.hitl
            ? t("inbox.context.owner.unclaimed")
            : t("inbox.context.owner.none")}
      </p>

      <div className="mt-2 flex flex-wrap gap-1.5">
        {conversation.hitl && conversation.assignee_id !== me && (
          <button
            type="button"
            data-testid="context-claim"
            disabled={busy}
            onClick={() => void mutate({ hitl: true })}
            className="min-h-11 rounded-lg border border-em-border-strong bg-em-bg-surface px-3 py-1.5 text-xs font-semibold text-em-text-primary hover:bg-em-bg-muted disabled:opacity-50"
          >
            {t("inbox.context.owner.claim")}
          </button>
        )}
        <button
          type="button"
          data-testid="context-assign-open"
          disabled={busy}
          onClick={openAssign}
          aria-expanded={assignOpen}
          className="rounded-lg bg-em-bg-muted px-3 py-1.5 text-xs font-medium text-em-text-primary hover:bg-em-border/60 disabled:opacity-50"
        >
          {t("inbox.context.owner.assign")}
        </button>
        {conflicted && privileged && (
          <button
            type="button"
            data-testid="context-force"
            disabled={busy}
            onClick={() => void mutate({ hitl: true }, true)}
            className="min-h-11 rounded-lg bg-em-danger-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-em-danger-700/90 disabled:opacity-50"
          >
            {t("inbox.context.owner.force")}
          </button>
        )}
      </div>

      {assignOpen && (
        <ul className="mt-2 space-y-1" data-testid="context-assign-list">
          {(agents ?? []).map((a) => {
            const displayName = a.full_name || a.name || a.id;
            return (
              <li key={a.id}>
                <button
                  type="button"
                  disabled={busy || String(conversation.assignee_id) === String(a.id)}
                  onClick={() => void mutate({ assignee_id: a.id }).then((ok) => ok && setAssignOpen(false))}
                  className="w-full rounded-lg px-2 py-1.5 text-left text-xs text-em-text-primary hover:bg-em-bg-muted disabled:opacity-40"
                >
                  {displayName}{a.role ? ` · ${a.role}` : ""}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {error && (
        <p role="alert" className="mt-2 text-xs text-em-danger-700" data-testid="context-owner-error">{error}</p>
      )}
    </section>
  );
}

function PanelSection<T>({
  label, section, empty, children,
}: {
  label: string;
  section: Section<T>;
  empty: React.ReactNode;
  children: (data: T) => React.ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <section aria-label={label} className="border-t border-em-border pt-3 first:border-0 first:pt-0">
      <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-em-text-secondary">{label}</h3>
      {section.status === "loading" && (
        <p className="text-xs text-em-text-secondary">{t("inbox.context.loading")}</p>
      )}
      {section.status === "error" && (
        <p className="text-xs text-em-text-secondary" data-testid="context-section-error">
          {t("inbox.context.unavailable")}
        </p>
      )}
      {section.status === "ready" && section.data && (
        Array.isArray(section.data)
          ? (section.data.length === 0 ? <p className="text-xs text-em-text-secondary">{empty}</p> : children(section.data))
          : children(section.data)
      )}
    </section>
  );
}
