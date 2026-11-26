/**
 * Tab 2 — "Payment Policies" (contract §5). Server-truth advance-payment policy,
 * persisted through the ONE `PUT /api/payment/policy` the shell owns (R-14: one
 * write pair per tab). This tab is presentational: every edit flows up through
 * `onChange`, `onSave` runs the single PUT, and `isDirty`/`justSaved` come from
 * the shell's saved-snapshot equality so the Saved confirmation only ever appears
 * after the server confirms (server-confirmed success; §4).
 *
 * Client validation MIRRORS the server policy validator (§5.2 /
 * payment-policy.service.js) so the PUT is never asked to reject what the
 * merchant can already see: percentage 1..99, fixed 1..100000 (both integers),
 * none|full|delivery_charge force `advance_value` null, message ≤ 500 chars. The
 * order-relative `fixed ≥ total → full` clamp lives at checkout math on the
 * server — never re-implemented or faked here.
 *
 * Honesty (§5.2 / §6): COD availability and the real delivery-charge number are
 * computed in Delivery Settings; this tab links there and never duplicates a
 * zone/COD control. The advance policy was previously a UI illusion (a blob the
 * server silently dropped) — the PUT now returns real validation errors which
 * surface inline.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { AlertCircle, AlertTriangle, Check } from 'lucide-react';
import { EmButton } from '../dashboard/EmButton';
import type { AdvancePolicy, PaymentPolicyView } from './taxonomy';
import { ADVANCE, ADVANCE_POLICIES, advancePolicyKey } from './taxonomy';

const FOCUS_RING =
  'focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-em-focus-light focus-visible:transition-none';
const INPUT_CLASSES =
  `w-full min-h-11 border border-em-border rounded-lg bg-em-bg-surface px-3 py-2 text-sm text-em-text-primary focus:outline-none ${FOCUS_RING}`;

const DELIVERY_SETTINGS_PATH = '/manage-shop/delivery-settings';

export interface PoliciesTabProps {
  policy: PaymentPolicyView;
  onChange: (next: PaymentPolicyView) => void;
  onSave: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  isDirty: boolean;
  justSaved: boolean;
  errors?: string | null;
}

export default function PoliciesTab({
  policy,
  onChange,
  onSave,
  onDirtyChange,
  isDirty,
  justSaved,
  errors = null,
}: PoliciesTabProps) {
  const { t, i18n } = useTranslation();
  const [saveInFlight, setSaveInFlight] = useState(false);
  const [blockedAlert, setBlockedAlert] = useState(false);

  const numberFormat = useMemo(
    () => new Intl.NumberFormat(i18n.language?.toLowerCase().startsWith('bn') ? 'bn-BD' : 'en-US'),
    [i18n.language],
  );

  // ---- Validation mirror of payment-policy.service.js validateAndBuildPolicy ----
  const issues = useMemo<string[]>(() => {
    const list: string[] = [];
    const value = policy.advance_value;
    if (policy.advance_policy === 'percentage') {
      if (value === null || !Number.isInteger(value) || value < ADVANCE.percentageMin || value > ADVANCE.percentageMax) {
        list.push(t(`manageShop.paymentSettings.policy.percentageRange`, {
          min: ADVANCE.percentageMin,
          max: ADVANCE.percentageMax,
          defaultValue: `Percentage must be a whole number from ${ADVANCE.percentageMin} to ${ADVANCE.percentageMax}`,
        }));
      }
    } else if (policy.advance_policy === 'fixed') {
      if (value === null || !Number.isInteger(value) || value < ADVANCE.fixedMin || value > ADVANCE.fixedMax) {
        list.push(t(`manageShop.paymentSettings.policy.fixedRange`, {
          min: numberFormat.format(ADVANCE.fixedMin),
          max: numberFormat.format(ADVANCE.fixedMax),
          defaultValue: `Fixed advance must be a whole taka amount from ${numberFormat.format(ADVANCE.fixedMin)} to ${numberFormat.format(ADVANCE.fixedMax)}`,
        }));
      }
    } else if (value !== null) {
      list.push(t(`manageShop.paymentSettings.policy.valueNotAllowed`, { defaultValue: 'This rule has no advance amount to set.' }));
    }
    if (policy.payment_message.length > ADVANCE.messageMax) {
      list.push(t(`manageShop.paymentSettings.policy.messageTooLong`, {
        max: ADVANCE.messageMax,
        defaultValue: `The payment message must be at most ${ADVANCE.messageMax} characters`,
      }));
    }
    return list;
  }, [policy, t, numberFormat]);

  const hasIssues = issues.length > 0;

  useEffect(() => {
    if (!hasIssues) setBlockedAlert(false);
  }, [hasIssues]);

  useEffect(() => {
    if (justSaved || errors) setSaveInFlight(false);
  }, [justSaved, errors]);

  const lastDirtyReport = useRef<boolean | null>(null);
  useEffect(() => {
    if (lastDirtyReport.current !== isDirty) {
      lastDirtyReport.current = isDirty;
      onDirtyChange?.(isDirty);
    }
  }, [isDirty, onDirtyChange]);

  // ---- Edit helpers (emit up; the shell runs the one PUT) ----
  const selectPolicy = (next: AdvancePolicy) => {
    if (next === 'percentage') {
      onChange({ ...policy, advance_policy: next, advance_value: policy.advance_value ?? 50 });
    } else if (next === 'fixed') {
      onChange({ ...policy, advance_policy: next, advance_value: policy.advance_value ?? 100 });
    } else {
      // none | full | delivery_charge force advance_value null (§5.2).
      onChange({ ...policy, advance_policy: next, advance_value: null });
    }
  };

  const setValue = (raw: string) => {
    const parsed = raw.trim() === '' ? null : Number.parseInt(raw, 10);
    onChange({ ...policy, advance_value: Number.isNaN(parsed as number) ? null : parsed });
  };

  const handleSave = () => {
    if (hasIssues) {
      setBlockedAlert(true);
      return;
    }
    setSaveInFlight(true);
    onSave();
  };

  const saveDisabled = !isDirty;
  const cleanReason = justSaved
    ? t(`manageShop.paymentSettings.policy.saved`, { defaultValue: 'Payment policy saved' })
    : t(`manageShop.paymentSettings.policy.allSaved`, { defaultValue: 'All changes saved' });

  const statusChip = isDirty ? (
    <span className="inline-flex items-center gap-1 text-xs font-semibold text-em-sunlight-700">
      <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
      {t(`manageShop.paymentSettings.policy.unsaved`, { defaultValue: 'Unsaved changes' })}
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-xs font-semibold text-em-success-700">
      <Check className="h-4 w-4 shrink-0" aria-hidden="true" />
      {cleanReason}
    </span>
  );

  // NOTE: no `em-payment` here — the scope class belongs to the workspace
  // root ONLY (PaymentWorkspace.tsx); re-wrapping here double-scoped the token
  // layer and the e2e axe/em-payment selectors.
  return (
    <div className="space-y-6" data-testid="policies-tab">
      {errors && (
        <div role="alert" className="flex items-start gap-2 rounded-xl border border-em-danger-700/20 bg-em-danger-100 p-4">
          <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-em-danger-700" aria-hidden="true" />
          <p className="text-sm text-em-danger-700">{errors}</p>
        </div>
      )}

      {blockedAlert && hasIssues && (
        <div role="alert" className="rounded-xl border border-em-danger-700/20 bg-em-danger-100 p-4">
          <p className="flex items-start gap-2 text-sm font-semibold text-em-danger-700">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            {t(`manageShop.paymentSettings.policy.fixBeforeSave`, { defaultValue: 'Fix these before saving' })}
          </p>
          <ul className="mt-1 space-y-0.5 pl-6 text-sm text-em-danger-700">
            {issues.map((issue) => <li key={issue} className="list-disc">{issue}</li>)}
          </ul>
        </div>
      )}

      {/* Advance rule radio set — five canonical rules (§5.2). */}
      <section className="rounded-xl border border-em-border bg-em-bg-surface p-6" aria-labelledby="policy-advance-heading">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 id="policy-advance-heading" className="text-lg font-semibold text-em-text-primary">
            {t(`manageShop.paymentSettings.advanceTitle`)}
          </h2>
          <div className="flex items-center gap-3">
            {statusChip}
            <EmButton
              variant="primary"
              onClick={handleSave}
              disabled={saveDisabled}
              loading={saveInFlight}
              title={saveDisabled ? cleanReason : undefined}
              data-testid="policy-save"
            >
              {t(`manageShop.paymentSettings.updatePayment`)}
            </EmButton>
          </div>
        </div>

        {/* F2 (A8 round-2 honesty): every self-MFS claim collects the FULL
            order total (payment-claim.service.js computeClaimAmount) — the
            advance rules below are recorded for gateway automation that is
            inert (R-12). The tab must not promise enforcement it no longer
            performs. */}
        <p className="mb-4 rounded-xl border border-em-sunlight-500/40 bg-em-sunlight-100 px-4 py-3 text-sm text-em-sunlight-700" data-testid="advance-enforcement-caveat">
          {t(`manageShop.paymentSettings.policy.enforcementCaveat`, {
            defaultValue: 'Advance rules are recorded for gateway automation. Until live-certified automation is active, the assistant always asks customers for the full order total — these rules change nothing about what is collected today.',
          })}
        </p>

        <div className="space-y-3" role="radiogroup" aria-label={t(`manageShop.paymentSettings.advanceTitle`)}>
          {ADVANCE_POLICIES.map((value) => {
            const selected = policy.advance_policy === value;
            const isPercentage = value === 'percentage';
            const isFixed = value === 'fixed';
            return (
              <label
                key={value}
                data-testid={`advance-radio-${value}`}
                className={`flex cursor-pointer items-start gap-3 rounded-xl border-2 p-4 transition-colors ${
                  selected ? 'border-em-violet-600 bg-em-violet-50' : 'border-em-border hover:border-em-border-strong'
                }`}
              >
                <input
                  type="radio"
                  name="advance-policy"
                  value={value}
                  checked={selected}
                  onChange={() => selectPolicy(value)}
                  className="mt-1 h-5 w-5 accent-em-violet-600"
                />
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-em-text-primary">{t(advancePolicyKey(value))}</div>
                  {value === 'none' && <div className="text-sm text-em-text-secondary">{t(`manageShop.paymentSettings.noPaymentDesc`)}</div>}
                  {value === 'full' && <div className="text-sm text-em-text-secondary">{t(`manageShop.paymentSettings.fullPaymentDesc`)}</div>}
                  {value === 'delivery_charge' && <div className="text-sm text-em-text-secondary">{t(`manageShop.paymentSettings.deliveryOnlyDesc`)}</div>}

                  {isPercentage && selected && (
                    <div className="mt-2 flex items-center gap-2">
                      <input
                        type="number"
                        inputMode="numeric"
                        aria-label={t(`manageShop.paymentSettings.percentage`)}
                        value={policy.advance_value ?? ''}
                        onChange={(event) => setValue(event.target.value)}
                        min={ADVANCE.percentageMin}
                        max={ADVANCE.percentageMax}
                        className={`w-24 ${INPUT_CLASSES}`}
                        data-testid="advance-percentage-input"
                      />
                      <span className="text-sm text-em-text-secondary">{t(`manageShop.paymentSettings.percentageSuffix`)}</span>
                    </div>
                  )}
                  {isFixed && selected && (
                    <div className="mt-2 flex items-center gap-2">
                      <span className="text-em-text-secondary">৳</span>
                      <input
                        type="number"
                        inputMode="numeric"
                        aria-label={t(`manageShop.paymentSettings.fixedAmount`)}
                        value={policy.advance_value ?? ''}
                        onChange={(event) => setValue(event.target.value)}
                        min={ADVANCE.fixedMin}
                        max={ADVANCE.fixedMax}
                        className={`w-32 ${INPUT_CLASSES}`}
                        data-testid="advance-fixed-input"
                      />
                      <span className="text-sm text-em-text-secondary">{t(`manageShop.paymentSettings.fixedSuffix`)}</span>
                    </div>
                  )}
                </div>
              </label>
            );
          })}
        </div>

        <p className="mt-3 text-xs text-em-text-secondary">
          {t(`manageShop.paymentSettings.policy.deliveryPointerPrefix`, { defaultValue: 'Cash-on-delivery availability and the delivery-charge amount are set in' })}{' '}
          <Link
            to={DELIVERY_SETTINGS_PATH}
            className={`font-semibold text-em-violet-700 hover:text-em-violet-900 hover:underline ${FOCUS_RING}`}
            data-testid="policy-delivery-link"
          >
            {t(`manageShop.paymentSettings.policy.deliveryLink`, { defaultValue: 'Delivery Settings' })}
          </Link>
          {t(`manageShop.paymentSettings.policy.deliveryPointerSuffix`, { defaultValue: '— the advance “delivery charge” rule references that number and never re-computes it.' })}
        </p>
      </section>

      {/* Payment process message — preserved verbatim (§5.2). */}
      <section className="rounded-xl border border-em-border bg-em-bg-surface p-6" aria-labelledby="policy-message-heading">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 id="policy-message-heading" className="text-lg font-semibold text-em-text-primary">
            {t(`manageShop.paymentSettings.paymentMessage`)}
          </h2>
          <span className="em-tabular text-xs text-em-text-secondary" data-testid="policy-message-count">
            {numberFormat.format(policy.payment_message.length)} / {numberFormat.format(ADVANCE.messageMax)}
          </span>
        </div>
        <textarea
          value={policy.payment_message}
          onChange={(event) => onChange({ ...policy, payment_message: event.target.value })}
          placeholder={t(`manageShop.paymentSettings.paymentMessagePlaceholder`)}
          aria-label={t(`manageShop.paymentSettings.paymentMessage`)}
          rows={5}
          maxLength={ADVANCE.messageMax}
          className={`${INPUT_CLASSES} mb-4`}
          data-testid="policy-message-input"
        />
        <div className="flex items-center gap-3">
          {statusChip}
          <EmButton variant="primary" onClick={handleSave} disabled={saveDisabled} loading={saveInFlight} data-testid="policy-message-save">
            {t(`manageShop.paymentSettings.updatePayment`)}
          </EmButton>
        </div>
      </section>
    </div>
  );
}
