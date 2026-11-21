/**
 * Maps Meta API error codes / error string patterns to merchant-friendly text.
 * The user-facing copy is translated at CALL TIME via the i18n singleton so the
 * language always tracks the user's current selection (never frozen).
 *
 * Usage:
 *   import { getMetaErrorMessage } from '@/lib/meta/error-messages';
 *   const msg = getMetaErrorMessage(errorCode, rawMessage, 'bn');
 */
import i18n from "@/i18n";

interface MetaErrorMapping {
  /** Meta error code (number) or substring pattern (string) in the raw message */
  match: number | string;
  /** i18n key (under the `errors.meta.*` namespace) resolved at call time */
  key: string;
  /**
   * Inline merchant copy used ONLY while the i18n key above has no locale
   * entry (locale files are owned by a separate stream). `i18n.t` prefers the
   * real translation as soon as the key lands, so adding the key later needs
   * no change here.
   */
  fallback?: { en: string; bn: string };
}

const META_ERROR_MAPPINGS: MetaErrorMapping[] = [
  // Token / auth errors
  { match: 190, key: "errors.meta.tokenExpired" },
  { match: 200, key: "errors.meta.needsMessageAccess" },
  { match: 102, key: "errors.meta.sessionInvalid" },
  // Page not found
  { match: 100, key: "errors.meta.pageNotFound" },
  // Rate limiting
  { match: 4, key: "errors.meta.tooManyRequests" },
  { match: 17, key: "errors.meta.dailyLimitReached" },
  // Permission errors (string patterns)
  { match: "token expired", key: "errors.meta.tokenExpired" },
  { match: "insufficient permission", key: "errors.meta.needsMessageAccess" },
  { match: "page not found", key: "errors.meta.pageNotFound" },
  { match: "rate limit", key: "errors.meta.tooManyRequests" },
  { match: "revoked", key: "errors.meta.accessRevoked" },
  { match: "disconnected", key: "errors.meta.channelDisconnected" },
  { match: "webhook", key: "errors.meta.webhookFailed" },
  { match: "META_PAGE_TASKS_REQUIRED", key: "errors.meta.pageTasksRequired" },
  { match: "META_PAGE_DISCOVERY_FAILED", key: "errors.meta.pageDiscoveryFailed" },
  // D7: stable backend codes whose raw sentence was shown untranslated.
  {
    match: "META_ASSET_ALREADY_CONNECTED",
    key: "errors.meta.assetAlreadyConnected",
    fallback: {
      en: "This Facebook Page is already connected to another EasyModerator shop. Disconnect it there first, or contact support to release the old connection.",
      bn: "এই Facebook Page টি ইতিমধ্যে অন্য EasyModerator shop-এর সাথে সংযুক্ত আছে। আগে সেখান থেকে disconnect করুন, অথবা পুরনো সংযোগ মুক্ত করতে সাপোর্টে যোগাযোগ করুন।",
    },
  },
  {
    match: "META_RECONNECT_TARGET_MISMATCH",
    key: "errors.meta.reconnectTargetMismatch",
    fallback: {
      en: "This reconnect no longer matches the Page it was started from. Close the popup and start the reconnect again from that Page's channel card.",
      bn: "এই reconnect আগের Page-এর সাথে আর মেলছে না। পপআপ বন্ধ করে ওই Page-এর channel কার্ড থেকে আবার reconnect শুরু করুন।",
    },
  },
];

/** Normalised error extracted from an Axios error, regardless of backend shape. */
export interface ExtractedApiError {
  /** Numeric Meta error code or stable backend code, when present. */
  code: number | string | null;
  /** Raw backend/Meta error message — the actual reason a request failed. */
  message: string | null;
}

/**
 * Pull the real error message out of an Axios error, handling BOTH backend
 * response shapes:
 *   - thrown AppError       → { success:false, message, code }      (top level)
 *   - validate() middleware → { success:false, error:{ message, details:[…] } }
 *
 * The OAuth/connect flow used to discard this entirely and show a generic
 * "সংযোগ ব্যর্থ" toast, which made every connection failure impossible to
 * diagnose. Use this so the true reason reaches the screen and the console.
 */
