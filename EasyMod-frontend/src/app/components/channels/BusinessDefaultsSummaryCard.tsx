/**
 * BusinessDefaultsSummaryCard — the business-wide ceiling shown on the
 * channels overview (ADR-0013 §3). Channels can only narrow it; the editor
 * lives at /manage-shop/automation.
 */
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ArrowUpRight, Loader2 } from "lucide-react";
import { getShopAISettings } from "@/api/domains/shop";
import { MODE_LABEL_KEYS } from "./channelAutomation";

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-em-focus-light focus-visible:transition-none";

export default function BusinessDefaultsSummaryCard() {
  const { t } = useTranslation();
  const settingsQuery = useQuery({
    queryKey: ["shop-ai-settings"],
    queryFn: getShopAISettings,
  });

  const mode = settingsQuery.data?.automation_mode;

  return (
    <section
      className="rounded-xl border border-em-border bg-em-bg-muted p-4 md:p-5"
      aria-label={t("manageShop.channels.defaults.title")}
      data-testid="business-defaults-summary"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-bold text-em-text-primary">
            {t("manageShop.channels.defaults.title")}
          </h2>
          <p className="mt-1 text-xs text-em-text-secondary">
            {t("manageShop.channels.defaults.desc")}
          </p>
          <p className="mt-2 text-sm text-em-text-primary">
            {settingsQuery.isLoading ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : mode ? (
              <>
                {t("manageShop.channels.defaults.ceiling")}:{" "}
                <span className="font-semibold">{t(MODE_LABEL_KEYS[mode])}</span>
              </>
            ) : (
              t("manageShop.channels.defaults.unavailable")
            )}
          </p>
        </div>
        <Link
          to="/manage-shop/automation"
          className={`inline-flex min-h-11 shrink-0 items-center gap-1 rounded-lg border border-em-border-strong bg-em-bg-surface px-3 py-1.5 text-xs font-semibold text-em-violet-700 hover:bg-em-violet-50 ${FOCUS_RING}`}
        >
          {t("manageShop.channels.defaults.edit")}
          <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
        </Link>
      </div>
    </section>
  );
}
