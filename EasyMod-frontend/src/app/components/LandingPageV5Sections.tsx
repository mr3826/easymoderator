import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SubscriptionPlanDefinition } from "@/app/lib/subscriptionPlans";
import type { PublicAddonDefinition } from "@/api/domains/publicAddons";
import { GROWTH_UPGRADE_INTENT } from "@/app/lib/signupIntent";
import { buildAppUrlWithLocale, buildMarketingUrlWithLocale, isBkashEnabled } from "@/app/lib/config";

export type MerchantNeed = "support" | "orders" | "store" | "brand" | "insights" | "measurement";

const NEEDS: MerchantNeed[] = ["support", "orders", "store", "brand", "insights", "measurement"];

function useReducedMotionPreference() {
  const [reducedMotion, setReducedMotion] = useState(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
      : false,
  );

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  return reducedMotion;
}

export function LandingHero({ locale }: { locale: string }) {
  const { t } = useTranslation();

  return (
    <section className="relative overflow-hidden bg-[#17223B] px-4 py-14 text-white sm:px-6 sm:py-20 lg:py-24">
      <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-[8%] w-px bg-white/10" />
      <div aria-hidden="true" className="pointer-events-none absolute -left-24 top-12 h-56 w-56 border border-[#F4C35E]/15" />
      <div className="relative mx-auto grid max-w-7xl items-center gap-10 lg:grid-cols-[minmax(0,0.92fr)_minmax(27rem,1.08fr)] lg:gap-14">
        <div className="max-w-3xl">
          <p className="mb-5 inline-flex items-center gap-2 border-l-2 border-[#F4C35E] pl-3 text-sm font-semibold text-[#F4C35E]">
            {t("publicFunnel.landingV5.hero.eyebrow")}
          </p>
          <h1 className="max-w-3xl text-4xl font-extrabold leading-[1.06] tracking-tight sm:text-5xl lg:text-6xl">
            {t("publicFunnel.landingV5.hero.title")}
          </h1>
          <p className="mt-6 max-w-2xl text-base leading-7 text-white/80 sm:text-lg sm:leading-8">
            {t("publicFunnel.landingV5.hero.body")}
          </p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <a href={buildAppUrlWithLocale("/signup", locale)} className="funnel-button funnel-button-primary min-h-12 justify-center px-6 py-3.5 text-base shadow-lg shadow-black/20">
              {t("publicFunnel.landing.primaryCta")}
            </a>
            <a href="#needs" className="funnel-button funnel-button-secondary min-h-12 justify-center px-6 py-3.5 text-base">
              {t("publicFunnel.landingV5.hero.exploreCta")}
            </a>
          </div>
          <p className="mt-4 text-sm leading-6 text-white/70">{t("publicFunnel.landing.signupNote")}</p>
        </div>

        <figure aria-labelledby="landing-v5-hero-visual-title" className="relative mx-auto w-full max-w-[42rem] overflow-hidden rounded-[1.8rem] border border-white/15 bg-[#202D49] p-4 shadow-2xl shadow-black/25 sm:p-6">
          <figcaption className="flex flex-wrap items-start justify-between gap-3 border-b border-white/10 pb-4">
            <div>
              <p id="landing-v5-hero-visual-title" className="text-sm font-bold tracking-tight text-white">{t("publicFunnel.landingV5.hero.visualTitle")}</p>
              <p className="mt-1 text-xs leading-5 text-white/60">{t("publicFunnel.landingV5.hero.visualNote")}</p>
            </div>
            <span className="border border-[#F4C35E]/50 px-2.5 py-1 text-[11px] font-semibold text-[#F4C35E]">{t("publicFunnel.landingV5.hero.illustration")}</span>
          </figcaption>

          <div className="relative mt-5 min-h-[16.5rem] overflow-hidden rounded-2xl border border-white/10 bg-[#17223B] p-4 sm:min-h-[18rem] sm:p-6">
            <svg aria-hidden="true" viewBox="0 0 520 280" className="absolute inset-0 h-full w-full" preserveAspectRatio="xMidYMid meet">
              <path d="M60 140H207C236 140 236 76 268 76H350C382 76 382 205 414 205H470" fill="none" stroke="#7460D9" strokeWidth="3" />
              <path d="M60 140H207C236 140 236 76 268 76H350C382 76 382 205 414 205H470" fill="none" stroke="#F4C35E" strokeDasharray="4 16" strokeLinecap="round" strokeWidth="3" />
              <circle cx="60" cy="140" r="13" fill="#17223B" stroke="#F4C35E" strokeWidth="4" />
              <circle cx="268" cy="76" r="13" fill="#17223B" stroke="#F4C35E" strokeWidth="4" />
              <circle cx="414" cy="205" r="13" fill="#17223B" stroke="#F4C35E" strokeWidth="4" />
              <path d="M45 52h112v46H45zM362 43h118v47H362z" fill="#263654" stroke="#ffffff" strokeOpacity=".18" />
            </svg>
            <div className="relative grid min-h-[14.5rem] grid-cols-2 items-start gap-4 sm:min-h-[15rem]">
              <div className="max-w-[11rem] border-l-2 border-[#F4C35E] bg-[#263654]/95 p-3">
                <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#F4C35E]">01 · {t("publicFunnel.landingV5.hero.signalSupport")}</p>
                <p className="mt-2 text-xs font-semibold leading-5 text-white">{t("publicFunnel.landingV5.hero.signalQuestion")}</p>
              </div>
              <div className="ml-auto mt-3 max-w-[11rem] border-l-2 border-[#7460D9] bg-[#263654]/95 p-3">
                <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#c1b8ff]">02 · {t("publicFunnel.landingV5.hero.signalProducts")}</p>
                <p className="mt-2 text-xs font-semibold leading-5 text-white">{t("publicFunnel.landingV5.hero.signalOrder")}</p>
              </div>
              <div className="col-span-2 mt-auto flex flex-wrap items-end justify-between gap-3">
                <span className="border border-white/15 bg-[#17223B]/90 px-3 py-2 text-xs font-medium text-white/75">{t("publicFunnel.landingV5.hero.signalReview")}</span>
                <span className="border border-[#F4C35E]/45 bg-[#17223B]/90 px-3 py-2 text-xs font-semibold text-[#F4C35E]">{t("publicFunnel.landingV5.hero.signalNext")}</span>
              </div>
            </div>
          </div>
        </figure>
      </div>
    </section>
  );
}
const STORY_STEPS = ["inquiry", "context", "response", "review", "delivery", "relationship"] as const;

