import React, { useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useTranslation } from 'react-i18next';

import type { MobileProduct } from '@/api/mobile/schemas';
import { useQuickUpdateStock } from '@/hooks/useProducts';
import { useNetworkStatus } from '@/hooks/useNetworkStatus';
import { brandColors, fontFamily, neutral, radius, spacing } from '@/theme/tokens';

interface QuickStockCounterProps {
  product: MobileProduct;
}

export function QuickStockCounter({ product }: QuickStockCounterProps) {
  const { t } = useTranslation();
  const isOnline = useNetworkStatus();
  const updateStockMutation = useQuickUpdateStock();
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [manualStock, setManualStock] = useState(String(product.quantity));
  const [manualPrice, setManualPrice] = useState(String(product.price));
  const [editError, setEditError] = useState<string | null>(null);

  const handleDelta = (delta: number) => {
    updateStockMutation.mutate({
      productId: product.id,
      stockDelta: delta,
    });
  };

  const handleSoldOut = () => {
    updateStockMutation.mutate({
      productId: product.id,
      newStock: 0,
      inStock: false,
    });
  };

  const handleSaveManual = () => {
    setEditError(null);
    const parsedStock = Number.parseInt(manualStock, 10);
    const parsedPrice = Number.parseFloat(manualPrice);

    if (Number.isNaN(parsedStock) || parsedStock < 0) {
      setEditError(t('mobile.products.invalidStock', 'স্টক সংখ্যা ০ বা তার বেশি হতে হবে'));
      return;
    }
    if (Number.isNaN(parsedPrice) || parsedPrice <= 0) {
      setEditError(t('mobile.products.invalidPrice', 'মূল্য ০ এর বেশি হতে হবে'));
      return;
    }

    updateStockMutation.mutate(
      {
        productId: product.id,
        newStock: parsedStock,
        newPrice: parsedPrice,
        inStock: parsedStock > 0,
      },
      {
        onSuccess: () => {
          setIsEditModalOpen(false);
        },
        onError: (err) => {
          setEditError(err.message || t('mobile.products.updateFailed', 'আপডেট ব্যর্থ হয়েছে'));
        },
      },
    );
  };

  const openManualModal = () => {
    setManualStock(String(product.quantity));
    setManualPrice(String(product.price));
    setEditError(null);
    setIsEditModalOpen(true);
  };

  const isPending = updateStockMutation.isPending;
  const isDisabled = isPending || !isOnline;

  return (
    <View style={styles.container}>
      {/* Stepper Buttons Row */}
      <View style={styles.stepperRow}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('mobile.products.decrement', 'স্টক ১ কমান')}
          testID={`stepper-decrement-${product.id}`}
          style={[styles.stepperBtn, (product.quantity <= 0 || !isOnline) && styles.stepperBtnDisabled]}
          disabled={product.quantity <= 0 || isDisabled}
          onPress={() => handleDelta(-1)}
          hitSlop={8}
        >
          <Text style={[styles.stepperBtnText, product.quantity <= 0 && styles.stepperBtnTextDisabled]}>-1</Text>
        </Pressable>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('mobile.products.currentStock', 'বর্তমান স্টক')}
          testID={`stepper-stock-display-${product.id}`}
          style={styles.stockDisplay}
          onPress={openManualModal}
          disabled={isDisabled}
        >
          {isPending ? (
            <ActivityIndicator size="small" color={brandColors.primary} />
          ) : (
            <View style={styles.stockCountWrapper}>
              <Text style={styles.stockCountText}>{product.quantity}</Text>
              <Text style={styles.stockUnitText}>{t('mobile.products.units', 'টি')}</Text>
            </View>
          )}
        </Pressable>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('mobile.products.increment', 'স্টক ১ বাড়ান')}
          testID={`stepper-increment-${product.id}`}
          style={styles.stepperBtn}
          disabled={isDisabled}
          onPress={() => handleDelta(1)}
          hitSlop={8}
        >
          <Text style={styles.stepperBtnText}>+1</Text>
        </Pressable>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('mobile.products.incrementFive', 'স্টক ৫ বাড়ান')}
          testID={`stepper-increment-five-${product.id}`}
          style={[styles.stepperBtn, styles.quickJumpBtn, !isOnline && styles.stepperBtnDisabled]}
          disabled={isDisabled}
          onPress={() => handleDelta(5)}
          hitSlop={8}
        >
          <Text style={styles.quickJumpText}>+5</Text>
        </Pressable>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('mobile.products.incrementTen', 'স্টক ১০ বাড়ান')}
          testID={`stepper-increment-ten-${product.id}`}
          style={[styles.stepperBtn, styles.quickJumpBtn, !isOnline && styles.stepperBtnDisabled]}
          disabled={isDisabled}
          onPress={() => handleDelta(10)}
          hitSlop={8}
        >
          <Text style={styles.quickJumpText}>+10</Text>
        </Pressable>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('mobile.products.markSoldOut', 'স্টক শেষ চিহ্নিত করুন')}
          testID={`stepper-sold-out-${product.id}`}
          style={[styles.stepperBtn, styles.soldOutBtn, (product.quantity <= 0 || !isOnline) && styles.stepperBtnDisabled]}
          disabled={product.quantity <= 0 || isDisabled}
          onPress={handleSoldOut}
          hitSlop={8}
        >
          <Text style={styles.soldOutText}>{t('mobile.products.soldOutShort', 'শেষ')}</Text>
        </Pressable>
      </View>

      {/* Quick Edit Price & Stock Modal */}
      <Modal
        visible={isEditModalOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setIsEditModalOpen(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContainer}>
            <Text style={styles.modalTitle}>{t('mobile.products.quickEditTitle', 'স্টক ও মূল্য পরিবর্তন')}</Text>
            <Text style={styles.modalProductName} numberOfLines={1}>{product.name}</Text>

            {editError && (
              <View style={styles.errorBox}>
                <Text style={styles.errorText}>{editError}</Text>
              </View>
            )}

            <View style={styles.inputGroup}>
              <Text style={styles.inputLabel}>{t('mobile.products.stockQuantity', 'স্টক সংখ্যা')}</Text>
              <TextInput
                style={styles.textInput}
                keyboardType="numeric"
                value={manualStock}
                onChangeText={setManualStock}
                placeholder="0"
                placeholderTextColor={neutral.muted}
              />
            </View>

            <View style={styles.inputGroup}>
              <Text style={styles.inputLabel}>{t('mobile.products.priceTaka', 'মূল্য (৳)')}</Text>
              <TextInput
                style={styles.textInput}
                keyboardType="decimal-pad"
                value={manualPrice}
                onChangeText={setManualPrice}
                placeholder="0.00"
                placeholderTextColor={neutral.muted}
              />
            </View>

            <View style={styles.modalActions}>
              <Pressable
                accessibilityRole="button"
                style={styles.cancelBtn}
                onPress={() => setIsEditModalOpen(false)}
                disabled={isPending}
              >
                <Text style={styles.cancelBtnText}>{t('mobile.common.cancel', 'বাতিল')}</Text>
              </Pressable>

              <Pressable
                accessibilityRole="button"
                style={styles.saveBtn}
                onPress={handleSaveManual}
                disabled={isDisabled}
              >
                {isPending ? (
                  <ActivityIndicator size="small" color="#FFFFFF" />
                ) : (
                  <Text style={styles.saveBtnText}>{t('mobile.common.save', 'সংরক্ষণ')}</Text>
                )}
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginTop: spacing.one,
  },
  stepperRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  stepperBtn: {
    minWidth: 38,
    height: 34,
    borderRadius: radius.default,
    backgroundColor: '#F3F4F6',
    borderWidth: 1,
    borderColor: '#E5E7EB',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 6,
  },
  stepperBtnDisabled: {
    opacity: 0.4,
  },
  stepperBtnText: {
    fontFamily: fontFamily.bold,
    fontSize: 14,
    color: brandColors.text,
  },
  stepperBtnTextDisabled: {
    color: neutral.muted,
  },
  stockDisplay: {
    minWidth: 48,
    height: 34,
    paddingHorizontal: 8,
    borderRadius: radius.default,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: brandColors.primary,
    justifyContent: 'center',
    alignItems: 'center',
  },
  stockCountWrapper: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 2,
  },
  stockCountText: {
    fontFamily: fontFamily.bold,
    fontSize: 15,
    color: brandColors.primary,
  },
  stockUnitText: {
    fontFamily: fontFamily.regular,
    fontSize: 10,
    color: neutral.muted,
  },
  quickJumpBtn: {
    backgroundColor: '#EEF2FF',
    borderColor: '#C7D2FE',
  },
  quickJumpText: {
    fontFamily: fontFamily.bold,
    fontSize: 12,
    color: '#4338CA',
  },
  soldOutBtn: {
    backgroundColor: '#FEE2E2',
    borderColor: '#FECACA',
  },
  soldOutText: {
    fontFamily: fontFamily.bold,
    fontSize: 12,
    color: '#DC2626',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.three,
  },
  modalContainer: {
    width: '100%',
    maxWidth: 380,
    backgroundColor: '#FFFFFF',
    borderRadius: radius.default,
    padding: spacing.three,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
    elevation: 8,
  },
  modalTitle: {
    fontFamily: fontFamily.bold,
    fontSize: 18,
    color: brandColors.text,
  },
  modalProductName: {
    fontFamily: fontFamily.regular,
    fontSize: 13,
    color: neutral.muted,
    marginTop: 2,
    marginBottom: spacing.two,
  },
  errorBox: {
    backgroundColor: '#FEE2E2',
    padding: spacing.one,
    borderRadius: radius.default,
    marginBottom: spacing.two,
  },
  errorText: {
    fontFamily: fontFamily.medium,
    fontSize: 12,
    color: '#DC2626',
  },
  inputGroup: {
    marginBottom: spacing.two,
  },
  inputLabel: {
    fontFamily: fontFamily.medium,
    fontSize: 13,
    color: brandColors.text,
    marginBottom: 4,
  },
  textInput: {
    height: 44,
    borderWidth: 1,
    borderColor: '#D1D5DB',
    borderRadius: radius.default,
    paddingHorizontal: spacing.two,
    fontFamily: fontFamily.regular,
    fontSize: 15,
    color: brandColors.text,
    backgroundColor: '#F9FAFB',
  },
  modalActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.two,
    marginTop: spacing.two,
  },
  cancelBtn: {
    paddingVertical: spacing.one,
    paddingHorizontal: spacing.three,
    borderRadius: radius.default,
    borderWidth: 1,
    borderColor: '#D1D5DB',
    justifyContent: 'center',
    alignItems: 'center',
  },
  cancelBtnText: {
    fontFamily: fontFamily.medium,
    fontSize: 14,
    color: neutral.muted,
  },
  saveBtn: {
    paddingVertical: spacing.one,
    paddingHorizontal: spacing.three,
    borderRadius: radius.default,
    backgroundColor: brandColors.primary,
    justifyContent: 'center',
    alignItems: 'center',
    minWidth: 80,
  },
  saveBtnText: {
    fontFamily: fontFamily.bold,
    fontSize: 14,
    color: '#FFFFFF',
  },
});
