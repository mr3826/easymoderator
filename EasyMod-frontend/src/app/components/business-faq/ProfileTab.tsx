/**
 * Tab 1 — "Business Profile" (Business & FAQ Settings redesign, role A2).
 *
 * Scope (binding, from 00_A0_DATA_CONTRACT.md):
 * - Preserve every existing field EXACTLY: shopName stays THE authoritative
 *   identity (single-shop-name sync contract from shop.service is untouched —
 *   this tab never writes it anywhere except businessInfo.shopName), phone (via
 *   BDPhoneInput), address, openingHours (free text), additionalInfo (3000
 *   counter, bn numerals), facebook + website socials.
 * - ADD per contract the optional businessInfo fields nameEn, tagline, email,
 *   city, and enable the remaining social links instagram / whatsapp / tiktok /
 *   youtube (SocialLinks already supports them; only the writer was gated).
 * - nameEn is DISPLAY metadata only and never replaces identity display logic;
 *   email is customer-facing only, with zero auth coupling (its own note says
 *   so — it does not touch login).
 * - Dirty-gated save through `updateShopBusinessInfo` with the EXTENDED payload.
 *   deliveryAreas / paymentMethods are intentionally excluded (they live on the
 *   Delivery / Payment Settings pages; the backend preserves stored values when
 *   this payload omits them). The dead PUT /api/knowledge/business-info is NEVER
 *   used (trap).
 * - Success notice is server-confirmed only: the PUT must resolve before we
 *   re-baseline the saved snapshot, show "saved" and refreshShops (so the page
 *   header / nav shop name reflects the new identity). Errors keep every input
 *   value (§12 preserve on failure) and never claim a partial success.
 * - Motion: panels fade in (fadeUp, 300ms — §19 200–300ms panel band) via
 *   MotionConfig reducedMotion="user" and the ANIMATE gate (MODE !== "test").
 *   No pulse / stagger-spam / bounce. Everything stays inside `.em-business`
 *   scope and uses only existing `--em-*` tokens (no new hex).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { Bot, ChevronRight } from "lucide-react";
import { motion, MotionConfig } from "motion/react";
import { apiClient } from "@/api";
import { authService } from "@/app/lib/auth";
import { getErrorMessage } from "@shared/lib/http/errors";
import { fadeUp } from "@/lib/motion";
import type { BusinessInfo, SocialLinks } from "@/app/lib/knowledgeTypes";
import { BDPhoneInput, BD_PHONE_REGEX } from "@shared/components/BDPhoneInput";
import { EmButton } from "@/app/components/dashboard/EmButton";
import { ResultBanner } from "@/app/components/dashboard/ResultBanner";
import { SignalBadge } from "@/app/components/dashboard/SignalBadge";
import { deriveBusinessSignal } from "@/app/components/business/derive";

const ANIMATE = import.meta.env.MODE !== "test";

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-em-focus-light focus-visible:transition-none";

const INPUT_CLASSES =
  `w-full min-h-11 px-4 py-2 border border-em-border-input rounded-lg bg-em-bg-surface text-sm text-em-text-primary focus:outline-none ${FOCUS_RING}`;

// Contract bounds for the four added fields + the preserved freeform note.
const MAX_NAME_EN = 120;
const MAX_TAGLINE = 160;
const MAX_EMAIL = 254;
const MAX_CITY = 60;
const MAX_ADDITIONAL = 3000;

// RFC-lite email shape. Matches the backend "email (RFC-lite validator)"
// contract for businessInfo.email — enough to stop obvious typos at the client
// so the server can never be asked to reject what the merchant can already see.
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The profile payload this tab reads and writes. `BusinessInfo` (A0-owned type)
 * gains nameEn / tagline / email / city when the contract lands; declaring the
 * optional additions locally keeps this file type-correct before and after that
 * merge and never edits the shared type.
 */
type ProfileBusinessInfo = BusinessInfo & {
  nameEn?: string;
  tagline?: string;
  email?: string;
  city?: string;
};

type FormShape = {
  shopName: string;
  nameEn: string;
  tagline: string;
  phone: string;
  email: string;
  city: string;
  address: string;
  openingHours: string;
  additionalInfo: string;
  socialLinks: Required<Pick<SocialLinks, keyof SocialLinks>>;
};

