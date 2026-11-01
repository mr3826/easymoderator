import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getCurrentPublicSubscriptionCatalog, hasRequiredPublicPlans, type PublicSubscriptionCatalog } from "@/api/domains/publicSubscription";
import { getPublicAddonCatalog, type PublicAddonDefinition } from "@/api/domains/publicAddons";
import { publicApiPost } from "@/shared/lib/http/public-client";
import { buildAppUrlWithLocale, isBkashEnabled } from "@/app/lib/config";
import { GROWTH_UPGRADE_INTENT } from "@/app/lib/signupIntent";
import type { SubscriptionPlanDefinition } from "@/app/lib/subscriptionPlans";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { PublicFunnelFooter, PublicFunnelHeader, PublicFunnelSkipLink } from "./PublicFunnelChrome";
import Seo from "./Seo";
import "./public-funnel.css";

interface PartnerFormData {
  businessName: string;
  phone: string;
  pageLink: string;
}

function formatNumber(value: number, locale: string) {
  return value.toLocaleString(locale === "bn" ? "bn-BD" : "en-US");
}

function normalizeBangladeshMobile(value: string): string | null {
  let digits = value.replace(/\D/g, "");
  if (digits.startsWith("00880")) digits = digits.slice(5);
  else if (digits.startsWith("880")) digits = digits.slice(3);
  if (digits.length === 10 && digits.startsWith("1")) digits = `0${digits}`;
  return /^01[3-9]\d{8}$/.test(digits) ? digits : null;
}

function PartnerApplicationDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [form, setForm] = useState<PartnerFormData>({ businessName: "", phone: "", pageLink: "" });
  const [errors, setErrors] = useState<Partial<PartnerFormData>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [submitError, setSubmitError] = useState("");

  const update = (field: keyof PartnerFormData, value: string) => {
    setForm((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextErrors: Partial<PartnerFormData> = {};
    if (!form.businessName.trim()) nextErrors.businessName = t("publicFunnel.pricing.fieldRequired");
    const normalizedPhone = normalizeBangladeshMobile(form.phone);
    if (!form.phone.trim()) nextErrors.phone = t("publicFunnel.pricing.fieldRequired");
    else if (!normalizedPhone) nextErrors.phone = t("publicFunnel.pricing.phoneInvalid");
    if (!form.pageLink.trim()) nextErrors.pageLink = t("publicFunnel.pricing.fieldRequired");
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      return;
    }

    setSubmitting(true);
    setSubmitError("");
    try {
      await publicApiPost("/api/partner/apply", { ...form, phone: normalizedPhone });
      setSubmitted(true);
    } catch {
      setSubmitError(t("publicFunnel.pricing.applicationError"));
    } finally {
      setSubmitting(false);
    }
  };

  const field = (name: keyof PartnerFormData, type: "text" | "tel" | "url", labelKey: string, placeholder?: string) => {
    const id = `partner-${name}`;
    const errorId = `${id}-error`;
    return (
      <div>
        <label htmlFor={id} className="mb-1 block text-sm font-semibold text-[#17223B]">{t(labelKey)} <span aria-hidden="true">*</span></label>
        <input
          id={id}
          name={name}
          type={type}
          value={form[name]}
          onChange={(event) => update(name, event.target.value)}
          placeholder={placeholder}
          required
          disabled={submitting}
          aria-invalid={errors[name] ? true : undefined}
          aria-describedby={name === "phone" ? `${id}-hint${errors[name] ? ` ${errorId}` : ""}` : errors[name] ? errorId : undefined}
          className="min-h-11 w-full rounded-xl border border-[#17223B]/20 bg-white px-3 py-2.5 text-sm text-[#17223B] outline-none focus:border-[#7460D9]"
        />
        {name === "phone" && <p id={`${id}-hint`} className="mt-1 text-xs leading-5 text-[#17223B]/65">{t("publicFunnel.pricing.phoneFormatNote")}</p>}
        {errors[name] && <p id={errorId} role="alert" className="mt-1 text-xs text-red-700">{errors[name]}</p>}
      </div>
    );
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto border-[#17223B]/10 bg-[#F8F9FC] sm:rounded-3xl">
        <DialogHeader className="pr-8 text-left">
          <DialogTitle className="text-xl font-bold text-[#17223B]">
            {submitted ? t("publicFunnel.pricing.partnershipSuccessTitle", { defaultValue: "Partnership request received" }) : t("publicFunnel.pricing.partnershipApplicationTitle", { defaultValue: "Partnership application" })}
          </DialogTitle>
          <DialogDescription className="text-sm leading-6 text-[#17223B]/70">
            {submitted ? t("publicFunnel.pricing.partnershipSuccessBody", { defaultValue: "Your request was recorded for review. Delivered-order billing and eligibility will be confirmed before activation." }) : t("publicFunnel.pricing.partnershipApplicationDescription", { defaultValue: "Share your business details so the team can review delivered-order eligibility." })}
          </DialogDescription>
        </DialogHeader>

        {submitted ? (
            <Button type="button" onClick={onClose} className="funnel-button funnel-button-primary justify-center px-5 py-3">
              {t("publicFunnel.pricing.applicationClose", { defaultValue: "Close" })}
          </Button>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            {field("businessName", "text", "publicFunnel.pricing.businessName")}
            {field("phone", "tel", "publicFunnel.pricing.phone", "+880 1XXX-XXXXXX")}
            {field("pageLink", "url", "publicFunnel.pricing.facebookPage", "https://facebook.com/yourpage")}
            {submitError && <p role="alert" className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">{submitError}</p>}
            <Button type="submit" disabled={submitting} className="funnel-button funnel-button-primary w-full justify-center px-5 py-3">
              {submitting ? t("publicFunnel.pricing.applicationSending", { defaultValue: "Sending…" }) : t("publicFunnel.pricing.applicationSubmit", { defaultValue: "Send for review" })}
            </Button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function PlanCard({
  plan,
  locale,
  onPartnerReview,
}: {
  plan: SubscriptionPlanDefinition;
  locale: string;
  onPartnerReview: () => void;
}) {
  const { t } = useTranslation();
  const isPartner = plan.code === "PARTNER";
  const isGrowth = plan.code === "GROWTH";
  const planName = plan.publicName || plan.name;
  const monthlyNumber = formatNumber(plan.monthlyPrice, locale);
  const thresholdTier = isPartner ? plan.partnerOrderTiers?.find((tier) => tier.minOrders === 300) : undefined;
  const signupUrl = new URL(buildAppUrlWithLocale("/signup", locale));
  if (isGrowth) signupUrl.searchParams.set("intent", GROWTH_UPGRADE_INTENT);
  const signupHref = signupUrl.toString();

  return (
    <article aria-labelledby={`plan-${plan.code}`} className={`flex h-full flex-col rounded-3xl border p-6 shadow-sm sm:p-7 ${isGrowth ? "border-[#7460D9]/45 bg-[#F3F0FF]" : "border-[#17223B]/10 bg-white"}`}>
      <div>
        <h2 id={`plan-${plan.code}`} className="text-xl font-extrabold text-[#17223B]">{planName}</h2>
        <p className="mt-3 flex flex-wrap items-baseline gap-x-2 text-[#17223B]">
          {isPartner ? (
            <span className="text-2xl font-extrabold">{t("publicFunnel.pricing.partnerRateTitle")}</span>
          ) : (
            <>
              <span className="text-4xl font-extrabold">৳{monthlyNumber}</span>
              <span className="text-sm font-medium text-[#46506A]">{t("publicFunnel.pricing.perMonth")}</span>
            </>
          )}
        </p>
        <p className="mt-3 min-h-12 text-sm leading-6 text-[#17223B]/70">
          {isPartner ? t("publicFunnel.pricing.partnerNoMonthlyFee") : t("publicFunnel.pricing.includedLimits")}
        </p>
      </div>

      <ul className="mt-5 space-y-3 border-t border-[#17223B]/10 pt-5 text-sm text-[#17223B]">
        <li className="flex gap-2">
          <span aria-hidden="true" className="text-[#5D49BB]">•</span>
          {plan.limits.conversations < 0
            ? t("publicFunnel.pricing.unlimitedConversations")
            : t("publicFunnel.pricing.conversationsPerMonth", { amount: formatNumber(plan.limits.conversations, locale) })}
        </li>
        {plan.limits.orders < 0 && <li className="flex gap-2"><span aria-hidden="true" className="text-[#5D49BB]">•</span>{t("publicFunnel.pricing.unlimitedOrders")}</li>}
        {plan.limits.products < 0 && <li className="flex gap-2"><span aria-hidden="true" className="text-[#5D49BB]">•</span>{t("publicFunnel.pricing.unlimitedProducts")}</li>}
      </ul>

      {plan.supportReplyAllowance && (
        <aside aria-label={t("publicFunnel.pricing.shadowAllowanceLabel", { defaultValue: "Non-billable support reply measurement" })} className="mt-5 rounded-2xl border border-amber-200 bg-amber-50/70 p-4 text-sm text-[#17223B]">
          <p className="font-bold">
            {t("publicFunnel.pricing.shadowAllowanceTitle", {
              amount: formatNumber(plan.supportReplyAllowance.amount, locale),
              defaultValue: `${formatNumber(plan.supportReplyAllowance.amount, locale)} accepted AI replies/month (shadow target)`,
            })}
          </p>
          <p className="mt-2 text-xs leading-5 text-[#17223B]/75">
            {t("publicFunnel.pricing.shadowAllowanceNote", {
              conversations: formatNumber(plan.limits.conversations, locale),
              defaultValue: `Measurement only: this is not billed or enforced. Your active allowance remains ${formatNumber(plan.limits.conversations, locale)} Messenger conversations; existing top-ups still apply to conversations only.`,
            })}
          </p>
        </aside>
      )}

      {isBkashEnabled() && isGrowth && (
        <div className="mt-5 rounded-2xl border border-[#7460D9]/20 bg-white/80 p-4">
          <p className="text-xs font-semibold leading-5 text-[#17223B]/80">{t("publicFunnel.pricing.growthMonthlyNote")}</p>
          {plan.canPurchaseTopups && (plan.topupPacks?.length ?? 0) > 0 && (
            <div className="mt-4">
              <h3 className="text-sm font-bold text-[#17223B]">{t("publicFunnel.pricing.topupsTitle")}</h3>
              <ul className="mt-2 space-y-1 text-xs text-[#17223B]/75">
                {plan.topupPacks!.map((pack) => (
                  <li key={pack.code}>{t("publicFunnel.pricing.topupPack", { amount: formatNumber(pack.conversations, locale), price: formatNumber(pack.priceBdt, locale) })}</li>
                ))}
              </ul>
              <p className="mt-2 text-xs leading-5 text-[#17223B]/65">{t("publicFunnel.pricing.topupsCaveat")}</p>
            </div>
          )}
        </div>
      )}

      {isPartner && (
        <div className="mt-5 rounded-2xl border border-[#17223B]/10 bg-[#F8F9FC] p-4">
          <p className="text-xs leading-5 text-[#17223B]/75">{t("publicFunnel.pricing.partnerQualification")}</p>
          <ul className="mt-4 space-y-2 text-sm font-semibold text-[#17223B]">
            {(plan.partnerOrderTiers ?? []).map((tier) => {
              const range = tier.maxOrders === null
                ? `${formatNumber(tier.minOrders, locale)}+`
                : `${formatNumber(tier.minOrders, locale)}–${formatNumber(tier.maxOrders, locale)}`;
              return <li key={`${tier.minOrders}-${tier.maxOrders}`} className="flex justify-between gap-2"><span>{range}</span><span>৳{formatNumber(tier.rateBdt, locale)} {t("publicFunnel.pricing.perDeliveredOrder")}</span></li>;
            })}
          </ul>
          <p className="mt-4 text-xs leading-5 text-[#17223B]/70">{t("publicFunnel.pricing.partnerBillingNote")}</p>
          {thresholdTier && (
            <p className="mt-3 rounded-xl border border-[#7460D9]/15 bg-white px-3 py-2 text-xs font-medium leading-5 text-[#17223B]/80">
              {t("publicFunnel.pricing.partnerThresholdExample", {
                belowThresholdOrders: formatNumber(thresholdTier.minOrders - 1, locale),
                orders: formatNumber(thresholdTier.minOrders, locale),
                rate: formatNumber(thresholdTier.rateBdt, locale),
                total: formatNumber(thresholdTier.minOrders * thresholdTier.rateBdt, locale),
              })}
            </p>
          )}
        </div>
      )}

      <div className="mt-auto pt-6">
        {isPartner ? (
          <>
            <button type="button" onClick={onPartnerReview} className="funnel-button funnel-button-primary w-full justify-center px-4 py-3 text-sm">
              {t("publicFunnel.pricing.partnershipAction", { defaultValue: "Request Partnership review" })}
            </button>
            <p className="mt-3 text-center text-xs leading-5 text-[#17223B]/65">{t("publicFunnel.pricing.partnershipReviewNote", { defaultValue: "Eligibility is reviewed before any Partnership terms are activated." })}</p>
          </>
        ) : (
          <>
            <a href={signupHref} className="funnel-button funnel-button-primary w-full justify-center px-4 py-3 text-sm">
              {t(isGrowth ? "publicFunnel.pricing.moderatorPlusAction" : "publicFunnel.pricing.getModeratorAction", {
                defaultValue: isGrowth ? "Review Moderator Plus" : "Create a Get Your Moderator account",
              })}
            </a>
            {isGrowth && <p className="mt-3 text-center text-xs leading-5 text-[#17223B]/65">{t("publicFunnel.pricing.moderatorPlusNewAccountsNote", { defaultValue: "New shops start with Get Your Moderator; upgrades keep existing plan and usage records." })}</p>}
          </>
        )}
      </div>
    </article>
  );
}

export default function Pricing() {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage || i18n.language;
  const [catalog, setCatalog] = useState<PublicSubscriptionCatalog | null>(null);
  const [addons, setAddons] = useState<PublicAddonDefinition[] | null>(null);
  const [addonsError, setAddonsError] = useState(false);
  const [catalogError, setCatalogError] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  const [partnerOpen, setPartnerOpen] = useState(false);

  useEffect(() => {
    let active = true;
    setCatalogError(false);
    getCurrentPublicSubscriptionCatalog()
      .then((result) => {
        if (!hasRequiredPublicPlans(result.plans)) {
          if (active) {
            setCatalog(null);
            setCatalogError(true);
          }
          return;
        }
        if (active) setCatalog(result);
      })
      .catch(() => {
        if (active) {
          setCatalog(null);
          setCatalogError(true);
        }
      });
    setAddonsError(false);
    getPublicAddonCatalog()
      .then((result) => { if (active) setAddons(result); })
      .catch(() => { if (active) { setAddons(null); setAddonsError(true); } });
    return () => { active = false; };
  }, [retryCount]);

  return (
    <div className="funnel-page">
      <Seo
        title={t("publicFunnel.meta.pricingTitle")}
        description={t("publicFunnel.meta.pricingDescription")}
        canonicalPath="/pricing"
        canonicalBase="marketing"
      />
      <PublicFunnelSkipLink />
      <PublicFunnelHeader page="pricing" />
      <main id="public-funnel-main" tabIndex={-1} className="scroll-mt-20 mx-auto max-w-7xl px-4 py-12 sm:px-6 sm:py-16">
        <header className="mx-auto mb-10 max-w-3xl text-center sm:mb-12">
          <p className="text-sm font-bold uppercase tracking-[0.16em] text-[#5D49BB]">{t("publicFunnel.pricing.eyebrow")}</p>
          <h1 className="mt-3 text-3xl font-extrabold tracking-tight text-[#17223B] sm:text-5xl">{t("publicFunnel.pricing.title")}</h1>
          <p className="mx-auto mt-4 max-w-2xl text-base leading-7 text-[#17223B]/70">{t("publicFunnel.pricing.subtitle")}</p>
        </header>

        <p className="mx-auto mb-6 max-w-4xl rounded-2xl border border-[#7460D9]/15 bg-[#F3F0FF]/70 px-5 py-4 text-center text-sm leading-6 text-[#17223B]/80">
          {t("publicFunnel.pricing.coreFeatureParity")}
        </p>

        {catalog ? (
          <div className="grid gap-5 lg:grid-cols-3">
            {catalog.plans.map((plan) => (
              <PlanCard key={plan.code} plan={plan} locale={locale} onPartnerReview={() => setPartnerOpen(true)} />
            ))}
          </div>
        ) : catalogError ? (
          <div role="alert" className="mx-auto flex max-w-2xl flex-col items-center gap-4 rounded-2xl border border-[#17223B]/10 bg-white p-6 text-center sm:p-8">
            <p className="text-sm leading-6 text-[#17223B]/75">{t("publicFunnel.pricing.catalogUnavailable")}</p>
            <button type="button" onClick={() => setRetryCount((count) => count + 1)} className="funnel-button funnel-button-primary min-h-11 justify-center px-5 py-3 text-sm">{t("publicFunnel.pricing.retryCatalog")}</button>
          </div>
        ) : (
          <p aria-live="polite" role="status" className="py-16 text-center text-sm text-[#17223B]/70">{t("publicFunnel.pricing.catalogLoading")}</p>
        )}

        <section aria-labelledby="optional-addons-title" className="mt-14 border-t border-[#17223B]/10 pt-10 sm:mt-16 sm:pt-12">
          <header className="mx-auto mb-7 max-w-3xl text-center">
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-[#5D49BB]">{t("publicFunnel.addons.eyebrow", { defaultValue: "Optional add-ons" })}</p>
            <h2 id="optional-addons-title" className="mt-2 text-2xl font-extrabold text-[#17223B] sm:text-3xl">{t("publicFunnel.addons.title", { defaultValue: "Choose only the tools your shop needs" })}</h2>
            <p className="mt-3 text-sm leading-6 text-[#17223B]/70">{t("publicFunnel.addons.availability", { defaultValue: "Pilot access is approved per shop. Add-on billing terms are not active; no add-on price or charge is presented here." })}</p>
          </header>
          {addons ? (
            <div className="grid gap-5 md:grid-cols-2">
              {addons.map((addon) => {
                const key = addon.code === "ADS_STUDIO" ? "adsStudio" : "storefront";
                return (
                  <article key={addon.code} aria-labelledby={`addon-${addon.code}`} className="flex h-full flex-col rounded-3xl border border-[#17223B]/10 bg-white p-6 shadow-sm sm:p-7">
                    <div>
                      <p className="text-xs font-bold uppercase tracking-[0.15em] text-[#5D49BB]">{t("publicFunnel.addons.optionalLabel", { defaultValue: "Optional pilot add-on" })}</p>
                      <h3 id={`addon-${addon.code}`} className="mt-2 text-xl font-extrabold text-[#17223B]">{addon.name}</h3>
                      <p className="mt-3 text-sm leading-6 text-[#17223B]/75">{t(`publicFunnel.addons.${key}.summary`, { defaultValue: addon.summary })}</p>
                      <ul className="mt-4 space-y-2 text-xs leading-5 text-[#17223B]/70">
                        {addon.limits.map((limit, index) => (
                          <li key={`${addon.code}-${index}`} className="flex gap-2">
                            <span aria-hidden="true" className="text-[#5D49BB]">•</span>
                            {t(`publicFunnel.addons.${key}.limits.${index}`, { defaultValue: limit })}
                          </li>
                        ))}
                      </ul>
                    </div>
                    <div className="mt-auto pt-5">
                      <p className="mb-3 text-xs leading-5 text-[#17223B]/70">{t("publicFunnel.addons.pilotTerms", { defaultValue: "Pilot access requires shop approval. Billing terms have not been activated." })}</p>
                      <a href={buildAppUrlWithLocale("/signin", locale)} className="funnel-button funnel-button-secondary w-full justify-center px-4 py-3 text-sm">
                        {t("publicFunnel.addons.checkEligibility", { defaultValue: "Sign in to check eligibility" })}
                      </a>
                    </div>
                  </article>
                );
              })}
            </div>
          ) : addonsError ? (
            <div role="alert" className="mx-auto flex max-w-2xl flex-col items-center gap-4 rounded-2xl border border-[#17223B]/10 bg-white p-6 text-center sm:p-8">
              <p className="text-sm leading-6 text-[#17223B]/75">{t("publicFunnel.addons.catalogUnavailable", { defaultValue: "Optional add-on details are currently unavailable." })}</p>
              <button type="button" onClick={() => setRetryCount((count) => count + 1)} className="funnel-button funnel-button-primary min-h-11 justify-center px-5 py-3 text-sm">{t("publicFunnel.pricing.retryCatalog")}</button>
            </div>
          ) : (
            <p aria-live="polite" role="status" className="py-8 text-center text-sm text-[#17223B]/70">{t("publicFunnel.pricing.catalogLoading")}</p>
          )}
        </section>

        <div className="mx-auto mt-8 max-w-3xl space-y-2 text-center text-sm leading-6 text-[#17223B]/65">
          <p>{t("publicFunnel.pricing.catalogUnitNote")}</p>
          <p>{t("publicFunnel.pricing.conversationCountNote")}</p>
          <p className="border-t border-[#17223B]/10 pt-4 font-medium text-[#17223B]/75">{t("publicFunnel.pricing.separateBoundary")}</p>
        </div>
      </main>
      <PublicFunnelFooter />
      {partnerOpen && <PartnerApplicationDialog onClose={() => setPartnerOpen(false)} />}
    </div>
  );
}
