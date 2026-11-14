import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import PublicApp from "./app/PublicApp";
import { ErrorBoundary } from "./app/components/ErrorBoundary";
import { queryClient } from "./app/lib/queryClient";
import { initializeMarketingI18n } from "./i18n/marketing";
import type { AppLanguage } from "./i18n/language";
import "./styles/index.css";

if (import.meta.env.VITE_SENTRY_DSN) {
  void import("./sentry").then(({ initSentry }) => initSentry());
}

export function startMarketing(
  language: AppLanguage,
  resources: Awaited<ReturnType<typeof import("./i18n/publicLocale").loadPublicLocaleResources>>,
) {
  initializeMarketingI18n(language, resources);
  // The marketing entry is a separate React root from the merchant app
  // (main-app.tsx). Public surfaces consume react-query (the contract-derived
  // landing's useCommercialContract / claim decisions), so this root needs its
  // own QueryClientProvider — without it the apex crashed with
  // "No QueryClient set" (2026-11-15 production outage, fixed here).
  createRoot(document.getElementById("root")!).render(
    <QueryClientProvider client={queryClient}>
      <ErrorBoundary><PublicApp /></ErrorBoundary>
    </QueryClientProvider>,
  );
}
