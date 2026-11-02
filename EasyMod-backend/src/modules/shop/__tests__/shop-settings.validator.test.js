/**
 * Unit tests for shop settings validator
 */

const {
  validateAISettings,
  validateBDSettings,
  validateBusinessInfo,
  validateSettings,
  sanitizeSettings,
  mergeAndSanitizeSettings,
  mergeSettingsPreservingRtoConsent,
  stripAutomationModeFromShopUpdate,
  AI_SETTINGS_SCHEMA,
  BD_SETTINGS_SCHEMA,
  BUSINESS_INFO_SCHEMA
} = require('../shop-settings.validator');
const { AppError } = require('../../../utils/AppError');

describe('Shop Settings Validator', () => {
  describe('validateAISettings', () => {
    it('validates correct AI settings', () => {
      const validSettings = {
        automation_mode: 'AUTO',
        confidence_threshold: 75,
        auto_reply_enabled: true,
        max_auto_order_value: 5000,
        ask_email: false,
        primary_language: 'mixed',
        required_fields: {
          customer_name: true,
          mobile_number: true,
          delivery_address: true,
          payment_method: true,
          email_address: false,
          special_instructions: false,
        },
        handoff_settings: {
          trigger_keywords: ['complain', 'problem'],
          notification_channel: 'in_app',
          cooldown_minutes: 30,
        },
      };

      expect(() => validateAISettings(validSettings)).not.toThrow();
    });

    it('throws error for invalid automation_mode', () => {
      const invalidSettings = {
        automation_mode: 'INVALID_MODE',
      };

      expect(() => validateAISettings(invalidSettings)).toThrow(AppError);
      expect(() => validateAISettings(invalidSettings)).toThrow('AI settings validation failed');
    });

    it('throws error for confidence_threshold out of range', () => {
      const invalidSettings = {
        confidence_threshold: 150,
      };

      expect(() => validateAISettings(invalidSettings)).toThrow(AppError);
    });

    it('throws error for negative confidence_threshold', () => {
      const invalidSettings = {
        confidence_threshold: -10,
      };

      expect(() => validateAISettings(invalidSettings)).toThrow(AppError);
    });

    it('throws error for non-boolean auto_reply_enabled', () => {
      const invalidSettings = {
        auto_reply_enabled: 'yes',
      };

      expect(() => validateAISettings(invalidSettings)).toThrow(AppError);
    });

    it('throws error for invalid primary_language', () => {
      const invalidSettings = {
        primary_language: 'french',
      };

      expect(() => validateAISettings(invalidSettings)).toThrow(AppError);
    });

    it('throws error for invalid required_fields structure', () => {
      const invalidSettings = {
        required_fields: {
          customer_name: 'yes', // Should be boolean
        },
      };

      expect(() => validateAISettings(invalidSettings)).toThrow(AppError);
    });

    it('accepts partial handoff_settings updates for service deep-merge', () => {
      const partialSettings = {
        handoff_settings: {
          trigger_keywords: ['complain'],
        },
      };

      expect(() => validateAISettings(partialSettings)).not.toThrow();
    });

    it('throws error for invalid notification_channel', () => {
      const invalidSettings = {
        handoff_settings: {
          trigger_keywords: ['complain'],
          notification_channel: 'push', // Invalid value
          cooldown_minutes: 30,
        },
      };

      expect(() => validateAISettings(invalidSettings)).toThrow(AppError);
    });

    it('accepts telegram notification_channel', () => {
      expect(() => validateAISettings({
        handoff_settings: { notification_channel: 'telegram' },
      })).not.toThrow();
    });

    it('throws error for negative cooldown_minutes', () => {
      const invalidSettings = {
        handoff_settings: {
          trigger_keywords: ['complain'],
          notification_channel: 'in_app',
          cooldown_minutes: -5,
        },
      };

      expect(() => validateAISettings(invalidSettings)).toThrow(AppError);
    });

    it('throws error for null settings', () => {
      expect(() => validateAISettings(null)).toThrow(AppError);
      expect(() => validateAISettings(null)).toThrow('AI settings must be an object');
    });

    it('throws error for non-object settings', () => {
      expect(() => validateAISettings('string')).toThrow(AppError);
    });
  });

  describe('validateBDSettings', () => {
    it('validates correct BD settings with null values', () => {
      const validSettings = {
        mfs_mode: null,
        mfs_type: null,
        mfs_number: null,
        google_sheet_id: null,
        google_sheet_range: 'Sheet1!A:Z',
      };

      expect(() => validateBDSettings(validSettings)).not.toThrow();
    });

    it('validates correct BD settings with actual values', () => {
      const validSettings = {
        mfs_mode: 'self',
        mfs_type: 'bkash',
        mfs_number: '01712345678',
        google_sheet_id: 'spreadsheet123',
        google_sheet_range: 'Products!A:Z',
      };

      expect(() => validateBDSettings(validSettings)).not.toThrow();
    });

    it('validates all valid MFS modes', () => {
      const modes = ['self', 'business'];
      modes.forEach(mode => {
        expect(() => validateBDSettings({ mfs_mode: mode })).not.toThrow();
      });
    });

    it('validates all valid MFS types', () => {
      const types = ['bkash', 'nagad', 'rocket'];
      types.forEach(type => {
        expect(() => validateBDSettings({ mfs_type: type })).not.toThrow();
      });
    });

    it('throws error for invalid mfs_mode', () => {
      expect(() => validateBDSettings({ mfs_mode: 'invalid' })).toThrow(AppError);
    });

    it('throws error for invalid mfs_type', () => {
      expect(() => validateBDSettings({ mfs_type: 'paypal' })).toThrow(AppError);
    });

    it('throws error for invalid phone number format', () => {
      expect(() => validateBDSettings({ mfs_number: '12345' })).toThrow(AppError);
    });

    it('validates correct phone number with +88 prefix', () => {
      expect(() => validateBDSettings({ mfs_number: '+8801712345678' })).not.toThrow();
    });

    it('throws error for null input', () => {
      expect(() => validateBDSettings(null)).toThrow(AppError);
    });
  });

  describe('validateBusinessInfo', () => {
    it('validates correct business info', () => {
      const validInfo = {
        shopName: 'Test Shop',
        address: 'Dhaka, Bangladesh',
        phone: '01712345678',
        openingHours: '9am-9pm',
        additionalInfo: 'Owner says warranty is 7 days.',
        deliveryAreas: ['Dhaka', 'Chittagong'],
        paymentMethods: ['bKash', 'COD'],
      };

      expect(() => validateBusinessInfo(validInfo)).not.toThrow();
    });

    it('validates empty arrays', () => {
      const validInfo = {
        deliveryAreas: [],
        paymentMethods: [],
      };

      expect(() => validateBusinessInfo(validInfo)).not.toThrow();
    });

    it('throws error for non-array deliveryAreas', () => {
      const invalidInfo = {
        deliveryAreas: 'Dhaka', // Should be array
      };

      expect(() => validateBusinessInfo(invalidInfo)).toThrow(AppError);
    });

    it('rejects additionalInfo over the length cap', () => {
      expect(() => validateBusinessInfo({ additionalInfo: 'x'.repeat(3001) })).toThrow(AppError);
    });

    it('throws error for non-string array items in deliveryAreas', () => {
      const invalidInfo = {
        deliveryAreas: ['Dhaka', 123], // Should be all strings
      };

      expect(() => validateBusinessInfo(invalidInfo)).toThrow(AppError);
    });

    it('throws error for non-array paymentMethods', () => {
      const invalidInfo = {
        paymentMethods: 'bKash',
      };

      expect(() => validateBusinessInfo(invalidInfo)).toThrow(AppError);
    });

    it('throws error for null input', () => {
      expect(() => validateBusinessInfo(null)).toThrow(AppError);
    });
  });

  describe('validateAISettings — greeting & closing', () => {
    it('accepts a valid greeting block', () => {
      expect(() => validateAISettings({ greeting: { enabled: true, custom_text: 'Welcome!' } })).not.toThrow();
    });

    it('accepts a valid closing block (disabled, blank text)', () => {
      expect(() => validateAISettings({ closing: { enabled: false, custom_text: '' } })).not.toThrow();
    });

    it('accepts a partial greeting (enabled only)', () => {
      expect(() => validateAISettings({ greeting: { enabled: true } })).not.toThrow();
    });

    it('rejects a non-boolean greeting.enabled', () => {
      expect(() => validateAISettings({ greeting: { enabled: 'yes' } })).toThrow(AppError);
    });

    it('rejects a non-string closing.custom_text', () => {
      expect(() => validateAISettings({ closing: { custom_text: 123 } })).toThrow(AppError);
    });

    it('rejects greeting.custom_text over the length cap', () => {
      expect(() => validateAISettings({ greeting: { custom_text: 'x'.repeat(1001) } })).toThrow(AppError);
    });

    it('rejects a non-object greeting', () => {
      expect(() => validateAISettings({ greeting: 'hi' })).toThrow(AppError);
    });
  });

  describe('validateBusinessInfo — socialLinks', () => {
    it('accepts empty + valid links', () => {
      expect(() => validateBusinessInfo({
        socialLinks: { facebook: 'https://fb.com/x', instagram: '', whatsapp: '01711111111' },
      })).not.toThrow();
    });

    it('accepts a wa.me WhatsApp link', () => {
      expect(() => validateBusinessInfo({ socialLinks: { whatsapp: 'https://wa.me/8801711111111' } })).not.toThrow();
    });

    it('rejects a non-URL facebook value', () => {
      expect(() => validateBusinessInfo({ socialLinks: { facebook: 'not a url' } })).toThrow(AppError);
    });

    it('rejects an unknown platform key', () => {
      expect(() => validateBusinessInfo({ socialLinks: { snapchat: 'https://x.example' } })).toThrow(AppError);
    });

    it('rejects a non-object socialLinks', () => {
      expect(() => validateBusinessInfo({ socialLinks: 'https://fb.com' })).toThrow(AppError);
    });
  });

  describe('validateSettings', () => {
    it('validates empty settings object', () => {
      expect(() => validateSettings({})).not.toThrow();
    });

    it('validates settings with AI section', () => {
      const settings = {
        ai: {
          automation_mode: 'DRAFT',
          confidence_threshold: 60,
        },
      };

      expect(() => validateSettings(settings)).not.toThrow();
    });

    it('validates settings with BD section', () => {
      const settings = {
        bd: {
          mfs_mode: 'self',
          mfs_type: 'bkash',
        },
      };

      expect(() => validateSettings(settings)).not.toThrow();
    });

    it('validates settings with businessInfo section', () => {
      const settings = {
        businessInfo: {
          shopName: 'Test Shop',
          address: 'Dhaka',
        },
      };

      expect(() => validateSettings(settings)).not.toThrow();
    });

    it('validates complete settings object', () => {
      const settings = {
        ai: {
          automation_mode: 'AUTO',
          confidence_threshold: 75,
          auto_reply_enabled: true,
          max_auto_order_value: 5000,
          ask_email: false,
          primary_language: 'mixed',
          required_fields: {
            customer_name: true,
            mobile_number: true,
            delivery_address: true,
            payment_method: true,
            email_address: false,
            special_instructions: false,
          },
          handoff_settings: {
            trigger_keywords: ['complain'],
            notification_channel: 'in_app',
            cooldown_minutes: 30,
          },
        },
        bd: {
          mfs_mode: 'self',
          mfs_type: 'bkash',
          mfs_number: '01712345678',
        },
        businessInfo: {
          shopName: 'Test Shop',
          address: 'Dhaka',
          phone: '01712345678',
          openingHours: '9am-9pm',
          additionalInfo: 'Exchange within 3 days.',
          deliveryAreas: ['Dhaka'],
          paymentMethods: ['bKash'],
        },
      };

      expect(() => validateSettings(settings)).not.toThrow();
    });

    it('throws error for invalid nested AI settings', () => {
      const settings = {
        ai: {
          automation_mode: 'INVALID',
        },
      };

      expect(() => validateSettings(settings)).toThrow(AppError);
    });

    it('throws error for null input', () => {
      expect(() => validateSettings(null)).toThrow(AppError);
    });

    it('throws error for non-object input', () => {
      expect(() => validateSettings('string')).toThrow(AppError);
    });
  });

  describe('sanitizeSettings', () => {
    it('returns empty object for null input', () => {
      expect(sanitizeSettings(null)).toEqual({});
    });

    it('returns empty object for non-object input', () => {
      expect(sanitizeSettings('string')).toEqual({});
    });

    it('keeps known top-level keys', () => {
      const settings = {
        ai: { automation_mode: 'AUTO' },
        bd: { mfs_mode: 'self' },
        businessInfo: { shopName: 'Test' },
        branding: { tone: 'friendly' },
      };

      const sanitized = sanitizeSettings(settings);
      expect(sanitized).toEqual(settings);
    });

    it('removes unknown top-level keys', () => {
      const settings = {
        ai: { automation_mode: 'AUTO' },
        unknownKey: { data: 'value' },
        anotherUnknown: 'test',
      };

      const sanitized = sanitizeSettings(settings);
      expect(sanitized).toEqual({ ai: { automation_mode: 'AUTO' } });
      expect(sanitized.unknownKey).toBeUndefined();
      expect(sanitized.anotherUnknown).toBeUndefined();
    });

    it('preserves nested structure of known keys', () => {
      const settings = {
        ai: {
          automation_mode: 'AUTO',
          nested: {
            deep: 'value',
          },
        },
      };

      const sanitized = sanitizeSettings(settings);
      expect(sanitized.ai.nested.deep).toBe('value');
    });

    it('preserves existing settings keys while sanitizing an AI update', () => {
      const existingSettings = {
        legacy_domain_setting: { enabled: true },
        onboarding_completed: true,
        payment_platform_priority: ['bkash'],
        delivery_platform_priority: ['pathao'],
      };

      const sanitized = sanitizeSettings({
        ...existingSettings,
        ai: { automation_mode: 'AUTO' },
        newUnknownKey: 'must not be introduced',
      }, existingSettings);

      expect(sanitized).toEqual({
        ...existingSettings,
        ai: { automation_mode: 'AUTO' },
      });
      expect(sanitized.newUnknownKey).toBeUndefined();
    });
  });

  describe('mergeAndSanitizeSettings', () => {
    it('deep-merges a patch without mutating current or patch objects', () => {
      const current = {
        businessInfo: { shopName: 'Shop', address: 'Dhaka' },
        ai: { greeting: { enabled: true, custom_text: 'Hi' } },
        legacy_domain: { enabled: true },
      };
      const patch = { ai: { greeting: { custom_text: 'Hello' } }, unknown: 'drop me' };
      const currentSnapshot = JSON.parse(JSON.stringify(current));
      const patchSnapshot = JSON.parse(JSON.stringify(patch));

      const merged = mergeAndSanitizeSettings(current, patch);

      expect(merged).toEqual({
        businessInfo: { shopName: 'Shop', address: 'Dhaka' },
        ai: { greeting: { enabled: true, custom_text: 'Hello' } },
        legacy_domain: { enabled: true },
      });
      expect(current).toEqual(currentSnapshot);
      expect(patch).toEqual(patchSnapshot);
    });

    it('validates known sections after the merge', () => {
      expect(() => mergeAndSanitizeSettings({}, {
        ai: { handoff_settings: { cooldown_minutes: 1441 } },
      })).toThrow(AppError);
    });
  });

  describe('mergeSettingsPreservingRtoConsent', () => {
    it('preserves persisted opt-out while merging an unrelated settings patch', () => {
      const current = { rto_network: { contribute: false, enforce: true }, delivery: { cod_enabled: false } };
      const stalePatch = { rto_network: { contribute: true, enforce: true }, delivery: { cod_enabled: true } };

      const merged = mergeSettingsPreservingRtoConsent(current, stalePatch);

      expect(merged).toEqual({
        rto_network: { contribute: false, enforce: true },
        delivery: { cod_enabled: true },
      });
      expect(current.rto_network.contribute).toBe(false);
      expect(stalePatch.rto_network.contribute).toBe(true);
    });

    it('does not let a general settings patch create RTO consent when none is persisted', () => {
      const merged = mergeSettingsPreservingRtoConsent({}, {
        rto_network: { contribute: true },
        delivery: { cod_enabled: true },
      });

      expect(merged.rto_network).toBeUndefined();
      expect(merged.delivery).toEqual({ cod_enabled: true });
    });
  });

  describe('stripAutomationModeFromShopUpdate', () => {
    it('removes only the general-update reply mode without mutating the input', () => {
      const update = {
        shop_name: 'Updated Shop',
        settings: {
          ai: { automation_mode: 'AUTO', confidence_threshold: 80 },
          businessInfo: { shopName: 'Updated Shop' },
        },
      };

      const stripped = stripAutomationModeFromShopUpdate(update);

      expect(stripped).toEqual({
        shop_name: 'Updated Shop',
        settings: {
          ai: { confidence_threshold: 80 },
          businessInfo: { shopName: 'Updated Shop' },
        },
      });
      expect(update.settings.ai.automation_mode).toBe('AUTO');
    });
  });

  describe('Schema exports', () => {
    it('exports AI_SETTINGS_SCHEMA', () => {
      expect(AI_SETTINGS_SCHEMA).toBeDefined();
      expect(typeof AI_SETTINGS_SCHEMA).toBe('object');
    });

    it('exports BD_SETTINGS_SCHEMA', () => {
      expect(BD_SETTINGS_SCHEMA).toBeDefined();
      expect(typeof BD_SETTINGS_SCHEMA).toBe('object');
    });

    it('exports BUSINESS_INFO_SCHEMA', () => {
      expect(BUSINESS_INFO_SCHEMA).toBeDefined();
      expect(typeof BUSINESS_INFO_SCHEMA).toBe('object');
    });

    it('AI_SETTINGS_SCHEMA validators return correct types', () => {
      expect(AI_SETTINGS_SCHEMA.automation_mode('AUTO')).toBe(true);
      expect(AI_SETTINGS_SCHEMA.automation_mode('AI_ACTIVE')).toBe(true);
      expect(AI_SETTINGS_SCHEMA.automation_mode('AI_SUGGEST_ONLY')).toBe(true);
      expect(AI_SETTINGS_SCHEMA.automation_mode('INVALID')).toBe(false);
      expect(AI_SETTINGS_SCHEMA.confidence_threshold(60)).toBe(true);
      expect(AI_SETTINGS_SCHEMA.confidence_threshold(150)).toBe(false);
      expect(AI_SETTINGS_SCHEMA.auto_reply_enabled(true)).toBe(true);
      expect(AI_SETTINGS_SCHEMA.auto_reply_enabled('yes')).toBe(false);
      expect(AI_SETTINGS_SCHEMA.handoff_settings({ notification_channel: 'telegram' })).toBe(true);
    });

    it('BD_SETTINGS_SCHEMA validators handle null values', () => {
      expect(BD_SETTINGS_SCHEMA.mfs_mode(null)).toBe(true);
      expect(BD_SETTINGS_SCHEMA.mfs_type(null)).toBe(true);
      expect(BD_SETTINGS_SCHEMA.mfs_number(null)).toBe(true);
    });

    it('BUSINESS_INFO_SCHEMA validates arrays correctly', () => {
      expect(BUSINESS_INFO_SCHEMA.deliveryAreas(['Dhaka', 'Chittagong'])).toBe(true);
      expect(BUSINESS_INFO_SCHEMA.deliveryAreas(['Dhaka', 123])).toBe(false);
      expect(BUSINESS_INFO_SCHEMA.deliveryAreas('not array')).toBe(false);
      expect(BUSINESS_INFO_SCHEMA.additionalInfo('x'.repeat(3000))).toBe(true);
      expect(BUSINESS_INFO_SCHEMA.additionalInfo('x'.repeat(3001))).toBe(false);
    });

    it('AI_SETTINGS_SCHEMA validates greeting/closing blocks', () => {
      expect(AI_SETTINGS_SCHEMA.greeting({ enabled: true, custom_text: 'hi' })).toBe(true);
      expect(AI_SETTINGS_SCHEMA.greeting({ enabled: 'x' })).toBe(false);
      expect(AI_SETTINGS_SCHEMA.closing({ custom_text: 'bye' })).toBe(true);
      expect(AI_SETTINGS_SCHEMA.closing({ custom_text: 5 })).toBe(false);
    });

    it('BUSINESS_INFO_SCHEMA validates socialLinks', () => {
      expect(BUSINESS_INFO_SCHEMA.socialLinks({ facebook: 'https://fb.com/x' })).toBe(true);
      expect(BUSINESS_INFO_SCHEMA.socialLinks({ facebook: 'bad' })).toBe(false);
      expect(BUSINESS_INFO_SCHEMA.socialLinks({ whatsapp: '01711111111' })).toBe(true);
      expect(BUSINESS_INFO_SCHEMA.socialLinks({ snapchat: 'https://x.example' })).toBe(false);
    });
  });
});
