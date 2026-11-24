/**
 * Tab 3 — "Delivery Charges & Policies" (Delivery Settings redesign, role A3).
 *
 * Contract with the shell (A0 owns `DeliverySettings.tsx`):
 * - All edits flow through `onChange(nextSettings)` up to the shell, which owns
 *   the ONE shared `shop.settings.delivery` object and the ONE
 *   `PUT /api/shop/delivery/settings`. This tab never calls the API (§"one
 *   PUT", ADR-0013 — no second configuration authority).
 * - `isDirty` / `justSaved` come from the shell's saved-snapshot equality, so
 *   the Saved indicator only ever appears after the server confirms the PUT
 *   (§4 — never claim success before the server does; Pending until confirmed).
 * - `errors` is the shell's last save/load failure message; it is shown inline
 *   near the fields the merchant was working in (§17 "inline first") and every
 *   input keeps its value when a save fails (§12 preserve input on failure).
 * - Validation mirrors `delivery.validator.js updateSettings` client-side so
 *   the server can never be asked to reject what the merchant can already see:
 *   `from_kg < to_kg`, non-overlapping tiers, one row per zone, non-negative
 *   area charges and tier values, charges are coerced to numbers. Invalid
 *   edits block `onSave` before the PUT.
 * - Honesty (preservation rows D3/D4/D9 + dead-field notes): weight tiers are
 *   "recorded only — NOT applied to quotes/bookings" (test-pinned copy), and
 *   `cod_charge` / `non_refundable` / `cod_enabled` / per-area COD are stored
 *   for configuration but not consumed by the live calculators — every one of
 *   them carries calm, non-scary helper copy. Nothing here claims an effect
 *   the platform does not have.
 * - Empty area/weight lists fall back to the platform defaults on save (frozen
 *   server behaviour — preserved, not "fixed"); the cards say so honestly and
 *   name the real default values via the shell's `applyDefaults`.
 * - Motion: intentionally none inside this tab (§19 — static utility text gets
 *   no mount animation; state changes are label + icon, never colour-only).
 *   Everything stays inside the `.em-delivery` scope and uses `--em-*` tokens.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, AlertTriangle, Check, X } from 'lucide-react';
import { EmButton } from '@/app/components/dashboard/EmButton';
import type {
  DeliveryAreaPricing,
  DeliveryShopSettings,
  DeliveryWeightTier,
} from '@/api/types/order';

// Kept identical to the current page until A0 lifts them into the shared
// delivery/styles.ts (A0-owned) — single visual contract for all three tabs.
const FOCUS_RING =
  'focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-em-focus-light focus-visible:transition-none';

const INPUT_CLASSES =
  `w-full min-h-11 border border-em-border rounded-lg bg-em-bg-surface px-3 py-2 text-sm text-em-text-primary focus:outline-none ${FOCUS_RING}`;

const CHECKBOX_CLASSES = 'h-5 w-5 rounded border-em-border-strong accent-em-violet-600';

type DeliveryZone = DeliveryAreaPricing['zone'];

const ZONES: DeliveryZone[] = ['inside_dhaka', 'sub_dhaka', 'outside_dhaka'];

export interface ChargesTabProps {
  /** The one shared settings object owned by the shell. */
  settings: DeliveryShopSettings;
  /** Emit every edit up to the shell — the single source of the one PUT. */
  onChange: (next: DeliveryShopSettings) => void;
  /** Ask the shell to run the one PUT. Never called with invalid data. */
  onSave: () => void;
  /** Report tab-level dirty state for the shell's unsaved-draft guard. */
  onDirtyChange: (dirty: boolean) => void;
  /** settings !== last server-saved snapshot (computed by the shell). */
  isDirty: boolean;
  /** True only after the server confirmed the last PUT (shell snapshot). */
  justSaved: boolean;
  /** Last shell-level save/load failure message, shown inline here too. */
  errors?: string | null;
  /** Shell's hydration normaliser — used only to name the real defaults in helper copy. */
  applyDefaults: (settings?: Partial<DeliveryShopSettings> | null) => DeliveryShopSettings;
}

