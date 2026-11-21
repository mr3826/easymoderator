/**
 * InboxComposer — Message input bar with attachments and quick replies.
 * Restyled to the guardrails --em-* scope. Send/attachment/idempotency/
 * template logic is verbatim; successPulse/errorShake motion removed (§19
 * duration bands), the composer input keeps its exact placeholders and gains
 * data-testid="message-input" for the shared-inbox proof locator.
 */
import { useRef, useState, ChangeEvent } from "react";
import {
  Send, Loader2, X, Paperclip, Zap, AlertTriangle, Search, Pencil,
  Trash2, Plus, Save, FileText, Image as ImageIcon, Package,
} from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import type { ResponseTemplate } from "@/api/types/conversation";
import type { Conversation, Message } from "@/api/types/conversation";
import type { Product } from "@/api/types/product";
import { apiClient } from "@/api";
import { getDenyMessage } from "@/lib/policy/deny-messages";
import { getErrorMessage } from "@shared/lib/http/errors";
import { EmButton } from "../dashboard/EmButton";

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-em-focus-light focus-visible:transition-none";

interface InboxComposerProps {
  selectedConversation: Conversation;
  is24hExpired: boolean;
  is24hWarning: boolean;
  interactionChoicesEnabled?: boolean;
  templates: ResponseTemplate[];
  quickReplyTemplates: ResponseTemplate[];
  loadingTemplates: boolean;
  planFeaturesAdvancedAI: boolean;
  onMessageSent: (message: Message) => void;
  onSendFailed?: () => void;
  onTemplatesChanged: () => Promise<void>;
}

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const SUPPORTED_ATTACHMENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "application/pdf",
  "text/plain",
  "text/csv",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

const emptyTemplateForm = { name: "", content: "", category: "Quick Reply" };

const fileToDataUrl = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("Attachment read failed"));
    reader.readAsDataURL(file);
  });

