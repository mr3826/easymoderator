import React, { useMemo } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';

import { apiErrorMessageKey } from '@/lib/api-error-i18n';
import { formatBdCurrency } from '@/lib/currency';
import { useCustomerQuickView } from '@/hooks/useCustomer';
import { brandColors, fontFamily, neutral, radius, spacing } from '@/theme/tokens';

interface CustomerQuickViewScreenProps {
  id: string | undefined;
}

export function CustomerQuickViewScreen({ id }: CustomerQuickViewScreenProps) {
  const { t } = useTranslation();
  const router = useRouter();
  const query = useCustomerQuickView(id ?? '');

  const customer = query.data?.customer;
  const orders = useMemo(() => query.data?.orders ?? [], [query.data?.orders]);
  const rawPhone = customer?.phone ? String(customer.phone).trim() : null;
  const rawEmail = customer?.email ? String(customer.email).trim() : null;
  const rawName = customer?.name ? String(customer.name).trim() : null;
  const displayName = rawName || rawPhone || t('mobile.customers.unknown');

  const stats = useMemo(() => {
    if (query.data?.stats) {
      return query.data.stats;
    }
    let delivered = 0;
    let returned = 0;
    let cancelled = 0;
    for (const o of orders) {
      const os = (o.order_status || '').toLowerCase();
      const fs = (o.fulfillment_status || '').toLowerCase();
      if (fs === 'delivered' || os === 'delivered') delivered++;
      if (fs === 'returned' || os === 'returned') returned++;
      if (os === 'cancelled') cancelled++;
    }
    const total = orders.length;
    const rate = total > 0 ? Math.round((returned / total) * 100) : 0;
    return {
      total_orders: total,
      delivered_count: delivered,
      rto_count: returned,
      cancelled_count: cancelled,
      return_rate: rate,
    };
  }, [query.data?.stats, orders]);

  if (!id) {
    return (
      <CustomerState
        title={t('mobile.deeplink.unavailable.title')}
        message={t('mobile.deeplink.unavailable.message')}
      />
    );
  }

  if (query.isPending) {
    return (
      <View style={styles.center} testID="customer-loading">
        <ActivityIndicator size="large" color={brandColors.primary} />
      </View>
    );
  }

  if (query.error?.kind === 'notFound') {
    return (
      <CustomerState
        title={t('mobile.deeplink.unavailable.title')}
        message={t('mobile.deeplink.unavailable.message')}
      />
    );
  }

  if (query.isError || !customer) {
    return (
      <CustomerState
        title={t('mobile.customers.error.title')}
        message={t(apiErrorMessageKey(query.error?.kind ?? 'unknown'))}
        actionLabel={t('common.retry')}
        onAction={() => void query.refetch()}
      />
    );
  }

  const handleCall = () => {
    if (!rawPhone) {
      Alert.alert(t('common.error'), t('mobile.customers.noPhone'));
      return;
    }
    const telUrl = `tel:${rawPhone}`;
    Linking.openURL(telUrl).catch(() => {
      Alert.alert(t('common.error'), t('mobile.customers.noPhone'));
    });
  };

  const handleMessage = () => {
    if (rawPhone) {
      Linking.openURL(`sms:${rawPhone}`).catch(() => {
        router.push('/inbox');
      });
    } else {
      router.push('/inbox');
    }
  };

  const handleCreateOrder = () => {
    router.push({
      pathname: '/quick-action',
      params: {
        action: 'manual-order',
        customerId: id,
        customerName: displayName,
        customerPhone: rawPhone || '',
      },
    });
  };

  const handleOrderPress = (orderId: string) => {
    router.push(`/order-detail/${orderId}`);
  };

  const returnRateColor =
    stats.return_rate >= 30
      ? brandColors.destructive
      : stats.return_rate >= 15
        ? '#D97706'
        : brandColors.primaryDark;

  return (
    <SafeAreaView style={styles.container} testID="mobile-customer-quick-view">
      <View style={styles.header}>
        <Pressable
          onPress={() => router.back()}
          testID="mobile-customer-back"
          accessibilityRole="button"
          accessibilityLabel={t('common.close')}
          style={styles.back}
        >
          <Text style={styles.backText}>‹</Text>
        </Pressable>
        <Text style={styles.title}>{t('mobile.customers.title')}</Text>
      </View>

      <FlatList
        testID="mobile-customer-orders-list"
        data={orders}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.content}
        windowSize={5}
        maxToRenderPerBatch={5}
        removeClippedSubviews={true}
        initialNumToRender={8}
        ListHeaderComponent={
          <View style={styles.headerComponent}>
            {/* Identity Card */}
            <View style={styles.identityCard} testID="customer-identity-card">
              <Text style={styles.name} testID="customer-display-name">
                {displayName}
              </Text>
              {rawPhone ? (
                <Text style={styles.phoneText} testID="customer-phone">
                  {rawPhone}
                </Text>
              ) : null}
              {rawEmail ? (
                <Text style={styles.meta} testID="customer-email">
                  {rawEmail}
                </Text>
              ) : null}
            </View>

            {/* Quick Action Buttons */}
            <View style={styles.actionRow} testID="customer-action-row">
              <Pressable
                onPress={handleCall}
                testID="customer-call-btn"
                accessibilityRole="button"
                style={[styles.actionBtn, styles.callBtn]}
              >
                <Text style={styles.actionBtnText}>📞 {t('mobile.customers.call')}</Text>
              </Pressable>

              <Pressable
                onPress={handleMessage}
                testID="customer-message-btn"
                accessibilityRole="button"
                style={[styles.actionBtn, styles.messageBtn]}
              >
                <Text style={styles.actionBtnText}>💬 {t('mobile.customers.message')}</Text>
              </Pressable>

              <Pressable
                onPress={handleCreateOrder}
                testID="customer-create-order-btn"
                accessibilityRole="button"
                style={[styles.actionBtn, styles.orderBtn]}
              >
                <Text style={[styles.actionBtnText, styles.orderBtnText]}>
                  ➕ {t('mobile.customers.createOrder')}
                </Text>
              </Pressable>
            </View>

            {/* Lifetime History & RTO Risk Card */}
            <View style={styles.statsCard} testID="customer-lifetime-stats">
              <Text style={styles.statsTitle}>{t('mobile.customers.lifetimeStats')}</Text>
              <View style={styles.statsGrid}>
                <View style={styles.statBox}>
                  <Text style={styles.statNumber} testID="customer-stat-total">
                    {stats.total_orders}
                  </Text>
                  <Text style={styles.statLabel}>{t('mobile.customers.totalOrders')}</Text>
                </View>

                <View style={styles.statBox}>
                  <Text
                    style={[styles.statNumber, { color: brandColors.primaryDark }]}
                    testID="customer-stat-delivered"
                  >
                    {stats.delivered_count}
                  </Text>
                  <Text style={styles.statLabel}>{t('mobile.customers.delivered')}</Text>
                </View>

                <View style={styles.statBox}>
                  <Text
                    style={[styles.statNumber, { color: brandColors.destructive }]}
                    testID="customer-stat-returned"
                  >
                    {stats.rto_count}
                  </Text>
                  <Text style={styles.statLabel}>{t('mobile.customers.returned')}</Text>
                </View>

                <View style={styles.statBox}>
                  <Text
                    style={[styles.statNumber, { color: returnRateColor }]}
                    testID="customer-stat-rate"
                  >
                    {stats.return_rate}%
                  </Text>
                  <Text style={styles.statLabel}>{t('mobile.customers.returnRate')}</Text>
                </View>
              </View>
            </View>

            <Text style={styles.sectionHeader}>{t('mobile.customers.orders')}</Text>
          </View>
        }
        ListEmptyComponent={
          <View style={styles.emptyContainer} testID="customer-no-orders">
            <Text style={styles.meta}>{t('mobile.customers.noOrders')}</Text>
          </View>
        }
        renderItem={({ item }) => (
          <Pressable
            style={styles.orderCard}
            onPress={() => handleOrderPress(item.id)}
            testID={`customer-order-item-${item.id}`}
            accessibilityRole="button"
          >
            <View style={styles.orderTopRow}>
              <Text style={styles.orderNumber}>
                {item.order_number || t('mobile.orders.unknownNumber')}
              </Text>
              <View style={[styles.statusBadge, getStatusStyle(item.order_status || '')]}>
                <Text style={styles.statusBadgeText}>{item.order_status}</Text>
              </View>
            </View>
            <View style={styles.orderBottomRow}>
              <Text style={styles.orderAmount}>
                {formatBdCurrency(Number(item.total || 0))}
              </Text>
              <Text style={styles.orderFulfillment}>
                {item.fulfillment_status || 'unfulfilled'}
              </Text>
            </View>
          </Pressable>
        )}
      />

      <View style={styles.readOnly}>
        <Text style={styles.readOnlyText}>{t('mobile.customers.readOnly')}</Text>
      </View>
    </SafeAreaView>
  );
}

