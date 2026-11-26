/**
 * FAQ execution-page guardrails contracts (§8/§16/§18/§29): signal matrix,
 * header without CTA, toolbar single primary, dialog semantics + focus return
 * for editor and delete confirm, gap card primary-per-domain, textarea-last
 * while authoring. Additive suite; FaqSettings.test.tsx and
 * FaqSettings.gaps.test.tsx stay untouched.
 */
import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import FaqSettings from '../FaqSettings';
import { apiClient } from '@/api';
import { listGapSuggestions } from '@/api/domains/knowledge';
import type { KnowledgeGapSuggestion } from '@/api/types/knowledge';

vi.mock('@/api', () => ({
  apiClient: {
    listKnowledgeFaqs: vi.fn(),
    updateKnowledgeFaq: vi.fn(),
    createKnowledgeFaq: vi.fn(),
    deleteKnowledgeFaq: vi.fn(),
  },
}));
vi.mock('@/api/domains/knowledge', () => ({
  listGapSuggestions: vi.fn(),
  reviewGapSuggestion: vi.fn(),
  dismissGapSuggestion: vi.fn(),
  publishGapSuggestion: vi.fn(),
  isGapSuggestionsDisabled: vi.fn(),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));

const faq = (overrides: Record<string, unknown> = {}) => ({
  id: 'faq-1',
  question: 'What is the delivery charge?',
  answer: 'Inside Dhaka delivery is 80 BDT.',
  category: 'Delivery',
  confidence: 1,
  source: 'manual',
  active: true,
  usageCount: 3,
  createdAt: '2026-07-04T00:00:00.000Z',
  updatedAt: '2026-07-04T00:00:00.000Z',
  ...overrides,
});

const gap = (overrides: Partial<KnowledgeGapSuggestion> = {}): KnowledgeGapSuggestion => ({
  id: 'gap-1',
  display_question: 'How do I pay with bKash?',
  owner_domain: 'PAYMENT',
  status: 'OPEN',
  evidence_count: 7,
  first_seen_at: '2026-10-01T00:00:00Z',
  last_seen_at: '2026-10-24T00:00:00Z',
  resolved_faq_id: null,
  published_at: null,
  authoritative_action: 'open_payment_settings',
  ...overrides,
});

const renderPage = () => render(<MemoryRouter><FaqSettings /></MemoryRouter>);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(apiClient.listKnowledgeFaqs).mockResolvedValue([faq()] as never);
  vi.mocked(listGapSuggestions).mockResolvedValue({ featureDisabled: true } as never);
});

describe('FAQ page signal header removed (C1/C6 absence pins)', () => {
  it('keeps the level-1 title, shows no signal band and no header CTA', async () => {
    renderPage();
    await screen.findByText('What is the delivery charge?');
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
    expect(screen.queryByTestId('faq-signal')).toBeNull();
    expect(screen.queryByTestId('inbox-primary-action')).toBeNull();
    expect(screen.queryByTestId('dashboard-primary-action')).toBeNull();
    // The single screen-level primary lives in the work-area toolbar.
    expect(screen.getAllByTestId('faq-add')).toHaveLength(1);
  });

  it('keeps open questions visible in the gap card (no signal copy)', async () => {
    vi.mocked(listGapSuggestions).mockResolvedValue({ featureDisabled: false, data: [gap()] } as never);
    renderPage();
    // The gap card (data-testid='gap-suggestions') carries the attention truth.
    await waitFor(() => expect(screen.getByTestId('gap-suggestions')).toBeInTheDocument());
    expect(screen.getByText('How do I pay with bKash?')).toBeInTheDocument();
    expect(screen.queryByTestId('faq-signal')).toBeNull();
  });

  it('surfaces load failure through the alert and hides creation', async () => {
    vi.mocked(apiClient.listKnowledgeFaqs).mockRejectedValue(new Error('boom'));
    renderPage();
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.queryByTestId('faq-signal')).toBeNull();
    expect(screen.queryByTestId('faq-add')).toBeNull();
  });

  it('shows creation affordance when empty without a signal band', async () => {
    vi.mocked(apiClient.listKnowledgeFaqs).mockResolvedValue([] as never);
    renderPage();
    await screen.findByTestId('faq-add');
    expect(screen.getAllByTestId('faq-add').length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByTestId('faq-signal')).toBeNull();
  });
});

