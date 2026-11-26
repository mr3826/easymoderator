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
 * - Execution-page header: title + one channel signal + factual pills only,
 *   no header CTA (§29). `derivePaymentSignal` is reused unchanged so its unit
 *   pins keep passing; the ladder truth lives on each account card, not in the
 *   signal (§7 row 3).
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
import { derivePaymentSignal } from '../payment/derive';
import { authService } from '@/app/lib/auth';
import { getErrorMessage } from '@shared/lib/http/errors';
import { paymentClient } from './paymentClient';
import MethodsTab from './MethodsTab';
import PoliciesTab from './PoliciesTab';
import type { AdvancePolicy, PaymentAccountView, PaymentPolicyView } from './taxonomy';
import { ADVANCE_POLICIES, DEFAULT_POLICY_VIEW, accountTypeDefaultLabel, accountTypeKey, advancePolicyKey, providerDefaultLabel, providerNameKey } from './taxonomy';

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

  const phase = loadError ? 'error' : loading && !booted ? 'loading' : 'ready';
  const enabledCount = accounts.filter((a) => a.is_enabled).length;
  const signal = derivePaymentSignal({ phase, enabledCount }, t);
  const shopName = authService.getCurrentShop()?.shop_name || t(`manageShop.paymentSettings.title`);
  const preferred = accounts.find((a) => a.is_preferred);
  const preferredLabel = preferred && preferred.provider
    ? `${t(providerNameKey(preferred.provider), { defaultValue: providerDefaultLabel(preferred.provider) })}${preferred.account_type ? ` · ${t(accountTypeKey(preferred.account_type), { defaultValue: accountTypeDefaultLabel(preferred.account_type) })}` : ''}`
    : '—';
  const advanceRuleLabel = t(advancePolicyKey(draftPolicy.advance_policy));

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
            <PageHeader
              title={t(`manageShop.paymentSettings.title`)}
              breadcrumb={[{ label: shopName }]}
              signal={signal}
              signalTestId="payment-signal"
              signalAnnounce={false}
              meta={
                <div className="flex flex-wrap items-center gap-2">
                  <span className="em-tabular whitespace-nowrap rounded-full border border-em-border bg-em-bg-muted px-3 py-1 text-xs font-medium text-em-text-secondary">
                    {t(`manageShop.paymentSettings.enabledMethodsLabel`)}: {enabledCount}
                  </span>
                  <span className="whitespace-nowrap rounded-full border border-em-border bg-em-bg-muted px-3 py-1 text-xs font-medium text-em-text-secondary">
                    {t(`manageShop.paymentSettings.accounts.preferred`, { defaultValue: 'Preferred' })}: {preferredLabel}
                  </span>
                  <span className="whitespace-nowrap rounded-full border border-em-border bg-em-bg-muted px-3 py-1 text-xs font-medium text-em-text-secondary">
                    {t(`manageShop.paymentSettings.advanceRuleLabel`)}: {advanceRuleLabel}
                  </span>
                </div>
              }
            />
          </motion.div>

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
