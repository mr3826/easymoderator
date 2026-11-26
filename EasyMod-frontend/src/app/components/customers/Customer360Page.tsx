import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ChevronLeft, ChevronRight, Loader2, Search, Sparkles, Users } from "lucide-react";
import { MotionConfig } from "motion/react";
import { listCustomers360, listOpportunities } from "@/api/domains/customer-intelligence";
import type { Customer360ListItem, Opportunity } from "@/api/types/customer-intelligence";
import { PageHeader } from "../dashboard/PageHeader";
import RtoNetworkSettings from "../RtoNetworkSettings";
import OpportunityCard from "./OpportunityCard";
import { formatMoney, formatRelative, initialOf, stateStyles } from "./customerDisplay";

const PAGE_SIZE = 20;
type Tab = "all" | "opportunities";
type ListStatus = { state: "loading" | "ready" | "error"; total: number };

function useDebounced<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

function Pagination({ page, total, onPage }: { page: number; total: number; onPage: (page: number) => void }) {
  const { t } = useTranslation();
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (total <= PAGE_SIZE) return null;
  const start = (page - 1) * PAGE_SIZE + 1;
  const end = Math.min(page * PAGE_SIZE, total);
  return (
    <nav className="flex items-center justify-between gap-3 mt-4" aria-label="pagination">
      <p className="text-sm text-em-text-secondary">{t("customer360.pagination", { start, end, total })}</p>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => onPage(page - 1)}
          disabled={page <= 1}
          aria-label={t("customer360.previous")}
          className="p-2 border border-em-border rounded-lg hover:bg-em-bg-muted disabled:opacity-40"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
        <span className="text-sm text-em-text-primary tabular-nums">{page} / {pages}</span>
        <button
          type="button"
          onClick={() => onPage(page + 1)}
          disabled={page >= pages}
          aria-label={t("customer360.next")}
          className="p-2 border border-em-border rounded-lg hover:bg-em-bg-muted disabled:opacity-40"
        >
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>
    </nav>
  );
}

function StateBadge({ customer }: { customer: Customer360ListItem }) {
  const { t } = useTranslation();
  const reason = customer.state_reasons?.[0];
  return (
    <span
      title={reason ? t(`customer360.stateReasons.${reason.code}`, reason.params ?? {}) : undefined}
      className={`inline-flex px-2.5 py-1 rounded-full text-xs font-semibold ${stateStyles[customer.state]}`}
    >
      {t(`customer360.states.${customer.state}`)}
    </span>
  );
}

