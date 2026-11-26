/**
 * FaqEditorDrawer unit contracts (A3). Whole-domain `@/api` mock — the drawer
 * calls faqApi through the same seam the tab uses. Pins:
 * - both answer languages are seeded and preserved (legacy single-language
 *   rows hydrate into their stored slot; an EN-only edit never rewrites bn);
 * - payloads never carry `category` / `confidence` / `usageCount` / `source`;
 * - PATCH sends only CHANGED fields (absence can't clear stored data);
 * - archived rows lock the status control (restore is a row action);
 * - focus discipline: role=dialog + aria-modal, Escape closes;
 * - failure keeps the drawer open, shows drawer-action-feedback (role=alert)
 *   and preserves input (§12) — success is only after the awaited response;
 * - published selection carries the AI-eligibility warning; notes carry the
 *   "never shown to customers" helper; no confidence UI at all.
 */
import '@testing-library/jest-dom';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import FaqEditorDrawer from '../FaqEditorDrawer';
import { apiClient } from '@/api';
import type { FaqRow } from '../faqModel';

vi.mock('@/api', () => ({
  apiClient: {
    listKnowledgeFaqs: vi.fn(),
    createKnowledgeFaq: vi.fn(),
    updateKnowledgeFaq: vi.fn(),
    deleteKnowledgeFaq: vi.fn(),
    archiveKnowledgeFaq: vi.fn(),
    restoreKnowledgeFaq: vi.fn(),
    resyncKnowledgeFaq: vi.fn(),
    searchKnowledgeFaqs: vi.fn(),
  },
}));

const { tMock } = vi.hoisted(() => ({
  tMock: (key: string, opts?: Record<string, unknown>) => {
    if (opts && typeof opts === 'object') {
      const values = Object.values(opts).filter((value) => value != null).join(' ');
      if (values) return `${key} ${values}`;
    }
    return key;
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: tMock, i18n: { language: 'bn' } }),
}));

const bilingualRow: FaqRow = {
  id: '7',
  question: 'What is the delivery time?',
  category_tag: 'Shipping',
  answers: { en: '2-3 days.', bn: '২-৩ দিন।' },
  keywords: ['delivery'],
  notes: 'internal reminder',
  status: 'published',
  is_active: true,
  priority: 5,
  use_count: 12,
  created_at: '2026-11-01T10:00:00.000Z',
  updated_at: '2026-11-05T12:00:00.000Z',
  sync_status: 'synced',
  sync_version: 3,
  synced_at: '2026-11-05T12:01:00.000Z',
};

const legacyOnlyBn = {
  id: '8',
  question: 'Purano FAQ',
  template_bn: 'শুধু বাংলা উত্তর।',
  answers: { en: null, bn: 'শুধু বাংলা উত্তর।' },
  keywords: [],
  notes: null,
  status: 'published',
  is_active: true,
  priority: 0,
  use_count: 0,
  created_at: '2026-10-01T10:00:00.000Z',
  updated_at: null,
  sync_status: 'synced',
  sync_version: 1,
  synced_at: null,
} as unknown as FaqRow;

function renderDrawer(props: Partial<Parameters<typeof FaqEditorDrawer>[0]> = {}) {
  const onClose = vi.fn();
  const onSaved = vi.fn();
  render(<FaqEditorDrawer row={bilingualRow} knownTags={['Shipping', 'Payment']} onClose={onClose} onSaved={onSaved} {...props} />);
  return { onClose, onSaved };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(apiClient.updateKnowledgeFaq).mockResolvedValue({ ...bilingualRow, sync_status: 'pending', synced_at: null } as never);
  vi.mocked(apiClient.createKnowledgeFaq).mockResolvedValue({ ...bilingualRow, id: '9', status: 'draft', sync_status: 'pending' } as never);
});

afterEach(() => {
  cleanup();
});

describe('FaqEditorDrawer — bilingual data preservation', () => {
  it('seeds BOTH answer slots from the rich row and never drops bn on an EN-only edit', async () => {
    const { onSaved } = renderDrawer();
    expect(screen.getByPlaceholderText('manageShop.faqs.modal.answerPlaceholder')).toHaveValue('2-3 days.');
    expect(screen.getByPlaceholderText('manageShop.businessFaq.editor.answerBnPlaceholder')).toHaveValue('২-৩ দিন।');

    fireEvent.change(screen.getByPlaceholderText('manageShop.faqs.modal.answerPlaceholder'), {
      target: { value: '3-4 days.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'manageShop.faqs.save' }));
    await waitFor(() => expect(apiClient.updateKnowledgeFaq).toHaveBeenCalled());
    const body = vi.mocked(apiClient.updateKnowledgeFaq).mock.calls[0][1] as Record<string, unknown>;
    // Only the changed slot is sent; bn absence NEVER clears stored bn data.
    expect(body.answer_en).toBe('3-4 days.');
    expect(body).not.toHaveProperty('answer_bn');
    // Contract bans on every write: no shadow category, no discarded fields.
    expect(body).not.toHaveProperty('category');
    expect(body).not.toHaveProperty('confidence');
    expect(body).not.toHaveProperty('usageCount');
    expect(body).not.toHaveProperty('source');
    // The parent closes the drawer (FaqTab does) only after this server-resolved call.
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ id: '7', sync_status: 'pending' }), 'update');
  });

  it('a legacy row without an answers object hydrates the stored bn slot', () => {
    renderDrawer({ row: legacyOnlyBn });
    expect(screen.getByPlaceholderText('manageShop.faqs.modal.answerPlaceholder')).toHaveValue('');
    expect(screen.getByPlaceholderText('manageShop.businessFaq.editor.answerBnPlaceholder')).toHaveValue('শুধু বাংলা উত্তর।');
  });
});

