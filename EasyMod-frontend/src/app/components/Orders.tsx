import { useState, useEffect, useMemo, useRef } from "react";
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Loader2, Package as PackageIcon, XCircle, Plus, Search, Download, ChevronDown, X, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { apiClient } from "@/api";
import { getErrorMessage } from "@shared/lib/http/errors";
import type { Order, DeliveryAddress, OrderWorklistBucket, OrderWorklistCounts } from "@/api/types/order";
import type { Product } from "@/api/types/product";
import bdGeography from '../../data/bd-geography.json';
import CourierBookingModal from './CourierBookingModal';
import { BDPhoneInput } from '@/shared/components/BDPhoneInput';
import { OrderRow, OrderTableRow } from './orders/OrderRow';
import OrderConfidencePanel from './orders/OrderConfidencePanel';
import ContextualEntityLink from './merchant-workspace/ContextualEntityLink';
import { ShopRole, UserRole } from '@/shared/lib/rbac/types';
import { useUserPermissions } from '@/shared/lib/rbac/useUserPermissions';

// Worklist chips. The keys mirror the backend bucket module — the server owns
// the predicates, so a chip click sends the same key the counters were built
// from and the two can never disagree.
const WORKLIST_BUCKETS: Array<{ key: OrderWorklistBucket; labelKey: string }> = [
  { key: 'to_confirm', labelKey: 'orders.buckets.toConfirm' },
  { key: 'to_pack', labelKey: 'orders.buckets.toPack' },
  { key: 'booked', labelKey: 'orders.buckets.booked' },
  { key: 'in_transit', labelKey: 'orders.buckets.inTransit' },
  { key: 'needs_action', labelKey: 'orders.buckets.needsAction' },
  { key: 'returned', labelKey: 'orders.buckets.returned' },
  { key: 'delivered', labelKey: 'orders.buckets.delivered' },
];

const statusColors = {
  draft: 'bg-gray-100 text-gray-700',
  pending: 'bg-orange-100 text-orange-700',
  confirmed: 'bg-blue-100 text-blue-700',
  processing: 'bg-yellow-100 text-yellow-700',
  completed: 'bg-green-100 text-green-700',
  delivered: 'bg-green-100 text-green-700',
  cancelled: 'bg-red-100 text-red-700',
};

interface OrderItem {
  productId: string;
  productName: string;
  quantity: number;
  price: number;
  sku?: string;
}

interface ManualOrder {
  customerName: string;
  customerPhone: string;
  deliveryAddress: string;
  division: string;
  district: string;
  upazila: string;
  streetAddress: string;
  channel: string;
  items: OrderItem[];
  discount: number;
  tax: number;
  delivery: number;
  payment: string;
  paymentMethod: string;
  notes: string;
  source: 'manual';
  createdBy: 'user';
}

const deriveZone = (divisionId: string, districtId: string): DeliveryAddress['zone'] => {
  if (divisionId === 'dhaka' && districtId === 'dhaka_city') return 'inside_dhaka';
  if (divisionId === 'dhaka') return 'sub_dhaka';
  return 'outside_dhaka';
};

