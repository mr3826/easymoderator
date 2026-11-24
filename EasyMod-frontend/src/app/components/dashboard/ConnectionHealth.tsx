/**
 * Connection health (mission D7) — dashboard module (not the shell footer),
 * self-fetching its own two sources with INDEPENDENT loading/error state so a
 * slow or failing connection read never degrades the pulse core above it.
 *
 * Meta row authority: `listMetaChannels()` connection facts. Aggregate is the
 * WORST state across channels: reconnect-required > disconnected >
 * connected·unverified > connected·verified. A reconnect opens the real
 * server-issued OAuth redirect (POST /api/channels/meta/:id/reconnect →
 * redirectUrl; OAuthCallbackPage completes the round trip) — there is NO
 * auto-ping / test-webhook call anywhere here, and a failed fetch renders
 * Unavailable, never green.
 *
 * Courier row authority: `getDeliveryReadiness()` (the existing
 * GET /api/shop/delivery/readiness verdict). missing[] and missing_fields[]
 * are the SAME array — the count uses `missing` only and excludes
 * provider_not_active (the controller's own settings-row aggregation rule).
 * A8 MAJOR: the API genuinely distinguishes ACTIVE from READY — READY means
 * configured-but-not-active (can never dispatch), so it maps to the published
 * `connectedNotActive` label, NOT to the healthy "Ready" (which is ACTIVE
 * only). The missing-count rule is unchanged by that mapping.
 */
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Plug, Truck } from "lucide-react";
import { listMetaChannels, reconnectMetaChannel, type MetaChannel } from "@/api/domains/meta-channels";
import { getDeliveryReadiness, type DeliveryReadiness } from "@/api/domains/delivery";
import { EmButton } from "./EmButton";
import { SignalBadge } from "./SignalBadge";
import type { SignalKind } from "./types";

interface Read<T> { data: T | null; loading: boolean }

const RECONNECT_STATUSES = new Set(["TOKEN_EXPIRED", "REVOKED", "ERROR"]);
type MetaState = "connectedVerified" | "connectedUnverified" | "reconnectRequired" | "disconnected";

export const META_STATE_KEYS: Record<MetaState, { key: string; kind: SignalKind }> = {
  connectedVerified: { key: "dashboard.connections.connectedVerified", kind: "healthy" },
  connectedUnverified: { key: "dashboard.connections.connectedUnverified", kind: "review" },
  reconnectRequired: { key: "dashboard.connections.reconnectRequired", kind: "blocked" },
  disconnected: { key: "dashboard.connections.disconnected", kind: "attention" },
};

export function channelState(channel: MetaChannel): MetaState {
  if (channel.needsReconnect || RECONNECT_STATUSES.has(channel.status)) return "reconnectRequired";
  if (channel.status === "CONNECTED") {
    return channel.webhookLastVerifiedAt ? "connectedVerified" : "connectedUnverified";
  }
  return "disconnected";
}

const META_SEVERITY: MetaState[] = ["reconnectRequired", "disconnected", "connectedUnverified", "connectedVerified"];

/** Worst-state aggregate across channels; an empty list means none connected. */
export function aggregateMetaState(channels: MetaChannel[]): MetaState {
  if (channels.length === 0) return "disconnected";
  const states = channels.map(channelState);
  for (const candidate of META_SEVERITY) {
    if (states.includes(candidate)) return candidate;
  }
  return "disconnected";
}

/**
 * missing_fields is the same array under both names — never sum them.
 * provider_not_active is excluded per the controller's aggregation rule.
 */
export function courierMissingCount(readiness: DeliveryReadiness): number {
  const missing = Array.isArray(readiness.missing) ? readiness.missing : [];
  return missing.filter((field) => field !== "provider_not_active").length;
}

interface RowHeaderProps {
  icon: React.ReactNode;
  label: string;
  to: string;
  badge: { kind: SignalKind; label: string } | null;
}

const RowHeader = ({ icon, label, to, badge }: RowHeaderProps) => (
  <div className="flex flex-wrap items-center justify-between gap-2">
    <h3 className="flex min-w-0 items-center gap-2 text-sm font-semibold text-em-text-primary">
      <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-em-violet-100 text-em-violet-700" aria-hidden="true">{icon}</span>
      {/* The row label doubles as the verified settings destination — no
          fabricated caption strings (A2 sole-writer rule). */}
      <Link to={to} className="rounded truncate hover:text-em-violet-700 hover:underline">{label}</Link>
    </h3>
    {badge && <SignalBadge signal={badge} />}
  </div>
);