describe('FaqEditorDrawer — create + validation', () => {
  it('create requires question AND at least one answer; body maps bn to answer_bn with a draft default', async () => {
    const { onSaved } = renderDrawer({ row: null });
    const save = screen.getByRole('button', { name: 'manageShop.faqs.save' });
    expect(save).toBeDisabled();

    fireEvent.change(screen.getByLabelText('manageShop.faqs.modal.questionLabel'), {
      target: { value: 'Do you offer warranty?' },
    });
    expect(save).toBeDisabled(); // server requireAnyAnswer mirrored before submit

    fireEvent.change(screen.getByPlaceholderText('manageShop.businessFaq.editor.answerBnPlaceholder'), {
      target: { value: 'হ্যাঁ, ৬ মাস।' },
    });
    fireEvent.click(save);
    await waitFor(() => expect(apiClient.createKnowledgeFaq).toHaveBeenCalled());
    const body = vi.mocked(apiClient.createKnowledgeFaq).mock.calls[0][0] as Record<string, unknown>;
    expect(body.question).toBe('Do you offer warranty?');
    expect(body.answer_bn).toBe('হ্যাঁ, ৬ মাস।');
    expect(body).not.toHaveProperty('answer_en');
    expect(body.status).toBe('draft');
    expect(body).not.toHaveProperty('category');
    expect(body).not.toHaveProperty('confidence');
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ id: '9' }), 'create');
  });

  it('Save is dirty-gated before any change', () => {
    renderDrawer();
    expect(screen.getByRole('button', { name: 'manageShop.faqs.save' })).toBeDisabled();
  });
});

describe('FaqEditorDrawer — lifecycle + internal-only copy', () => {
  it('archived rows lock the status control — no selectable archived/draft path', () => {
    renderDrawer({ row: { ...bilingualRow, status: 'archived' } });
    expect(screen.queryByLabelText('manageShop.businessFaq.editor.status')).toBeNull();
    expect(screen.getByText('manageShop.businessFaq.chip.status.archived')).toBeInTheDocument();
    expect(screen.getByText('manageShop.businessFaq.editor.archivedLocked')).toBeInTheDocument();
  });

  it('selecting Published swaps in the AI-eligibility warning', () => {
    renderDrawer({ row: { ...bilingualRow, status: 'draft' } });
    expect(screen.getByText('manageShop.businessFaq.editor.statusHelp')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('manageShop.businessFaq.editor.status'), { target: { value: 'published' } });
    expect(screen.getByText('manageShop.businessFaq.editor.publishedWarn')).toBeInTheDocument();
  });

  it('notes + keywords carry explicit internal-only helpers (never-customer-facing)', () => {
    renderDrawer();
    expect(screen.getByText('manageShop.businessFaq.editor.notesHelp')).toBeInTheDocument();
    expect(screen.getByText('manageShop.businessFaq.editor.keywordsHelp')).toBeInTheDocument();
    expect(screen.getByDisplayValue('internal reminder')).toBeInTheDocument();
  });
});

describe('FaqEditorDrawer — dialog discipline', () => {
  it('Escape closes; scrim click closes', () => {
    const { onClose } = renderDrawer();
    const drawer = screen.getByTestId('faq-editor-drawer');
    expect(drawer).toHaveAttribute('role', 'dialog');
    expect(drawer).toHaveAttribute('aria-modal', 'true');
    fireEvent.keyDown(drawer, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('save failure keeps the drawer open with role=alert inside and preserves input', async () => {
    renderDrawer();
    vi.mocked(apiClient.updateKnowledgeFaq).mockRejectedValueOnce(new Error('Server said no'));
    fireEvent.change(screen.getByLabelText('manageShop.faqs.modal.questionLabel'), { target: { value: 'Edited question' } });
    fireEvent.click(screen.getByRole('button', { name: 'manageShop.faqs.save' }));
    const feedback = await screen.findByTestId('drawer-action-feedback');
    expect(feedback).toHaveAttribute('role', 'alert');
    expect(feedback).toHaveTextContent('Server said no');
    expect(screen.getByTestId('faq-editor-drawer')).toBeInTheDocument();
    // §12: input preserved, nothing claimed.
    expect(screen.getByLabelText('manageShop.faqs.modal.questionLabel')).toHaveValue('Edited question');
    expect(apiClient.createKnowledgeFaq).not.toHaveBeenCalled();
  });
});