export default function Orders() {
  const { t, i18n } = useTranslation();
  const { hasShopRole, hasRole } = useUserPermissions();
  const canCorrectPaymentMethod = hasShopRole(ShopRole.OWNER) || hasRole(UserRole.ADMIN);
  const navigate = useNavigate();
  const [orders, setOrders] = useState<Order[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  const [isCreating, setIsCreating] = useState(false);
  const [appliedSearchQuery, setAppliedSearchQuery] = useState('');
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null);
  const [orderStatusFilter, setOrderStatusFilter] = useState<string>('all');
  const [fulfillmentStatusFilter, setFulfillmentStatusFilter] = useState<string>('all');
  const [paymentStatusFilter, setPaymentStatusFilter] = useState<string>('all');
  const [dateFilter, setDateFilter] = useState<string>('all');
  const [deliveryBucket, setDeliveryBucket] = useState<'all' | OrderWorklistBucket>('all');
  // Shop-wide chip counts. Null until the first response; a failed fetch leaves
  // them as dashes rather than inventing zeros.
  const [worklistCounts, setWorklistCounts] = useState<OrderWorklistCounts | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [showExportMenu, setShowExportMenu] = useState(false);
  const exportMenuRef = useRef<HTMLDivElement | null>(null);
  const createOrderRetryKeysRef = useRef(new Map<string, string>());
  const [showCreateOrder, setShowCreateOrder] = useState(false);
  const [paymentMethodChoices, setPaymentMethodChoices] = useState<string[]>(['cod']);
  const [paymentMethodsLoadFailed, setPaymentMethodsLoadFailed] = useState(false);
  const [paymentMethodsRetry, setPaymentMethodsRetry] = useState(0);
  const [paymentMethodCorrection, setPaymentMethodCorrection] = useState('');
  const [paymentMethodCorrectionUnavailable, setPaymentMethodCorrectionUnavailable] = useState(false);
  const [isUpdatingPaymentMethod, setIsUpdatingPaymentMethod] = useState(false);
  const [showProductSelector, setShowProductSelector] = useState(false);
  const [detailNote, setDetailNote] = useState('');
  const [conversationSnippets, setConversationSnippets] = useState<string[]>([]);
  // FE-08: id of the conversation that VERIFIEDLY belongs to this order's
  // customer (null = no safe link → honest unavailable state, never a guess).
  const [linkedConversationId, setLinkedConversationId] = useState<string | null>(null);
  // Bug #14: inline product search — no separate modal needed
  const [productSearchQuery, setProductSearchQuery] = useState('');
  const [showCourierModal, setShowCourierModal] = useState(false);
  // Refresh confidence after order/payment changes and courier attempts.
  const [confidenceRefresh, setConfidenceRefresh] = useState(0);
  const [searchParams, setSearchParams] = useSearchParams();
  const [deepLinkError, setDeepLinkError] = useState(false);
  const [deepLinkRetry, setDeepLinkRetry] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setPaymentMethodsLoadFailed(false);
    apiClient.getPaymentConfig()
      .then((response) => {
        if (cancelled) return;
        if (!response.success || !Array.isArray(response.data)) throw new Error('Payment methods unavailable');
        const enabledMethods = response.data
          .filter((config) => config.is_enabled && typeof config.gateway === 'string' && config.gateway.trim())
          .map((config) => config.gateway.trim().toLowerCase());
        setPaymentMethodChoices([...new Set(['cod', ...enabledMethods])]);
      })
      .catch(() => {
        if (cancelled) return;
        setPaymentMethodChoices(['cod']);
        setPaymentMethodsLoadFailed(true);
      });
    return () => { cancelled = true; };
  }, [paymentMethodsRetry]);

  useEffect(() => {
    setPaymentMethodCorrection('');
    setPaymentMethodCorrectionUnavailable(false);
  }, [selectedOrder?.id]);

  // Deep link (/orders?orderId=…) from notifications and Customer 360: open that order.
  useEffect(() => {
    const orderId = searchParams.get('orderId');
    if (!orderId) {
      setDeepLinkError(false);
      return;
    }
    let cancelled = false;
    setDeepLinkError(false);
    apiClient.getOrder(orderId)
      .then((order) => {
        if (cancelled) return;
        if (!order?.id) {
          setDeepLinkError(true);
          return;
        }
        setSelectedOrder(order);
        const next = new URLSearchParams(searchParams);
        next.delete('orderId');
        setSearchParams(next, { replace: true });
      })
      .catch(() => { if (!cancelled) setDeepLinkError(true); });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams.get('orderId'), deepLinkRetry]);

  // Deep link (/orders?search=…) from a customer profile: the server-backed
  // search covers order number, customer name, and phone.
  useEffect(() => {
    const q = searchParams.get('search');
    if (q) setSearchQuery(q);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the URL shareable/back-navigable with the applied query.
  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    if (appliedSearchQuery) next.set('search', appliedSearchQuery);
    else next.delete('search');
    if (next.toString() !== searchParams.toString()) setSearchParams(next, { replace: true });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appliedSearchQuery]);

  const currencyFormatter = useMemo(
    () =>
      new Intl.NumberFormat(i18n.language === 'bn' ? 'bn-BD' : 'en-US', {
        style: 'currency',
        currency: 'BDT',
        minimumFractionDigits: 2,
      }),
    [i18n.language]
  );

  const formatCurrency = (value: number) => currencyFormatter.format(Number(value || 0));
  const formatDate = (value: string) => new Date(value).toLocaleString(i18n.language === 'bn' ? 'bn-BD' : 'en-US');
  const paymentMethodLabel = (gateway: string) => {
    const labels: Record<string, string> = {
      cod: t('orders.paymentMethod.cod'),
      'self-mfs': t('orders.paymentMethod.selfMfs'),
      bkash: t('orders.paymentMethod.bkash'),
      nagad: t('orders.paymentMethod.nagad'),
      rocket: t('orders.paymentMethod.rocket'),
    };
    return labels[gateway.toLowerCase()] || gateway;
  };
  const selectedDeliveryStatus = selectedOrder?.delivery_status?.trim().toLowerCase();
  const paymentReconciliation = selectedOrder?.metadata?.payment_reconciliation;
  const showPaymentReconciliation = paymentReconciliation?.required === true;
  const reconciliationWarningKey = paymentReconciliation?.code === 'COD_COURIER_COLLECTION_REVIEW_REQUIRED'
    ? 'cod'
    : paymentReconciliation?.code === 'PAYMENT_VERIFIED_AFTER_COURIER_CLAIM'
      ? 'verifiedPayment'
      : paymentReconciliation?.code === 'PAYMENT_VERIFIED_AFTER_TERMINAL_ORDER_STATE'
        ? 'terminalOrder'
        : 'unknown';
  const selectedOrderHasCourierRecord = Boolean(
    selectedOrder?.delivery_tracking_code
    || selectedOrder?.delivery_consignment_id
    || selectedOrder?.delivery_dispatched_at
    || (selectedDeliveryStatus && !['unfulfilled', 'not_booked'].includes(selectedDeliveryStatus))
  );

  const resolveDateRange = (value: string): { start_date?: string; end_date?: string } => {
    const now = new Date();

    if (value === 'today') {
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      return { start_date: start.toISOString(), end_date: now.toISOString() };
    }

    if (value === 'last7days') {
      const start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      return { start_date: start.toISOString(), end_date: now.toISOString() };
    }

    if (value === 'last30days') {
      const start = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      return { start_date: start.toISOString(), end_date: now.toISOString() };
    }

    return {};
  };

  // Manual order form state
  const [manualOrder, setManualOrder] = useState<ManualOrder>({
    customerName: '',
    customerPhone: '',
    deliveryAddress: '',
    division: '',
    district: '',
    upazila: '',
    streetAddress: '',
    channel: 'manual',
    items: [],
    discount: 0,
    tax: 0,
    delivery: 0,
    payment: 'pending',
    paymentMethod: '',
    notes: '',
    source: 'manual',
    createdBy: 'user',
  });

  // Products only need to load once — they don't change with order filters
  useEffect(() => {
    apiClient.getProducts()
      .then(setProducts)
      .catch((err: unknown) => console.error('Products load failed:', err));
  }, []);

  // Debounce search input so we don't fire an API call on every keystroke
  useEffect(() => {
    setIsLoading(true);
    const timer = setTimeout(() => setAppliedSearchQuery(searchQuery), 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  // Fetch orders whenever filters or debounced search change
  useEffect(() => {
    const controller = new AbortController();
    const fetchOrders = async () => {
      try {
        setIsLoading(true);
        setLoadError(false);
        setOrders([]);
        const dateRange = resolveDateRange(dateFilter);
        const fetchedOrders = await apiClient.getOrders({
          search: appliedSearchQuery || undefined,
          ...dateRange,
          order_status: orderStatusFilter === 'all' ? undefined : orderStatusFilter,
          payment_status: paymentStatusFilter === 'all' ? undefined : paymentStatusFilter,
          fulfillment_status: fulfillmentStatusFilter === 'all' ? undefined : fulfillmentStatusFilter,
          delivery_bucket: deliveryBucket === 'all' ? undefined : deliveryBucket,
          page: 1,
          limit: 100,
        });
        if (!controller.signal.aborted) setOrders(fetchedOrders);
      } catch (err: unknown) {
        if (controller.signal.aborted) return;
        setOrders([]);
        setLoadError(true);
        toast.error(getErrorMessage(err, t('orders.errors.loadFailed')));
      } finally {
        if (!controller.signal.aborted) setIsLoading(false);
      }
    };
    fetchOrders();
    return () => controller.abort();
  }, [dateFilter, appliedSearchQuery, orderStatusFilter, fulfillmentStatusFilter, paymentStatusFilter, deliveryBucket, retryCount]);

  // Chip counts are shop-wide, so they do not depend on the active filters —
  // they refresh when the underlying data changes, not when a chip is clicked.
  useEffect(() => {
    let cancelled = false;
    apiClient.getOrderCounts()
      .then((counts) => { if (!cancelled) setWorklistCounts(counts); })
      .catch(() => { if (!cancelled) setWorklistCounts(null); });
    return () => { cancelled = true; };
  }, [retryCount, confidenceRefresh]);

  // FE-08: resolve the chat snippet ONLY through the verified shop-scoped
  // customer id (backend GET /api/conversation already filters customer_id
  // inside the caller's own shop scope). The previous name search was worse
  // than it looked: the list endpoint ignores `search`, so this used to show
  // whatever conversation was most recently ACTIVE — possibly another
  // customer's. No customerId (manual orders) or no matching thread now
  // renders the honest "no linked chat" state instead of guessing.
  useEffect(() => {
    setLinkedConversationId(null);
    setConversationSnippets([]);
    const customerId = selectedOrder?.customerId;
    if (!customerId) return;

    const controller = new AbortController();
    const loadConversationSnippet = async () => {
      try {
        const list = await apiClient.getConversations({ customer_id: customerId, limit: 1 }, controller.signal);
        // Defensive client-side identity check before touching messages.
        const linked = (list.data ?? []).find((c) => String(c.customer_id ?? '') === String(customerId));
        if (!linked) return;
        const messagesResult = await apiClient.getMessages(linked.id, { page: 1, limit: 3, signal: controller.signal });
        if (controller.signal.aborted) return;
        const snippets = (messagesResult.messages || [])
          .slice(-3)
          .map((msg) => msg.content)
          .filter(Boolean);
        setLinkedConversationId(linked.id);
        setConversationSnippets(snippets);
      } catch (err: unknown) {
        if ((err as { code?: string })?.code !== 'ERR_CANCELED') {
          console.error('Failed to load conversation snippet:', err);
        }
      }
    };

    loadConversationSnippet();
    return () => controller.abort();
  }, [selectedOrder?.id, selectedOrder?.customerId]);

  const handleUpdateStatus = async (orderId: string, newStatus: Order['status']) => {
    try {
      let updatedOrder: Order;
      if (newStatus === 'confirmed') {
        updatedOrder = await apiClient.confirmOrder(orderId);
      } else {
        updatedOrder = await apiClient.updateOrder(orderId, { status: newStatus });
      }

      setOrders(current => current.map(o =>
        o.id === orderId ? updatedOrder : o
      ));
      if (selectedOrder?.id === orderId) {
        setSelectedOrder(updatedOrder);
      }
      setConfidenceRefresh((count) => count + 1);
      setIsLoading(true);
      setRetryCount((count) => count + 1);
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, t('orders.errors.updateStatus')));
    }
  };

  const handleCorrectPaymentMethod = async () => {
    if (!canCorrectPaymentMethod || !selectedOrder || !paymentMethodCorrection) return;
    try {
      setIsUpdatingPaymentMethod(true);
      const updatedOrder = await apiClient.updateOrder(selectedOrder.id, {
        payment_method: paymentMethodCorrection,
      });
      setSelectedOrder(updatedOrder);
      setOrders((current) => current.map((order) => order.id === updatedOrder.id ? updatedOrder : order));
      setConfidenceRefresh((count) => count + 1);
      setIsLoading(true);
      setRetryCount((count) => count + 1);
      toast.success(t('orders.paymentMethodUpdated'));
    } catch (err: unknown) {
      const status = (err as { statusCode?: number; response?: { status?: number } })?.statusCode
        ?? (err as { response?: { status?: number } })?.response?.status;
      if (status === 409) setPaymentMethodCorrectionUnavailable(true);
      toast.error(getErrorMessage(err, t('orders.errors.updateStatus')));
    } finally {
      setIsUpdatingPaymentMethod(false);
    }
  };

  const handleSaveNote = async () => {
    if (!selectedOrder || !detailNote.trim()) return;
    try {
      await apiClient.updateOrder(selectedOrder.id, { note: detailNote });
      setDetailNote('');
      toast.success(t('orders.detailModal.noteSaved'));
    } catch (err: unknown) {
      console.error('Failed to save note:', err);
      toast.error(t('orders.errors.updateStatus'));
    }
  };

  const buildCsv = (rows: Record<string, string | number>[]) => {
    const headers = Object.keys(rows[0] || {});
    const escapeCsv = (value: string | number) => {
      const text = String(value ?? '');
      if (text.includes(',') || text.includes('"') || text.includes('\n')) {
        return `"${text.replace(/"/g, '""')}"`;
      }
      return text;
    };

    const lines = [headers.join(',')];
    rows.forEach((row) => {
      lines.push(headers.map((header) => escapeCsv(row[header] ?? '')).join(','));
    });

    return lines.join('\n');
  };

  const downloadFile = (content: string, filename: string, type: string) => {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  const handleExport = (format: 'csv' | 'excel') => {
    if (orders.length === 0) {
      toast.error(t('orders.errors.noExportData'));
      setShowExportMenu(false);
      return;
    }

    if (format === 'excel') {
      toast.info(t('orders.errors.csvFallback'));
    }

    const rows = orders.map((order) => ({
      id: order.id,
      customer: order.customerName,
      total: order.total,
      status: order.status,
      channel: order.channel,
      createdAt: order.createdAt
    }));

    const csv = buildCsv(rows);
    downloadFile(csv, 'orders.csv', 'text/csv');
    setShowExportMenu(false);
  };

  const addProductToOrder = (product: Product, quantity: number = 1) => {
    const existingItem = manualOrder.items.find(item => item.productId === product.id);
    if (existingItem) {
      setManualOrder({
        ...manualOrder,
        items: manualOrder.items.map(item =>
          item.productId === product.id
            ? { ...item, quantity: item.quantity + quantity }
            : item
        )
      });
    } else {
      setManualOrder({
        ...manualOrder,
        items: [
          ...manualOrder.items,
          {
            productId: product.id,
            productName: product.name,
            quantity,
            price: product.price,
            sku: product.sku,
          }
        ]
      });
    }
    setShowProductSelector(false);
  };

  const removeProductFromOrder = (productId: string) => {
    setManualOrder({
      ...manualOrder,
      items: manualOrder.items.filter(item => item.productId !== productId)
    });
  };

  const updateProductQuantity = (productId: string, quantity: number) => {
    if (quantity <= 0) {
      removeProductFromOrder(productId);
      return;
    }
    setManualOrder({
      ...manualOrder,
      items: manualOrder.items.map(item =>
        item.productId === productId ? { ...item, quantity } : item
      )
    });
  };

  const calculateSubtotal = () => {
    return manualOrder.items.reduce((sum, item) => sum + (item.price * item.quantity), 0);
  };

  const calculateTotal = () => {
    const subtotal = calculateSubtotal();
    return subtotal - manualOrder.discount + manualOrder.tax + manualOrder.delivery;
  };

  const handleCreateOrder = async () => {
    if (!manualOrder.customerName.trim()) { toast.error(t('orders.errors.nameRequired')); return; }
    if (!manualOrder.customerPhone.trim()) { toast.error(t('orders.errors.phoneRequired')); return; }
    if (!manualOrder.paymentMethod) { toast.error(t('orders.errors.paymentMethodRequired')); return; }
    if (!manualOrder.division || !manualOrder.district || !manualOrder.upazila || !manualOrder.streetAddress.trim()) {
      toast.error(t('orders.errors.addressRequired')); return;
    }
    if (manualOrder.items.length === 0) { toast.error(t('orders.errors.itemRequired')); return; }

    try {
      setIsCreating(true);

      // Transform frontend order data to backend format
      const selectedDivision = bdGeography.divisions.find((d) => d.id === manualOrder.division);
      const selectedDistrict = selectedDivision?.districts.find((d) => d.id === manualOrder.district);
      const structuredAddress: DeliveryAddress = {
        division: selectedDivision?.name || manualOrder.division,
        district: selectedDistrict?.name || manualOrder.district,
        upazila: manualOrder.upazila,
        street_address: manualOrder.streetAddress,
        zone: deriveZone(manualOrder.division, manualOrder.district),
      };
      const orderData = {
        customer_name: manualOrder.customerName,
        customer_phone: manualOrder.customerPhone,
        delivery_address: structuredAddress,
        channel: manualOrder.channel,
        items: manualOrder.items.map(item => ({
          product_id: item.productId,
          quantity: item.quantity,
          price: item.price
        })),
        discount: manualOrder.discount,
        tax: manualOrder.tax,
        delivery_fee: manualOrder.delivery,
        payment_status: manualOrder.payment,
        payment_method: manualOrder.paymentMethod,
        note: manualOrder.notes
      };

      const requestFingerprint = JSON.stringify(orderData);
      let idempotencyKey = createOrderRetryKeysRef.current.get(requestFingerprint);
      if (!idempotencyKey) {
        idempotencyKey = typeof globalThis.crypto?.randomUUID === 'function'
          ? globalThis.crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        createOrderRetryKeysRef.current.set(requestFingerprint, idempotencyKey);
        if (createOrderRetryKeysRef.current.size > 5) {
          const oldest = createOrderRetryKeysRef.current.keys().next().value;
          if (oldest) createOrderRetryKeysRef.current.delete(oldest);
        }
      }

      const newOrder = await apiClient.createOrder(orderData, idempotencyKey);
      createOrderRetryKeysRef.current.delete(requestFingerprint);
      setSelectedOrder(newOrder);
      setIsLoading(true);
      setRetryCount((count) => count + 1);
      setShowCreateOrder(false);
      toast.success(t('orders.createModal.createSuccess', { orderId: newOrder.orderNumber || newOrder.id }));
      setManualOrder({
        customerName: '',
        customerPhone: '',
        deliveryAddress: '',
        division: '',
        district: '',
        upazila: '',
        streetAddress: '',
        channel: 'manual',
        items: [],
        discount: 0,
        tax: 0,
        delivery: 0,
        payment: 'pending',
        paymentMethod: '',
        notes: '',
        source: 'manual',
        createdBy: 'user',
      });
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, t('orders.errors.createFailed')));
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <div className={`p-4 md:p-8 ${selectedOrder ? 'lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(320px,380px)] lg:items-start lg:gap-4' : ''}`}>
      <div className="min-w-0">
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl font-bold text-foreground">{t('orders.title')}</h1>
            <p className="mt-1 text-sm text-muted-foreground">{t('orders.subtitle')}</p>
          </div>
          <div className="flex shrink-0 gap-2">
            <div className="relative">
              <button
                type="button"
                onClick={() => setShowExportMenu(!showExportMenu)}
                disabled={isLoading || loadError || orders.length === 0}
                className="flex min-h-10 items-center gap-2 rounded-lg border border-border px-3 text-sm text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Download className="h-4 w-4" />
                {t('orders.export')}
                <ChevronDown className="h-4 w-4" />
              </button>
              {showExportMenu && (
                <>
                  <div className="fixed inset-0 z-[9]" onClick={() => setShowExportMenu(false)} />
                  <div ref={exportMenuRef} className="absolute right-0 z-10 mt-2 w-40 rounded-lg border border-border bg-card shadow-lg">
                    <button onClick={() => handleExport('csv')} className="w-full px-4 py-2 text-left text-sm hover:bg-muted">
                      {t('orders.exportCSV')}
                    </button>
                    <button onClick={() => handleExport('excel')} className="w-full border-t border-border px-4 py-2 text-left text-sm hover:bg-muted">
                      {t('orders.exportExcel')}
                    </button>
                  </div>
                </>
              )}
            </div>
            <button
              type="button"
              onClick={() => setShowCreateOrder(true)}
              className="flex min-h-10 items-center gap-2 rounded-lg bg-primary px-3 text-sm font-semibold text-primary-foreground hover:opacity-90"
            >
              <Plus className="h-4 w-4" />
              {t('orders.createOrder')}
            </button>
          </div>
        </div>

        <section aria-label={t('orders.toolbarLabel')} className="mb-4 rounded-xl border border-border bg-card p-3">
          <div role="group" aria-label={t('orders.buckets.label')} className="mb-3 flex flex-wrap gap-2">
            {[{ key: 'all' as const, labelKey: 'orders.buckets.all', count: worklistCounts?.total }, ...WORKLIST_BUCKETS.map((bucket) => ({
              ...bucket,
              count: worklistCounts ? worklistCounts[bucket.key] : undefined,
            }))].map((bucket) => {
              const active = deliveryBucket === bucket.key;
              return (
                <button
                  key={bucket.key}
                  type="button"
                  aria-pressed={active}
                  data-testid={`orders-bucket-${bucket.key}`}
                  onClick={() => { setIsLoading(true); setDeliveryBucket(bucket.key); }}
                  className={`flex min-h-9 items-center gap-2 rounded-full border px-3 text-xs font-semibold transition-colors ${
                    active
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-border bg-background text-foreground hover:border-primary'
                  }`}
                >
                  <span>{t(bucket.labelKey)}</span>
                  <span
                    data-testid={`orders-bucket-count-${bucket.key}`}
                    className={`rounded-full px-1.5 py-0.5 text-[11px] tabular-nums ${
                      active ? 'bg-primary-foreground/20' : 'bg-muted text-muted-foreground'
                    }`}
                  >
                    {bucket.count === undefined ? '—' : bucket.count}
                  </span>
                </button>
              );
            })}
          </div>
          <div className="grid gap-2 md:grid-cols-[minmax(220px,1fr)_repeat(2,minmax(145px,190px))] xl:grid-cols-[minmax(260px,1fr)_repeat(4,minmax(140px,180px))]">
            <label className="relative block min-w-0">
              <span className="sr-only">{t('orders.searchLabel')}</span>
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                type="search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={t('orders.searchPlaceholder')}
                aria-label={t('orders.searchLabel')}
                className="min-h-10 w-full rounded-lg border border-border bg-background pl-10 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </label>
            <label>
              <span className="sr-only">{t('orders.filterDate')}</span>
              <select aria-label={t('orders.filterDate')} value={dateFilter} onChange={(e) => { setIsLoading(true); setDateFilter(e.target.value); }} className="min-h-10 w-full rounded-lg border border-border bg-background px-3 text-sm">
                <option value="all">{t('orders.dateAll')}</option>
                <option value="today">{t('orders.dateToday')}</option>
                <option value="last7days">{t('orders.dateLast7')}</option>
                <option value="last30days">{t('orders.dateLast30')}</option>
              </select>
            </label>
            <label>
              <span className="sr-only">{t('orders.filterOrderStatus')}</span>
              <select aria-label={t('orders.filterOrderStatus')} value={orderStatusFilter} onChange={(e) => { setIsLoading(true); setOrderStatusFilter(e.target.value); }} className="min-h-10 w-full rounded-lg border border-border bg-background px-3 text-sm">
                <option value="all">{t('orders.orderStatusAll')}</option>
                <option value="draft">{t('orders.statusDraft')}</option>
                <option value="confirmed">{t('orders.statusConfirmed')}</option>
                <option value="processing">{t('orders.statusProcessing')}</option>
                <option value="completed">{t('orders.statusCompleted')}</option>
                <option value="delivered">{t('orders.statusDelivered')}</option>
                <option value="cancelled">{t('orders.statusCancelled')}</option>
              </select>
            </label>
            <label>
              <span className="sr-only">{t('orders.filterFulfillmentStatus')}</span>
              <select aria-label={t('orders.filterFulfillmentStatus')} value={fulfillmentStatusFilter} onChange={(e) => { setIsLoading(true); setFulfillmentStatusFilter(e.target.value); }} className="min-h-10 w-full rounded-lg border border-border bg-background px-3 text-sm">
                <option value="all">{t('orders.fulfillmentStatusAll')}</option>
                <option value="unfulfilled">{t('orders.fulfillmentStatus.unfulfilled')}</option>
                <option value="fulfilled">{t('orders.fulfillmentStatus.fulfilled')}</option>
                <option value="partially_fulfilled">{t('orders.fulfillmentStatus.partially_fulfilled')}</option>
                <option value="cancelled">{t('orders.fulfillmentStatus.cancelled')}</option>
              </select>
            </label>
            <label>
              <span className="sr-only">{t('orders.filterPaymentStatus')}</span>
              <select aria-label={t('orders.filterPaymentStatus')} value={paymentStatusFilter} onChange={(e) => { setIsLoading(true); setPaymentStatusFilter(e.target.value); }} className="min-h-10 w-full rounded-lg border border-border bg-background px-3 text-sm">
                <option value="all">{t('orders.paymentStatusAll')}</option>
                <option value="pending">{t('orders.paymentStatus.pending')}</option>
                <option value="paid">{t('orders.paymentStatus.paid')}</option>
                <option value="unpaid">{t('orders.paymentStatus.unpaid')}</option>
                <option value="partially_paid">{t('orders.paymentStatus.partially_paid')}</option>
                <option value="refunded">{t('orders.paymentStatus.refunded')}</option>
              </select>
            </label>
          </div>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">{t('orders.listScope')}</p>
            <button
              type="button"
              onClick={() => {
                setIsLoading(true);
                setSearchQuery('');
                setOrderStatusFilter('all');
                setFulfillmentStatusFilter('all');
                setPaymentStatusFilter('all');
                setDateFilter('all');
                setDeliveryBucket('all');
              }}
              className="text-xs font-semibold text-primary hover:underline"
            >
              {t('orders.clearFilters')}
            </button>
          </div>
        </section>

        {deepLinkError && (
          <div role="alert" className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm">
            <span>{t('orders.deepLinkFailed')}</span>
            <button type="button" onClick={() => setDeepLinkRetry((retry) => retry + 1)} className="font-semibold text-primary hover:underline">
              {t('orders.retry')}
            </button>
          </div>
        )}

        {isLoading || searchQuery !== appliedSearchQuery ? (
          <div role="status" className="rounded-xl border border-border bg-card p-8 text-center text-sm text-muted-foreground">
            <Loader2 className="mx-auto mb-2 h-5 w-5 animate-spin" />
            {t('orders.loading')}
          </div>
        ) : loadError ? (
          <div role="alert" className="rounded-xl border border-destructive/30 bg-card p-8 text-center">
            <p className="text-sm text-foreground">{t('orders.loadError')}</p>
            <button type="button" onClick={() => setRetryCount((count) => count + 1)} className="mt-3 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground">
              {t('orders.retry')}
            </button>
          </div>
        ) : orders.length === 0 ? (
          <div className="rounded-xl border border-border bg-card p-10 text-center">
            <PackageIcon className="mx-auto mb-3 h-10 w-10 text-muted-foreground" />
            <p className="text-sm font-medium text-muted-foreground">
              {appliedSearchQuery || orderStatusFilter !== 'all' || fulfillmentStatusFilter !== 'all' || paymentStatusFilter !== 'all' || dateFilter !== 'all' || deliveryBucket !== 'all'
                ? t('orders.noMatches')
                : t('orders.emptyShop')}
            </p>
          </div>
        ) : (
          <>
            <div className="space-y-3 md:hidden">
              {orders.map((order) => (
                <OrderRow
                  key={order.id}
                  order={order}
                  formatCurrency={formatCurrency}
                  formatDate={formatDate}
                  onViewDetail={setSelectedOrder}
                  onDispatch={(selected) => { setSelectedOrder(selected); setShowCourierModal(true); }}
                />
              ))}
            </div>
            <div className="hidden overflow-hidden rounded-xl border border-border bg-card md:block">
              <p className="border-b border-border px-3 py-2 text-xs text-muted-foreground">{t('orders.desktopTableScrollHint')}</p>
              <div className="overflow-x-auto">
                <table className="min-w-[1240px] w-full border-collapse text-left text-sm">
                  <thead className="bg-muted/60 text-xs uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="px-3 py-3 font-semibold">{t('orders.columns.orderId')}</th>
                      <th className="px-3 py-3 font-semibold">{t('orders.columns.customer')}</th>
                      <th className="px-3 py-3 font-semibold">{t('orders.columns.items')}</th>
                      <th className="px-3 py-3 font-semibold">{t('orders.columns.channel')}</th>
                      <th className="px-3 py-3 text-right font-semibold">{t('orders.columns.total')}</th>
                      <th className="px-3 py-3 font-semibold">{t('orders.columns.status')}</th>
                      <th className="px-3 py-3 font-semibold">{t('orders.columns.payment')}</th>
                      <th className="px-3 py-3 font-semibold">{t('orders.columns.delivery')}</th>
                      <th className="px-3 py-3 font-semibold">{t('orders.columns.expectedCollection')}</th>
                      <th className="px-3 py-3 font-semibold">{t('orders.columns.created')}</th>
                      <th className="px-3 py-3 font-semibold">{t('orders.columns.actions')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {orders.map((order) => (
                      <OrderTableRow
                        key={order.id}
                        order={order}
                        selected={selectedOrder?.id === order.id}
                        formatCurrency={formatCurrency}
                        formatDate={formatDate}
                        onViewDetail={setSelectedOrder}
                        onDispatch={(selected) => { setSelectedOrder(selected); setShowCourierModal(true); }}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}

      {/* Create Order Modal */}
      {showCreateOrder && (
        <div
          className="fixed inset-0 bg-gray-900/60 flex items-center justify-center z-50 p-4"
          onKeyDown={(e) => { if (e.key === 'Escape') setShowCreateOrder(false); }}
          onClick={(e) => { if (e.target === e.currentTarget) setShowCreateOrder(false); }}
        >
          <div data-testid="create-order-modal" className="bg-card rounded-xl max-w-4xl w-full max-h-[90vh] overflow-y-auto">
            <div className="sticky top-0 bg-card border-b border-border px-6 py-4 flex items-center justify-between z-10">
              <h2 className="text-2xl font-bold text-card-foreground">{t('orders.createModal.title')}</h2>
              <button
                onClick={() => setShowCreateOrder(false)}
                className="text-gray-500 hover:text-gray-700"
              >
                <XCircle className="w-6 h-6" />
              </button>
            </div>

            <div className="p-6 space-y-6">
              <p role="note" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 font-bn">
                {t('orders.createModal.draftStockDisclosure')}
              </p>
              {/* Customer Info */}
              <div>
                <h3 className="font-semibold text-gray-900 mb-3">{t('orders.createModal.customerSection')}</h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      {t('orders.createModal.customerName')} <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="text"
                      value={manualOrder.customerName}
                      onChange={(e) => setManualOrder({ ...manualOrder, customerName: e.target.value })}
                      placeholder={t('orders.createModal.customerNamePlaceholder')}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand"
                    />
                  </div>
                  <div>
                    <BDPhoneInput
                      label={t('orders.createModal.phone')}
                      value={manualOrder.customerPhone}
                      onChange={(raw) => setManualOrder({ ...manualOrder, customerPhone: raw })}
                      required
                      id="order-customer-phone"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">{t('orders.createModal.channel')}</label>
                    <select
                      value={manualOrder.channel}
                      onChange={(e) => setManualOrder({ ...manualOrder, channel: e.target.value })}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand"
                    >
                      <option value="manual">{t('orders.createModal.channelManual')}</option>
                      <option value="facebook">{t('orders.createModal.channelFacebook')}</option>
                      <option value="webchat">{t('orders.createModal.channelWebChat')}</option>
                      <option value="telegram">{t('orders.createModal.channelTelegram')}</option>
                    </select>
                  </div>
                </div>

                {/* Delivery Address — structured BD geography */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    {t('orders.createModal.address')} <span className="text-red-500">*</span>
                  </label>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mb-2">
                    <select
                      value={manualOrder.division}
                      onChange={(e) => setManualOrder({ ...manualOrder, division: e.target.value, district: '', upazila: '' })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand text-sm"
                    >
                      <option value="">{t('orders.form.division')}</option>
                      {bdGeography.divisions.map((div) => (
                        <option key={div.id} value={div.id}>{div.name} / {div.name_bn}</option>
                      ))}
                    </select>
                    <select
                      value={manualOrder.district}
                      onChange={(e) => setManualOrder({ ...manualOrder, district: e.target.value, upazila: '' })}
                      disabled={!manualOrder.division}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand text-sm disabled:bg-gray-100"
                    >
                      <option value="">{t('orders.form.district')}</option>
                      {bdGeography.divisions
                        .find((d) => d.id === manualOrder.division)
                        ?.districts.map((dist) => (
                          <option key={dist.id} value={dist.id}>{dist.name} / {dist.name_bn}</option>
                        ))}
                    </select>
                    <select
                      value={manualOrder.upazila}
                      onChange={(e) => setManualOrder({ ...manualOrder, upazila: e.target.value })}
                      disabled={!manualOrder.district}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand text-sm disabled:bg-gray-100"
                    >
                      <option value="">{t('orders.form.upazila')}</option>
                      {bdGeography.divisions
                        .find((d) => d.id === manualOrder.division)
                        ?.districts.find((d) => d.id === manualOrder.district)
                        ?.upazilas.map((upazila) => (
                          <option key={upazila} value={upazila}>{upazila}</option>
                        ))}
                    </select>
                  </div>
                  <input
                    type="text"
                    value={manualOrder.streetAddress}
                    onChange={(e) => setManualOrder({ ...manualOrder, streetAddress: e.target.value })}
                    placeholder={t('orders.form.streetAddress')}
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand text-sm"
                  />
                  {manualOrder.division && manualOrder.district && (
                    <p className="text-xs text-gray-500 mt-1">
                      {t('orders.createModal.zone')}: <span className="font-medium text-brand-hover">{deriveZone(manualOrder.division, manualOrder.district)?.replace(/_/g, ' ')}</span>
                    </p>
                  )}
                </div>
              </div>

              {/* Products — Bug #14: inline search, no separate modal */}
              <div>
                <h3 className="font-semibold text-gray-900 mb-3">{t('orders.createModal.productsSection')}</h3>

                {/* Inline product search */}
                <div className="relative mb-3">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                  <input
                    type="text"
                    placeholder={t('orders.createModal.searchProducts')}
                    value={productSearchQuery}
                    onChange={(e) => setProductSearchQuery(e.target.value)}
                    className="w-full pl-9 pr-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand text-sm"
                  />
                  {/* Dropdown results */}
                  {productSearchQuery.trim().length >= 1 && (
                    <div className="absolute top-full left-0 right-0 bg-white border border-gray-200 rounded-lg shadow-lg z-10 max-h-48 overflow-y-auto mt-1">
                      {products
                        .filter(p =>
                          p.name.toLowerCase().includes(productSearchQuery.toLowerCase()) ||
                          (p.sku || '').toLowerCase().includes(productSearchQuery.toLowerCase())
                        )
                        .slice(0, 8)
                        .map(product => (
                          <button
                            key={product.id}
                            type="button"
                            onClick={() => {
                              addProductToOrder(product);
                              setProductSearchQuery('');
                            }}
                            className="w-full flex items-center justify-between px-4 py-2.5 hover:bg-emerald-50 text-left text-sm border-b border-gray-100 last:border-0"
                          >
                            <span className="font-medium text-gray-900 truncate">{product.name}</span>
                            <span className="ml-2 text-brand-hover font-semibold whitespace-nowrap">{formatCurrency(product.price)}</span>
                          </button>
                        ))
                      }
                      {products.filter(p =>
                        p.name.toLowerCase().includes(productSearchQuery.toLowerCase()) ||
                        (p.sku || '').toLowerCase().includes(productSearchQuery.toLowerCase())
                      ).length === 0 && (
                        <p className="px-4 py-3 text-sm text-gray-500">{t('orders.createModal.noProductsFound')}</p>
                      )}
                    </div>
                  )}
                </div>

                {manualOrder.items.length === 0 ? (
                  <div className="border-2 border-dashed border-gray-300 rounded-lg p-8 text-center">
                    <PackageIcon className="w-12 h-12 text-gray-400 mx-auto mb-3" />
                    <p className="text-gray-600">{t('orders.createModal.noProducts')}</p>
                  </div>
                ) : (
                  <div className="border border-gray-200 rounded-lg divide-y divide-gray-200">
                    {manualOrder.items.map((item, index) => (
                      <div key={index} className="p-4 flex items-center gap-4">
                        <div className="flex-1">
                          {item.productId ? (
                            <ContextualEntityLink to={`/products/${encodeURIComponent(item.productId)}`}>
                              {item.productName}
                            </ContextualEntityLink>
                          ) : (
                            <p className="font-medium text-gray-900">{item.productName}</p>
                          )}
                          <p className="text-sm text-gray-500">{t('orders.labels.sku')}: {item.sku} • {formatCurrency(item.price)}</p>
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => updateProductQuantity(item.productId, item.quantity - 1)}
                            className="w-8 h-8 border border-gray-300 rounded hover:bg-gray-50"
                          >
                            -
                          </button>
                          <span className="w-12 text-center text-sm font-medium">{item.quantity}</span>
                          <button
                            onClick={() => updateProductQuantity(item.productId, item.quantity + 1)}
                            className="w-8 h-8 border border-gray-300 rounded hover:bg-gray-50"
                          >
                            +
                          </button>
                        </div>
                        <div className="w-24 text-right font-semibold text-gray-900">
                          {formatCurrency(item.price * item.quantity)}
                        </div>
                        <button
                          onClick={() => removeProductFromOrder(item.productId)}
                          className="text-red-600 hover:text-red-700"
                        >
                          <X className="w-5 h-5" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Order Summary */}
              <div className="bg-gray-50 rounded-lg p-4">
                <h3 className="font-semibold text-gray-900 mb-4">{t('orders.createModal.orderSummary')}</h3>
                <div className="space-y-3">
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-600">{t('orders.createModal.subtotal')}:</span>
                    <span className="text-gray-900">{formatCurrency(calculateSubtotal())}</span>
                  </div>
                  <div className="flex justify-between text-sm items-center">
                    <span className="text-gray-600">{t('orders.createModal.discount')}:</span>
                    <div className="flex items-center gap-2">
                      <span className="text-gray-500">৳</span>
                      <input
                        type="number"
                        value={manualOrder.discount}
                        onChange={(e) => setManualOrder({ ...manualOrder, discount: parseFloat(e.target.value) || 0 })}
                        className="w-24 px-2 py-1 border border-gray-300 rounded text-right text-sm"
                        step="0.01"
                        min="0"
                      />
                    </div>
                  </div>
                  <div className="flex justify-between text-sm items-center">
                    <span className="text-gray-600">{t('orders.createModal.vat')}:</span>
                    <div className="flex items-center gap-2">
                      <span className="text-gray-500">৳</span>
                      <input
                        type="number"
                        value={manualOrder.tax}
                        onChange={(e) => setManualOrder({ ...manualOrder, tax: parseFloat(e.target.value) || 0 })}
                        className="w-24 px-2 py-1 border border-gray-300 rounded text-right text-sm"
                        step="0.01"
                        min="0"
                      />
                    </div>
                  </div>
                  <div className="flex justify-between text-sm items-center">
                    <span className="text-gray-600">{t('orders.createModal.delivery')}:</span>
                    <div className="flex items-center gap-2">
                      <span className="text-gray-500">৳</span>
                      <input
                        type="number"
                        value={manualOrder.delivery}
                        onChange={(e) => setManualOrder({ ...manualOrder, delivery: parseFloat(e.target.value) || 0 })}
                        className="w-24 px-2 py-1 border border-gray-300 rounded text-right text-sm"
                        step="0.01"
                        min="0"
                      />
                    </div>
                  </div>
                  <div className="border-t border-gray-300 pt-3 flex justify-between font-bold">
                    <span className="text-gray-900">{t('orders.createModal.total')}:</span>
                    <span className="text-brand-hover text-lg">{formatCurrency(calculateTotal())}</span>
                  </div>
                </div>
              </div>

              {/* Payment & Notes */}
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    {t('orders.createModal.paymentMethod')} <span className="text-red-500">*</span>
                  </label>
                  <select
                    aria-label={t('orders.createModal.paymentMethod')}
                    required
                    value={manualOrder.paymentMethod}
                    onChange={(e) => setManualOrder({ ...manualOrder, paymentMethod: e.target.value })}
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand"
                  >
                    <option value="">{t('orders.createModal.selectPaymentMethod')}</option>
                    {paymentMethodChoices.map((gateway) => (
                      <option key={gateway} value={gateway}>{paymentMethodLabel(gateway)}</option>
                    ))}
                  </select>
                  {paymentMethodsLoadFailed && (
                    <p className="mt-1 text-xs text-amber-800">
                      {t('orders.paymentConfigUnavailable')} {' '}
                      <button type="button" onClick={() => setPaymentMethodsRetry((retry) => retry + 1)} className="font-semibold underline">
                        {t('orders.retry')}
                      </button>
                    </p>
                  )}
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">{t('orders.createModal.paymentStatus')}</label>
                  <select
                    value={manualOrder.payment}
                    onChange={(e) => setManualOrder({ ...manualOrder, payment: e.target.value })}
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand"
                  >
                    <option value="pending">{t('orders.createModal.payPending')}</option>
                    <option value="paid">{t('orders.createModal.payPaid')}</option>
                    <option value="unpaid">{t('orders.createModal.payUnpaid')}</option>
                    <option value="refunded">{t('orders.createModal.payRefunded')}</option>
                    <option value="partially_paid">{t('orders.createModal.payPartial')}</option>
                  </select>
                  {(manualOrder.payment === 'unpaid' || manualOrder.payment === 'pending') && (
                    <p className="mt-1.5 flex items-center gap-1 text-xs text-amber-700">
                      <AlertTriangle className="w-3 h-3 flex-shrink-0" />
                      {t('orders.createModal.rtoWarning')}
                    </p>
                  )}
                </div>
                <div className="sm:col-span-2">
                  <label className="block text-sm font-medium text-gray-700 mb-2">{t('orders.createModal.notes')}</label>
                  <input
                    type="text"
                    value={manualOrder.notes}
                    onChange={(e) => setManualOrder({ ...manualOrder, notes: e.target.value })}
                    placeholder={t('orders.createModal.notesPlaceholder')}
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand"
                  />
                </div>
              </div>
            </div>

            <div className="border-t border-gray-200 px-6 py-4 flex gap-3">
              <button
                onClick={() => setShowCreateOrder(false)}
                className="flex-1 px-6 py-3 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={handleCreateOrder}
                disabled={
                  isCreating ||
                  !manualOrder.customerName ||
                  !manualOrder.customerPhone ||
                  !manualOrder.paymentMethod ||
                  (!manualOrder.division || !manualOrder.district || !manualOrder.upazila || !manualOrder.streetAddress.trim()) ||
                  manualOrder.items.length === 0
                }
                className="flex-1 flex items-center justify-center gap-2 px-6 py-3 bg-primary text-primary-foreground rounded-lg hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isCreating && <Loader2 className="w-4 h-4 animate-spin" />}
                {t('orders.createModal.createButton')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Product Selector Modal */}
      {showProductSelector && (
        <div
          className="fixed inset-0 bg-gray-900/60 flex items-center justify-center z-[60] p-4"
          onKeyDown={(e) => { if (e.key === 'Escape') setShowProductSelector(false); }}
          onClick={(e) => { if (e.target === e.currentTarget) setShowProductSelector(false); }}
        >
          <div className="bg-white rounded-xl max-w-2xl w-full max-h-[80vh] overflow-hidden flex flex-col">
            <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
              <h3 className="text-lg font-bold text-gray-900">{t('orders.selectProduct.title')}</h3>
              <button
                onClick={() => setShowProductSelector(false)}
                className="text-gray-500 hover:text-gray-700"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-6">
              <div className="space-y-3">
                {products.map((product) => (
                  <button
                    key={product.id}
                    onClick={() => addProductToOrder(product)}
                    className="w-full flex items-center gap-4 p-4 border border-gray-200 rounded-lg hover:border-brand hover:bg-emerald-50 transition-colors text-left"
                  >
                    <div className="w-12 h-12 bg-gray-100 rounded-lg flex items-center justify-center">
                      <PackageIcon className="w-6 h-6 text-gray-600" />
                    </div>
                    <div className="flex-1">
                      <p className="font-medium text-gray-900">{product.name}</p>
                      <p className="text-sm text-gray-500">{t('orders.labels.sku')}: {product.sku} • {product.category}</p>
                    </div>
                    <div className="text-right">
                      <p className="font-semibold text-gray-900">{formatCurrency(product.price)}</p>
                      <p className="text-xs text-green-600">{product.stock ? t('orders.selectProduct.inStock') : t('orders.selectProduct.outOfStock')}</p>
                    </div>
                  </button>
                ))}
              </div>

              <div className="mt-6 p-4 bg-gray-50 rounded-lg border border-gray-200">
                <p className="text-sm text-gray-700 mb-3 flex items-center gap-2">
                  <Plus className="w-4 h-4" />
                  {t('orders.selectProduct.createNew')}
                </p>
                <button
                  onClick={() => {
                    setShowProductSelector(false);
                    setShowCreateOrder(false);
                    navigate('/products/add');
                  }}
                  className="w-full px-4 py-2 bg-white border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors"
                >
                  {t('orders.selectProduct.createButton')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      </div>

      {/* Selected order context; full-screen on mobile, docked beside the table on desktop. */}
      {selectedOrder && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-gray-900/60 p-3 lg:static lg:col-start-2 lg:row-start-1 lg:block lg:bg-transparent lg:p-0"
          role="region"
          aria-label={t('orders.detailModal.title')}
          data-testid="order-detail-panel"
          onKeyDown={(e) => { if (e.key === 'Escape') setSelectedOrder(null); }}
          onClick={(e) => { if (e.target === e.currentTarget) setSelectedOrder(null); }}
        >
          <div className="max-h-[96vh] w-full max-w-2xl overflow-y-auto rounded-xl bg-card p-4 md:p-6 lg:max-h-[calc(100vh-4rem)] lg:max-w-none lg:border lg:border-border">
            <div className="flex items-center justify-between mb-6">
              <div>
                <h2 className="text-2xl font-bold text-gray-900">{t('orders.detailModal.title')}</h2>
                <p className="text-gray-600 mt-1">{selectedOrder.orderNumber || selectedOrder.id}</p>
              </div>
              <button
                onClick={() => setSelectedOrder(null)}
                className="text-gray-500 hover:text-gray-700"
              >
                <XCircle className="w-6 h-6" />
              </button>
            </div>

            {/* Customer Info */}
            <div className="bg-gray-50 rounded-lg p-4 mb-6">
              <h3 className="font-semibold text-gray-900 mb-3">{t('orders.detailModal.customerSection')}</h3>
              <div className="space-y-2">
                <div className="flex justify-between">
                  <span className="text-gray-600">{t('orders.detailModal.name')}:</span>
                  <span className="text-gray-900 font-medium">{selectedOrder.customerName}</span>
                </div>
                <div className="flex flex-wrap gap-2 pt-2">
                  {selectedOrder.customerPhone ? (
                    <>
                      <a
                        href={`tel:${selectedOrder.customerPhone}`}
                        className="min-h-12 rounded-lg border border-gray-300 px-3 py-2 text-sm font-semibold text-gray-700"
                      >
                        {t('orders.detailModal.call')}
                      </a>
                    </>
                  ) : (
                    <span className="text-xs text-gray-500">{t('orders.detailModal.noPhone')}</span>
                  )}
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600">{t('orders.detailModal.channel')}:</span>
                  <span className="text-gray-900 font-medium capitalize">{selectedOrder.channel}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600">{t('orders.detailModal.created')}:</span>
                  <span className="text-gray-900 font-medium">
                    {formatDate(selectedOrder.createdAt)}
                  </span>
                </div>
              </div>
            </div>

            <div className="bg-gray-50 rounded-lg p-4 mb-6">
              <h3 className="font-semibold text-gray-900 mb-3">{t('orders.detailModal.deliveryAddress')}</h3>
              {selectedOrder.delivery_address ? (
                <div className="space-y-1 text-sm text-gray-700 mb-3">
                  {selectedOrder.delivery_address.street_address && (
                    <p>{selectedOrder.delivery_address.street_address}</p>
                  )}
                  {(selectedOrder.delivery_address.upazila || selectedOrder.delivery_address.district) && (
                    <p>{[selectedOrder.delivery_address.upazila, selectedOrder.delivery_address.district].filter(Boolean).join(', ')}</p>
                  )}
                  {selectedOrder.delivery_address.division && (
                    <p>{selectedOrder.delivery_address.division}</p>
                  )}
                  {selectedOrder.delivery_address.zone && (
                    <span className="inline-block text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full mt-1">
                      {t('orders.detailModal.zoneLabel')}: {selectedOrder.delivery_address.zone.replace(/_/g, ' ')}
                    </span>
                  )}
                </div>
              ) : (
                <p className="text-sm text-gray-700 mb-3">{selectedOrder.deliveryAddress || t('orders.detailModal.noAddress')}</p>
              )}
              {selectedOrder.deliveryAddress && (
                <a
                  href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(selectedOrder.deliveryAddress)}`}
                  target="_blank"
                  rel="noreferrer"
                  className="block rounded-lg border border-gray-200 bg-white p-3 text-sm font-semibold text-brand-hover"
                >
                  {t('orders.detailModal.viewOnMap')}
                </a>
              )}
            </div>

            <div className="bg-gray-50 rounded-lg p-4 mb-6">
              <h3 className="font-semibold text-gray-900 mb-3">{t('orders.detailModal.paymentStatusLabel')}</h3>
              <p className="text-sm font-medium text-gray-700">
                {selectedOrder.payment_status
                  ? t(`orders.paymentStatus.${selectedOrder.payment_status.toLowerCase()}`, { defaultValue: selectedOrder.payment_status })
                  : t('orders.paymentStatus.unknown')}
              </p>
              <p className="mt-1 text-xs text-gray-600">
                {selectedOrder.payment_method || t('orders.paymentMethod.unknown')}
              </p>
              {showPaymentReconciliation && (
                <div role="alert" className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
                  <p className="font-semibold">{t(`orders.paymentReconciliation.${reconciliationWarningKey}.title`)}</p>
                  <p className="mt-1">{t(`orders.paymentReconciliation.${reconciliationWarningKey}.body`)}</p>
                  <p className="mt-1 text-xs">{t(`orders.paymentReconciliation.${reconciliationWarningKey}.nextStep`)}</p>
                </div>
              )}
              {!selectedOrder.payment_method && selectedOrder.payment_status?.toLowerCase() !== 'paid' && (
                canCorrectPaymentMethod
                  && !paymentMethodCorrectionUnavailable
                  && !selectedOrderHasCourierRecord
                  && ['draft', 'pending', 'confirmed', 'processing'].includes(selectedOrder.status) ? (
                  <div className="mt-3 border-t border-gray-200 pt-3">
                    <label className="block text-xs font-semibold text-gray-700" htmlFor="order-payment-method-correction">
                      {t('orders.detailModal.paymentMethodCorrection')}
                    </label>
                    <p className="mt-1 text-xs text-gray-600">{t('orders.paymentMethodCorrectionOwnerOnly')}</p>
                    <select
                      id="order-payment-method-correction"
                      value={paymentMethodCorrection}
                      onChange={(event) => setPaymentMethodCorrection(event.target.value)}
                      className="mt-2 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"
                    >
                      <option value="">{t('orders.createModal.selectPaymentMethod')}</option>
                      {paymentMethodChoices.map((gateway) => (
                        <option key={gateway} value={gateway}>{paymentMethodLabel(gateway)}</option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={() => void handleCorrectPaymentMethod()}
                      disabled={!paymentMethodCorrection || isUpdatingPaymentMethod}
                      className="mt-2 min-h-9 rounded-lg bg-primary px-3 text-xs font-semibold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {isUpdatingPaymentMethod ? t('orders.loading') : t('orders.detailModal.savePaymentMethod')}
                    </button>
                  </div>
                ) : (
                  <p className="mt-2 text-xs text-amber-800">
                    {selectedOrderHasCourierRecord || paymentMethodCorrectionUnavailable
                      ? t('orders.paymentMethodCorrectionLockedByCourier')
                      : canCorrectPaymentMethod
                        ? t('orders.bookingMethodCorrectionUnavailable')
                        : t('orders.paymentMethodCorrectionOwnerOnly')}
                  </p>
                )
              )}
            </div>

            <div className="bg-gray-50 rounded-lg p-4 mb-6">
              <h3 className="font-semibold text-gray-900 mb-3">{t('orders.detailModal.deliveryStatusLabel')}</h3>
              <p className="text-sm font-medium text-gray-700">
                {selectedOrder.delivery_status
                  ? t(`orders.deliveryStatus.${selectedOrder.delivery_status.toLowerCase()}`, { defaultValue: selectedOrder.delivery_status })
                  : selectedOrder.fulfillment_status
                    ? t(`orders.fulfillmentStatus.${selectedOrder.fulfillment_status.toLowerCase()}`, { defaultValue: selectedOrder.fulfillment_status })
                    : t('orders.deliveryStatus.unknown')}
              </p>
              <p className="mt-1 text-xs text-gray-600">
                {[selectedOrder.delivery_provider, selectedOrder.delivery_tracking_code].filter(Boolean).join(' · ') || t('orders.deliveryStatus.noTracking')}
              </p>
            </div>

            <div className="bg-gray-50 rounded-lg p-4 mb-6">
              <h3 className="font-semibold text-gray-900 mb-3">{t('orders.detailModal.customerChat')}</h3>
              {linkedConversationId ? (
                conversationSnippets.length === 0 ? (
                  <p className="text-sm text-gray-500">{t('orders.detailModal.linkedChatEmpty')}</p>
                ) : (
                  <div className="space-y-2">
                    {conversationSnippets.map((line, idx) => (
                      <p key={`${selectedOrder.id}-msg-${idx}`} className="rounded-lg bg-white p-3 text-sm text-gray-700 border border-gray-200">
                        {line}
                      </p>
                    ))}
                  </div>
                )
              ) : (
                <p className="text-sm text-gray-500">{t('orders.detailModal.noChatSnippet')}</p>
              )}
              {/* FE-08: navigation only ever for the conversation VERIFIED to
                  belong to this order's customer, via the canonical inbox deep link. */}
              {linkedConversationId && (
                <button
                  type="button"
                  onClick={() => navigate(`/inbox?conversation=${encodeURIComponent(linkedConversationId)}`)}
                  className="mt-3 text-sm font-semibold text-brand-hover hover:underline font-bn"
                >
                  {t('orders.detailModal.openConversation')}
                </button>
              )}
            </div>

            {/* Order Meta Information */}
            <div className="bg-emerald-50 rounded-lg p-4 mb-6 border border-emerald-200">
              <h3 className="font-semibold text-gray-900 mb-3">{t('orders.detailModal.metaSection')}</h3>
              <div className="space-y-2">
                <div className="flex justify-between">
                  <span className="text-gray-600">{t('orders.detailModal.orderSource')}:</span>
                  <span className="text-gray-900 font-medium capitalize">{selectedOrder.channel}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600">{t('orders.detailModal.createdBy')}:</span>
                  <span className="text-gray-900 font-medium">
                    {selectedOrder.channel === 'manual' ? t('orders.detailModal.createdByManual') : t('orders.detailModal.createdByAI')}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600">{t('orders.detailModal.creationMethod')}:</span>
                  <span className="text-gray-900 font-medium">
                    {selectedOrder.channel === 'manual' ? t('orders.detailModal.methodManual') : t('orders.detailModal.methodAutomated')}
                  </span>
                </div>
              </div>
            </div>

            {/* Order Items */}
            <div className="mb-6">
              <h3 className="font-semibold text-gray-900 mb-3">{t('orders.detailModal.itemsSection')}</h3>
              <div className="border border-gray-200 rounded-lg divide-y divide-gray-200">
                {selectedOrder.items.map((item, index) => (
                  <div key={index} className="p-4 flex justify-between items-center">
                    <div className="flex-1">
                      <p className="font-medium text-gray-900">{item.productName}</p>
                      <p className="text-sm text-gray-500">{t('orders.detailModal.quantity')}: {item.quantity}</p>
                    </div>
                    <p className="text-gray-900 font-semibold">
                      {formatCurrency(item.price * item.quantity)}
                    </p>
                  </div>
                ))}
              </div>
              
              <div className="mt-4 flex justify-between items-center text-lg font-bold">
                <span>{t('orders.detailModal.total')}:</span>
                <span className="text-brand-hover">{formatCurrency(selectedOrder.total)}</span>
              </div>
            </div>

            {/* RTO Shield v2 — renders nothing unless this shop has the pilot */}
            <OrderConfidencePanel orderId={selectedOrder.id} refreshKey={confidenceRefresh} />

            {/* Order Status */}
            <div className="mb-6">
              <h3 className="font-semibold text-gray-900 mb-3">{t('orders.detailModal.updateStatus')}</h3>
              <div className="grid grid-cols-2 gap-2">
                {([
                  { value: 'confirmed' as Order['status'], label: t('orders.statusConfirmed') },
                  { value: 'processing' as Order['status'], label: t('orders.statusProcessing') },
                  { value: 'completed' as Order['status'], label: t('orders.statusCompleted') },
                  { value: 'cancelled' as Order['status'], label: t('orders.statusCancelled') },
                ]).map(({ value, label }) => (
                  <button
                    key={value}
                    onClick={() => handleUpdateStatus(selectedOrder.id, value)}
                    disabled={selectedOrder.status === value}
                    className={`px-4 py-2 rounded-lg text-sm transition-colors ${
                      selectedOrder.status === value
                        ? statusColors[value] + ' opacity-50 cursor-not-allowed'
                        : 'bg-gray-100 hover:bg-gray-200 text-gray-700'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="mb-6">
              <h3 className="font-semibold text-gray-900 mb-3">{t('orders.detailModal.note')}</h3>
              <textarea
                value={detailNote}
                onChange={(e) => setDetailNote(e.target.value)}
                rows={3}
                placeholder={t('orders.detailModal.notePlaceholder')}
                className="w-full rounded-lg border border-gray-300 px-4 py-2 text-sm"
              />
            </div>

            <div className="flex flex-wrap gap-2">
              <button
                onClick={handleSaveNote}
                className="flex-1 min-w-[120px] px-4 py-2.5 bg-gray-900 text-white rounded-lg hover:bg-black text-sm"
              >
                {t('orders.detailModal.saveNote')}
              </button>
              <button
                onClick={() => setShowCourierModal(true)}
                disabled={!!selectedOrder.delivery_tracking_code}
                className="flex-1 min-w-[120px] px-4 py-2.5 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed text-sm"
              >
                {selectedOrder.delivery_tracking_code ? `ID: ${selectedOrder.delivery_tracking_code}` : t('orders.detailModal.bookCourier')}
              </button>
              {selectedOrder.status === 'draft' && (
                <button
                  onClick={() => handleUpdateStatus(selectedOrder.id, 'confirmed')}
                  className="flex-1 min-w-[120px] px-4 py-2.5 bg-primary text-primary-foreground rounded-lg hover:opacity-90 text-sm"
                >
                  {t('orders.detailModal.confirmOrder')}
                </button>
              )}
              {selectedOrder.status !== 'completed' && (
                <button
                  onClick={() => handleUpdateStatus(selectedOrder.id, 'cancelled')}
                  className="flex-1 min-w-[120px] px-4 py-2.5 bg-red-100 text-red-700 rounded-lg hover:bg-red-200 text-sm"
                >
                  {t('orders.detailModal.cancelOrderBtn')}
                </button>
              )}
              <button
                onClick={() => setSelectedOrder(null)}
                className="w-full px-4 py-2.5 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 text-sm"
              >
                {t('orders.detailModal.close')}
              </button>
            </div>
          </div>
        </div>
      )}
      {showCourierModal && selectedOrder && (
        <CourierBookingModal
          order={selectedOrder}
          paymentMethodCorrectionUnavailable={paymentMethodCorrectionUnavailable}
          onClose={() => setShowCourierModal(false)}
          onHeld={() => setConfidenceRefresh((n) => n + 1)}
          onBooked={(trackingId, provider) => {
            const updated = { ...selectedOrder, delivery_tracking_code: trackingId, delivery_provider: provider };
            setSelectedOrder(updated);
            setOrders(prev => prev.map(o => o.id === selectedOrder.id ? updated : o));
          }}
        />
      )}
    </div>
  );
}
