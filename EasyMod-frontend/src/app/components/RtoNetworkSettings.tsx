import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { ShieldCheck, Loader2, ChevronDown, ChevronUp, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { apiClient } from "@/api";
import type { RtoNetworkSettings as Settings } from "@/api/domains/rto-shield";
import { useAuth } from "@/features/auth/AuthProvider";

/**
 * Network RTO / Fake-Order Shield participation panel.
 *
 * The shield gets stronger as more shops join: a phone that burns several shops becomes
 * a global fraud signal that protects everyone. Each shop controls whether it contributes
 * its (phone-only) delivery outcomes and whether it enforces the shared signal.
 *
 * Consent truth rules (A4-G3-05): a failed settings read is `unavailable`, never an
 * assumed enabled/disabled choice; toggles are disabled with a retry path. Changes are
 * owner/admin server-side (PUT /api/rto-shield/settings requireOwnerOrAdmin), so only
 * those roles may attempt a write here; other members see the stored state read-only.
 */
export default function RtoNetworkSettings() {
  const { t } = useTranslation();
  const { currentShop } = useAuth();
  const canManage = ["owner", "admin"].includes(String(currentShop?.role || "").toLowerCase());
  const [settings, setSettings] = useState<Settings | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "unavailable">("loading");
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState(false);

  const load = useCallback(() => {
    let active = true;
    setState("loading");
    apiClient
      .getRtoNetworkSettings()
      .then((s) => {
        if (!active) return;
        setSettings(s);
        setState("ready");
      })
      .catch(() => {
        if (!active) return;
        setSettings(null);
        setState("unavailable");
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => load(), [load]);

  const toggle = async (key: keyof Settings) => {
    if (!settings || saving || !canManage) return;
    const next = { ...settings, [key]: !settings[key] };
    setSettings(next);
    setSaving(true);
    try {
      const saved = await apiClient.updateRtoNetworkSettings({ [key]: next[key] });
      setSettings(saved);
      toast.success(t("rtoShield.settings.saved"));
    } catch {
      setSettings(settings); // revert
      toast.error(t("rtoShield.settings.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const Switch = ({ on, onClick, disabled }: { on: boolean; onClick: () => void; disabled?: boolean }) => (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={on}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
        on ? "bg-em-violet-600" : "bg-em-border-strong"
      } ${disabled ? "opacity-60" : ""}`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-em-bg-surface transition-transform ${
          on ? "translate-x-6" : "translate-x-1"
        }`}
      />
    </button>
  );

  return (
    <div className="mb-4 bg-em-bg-surface rounded-lg shadow-sm border border-em-border overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between gap-3 px-3 py-2.5 text-left"
      >
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="flex items-center justify-center w-8 h-8 shrink-0 rounded-lg bg-em-bg-muted">
            <ShieldCheck className="w-4 h-4 text-em-text-secondary" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-em-text-primary truncate">{t("rtoShield.settings.title")}</h3>
            <p className="text-xs text-em-text-secondary truncate">
              {state === "unavailable"
                ? t("rtoShield.settings.unavailable")
                : state === "loading"
                  ? t("common.loading")
                  : t("rtoShield.settings.subtitle")}
            </p>
          </div>
        </div>
        {open ? <ChevronUp className="w-4 h-4 text-em-text-secondary shrink-0" /> : <ChevronDown className="w-4 h-4 text-em-text-secondary shrink-0" />}
      </button>

      {open && (
        <div className="px-3 pb-3 border-t border-em-border">
          {state === "loading" ? (
            <div className="flex items-center gap-2 py-3 text-em-text-secondary text-sm">
              <Loader2 className="w-4 h-4 animate-spin" /> {t("common.loading")}
            </div>
          ) : state === "unavailable" ? (
            <div className="py-3 space-y-2" role="alert">
              <p className="text-sm text-em-text-primary flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-em-warning-700 shrink-0 mt-0.5" aria-hidden="true" />
                {t("rtoShield.settings.unavailableHelp")}
              </p>
              <button
                type="button"
                onClick={() => load()}
                data-testid="rto-settings-retry"
                className="px-3 py-1.5 rounded-lg bg-em-midnight-900 text-white text-sm font-medium"
              >
                {t("rtoShield.settings.retry")}
              </button>
            </div>
          ) : (
            <div className="space-y-3 pt-3">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-sm font-medium text-em-text-primary">{t("rtoShield.settings.enforceLabel")}</p>
                  <p className="text-xs text-em-text-secondary">{t("rtoShield.settings.enforceHelp")}</p>
                </div>
                <Switch on={Boolean(settings?.enforce)} onClick={() => toggle("enforce")} disabled={saving || !canManage} />
              </div>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-sm font-medium text-em-text-primary">{t("rtoShield.settings.contributeLabel")}</p>
                  <p className="text-xs text-em-text-secondary">{t("rtoShield.settings.contributeHelp")}</p>
                </div>
                <Switch on={Boolean(settings?.contribute)} onClick={() => toggle("contribute")} disabled={saving || !canManage} />
              </div>
              {!canManage && (
                <p className="text-xs text-em-text-secondary" data-testid="rto-settings-owner-only-note">
                  {t("rtoShield.settings.ownerOnly")}
                </p>
              )}
              <p className="text-xs text-em-text-secondary">{t("rtoShield.settings.privacyNote")}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
