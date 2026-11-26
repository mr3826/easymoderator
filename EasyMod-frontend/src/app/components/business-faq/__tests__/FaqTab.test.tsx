/**
 * FaqTab unit contracts (A3). Whole-domain mocks per house rule — every api
 * fn the tab touches is listed, no partial mocks, no network. Pins:
 * - lifecycle transitions hit the exact endpoints (status PATCH / archive /
 *   restore / resync / delete);
 * - bulk enable/disable discloses affected count, confirms first, reloads
 *   from the server and reports partial failure;
 * - filter chip counts are accurate against the merchant list;
 * - a typed query filters CLIENT-SIDE across ALL statuses (A8 #2) and rows
 *   their internal keywords/notes from the merchant list (projection-safe);
 * - a failed sync row shows Retry and NEVER a green synced state;
 * - confidence/% text is absent everywhere (inverted F3 pin);
 * - internal notes never render on the list;
 * - NULL updated_at renders "—", bn locale renders bn-BD numerals;
 * - save toast says SAVED; the row's sync chip stays pending (never "live");
 * - owner-only affordances (delete/resync) hidden for staff.
 */
import '@testing-library/jest-dom';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import FaqTab from '../FaqTab';
import { faqApi } from '../faqModel';
import { listGapSuggestions } from '@/api/domains/knowledge';
import { authService } from '@/app/lib/auth';

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

