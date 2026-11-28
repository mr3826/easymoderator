import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft, Calendar, Clock, ExternalLink, Link2, Loader2, Mail, MessageSquare, Pencil, Phone, ShieldCheck, ShieldAlert, Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { apiClient } from "@/api";
import { getCustomer360, getPilotStatus } from "@/api/domains/customer-intelligence";
import type { Customer360Detail, Opportunity, TimelineEvent } from "@/api/types/customer-intelligence";
import { useAuth } from "@/features/auth/AuthProvider";
import { getErrorMessage } from "@/shared/lib/http/errors";
import { EmButton } from "../dashboard/EmButton";
import { PageHeader } from "../dashboard/PageHeader";
import { LegacyCustomerRouteDrawer } from "../Customers";
import CustomerCRMPanel from "./CustomerCRMPanel";
import OpportunityCard from "./OpportunityCard";
import { CustomerDeleteDialog, CustomerRecordDialog, isDuplicateCustomerError, type CustomerRecordDraft } from "./CustomerRecordDialogs";
import {
  formatCount, formatDateTime, formatMoney, formatRelative, initialOf, outcomeStyles, stateStyles,
} from "./customerDisplay";

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-xl bg-em-bg-muted border border-em-border p-3">
      <p className="text-xs text-em-text-secondary">{label}</p>
      <p className="text-lg font-semibold text-em-text-primary tabular-nums mt-0.5">{value}</p>
    </div>
  );
}

function Section({ title, children, testId }: { title: string; children: React.ReactNode; testId?: string }) {
  return (
    <section className="bg-em-bg-surface rounded-2xl border border-em-border shadow-sm p-4 md:p-5" data-testid={testId}>
      <h2 className="text-base font-semibold text-em-text-primary mb-3">{title}</h2>
      {children}
    </section>
  );
}

function timelineLabel(event: TimelineEvent, t: (key: string, opts?: Record<string, unknown>) => string) {
  return t(`customer360.timeline.${event.type}`, {
    number: event.order_number ?? "",
    count: event.customer_messages ?? 0,
    defaultValue: event.type,
  });
}

