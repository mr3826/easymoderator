/**
 * Business & FAQ workspace — Tab 3: Business Policies (role A4).
 *
 * Four policy cards (returns / exchange / refunds / warranty) exactly on the
 * A5 contract for GET/PUT /api/shop/business-policies:
 *   stance: unspecified | offered | not_offered | conditional
 *   returns/exchange gain period_days (int 0..365|null)
 *   every kind carries details (≤500, REQUIRED when conditional) + exclusions (≤500|null)
 *   refunds gains process (≤500|null); warranty gains duration (≤120|null),
 *   coverage (≤500|null), coverage_exclusions (≤500|null).
 *
 * Honesty rules this file exists to enforce (contract Y3/Y4/Y6, 02 §3):
 *  - NO defaults are ever written or shown: an absent policy renders
 *    "Not stated yet", which is visually distinct from "We do not offer".
 *  - The PUT body carries ONLY policies the merchant actually edited — never
 *    `{}` placeholders, never untouched kinds, never fields foreign to a kind.
 *    Within an edited kind the payload is the coherent full field set for the
 *    chosen stance: applicable fields with values (trimmed; empty -> null so
 *    the server-side partial merge clears them explicitly), non-applicable
 *    fields of that kind as explicit nulls (hidden stale text must not linger).
 *  - Save success is server-confirmed: the notice appears only after the
 *    awaited PUT resolves and the baseline re-seeds FROM THE RESPONSE.
 *  - Policies are INFORMATIONAL ONLY. They inform the facts the assistant
 *    answers from; they never authorize or block cancellations, refunds,
 *    exchanges or warranty claims — the visible disclosure line states this,
 *    and nothing here links to order processing (zero automation, Y4).
 *
 * Scope notes: business hours stay informational and live on the Profile tab;
 * COD / advance / delivery-promise are Payment/Delivery scope and are NOT
 * policy fields even though the reference mock shows them. Non-owners get a
 * read-only view + the owner note (Y6) — the PUT is requireOwner server-side,
 * so no affordance here can 403.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { motion, MotionConfig } from "motion/react";
import { apiClient } from "@/api";
import { authService } from "@/app/lib/auth";
import { getErrorMessage } from "@shared/lib/http/errors";
import { fadeUp } from "@/lib/motion";
import { EmButton } from "../dashboard/EmButton";
import { PageHeader } from "../dashboard/PageHeader";
import { derivePoliciesSignal, POLICY_TOTAL } from "../policies/derive";

const ANIMATE = import.meta.env.MODE !== "test";

// House constants: each new file keeps its own local copy (03 §1 — duplication
// by design under the one-writer rule; precedent BusinessInfoForm.tsx:7-11).
const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-em-focus-light focus-visible:transition-none";

const INPUT_CLASSES =
  `w-full min-h-11 px-4 py-2 border border-em-border-input rounded-lg bg-em-bg-surface text-sm text-em-text-primary focus:outline-none ${FOCUS_RING}`;

const INPUT_DISABLED_CLASSES = `${INPUT_CLASSES} disabled:bg-em-bg-muted disabled:text-em-text-disabled`;

// bn-numerals rule (ProviderDrawer.tsx:63 / customerDisplay.ts localeFor):
// the ACTIVE locale decides numerals through Intl — never a locale-less format.
const localeFor = (language: string): string => (language.toLowerCase().startsWith("bn") ? "bn-BD" : "en-US");

/* ------------------------------------------------------------------ types */

export type PolicyStance = "unspecified" | "offered" | "not_offered" | "conditional";

export type PolicyKey = "returns" | "exchange" | "refunds" | "warranty";

/** One policy entry as persisted under shop.settings.policies (A5 contract). */
export interface PolicyEntry {
  stance?: PolicyStance | null;
  period_days?: number | null;
  details?: string | null;
  exclusions?: string | null;
  process?: string | null;
  duration?: string | null;
  coverage?: string | null;
  coverage_exclusions?: string | null;
}

export type ShopBusinessPolicies = Partial<Record<PolicyKey, PolicyEntry>>;

/** Body sent to PUT: only edited kinds (no defaults, no `{}` placeholders). */
export type PoliciesPatch = Partial<Record<PolicyKey, PolicyEntry>>;

/**
 * A0 owns src/api/domains/shop.ts + the facade; writers call these names
 * exactly (03 §2): getShopBusinessPolicies() / updateShopBusinessPolicies().
 * Typed locally until A0's wiring + types/ land so this file stays compilable
 * standalone; tests mock the whole "@/api" module either way.
 */
