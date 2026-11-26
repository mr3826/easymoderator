/**
 * VerificationChip — ladder honesty (contract §2, R-12/R-13, D-3). The chip is
 * the only place a merchant learns "how verified" an account is, so these pins
 * prove it can NEVER overstate: the exact ratification sentences render, and the
 * forbidden implications ("verified with bKash/provider", "connected", the
 * legacy "…via official merchant API") never appear below live certification.
 */
import '@testing-library/jest-dom';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import VerificationChip from '../VerificationChip';
import type { PaymentAccountView } from '../taxonomy';

const acc = (o: Partial<PaymentAccountView> = {}): PaymentAccountView => ({
  id: 'a1',
  shop_id: 'shop-1',
  provider: 'bkash',
  account_type: 'self',
  gateway: 'self-mfs',
  is_enabled: true,
  is_preferred: false,
  verification_level: 'configured_unverified',
  automated_checkout_active: false,
  ...o,
});

describe('VerificationChip ladder honesty', () => {
  it('bKash wallet at configured_unverified states format-only, never a provider check', () => {
    render(<VerificationChip account={acc({ account_type: 'self', verification_level: 'configured_unverified' })} />);
    expect(screen.getByTestId('verification-honesty')).toHaveTextContent(
      'Credentials validated (format) — not verified with bKash',
    );
    const chip = screen.getByTestId(/^verification-chip/);
    expect(chip).not.toHaveTextContent(/verified with provider/i);
    expect(chip).not.toHaveTextContent(/\bconnected\b/i);
  });

  it('unverified bKash does not claim validated or verified', () => {
    render(<VerificationChip account={acc({ verification_level: 'unverified' })} />);
    expect(screen.getByTestId('verification-honesty')).toHaveTextContent(/Not verified/i);
    expect(screen.getByTestId('verification-chip-a1')).not.toHaveTextContent(/not verified with bKash/i);
  });

  it('Nagad / Rocket render the exact "official verification unavailable" notice', () => {
    const { rerender } = render(<VerificationChip account={acc({ provider: 'nagad', account_type: 'self', verification_level: 'configured_unverified' })} />);
    expect(screen.getByTestId('verification-honesty')).toHaveTextContent(
      'Official automated verification is not available for Nagad/Rocket.',
    );
    expect(screen.getByTestId('verification-honesty')).toHaveTextContent('never automatically');
    rerender(<VerificationChip account={acc({ provider: 'rocket', account_type: 'business', verification_level: 'configured_unverified' })} />);
    expect(screen.getByTestId('verification-honesty')).toHaveTextContent(
      'confirmed by you (the merchant)',
    );
  });

  it('bKash merchant_gateway below live_certified renders the not-active family and never the forbidden API string', () => {
    render(<VerificationChip account={acc({ account_type: 'merchant_gateway', verification_level: 'configured_unverified' })} />);
    expect(screen.getByTestId('verification-honesty')).toHaveTextContent('Credentials validated (format) — not verified with bKash');
    expect(screen.getByTestId('verification-extra')).toHaveTextContent('Automated checkout is not active yet');
    expect(screen.getByTestId('verification-chip-a1')).not.toHaveTextContent(/via official merchant API/i);
  });

  it('bKash gateway sandbox_verified renders D-3 copy exactly + no-settlement honesty', () => {
    render(<VerificationChip account={acc({ account_type: 'merchant_gateway', verification_level: 'sandbox_verified' })} />);
    expect(screen.getByTestId('verification-honesty')).toHaveTextContent('sandbox checkout handshake verified; no settlement implied');
    expect(screen.getByTestId('verification-extra')).toHaveTextContent('Automated checkout is not active yet');
  });

  it('bKash gateway live_certified is framed as an owner record, never an app-verified claim', () => {
    render(<VerificationChip account={acc({ account_type: 'merchant_gateway', verification_level: 'live_certified' })} />);
    expect(screen.getByTestId('verification-honesty')).toHaveTextContent(/owner/i);
    expect(screen.getByTestId('verification-honesty')).toHaveTextContent(/never declares this itself/i);
    const chip = screen.getByTestId('verification-chip-a1');
    expect(chip).not.toHaveTextContent(/verified with bKash/i);
    expect(chip).not.toHaveTextContent(/via official merchant API/i);
  });

  it('COD carries no ladder claim', () => {
    render(<VerificationChip account={acc({ provider: 'cod', account_type: 'standard', gateway: 'cod', verification_level: 'unverified' })} />);
    expect(screen.getByTestId('verification-honesty')).toHaveTextContent('No verification needed — cash on delivery');
  });
});