describe('FAQ dialogs', () => {
  it('editor is a labelled modal dialog with focus trap and Escape close', async () => {
    renderPage();
    const add = await screen.findByTestId('faq-add');
    add.focus();
    fireEvent.click(add);
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByLabelText('Question')).toBeInTheDocument();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(add);
  });

  it('saves the typed QUESTION and never sends a category that would overwrite it', async () => {
    // Regression: the API resolves its single text column as `category || question`.
    // The editor used to always send category:"General", so the merchant's question
    // was discarded and the wrong text reached the RAG index and the AI prompt.
    vi.mocked(apiClient.createKnowledgeFaq).mockImplementation(async (payload) => ({
      ...faq(), ...payload, id: 'faq-new',
    }) as never);
    renderPage();
    fireEvent.click(await screen.findByTestId('faq-add'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Question'), {
      target: { value: 'Do you ship to Chittagong?' },
    });
    fireEvent.change(within(dialog).getByLabelText('Answer'), {
      target: { value: 'Yes, delivery takes 3 days.' },
    });
    // The editor no longer offers a second input for the same column.
    expect(within(dialog).queryByLabelText(/category/i)).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: /save/i }));
    await waitFor(() => expect(apiClient.createKnowledgeFaq).toHaveBeenCalled());
    const sent = vi.mocked(apiClient.createKnowledgeFaq).mock.calls[0][0] as Record<string, unknown>;
    expect(sent.question).toBe('Do you ship to Chittagong?');
    expect(sent).not.toHaveProperty('category');
  });

  it('delete asks through a danger confirm dialog, not window.confirm', async () => {
    vi.mocked(apiClient.deleteKnowledgeFaq).mockResolvedValue({ message: 'ok' } as never);
    renderPage();
    const deleteButton = await screen.findByRole('button', { name: 'Delete FAQ' });
    deleteButton.focus();
    fireEvent.click(deleteButton);
    const dialog = await screen.findByRole('dialog');
    // No native confirm: deletion waits for the in-system danger confirm.
    expect(apiClient.deleteKnowledgeFaq).not.toHaveBeenCalled();
    expect(within(dialog).getByText('What is the delivery charge?')).toBeInTheDocument();
    // Cancel returns focus to the invoking row button.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(document.activeElement).toBe(deleteButton);
    fireEvent.click(deleteButton);
    fireEvent.click(await screen.findByTestId('faq-delete-confirm'));
    await waitFor(() => expect(apiClient.deleteKnowledgeFaq).toHaveBeenCalledWith('faq-1'));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    // The row is gone after deletion, so its button cannot receive focus back.
    expect(screen.queryByText('What is the delivery charge?')).not.toBeInTheDocument();
  });
});

describe('gap cards', () => {
  it('keeps one primary per card and the authoring textarea last', async () => {
    vi.mocked(listGapSuggestions).mockResolvedValue({
      featureDisabled: false,
      data: [gap(), gap({ id: 'gap-2', owner_domain: 'POLICY', authoritative_action: 'author_faq' })],
    } as never);
    renderPage();
    const policyCard = await screen.findByTestId('gap-suggestion-gap-2');
    const write = within(policyCard).getByRole('button', { name: /Write answer/i });
    fireEvent.click(write);
    const boxes = document.querySelectorAll('textarea');
    expect(boxes[boxes.length - 1]).toBe(within(policyCard).getByRole('textbox', { name: 'Your answer' }));
    // While authoring, the toggle demotes and publish becomes the card primary.
    expect(within(policyCard).getByTestId('gap-publish')).toBeInTheDocument();
    const settingsCard = screen.getByTestId('gap-suggestion-gap-1');
    expect(within(settingsCard).getByTestId('gap-open-settings')).toBeInTheDocument();
  });
});