vi.mock('@/api/domains/knowledge', () => ({
  listGapSuggestions: vi.fn(),
  reviewGapSuggestion: vi.fn(),
  dismissGapSuggestion: vi.fn(),
  publishGapSuggestion: vi.fn(),
  isGapSuggestionsDisabled: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

vi.mock('@/app/lib/auth', () => ({
  authService: { getCurrentShop: vi.fn() },
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

const i18nState = vi.hoisted(() => ({ language: 'en' }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: tMock,
    i18n: { get language() { return i18nState.language; } },
  }),
}));

/* Rich FaqRow fixtures — plain fake ids only (gitleaks rule: no JWT-shaped
   strings), fields exactly per the A5 `formatFaq` serialization. */
const draftRow = {
  id: '1',
  question: 'Do you ship to Chattogram?',
  category_tag: 'Shipping',
  answers: { en: 'Yes, Chattogram is covered.', bn: 'হ্যাঁ, চট্টগ্রাম কভার করা হয়।' },
  keywords: ['chattogram'],
  notes: 'INTERNAL PRICE FLOOR — never customer facing',
  status: 'draft',
  is_active: false,
  priority: 5,
  use_count: 2,
  created_at: '2026-11-01T10:00:00.000Z',
  updated_at: null,
  sync_status: 'pending',
  sync_version: 1,
  synced_at: null,
  answer: 'Yes, Chattogram is covered.',
  category: 'Do you ship to Chattogram?',
  source: 'manual',
  active: false,
  usageCount: 2,
};

const publishedRow = {
  ...draftRow,
  id: '2',
  question: 'What is the delivery charge?',
  category_tag: null,
  status: 'published',
  is_active: true,
  active: true,
  updated_at: '2026-11-05T12:00:00.000Z',
  sync_status: 'synced',
  synced_at: '2026-11-05T12:01:00.000Z',
};

const failedSyncRow = {
  ...publishedRow,
  id: '3',
  question: 'Is cash on delivery available?',
  sync_status: 'failed',
  synced_at: null,
};

const disabledRow = {
  ...publishedRow,
  id: '4',
  question: 'Do you deliver on Fridays?',
  status: 'disabled',
  is_active: false,
  active: false,
  sync_status: 'pending',
  synced_at: null,
};

const archivedRow = {
  ...publishedRow,
  id: '5',
  question: 'Old seasonal question',
  status: 'archived',
  is_active: false,
  active: false,
  sync_status: 'pruned',
  synced_at: null,
};

const allRows = [draftRow, publishedRow, failedSyncRow, disabledRow, archivedRow];

function renderTab() {
  return render(
    <MemoryRouter>
      <FaqTab />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  i18nState.language = 'en';
  vi.mocked(listGapSuggestions).mockResolvedValue({ featureDisabled: true });
  vi.mocked(authService.getCurrentShop).mockReturnValue({ shop_name: 'Test Shop', role: 'owner' } as never);
  vi.mocked(faqApi.listKnowledgeFaqs).mockResolvedValue(allRows as never);
  vi.mocked(faqApi.updateKnowledgeFaq).mockImplementation(async (id: string, payload: unknown) => {
    const source = allRows.find((row) => row.id === id) ?? publishedRow;
    return { ...source, ...(payload as object), sync_status: 'pending', synced_at: null } as never;
  });
  vi.mocked(faqApi.archiveKnowledgeFaq).mockImplementation(async (id: string) => ({ ...archivedRow, id } as never));
  vi.mocked(faqApi.restoreKnowledgeFaq).mockImplementation(
    async (id: string) => ({ ...disabledRow, id, status: 'disabled', sync_status: 'pending' } as never),
  );
  vi.mocked(faqApi.resyncKnowledgeFaq).mockResolvedValue({ ...failedSyncRow, sync_status: 'pending' } as never);
  vi.mocked(faqApi.deleteKnowledgeFaq).mockResolvedValue({ message: 'FAQ deleted successfully' } as never);
  vi.mocked(faqApi.searchKnowledgeFaqs).mockResolvedValue([] as never);
});

afterEach(() => {
  cleanup();
});

describe('FaqTab — lifecycle transitions bind to the contract endpoints', () => {
  it('Publish on a draft PATCHes status published', async () => {
    renderTab();
    const row = await screen.findByTestId('faq-row-1');
    fireEvent.click(within(row).getByRole('button', { name: /manageShop\.businessFaq\.publish/ }));
    await waitFor(() => expect(faqApi.updateKnowledgeFaq).toHaveBeenCalledWith('1', { status: 'published' }));
  });

  it('Disable on a published row PATCHes status disabled; Enable on a disabled row PATCHes published', async () => {
    renderTab();
    const published = await screen.findByTestId('faq-row-2');
    fireEvent.click(within(published).getByRole('button', { name: /manageShop\.faqs\.deactivate/ }));
    await waitFor(() => expect(faqApi.updateKnowledgeFaq).toHaveBeenCalledWith('2', { status: 'disabled' }));
    const disabled = await screen.findByTestId('faq-row-4');
    fireEvent.click(within(disabled).getByRole('button', { name: /manageShop\.faqs\.activate/ }));
    await waitFor(() => expect(faqApi.updateKnowledgeFaq).toHaveBeenCalledWith('4', { status: 'published' }));
  });

  it('Archive posts /:id/archive; archived rows offer Restore (→ disabled) instead of Archive', async () => {
    renderTab();
    const row = await screen.findByTestId('faq-row-2');
    fireEvent.click(within(row).getByTestId('faq-archive-2'));
    await waitFor(() => expect(faqApi.archiveKnowledgeFaq).toHaveBeenCalledWith('2'));
    expect(faqApi.updateKnowledgeFaq).not.toHaveBeenCalledWith('2', { status: 'archived' });
    // A8 minor #2: ONE denominator — the archived row STAYS visible in the
    // default list with the server-confirmed state + Restore affordance.
    const archivedNow = await screen.findByTestId('faq-row-2');
    expect(within(archivedNow).queryByTestId('faq-archive-2')).toBeNull();
    expect(within(archivedNow).getByTestId('faq-restore-2')).toBeInTheDocument();

    // The Archived filter reveals restore-only affordances (fixture row 5).
    fireEvent.click(screen.getByTestId('faq-filter-archived'));
    const archived = await screen.findByTestId('faq-row-5');
    expect(within(archived).queryByTestId('faq-archive-5')).toBeNull();
    fireEvent.click(within(archived).getByTestId('faq-restore-5'));
    await waitFor(() => expect(faqApi.restoreKnowledgeFaq).toHaveBeenCalledWith('5'));
  });

  it('Delete stays hard but is confirm-gated (F11) and owner-only', async () => {
    renderTab();
    const row = await screen.findByTestId('faq-row-2');
    fireEvent.click(within(row).getByRole('button', { name: /manageShop\.faqs\.delete/ }));
    const confirm = await screen.findByTestId('faq-delete-confirm');
    const dialog = confirm.closest('[role="dialog"]') as HTMLElement;
    expect(within(dialog).getByText('What is the delivery charge?')).toBeInTheDocument();
    expect(faqApi.deleteKnowledgeFaq).not.toHaveBeenCalled();
    fireEvent.click(confirm);
    await waitFor(() => expect(faqApi.deleteKnowledgeFaq).toHaveBeenCalledWith('2'));
  });

  it('staff (non-owner) never sees delete or resync affordances', async () => {
    vi.mocked(authService.getCurrentShop).mockReturnValue({ shop_name: 'Test Shop', role: 'manager' } as never);
    renderTab();
    const failed = await screen.findByTestId('faq-row-3');
    expect(within(failed).queryByTestId('faq-resync-3')).toBeNull();
    expect(screen.queryByRole('button', { name: /manageShop\.faqs\.delete/ })).toBeNull();
  });
});

describe('FaqTab — bulk enable/disable is count-disclosed and confirmed', () => {
  it('enable applies only to rows the state machine allows, confirms first, reloads, clears selection', async () => {
    renderTab();
    // Select draft + disabled (enable-eligible) and published (NOT enable-eligible).
    fireEvent.click(await screen.findByLabelText('manageShop.businessFaq.bulk.select: Do you ship to Chattogram?'));
    fireEvent.click(screen.getByLabelText('manageShop.businessFaq.bulk.select: Do you deliver on Fridays?'));
    fireEvent.click(screen.getByLabelText('manageShop.businessFaq.bulk.select: What is the delivery charge?'));

    const bar = await screen.findByTestId('faq-bulk-bar');
    // tMock joins interpolated values: count + Intl-formatted ("3 3" in en-US).
    expect(within(bar).getByText('manageShop.businessFaq.bulk.selected 3 3')).toBeInTheDocument();
    const enable = within(bar).getByTestId('faq-bulk-enable');
    expect(enable).toHaveTextContent('(2)'); // draft + disabled may go published
    expect(within(bar).getByTestId('faq-bulk-disable')).toHaveTextContent('(1)'); // only the published row

    fireEvent.click(enable);
    // Confirmation step BEFORE the mutation: no PATCH until confirm is pressed.
    expect(faqApi.updateKnowledgeFaq).not.toHaveBeenCalled();
    fireEvent.click(within(bar).getByTestId('faq-bulk-confirm'));
    await waitFor(() => expect(faqApi.updateKnowledgeFaq).toHaveBeenCalledWith('1', { status: 'published' }));
    await waitFor(() => expect(faqApi.updateKnowledgeFaq).toHaveBeenCalledWith('4', { status: 'published' }));
    expect(faqApi.updateKnowledgeFaq).not.toHaveBeenCalledWith('2', { status: 'published' });
    // Re-read from the server after the batch; selection cleared.
    await waitFor(() => expect(faqApi.listKnowledgeFaqs).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByTestId('faq-bulk-bar')).toBeNull());
  });

  it('discloses partial failure instead of a silent full success', async () => {
    vi.mocked(faqApi.updateKnowledgeFaq)
      .mockRejectedValueOnce(new Error('server rejected'))
      .mockResolvedValue({ ...publishedRow, status: 'disabled' } as never);
    const { toast } = await import('sonner');
    renderTab();
    // Two published rows → both disable-eligible; the first PATCH fails.
    fireEvent.click(await screen.findByLabelText('manageShop.businessFaq.bulk.select: What is the delivery charge?'));
    fireEvent.click(screen.getByLabelText('manageShop.businessFaq.bulk.select: Is cash on delivery available?'));
    const bar = await screen.findByTestId('faq-bulk-bar');
    expect(within(bar).getByTestId('faq-bulk-disable')).toHaveTextContent('(2)');
    fireEvent.click(within(bar).getByTestId('faq-bulk-disable'));
    fireEvent.click(within(bar).getByTestId('faq-bulk-confirm'));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('manageShop.businessFaq.bulk.partial')),
    );
    expect(toast.success).not.toHaveBeenCalled();
  });
});

