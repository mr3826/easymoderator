/**
 * PoliciesTab — validation mirrors the server bounds, and a valid edit calls
 * the shell's single save exactly once (§5.2; R-14 one-PUT). The tab is
 * presentational: it never hits the API itself (that is the shell's one PUT).
 */
import '@testing-library/jest-dom';
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import PoliciesTab from '../PoliciesTab';
import type { PaymentPolicyView } from '../taxonomy';

const base: PaymentPolicyView = { advance_policy: 'none', advance_value: null, payment_message: '' };

function renderTab(o: Partial<PaymentPolicyView> = {}) {
  const onChange = vi.fn();
  const onSave = vi.fn();
  const policy = { ...base, ...o };
  render(
    <MemoryRouter>
      <PoliciesTab policy={policy} onChange={onChange} onSave={onSave} isDirty justSaved={false} />
    </MemoryRouter>,
  );
  return { onChange, onSave, policy };
}

describe('PoliciesTab validation + save', () => {
  it('renders the five canonical rules and keeps the value null for the non-numeric ones', () => {
    const { onChange } = renderTab();
    for (const p of ['none', 'full', 'delivery_charge', 'percentage', 'fixed']) {
      expect(screen.getByTestId(`advance-radio-${p}`)).toBeInTheDocument();
    }
    fireEvent.click(screen.getByLabelText(/Full Payment/i));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ advance_policy: 'full', advance_value: null }));
  });

  it('shows the numeric field only for the selected rule', () => {
    renderTab({ advance_policy: 'percentage', advance_value: 50 });
    expect(screen.getByTestId('advance-percentage-input')).toBeInTheDocument();
    expect(screen.queryByTestId('advance-fixed-input')).not.toBeInTheDocument();
  });

  it('blocks the save before the PUT when the percentage is out of range', () => {
    renderTab({ advance_policy: 'percentage', advance_value: 100 });
    fireEvent.click(screen.getByTestId('policy-save'));
    expect(screen.getByRole('alert')).toHaveTextContent(/whole number from 1 to 99/i);
    // onSave (the shell's one PUT) is NEVER called with provably-invalid data.
    expect(screen.getByTestId('policy-save'));
  });

  it('blocks onSave for an invalid fixed amount', () => {
    const { onSave } = renderTab({ advance_policy: 'fixed', advance_value: 0 });
    fireEvent.click(screen.getByTestId('policy-save'));
    expect(onSave).not.toHaveBeenCalled();
  });

  it('calls the shell save exactly once for a valid fixed amount', () => {
    const { onSave } = renderTab({ advance_policy: 'fixed', advance_value: 200 });
    fireEvent.click(screen.getByTestId('policy-save'));
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('reports the message character limit and caps input at 500', () => {
    renderTab({ payment_message: 'hello' });
    const textarea = screen.getByTestId('policy-message-input') as HTMLTextAreaElement;
    expect(textarea).toHaveAttribute('maxlength', '500');
    expect(screen.getByTestId('policy-message-count')).toHaveTextContent('5');
  });

  it('points at Delivery Settings for COD + delivery charge and never duplicates that control', () => {
    renderTab();
    const link = screen.getByTestId('policy-delivery-link');
    expect(link).toHaveAccessibleName('Delivery Settings');
    expect(link).toHaveAttribute('href', '/manage-shop/delivery-settings');
    // No zone/COD charge inputs belong in this tab (§5.2 authority lives in Delivery).
    expect(screen.queryByLabelText(/Default delivery charge/i)).not.toBeInTheDocument();
  });

  it('disables save when nothing is dirty', () => {
    render(
      <MemoryRouter>
        <PoliciesTab policy={base} onChange={vi.fn()} onSave={vi.fn()} isDirty={false} justSaved />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('policy-save')).toBeDisabled();
  });
});
