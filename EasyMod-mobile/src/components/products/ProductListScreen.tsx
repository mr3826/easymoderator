import React, { useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Image,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';

import type { MobileProduct } from '@/api/mobile/schemas';
import { useProducts } from '@/hooks/useProducts';
import { useNetworkStatus } from '@/hooks/useNetworkStatus';
import { brandColors, fontFamily, neutral, radius, spacing } from '@/theme/tokens';
import { QuickStockCounter } from './QuickStockCounter';
import { PhotoToProductModal } from './PhotoToProductModal';

export function ProductListScreen() {
  const { t } = useTranslation();
  const isOnline = useNetworkStatus();

  const [selectedStockFilter, setSelectedStockFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [isDraftModalVisible, setIsDraftModalVisible] = useState<boolean>(false);

  const query = useProducts({
    stock_status: selectedStockFilter === 'all' ? undefined : selectedStockFilter,
    search: searchQuery.trim() || undefined,
  });

  const products = query.data?.products ?? [];

  const filterChips = [
    { id: 'all', label: t('mobile.products.filterAll', 'সকল') },
    { id: 'low_stock', label: t('mobile.products.filterLowStock', 'কম স্টক') },
    { id: 'out_of_stock', label: t('mobile.products.filterOutOfStock', 'স্টক শেষ') },
    { id: 'in_stock', label: t('mobile.products.filterInStock', 'স্টকে আছে') },
  ];

  const renderStockBadge = (product: MobileProduct) => {
    switch (product.stock_status) {
      case 'out_of_stock':
        return (
          <View style={[styles.badge, styles.badgeOutOfStock]}>
            <Text style={styles.badgeOutOfStockText}>{t('mobile.products.outOfStockBadge', 'স্টক শেষ')}</Text>
          </View>
        );
      case 'low_stock':
        return (
          <View style={[styles.badge, styles.badgeLowStock]}>
            <Text style={styles.badgeLowStockText}>
              {t('mobile.products.lowStockBadge', 'কম স্টক: {{count}}', { count: product.quantity })}
            </Text>
          </View>
        );
      case 'in_stock':
      default:
        return (
          <View style={[styles.badge, styles.badgeInStock]}>
            <Text style={styles.badgeInStockText}>
              {t('mobile.products.inStockBadge', 'স্টক: {{count}}', { count: product.quantity })}
            </Text>
          </View>
        );
    }
  };

  const renderProductItem = ({ item }: { item: MobileProduct }) => {
    return (
      <View style={styles.productCard} testID={`product-card-${item.id}`}>
        <View style={styles.cardHeader}>
          {item.image_url ? (
            <Image source={{ uri: item.image_url }} style={styles.productThumb} resizeMode="cover" />
          ) : (
            <View style={styles.placeholderThumb}>
              <Text style={styles.placeholderThumbText}>📦</Text>
            </View>
          )}

          <View style={styles.cardInfo}>
            <View style={styles.titleRow}>
              <Text style={styles.productName} testID={`product-name-${item.id}`} numberOfLines={2}>
                {item.name_bn || item.name}
              </Text>
            </View>

            <View style={styles.metaRow}>
              {item.sku ? (
                <Text style={styles.skuText}>SKU: {item.sku}</Text>
              ) : null}
              {item.category ? (
                <Text style={styles.categoryText}>{item.category}</Text>
              ) : null}
              {!item.is_active && (
                <View style={styles.draftBadge}>
                  <Text style={styles.draftBadgeText}>{t('mobile.products.draftLabel', 'ড্রাফট')}</Text>
                </View>
              )}
            </View>

            <View style={styles.priceRow}>
              <Text style={styles.priceText} testID={`product-price-${item.id}`}>৳{item.price.toLocaleString()}</Text>
              {item.compare_at_price && item.compare_at_price > item.price ? (
                <Text style={styles.comparePriceText}>৳{item.compare_at_price.toLocaleString()}</Text>
              ) : null}
              <View style={styles.badgeContainer}>
                {renderStockBadge(item)}
              </View>
            </View>
          </View>
        </View>

        {/* Quick Stock Adjust Stepper Bar */}
        <View style={styles.counterSection}>
          <Text style={styles.counterLabel}>{t('mobile.products.quickAdjustLabel', 'দ্রুত স্টক পরিবর্তন:')}</Text>
          <QuickStockCounter product={item} />
        </View>
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
      {/* Top Header */}
      <View style={styles.header}>
        <View>
          <Text style={styles.title} testID="product-screen-title">{t('mobile.products.screenTitle', 'পণ্য ও স্টক')}</Text>
          <Text style={styles.subtitle}>
            {t('mobile.products.screenSubtitle', 'দ্রুত স্টক আপডেট ও ক্যাটালগ পরিচালনা')}
          </Text>
        </View>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('mobile.products.addDraft', 'নতুন ড্রাফট')}
          testID="product-add-draft-btn"
          style={[styles.addDraftBtn, !isOnline ? styles.buttonDisabled : null]}
          onPress={() => setIsDraftModalVisible(true)}
          disabled={!isOnline}
        >
          <Text style={styles.addDraftBtnText}>+ {t('mobile.products.addDraftShort', 'ড্রাফট')}</Text>
        </Pressable>
      </View>

      {/* Offline Alert Banner */}
      {!isOnline && (
        <View style={styles.offlineBanner}>
          <Text style={styles.offlineBannerText}>
            {t('mobile.common.offlineNotice', 'ইন্টারনেট সংযোগ নেই। পূর্ববর্তী সংরক্ষিত তথ্য প্রদর্শিত হচ্ছে।')}
          </Text>
        </View>
      )}

      {/* Search Input */}
      <View style={styles.searchContainer}>
        <TextInput
          style={styles.searchInput}
          value={searchQuery}
          onChangeText={setSearchQuery}
          placeholder={t('mobile.products.searchPlaceholder', 'নাম বা SKU দিয়ে খুঁজুন...')}
          placeholderTextColor={neutral.muted}
          clearButtonMode="while-editing"
        />
      </View>

      {/* Filter Chips */}
      <View style={styles.filterRow}>
        {filterChips.map((chip) => {
          const isActive = selectedStockFilter === chip.id;
          return (
            <Pressable
              key={chip.id}
              accessibilityRole="button"
              testID={`product-chip-${chip.id}`}
              style={[styles.chip, isActive && styles.chipActive]}
              onPress={() => setSelectedStockFilter(chip.id)}
            >
              <Text style={[styles.chipText, isActive && styles.chipTextActive]}>
                {chip.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {/* Product List */}
      {query.isLoading ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={brandColors.primary} />
          <Text style={styles.loadingText}>{t('mobile.products.loading', 'পণ্য তালিকা লোড হচ্ছে...')}</Text>
        </View>
      ) : query.isError ? (
        <View style={styles.centered}>
          <Text style={styles.errorText}>
            {query.error?.message || t('mobile.products.loadError', 'পণ্য লোড করতে ব্যর্থ হয়েছে')}
          </Text>
          <Pressable style={styles.retryBtn} onPress={() => query.refetch()}>
            <Text style={styles.retryBtnText}>{t('mobile.common.retry', 'পুনরায় চেষ্টা করুন')}</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={products}
          keyExtractor={(item) => item.id}
          renderItem={renderProductItem}
          contentContainerStyle={styles.listContent}
          keyboardShouldPersistTaps="handled"
          windowSize={5}
          maxToRenderPerBatch={5}
          removeClippedSubviews={true}
          initialNumToRender={8}
          refreshControl={
            <RefreshControl
              refreshing={query.isRefetching}
              onRefresh={() => query.refetch()}
              colors={[brandColors.primary]}
            />
          }
          ListEmptyComponent={
            <View style={styles.emptyContainer}>
              <Text style={styles.emptyIcon}>📦</Text>
              <Text style={styles.emptyTitle}>
                {t('mobile.products.emptyTitle', 'কোন পণ্য পাওয়া যায়নি')}
              </Text>
              <Text style={styles.emptySubtitle}>
                {t('mobile.products.emptySubtitle', 'নতুন ড্রাফট তৈরি করতে উপরের বোতামে চাপুন।')}
              </Text>
            </View>
          }
        />
      )}

      {/* Photo to Product Draft Modal */}
      <PhotoToProductModal
        visible={isDraftModalVisible}
        onClose={() => setIsDraftModalVisible(false)}
        onSuccess={() => void query.refetch()}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: brandColors.background,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: spacing.three,
    paddingTop: spacing.two,
    paddingBottom: spacing.two,
  },
  title: {
    fontFamily: fontFamily.bold,
    fontSize: 22,
    color: brandColors.text,
  },
  subtitle: {
    fontFamily: fontFamily.regular,
    fontSize: 13,
    color: neutral.muted,
    marginTop: spacing.half,
  },
  addDraftBtn: {
    backgroundColor: brandColors.primary,
    paddingHorizontal: spacing.two,
    paddingVertical: spacing.one,
    borderRadius: radius.default,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonDisabled: { opacity: 0.5 },
  addDraftBtnText: {
    fontFamily: fontFamily.bold,
    fontSize: 13,
    color: '#FFFFFF',
  },
  offlineBanner: {
    backgroundColor: '#FEF3C7',
    paddingHorizontal: spacing.three,
    paddingVertical: spacing.two,
    marginHorizontal: spacing.three,
    borderRadius: radius.default,
    marginBottom: spacing.two,
  },
  offlineBannerText: {
    fontFamily: fontFamily.medium,
    fontSize: 13,
    color: '#92400E',
  },
  searchContainer: {
    paddingHorizontal: spacing.three,
    marginBottom: spacing.two,
  },
  searchInput: {
    height: 42,
    borderWidth: 1,
    borderColor: '#D1D5DB',
    borderRadius: radius.default,
    paddingHorizontal: spacing.two,
    fontFamily: fontFamily.regular,
    fontSize: 14,
    color: brandColors.text,
    backgroundColor: '#FFFFFF',
  },
  filterRow: {
    flexDirection: 'row',
    paddingHorizontal: spacing.three,
    paddingBottom: spacing.two,
    gap: spacing.two,
  },
  chip: {
    paddingHorizontal: spacing.two,
    paddingVertical: spacing.one,
    borderRadius: 16,
    backgroundColor: '#E5E7EB',
  },
  chipActive: {
    backgroundColor: brandColors.primary,
  },
  chipText: {
    fontFamily: fontFamily.medium,
    fontSize: 12,
    color: neutral.muted,
  },
  chipTextActive: {
    color: '#FFFFFF',
  },
  listContent: {
    paddingHorizontal: spacing.three,
    paddingBottom: spacing.four,
  },
  productCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: radius.default,
    padding: spacing.two,
    marginBottom: spacing.two,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 3,
    elevation: 2,
  },
  cardHeader: {
    flexDirection: 'row',
    gap: spacing.two,
  },
  productThumb: {
    width: 64,
    height: 64,
    borderRadius: radius.default,
    backgroundColor: '#F3F4F6',
  },
  placeholderThumb: {
    width: 64,
    height: 64,
    borderRadius: radius.default,
    backgroundColor: '#F3F4F6',
    justifyContent: 'center',
    alignItems: 'center',
  },
  placeholderThumbText: {
    fontSize: 24,
  },
  cardInfo: {
    flex: 1,
  },
  titleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  productName: {
    fontFamily: fontFamily.bold,
    fontSize: 15,
    color: brandColors.text,
    lineHeight: 20,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.one,
    marginTop: 2,
  },
  skuText: {
    fontFamily: fontFamily.regular,
    fontSize: 11,
    color: neutral.muted,
  },
  categoryText: {
    fontFamily: fontFamily.regular,
    fontSize: 11,
    color: neutral.muted,
    backgroundColor: '#F3F4F6',
    paddingHorizontal: 4,
    borderRadius: 4,
  },
  draftBadge: {
    backgroundColor: '#FEF9C3',
    paddingHorizontal: 4,
    borderRadius: 4,
  },
  draftBadgeText: {
    fontFamily: fontFamily.medium,
    fontSize: 10,
    color: '#A16207',
  },
  priceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.one,
    marginTop: 4,
  },
  priceText: {
    fontFamily: fontFamily.bold,
    fontSize: 15,
    color: brandColors.primary,
  },
  comparePriceText: {
    fontFamily: fontFamily.regular,
    fontSize: 12,
    color: neutral.muted,
    textDecorationLine: 'line-through',
  },
  badgeContainer: {
    marginLeft: 'auto',
  },
  badge: {
    paddingHorizontal: spacing.one,
    paddingVertical: 2,
    borderRadius: 6,
  },
  badgeInStock: {
    backgroundColor: '#DCFCE7',
  },
  badgeInStockText: {
    fontFamily: fontFamily.bold,
    fontSize: 11,
    color: '#15803D',
  },
  badgeLowStock: {
    backgroundColor: '#FEF3C7',
  },
  badgeLowStockText: {
    fontFamily: fontFamily.bold,
    fontSize: 11,
    color: '#B45309',
  },
  badgeOutOfStock: {
    backgroundColor: '#FEE2E2',
  },
  badgeOutOfStockText: {
    fontFamily: fontFamily.bold,
    fontSize: 11,
    color: '#B91C1C',
  },
  counterSection: {
    marginTop: spacing.one,
    paddingTop: spacing.one,
    borderTopWidth: 1,
    borderTopColor: '#F3F4F6',
  },
  counterLabel: {
    fontFamily: fontFamily.medium,
    fontSize: 11,
    color: neutral.muted,
    marginBottom: 4,
  },
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.four,
  },
  loadingText: {
    fontFamily: fontFamily.regular,
    fontSize: 14,
    color: neutral.muted,
    marginTop: spacing.two,
  },
  errorText: {
    fontFamily: fontFamily.medium,
    fontSize: 14,
    color: '#DC2626',
    textAlign: 'center',
    marginBottom: spacing.two,
  },
  retryBtn: {
    paddingHorizontal: spacing.three,
    paddingVertical: spacing.one,
    borderRadius: radius.default,
    backgroundColor: brandColors.primary,
  },
  retryBtnText: {
    fontFamily: fontFamily.medium,
    fontSize: 14,
    color: '#FFFFFF',
  },
  emptyContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.four,
  },
  emptyIcon: {
    fontSize: 48,
    marginBottom: spacing.two,
  },
  emptyTitle: {
    fontFamily: fontFamily.bold,
    fontSize: 16,
    color: brandColors.text,
    marginBottom: spacing.half,
  },
  emptySubtitle: {
    fontFamily: fontFamily.regular,
    fontSize: 13,
    color: neutral.muted,
    textAlign: 'center',
  },
});
