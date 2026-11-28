import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ChevronRight, Loader2 } from "lucide-react";
import { useTranslation } from 'react-i18next';
import { apiClient } from "@/api";
import { getErrorMessage } from "@shared/lib/http/errors";

export default function SubcategoryDetails() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const loadFailedMessage = t('categories.subcategoryDetail.loadFailed');
  const { categoryId, subcategoryId } = useParams();

  const [subcategoryName, setSubcategoryName] = useState("");
  const [description, setDescription] = useState("");
  const [isActive, setIsActive] = useState(true);
  const [parentCategoryName, setParentCategoryName] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const loadDetails = async () => {
      if (!categoryId || !subcategoryId) {
        setLoading(false);
        return;
      }
      try {
        setLoading(true);
        setLoadError(null);
        const [parentCategory, subcategory] = await Promise.all([
          apiClient.getCategory(categoryId),
          apiClient.getSubcategoryDetails(categoryId, subcategoryId),
        ]);
        if (!active) return;
        setParentCategoryName(parentCategory.name);
        setSubcategoryName(subcategory.name);
        setDescription(subcategory.description || "");
        setIsActive(subcategory.is_active !== false);
      } catch (error: unknown) {
        if (active) setLoadError(getErrorMessage(error, loadFailedMessage));
      } finally {
        if (active) setLoading(false);
      }
    };
    void loadDetails();
    return () => { active = false; };
  }, [categoryId, subcategoryId, loadFailedMessage]);

  const handleSave = async () => {
    if (!subcategoryId || !subcategoryName.trim()) return;
    try {
      setSaving(true);
      setSaveError(null);
      await apiClient.updateCategory(subcategoryId, {
        name: subcategoryName.trim(),
        description: description.trim(),
        is_active: isActive,
      });
      navigate('/categories');
    } catch (error: unknown) {
      setSaveError(getErrorMessage(error, t('categories.subcategoryDetail.updateFailed')));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="min-h-full p-4 md:p-6">
      <div className="mx-auto w-full max-w-4xl space-y-5">
        <nav aria-label={t('categories.subcategoryDetail.breadcrumb')} className="flex flex-wrap items-center gap-2 text-sm text-em-text-secondary">
          <button type="button" onClick={() => navigate('/categories')} className="min-h-11 rounded px-1 hover:text-em-violet-700 hover:underline">
            {t('categories.subcategoryDetail.breadcrumb')}
          </button>
          <ChevronRight aria-hidden="true" className="h-4 w-4" />
          <button type="button" onClick={() => navigate(`/categories/${categoryId}/edit`)} className="min-h-11 rounded px-1 hover:text-em-violet-700 hover:underline">
            {parentCategoryName || t('categories.detail.breadcrumb')}
          </button>
          <ChevronRight aria-hidden="true" className="h-4 w-4" />
          <span aria-current="page" className="text-em-text-primary">{subcategoryName || t('categories.subcategoryDetail.title')}</span>
        </nav>

        <header>
          <h1 className="text-lg font-semibold text-em-text-primary">{t('categories.subcategoryDetail.title')}</h1>
          <p className="mt-1 text-sm text-em-text-secondary">{t('categories.subcategoryDetail.persistedSubtitle')}</p>
        </header>

        {loadError && <p role="alert" className="rounded-lg border border-em-danger-700/20 bg-em-danger-100 px-4 py-3 text-sm text-em-danger-700">{loadError}</p>}
        {saveError && <p role="alert" className="rounded-lg border border-em-danger-700/20 bg-em-danger-100 px-4 py-3 text-sm text-em-danger-700">{saveError}</p>}

        {loading ? (
          <div role="status" className="flex items-center justify-center gap-2 py-12 text-em-text-secondary">
            <Loader2 className="h-5 w-5 animate-spin" />
            {t('categories.subcategoryDetail.loading')}
          </div>
        ) : (
          <section className="space-y-5 rounded-xl border border-em-border bg-em-bg-surface p-4 sm:p-6">
            <div>
              <h2 className="text-base font-semibold text-em-text-primary">{t('categories.subcategoryDetail.infoSection')}</h2>
              {parentCategoryName && <p className="mt-1 text-sm text-em-text-secondary">{t('categories.detail.parentCategory', { name: parentCategoryName })}</p>}
            </div>

            <div className="space-y-1.5">
              <label htmlFor="subcategory-name" className="block text-sm font-medium text-em-text-primary">
                {t('categories.subcategoryDetail.nameLabel')} <span aria-hidden="true" className="text-em-danger-700">*</span>
              </label>
              <input
                id="subcategory-name"
                type="text"
                value={subcategoryName}
                onChange={(event) => setSubcategoryName(event.target.value)}
                maxLength={50}
                required
                aria-invalid={!subcategoryName.trim()}
                placeholder={t('categories.subcategoryDetail.namePlaceholder')}
                className="min-h-11 w-full rounded-lg border border-em-border-strong bg-em-bg-surface px-4 py-2 text-sm text-em-text-primary focus-visible:outline-2 focus-visible:outline-em-focus-light"
              />
            </div>

            <div className="space-y-1.5">
              <label htmlFor="subcategory-description" className="block text-sm font-medium text-em-text-primary">{t('categories.subcategoryDetail.shortDesc')}</label>
              <textarea
                id="subcategory-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                rows={4}
                placeholder={t('categories.subcategoryDetail.shortDescPlaceholder')}
                className="min-h-28 w-full rounded-lg border border-em-border-strong bg-em-bg-surface px-4 py-2 text-sm text-em-text-primary focus-visible:outline-2 focus-visible:outline-em-focus-light"
              />
            </div>

            <div className="space-y-1.5">
              <label htmlFor="subcategory-status" className="block text-sm font-medium text-em-text-primary">{t('categories.detail.status')}</label>
              <select
                id="subcategory-status"
                value={isActive ? 'active' : 'inactive'}
                onChange={(event) => setIsActive(event.target.value === 'active')}
                className="min-h-11 w-full rounded-lg border border-em-border-strong bg-em-bg-surface px-3 py-2 text-sm text-em-text-primary sm:max-w-xs"
              >
                <option value="active">{t('categories.status.active')}</option>
                <option value="inactive">{t('categories.status.inactive')}</option>
              </select>
            </div>

            <div className="flex flex-col-reverse gap-2 border-t border-em-border pt-4 sm:flex-row sm:justify-end">
              <button type="button" onClick={() => navigate('/categories')} className="min-h-11 rounded-lg border border-em-border-strong px-5 text-sm font-medium text-em-text-primary hover:bg-em-bg-muted">
                {t('common.cancel')}
              </button>
              <button type="button" onClick={() => void handleSave()} disabled={saving || loading || !subcategoryName.trim()} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-em-violet-600 px-5 text-sm font-semibold text-white hover:bg-em-violet-700 disabled:cursor-not-allowed disabled:opacity-60">
                {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                {saving ? t('common.saving') : t('categories.subcategoryDetail.updateButton')}
              </button>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
