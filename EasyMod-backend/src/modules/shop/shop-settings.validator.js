/**
 * Settings Validation Schema
 * Validates shop settings structure using Joi-like validation
 */

const { AppError } = require('../../utils/AppError');
const { isKnownAiReplyMode } = require('./ai-reply-mode');

// Validation helpers
const isValidEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
const isValidPhone = (phone) => /^(?:\+?88)?01[3-9]\d{8}$/.test(phone);
const isNonEmptyString = (val) => typeof val === 'string' && val.trim().length > 0;
const isValidUrl = (val) => typeof val === 'string' && /^https?:\/\/\S+$/.test(val.trim());
const BUSINESS_INFO_TEXT_MAX = 3000;
const NOTIFICATION_CHANNELS = ['in_app', 'email', 'sms', 'telegram'];

// Greeting / closing message block: { enabled?: boolean, custom_text?: string }.
const MESSAGE_TEXT_MAX = 1000;
const isValidMessageBlock = (val) => {
  if (typeof val !== 'object' || val === null || Array.isArray(val)) return false;
  if ('enabled' in val && typeof val.enabled !== 'boolean') return false;
  if ('custom_text' in val) {
    if (typeof val.custom_text !== 'string') return false;
    if (val.custom_text.length > MESSAGE_TEXT_MAX) return false;
  }
  return true;
};

// Social links: only known platforms; each value empty OR an http(s) URL
// (WhatsApp may also be a bare BD phone number).
const SOCIAL_PLATFORMS = ['facebook', 'instagram', 'whatsapp', 'tiktok', 'youtube', 'website'];
const isValidSocialLinks = (val) => {
  if (typeof val !== 'object' || val === null || Array.isArray(val)) return false;
  return Object.entries(val).every(([key, v]) => {
    if (!SOCIAL_PLATFORMS.includes(key)) return false;
    if (typeof v !== 'string') return false;
    const trimmed = v.trim();
    if (trimmed === '') return true; // empty is allowed (link not set)
    if (key === 'whatsapp') return isValidUrl(trimmed) || isValidPhone(trimmed);
    return isValidUrl(trimmed);
  });
};

// AI Settings Schema
const AI_SETTINGS_SCHEMA = {
  automation_mode: isKnownAiReplyMode,
  confidence_threshold: (val) => typeof val === 'number' && val >= 0 && val <= 100,
  auto_reply_enabled: (val) => typeof val === 'boolean',
  max_auto_order_value: (val) => typeof val === 'number' && val >= 0,
  ask_email: (val) => typeof val === 'boolean',
  primary_language: (val) => ['mixed', 'bn', 'en'].includes(val),
  required_fields: (val) => {
    if (typeof val !== 'object' || val === null) return false;
    const validFields = ['customer_name', 'mobile_number', 'delivery_address', 'payment_method', 'email_address', 'special_instructions'];
    return Object.keys(val).every(k => validFields.includes(k) && typeof val[k] === 'boolean');
  },
  handoff_settings: (val) => {
    if (typeof val !== 'object' || val === null || Array.isArray(val)) return false;
    const validFields = ['trigger_keywords', 'notification_channel', 'cooldown_minutes'];
    if (!Object.keys(val).every(k => validFields.includes(k))) return false;
    return (
      (!('trigger_keywords' in val) || (Array.isArray(val.trigger_keywords) && val.trigger_keywords.every(v => typeof v === 'string'))) &&
      (!('notification_channel' in val) || NOTIFICATION_CHANNELS.includes(val.notification_channel)) &&
      (!('cooldown_minutes' in val) || (
        typeof val.cooldown_minutes === 'number'
        && Number.isInteger(val.cooldown_minutes)
        && val.cooldown_minutes >= 0
        && val.cooldown_minutes <= 1440
      ))
    );
  },
  greeting: isValidMessageBlock,
  closing: isValidMessageBlock
};

// BD Settings Schema
const BD_SETTINGS_SCHEMA = {
  mfs_mode: (val) => val === null || ['self', 'business'].includes(val),
  mfs_type: (val) => val === null || ['bkash', 'nagad', 'rocket'].includes(val),
  mfs_number: (val) => val === null || isValidPhone(val),
  google_sheet_id: (val) => val === null || isNonEmptyString(val),
  google_sheet_range: (val) => typeof val === 'string'
};

// Business Info Schema
const BUSINESS_INFO_SCHEMA = {
  shopName: (val) => typeof val === 'string',
  address: (val) => typeof val === 'string',
  phone: (val) => typeof val === 'string',
  openingHours: (val) => typeof val === 'string',
  additionalInfo: (val) => typeof val === 'string' && val.length <= BUSINESS_INFO_TEXT_MAX,
  deliveryAreas: (val) => Array.isArray(val) && val.every(v => typeof v === 'string'),
  paymentMethods: (val) => Array.isArray(val) && val.every(v => typeof v === 'string'),
  socialLinks: isValidSocialLinks
};

/**
 * Validate AI settings object
 * @param {object} settings - AI settings to validate
 * @throws {AppError} If validation fails
 */
const validateAISettings = (settings) => {
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
    throw new AppError('AI settings must be an object', 400);
  }

  const errors = [];
  
  for (const [key, validator] of Object.entries(AI_SETTINGS_SCHEMA)) {
    if (key in settings) {
      if (!validator(settings[key])) {
        errors.push(`Invalid value for ${key}: ${JSON.stringify(settings[key])}`);
      }
    }
  }

  if (errors.length > 0) {
    throw new AppError(`AI settings validation failed: ${errors.join(', ')}`, 400);
  }

  return true;
};

/**
 * Validate BD settings object
 * @param {object} settings - BD settings to validate
 * @throws {AppError} If validation fails
 */
