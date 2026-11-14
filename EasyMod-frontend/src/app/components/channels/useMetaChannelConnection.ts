/**
 * useMetaChannelConnection — behaviour-preserving extraction of the OAuth /
 * health / consent / purpose-label logic that used to live inline in
 * ChatSettings.tsx (ADR-0013 §9, PROPOSED_ARCHITECTURE §4).
 *
 * Every state transition and side effect is ported verbatim from ChatSettings
 * so the legacy surface keeps byte-identical behaviour. This hook owns no
 * markup: ChatSettings renders it through ChannelConnectionManager, and the
 * redesigned ChannelsOverview / ChannelDetail reuse the per-channel actions.
 */
import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import {
  listMetaChannels,
  initiateMetaOAuth,
  handleMetaOAuthCallback,
  connectMetaAsset,
  pingMetaChannel,
  disconnectMetaChannel,
  reconnectMetaChannel,
  getMetaChannelConsentSummary,
  updateMetaChannelPurposeLabel,
  type MetaChannel,
  type MetaOAuthAsset,
  type MetaChannelConsentSummary,
} from "@/api/domains/meta-channels";
import { getMetaErrorMessage, extractMetaApiError } from "@/lib/meta/error-messages";
import { getErrorMessage } from "@shared/lib/http/errors";

export const OAUTH_NONCE_KEY = "easymod_oauth_nonce";

export interface ActiveOAuth {
  step: "connecting" | "page-select";
  reconnectChannelId?: string;
  reconnectAssetId?: string;
}

/** postMessage / BroadcastChannel payload from the OAuth callback page. */
interface OAuthMessagePayload {
  type?: string;
  code?: string;
  state?: string;
  error?: string;
}

export interface UseMetaChannelConnectionResult {
  channels: MetaChannel[];
  setChannels: Dispatch<SetStateAction<MetaChannel[]>>;
  isLoading: boolean;
  loadError: string | null;
  fetchChannels: () => Promise<boolean>;

  activeOAuth: ActiveOAuth | null;
  availablePages: MetaOAuthAsset[];
  selectedPageIds: Set<string>;
  isConnectingPage: boolean;
  handleConnect: () => Promise<void>;
  handleCancelOAuth: () => void;
  handleRetryOAuthAssetLookup: () => void;
  togglePageSelection: (pageId: string) => void;
  handleConnectPages: () => Promise<void>;

  testingId: string | null;
  disconnectingId: string | null;
  confirmDisconnect: MetaChannel | null;
  setConfirmDisconnect: Dispatch<SetStateAction<MetaChannel | null>>;
  handleTestPipeline: (channelId: string) => Promise<void>;
  handleDisconnect: (channel: MetaChannel) => Promise<void>;
  handleReconnect: (channel: MetaChannel) => Promise<void>;

  consentByChannelId: Record<string, MetaChannelConsentSummary>;
  expandedConsentChannelId: string | null;
  setExpandedConsentChannelId: Dispatch<SetStateAction<string | null>>;
  loadingConsentId: string | null;
  handleToggleConsent: (channelId: string) => Promise<void>;

  savingLabelId: string | null;
  handleSavePurposeLabel: (
    channelId: string,
    rawLabel: string,
    currentLabel: string | null,
  ) => Promise<void>;

  permissionsExpanded: boolean;
  setPermissionsExpanded: Dispatch<SetStateAction<boolean>>;
}

