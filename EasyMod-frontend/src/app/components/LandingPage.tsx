import { useTranslation } from "react-i18next";
import { ClaimProvider } from "./claims/ClaimProvider";
import { PublicFunnelFooter, PublicFunnelHeader, PublicFunnelSkipLink } from "./PublicFunnelChrome";
import { LandingV7Page } from "./landing/LandingV7";
import Seo from "./Seo";
import "./public-funnel.css";

const LANDING_SCHEMA = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "EasyModerator",
  applicationCategory: "BusinessApplication",
  operatingSystem: "Web",
  url: "https://easymod.tech/",
};

/**
 * Merchant landing page — a contract-derived surface (ADR-0011).
 *
 * Every price renders from the frozen commercial contract, every capability
 * statement renders through the claim gate, and the page fails closed when the
 * contract is unavailable. The Direction C design is preserved; the only change
 * from the prior landing is where the numbers and claims come from.
 */
export default function LandingPage() {
  const { t } = useTranslation();

  return (
    <div className="funnel-page">
      <Seo
        title={t("landingV7.meta.title")}
        description={t("landingV7.meta.description")}
        canonicalPath="/"
        canonicalBase="marketing"
        structuredData={LANDING_SCHEMA}
      />
      <PublicFunnelSkipLink />
      <PublicFunnelHeader page="landing" />
      <main id="public-funnel-main" tabIndex={-1} className="scroll-mt-20">
        <ClaimProvider surface="landing">
          <LandingV7Page />
        </ClaimProvider>
      </main>
      <PublicFunnelFooter />
    </div>
  );
}