export function ConnectionHealth() {
  const { t } = useTranslation();
  const [meta, setMeta] = useState<Read<MetaChannel[]>>({ data: null, loading: true });
  const [courier, setCourier] = useState<Read<DeliveryReadiness>>({ data: null, loading: true });
  const [reconnectingId, setReconnectingId] = useState<string | null>(null);
  const [reconnectFailedFor, setReconnectFailedFor] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setMeta({ data: null, loading: true });
    setCourier({ data: null, loading: true });
    void Promise.allSettled([listMetaChannels(), getDeliveryReadiness()]).then(([metaResult, courierResult]) => {
      if (cancelled) return;
      setMeta(metaResult.status === "fulfilled" && Array.isArray(metaResult.value)
        ? { data: metaResult.value, loading: false }
        : { data: null, loading: false });
      setCourier(courierResult.status === "fulfilled" && courierResult.value
        ? { data: courierResult.value, loading: false }
        : { data: null, loading: false });
    });
    return () => { cancelled = true; };
  }, [nonce]);

  const handleReconnect = useCallback(async (channelId: string) => {
    setReconnectingId(channelId);
    setReconnectFailedFor(null);
    try {
      const result = await reconnectMetaChannel(channelId);
      if (result?.redirectUrl) {
        // Real OAuth hand-off: server-issued redirect, server-issued state.
        window.location.assign(result.redirectUrl);
        return;
      }
      setReconnectFailedFor(channelId);
    } catch {
      setReconnectFailedFor(channelId);
    } finally {
      setReconnectingId(null);
    }
  }, []);

  const pendingBadge = { kind: "pending" as SignalKind, label: t("dashboard.pulse.signal.pending") };
  const unavailableBadge = { kind: "blocked" as SignalKind, label: t("dashboard.connections.unavailable") };

  const channels = meta.data ?? [];
  const metaState = meta.data === null ? null : aggregateMetaState(channels);
  const metaBadge = meta.loading ? pendingBadge
    : meta.data === null ? unavailableBadge
    : { kind: META_STATE_KEYS[metaState!].kind, label: t(META_STATE_KEYS[metaState!].key) };

  const readiness = courier.data;
  const noProviders = readiness !== null && Array.isArray(readiness.providers) && readiness.providers.length === 0;
  const courierConnectedNotActive = Boolean(
    readiness && readiness.connected && !readiness.active && readiness.status === "SETUP_INCOMPLETE",
  );
  const missingCount = readiness ? courierMissingCount(readiness) : 0;

  let courierBadge: { kind: SignalKind; label: string } = pendingBadge;
  if (!courier.loading) {
    if (readiness === null) courierBadge = unavailableBadge;
    else if (noProviders) courierBadge = { kind: "attention", label: t("dashboard.connections.notSetUp") };
    else if (readiness.status === "ACTIVE") courierBadge = { kind: "healthy", label: t("dashboard.connections.ready") };
    // READY is a DISTINCT server state: credentials/store configured but the
    // integration is not active — it can never dispatch. Same honest label
    // as connected-but-inactive, never a green "Ready".
    else if (readiness.status === "READY") courierBadge = { kind: "attention", label: t("dashboard.connections.connectedNotActive") };
    else if (courierConnectedNotActive) courierBadge = { kind: "attention", label: t("dashboard.connections.connectedNotActive") };
    else courierBadge = { kind: "attention", label: t("dashboard.connections.setupIncomplete") };
  }

  const metaFailed = !meta.loading && meta.data === null;
  const courierFailed = !courier.loading && courier.data === null;

  return (
    <section className="mb-4 min-w-0 rounded-xl border border-em-border bg-em-bg-surface p-4" aria-labelledby="dashboard-connections-heading">
      <div className="mb-3">
        <h2 id="dashboard-connections-heading" className="text-lg font-semibold text-em-text-primary">
          {t("dashboard.connections.title")}
        </h2>
      </div>
      <div className="space-y-3">
        {/* Meta channels row */}
        <div className="rounded-xl border border-em-border bg-em-bg-app p-3" data-testid="connections-meta-row">
          <RowHeader
            icon={<Plug className="h-4 w-4" aria-hidden="true" />}
            label={t("dashboard.connections.metaRow")}
            to="/manage-shop/channels"
            badge={metaBadge}
          />
          {metaState !== null && channels.length > 0 && (
            <ul className="mt-2 space-y-1">
              {channels.map((channel) => {
                const state = channelState(channel);
                return (
                  <li key={channel.id} className="flex min-h-11 flex-wrap items-center justify-between gap-2 text-sm">
                    <span className="min-w-0 flex-1 truncate font-medium text-em-text-primary">{channel.displayName}</span>
                    <span className="text-xs text-em-text-secondary">{t(META_STATE_KEYS[state].key)}</span>
                    {state === "reconnectRequired" && (
                      <EmButton
                        variant="secondary"
                        className="px-3 text-xs"
                        loading={reconnectingId === channel.id}
                        onClick={() => void handleReconnect(channel.id)}
                        data-testid={`connection-reconnect-${channel.id}`}
                      >
                        {t("dashboard.connections.reconnect")}
                      </EmButton>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {reconnectFailedFor && (
            <p role="status" className="mt-2 text-xs font-medium text-em-warning-700">
              {t("dashboard.connections.reconnectFailed")}
            </p>
          )}
        </div>

        {/* Courier row */}
        <div className="rounded-xl border border-em-border bg-em-bg-app p-3" data-testid="connections-courier-row">
          <RowHeader
            icon={<Truck className="h-4 w-4" aria-hidden="true" />}
            label={t("dashboard.connections.courierRow")}
            to="/manage-shop/delivery-settings"
            badge={courierBadge}
          />
          {!courier.loading && readiness !== null && !noProviders && missingCount > 0 && (
            <p className="em-tabular mt-2 text-xs text-em-text-secondary">
              {t("dashboard.connections.missingCount", { count: missingCount })}
            </p>
          )}
        </div>

        {/* Independent retry for degraded reads (§16 error state). */}
        {(metaFailed || courierFailed) && (
          <EmButton variant="ghost" className="px-2 text-xs" onClick={() => setNonce((n) => n + 1)} data-testid="connections-retry">
            {t("dashboard.pulse.retry")}
          </EmButton>
        )}
      </div>
    </section>
  );
}
