import '@testing-library/jest-dom';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { OverrideControl } from '@/app/components/channels/OverrideControl';

describe('OverrideControl', () => {
  it('offers an explicit override only when editing is allowed', () => {
    const onStartOverride = vi.fn();
    render(
      <OverrideControl
        label="Confidence threshold"
        overridden={false}
        canEdit
        effective="80%"
        onStartOverride={onStartOverride}
        onRevert={vi.fn()}
      >
        <p>editor</p>
      </OverrideControl>,
    );

    expect(screen.getByText('Inherited')).toBeInTheDocument();
    expect(screen.getByText(/Effective/)).toHaveTextContent('80%');
    expect(screen.queryByText('editor')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Override for this channel/i }));
    expect(onStartOverride).toHaveBeenCalledTimes(1);
  });

  it('shows the editor plus revert control when an override is stored', () => {
    const onRevert = vi.fn();
    render(
      <OverrideControl
        label="Confidence threshold"
        overridden
        canEdit
        effective="80%"
        onStartOverride={vi.fn()}
        onRevert={onRevert}
        revertTestId="channel-override-revert-confidence_threshold"
      >
        <input aria-label="threshold" />
      </OverrideControl>,
    );

    expect(screen.getByText('Overridden')).toBeInTheDocument();
    expect(screen.getByLabelText('threshold')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('channel-override-revert-confidence_threshold'));
    expect(onRevert).toHaveBeenCalledTimes(1);
  });

  it('never renders edit controls for a read-only member and states the real reason', () => {
    render(
      <OverrideControl
        label="Reply mode"
        overridden={false}
        canEdit={false}
        readOnlyReason="Only the shop owner can change channel automation."
        effective="Manual replies only"
        onStartOverride={vi.fn()}
        onRevert={vi.fn()}
      >
        <p>editor</p>
      </OverrideControl>,
    );

    expect(screen.getByTestId('channel-read-only-reason')).toHaveTextContent(
      'Only the shop owner can change channel automation.',
    );
    expect(screen.queryByRole('button', { name: /Override for this channel/i })).not.toBeInTheDocument();
    expect(screen.queryByText('editor')).not.toBeInTheDocument();
  });
});