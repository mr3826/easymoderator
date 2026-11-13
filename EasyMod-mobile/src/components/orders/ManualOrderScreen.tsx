import React, { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';

import { useCreateManualOrder } from '@/hooks/useOrders';
import { useNetworkStatus } from '@/hooks/useNetworkStatus';
import { brandColors, fontFamily, neutral, radius, spacing } from '@/theme/tokens';

export function ManualOrderScreen() {
  const { t } = useTranslation();
  const isOnline = useNetworkStatus();
  const [customerPhone, setCustomerPhone] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [deliveryAddress, setDeliveryAddress] = useState('');
  const [productName, setProductName] = useState('');
  const [quantity, setQuantity] = useState(1);
  const [price, setPrice] = useState('');
  const [deliveryFee, setDeliveryFee] = useState(60);
  const [discount, setDiscount] = useState('');
  const [notes, setNotes] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successOrder, setSuccessOrder] = useState<string | null>(null);

  const createOrderMutation = useCreateManualOrder();

  const unitPrice = Number(price) || 0;
  const discountAmount = Number(discount) || 0;
  const subtotal = quantity * unitPrice;
  const totalAmount = Math.max(0, subtotal + deliveryFee - discountAmount);

  const handleCreateOrder = (isDraft = false) => {
    if (!isOnline) return;
    setErrorMsg(null);
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
        notes: notes.trim() || undefined,
        is_draft: isDraft,
        idempotencyKey: `manual-ord-${Date.now()}`,
      },
      {
        onSuccess: (data) => {
          setSuccessOrder(data.order.order_number || data.order.id);
        },
        onError: (err) => {
          setErrorMsg(err.message || t('mobile.orders.manualOrder.error'));
        },
      },
    );
  };

  const handleReset = () => {
    setCustomerPhone('');
    setCustomerName('');
    setDeliveryAddress('');
    setProductName('');
    setQuantity(1);
    setPrice('');
    setDeliveryFee(60);
    setDiscount('');
    setNotes('');
    setErrorMsg(null);
    setSuccessOrder(null);
  };

  return (
    <SafeAreaView style={styles.container} testID="mobile-manual-order-screen">
      <KeyboardAvoidingView
        style={styles.keyboardContainer}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
          <View style={styles.header}>
            <Text style={styles.headerTitle}>{t('mobile.orders.manualOrder.title')}</Text>
          </View>

          {/* Success Banner */}
          {successOrder ? (
            <View style={styles.successBanner} testID="mobile-manual-order-success">
              <Text style={styles.successTitle}>🎉 {t('mobile.orders.manualOrder.success')}</Text>
              <Text style={styles.successSub}>#{successOrder}</Text>
              <Pressable style={styles.resetButton} onPress={handleReset}>
                <Text style={styles.resetButtonText}>+ Create Another Order</Text>
              </Pressable>
            </View>
          ) : (
            <>
              {errorMsg ? (
                <View style={styles.errorBanner} testID="mobile-manual-order-error">
                  <Text style={styles.errorText}>{errorMsg}</Text>
                </View>
              ) : null}

              {/* Customer Information */}
              <View style={styles.card}>
                <Text style={styles.cardTitle}>{t('mobile.customers.title')}</Text>

                <Text style={styles.label}>{t('mobile.orders.manualOrder.customerPhone')} *</Text>
                <TextInput
                  style={styles.input}
                  placeholder="017xxxxxxxx"
                  placeholderTextColor={neutral.muted}
                  keyboardType="phone-pad"
                  value={customerPhone}
                  onChangeText={setCustomerPhone}
                  testID="mobile-manual-phone-input"
                />

                <Text style={styles.label}>{t('mobile.orders.manualOrder.customerName')}</Text>
                <TextInput
                  style={styles.input}
                  placeholder="Customer Name"
                  placeholderTextColor={neutral.muted}
                  value={customerName}
                  onChangeText={setCustomerName}
                  testID="mobile-manual-name-input"
                />

                <Text style={styles.label}>{t('mobile.orders.manualOrder.deliveryAddress')}</Text>
                <TextInput
                  style={[styles.input, styles.multilineInput]}
                  placeholder="House, Road, Area, City"
                  placeholderTextColor={neutral.muted}
                  multiline
                  numberOfLines={2}
                  value={deliveryAddress}
                  onChangeText={setDeliveryAddress}
                  testID="mobile-manual-address-input"
                />
              </View>

              {/* Product Information */}
              <View style={styles.card}>
                <Text style={styles.cardTitle}>{t('mobile.orders.detail.items')}</Text>

                <Text style={styles.label}>{t('mobile.orders.manualOrder.selectProduct')} *</Text>
                <TextInput
                  style={styles.input}
                  placeholder="Product Name / Model"
                  placeholderTextColor={neutral.muted}
                  value={productName}
                  onChangeText={setProductName}
                  testID="mobile-manual-product-input"
                />

                <View style={styles.row}>
                  <View style={styles.halfCol}>
                    <Text style={styles.label}>{t('mobile.orders.manualOrder.quantity')} *</Text>
                    <View style={styles.qtyControl}>
                      <Pressable
                        style={styles.qtyBtn}
                        onPress={() => setQuantity(Math.max(1, quantity - 1))}
                        accessibilityRole="button"
                      >
                        <Text style={styles.qtyBtnText}>-</Text>
                      </Pressable>
                      <Text style={styles.qtyText} testID="mobile-manual-qty-text">{quantity}</Text>
                      <Pressable
                        style={styles.qtyBtn}
                        onPress={() => setQuantity(quantity + 1)}
                        accessibilityRole="button"
                      >
                        <Text style={styles.qtyBtnText}>+</Text>
                      </Pressable>
                    </View>
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
                      testID="mobile-manual-price-input"
                    />
                  </View>
                </View>
              </View>

              {/* Delivery Fee & Total */}
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Pricing & Delivery</Text>

                <Text style={styles.label}>{t('mobile.orders.manualOrder.deliveryFee')}</Text>
                <View style={styles.deliveryFeePills}>
                  <Pressable
                    style={[styles.pill, deliveryFee === 60 ? styles.pillActive : null]}
                    onPress={() => setDeliveryFee(60)}
                  >
                    <Text style={[styles.pillText, deliveryFee === 60 ? styles.pillTextActive : null]}>
                      Inside Dhaka (৳60)
                    </Text>
                  </Pressable>
                  <Pressable
                    style={[styles.pill, deliveryFee === 120 ? styles.pillActive : null]}
                    onPress={() => setDeliveryFee(120)}
                  >
                    <Text style={[styles.pillText, deliveryFee === 120 ? styles.pillTextActive : null]}>
                      Outside Dhaka (৳120)
                    </Text>
                  </Pressable>
                  <Pressable
                    style={[styles.pill, deliveryFee === 0 ? styles.pillActive : null]}
                    onPress={() => setDeliveryFee(0)}
                  >
                    <Text style={[styles.pillText, deliveryFee === 0 ? styles.pillTextActive : null]}>
                      Free (৳0)
                    </Text>
                  </Pressable>
                </View>

                <View style={styles.row}>
                  <View style={styles.halfCol}>
                    <Text style={styles.label}>{t('mobile.orders.manualOrder.discount')}</Text>
                    <TextInput
                      style={styles.input}
                      placeholder="0"
                      placeholderTextColor={neutral.muted}
                      keyboardType="numeric"
                      value={discount}
                      onChangeText={setDiscount}
                    />
                  </View>

                  <View style={styles.halfCol}>
                    <Text style={styles.label}>{t('mobile.orders.manualOrder.total')}</Text>
                    <View style={styles.totalDisplay}>
                      <Text style={styles.totalAmountText} testID="mobile-manual-total-amount">৳{totalAmount}</Text>
                    </View>
                  </View>
                </View>
              </View>

              {/* Submit Buttons */}
              <View style={styles.actions}>
                <Pressable
                   style={[styles.submitButton, (createOrderMutation.isPending || !isOnline) ? styles.buttonDisabled : null]}
                   onPress={() => handleCreateOrder(false)}
                   disabled={createOrderMutation.isPending || !isOnline}
                  testID="mobile-manual-order-submit-btn"
                  accessibilityRole="button"
                >
                  {createOrderMutation.isPending ? (
                    <ActivityIndicator color="#FFFFFF" size="small" />
                  ) : (
                    <Text style={styles.submitButtonText}>{t('mobile.orders.manualOrder.submit')}</Text>
                  )}
                </Pressable>

                <Pressable
                   style={[styles.draftButton, !isOnline ? styles.buttonDisabled : null]}
                   onPress={() => handleCreateOrder(true)}
                   disabled={createOrderMutation.isPending || !isOnline}
                  testID="mobile-manual-order-draft-btn"
                  accessibilityRole="button"
                >
                  <Text style={styles.draftButtonText}>Save as Draft</Text>
                </Pressable>
              </View>
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: brandColors.background },
  keyboardContainer: { flex: 1 },
  scrollContent: { padding: spacing.three, gap: spacing.three },
  header: {
    paddingVertical: spacing.two,
    borderBottomWidth: 1,
    borderBottomColor: neutral.border,
  },
  headerTitle: { color: brandColors.text, fontFamily: fontFamily.bold, fontSize: 20 },
  card: {
    backgroundColor: neutral.surface,
    padding: spacing.three,
    borderRadius: radius.default,
    borderWidth: 1,
    borderColor: neutral.border,
    gap: spacing.two,
  },
  cardTitle: { color: brandColors.text, fontFamily: fontFamily.semiBold, fontSize: 16, marginBottom: spacing.half },
  label: { color: neutral.muted, fontFamily: fontFamily.medium, fontSize: 13 },
  input: {
    borderWidth: 1,
    borderColor: neutral.border,
    borderRadius: radius.default,
    padding: spacing.two,
    fontFamily: fontFamily.regular,
    fontSize: 15,
    color: brandColors.text,
    backgroundColor: brandColors.background,
  },
  multilineInput: { minHeight: 60, textAlignVertical: 'top' },
  row: { flexDirection: 'row', gap: spacing.two },
  halfCol: { flex: 1, gap: spacing.one },
  qtyControl: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: neutral.border,
    borderRadius: radius.default,
    backgroundColor: brandColors.background,
    overflow: 'hidden',
  },
  qtyBtn: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: neutral.surface,
  },
  qtyBtnText: { fontSize: 20, color: brandColors.primaryDark, fontFamily: fontFamily.bold },
  qtyText: { flex: 1, textAlign: 'center', fontFamily: fontFamily.bold, fontSize: 16, color: brandColors.text },
  deliveryFeePills: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.one },
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
  totalDisplay: {
    borderWidth: 1,
    borderColor: brandColors.primary,
    borderRadius: radius.default,
    padding: spacing.two,
    backgroundColor: '#F0FDF4',
    alignItems: 'center',
    justifyContent: 'center',
  },
  totalAmountText: { color: brandColors.primaryDark, fontFamily: fontFamily.bold, fontSize: 18 },
  actions: { gap: spacing.two, marginTop: spacing.two },
  submitButton: {
    backgroundColor: brandColors.primary,
    borderRadius: radius.default,
    paddingVertical: spacing.two + 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  submitButtonText: { color: '#FFFFFF', fontFamily: fontFamily.semiBold, fontSize: 16 },
  draftButton: {
    borderWidth: 1,
    borderColor: neutral.border,
    backgroundColor: neutral.surface,
    borderRadius: radius.default,
    paddingVertical: spacing.two + 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  draftButtonText: { color: neutral.muted, fontFamily: fontFamily.medium, fontSize: 14 },
  buttonDisabled: { opacity: 0.6 },
  errorBanner: {
    backgroundColor: '#FEE2E2',
    padding: spacing.two,
    borderRadius: radius.default,
    borderWidth: 1,
    borderColor: '#FCA5A5',
  },
  errorText: { color: brandColors.destructive, fontFamily: fontFamily.medium, fontSize: 13, textAlign: 'center' },
  successBanner: {
    backgroundColor: '#ECFDF5',
    padding: spacing.four,
    borderRadius: radius.default,
    borderWidth: 1,
    borderColor: '#A7F3D0',
    alignItems: 'center',
    gap: spacing.two,
  },
  successTitle: { color: brandColors.primaryDark, fontFamily: fontFamily.bold, fontSize: 18 },
  successSub: { color: brandColors.text, fontFamily: fontFamily.semiBold, fontSize: 15 },
  resetButton: {
    backgroundColor: brandColors.primary,
    borderRadius: radius.default,
    paddingHorizontal: spacing.four,
    paddingVertical: spacing.two,
    marginTop: spacing.two,
  },
  resetButtonText: { color: '#FFFFFF', fontFamily: fontFamily.semiBold, fontSize: 14 },
});
