import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Plus, Search, Edit2, Trash2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from 'react-i18next';
import { apiClient } from "@/api";
import { getErrorMessage } from "@shared/lib/http/errors";
import type { Category as ApiCategory } from "@/api/types/product";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";

type CategoryItem = Pick<ApiCategory, 'id' | 'name' | 'description' | 'is_active' | 'product_count' | 'affected_product_count' | 'subcategory_count'> & {
  subcategories?: Array<Pick<ApiCategory, 'id' | 'name' | 'description' | 'is_active' | 'product_count' | 'affected_product_count' | 'subcategory_count'>>;
};
type VisibleCategory = CategoryItem & { visibleChildren: NonNullable<CategoryItem['subcategories']> };

interface DeleteTarget {
  category: CategoryItem | NonNullable<CategoryItem['subcategories']>[number];
  parentId?: string;
  activeProductCount?: number;
  totalAffectedProductCount?: number;
  childCount?: number;
}

const categoryMatches = (category: { name: string; description?: string }, query: string) => (
  `${category.name} ${category.description ?? ''}`.toLowerCase().includes(query)
);

export default function Categories() {
  const navigate = useNavigate();
  const { t, i18n } = useTranslation();
  const language = i18n?.language ?? 'en';
  const loadFailedMessage = t('categories.loadFailed');
  const formatCount = (count: number | undefined) => count === undefined
    ? '—'
    : new Intl.NumberFormat(language.toLowerCase().startsWith('bn') ? 'bn-BD' : 'en-US').format(count);
  const [searchQuery, setSearchQuery] = useState("");
  const [categories, setCategories] = useState<CategoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [reactivatingId, setReactivatingId] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const loadCategories = async () => {
      try {
        setLoading(true);
        setLoadError(null);
        const result = await apiClient.getCategories({ include: 'product_count', include_inactive: true });
        if (active) setCategories(result as CategoryItem[]);
      } catch (error: unknown) {
        if (active) setLoadError(getErrorMessage(error, loadFailedMessage));
      } finally {
        if (active) setLoading(false);
      }
    };
    void loadCategories();
    return () => { active = false; };
  }, [loadFailedMessage]);

  const filteredCategories = useMemo<VisibleCategory[]>(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return categories.map((category) => ({ ...category, visibleChildren: category.subcategories ?? [] }));
    return categories.flatMap((category) => {
      const rootMatches = categoryMatches(category, query);
      const children = category.subcategories ?? [];
      const matchedChildren = rootMatches ? children : children.filter((child) => categoryMatches(child, query));
      return rootMatches || matchedChildren.length > 0
        ? [{ ...category, visibleChildren: matchedChildren }]
        : [];
    });
  }, [categories, searchQuery]);

  const beginDelete = (
    category: CategoryItem | NonNullable<CategoryItem['subcategories']>[number],
    parent?: CategoryItem,
  ) => {
    const children = 'subcategories' in category ? category.subcategories ?? [] : [];
    const activeProductCounts = [category.product_count, ...children.map((child) => child.product_count)];
    const totalAffectedProductCounts = [category.affected_product_count, ...children.map((child) => child.affected_product_count)];
    const activeProductCount = activeProductCounts.every((count): count is number => typeof count === 'number')
      ? activeProductCounts.reduce((sum, count) => sum + count, 0)
      : undefined;
    const totalAffectedProductCount = totalAffectedProductCounts.every((count): count is number => typeof count === 'number')
      ? totalAffectedProductCounts.reduce((sum, count) => sum + count, 0)
      : undefined;
    const childCount = category.subcategory_count ?? ('subcategories' in category ? children.length : 0);
    setDeleteTarget({
      category,
      parentId: parent?.id,
      activeProductCount,
      totalAffectedProductCount,
      childCount,
    });
  };

  const reactivateCategory = async (
    category: CategoryItem | NonNullable<CategoryItem['subcategories']>[number],
    parentId?: string,
  ) => {
    if (reactivatingId) return;
    setReactivatingId(category.id);
    try {
      await apiClient.updateCategory(category.id, { is_active: true });
      setCategories((previous) => parentId
        ? previous.map((root) => root.id === parentId
          ? { ...root, subcategories: (root.subcategories ?? []).map((child) => child.id === category.id ? { ...child, is_active: true } : child) }
          : root)
        : previous.map((root) => root.id === category.id ? { ...root, is_active: true } : root));
      toast.success(t('categories.reactivateSuccess'));
    } catch (error: unknown) {
      toast.error(getErrorMessage(error, t('categories.reactivateFailed')));
    } finally {
      setReactivatingId(null);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    try {
      await apiClient.deleteCategory(deleteTarget.category.id);
      setCategories((previous) => deleteTarget.parentId
        ? previous.map((root) => root.id === deleteTarget.parentId
          ? {
              ...root,
              subcategories: (root.subcategories ?? []).filter((child) => child.id !== deleteTarget.category.id),
              subcategory_count: Math.max(0, (root.subcategory_count ?? root.subcategories?.length ?? 1) - 1),
            }
          : root)
        : previous.filter((root) => root.id !== deleteTarget.category.id));
      setDeleteTarget(null);
      toast.success(t('categories.deleteSuccess'));
    } catch (error: unknown) {
      toast.error(getErrorMessage(error, t('categories.deleteFailed')));
    } finally {
      setDeleting(false);
    }
  };

  const cancelDelete = () => {
    if (!deleting) setDeleteTarget(null);
  };

  const statusBadge = (active: boolean | undefined) => (
    <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${active === false ? 'bg-em-bg-muted text-em-text-secondary' : 'bg-em-success-100 text-em-success-700'}`}>
      {active === false ? t('categories.status.inactive') : t('categories.status.active')}
    </span>
  );

  return (
    <div className="min-h-full p-4 md:p-6">
      <div className="mx-auto w-full max-w-6xl space-y-5">
        <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-lg font-semibold text-em-text-primary">{t('categories.title')}</h1>
            <p className="mt-1 text-sm text-em-text-secondary">{t('categories.subtitle')}</p>
          </div>
          <div className="flex w-full flex-wrap gap-2 sm:w-auto">
            <label className="relative min-w-0 flex-1 sm:w-64 sm:flex-none">
              <Search aria-hidden="true" className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-em-text-secondary" />
              <input
                type="search"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder={t('categories.searchPlaceholder')}
                aria-label={t('categories.searchPlaceholder')}
                className="min-h-11 w-full rounded-lg border border-em-border-strong bg-em-bg-surface py-2 pl-9 pr-3 text-sm text-em-text-primary focus-visible:outline-2 focus-visible:outline-em-focus-light"
              />
            </label>
            <button
              type="button"
              onClick={() => navigate('/categories/create')}
              className="flex min-h-11 items-center gap-2 rounded-lg bg-em-violet-600 px-4 py-2 font-medium text-white hover:bg-em-violet-700"
            >
              <Plus className="h-5 w-5" />
              {t('categories.addCategory')}
            </button>
          </div>
        </header>

        {loadError && <p role="alert" className="rounded-lg border border-em-danger-700/20 bg-em-danger-100 px-4 py-3 text-sm text-em-danger-700">{loadError}</p>}

        {loading ? (
          <div role="status" className="flex items-center justify-center gap-2 py-12 text-em-text-secondary">
            <Loader2 className="h-5 w-5 animate-spin" />
            {t('categories.loading')}
          </div>
        ) : filteredCategories.length === 0 ? (
          <div className="rounded-xl border border-dashed border-em-border-strong bg-em-bg-surface px-4 py-12 text-center">
            <Search className="mx-auto mb-3 h-8 w-8 text-em-text-secondary" />
            <h2 className="font-medium text-em-text-primary">{t('categories.emptySearch')}</h2>
            <p className="mt-1 text-sm text-em-text-secondary">
              {searchQuery ? t('categories.emptySearchHint') : t('categories.emptyStart')}
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {filteredCategories.map((category) => (
              <section key={category.id} className="min-w-0 overflow-hidden rounded-xl border border-em-border bg-em-bg-surface">
                <div className="flex min-w-0 flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex min-w-0 items-start gap-3">
                    <span aria-hidden="true" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-em-violet-100 font-semibold text-em-violet-700">
                      {category.name.slice(0, 1).toUpperCase()}
                    </span>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="break-words font-semibold text-em-text-primary">{category.name}</h2>
                        {statusBadge(category.is_active)}
                      </div>
                      {category.description && <p className="mt-1 break-words text-sm text-em-text-secondary">{category.description}</p>}
                      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-em-text-secondary">
                        <span>{t('categories.columns.activeProducts')}: {formatCount(category.product_count)}</span>
                        <span>{t('categories.columns.totalSubcategory')}: {formatCount(category.subcategory_count ?? category.subcategories?.length ?? 0)}</span>
                      </div>
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
                    <button
                      type="button"
                      onClick={() => navigate(`/categories/create?parent=${encodeURIComponent(category.id)}`)}
                      aria-label={t('categories.detail.addSubcategoryFor', { name: category.name })}
                      className="flex min-h-11 items-center gap-2 rounded-lg px-3 text-sm font-medium text-em-violet-700 hover:bg-em-violet-50"
                    >
                      <Plus className="h-4 w-4" />
                      {t('categories.detail.addSubcategory')}
                    </button>
                    <button
                      type="button"
                      onClick={() => navigate(`/categories/${category.id}/edit`)}
                      aria-label={t('categories.editAria', { name: category.name })}
                      className="flex min-h-11 min-w-11 items-center justify-center rounded-lg text-em-text-secondary hover:bg-em-bg-muted hover:text-em-violet-700"
                    >
                      <Edit2 className="h-4 w-4" />
                    </button>
                    {category.is_active === false && (
                      <button
                        type="button"
                        onClick={() => void reactivateCategory(category)}
                        disabled={reactivatingId === category.id}
                        aria-label={t('categories.reactivateAria', { name: category.name })}
                        className="min-h-11 rounded-lg px-3 text-sm font-medium text-em-success-700 hover:bg-em-success-100 disabled:opacity-50"
                      >
                        {reactivatingId === category.id ? t('common.saving') : t('categories.reactivate')}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => beginDelete(category)}
                      aria-label={t('categories.deleteAria', { name: category.name })}
                      className="flex min-h-11 min-w-11 items-center justify-center rounded-lg text-em-text-secondary hover:bg-em-danger-100 hover:text-em-danger-700"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>

                {category.visibleChildren.length > 0 && (
                  <ul className="divide-y divide-em-border border-t border-em-border bg-em-bg-muted/40">
                    {category.visibleChildren.map((child) => (
                      <li key={child.id} className="flex min-w-0 flex-col gap-3 py-3 pl-4 pr-3 sm:flex-row sm:items-center sm:justify-between sm:pl-8">
                        <div className="flex min-w-0 items-start gap-3">
                          <span aria-hidden="true" className="mt-1 h-2 w-2 shrink-0 rounded-full bg-em-violet-500" />
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <button
                                type="button"
                                onClick={() => navigate(`/categories/${category.id}/${child.id}`)}
                                className="break-words text-left text-sm font-medium text-em-text-primary hover:text-em-violet-700 hover:underline"
                              >
                                {child.name}
                              </button>
                              {statusBadge(child.is_active)}
                            </div>
                            {child.description && <p className="mt-1 break-words text-xs text-em-text-secondary">{child.description}</p>}
                            <p className="mt-1 text-xs text-em-text-secondary">{t('categories.columns.activeProducts')}: {formatCount(child.product_count)}</p>
                          </div>
                        </div>
                        <div className="flex items-center justify-end gap-1">
                          <button
                            type="button"
                            onClick={() => navigate(`/categories/${category.id}/${child.id}`)}
                            aria-label={t('categories.editAria', { name: child.name })}
                            className="flex min-h-11 min-w-11 items-center justify-center rounded-lg text-em-text-secondary hover:bg-em-bg-muted hover:text-em-violet-700"
                          >
                            <Edit2 className="h-4 w-4" />
                          </button>
                          {child.is_active === false && (
                            <button
                              type="button"
                              onClick={() => void reactivateCategory(child, category.id)}
                              disabled={reactivatingId === child.id}
                              aria-label={t('categories.reactivateAria', { name: child.name })}
                              className="min-h-11 rounded-lg px-3 text-sm font-medium text-em-success-700 hover:bg-em-success-100 disabled:opacity-50"
                            >
                              {reactivatingId === child.id ? t('common.saving') : t('categories.reactivate')}
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => beginDelete(child, category)}
                            aria-label={t('categories.deleteAria', { name: child.name })}
                            className="flex min-h-11 min-w-11 items-center justify-center rounded-lg text-em-text-secondary hover:bg-em-danger-100 hover:text-em-danger-700"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            ))}
          </div>
        )}

        <Dialog open={Boolean(deleteTarget)} onOpenChange={(open) => { if (!open) cancelDelete(); }}>
          <DialogContent className="border-em-border bg-em-bg-surface text-em-text-primary sm:max-w-md">
            <DialogHeader>
              <DialogTitle>{t('categories.deleteModal.title')}</DialogTitle>
              <DialogDescription className="text-em-text-secondary">
                {deleteTarget && t('categories.deleteModal.message', { name: deleteTarget.category.name })}
              </DialogDescription>
            </DialogHeader>
            {deleteTarget && (
              <div className="space-y-2 rounded-lg bg-em-bg-muted p-3 text-sm text-em-text-primary">
                <p>{t('categories.deleteModal.activeProductCount', {
                  count: deleteTarget.activeProductCount ?? 0,
                  formattedCount: formatCount(deleteTarget.activeProductCount),
                })}</p>
                <p>
                  {typeof deleteTarget.totalAffectedProductCount === 'number'
                    ? t('categories.deleteModal.totalAffectedProductCount', {
                      count: deleteTarget.totalAffectedProductCount,
                      formattedCount: formatCount(deleteTarget.totalAffectedProductCount),
                    })
                    : t('categories.deleteModal.totalLinkedCountUnavailable')}
                </p>
                <p>{t('categories.deleteModal.associationsCleared')}</p>
                <p>{t('categories.deleteModal.affectedChildren', {
                  count: deleteTarget.childCount ?? 0,
                  formattedCount: formatCount(deleteTarget.childCount),
                })}</p>
                <p className="text-xs text-em-text-secondary">{t('categories.deleteModal.cannotUndo')}</p>
              </div>
            )}
            <div className="mt-2 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <button type="button" onClick={cancelDelete} disabled={deleting} className="min-h-11 rounded-lg border border-em-border-strong px-4 text-sm font-medium hover:bg-em-bg-muted disabled:opacity-50">
                {t('common.cancel')}
              </button>
              <button type="button" onClick={() => void confirmDelete()} disabled={deleting} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-em-danger-700 px-4 text-sm font-semibold text-white hover:bg-em-danger-700/90 disabled:opacity-60">
                {deleting && <Loader2 className="h-4 w-4 animate-spin" />}
                {t('common.delete')}
              </button>
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
