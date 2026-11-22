import { useState, useRef } from "react";
import { useTranslation } from 'react-i18next';
import type { BusinessInfo, SocialLinks } from "../lib/knowledgeTypes";
import { getErrorMessage } from "@shared/lib/http/errors";
import { EmButton } from "./dashboard/EmButton";

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-em-focus-light focus-visible:transition-none";

const INPUT_CLASSES =
  `w-full min-h-11 px-4 py-2 border border-em-border-input rounded-lg bg-em-bg-surface text-sm text-em-text-primary focus:outline-none ${FOCUS_RING}`;

const emptyBusinessInfo: BusinessInfo = {
  shopName: "",
  address: "",
  phone: "",
  openingHours: "",
  additionalInfo: "",
  socialLinks: {},
};

// Build only the fields edited here — deliveryAreas / paymentMethods are
// intentionally NOT carried (they live on the Delivery / Payment Settings pages;
// the backend preserves any stored values since this payload omits them).
const normalizeBusinessInfo = (value?: Partial<BusinessInfo> | null): BusinessInfo => ({
  ...emptyBusinessInfo,
  shopName: value?.shopName ?? "",
  address: value?.address ?? "",
  phone: value?.phone ?? "",
  openingHours: value?.openingHours ?? "",
  additionalInfo: value?.additionalInfo ?? "",
  socialLinks: (value?.socialLinks && typeof value.socialLinks === "object") ? value.socialLinks : {},
});

// Keep the launch-visible business profile aligned with the Messenger-only
// Meta review scope. Stored legacy links are preserved, but only Facebook and
// website are editable during the BD private launch.
const SOCIAL_FIELDS: { key: keyof SocialLinks; labelKey: string; placeholderKey: string }[] = [
  { key: "facebook", labelKey: "manageShop.businessInfo.social.facebookLabel", placeholderKey: "manageShop.businessInfo.social.facebookPlaceholder" },
  { key: "website", labelKey: "manageShop.businessInfo.social.websiteLabel", placeholderKey: "manageShop.businessInfo.social.websitePlaceholder" },
];

interface BusinessInfoFormProps {
  initialData?: Partial<BusinessInfo> | null;
  onSave: (data: BusinessInfo) => Promise<void>;
  isLoading?: boolean;
}