describe('FaqTab — search + filters', () => {
  it('chip counts are accurate against the merchant list and the status filter narrows rows', async () => {
    renderTab();
    // A8 minor #2: 'All' == Total incl. archived = 5; published=2 (rows 2+3).
    expect(await screen.findByTestId('faq-filter-all')).toHaveTextContent('(5)');
    expect(screen.getByTestId('faq-filter-published')).toHaveTextContent('(2)');
    expect(screen.getByTestId('faq-filter-draft')).toHaveTextContent('(1)');
    expect(screen.getByTestId('faq-filter-archived')).toHaveTextContent('(1)');

    // Archived rows are visibly reachable in the default list (one denominator).
    expect(screen.getByTestId('faq-row-5')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('faq-filter-archived'));
    await waitFor(() => expect(screen.getByTestId('faq-row-5')).toBeInTheDocument());
    expect(screen.queryByTestId('faq-row-2')).toBeNull();

    fireEvent.click(screen.getByTestId('faq-filter-published'));
    expect(screen.getByTestId('faq-row-2')).toBeInTheDocument();
    expect(screen.getByTestId('faq-row-3')).toBeInTheDocument();
    expect(screen.queryByTestId('faq-row-1')).toBeNull();
  });

  it('a typed query filters CLIENT-SIDE across all statuses — never a published-only server call (A8 #2)', async () => {
    renderTab();
    const input = await screen.findByTestId('faq-search');
    fireEvent.change(input, { target: { value: 'fridays' } });
    await waitFor(() => expect(screen.getByTestId('faq-row-4')).toBeInTheDocument());
    expect(faqApi.searchKnowledgeFaqs).not.toHaveBeenCalled();
    expect(screen.queryByTestId('faq-row-2')).toBeNull();
    // The A8 trap: a DRAFT must stay findable while the merchant types —
    // 'chattogram' matches draft row 1 (question + keyword), never vanishes.
    fireEvent.change(input, { target: { value: 'chattogram' } });
    await waitFor(() => expect(screen.getByTestId('faq-row-1')).toBeInTheDocument());
    expect(faqApi.searchKnowledgeFaqs).not.toHaveBeenCalled();
  });

  it('category filter includes Uncategorized for NULL tags', async () => {
    renderTab();
    const select = await screen.findByTestId('faq-filter-category');
    fireEvent.change(select, { target: { value: 'Shipping' } });
    await waitFor(() => {
      expect(screen.getByTestId('faq-row-1')).toBeInTheDocument();
      expect(screen.queryByTestId('faq-row-2')).toBeNull();
    });
    fireEvent.change(select, { target: { value: '__uncategorized__' } });
    await waitFor(() => expect(screen.queryByTestId('faq-row-1')).toBeNull());
    fireEvent.change(select, { target: { value: 'all' } });
    await waitFor(() => expect(screen.getByTestId('faq-row-1')).toBeInTheDocument());
  });

  it('no server-search matches surfaces an honest empty filter state with clear action', async () => {
    vi.mocked(faqApi.searchKnowledgeFaqs).mockResolvedValue([] as never);
    renderTab();
    const input = await screen.findByTestId('faq-search');
    fireEvent.change(input, { target: { value: 'zzz nothing matches' } });
    await waitFor(() => expect(screen.getByText('manageShop.businessFaq.filter.noResults')).toBeInTheDocument());
    expect(screen.queryByTestId('faq-row-2')).toBeNull();
  });
});