function getStatusStyle(status: string) {
  const s = String(status || '').toLowerCase();
  if (s === 'delivered') return { backgroundColor: '#DCFCE7' };
  if (s === 'confirmed' || s === 'processing') return { backgroundColor: '#DBEAFE' };
  if (s === 'cancelled' || s === 'returned') return { backgroundColor: '#FEE2E2' };
  return { backgroundColor: '#F3F4F6' };
}

function CustomerState({
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
    <View style={styles.center} testID="mobile-customer-state">
      <Text style={styles.stateTitle}>{title}</Text>
      <Text style={styles.meta}>{message}</Text>
      {actionLabel && onAction ? (
        <Pressable onPress={onAction} style={styles.retry} testID="customer-retry-btn">
          <Text style={styles.retryText}>{actionLabel}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: brandColors.background,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.two,
    paddingHorizontal: spacing.two,
    paddingVertical: spacing.one,
    borderBottomWidth: 1,
    borderBottomColor: neutral.border,
    backgroundColor: neutral.surface,
  },
  back: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backText: {
    fontSize: 32,
    color: brandColors.primaryDark,
    lineHeight: 36,
  },
  title: {
    color: brandColors.text,
    fontFamily: fontFamily.semiBold,
    fontSize: 18,
  },
  content: {
    padding: spacing.three,
    paddingBottom: spacing.six,
  },
  headerComponent: {
    gap: spacing.three,
    marginBottom: spacing.two,
  },
  identityCard: {
    backgroundColor: neutral.surface,
    borderRadius: radius.default,
    borderWidth: 1,
    borderColor: neutral.border,
    padding: spacing.three,
    gap: spacing.one,
  },
  name: {
    color: brandColors.text,
    fontFamily: fontFamily.bold,
    fontSize: 22,
  },
  phoneText: {
    color: brandColors.primaryDark,
    fontFamily: fontFamily.semiBold,
    fontSize: 15,
  },
  meta: {
    color: neutral.muted,
    fontFamily: fontFamily.regular,
    fontSize: 13,
  },
  actionRow: {
    flexDirection: 'row',
    gap: spacing.two,
  },
  actionBtn: {
    flex: 1,
    borderRadius: radius.default,
    paddingVertical: spacing.two,
    paddingHorizontal: spacing.one,
    alignItems: 'center',
    justifyContent: 'center',
  },
  callBtn: {
    backgroundColor: '#EFF6FF',
    borderWidth: 1,
    borderColor: '#BFDBFE',
  },
  messageBtn: {
    backgroundColor: '#F3F4F6',
    borderWidth: 1,
    borderColor: neutral.border,
  },
  orderBtn: {
    backgroundColor: brandColors.primary,
  },
  actionBtnText: {
    color: brandColors.text,
    fontFamily: fontFamily.semiBold,
    fontSize: 13,
  },
  orderBtnText: {
    color: '#FFFFFF',
  },
  statsCard: {
    backgroundColor: neutral.surface,
    borderRadius: radius.default,
    borderWidth: 1,
    borderColor: neutral.border,
    padding: spacing.three,
    gap: spacing.two,
  },
  statsTitle: {
    color: brandColors.text,
    fontFamily: fontFamily.semiBold,
    fontSize: 15,
  },
  statsGrid: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  statBox: {
    alignItems: 'center',
    flex: 1,
  },
  statNumber: {
    fontFamily: fontFamily.bold,
    fontSize: 20,
    color: brandColors.text,
  },
  statLabel: {
    fontFamily: fontFamily.regular,
    fontSize: 11,
    color: neutral.muted,
    marginTop: spacing.half,
    textAlign: 'center',
  },
  sectionHeader: {
    color: brandColors.text,
    fontFamily: fontFamily.semiBold,
    fontSize: 16,
    marginTop: spacing.one,
  },
  emptyContainer: {
    padding: spacing.four,
    alignItems: 'center',
  },
  orderCard: {
    backgroundColor: neutral.surface,
    borderRadius: radius.default,
    borderWidth: 1,
    borderColor: neutral.border,
    padding: spacing.three,
    marginBottom: spacing.two,
    gap: spacing.one,
  },
  orderTopRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  orderNumber: {
    color: brandColors.text,
    fontFamily: fontFamily.semiBold,
    fontSize: 15,
  },
  statusBadge: {
    paddingHorizontal: spacing.two,
    paddingVertical: spacing.half,
    borderRadius: radius.default,
  },
  statusBadgeText: {
    fontFamily: fontFamily.medium,
    fontSize: 12,
    color: brandColors.text,
    textTransform: 'capitalize',
  },
  orderBottomRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  orderAmount: {
    fontFamily: fontFamily.bold,
    fontSize: 14,
    color: brandColors.primaryDark,
  },
  orderFulfillment: {
    fontFamily: fontFamily.regular,
    fontSize: 12,
    color: neutral.muted,
    textTransform: 'capitalize',
  },
  readOnly: {
    borderTopWidth: 1,
    borderTopColor: neutral.border,
    padding: spacing.two,
    backgroundColor: neutral.surface,
  },
  readOnlyText: {
    color: neutral.muted,
    fontFamily: fontFamily.regular,
    fontSize: 12,
    textAlign: 'center',
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.four,
    gap: spacing.two,
    backgroundColor: brandColors.background,
  },
  stateTitle: {
    color: brandColors.text,
    fontFamily: fontFamily.semiBold,
    fontSize: 18,
    textAlign: 'center',
  },
  retry: {
    backgroundColor: brandColors.primary,
    borderRadius: radius.default,
    paddingHorizontal: spacing.four,
    paddingVertical: spacing.two,
  },
  retryText: {
    color: '#FFFFFF',
    fontFamily: fontFamily.semiBold,
  },
});