function CustomerList({ search, onStatus }: { search: string; onStatus?: (status: ListStatus) => void }) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<Customer360ListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => setPage(1), [search]);
  useEffect(() => { onStatus?.({ state, total }); }, [state, total, onStatus]);

  const load = useCallback(async () => {
    setState("loading");
    try {
      const result = await listCustomers360({ page, pageSize: PAGE_SIZE, search: search || undefined });
      setRows(result.data);
      setTotal(result.total);
      setState("ready");
    } catch {
      setState("error");
    }
  }, [page, search]);

  useEffect(() => { void load(); }, [load]);

  if (state === "loading") {
    return (
      <div className="bg-em-bg-surface rounded-2xl border border-em-border p-10 text-center" role="status">
        <Loader2 className="w-8 h-8 animate-spin text-em-violet-700 mx-auto mb-3" />
        <p className="text-em-text-secondary">{t("customer360.loading")}</p>
      </div>
    );
  }
  if (state === "error") {
    return (
      <div className="bg-em-bg-surface rounded-2xl border border-em-danger-700/20 p-8 text-center" role="alert">
        <p className="text-em-danger-700 font-medium mb-3">{t("customer360.loadFailed")}</p>
        <button type="button" onClick={() => void load()} className="px-4 py-2 rounded-lg bg-em-midnight-900 text-white text-sm">
          {t("customer360.retry")}
        </button>
      </div>
    );
  }
  if (!rows.length) {
    return (
      <div className="bg-em-bg-surface rounded-2xl border border-em-border p-10 text-center">
        <Users className="w-12 h-12 text-em-text-secondary mx-auto mb-3" aria-hidden="true" />
        <p className="text-em-text-secondary">{search ? t("customer360.emptySearch") : t("customer360.empty")}</p>
      </div>
    );
  }

  const open = (id: string) => navigate(`/customers/${id}`);

  return (
    <>
      {/* Mobile: cards */}
      <ul className="md:hidden space-y-3" data-testid="customer-list-mobile">
        {rows.map((c) => (
          <li key={c.id}>
            <button
              type="button"
              onClick={() => open(c.id)}
              className="w-full text-left bg-em-bg-surface rounded-2xl border border-em-border shadow-sm p-4"
            >
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 shrink-0 rounded-full bg-em-bg-muted text-em-text-secondary font-semibold flex items-center justify-center">
                  {initialOf(c.name)}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-em-text-primary truncate">{c.name || t("customer360.unknownName")}</p>
                  <p className="text-xs text-em-text-secondary">{formatRelative(c.last_activity_at, i18n.language)}</p>
                </div>
                <StateBadge customer={c} />
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-em-text-primary">
                <span>{t("customer360.ordersCount", { delivered: c.delivered_orders, total: c.total_orders })}</span>
                <span className="font-medium">{formatMoney(c.delivered_value, i18n.language)}</span>
                {c.open_opportunity && (
                  <span className="inline-flex items-center gap-1 text-em-violet-700 font-medium">
                    <Sparkles className="w-3.5 h-3.5" aria-hidden="true" /> {t(`customer360.strength.${c.open_opportunity.strength}`)}
                  </span>
                )}
              </div>
            </button>
          </li>
        ))}
      </ul>

      {/* Desktop: table */}
      <div className="hidden md:block bg-em-bg-surface rounded-2xl shadow-sm border border-em-border overflow-hidden">
        <table className="w-full" data-testid="customer-table">
          <thead className="bg-em-bg-muted border-b border-em-border">
            <tr>
              {["customer", "state", "orders", "deliveredValue", "lastActivity", "opportunity"].map((col) => (
                <th key={col} scope="col" className="px-5 py-3 text-left text-xs font-semibold text-em-text-secondary uppercase tracking-wider">
                  {t(`customer360.columns.${col}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-em-border">
            {rows.map((c) => (
              <tr
                key={c.id}
                onClick={() => open(c.id)}
                className="hover:bg-em-bg-muted cursor-pointer"
                data-testid={`customer-row-${c.id}`}
              >
                <td className="px-5 py-3">
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 shrink-0 rounded-full bg-em-bg-muted text-em-text-secondary text-sm font-semibold flex items-center justify-center">
                      {initialOf(c.name)}
                    </div>
                    <div className="min-w-0">
                      <a
                        href={`/customers/${c.id}`}
                        onClick={(e) => { e.preventDefault(); open(c.id); }}
                        className="font-medium text-em-text-primary hover:text-em-violet-700 truncate block"
                      >
                        {c.name || t("customer360.unknownName")}
                      </a>
                      <p className="text-xs text-em-text-secondary">{c.phone || c.channel_type}</p>
                    </div>
                  </div>
                </td>
                <td className="px-5 py-3"><StateBadge customer={c} /></td>
                <td className="px-5 py-3 text-sm text-em-text-primary tabular-nums">
                  {t("customer360.ordersCount", { delivered: c.delivered_orders, total: c.total_orders })}
                </td>
                <td className="px-5 py-3 text-sm font-medium text-em-text-primary tabular-nums">
                  {formatMoney(c.delivered_value, i18n.language)}
                </td>
                <td className="px-5 py-3 text-sm text-em-text-secondary">{formatRelative(c.last_activity_at, i18n.language)}</td>
                <td className="px-5 py-3 text-sm">
                  {c.open_opportunity ? (
                    <span className="inline-flex items-center gap-1 text-em-violet-700 font-medium">
                      <Sparkles className="w-3.5 h-3.5" aria-hidden="true" /> {t(`customer360.strength.${c.open_opportunity.strength}`)}
                    </span>
                  ) : <span className="text-em-text-secondary">{t("customer360.never")}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pagination page={page} total={total} onPage={setPage} />
    </>
  );
}

function OpportunityList({ onCount }: { onCount: (n: number) => void }) {
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<Opportunity[]>([]);
  const [total, setTotal] = useState(0);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");

  const load = useCallback(async () => {
    setState("loading");
    try {
      const result = await listOpportunities({ status: "LIVE", page, pageSize: PAGE_SIZE });
      setRows(result.data);
      setTotal(result.total);
      onCount(result.total);
      setState("ready");
    } catch {
      setState("error");
    }
  }, [page, onCount]);

  useEffect(() => { void load(); }, [load]);

  if (state === "loading") {
    return (
      <div className="bg-em-bg-surface rounded-2xl border border-em-border p-10 text-center" role="status">
        <Loader2 className="w-8 h-8 animate-spin text-em-violet-700 mx-auto mb-3" />
      </div>
    );
  }
  if (state === "error") {
    return (
      <div className="bg-em-bg-surface rounded-2xl border border-em-danger-700/20 p-8 text-center" role="alert">
        <p className="text-em-danger-700 font-medium mb-3">{t("customer360.loadFailed")}</p>
        <button type="button" onClick={() => void load()} className="px-4 py-2 rounded-lg bg-em-midnight-900 text-white text-sm">
          {t("customer360.retry")}
        </button>
      </div>
    );
  }
  if (!rows.length) {
    return (
      <div className="bg-em-bg-surface rounded-2xl border border-em-border p-10 text-center">
        <Sparkles className="w-12 h-12 text-em-text-secondary mx-auto mb-3" aria-hidden="true" />
        <p className="text-em-text-secondary max-w-md mx-auto">{t("customer360.emptyOpportunities")}</p>
      </div>
    );
  }
  return (
    <>
      <div className="grid gap-3 lg:grid-cols-2" data-testid="opportunity-list">
        {rows.map((opportunity) => (
          <OpportunityCard
            key={opportunity.id}
            opportunity={opportunity}
            onChanged={(updated) => {
              const stillLive = updated.status === "OPEN" || updated.status === "ACTIONED";
              setRows((prev) => (stillLive
                ? prev.map((o) => (o.id === updated.id ? updated : o))
                : prev.filter((o) => o.id !== updated.id)));
              if (!stillLive) {
                const next = Math.max(0, total - 1);
                setTotal(next);
                onCount(next);
              }
            }}
          />
        ))}
      </div>
      <Pagination page={page} total={total} onPage={setPage} />
    </>
  );
}

/** Customer 360 Lite — shown when the shop has the customer intelligence pilot. */
export default function Customer360Page() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const tab: Tab = params.get("tab") === "opportunities" ? "opportunities" : "all";
  const [searchInput, setSearchInput] = useState("");
  const search = useDebounced(searchInput.trim());
  const [opportunityCount, setOpportunityCount] = useState<number | null>(null);
  const [listStatus, setListStatus] = useState<ListStatus>({ state: "loading", total: 0 });

  // Fetch the live count once so the tab badge is right before it is opened.
  useEffect(() => {
    listOpportunities({ status: "LIVE", page: 1, pageSize: 1 })
      .then((r) => setOpportunityCount(r.total))
      .catch(() => setOpportunityCount(null));
  }, []);

  const setTab = (next: Tab) => {
    const nextParams = new URLSearchParams(params);
    if (next === "all") nextParams.delete("tab"); else nextParams.set("tab", next);
    setParams(nextParams, { replace: true });
  };

  return (
    <MotionConfig reducedMotion="user">
    <div className="em-customers min-h-full p-4 md:p-6">
      <div className="mx-auto w-full max-w-[1440px] space-y-6">
        {/* Header-removal C1: signal band retired. This is the /customers
            title surface, so the compact heading stays; the live counts are
            already honest in the tab strip badges below. */}
        <PageHeader title={t("customer360.title")} />

        <RtoNetworkSettings />

        <div className="flex flex-col md:flex-row md:items-center gap-3 mb-5">
          <div role="tablist" aria-label={t("customer360.title")} className="inline-flex bg-em-bg-surface border border-em-border rounded-xl p-1 self-start">
            {(["all", "opportunities"] as Tab[]).map((key) => (
              <button
                key={key}
                id={`customers-tab-${key}`}
                type="button"
                role="tab"
                aria-selected={tab === key}
                aria-controls="customers-tabpanel"
                onClick={() => setTab(key)}
                data-testid={`customers-tab-${key}`}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                  tab === key ? "bg-em-violet-600 text-white" : "text-em-text-primary hover:bg-em-bg-muted"
                }`}
              >
                {t(`customer360.tabs.${key}`)}
                {/* Header-removal C4: the list total reads live here instead
                    of the retired header meta pills. */}
                {key === "all" && listStatus.state === "ready" && (
                  <span className={`ml-2 inline-flex min-w-[1.5rem] justify-center px-1.5 rounded-full text-xs ${
                    tab === key ? "bg-em-bg-surface/20" : "bg-em-success-100 text-em-success-700"
                  }`}>
                    {listStatus.total}
                  </span>
                )}
                {key === "opportunities" && opportunityCount !== null && (
                  <span className={`ml-2 inline-flex min-w-[1.5rem] justify-center px-1.5 rounded-full text-xs ${
                    tab === key ? "bg-em-bg-surface/20" : "bg-em-success-100 text-em-success-700"
                  }`}>
                    {opportunityCount}
                  </span>
                )}
              </button>
            ))}
          </div>
          {tab === "all" && (
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-em-text-secondary" aria-hidden="true" />
              <input
                type="search"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                placeholder={t("customer360.searchPlaceholder")}
                aria-label={t("customer360.searchPlaceholder")}
                maxLength={100}
                className="w-full pl-9 pr-3 py-2.5 border border-em-border rounded-xl bg-em-bg-surface focus:outline-none focus:ring-2 focus:ring-em-violet-600"
              />
            </div>
          )}
        </div>

        <div role="tabpanel" id="customers-tabpanel" aria-labelledby={`customers-tab-${tab}`}>
          {tab === "all" ? <CustomerList search={search} onStatus={setListStatus} /> : <OpportunityList onCount={setOpportunityCount} />}
        </div>
      </div>
    </div>
    </MotionConfig>
  );
}