interface PoliciesApiClientSlice {
  getShopBusinessPolicies: () => Promise<unknown>;
  updateShopBusinessPolicies: (payload: PoliciesPatch) => Promise<unknown>;
}
const policiesApi = apiClient as unknown as PoliciesApiClientSlice;

/* ------------------------------------------------------------ field model */

const STANCES: PolicyStance[] = ["unspecified", "offered", "not_offered", "conditional"];
const POLICY_KEYS: PolicyKey[] = ["returns", "exchange", "refunds", "warranty"];

// Card titles as LITERAL keys (translation-coverage scanner requirement —
// dynamic `card.${kind}` templates would be invisible to the gate).
const CARD_TITLE_KEY: Record<PolicyKey, string> = {
  returns: "manageShop.businessFaq.policies.card.returns",
  exchange: "manageShop.businessFaq.policies.card.exchange",
  refunds: "manageShop.businessFaq.policies.card.refunds",
  warranty: "manageShop.businessFaq.policies.card.warranty",
};

type DetailFieldKey =
  | "periodDays"
  | "details"
  | "exclusions"
  | "process"
  | "duration"
  | "coverage"
  | "coverageExclusions";

interface FieldDef {
  key: DetailFieldKey;
  payload: string; // server field name (contract spelling)
  labelKey: string;
  control: "number" | "text" | "textarea";
  maxLength?: number;
  kinds: PolicyKey[];
}

const FIELDS: FieldDef[] = [
  { key: "periodDays", payload: "period_days", labelKey: "manageShop.businessFaq.policies.periodDays", control: "number", kinds: ["returns", "exchange"] },
  { key: "details", payload: "details", labelKey: "manageShop.businessFaq.policies.details", control: "textarea", maxLength: 500, kinds: [...POLICY_KEYS] },
  { key: "exclusions", payload: "exclusions", labelKey: "manageShop.businessFaq.policies.exclusions", control: "textarea", maxLength: 500, kinds: [...POLICY_KEYS] },
  { key: "process", payload: "process", labelKey: "manageShop.businessFaq.policies.process", control: "textarea", maxLength: 500, kinds: ["refunds"] },
  { key: "duration", payload: "duration", labelKey: "manageShop.businessFaq.policies.duration", control: "text", maxLength: 120, kinds: ["warranty"] },
  { key: "coverage", payload: "coverage", labelKey: "manageShop.businessFaq.policies.coverage", control: "textarea", maxLength: 500, kinds: ["warranty"] },
  { key: "coverageExclusions", payload: "coverage_exclusions", labelKey: "manageShop.businessFaq.policies.coverageExclusions", control: "textarea", maxLength: 500, kinds: ["warranty"] },
];

/** Fields that only make sense while the merchant says the policy exists. */
const fieldsShownFor = (kind: PolicyKey): FieldDef[] =>
  FIELDS.filter((field) => field.kinds.includes(kind));

/** stance semantics: fields (and "stated" credit) exist only for these. */
const stanceHasDetails = (stance: PolicyStance): boolean => stance === "offered" || stance === "conditional";

interface PolicyForm {
  stance: PolicyStance;
  periodDays: string;
  details: string;
  exclusions: string;
  process: string;
  duration: string;
  coverage: string;
  coverageExclusions: string;
}

const EMPTY_FORM: PolicyForm = {
  stance: "unspecified",
  periodDays: "",
  details: "",
  exclusions: "",
  process: "",
  duration: "",
  coverage: "",
  coverageExclusions: "",
};

const textOf = (value: unknown): string => (typeof value === "string" ? value : value == null ? "" : String(value));

/** Server entry -> form. Absent entry / absent fields hydrate as UNSET (''). */
const entryToForm = (entry: PolicyEntry | null | undefined): PolicyForm => {
  if (!entry || typeof entry !== "object") return { ...EMPTY_FORM };
  const stance = STANCES.includes((entry.stance as PolicyStance)) ? (entry.stance as PolicyStance) : "unspecified";
  return {
    stance,
    periodDays: entry.period_days == null ? "" : textOf(entry.period_days),
    details: textOf(entry.details),
    exclusions: textOf(entry.exclusions),
    process: textOf(entry.process),
    duration: textOf(entry.duration),
    coverage: textOf(entry.coverage),
    coverageExclusions: textOf(entry.coverage_exclusions),
  };
};

