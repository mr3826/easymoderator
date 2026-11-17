import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Download, X } from "lucide-react";

/**
 * BeforeInstallPromptEvent is not in the standard lib DOM types.
 */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const DISMISS_KEY = "easymod_install_dismissed";

/**
 * "Install app" banner — captures the browser's beforeinstallprompt and offers
 * a one-tap install. BD sellers are phone-only on patchy networks, so an
 * installed (offline-tolerant) app feels like a real app and aids retention.
 *
 * Shows only when the browser deems the PWA installable and the user hasn't
 * dismissed it. Hidden once installed or when running standalone.
 */
export default function InstallPrompt() {
  const { t } = useTranslation();
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    // Already installed / launched from home screen → never show.
    const standalone =
      window.matchMedia?.("(display-mode: standalone)").matches ||
      // iOS Safari
      (window.navigator as unknown as { standalone?: boolean }).standalone === true;
    if (standalone) return;
    if (localStorage.getItem(DISMISS_KEY) === "1") return;

    const onBeforeInstall = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
      setVisible(true);
    };
    const onInstalled = () => {
      setVisible(false);
      setDeferred(null);
    };

    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const install = async () => {
    if (!deferred) return;
    await deferred.prompt();
    try {
      await deferred.userChoice;
    } finally {
      setVisible(false);
      setDeferred(null);
    }
  };

  const dismiss = () => {
    localStorage.setItem(DISMISS_KEY, "1");
    setVisible(false);
  };

  if (!visible) return null;

  return (
    <div className="fixed bottom-20 md:bottom-4 left-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 rounded-2xl border border-em-border bg-em-bg-surface p-4 shadow-lg">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-em-violet-100 text-em-violet-700">
          <Download className="h-5 w-5" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-em-text-primary">
            {t("pwa.installTitle", "Install EasyModerator")}
          </p>
          <p className="text-xs text-em-text-secondary">
            {t("pwa.installSubtitle", "Add to your home screen for faster, app-like access.")}
          </p>
        </div>
        <button
          type="button"
          onClick={install}
          className="shrink-0 min-h-11 rounded-lg bg-em-violet-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-em-violet-700 focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-em-focus-light focus-visible:transition-none"
        >
          {t("pwa.install", "Install")}
        </button>
        <button
          type="button"
          onClick={dismiss}
          aria-label={t("pwa.dismiss", "Dismiss")}
          className="shrink-0 min-h-11 min-w-11 inline-flex items-center justify-center text-em-text-secondary hover:text-em-text-primary focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-em-focus-light focus-visible:transition-none"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