export function ChargesTab({
  settings,
  onChange,
  onSave,
  onDirtyChange,
  isDirty,
  justSaved,
  errors = null,
  applyDefaults,
}: ChargesTabProps) {
  const { t, i18n } = useTranslation();
  const [saveInFlight, setSaveInFlight] = useState(false);
  const [blockedAlert, setBlockedAlert] = useState(false);

  // Bangla numerals must render for bn counts/amounts (§12; customerDisplay.ts
  // pattern). Charge inputs themselves stay plain editable numbers.
  const usesBnNumerals = i18n.language === 'bn';
  const numberFormat = useMemo(
    () => new Intl.NumberFormat(usesBnNumerals ? 'bn-BD' : 'en-US'),
    [usesBnNumerals],
  );

  const zoneLabel = useMemo<Record<DeliveryZone, string>>(() => ({
    inside_dhaka: t('manageShop.deliverySettings.zoneInsideDhaka'),
    sub_dhaka: t('manageShop.deliverySettings.zoneSubDhaka'),
    outside_dhaka: t('manageShop.deliverySettings.zoneOutsideDhaka'),
  }), [t]);

  // ---- Validation mirror of delivery.validator.js updateSettings ----------
  // (Joi: zone enum w/ no duplicate, area charge >= 0, weight from<to,
  //  non-overlapping tiers. Number coercion happens on every input below.)

  const tierOrderErrorRows = useMemo(
    () => new Set(
      settings.weight_tiers
        .map((tier, index) => ({ invalid: tier.from_kg >= tier.to_kg, index }))
        .filter((entry) => entry.invalid)
        .map((entry) => entry.index),
    ),
    [settings.weight_tiers],
  );

  const overlapErrorRows = useMemo(() => {
    const rows = new Set<number>();
    const sorted = settings.weight_tiers
      .map((tier, index) => ({ tier, index }))
      .sort((a, b) => a.tier.from_kg - b.tier.from_kg);
    for (let i = 1; i < sorted.length; i += 1) {
      const previous = sorted[i - 1];
      const current = sorted[i];
      if (current.tier.from_kg < previous.tier.to_kg) {
        rows.add(previous.index);
        rows.add(current.index);
      }
    }
    return rows;
  }, [settings.weight_tiers]);

  const duplicateZoneErrorRows = useMemo(() => {
    const seen = new Set<DeliveryZone>();
    const rows = new Set<number>();
    settings.area_pricing.forEach((area, index) => {
      if (seen.has(area.zone)) rows.add(index);
      else seen.add(area.zone);
    });
    return rows;
  }, [settings.area_pricing]);

  // Joi enforces min(0) on area charge and every weight-tier field; typing a
  // minus sign can still produce a negative, so mirror it and block the PUT.
  const negativeAreaChargeRows = useMemo(
    () => new Set(
      settings.area_pricing
        .map((area, index) => ({ negative: area.charge < 0, index }))
        .filter((entry) => entry.negative)
        .map((entry) => entry.index),
    ),
    [settings.area_pricing],
  );

  const negativeTierRows = useMemo(
    () => new Set(
      settings.weight_tiers
        .map((tier, index) => ({
          negative: tier.from_kg < 0 || tier.to_kg < 0 || tier.extra_charge < 0,
          index,
        }))
        .filter((entry) => entry.negative)
        .map((entry) => entry.index),
    ),
    [settings.weight_tiers],
  );

  const issueSummaries = useMemo(() => {
    const issues: string[] = [];
    if (tierOrderErrorRows.size > 0) issues.push(t('manageShop.deliverySettings.errors.invalidWeightTiers'));
    if (overlapErrorRows.size > 0) issues.push(t('manageShop.deliverySettings.charges.overlappingTiers'));
    if (duplicateZoneErrorRows.size > 0) issues.push(t('manageShop.deliverySettings.charges.duplicateZone'));
    if (negativeAreaChargeRows.size > 0 || negativeTierRows.size > 0) {
      issues.push(t('manageShop.deliverySettings.charges.negativeValue'));
    }
    return issues;
  }, [tierOrderErrorRows, overlapErrorRows, duplicateZoneErrorRows, negativeAreaChargeRows, negativeTierRows, t]);

  const hasIssues = issueSummaries.length > 0;

  // ---- State handoff with the shell ----------------------------------------

  // Report dirty transitions without looping when the shell re-renders with a
  // new callback identity: only an actual transition is emitted.
  const lastDirtyReport = useRef<boolean | null>(null);
  useEffect(() => {
    if (lastDirtyReport.current !== isDirty) {
      lastDirtyReport.current = isDirty;
      onDirtyChange(isDirty);
    }
  }, [isDirty, onDirtyChange]);

  // Saved/pending clarity (§16): the in-flight spinner only ever ends when the
  // shell reports a server-confirmed save (justSaved) or an error — never on a
  // local guess.
  useEffect(() => {
    if (justSaved || errors) setSaveInFlight(false);
  }, [justSaved, errors]);

  useEffect(() => {
    if (!hasIssues) setBlockedAlert(false);
  }, [hasIssues]);

  const handleSave = () => {
    if (hasIssues) {
      // Rejected before onSave runs: the PUT can never be asked to fail what
      // the client can already prove is invalid. Inputs are preserved (§12).
      setBlockedAlert(true);
      return;
    }
    setSaveInFlight(true);
    onSave();
  };

  // ---- Edit helpers (every one emits the shared object up, never saves) ----

  const patch = (partial: Partial<DeliveryShopSettings>) => {
    onChange({ ...settings, ...partial });
  };

  const patchArea = (index: number, partial: Partial<DeliveryAreaPricing>) => {
    onChange({
      ...settings,
      area_pricing: settings.area_pricing.map((area, idx) => (idx === index ? { ...area, ...partial } : area)),
    });
  };

  const patchTier = (index: number, partial: Partial<DeliveryWeightTier>) => {
    onChange({
      ...settings,
      weight_tiers: settings.weight_tiers.map((tier, idx) => (idx === index ? { ...tier, ...partial } : tier)),
    });
  };

  const addAreaPricing = () => {
    // Seed the first not-yet-priced zone so the new row does not arrive
    // pre-flagged as a duplicate; falls back to the first zone when all three
    // are used (the honest duplicate hint then appears near the field).
    const used = new Set(settings.area_pricing.map((area) => area.zone));
    const zone = ZONES.find((candidate) => !used.has(candidate)) ?? ZONES[0];
    onChange({
      ...settings,
      area_pricing: [...settings.area_pricing, { zone, charge: 0, cod_enabled: false }],
    });
  };

  const removeAreaPricing = (index: number) => {
    onChange({ ...settings, area_pricing: settings.area_pricing.filter((_, idx) => idx !== index) });
  };

  const addWeightTier = () => {
    // Continue from the heaviest existing range so the new tier is valid by
    // default (0–1 kg when the list is empty, matching the platform default).
    const maxTo = settings.weight_tiers.reduce((max, tier) => Math.max(max, tier.to_kg), 0);
    onChange({
      ...settings,
      weight_tiers: [...settings.weight_tiers, { from_kg: maxTo, to_kg: maxTo + 1, extra_charge: 0 }],
    });
  };

  const removeWeightTier = (index: number) => {
    onChange({ ...settings, weight_tiers: settings.weight_tiers.filter((_, idx) => idx !== index) });
  };

  // Honest fallback copy: clearing every row reverts to the real platform
  // defaults (frozen server behaviour). Values come from the shell's own
  // applyDefaults, with bn numerals — never a fabricated number.
  const defaultAreaText = useMemo(
    () => applyDefaults({})
      .area_pricing
      .map((area) => `${zoneLabel[area.zone]} ৳${numberFormat.format(area.charge)}`)
      .join(' · '),
    [applyDefaults, zoneLabel, numberFormat],
  );

  const defaultTierText = useMemo(
    () => applyDefaults({})
      .weight_tiers
      .map((tier) => `${numberFormat.format(tier.from_kg)}–${numberFormat.format(tier.to_kg)} kg`)
      .join(', '),
    [applyDefaults, numberFormat],
  );

  // ---- Shared status + save affordance -------------------------------------
  // General, area and weight all live in one settings object behind one PUT, so
  // every pricing card carries the same save affordance where the merchant
  // actually edits. The label and helper state the real scope (test-pinned).

  const saveDisabled = !isDirty;
  const cleanReason = justSaved
    ? t('manageShop.deliverySettings.chargesSaved')
    : t('manageShop.deliverySettings.charges.allChangesSaved');

  const statusChip = isDirty ? (
    <span className="inline-flex items-center gap-1 text-xs font-semibold text-em-sunlight-700">
      <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
      {t('manageShop.deliverySettings.charges.unsavedChanges')}
    </span>
  ) : justSaved ? (
    <span className="inline-flex items-center gap-1 text-xs font-semibold text-em-success-700">
      <Check className="h-4 w-4 shrink-0" aria-hidden="true" />
      {t('manageShop.deliverySettings.chargesSaved')}
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-xs text-em-text-secondary">
      <Check className="h-4 w-4 shrink-0" aria-hidden="true" />
      {t('manageShop.deliverySettings.charges.allChangesSaved')}
    </span>
  );

  const renderSaveRow = (testId?: string) => (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-em-border pt-4">
      <p className="min-w-0 flex-1 text-xs text-em-text-secondary">
        {t('manageShop.deliverySettings.saveChargesScope')}
      </p>
      <div className="flex items-center gap-3">
        {statusChip}
        <EmButton
          variant="primary"
          onClick={handleSave}
          disabled={saveDisabled}
          loading={saveInFlight}
          title={saveDisabled ? cleanReason : undefined}
          data-testid={testId}
        >
          {t('manageShop.deliverySettings.saveCharges')}
        </EmButton>
      </div>
    </div>
  );

  const inlineError = (message: string) => (
    <p className="mt-1 flex items-start gap-1 text-xs font-medium text-em-danger-700">
      <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>{message}</span>
    </p>
  );

  const honestyHelper = (message: string, id?: string) => (
    <p id={id} className="mt-1 text-xs text-em-text-secondary">
      {message}
    </p>
  );

  const areaCountLabel = t('manageShop.deliverySettings.charges.areaCount', {
    count: settings.area_pricing.length,
    formatted: numberFormat.format(settings.area_pricing.length),
  });
  const tierCountLabel = t('manageShop.deliverySettings.charges.tierCount', {
    count: settings.weight_tiers.length,
    formatted: numberFormat.format(settings.weight_tiers.length),
  });

  return (
    <div className="em-delivery space-y-6" data-testid="charges-tab">
      {/* What failed / why it matters / what to do (§16) — inline, values kept. */}
      {errors && (
        <div role="alert" className="flex items-start gap-2 rounded-xl border border-em-danger-700/20 bg-em-danger-100 p-4">
          <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-em-danger-700" aria-hidden="true" />
          <p className="text-sm text-em-danger-700">{errors}</p>
        </div>
      )}

      {/* Blocked-before-save summary: the PUT is never attempted with data the
          client can already prove invalid. */}
      {blockedAlert && hasIssues && (
        <div role="alert" className="rounded-xl border border-em-danger-700/20 bg-em-danger-100 p-4">
          <p className="flex items-start gap-2 text-sm font-semibold text-em-danger-700">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            {t('manageShop.deliverySettings.charges.fixBeforeSave')}
          </p>
          <ul className="mt-1 space-y-0.5 pl-6 text-sm text-em-danger-700">
            {issueSummaries.map((issue) => (
              <li key={issue} className="list-disc">{issue}</li>
            ))}
          </ul>
        </div>
      )}

      {/* ── General ─────────────────────────────────────────────────────────── */}
      <section className="rounded-xl border border-em-border bg-em-bg-surface p-6" aria-labelledby="charges-general-heading">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 id="charges-general-heading" className="text-lg font-semibold text-em-text-primary">
            {t('manageShop.deliverySettings.generalSettings')}
          </h2>
          <div className="flex items-center gap-3">
            {statusChip}
            <EmButton
              variant="primary"
              onClick={handleSave}
              disabled={saveDisabled}
              loading={saveInFlight}
              title={saveDisabled ? cleanReason : undefined}
              className="gap-2"
            >
              {t('manageShop.deliverySettings.saveSettings')}
            </EmButton>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div>
            <label htmlFor="delivery-default-charge" className="mb-1 block text-sm font-medium text-em-text-primary">
              {t('manageShop.deliverySettings.defaultCharge')}
            </label>
            <input
              id="delivery-default-charge"
              type="number"
              inputMode="decimal"
              aria-label={t('manageShop.deliverySettings.defaultCharge')}
              value={settings.default_delivery_charge}
              onChange={(event) => patch({ default_delivery_charge: Number(event.target.value) || 0 })}
              className={INPUT_CLASSES}
            />
          </div>

          <div>
            <label htmlFor="delivery-cod-charge" className="mb-1 block text-sm font-medium text-em-text-primary">
              {t('manageShop.deliverySettings.codCharge')}
            </label>
            <input
              id="delivery-cod-charge"
              type="number"
              inputMode="decimal"
              aria-label={t('manageShop.deliverySettings.codCharge')}
              value={settings.cod_charge}
              onChange={(event) => patch({ cod_charge: Number(event.target.value) || 0 })}
              disabled={!settings.cod_enabled}
              aria-describedby={settings.cod_enabled
                ? 'delivery-cod-charge-help'
                : 'delivery-cod-charge-help delivery-cod-charge-locked'}
              className={`${INPUT_CLASSES} disabled:bg-em-bg-muted disabled:text-em-text-disabled`}
            />
            {honestyHelper(
              t('manageShop.deliverySettings.charges.codChargeRecorded'),
              'delivery-cod-charge-help',
            )}
            {!settings.cod_enabled && (
              <p id="delivery-cod-charge-locked" className="mt-1 text-xs text-em-text-secondary">
                {t('manageShop.deliverySettings.charges.enableCodToEdit')}
              </p>
            )}
          </div>
        </div>

        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className="inline-flex min-h-11 items-center gap-2 text-sm text-em-text-primary">
              <input
                type="checkbox"
                checked={settings.cod_enabled}
                onChange={(event) => patch({ cod_enabled: event.target.checked })}
                className={CHECKBOX_CLASSES}
              />
              {t('manageShop.deliverySettings.enableCOD')}
            </label>
            {honestyHelper(t('manageShop.deliverySettings.charges.codAvailabilityNote'))}
          </div>
          <div>
            <label className="inline-flex min-h-11 items-center gap-2 text-sm text-em-text-primary">
              <input
                type="checkbox"
                checked={settings.non_refundable}
                onChange={(event) => patch({ non_refundable: event.target.checked })}
                className={CHECKBOX_CLASSES}
              />
              {t('manageShop.deliverySettings.nonRefundable')}
            </label>
            {honestyHelper(t('manageShop.deliverySettings.charges.nonRefundableRecorded'))}
          </div>
        </div>
      </section>

      {/* ── Area-based pricing ──────────────────────────────────────────────── */}
      <section className="rounded-xl border border-em-border bg-em-bg-surface p-6" aria-labelledby="charges-area-heading">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <h2 id="charges-area-heading" className="text-lg font-semibold text-em-text-primary">
              {t('manageShop.deliverySettings.areaBasedPricing')}
            </h2>
            <span className="em-tabular whitespace-nowrap rounded-full border border-em-border bg-em-bg-muted px-2.5 py-0.5 text-xs font-medium text-em-text-secondary">
              {areaCountLabel}
            </span>
          </div>
          <button
            type="button"
            onClick={addAreaPricing}
            className={`min-h-11 rounded-lg px-3 text-sm font-semibold text-em-violet-700 hover:bg-em-violet-50 ${FOCUS_RING}`}
          >
            {t('manageShop.deliverySettings.addArea')}
          </button>
        </div>

        <div className="space-y-3">
          {settings.area_pricing.map((area, index) => (
            <div key={`${area.zone}-${index}`} className="grid grid-cols-1 items-start gap-3 md:grid-cols-12">
              <div className="md:col-span-4">
                <label
                  htmlFor={`delivery-area-zone-${index}`}
                  className="mb-1 block text-xs font-medium text-em-text-secondary"
                >
                  {t('manageShop.deliverySettings.charges.areaZone')}
                </label>
                <select
                  id={`delivery-area-zone-${index}`}
                  aria-label={`${t('manageShop.deliverySettings.areaBasedPricing')} ${index + 1}`}
                  value={area.zone}
                  onChange={(event) => patchArea(index, { zone: event.target.value as DeliveryZone })}
                  aria-invalid={duplicateZoneErrorRows.has(index) || undefined}
                  className={INPUT_CLASSES}
                >
                  {ZONES.map((zone) => (
                    <option key={zone} value={zone}>
                      {zoneLabel[zone]}
                    </option>
                  ))}
                </select>
                {duplicateZoneErrorRows.has(index) && inlineError(
                  t('manageShop.deliverySettings.charges.duplicateZone'),
                )}
              </div>
              <div className="md:col-span-4">
                <label
                  htmlFor={`delivery-area-charge-${index}`}
                  className="mb-1 block text-xs font-medium text-em-text-secondary"
                >
                  {t('manageShop.deliverySettings.charges.areaCharge')}
                </label>
                <input
                  id={`delivery-area-charge-${index}`}
                  type="number"
                  inputMode="decimal"
                  aria-label={`${t('manageShop.deliverySettings.charges.areaCharge')} ${index + 1}`}
                  value={area.charge}
                  onChange={(event) => patchArea(index, { charge: Number(event.target.value) || 0 })}
                  min={0}
                  aria-invalid={negativeAreaChargeRows.has(index) || undefined}
                  className={INPUT_CLASSES}
                />
                {negativeAreaChargeRows.has(index) && inlineError(
                  t('manageShop.deliverySettings.charges.negativeValue'),
                )}
              </div>
              <div className="md:col-span-3">
                <span className="mb-1 block text-xs font-medium text-em-text-secondary">
                  {t('manageShop.deliverySettings.codAllowed')}
                </span>
                <label className="inline-flex min-h-11 items-center gap-2 text-sm text-em-text-primary">
                  <input
                    type="checkbox"
                    checked={area.cod_enabled}
                    onChange={(event) => patchArea(index, { cod_enabled: event.target.checked })}
                    className={CHECKBOX_CLASSES}
                  />
                  {t('manageShop.deliverySettings.codAllowed')}
                </label>
              </div>
              <div className="flex justify-end md:col-span-1">
                <button
                  type="button"
                  onClick={() => removeAreaPricing(index)}
                  className={`min-h-11 min-w-11 inline-flex items-center justify-center text-em-text-secondary hover:text-em-danger-700 ${FOCUS_RING}`}
                  aria-label={t('manageShop.deliverySettings.removeArea')}
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </button>
              </div>
            </div>
          ))}

          {settings.area_pricing.length === 0 && (
            <p className="rounded-lg border border-em-info-700/20 bg-em-info-100 px-4 py-3 text-sm text-em-info-700">
              {t('manageShop.deliverySettings.charges.areasRevertNote', { defaults: defaultAreaText })}
            </p>
          )}
        </div>

        {settings.area_pricing.length > 0 &&
          honestyHelper(t('manageShop.deliverySettings.charges.areaCodRecorded'))}

        {renderSaveRow('area-pricing-save')}
      </section>

      {/* ── Weight-based extra charges ──────────────────────────────────────── */}
      <section className="rounded-xl border border-em-border bg-em-bg-surface p-6" aria-labelledby="charges-weight-heading">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <h2 id="charges-weight-heading" className="text-lg font-semibold text-em-text-primary">
              {t('manageShop.deliverySettings.weightCharges')}
            </h2>
            <span
              className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-em-border-strong text-xs font-semibold text-em-text-secondary"
              title={t('manageShop.deliverySettings.weightTierTooltip')}
            >
              ?
            </span>
            <span className="em-tabular whitespace-nowrap rounded-full border border-em-border bg-em-bg-muted px-2.5 py-0.5 text-xs font-medium text-em-text-secondary">
              {tierCountLabel}
            </span>
          </div>
          <button
            type="button"
            onClick={addWeightTier}
            className={`min-h-11 rounded-lg px-3 text-sm font-semibold text-em-violet-700 hover:bg-em-violet-50 ${FOCUS_RING}`}
          >
            {t('manageShop.deliverySettings.addTier')}
          </button>
        </div>

        {/* Test-pinned honesty band — recorded only, never claimed as applied. */}
        <div className="mb-4 rounded-lg border border-em-info-700/20 bg-em-info-100 px-4 py-3 text-sm text-em-info-700">
          {t('manageShop.deliverySettings.weightTierInfo')}
        </div>

        <div className="space-y-3">
          {settings.weight_tiers.map((tier, index) => (
            <div key={`tier-${index}`} className="grid grid-cols-1 items-start gap-3 md:grid-cols-12">
              <div className="md:col-span-3">
                <label
                  htmlFor={`delivery-tier-from-${index}`}
                  className="mb-1 block text-xs font-medium text-em-text-secondary"
                >
                  {t('manageShop.deliverySettings.weightFrom')}
                </label>
                <input
                  id={`delivery-tier-from-${index}`}
                  type="number"
                  inputMode="decimal"
                  aria-label={`${t('manageShop.deliverySettings.weightFrom')} ${index + 1}`}
                  value={tier.from_kg}
                  onChange={(event) => patchTier(index, { from_kg: Number(event.target.value) || 0 })}
                  min={0}
                  aria-invalid={tierOrderErrorRows.has(index) || overlapErrorRows.has(index) || negativeTierRows.has(index) || undefined}
                  className={INPUT_CLASSES}
                />
              </div>
              <div className="md:col-span-3">
                <label
                  htmlFor={`delivery-tier-to-${index}`}
                  className="mb-1 block text-xs font-medium text-em-text-secondary"
                >
                  {t('manageShop.deliverySettings.weightTo')}
                </label>
                <input
                  id={`delivery-tier-to-${index}`}
                  type="number"
                  inputMode="decimal"
                  aria-label={`${t('manageShop.deliverySettings.weightTo')} ${index + 1}`}
                  value={tier.to_kg}
                  onChange={(event) => patchTier(index, { to_kg: Number(event.target.value) || 0 })}
                  min={0}
                  aria-invalid={tierOrderErrorRows.has(index) || overlapErrorRows.has(index) || negativeTierRows.has(index) || undefined}
                  className={INPUT_CLASSES}
                />
              </div>
              <div className="md:col-span-4">
                <label
                  htmlFor={`delivery-tier-extra-${index}`}
                  className="mb-1 block text-xs font-medium text-em-text-secondary"
                >
                  {t('manageShop.deliverySettings.extraCharge')}
                </label>
                <input
                  id={`delivery-tier-extra-${index}`}
                  type="number"
                  inputMode="decimal"
                  aria-label={`${t('manageShop.deliverySettings.extraCharge')} ${index + 1}`}
                  value={tier.extra_charge}
                  onChange={(event) => patchTier(index, { extra_charge: Number(event.target.value) || 0 })}
                  min={0}
                  className={INPUT_CLASSES}
                />
              </div>
              <div className="flex justify-end md:col-span-2">
                <button
                  type="button"
                  onClick={() => removeWeightTier(index)}
                  className={`min-h-11 min-w-11 inline-flex items-center justify-center text-em-text-secondary hover:text-em-danger-700 ${FOCUS_RING}`}
                  aria-label={t('manageShop.deliverySettings.removeTier')}
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </button>
              </div>
              {(tierOrderErrorRows.has(index) || overlapErrorRows.has(index) || negativeTierRows.has(index)) && (
                <div className="md:col-span-12">
                  {tierOrderErrorRows.has(index)
                    && inlineError(t('manageShop.deliverySettings.errors.invalidWeightTiers'))}
                  {overlapErrorRows.has(index) && inlineError(
                    t('manageShop.deliverySettings.charges.overlappingTiers'),
                  )}
                  {negativeTierRows.has(index) && inlineError(
                    t('manageShop.deliverySettings.charges.negativeValue'),
                  )}
                </div>
              )}
            </div>
          ))}

          {settings.weight_tiers.length === 0 && (
            <>
              <p className="text-sm text-em-text-secondary">
                {t('manageShop.deliverySettings.noTiers')}
              </p>
              <p className="rounded-lg border border-em-info-700/20 bg-em-info-100 px-4 py-3 text-sm text-em-info-700">
                {t('manageShop.deliverySettings.charges.tiersRevertNote', { defaults: defaultTierText })}
              </p>
            </>
          )}
        </div>

        {renderSaveRow('weight-charges-save')}
      </section>
    </div>
  );
}

export default ChargesTab;
