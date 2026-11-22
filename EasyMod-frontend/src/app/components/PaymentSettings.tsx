import { useState, useEffect } from "react";
import { useTranslation } from 'react-i18next';
import { Wallet, DollarSign, ChevronDown, ChevronUp, Mail, Star, X } from "lucide-react";
import { motion, MotionConfig } from "motion/react";
import { apiClient } from "@/api";
import { authService } from "@/app/lib/auth";
import { getErrorMessage } from "@shared/lib/http/errors";
import { fadeUp } from "@/lib/motion";
import { EmButton } from "./dashboard/EmButton";
import { PageHeader } from "./dashboard/PageHeader";
import { derivePaymentSignal } from "./payment/derive";

const ANIMATE = import.meta.env.MODE !== "test";

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-em-focus-light focus-visible:transition-none";

const INPUT_CLASSES =
  `w-full min-h-11 px-4 py-2 border border-em-border-input rounded-lg bg-em-bg-surface text-sm text-em-text-primary focus:outline-none ${FOCUS_RING}`;

interface PaymentGateway {
  id: string;
  name: string;
  logo: React.ReactNode;
  description: string;
  enabled: boolean;
  config?: any;
  requiresContact?: boolean;
}

const isMfsGateway = (gatewayId: string) => gatewayId === 'bkash';

const toCanonicalGateway = (gatewayId: string) => (isMfsGateway(gatewayId) ? 'self-mfs' : gatewayId);

