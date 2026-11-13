import React, { useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useTranslation } from 'react-i18next';

import { useCreateManualOrder } from '@/hooks/useOrders';
import { useNetworkStatus } from '@/hooks/useNetworkStatus';
import { brandColors, fontFamily, neutral, radius, spacing } from '@/theme/tokens';

export interface OrderDraftModalProps {
  visible: boolean;
  onClose: () => void;
  initialCustomerName?: string;
  initialCustomerPhone?: string;
  initialAddress?: string;
  onOrderCreated?: (orderId: string) => void;
}

export function OrderDraftModal({
  visible,
  onClose,
  initialCustomerName = '',
  initialCustomerPhone = '',
  initialAddress = '',
  onOrderCreated,
}: OrderDraftModalProps) {
  const { t } = useTranslation();
  const isOnline = useNetworkStatus();

  const [customerName, setCustomerName] = useState(initialCustomerName);
  const [customerPhone, setCustomerPhone] = useState(initialCustomerPhone);
  const [deliveryAddress, setDeliveryAddress] = useState(initialAddress);
  const [productName, setProductName] = useState('');
  const [quantity, setQuantity] = useState(1);
  const [price, setPrice] = useState('');
  const [deliveryFee, setDeliveryFee] = useState(60);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const createOrderMutation = useCreateManualOrder();

  const unitPrice = Number(price) || 0;
  const discountAmount = 0;
  const subtotal = quantity * unitPrice;
  const totalAmount = Math.max(0, subtotal + deliveryFee - discountAmount);

  const handleSubmit = (isDraft: boolean) => {
    setErrorMsg(null);
    if (!isOnline) {
      setErrorMsg(t('mobile.offline.mutationUnavailable', 'Reconnect to continue this action.'));
      return;
    }
    const trimmedPhone = customerPhone.trim();
    if (!trimmedPhone) {
      setErrorMsg(t('mobile.orders.manualOrder.customerPhone') + ' is required');
      return;
    }
    if (!productName.trim()) {
      setErrorMsg(t('mobile.orders.manualOrder.selectProduct') + ' is required');
      return;
    }
    if (unitPrice <= 0) {
      setErrorMsg(t('mobile.orders.manualOrder.price') + ' must be greater than 0');
      return;
    }

    createOrderMutation.mutate(
      {
        customer_name: customerName.trim() || undefined,
        customer_phone: trimmedPhone,
        delivery_address: deliveryAddress.trim() || undefined,
        items: [
          {
            name: productName.trim(),
            quantity,
            price: unitPrice,
          },
        ],
        delivery_fee: deliveryFee,
        discount: discountAmount,
        is_draft: isDraft,
        idempotencyKey: `draft-ord-${Date.now()}`,
      },
      {
        onSuccess: (data) => {
          onClose();
          if (onOrderCreated) {
            onOrderCreated(data.order.id);
          }
        },
        onError: (err) => {
          setErrorMsg(err.message || t('mobile.orders.manualOrder.error'));
        },
      },
    );
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
      testID="mobile-order-draft-modal"
    >
      <View style={styles.modalOverlay}>
        <View style={styles.modalContainer}>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.scrollContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>{t('mobile.orders.detail.actions.createDraft')}</Text>
              <Pressable onPress={onClose} style={styles.closeBtn} accessibilityRole="button">
                <Text style={styles.closeBtnText}>✕</Text>
              </Pressable>
            </View>

            <View style={styles.hitlBanner}>
              <Text style={styles.hitlBannerText}>
                🛡️ Human Review Required: Review customer details before committing.
              </Text>
            </View>

            {errorMsg ? (
              <View style={styles.errorBanner}>
                <Text style={styles.errorText}>{errorMsg}</Text>
              </View>
            ) : null}

            {/* Customer Inputs */}
            <Text style={styles.label}>{t('mobile.orders.manualOrder.customerPhone')} *</Text>
            <TextInput
              style={styles.input}
              placeholder="017xxxxxxxx"
              placeholderTextColor={neutral.muted}
              keyboardType="phone-pad"
              value={customerPhone}
              onChangeText={setCustomerPhone}
              testID="mobile-draft-phone-input"
            />

            <Text style={styles.label}>{t('mobile.orders.manualOrder.customerName')}</Text>
            <TextInput
              style={styles.input}
              placeholder="Customer Name"
              placeholderTextColor={neutral.muted}
              value={customerName}
              onChangeText={setCustomerName}
              testID="mobile-draft-name-input"
            />

            <Text style={styles.label}>{t('mobile.orders.manualOrder.deliveryAddress')}</Text>
            <TextInput
              style={[styles.input, styles.multilineInput]}
              placeholder="Delivery address"
              placeholderTextColor={neutral.muted}
              multiline
              numberOfLines={2}
              value={deliveryAddress}
              onChangeText={setDeliveryAddress}
              testID="mobile-draft-address-input"
            />

            {/* Product Inputs */}
            <Text style={styles.label}>{t('mobile.orders.manualOrder.selectProduct')} *</Text>
            <TextInput
              style={styles.input}
              placeholder="Product Name"
              placeholderTextColor={neutral.muted}
              value={productName}
              onChangeText={setProductName}
              testID="mobile-draft-product-input"
            />

            <View style={styles.row}>
              <View style={styles.halfCol}>
                <Text style={styles.label}>{t('mobile.orders.manualOrder.quantity')} *</Text>
                <TextInput
                  style={styles.input}
                  placeholder="1"
                  placeholderTextColor={neutral.muted}
                  keyboardType="numeric"
                  value={String(quantity)}
                  onChangeText={(val) => setQuantity(Math.max(1, parseInt(val, 10) || 1))}
                  testID="mobile-draft-qty-input"
                />
              </View>

              <View style={styles.halfCol}>
                <Text style={styles.label}>{t('mobile.orders.manualOrder.price')} *</Text>
                <TextInput
                  style={styles.input}
                  placeholder="1000"
                  placeholderTextColor={neutral.muted}
                  keyboardType="numeric"
                  value={price}
                  onChangeText={setPrice}
                  testID="mobile-draft-price-input"
                />
              </View>
            </View>

            {/* Delivery fee selection */}
            <Text style={styles.label}>{t('mobile.orders.manualOrder.deliveryFee')}</Text>
            <View style={styles.row}>
              <Pressable
                style={[styles.pill, deliveryFee === 60 ? styles.pillActive : null]}
                onPress={() => setDeliveryFee(60)}
              >
                <Text style={[styles.pillText, deliveryFee === 60 ? styles.pillTextActive : null]}>৳60 Dhaka</Text>
              </Pressable>
              <Pressable
                style={[styles.pill, deliveryFee === 120 ? styles.pillActive : null]}
                onPress={() => setDeliveryFee(120)}
              >
                <Text style={[styles.pillText, deliveryFee === 120 ? styles.pillTextActive : null]}>৳120 Outside</Text>
              </Pressable>
              <Pressable
                style={[styles.pill, deliveryFee === 0 ? styles.pillActive : null]}
                onPress={() => setDeliveryFee(0)}
              >
                <Text style={[styles.pillText, deliveryFee === 0 ? styles.pillTextActive : null]}>৳0 Free</Text>
              </Pressable>
            </View>

            {/* Total summary */}
            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>{t('mobile.orders.manualOrder.total')}:</Text>
              <Text style={styles.totalValue} testID="mobile-draft-total-value">৳{totalAmount}</Text>
            </View>

            {/* Submit Actions */}
            <View style={styles.actions}>
              <Pressable
                style={[styles.confirmBtn, (createOrderMutation.isPending || !isOnline) ? styles.buttonDisabled : null]}
                onPress={() => handleSubmit(false)}
                disabled={createOrderMutation.isPending || !isOnline}
                testID="mobile-draft-confirm-btn"
                accessibilityRole="button"
              >
                {createOrderMutation.isPending ? (
                  <ActivityIndicator color="#FFFFFF" size="small" />
                ) : (
                  <Text style={styles.confirmBtnText}>{t('mobile.orders.detail.actions.confirm')}</Text>
                )}
              </Pressable>

              <Pressable
                style={[styles.draftBtn, !isOnline ? styles.buttonDisabled : null]}
                onPress={() => handleSubmit(true)}
                disabled={createOrderMutation.isPending || !isOnline}
                testID="mobile-draft-save-btn"
                accessibilityRole="button"
              >
                <Text style={styles.draftBtnText}>Save as Draft</Text>
              </Pressable>
            </View>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  modalOverlay: {
    flex: 1,
    backgroundColor: neutral.overlay,
    justifyContent: 'flex-end',
  },
  modalContainer: {
    backgroundColor: neutral.surface,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    maxHeight: '90%',
  },
  scrollContent: { padding: spacing.three, gap: spacing.two },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.one,
  },
  modalTitle: { color: brandColors.text, fontFamily: fontFamily.bold, fontSize: 18 },
  closeBtn: { padding: spacing.one },
  closeBtnText: { color: neutral.muted, fontSize: 18, fontFamily: fontFamily.bold },
  hitlBanner: {
    backgroundColor: '#EFF6FF',
    borderRadius: radius.default,
    padding: spacing.two,
    borderWidth: 1,
    borderColor: '#BFDBFE',
  },
  hitlBannerText: { color: '#1E40AF', fontFamily: fontFamily.medium, fontSize: 12 },
  label: { color: neutral.muted, fontFamily: fontFamily.medium, fontSize: 12 },
  input: {
    borderWidth: 1,
    borderColor: neutral.border,
    borderRadius: radius.default,
    padding: spacing.two,
    fontFamily: fontFamily.regular,
    fontSize: 14,
    color: brandColors.text,
    backgroundColor: brandColors.background,
  },
  multilineInput: { minHeight: 50, textAlignVertical: 'top' },
  row: { flexDirection: 'row', gap: spacing.two },
  halfCol: { flex: 1, gap: spacing.one },
  pill: {
    borderWidth: 1,
    borderColor: neutral.border,
    borderRadius: 16,
    paddingHorizontal: spacing.two,
    paddingVertical: spacing.one,
    backgroundColor: brandColors.background,
  },
  pillActive: {
    backgroundColor: brandColors.primary,
    borderColor: brandColors.primary,
  },
  pillText: { color: neutral.muted, fontFamily: fontFamily.medium, fontSize: 12 },
  pillTextActive: { color: '#FFFFFF' },
  totalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: spacing.two,
    borderTopWidth: 1,
    borderTopColor: neutral.border,
    marginTop: spacing.one,
  },
  totalLabel: { color: brandColors.text, fontFamily: fontFamily.semiBold, fontSize: 16 },
  totalValue: { color: brandColors.primaryDark, fontFamily: fontFamily.bold, fontSize: 20 },
  actions: { gap: spacing.two, marginTop: spacing.two },
  confirmBtn: {
    backgroundColor: brandColors.primary,
    borderRadius: radius.default,
    paddingVertical: spacing.two + 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  confirmBtnText: { color: '#FFFFFF', fontFamily: fontFamily.semiBold, fontSize: 16 },
  draftBtn: {
    borderWidth: 1,
    borderColor: neutral.border,
    backgroundColor: neutral.surface,
    borderRadius: radius.default,
    paddingVertical: spacing.two + 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  draftBtnText: { color: neutral.muted, fontFamily: fontFamily.medium, fontSize: 14 },
  buttonDisabled: { opacity: 0.6 },
  errorBanner: {
    backgroundColor: '#FEE2E2',
    padding: spacing.two,
    borderRadius: radius.default,
    borderWidth: 1,
    borderColor: '#FCA5A5',
  },
  errorText: { color: brandColors.destructive, fontFamily: fontFamily.medium, fontSize: 13, textAlign: 'center' },
});
