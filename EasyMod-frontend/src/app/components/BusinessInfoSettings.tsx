import { useEffect, useRef, useState } from "react";
import { useTranslation } from 'react-i18next';
import { Link } from "react-router-dom";
import { Bot, ChevronRight } from "lucide-react";
import type { BusinessInfo } from "../lib/knowledgeTypes";
import { apiClient } from "@/api";
import { authService } from "../lib/auth";
import BusinessInfoForm from "./BusinessInfoForm";
import { getErrorMessage } from "@shared/lib/http/errors";

/**
 * Business profile: identity and knowledge only. AI reply mode moved to the
 * business automation defaults page (ADR-0013 §1); this page links there.
 */
export default function BusinessInfoSettings() {
  const { t } = useTranslation();
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [businessInfo, setBusinessInfo] = useState<BusinessInfo | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    abortControllerRef.current = new AbortController();
    const load = async () => {
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
    };
    load();
    return () => {
      abortControllerRef.current?.abort();
    };
  }, []);

  const handleSaveBusinessInfo = async (data: BusinessInfo) => {
    const updated = await apiClient.updateShopBusinessInfo(data);
    await authService.refreshShops();
    return updated;
  };

  if (isLoading) return <div className="p-6 text-gray-500">{t('manageShop.businessInfo.loading')}</div>;
  if (loadError) return <div className="p-6 text-red-600">{loadError}</div>;

  return (
    <div className="space-y-8 p-6">
      <BusinessInfoForm
        initialData={businessInfo}
        onSave={handleSaveBusinessInfo}
        isLoading={isLoading}
      />

      <Link
        to="/manage-shop/automation"
        data-testid="business-info-automation-link"
        className="flex items-center gap-4 rounded-xl border border-gray-200 bg-white p-4 transition-all hover:border-blue-300 hover:shadow-sm"
      >
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-violet-50 text-violet-700">
          <Bot className="h-5 w-5" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-gray-900">
            {t('manageShop.businessInfo.automationLink.title')}
          </div>
          <div className="mt-0.5 text-xs text-gray-500">
            {t('manageShop.businessInfo.automationLink.desc')}
          </div>
        </div>
        <ChevronRight className="h-4 w-4 shrink-0 text-gray-400" aria-hidden="true" />
      </Link>
    </div>
  );
}