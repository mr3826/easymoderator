import { useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import type { ChannelType } from "@/api/types/customer";
import { BDPhoneInput } from "@/shared/components/BDPhoneInput";
import { EmButton } from "../dashboard/EmButton";
import { useDialogFocus } from "../inbox/useDialogFocus";

type ManualCustomerChannel = Exclude<ChannelType, "instagram" | "messenger">;
const CHANNELS: ManualCustomerChannel[] = ["facebook", "telegram", "webchat", "manual"];

export function isDuplicateCustomerError(error: unknown): boolean {
  const candidate = error as { type?: string; statusCode?: number; code?: string; message?: string };
  return candidate?.statusCode === 409
    || candidate?.type === "CONFLICT"
    || /duplicate|unique|already exists|23505|ER_DUP_ENTRY/i.test(`${candidate?.code ?? ""} ${candidate?.message ?? ""}`);
}

export interface CustomerRecordDraft {
  name: string;
  phone: string;
  email: string;
  channel: ChannelType | "";
}

export interface CustomerRecordInitial {
  id?: string;
  name: string | null;
  phone?: string | null;
  number?: string | null;
  email?: string | null;
  channel?: ChannelType;
}

interface CustomerFormProps {
  mode: "create" | "edit";
  open: boolean;
  initial?: CustomerRecordInitial;
  saving: boolean;
  error: string | null;
  onClose: () => void;
  onSave: (draft: CustomerRecordDraft) => void;
}

export function CustomerRecordDialog({ mode, open, initial, saving, error, onClose, onSave }: CustomerFormProps) {
  const { t } = useTranslation();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<CustomerRecordDraft>({ name: "", phone: "", email: "", channel: "" });
  const editing = mode === "edit";

  useEffect(() => {
    if (!open) return;
    setDraft({
      name: initial?.name ?? "",
      phone: initial?.phone ?? initial?.number ?? "",
      email: initial?.email ?? "",
      channel: initial?.channel ?? "",
    });
  }, [mode, initial?.id, initial?.name, initial?.phone, initial?.number, initial?.email, initial?.channel, open]);

  useDialogFocus(dialogRef, open);

  if (!open) return null;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSave({ ...draft, name: draft.name.trim(), phone: draft.phone.trim(), email: draft.email.trim() });
  };

  const title = editing
    ? t("customers.editModal.title", { defaultValue: "Edit customer" })
    : t("customers.addModal.title");

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-em-midnight-950/60 p-4"
      onKeyDown={(event) => { if (event.key === "Escape") onClose(); }}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-2xl bg-em-bg-surface p-5 shadow-xl"
      >
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-lg font-bold text-em-text-primary">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("common.close")}
            className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg text-em-text-secondary hover:bg-em-bg-muted focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-em-focus-light"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>

        <form onSubmit={submit} className="space-y-3">
          <div>
            <label htmlFor="customer-name" className="mb-1 block text-sm font-semibold text-em-text-primary">
              {t("customers.addModal.name")} <span className="text-em-danger-700" aria-hidden="true">*</span>
            </label>
            <input
              id="customer-name"
              value={draft.name}
              onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
              placeholder={t("customers.addModal.namePlaceholder")}
              required
              maxLength={120}
              className="min-h-11 w-full rounded-lg border border-em-border-input bg-em-bg-surface px-3 py-2 text-sm text-em-text-primary focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-em-focus-light"
            />
          </div>

          <BDPhoneInput
            id="customer-phone"
            label={t("customers.addModal.phone")}
            value={draft.phone}
            onChange={(phone) => setDraft((current) => ({ ...current, phone }))}
            required
          />

          <div>
            <label htmlFor="customer-email" className="mb-1 block text-sm font-semibold text-em-text-primary">
              {t("customers.addModal.email")}
            </label>
            <input
              id="customer-email"
              type="email"
              value={draft.email}
              onChange={(event) => setDraft((current) => ({ ...current, email: event.target.value }))}
              placeholder={t("customers.addModal.emailPlaceholder")}
              maxLength={254}
              className="min-h-11 w-full rounded-lg border border-em-border-input bg-em-bg-surface px-3 py-2 text-sm text-em-text-primary focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-em-focus-light"
            />
          </div>

          {!editing && (
            <div>
              <label htmlFor="customer-channel" className="mb-1 block text-sm font-semibold text-em-text-primary">
                {t("customers.addModal.channel")} <span className="text-em-danger-700" aria-hidden="true">*</span>
              </label>
              <select
                id="customer-channel"
                value={draft.channel}
                onChange={(event) => setDraft((current) => ({ ...current, channel: event.target.value as ChannelType | "" }))}
                required
                className="min-h-11 w-full rounded-lg border border-em-border-input bg-em-bg-surface px-3 py-2 text-sm text-em-text-primary focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-em-focus-light"
              >
                <option value="">{t("customers.addModal.channelPlaceholder")}</option>
                {CHANNELS.map((channel) => (
                  <option key={channel} value={channel}>
                    {t(`customers.channels.${channel}`, { defaultValue: channel })}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs text-em-text-secondary">
                {t("customers.addModal.channelHelp", { defaultValue: "Instagram and Messenger customers are created from inbound conversations." })}
              </p>
            </div>
          )}

          {error && <p role="alert" className="rounded-lg border border-em-danger-700/20 bg-em-danger-100 p-3 text-sm text-em-danger-700">{error}</p>}

          <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="min-h-11 rounded-lg border border-em-border-strong bg-em-bg-surface px-4 text-sm font-semibold text-em-text-primary hover:bg-em-bg-muted focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-em-focus-light disabled:opacity-50"
            >
              {t("common.cancel")}
            </button>
            <EmButton variant="primary" loading={saving} disabled={!draft.name.trim() || !draft.phone.trim() || (!editing && !draft.channel)}>
              {editing ? t("common.save") : t("customers.addModal.createButton")}
            </EmButton>
          </div>
        </form>
      </div>
    </div>
  );
}

interface DeleteDialogProps {
  open: boolean;
  deleting: boolean;
  customerName?: string | null;
  onClose: () => void;
  onConfirm: () => void;
}

export function CustomerDeleteDialog({ open, deleting, customerName, onClose, onConfirm }: DeleteDialogProps) {
  const { t } = useTranslation();
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef, open);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-em-midnight-950/60 p-4"
      onKeyDown={(event) => { if (event.key === "Escape") onClose(); }}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={t("customers.deleteModal.title")}
        className="w-full max-w-md rounded-2xl bg-em-bg-surface p-5 shadow-xl"
      >
        <h2 className="mb-1 text-center text-lg font-bold text-em-text-primary">{t("customers.deleteModal.title")}</h2>
        <p className="mb-1 text-center text-sm text-em-text-secondary">
          {customerName
            ? t("customers.deleteModal.messageWithName", {
              name: customerName,
              defaultValue: `Delete ${customerName}? This action cannot be undone.`,
            })
            : t("customers.deleteModal.message")}
        </p>
        <p className="mb-4 text-center text-xs text-em-text-secondary">{t("customers.deleteModal.erasureNote")}</p>
        <div className="flex flex-col-reverse gap-2 sm:flex-row">
          <EmButton variant="secondary" onClick={onClose} disabled={deleting} className="flex-1">
            {t("common.cancel")}
          </EmButton>
          <EmButton variant="danger" onClick={onConfirm} disabled={deleting} loading={deleting} className="flex-1">
            {t("customers.deleteModal.deleteButton")}
          </EmButton>
        </div>
      </div>
    </div>
  );
}
