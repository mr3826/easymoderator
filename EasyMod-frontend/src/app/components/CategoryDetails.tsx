import { useEffect, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ChevronRight, Loader2 } from "lucide-react";
import { useTranslation } from 'react-i18next';
import { apiClient } from "@/api";
import { getErrorMessage } from "@shared/lib/http/errors";
import type { Category as ApiCategory } from "@/api/types/product";

export default function CategoryDetails() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const loadFailedMessage = t('categories.detail.loadFailed');
  const { categoryId } = useParams();
  const [searchParams] = useSearchParams();
  const parentId = !categoryId ? searchParams.get('parent') : null;
  const isCreateMode = !categoryId;
  const isChildCreate = isCreateMode && Boolean(parentId);

  const [categoryName, setCategoryName] = useState("");
  const [description, setDescription] = useState("");
  const [isActive, setIsActive] = useState(true);
  const [parentName, setParentName] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const load = async () => {
      if (!categoryId && !parentId) return;
      try {
        setLoading(true);
        setError(null);
        if (categoryId) {
          const category = await apiClient.getCategory(categoryId);
          if (!active) return;
          setCategoryName(category.name);
          setDescription(category.description || "");
          setIsActive(category.is_active !== false);
        } else if (parentId) {
          const parent = await apiClient.getCategory(parentId);
          if (active) setParentName(parent.name);
        }
      } catch (loadError: unknown) {
        if (active) setError(getErrorMessage(loadError, loadFailedMessage));
      } finally {
        if (active) setLoading(false);
      }
    };
    void load();
    return () => { active = false; };
  }, [categoryId, parentId, loadFailedMessage]);

  const handleSave = async () => {
    if (!categoryName.trim()) {
      setError(t('categories.detail.nameRequired'));
      return;
    }

    try {
      setSaving(true);
      setError(null);
      const categoryData = {
        name: categoryName.trim(),
        description: description.trim(),
        is_active: isActive,
      };

      if (isChildCreate && parentId) {
        const childData: Omit<ApiCategory, 'id' | 'created_at' | 'updated_at'> = {
          ...categoryData,
          parent_category_id: parentId,
        };
        await apiClient.createCategory(childData);
      } else if (categoryId) {
        await apiClient.updateCategory(categoryId, categoryData);
      } else {
        await apiClient.createCategory(categoryData);
      }

      navigate("/categories");
    } catch (saveError: unknown) {
      setError(getErrorMessage(saveError, t(isCreateMode ? 'categories.detail.createFailed' : 'categories.detail.updateFailed')));
    } finally {
      setSaving(false);
    }
  };

  const pageTitle = isChildCreate
    ? t('categories.detail.createSubcategoryTitle')
    : isCreateMode
      ? t('categories.detail.createTitle')
      : t('categories.detail.detailTitle');

  return (
    <div className="min-h-full p-4 md:p-6">
      <div className="mx-auto w-full max-w-4xl space-y-5">
        <nav aria-label={t('categories.detail.breadcrumb')} className="flex flex-wrap items-center gap-2 text-sm text-em-text-secondary">
          <button type="button" onClick={() => navigate('/categories')} className="min-h-11 rounded px-1 hover:text-em-violet-700 hover:underline">
            {t('categories.detail.breadcrumb')}
          </button>
          {parentName && <>
            <ChevronRight aria-hidden="true" className="h-4 w-4" />
            <span>{parentName}</span>
          </>}
          {(categoryName || isCreateMode) && <>
            <ChevronRight aria-hidden="true" className="h-4 w-4" />
            <span aria-current="page" className="text-em-text-primary">{categoryName || pageTitle}</span>
          </>}
        </nav>

        <header>
          <h1 className="text-lg font-semibold text-em-text-primary">{pageTitle}</h1>
          <p className="mt-1 text-sm text-em-text-secondary">
            {isChildCreate ? t('categories.detail.createSubcategoryDesc', { parent: parentName }) : isCreateMode ? t('categories.detail.createDesc') : t('categories.detail.persistedUpdateDesc')}
          </p>
        </header>

        {error && <p role="alert" className="rounded-lg border border-em-danger-700/20 bg-em-danger-100 px-4 py-3 text-sm text-em-danger-700">{error}</p>}

        {loading ? (
          <div role="status" className="flex items-center justify-center gap-2 py-12 text-em-text-secondary">
            <Loader2 className="h-5 w-5 animate-spin" />
            {t('categories.detail.loading')}
          </div>
        ) : (
          <section className="space-y-5 rounded-xl border border-em-border bg-em-bg-surface p-4 sm:p-6">
            <div>
              <h2 className="text-base font-semibold text-em-text-primary">{t('categories.detail.infoSection')}</h2>
              {parentName && <p className="mt-1 text-sm text-em-text-secondary">{t('categories.detail.parentCategory', { name: parentName })}</p>}
            </div>

            <div className="space-y-1.5">
              <label htmlFor="category-name" className="block text-sm font-medium text-em-text-primary">
                {t('categories.detail.categoryName')} <span aria-hidden="true" className="text-em-danger-700">*</span>
              </label>
              <input
                id="category-name"
                type="text"
                value={categoryName}
                onChange={(event) => setCategoryName(event.target.value)}
                maxLength={50}
                required
                aria-invalid={Boolean(error && !categoryName.trim())}
                placeholder={t('categories.detail.categoryNamePlaceholder')}
                className="min-h-11 w-full rounded-lg border border-em-border-strong bg-em-bg-surface px-4 py-2 text-sm text-em-text-primary focus-visible:outline-2 focus-visible:outline-em-focus-light"
              />
              <p className="text-xs text-em-text-secondary">{t('categories.detail.charCount', { count: categoryName.length })}</p>
            </div>

            <div className="space-y-1.5">
              <label htmlFor="category-description" className="block text-sm font-medium text-em-text-primary">{t('categories.detail.shortDesc')}</label>
              <textarea
                id="category-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                rows={4}
                placeholder={t('categories.detail.shortDescPlaceholder')}
                className="min-h-28 w-full rounded-lg border border-em-border-strong bg-em-bg-surface px-4 py-2 text-sm text-em-text-primary focus-visible:outline-2 focus-visible:outline-em-focus-light"
              />
            </div>

            <div className="space-y-1.5">
              <label htmlFor="category-status" className="block text-sm font-medium text-em-text-primary">{t('categories.detail.status')}</label>
              <select
                id="category-status"
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
              <button type="button" onClick={() => void handleSave()} disabled={saving || loading} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-em-violet-600 px-5 text-sm font-semibold text-white hover:bg-em-violet-700 disabled:cursor-not-allowed disabled:opacity-60">
                {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                {saving
                  ? isCreateMode ? t('categories.detail.creating') : t('categories.detail.updating')
                  : isChildCreate ? t('categories.detail.createSubcategoryButton') : isCreateMode ? t('categories.detail.createButton') : t('categories.detail.updateButton')}
              </button>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
