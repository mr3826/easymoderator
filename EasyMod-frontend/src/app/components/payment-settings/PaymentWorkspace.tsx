/**
 * Payment Settings workspace — the two-tab shell (Payment Methods / Payment
 * Policies). This is the redesign surface; the legacy single-page
 * `PaymentSettings.tsx` is left untouched and routing to this component is
 * owned by another role (one-writer rule — this file does NOT edit routes.ts).
 *
 * Contract with the tabs (mirrors `DeliverySettings.tsx`, the house tabbed shell):
 * - The shell owns every load and reload. Methods mutations reload ACCOUNTS
 *   only (never clobbering an unsaved Policies draft); the Policies tab's edits
 *   live in a draft the shell persists through ONE `PUT /api/payment/policy`,
 *   and the Saved state comes from snapshot equality with the SERVER reply — so
 *   success is never claimed before the server confirms it (§4, R-14).
 * - Execution-page header is SLIM (header-removal C1/C1-amendment):
 *   "Payment Settings" ≠ AppBar "Payment" in BOTH locales → titleMode="compact",
 *   no signal prop, no whyHere, no ActionBar (docs/header-removal/03_CONTRACT.md).
 *   `derivePaymentSignal` and the `paymentSettings.signal.*` / `advanceRuleLabel`
 *   keys were deleted by the sweep (C3/C5). The contextual account facts
 *   (enabled-methods count, preferred account) live INSIDE the methods tab body,
 *   where they are record-level context, not a global pulse; the advance rule is
 *   the Policies tab's own form state (§29, C7 reclaims the band space).
 * - Tabs follow the ARIA tablist contract: roving tabindex + ArrowLeft/Right
 *   wrap + Home/End. Testids `payment-tab-*` / `payment-panel-*`.
 *
 * Inert-by-default (R-12): nothing here triggers a provider call on load, and
 * every verification status is whatever the server reports — never implied.
 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { motion, MotionConfig } from 'motion/react';
import { fadeUp } from '@/lib/motion';
import { PageHeader } from '../dashboard/PageHeader';
import { getErrorMessage } from '@shared/lib/http/errors';
import { paymentClient } from './paymentClient';
import MethodsTab from './MethodsTab';
import PoliciesTab from './PoliciesTab';
import type { AdvancePolicy, PaymentAccountView, PaymentPolicyView } from './taxonomy';
import { ADVANCE_POLICIES, DEFAULT_POLICY_VIEW, accountTypeDefaultLabel, accountTypeKey, providerDefaultLabel, providerNameKey } from './taxonomy';

const ANIMATE = import.meta.env.MODE !== 'test';

type WorkspaceTab = 'methods' | 'policies';

const TABS: { id: WorkspaceTab; labelKey: string; def: string }[] = [
  { id: 'methods', labelKey: `manageShop.paymentSettings.tabs.methods`, def: 'Payment Methods' },
  { id: 'policies', labelKey: `manageShop.paymentSettings.tabs.policies`, def: 'Payment Policies' },
];

/** Defensive hydration of the policy reply: canonical enum + integer-or-null value. */
function normalizePolicy(raw: Partial<PaymentPolicyView> | null | undefined): PaymentPolicyView {
  const policy = (raw?.advance_policy && (ADVANCE_POLICIES as string[]).includes(raw.advance_policy))
    ? (raw.advance_policy as AdvancePolicy)
    : DEFAULT_POLICY_VIEW.advance_policy;
  const value = Number.isInteger(raw?.advance_value as number) ? (raw!.advance_value as number) : null;
  const message = typeof raw?.payment_message === 'string' ? raw.payment_message : '';
  return {
    advance_policy: policy,
    advance_value: policy === 'percentage' || policy === 'fixed' ? value : null,
    payment_message: message,
    updated_at: raw?.updated_at ?? null,
    updated_by: raw?.updated_by ?? null,
  };
}