describe('FaqTab — sync honesty', () => {
  it('a failed sync row offers Retry (resync, owner) and NEVER renders a synced chip', async () => {
    renderTab();
    const failed = await screen.findByTestId('faq-row-3');
    const chip = within(failed).getByTestId('faq-sync-chip-3');
    expect(chip).toHaveTextContent('manageShop.businessFaq.chip.sync.failed');
    expect(chip).not.toHaveTextContent('chip.sync.synced');
    const retry = within(failed).getByTestId('faq-resync-3');
    fireEvent.click(retry);
    await waitFor(() => expect(faqApi.resyncKnowledgeFaq).toHaveBeenCalledWith('3'));
    await waitFor(() =>
      expect(within(screen.getByTestId('faq-row-3')).getByTestId('faq-sync-chip-3')).toHaveTextContent(
        'manageShop.businessFaq.chip.sync.pending',
      ),
    );
  });

  it('save confirms SAVED only — the returned pending row never claims synced', async () => {
    const { toast } = await import('sonner');
    vi.mocked(faqApi.updateKnowledgeFaq).mockResolvedValue({
      ...publishedRow,
      question: 'What is the delivery charge now?',
      sync_status: 'pending',
      synced_at: null,
    } as never);
    renderTab();
    const row = await screen.findByTestId('faq-row-2');
    fireEvent.click(within(row).getByRole('button', { name: /manageShop\.faqs\.edit/ }));
    const drawer = await screen.findByTestId('faq-editor-drawer');
    const answerInput = within(drawer).getByPlaceholderText('manageShop.faqs.modal.answerPlaceholder');
    fireEvent.change(answerInput, { target: { value: 'Inside Dhaka 80, outside 120.' } });
    fireEvent.click(within(drawer).getByRole('button', { name: /manageShop\.faqs\.save/ }));
    await waitFor(() => expect(faqApi.updateKnowledgeFaq).toHaveBeenCalled());
    // Toast = SAVED wording (server-resolved, after await); no "live/synced" claim.
    expect(toast.success).toHaveBeenCalledWith('manageShop.businessFaq.savedToast');
    await waitFor(() =>
      expect(within(screen.getByTestId('faq-row-2')).getByTestId('faq-sync-chip-2')).toHaveTextContent(
        'manageShop.businessFaq.chip.sync.pending',
      ),
    );
    expect(within(screen.getByTestId('faq-row-2')).getByTestId('faq-sync-chip-2')).not.toHaveTextContent(
      'chip.sync.synced',
    );
  });
});