const formsFrom = (map: ShopBusinessPolicies): Record<PolicyKey, PolicyForm> =>
  Object.fromEntries(POLICY_KEYS.map((key) => [key, entryToForm(map[key])])) as Record<PolicyKey, PolicyForm>;

/** Defensive normalize: tolerate a `{ policies }` wrapper or a bare map. */
const normalizePoliciesPayload = (raw: unknown): ShopBusinessPolicies => {
  if (!raw || typeof raw !== "object") return {};
  let source: Record<string, unknown> = raw as Record<string, unknown>;
  const wrapped = source.policies;
  if (
    wrapped && typeof wrapped === "object" &&
    !POLICY_KEYS.some((key) => key in source)
  ) {
    source = wrapped as Record<string, unknown>;
  }
  const out: ShopBusinessPolicies = {};
  for (const key of POLICY_KEYS) {
    const entry = source[key];
    if (entry && typeof entry === "object") out[key] = entry as PolicyEntry;
  }
  return out;
};

/* ------------------------------------------------------------- validation */

type CardErrors = Partial<Record<DetailFieldKey, string>>; // value = message key

/** Inline validation near the field (§12). The server validator stays authoritative. */
const validateCard = (kind: PolicyKey, form: PolicyForm): CardErrors => {
  const errors: CardErrors = {};
  if (stanceHasDetails(form.stance)) {
    if (form.details.trim() === "" && form.stance === "conditional") {
      errors.details = "manageShop.businessFaq.policies.errors.detailsRequired";
    }
    if (kind === "returns" || kind === "exchange") {
      const raw = form.periodDays.trim();
      if (raw !== "") {
        const value = Number(raw);
        if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0 || value > 365) {
          errors.periodDays = "manageShop.businessFaq.policies.errors.periodRange";
        }
      }
    }
  }
  return errors;
};

/* --------------------------------------------------------------- payload */

/**
 * Coherent entry for an EDITED policy only. stance always rides; for
 * offered/conditional every shown field of the kind carries its trimmed
 * value (empty -> null so the server merge clears it explicitly); for
 * not_offered/unspecified every field of the kind clears to null.
 */
const buildEntry = (kind: PolicyKey, form: PolicyForm): PolicyEntry => {
  const entry: PolicyEntry = { stance: form.stance };
  for (const field of fieldsShownFor(kind)) {
    const active = stanceHasDetails(form.stance);
    const raw = (form[field.key] ?? "").trim();
    let value: string | number | null;
    if (!active || raw === "") {
      value = null;
    } else if (field.key === "periodDays") {
      value = Number(raw);
    } else {
      value = raw;
    }
    (entry as Record<string, unknown>)[field.payload] = value;
  }
  return entry;
};

const cardIsDirty = (form: PolicyForm, saved: PolicyForm): boolean =>
  JSON.stringify(form) !== JSON.stringify(saved);

/* ---------------------------------------------------------------- render */