export function CommerceSignalStory() {
  const { t } = useTranslation();
  const reducedMotion = useReducedMotionPreference();
  const [motionState, setMotionState] = useState<"idle" | "playing" | "paused" | "complete">("idle");

  const startOrResume = () => setMotionState("playing");
  const pause = () => setMotionState("paused");

  return (
    <section id="workflow" aria-labelledby="workflow-title" className="scroll-mt-20 bg-white px-4 py-16 sm:px-6 sm:py-20">
      <div className="mx-auto max-w-7xl">
        <div className="grid gap-6 lg:grid-cols-[0.78fr_1.22fr] lg:items-end">
          <div>
            <p className="text-sm font-bold uppercase tracking-[0.16em] text-[#5D49BB]">{t("publicFunnel.landingV5.story.eyebrow")}</p>
            <h2 id="workflow-title" className="mt-3 max-w-2xl text-3xl font-extrabold tracking-tight text-[#17223B] sm:text-4xl">{t("publicFunnel.landingV5.story.title")}</h2>
          </div>
          <p className="max-w-2xl text-base leading-7 text-[#17223B]/70">{t("publicFunnel.landingV5.story.body")}</p>
        </div>

        <figure id="commerce-story" aria-labelledby="commerce-story-caption" className="mt-10 rounded-[1.75rem] border border-[#17223B]/10 bg-[#F8F9FC] p-5 sm:p-8">
          <figcaption id="commerce-story-caption" className="flex flex-col gap-4 border-b border-[#17223B]/10 pb-5 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-extrabold text-[#17223B]">{t("publicFunnel.landingV5.story.figureTitle")}</p>
              <p className="mt-1 text-xs leading-5 text-[#17223B]/65">{t("publicFunnel.landingV5.story.illustrationNote")}</p>
            </div>
            {reducedMotion ? (
              <p role="status" className="text-xs font-semibold text-[#39445F]">{t("publicFunnel.landingV5.story.reducedMotion")}</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {motionState === "playing" ? (
                  <button type="button" onClick={pause} aria-controls="commerce-story-track" className="funnel-button funnel-button-secondary min-h-11 justify-center px-4 py-2 text-sm">{t("publicFunnel.landingV5.story.pauseMotion")}</button>
                ) : (
                  <button type="button" onClick={startOrResume} aria-controls="commerce-story-track" className="funnel-button funnel-button-secondary min-h-11 justify-center px-4 py-2 text-sm">
                    {t(motionState === "complete" ? "publicFunnel.landingV5.story.replayMotion" : motionState === "paused" ? "publicFunnel.landingV5.story.resumeMotion" : "publicFunnel.landingV5.story.playMotion")}
                  </button>
                )}
              </div>
            )}
          </figcaption>

          <ol
            id="commerce-story-track"
            className={`landing-v5-story-track mt-7 ${motionState === "playing" ? "is-playing" : ""} ${motionState === "paused" ? "is-paused" : ""} ${motionState === "complete" ? "is-complete" : ""}`}
            onAnimationEnd={(event) => {
              if (event.target === event.currentTarget.querySelector(".landing-v5-story-tracer")) setMotionState("complete");
            }}
          >
            <span aria-hidden="true" className="landing-v5-story-tracer" />
            {STORY_STEPS.map((step, index) => (
              <li key={step} className="landing-v5-story-step">
                <span aria-hidden="true" className="landing-v5-story-node">0{index + 1}</span>
                <div className="landing-v5-story-copy">
                  <h3 className="text-sm font-bold leading-5 text-[#17223B]">{t(`publicFunnel.landingV5.story.steps.${step}.title`)}</h3>
                  <p className="mt-1 text-xs leading-5 text-[#17223B]/70">{t(`publicFunnel.landingV5.story.steps.${step}.body`)}</p>
                </div>
              </li>
            ))}
          </ol>
        </figure>
      </div>
    </section>
  );
}

