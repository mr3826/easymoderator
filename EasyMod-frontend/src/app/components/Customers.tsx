import { useState, useEffect, useRef } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from 'react-i18next';
import { MotionConfig } from "motion/react";
import {
  Users,
  Search,
  X,
  Trash2,
  ChevronLeft,
  ChevronRight,
  UserPlus,
  Phone,
  Mail,
  MessageSquare,
  Calendar,
  PackageSearch,
  Loader2
} from "lucide-react";
import { toast } from "sonner";
import { apiClient } from "@/api";
import type { ChannelType as ApiChannelType, Customer, CustomerFilters } from "@/api/types/customer";
import RtoNetworkSettings from './RtoNetworkSettings';
import { getErrorMessage } from "@shared/lib/http/errors";
import { getPilotStatus } from "@/api/domains/customer-intelligence";
import { useAuth } from "@/features/auth/AuthProvider";
import { EmButton } from "./dashboard/EmButton";
import { PageHeader } from "./dashboard/PageHeader";
import { useDialogFocus } from "./inbox/useDialogFocus";
import Customer360Page from "./customers/Customer360Page";
import CustomerCRMPanel from "./customers/CustomerCRMPanel";
import { formatCount } from "./customers/customerDisplay";
import { normalizeBengaliDigits } from "@/shared/lib/normalizeBengaliDigits";
import { CustomerDeleteDialog, CustomerRecordDialog, isDuplicateCustomerError, type CustomerRecordDraft } from "./customers/CustomerRecordDialogs";

type CustomerChannelFilter = ApiChannelType | 'all';

const channelConfig: Record<string, { icon: any; color: string; bgColor: string; labelKey: string }> = {
  facebook:  { icon: MessageSquare, color: "text-em-info-700",   bgColor: "bg-em-info-100",   labelKey: "customers.channels.facebook" },
  instagram: { icon: MessageSquare, color: "text-em-info-700",   bgColor: "bg-em-info-100",   labelKey: "customers.channels.instagram" },
  messenger: { icon: MessageSquare, color: "text-em-info-700",   bgColor: "bg-em-info-100",   labelKey: "customers.channels.messenger" },
  webchat:   { icon: MessageSquare, color: "text-em-violet-700", bgColor: "bg-em-violet-100", labelKey: "customers.channels.webchat" },
  telegram:  { icon: MessageSquare, color: "text-em-info-700",    bgColor: "bg-em-info-100",    labelKey: "customers.channels.telegram" },
  manual:    { icon: UserPlus,      color: "text-em-text-secondary",   bgColor: "bg-em-bg-muted",   labelKey: "customers.channels.manual" },
};

const CUSTOMER_CHANNELS: ApiChannelType[] = ['facebook', 'instagram', 'messenger', 'telegram', 'webchat', 'manual'];
const channelFallback = (channel: string) => channel === 'instagram' ? 'Instagram' : channel;
const toCustomerChannel = (value: string): ApiChannelType | "" =>
  CUSTOMER_CHANNELS.includes(value as ApiChannelType) ? (value as ApiChannelType) : "";
const toCustomerChannelFilter = (value: string): CustomerChannelFilter =>
  value === "all" ? "all" : toCustomerChannel(value) || "all";

const PAGE_SIZE = 20;

const nameInitial = (name: string | null | undefined) =>
  (name ?? '?').charAt(0).toUpperCase();

/**
 * The API returns `phone` / `channel_type`; this page was written against
 * `number` / `channel`, so phone showed "—" and channel badges fell back.
 * Normalise at the boundary so the legacy page renders real values.
 */
export const normalizeLegacyCustomer = (customer: Customer): Customer => {
  const raw = customer as Customer & { phone?: string | null; channel_type?: ApiChannelType };
  const number = customer.number?.trim() || raw.phone?.trim() || '';
  const channel = CUSTOMER_CHANNELS.includes((customer.channel || raw.channel_type) as ApiChannelType)
    ? ((customer.channel || raw.channel_type) as ApiChannelType)
    : 'manual';
  return { ...customer, number, channel };
};

const formatDate = (value: string | undefined, language: string) =>
  value ? new Date(value).toLocaleDateString(language === 'bn' ? 'bn-BD' : 'en-US', {
    year: 'numeric', month: 'short', day: 'numeric',
  }) : '—';

