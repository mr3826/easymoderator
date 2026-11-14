import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getPublicAddonCatalog, type PublicAddonDefinition } from "@/api/domains/publicAddons";
import { useCommercialContract } from "@/api/domains/commercialContract";
import { buildAppUrlWithLocale } from "@/app/lib/config";
import { formatBdt, formatBdtBn } from "@/shared/contracts/commercial-contract";
import { Claim } from "./claims/Claim";
import { ClaimProvider } from "./claims/ClaimProvider";
import { PublicFunnelFooter, PublicFunnelHeader, PublicFunnelSkipLink } from "./PublicFunnelChrome";
import Seo from "./Seo";
import "./public-funnel.css";

/**
 * Public pricing surface (ADR-0011).
 *
 * The single delivered-order offer is read from the public commercial contract
 * endpoint. There is no price fallback: while the contract is loading no number
 * is shown, and if it fails the page reports an error instead of rendering a
 * stale or invented price. Capability statements come from the claim gate via
 * <Claim>, which fails closed to no DOM node when the evidence is missing.
 */
export default function Pricing() {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage || i18n.language;
  const isBangla = locale.toLowerCase().startsWith("bn");
  const [addons, setAddons] = useState<PublicAddonDefinition[] | null>(null);
  const [addonsError, setAddonsError] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  const contractQuery = useCommercialContract();
  const contract = contractQuery.data;

  useEffect(() => {
    let active = true;
    setAddonsError(false);
    getPublicAddonCatalog()
      .then((result) => { if (active) setAddons(result); })
      .catch(() => { if (active) { setAddons(null); setAddonsError(true); } });
    return () => { active = false; };
  }, [retryCount]);

  const unitPrice = contract
    ? (isBangla ? formatBdtBn(contract.unit_price_minor) : formatBdt(contract.unit_price_minor))
    : null;
  const description = contract ? contract.description[isBangla ? "bn" : "en"] : null;

  const retry = () => {
    setRetryCount((count) => count + 1);
    void contractQuery.refetch();
  };

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
          <p className="mx-auto mt-4 max-w-2xl text-base leading-7 text-[#17223B]/70">
            {unitPrice
              ? t("publicFunnel.pricing.subtitle", { unitPrice })
              : t("publicFunnel.pricing.noFeesNote")}
          </p>
        </header>

        {contract ? (
          <div className="mx-auto max-w-3xl">
            <article
              aria-labelledby="delivered-order-offer"
              className="flex h-full flex-col rounded-3xl border border-[#7460D9]/45 bg-[#F3F0FF] p-6 shadow-sm sm:p-8"
              data-contract-version={contract.contract_version}
              data-contract-hash={contract.contract_hash}
            >
              <h2 id="delivered-order-offer" className="text-2xl font-extrabold text-[#17223B]">{t("publicFunnel.pricing.offerTitle")}</h2>
              <p className="mt-4 flex flex-wrap items-baseline gap-x-2 text-[#17223B]">
                <span data-testid="commercial-unit-price" className="text-4xl font-extrabold">{unitPrice}</span>
                <span className="text-sm font-medium text-[#46506A]">{t("publicFunnel.pricing.perDeliveredOrder")}</span>
              </p>
              {description && <p className="mt-4 text-sm leading-6 text-[#17223B]/75">{description}</p>}
              <ul className="mt-5 space-y-2 border-t border-[#17223B]/10 pt-5 text-sm leading-6 text-[#17223B]">
                <li>{t("publicFunnel.pricing.zeroRatedNote")}</li>
                <li>{t("publicFunnel.pricing.noFeesNote")}</li>
                <li>{t("publicFunnel.pricing.dueNote", { dueDays: contract.due_days })}</li>
              </ul>

              <div className="mt-6 border-t border-[#17223B]/10 pt-5">
                <h3 className="text-sm font-bold text-[#17223B]">{t("publicFunnel.pricing.capabilitiesTitle")}</h3>
                <div className="mt-3 space-y-2 text-sm leading-6 text-[#17223B]/80">
                  <ClaimProvider surface="pricing">
                    <Claim id="billing.delivered_order" surface="pricing" className="block" />
                    <Claim id="ai.draft_reply" surface="pricing" className="block" />
                    <Claim id="ai.auto_reply" surface="pricing" className="block" />
                    <Claim id="courier.pathao.booking_live" surface="pricing" className="block" />
                    <Claim id="courier.steadfast.booking_live" surface="pricing" className="block" />
                    <Claim id="courier.redx.booking_live" surface="pricing" className="block" />
                    <Claim id="courier.cod_settlement.pathao" surface="pricing" className="block" />
                    <Claim id="courier.cod_settlement.steadfast" surface="pricing" className="block" />
                    <Claim id="courier.cod_settlement.redx" surface="pricing" className="block" />
                    <Claim id="voice.transcription" surface="pricing" className="block" />
                    <Claim id="addons.ads_studio.pilot" surface="pricing" className="block" />
                    <Claim id="addons.storefront.pilot" surface="pricing" className="block" />
                  </ClaimProvider>
                </div>
              </div>

              <div className="mt-auto pt-7">
                <a href={buildAppUrlWithLocale("/signup", locale)} className="funnel-button funnel-button-primary w-full justify-center px-5 py-3 text-sm">
                  {t("publicFunnel.pricing.cta")}
                </a>
                <p className="mt-3 text-center text-xs leading-5 text-[#17223B]/65">
                  {t("publicFunnel.pricing.contractVersionLabel", { version: contract.contract_version })}
                </p>
              </div>
            </article>
          </div>
        ) : contractQuery.isPending ? (
          <p aria-live="polite" role="status" className="py-16 text-center text-sm text-[#17223B]/70">{t("publicFunnel.pricing.catalogLoading")}</p>
        ) : (
          <div role="alert" className="mx-auto flex max-w-2xl flex-col items-center gap-4 rounded-2xl border border-[#17223B]/10 bg-white p-6 text-center sm:p-8">
            <p className="text-sm leading-6 text-[#17223B]/75">{t("publicFunnel.pricing.catalogUnavailable")}</p>
            <button type="button" onClick={retry} className="funnel-button funnel-button-primary min-h-11 justify-center px-5 py-3 text-sm">{t("publicFunnel.pricing.retryCatalog")}</button>
          </div>
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
              <button type="button" onClick={retry} className="funnel-button funnel-button-primary min-h-11 justify-center px-5 py-3 text-sm">{t("publicFunnel.pricing.retryCatalog")}</button>
            </div>
          ) : (
            <p aria-live="polite" role="status" className="py-8 text-center text-sm text-[#17223B]/70">{t("publicFunnel.pricing.catalogLoading")}</p>
          )}
        </section>

        <div className="mx-auto mt-8 max-w-3xl space-y-2 text-center text-sm leading-6 text-[#17223B]/65">
          <p className="border-t border-[#17223B]/10 pt-4 font-medium text-[#17223B]/75">{t("publicFunnel.pricing.separateBoundary")}</p>
        </div>
      </main>
      <PublicFunnelFooter />
    </div>
  );
}