export default function BusinessInfoForm({ initialData, onSave, isLoading = false }: BusinessInfoFormProps) {
  const { t } = useTranslation();
  const [businessInfo, setBusinessInfo] = useState<BusinessInfo>(() => normalizeBusinessInfo(initialData));
  const [savedBusinessInfo, setSavedBusinessInfo] = useState<BusinessInfo>(() => normalizeBusinessInfo(initialData));
  const [isSaving, setIsSaving] = useState(false);
  const [notice, setNotice] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const infoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showNotice = (type: "success" | "error", message: string) => {
    if (infoTimerRef.current) clearTimeout(infoTimerRef.current);
    setNotice({ type, message });
    if (type === "success") infoTimerRef.current = setTimeout(() => setNotice(null), 3000);
  };

  const isDirty = JSON.stringify(businessInfo) !== JSON.stringify(savedBusinessInfo);

  const handleSave = async () => {
    try {
      setIsSaving(true);
      await onSave(businessInfo);
      setSavedBusinessInfo(businessInfo);
      showNotice("success", t('manageShop.businessInfo.successMsg'));
    } catch (error: any) {
      showNotice("error", getErrorMessage(error, t('manageShop.businessInfo.errorUpdate')));
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading) return <div role="status" className="p-6 text-em-text-secondary">{t('manageShop.businessInfo.loading')}</div>;

  const infoLength = (businessInfo.additionalInfo || "").length;

  return (
    <section className="bg-em-bg-surface rounded-xl border border-em-border p-6">
      <h2 className="text-lg font-semibold text-em-text-primary mb-4">{t('manageShop.businessInfo.sectionTitle')}</h2>

      {notice && (
        <div
          role={notice.type === "error" ? "alert" : "status"}
          className={`mb-4 rounded-lg border px-4 py-3 text-sm ${
            notice.type === "success"
              ? "border-em-success-700/20 bg-em-success-100 text-em-success-700"
              : "border-em-danger-700/20 bg-em-danger-100 text-em-danger-700"
          }`}
        >
          {notice.message}
        </div>
      )}

      <div className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label htmlFor="bi-shopName" className="block text-sm font-medium text-em-text-primary mb-2">{t('manageShop.businessInfo.shopName')}</label>
            <input
              id="bi-shopName"
              type="text"
              aria-label={t('manageShop.businessInfo.shopName')}
              value={businessInfo.shopName}
              onChange={(e) => setBusinessInfo({ ...businessInfo, shopName: e.target.value })}
              className={INPUT_CLASSES}
            />
          </div>
          <div>
            <label htmlFor="bi-phone" className="block text-sm font-medium text-em-text-primary mb-2">{t('manageShop.businessInfo.phone')}</label>
            <input
              id="bi-phone"
              type="text"
              aria-label={t('manageShop.businessInfo.phone')}
              value={businessInfo.phone}
              onChange={(e) => setBusinessInfo({ ...businessInfo, phone: e.target.value })}
              className={INPUT_CLASSES}
            />
          </div>
        </div>

        <div>
          <label htmlFor="bi-address" className="block text-sm font-medium text-em-text-primary mb-2">{t('manageShop.businessInfo.address')}</label>
          <input
            id="bi-address"
            type="text"
            aria-label={t('manageShop.businessInfo.address')}
            value={businessInfo.address}
            onChange={(e) => setBusinessInfo({ ...businessInfo, address: e.target.value })}
            className={INPUT_CLASSES}
          />
        </div>

        <div>
          <label htmlFor="bi-openingHours" className="block text-sm font-medium text-em-text-primary mb-2">{t('manageShop.businessInfo.openingHours')}</label>
          <input
            id="bi-openingHours"
            type="text"
            aria-label={t('manageShop.businessInfo.openingHours')}
            value={businessInfo.openingHours}
            onChange={(e) => setBusinessInfo({ ...businessInfo, openingHours: e.target.value })}
            placeholder={t('manageShop.businessInfo.openingHoursPlaceholder')}
            className={INPUT_CLASSES}
          />
        </div>

        <div>
          <div className="flex items-center justify-between mb-2">
            <label htmlFor="bi-additionalInfo" className="block text-sm font-medium text-em-text-primary">{t('manageShop.businessInfo.additionalInfo')}</label>
            <span className="em-tabular text-xs text-em-text-secondary">{infoLength}/3000</span>
          </div>
          <textarea
            id="bi-additionalInfo"
            rows={4}
            maxLength={3000}
            aria-label={t('manageShop.businessInfo.additionalInfo')}
            aria-describedby="bi-additionalInfo-help"
            value={businessInfo.additionalInfo || ""}
            onChange={(e) => setBusinessInfo({ ...businessInfo, additionalInfo: e.target.value })}
            placeholder={t('manageShop.businessInfo.additionalInfoPlaceholder')}
            className={INPUT_CLASSES}
          />
          <p id="bi-additionalInfo-help" className="mt-1 text-xs text-em-text-secondary">{t('manageShop.businessInfo.additionalInfoHelp')}</p>
        </div>

        <div role="group" aria-label={t('manageShop.businessInfo.social.title')} className="border-t border-em-border pt-4">
          <p className="block text-sm font-medium text-em-text-primary mb-1">{t('manageShop.businessInfo.social.title')}</p>
          <p className="text-xs text-em-text-secondary mb-3">{t('manageShop.businessInfo.social.help')}</p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {SOCIAL_FIELDS.map(({ key, labelKey, placeholderKey }) => (
              <div key={key}>
                <label htmlFor={`bi-social-${key}`} className="block text-xs font-medium text-em-text-secondary mb-1">{t(labelKey)}</label>
                <input
                  id={`bi-social-${key}`}
                  type="text"
                  aria-label={t(labelKey)}
                  value={businessInfo.socialLinks?.[key] ?? ""}
                  onChange={(e) => setBusinessInfo({
                    ...businessInfo,
                    socialLinks: { ...(businessInfo.socialLinks || {}), [key]: e.target.value },
                  })}
                  placeholder={t(placeholderKey)}
                  className={`w-full min-h-11 px-3 py-2 text-sm border border-em-border-strong rounded-lg bg-em-bg-surface text-em-text-primary focus:outline-none ${FOCUS_RING}`}
                />
              </div>
            ))}
          </div>
        </div>
      </div>

      <EmButton
        variant="primary"
        onClick={handleSave}
        disabled={isSaving || !isDirty}
        loading={isSaving}
        className="mt-6"
      >
        {isSaving ? t('manageShop.businessInfo.saving') : t('manageShop.businessInfo.saveChanges')}
      </EmButton>
    </section>
  );
}
