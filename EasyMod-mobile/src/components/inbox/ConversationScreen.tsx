import { useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';

import type { ConversationMessage } from '@/api/mobile/schemas';
import { apiErrorMessageKey } from '@/lib/api-error-i18n';
import {
  useConversation,
  useConversationMessages,
  useSendConversationReply,
  useSetConversationAiMode,
} from '@/hooks/useInbox';
import { OrderDraftModal } from '@/components/orders/OrderDraftModal';
import { useNetworkStatus } from '@/hooks/useNetworkStatus';
import { brandColors, fontFamily, neutral, radius, spacing } from '@/theme/tokens';

export function ConversationScreen({ id }: { id: string | undefined }) {
  const { t } = useTranslation();
  const router = useRouter();
  const isOnline = useNetworkStatus();
  const [replyText, setReplyText] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [draftModalVisible, setDraftModalVisible] = useState(false);

  const conversationQuery = useConversation(id ?? '');
  const messagesQuery = useConversationMessages(id ?? '');
  const sendReplyMutation = useSendConversationReply();
  const setAiModeMutation = useSetConversationAiMode();

  if (!id) return <ConversationState title={t('mobile.deeplink.unavailable.title')} message={t('mobile.deeplink.unavailable.message')} />;
  if (conversationQuery.isPending || messagesQuery.isPending) return <ConversationLoading />;
  if (conversationQuery.error?.kind === 'notFound' || messagesQuery.error?.kind === 'notFound') {
    return <ConversationState title={t('mobile.deeplink.unavailable.title')} message={t('mobile.deeplink.unavailable.message')} />;
  }
  if (conversationQuery.isError || messagesQuery.isError) {
    const error = conversationQuery.error || messagesQuery.error;
    return (
      <ConversationState
        title={t('mobile.inbox.detail.error.title')}
        message={error ? t(apiErrorMessageKey(error.kind)) : t('mobile.inbox.detail.error.message')}
        actionLabel={t('common.retry')}
        onAction={() => {
          void conversationQuery.refetch();
          void messagesQuery.refetch();
        }}
      />
    );
  }

  const conversation = conversationQuery.data;
  const messages = messagesQuery.data?.messages ?? [];
  const customerName = conversation?.customer?.name || conversation?.title || t('mobile.inbox.unknownCustomer');
  const isAiPaused = conversation?.status === 'paused' || conversation?.hitl === true;

  const handleSend = async () => {
    const trimmed = replyText.trim();
    if (!isOnline || !trimmed || !id || sendReplyMutation.isPending) return;

    setErrorMessage(null);
    const idempotencyKey = `idemp-mob-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    try {
      await sendReplyMutation.mutateAsync({
        conversationId: id,
        message: trimmed,
        idempotencyKey,
      });
      setReplyText('');
    } catch (err: unknown) {
      const errorObj = err as { code?: string; kind?: string; message?: string };
      if (errorObj?.code === 'OUTSIDE_24H_WINDOW') {
        setErrorMessage(t('mobile.inbox.detail.outside24h'));
      } else {
        setErrorMessage(errorObj?.message || t('mobile.inbox.detail.error.message'));
      }
    }
  };

  const handleToggleAi = async () => {
    if (!isOnline || !id || setAiModeMutation.isPending) return;
    try {
      await setAiModeMutation.mutateAsync({
        conversationId: id,
        mode: isAiPaused ? 'resume' : 'pause',
      });
    } catch (err: unknown) {
      const errorObj = err as { message?: string };
      setErrorMessage(errorObj?.message || t('mobile.inbox.detail.error.message'));
    }
  };

  return (
    <SafeAreaView style={styles.container} testID="mobile-conversation-detail">
      <KeyboardAvoidingView
        style={styles.keyboardContainer}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} accessibilityRole="button" testID="mobile-conversation-back" style={styles.backButton}>
            <Text style={styles.backText}>‹</Text>
          </Pressable>
          <View style={styles.headerCopy}>
            {conversation?.customer_id ? (
              <Pressable onPress={() => router.push({ pathname: '/customer-detail/[id]', params: { id: conversation.customer_id! } })} accessibilityRole="button">
                <Text style={styles.customerName} numberOfLines={1}>{customerName}</Text>
              </Pressable>
            ) : (
              <Text style={styles.customerName} numberOfLines={1}>{customerName}</Text>
            )}
            <Text style={styles.headerMeta}>{conversation?.channel} · {conversation?.status}</Text>
          </View>
          <View style={styles.headerActions}>
            <Pressable
              testID="mobile-conversation-create-draft"
              onPress={() => setDraftModalVisible(true)}
              disabled={!isOnline}
              style={styles.draftPill}
              accessibilityRole="button"
            >
              <Text style={styles.draftPillText}>+ Order</Text>
            </Pressable>
            <Pressable
              testID="mobile-conversation-ai-toggle"
              onPress={handleToggleAi}
              disabled={!isOnline || setAiModeMutation.isPending}
              style={[styles.aiPill, isAiPaused ? styles.aiPillPaused : styles.aiPillActive]}
              accessibilityRole="button"
            >
              {setAiModeMutation.isPending ? (
                <ActivityIndicator size="small" color={isAiPaused ? '#D97706' : brandColors.primary} />
              ) : (
                <Text style={[styles.aiPillText, isAiPaused ? styles.aiPillTextPaused : styles.aiPillTextActive]}>
                  {isAiPaused ? t('mobile.inbox.detail.resumeAi') : t('mobile.inbox.detail.pauseAi')}
                </Text>
              )}
            </Pressable>
          </View>
        </View>

        {conversation?.needs_merchant_reply ? (
          <View style={styles.needsNotice} accessibilityRole="alert">
            <Text style={styles.needsNoticeText}>{t('mobile.inbox.detail.needsReply')}</Text>
          </View>
        ) : null}

        {errorMessage ? (
          <View style={styles.errorBanner} accessibilityRole="alert">
            <Text style={styles.errorBannerText}>{errorMessage}</Text>
            <Pressable onPress={() => setErrorMessage(null)} accessibilityRole="button">
              <Text style={styles.errorDismissText}>✕</Text>
            </Pressable>
          </View>
        ) : null}

        <FlatList
          testID="mobile-conversation-messages"
          data={messages}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.messages}
          windowSize={5}
          maxToRenderPerBatch={5}
          removeClippedSubviews={true}
          initialNumToRender={8}
          ListEmptyComponent={<ConversationState title={t('mobile.inbox.detail.empty.title')} message={t('mobile.inbox.detail.empty.message')} />}
          renderItem={({ item }) => <MessageBubble message={item} />}
        />

        <View style={styles.replyBar}>
          <TextInput
            testID="mobile-conversation-reply-input"
            style={styles.replyInput}
            value={replyText}
            onChangeText={setReplyText}
            placeholder={t('mobile.inbox.detail.replyPlaceholder')}
            placeholderTextColor={neutral.muted}
            multiline
            maxLength={2000}
            editable={isOnline && !sendReplyMutation.isPending}
          />
          <Pressable
            testID="mobile-conversation-send-btn"
            style={[
              styles.sendButton,
              (!isOnline || !replyText.trim() || sendReplyMutation.isPending) && styles.sendButtonDisabled,
            ]}
            disabled={!isOnline || !replyText.trim() || sendReplyMutation.isPending}
            onPress={handleSend}
            accessibilityRole="button"
          >
            {sendReplyMutation.isPending ? (
              <ActivityIndicator size="small" color="#FFFFFF" />
            ) : (
              <Text style={styles.sendButtonText}>{t('mobile.inbox.detail.send')}</Text>
            )}
          </Pressable>
        </View>
      </KeyboardAvoidingView>
      <OrderDraftModal
        visible={draftModalVisible}
        onClose={() => setDraftModalVisible(false)}
        initialCustomerName={customerName}
        initialCustomerPhone={(conversation as unknown as { customer_phone?: string })?.customer_phone || ''}
        onOrderCreated={(orderId) => {
          router.push({ pathname: '/order/[id]', params: { id: orderId } });
        }}
      />
    </SafeAreaView>
  );
}

function MessageBubble({ message }: { message: ConversationMessage }) {
  const senderIsCustomer = message.sender === 'customer';
  return (
    <View style={[styles.messageRow, senderIsCustomer ? styles.customerRow : styles.merchantRow]}>
      <View style={[styles.bubble, senderIsCustomer ? styles.customerBubble : styles.merchantBubble]}>
        <Text style={[styles.messageText, !senderIsCustomer && styles.merchantMessageText]}>
          {message.content || message.ai_suggestion || ' '}
        </Text>
        <Text style={[styles.timestamp, !senderIsCustomer && styles.merchantTimestamp]}>
          {new Date(message.created_at).toLocaleString()}
        </Text>
      </View>
    </View>
  );
}

function ConversationLoading() {
  return <View style={styles.center} testID="mobile-conversation-loading"><ActivityIndicator size="large" color={brandColors.primary} /></View>;
}

function ConversationState({
  title,
  message,
  actionLabel,
  onAction,
}: {
  title: string;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <View style={styles.center} testID="mobile-conversation-state">
      <Text style={styles.stateTitle}>{title}</Text>
      <Text style={styles.stateMessage}>{message}</Text>
      {actionLabel && onAction ? <Pressable onPress={onAction} style={styles.retry}><Text style={styles.retryText}>{actionLabel}</Text></Pressable> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: brandColors.background },
  keyboardContainer: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.two,
    paddingVertical: spacing.two,
    borderBottomWidth: 1,
    borderBottomColor: neutral.border,
    backgroundColor: neutral.surface,
  },
  backButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  backText: { fontSize: 36, color: brandColors.primaryDark, lineHeight: 38 },
  headerCopy: { flex: 1, gap: spacing.half },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: spacing.one },
  draftPill: {
    paddingHorizontal: spacing.two,
    paddingVertical: spacing.one,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: brandColors.primary,
    backgroundColor: '#ECFDF5',
    alignItems: 'center',
    justifyContent: 'center',
  },
  draftPillText: {
    color: brandColors.primaryDark,
    fontFamily: fontFamily.semiBold,
    fontSize: 12,
  },
  customerName: { color: brandColors.text, fontFamily: fontFamily.semiBold, fontSize: 17 },
  headerMeta: { color: neutral.muted, fontFamily: fontFamily.regular, fontSize: 12, textTransform: 'capitalize' },
  aiPill: {
    paddingHorizontal: spacing.two,
    paddingVertical: spacing.one,
    borderRadius: 16,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  aiPillActive: {
    backgroundColor: 'rgba(0, 166, 81, 0.08)',
    borderColor: brandColors.primary,
  },
  aiPillPaused: {
    backgroundColor: 'rgba(217, 119, 6, 0.1)',
    borderColor: '#D97706',
  },
  aiPillText: {
    fontFamily: fontFamily.medium,
    fontSize: 12,
  },
  aiPillTextActive: {
    color: brandColors.primaryDark,
  },
  aiPillTextPaused: {
    color: '#B45309',
  },
  needsNotice: { margin: spacing.two, padding: spacing.two, borderRadius: radius.default, backgroundColor: 'rgba(0, 166, 81, 0.12)' },
  needsNoticeText: { color: brandColors.primaryDark, fontFamily: fontFamily.medium, fontSize: 13 },
  errorBanner: {
    marginHorizontal: spacing.two,
    marginTop: spacing.one,
    padding: spacing.two,
    borderRadius: radius.default,
    backgroundColor: '#FEF2F2',
    borderWidth: 1,
    borderColor: '#F87171',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  errorBannerText: { color: '#B91C1C', fontFamily: fontFamily.regular, fontSize: 13, flex: 1 },
  errorDismissText: { color: '#B91C1C', fontFamily: fontFamily.semiBold, fontSize: 14, marginLeft: spacing.two },
  messages: { padding: spacing.three, gap: spacing.two, flexGrow: 1 },
  messageRow: { flexDirection: 'row', marginBottom: spacing.two },
  customerRow: { justifyContent: 'flex-start' },
  merchantRow: { justifyContent: 'flex-end' },
  bubble: { maxWidth: '84%', padding: spacing.two, borderRadius: radius.default, gap: spacing.one },
  customerBubble: { backgroundColor: neutral.surface, borderWidth: 1, borderColor: neutral.border },
  merchantBubble: { backgroundColor: brandColors.primary },
  messageText: { color: brandColors.text, fontFamily: fontFamily.regular, fontSize: 15 },
  merchantMessageText: { color: '#FFFFFF' },
  timestamp: { color: neutral.muted, fontFamily: fontFamily.regular, fontSize: 10 },
  merchantTimestamp: { color: 'rgba(255,255,255,0.75)' },
  replyBar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    borderTopWidth: 1,
    borderTopColor: neutral.border,
    paddingHorizontal: spacing.two,
    paddingVertical: spacing.two,
    backgroundColor: neutral.surface,
    gap: spacing.two,
  },
  replyInput: {
    flex: 1,
    minHeight: 40,
    maxHeight: 100,
    borderRadius: radius.default,
    borderWidth: 1,
    borderColor: neutral.border,
    paddingHorizontal: spacing.two,
    paddingVertical: spacing.one,
    fontFamily: fontFamily.regular,
    fontSize: 15,
    color: brandColors.text,
    backgroundColor: brandColors.background,
  },
  sendButton: {
    backgroundColor: brandColors.primary,
    borderRadius: radius.default,
    paddingHorizontal: spacing.three,
    paddingVertical: spacing.two,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 40,
  },
  sendButtonDisabled: {
    backgroundColor: neutral.border,
  },
  sendButtonText: {
    color: '#FFFFFF',
    fontFamily: fontFamily.semiBold,
    fontSize: 14,
  },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.four, gap: spacing.two, backgroundColor: brandColors.background },
  stateTitle: { color: brandColors.text, fontFamily: fontFamily.semiBold, fontSize: 18, textAlign: 'center' },
  stateMessage: { color: neutral.muted, fontFamily: fontFamily.regular, fontSize: 14, textAlign: 'center' },
  retry: { backgroundColor: brandColors.primary, borderRadius: radius.default, paddingHorizontal: spacing.four, paddingVertical: spacing.two },
  retryText: { color: '#FFFFFF', fontFamily: fontFamily.semiBold },
});