export function InboxComposer({
  selectedConversation,
  is24hExpired,
  is24hWarning,
  interactionChoicesEnabled = false,
  templates,
  quickReplyTemplates,
  loadingTemplates,
  onMessageSent,
  onSendFailed,
  onTemplatesChanged,
}: InboxComposerProps) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language === "bn" ? "bn" : "en";

  const [editingMessage, setEditingMessage] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [sendPhase, setSendPhase] = useState<"idle" | "uploading" | "sending">("idle");
  const [sendError, setSendError] = useState<string | null>(null);
  const [selectedAttachment, setSelectedAttachment] = useState<File | null>(null);
  const [showQuickReplies, setShowQuickReplies] = useState(false);
  const [quickSearch, setQuickSearch] = useState("");
  const [showTemplateManager, setShowTemplateManager] = useState(false);
  const [templateSearch, setTemplateSearch] = useState("");
  const [templateForm, setTemplateForm] = useState(emptyTemplateForm);
  const [editingTemplateId, setEditingTemplateId] = useState<string | null>(null);
  const [templateSaving, setTemplateSaving] = useState(false);
  const [deletingTemplateId, setDeletingTemplateId] = useState<string | null>(null);
  const [showProductPicker, setShowProductPicker] = useState(false);
  const [loadingProducts, setLoadingProducts] = useState(false);
  const [products, setProducts] = useState<Product[]>([]);
  const [productSearch, setProductSearch] = useState("");
  const [sendingProductId, setSendingProductId] = useState<string | null>(null);

  const isMessengerThread =
    selectedConversation.channel === "messenger" || selectedConversation.channel === "facebook";

  const handleToggleProductPicker = async () => {
    if (is24hExpired) return;
    const next = !showProductPicker;
    setShowProductPicker(next);
    if (!next) return;
    setLoadingProducts(true);
    try {
      const list = await apiClient.getProducts({ is_active: true, limit: 25 });
      setProducts(Array.isArray(list) ? list.filter((p) => p.is_active !== false) : []);
    } catch {
      setProducts([]);
    } finally {
      setLoadingProducts(false);
    }
  };

  const handleSendProductCard = async (product: Product) => {
    if (is24hExpired || sendingProductId) return;
    setSendingProductId(product.id);
    try {
      const idempotencyKey =
        typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : `card-${product.id}-${Date.now()}`;
      const sent = await apiClient.sendProductCard(
        selectedConversation.id,
        { product_id: product.id },
        { idempotencyKey },
      );
      setShowProductPicker(false);
      setProductSearch("");
      onMessageSent(sent);
      toast.success(t("inbox.composer.productCardSent"));
    } catch (error) {
      toast.error(getErrorMessage(error, t("inbox.composer.productCardFailed")));
      onSendFailed?.();
    } finally {
      setSendingProductId(null);
    }
  };

  const filteredProducts = products.filter((p) =>
    p.name.toLowerCase().includes(productSearch.trim().toLowerCase()),
  );

  const fileInputRef = useRef<HTMLInputElement>(null);
  const quickReplyRef = useRef<HTMLDivElement>(null);
  const isSendingRef = useRef(false);
  const attachmentIdentityRef = useRef(new WeakMap<File, string>());
  const retryIdempotencyKeysRef = useRef(new Map<string, string>());

  const identityForAttachment = (file: File) => {
    let identity = attachmentIdentityRef.current.get(file);
    if (!identity) {
      identity = typeof globalThis.crypto?.randomUUID === "function"
        ? globalThis.crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      attachmentIdentityRef.current.set(file, identity);
    }
    return identity;
  };

  const filteredQuickTemplates = quickReplyTemplates.filter((template) => {
    const query = quickSearch.trim().toLowerCase();
    if (!query) return true;
    return `${template.name} ${template.content} ${template.category || ""}`.toLowerCase().includes(query);
  });

  const filteredManagedTemplates = templates.filter((template) => {
    const query = templateSearch.trim().toLowerCase();
    if (!query) return true;
    return `${template.name} ${template.content} ${template.category || ""}`.toLowerCase().includes(query);
  });

  const handleAttachmentClear = () => {
    setSelectedAttachment(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleAttachmentPick = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] || null;
    if (!file) return;
    if (!SUPPORTED_ATTACHMENT_TYPES.has(file.type)) {
      toast.error("Messenger cannot send this file type. Use an image, PDF, document, CSV, or text file.");
      event.target.value = "";
      return;
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      toast.error("Attachment must be 25MB or smaller for Messenger.");
      event.target.value = "";
      return;
    }
    setSelectedAttachment(file);
  };

  const handleSendMessage = async () => {
    const trimmed = editingMessage.trim();
    const hasAttachment = !!selectedAttachment;
    if (!selectedConversation || (!trimmed && !hasAttachment) || isSendingRef.current) return;
    isSendingRef.current = true;
    if (is24hExpired) {
      toast.error(t("inbox.errors.outsideWindowDisabled"));
      isSendingRef.current = false;
      return;
    }
    try {
      setIsSending(true);
      setSendError(null);
      let messageType: "text" | "image" | "file" | "location" = "text";
      let metadata: Record<string, unknown> | undefined;
      let content = trimmed;

      if (selectedAttachment) {
        setSendPhase("uploading");
        const dataUrl = await fileToDataUrl(selectedAttachment);
        const isImage = selectedAttachment.type.startsWith("image/");
        messageType = isImage ? "image" : "file";
        metadata = {
          message_type: messageType,
          file_name: selectedAttachment.name,
          mime_type: selectedAttachment.type,
          file_size: selectedAttachment.size,
          file_data_url: dataUrl,
          delivery_status: "pending",
        };
        if (!content) content = selectedAttachment.name;
      }

      setSendPhase("sending");
      const draftFingerprint = JSON.stringify([
        selectedConversation.id,
        content,
        messageType,
        selectedAttachment ? identityForAttachment(selectedAttachment) : null,
      ]);
      let idempotencyKey = retryIdempotencyKeysRef.current.get(draftFingerprint);
      if (!idempotencyKey) {
        idempotencyKey = typeof globalThis.crypto?.randomUUID === "function"
        ? globalThis.crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        retryIdempotencyKeysRef.current.set(draftFingerprint, idempotencyKey);
        if (retryIdempotencyKeysRef.current.size > 10) {
          const oldest = retryIdempotencyKeysRef.current.keys().next().value;
          if (oldest) retryIdempotencyKeysRef.current.delete(oldest);
        }
      }
      const message = await apiClient.createMessage(selectedConversation.id, {
        content,
        sender: "agent",
        message_type: messageType,
        ...(metadata ? { metadata } : {}),
      }, { idempotencyKey });
      retryIdempotencyKeysRef.current.delete(draftFingerprint);
      onMessageSent(message);
      setEditingMessage("");
      handleAttachmentClear();
    } catch (err: unknown) {
      onSendFailed?.();
      const rawMsg = getErrorMessage(err, "");
      const friendly = getDenyMessage(rawMsg || "error", lang as "bn" | "en");
      setSendError(friendly);
      toast.error(friendly);
    } finally {
      isSendingRef.current = false;
      setIsSending(false);
      setSendPhase("idle");
    }
  };

  const resolveTemplateContent = (template: ResponseTemplate): string => {
    const customerName = selectedConversation?.customer?.name || "Customer";
    return template.content
      .replace(/\{\{\s*customer_name\s*\}\}/g, customerName)
      .replace(/\{\{\s*name\s*\}\}/g, customerName);
  };

  const handleTemplateInsert = (template: ResponseTemplate) => {
    const rendered = resolveTemplateContent(template).trim();
    if (!rendered) return;
    setEditingMessage(rendered);
    setShowQuickReplies(false);
  };

  const resetTemplateForm = () => {
    setTemplateForm(emptyTemplateForm);
    setEditingTemplateId(null);
  };

  const handleEditTemplate = (template: ResponseTemplate) => {
    setEditingTemplateId(template.id);
    setTemplateForm({
      name: template.name,
      content: template.content,
      category: template.category || "Quick Reply",
    });
  };

  const handleSaveTemplate = async () => {
    const name = templateForm.name.trim();
    const content = templateForm.content.trim();
    if (!name || !content) {
      toast.error("Add a quick reply name and message before saving.");
      return;
    }
    try {
      setTemplateSaving(true);
      if (editingTemplateId) {
        await apiClient.updateTemplate(editingTemplateId, {
          name,
          content,
          category: templateForm.category.trim() || "Quick Reply",
          is_active: true,
        });
      } else {
        await apiClient.createTemplate({
          name,
          content,
          category: templateForm.category.trim() || "Quick Reply",
          variables: [],
          is_active: true,
        });
      }
      await onTemplatesChanged();
      resetTemplateForm();
      toast.success("Quick reply saved.");
    } catch (err: unknown) {
      toast.error((err as { message?: string })?.message || "Quick reply could not be saved.");
    } finally {
      setTemplateSaving(false);
    }
  };

  const handleDeleteTemplate = async (templateId: string) => {
    try {
      setDeletingTemplateId(templateId);
      await apiClient.deleteTemplate(templateId);
      await onTemplatesChanged();
      if (editingTemplateId === templateId) resetTemplateForm();
      toast.success("Quick reply deleted.");
    } catch (err: unknown) {
      toast.error((err as { message?: string })?.message || "Quick reply could not be deleted.");
    } finally {
      setDeletingTemplateId(null);
    }
  };

  const sendLabel = sendPhase === "uploading" ? "Uploading" : sendPhase === "sending" ? t("inbox.sending") : t("inbox.send");

  return (
    <div className="bg-em-bg-surface border-t border-em-border p-4 shrink-0">
      {(is24hWarning || is24hExpired) && (
        <div className={`mb-3 flex items-start gap-2 rounded-lg border px-3 py-2 text-sm ${
          is24hExpired
            ? "border-em-danger-700/20 bg-em-danger-100 text-em-danger-700"
            : "border-em-sunlight-600/30 bg-em-sunlight-100 text-em-sunlight-700"
        }`}>
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden="true" />
          <span>{is24hExpired ? t("inbox.outsideWindowDisabled") : t("inbox.windowWarning")}</span>
        </div>
      )}
      {selectedAttachment && (
        <div className="mb-3 inline-flex items-center gap-2 rounded-lg border border-em-info-700/20 bg-em-info-100 px-3 py-2 text-sm text-em-info-700">
          {selectedAttachment.type.startsWith("image/") ? <ImageIcon className="w-4 h-4" aria-hidden="true" /> : <FileText className="w-4 h-4" aria-hidden="true" />}
          <span className="max-w-56 truncate">{selectedAttachment.name}</span>
          <button
            onClick={handleAttachmentClear}
            className={`min-h-11 min-w-11 inline-flex items-center justify-center text-em-info-700 hover:text-em-midnight-900 ${FOCUS_RING}`}
            aria-label="Remove attachment"
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>
      )}
      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        accept="image/jpeg,image/png,image/gif,image/webp,application/pdf,text/plain,text/csv,.doc,.docx,.xls,.xlsx"
        onChange={handleAttachmentPick}
      />
      {sendError && (
        <div
          role="alert"
          className="mb-3 text-sm text-em-danger-700 flex items-center gap-1"
        >
          <AlertTriangle className="w-4 h-4 flex-shrink-0" aria-hidden="true" />
          <span>{sendError}</span>
        </div>
      )}

      <div className="flex items-center gap-2 md:gap-3 relative">
        {showQuickReplies && (
          <div
            ref={quickReplyRef}
            className="absolute bottom-full left-0 mb-2 w-80 max-w-[calc(100vw-2rem)] bg-em-bg-surface border border-em-border rounded-lg shadow-xl z-20 overflow-hidden"
          >
            <div className="px-3 py-2 border-b border-em-border bg-em-bg-muted flex items-center justify-between gap-2">
              <span className="text-xs font-semibold text-em-text-secondary">{t("inbox.composer.quickReplies")}</span>
              <button
                onClick={() => setShowTemplateManager(true)}
                className={`min-h-11 text-xs text-em-violet-700 hover:text-em-violet-900 font-medium ${FOCUS_RING}`}
              >
                {t("inbox.composer.manageQuickReplies")}
              </button>
              <button
                onClick={() => setShowQuickReplies(false)}
                className={`min-h-11 min-w-11 inline-flex items-center justify-center text-em-text-secondary hover:text-em-text-primary ${FOCUS_RING}`}
                aria-label={t("inbox.composer.closeQuickReplies")}
              >
                <X className="w-3 h-3" aria-hidden="true" />
              </button>
            </div>
            <div className="p-2 border-b border-em-border">
              <div className="relative">
                <Search className="w-4 h-4 absolute left-2 top-3.5 text-em-text-disabled" aria-hidden="true" />
                <input
                  value={quickSearch}
                  onChange={(e) => setQuickSearch(e.target.value)}
                  placeholder={t("inbox.composer.searchQuickReplies")}
                  className={`w-full min-h-11 pl-8 pr-3 py-2 text-sm border border-em-border rounded-lg bg-em-bg-surface text-em-text-primary focus:outline-none ${FOCUS_RING}`}
                />
              </div>
            </div>
            <div className="max-h-56 overflow-y-auto divide-y divide-em-border">
              {loadingTemplates && (
                <div className="px-3 py-2 text-xs text-em-text-secondary">{t("inbox.composer.loadingQuickReplies")}</div>
              )}
              {filteredQuickTemplates.map((template) => (
                <button
                  key={template.id}
                  onClick={() => handleTemplateInsert(template)}
                  className={`w-full text-left px-3 py-2.5 text-sm text-em-text-primary hover:bg-em-violet-50 hover:text-em-violet-700 transition-colors leading-snug ${FOCUS_RING}`}
                >
                  <div className="font-medium text-em-text-primary">{template.name}</div>
                  <div className="line-clamp-2 text-xs text-em-text-secondary mt-1">{template.content}</div>
                </button>
              ))}
              {!loadingTemplates && filteredQuickTemplates.length === 0 && (
                <div className="px-3 py-3 text-xs text-em-text-secondary">No quick replies yet. Save common delivery, payment, and order answers here.</div>
              )}
            </div>
          </div>
        )}

        <button
          onClick={() => setShowQuickReplies((v) => !v)}
          title={t("inbox.composer.quickReplies")}
          aria-label={t("inbox.composer.quickReplies")}
          className={`p-2.5 text-em-sunlight-600 hover:text-em-sunlight-700 hover:bg-em-sunlight-50 border border-em-border-strong rounded-lg transition-colors flex-shrink-0 min-h-[44px] min-w-[44px] flex items-center justify-center ${FOCUS_RING}`}
        >
          <Zap className="w-4 h-4" aria-hidden="true" />
        </button>
        <button
          onClick={() => fileInputRef.current?.click()}
          title={t("inbox.composer.attachFile")}
          aria-label={t("inbox.composer.attachFile")}
          className={`p-2.5 text-em-text-secondary hover:text-em-violet-700 hover:bg-em-violet-50 border border-em-border-strong rounded-lg transition-colors flex-shrink-0 min-h-[44px] min-w-[44px] flex items-center justify-center ${FOCUS_RING}`}
        >
          <Paperclip className="w-4 h-4" aria-hidden="true" />
        </button>
        {interactionChoicesEnabled && isMessengerThread && (
          <div className="relative flex-shrink-0">
            <button
              type="button"
              data-testid="inbox-product-card-button"
              onClick={() => void handleToggleProductPicker()}
              disabled={is24hExpired}
              title={
                is24hExpired
                  ? t("inbox.composer.productCardWindowExpired")
                  : t("inbox.composer.sendProductCard")
              }
              aria-label={t("inbox.composer.sendProductCard")}
              className={`p-2.5 text-em-text-secondary hover:text-em-violet-700 hover:bg-em-violet-50 border border-em-border-strong rounded-lg transition-colors min-h-[44px] min-w-[44px] flex items-center justify-center disabled:opacity-50 disabled:cursor-not-allowed ${FOCUS_RING}`}
            >
              <Package className="w-4 h-4" aria-hidden="true" />
            </button>
            {showProductPicker && (
              <div
                data-testid="inbox-product-card-popover"
                role="dialog"
                aria-label={t("inbox.composer.productCardTitle")}
                className="absolute bottom-full left-0 mb-2 w-80 bg-em-bg-surface border border-em-border rounded-xl shadow-lg z-30 overflow-hidden"
              >
                <div className="px-3 py-2.5 border-b border-em-border flex items-center justify-between">
                  <span className="text-xs font-semibold text-em-text-secondary uppercase">
                    {t("inbox.composer.productCardTitle")}
                  </span>
                  <button
                    type="button"
                    onClick={() => setShowProductPicker(false)}
                    className={`min-h-8 min-w-8 inline-flex items-center justify-center text-em-text-secondary hover:text-em-text-primary ${FOCUS_RING}`}
                    aria-label="Close product card picker"
                  >
                    <X className="w-4 h-4" aria-hidden="true" />
                  </button>
                </div>
                <div className="p-2 border-b border-em-border">
                  <input
                    type="text"
                    value={productSearch}
                    onChange={(e) => setProductSearch(e.target.value)}
                    placeholder={t("inbox.composer.productCardSearch")}
                    className={`w-full min-h-10 px-3 py-1.5 text-sm border border-em-border-strong rounded-lg bg-em-bg-surface text-em-text-primary focus:outline-none ${FOCUS_RING}`}
                  />
                </div>
                <div className="max-h-60 overflow-y-auto divide-y divide-em-border">
                  {loadingProducts && (
                    <div className="px-3 py-3 text-xs text-em-text-secondary">
                      {t("inbox.composer.loadingQuickReplies")}
                    </div>
                  )}
                  {!loadingProducts && filteredProducts.length === 0 && (
                    <div className="px-3 py-3 text-xs text-em-text-secondary">
                      {t("inbox.composer.productCardEmpty")}
                    </div>
                  )}
                  {!loadingProducts &&
                    filteredProducts.map((product) => (
                      <div
                        key={product.id}
                        className="px-3 py-2.5 flex items-center justify-between gap-2"
                      >
                        <div className="min-w-0">
                          <div className="text-sm font-medium text-em-text-primary truncate">
                            {product.name}
                          </div>
                          <div className="text-xs text-em-text-secondary">
                            ৳{Number(product.price)}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => void handleSendProductCard(product)}
                          disabled={sendingProductId === product.id}
                          className={`min-h-9 px-3 py-1.5 text-xs font-medium bg-em-violet-600 text-white rounded-lg hover:bg-em-violet-700 disabled:opacity-50 ${FOCUS_RING}`}
                        >
                          {sendingProductId === product.id ? "..." : t("inbox.composer.productCardSend")}
                        </button>
                      </div>
                    ))}
                </div>
              </div>
            )}
          </div>
        )}
        <input
          type="text"
          data-testid="message-input"
          value={editingMessage}
          onChange={(e) => setEditingMessage(e.target.value)}
          placeholder={is24hExpired ? t("inbox.outsideWindowPlaceholder") : t("inbox.messagePlaceholder")}
          disabled={is24hExpired}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSendMessage();
            }
          }}
          className={`flex-1 min-h-11 px-4 py-3 border border-em-border-strong rounded-lg bg-em-bg-surface text-sm text-em-text-primary placeholder:text-em-text-disabled focus:outline-none ${FOCUS_RING} ${
            is24hExpired ? "bg-em-bg-muted cursor-not-allowed" : ""
          }`}
        />
        <EmButton
          variant="secondary"
          onClick={handleSendMessage}
          aria-label={isSending ? sendLabel : t("inbox.send")}
          loading={isSending}
          disabled={
            isSending ||
            (!editingMessage.trim() && !selectedAttachment) ||
            is24hExpired
          }
          data-testid="inbox-send"
          className="flex-shrink-0 justify-center gap-2 px-4 md:px-6"
        >
          {!isSending && <Send className="w-4 h-4" aria-hidden="true" />}
          <span className="hidden sm:inline">{sendLabel}</span>
        </EmButton>
      </div>

      {showTemplateManager && (
        <div
          className="fixed inset-0 bg-em-midnight-950/50 z-50 flex justify-end"
          onClick={(event) => {
            if (event.target === event.currentTarget) setShowTemplateManager(false);
          }}
        >
          <div className="h-full w-full max-w-lg bg-em-bg-surface shadow-2xl flex flex-col">
            <div className="px-5 py-4 border-b border-em-border flex items-center justify-between">
              <h2 className="text-base font-semibold text-em-text-primary">{t("inbox.composer.manageQuickReplies")}</h2>
              <button
                onClick={() => setShowTemplateManager(false)}
                className={`min-h-11 min-w-11 inline-flex items-center justify-center text-em-text-secondary hover:text-em-text-primary ${FOCUS_RING}`}
                aria-label="Close quick reply manager"
              >
                <X className="w-5 h-5" aria-hidden="true" />
              </button>
            </div>
            <div className="p-5 border-b border-em-border space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <input
                  value={templateForm.name}
                  onChange={(e) => setTemplateForm((prev) => ({ ...prev, name: e.target.value }))}
                  placeholder={t("inbox.composer.quickReplyName")}
                  className={`min-h-11 px-3 py-2 border border-em-border-strong rounded-lg bg-em-bg-surface text-sm text-em-text-primary focus:outline-none ${FOCUS_RING}`}
                />
                <input
                  value={templateForm.category}
                  onChange={(e) => setTemplateForm((prev) => ({ ...prev, category: e.target.value }))}
                  placeholder="Category"
                  className={`min-h-11 px-3 py-2 border border-em-border-strong rounded-lg bg-em-bg-surface text-sm text-em-text-primary focus:outline-none ${FOCUS_RING}`}
                />
              </div>
              <textarea
                value={templateForm.content}
                onChange={(e) => setTemplateForm((prev) => ({ ...prev, content: e.target.value }))}
                placeholder={t("inbox.composer.quickReplyMessage")}
                rows={4}
                className={`w-full px-3 py-2 border border-em-border-strong rounded-lg bg-em-bg-surface text-sm text-em-text-primary focus:outline-none ${FOCUS_RING}`}
              />
              <div className="flex flex-wrap items-center gap-2">
                <EmButton
                  variant="primary"
                  onClick={handleSaveTemplate}
                  disabled={templateSaving}
                  loading={templateSaving}
                  className="gap-2"
                >
                  {!templateSaving && (editingTemplateId ? <Save className="w-4 h-4" aria-hidden="true" /> : <Plus className="w-4 h-4" aria-hidden="true" />)}
                  {editingTemplateId ? "Save" : "Create"}
                </EmButton>
                {editingTemplateId && (
                  <EmButton variant="secondary" onClick={resetTemplateForm}>
                    Cancel
                  </EmButton>
                )}
              </div>
            </div>
            <div className="p-5 border-b border-em-border">
              <div className="relative">
                <Search className="w-4 h-4 absolute left-3 top-3.5 text-em-text-disabled" aria-hidden="true" />
                <input
                  value={templateSearch}
                  onChange={(e) => setTemplateSearch(e.target.value)}
                  placeholder={t("inbox.composer.searchQuickReplies")}
                  className={`w-full min-h-11 pl-9 pr-3 py-2 border border-em-border-strong rounded-lg bg-em-bg-surface text-sm text-em-text-primary focus:outline-none ${FOCUS_RING}`}
                />
              </div>
            </div>
            <div className="flex-1 overflow-y-auto divide-y divide-em-border">
              {filteredManagedTemplates.map((template) => (
                <div key={template.id} className="p-4 flex items-start gap-3">
                  <button
                    onClick={() => handleTemplateInsert(template)}
                    className={`flex-1 text-left min-w-0 ${FOCUS_RING}`}
                  >
                    <div className="text-sm font-semibold text-em-text-primary truncate">{template.name}</div>
                    <div className="text-xs text-em-text-secondary mt-0.5">{template.category || "Quick Reply"}</div>
                    <div className="text-sm text-em-text-primary mt-2 line-clamp-3">{template.content}</div>
                  </button>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => handleEditTemplate(template)}
                      className={`h-11 w-11 inline-flex items-center justify-center text-em-text-secondary hover:text-em-violet-700 hover:bg-em-violet-50 rounded-lg ${FOCUS_RING}`}
                      aria-label={`Edit ${template.name}`}
                    >
                      <Pencil className="w-4 h-4" aria-hidden="true" />
                    </button>
                    <button
                      onClick={() => handleDeleteTemplate(template.id)}
                      disabled={deletingTemplateId === template.id}
                      className={`h-11 w-11 inline-flex items-center justify-center text-em-text-secondary hover:text-em-danger-700 hover:bg-em-danger-100 rounded-lg disabled:opacity-50 ${FOCUS_RING}`}
                      aria-label={`Delete ${template.name}`}
                    >
                      {deletingTemplateId === template.id ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <Trash2 className="w-4 h-4" aria-hidden="true" />}
                    </button>
                  </div>
                </div>
              ))}
              {!loadingTemplates && filteredManagedTemplates.length === 0 && (
                <div className="p-5 text-sm text-em-text-secondary">{t("inbox.composer.noSavedQuickReplies")}</div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