function LegacyCustomers({ routeCustomerId }: { routeCustomerId?: string }) {
  const { t, i18n } = useTranslation();
  const language = i18n?.language ?? 'en';
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const linkedCustomerId = routeCustomerId || searchParams.get("customerId");
  const { currentShop } = useAuth();
  // Server-side enforcement lives in customer.service.deleteCustomer
  // (owner/admin only). This only avoids offering a doomed action.
  const canDelete = ["owner", "admin"].includes(String(currentShop?.role || "").toLowerCase());

  // Inbox deep links carry the exact customer ID. Resolve it through the
  // existing shop-scoped endpoint before opening the legacy detail drawer.
  useEffect(() => {
    if (!linkedCustomerId) return;
    let cancelled = false;
    apiClient.getCustomer(linkedCustomerId)
      .then((customer) => {
        if (!cancelled) setSelectedCustomer(normalizeLegacyCustomer(customer));
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        toast.error(getErrorMessage(err, t("customers.errors.fetchFailed")));
        const next = new URLSearchParams(searchParams);
        next.delete("customerId");
        setSearchParams(next, { replace: true });
      });
    return () => { cancelled = true; };
  }, [linkedCustomerId, searchParams, setSearchParams, t]);

  const closeCustomerDetails = () => {
    setSelectedCustomer(null);
    if (routeCustomerId) {
      navigate('/customers');
      return;
    }
    if (!searchParams.has("customerId")) return;
    const next = new URLSearchParams(searchParams);
    next.delete("customerId");
    setSearchParams(next, { replace: true });
  };

  // Table data — one authoritative query. Whole-queue summaries were removed:
  // the separate count fetches went stale after create/delete and were not
  // tied to the active filters (E-007). The server `total` for the current
  // query is shown with pagination instead.
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [tableTotal, setTableTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const customersRequestRef = useRef(0);

  // Filters and pagination. `search` matches NAME only on this endpoint;
  // phone is a separate supported filter — the labels must not promise more
  // than the server actually queries.
  const [searchQuery, setSearchQuery] = useState("");
  const [phoneQuery, setPhoneQuery] = useState("");
  const [channelFilter, setChannelFilter] = useState<CustomerChannelFilter>("all");
  const [currentPage, setCurrentPage] = useState(1);

  // UI state
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [showCreateCustomer, setShowCreateCustomer] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState<string | null>(null);
  const [editingCustomer, setEditingCustomer] = useState<Customer | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const closeRecordDialog = () => {
    setShowCreateCustomer(false);
    setEditingCustomer(null);
    setFormError(null);
  };

  const hasActiveQuery = Boolean(searchQuery || phoneQuery || channelFilter !== 'all');

  // ── Table fetch — server-side, debounced search ───────────────────────────
  useEffect(() => {
    const timer = setTimeout(() => {
      fetchCustomers();
    }, (searchQuery || phoneQuery) ? 300 : 0);
    return () => {
      clearTimeout(timer);
      customersRequestRef.current += 1;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery, phoneQuery, channelFilter, currentPage]);

  const fetchCustomers = async () => {
    const request = ++customersRequestRef.current;
    try {
      setIsLoading(true);
      setError(null);
      const filters: CustomerFilters = { page: currentPage, pageSize: PAGE_SIZE };
      if (searchQuery) filters.search = searchQuery;
      if (phoneQuery) filters.phone = phoneQuery;
      if (channelFilter !== 'all') filters.channel_type = channelFilter;

      const result = await apiClient.getCustomers(filters);
      if (request !== customersRequestRef.current) return;
      const resultTotal = result?.total ?? 0;
      setTableTotal(resultTotal);
      const lastPage = Math.max(1, Math.ceil(resultTotal / PAGE_SIZE));
      if (currentPage > lastPage) {
        setCurrentPage(lastPage);
        return;
      }
      // Guard against a malformed/empty payload so a shape drift degrades to an
      // empty table rather than crashing the page on `customers.length`.
      setCustomers((result?.data ?? []).map(normalizeLegacyCustomer));
    } catch (err: any) {
      if (request !== customersRequestRef.current) return;
      setError(err.message || t('customers.errors.fetchFailed'));
      setCustomers([]);
      setTableTotal(0);
    } finally {
      if (request === customersRequestRef.current) setIsLoading(false);
    }
  };

  const handleSearchChange = (value: string) => {
    setSearchQuery(value);
    setCurrentPage(1);
  };

  const handlePhoneChange = (value: string) => {
    setPhoneQuery(normalizeBengaliDigits(value));
    setCurrentPage(1);
  };

  const handleChannelChange = (value: CustomerChannelFilter) => {
    setChannelFilter(value);
    setCurrentPage(1);
  };

  const clearQuery = () => {
    setSearchQuery("");
    setPhoneQuery("");
    setChannelFilter("all");
    setCurrentPage(1);
  };

  const totalPages = Math.ceil(tableTotal / PAGE_SIZE);
  const startIndex = (currentPage - 1) * PAGE_SIZE + 1;
  const endIndex = Math.min(currentPage * PAGE_SIZE, tableTotal);

  // ── Mutations ──────────────────────────────────────────────────────────────

  const handleSaveCustomer = async (draft: CustomerRecordDraft) => {
    if (!draft.name || !draft.phone || (!editingCustomer && !draft.channel)) {
      toast.error(t('customers.errors.requiredFields'));
      return;
    }
    try {
      setIsSubmitting(true);
      setFormError(null);
      if (editingCustomer) {
        const updated = await apiClient.updateCustomer(editingCustomer.id, {
          name: draft.name,
          number: draft.phone,
          email: draft.email.trim() || null,
        });
        const normalized = normalizeLegacyCustomer(updated);
        setSelectedCustomer((current) => current?.id === normalized.id ? normalized : current);
        setEditingCustomer(null);
        toast.success(t('customers.success.updated'));
      } else {
        await apiClient.createCustomer({
          name: draft.name,
          number: draft.phone,
          email: draft.email || undefined,
          channel: draft.channel as ApiChannelType,
        });
        setShowCreateCustomer(false);
        toast.success(t('customers.success.created'));
      }
      void fetchCustomers();
    } catch (err: unknown) {
      const message = isDuplicateCustomerError(err)
        ? t('customers.errors.duplicatePhone', { defaultValue: 'A customer with this phone number already exists.' })
        : getErrorMessage(err, t(editingCustomer ? 'customers.errors.updateFailed' : 'customers.errors.createFailed'));
      setFormError(message);
      toast.error(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDeleteCustomer = async (customerId: string) => {
    try {
      setIsSubmitting(true);
      await apiClient.deleteCustomer(customerId);
      setShowDeleteConfirm(null);
      if (selectedCustomer?.id === customerId) {
        setSelectedCustomer(null);
        if (routeCustomerId) navigate('/customers');
      }
      toast.success(t('customers.success.deleted'));
      fetchCustomers();
    } catch (err: any) {
      toast.error(getErrorMessage(err, t('customers.errors.deleteFailed')));
    } finally {
      setIsSubmitting(false);
    }
  };

  // MW-V1: the previous handleToggleBlacklist targeted POST/DELETE
  // /api/customer/:id/blacklist — a route the backend has never mounted —
  // and rendered a permanently-false "blacklisted" state. Contact refusal
  // truth is messaging_consent (opt-out), surfaced in the Inbox, not here.

  const CustomerAvatar = ({ customer, size }: { customer: Customer; size: "row" | "drawer" }) => (
    <div
      aria-hidden="true"
      className={`shrink-0 rounded-full bg-em-bg-muted text-em-text-secondary font-semibold flex items-center justify-center ${
        size === "row" ? "w-8 h-8 text-sm" : "w-12 h-12 text-lg"
      }`}
    >
      {nameInitial(customer.name)}
    </div>
  );

  // ── Render ─────────────────────────────────────────────────────────────────

  const drawerRef = useRef<HTMLDivElement>(null);
  useDialogFocus(drawerRef, Boolean(selectedCustomer));

  return (
    <MotionConfig reducedMotion="user">
    <div className="em-customers min-h-full p-4 md:p-6">
      <div className="mx-auto w-full max-w-[1440px] space-y-4">
        {/* Header-removal C1: signal band retired. "Customer Management" is
            not the AppBar's name ("Customers"), so the compact title stays
            visible; the result count and Create button moved into the
            existing search/filter toolbar below. */}
        <PageHeader title={t('customers.title')} />

        {/* Search / filter strip — matches only fields this API queries */}
        <div className="bg-em-bg-surface rounded-lg shadow-sm border border-em-border p-2.5 mb-3">
          <div className="flex flex-col lg:flex-row gap-2">
            <div className="flex-1 relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-em-text-secondary" aria-hidden="true" />
              <input
                type="search"
                value={searchQuery}
                onChange={(e) => handleSearchChange(e.target.value)}
                placeholder={t('customers.searchNamePlaceholder')}
                aria-label={t('customers.searchNamePlaceholder')}
                className="min-h-11 w-full pl-8 pr-3 py-2 text-sm border border-em-border rounded-lg focus:outline-none focus:ring-2 focus:ring-em-violet-600 focus:border-transparent"
              />
            </div>
            <div className="lg:w-48 relative">
              <Phone className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-em-text-secondary" aria-hidden="true" />
              <input
                type="search"
                inputMode="tel"
                value={phoneQuery}
                onChange={(e) => handlePhoneChange(e.target.value.replace(/[^\d+]/g, "").slice(0, 17))}
                placeholder={t('customers.searchPhonePlaceholder')}
                aria-label={t('customers.searchPhonePlaceholder')}
                className="min-h-11 w-full pl-8 pr-3 py-2 text-sm border border-em-border rounded-lg tabular-nums focus:outline-none focus:ring-2 focus:ring-em-violet-600 focus:border-transparent"
              />
            </div>
            <div className="lg:w-44">
              <select
                value={channelFilter}
                onChange={(e) => handleChannelChange(toCustomerChannelFilter(e.target.value))}
                aria-label={t('customers.allChannels')}
                className="min-h-11 w-full px-3 py-2 text-sm border border-em-border rounded-lg bg-em-bg-surface focus:outline-none focus:ring-2 focus:ring-em-violet-600"
              >
                <option value="all">{t('customers.allChannels')}</option>
                {CUSTOMER_CHANNELS.map((ch) => (
                  <option key={ch} value={ch}>
                    {t(channelConfig[ch]?.labelKey ?? `customers.channels.${ch}`, { defaultValue: channelFallback(ch) })}
                  </option>
                ))}
              </select>
            </div>
            {hasActiveQuery && (
              <button
                type="button"
                onClick={clearQuery}
                data-testid="customers-clear-filters"
                className="flex min-h-11 items-center justify-center gap-1 px-3 py-2 text-sm text-em-text-secondary hover:bg-em-bg-muted rounded-lg border border-em-border"
              >
                <X className="w-4 h-4" aria-hidden="true" />
                {t('customers.clearFilters')}
              </button>
            )}
            {/* C2/C4: toolbar-owned contextual count + create action (were
                header/band affordances before the header removal). */}
            <div className="flex flex-wrap items-center gap-2 lg:ml-auto">
              {!isLoading && !error && (
                <span
                  data-testid="customers-result-count"
                  className="em-tabular whitespace-nowrap rounded-full border border-em-border bg-em-bg-muted px-3 py-1 text-xs font-medium text-em-text-secondary"
                >
                  {t('customers.resultCount', { total: formatCount(tableTotal, language) })}
                </span>
              )}
              <EmButton variant="primary" onClick={() => { setFormError(null); setShowCreateCustomer(true); }} className="gap-1.5">
                <UserPlus className="w-4 h-4" aria-hidden="true" />
                {t('customers.addCustomer')}
              </EmButton>
            </div>
          </div>
        </div>

        {/* RTO network participation stays discoverable but secondary, under
            the working list controls rather than above the fold (Stage 3). */}
        <RtoNetworkSettings />

        {/* Request error: never present an empty list as the truth */}
        {error && !isLoading && (
          <div className="mb-3 p-3 bg-em-danger-100 border border-em-danger-700/20 rounded-lg flex items-center gap-3" role="alert">
            <X className="w-5 h-5 text-em-danger-700 shrink-0" aria-hidden="true" />
            <p className="flex-1 text-sm font-medium text-em-danger-700">{error}</p>
            <button onClick={() => fetchCustomers()} className="px-3 py-1.5 rounded-lg bg-em-danger-700 text-white text-sm font-medium shrink-0">
              {t('common.retry')}
            </button>
          </div>
        )}

        {/* Loading */}
        {isLoading && (
          <div className="bg-em-bg-surface rounded-lg shadow-sm border border-em-border p-8 text-center" role="status">
            <Loader2 className="h-6 w-6 animate-spin text-em-violet-700 mx-auto mb-2" />
            <p className="text-em-text-secondary text-sm">{t('customers.loading')}</p>
          </div>
        )}

        {/* Worklist */}
        {!isLoading && !error && (
          <>
            {customers.length === 0 ? (
              hasActiveQuery ? (
                <div className="bg-em-bg-surface rounded-lg shadow-sm border border-em-border p-8 text-center">
                  <Search className="w-10 h-10 text-em-text-secondary mx-auto mb-3" aria-hidden="true" />
                  <h3 className="text-base font-semibold text-em-text-primary mb-1">{t('customers.noMatches')}</h3>
                  <p className="text-em-text-secondary text-sm mb-3">{t('customers.noMatchesHint')}</p>
                  <button
                    type="button"
                    onClick={clearQuery}
                    className="px-3 py-1.5 text-sm font-medium text-em-violet-700 hover:bg-em-success-100 rounded-lg"
                  >
                    {t('customers.clearFilters')}
                  </button>
                </div>
              ) : (
                <div className="bg-em-bg-surface rounded-lg shadow-sm border border-em-border p-8 text-center">
                  <Users className="w-10 h-10 text-em-text-secondary mx-auto mb-3" aria-hidden="true" />
                  <h3 className="text-base font-semibold text-em-text-primary mb-1">{t('customers.empty.title')}</h3>
                  <p className="text-em-text-secondary text-sm max-w-md mx-auto">{t('customers.empty.hint')}</p>
                </div>
              )
            ) : (
              <>
                {/* Mobile: cards, not a compressed table */}
                <ul className="md:hidden space-y-2" data-testid="customer-list-mobile">
                  {customers.map((customer) => {
                    const cfg = channelConfig[customer.channel];
                    const ChannelIcon = cfg?.icon ?? MessageSquare;
                    return (
                      <li key={customer.id} className="rounded-lg">
                        <button
                          type="button"
                          onClick={() => setSelectedCustomer(customer)}
                          data-testid={`customer-row-${customer.id}`}
                          className="w-full rounded-t-lg border border-em-border bg-em-bg-surface p-3 text-left shadow-sm focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-em-focus-light"
                        >
                          <div className="flex items-center gap-3">
                            <CustomerAvatar customer={customer} size="row" />
                            <div className="min-w-0 flex-1">
                              <p className="font-medium text-em-text-primary truncate">{customer.name ?? t('customers.unknownName')}</p>
                              <p className="text-sm text-em-text-secondary tabular-nums truncate">{customer.number || '—'}</p>
                            </div>
                            <span className={`inline-flex items-center gap-1 text-xs font-medium ${cfg?.color ?? 'text-em-text-secondary'}`}>
                              <ChannelIcon className="w-3.5 h-3.5" aria-hidden="true" />
                              {t(cfg?.labelKey ?? `customers.channels.${customer.channel}`, { defaultValue: channelFallback(customer.channel) })}
                            </span>
                          </div>
                        </button>
                        <div className="flex justify-end gap-1 rounded-b-lg border-x border-b border-em-border bg-em-bg-surface px-2 pb-2">
                          <EmButton variant="ghost" onClick={() => { setFormError(null); setEditingCustomer(customer); }}>
                            {t("common.edit")}
                          </EmButton>
                          {canDelete && (
                            <button
                              type="button"
                              onClick={() => setShowDeleteConfirm(customer.id)}
                              aria-label={t('customers.deleteModal.title')}
                              className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg text-em-text-secondary hover:bg-em-danger-100 hover:text-em-danger-700 focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-em-focus-light"
                            >
                              <Trash2 className="h-4 w-4" aria-hidden="true" />
                            </button>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>

                {/* Desktop: dense table */}
                <div className="hidden md:block bg-em-bg-surface rounded-lg shadow-sm border border-em-border overflow-hidden">
                  <div className="overflow-x-auto">
                    <table className="w-full" data-testid="customer-table">
                      <thead className="bg-em-bg-muted border-b border-em-border">
                        <tr>
                          <th scope="col" className="px-3 py-2 text-left text-xs font-semibold text-em-text-secondary uppercase tracking-wider">{t('customers.columns.customer')}</th>
                          <th scope="col" className="px-3 py-2 text-left text-xs font-semibold text-em-text-secondary uppercase tracking-wider">{t('customers.columns.contact')}</th>
                          <th scope="col" className="px-3 py-2 text-left text-xs font-semibold text-em-text-secondary uppercase tracking-wider">{t('customers.columns.channel')}</th>
                          <th scope="col" className="px-3 py-2 text-left text-xs font-semibold text-em-text-secondary uppercase tracking-wider">{t('customers.columns.created')}</th>
                          <th scope="col" className="px-3 py-2 text-right text-xs font-semibold text-em-text-secondary uppercase tracking-wider">{t('customers.columns.actions')}</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-em-border">
                        {customers.map((customer) => {
                          const cfg = channelConfig[customer.channel];
                          const ChannelIcon = cfg?.icon ?? MessageSquare;
                          return (
                            <tr key={customer.id} className="hover:bg-em-bg-muted">
                              <td className="px-3 py-2">
                                <div className="flex items-center gap-2.5">
                                  <CustomerAvatar customer={customer} size="row" />
                                  <div className="min-w-0">
                                    <p className="font-medium text-em-text-primary text-sm truncate max-w-[16rem]">{customer.name ?? t('customers.unknownName')}</p>
                                    <p className="text-xs text-em-text-secondary">{t('customers.detail.id', { id: customer.id.slice(0, 8) })}</p>
                                  </div>
                                </div>
                              </td>
                              <td className="px-3 py-2">
                                <p className="text-sm text-em-text-primary tabular-nums">{customer.number || '—'}</p>
                                {customer.email && (
                                  <p className="text-xs text-em-text-secondary truncate max-w-[14rem]">{customer.email}</p>
                                )}
                              </td>
                              <td className="px-3 py-2">
                                <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-medium ${cfg?.bgColor ?? 'bg-em-bg-muted'} ${cfg?.color ?? 'text-em-text-secondary'}`}>
                                  <ChannelIcon className="w-3.5 h-3.5" aria-hidden="true" />
                                  {t(cfg?.labelKey ?? `customers.channels.${customer.channel}`, { defaultValue: channelFallback(customer.channel) })}
                                </span>
                              </td>
                              <td className="px-3 py-2 text-sm text-em-text-secondary whitespace-nowrap">
                                <span className="inline-flex items-center gap-1.5">
                                  <Calendar className="w-3.5 h-3.5 text-em-text-secondary" aria-hidden="true" />
                                  {formatDate(customer.created_at, language)}
                                </span>
                              </td>
                              <td className="px-3 py-2">
                                <div className="flex items-center justify-end gap-1">
                                  <button
                                    type="button"
                                    onClick={() => setSelectedCustomer(customer)}
                                    className="min-h-11 px-2.5 py-1.5 text-sm font-medium text-em-violet-700 hover:bg-em-success-100 rounded-lg"
                                  >
                                    {t('common.view')}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => { setFormError(null); setEditingCustomer(customer); }}
                                    className="min-h-11 px-2.5 py-1.5 text-sm font-medium text-em-text-secondary hover:bg-em-bg-muted rounded-lg"
                                  >
                                    {t('common.edit')}
                                  </button>
                                  {canDelete && (
                                    <button
                                      onClick={() => setShowDeleteConfirm(customer.id)}
                                      aria-label={t('customers.deleteModal.title')}
                                      className="inline-flex min-h-11 min-w-11 items-center justify-center p-1.5 text-em-text-secondary hover:text-em-danger-700 hover:bg-em-danger-100 rounded-lg"
                                    >
                                      <Trash2 className="w-4 h-4" />
                                    </button>
                                  )}
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Pagination */}
                {totalPages > 1 && (
                  <div className="bg-em-bg-surface rounded-lg shadow-sm border border-em-border p-2.5 mt-2 flex items-center justify-between">
                    <p className="text-sm text-em-text-secondary">
                      {t('customers.pagination', {
                        start: formatCount(startIndex, language),
                        end: formatCount(endIndex, language),
                        total: formatCount(tableTotal, language),
                      })}
                    </p>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => setCurrentPage(prev => Math.max(1, prev - 1))}
                        disabled={currentPage === 1}
                        aria-label={t('customers.previousPage')}
                        className="p-1.5 border border-em-border rounded-lg hover:bg-em-bg-muted disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        <ChevronLeft className="w-4 h-4" />
                      </button>
                      <span className="px-3 py-1 text-sm font-medium text-em-text-primary tabular-nums">
                        {formatCount(currentPage, language)} / {formatCount(totalPages, language)}
                      </span>
                      <button
                        onClick={() => setCurrentPage(prev => Math.min(totalPages, prev + 1))}
                        disabled={currentPage === totalPages}
                        aria-label={t('customers.nextPage')}
                        className="p-1.5 border border-em-border rounded-lg hover:bg-em-bg-muted disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        <ChevronRight className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>

      {/* Customer Detail Drawer */}
      {selectedCustomer && (
        <div ref={drawerRef} onKeyDown={(e) => { if (e.key === 'Escape') closeCustomerDetails(); }} className="fixed inset-0 bg-em-midnight-950/60 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label={t('customers.detail.title')}>
          <div className="bg-em-bg-surface rounded-2xl max-w-md w-full max-h-[90vh] overflow-y-auto">
            <div className="sticky top-0 bg-em-bg-surface border-b border-em-border p-4 flex items-center justify-between rounded-t-2xl">
              <h2 className="text-lg font-bold text-em-text-primary">{t('customers.detail.title')}</h2>
              <button
                onClick={closeCustomerDetails}
                aria-label={t('common.close')}
                className="p-2 text-em-text-secondary hover:text-em-text-secondary hover:bg-em-bg-muted rounded-lg"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-4 space-y-4">
              <div className="flex items-center gap-3">
                <CustomerAvatar customer={selectedCustomer} size="drawer" />
                <div>
                  <h3 className="text-lg font-semibold text-em-text-primary">{selectedCustomer.name ?? t('customers.unknownName')}</h3>
                  <p className="text-sm text-em-text-secondary">{t('customers.detail.id', { id: selectedCustomer.id.slice(0, 8) })}</p>
                </div>
              </div>

              <div className="space-y-3">
                <div>
                  <p className="flex items-center gap-2 text-xs font-medium text-em-text-secondary mb-0.5">
                    <Phone className="w-3.5 h-3.5" aria-hidden="true" />
                    {t('customers.detail.phoneNumber')}
                  </p>
                  <p className="text-sm text-em-text-primary tabular-nums pl-5.5">
                    {selectedCustomer.number
                      ? <a href={`tel:${selectedCustomer.number.replace(/[^\d+]/g, '')}`} className="underline decoration-em-border-strong underline-offset-2">{selectedCustomer.number}</a>
                      : '—'}
                  </p>
                </div>

                <div>
                  <p className="flex items-center gap-2 text-xs font-medium text-em-text-secondary mb-0.5">
                    <Mail className="w-3.5 h-3.5" aria-hidden="true" />
                    {t('customers.detail.email')}
                  </p>
                  <p className="text-sm text-em-text-primary pl-5.5">{selectedCustomer.email || t('customers.detail.notProvided')}</p>
                </div>

                <div>
                  <p className="flex items-center gap-2 text-xs font-medium text-em-text-secondary mb-0.5">
                    <MessageSquare className="w-3.5 h-3.5" aria-hidden="true" />
                    {t('customers.detail.channel')}
                  </p>
                  <div className="pl-5.5">
                    {(() => {
                      const cfg = channelConfig[selectedCustomer.channel];
                      const ChannelIcon = cfg?.icon ?? MessageSquare;
                      return (
                        <span className={`inline-flex items-center gap-1.5 px-2 py-1 rounded text-xs font-medium ${cfg?.bgColor ?? 'bg-em-bg-muted'} ${cfg?.color ?? 'text-em-text-secondary'}`}>
                          <ChannelIcon className="w-3.5 h-3.5" aria-hidden="true" />
                          {t(cfg?.labelKey ?? `customers.channels.${selectedCustomer.channel}`, { defaultValue: channelFallback(selectedCustomer.channel) })}
                        </span>
                      );
                    })()}
                  </div>
                </div>

                <div>
                  <p className="flex items-center gap-2 text-xs font-medium text-em-text-secondary mb-0.5">
                    <Calendar className="w-3.5 h-3.5" aria-hidden="true" />
                    {t('customers.detail.createdAt')}
                  </p>
                  <p className="text-sm text-em-text-primary pl-5.5">
                    {selectedCustomer.created_at
                      ? new Date(selectedCustomer.created_at).toLocaleDateString(language === 'bn' ? 'bn-BD' : 'en-US', {
                          year: 'numeric', month: 'long', day: 'numeric',
                        })
                      : t('customers.detail.notAvailable')}
                  </p>
                </div>
              </div>

              <CustomerCRMPanel customerId={selectedCustomer.id} />

              <EmButton variant="secondary" onClick={() => navigate(`/inbox?customer_id=${encodeURIComponent(selectedCustomer.id)}`)} className="w-full">
                <MessageSquare className="w-4 h-4" aria-hidden="true" />
                {t('customers.actions.openInbox', { defaultValue: 'Open inbox' })}
              </EmButton>

              {/* Order history is a separate authority (order search by phone);
                  this profile endpoint does not compute it. Deep-link to the
                  supported Orders worklist instead of inventing a panel. */}
              {selectedCustomer.number && (
                <button
                  type="button"
                  onClick={() => navigate(`/orders?search=${encodeURIComponent(selectedCustomer.number)}`)}
                  data-testid="customer-view-orders"
                  className="w-full flex items-center justify-center gap-2 px-3 py-2 text-sm font-medium text-em-violet-700 bg-em-success-100 hover:bg-em-success-100 rounded-lg"
                >
                  <PackageSearch className="w-4 h-4" aria-hidden="true" />
                  {t('customers.viewOrders')}
                </button>
              )}

              <EmButton
                variant="secondary"
                onClick={() => { setFormError(null); setEditingCustomer(selectedCustomer); }}
                className="w-full"
              >
                {t("common.edit")}
              </EmButton>

              {canDelete && (
                <button
                  onClick={() => setShowDeleteConfirm(selectedCustomer.id)}
                  className="w-full flex items-center justify-center gap-2 px-3 py-2 text-sm font-medium text-em-danger-700 border border-em-danger-700/20 hover:bg-em-danger-100 rounded-lg"
                >
                  <Trash2 className="w-4 h-4" aria-hidden="true" />
                  {t('customers.deleteModal.title')}
                </button>
              )}

              {/* MW-V1: blacklist toggle removed — unmounted endpoint,
                  permanently-false state (see handler note above). The legacy
                  RTO Shield block was removed for the same reason: this API
                  returns neither rto_risk nor rto_count (dead UI, E-007 audit). */}
            </div>
          </div>
        </div>
      )}

      <CustomerRecordDialog
        mode={editingCustomer ? "edit" : "create"}
        open={showCreateCustomer || Boolean(editingCustomer)}
        initial={editingCustomer ? {
          id: editingCustomer.id,
          name: editingCustomer.name,
          number: editingCustomer.number,
          email: editingCustomer.email,
          channel: editingCustomer.channel,
        } : undefined}
        saving={isSubmitting}
        error={formError}
        onClose={closeRecordDialog}
        onSave={(draft) => void handleSaveCustomer(draft)}
      />
      <CustomerDeleteDialog
        open={Boolean(showDeleteConfirm)}
        deleting={isSubmitting}
        customerName={customers.find((customer) => customer.id === showDeleteConfirm)?.name ?? selectedCustomer?.name}
        onClose={() => setShowDeleteConfirm(null)}
        onConfirm={() => { if (showDeleteConfirm) void handleDeleteCustomer(showDeleteConfirm); }}
      />
    </div>
    </MotionConfig>
  );
}

/** Opens the existing legacy customer drawer for the /customers/:id route. */
export function LegacyCustomerRouteDrawer({ customerId }: { customerId: string }) {
  return <LegacyCustomers routeCustomerId={customerId} />;
}

/**
 * Customer 360 Lite is a per-shop pilot (docs/pilot-intelligence). The flag is
 * server-side; the status call only chooses which page to render, and every
 * pilot API re-checks it. Any failure falls back to the existing page.
 */
export default function Customers() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const linkedCustomerId = searchParams.get("customerId");
  const [mode, setMode] = useState<'loading' | 'pilot' | 'legacy'>('loading');

  useEffect(() => {
    let cancelled = false;
    getPilotStatus()
      .then((status) => { if (!cancelled) setMode(status?.customer_intelligence ? 'pilot' : 'legacy'); })
      .catch(() => { if (!cancelled) setMode('legacy'); });
    return () => { cancelled = true; };
  }, []);

  // Pilot mode owns a path-based detail route; convert the inbox deep-link once
  // the mode is known so both modes resolve the exact customer.
  useEffect(() => {
    if (mode === 'pilot' && linkedCustomerId) {
      navigate(`/customers/${encodeURIComponent(linkedCustomerId)}`, { replace: true });
    }
  }, [linkedCustomerId, mode, navigate]);

  if (mode === 'loading') {
    return (
      <div className="min-h-full flex items-center justify-center" role="status">
        <Loader2 className="h-8 w-8 animate-spin text-em-violet-700" />
      </div>
    );
  }
  return mode === 'pilot' ? <Customer360Page /> : <LegacyCustomers />;
}