type SocialKey = keyof SocialLinks;

const SOCIAL_KEYS: SocialKey[] = [
  "facebook",
  "website",
  "instagram",
  "whatsapp",
  "tiktok",
  "youtube",
];

const EMPTY_SOCIAL: FormShape["socialLinks"] = {
  facebook: "",
  website: "",
  instagram: "",
  whatsapp: "",
  tiktok: "",
  youtube: "",
};

const normalize = (value?: Partial<ProfileBusinessInfo> | null): FormShape => {
  const social =
    value?.socialLinks && typeof value.socialLinks === "object" ? value.socialLinks : {};
  return {
    shopName: value?.shopName ?? "",
    nameEn: value?.nameEn ?? "",
    tagline: value?.tagline ?? "",
    phone: value?.phone ?? "",
    email: value?.email ?? "",
    city: value?.city ?? "",
    address: value?.address ?? "",
    openingHours: value?.openingHours ?? "",
    additionalInfo: value?.additionalInfo ?? "",
    socialLinks: SOCIAL_KEYS.reduce((acc, key) => {
      acc[key] = (social[key] ?? "").toString();
      return acc;
    }, { ...EMPTY_SOCIAL } as FormShape["socialLinks"]),
  };
};

// The shared `localeFor` mapping from the delivery redesign (customerDisplay.ts):
// bn → bn-BD, everything else → en-US. Used so counters render Bengali numerals.
const localeFor = (language: string): string =>
  language.toLowerCase().startsWith("bn") ? "bn-BD" : "en-US";

export interface ProfileTabProps {
  /** Seed from a shell that already loaded business info; omitted → self-load. */
  initialData?: Partial<ProfileBusinessInfo> | null;
  /** Shell-driven loading flag; combined with internal load state. */
  loading?: boolean;
  /** Lets the shell react to a server-confirmed save (e.g. re-derive its header). */
  onPersisted?: (data: ProfileBusinessInfo) => void;
}

