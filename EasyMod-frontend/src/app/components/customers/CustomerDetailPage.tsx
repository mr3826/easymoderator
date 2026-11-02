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
    <div className="rounded-xl bg-gray-50 border border-gray-100 p-3">
      <p className="text-xs text-gray-500">{label}</p>
      <p className="text-lg font-semibold text-gray-900 tabular-nums mt-0.5">{value}</p>
    </div>
  );
}

function Section({ title, children, testId }: { title: string; children: React.ReactNode; testId?: string }) {
  return (
    <section className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4 md:p-5" data-testid={testId}>
      <h2 className="text-base font-semibold text-gray-900 mb-3">{title}</h2>
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
    <Link to="/customers" className="inline-flex items-center gap-2 text-sm text-gray-600 hover:text-gray-900 mb-4">
      <ArrowLeft className="w-4 h-4" aria-hidden="true" /> {t("customer360.actions.back")}
    </Link>
  );

  if (state === "loading") {
    return (
      <div className="min-h-screen p-4 md:p-6"><div className="max-w-5xl mx-auto">{back}
        <div className="bg-white rounded-2xl border border-gray-100 p-10 text-center" role="status">
          <Loader2 className="w-8 h-8 animate-spin text-brand-hover mx-auto" />
        </div>
      </div></div>
    );
  }
  if (state !== "ready" || !detail) {
    return (
      <div className="min-h-screen p-4 md:p-6"><div className="max-w-5xl mx-auto">{back}
        <div className="bg-white rounded-2xl border border-red-100 p-8 text-center" role="alert">
          <p className="text-red-800 font-medium mb-3">
            {state === "notFound" ? t("customer360.detail.notFound") : t("customer360.detail.loadFailed")}
          </p>
          {state === "error" && (
            <button type="button" onClick={() => void load()} className="px-4 py-2 rounded-lg bg-gray-900 text-white text-sm">
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
    <div className="min-h-screen bg-gradient-to-br from-gray-50 to-gray-100 p-4 md:p-6">
      <div className="max-w-5xl mx-auto space-y-4">
        {back}

        <header className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4 md:p-5" data-testid="customer-header">
          <div className="flex flex-wrap items-start gap-4">
            {customer.profile_pic ? (
              <img src={customer.profile_pic} alt="" className="w-14 h-14 rounded-full object-cover" referrerPolicy="no-referrer" />
            ) : (
              <div className="w-14 h-14 rounded-full bg-gradient-to-br from-blue-500 to-purple-500 text-white text-xl font-bold flex items-center justify-center">
                {initialOf(customer.name)}
              </div>
            )}
            <div className="min-w-0 flex-1">
              <h1 className="text-xl md:text-2xl font-bold text-gray-900 break-words">
                {customer.name || t("customer360.unknownName")}
              </h1>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <span className={`inline-flex px-2.5 py-1 rounded-full text-xs font-semibold ${stateStyles[detail.state]}`} data-testid="customer-state">
                  {t(`customer360.states.${detail.state}`)}
                </span>
                {reason && (
                  <span className="text-xs text-gray-600">{t(`customer360.stateReasons.${reason.code}`, reason.params ?? {})}</span>
                )}
              </div>
            </div>
          </div>
          <dl className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-sm">
            <div className="flex items-center gap-2 text-gray-700">
              <Phone className="w-4 h-4 text-gray-400" aria-hidden="true" />
              <dt className="sr-only">{t("customer360.detail.phone")}</dt>
              <dd>{customer.phone || t("customer360.detail.notProvided")}</dd>
            </div>
            <div className="flex items-center gap-2 text-gray-700">
              <Mail className="w-4 h-4 text-gray-400" aria-hidden="true" />
              <dt className="sr-only">{t("customer360.detail.email")}</dt>
              <dd className="break-all">{customer.email || t("customer360.detail.notProvided")}</dd>
            </div>
            <div className="flex items-center gap-2 text-gray-700">
              <MessageSquare className="w-4 h-4 text-gray-400" aria-hidden="true" />
              <dt className="sr-only">{t("customer360.detail.channel")}</dt>
              <dd>{customer.channel_type}{customer.page?.name ? ` · ${customer.page.name}` : ""}</dd>
            </div>
            <div className="flex items-center gap-2 text-gray-700">
              <Calendar className="w-4 h-4 text-gray-400" aria-hidden="true" />
              <dt>{t("customer360.detail.firstSeen")}:</dt>
              <dd>{formatDateTime(customer.first_seen_at, i18n.language)}</dd>
            </div>
            <div className="flex items-center gap-2 text-gray-700">
              <Clock className="w-4 h-4 text-gray-400" aria-hidden="true" />
              <dt>{t("customer360.detail.lastSeen")}:</dt>
              <dd>{formatRelative(customer.last_activity_at, i18n.language)}</dd>
            </div>
            {replyWindow && (
              <div className="flex items-center gap-2 text-gray-700" data-testid="reply-window">
                <MessageSquare className="w-4 h-4 text-gray-400" aria-hidden="true" />
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
          <p className="text-xs text-gray-500 mt-3">{t("customer360.detail.valueNote")}</p>
        </Section>

        <Section title={t("customer360.detail.rto")} testId="rto-signal">
          {!rto.available ? (
            <p className="text-sm text-gray-600">{t("customer360.detail.rtoUnavailable")}</p>
          ) : (
            <div className="flex items-start gap-3">
              {rto.tier === "clear"
                ? <ShieldCheck className="w-5 h-5 text-emerald-600 shrink-0" aria-hidden="true" />
                : <ShieldAlert className="w-5 h-5 text-amber-600 shrink-0" aria-hidden="true" />}
              <div className="text-sm">
                <p className="font-medium text-gray-900">{t(`customer360.detail.rtoTier.${rto.tier}`)}</p>
                {rto.network && rto.network.shops_reported > 0 && (
                  <p className="text-gray-600 mt-0.5">
                    {t("customer360.detail.rtoNetwork", { shops: rto.network.shops_reported, attempts: rto.network.total_attempts })}
                  </p>
                )}
              </div>
            </div>
          )}
        </Section>

        <Section title={t("customer360.detail.opportunities")} testId="customer-opportunities">
          {detail.opportunities.length === 0 ? (
            <p className="text-sm text-gray-600">{t("customer360.detail.noOpportunities")}</p>
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
            <p className="text-sm text-gray-600">{t("customer360.detail.noOrders")}</p>
          ) : (
            <ul className="divide-y divide-gray-100">
              {detail.orders.map((order) => (
                <li key={order.id} className="py-3 flex flex-wrap items-center gap-x-4 gap-y-1">
                  <button
                    type="button"
                    onClick={() => navigate(`/orders?orderId=${encodeURIComponent(order.id)}`)}
                    className="font-medium text-gray-900 hover:text-brand-hover"
                  >
                    #{order.order_number ?? order.id.slice(0, 8)}
                  </button>
                  <span className="text-sm text-gray-600">{formatDateTime(order.created_at, i18n.language)}</span>
                  <span className="text-sm font-medium tabular-nums">{formatMoney(order.total, i18n.language)}</span>
                  <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${outcomeStyles[order.outcome]}`}>
                    {t(`customer360.detail.outcome.${order.outcome}`)}
                  </span>
                  {order.link === "PHONE_MATCH" && (
                    <span
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-gray-100 text-gray-600"
                      title={t("customer360.detail.matchedByPhoneHelp")}
                    >
                      <Link2 className="w-3 h-3" aria-hidden="true" /> {t("customer360.detail.matchedByPhone")}
                    </span>
                  )}
                  {order.confidence && (
                    <span className="px-2 py-0.5 rounded-full text-xs bg-emerald-50 text-emerald-700">
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
            <p className="text-sm text-gray-600">{t("customer360.detail.noTimeline")}</p>
          ) : (
            <ol className="relative border-l border-gray-200 ml-2 space-y-4">
              {detail.timeline.map((event, index) => (
                <li key={`${event.type}-${event.at}-${index}`} className="ml-4">
                  <span className="absolute -left-1.5 mt-1.5 w-3 h-3 rounded-full bg-blue-200 border border-white" aria-hidden="true" />
                  <p className="text-sm text-gray-900">{timelineLabel(event, t)}</p>
                  <p className="text-xs text-gray-500">
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
