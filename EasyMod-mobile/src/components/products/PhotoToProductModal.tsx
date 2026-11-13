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

import { usePhotoDraft } from '@/hooks/useProducts';
import { useNetworkStatus } from '@/hooks/useNetworkStatus';
import { brandColors, fontFamily, neutral, radius, spacing } from '@/theme/tokens';

interface PhotoToProductModalProps {
  visible: boolean;
  onClose: () => void;
  onSuccess?: () => void;
}

export function PhotoToProductModal({ visible, onClose, onSuccess }: PhotoToProductModalProps) {
  const { t } = useTranslation();
  const isOnline = useNetworkStatus();
  const photoDraftMutation = usePhotoDraft();

  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [quantity, setQuantity] = useState('0');
  const [category, setCategory] = useState('');
  const [description, setDescription] = useState('');
  const [imageUrl, setImageUrl] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleSubmit = () => {
    setErrorMessage(null);
    if (!isOnline) {
      setErrorMessage(t('mobile.offline.mutationUnavailable', 'Reconnect to continue this action.'));
      return;
    }
    const trimmedName = name.trim();
    if (!trimmedName) {
      setErrorMessage(t('mobile.products.nameRequired', 'পণ্যের নাম আবশ্যক'));
      return;
    }

    const parsedPrice = Number.parseFloat(price);
    if (Number.isNaN(parsedPrice) || parsedPrice <= 0) {
      setErrorMessage(t('mobile.products.priceRequired', 'সঠিক মূল্য উল্লেখ করুন'));
      return;
    }

    const parsedQuantity = Math.max(0, Number.parseInt(quantity, 10) || 0);

    photoDraftMutation.mutate(
      {
        name: trimmedName,
        price: parsedPrice,
        quantity: parsedQuantity,
        category: category.trim() || undefined,
        description: description.trim() || undefined,
        image_url: imageUrl.trim() || undefined,
      },
      {
        onSuccess: () => {
          resetForm();
          onClose();
          onSuccess?.();
        },
        onError: (err) => {
          setErrorMessage(err.message || t('mobile.products.draftFailed', 'ড্রাফট তৈরি ব্যর্থ হয়েছে'));
        },
      },
    );
  };

  const resetForm = () => {
    setName('');
    setPrice('');
    setQuantity('0');
    setCategory('');
    setDescription('');
    setImageUrl('');
    setErrorMessage(null);
  };

  const isPending = photoDraftMutation.isPending;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <View style={styles.modalOverlay}>
        <View style={styles.modalContainer}>
          <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
            <View style={styles.headerRow}>
              <Text style={styles.modalTitle}>{t('mobile.products.addDraftTitle', 'নতুন পণ্যের ড্রাফট')}</Text>
              <Pressable onPress={onClose} hitSlop={10} testID="photo-draft-close-btn">
                <Text style={styles.closeBtn}>✕</Text>
              </Pressable>
            </View>

            {/* Non-Publish Warning / HITL Badge */}
            <View style={styles.draftNoticeBox}>
              <Text style={styles.draftNoticeTitle}>{t('mobile.products.draftNoticeTitle', 'অপ্রকাশিত খসড়া (Draft)')}</Text>
              <Text style={styles.draftNoticeText}>
                {t(
                  'mobile.products.draftNoticeText',
                  'পণ্যটি সরাসরি প্রকাশ পাবে না। আপনি পরে ওয়েব বা মোবাইল থেকে চেক করে সক্রিয় করতে পারবেন।',
                )}
              </Text>
            </View>

            {errorMessage && (
              <View style={styles.errorBox}>
                <Text style={styles.errorText}>{errorMessage}</Text>
              </View>
            )}

            {/* Product Name */}
            <View style={styles.inputGroup}>
              <Text style={styles.inputLabel}>{t('mobile.products.nameLabel', 'পণ্যের নাম *')}</Text>
              <TextInput
                style={styles.textInput}
                testID="photo-draft-name-input"
                value={name}
                onChangeText={setName}
                placeholder={t('mobile.products.namePlaceholder', 'যেমন: প্রিমিয়াম পাঞ্জাবি')}
                placeholderTextColor={neutral.muted}
              />
            </View>

            {/* Price & Quantity Row */}
            <View style={styles.twoColumnRow}>
              <View style={[styles.inputGroup, { flex: 1 }]}>
                <Text style={styles.inputLabel}>{t('mobile.products.priceLabel', 'মূল্য (৳) *')}</Text>
                <TextInput
                  style={styles.textInput}
                  testID="photo-draft-price-input"
                  keyboardType="decimal-pad"
                  value={price}
                  onChangeText={setPrice}
                  placeholder="0.00"
                  placeholderTextColor={neutral.muted}
                />
              </View>

              <View style={[styles.inputGroup, { flex: 1 }]}>
                <Text style={styles.inputLabel}>{t('mobile.products.quantityLabel', 'প্রাথমিক স্টক')}</Text>
                <TextInput
                  style={styles.textInput}
                  testID="photo-draft-quantity-input"
                  keyboardType="numeric"
                  value={quantity}
                  onChangeText={setQuantity}
                  placeholder="0"
                  placeholderTextColor={neutral.muted}
                />
              </View>
            </View>

            {/* Category & Image URL */}
            <View style={styles.inputGroup}>
              <Text style={styles.inputLabel}>{t('mobile.products.categoryLabel', 'ক্যাটেগরি (ঐচ্ছিক)')}</Text>
              <TextInput
                style={styles.textInput}
                value={category}
                onChangeText={setCategory}
                placeholder={t('mobile.products.categoryPlaceholder', 'যেমন: পোশাক, এক্সেসরিজ')}
                placeholderTextColor={neutral.muted}
              />
            </View>

            <View style={styles.inputGroup}>
              <Text style={styles.inputLabel}>{t('mobile.products.imageLabel', 'ছবির লিংক (ঐচ্ছিক)')}</Text>
              <TextInput
                style={styles.textInput}
                value={imageUrl}
                onChangeText={setImageUrl}
                placeholder="https://..."
                placeholderTextColor={neutral.muted}
                autoCapitalize="none"
              />
            </View>

            {/* Description */}
            <View style={styles.inputGroup}>
              <Text style={styles.inputLabel}>{t('mobile.products.descriptionLabel', 'বিবরণ (ঐচ্ছিক)')}</Text>
              <TextInput
                style={[styles.textInput, styles.textArea]}
                value={description}
                onChangeText={setDescription}
                placeholder={t('mobile.products.descriptionPlaceholder', 'পণ্যের বিবরণ বা সাইজ...')}
                placeholderTextColor={neutral.muted}
                multiline
                numberOfLines={3}
              />
            </View>

            {/* Action Buttons */}
            <View style={styles.modalActions}>
              <Pressable
                accessibilityRole="button"
                style={styles.cancelBtn}
                onPress={onClose}
                disabled={isPending}
              >
                <Text style={styles.cancelBtnText}>{t('mobile.common.cancel', 'বাতিল')}</Text>
              </Pressable>

              <Pressable
                accessibilityRole="button"
                testID="photo-draft-submit-btn"
                style={styles.saveDraftBtn}
                onPress={handleSubmit}
                disabled={isPending || !isOnline}
              >
                {isPending ? (
                  <ActivityIndicator size="small" color="#FFFFFF" />
                ) : (
                  <Text style={styles.saveDraftBtnText}>
                    {t('mobile.products.saveDraftBtn', 'ড্রাফট সংরক্ষণ করুন')}
                  </Text>
                )}
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
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.two,
  },
  modalContainer: {
    width: '100%',
    maxWidth: 420,
    maxHeight: '90%',
    backgroundColor: '#FFFFFF',
    borderRadius: radius.default,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
    elevation: 8,
  },
  scrollContent: {
    padding: spacing.three,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.two,
  },
  modalTitle: {
    fontFamily: fontFamily.bold,
    fontSize: 20,
    color: brandColors.text,
  },
  closeBtn: {
    fontFamily: fontFamily.bold,
    fontSize: 18,
    color: neutral.muted,
    padding: spacing.half,
  },
  draftNoticeBox: {
    backgroundColor: '#F0FDF4',
    borderWidth: 1,
    borderColor: '#BBF7D0',
    padding: spacing.two,
    borderRadius: radius.default,
    marginBottom: spacing.two,
  },
  draftNoticeTitle: {
    fontFamily: fontFamily.bold,
    fontSize: 13,
    color: '#15803D',
    marginBottom: 2,
  },
  draftNoticeText: {
    fontFamily: fontFamily.regular,
    fontSize: 12,
    color: '#166534',
    lineHeight: 16,
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
  twoColumnRow: {
    flexDirection: 'row',
    gap: spacing.two,
  },
  inputLabel: {
    fontFamily: fontFamily.medium,
    fontSize: 13,
    color: brandColors.text,
    marginBottom: 4,
  },
  textInput: {
    minHeight: 44,
    borderWidth: 1,
    borderColor: '#D1D5DB',
    borderRadius: radius.default,
    paddingHorizontal: spacing.two,
    fontFamily: fontFamily.regular,
    fontSize: 15,
    color: brandColors.text,
    backgroundColor: '#F9FAFB',
  },
  textArea: {
    height: 72,
    paddingTop: 8,
    textAlignVertical: 'top',
  },
  modalActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.two,
    marginTop: spacing.two,
  },
  cancelBtn: {
    paddingVertical: spacing.two,
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
  saveDraftBtn: {
    paddingVertical: spacing.two,
    paddingHorizontal: spacing.three,
    borderRadius: radius.default,
    backgroundColor: brandColors.primary,
    justifyContent: 'center',
    alignItems: 'center',
    minWidth: 140,
  },
  saveDraftBtnText: {
    fontFamily: fontFamily.bold,
    fontSize: 14,
    color: '#FFFFFF',
  },
});