export function ProfileTab({ initialData, loading = false, onPersisted }: ProfileTabProps) {
  const { t, i18n } = useTranslation();

  const [form, setForm] = useState<FormShape>(() => normalize(initialData));
  const [saved, setSaved] = useState<FormShape>(() => normalize(initialData));
  const [phase, setPhase] = useState<"loading" | "error" | "ready">(
    initialData ? "ready" : loading ? "loading" : "loading",
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [notice, setNotice] = useState<{ status: "success" | "error"; message: string } | null>(null);
  const [touched, setTouched] = useState(false);

  const abortRef = useRef<AbortController | null>(null);

  const numberFormat = useMemo(
    () => new Intl.NumberFormat(localeFor(i18n.language ?? "en")),
    [i18n.language],
  );

  const applyLoaded = useCallback((business?: Partial<ProfileBusinessInfo> | null) => {
    const next = normalize(business);
    setForm(next);
    setSaved(next);
  }, []);

  // Stable identity so the mount effect runs exactly once; retry reuses it
  // (mirrors the proven BusinessInfoSettings load pattern).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const load = useCallback(async () => {
    try {
      setPhase("loading");
      setLoadError(null);
      const info = await apiClient.getShopBusinessInfo();
      if (abortRef.current?.signal.aborted) return;
      applyLoaded(info?.businessInfo);
      setPhase("ready");
    } catch (error) {
      if (abortRef.current?.signal.aborted) return;
      setLoadError(getErrorMessage(error, t("manageShop.businessInfo.errorLoad")));
      setPhase("error");
    }
  }, [applyLoaded]);

  // Decide the data mode ONCE at mount so the two authorities never both fetch.
  // Shell-driven when the caller passes initialData and/or loading; otherwise
  // this tab owns its single GET (§"one request owner", no double-fetch).
  const shellMode = useRef(initialData != null || loading).current;

  useEffect(() => {
    if (shellMode) return undefined;
    // Self-contained mode: this tab owns its single GET.
    abortRef.current = new AbortController();
    void load();
    return () => abortRef.current?.abort();
  }, [shellMode, load]);

  useEffect(() => {
    if (!shellMode) return;
    // Shell-driven mode: reflect the caller's loading/data without fetching.
    if (loading) {
      setPhase("loading");
      return;
    }
    if (initialData) {
      applyLoaded(initialData);
      setPhase("ready");
    }
  }, [shellMode, loading, initialData, applyLoaded]);

  const patch = (partial: Partial<FormShape>) => {
    setForm((prev) => ({ ...prev, ...partial }));
    setTouched(true);
    if (notice?.status === "success") setNotice(null);
  };

  const patchSocial = (key: SocialKey, value: string) => {
    setForm((prev) => ({ ...prev, socialLinks: { ...prev.socialLinks, [key]: value } }));
    setTouched(true);
    if (notice?.status === "success") setNotice(null);
  };

  const isDirty = useMemo(
    () => JSON.stringify(form) !== JSON.stringify(saved),
    [form, saved],
  );

  // ---- Inline validation (§17 inline first). Optional fields: empty is valid. --
  const fieldErrors = useMemo(() => {
    const errors: Partial<Record<keyof FormShape | SocialKey, string>> = {};
    if (form.email.trim() && !EMAIL_REGEX.test(form.email.trim())) {
      errors.email = t("manageShop.businessInfo.errors.emailInvalid");
    }
    if (form.nameEn.length > MAX_NAME_EN) {
      errors.nameEn = t("manageShop.businessInfo.errors.tooLong", { max: numberFormat.format(MAX_NAME_EN) });
    }
    if (form.tagline.length > MAX_TAGLINE) {
      errors.tagline = t("manageShop.businessInfo.errors.tooLong", { max: numberFormat.format(MAX_TAGLINE) });
    }
    if (form.email.length > MAX_EMAIL) {
      errors.email = t("manageShop.businessInfo.errors.tooLong", { max: numberFormat.format(MAX_EMAIL) });
    }
    if (form.city.length > MAX_CITY) {
      errors.city = t("manageShop.businessInfo.errors.tooLong", { max: numberFormat.format(MAX_CITY) });
    }
    if (form.additionalInfo.length > MAX_ADDITIONAL) {
      errors.additionalInfo = t("manageShop.businessInfo.errors.tooLong", { max: numberFormat.format(MAX_ADDITIONAL) });
    }
    return errors;
  }, [form, t, numberFormat]);

  const phoneInvalid = Boolean(form.phone) && !BD_PHONE_REGEX.test(form.phone);
  const hasValidationErrors = Object.keys(fieldErrors).length > 0 || phoneInvalid;

  const buildPayload = (): ProfileBusinessInfo => {
    const socialLinks = SOCIAL_KEYS.reduce((acc, key) => {
      const trimmed = form.socialLinks[key].trim();
      if (trimmed) acc[key] = trimmed;
      return acc;
    }, {} as SocialLinks);

    // deliveryAreas / paymentMethods / location deliberately omitted.
    return {
      shopName: form.shopName.trim(),
      nameEn: form.nameEn.trim() || undefined,
      tagline: form.tagline.trim() || undefined,
      phone: form.phone.trim(),
      email: form.email.trim() || undefined,
      city: form.city.trim() || undefined,
      address: form.address.trim(),
      openingHours: form.openingHours.trim(),
      additionalInfo: form.additionalInfo,
      socialLinks,
    };
  };

  const handleSave = async () => {
    if (!isDirty || hasValidationErrors || isSaving) return;
    setIsSaving(true);
    setNotice(null);
    try {
      const payload = buildPayload();
      // Server-confirmed only: we re-baseline AFTER the PUT resolves.
      const updated = await apiClient.updateShopBusinessInfo(payload);
      const persisted: ProfileBusinessInfo =
        (updated && (updated.businessInfo || updated)) || payload;
      const next = normalize(persisted);
      setForm(next);
      setSaved(next);
      setTouched(false);
      try {
        // Keep nav / page-header shop name honest. A refreshShops hiccup must
        // not turn a committed save into a false failure (§4), so it is
        // contained separately from the save result.
        await authService.refreshShops();
      } catch {
        /* save succeeded; identity refresh is best-effort */
      }
      setNotice({ status: "success", message: t("manageShop.businessInfo.successMsg") });
      onPersisted?.(persisted);
    } catch (error) {
      setNotice({
        status: "error",
        message: getErrorMessage(error, t("manageShop.businessInfo.errorUpdate")),
      });
    } finally {
      setIsSaving(false);
    }
  };

  const retry = () => {
    abortRef.current = new AbortController();
    void load();
  };

  const signal = deriveBusinessSignal(
    { phase: phase === "error" ? "error" : phase === "loading" ? "loading" : "ready", hasShopName: Boolean(form.shopName.trim()) },
    t,
  );

  const errNode = (message?: string) =>
    message ? (
      <p className="mt-1 text-xs font-medium text-em-danger-700" role="alert">
        {message}
      </p>
    ) : null;

  const infoLength = form.additionalInfo.length;

  return (
    <MotionConfig reducedMotion="user">
      <div className="em-business space-y-6" data-testid="profile-tab">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-em-text-primary">
            {t("manageShop.businessInfo.sectionTitle")}
          </h2>
          <SignalBadge
            signal={signal}
            size="sm"
            announce={false}
            data-testid="profile-signal"
          />
        </div>

        {phase === "loading" ? (
          <div className="space-y-4" aria-label={t("manageShop.businessInfo.loading")} data-testid="profile-loading">
            {[0, 1].map((row) => (
              <div key={row} className="animate-pulse space-y-3 rounded-xl border border-em-border bg-em-bg-surface p-6">
                <div className="h-5 w-1/3 rounded bg-em-bg-muted" />
                <div className="h-3 w-2/3 rounded bg-em-bg-muted" />
                <div className="h-9 w-40 rounded bg-em-bg-muted" />
              </div>
            ))}
          </div>
        ) : phase === "error" ? (
          <div role="alert" className="flex flex-wrap items-center gap-2 rounded-xl border border-em-danger-700/20 bg-em-danger-100 px-4 py-3 text-sm text-em-danger-700">
            <span className="flex-1">{loadError}</span>
            <EmButton variant="secondary" onClick={retry}>
              {t("manageShop.businessInfo.retryLoad")}
            </EmButton>
          </div>
        ) : (
          <motion.div variants={fadeUp} initial={ANIMATE ? "hidden" : false} animate="visible">
            <div className="space-y-6">
              {notice && (
                <div data-testid="profile-notice">
                  <ResultBanner
                    status={notice.status}
                    title={
                      notice.status === "success"
                        ? t("manageShop.businessInfo.savedAll")
                        : t("manageShop.businessInfo.errorUpdate")
                    }
                    description={notice.message}
                  />
                </div>
              )}

              <section className="rounded-xl border border-em-border bg-em-bg-surface p-6" aria-labelledby="profile-identity-heading">
                <h3 id="profile-identity-heading" className="mb-4 text-base font-semibold text-em-text-primary">
                  {t("manageShop.businessInfo.identityTitle")}
                </h3>
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <div>
                    <label htmlFor="bi-shopName" className="mb-1 block text-sm font-medium text-em-text-primary">
                      {t("manageShop.businessInfo.shopName")}
                    </label>
                    <input
                      id="bi-shopName"
                      type="text"
                      aria-label={t("manageShop.businessInfo.shopName")}
                      value={form.shopName}
                      onChange={(e) => patch({ shopName: e.target.value })}
                      className={INPUT_CLASSES}
                    />
                    <p className="mt-1 text-xs text-em-text-secondary">
                      {t("manageShop.businessInfo.shopNameHelp")}
                    </p>
                  </div>

                  <div>
                    <label htmlFor="bi-nameEn" className="mb-1 block text-sm font-medium text-em-text-primary">
                      {t("manageShop.businessInfo.nameEn")}
                    </label>
                    <input
                      id="bi-nameEn"
                      type="text"
                      maxLength={MAX_NAME_EN}
                      aria-label={t("manageShop.businessInfo.nameEn")}
                      aria-invalid={Boolean(fieldErrors.nameEn) || undefined}
                      value={form.nameEn}
                      onChange={(e) => patch({ nameEn: e.target.value })}
                      className={INPUT_CLASSES}
                    />
                    <p className="mt-1 text-xs text-em-text-secondary">
                      {t("manageShop.businessInfo.nameEnHelp")}
                    </p>
                    {errNode(fieldErrors.nameEn)}
                  </div>

                  <div className="md:col-span-2">
                    <label htmlFor="bi-tagline" className="mb-1 block text-sm font-medium text-em-text-primary">
                      {t("manageShop.businessInfo.tagline")}
                    </label>
                    <input
                      id="bi-tagline"
                      type="text"
                      maxLength={MAX_TAGLINE}
                      aria-label={t("manageShop.businessInfo.tagline")}
                      aria-invalid={Boolean(fieldErrors.tagline) || undefined}
                      value={form.tagline}
                      onChange={(e) => patch({ tagline: e.target.value })}
                      className={INPUT_CLASSES}
                    />
                    <p className="mt-1 text-xs text-em-text-secondary">
                      {t("manageShop.businessInfo.taglineHelp")}
                    </p>
                    {errNode(fieldErrors.tagline)}
                  </div>

                  <BDPhoneInput
                    id="bi-phone"
                    label={t("manageShop.businessInfo.phone")}
                    value={form.phone}
                    onChange={(raw) => patch({ phone: raw })}
                    error={phoneInvalid ? t("manageShop.businessInfo.errors.phoneInvalid") : undefined}
                  />

                  <div>
                    <label htmlFor="bi-city" className="mb-1 block text-sm font-medium text-em-text-primary">
                      {t("manageShop.businessInfo.city")}
                    </label>
                    <input
                      id="bi-city"
                      type="text"
                      maxLength={MAX_CITY}
                      aria-label={t("manageShop.businessInfo.city")}
                      aria-invalid={Boolean(fieldErrors.city) || undefined}
                      value={form.city}
                      onChange={(e) => patch({ city: e.target.value })}
                      className={INPUT_CLASSES}
                    />
                    {errNode(fieldErrors.city)}
                  </div>

                  <div>
                    <label htmlFor="bi-email" className="mb-1 block text-sm font-medium text-em-text-primary">
                      {t("manageShop.businessInfo.email")}
                    </label>
                    <input
                      id="bi-email"
                      type="email"
                      maxLength={MAX_EMAIL}
                      autoComplete="email"
                      aria-label={t("manageShop.businessInfo.email")}
                      aria-invalid={Boolean(fieldErrors.email) || undefined}
                      aria-describedby={fieldErrors.email ? "bi-email-help bi-email-error" : "bi-email-help"}
                      value={form.email}
                      onChange={(e) => patch({ email: e.target.value })}
                      className={INPUT_CLASSES}
                    />
                    <p id="bi-email-help" className="mt-1 text-xs text-em-text-secondary">
                      {t("manageShop.businessInfo.emailHelp")}
                    </p>
                    {fieldErrors.email && (
                      <p id="bi-email-error" className="mt-1 text-xs font-medium text-em-danger-700" role="alert">
                        {fieldErrors.email}
                      </p>
                    )}
                  </div>

                  <div className="md:col-span-2">
                    <label htmlFor="bi-address" className="mb-1 block text-sm font-medium text-em-text-primary">
                      {t("manageShop.businessInfo.address")}
                    </label>
                    <input
                      id="bi-address"
                      type="text"
                      aria-label={t("manageShop.businessInfo.address")}
                      value={form.address}
                      onChange={(e) => patch({ address: e.target.value })}
                      className={INPUT_CLASSES}
                    />
                  </div>

                  <div className="md:col-span-2">
                    <label htmlFor="bi-openingHours" className="mb-1 block text-sm font-medium text-em-text-primary">
                      {t("manageShop.businessInfo.openingHours")}
                    </label>
                    <input
                      id="bi-openingHours"
                      type="text"
                      aria-label={t("manageShop.businessInfo.openingHours")}
                      placeholder={t("manageShop.businessInfo.openingHoursPlaceholder")}
                      value={form.openingHours}
                      onChange={(e) => patch({ openingHours: e.target.value })}
                      className={INPUT_CLASSES}
                    />
                  </div>
                </div>
              </section>

              <section className="rounded-xl border border-em-border bg-em-bg-surface p-6" aria-labelledby="profile-additional-heading">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <label htmlFor="bi-additionalInfo" className="block text-sm font-medium text-em-text-primary">
                    {t("manageShop.businessInfo.additionalInfo")}
                  </label>
                  <span className="em-tabular text-xs text-em-text-secondary">
                    {numberFormat.format(infoLength)}/{numberFormat.format(MAX_ADDITIONAL)}
                  </span>
                </div>
                <textarea
                  id="bi-additionalInfo"
                  rows={4}
                  maxLength={MAX_ADDITIONAL}
                  aria-label={t("manageShop.businessInfo.additionalInfo")}
                  aria-describedby={fieldErrors.additionalInfo ? "bi-additionalInfo-help bi-additionalInfo-error" : "bi-additionalInfo-help"}
                  value={form.additionalInfo}
                  onChange={(e) => patch({ additionalInfo: e.target.value })}
                  placeholder={t("manageShop.businessInfo.additionalInfoPlaceholder")}
                  className={`${INPUT_CLASSES} min-h-[88px] resize-y`}
                />
                <p id="bi-additionalInfo-help" className="mt-1 text-xs text-em-text-secondary">
                  {t("manageShop.businessInfo.additionalInfoHelp")}
                </p>
                {fieldErrors.additionalInfo && (
                  <p id="bi-additionalInfo-error" className="mt-1 text-xs font-medium text-em-danger-700" role="alert">
                    {fieldErrors.additionalInfo}
                  </p>
                )}
              </section>

              <section
                role="group"
                aria-labelledby="profile-social-heading"
                className="rounded-xl border border-em-border bg-em-bg-surface p-6"
              >
                <h3 id="profile-social-heading" className="mb-1 text-base font-semibold text-em-text-primary">
                  {t("manageShop.businessInfo.social.title")}
                </h3>
                <p className="mb-4 text-xs text-em-text-secondary">
                  {t("manageShop.businessInfo.social.help")}
                </p>
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  {SOCIAL_KEYS.map((key) => {
                    const isWhatsapp = key === "whatsapp";
                    return (
                      <div key={key}>
                        <label htmlFor={`bi-social-${key}`} className="mb-1 block text-sm font-medium text-em-text-primary">
                          {t(`manageShop.businessInfo.social.${key}Label`)}
                        </label>
                        <input
                          id={`bi-social-${key}`}
                          type={isWhatsapp ? "text" : key === "website" ? "url" : "text"}
                          aria-label={t(`manageShop.businessInfo.social.${key}Label`)}
                          aria-describedby={isWhatsapp ? `bi-social-${key}-hint` : undefined}
                          value={form.socialLinks[key]}
                          onChange={(e) => patchSocial(key, e.target.value)}
                          placeholder={t(`manageShop.businessInfo.social.${key}Placeholder`)}
                          className={INPUT_CLASSES}
                        />
                        {isWhatsapp && (
                          <p id={`bi-social-${key}-hint`} className="mt-1 text-xs text-em-text-secondary">
                            {t("manageShop.businessInfo.social.whatsappHint")}
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>

              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-em-border pt-4">
                <span className="text-xs text-em-text-secondary">
                  {isDirty
                    ? t("manageShop.businessInfo.unsavedChanges")
                    : touched
                      ? t("manageShop.businessInfo.savedAll")
                      : ""}
                </span>
                <EmButton
                  variant="primary"
                  onClick={handleSave}
                  disabled={!isDirty || hasValidationErrors || isSaving}
                  loading={isSaving}
                  title={
                    hasValidationErrors
                      ? t("manageShop.businessInfo.fixBeforeSave")
                      : !isDirty
                        ? t("manageShop.businessInfo.savedAll")
                        : undefined
                  }
                  data-testid="profile-save"
                >
                  {isSaving ? t("manageShop.businessInfo.saving") : t("manageShop.businessInfo.saveChanges")}
                </EmButton>
              </div>

              <Link
                to="/manage-shop/automation"
                data-testid="business-info-automation-link"
                className="flex items-center gap-4 rounded-xl border border-em-border bg-em-bg-surface p-4 transition-colors hover:border-em-violet-300"
              >
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-em-violet-50 text-em-violet-700">
                  <Bot className="h-5 w-5" aria-hidden="true" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-em-text-primary">
                    {t("manageShop.businessInfo.automationLink.title")}
                  </div>
                  <div className="mt-0.5 text-xs text-em-text-secondary">
                    {t("manageShop.businessInfo.automationLink.desc")}
                  </div>
                </div>
                <ChevronRight className="h-4 w-4 shrink-0 text-em-text-secondary" aria-hidden="true" />
              </Link>
            </div>
          </motion.div>
        )}
      </div>
    </MotionConfig>
  );
}

export default ProfileTab;
