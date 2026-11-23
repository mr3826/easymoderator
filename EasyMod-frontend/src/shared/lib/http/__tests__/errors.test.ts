/**
 * A8 merchant pass F-6: library internals reached merchant screens verbatim
 * ("Unsupported protocol C:…" on the signup form; the axios catch-all
 * "Request failed with status code NNN" belongs to the same class). Anything
 * without an HTTP response is a TRANSPORT problem: normalizeApiError must
 * render honest transport copy, never the raw axios message. Backend-authored
 * messages (a response exists) stay untouched — they are the merchant's own
 * validation copy.
 */
import { describe, it, expect } from 'vitest';
import { normalizeApiError, getErrorMessage, isApiError } from '../errors';

describe('normalizeApiError — transport-layer leaks (A8 F-6)', () => {
  it('does not echo a raw axios protocol error to the UI', () => {
    const normalized = normalizeApiError({
      message: 'Unsupported protocol C:/Program Files/Git/api',
      name: 'Error',
    });

    expect(normalized.type).toBe('UNKNOWN_ERROR');
    expect(normalized.message).not.toContain('Unsupported protocol');
    expect(normalized.message).toMatch(/could not reach/i);
    // Debug detail survives, but out of the merchant-facing message.
    expect(normalized.details?.transportMessage).toContain('Unsupported protocol');
  });

  it('does not echo the generic "Request failed with status code" string when no response arrived', () => {
    const normalized = normalizeApiError({ message: 'Request failed with status code 500' });

    expect(normalized.type).toBe('UNKNOWN_ERROR');
    expect(normalized.message).not.toMatch(/status code/i);
    expect(normalized.message).not.toMatch(/axios/i);
  });

  it('keeps the dedicated timeout and network copy', () => {
    expect(normalizeApiError({ code: 'ECONNABORTED', message: 'timeout of 10000ms exceeded' })).toMatchObject({
      type: 'TIMEOUT_ERROR',
      message: 'Request timeout. Please try again.',
    });
    expect(normalizeApiError({ code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND api' })).toMatchObject({
      type: 'NETWORK_ERROR',
      message: 'Network error. Please check your connection.',
    });
  });

  it('still shows backend-authored messages when a response arrived', () => {
    const normalized = normalizeApiError({
      message: 'Request failed with status code 500',
      response: { status: 500, data: { message: 'Courier provider is unreachable right now' } },
    });

    expect(normalized.type).toBe('SERVER_ERROR');
    expect(normalized.message).toBe('Courier provider is unreachable right now');
  });

  it('falls back to the translated call-site copy for plain errors without a message', () => {
    expect(getErrorMessage({}, 'অ্যাকাউন্ট তৈরি করা যায়নি।')).toBe('অ্যাকাউন্ট তৈরি করা যায়নি।');
    expect(isApiError(new Error('nope'))).toBe(false);
  });
});
