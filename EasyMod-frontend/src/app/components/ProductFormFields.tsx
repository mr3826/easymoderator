import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { ProductDraft, ProductFieldErrors, ProductFormField as ProductFormFieldName } from "./products/productForm";
import { validateProductField } from "./products/productForm";

const CONTROL_CLASS = "min-h-11 w-full rounded-lg border border-em-border-strong bg-em-bg-surface px-3 py-2 text-sm text-em-text-primary focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-em-focus-light disabled:cursor-not-allowed disabled:opacity-60";

interface ProductFormFieldViewProps {
  id: string;
  field: ProductFormFieldName;
  label: string;
  draft: ProductDraft;
  touched: boolean;
  errors: ProductFieldErrors;
  help?: ReactNode;
  required?: boolean;
  aiReview?: ReactNode;
  children: (state: { error?: string; describedBy?: string }) => ReactNode;
}

export function ProductFormFieldView({
  id,
  field,
  label,
  draft,
  touched,
  errors,
  help,
  required = false,
  aiReview,
  children,
}: ProductFormFieldViewProps) {
  const { t } = useTranslation();
  const validationError = touched ? errors[field] ?? validateProductField(field, draft) : undefined;
  const helpId = help ? `${id}-help` : undefined;
  const errorId = validationError ? `${id}-error` : undefined;
  const describedBy = [helpId, errorId].filter(Boolean).join(" ") || undefined;

  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium text-em-text-primary">
        {label}
        {required && (
          <>
            <span aria-hidden="true" className="ml-1 text-em-danger-700">*</span>
            <span className="sr-only"> ({t("common.required")})</span>
          </>
        )}
      </label>
      {children({
        error: validationError ? t(validationError) : undefined,
        describedBy,
      })}
      {help && <p id={helpId} className="text-xs text-em-text-secondary">{help}</p>}
      {aiReview && (
        <div role="status" className="rounded-md border border-em-info-700/20 bg-em-info-100 px-3 py-2 text-xs text-em-info-700">
          {aiReview}
        </div>
      )}
      {validationError && (
        <p id={errorId} className="text-sm text-em-danger-700" role="alert">
          {t(validationError)}
        </p>
      )}
    </div>
  );
}

export function ProductTextInput(props: ComponentPropsWithoutRef<"input">) {
  return <input {...props} className={`${CONTROL_CLASS} ${props.className ?? ""}`} />;
}

export function ProductTextArea(props: ComponentPropsWithoutRef<"textarea">) {
  return <textarea {...props} className={`${CONTROL_CLASS} min-h-28 ${props.className ?? ""}`} />;
}

export function ProductSelect(props: ComponentPropsWithoutRef<"select">) {
  return <select {...props} className={`${CONTROL_CLASS} ${props.className ?? ""}`} />;
}
