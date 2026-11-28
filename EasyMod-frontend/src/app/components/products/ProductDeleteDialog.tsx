import { Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";

interface ProductDeleteDialogProps {
  open: boolean;
  productName?: string;
  isDeleting: boolean;
  error?: string | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}

export function ProductDeleteDialog({
  open,
  productName,
  isDeleting,
  error,
  onOpenChange,
  onConfirm,
}: ProductDeleteDialogProps) {
  const { t } = useTranslation();

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!isDeleting) onOpenChange(nextOpen); }}>
      <DialogContent className="max-w-sm border-em-border bg-em-bg-surface text-em-text-primary motion-reduce:animate-none">
        <DialogHeader>
          <DialogTitle>{t("products.deleteModal.title")}</DialogTitle>
          <DialogDescription className="text-em-text-secondary">
            {t("products.deleteModal.description", { name: productName })}
          </DialogDescription>
        </DialogHeader>
        {error && <p role="alert" className="rounded-lg bg-em-danger-100 px-3 py-2 text-sm text-em-danger-700">{error}</p>}
        <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            disabled={isDeleting}
            className="min-h-11 rounded-lg border border-em-border-strong px-4 text-sm font-medium hover:bg-em-bg-muted disabled:opacity-50"
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={isDeleting}
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-em-danger-700 px-4 text-sm font-semibold text-white hover:bg-em-danger-700/90 disabled:opacity-60"
          >
            {isDeleting && <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
            {isDeleting ? t("common.deleting") : t("common.delete")}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
