import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import type { ClaimDecision } from '@/api/types/commercial';
import { FeatureGate } from '../FeatureGate';

const { mockUseClaimDecisions, translations } = vi.hoisted(() => ({
  mockUseClaimDecisions: vi.fn(),
  translations: {
    'claims.ai.draft_reply.en': 'AI-assisted draft replies are verified.',
    'claims.ai.auto_reply.fallback.en': 'Automated AI replies have not been proven live; replies stay in draft for review.',
    'featureGate.viewBilling': 'View billing',
  } as Record<string, string>,
}));

vi.mock('@/api/domains/commercialContract', () => ({
  useClaimDecisions: mockUseClaimDecisions,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'en' },
    t: (key: string, options?: unknown) => {
      if (translations[key]) return translations[key];
      if (typeof options === 'string') return options;
      return key;
    },
  }),
}));

const REGISTRY_HASH = `sha256:${'a'.repeat(64)}`;

const decision = (overrides: Partial<ClaimDecision> = {}): ClaimDecision => ({
  claimId: 'ai.draft_reply',
  available: true,
  render: 'claim',
  textKey: 'claims.ai.draft_reply.en',
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
  ...overrides,
});

function mockQuery(result: { data?: unknown; isLoading?: boolean; error?: Error | null }) {
  mockUseClaimDecisions.mockReturnValue({
    data: result.data,
    isLoading: result.isLoading ?? false,
    error: result.error ?? null,
  });
}

function renderGate() {
  return render(
    <MemoryRouter>
      <FeatureGate claimId="ai.draft_reply" featureLabel="AI draft replies">
        <div>gated content</div>
      </FeatureGate>
    </MemoryRouter>,
  );
}

describe('FeatureGate claim-based gating', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders children when the claim is available', () => {
    mockQuery({
      data: { decisions: [decision()] },
    });

    renderGate();

    expect(screen.getByText('gated content')).toBeInTheDocument();
    expect(screen.queryByTestId('feature-gate-locked')).not.toBeInTheDocument();
  });

  it('shows the claim fallback instead of an upgrade promise when unavailable', () => {
    mockQuery({
      data: {
        decisions: [
          decision({
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
          }),
        ],
      },
    });

    renderGate();

    expect(screen.getByTestId('feature-gate-locked')).toBeInTheDocument();
    expect(screen.getByText(translations['claims.ai.auto_reply.fallback.en'])).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View billing' })).toHaveAttribute('href', '/subscription');
    expect(screen.queryByText(/upgrade/i)).not.toBeInTheDocument();
  });

  it('fails closed when no decision is returned', () => {
    mockQuery({ data: { decisions: [] } });

    renderGate();

    expect(screen.getByTestId('feature-gate-locked')).toBeInTheDocument();
    expect(screen.getByText('AI draft replies')).toBeInTheDocument();
  });

  it('keeps gated content blocked while claim decisions load', () => {
    mockQuery({ isLoading: true });

    renderGate();

    expect(screen.getByTestId('feature-gate-loading')).toBeInTheDocument();
    expect(screen.getByText('Checking feature availability...')).toBeInTheDocument();
  });

  it('does not present a failed lookup as a confirmed restriction', () => {
    mockQuery({ error: new Error('claims unavailable') });

    renderGate();

    expect(screen.getByTestId('feature-gate-unavailable')).toBeInTheDocument();
    expect(screen.getByText('Feature availability is temporarily unavailable.')).toBeInTheDocument();
    expect(screen.queryByText(/upgrade/i)).not.toBeInTheDocument();
  });
});