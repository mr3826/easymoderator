import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getPublicAddonCatalog, type PublicAddonDefinition } from "@/api/domains/publicAddons";
import { trackFunnelEvent } from "@/app/lib/funnel";
import { PublicFunnelFooter, PublicFunnelHeader, PublicFunnelSkipLink } from "./PublicFunnelChrome";
import { PlanComparison } from "./LandingPageV5Sections";
import { CoreCapabilities, FeatureBar, LandingClosing, LandingHero, StorySection, TrustAndFaq, WorkflowSection } from "./LandingPageV6Sections";
import Seo from "./Seo";
import "./public-funnel.css";
import "./landing-v6.css";

const LANDING_SCHEMA = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "EasyModerator",
  applicationCategory: "BusinessApplication",
  operatingSystem: "Web",
  url: "https://easymod.tech/",
};

export default function LandingPage() {
  const { t } = useTranslation();
  const [addons, setAddons] = useState<PublicAddonDefinition[] | null>(null);
  const [addonsError, setAddonsError] = useState(false);
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    trackFunnelEvent("landing_view", { surface: "landing" });
    let active = true;
    setAddons(null);
    setAddonsError(false);

    getPublicAddonCatalog()
      .then((result) => { if (active) setAddons(result); })
      .catch(() => { if (active) { setAddons(null); setAddonsError(true); } });

    return () => { active = false; };
  }, [retryCount]);

  return (
    <div className="funnel-page landing-v6-page">
      <Seo
        title={t("publicFunnel.meta.landingTitle")}
        description={t("publicFunnel.meta.landingDescription")}
        canonicalPath="/"
        canonicalBase="marketing"
        structuredData={LANDING_SCHEMA}
      />
      <PublicFunnelSkipLink />
      <PublicFunnelHeader page="landing" />
      <main id="public-funnel-main" tabIndex={-1} className="scroll-mt-20">
        <LandingHero />
        <FeatureBar />
        <WorkflowSection />
        <CoreCapabilities />
        <StorySection />
        <TrustAndFaq />
        <PlanComparison
          addons={addons}
          addonsLoading={!addonsError && addons === null}
          addonsUnavailable={addonsError}
          onRetry={() => setRetryCount((count) => count + 1)}
        />
        <LandingClosing />
      </main>
      <PublicFunnelFooter />
    </div>
  );
}