export default function PaymentWorkspace() {
  const { t } = useTranslation();
  const [accounts, setAccounts] = useState<PaymentAccountView[]>([]);
  const [savedPolicy, setSavedPolicy] = useState<PaymentPolicyView>(DEFAULT_POLICY_VIEW);
  const [draftPolicy, setDraftPolicy] = useState<PaymentPolicyView>(DEFAULT_POLICY_VIEW);
  const [loading, setLoading] = useState(true);
  const [booted, setBooted] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [policyError, setPolicyError] = useState<string | null>(null);
  const [policySaving, setPolicySaving] = useState(false);
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('methods');

  const policyDirty = JSON.stringify(draftPolicy) !== JSON.stringify(savedPolicy);
  const justSaved = !policyDirty;
  // Background reloads must never overwrite an unsaved policy draft.
  const policyDirtyRef = useRef(false);
  useEffect(() => {
    policyDirtyRef.current = policyDirty;
  }, [policyDirty]);

  const loadAll = useCallback(async () => {
    try {
      setLoading(true);
      setLoadError(null);
      const [accountsRes, policyRes] = await Promise.all([
        paymentClient.getPaymentAccounts(),
        paymentClient.getPaymentPolicy(),
      ]);
      setAccounts(Array.isArray(accountsRes?.data) ? accountsRes.data : []);
      const policy = normalizePolicy(policyRes?.data);
      // The draft only resets to the server value when the merchant has nothing
      // unsaved; a dirty policy survives the refresh (Guardrails §2).
      if (!policyDirtyRef.current) {
        setSavedPolicy(policy);
        setDraftPolicy(policy);
      } else {
        setSavedPolicy(policy);
      }
    } catch (err: unknown) {
      setLoadError(getErrorMessage(err, t(`manageShop.paymentSettings.errors.loadFailed`)));
    } finally {
      setLoading(false);
      setBooted(true);
    }
  }, [t]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  // Methods mutations reload ONLY the accounts — the policy draft is preserved.
  const reloadAccounts = useCallback(async () => {
    const res = await paymentClient.getPaymentAccounts();
    setAccounts(Array.isArray(res?.data) ? res.data : []);
  }, []);

  const savePolicy = useCallback(async () => {
    setPolicySaving(true);
    setPolicyError(null);
    try {
      const res = await paymentClient.updatePaymentPolicy({
        advance_policy: draftPolicy.advance_policy,
        advance_value: draftPolicy.advance_value,
        payment_message: draftPolicy.payment_message,
      });
      const persisted = normalizePolicy(res?.data);
      setSavedPolicy(persisted);
      setDraftPolicy(persisted);
    } catch (err: unknown) {
      setPolicyError(getErrorMessage(err, t(`manageShop.paymentSettings.errors.saveSettingsFailed`)));
    } finally {
      setPolicySaving(false);
    }
  }, [draftPolicy, t]);

  const moveTabFocus = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number | null = null;
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % TABS.length;
    else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + TABS.length) % TABS.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = TABS.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    document.getElementById(`payment-tab-${TABS[nextIndex].id}`)?.focus();
    setActiveTab(TABS[nextIndex].id);
  };

  const enabledCount = accounts.filter((a) => a.is_enabled).length;
  const preferred = accounts.find((a) => a.is_preferred);
  const preferredLabel = preferred && preferred.provider
    ? `${t(providerNameKey(preferred.provider), { defaultValue: providerDefaultLabel(preferred.provider) })}${preferred.account_type ? ` · ${t(accountTypeKey(preferred.account_type), { defaultValue: accountTypeDefaultLabel(preferred.account_type) })}` : ''}`
    : '—';

  if (loading && !booted) {
    return (
      <div className="em-payment min-h-full p-4 md:p-6">
        <div className="mx-auto w-full max-w-[1440px] space-y-4" aria-label={t(`manageShop.paymentSettings.title`)}>
          {[0, 1, 2].map((row) => (
            <div key={row} className="animate-pulse space-y-3 rounded-xl border border-em-border bg-em-bg-surface p-6">
              <div className="h-5 w-1/3 rounded bg-em-bg-muted" />
              <div className="h-3 w-2/3 rounded bg-em-bg-muted" />
              <div className="h-9 w-40 rounded bg-em-bg-muted" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <MotionConfig reducedMotion="user">
      <div className="em-payment min-h-full p-4 md:p-6">
        <div className="mx-auto w-full max-w-[1440px] space-y-6">
          <motion.div variants={fadeUp} initial={ANIMATE ? 'hidden' : false} animate="visible">
            {/* Slim header (header-removal C1 amendment): "Payment Settings" is NOT
                the AppBar's name ("Payment") in either locale → titleMode="compact".
                No signal band, no breadcrumb, no pill strip — the contextual
                account facts render inside the methods tab below. */}
            <PageHeader title={t(`manageShop.paymentSettings.title`)} titleMode="compact" />
          </motion.div>

          {/* Load failure has an honest surface (C4: alert regions stay). Its old
              home was the header signal's blocked reason — relocated here with a
              retry affordance so nothing is only-in-the-band. */}
          {loadError && (
            <div role="alert" data-testid="payment-load-error" className="flex items-center gap-2 rounded-xl border border-em-danger-700/20 bg-em-danger-100 px-4 py-3 text-sm text-em-danger-700">
              <span className="flex-1">{loadError}</span>
              <button
                type="button"
                onClick={() => void loadAll()}
                className="min-h-11 rounded-lg border border-em-danger-700/30 px-3 text-xs font-semibold text-em-danger-700 hover:text-em-danger-700/80 focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-em-focus-light"
              >
                {t('common.retry')}
              </button>
            </div>
          )}

          <div role="tablist" aria-label={t(`manageShop.paymentSettings.tabs.label`, { defaultValue: 'Payment settings sections' })} className="flex gap-1 overflow-x-auto">
            {TABS.map((tab, index) => (
              <button
                key={tab.id}
                id={`payment-tab-${tab.id}`}
                type="button"
                role="tab"
                data-testid={`payment-tab-${tab.id}`}
                aria-selected={activeTab === tab.id}
                aria-controls={`payment-panel-${tab.id}`}
                tabIndex={activeTab === tab.id ? 0 : -1}
                onClick={() => setActiveTab(tab.id)}
                onKeyDown={(event) => moveTabFocus(event, index)}
                className={`shrink-0 rounded-lg px-3 py-2 text-sm font-semibold ${
                  activeTab === tab.id
                    ? 'bg-em-violet-600 text-white'
                    : 'bg-em-bg-surface text-em-text-secondary hover:bg-em-violet-50'
                }`}
              >
                {t(tab.labelKey, { defaultValue: tab.def })}
              </button>
            ))}
          </div>

          {activeTab === 'methods' && (
            <div role="tabpanel" id="payment-panel-methods" aria-labelledby="payment-tab-methods" tabIndex={-1}>
              {/* Contextual account facts relocated from the retired header band:
                  server-confirmed state (never a global shop pulse, C1). The
                  advance rule is intentionally NOT repeated here — the Policies
                  tab's own form + saved footer are its single honest home. */}
              <div className="mb-4 flex flex-wrap items-center gap-2">
                <span className="em-tabular whitespace-nowrap rounded-full border border-em-border bg-em-bg-muted px-3 py-1 text-xs font-medium text-em-text-secondary">
                  {t(`manageShop.paymentSettings.enabledMethodsLabel`)}: {enabledCount}
                </span>
                <span className="whitespace-nowrap rounded-full border border-em-border bg-em-bg-muted px-3 py-1 text-xs font-medium text-em-text-secondary">
                  {t(`manageShop.paymentSettings.accounts.preferred`, { defaultValue: 'Preferred' })}: {preferredLabel}
                </span>
              </div>
              <MethodsTab accounts={accounts} onMutate={reloadAccounts} />
            </div>
          )}

          {activeTab === 'policies' && (
            <div role="tabpanel" id="payment-panel-policies" aria-labelledby="payment-tab-policies" tabIndex={-1}>
              <PoliciesTab
                policy={draftPolicy}
                onChange={setDraftPolicy}
                onSave={savePolicy}
                isDirty={policyDirty}
                justSaved={justSaved && !policySaving}
                errors={policyError}
              />
            </div>
          )}
        </div>
      </div>
    </MotionConfig>
  );
}