const validateBDSettings = (settings) => {
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
    throw new AppError('BD settings must be an object', 400);
  }

  const errors = [];
  
  for (const [key, validator] of Object.entries(BD_SETTINGS_SCHEMA)) {
    if (key in settings) {
      if (!validator(settings[key])) {
        errors.push(`Invalid value for ${key}: ${JSON.stringify(settings[key])}`);
      }
    }
  }

  if (errors.length > 0) {
    throw new AppError(`BD settings validation failed: ${errors.join(', ')}`, 400);
  }

  return true;
};

/**
 * Validate business info object
 * @param {object} info - Business info to validate
 * @throws {AppError} If validation fails
 */
const validateBusinessInfo = (info) => {
  if (typeof info !== 'object' || info === null || Array.isArray(info)) {
    throw new AppError('Business info must be an object', 400);
  }

  const errors = [];
  
  for (const [key, validator] of Object.entries(BUSINESS_INFO_SCHEMA)) {
    if (key in info) {
      if (!validator(info[key])) {
        errors.push(`Invalid value for ${key}: ${JSON.stringify(info[key])}`);
      }
    }
  }

  if (errors.length > 0) {
    throw new AppError(`Business info validation failed: ${errors.join(', ')}`, 400);
  }

  return true;
};

/**
 * Validate complete settings object
 * @param {object} settings - Complete settings object
 * @throws {AppError} If validation fails
 */
const validateSettings = (settings) => {
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
    throw new AppError('Settings must be an object', 400);
  }

  // Validate nested sections if present
  if (settings.ai) {
    validateAISettings(settings.ai);
  }
  if (settings.bd) {
    validateBDSettings(settings.bd);
  }
  if (settings.businessInfo) {
    validateBusinessInfo(settings.businessInfo);
  }

  return true;
};

/**
 * Sanitize settings object (removes unknown keys unless they already exist in
 * the persisted settings object being updated).
 *
 * @param {object} settings - Settings to sanitize
 * @param {object} [preservedSettings] - Existing persisted settings to retain
 * @returns {object} Sanitized settings
 */
const sanitizeSettings = (settings, preservedSettings = {}) => {
  if (typeof settings !== 'object' || settings === null) {
    return {};
  }

  const sanitized = {};

  // Keep the known schema sections and settings written by other domains.
  // Existing keys are included separately so adding a new settings domain does
  // not make an AI update silently delete data until this list is updated.
  const knownKeys = new Set([
    'ai',
    'bd',
    'businessInfo',
    'branding',
    'brandingRules',
    'delivery',
    'documents',
    'policies',
    'rto_network',
    'activation',
    'onboarding',
    'onboarding_completed',
    'onboarding_completed_at',
    'onboarding_status_snapshot',
    'payment_platform_priority',
    'delivery_platform_priority',
  ]);
  if (preservedSettings && typeof preservedSettings === 'object') {
    for (const key of Object.keys(preservedSettings)) knownKeys.add(key);
  }

  for (const key of Object.keys(settings)) {
    if (knownKeys.has(key)) {
      sanitized[key] = settings[key];
    }
  }

  return sanitized;
};

const isPlainObject = (value) => (
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value)
);

const cloneSettingValue = (value) => {
  if (Array.isArray(value)) return value.map(cloneSettingValue);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, cloneSettingValue(nested)]));
};

const mergeSettingObjects = (current, patch) => {
  const merged = isPlainObject(current) ? cloneSettingValue(current) : {};
  if (!isPlainObject(patch)) return merged;

  for (const [key, value] of Object.entries(patch)) {
    merged[key] = isPlainObject(value) && isPlainObject(merged[key])
      ? mergeSettingObjects(merged[key], value)
      : cloneSettingValue(value);
  }
  return merged;
};

/**
 * Merge a merchant settings patch without dropping existing domains or
 * accepting new arbitrary top-level keys. Known nested sections are validated
 * after the merge; caller-owned objects are never mutated.
 */
const mergeAndSanitizeSettings = (currentSettings, patch) => {
  const current = isPlainObject(currentSettings) ? currentSettings : {};
  const merged = mergeSettingObjects(current, patch);
  const sanitized = sanitizeSettings(merged, current);
  validateSettings(sanitized);
  return sanitized;
};

/**
 * General shop-settings writers may merge unrelated domains, but RTO network
 * consent is owned exclusively by its audited owner/admin endpoint.
 */
const mergeSettingsPreservingRtoConsent = (currentSettings, patch) => {
  const current = isPlainObject(currentSettings) ? currentSettings : {};
  const safePatch = isPlainObject(patch) ? cloneSettingValue(patch) : {};
  delete safePatch.rto_network;
  const merged = mergeAndSanitizeSettings(current, safePatch);
  if (Object.prototype.hasOwnProperty.call(current, 'rto_network')) {
    merged.rto_network = cloneSettingValue(current.rto_network);
  } else {
    delete merged.rto_network;
  }
  return merged;
};

/**
 * Remove the reply-mode field from the general shop update surface. Reply mode
 * has its own audited API contract and must not be changed as a side effect of
 * updating unrelated shop settings.
 */
const stripAutomationModeFromShopUpdate = (updateData) => {
  if (!isPlainObject(updateData)
    || !isPlainObject(updateData.settings)
    || !isPlainObject(updateData.settings.ai)
    || !Object.prototype.hasOwnProperty.call(updateData.settings.ai, 'automation_mode')) {
    return updateData;
  }

  const settings = {
    ...updateData.settings,
    ai: { ...updateData.settings.ai },
  };
  delete settings.ai.automation_mode;

  return { ...updateData, settings };
};

module.exports = {
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
};