export default function PoliciesTab() {
  const { t, i18n } = useTranslation();
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [serverPolicies, setServerPolicies] = useState<ShopBusinessPolicies>({});
  const [forms, setForms] = useState<Record<PolicyKey, PolicyForm>>(() => formsFrom({}));
  const [isSaving, setIsSaving] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [notice, setNotice] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const isOwner = authService.getCurrentShop()?.role?.toLowerCase() === "owner";
  const shopName = authService.getCurrentShop()?.shop_name || t("manageShop.businessFaq.policies.title");

  const seed = (map: ShopBusinessPolicies) => {
    setServerPolicies(map);
    setForms(formsFrom(map));
  };

  // Stable identity so the mount effect runs exactly once (profile pattern,
  // S11 abort discipline); retry reuses it with a fresh controller.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const load = useCallback(async () => {
    try {
      setIsLoading(true);
      setLoadError(null);
      const raw = await policiesApi.getShopBusinessPolicies();
      if (!abortControllerRef.current?.signal.aborted) {
        seed(normalizePoliciesPayload(raw));
      }
    } catch (error) {
      if (!abortControllerRef.current?.signal.aborted) {
        setLoadError(getErrorMessage(error, t("manageShop.businessFaq.policies.errors.load")));
      }
    } finally {
      if (!abortControllerRef.current?.signal.aborted) {
        setIsLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    abortControllerRef.current = new AbortController();
    load();
    return () => {
      abortControllerRef.current?.abort();
      if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    };
  }, [load]);

  const retry = () => {
    abortControllerRef.current = new AbortController();
    load();
  };

  const savedForms = formsFrom(serverPolicies);
  const anyDirty = POLICY_KEYS.some((key) => cardIsDirty(forms[key], savedForms[key]));

  // Delivery precedent (cheap to keep): warn on tab close while edits are live.
  useEffect(() => {
    if (!anyDirty || !isOwner) return undefined;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [anyDirty, isOwner]);

  const showNotice = (type: "success" | "error", message: string) => {
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    setNotice({ type, message });
    if (type === "success") {
      noticeTimerRef.current = setTimeout(() => setNotice(null), 3000);
    }
  };

  const setField = (kind: PolicyKey, key: DetailFieldKey, value: string) => {
    setForms((prev) => ({ ...prev, [kind]: { ...prev[kind], [key]: value } }));
    setAttempted(false);
  };

  const setStance = (kind: PolicyKey, stance: PolicyStance) => {
    setForms((prev) => ({ ...prev, [kind]: { ...prev[kind], stance } }));
    setAttempted(false);
  };

  const resetToSaved = () => {
    setForms(formsFrom(serverPolicies));
    setAttempted(false);
  };

  const statedCount = POLICY_KEYS.filter((key) => {
    const stance = serverPolicies[key]?.stance;
    return stance === "offered" || stance === "not_offered" || stance === "conditional";
  }).length;

  const cardErrorMaps = POLICY_KEYS.reduce<Record<PolicyKey, CardErrors>>((acc, key) => {
    acc[key] = validateCard(key, forms[key]);
    return acc;
  }, {} as Record<PolicyKey, CardErrors>);
  const hasErrors = POLICY_KEYS.some((key) => Object.keys(cardErrorMaps[key]).length > 0);

  const handleSave = async () => {
    setAttempted(true);
    if (hasErrors) return;
    const payload: PoliciesPatch = {};
    let touched = 0;
    for (const key of POLICY_KEYS) {
      if (cardIsDirty(forms[key], savedForms[key])) {
        payload[key] = buildEntry(key, forms[key]);
        touched += 1;
      }
    }
    if (touched === 0) return;
    try {
      setIsSaving(true);
      setNotice(null);
      // server-confirmed success: notice + reseed ONLY after the awaited PUT.
      const rawSaved = await policiesApi.updateShopBusinessPolicies(payload);
      seed(normalizePoliciesPayload(rawSaved));
      setAttempted(false);
      showNotice("success", t("manageShop.businessFaq.policies.saved"));
    } catch (error) {
      showNotice("error", getErrorMessage(error, t("manageShop.businessFaq.policies.errors.save")));
    } finally {
      setIsSaving(false);
    }
  };

  const numberFormat = new Intl.NumberFormat(localeFor(i18n.language || "en"));
  const formatted = (value: number) => numberFormat.format(value);

  const phase = loadError ? "error" : isLoading ? "loading" : "ready";
  const signal = derivePoliciesSignal({ phase, statedCount }, t);
  const allNotStated = phase === "ready" && statedCount === 0;

  return (
    <MotionConfig reducedMotion="user">
      <div className="space-y-6">
        <motion.div variants={fadeUp} initial={ANIMATE ? "hidden" : false} animate="visible">
          <PageHeader
            title={t("manageShop.businessFaq.policies.title")}
            breadcrumb={[{ label: shopName }]}
            signal={signal}
            signalTestId="policies-signal"
            signalAnnounce={false}
            meta={
              <div className="flex flex-wrap items-center gap-2">
                {phase === "ready" && (
                  <span className="em-tabular whitespace-nowrap rounded-full border border-em-border bg-em-bg-muted px-3 py-1 text-xs font-medium text-em-text-secondary">
                    {t("manageShop.businessFaq.policies.stated")}: {formatted(statedCount)}/{formatted(POLICY_TOTAL)}
                  </span>
                )}
                {anyDirty && isOwner && (
                  <span
                    data-testid="policies-unsaved"
                    className="whitespace-nowrap rounded-full border border-em-sunlight-500/40 bg-em-sunlight-100 px-3 py-1 text-xs font-medium text-em-sunlight-700"
                  >
                    {t("manageShop.businessFaq.policies.unsavedPill")}
                  </span>
                )}
              </div>
            }
          />
        </motion.div>

        {/* Mission §7 / Y4 disclosure — plain language, never color-only. */}
        <p className="rounded-xl border border-em-border bg-em-bg-muted px-4 py-3 text-sm text-em-text-secondary">
          {t("manageShop.businessFaq.policies.informational")}
        </p>

        {allNotStated && (
          <p className="text-sm text-em-text-secondary">
            {t("manageShop.businessFaq.policies.emptyHint")}
          </p>
        )}

        {loadError ? (
          <div
            role="alert"
            className="flex flex-wrap items-center gap-2 rounded-xl border border-em-danger-700/20 bg-em-danger-100 px-4 py-3 text-sm text-em-danger-700"
          >
            <span className="flex-1">{loadError}</span>
            <EmButton variant="secondary" onClick={retry}>
              {t("manageShop.businessFaq.policies.retryLoad")}
            </EmButton>
          </div>
        ) : isLoading ? (
          <div className="space-y-4" aria-label={t("manageShop.businessFaq.policies.loading")}>
            {[0, 1].map((row) => (
              <div key={row} className="animate-pulse space-y-3 rounded-xl border border-em-border bg-em-bg-surface p-6">
                <div className="h-5 w-1/3 rounded bg-em-bg-muted" />
                <div className="h-3 w-2/3 rounded bg-em-bg-muted" />
                <div className="h-9 w-40 rounded bg-em-bg-muted" />
              </div>
            ))}
          </div>
        ) : (
          <div className="space-y-4">
            {POLICY_KEYS.map((kind) => {
              const form = forms[kind];
              const errors = cardErrorMaps[kind];
              const shown = fieldsShownFor(kind);
              return (
                <section
                  key={kind}
                  data-testid={`policy-card-${kind}`}
                  className="rounded-xl border border-em-border bg-em-bg-surface p-6"
                >
                  <h2 className="mb-4 text-base font-semibold text-em-text-primary">
                    {t(CARD_TITLE_KEY[kind])}
                  </h2>

                  <div className="max-w-md">
                    <label
                      htmlFor={`policy-stance-${kind}`}
                      className="mb-2 block text-sm font-medium text-em-text-primary"
                    >
                      {t("manageShop.businessFaq.policies.stance")}
                    </label>
                    <select
                      id={`policy-stance-${kind}`}
                      data-testid={`policy-stance-${kind}`}
                      aria-label={`${t("manageShop.businessFaq.policies.stance")}: ${t(CARD_TITLE_KEY[kind])}`}
                      value={form.stance}
                      onChange={(event) => setStance(kind, event.target.value as PolicyStance)}
                      disabled={!isOwner}
                      className={INPUT_DISABLED_CLASSES}
                    >
                      <option value="unspecified">{t("manageShop.businessFaq.policies.notStated")}</option>
                      <option value="offered">{t("manageShop.businessFaq.policies.offered")}</option>
                      <option value="not_offered">{t("manageShop.businessFaq.policies.notOffered")}</option>
                      <option value="conditional">{t("manageShop.businessFaq.policies.conditional")}</option>
                    </select>
                  </div>

                  {stanceHasDetails(form.stance) && (
                    <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
                      {shown.map((field) => {
                        const fieldId = `policy-${kind}-${field.key}`;
                        const errorKey = attempted ? errors[field.key] : undefined;
                        const helpId = `${fieldId}-help`;
                        const errorId = `${fieldId}-error`;
                        // describedby only ever references rendered elements:
                        // period helper, conditional-details helper, field error.
                        const showsPeriodHelp = field.key === "periodDays";
                        const showsConditionalHelp = field.key === "details" && form.stance === "conditional";
                        const describedBy =
                          [showsPeriodHelp || showsConditionalHelp ? helpId : undefined, errorKey ? errorId : undefined]
                            .filter(Boolean)
                            .join(" ");
                        const value = form[field.key];
                        return (
                          <div key={field.key} className={field.control === "number" ? "md:col-span-1" : "md:col-span-2"}>
                            <div className="mb-2 flex items-center justify-between gap-2">
                              <label htmlFor={fieldId} className="block text-sm font-medium text-em-text-primary">
                                {t(field.labelKey)}
                              </label>
                              {field.maxLength != null && (
                                <span className="em-tabular text-xs text-em-text-secondary">
                                  {value.length}/{field.maxLength}
                                </span>
                              )}
                            </div>
                            {field.control === "textarea" ? (
                              <textarea
                                id={fieldId}
                                rows={3}
                                maxLength={field.maxLength}
                                aria-label={t(field.labelKey)}
                                aria-invalid={errorKey ? true : undefined}
                                aria-describedby={describedBy || undefined}
                                value={value}
                                onChange={(event) => setField(kind, field.key, event.target.value)}
                                disabled={!isOwner}
                                placeholder={isOwner ? undefined : t("manageShop.businessFaq.policies.notSet")}
                                className={INPUT_DISABLED_CLASSES}
                              />
                            ) : (
                              <input
                                id={fieldId}
                                type={field.control === "number" ? "number" : "text"}
                                inputMode={field.control === "number" ? "numeric" : undefined}
                                min={field.control === "number" ? 0 : undefined}
                                max={field.control === "number" ? 365 : undefined}
                                step={field.control === "number" ? 1 : undefined}
                                maxLength={field.maxLength}
                                aria-label={t(field.labelKey)}
                                aria-invalid={errorKey ? true : undefined}
                                aria-describedby={describedBy || undefined}
                                value={value}
                                onChange={(event) => setField(kind, field.key, event.target.value)}
                                disabled={!isOwner}
                                placeholder={isOwner ? undefined : t("manageShop.businessFaq.policies.notSet")}
                                className={INPUT_DISABLED_CLASSES}
                              />
                            )}
                            {showsPeriodHelp && (
                              <p id={helpId} className="mt-1 text-xs text-em-text-secondary">
                                {t("manageShop.businessFaq.policies.periodDaysHelp")}
                              </p>
                            )}
                            {showsConditionalHelp && (
                              <p id={helpId} className="mt-1 text-xs text-em-text-secondary">
                                {t("manageShop.businessFaq.policies.detailsConditionalHelp")}
                              </p>
                            )}
                            {errorKey && (
                              <p id={errorId} className="mt-1 text-xs font-medium text-em-danger-700">
                                {t(errorKey)}
                              </p>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </section>
              );
            })}

            <motion.div variants={fadeUp} initial={ANIMATE ? "hidden" : false} animate="visible">
              <section className="rounded-xl border border-em-border bg-em-bg-surface p-6">
                {notice && (
                  <div
                    role={notice.type === "error" ? "alert" : "status"}
                    className={`mb-4 rounded-lg border px-4 py-3 text-sm ${
                      notice.type === "success"
                        ? "border-em-success-700/20 bg-em-success-100 text-em-success-700"
                        : "border-em-danger-700/20 bg-em-danger-100 text-em-danger-700"
                    }`}
                  >
                    {notice.message}
                  </div>
                )}

                {isOwner ? (
                  <>
                    <div className="flex flex-wrap items-center gap-3">
                      <EmButton
                        variant="primary"
                        data-testid="policies-save"
                        onClick={handleSave}
                        disabled={!anyDirty || isSaving || (attempted && hasErrors)}
                        loading={isSaving}
                      >
                        {isSaving
                          ? t("manageShop.businessFaq.policies.saving")
                          : t("manageShop.businessFaq.policies.save")}
                      </EmButton>
                      {anyDirty && (
                        <EmButton variant="secondary" onClick={resetToSaved} disabled={isSaving}>
                          {t("manageShop.businessFaq.policies.reset")}
                        </EmButton>
                      )}
                    </div>
                    {attempted && hasErrors && (
                      <p className="mt-3 text-sm text-em-danger-700">
                        {t("manageShop.businessFaq.policies.errors.fixBeforeSave")}
                      </p>
                    )}
                    <p className="mt-3 text-xs text-em-text-secondary">
                      {t("manageShop.businessFaq.policies.help.aiProjection")}
                    </p>
                  </>
                ) : (
                  <>
                    <p role="note" className="text-sm text-em-text-secondary">
                      {t("manageShop.businessFaq.policies.ownerOnly")}
                    </p>
                    <p className="mt-3 text-xs text-em-text-secondary">
                      {t("manageShop.businessFaq.policies.help.aiProjection")}
                    </p>
                  </>
                )}

                {/* Contract exposes no persisted timestamp for policies, so the
                    honest value is the em-dash — never a fabricated "just now".
                    If the writer later returns one, it renders here. */}
                <p className="em-tabular mt-3 text-xs text-em-text-secondary">
                  {t("manageShop.businessFaq.policies.lastSaved")}: {t("manageShop.businessFaq.policies.notSet")}
                </p>
              </section>
            </motion.div>
          </div>
        )}
      </div>
    </MotionConfig>
  );
}