export function extractMetaApiError(err: unknown): ExtractedApiError {
  // The axios interceptor already collapsed the raw error into a
  // NormalizedApiError, so `.response` is gone and `details` is hoisted to the
  // top level. Read that shape first; the `.response` branch below still covers
  // errors raised before the interceptor (or by a bare axios call).
  const normalized = err as { details?: unknown; code?: unknown; message?: unknown } | undefined;
  const data = ((err as { response?: { data?: unknown } })?.response?.data ??
    (normalized?.details !== undefined ? { error: { details: normalized.details } } : undefined)) as
    | Record<string, unknown>
    | undefined;

  let message: string | null = null;

  if (data && typeof data === "object") {
    const nested = data.error as
      | { message?: unknown; code?: unknown; details?: Array<{ message?: unknown }> }
      | undefined;

    if (nested && typeof nested === "object") {
      if (Array.isArray(nested.details) && nested.details.length > 0) {
        message =
          nested.details
            .map((d) => (typeof d?.message === "string" ? d.message : null))
            .filter(Boolean)
            .join("; ") || null;
      }
      if (!message && typeof nested.message === "string") message = nested.message;
    }

    if (!message && typeof data.message === "string") message = data.message as string;
  }

  // Fall back to the Axios error's own message (network errors etc.)
  if (!message) {
    const axiosMsg = (err as { message?: unknown })?.message;
    if (typeof axiosMsg === "string") message = axiosMsg;
  }

  // Meta embeds its numeric code in the text as "(#100) …" — recover it so the
  // code-based mappings below can match.
  const rawCode =
    (data?.error as { code?: unknown } | undefined)?.code
    ?? data?.code
    ?? normalized?.code;
  let code: number | string | null = null;
  if (typeof rawCode === "number" && Number.isFinite(rawCode)) {
    code = rawCode;
  } else if (typeof rawCode === "string" && rawCode.trim()) {
    const trimmedCode = rawCode.trim();
    code = /^\d+$/.test(trimmedCode) ? Number(trimmedCode) : trimmedCode;
  }
  if (message) {
    const m = message.match(/\(#(\d+)\)/);
    if (m && code == null) code = Number(m[1]);
  }

  return { code, message };
}

/** Resolve a mapping to merchant copy; inline fallback only while the locale key is absent. */
function resolveMappingText(mapping: MetaErrorMapping, lang: "bn" | "en"): string {
  if (mapping.fallback) {
    return i18n.t(mapping.key, {
      lng: lang,
      defaultValue: mapping.fallback[lang === "bn" ? "bn" : "en"],
    });
  }
  return i18n.t(mapping.key, { lng: lang });
}

/**
 * Returns a merchant-friendly error message for a Meta API error.
 * @param code - Numeric Meta error code or stable backend code (optional)
 * @param rawMessage - Raw error string from API (optional)
 * @param lang - 'bn' (default) or 'en'
 */
export function getMetaErrorMessage(
  code?: number | string | null,
  rawMessage?: string | null,
  lang: "bn" | "en" = "bn"
): string {
  // Try numeric code match first
  if (code != null) {
    const numericCode = typeof code === "string" && /^\d+$/.test(code) ? Number(code) : code;
    const byCode = META_ERROR_MAPPINGS.find(
      (m) => typeof m.match === "number" && m.match === numericCode
    );
    if (byCode) return resolveMappingText(byCode, lang);

    const byStableCode = META_ERROR_MAPPINGS.find(
      (m) => typeof m.match === "string" && m.match.toUpperCase() === String(code).toUpperCase(),
    );
    if (byStableCode) return resolveMappingText(byStableCode, lang);
  }

  // Try string pattern match against raw message
  if (rawMessage) {
    const lower = rawMessage.toLowerCase();
    const byString = META_ERROR_MAPPINGS.find(
      (m) => typeof m.match === "string" && lower.includes(m.match.toLowerCase())
    );
    if (byString) return resolveMappingText(byString, lang);
  }

  // Default fallback
  return i18n.t("errors.meta.fallback", { lng: lang });
}
