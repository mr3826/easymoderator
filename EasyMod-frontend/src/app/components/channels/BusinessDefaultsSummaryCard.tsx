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

export default function BusinessDefaultsSummaryCard() {
  const { t } = useTranslation();
  const settingsQuery = useQuery({
    queryKey: ["shop-ai-settings"],
    queryFn: getShopAISettings,
  });

  const mode = settingsQuery.data?.automation_mode;

  return (
    <section
      className="rounded-xl border border-[var(--ca-border)] bg-[var(--ca-surface-muted)] p-4 md:p-5"
      aria-label={t("manageShop.channels.defaults.title")}
      data-testid="business-defaults-summary"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-bold text-[var(--ca-ink)]">
            {t("manageShop.channels.defaults.title")}
          </h2>
          <p className="mt-1 text-xs text-[var(--ca-ink-muted)]">
            {t("manageShop.channels.defaults.desc")}
          </p>
          <p className="mt-2 text-sm text-[var(--ca-ink)]">
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
          className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-[var(--ca-border)] bg-white px-3 py-1.5 text-xs font-semibold text-[var(--ca-violet-deep)] hover:bg-[var(--ca-violet-soft)]"
        >
          {t("manageShop.channels.defaults.edit")}
          <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
        </Link>
      </div>
    </section>
  );
}