export function useMetaChannelConnection(): UseMetaChannelConnectionResult {
  const { t, i18n } = useTranslation();

  // Surface the *real* reason a Meta connect/callback failed. Shows a
  // merchant-friendly headline (mapped from the Meta error) plus the raw
  // backend message as a sub-line, and logs the full error for support/QA.
  const reportConnectError = (context: string, err: unknown) => {
    const { code, message } = extractMetaApiError(err);
    const lang = i18n.language?.startsWith("en") ? "en" : "bn";
    const friendly = getMetaErrorMessage(code, message, lang);
    console.error(`[Meta connect] ${context} failed`, { code, message, err });
    toast.error(friendly, message ? { description: message, duration: 12000 } : undefined);
  };

  const [channels, setChannels] = useState<MetaChannel[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [activeOAuth, setActiveOAuth] = useState<ActiveOAuth | null>(null);
  const [availablePages, setAvailablePages] = useState<MetaOAuthAsset[]>([]);
  const [selectedPageIds, setSelectedPageIds] = useState<Set<string>>(new Set());
  const [tempToken, setTempToken] = useState("");
  const [isConnectingPage, setIsConnectingPage] = useState(false);
  const oauthPopupRef = useRef<Window | null>(null);
  const oauthListenerRef = useRef<((e: MessageEvent) => void) | null>(null);
  const oauthInProgressRef = useRef(false);

  const [testingId, setTestingId] = useState<string | null>(null);
  const [disconnectingId, setDisconnectingId] = useState<string | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState<MetaChannel | null>(null);
  const [consentByChannelId, setConsentByChannelId] = useState<
    Record<string, MetaChannelConsentSummary>
  >({});
  const [expandedConsentChannelId, setExpandedConsentChannelId] = useState<string | null>(null);
  const [loadingConsentId, setLoadingConsentId] = useState<string | null>(null);
  const [permissionsExpanded, setPermissionsExpanded] = useState(false);
  const [savingLabelId, setSavingLabelId] = useState<string | null>(null);

  const handleSavePurposeLabel = async (
    channelId: string,
    rawLabel: string,
    currentLabel: string | null,
  ) => {
    const next = rawLabel.trim().slice(0, 64);
    const normalized = next.length === 0 ? null : next;
    if ((currentLabel ?? null) === normalized) return;

    try {
      setSavingLabelId(channelId);
      const updated = await updateMetaChannelPurposeLabel(channelId, normalized);
      setChannels((prev) => prev.map((c) => (c.id === channelId ? updated : c)));
      toast.success(
        normalized
          ? t("channels.label.updated", { label: normalized })
          : t("channels.label.cleared"),
      );
    } catch (error: unknown) {
      const msg = getErrorMessage(error, t("channels.label.updateFailed"));
      toast.error(msg);
    } finally {
      setSavingLabelId(null);
    }
  };

  const fetchChannels = async (): Promise<boolean> => {
    try {
      setIsLoading(true);
      setLoadError(null);
      const fetched = await listMetaChannels();
      setChannels(
        fetched.filter((c) => c.platform === "facebook" && c.status !== "DISCONNECTED"),
      );
      return true;
    } catch (error: unknown) {
      const { code, message } = extractMetaApiError(error);
      setLoadError(getMetaErrorMessage(code, message, "en"));
      return false;
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    const oauthError = sessionStorage.getItem("oauth_error");
    if (oauthError) {
      sessionStorage.removeItem("oauth_error");
      toast.error(oauthError);
    }
    fetchChannels();
    return () => {
      if (oauthListenerRef.current) {
        window.removeEventListener("message", oauthListenerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (activeOAuth?.step !== "connecting") return;
    const interval = setInterval(() => {
      if (oauthPopupRef.current?.closed) {
        clearInterval(interval);
        if (oauthListenerRef.current) {
          window.removeEventListener("message", oauthListenerRef.current);
          oauthListenerRef.current = null;
        }
        setActiveOAuth(null);
        oauthInProgressRef.current = false;
      }
    }, 500);
    return () => clearInterval(interval);
  }, [activeOAuth?.step]);

  // Single Facebook connect flow — one popup, then a multi-select page picker so
  // the merchant can connect one OR several Facebook Pages at once.
  const handleConnect = async () => {
    if (oauthInProgressRef.current) {
      toast.error(t("channels.errors.oauthInProgress"));
      return;
    }
    oauthInProgressRef.current = true;
    try {
      sessionStorage.removeItem("easymod_oauth_channel_id");
      const { redirectUrl } = await initiateMetaOAuth("facebook");

      try {
        const urlState = new URL(redirectUrl).searchParams.get("state");
        if (urlState) sessionStorage.setItem(OAUTH_NONCE_KEY, urlState);
      } catch {
        /* non-critical */
      }
      sessionStorage.setItem("easymod_oauth_channel_type", "facebook");

      oauthPopupRef.current = window.open(
        redirectUrl,
        "meta_oauth",
        "width=600,height=700,left=200,top=100",
      );
      setActiveOAuth({ step: "connecting" });

      const bc = new BroadcastChannel("easymod_oauth");
      const cleanup = () => {
        window.removeEventListener("message", handler);
        bc.close();
        oauthListenerRef.current = null;
        oauthInProgressRef.current = false;
      };

      const processPayload = (data: OAuthMessagePayload) => {
        if (data?.type === "OAUTH_SUCCESS") {
          const expectedNonce = sessionStorage.getItem(OAUTH_NONCE_KEY);
          sessionStorage.removeItem(OAUTH_NONCE_KEY);
          if (!expectedNonce || data.state !== expectedNonce) {
            toast.error(
              t(
                "channels.errors.oauthStateMismatch",
                "OAuth validation failed — please try again",
              ),
            );
            sessionStorage.removeItem("easymod_oauth_channel_id");
            setActiveOAuth(null);
            cleanup();
            return;
          }

          if (typeof data.code !== "string" || typeof data.state !== "string") {
            toast.error(t("channels.errors.connectionFailed", "সংযোগ ব্যর্থ"));
            setActiveOAuth(null);
            cleanup();
            return;
          }

          handleMetaOAuthCallback(data.code, data.state)
            .then((result) => {
              setAvailablePages(result.pages);
              setSelectedPageIds(new Set());
              setTempToken(result.tempToken);
              setActiveOAuth({ step: "page-select" });
            })
            .catch((err) => {
              reportConnectError("OAuth callback", err);
              setActiveOAuth(null);
            });
        } else if (data?.type === "OAUTH_ERROR") {
          sessionStorage.removeItem(OAUTH_NONCE_KEY);
          sessionStorage.removeItem("easymod_oauth_channel_id");
          toast.error(data.error || t("channels.errors.connectionFailed", "সংযোগ ব্যর্থ"));
          setActiveOAuth(null);
        }
        cleanup();
      };

      const handler = (e: MessageEvent) => {
        if (e.origin !== window.location.origin) return;
        if (oauthPopupRef.current && e.source !== oauthPopupRef.current) return;
        processPayload(e.data);
      };
      bc.onmessage = (e) => processPayload(e.data);
      oauthListenerRef.current = handler;
      window.addEventListener("message", handler);
    } catch {
      sessionStorage.removeItem(OAUTH_NONCE_KEY);
      sessionStorage.removeItem("easymod_oauth_channel_id");
      oauthInProgressRef.current = false;
      toast.error(t("channels.errors.oauthInitFailed", "সংযোগ শুরু করা যায়নি"));
    }
  };

  const handleCancelOAuth = () => {
    oauthPopupRef.current?.close();
    oauthInProgressRef.current = false;
    if (oauthListenerRef.current) {
      window.removeEventListener("message", oauthListenerRef.current);
      oauthListenerRef.current = null;
    }
    sessionStorage.removeItem(OAUTH_NONCE_KEY);
    sessionStorage.removeItem("easymod_oauth_channel_id");
    setActiveOAuth(null);
    setAvailablePages([]);
    setSelectedPageIds(new Set());
    setTempToken("");
  };

  const handleRetryOAuthAssetLookup = () => {
    handleCancelOAuth();
    setTimeout(() => void handleConnect(), 0);
  };

  const togglePageSelection = (pageId: string) => {
    const page = availablePages.find((candidate) => candidate.id === pageId);
    if (page?.connectable !== true) return;
    if (activeOAuth?.reconnectAssetId && pageId !== activeOAuth.reconnectAssetId) return;

    setSelectedPageIds((prev) => {
      const next = new Set(prev);
      if (next.has(pageId)) next.delete(pageId);
      else next.add(pageId);
      return next;
    });
  };

  const handleConnectPages = async () => {
    const pagesToConnect = availablePages.filter(
      (page) => selectedPageIds.has(page.id) && page.connectable === true,
    );
    if (!activeOAuth || pagesToConnect.length === 0) return;
    setIsConnectingPage(true);
    try {
      let webhookWarning: string | null = null;
      for (const page of pagesToConnect) {
        const result = await connectMetaAsset({
          assetId: page.id,
          displayName: page.name,
          tempToken,
          platform: "facebook",
        });
        if (result.webhookWarning) webhookWarning = result.webhookWarning;
      }
      const refreshed = await fetchChannels();
      if (!refreshed) {
        throw new Error(
          t(
            "channels.errors.refreshFailed",
            "The connection was saved, but the channel status could not be refreshed. Reload the page to verify.",
          ),
        );
      }
      sessionStorage.removeItem("easymod_oauth_channel_id");
      setActiveOAuth(null);
      setAvailablePages([]);
      setSelectedPageIds(new Set());
      setTempToken("");
      toast.success(t("channels.connectSuccess"));
      if (webhookWarning) {
        setTimeout(() => toast.warning(webhookWarning!, { duration: 12000 }), 500);
      }
    } catch (err) {
      reportConnectError("connect-asset", err);
    } finally {
      setIsConnectingPage(false);
    }
  };

  const handleTestPipeline = async (channelId: string) => {
    setTestingId(channelId);
    try {
      const result = await pingMetaChannel(channelId);
      if (result.ping.ok) {
        toast.success(t("channels.test.ok", { ms: result.ping.latencyMs ?? "?" }), {
          duration: 8000,
        });
      } else {
        toast.error(t("channels.test.failed", { error: result.ping.error }), {
          duration: 15000,
        });
      }
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, t("channels.test.error")));
    } finally {
      setTestingId(null);
    }
  };

  const handleDisconnect = async (channel: MetaChannel) => {
    setDisconnectingId(channel.id);
    try {
      await disconnectMetaChannel(channel.id);
      toast.success(t("channels.disconnectedNamed", { name: channel.displayName }));
      await fetchChannels();
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, t("channels.errors.disconnectFailed")));
    } finally {
      setDisconnectingId(null);
      setConfirmDisconnect(null);
    }
  };

  const handleReconnect = async (channel: MetaChannel) => {
    if (oauthInProgressRef.current) {
      toast.error(
        t(
          "channels.errors.oauthInProgress",
          "একটি সংযোগ ইতিমধ্যে চলছে। আগের সংযোগ শেষ করুন।",
        ),
      );
      return;
    }
    oauthInProgressRef.current = true;
    const reconnectChannelId = channel.id;
    try {
      const { redirectUrl, state } = await reconnectMetaChannel(channel.id);

      try {
        if (state) sessionStorage.setItem(OAUTH_NONCE_KEY, state);
      } catch {
        /* non-critical */
      }
      sessionStorage.setItem("easymod_oauth_channel_type", "facebook");
      sessionStorage.setItem("easymod_oauth_channel_id", reconnectChannelId);

      oauthPopupRef.current = window.open(
        redirectUrl,
        "meta_oauth",
        "width=600,height=700,left=200,top=100",
      );
      setActiveOAuth({ step: "connecting", reconnectChannelId });

      const bc = new BroadcastChannel("easymod_oauth");
      const cleanup = () => {
        window.removeEventListener("message", handler);
        bc.close();
        oauthListenerRef.current = null;
        oauthInProgressRef.current = false;
      };

      const processPayload = (data: OAuthMessagePayload) => {
        if (data?.type === "OAUTH_SUCCESS") {
          const expectedNonce = sessionStorage.getItem(OAUTH_NONCE_KEY);
          sessionStorage.removeItem(OAUTH_NONCE_KEY);
          if (!expectedNonce || data.state !== expectedNonce) {
            toast.error(
              t(
                "channels.errors.oauthStateMismatch",
                "OAuth validation failed — please try again",
              ),
            );
            sessionStorage.removeItem("easymod_oauth_channel_id");
            setActiveOAuth(null);
            cleanup();
            return;
          }

          if (typeof data.code !== "string" || typeof data.state !== "string") {
            toast.error(t("channels.errors.connectionFailed", "সংযোগ ব্যর্থ"));
            setActiveOAuth(null);
            cleanup();
            return;
          }

          handleMetaOAuthCallback(data.code, data.state)
            .then((result) => {
              setAvailablePages(result.pages);
              const reconnectAssetId = result.reconnectAssetId || channel.metaAssetId;
              const reconnectPage = result.pages.find((page) => page.id === reconnectAssetId);
              setSelectedPageIds(reconnectPage ? new Set([reconnectPage.id]) : new Set());
              setTempToken(result.tempToken);
              setActiveOAuth({ step: "page-select", reconnectChannelId, reconnectAssetId });
            })
            .catch((err) => {
              reportConnectError("OAuth callback", err);
              setActiveOAuth(null);
            });
        } else if (data?.type === "OAUTH_ERROR") {
          sessionStorage.removeItem(OAUTH_NONCE_KEY);
          sessionStorage.removeItem("easymod_oauth_channel_id");
          toast.error(data.error || t("channels.errors.connectionFailed", "সংযোগ ব্যর্থ"));
          setActiveOAuth(null);
        }
        cleanup();
      };

      const handler = (e: MessageEvent) => {
        if (e.origin !== window.location.origin) return;
        if (oauthPopupRef.current && e.source !== oauthPopupRef.current) return;
        processPayload(e.data);
      };
      bc.onmessage = (e) => processPayload(e.data);
      oauthListenerRef.current = handler;
      window.addEventListener("message", handler);
    } catch {
      sessionStorage.removeItem(OAUTH_NONCE_KEY);
      sessionStorage.removeItem("easymod_oauth_channel_id");
      oauthInProgressRef.current = false;
      toast.error(t("channels.errors.oauthInitFailed", "সংযোগ শুরু করা যায়নি"));
    }
  };

  const handleToggleConsent = async (channelId: string) => {
    if (expandedConsentChannelId === channelId) {
      setExpandedConsentChannelId(null);
      return;
    }
    setExpandedConsentChannelId(channelId);
    if (consentByChannelId[channelId]) return;
    setLoadingConsentId(channelId);
    try {
      const summary = await getMetaChannelConsentSummary(channelId);
      setConsentByChannelId((prev) => ({ ...prev, [channelId]: summary }));
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, t("channels.consent.loadFailed")));
      setExpandedConsentChannelId(null);
    } finally {
      setLoadingConsentId(null);
    }
  };

  return {
    channels,
    setChannels,
    isLoading,
    loadError,
    fetchChannels,
    activeOAuth,
    availablePages,
    selectedPageIds,
    isConnectingPage,
    handleConnect,
    handleCancelOAuth,
    handleRetryOAuthAssetLookup,
    togglePageSelection,
    handleConnectPages,
    testingId,
    disconnectingId,
    confirmDisconnect,
    setConfirmDisconnect,
    handleTestPipeline,
    handleDisconnect,
    handleReconnect,
    consentByChannelId,
    expandedConsentChannelId,
    setExpandedConsentChannelId,
    loadingConsentId,
    handleToggleConsent,
    savingLabelId,
    handleSavePurposeLabel,
    permissionsExpanded,
    setPermissionsExpanded,
  };
}