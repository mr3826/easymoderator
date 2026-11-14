import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClaimDecision } from '@/api/types/commercial';
import { useSubscriptionFeatures } from '../useSubscriptionFeatures';

const { mockUseClaimDecisions } = vi.hoisted(() => ({
  mockUseClaimDecisions: vi.fn(),
}));

vi.mock('@/api/domains/commercialContract', () => ({
  useClaimDecisions: mockUseClaimDecisions,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ i18n: { language: 'en' }, t: (key: string) => key }),
}));

const REGISTRY_HASH = `sha256:${'e'.repeat(64)}`;

const verifiedDecision = (claimId: string): ClaimDecision => ({
  claimId,
  available: true,
  render: 'claim',
  textKey: `claims.${claimId}.en`,
  locale: 'en',
  surface: 'subscription',
  scope: { claimedProviders: null, verifiedProviders: null, match: true, text: null },
  interpolation: {},
  mode: 'enforce',
  predicate: {
    code_present: true,
    merchant_enabled: true,
    production_verified: true,
    deprecated: false,
    internal_only: false,
    scope_match: true,
  },
  wouldBlock: false,
  contractVersion: '1.0.0',
  registryHash: REGISTRY_HASH,
});

function mockQuery(result: { data?: unknown; isLoading?: boolean; error?: Error | null }) {
  mockUseClaimDecisions.mockReturnValue({
    data: result.data,
    isLoading: result.isLoading ?? false,
    error: result.error ?? null,
  });
}

describe('useSubscriptionFeatures', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('derives advanced AI from the verified ai.draft_reply claim only', () => {
    mockQuery({ data: { decisions: [verifiedDecision('ai.draft_reply')] } });

    const { result } = renderHook(() => useSubscriptionFeatures());

    expect(result.current.error).toBeNull();
    expect(result.current.planName).toBeNull();
    expect(result.current.features).toEqual({
      image_understanding: false,
      advanced_ai: true,
      priority_support: false,
      custom_branding: false,
    });
  });

  it('fails closed when the AI claim is unavailable', () => {
    mockQuery({
      data: {
        decisions: [{
          ...verifiedDecision('ai.auto_reply'),
          available: false,
          render: 'fallback',
          textKey: 'claims.ai.auto_reply.fallback.en',
          predicate: {
            code_present: true,
            merchant_enabled: true,
            production_verified: false,
            deprecated: false,
            internal_only: false,
            scope_match: true,
          },
        }],
      },
    });

    const { result } = renderHook(() => useSubscriptionFeatures());

    expect(result.current.features.advanced_ai).toBe(false);
  });

  it('locks every feature while decisions load', () => {
    mockQuery({ isLoading: true });

    const { result } = renderHook(() => useSubscriptionFeatures());

    expect(result.current.loading).toBe(true);
    expect(result.current.features.advanced_ai).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('locks every feature when the claim lookup fails', () => {
    mockQuery({ error: new Error('claims unavailable') });

    const { result } = renderHook(() => useSubscriptionFeatures());

    expect(result.current.error).toBe('Failed to load capability decisions');
    expect(result.current.features).toEqual({
      image_understanding: false,
      advanced_ai: false,
      priority_support: false,
      custom_branding: false,
    });
  });

  it('locks every feature when no decision set is returned', () => {
    mockQuery({ data: undefined });

    const { result } = renderHook(() => useSubscriptionFeatures());

    expect(result.current.features.advanced_ai).toBe(false);
  });
});