import { useState, useEffect, useRef } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from 'react-i18next';
import { motion, MotionConfig } from "motion/react";
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
import { BDPhoneInput } from '@/shared/components/BDPhoneInput';
import RtoNetworkSettings from './RtoNetworkSettings';
import { getErrorMessage } from "@shared/lib/http/errors";
import { getPilotStatus } from "@/api/domains/customer-intelligence";
import { useAuth } from "@/features/auth/AuthProvider";
import { fadeUp } from "@/lib/motion";
import { EmButton } from "./dashboard/EmButton";
import { PageHeader } from "./dashboard/PageHeader";
import { useDialogFocus } from "./inbox/useDialogFocus";
import { deriveCustomersSignal } from "./customers/derive";
import Customer360Page from "./customers/Customer360Page";

const ANIMATE = import.meta.env.MODE !== "test";

type CustomerChannelFilter = ApiChannelType | 'all';

const channelConfig: Record<string, { icon: any; color: string; bgColor: string; labelKey: string }> = {
  facebook:  { icon: MessageSquare, color: "text-em-info-700",   bgColor: "bg-em-info-100",   labelKey: "customers.channels.facebook" },
  messenger: { icon: MessageSquare, color: "text-em-info-700",   bgColor: "bg-em-info-100",   labelKey: "customers.channels.messenger" },
  webchat:   { icon: MessageSquare, color: "text-em-violet-700", bgColor: "bg-em-violet-100", labelKey: "customers.channels.webchat" },
  telegram:  { icon: MessageSquare, color: "text-em-info-700",    bgColor: "bg-em-info-100",    labelKey: "customers.channels.telegram" },
  manual:    { icon: UserPlus,      color: "text-em-text-secondary",   bgColor: "bg-em-bg-muted",   labelKey: "customers.channels.manual" },
};

const INCOMING_CHANNELS: ApiChannelType[] = ['facebook', 'messenger', 'telegram', 'webchat', 'manual'];
const REST_CHANNELS: ApiChannelType[] = ['facebook', 'telegram', 'webchat', 'manual'];
const toCustomerChannel = (value: string): ApiChannelType | "" =>
  REST_CHANNELS.includes(value as ApiChannelType) ? (value as ApiChannelType) : "";
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
  const channel = INCOMING_CHANNELS.includes((customer.channel || raw.channel_type) as ApiChannelType)
    ? ((customer.channel || raw.channel_type) as ApiChannelType)
    : 'manual';
  return { ...customer, number, channel };
};

const formatDate = (value: string | undefined, language: string) =>
  value ? new Date(value).toLocaleDateString(language === 'bn' ? 'bn-BD' : 'en-US', {
    year: 'numeric', month: 'short', day: 'numeric',
  }) : '—';

