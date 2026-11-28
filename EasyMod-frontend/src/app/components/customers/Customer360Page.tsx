import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ChevronLeft, ChevronRight, Loader2, Pencil, Search, Sparkles, Trash2, UserPlus, Users, X } from "lucide-react";
import { MotionConfig } from "motion/react";
import { toast } from "sonner";
import { getCustomerOverview, listCustomers360, listOpportunities } from "@/api/domains/customer-intelligence";
import type { Customer360ListItem, CustomerOverview, Opportunity } from "@/api/types/customer-intelligence";
import type { ChannelType } from "@/api/types/customer";
import { apiClient } from "@/api";
import { useAuth } from "@/features/auth/AuthProvider";
import { getErrorMessage } from "@/shared/lib/http/errors";
import { PageHeader } from "../dashboard/PageHeader";
import { EmButton } from "../dashboard/EmButton";
import RtoNetworkSettings from "../RtoNetworkSettings";
import OpportunityCard from "./OpportunityCard";
import { formatCount, formatMoney, formatRelative, initialOf, stateStyles } from "./customerDisplay";
import { normalizeBengaliDigits } from "@/shared/lib/normalizeBengaliDigits";
import { CustomerDeleteDialog, CustomerRecordDialog, isDuplicateCustomerError, type CustomerRecordDraft } from "./CustomerRecordDialogs";

const PAGE_SIZE = 20;
type Tab = "all" | "opportunities";
type ListStatus = { state: "loading" | "ready" | "error"; total: number };
type OverviewState = { state: "loading" | "ready" | "error"; data: CustomerOverview | null };
type CustomerChannelFilter = ChannelType | "all";

const CUSTOMER_CHANNELS: ChannelType[] = ["facebook", "instagram", "messenger", "telegram", "webchat", "manual"];

function useDebounced<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

