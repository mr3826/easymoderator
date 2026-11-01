import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { getShopAddons, setShopAddonEnabled, type ShopAddonDefinition, type ShopAddonState } from "@/api/domains/addons";
import { Card, CardContent, CardHeader, CardTitle } from "@/app/components/ui/card";
import { Button } from "@/app/components/ui/button";

export default function Addons() {
  const { t } = useTranslation();
  const [state, setState] = useState<ShopAddonState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pendingCode, setPendingCode] = useState<ShopAddonDefinition["code"] | null>(null);

  const loadAddons = async () => {
    try {
      setError(null);
      setState(await getShopAddons());
    } catch {
      setError(t("addons.loadFailed", { defaultValue: "Add-on eligibility could not be verified. Try again later." }));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let active = true;
    getShopAddons()
      .then((data) => { if (active) setState(data); })
      .catch(() => { if (active) setError(t("addons.loadFailed", { defaultValue: "Add-on eligibility could not be verified. Try again later." })); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [t]);

  const toggleAddon = async (addon: ShopAddonDefinition) => {
    setPendingCode(addon.code);
    setError(null);
    try {
      await setShopAddonEnabled(addon.code, !addon.enabled);
      await loadAddons();
    } catch {
      setError(t("addons.updateFailed", { defaultValue: "The add-on setting was not changed. Verify eligibility and try again." }));
    } finally {
      setPendingCode(null);
    }
  };

  const canManage = state ? ["owner", "admin"].includes(state.role.toLowerCase()) : false;

  return (
    <main className="mx-auto w-full max-w-6xl p-4 pb-24 md:p-8">
      <header className="mb-6 max-w-3xl">
        <p className="text-xs font-bold uppercase tracking-[0.14em] text-brand">{t("addons.eyebrow", { defaultValue: "Optional pilot tools" })}</p>
        <h1 className="mt-2 text-2xl font-bold text-gray-900 md:text-3xl">{t("addons.title", { defaultValue: "Add-ons for your shop" })}</h1>
        <p className="mt-2 text-sm leading-6 text-gray-600">{t("addons.subtitle", { defaultValue: "Check shop-specific eligibility, then opt in or out. Pilot access is approved by EasyModerator; add-on billing terms are not active." })}</p>
      </header>

      {error && <p role="alert" className="mb-5 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">{error}</p>}
      {loading ? (
        <p role="status" aria-live="polite" className="py-12 text-center text-sm text-gray-600">{t("addons.loading", { defaultValue: "Checking add-on eligibility…" })}</p>
      ) : state ? (
        <section aria-label={t("addons.listLabel", { defaultValue: "Optional add-ons" })} className="grid gap-4 md:grid-cols-2">
          {state.addons.map((addon) => {
            const key = addon.code === "ADS_STUDIO" ? "adsStudio" : "storefront";
            return (
              <Card key={addon.code} className="flex h-full flex-col">
                <CardHeader>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <CardTitle>{t(`addons.${key}.title`, { defaultValue: addon.name })}</CardTitle>
                    <span className={`rounded-full px-3 py-1 text-xs font-semibold ${addon.enabled ? "bg-emerald-100 text-emerald-800" : addon.eligible ? "bg-amber-100 text-amber-800" : "bg-slate-100 text-slate-700"}`}>
                      {addon.enabled
                        ? t("addons.statusEnabled", { defaultValue: "Enabled" })
                        : addon.eligible
                          ? t("addons.statusEligible", { defaultValue: "Available by approval" })
                          : t("addons.statusUnavailable", { defaultValue: "Not enabled for this shop" })}
                    </span>
                  </div>
                </CardHeader>
                <CardContent className="flex flex-1 flex-col">
                  <p className="text-sm leading-6 text-gray-600">{t(`addons.${key}.summary`, { defaultValue: addon.summary })}</p>
                  <ul className="mt-4 space-y-2 text-xs leading-5 text-gray-600">
                    {addon.limits.map((limit, index) => (
                      <li key={`${addon.code}-${index}`} className="flex gap-2"><span aria-hidden="true">•</span>{t(`addons.${key}.limits.${index}`, { defaultValue: limit })}</li>
                    ))}
                  </ul>
                  <p className="mt-4 rounded-lg bg-slate-50 p-3 text-xs leading-5 text-gray-600">
                    {t("addons.termsNote", { defaultValue: "No add-on price or billing is activated. An enable action only records this shop's pilot opt-in." })}
                  </p>
                  <div className="mt-auto pt-5">
                    {addon.enabled && (
                      <Link
                        to={addon.code === "ADS_STUDIO" ? "/addons/ads-studio" : "/addons/storefront"}
                        className="mb-3 inline-flex min-h-11 w-full items-center justify-center rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
                      >
                        {addon.code === "ADS_STUDIO"
                          ? t("addons.openAdsStudio", { defaultValue: "Open Ads Studio" })
                          : t("addons.manageStorefront", { defaultValue: "Manage Storefront" })}
                      </Link>
                    )}
                    {canManage ? (
                      <Button
                        type="button"
                        variant={addon.enabled ? "outline" : "default"}
                        disabled={pendingCode !== null || (!addon.eligible && !addon.enabled)}
                        onClick={() => void toggleAddon(addon)}
                        className="min-h-11 w-full"
                      >
                        {pendingCode === addon.code
                          ? t("addons.saving", { defaultValue: "Saving…" })
                          : addon.enabled
                            ? t("addons.disable", { defaultValue: "Disable for this shop" })
                            : t("addons.enable", { defaultValue: "Enable for this shop" })}
                      </Button>
                    ) : (
                      <p className="text-sm text-gray-600">{t("addons.ownerRequired", { defaultValue: "A shop owner or admin manages add-on settings." })}</p>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </section>
      ) : (
        <Card><CardContent className="p-6 text-sm text-gray-600">{t("addons.empty", { defaultValue: "No add-on information is available." })}</CardContent></Card>
      )}
    </main>
  );
}