function LegacyCustomers() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const linkedCustomerId = searchParams.get("customerId");
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
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [newCustomer, setNewCustomer] = useState({
    name: "",
    number: "",
    email: "",
    channel: "" as "" | ApiChannelType,
  });

  const hasActiveQuery = Boolean(searchQuery || phoneQuery || channelFilter !== 'all');

  // ── Table fetch — server-side, debounced search ───────────────────────────
  useEffect(() => {
    const timer = setTimeout(() => {
      fetchCustomers();
    }, (searchQuery || phoneQuery) ? 300 : 0);
    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery, phoneQuery, channelFilter, currentPage]);

  const fetchCustomers = async () => {
    try {
      setIsLoading(true);
      setError(null);
      const filters: CustomerFilters = { page: currentPage, pageSize: PAGE_SIZE };
      if (searchQuery) filters.search = searchQuery;
      if (phoneQuery) filters.phone = phoneQuery;
      if (channelFilter !== 'all') filters.channel_type = channelFilter;

      const result = await apiClient.getCustomers(filters);
      // Guard against a malformed/empty payload so a shape drift degrades to an
      // empty table rather than crashing the page on `customers.length`.
      setCustomers((result?.data ?? []).map(normalizeLegacyCustomer));
      setTableTotal(result?.total ?? 0);
    } catch (err: any) {
      setError(err.message || t('customers.errors.fetchFailed'));
      setCustomers([]);
      setTableTotal(0);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSearchChange = (value: string) => {
    setSearchQuery(value);
    setCurrentPage(1);
  };

  const handlePhoneChange = (value: string) => {
    setPhoneQuery(value);
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

  const handleCreateCustomer = async () => {
    if (!newCustomer.name || !newCustomer.number || !newCustomer.channel) {
      toast.error(t('customers.errors.requiredFields'));
      return;
    }
    try {
      setIsSubmitting(true);
      await apiClient.createCustomer({
        name: newCustomer.name,
        number: newCustomer.number,
        email: newCustomer.email || undefined,
        channel: newCustomer.channel,
      });
      setShowCreateCustomer(false);
      setNewCustomer({ name: "", number: "", email: "", channel: "" });
      toast.success(t('customers.success.created'));
      fetchCustomers();
    } catch (err: any) {
      toast.error(getErrorMessage(err, t('customers.errors.createFailed')));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDeleteCustomer = async (customerId: string) => {
    try {
      setIsSubmitting(true);
      await apiClient.deleteCustomer(customerId);
      setShowDeleteConfirm(null);
      if (selectedCustomer?.id === customerId) setSelectedCustomer(null);
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
  const createRef = useRef<HTMLDivElement>(null);
  const deleteRef = useRef<HTMLDivElement>(null);
  useDialogFocus(drawerRef, Boolean(selectedCustomer));
  useDialogFocus(createRef, showCreateCustomer);
  useDialogFocus(deleteRef, Boolean(showDeleteConfirm));
  const signal = deriveCustomersSignal(
    { phase: error ? "error" : isLoading ? "loading" : "ready", totalCount: tableTotal, opportunityCount: 0 },
    t,
  );

  return (
    <MotionConfig reducedMotion="user">
    <div className="em-customers min-h-full p-4 md:p-6">
      <div className="mx-auto w-full max-w-[1440px] space-y-4">
        <motion.div variants={fadeUp} initial={ANIMATE ? "hidden" : false} animate="visible">
          <PageHeader
            title={t('customers.title')}
            breadcrumb={currentShop?.shop_name ? [{ label: currentShop.shop_name }] : []}
            signal={signal}
            signalTestId="customers-signal"
            signalAnnounce={false}
            meta={!isLoading && !error ? (
              <span className="em-tabular whitespace-nowrap rounded-full border border-em-border bg-em-bg-muted px-3 py-1 text-xs font-medium text-em-text-secondary" data-testid="customers-result-count">
                {t('customers.resultCount', { total: tableTotal })}
              </span>
            ) : undefined}
          />
        </motion.div>

        <div className="flex flex-wrap items-center justify-end gap-2">
          <EmButton variant="primary" onClick={() => setShowCreateCustomer(true)} className="gap-1.5">
            <UserPlus className="w-4 h-4" aria-hidden="true" />
            {t('customers.addCustomer')}
          </EmButton>
        </div>

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
                {REST_CHANNELS.map((ch) => (
                  <option key={ch} value={ch}>
                    {t(channelConfig[ch]?.labelKey ?? `customers.channels.${ch}`, { defaultValue: ch })}
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
                      <li key={customer.id}>
                        <button
                          type="button"
                          onClick={() => setSelectedCustomer(customer)}
                          data-testid={`customer-row-${customer.id}`}
                          className="w-full text-left bg-em-bg-surface rounded-lg border border-em-border shadow-sm p-3"
                        >
                          <div className="flex items-center gap-3">
                            <CustomerAvatar customer={customer} size="row" />
                            <div className="min-w-0 flex-1">
                              <p className="font-medium text-em-text-primary truncate">{customer.name ?? t('customers.unknownName')}</p>
                              <p className="text-sm text-em-text-secondary tabular-nums truncate">{customer.number || '—'}</p>
                            </div>
                            <span className={`inline-flex items-center gap-1 text-xs font-medium ${cfg?.color ?? 'text-em-text-secondary'}`}>
                              <ChannelIcon className="w-3.5 h-3.5" aria-hidden="true" />
                              {t(cfg?.labelKey ?? `customers.channels.${customer.channel}`, { defaultValue: customer.channel })}
                            </span>
                          </div>
                        </button>
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
                                  {t(cfg?.labelKey ?? `customers.channels.${customer.channel}`, { defaultValue: customer.channel })}
                                </span>
                              </td>
                              <td className="px-3 py-2 text-sm text-em-text-secondary whitespace-nowrap">
                                <span className="inline-flex items-center gap-1.5">
                                  <Calendar className="w-3.5 h-3.5 text-em-text-secondary" aria-hidden="true" />
                                  {formatDate(customer.created_at, i18n.language)}
                                </span>
                              </td>
                              <td className="px-3 py-2">
                                <div className="flex items-center justify-end gap-1">
                                  <button
                                    onClick={() => setSelectedCustomer(customer)}
                                    className="min-h-11 px-2.5 py-1.5 text-sm font-medium text-em-violet-700 hover:bg-em-success-100 rounded-lg"
                                  >
                                    {t('common.view')}
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
                      {t('customers.pagination', { start: startIndex, end: endIndex, total: tableTotal })}
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
                        {currentPage} / {totalPages}
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
                  <p className="text-sm text-em-text-primary tabular-nums pl-5.5">{selectedCustomer.number || '—'}</p>
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
                          {t(cfg?.labelKey ?? `customers.channels.${selectedCustomer.channel}`, { defaultValue: selectedCustomer.channel })}
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
                      ? new Date(selectedCustomer.created_at).toLocaleDateString(i18n.language === 'bn' ? 'bn-BD' : 'en-US', {
                          year: 'numeric', month: 'long', day: 'numeric',
                        })
                      : t('customers.detail.notAvailable')}
                  </p>
                </div>
              </div>

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

      {/* Create Customer Modal */}
      {showCreateCustomer && (
        <div ref={createRef} onKeyDown={(e) => { if (e.key === 'Escape') setShowCreateCustomer(false); }} className="fixed inset-0 bg-em-midnight-950/60 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label={t('customers.addModal.title')}>
          <div className="bg-em-bg-surface rounded-2xl max-w-md w-full p-5">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-bold text-em-text-primary">{t('customers.addModal.title')}</h2>
              <button
                onClick={() => {
                  setShowCreateCustomer(false);
                  setNewCustomer({ name: "", number: "", email: "", channel: "" as const });
                }}
                aria-label={t('common.close')}
                className="p-2 text-em-text-secondary hover:text-em-text-secondary hover:bg-em-bg-muted rounded-lg"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-3">
              <div>
                <label className="block text-sm font-semibold text-em-text-primary mb-1" htmlFor="customer-name">
                  {t('customers.addModal.name')} <span className="text-em-danger-700" aria-hidden="true">*</span>
                </label>
                <input
                  id="customer-name"
                  type="text"
                  value={newCustomer.name}
                  onChange={(e) => setNewCustomer({ ...newCustomer, name: e.target.value })}
                  className="w-full px-3 py-2 text-sm border border-em-border rounded-lg focus:outline-none focus:ring-2 focus:ring-em-violet-600"
                  placeholder={t('customers.addModal.namePlaceholder')}
                />
              </div>

              <BDPhoneInput
                label={t('customers.addModal.phone')}
                value={newCustomer.number}
                onChange={(raw) => setNewCustomer({ ...newCustomer, number: raw })}
                required
                id="customer-phone"
              />

              <div>
                <label className="block text-sm font-semibold text-em-text-primary mb-1" htmlFor="customer-email">
                  {t('customers.addModal.email')}
                </label>
                <input
                  id="customer-email"
                  type="email"
                  value={newCustomer.email}
                  onChange={(e) => setNewCustomer({ ...newCustomer, email: e.target.value })}
                  className="w-full px-3 py-2 text-sm border border-em-border rounded-lg focus:outline-none focus:ring-2 focus:ring-em-violet-600"
                  placeholder={t('customers.addModal.emailPlaceholder')}
                />
              </div>

              <div>
                <label className="block text-sm font-semibold text-em-text-primary mb-1" htmlFor="customer-channel">
                  {t('customers.addModal.channel')} <span className="text-em-danger-700" aria-hidden="true">*</span>
                </label>
                <select
                  id="customer-channel"
                  value={newCustomer.channel}
                  onChange={(e) => setNewCustomer({ ...newCustomer, channel: toCustomerChannel(e.target.value) })}
                  className="min-h-11 w-full px-3 py-2 text-sm border border-em-border rounded-lg bg-em-bg-surface focus:outline-none focus:ring-2 focus:ring-em-violet-600"
                >
                  <option value="">{t('customers.addModal.channelPlaceholder')}</option>
                  {REST_CHANNELS.map((ch) => (
                    <option key={ch} value={ch}>
                      {t(channelConfig[ch]?.labelKey ?? `customers.channels.${ch}`, { defaultValue: ch })}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex gap-2 pt-2">
                <button
                  onClick={() => {
                    setShowCreateCustomer(false);
                    setNewCustomer({ name: "", number: "", email: "", channel: "" as const });
                  }}
                  className="flex-1 px-4 py-2 border border-em-border text-em-text-primary rounded-lg hover:bg-em-bg-muted text-sm font-medium"
                >
                  {t('common.cancel')}
                </button>
                <button
                  onClick={handleCreateCustomer}
                  disabled={isSubmitting || !newCustomer.name || !newCustomer.number || !newCustomer.channel}
                  className="flex-1 px-4 py-2 bg-em-violet-600 text-white rounded-lg hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed text-sm font-medium"
                >
                  {isSubmitting ? t('customers.addModal.creating') : t('customers.addModal.createButton')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {showDeleteConfirm && (
        <div ref={deleteRef} onKeyDown={(e) => { if (e.key === 'Escape') setShowDeleteConfirm(null); }} className="fixed inset-0 bg-em-midnight-950/60 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label={t('customers.deleteModal.title')}>
          <div className="bg-em-bg-surface rounded-2xl max-w-md w-full p-5">
            <div className="w-10 h-10 bg-em-danger-100 rounded-full flex items-center justify-center mx-auto mb-3">
              <Trash2 className="w-5 h-5 text-em-danger-700" aria-hidden="true" />
            </div>
            <h2 className="text-lg font-bold text-em-text-primary mb-1 text-center">{t('customers.deleteModal.title')}</h2>
            <p className="text-em-text-secondary mb-1 text-center text-sm">{t('customers.deleteModal.message')}</p>
            <p className="text-em-text-secondary mb-4 text-center text-xs">{t('customers.deleteModal.erasureNote')}</p>
            <div className="flex gap-2">
              <button
                onClick={() => setShowDeleteConfirm(null)}
                className="flex-1 px-4 py-2 border border-em-border text-em-text-primary rounded-lg hover:bg-em-bg-muted text-sm font-medium"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={() => handleDeleteCustomer(showDeleteConfirm)}
                disabled={isSubmitting}
                className="flex-1 px-4 py-2 bg-em-danger-700 text-white rounded-lg hover:bg-em-danger-700/90 disabled:opacity-50 text-sm font-medium"
              >
                {isSubmitting ? t('customers.deleteModal.deleting') : t('customers.deleteModal.deleteButton')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
    </MotionConfig>
  );
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