function Pagination({ page, total, onPage }: { page: number; total: number; onPage: (page: number) => void }) {
  const { t, i18n } = useTranslation();
  const language = i18n?.language ?? "en";
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (total <= PAGE_SIZE) return null;
  const start = (page - 1) * PAGE_SIZE + 1;
  const end = Math.min(page * PAGE_SIZE, total);
  return (
    <nav className="flex items-center justify-between gap-3 mt-4" aria-label="pagination">
      <p className="text-sm text-em-text-secondary">{t("customer360.pagination", {
        start: formatCount(start, language),
        end: formatCount(end, language),
        total: formatCount(total, language),
      })}</p>
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
        <span className="text-sm text-em-text-primary tabular-nums">{formatCount(page, language)} / {formatCount(pages, language)}</span>
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

function CustomerList({
  search,
  phone,
  channel,
  refreshKey,
  hasFilters,
  canDelete,
  onEdit,
  onDelete,
  onStatus,
}: {
  search: string;
  phone: string;
  channel: CustomerChannelFilter;
  refreshKey: number;
  hasFilters: boolean;
  canDelete: boolean;
  onEdit: (customer: Customer360ListItem) => void;
  onDelete: (customer: Customer360ListItem) => void;
  onStatus?: (status: ListStatus) => void;
}) {
  const { t, i18n } = useTranslation();
  const language = i18n?.language ?? "en";
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<Customer360ListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const requestRef = useRef(0);

  useEffect(() => setPage(1), [search, phone, channel]);
  useEffect(() => { onStatus?.({ state, total }); }, [state, total, onStatus]);

  const load = useCallback(async () => {
    const request = ++requestRef.current;
    setState("loading");
    try {
      const result = await listCustomers360({
        page,
        pageSize: PAGE_SIZE,
        search: search || undefined,
        phone: phone || undefined,
        channel_type: channel === "all" ? undefined : channel,
      });
      if (request !== requestRef.current) return;
      const lastPage = Math.max(1, Math.ceil(result.total / PAGE_SIZE));
      if (page > lastPage) {
        setPage(lastPage);
        return;
      }
      setRows(result.data);
      setTotal(result.total);
      setState("ready");
    } catch {
      if (request !== requestRef.current) return;
      setRows([]);
      setTotal(0);
      setState("error");
    }
  }, [page, search, phone, channel, refreshKey]);

  useEffect(() => {
    void load();
    return () => { requestRef.current += 1; };
  }, [load]);

  if (state === "loading") {
    return (
      <div className="rounded-2xl border border-em-border bg-em-bg-surface p-10 text-center" role="status">
        <Loader2 className="mx-auto mb-3 h-8 w-8 animate-spin text-em-violet-700" />
        <p className="text-em-text-secondary">{t("customer360.loading")}</p>
      </div>
    );
  }
  if (state === "error") {
    return (
      <div className="rounded-2xl border border-em-danger-700/20 bg-em-bg-surface p-8 text-center" role="alert">
        <p className="mb-3 font-medium text-em-danger-700">{t("customer360.loadFailed")}</p>
        <EmButton variant="secondary" onClick={() => void load()}>{t("customer360.retry")}</EmButton>
      </div>
    );
  }
  if (!rows.length) {
    return (
      <div className="rounded-2xl border border-em-border bg-em-bg-surface p-10 text-center">
        <Users className="mx-auto mb-3 h-12 w-12 text-em-text-secondary" aria-hidden="true" />
        <p className="text-em-text-secondary">{hasFilters ? t("customer360.emptySearch") : t("customer360.empty")}</p>
      </div>
    );
  }

  const open = (id: string) => navigate(`/customers/${encodeURIComponent(id)}`);
  const channelLabel = (value: ChannelType) => t(`customers.channels.${value}`, { defaultValue: value === "instagram" ? "Instagram" : value });
  const ordersCountLabel = (customer: Customer360ListItem) => t("customer360.ordersCount", {
    delivered: `${formatCount(customer.delivered_orders, language)}${customer.order_coverage?.complete === false ? "+" : ""}`,
    total: formatCount(customer.total_orders, language),
  });
  const partialOrderHistoryLabel = (customer: Customer360ListItem) => customer.order_coverage?.complete === false
    ? t("customer360.orderCoveragePartial", {
      scanned: formatCount(customer.order_coverage.scanned, language),
      total: formatCount(customer.order_coverage.total, language),
    })
    : null;
  const deliveredValueLabel = (customer: Customer360ListItem) =>
    `${formatMoney(customer.delivered_value, language)}${customer.order_coverage?.complete === false ? "+" : ""}`;

  return (
    <>
      <ul className="space-y-3 md:hidden" data-testid="customer-list-mobile">
        {rows.map((customer) => (
          <li key={customer.id} className="rounded-2xl border border-em-border bg-em-bg-surface shadow-sm">
            <button
              type="button"
              onClick={() => open(customer.id)}
              className="w-full rounded-t-2xl p-4 text-left focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-em-focus-light"
            >
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-em-bg-muted font-semibold text-em-text-secondary">{initialOf(customer.name)}</div>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-em-text-primary">{customer.name || t("customer360.unknownName")}</p>
                  <p className="truncate text-xs text-em-text-secondary">{customer.phone || channelLabel(customer.channel_type)}</p>
                </div>
                <StateBadge customer={customer} />
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-em-text-primary">
                <span>{ordersCountLabel(customer)}</span>
                {partialOrderHistoryLabel(customer) && <span className="basis-full text-xs text-em-warning-700">{partialOrderHistoryLabel(customer)}</span>}
                <span className="font-medium">{deliveredValueLabel(customer)}</span>
                {customer.open_opportunity && <span className="inline-flex items-center gap-1 font-medium text-em-violet-700"><Sparkles className="h-3.5 w-3.5" aria-hidden="true" />{t(`customer360.strength.${customer.open_opportunity.strength}`)}</span>}
              </div>
            </button>
            <div className="flex justify-end gap-1 border-t border-em-border px-2 py-1">
              <EmButton variant="ghost" onClick={() => onEdit(customer)}><Pencil className="h-4 w-4" aria-hidden="true" />{t("common.edit")}</EmButton>
              {canDelete && (
                <button type="button" onClick={() => onDelete(customer)} aria-label={t("customers.deleteModal.title")} className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg text-em-text-secondary hover:bg-em-danger-100 hover:text-em-danger-700 focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-em-focus-light">
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>

      <div className="hidden overflow-hidden rounded-2xl border border-em-border bg-em-bg-surface shadow-sm md:block">
        <div className="overflow-x-auto">
          <table className="w-full" data-testid="customer-table">
            <thead className="border-b border-em-border bg-em-bg-muted">
              <tr>
                {["customer", "state", "orders", "deliveredValue", "lastActivity", "opportunity"].map((column) => (
                  <th key={column} scope="col" className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-em-text-secondary">{t(`customer360.columns.${column}`)}</th>
                ))}
                <th scope="col" className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wider text-em-text-secondary">{t("customers.columns.actions")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-em-border">
              {rows.map((customer) => (
                <tr key={customer.id} data-testid={`customer-row-${customer.id}`} className="hover:bg-em-bg-muted">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-em-bg-muted text-sm font-semibold text-em-text-secondary">{initialOf(customer.name)}</div>
                      <div className="min-w-0">
                        <button type="button" onClick={() => open(customer.id)} className="block max-w-[16rem] truncate text-left font-medium text-em-text-primary hover:text-em-violet-700 focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-em-focus-light">{customer.name || t("customer360.unknownName")}</button>
                        <p className="truncate text-xs text-em-text-secondary">{customer.phone || channelLabel(customer.channel_type)}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3"><StateBadge customer={customer} /></td>
                  <td className="px-4 py-3 text-sm tabular-nums text-em-text-primary">
                    <span>{ordersCountLabel(customer)}</span>
                    {partialOrderHistoryLabel(customer) && <span className="block text-xs text-em-warning-700">{partialOrderHistoryLabel(customer)}</span>}
                  </td>
                  <td className="px-4 py-3 text-sm font-medium tabular-nums text-em-text-primary">{deliveredValueLabel(customer)}</td>
                  <td className="px-4 py-3 text-sm text-em-text-secondary">{formatRelative(customer.last_activity_at, language)}</td>
                  <td className="px-4 py-3 text-sm">{customer.open_opportunity ? <span className="inline-flex items-center gap-1 font-medium text-em-violet-700"><Sparkles className="h-3.5 w-3.5" aria-hidden="true" />{t(`customer360.strength.${customer.open_opportunity.strength}`)}</span> : <span className="text-em-text-secondary">{t("customer360.never")}</span>}</td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-1">
                      <EmButton variant="ghost" onClick={() => onEdit(customer)}><Pencil className="h-4 w-4" aria-hidden="true" />{t("common.edit")}</EmButton>
                      {canDelete && <button type="button" onClick={() => onDelete(customer)} aria-label={t("customers.deleteModal.title")} className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg text-em-text-secondary hover:bg-em-danger-100 hover:text-em-danger-700 focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-em-focus-light"><Trash2 className="h-4 w-4" aria-hidden="true" /></button>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <Pagination page={page} total={total} onPage={setPage} />
    </>
  );
}

function OpportunityList({ onCount }: { onCount: (n: number | null) => void }) {
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<Opportunity[]>([]);
  const [total, setTotal] = useState(0);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");

  const load = useCallback(async () => {
    setState("loading");
    onCount(null);
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
  const { t, i18n } = useTranslation();
  const language = i18n?.language ?? "en";
  const [params, setParams] = useSearchParams();
  const { currentShop } = useAuth();
  const canDelete = ["owner", "admin"].includes(String(currentShop?.role ?? "").toLowerCase());
  const tab: Tab = params.get("tab") === "opportunities" ? "opportunities" : "all";
  const [searchInput, setSearchInput] = useState("");
  const [phoneInput, setPhoneInput] = useState("");
  const [channelFilter, setChannelFilter] = useState<CustomerChannelFilter>("all");
  const search = useDebounced(searchInput.trim());
  const phone = useDebounced(phoneInput.trim());
  const [opportunityCount, setOpportunityCount] = useState<number | null>(null);
  const [listStatus, setListStatus] = useState<ListStatus>({ state: "loading", total: 0 });
  const [overviewState, setOverviewState] = useState<OverviewState>({ state: "loading", data: null });
  const overviewRequestRef = useRef(0);
  const [overviewRefresh, setOverviewRefresh] = useState(0);
  const [refreshKey, setRefreshKey] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  const [editingCustomer, setEditingCustomer] = useState<Customer360ListItem | null>(null);
  const [deleteCustomer, setDeleteCustomer] = useState<Customer360ListItem | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const loadOverview = useCallback(async () => {
    const request = ++overviewRequestRef.current;
    setOverviewState({ state: "loading", data: null });
    try {
      const data = await getCustomerOverview();
      if (request === overviewRequestRef.current) setOverviewState({ state: "ready", data });
    } catch {
      if (request === overviewRequestRef.current) setOverviewState({ state: "error", data: null });
    }
  }, []);

  useEffect(() => {
    void loadOverview();
    return () => { overviewRequestRef.current += 1; };
  }, [loadOverview, overviewRefresh]);

  const handleSaveCustomer = async (draft: CustomerRecordDraft) => {
    setSaving(true);
    setFormError(null);
    try {
      if (editingCustomer) {
        await apiClient.updateCustomer(editingCustomer.id, {
          name: draft.name,
          number: draft.phone,
          email: draft.email.trim() || null,
        });
        setEditingCustomer(null);
        toast.success(t("customers.success.updated"));
      } else {
        await apiClient.createCustomer({
          name: draft.name,
          number: draft.phone,
          email: draft.email || undefined,
          channel: draft.channel as ChannelType,
        });
        setCreateOpen(false);
        toast.success(t("customers.success.created"));
      }
      setOpportunityCount(null);
      setRefreshKey((key) => key + 1);
      setOverviewRefresh((key) => key + 1);
    } catch (error: unknown) {
      const message = isDuplicateCustomerError(error)
        ? t("customers.errors.duplicatePhone", { defaultValue: "A customer with this phone number already exists." })
        : getErrorMessage(error, t(editingCustomer ? "customers.errors.updateFailed" : "customers.errors.createFailed"));
      setFormError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteCustomer = async () => {
    if (!deleteCustomer) return;
    setSaving(true);
    try {
      await apiClient.deleteCustomer(deleteCustomer.id);
      setDeleteCustomer(null);
      setOpportunityCount(null);
      setRefreshKey((key) => key + 1);
      setOverviewRefresh((key) => key + 1);
      toast.success(t("customers.success.deleted"));
    } catch (error: unknown) {
      toast.error(getErrorMessage(error, t("customers.errors.deleteFailed")));
    } finally {
      setSaving(false);
    }
  };

  const setTab = (next: Tab) => {
    const nextParams = new URLSearchParams(params);
    if (next === "all") nextParams.delete("tab"); else nextParams.set("tab", next);
    setParams(nextParams, { replace: true });
  };

  const hasFilters = Boolean(searchInput.trim() || phoneInput.trim() || channelFilter !== "all");
  const openOpportunityCount = opportunityCount ?? (overviewState.state === "ready"
    ? overviewState.data?.open_opportunities ?? null
    : null);
  const overviewCards = overviewState.data ? [
    { key: "totalRecords", label: "Customers", value: overviewState.data.total_records, definition: undefined, bounded: false },
    { key: "buyers", label: "Buyers", value: overviewState.data.buyers, definition: overviewState.data.definitions.buyers, bounded: true },
    { key: "repeatBuyers", label: "Repeat buyers", value: overviewState.data.repeat_buyers, definition: overviewState.data.definitions.repeat_buyers, bounded: true },
    { key: "newBuyers", label: "New buyers", value: overviewState.data.new_buyers, definition: overviewState.data.definitions.new_buyers, bounded: true },
    { key: "openOpportunities", label: "Open opportunities", value: overviewState.data.open_opportunities, definition: overviewState.data.definitions.open_opportunities, bounded: false },
  ] : [];

  return (
    <MotionConfig reducedMotion="user">
    <div className="em-customers min-h-full p-4 md:p-6">
      <div className="mx-auto w-full max-w-[1440px] space-y-6">
        {/* Header-removal C1 amendment (unified title rule): this <h1> renders
            customer360.title = "Customers"/"কাস্টমার" — byte-identical to the
            sticky AppBar's nav.customers in BOTH locales — so it is sr-only
            (landmark kept, no visible duplicate). Signal band stays retired;
            live counts are honest in the tab strip badges below. */}
        <PageHeader title={t("customer360.title")} titleMode="srOnly" />

        <RtoNetworkSettings />

        <section aria-labelledby="customer-overview-heading" data-testid="customer-overview">
          <h2 id="customer-overview-heading" className="mb-3 text-base font-semibold text-em-text-primary">
            {t("customer360.overview.title", { defaultValue: "Customer overview" })}
          </h2>
          {overviewState.state === "loading" && (
            <div role="status" className="rounded-xl border border-em-border bg-em-bg-surface p-4 text-sm text-em-text-secondary">
              {t("customer360.loading")}
            </div>
          )}
          {overviewState.state === "error" && (
            <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-em-danger-700/20 bg-em-danger-100 p-4">
              <p className="text-sm font-medium text-em-danger-700">{t("customer360.overview.unavailable", { defaultValue: "Customer overview is unavailable. Counts are not shown." })}</p>
              <EmButton variant="secondary" onClick={() => void loadOverview()}>{t("customer360.retry")}</EmButton>
            </div>
          )}
          {overviewState.state === "ready" && overviewState.data && (
            <>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
                {overviewCards.map((card) => (
                  <article key={card.key} title={card.definition} className="rounded-xl border border-em-border bg-em-bg-surface p-3">
                    <p className="text-xs text-em-text-secondary">{t(`customer360.overview.${card.key}`, { defaultValue: card.label })}</p>
                    <p className="mt-1 text-xl font-semibold tabular-nums text-em-text-primary">
                      {card.value === null
                        ? t("customer360.overview.metricUnavailable", { defaultValue: "Unavailable" })
                        : `${formatCount(card.value, language)}${card.bounded && !overviewState.data?.coverage_complete ? "+" : ""}`}
                    </p>
                    {card.definition && (
                      <p className="mt-1 text-xs text-em-text-secondary">
                        {t(`customer360.overview.definitions.${card.key}`, { defaultValue: card.definition })}
                      </p>
                    )}
                  </article>
                ))}
              </div>
              <p className="mt-2 text-xs text-em-text-secondary">
                {overviewState.data.coverage_complete
                  ? t("customer360.overview.coverageComplete", { defaultValue: "Order coverage is complete." })
                  : t("customer360.overview.coveragePartial", { defaultValue: "Order coverage is partial." })}
                {" "}{t("customer360.overview.ordersScanned", {
                  defaultValue: "Scanned {{scanned}} of {{total}} linked orders (scan cap {{cap}}).",
                  scanned: formatCount(overviewState.data.scanned_orders, language),
                  total: formatCount(overviewState.data.total_linked_orders, language),
                  cap: formatCount(overviewState.data.order_scan_cap, language),
                })}
              </p>
            </>
          )}
        </section>

        <div className="space-y-3">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div role="tablist" aria-label={t("customer360.title")} className="inline-flex self-start rounded-xl border border-em-border bg-em-bg-surface p-1">
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
                    {formatCount(listStatus.total, language)}
                  </span>
                )}
                {key === "opportunities" && openOpportunityCount !== null && (
                  <span className={`ml-2 inline-flex min-w-[1.5rem] justify-center px-1.5 rounded-full text-xs ${
                    tab === key ? "bg-em-bg-surface/20" : "bg-em-success-100 text-em-success-700"
                  }`}>
                    {formatCount(openOpportunityCount, language)}
                  </span>
                )}
              </button>
            ))}
          </div>
          {tab === "all" && (
            <EmButton variant="primary" onClick={() => { setFormError(null); setCreateOpen(true); }} className="gap-2">
              <UserPlus className="h-4 w-4" aria-hidden="true" />{t("customers.addCustomer")}
            </EmButton>
          )}
          </div>
          {tab === "all" && (
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-[minmax(14rem,1fr)_minmax(14rem,1fr)_12rem_auto]">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-em-text-secondary" aria-hidden="true" />
                <input
                  type="search"
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  placeholder={t("customers.searchNamePlaceholder")}
                  aria-label={t("customers.searchNamePlaceholder")}
                  maxLength={100}
                  className="min-h-11 w-full rounded-xl border border-em-border bg-em-bg-surface py-2 pl-9 pr-3 text-sm focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-em-focus-light"
                />
              </div>
              <div className="relative">
                <input
                  type="search"
                  inputMode="tel"
                  value={phoneInput}
                  onChange={(event) => setPhoneInput(normalizeBengaliDigits(event.target.value).replace(/[^\d+]/g, "").slice(0, 17))}
                  placeholder={t("customers.searchPhonePlaceholder")}
                  aria-label={t("customers.searchPhonePlaceholder")}
                  maxLength={17}
                  className="min-h-11 w-full rounded-xl border border-em-border bg-em-bg-surface px-3 py-2 text-sm tabular-nums focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-em-focus-light"
                />
              </div>
              <select
                value={channelFilter}
                onChange={(event) => setChannelFilter(event.target.value as CustomerChannelFilter)}
                aria-label={t("customers.allChannels")}
                className="min-h-11 w-full rounded-xl border border-em-border bg-em-bg-surface px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-em-focus-light"
              >
                <option value="all">{t("customers.allChannels")}</option>
                {CUSTOMER_CHANNELS.map((channel) => <option key={channel} value={channel}>{t(`customers.channels.${channel}`, { defaultValue: channel === "instagram" ? "Instagram" : channel })}</option>)}
              </select>
              {hasFilters && (
                <EmButton variant="secondary" onClick={() => { setSearchInput(""); setPhoneInput(""); setChannelFilter("all"); }} className="gap-1.5">
                  <X className="h-4 w-4" aria-hidden="true" />{t("customers.clearFilters")}
                </EmButton>
              )}
            </div>
          )}
        </div>

        <div role="tabpanel" id="customers-tabpanel" aria-labelledby={`customers-tab-${tab}`}>
          {tab === "all" ? (
            <CustomerList
              search={search}
              phone={phone}
              channel={channelFilter}
              refreshKey={refreshKey}
              hasFilters={hasFilters}
              canDelete={canDelete}
              onEdit={(customer) => {
                setCreateOpen(false);
                setFormError(null);
                setEditingCustomer(customer);
              }}
              onDelete={setDeleteCustomer}
              onStatus={setListStatus}
            />
          ) : <OpportunityList onCount={setOpportunityCount} />}
        </div>
      </div>
    </div>
    <CustomerRecordDialog
      mode={editingCustomer ? "edit" : "create"}
      open={createOpen || Boolean(editingCustomer)}
      initial={editingCustomer ? { id: editingCustomer.id, name: editingCustomer.name, phone: editingCustomer.phone, email: editingCustomer.email, channel: editingCustomer.channel_type } : undefined}
      saving={saving}
      error={formError}
      onClose={() => { setCreateOpen(false); setEditingCustomer(null); setFormError(null); }}
      onSave={(draft) => void handleSaveCustomer(draft)}
    />
    <CustomerDeleteDialog
      open={Boolean(deleteCustomer)}
      deleting={saving}
      customerName={deleteCustomer?.name}
      onClose={() => setDeleteCustomer(null)}
      onConfirm={() => void handleDeleteCustomer()}
    />
    </MotionConfig>
  );
}