export default function PaymentSettings() {
  const { t } = useTranslation();
  const [gateways, setGateways] = useState<PaymentGateway[]>([
    {
      id: 'cod',
      name: t('manageShop.paymentSettings.codName'),
      logo: <DollarSign className="w-6 h-6 text-em-success-700" aria-hidden="true" />,
      description: t('manageShop.paymentSettings.codDesc'),
      enabled: true,
    },
    {
      id: 'bkash',
      name: t('manageShop.paymentSettings.bkashName'),
      logo: <Wallet className="w-6 h-6 text-em-violet-700" aria-hidden="true" />,
      description: t('manageShop.paymentSettings.bkashDesc'),
      enabled: false,
      config: { phone: '', accountType: 'self' },
    },
  ]);

  const [expandedGateway, setExpandedGateway] = useState<string | null>(null);
  const [advancePaymentRule, setAdvancePaymentRule] = useState<'none' | 'full' | 'delivery' | 'percentage' | 'fixed'>('none');
  const [advancePercentage, setAdvancePercentage] = useState(50);
  const [advanceFixed, setAdvanceFixed] = useState(100);
  const [paymentMessage, setPaymentMessage] = useState(t('manageShop.paymentSettings.defaultPaymentMessage'));
  const [savingSettings, setSavingSettings] = useState(false);
  const [savingGateway, setSavingGateway] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [savedGateways, setSavedGateways] = useState<Set<string>>(new Set());
  const [priority, setPriority] = useState<{ payment: string[]; delivery: string[] }>({ payment: [], delivery: [] });
  const [settingDefaultGateway, setSettingDefaultGateway] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Load payment configurations on mount
  useEffect(() => {
    loadPaymentConfigs();
    apiClient.get('/shop/platform-priority')
      .then((res: any) => setPriority(res.data?.data || { payment: [], delivery: [] }))
      .catch(() => {});
  }, []);

  const defaultGateway = priority.payment[0];

  // Display names/descriptions are derived at render time so a language switch
  // re-translates them (the useState initializers only capture the first language).
  const nameFor = (id: string) =>
    id === 'cod' ? t('manageShop.paymentSettings.codName') : t('manageShop.paymentSettings.bkashName');
  const descFor = (id: string) =>
    id === 'cod' ? t('manageShop.paymentSettings.codDesc') : t('manageShop.paymentSettings.bkashDesc');

  const handleSetDefault = async (gatewayId: string) => {
    try {
      setSettingDefaultGateway(gatewayId);
      setError(null);
      setSuccess(null);
      const nextPayment = [gatewayId, ...priority.payment.filter((p) => p !== gatewayId)];
      const nextPriority = { payment: nextPayment, delivery: priority.delivery };
      await apiClient.put('/shop/platform-priority', nextPriority);
      setPriority(nextPriority);
      setSuccess(t('manageShop.paymentSettings.setDefaultSuccess', { name: nameFor(gatewayId) }));
    } catch (err: any) {
      setError(getErrorMessage(err, t('manageShop.paymentSettings.errors.updateDefaultFailed')));
    } finally {
      setSettingDefaultGateway(null);
    }
  };

  const loadPaymentConfigs = async () => {
    try {
      // Load payment gateway configs
      const response = await apiClient.getPaymentConfig();

      if (response.success && response.data) {
        // Update gateways with loaded configurations
        const loadedConfigs = Array.isArray(response.data) ? response.data : [];
        const savedSet = new Set<string>();

        setGateways(prev => prev.map(gw => {
          const config = loadedConfigs.find((c: any) => c.gateway === gw.id);
          const mfsConfig = loadedConfigs.find((c: any) => (
            c.gateway === 'self-mfs' && c.credential_summary?.mfs_type === gw.id
          ));
          const matched = config || mfsConfig;
          if (matched) {
            const hasCredentials = matched.gateway === 'cod'
              || matched.credential_summary?.has_credentials === true;
            if (hasCredentials) savedSet.add(gw.id);

            const summary = matched.credential_summary;
            const hydratedConfig = gw.config && summary
              ? {
                  ...gw.config,
                  ...(summary.mfs_number ? { phone: summary.mfs_number } : {}),
                  ...(summary.mfs_mode ? {
                    accountType: summary.mfs_mode === 'business' || summary.mfs_mode === 'merchant'
                      ? 'merchant'
                      : 'self'
                  } : {})
                }
              : gw.config;

            return {
              ...gw,
              enabled: matched.is_enabled,
              // Only the non-secret summary is hydrated. Merchant API secrets
              // intentionally remain blank and must be re-entered to change them.
              ...(hydratedConfig ? { config: hydratedConfig } : {})
            };
          }
          return gw;
        }));

        setSavedGateways(savedSet);
      }

      // Load shop payment settings
      try {
        const shopResponse = await apiClient.getShop();
        if (shopResponse.success && shopResponse.data?.payment_methods) {
          const settings = JSON.parse(shopResponse.data.payment_methods);
          if (settings.advancePaymentRule) setAdvancePaymentRule(settings.advancePaymentRule);
          if (settings.advancePercentage !== undefined) setAdvancePercentage(settings.advancePercentage);
          if (settings.advanceFixed !== undefined) setAdvanceFixed(settings.advanceFixed);
          if (settings.paymentMessage) setPaymentMessage(settings.paymentMessage);
        }
      } catch (shopError) {
        // Shop settings are optional, so don't fail if they don't exist
        console.log('No existing payment settings found');
      }
    } catch (error: any) {
      console.error('Failed to load payment configs:', error);
      setError(t('manageShop.paymentSettings.errors.loadFailed'));
    } finally {
      setLoading(false);
    }
  };

  const saveGatewayConfig = async (gatewayId: string) => {
    try {
      setSavingGateway(gatewayId);
      setError(null);
      setSuccess(null);

      const gateway = gateways.find(gw => gw.id === gatewayId);
      if (!gateway) return;

      // Skip saving for contact-required gateways
      if (gateway.requiresContact) {
        setError(t('manageShop.paymentSettings.errors.contactRequired'));
        return;
      }

      let credentials: any = null;
      const canonicalGateway = toCanonicalGateway(gatewayId);

      // Prepare credentials based on gateway type
      if (isMfsGateway(gatewayId) && gateway.config) {
        const isMerchant = gateway.config.accountType === 'merchant';
        if (!gateway.config.phone) {
          setError(t('manageShop.paymentSettings.errors.phoneRequired', 'MFS phone number is required'));
          return;
        }
        if (isMerchant) {
          if (!gateway.config.app_key || !gateway.config.app_secret) {
            setError(t('manageShop.paymentSettings.errors.merchantCredentialsRequired'));
            return;
          }
          credentials = {
            mfs_type: gatewayId,
            mfs_mode: 'merchant',
            mfs_number: gateway.config.phone,
            app_key: gateway.config.app_key,
            app_secret: gateway.config.app_secret,
            username: gateway.config.username || '',
            password: gateway.config.password || '',
          };
        } else {
          if (!gateway.config.phone) {
            setError(t('manageShop.paymentSettings.errors.phoneRequired', 'MFS phone number is required'));
            return;
          }
          credentials = {
            mfs_type: gatewayId,
            mfs_number: gateway.config.phone,
            mfs_mode: gateway.config.accountType || 'self',
          };
        }
      } else if (gatewayId === 'self-mfs' && gateway.config) {
        if (!gateway.config.phone) {
          setError(t('manageShop.paymentSettings.errors.phoneRequired', 'MFS phone number is required'));
          return;
        }
        credentials = {
          mfs_type: gateway.config.type || 'bkash',
          mfs_number: gateway.config.phone,
          mfs_mode: gateway.config.accountType === 'personal' ? 'self' : 'business'
        };
      }

      // First, test the connection
      const testPayload = {
        gateway: canonicalGateway,
        credentials
      };

      const testResponse = await apiClient.testPaymentConnection(testPayload);

      if (!testResponse.success) {
        setError(t('manageShop.paymentSettings.errors.testFailed'));
        return;
      }

      // If test successful, save the configuration
      const payload = {
        gateway: canonicalGateway,
        credentials,
        config: {}
        // is_enabled not needed here - defaults to false on backend
      };

      const response = await apiClient.updatePaymentConfig(payload);

      if (response.success) {
        setSuccess(t('manageShop.paymentSettings.savedSuccess', { name: nameFor(gatewayId) }));

        // Mark gateway as saved
        setSavedGateways(prev => new Set(prev).add(gatewayId));

        // Keep success message longer so user sees it
        setTimeout(() => setSuccess(null), 4000);
      }
    } catch (error: any) {
      console.error('Failed to save gateway config:', error);
      setError(getErrorMessage(error, t('manageShop.paymentSettings.errors.saveConfigFailed')));
    } finally {
      setSavingGateway(null);
    }
  };

  const toggleGateway = async (id: string) => {
    const gateway = gateways.find(gw => gw.id === id);
    if (!gateway) return;

    // For COD, allow toggle without saved credentials
    // For others, require saved credentials first
    if (id !== 'cod' && !savedGateways.has(id)) {
      setError(t('manageShop.paymentSettings.errors.credentialsSaveFirst'));
      setTimeout(() => setError(null), 3000);
      return;
    }

    try {
      setError(null);
      setSavingGateway(id);

      const payload = {
        gateway: toCanonicalGateway(id),
        is_enabled: !gateway.enabled
      };

      const response = await apiClient.updatePaymentConfig(payload);

      if (response.success) {
        // Update local state
        setGateways(prev => prev.map(gw =>
          gw.id === id ? { ...gw, enabled: !gw.enabled } : gw
        ));

        setSuccess(!gateway.enabled
          ? t('manageShop.paymentSettings.activatedSuccess', { name: nameFor(id) })
          : t('manageShop.paymentSettings.deactivatedSuccess', { name: nameFor(id) }));
        setTimeout(() => setSuccess(null), 2500);
      }
    } catch (error: any) {
      console.error('Failed to toggle gateway:', error);
      setError(getErrorMessage(error, t('manageShop.paymentSettings.errors.toggleFailed')));
    } finally {
      setSavingGateway(null);
    }
  };

  const toggleExpand = (id: string) => {
    setExpandedGateway(expandedGateway === id ? null : id);
  };

  const updateGatewayConfig = (id: string, field: string, value: any) => {
    setGateways(gateways.map(gw =>
      gw.id === id && gw.config
        ? { ...gw, config: { ...gw.config, [field]: value } }
        : gw
    ));
  };

  const savePaymentSettings = async () => {
    try {
      setSavingSettings(true);
      setError(null);
      setSuccess(null);

      const shopId = authService.getCurrentShopId();
      if (!shopId) {
        setError(t('manageShop.paymentSettings.errors.shopNotFound'));
        return;
      }

      // Prepare payment settings data
      const paymentSettings = {
        advancePaymentRule,
        advancePercentage,
        advanceFixed,
        paymentMessage
      };

      // Save to shop's payment_methods field as JSON
      await apiClient.updateShop(shopId, {
        payment_methods: JSON.stringify(paymentSettings)
      });

      setSuccess(t('manageShop.paymentSettings.settingsSavedSuccess'));
      setTimeout(() => setSuccess(null), 3000);
    } catch (error: any) {
      console.error('Failed to save payment settings:', error);
      setError(getErrorMessage(error, t('manageShop.paymentSettings.errors.saveSettingsFailed')));
    } finally {
      setSavingSettings(false);
    }
  };

  const enabledCount = gateways.filter((gateway) => gateway.enabled).length;
  const signal = derivePaymentSignal({ phase: error ? 'error' : loading ? 'loading' : 'ready', enabledCount }, t);
  const shopName = authService.getCurrentShop()?.shop_name || t('manageShop.paymentSettings.title');
  const defaultGatewayName = defaultGateway ? nameFor(defaultGateway) : undefined;
  const advanceRuleLabel = {
    none: t('manageShop.paymentSettings.noPayment'),
    full: t('manageShop.paymentSettings.fullPayment'),
    delivery: t('manageShop.paymentSettings.deliveryOnly'),
    percentage: t('manageShop.paymentSettings.percentage'),
    fixed: t('manageShop.paymentSettings.fixedAmount'),
  }[advancePaymentRule];

  const advanceOption = (value: 'none' | 'full' | 'delivery' | 'percentage' | 'fixed', title: string, description?: string, children?: React.ReactNode) => (
    <label
      className={`flex items-start gap-3 p-4 border-2 rounded-xl cursor-pointer transition-colors ${
        advancePaymentRule === value
          ? 'border-em-violet-600 bg-em-violet-50'
          : 'border-em-border hover:border-em-border-strong'
      }`}
    >
      <input
        type="radio"
        name="advance-payment"
        value={value}
        checked={advancePaymentRule === value}
        onChange={(e) => setAdvancePaymentRule(e.target.value as any)}
        className="w-5 h-5 mt-0.5 accent-em-violet-600"
      />
      <div className="flex-1">
        <div className="font-medium text-em-text-primary">{title}</div>
        {description && <div className="text-sm text-em-text-secondary">{description}</div>}
        {children}
      </div>
    </label>
  );

  return (
    <MotionConfig reducedMotion="user">
    <div className="em-payment min-h-full p-4 md:p-6">
      <div className="mx-auto w-full max-w-[1440px] space-y-6">
        {/* Execution-page header (§29): title + signal + factual pills only. */}
        <motion.div variants={fadeUp} initial={ANIMATE ? 'hidden' : false} animate="visible">
          <PageHeader
            title={t('manageShop.paymentSettings.title')}
            breadcrumb={[{ label: shopName }]}
            signal={signal}
            signalTestId="payment-signal"
            signalAnnounce={false}
            meta={
              <div className="flex flex-wrap items-center gap-2">
                <span className="em-tabular whitespace-nowrap rounded-full border border-em-border bg-em-bg-muted px-3 py-1 text-xs font-medium text-em-text-secondary">
                  {t('manageShop.paymentSettings.enabledMethodsLabel')}: {enabledCount}
                </span>
                <span className="whitespace-nowrap rounded-full border border-em-border bg-em-bg-muted px-3 py-1 text-xs font-medium text-em-text-secondary">
                  {t('manageShop.paymentSettings.defaultBadge')}: {defaultGatewayName || '—'}
                </span>
                <span className="whitespace-nowrap rounded-full border border-em-border bg-em-bg-muted px-3 py-1 text-xs font-medium text-em-text-secondary">
                  {t('manageShop.paymentSettings.advanceRuleLabel')}: {advanceRuleLabel}
                </span>
              </div>
            }
          />
        </motion.div>

        {/* Success/Error Messages */}
        {error && (
          <div role="alert" className="flex items-center gap-2 rounded-xl border border-em-danger-700/20 bg-em-danger-100 px-4 py-3 text-sm text-em-danger-700">
            <span className="flex-1">{error}</span>
            <button
              onClick={() => setError(null)}
              aria-label={t('common.close')}
              className={`min-h-11 min-w-11 inline-flex items-center justify-center text-em-danger-700 hover:text-em-danger-700/80 ${FOCUS_RING}`}
            >
              <X className="w-4 h-4" aria-hidden="true" />
            </button>
          </div>
        )}
        {success && (
          <div role="status" className="flex items-center gap-2 rounded-xl border border-em-success-700/20 bg-em-success-100 px-4 py-3 text-sm text-em-success-700">
            <span className="flex-1">{success}</span>
            <button
              onClick={() => setSuccess(null)}
              aria-label={t('common.close')}
              className={`min-h-11 min-w-11 inline-flex items-center justify-center text-em-success-700 hover:text-em-success-700/80 ${FOCUS_RING}`}
            >
              <X className="w-4 h-4" aria-hidden="true" />
            </button>
          </div>
        )}

        {loading ? (
          <div className="space-y-4" aria-label={t('manageShop.paymentSettings.title')}>
            {[0, 1, 2].map((row) => (
              <div key={row} className="animate-pulse space-y-3 rounded-xl border border-em-border bg-em-bg-surface p-6">
                <div className="h-5 w-1/3 rounded bg-em-bg-muted" />
                <div className="h-3 w-2/3 rounded bg-em-bg-muted" />
                <div className="h-9 w-40 rounded bg-em-bg-muted" />
              </div>
            ))}
          </div>
        ) : (
        <div className="space-y-6">
          {/* Payment Gateways */}
          <motion.div variants={fadeUp} initial={ANIMATE ? 'hidden' : false} animate="visible" className="bg-em-bg-surface rounded-xl border border-em-border p-6">
            <h2 className="text-lg font-semibold text-em-text-primary mb-4">{t('manageShop.paymentSettings.gatewaysTitle')}</h2>
            <p className="text-sm text-em-text-secondary mb-4">
              {t('manageShop.paymentSettings.gatewaysSubtitle')}
            </p>

            <div className="space-y-3">
              {gateways.map((gateway) => (
                <div key={gateway.id} data-testid={`gateway-card-${gateway.id}`} className="border border-em-border rounded-xl overflow-hidden">
                  <div className="flex items-center gap-4 p-4 hover:bg-em-bg-muted transition-colors">
                    <div className="w-12 h-12 rounded-lg bg-em-bg-muted flex items-center justify-center flex-shrink-0">
                      {gateway.logo}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <div className="font-semibold text-em-text-primary">{nameFor(gateway.id)}</div>
                        {defaultGateway === gateway.id && (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-em-violet-100 text-em-violet-700">
                            <Star className="w-3 h-3 fill-current" aria-hidden="true" />
                            {t('manageShop.paymentSettings.defaultBadge')}
                          </span>
                        )}
                      </div>
                      <div className="text-sm text-em-text-secondary">{descFor(gateway.id)}</div>
                    </div>
                    <div className="flex items-center gap-2">
                      {gateway.enabled && defaultGateway !== gateway.id && !gateway.requiresContact && (
                        <EmButton
                          variant="secondary"
                          onClick={() => handleSetDefault(gateway.id)}
                          disabled={settingDefaultGateway === gateway.id}
                          loading={settingDefaultGateway === gateway.id}
                          title={t('manageShop.paymentSettings.setDefaultTitle')}
                          className="min-w-11 gap-1.5 px-3 text-xs"
                        >
                          <Star className="w-3.5 h-3.5" aria-hidden="true" />
                          <span className="hidden md:inline">{t('manageShop.paymentSettings.setDefault')}</span>
                        </EmButton>
                      )}
                      {gateway.requiresContact ? (
                        <a
                          href="mailto:support@easymod.tech?subject=Integrate AamarPay or SSLCommerz"
                          className={`flex min-h-11 items-center gap-2 px-4 py-2 bg-em-bg-muted text-em-text-primary rounded-lg hover:bg-em-border/60 transition-colors ${FOCUS_RING}`}
                          title={t('manageShop.paymentSettings.contactUsTitle')}
                        >
                          <Mail className="w-4 h-4" aria-hidden="true" />
                          <span className="text-sm font-medium">{t('manageShop.paymentSettings.contactUs')}</span>
                        </a>
                      ) : (
                        <>
                          <button
                            type="button"
                            role="switch"
                            aria-checked={gateway.enabled}
                            aria-label={nameFor(gateway.id)}
                            onClick={() => toggleGateway(gateway.id)}
                            disabled={(gateway.id !== 'cod' && !savedGateways.has(gateway.id)) || savingGateway === gateway.id}
                            title={gateway.id !== 'cod' && !savedGateways.has(gateway.id) ? t('manageShop.paymentSettings.saveConfigFirst') : t('manageShop.paymentSettings.toggleActivateTitle')}
                            // 44px touch target (guardrails §18): the visual track
                            // stays 24px tall inside a full-size hit area.
                            className={`inline-flex min-h-11 min-w-11 items-center justify-center rounded-full transition-colors cursor-pointer ${
                              (gateway.id !== 'cod' && !savedGateways.has(gateway.id)) ? 'opacity-50 cursor-not-allowed' : ''
                            } ${FOCUS_RING}`}
                          >
                            <span className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full ${
                              gateway.enabled ? 'bg-em-violet-600' : 'bg-em-border-strong'
                            }`}>
                              <span
                                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                                  gateway.enabled ? 'translate-x-6' : 'translate-x-1'
                                }`}
                              />
                            </span>
                          </button>
                          {gateway.config && (
                            <button
                              type="button"
                              data-testid={`gateway-expand-${gateway.id}`}
                              onClick={() => toggleExpand(gateway.id)}
                              aria-expanded={expandedGateway === gateway.id}
                              aria-label={t('manageShop.paymentSettings.configureGateway', { name: nameFor(gateway.id) })}
                              className={`min-h-11 min-w-11 inline-flex items-center justify-center p-2 text-em-text-secondary hover:text-em-text-primary ${FOCUS_RING}`}
                            >
                              {expandedGateway === gateway.id ? (
                                <ChevronUp className="w-5 h-5" aria-hidden="true" />
                              ) : (
                                <ChevronDown className="w-5 h-5" aria-hidden="true" />
                              )}
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  </div>

                  {/* Configuration Forms */}
                  {expandedGateway === gateway.id && gateway.config && !gateway.requiresContact && (
                    <div className="border-t border-em-border p-4 bg-em-bg-muted">
                      {/* bKash individual config */}
                      {isMfsGateway(gateway.id) && (
                        <div className="space-y-4">
                          {/* Mode selector */}
                          <div>
                            <label className="block text-sm font-medium text-em-text-primary mb-2">
                              {t('manageShop.paymentSettings.paymentMode')}
                            </label>
                            <div className="flex gap-2">
                              {(['self', 'merchant'] as const).map((mode) => (
                                <button
                                  key={mode}
                                  type="button"
                                  onClick={() => updateGatewayConfig(gateway.id, 'accountType', mode)}
                                  aria-pressed={(gateway.config.accountType || 'self') === mode}
                                  className={`flex-1 min-h-11 py-2 px-4 rounded-lg border text-sm font-medium transition-colors ${FOCUS_RING} ${
                                    (gateway.config.accountType || 'self') === mode
                                      ? 'bg-em-violet-600 text-white border-em-violet-600'
                                      : 'bg-em-bg-surface text-em-text-primary border-em-border-strong hover:border-em-violet-300'
                                  }`}
                                >
                                  {mode === 'self' ? t('manageShop.paymentSettings.modeSelf') : t('manageShop.paymentSettings.modeMerchant')}
                                </button>
                              ))}
                            </div>
                            <p className="text-xs text-em-text-secondary mt-1">
                              {(gateway.config.accountType || 'self') === 'self'
                                ? t('manageShop.paymentSettings.modeSelfHint')
                                : t('manageShop.paymentSettings.modeMerchantHint')}
                            </p>
                          </div>

                          {/* Receiver number is required for both supported modes. */}
                          <div>
                            <label className="block text-sm font-medium text-em-text-primary mb-2">
                              {t('manageShop.paymentSettings.mfsPhoneNumber', { name: nameFor(gateway.id) })}
                            </label>
                            <input
                              type="tel"
                              aria-label={t('manageShop.paymentSettings.mfsPhoneNumber', { name: nameFor(gateway.id) })}
                              value={gateway.config.phone || ''}
                              onChange={(e) => updateGatewayConfig(gateway.id, 'phone', e.target.value)}
                              placeholder="01XXXXXXXXX"
                              className={INPUT_CLASSES}
                            />
                          </div>

                          {/* Merchant API fields */}
                          {gateway.config.accountType === 'merchant' && (
                            <div className="space-y-3">
                              <div>
                                <label className="block text-sm font-medium text-em-text-primary mb-1">{t('manageShop.paymentSettings.appKey')}</label>
                                <input
                                  type="text"
                                  aria-label={t('manageShop.paymentSettings.appKey')}
                                  value={gateway.config.app_key || ''}
                                  onChange={(e) => updateGatewayConfig(gateway.id, 'app_key', e.target.value)}
                                  placeholder={t('manageShop.paymentSettings.appKeyPlaceholder')}
                                  className={INPUT_CLASSES}
                                />
                              </div>
                              <div>
                                <label className="block text-sm font-medium text-em-text-primary mb-1">{t('manageShop.paymentSettings.appSecret')}</label>
                                <input
                                  type="password"
                                  aria-label={t('manageShop.paymentSettings.appSecret')}
                                  value={gateway.config.app_secret || ''}
                                  onChange={(e) => updateGatewayConfig(gateway.id, 'app_secret', e.target.value)}
                                  placeholder={t('manageShop.paymentSettings.appSecretPlaceholder')}
                                  className={INPUT_CLASSES}
                                />
                              </div>
                              <div className="grid grid-cols-2 gap-3">
                                <div>
                                  <label className="block text-sm font-medium text-em-text-primary mb-1">{t('manageShop.paymentSettings.username')}</label>
                                  <input
                                    type="text"
                                    aria-label={t('manageShop.paymentSettings.username')}
                                    value={gateway.config.username || ''}
                                    onChange={(e) => updateGatewayConfig(gateway.id, 'username', e.target.value)}
                                    placeholder={t('manageShop.paymentSettings.merchantUsernamePlaceholder')}
                                    className={INPUT_CLASSES}
                                  />
                                </div>
                                <div>
                                  <label className="block text-sm font-medium text-em-text-primary mb-1">{t('manageShop.paymentSettings.password')}</label>
                                  <input
                                    type="password"
                                    aria-label={t('manageShop.paymentSettings.password')}
                                    value={gateway.config.password || ''}
                                    onChange={(e) => updateGatewayConfig(gateway.id, 'password', e.target.value)}
                                    placeholder={t('manageShop.paymentSettings.merchantPasswordPlaceholder')}
                                    className={INPUT_CLASSES}
                                  />
                                </div>
                              </div>
                            </div>
                          )}

                          <EmButton
                            variant="primary"
                            onClick={() => saveGatewayConfig(gateway.id)}
                            disabled={savingGateway === gateway.id}
                            loading={savingGateway === gateway.id}
                            className="w-full"
                          >
                            {savingGateway === gateway.id ? t('common.saving') : t('manageShop.paymentSettings.saveGateway', { name: nameFor(gateway.id) })}
                          </EmButton>
                        </div>
                      )}

                    </div>
                  )}
                </div>
              ))}
            </div>
          </motion.div>

          {/* Advance Payment Rules */}
          <motion.div variants={fadeUp} initial={ANIMATE ? 'hidden' : false} animate="visible" className="bg-em-bg-surface rounded-xl border border-em-border p-6">
            <h2 className="text-lg font-semibold text-em-text-primary mb-4">{t('manageShop.paymentSettings.advanceTitle')}</h2>
            <p className="text-sm text-em-text-secondary mb-4">
              {t('manageShop.paymentSettings.advanceSubtitle')}
            </p>

            <div className="space-y-3">
              {advanceOption('none', t('manageShop.paymentSettings.noPayment'), t('manageShop.paymentSettings.noPaymentDesc'))}
              {advanceOption('full', t('manageShop.paymentSettings.fullPayment'), t('manageShop.paymentSettings.fullPaymentDesc'))}
              {advanceOption('delivery', t('manageShop.paymentSettings.deliveryOnly'), t('manageShop.paymentSettings.deliveryOnlyDesc'))}
              {advanceOption('percentage', t('manageShop.paymentSettings.percentage'), undefined, (
                <div className="flex items-center gap-2 mt-2">
                  <input
                    type="number"
                    aria-label={t('manageShop.paymentSettings.percentage')}
                    value={advancePercentage}
                    onChange={(e) => setAdvancePercentage(parseFloat(e.target.value) || 0)}
                    disabled={advancePaymentRule !== 'percentage'}
                    className={`w-24 px-3 py-2 min-h-11 border border-em-border-input rounded-lg bg-em-bg-surface text-sm text-em-text-primary focus:outline-none disabled:bg-em-bg-muted disabled:text-em-text-disabled ${FOCUS_RING}`}
                    min="0"
                    max="100"
                  />
                  <span className="text-em-text-secondary">{t('manageShop.paymentSettings.percentageSuffix')}</span>
                </div>
              ))}
              {advanceOption('fixed', t('manageShop.paymentSettings.fixedAmount'), undefined, (
                <div className="flex items-center gap-2 mt-2">
                  <span className="text-em-text-secondary">৳</span>
                  <input
                    type="number"
                    aria-label={t('manageShop.paymentSettings.fixedAmount')}
                    value={advanceFixed}
                    onChange={(e) => setAdvanceFixed(parseFloat(e.target.value) || 0)}
                    disabled={advancePaymentRule !== 'fixed'}
                    className={`w-32 px-3 py-2 min-h-11 border border-em-border-input rounded-lg bg-em-bg-surface text-sm text-em-text-primary focus:outline-none disabled:bg-em-bg-muted disabled:text-em-text-disabled ${FOCUS_RING}`}
                    min="0"
                    step="10"
                  />
                  <span className="text-em-text-secondary">{t('manageShop.paymentSettings.fixedSuffix')}</span>
                </div>
              ))}
            </div>
          </motion.div>

          {/* Payment Process Message */}
          <motion.div variants={fadeUp} initial={ANIMATE ? 'hidden' : false} animate="visible" className="bg-em-bg-surface rounded-xl border border-em-border p-6">
            <h2 className="text-lg font-semibold text-em-text-primary mb-4">{t('manageShop.paymentSettings.paymentMessage')}</h2>
            <p className="text-sm text-em-text-secondary mb-4">
              {t('manageShop.paymentSettings.paymentMessageSubtitle')}
            </p>

            <textarea
              value={paymentMessage}
              onChange={(e) => setPaymentMessage(e.target.value)}
              placeholder={t('manageShop.paymentSettings.paymentMessagePlaceholder')}
              aria-label={t('manageShop.paymentSettings.paymentMessage')}
              rows={5}
              className={`w-full px-4 py-2 border border-em-border-strong rounded-lg bg-em-bg-surface text-sm text-em-text-primary focus:outline-none mb-4 ${FOCUS_RING}`}
            />

            <EmButton
              variant="primary"
              onClick={savePaymentSettings}
              disabled={savingSettings}
              loading={savingSettings}
              className="w-full"
            >
              {savingSettings ? t('manageShop.paymentSettings.saving') : t('manageShop.paymentSettings.updatePayment')}
            </EmButton>
          </motion.div>
        </div>
        )}
      </div>
    </div>
    </MotionConfig>
  );
}
