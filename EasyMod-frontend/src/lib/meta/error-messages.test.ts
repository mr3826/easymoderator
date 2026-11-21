import { describe, expect, it } from 'vitest';
import { extractMetaApiError, getMetaErrorMessage } from './error-messages';
import { normalizeApiError } from '@/shared/lib/http/errors';

describe('Meta error mapping', () => {
  it('preserves stable string error codes from normalized API errors', () => {
    expect(extractMetaApiError({
      statusCode: 403,
      code: 'META_PAGE_TASKS_REQUIRED',
      message: 'Page tasks are insufficient',
    })).toEqual({
      code: 'META_PAGE_TASKS_REQUIRED',
      message: 'Page tasks are insufficient',
    });
  });

  it('maps the stable Page task rejection to merchant-facing copy', () => {
    expect(getMetaErrorMessage('META_PAGE_TASKS_REQUIRED', null, 'en')).toContain('not eligible');
  });

  it('maps the canary discovery failure without blaming Page ownership', () => {
    expect(getMetaErrorMessage('META_PAGE_DISCOVERY_FAILED', null, 'en')).toContain('discovery');
  });

  it('keeps a top-level backend stable code through API error normalization', () => {
    const normalized = normalizeApiError({
      response: {
        status: 403,
        data: {
          success: false,
          message: 'Page tasks are insufficient',
          code: 'META_PAGE_TASKS_REQUIRED',
        },
      },
    });

    expect(extractMetaApiError(normalized).code).toBe('META_PAGE_TASKS_REQUIRED');
  });

  // D7: the two connection-claim codes used to fall through to the raw
  // backend sentence. They must resolve friendly recovery guidance in both
  // languages, via inline fallback until (and superseded by) locale keys.
  it('maps META_ASSET_ALREADY_CONNECTED to recovery guidance instead of the raw sentence', () => {
    const rawBackendSentence =
      'This Facebook Page is already connected to another EasyModerator shop. Disconnect it there first, or ask support to release the old connection.';
    const en = getMetaErrorMessage('META_ASSET_ALREADY_CONNECTED', rawBackendSentence, 'en');

    expect(en).toContain('another EasyModerator shop');
    // Not the untranslated i18n key path, and not the generic fallback key echo.
    expect(en).not.toBe('errors.meta.assetAlreadyConnected');
    expect(en).not.toBe('errors.meta.fallback');

    const bn = getMetaErrorMessage('META_ASSET_ALREADY_CONNECTED', rawBackendSentence, 'bn');
    expect(bn).not.toBe(en); // localized guidance, not one shared English string
    expect(bn).not.toBe('errors.meta.assetAlreadyConnected');
  });

  it('maps META_RECONNECT_TARGET_MISMATCH to reconnect recovery guidance', () => {
    const en = getMetaErrorMessage('META_RECONNECT_TARGET_MISMATCH', null, 'en');
    expect(en.toLowerCase()).toContain('reconnect');
    expect(en).not.toBe('errors.meta.reconnectTargetMismatch');
    expect(en).not.toBe('errors.meta.fallback');

    const bn = getMetaErrorMessage('META_RECONNECT_TARGET_MISMATCH', null, 'bn');
    expect(bn).not.toBe('errors.meta.reconnectTargetMismatch');
  });

  it('surfaces the stable claim code through error normalization and maps it', () => {
    const normalized = normalizeApiError({
      response: {
        status: 409,
        data: {
          success: false,
          message: 'This Facebook Page is already connected to another EasyModerator shop.',
          code: 'META_ASSET_ALREADY_CONNECTED',
        },
      },
    });

    const { code } = extractMetaApiError(normalized);
    expect(code).toBe('META_ASSET_ALREADY_CONNECTED');
    expect(getMetaErrorMessage(code, 'This Facebook Page is already connected to another EasyModerator shop.', 'en'))
      .toContain('support');
  });

  it('does not regress the existing numeric-code mappings', () => {
    expect(getMetaErrorMessage(190, null, 'en')).toContain('Reconnect');
    expect(getMetaErrorMessage('META_PAGE_TASKS_REQUIRED', null, 'en')).toContain('not eligible');
  });
});
