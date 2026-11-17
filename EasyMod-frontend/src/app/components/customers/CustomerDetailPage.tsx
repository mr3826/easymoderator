import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft, Calendar, Clock, Link2, Loader2, Mail, MessageSquare, Phone, ShieldCheck, ShieldAlert,
} from "lucide-react";
import { getCustomer360 } from "@/api/domains/customer-intelligence";
import type { Customer360Detail, Opportunity, TimelineEvent } from "@/api/types/customer-intelligence";
import OpportunityCard from "./OpportunityCard";
import {
  formatDateTime, formatMoney, formatRelative, initialOf, outcomeStyles, stateStyles,
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
export default function CustomerDetailPage() {
  const { customerId = "" } = useParams();
  const navigate = useNavigate();
  const { t, i18n } = useTranslation();
  const [detail, setDetail] = useState<Customer360Detail | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error" | "notFound">("loading");

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
  const replyWindow = contactability.reason === "OPTED_OUT"
    ? t("customer360.detail.optedOut")
    : contactability.window_open
      ? t("customer360.detail.replyWindowOpen", { time: formatDateTime(contactability.window_closes_at, i18n.language) })
      : contactability.platform ? t("customer360.detail.replyWindowClosed") : null;
  const updateOpportunity = (updated: Opportunity) => setDetail((prev) => prev && ({
    ...prev,
    opportunities: prev.opportunities.map((o) => (o.id === updated.id ? updated : o)),
  }));

  return (
    <div className="em-customers min-h-full p-4 md:p-6">
      <div className="max-w-5xl mx-auto space-y-4">
        {back}

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
              <h1 className="text-xl md:text-2xl font-bold text-em-text-primary break-words">
                {customer.name || t("customer360.unknownName")}
              </h1>
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
              <dd>{customer.channel_type}{customer.page?.name ? ` · ${customer.page.name}` : ""}</dd>
            </div>
            <div className="flex items-center gap-2 text-em-text-primary">
              <Calendar className="w-4 h-4 text-em-text-secondary" aria-hidden="true" />
              <dt>{t("customer360.detail.firstSeen")}:</dt>
              <dd>{formatDateTime(customer.first_seen_at, i18n.language)}</dd>
            </div>
            <div className="flex items-center gap-2 text-em-text-primary">
              <Clock className="w-4 h-4 text-em-text-secondary" aria-hidden="true" />
              <dt>{t("customer360.detail.lastSeen")}:</dt>
              <dd>{formatRelative(customer.last_activity_at, i18n.language)}</dd>
            </div>
            {replyWindow && (
              <div className="flex items-center gap-2 text-em-text-primary" data-testid="reply-window">
                <MessageSquare className="w-4 h-4 text-em-text-secondary" aria-hidden="true" />
                <dd>{replyWindow}</dd>
              </div>
            )}
          </dl>
        </header>

        <Section title={t("customer360.detail.commerce")} testId="commerce-summary">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Stat label={t("customer360.detail.totalOrders")} value={summary.total_orders} />
            <Stat label={t("customer360.detail.delivered")} value={summary.delivered_orders} />
            <Stat label={t("customer360.detail.returned")} value={summary.returned_orders} />
            <Stat label={t("customer360.detail.cancelled")} value={summary.cancelled_orders} />
            <Stat label={t("customer360.detail.orderedValue")} value={formatMoney(summary.ordered_value, i18n.language)} />
            <Stat label={t("customer360.detail.deliveredValue")} value={formatMoney(summary.delivered_value, i18n.language)} />
            <Stat label={t("customer360.detail.lastOrder")} value={formatRelative(summary.last_order_at, i18n.language)} />
            <Stat label={t("customer360.detail.lastDelivery")} value={formatRelative(summary.last_delivered_at, i18n.language)} />
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
                  <span className="text-sm text-em-text-secondary">{formatDateTime(order.created_at, i18n.language)}</span>
                  <span className="text-sm font-medium tabular-nums">{formatMoney(order.total, i18n.language)}</span>
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
                    {formatDateTime(event.at, i18n.language)}
                    {event.approximate_time ? ` · ${t("customer360.timeline.approximate")}` : ""}
                  </p>
                </li>
              ))}
            </ol>
          )}
        </Section>
      </div>
    </div>
  );
}