/** Customer 360 Lite detail: identity, commerce summary, history, opportunities, delivery signal. */
export function Customer360DetailPage() {
  const { customerId = "" } = useParams();
  const navigate = useNavigate();
  const { t, i18n } = useTranslation();
  const language = i18n?.language ?? "en";
  const { currentShop } = useAuth();
  const canDelete = ["owner", "admin"].includes(String(currentShop?.role ?? "").toLowerCase());
  const [detail, setDetail] = useState<Customer360Detail | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error" | "notFound">("loading");
  const [editing, setEditing] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState("loading");
    try {
      setDetail(await getCustomer360(customerId));
      setState("ready");
    } catch (error) {
      // httpClient throws a NormalizedApiError ({ statusCode, code, ... }).
      const status = (error as { statusCode?: number })?.statusCode;
      setState(status === 404 ? "notFound" : "error");
    }
  }, [customerId]);

  useEffect(() => { void load(); }, [load]);

  const back = (
    <Link to="/customers" className="inline-flex items-center gap-2 text-sm text-em-text-secondary hover:text-em-text-primary mb-4">
      <ArrowLeft className="w-4 h-4" aria-hidden="true" /> {t("customer360.actions.back")}
    </Link>
  );

  if (state === "loading") {
    return (
      <div className="em-customers min-h-full p-4 md:p-6"><div className="max-w-5xl mx-auto">{back}
        <div className="bg-em-bg-surface rounded-2xl border border-em-border p-10 text-center" role="status">
          <Loader2 className="w-8 h-8 animate-spin text-em-violet-700 mx-auto" />
        </div>
      </div></div>
    );
  }
  if (state !== "ready" || !detail) {
    return (
      <div className="em-customers min-h-full p-4 md:p-6"><div className="max-w-5xl mx-auto">{back}
        <div className="bg-em-bg-surface rounded-2xl border border-em-danger-700/20 p-8 text-center" role="alert">
          <p className="text-em-danger-700 font-medium mb-3">
            {state === "notFound" ? t("customer360.detail.notFound") : t("customer360.detail.loadFailed")}
          </p>
          {state === "error" && (
            <button type="button" onClick={() => void load()} className="px-4 py-2 rounded-lg bg-em-midnight-900 text-white text-sm">
              {t("customer360.retry")}
            </button>
          )}
        </div>
      </div></div>
    );
  }

  const { customer, summary, contactability, rto_signal: rto } = detail;
  const reason = detail.state_reasons?.[0];
  const callNumber = customer.phone?.replace(/[^\d+]/g, "") ?? "";
  const partialOrderHistory = summary.order_coverage?.complete === false;
  const formatOrderCount = (value: number) => `${formatCount(value, language)}${partialOrderHistory ? "+" : ""}`;
  const formatOrderValue = (value: number) => `${formatMoney(value, language)}${partialOrderHistory ? "+" : ""}`;
  const replyWindow = contactability.reason === "OPTED_OUT"
    ? t("customer360.detail.optedOut")
    : contactability.reason === "WITHIN_24H_WINDOW"
      ? contactability.window_open
        ? t("customer360.detail.replyWindowOpen", { time: formatDateTime(contactability.window_closes_at, language) })
        : t("customer360.detail.replyWindowClosed")
      : contactability.reason === "OUTSIDE_24H_WINDOW"
        ? t("customer360.detail.replyWindowClosed")
        : contactability.reason === "NO_INBOUND_MESSAGE"
          ? t("customer360.detail.noInboundMessage", { defaultValue: "No inbound message has opened a reply window." })
          : t("customer360.detail.notMessagingChannel", { defaultValue: "This channel does not support inbox replies." });
  const updateOpportunity = (updated: Opportunity) => setDetail((prev) => prev && ({
    ...prev,
    opportunities: prev.opportunities.map((o) => (o.id === updated.id ? updated : o)),
  }));

  const saveCustomer = async (draft: CustomerRecordDraft) => {
    setSaving(true);
    setFormError(null);
    try {
      const updated = await apiClient.updateCustomer(customer.id, {
        name: draft.name,
        number: draft.phone,
        email: draft.email.trim() || null,
      });
      setDetail((current) => current ? {
        ...current,
        customer: { ...current.customer, name: updated.name, phone: updated.number, email: updated.email ?? null },
      } : current);
      setEditing(false);
      toast.success(t("customers.success.updated"));
    } catch (error: unknown) {
      const message = isDuplicateCustomerError(error)
        ? t("customers.errors.duplicatePhone", { defaultValue: "A customer with this phone number already exists." })
        : getErrorMessage(error, t("customers.errors.updateFailed"));
      setFormError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  const deleteCustomer = async () => {
    setSaving(true);
    try {
      await apiClient.deleteCustomer(customer.id);
      toast.success(t("customers.success.deleted"));
      navigate("/customers", { replace: true });
    } catch (error: unknown) {
      toast.error(getErrorMessage(error, t("customers.errors.deleteFailed")));
    } finally {
      setSaving(false);
      setDeleteOpen(false);
    }
  };

  return (
    <div className="em-customers min-h-full p-4 md:p-6">
      <div className="max-w-5xl mx-auto space-y-4">
        {back}
        <PageHeader title={customer.name || t("customer360.unknownName")} titleMode="compact" />

        <header className="bg-em-bg-surface rounded-2xl border border-em-border shadow-sm p-4 md:p-5" data-testid="customer-header">
          <div className="flex flex-wrap items-start gap-4">
            {customer.profile_pic ? (
              <img src={customer.profile_pic} alt="" className="w-14 h-14 rounded-full object-cover" referrerPolicy="no-referrer" />
            ) : (
              <div className="w-14 h-14 rounded-full bg-em-violet-600 text-white text-xl font-bold flex items-center justify-center">
                {initialOf(customer.name)}
              </div>
            )}
            <div className="min-w-0 flex-1">
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <span className={`inline-flex px-2.5 py-1 rounded-full text-xs font-semibold ${stateStyles[detail.state]}`} data-testid="customer-state">
                  {t(`customer360.states.${detail.state}`)}
                </span>
                {reason && (
                  <span className="text-xs text-em-text-secondary">{t(`customer360.stateReasons.${reason.code}`, reason.params ?? {})}</span>
                )}
              </div>
            </div>
          </div>
          <div className="mt-4 flex flex-wrap gap-2" role="group" aria-label={t("common.actions")}>
            <EmButton variant="secondary" onClick={() => { setFormError(null); setEditing(true); }}>
              <Pencil className="h-4 w-4" aria-hidden="true" />{t("common.edit")}
            </EmButton>
            {callNumber && (
              <a href={`tel:${callNumber}`} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-em-border-strong px-4 text-sm font-semibold text-em-text-primary hover:bg-em-bg-muted focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-em-focus-light">
                <Phone className="h-4 w-4" aria-hidden="true" />{t("customers.actions.call", { defaultValue: "Call" })}
              </a>
            )}
            {detail.conversations[0] && (
              <EmButton variant="primary" onClick={() => navigate(`/inbox?conversation=${encodeURIComponent(detail.conversations[0].id)}`)}>
                <ExternalLink className="h-4 w-4" aria-hidden="true" />{t("customer360.actions.openConversation")}
              </EmButton>
            )}
            {!detail.conversations[0] && (
              <EmButton variant="primary" onClick={() => navigate(`/inbox?customer_id=${encodeURIComponent(customer.id)}`)}>
                <ExternalLink className="h-4 w-4" aria-hidden="true" />{t("customers.actions.openInbox", { defaultValue: "Open inbox" })}
              </EmButton>
            )}
            {canDelete && (
              <EmButton variant="danger" onClick={() => setDeleteOpen(true)}>
                <Trash2 className="h-4 w-4" aria-hidden="true" />{t("customers.deleteModal.title")}
              </EmButton>
            )}
          </div>
          <dl className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-sm">
            <div className="flex items-center gap-2 text-em-text-primary">
              <Phone className="w-4 h-4 text-em-text-secondary" aria-hidden="true" />
              <dt className="sr-only">{t("customer360.detail.phone")}</dt>
                <dd>{customer.phone || t("customer360.detail.notProvided")}</dd>
            </div>
            <div className="flex items-center gap-2 text-em-text-primary">
              <Mail className="w-4 h-4 text-em-text-secondary" aria-hidden="true" />
              <dt className="sr-only">{t("customer360.detail.email")}</dt>
              <dd className="break-all">{customer.email || t("customer360.detail.notProvided")}</dd>
            </div>
            <div className="flex items-center gap-2 text-em-text-primary">
              <MessageSquare className="w-4 h-4 text-em-text-secondary" aria-hidden="true" />
              <dt className="sr-only">{t("customer360.detail.channel")}</dt>
              <dd>{t(`customers.channels.${customer.channel_type}`, { defaultValue: customer.channel_type === "instagram" ? "Instagram" : customer.channel_type })}{customer.page?.name ? ` · ${customer.page.name}` : ""}</dd>
            </div>
            <div className="flex items-center gap-2 text-em-text-primary">
              <Calendar className="w-4 h-4 text-em-text-secondary" aria-hidden="true" />
              <dt>{t("customer360.detail.firstSeen")}:</dt>
              <dd>{formatDateTime(customer.first_seen_at, language)}</dd>
            </div>
            <div className="flex items-center gap-2 text-em-text-primary">
              <Clock className="w-4 h-4 text-em-text-secondary" aria-hidden="true" />
              <dt>{t("customer360.detail.lastSeen")}:</dt>
              <dd>{formatRelative(customer.last_activity_at, language)}</dd>
            </div>
            {replyWindow && (
              <div className="flex items-center gap-2 text-em-text-primary" data-testid="reply-window">
                <MessageSquare className="w-4 h-4 text-em-text-secondary" aria-hidden="true" />
                <dt className="font-medium">{t("customer360.detail.contactability", { defaultValue: "Contactability" })}:</dt>
                <dd>{replyWindow}</dd>
              </div>
            )}
          </dl>
        </header>

        {partialOrderHistory && (
          <p role="status" className="rounded-xl border border-em-warning-700/30 bg-em-warning-100 px-4 py-3 text-sm text-em-text-primary">
            {t("customer360.orderCoveragePartial", {
              scanned: formatCount(summary.order_coverage!.scanned, language),
              total: formatCount(summary.order_coverage!.total, language),
            })}
          </p>
        )}

        <Section title={t("customer360.detail.commerce")} testId="commerce-summary">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Stat label={t("customer360.detail.totalOrders")} value={formatCount(summary.total_orders, language)} />
            <Stat label={t("customer360.detail.delivered")} value={formatOrderCount(summary.delivered_orders)} />
            <Stat label={t("customer360.detail.returned")} value={formatOrderCount(summary.returned_orders)} />
            <Stat label={t("customer360.detail.cancelled")} value={formatOrderCount(summary.cancelled_orders)} />
            <Stat label={t("customer360.detail.orderedValue")} value={formatOrderValue(summary.ordered_value)} />
            <Stat label={t("customer360.detail.deliveredValue")} value={formatOrderValue(summary.delivered_value)} />
            <Stat label={t("customer360.detail.lastOrder")} value={formatRelative(summary.last_order_at, language)} />
            <Stat label={t("customer360.detail.lastDelivery")} value={formatRelative(summary.last_delivered_at, language)} />
          </div>
          <p className="text-xs text-em-text-secondary mt-3">{t("customer360.detail.valueNote")}</p>
        </Section>

        <Section title={t("customer360.detail.rto")} testId="rto-signal">
          {!rto.available ? (
            <p className="text-sm text-em-text-secondary">{t("customer360.detail.rtoUnavailable")}</p>
          ) : (
            <div className="flex items-start gap-3">
              {rto.tier === "clear"
                ? <ShieldCheck className="w-5 h-5 text-em-success-700 shrink-0" aria-hidden="true" />
                : <ShieldAlert className="w-5 h-5 text-em-warning-700 shrink-0" aria-hidden="true" />}
              <div className="text-sm">
                <p className="font-medium text-em-text-primary">{t(`customer360.detail.rtoTier.${rto.tier}`)}</p>
                {rto.network && rto.network.shops_reported > 0 && (
                  <p className="text-em-text-secondary mt-0.5">
                    {t("customer360.detail.rtoNetwork", { shops: rto.network.shops_reported, attempts: rto.network.total_attempts })}
                  </p>
                )}
              </div>
            </div>
          )}
        </Section>

        <Section title={t("customer360.detail.opportunities")} testId="customer-opportunities">
          {detail.opportunities.length === 0 ? (
            <p className="text-sm text-em-text-secondary">{t("customer360.detail.noOpportunities")}</p>
          ) : (
            <div className="space-y-3">
              {detail.opportunities.map((o) => (
                <OpportunityCard key={o.id} opportunity={o} showCustomer={false} onChanged={updateOpportunity} />
              ))}
            </div>
          )}
        </Section>

        <Section title={t("customer360.detail.orders")} testId="customer-orders">
          {detail.orders.length === 0 ? (
            <p className="text-sm text-em-text-secondary">{t("customer360.detail.noOrders")}</p>
          ) : (
            <ul className="divide-y divide-em-border">
              {detail.orders.map((order) => (
                <li key={order.id} className="py-3 flex flex-wrap items-center gap-x-4 gap-y-1">
                  <button
                    type="button"
                    onClick={() => navigate(`/orders?orderId=${encodeURIComponent(order.id)}`)}
                    className="font-medium text-em-text-primary hover:text-em-violet-700"
                  >
                    #{order.order_number ?? order.id.slice(0, 8)}
                  </button>
                  <span className="text-sm text-em-text-secondary">{formatDateTime(order.created_at, language)}</span>
                  <span className="text-sm font-medium tabular-nums">{formatMoney(order.total, language)}</span>
                  <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${outcomeStyles[order.outcome]}`}>
                    {t(`customer360.detail.outcome.${order.outcome}`)}
                  </span>
                  {order.link === "PHONE_MATCH" && (
                    <span
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-em-bg-muted text-em-text-secondary"
                      title={t("customer360.detail.matchedByPhoneHelp")}
                    >
                      <Link2 className="w-3 h-3" aria-hidden="true" /> {t("customer360.detail.matchedByPhone")}
                    </span>
                  )}
                  {order.confidence && (
                    <span className="px-2 py-0.5 rounded-full text-xs bg-em-success-100 text-em-success-700">
                      {t(`orderConfidence.decisions.${order.confidence.decision}`)}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section
          title={t("customer360.detail.conversations", { defaultValue: "Conversations" })}
          testId="customer-conversations"
        >
          {detail.conversations.length === 0 ? (
            <p className="text-sm text-em-text-secondary">{t("customer360.detail.noConversations", { defaultValue: "No conversations are linked to this customer." })}</p>
          ) : (
            <ul className="divide-y divide-em-border">
              {detail.conversations.map((conversation) => (
                <li key={conversation.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div>
                    <p className="text-sm font-medium text-em-text-primary">{t(`customers.channels.${conversation.channel}`, { defaultValue: conversation.channel === "instagram" ? "Instagram" : conversation.channel })} | {conversation.status}</p>
                    <p className="text-xs text-em-text-secondary">
                      {formatDateTime(conversation.started_at, i18n.language)} | {t("customer360.detail.messageCount", {
                        defaultValue: "{{formattedCount}} customer messages",
                        count: conversation.customer_messages,
                        formattedCount: formatCount(conversation.customer_messages, language),
                      })}
                    </p>
                  </div>
                  <EmButton variant="secondary" onClick={() => navigate(`/inbox?conversation=${encodeURIComponent(conversation.id)}`)}>
                    <ExternalLink className="h-4 w-4" aria-hidden="true" />{t("customer360.actions.openConversation")}
                  </EmButton>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <CustomerCRMPanel customerId={customer.id} />

        <Section title={t("customer360.detail.timeline")} testId="customer-timeline">
          {detail.timeline.length === 0 ? (
            <p className="text-sm text-em-text-secondary">{t("customer360.detail.noTimeline")}</p>
          ) : (
            <ol className="relative border-l border-em-border ml-2 space-y-4">
              {detail.timeline.map((event, index) => (
                <li key={`${event.type}-${event.at}-${index}`} className="ml-4">
                  <span className="absolute -left-1.5 mt-1.5 w-3 h-3 rounded-full bg-em-info-100 border border-white" aria-hidden="true" />
                  <p className="text-sm text-em-text-primary">{timelineLabel(event, t)}</p>
                  <p className="text-xs text-em-text-secondary">
                    {formatDateTime(event.at, language)}
                    {event.approximate_time ? ` · ${t("customer360.timeline.approximate")}` : ""}
                  </p>
                </li>
              ))}
            </ol>
          )}
        </Section>
      </div>
      <CustomerRecordDialog
        mode="edit"
        open={editing}
        initial={{ id: customer.id, name: customer.name, phone: customer.phone, email: customer.email, channel: customer.channel_type }}
        saving={saving}
        error={formError}
        onClose={() => { setEditing(false); setFormError(null); }}
        onSave={(draft) => void saveCustomer(draft)}
      />
      <CustomerDeleteDialog open={deleteOpen} deleting={saving} customerName={customer.name} onClose={() => setDeleteOpen(false)} onConfirm={() => void deleteCustomer()} />
    </div>
  );
}

/** Route entry point used by /customers/:customerId in both feature-flag modes. */
export function CustomerDetailRouteWrapper() {
  const { customerId = "" } = useParams();
  const [mode, setMode] = useState<"loading" | "pilot" | "legacy">("loading");

  useEffect(() => {
    let stale = false;
    setMode("loading");
    getPilotStatus()
      .then((status) => { if (!stale) setMode(status.customer_intelligence ? "pilot" : "legacy"); })
      .catch(() => { if (!stale) setMode("legacy"); });
    return () => { stale = true; };
  }, [customerId]);

  if (mode === "loading") {
    return <div className="min-h-full p-8 text-center" role="status"><Loader2 className="mx-auto h-7 w-7 animate-spin text-em-violet-700" /></div>;
  }
  return mode === "pilot"
    ? <Customer360DetailPage key={customerId} />
    : <LegacyCustomerRouteDrawer customerId={customerId} />;
}

export default CustomerDetailRouteWrapper;
