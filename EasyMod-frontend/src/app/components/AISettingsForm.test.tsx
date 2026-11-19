import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AISettingsForm from './AISettingsForm';
import type { ShopAISettings } from '@/api/types/dashboard';
import { queryClient } from '@/app/lib/queryClient';

// Resolve real English from en.json so assertions verify the actual (en-default)
// UI copy after i18n-ization, with {{var}} interpolation support.
vi.mock('react-i18next', async () => {
  const en = (await import('@/i18n/locales/en.json')).default as Record<string, any>;
  const t = (key: string, opts?: any) => {
    const v = key.split('.').reduce((o: any, k) => (o == null ? undefined : o[k]), en);
    if (typeof v !== 'string') return typeof opts === 'string' ? opts : key;
    if (opts && typeof opts === 'object') {
      return Object.entries(opts).reduce(
        (s, [k, val]) => s.replace(new RegExp(`{{\\s*${k}\\s*}}`, 'g'), String(val)),
        v,
      );
    }
    return v;
  };
  return { useTranslation: () => ({ t, i18n: { language: 'en', changeLanguage: () => Promise.resolve() } }) };
});

describe('AISettingsForm', () => {
  const mockOnSave = vi.fn();
  const defaultProps = {
    initialData: null,
    onSave: mockOnSave,
  };

  const defaultSettings: ShopAISettings = {
    automation_mode: 'DRAFT',
    confidence_threshold: 75,
    auto_reply_enabled: false,
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
      trigger_keywords: ['complain', 'problem', 'issue'],
      notification_channel: 'in_app',
      cooldown_minutes: 30,
    },
  };

  beforeEach(() => {
    mockOnSave.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders with default settings', () => {
    render(<AISettingsForm {...defaultProps} />);
    
    expect(screen.getByText('Reply Settings')).toBeInTheDocument();
    expect(screen.getByText('Choose when EasyModerator drafts, sends, or pauses replies.')).toBeInTheDocument();
    expect(screen.getByText('75%')).toBeInTheDocument();
  });

  it('renders automation mode options', () => {
    render(<AISettingsForm {...defaultProps} />);

    expect(screen.getByText('AUTO')).toBeInTheDocument();
    expect(screen.getByText('DRAFT')).toBeInTheDocument();
    expect(screen.getByText('MANUAL')).toBeInTheDocument();
    expect(screen.getByText('Manual replies only (Recommended)')).toBeInTheDocument();
    expect(screen.getByText('Review first')).toBeInTheDocument();
    expect(screen.queryByText('Review first (Recommended)')).not.toBeInTheDocument();
    expect([...screen.getByTestId('ai-reply-mode').querySelectorAll('[role="radio"]')].map((radio) => radio.id)).toEqual([
      'ai-reply-mode-manual',
      'ai-reply-mode-draft',
      'ai-reply-mode-auto',
    ]);
  });

  it('renders an accessible radio group with Manual selected by default', () => {
    render(<AISettingsForm {...defaultProps} />);

    expect(screen.getByTestId('ai-reply-mode')).toHaveAttribute('role', 'radiogroup');
    expect(screen.getByTestId('ai-reply-mode-manual')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('ai-reply-mode-draft')).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByTestId('ai-reply-mode-auto')).toHaveAttribute('aria-checked', 'false');
  });

  it('selects automation mode on click', async () => {
    render(<AISettingsForm {...defaultProps} />);

    const autoRadio = screen.getByTestId('ai-reply-mode-auto');
    fireEvent.click(autoRadio);

    expect(autoRadio).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('ai-reply-mode-manual')).toHaveAttribute('aria-checked', 'false');
  });

  it('moves focus between modes with arrow keys', async () => {
    const user = userEvent.setup();
    render(<AISettingsForm {...defaultProps} />);

    const manualRadio = screen.getByTestId('ai-reply-mode-manual');
    const draftRadio = screen.getByTestId('ai-reply-mode-draft');
    manualRadio.focus();

    await user.keyboard('{ArrowRight}');

    await waitFor(() => expect(draftRadio).toHaveFocus());
  });

  it('renders language options', () => {
    render(<AISettingsForm {...defaultProps} />);
    
    expect(screen.getByText('mixed')).toBeInTheDocument();
    expect(screen.getByText('bn')).toBeInTheDocument();
    expect(screen.getByText('en')).toBeInTheDocument();
  });

  it('selects primary language on click', async () => {
    render(<AISettingsForm {...defaultProps} />);
    
    const enButton = screen.getByRole('button', { name: /^en\b/i });
    fireEvent.click(enButton);
    
    // Token migration (harness): the selected-state border moved from legacy
    // blue-500 to the em violet ramp. Same element, same contract; aria-pressed
    // is the durable semantic proof the class was proxying.
    expect(enButton.className).toContain('border-em-violet-600');
    expect(enButton).toHaveAttribute('aria-pressed', 'true');
  });

  it('updates confidence threshold on slider change', async () => {
    render(<AISettingsForm {...defaultProps} />);
    
    const slider = screen.getByRole('slider');
    fireEvent.change(slider, { target: { value: '80' } });
    
    expect(screen.getByText('80%')).toBeInTheDocument();
  });

  it('omits unconsumed max_auto_order_value and required_fields controls', async () => {
    render(<AISettingsForm {...defaultProps} initialData={defaultSettings} />);

    expect(screen.queryByLabelText(/Maximum automatic order value/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/customer name/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/email address/i)).not.toBeInTheDocument();
  });

  it('does not render a redundant auto-reply toggle', async () => {
    render(<AISettingsForm {...defaultProps} initialData={defaultSettings} />);

    expect(screen.queryByText('Automatic replies enabled')).not.toBeInTheDocument();
  });

  it('expands handoff settings section on click', async () => {
    render(<AISettingsForm {...defaultProps} />);
    
    const handoffButton = screen.getByRole('button', { name: /When We Should Alert You/i });
    fireEvent.click(handoffButton);
    
    expect(screen.getByLabelText(/Alert channel/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Cooldown/i)).toBeInTheDocument();
  });

  it('changes notification channel in handoff settings to Telegram', async () => {
    render(<AISettingsForm {...defaultProps} initialData={defaultSettings} />);
    
    const handoffButton = screen.getByRole('button', { name: /When We Should Alert You/i });
    fireEvent.click(handoffButton);
    
    const channelSelect = screen.getByLabelText(/Alert channel/i);
    fireEvent.change(channelSelect, { target: { value: 'telegram' } });
    
    expect(channelSelect).toHaveValue('telegram');
  });

  it('adds alert keywords in handoff settings', async () => {
    render(<AISettingsForm {...defaultProps} initialData={defaultSettings} />);
    
    const handoffButton = screen.getByRole('button', { name: /When We Should Alert You/i });
    fireEvent.click(handoffButton);
    
    // Find the alert keywords input (second tag input in the form)
    const inputs = screen.getAllByPlaceholderText(/e\.g\./i);
    const keywordInput = inputs[inputs.length - 1]; // Last one is the handoff keywords
    
    await userEvent.type(keywordInput, 'refund');
    
    // Locator migration (harness): the add button used to have an EMPTY
    // accessible name, so it could only be found by ordinal. It is now named
    // (axe button-name is critical), which makes this query singular and
    // immune to DOM reordering. The assertion below is unchanged.
    const addButton = screen.getByRole('button', { name: 'Add keyword' });
    fireEvent.click(addButton);
    
    await waitFor(() => {
      expect(screen.getByText('refund')).toBeInTheDocument();
    });
  });

  it('disables save button when no changes made', () => {
    render(<AISettingsForm {...defaultProps} initialData={defaultSettings} />);
    const saveButton = screen.getByRole('button', { name: /Save Reply Settings/i });
    expect(saveButton).toBeDisabled();
  });

  it('enables save button when settings change', async () => {
    render(<AISettingsForm {...defaultProps} initialData={defaultSettings} />);
    
    const slider = screen.getByRole('slider');
    fireEvent.change(slider, { target: { value: '80' } });
    
    const saveButton = screen.getByRole('button', { name: /Save Reply Settings/i });
    expect(saveButton).not.toBeDisabled();
  });

  it('calls onSave with correct data', async () => {
    mockOnSave.mockResolvedValue({});
    
    render(<AISettingsForm {...defaultProps} initialData={defaultSettings} />);
    
    const slider = screen.getByRole('slider');
    fireEvent.change(slider, { target: { value: '80' } });
    
    const saveButton = screen.getByRole('button', { name: /Save Reply Settings/i });
    fireEvent.click(saveButton);
    
    await waitFor(() => {
      expect(mockOnSave).toHaveBeenCalledWith(expect.objectContaining({
        confidence_threshold: 80,
        automation_mode: 'DRAFT',
        auto_reply_enabled: false,
      }));
    });
  });

  it('derives auto_reply_enabled from automation mode when saving', async () => {
    mockOnSave.mockResolvedValue({});

    render(<AISettingsForm {...defaultProps} initialData={defaultSettings} />);

    fireEvent.click(screen.getByTestId('ai-reply-mode-auto'));

    const saveButton = screen.getByRole('button', { name: /Save Reply Settings/i });
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(mockOnSave).toHaveBeenCalledWith(expect.objectContaining({
        automation_mode: 'AUTO',
        auto_reply_enabled: true,
      }));
    });
  });

  it('uses the persisted server mode after saving', async () => {
    mockOnSave.mockResolvedValue({
      ...defaultSettings,
      automation_mode: 'MANUAL',
      auto_reply_enabled: false,
    });

    render(<AISettingsForm {...defaultProps} initialData={defaultSettings} />);

    fireEvent.click(screen.getByTestId('ai-reply-mode-auto'));
    fireEvent.click(screen.getByRole('button', { name: /Save Reply Settings/i }));

    await waitFor(() => {
      expect(screen.getByTestId('ai-reply-mode-manual')).toHaveAttribute('aria-checked', 'true');
      expect(screen.getByTestId('ai-reply-mode-auto')).toHaveAttribute('aria-checked', 'false');
    });
  });

  it('shows success notice after save', async () => {
    mockOnSave.mockResolvedValue({});
    
    render(<AISettingsForm {...defaultProps} initialData={defaultSettings} />);
    
    const maxOrderInput = screen.getByLabelText(/Maximum automatic order value/i);
    await userEvent.clear(maxOrderInput);
    await userEvent.type(maxOrderInput, '10000');
    
    const saveButton = screen.getByRole('button', { name: /Save Reply Settings/i });
    fireEvent.click(saveButton);
    
    await waitFor(() => {
      expect(screen.getByText('Reply settings saved.')).toBeInTheDocument();
    });
  });

  it('shows error notice when save fails', async () => {
    // The shape the axios interceptor actually throws — a NormalizedApiError,
    // with no `.response`.
    mockOnSave.mockRejectedValue({
      type: 'VALIDATION_ERROR',
      statusCode: 400,
      message: 'Failed to save',
      timestamp: '2026-08-02T00:00:00.000Z',
    });
    
    render(<AISettingsForm {...defaultProps} initialData={defaultSettings} />);
    
    const maxOrderInput = screen.getByLabelText(/Maximum automatic order value/i);
    await userEvent.clear(maxOrderInput);
    await userEvent.type(maxOrderInput, '10000');
    
    const saveButton = screen.getByRole('button', { name: /Save Reply Settings/i });
    fireEvent.click(saveButton);
    
    await waitFor(() => {
      expect(screen.getByText('Failed to save')).toBeInTheDocument();
    });
  });

  it('merges initial data with defaults correctly', () => {
    const partialData = {
      automation_mode: 'AI_ACTIVE',
      confidence_threshold: 80,
    } as unknown as Partial<ShopAISettings>;

    render(<AISettingsForm {...defaultProps} initialData={partialData} />);
    
    // Check that provided values are used
    expect(screen.getByText('80%')).toBeInTheDocument();
    
    // Check that defaults are merged for missing values
    const maxOrderInput = screen.getByLabelText(/Maximum automatic order value/i);
    expect(maxOrderInput).toHaveValue(5000);

    expect(screen.getByTestId('ai-reply-mode-auto')).toHaveAttribute('aria-checked', 'true');
  });

  it('fails closed to Manual for unknown initial mode values', () => {
    const partialData = {
      automation_mode: 'GARBAGE',
    } as unknown as Partial<ShopAISettings>;

    render(<AISettingsForm {...defaultProps} initialData={partialData} />);

    expect(screen.getByTestId('ai-reply-mode-manual')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('ai-reply-mode-draft')).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByTestId('ai-reply-mode-auto')).toHaveAttribute('aria-checked', 'false');
  });

  it('invalidates the inbox conversations after a successful save', async () => {
    mockOnSave.mockResolvedValue({});
    const invalidateQueries = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue(undefined);

    render(<AISettingsForm {...defaultProps} initialData={defaultSettings} />);

    const maxOrderInput = screen.getByLabelText(/Maximum automatic order value/i);
    await userEvent.clear(maxOrderInput);
    await userEvent.type(maxOrderInput, '10000');
    fireEvent.click(screen.getByRole('button', { name: /Save Reply Settings/i }));

    await waitFor(() => {
      expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['conversations'] });
    });
  });

  it('preserves stored required_fields and legacy ask_email untouched on save', async () => {
    mockOnSave.mockResolvedValue({});
    const partialData: Partial<ShopAISettings> = {
      ask_email: true,
      required_fields: {
        customer_name: false,
        mobile_number: true,
        delivery_address: true,
        payment_method: true,
        email_address: true,
        special_instructions: false,
      },
    };

    render(<AISettingsForm {...defaultProps} initialData={partialData} />);
    fireEvent.change(screen.getByRole('slider'), { target: { value: '85' } });
    fireEvent.click(screen.getByRole('button', { name: /Save Reply Settings/i }));

    await waitFor(() => {
      expect(mockOnSave).toHaveBeenCalledWith(expect.objectContaining({
        ask_email: true,
        required_fields: partialData.required_fields,
      }));
    });
  });

  it('updates cooldown minutes in handoff settings', async () => {
    render(<AISettingsForm {...defaultProps} initialData={defaultSettings} />);
    
    const handoffButton = screen.getByRole('button', { name: /When We Should Alert You/i });
    fireEvent.click(handoffButton);
    
    const cooldownInput = screen.getByLabelText(/Cooldown/i);
    await userEvent.clear(cooldownInput);
    await userEvent.type(cooldownInput, '60');
    
    expect(cooldownInput).toHaveValue(60);
  });
});
