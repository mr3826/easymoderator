import ChannelConnectionManager from "./channels/ChannelConnectionManager";

/**
 * Legacy route target kept for compatibility (ADR-0013 §9). The OAuth / health /
 * consent logic now lives in `channels/useMetaChannelConnection` and the UI in
 * `channels/ChannelConnectionManager`; this component is a thin consumer.
 *
 * `/manage-shop/chat-settings` redirects to `/manage-shop/channels`, so this is
 * only reached through direct imports and tests.
 */
export default function ChatSettings() {
  return <ChannelConnectionManager />;
}