describe('FaqTab — banned content and data hygiene', () => {
  it('renders NO confidence text or percent anywhere, including with the editor open', async () => {
    const { container } = renderTab();
    await screen.findByTestId('faq-row-2');
    expect(container.textContent).not.toMatch(/confidence/i);
    expect(container.textContent).not.toMatch(/%/);
    const row = screen.getByTestId('faq-row-2');
    fireEvent.click(within(row).getByRole('button', { name: /manageShop\.faqs\.edit/ }));
    const drawer = await screen.findByTestId('faq-editor-drawer');
    expect(drawer.textContent).not.toMatch(/confidence/i);
    expect(drawer.querySelector('input[type="range"]')).toBeNull();
  });

  it('internal notes NEVER render on list rows, and keywords are labeled internal', async () => {
    const { container } = renderTab();
    await screen.findByTestId('faq-row-2');
    expect(container.textContent).not.toContain('INTERNAL PRICE FLOOR');
    // The keywords line carries its explicit internal label.
    expect(screen.getAllByText('manageShop.businessFaq.keywordsLabel').length).toBeGreaterThan(0);
  });

  it('NULL updated_at renders "—" while created_at formats; en then bn numerals', async () => {
    const { container } = renderTab();
    const draft = await screen.findByTestId('faq-row-1');
    // tMock joins values: "…time.updated —"
    expect(draft.textContent).toContain('manageShop.businessFaq.time.updated —');
    const expectedEn = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(
      new Date('2026-11-01T10:00:00.000Z'),
    );
    expect(draft.textContent).toContain(expectedEn);
    expect(container.textContent).not.toContain('Invalid Date');

    i18nState.language = 'bn';
    cleanup();
    const rerendered = renderTab();
    const bnDraft = await screen.findByTestId('faq-row-1');
    const expectedBn = new Intl.DateTimeFormat('bn-BD', { dateStyle: 'medium', timeStyle: 'short' }).format(
      new Date('2026-11-01T10:00:00.000Z'),
    );
    expect(bnDraft.textContent).toContain(expectedBn);
    // replies-used renders the Intl bn-BD numerals alongside the raw count
    // (tMock joins interpolated values: "…repliesUsed 2 ২").
    const expectedCount = new Intl.NumberFormat('bn-BD').format(2);
    expect(bnDraft.textContent).toContain(`manageShop.businessFaq.repliesUsed 2 ${expectedCount}`);
    rerendered.unmount();
  });
});

describe('FaqTab — page states', () => {
  it('load error: ResultBanner alert, faq-add hidden, retry recovers', async () => {
    vi.mocked(faqApi.listKnowledgeFaqs)
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(allRows as never);
    renderTab();
    const banner = await screen.findByRole('alert');
    expect(banner).toBeInTheDocument();
    expect(screen.queryByTestId('faq-add')).toBeNull();
    fireEvent.click(within(banner).getByRole('button', { name: 'manageShop.faqs.refresh' }));
    await waitFor(() => expect(faqApi.listKnowledgeFaqs).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId('faq-add')).toBeInTheDocument());
  });

  it('empty list keeps the faq-add CTA inside the empty block', async () => {
    vi.mocked(faqApi.listKnowledgeFaqs).mockResolvedValue([] as never);
    renderTab();
    const add = await screen.findByTestId('faq-add');
    expect(add).toBeInTheDocument();
    expect(screen.getByText('manageShop.faqs.emptyTitle')).toBeInTheDocument();
  });

  it('default order is updated-first, NULL-safe (never-edited rows last)', async () => {
    renderTab();
    await screen.findByTestId('faq-row-2');
    const rows = Array.from(document.querySelectorAll('[data-testid^="faq-row-"]')).map((el) =>
      el.getAttribute('data-testid'),
    );
    // Rows 2/3/4 share updated 2026-11-05; draft (updated NULL) sorts in the
    // NULL-safe tail; archived rows are now part of the default view (A8 #2).
    expect(rows).toContain('faq-row-5');
    expect(rows.indexOf('faq-row-2')).toBeLessThan(rows.indexOf('faq-row-1'));
    expect(rows.slice(-2).sort()).toEqual(['faq-row-1', 'faq-row-5']);
  });
});
