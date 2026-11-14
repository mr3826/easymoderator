/**
 * useChannelSettingsSSE — scoped invalidation for the channel surfaces
 * (API_CONTRACT §8). The backend emits shop-scoped `channel_settings_changed`
 * and `emergency_stop_changed`; the channel pages re-read the affected
 * react-query keys instead of polling.
 */
import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { createSSEClient } from "@/api/sse-client";
import { authService } from "@/app/lib/auth";

export function useChannelSettingsSSE(): void {
  const queryClient = useQueryClient();
  const shopId = authService.getCurrentShopId?.() ?? null;

  useEffect(() => {
    // EventSource is absent in SSR/unit environments; invalidation is a
    // progressive enhancement over the initial fetch.
    if (!shopId || typeof EventSource === "undefined") return;

    const client = createSSEClient({ shopId });
    client.on<{ channel_id?: string }>("channel_settings_changed", (data) => {
      void queryClient.invalidateQueries({ queryKey: ["channels"] });
      if (data?.channel_id) {
        void queryClient.invalidateQueries({
          queryKey: ["channel-settings", data.channel_id],
        });
      }
      void queryClient.invalidateQueries({ queryKey: ["conversations"] });
    });
    client.on("emergency_stop_changed", () => {
      void queryClient.invalidateQueries({ queryKey: ["shop-ai-settings"] });
      void queryClient.invalidateQueries({ queryKey: ["channels"] });
      void queryClient.invalidateQueries({ queryKey: ["channel-settings"] });
      void queryClient.invalidateQueries({ queryKey: ["conversations"] });
    });
    client.connect();
    return () => client.disconnect();
  }, [shopId, queryClient]);
}