export function MerchantNeedsExplorer({ selected, onSelect }: { selected: MerchantNeed; onSelect: (need: MerchantNeed) => void }) {
  const { t } = useTranslation();

  return (
    <section id="needs" aria-labelledby="needs-title" className="scroll-mt-20 bg-[#17223B] px-4 py-16 text-white sm:px-6 sm:py-20">
      <div className="mx-auto max-w-7xl">
        <div className="max-w-3xl">
          <p className="text-sm font-bold uppercase tracking-[0.16em] text-[#F4C35E]">{t("publicFunnel.landingV5.explorer.eyebrow")}</p>
          <h2 id="needs-title" className="mt-3 text-3xl font-extrabold tracking-tight sm:text-4xl">{t("publicFunnel.landingV5.explorer.title")}</h2>
          <p className="mt-3 text-base leading-7 text-white/70">{t("publicFunnel.landingV5.explorer.body")}</p>
        </div>

        <div role="region" aria-label={t("publicFunnel.landingV5.explorer.controlsLabel")} className="mt-8">
          <div aria-labelledby="needs-title" role="group" className="flex flex-wrap gap-2">
            {NEEDS.map((need, index) => (
              <button
                key={need}
                type="button"
                aria-pressed={selected === need}
                aria-controls="merchant-need-panel"
                onClick={() => onSelect(need)}
                className={`landing-v5-need-button min-h-11 border px-4 py-2.5 text-sm font-semibold transition-colors ${selected === need ? "border-[#F4C35E] bg-[#F4C35E] text-[#17223B]" : "border-white/20 bg-white/5 text-white hover:border-white/50 hover:bg-white/10"}`}
              >
                <span aria-hidden="true" className="mr-2 text-[10px] opacity-65">0{index + 1}</span>
                {t(`publicFunnel.landingV5.needs.${need}.label`)}
              </button>
            ))}
          </div>
          <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">
            {t("publicFunnel.landingV5.explorer.selectionAnnouncement", {
              label: t(`publicFunnel.landingV5.needs.${selected}.label`),
            })}
          </p>

          <div id="merchant-need-panel" className="mt-5 grid overflow-hidden border border-white/15 bg-[#202D49] lg:grid-cols-[0.92fr_1.08fr]">
          <div className="p-6 sm:p-8 lg:p-10">
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-[#F4C35E]">{t(`publicFunnel.landingV5.needs.${selected}.type`)}</p>
            <h3 className="mt-3 text-2xl font-extrabold leading-tight sm:text-3xl">{t(`publicFunnel.landingV5.needs.${selected}.title`)}</h3>
            <p className="mt-4 max-w-xl text-sm leading-6 text-white/75">{t(`publicFunnel.landingV5.needs.${selected}.body`)}</p>
            <p className="mt-6 border-l-2 border-[#7460D9] pl-4 text-sm font-semibold leading-6 text-white/90">{t(`publicFunnel.landingV5.needs.${selected}.boundary`)}</p>
          </div>
          <div className="flex min-h-64 flex-col justify-between border-t border-white/10 bg-[#1B2742] p-6 sm:p-8 lg:border-l lg:border-t-0 lg:p-10">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <p className="text-xs font-bold uppercase tracking-[0.16em] text-white/55">{t("publicFunnel.landingV5.explorer.productView")}</p>
              <span className="border border-white/15 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-white/65">{t("publicFunnel.landingV5.explorer.illustration")}</span>
            </div>
            <div className="mt-8">
              <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-[#c1b8ff]">{t(`publicFunnel.landingV5.needs.${selected}.viewLabel`)}</p>
              <p className="mt-3 max-w-lg text-xl font-semibold leading-snug text-white sm:text-2xl">{t(`publicFunnel.landingV5.needs.${selected}.viewTitle`)}</p>
            </div>
            <p className="mt-8 text-xs leading-5 text-white/55">{t("publicFunnel.landingV5.explorer.noMerchantData")}</p>
          </div>
          </div>
        </div>
      </div>
    </section>
  );
}

export function SolutionsCatalog({ onSelect }: { onSelect: (need: MerchantNeed) => void }) {
  const { t } = useTranslation();

  return (
    <section id="solutions" aria-labelledby="solutions-title" className="scroll-mt-20 bg-[#F8F9FC] px-4 py-16 sm:px-6 sm:py-20">
      <div className="mx-auto max-w-7xl">
        <div className="max-w-3xl">
          <p className="text-sm font-bold uppercase tracking-[0.16em] text-[#5D49BB]">{t("publicFunnel.landingV5.solutions.eyebrow")}</p>
          <h2 id="solutions-title" className="mt-3 text-3xl font-extrabold tracking-tight text-[#17223B] sm:text-4xl">{t("publicFunnel.landingV5.solutions.title")}</h2>
          <p className="mt-3 text-base leading-7 text-[#17223B]/70">{t("publicFunnel.landingV5.solutions.body")}</p>
        </div>

        <div className="mt-9 grid gap-4 lg:grid-cols-[1fr_1fr]">
          <article className="flex h-full flex-col border border-[#17223B]/15 bg-white p-6 sm:p-8">
            <p className="text-xs font-bold uppercase tracking-[0.15em] text-[#5D49BB]">{t("publicFunnel.landingV5.solutions.coreLabel")}</p>
            <h3 className="mt-3 text-2xl font-extrabold text-[#17223B]">{t("publicFunnel.landingV5.solutions.coreTitle")}</h3>
            <p className="mt-3 max-w-xl text-sm leading-6 text-[#17223B]/70">{t("publicFunnel.landingV5.solutions.coreBody")}</p>
            <ul className="mt-6 grid gap-3 border-t border-[#17223B]/10 pt-5 text-sm font-semibold text-[#17223B] sm:grid-cols-2">
              <li className="flex gap-3"><span aria-hidden="true" className="text-[#5D49BB]">01</span>{t("publicFunnel.landingV5.solutions.coreSupport")}</li>
              <li className="flex gap-3"><span aria-hidden="true" className="text-[#5D49BB]">02</span>{t("publicFunnel.landingV5.solutions.coreOrders")}</li>
            </ul>
            <a href="#workflow" className="funnel-button funnel-button-secondary mt-7 min-h-11 w-fit justify-center px-4 py-2.5 text-sm">{t("publicFunnel.landingV5.solutions.coreCta")}</a>
          </article>

          <article className="border border-[#17223B]/15 bg-white p-6 sm:p-8">
            <p className="text-xs font-bold uppercase tracking-[0.15em] text-[#5D49BB]">{t("publicFunnel.landingV5.solutions.optionalLabel")}</p>
            <h3 className="mt-3 text-2xl font-extrabold text-[#17223B]">{t("publicFunnel.landingV5.solutions.optionalTitle")}</h3>
            <p className="mt-3 max-w-xl text-sm leading-6 text-[#17223B]/70">{t("publicFunnel.landingV5.solutions.optionalBody")}</p>
            <ul className="mt-6 grid gap-3 sm:grid-cols-2">
              {(["store", "brand", "insights", "measurement"] as const).map((need) => (
                <li key={need} className="flex min-w-0 items-center justify-between gap-2 border-t border-[#17223B]/10 py-3">
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-[#17223B]">{t(`publicFunnel.landingV5.needs.${need}.label`)}</p>
                    <p className="mt-1 text-xs leading-5 text-[#17223B]/70">{t(`publicFunnel.landingV5.solutions.scope.${need}`)}</p>
                  </div>
                  <a
                    href="#needs"
                    onClick={() => onSelect(need)}
                    aria-label={t("publicFunnel.landingV5.solutions.exploreNeed", { name: t(`publicFunnel.landingV5.needs.${need}.label`) })}
                    className="funnel-quiet-link inline-flex min-h-11 shrink-0 items-center gap-1 px-2 text-xs"
                  >
                    {t("publicFunnel.landingV5.solutions.detailsCta")} <span aria-hidden="true">↗</span>
                  </a>
                </li>
              ))}
            </ul>
          </article>
        </div>
      </div>
    </section>
  );
}

function planSignupHref(code: SubscriptionPlanDefinition["code"], locale: string) {
  if (code !== "SHURU" && code !== "GROWTH") return null;
  const url = new URL(buildAppUrlWithLocale("/signup", locale));
  if (code === "GROWTH") url.searchParams.set("intent", GROWTH_UPGRADE_INTENT);
  return url.toString();
}

function formatNumber(value: number, locale: string) {
  return value.toLocaleString(locale === "bn" ? "bn-BD" : "en-US");
}

export function PlanComparison({ plans, loading, unavailable, addons, addonsLoading, addonsUnavailable, onRetry }: {
  plans: SubscriptionPlanDefinition[];
  loading: boolean;
  unavailable: boolean;
  addons: PublicAddonDefinition[] | null;
  addonsLoading: boolean;
  addonsUnavailable: boolean;
  onRetry: () => void;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage || i18n.language;
  const orderedPlans = (["SHURU", "GROWTH", "PARTNER"] as const)
    .map((code) => plans.find((plan) => plan.code === code))
    .filter((plan): plan is SubscriptionPlanDefinition => Boolean(plan));

  return (
    <section id="plans" aria-labelledby="plans-title" className="scroll-mt-20 bg-white px-4 py-16 sm:px-6 sm:py-20">
      <div className="mx-auto max-w-7xl">
        <div className="grid gap-5 lg:grid-cols-[0.9fr_1.1fr] lg:items-end">
          <div>
            <p className="text-sm font-bold uppercase tracking-[0.16em] text-[#5D49BB]">{t("publicFunnel.landingV5.plans.eyebrow")}</p>
            <h2 id="plans-title" className="mt-3 text-3xl font-extrabold tracking-tight text-[#17223B] sm:text-4xl">{t("publicFunnel.landingV5.plans.title")}</h2>
          </div>
          <p className="max-w-2xl text-sm leading-6 text-[#17223B]/70">{t("publicFunnel.landingV5.plans.body")}</p>
        </div>

        {orderedPlans.length > 0 ? (
          <div className="mt-9 grid gap-4 lg:grid-cols-3">
            {orderedPlans.map((plan) => {
              const planKey = plan.code.toLowerCase();
              const signupHref = planSignupHref(plan.code, locale);
              const partner = plan.code === "PARTNER";
              return (
                <article key={plan.code} aria-labelledby={`landing-plan-${plan.code}`} className={`flex h-full flex-col border p-5 sm:p-6 ${plan.code === "GROWTH" ? "border-[#7460D9]/45 bg-[#F3F0FF]" : "border-[#17223B]/10 bg-[#F8F9FC]"}`}>
                  <h3 id={`landing-plan-${plan.code}`} className="text-xl font-extrabold text-[#17223B]">{plan.publicName || plan.name}</h3>
                  <p className="mt-3 flex flex-wrap items-baseline gap-x-2 text-2xl font-extrabold text-[#17223B]">
                    {partner ? t("publicFunnel.landingV5.plans.partnerBilling") : <>৳{formatNumber(plan.monthlyPrice, locale)}<span className="text-sm font-semibold text-[#17223B]/70">{t("publicFunnel.pricing.perMonth")}</span></>}
                  </p>
                  <p className="mt-3 min-h-12 text-sm leading-6 text-[#17223B]/70">
                    {locale.startsWith("bn") ? plan.descriptionBn : plan.description}
                  </p>
                  {partner && <p className="mt-3 text-xs leading-5 text-[#17223B]/70">{t("publicFunnel.pricing.partnerQualification")}</p>}
                  <ul className="mt-5 space-y-2 border-t border-[#17223B]/10 pt-4 text-sm text-[#17223B]">
                    <li>{plan.limits.conversations < 0
                      ? t("publicFunnel.pricing.unlimitedConversations")
                      : t("publicFunnel.pricing.conversationsPerMonth", { amount: formatNumber(plan.limits.conversations, locale) })}</li>
                    {partner && (plan.partnerOrderTiers ?? []).map((tier) => {
                      const range = tier.maxOrders === null
                        ? `${formatNumber(tier.minOrders, locale)}+`
                        : `${formatNumber(tier.minOrders, locale)}–${formatNumber(tier.maxOrders, locale)}`;
                      return <li key={`${tier.minOrders}-${tier.maxOrders}`} className="flex justify-between gap-2"><span>{range}</span><span>৳{formatNumber(tier.rateBdt, locale)} {t("publicFunnel.pricing.perDeliveredOrder")}</span></li>;
                    })}
                  </ul>
                  {plan.supportReplyAllowance?.status === "shadow_only" && (
                    <aside aria-label={t("publicFunnel.pricing.shadowAllowanceLabel")} className="mt-4 rounded-xl border border-amber-200 bg-amber-50/70 p-3 text-xs leading-5 text-[#17223B]/80">
                      <p className="font-bold text-[#17223B]">
                        {t("publicFunnel.pricing.shadowAllowanceTitle", {
                          amount: formatNumber(plan.supportReplyAllowance.amount, locale),
                        })}
                      </p>
                      <p className="mt-1">
                        {t("publicFunnel.pricing.shadowAllowanceNote", {
                          conversations: formatNumber(plan.limits.conversations, locale),
                        })}
                      </p>
                    </aside>
                  )}
                  {isBkashEnabled() && plan.code === "GROWTH" && plan.canPurchaseTopups && (plan.topupPacks?.length ?? 0) > 0 && (
                    <div className="mt-4 rounded-xl border border-[#7460D9]/15 bg-white/75 p-3">
                      <p className="text-xs leading-5 text-[#17223B]/70">{t("publicFunnel.landingV5.plans.topupBoundary")}</p>
                      <ul className="mt-2 space-y-1 text-xs font-semibold leading-5 text-[#17223B]">
                        {plan.topupPacks!.map((pack) => (
                          <li key={pack.code}>{t("publicFunnel.pricing.topupPack", { amount: formatNumber(pack.conversations, locale), price: formatNumber(pack.priceBdt, locale) })}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  <div className="mt-auto pt-6">
                    {signupHref ? (
                      <a href={signupHref} className="funnel-button funnel-button-primary min-h-11 w-full justify-center px-4 py-2.5 text-sm">
                        {t(`publicFunnel.landingV5.plans.actions.${planKey}`)}
                      </a>
                    ) : (
                      <a href={buildMarketingUrlWithLocale("/pricing", locale)} className="funnel-button funnel-button-secondary min-h-11 w-full justify-center px-4 py-2.5 text-sm">
                        {t("publicFunnel.landingV5.plans.actions.partner")}
                      </a>
                    )}
                    {plan.code === "GROWTH" && <p className="mt-3 text-xs leading-5 text-[#17223B]/65">{t("publicFunnel.landingV5.plans.growthIntentNote")}</p>}
                  </div>
                </article>
              );
            })}
          </div>
        ) : unavailable ? (
          <div role="alert" className="mt-8 border border-[#17223B]/10 bg-[#F8F9FC] p-6">
            <p className="text-sm leading-6 text-[#17223B]/75">{t("publicFunnel.landing.catalogUnavailable")}</p>
            <button type="button" onClick={onRetry} className="funnel-button funnel-button-primary mt-4 min-h-11 px-4 py-2.5 text-sm">{t("publicFunnel.landing.retryCatalog")}</button>
          </div>
        ) : loading ? (
          <p role="status" aria-live="polite" className="mt-8 text-sm text-[#17223B]/70">{t("publicFunnel.landing.catalogLoading")}</p>
        ) : (
          <div role="alert" className="mt-8 border border-[#17223B]/10 bg-[#F8F9FC] p-6">
            <p className="text-sm leading-6 text-[#17223B]/75">{t("publicFunnel.landing.catalogUnavailable")}</p>
            <button type="button" onClick={onRetry} className="funnel-button funnel-button-primary mt-4 min-h-11 px-4 py-2.5 text-sm">{t("publicFunnel.landing.retryCatalog")}</button>
          </div>
        )}

        <section aria-labelledby="landing-addons-title" className="mt-14 border-t border-[#17223B]/10 pt-10 sm:mt-16 sm:pt-12">
          <header className="mx-auto mb-7 max-w-3xl text-center">
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-[#5D49BB]">{t("publicFunnel.addons.eyebrow")}</p>
            <h3 id="landing-addons-title" className="mt-2 text-2xl font-extrabold text-[#17223B] sm:text-3xl">{t("publicFunnel.addons.title")}</h3>
            <p className="mt-3 text-sm leading-6 text-[#17223B]/70">{t("publicFunnel.addons.availability")}</p>
          </header>
          {addons ? (
            <div className="grid gap-4 md:grid-cols-2">
              {addons.map((addon) => {
                const key = addon.code === "ADS_STUDIO" ? "adsStudio" : "storefront";
                return (
                  <article key={addon.code} aria-labelledby={`landing-addon-${addon.code}`} className="flex h-full flex-col border border-[#17223B]/10 bg-[#F8F9FC] p-5 sm:p-6">
                    <p className="text-xs font-bold uppercase tracking-[0.15em] text-[#5D49BB]">{t("publicFunnel.addons.optionalLabel")}</p>
                    <h4 id={`landing-addon-${addon.code}`} className="mt-2 text-lg font-extrabold text-[#17223B]">{addon.name}</h4>
                    <p className="mt-3 text-sm leading-6 text-[#17223B]/75">{t(`publicFunnel.addons.${key}.summary`, { defaultValue: addon.summary })}</p>
                    <ul className="mt-4 space-y-2 text-xs leading-5 text-[#17223B]/70">
                      {addon.limits.map((limit, index) => (
                        <li key={`${addon.code}-${index}`} className="flex gap-2"><span aria-hidden="true">•</span>{t(`publicFunnel.addons.${key}.limits.${index}`, { defaultValue: limit })}</li>
                      ))}
                    </ul>
                    <div className="mt-auto pt-5">
                      <p className="mb-3 text-xs leading-5 text-[#17223B]/70">{t("publicFunnel.addons.pilotTerms")}</p>
                      <a href={buildAppUrlWithLocale("/signin", locale)} className="funnel-button funnel-button-secondary min-h-11 w-full justify-center px-4 py-2.5 text-sm">
                        {t("publicFunnel.addons.checkEligibility")}
                      </a>
                    </div>
                  </article>
                );
              })}
            </div>
          ) : addonsUnavailable ? (
            <div role="alert" className="mx-auto flex max-w-2xl flex-col items-center gap-4 border border-[#17223B]/10 bg-[#F8F9FC] p-6 text-center">
              <p className="text-sm leading-6 text-[#17223B]/75">{t("publicFunnel.addons.catalogUnavailable")}</p>
              <button type="button" onClick={onRetry} className="funnel-button funnel-button-primary min-h-11 px-4 py-2.5 text-sm">{t("publicFunnel.pricing.retryCatalog")}</button>
            </div>
          ) : addonsLoading ? (
            <p role="status" aria-live="polite" className="py-8 text-center text-sm text-[#17223B]/70">{t("publicFunnel.pricing.catalogLoading")}</p>
          ) : null}
        </section>

        <p className="mt-5 text-xs leading-5 text-[#17223B]/70">{t("publicFunnel.landingV5.plans.catalogNote")}</p>
      </div>
    </section>
  );
}

export function LandingTrust() {
  const { t } = useTranslation();
  const faqItems = ["channel", "ai", "quota", "signup"] as const;

  return (
    <>
      <section aria-labelledby="trust-title" className="bg-[#F8F9FC] px-4 py-14 sm:px-6 sm:py-16">
        <div className="mx-auto grid max-w-7xl gap-8 lg:grid-cols-[0.75fr_1.25fr] lg:items-center">
          <div>
            <p className="text-sm font-bold uppercase tracking-[0.16em] text-[#5D49BB]">{t("publicFunnel.landingV5.trust.eyebrow")}</p>
            <h2 id="trust-title" className="mt-3 text-2xl font-extrabold leading-tight text-[#17223B] sm:text-3xl">{t("publicFunnel.landingV5.trust.title")}</h2>
          </div>
          <ul className="grid gap-3 sm:grid-cols-3">
            {(["channel", "control", "states"] as const).map((item, index) => (
              <li key={item} className="border-l-2 border-[#7460D9] bg-white p-4">
                <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#5D49BB]">0{index + 1}</p>
                <h3 className="mt-2 text-sm font-bold text-[#17223B]">{t(`publicFunnel.landingV5.trust.points.${item}.title`)}</h3>
                <p className="mt-2 text-xs leading-5 text-[#17223B]/70">{t(`publicFunnel.landingV5.trust.points.${item}.body`)}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section aria-labelledby="faq-title" className="bg-white px-4 py-16 sm:px-6 sm:py-20">
        <div className="mx-auto max-w-4xl">
          <h2 id="faq-title" className="text-3xl font-extrabold tracking-tight text-[#17223B] sm:text-4xl">{t("publicFunnel.landing.faqTitle")}</h2>
          <div className="mt-7 divide-y divide-[#17223B]/10 border-y border-[#17223B]/10">
            {faqItems.map((item) => (
              <details key={item} className="group py-4">
                <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-4 text-left font-bold text-[#17223B] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#7460D9]">
                  {t(`publicFunnel.landing.faq.${item}.question`)}
                  <span aria-hidden="true" className="text-xl font-normal text-[#5D49BB] group-open:rotate-45">+</span>
                </summary>
                <p className="max-w-3xl pb-2 pr-8 pt-2 text-sm leading-6 text-[#17223B]/75">{t(`publicFunnel.landing.faq.${item}.answer`)}</p>
              </details>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}

export function LandingClosing({ locale }: { locale: string }) {
  const { t } = useTranslation();
  return (
    <section className="bg-[#17223B] px-4 py-14 text-white sm:px-6 sm:py-16">
      <div className="mx-auto flex max-w-7xl flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-2xl font-bold sm:text-3xl">{t("publicFunnel.landing.closingTitle")}</h2>
          <p className="mt-2 max-w-xl text-sm leading-6 text-white/75">{t("publicFunnel.landing.closingBody")}</p>
          <p className="mt-3 text-sm font-semibold text-white/90">{t("publicFunnel.landing.brandPromise")}</p>
        </div>
        <a href={buildAppUrlWithLocale("/signup", locale)} className="funnel-button funnel-button-primary min-h-12 shrink-0 justify-center px-6 py-3">{t("publicFunnel.landing.primaryCta")}</a>
      </div>
    </section>
  );
}
