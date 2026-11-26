import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from 'react-i18next';
import { Link } from "react-router-dom";
import { Bot, ChevronRight } from "lucide-react";
import { motion, MotionConfig } from "motion/react";
import type { BusinessInfo } from "../lib/knowledgeTypes";
import { apiClient } from "@/api";
import { authService } from "../lib/auth";
import BusinessInfoForm from "./BusinessInfoForm";
import { getErrorMessage } from "@shared/lib/http/errors";
import { fadeUp } from "@/lib/motion";
import { EmButton } from "./dashboard/EmButton";
import { PageHeader } from "./dashboard/PageHeader";

const ANIMATE = import.meta.env.MODE !== "test";

/**
 * Business profile: identity and knowledge only. AI reply mode moved to the
 * business automation defaults page (ADR-0013 §1); this page links there.
 * Legacy (unrouted — /manage-shop/business-info renders the Business & FAQ
 * workspace): kept test-compilable under header-removal C1, the page-level
 * signal header is retired here too; only the sr-only h1 landmark remains.
 */
export default function BusinessInfoSettings() {
  const { t } = useTranslation();
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [businessInfo, setBusinessInfo] = useState<BusinessInfo | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Stable identity so the mount effect runs exactly once (pinned); retry reuses it.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const load = useCallback(async () => {
    try {
      setIsLoading(true);
      setLoadError(null);
      const infoData = await apiClient.getShopBusinessInfo();
      if (!abortControllerRef.current?.signal.aborted) {
        setBusinessInfo(infoData.businessInfo);
      }
    } catch (error: any) {
      if (!abortControllerRef.current?.signal.aborted) {
        setLoadError(getErrorMessage(error, t('manageShop.businessInfo.errorLoad')));
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
    };
  }, [load]);

  const retry = () => {
    abortControllerRef.current = new AbortController();
    load();
  };

  const handleSaveBusinessInfo = async (data: BusinessInfo) => {
    const updated = await apiClient.updateShopBusinessInfo(data);
    await authService.refreshShops();
    return updated;
  };

  return (
    <MotionConfig reducedMotion="user">
    <div className="em-business min-h-full p-4 md:p-6">
      <div className="mx-auto w-full max-w-[1440px] space-y-6">
        {/* Header-removal C1 (legacy page): signal band, shop-name breadcrumb
            and tally pills retired; the load-error alert below still owns the
            blocked-state honesty. */}
        <PageHeader title={t('nav.businessInfo')} titleMode="srOnly" />

        {loadError ? (
          <div role="alert" className="flex flex-wrap items-center gap-2 rounded-xl border border-em-danger-700/20 bg-em-danger-100 px-4 py-3 text-sm text-em-danger-700">
            <span className="flex-1">{loadError}</span>
            <EmButton variant="secondary" onClick={retry}>
              {t('manageShop.businessInfo.retryLoad')}
            </EmButton>
          </div>
        ) : isLoading ? (
          <div className="space-y-4" aria-label={t('manageShop.businessInfo.loading')}>
            {[0, 1].map((row) => (
              <div key={row} className="animate-pulse space-y-3 rounded-xl border border-em-border bg-em-bg-surface p-6">
                <div className="h-5 w-1/3 rounded bg-em-bg-muted" />
                <div className="h-3 w-2/3 rounded bg-em-bg-muted" />
                <div className="h-9 w-40 rounded bg-em-bg-muted" />
              </div>
            ))}
          </div>
        ) : (
          <>
            <motion.div variants={fadeUp} initial={ANIMATE ? 'hidden' : false} animate="visible">
              <BusinessInfoForm
                initialData={businessInfo}
                onSave={handleSaveBusinessInfo}
                isLoading={isLoading}
              />
            </motion.div>

            <motion.div variants={fadeUp} initial={ANIMATE ? 'hidden' : false} animate="visible">
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
                    {t('manageShop.businessInfo.automationLink.title')}
                  </div>
                  <div className="mt-0.5 text-xs text-em-text-secondary">
                    {t('manageShop.businessInfo.automationLink.desc')}
                  </div>
                </div>
                <ChevronRight className="h-4 w-4 shrink-0 text-em-text-secondary" aria-hidden="true" />
              </Link>
            </motion.div>
          </>
        )}
      </div>
    </div>
    </MotionConfig>
  );
}
