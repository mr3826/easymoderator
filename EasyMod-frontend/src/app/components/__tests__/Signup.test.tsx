import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import Signup from '../Signup';

const { mockContractQuery } = vi.hoisted(() => ({ mockContractQuery: vi.fn() }));

vi.mock('@/api/domains/commercialContract', () => ({
  useCommercialContract: mockContractQuery,
}));

const mockSignup = vi.fn();

vi.mock('@/features/auth/AuthProvider', () => ({
  useAuth: () => ({ signup: mockSignup }),
}));

vi.mock('@/app/lib/funnel', () => ({
  trackFunnelEvent: vi.fn(),
}));

function LocationDisplay() {
  const location = useLocation();
  return <output data-testid="current-location">{`${location.pathname}${location.search}`}</output>;
}

function renderSignup(initialEntry = '/signup') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Signup />
      <LocationDisplay />
    </MemoryRouter>,
  );
}

async function fillValidFields(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('Your name'), 'Consent Test User');
  await user.type(screen.getByLabelText('Email'), 'consent-test@example.com');
  await user.type(screen.getByLabelText(/mobile number/i), '01712345678');
  await user.type(screen.getByLabelText('Password'), 'ValidPass123!');
}

describe('Signup terms consent', () => {
  beforeEach(() => {
    mockContractQuery.mockReturnValue({
      data: {
        contract_version: '1.0.0',
        contract_hash: `sha256:${'b'.repeat(64)}`,
        registry_hash: `sha256:${'a'.repeat(64)}`,
        unit_price_minor: 1000,
        due_days: 7,
        description: {
          en: '৳10.00 per delivered order. ৳0.00 on returned or cancelled orders.',
          bn: 'প্রতি ডেলিভারি অর্ডারে ৳১০.০০।',
        },
      },
      isPending: false,
      error: null,
      refetch: vi.fn(),
    });
    mockSignup.mockReset();
    mockSignup.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('starts with a disabled submit button and visible consent guidance', () => {
    renderSignup();

    expect(screen.getByLabelText('Your name')).toHaveAttribute('aria-required', 'true');
    expect(screen.getByLabelText('Email')).toHaveAttribute('aria-required', 'true');
    expect(screen.getByLabelText('Password')).toHaveAttribute('aria-required', 'true');
    expect(screen.getByRole('checkbox', { name: /privacy policy/i })).toHaveAttribute('aria-required', 'true');
    expect(screen.getByRole('button', { name: /create your EasyModerator account/i })).toBeDisabled();
    expect(screen.getByText(/required to create your account/i)).toBeInTheDocument();
    expect(screen.getByText(/8 or more characters/i)).toBeInTheDocument();
    expect(screen.getAllByText(/first shop/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/no payment information is required to create an account/i)).toBeInTheDocument();
    expect(screen.getByText(/after account creation, finish shop setup from the dashboard/i)).toBeInTheDocument();
    expect(screen.getByText(/to connect Messenger, go to Settings → Chat, complete Facebook Login, then choose an eligible Page/i)).toBeInTheDocument();
    expect(screen.getByText(/under Business information/i)).toBeInTheDocument();
    expect(screen.getByText(/we use your name for your account and first shop/i)).toBeInTheDocument();
    expect(screen.getByText(/accounts start on delivered-order billing/i)).toBeInTheDocument();
    expect(screen.getByText(/৳10\.00 per provider-confirmed delivered order/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/mobile number/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/mobile number/i)).toHaveAttribute('aria-required', 'true');
    expect(screen.getAllByRole('link', { name: /privacy policy/i }).every((link) => link.getAttribute('href')?.includes('/privacy-policy?lang=en'))).toBe(true);
    expect(screen.getAllByRole('link', { name: /terms of service/i }).every((link) => link.getAttribute('href')?.includes('/terms?lang=en'))).toBe(true);
  });

  it('does not submit or enter a pending state when consent is missing', async () => {
    const user = userEvent.setup();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    renderSignup();
    await fillValidFields(user);

    const submit = screen.getByRole('button', { name: /create your EasyModerator account/i });
    const form = submit.closest('form');
    expect(form).not.toBeNull();
    fireEvent.submit(form!);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/accept the terms/i);
    });
    expect(mockSignup).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /create your EasyModerator account/i })).not.toHaveTextContent(/creating account/i);
    expect(consoleError).not.toHaveBeenCalled();

    await user.click(screen.getByRole('checkbox', { name: /privacy policy/i }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('enables consented signup and sends exactly one consented request', async () => {
    const user = userEvent.setup();
    let resolveSignup!: () => void;
    mockSignup.mockImplementation(() => new Promise<void>((resolve) => {
      resolveSignup = resolve;
    }));
    renderSignup();
    await fillValidFields(user);

    const terms = screen.getByRole('checkbox', { name: /privacy policy/i });
    const submit = screen.getByRole('button', { name: /create your EasyModerator account/i });
    expect(submit).toBeDisabled();
    await user.click(terms);
    expect(submit).toBeEnabled();

    const firstSubmit = user.click(submit);
    await waitFor(() => expect(mockSignup).toHaveBeenCalledTimes(1));
    expect(submit).toBeDisabled();
    expect(screen.getByText(/creating account/i)).toBeInTheDocument();

    await user.click(submit);
    expect(mockSignup).toHaveBeenCalledTimes(1);
    expect(mockSignup).toHaveBeenCalledWith({
      email: 'consent-test@example.com',
      password: 'ValidPass123!',
      full_name: 'Consent Test User',
      phone: '01712345678',
      accepted_terms: true,
    });

    resolveSignup();
    await firstSubmit;
  });

  it('continues the fixed subscription path after signup', async () => {
    const user = userEvent.setup();
    renderSignup('/signup?lang=en&intent=growth-upgrade&returnTo=https%3A%2F%2Fevil.invalid');
    await fillValidFields(user);
    await user.click(screen.getByRole('checkbox', { name: /privacy policy/i }));
    await user.click(screen.getByRole('button', { name: /create your EasyModerator account/i }));

    await waitFor(() => {
      expect(screen.getByTestId('current-location')).toHaveTextContent(
        '/subscription?intent=growth-upgrade&lang=en',
      );
    });
    expect(screen.getByTestId('current-location')).not.toHaveTextContent('evil.invalid');
  });

  it('re-enables the button and presents a normal error after signup failure', async () => {
    const user = userEvent.setup();
    mockSignup.mockRejectedValue(new Error('Email is already registered'));
    renderSignup();
    await fillValidFields(user);
    await user.click(screen.getByRole('checkbox', { name: /privacy policy/i }));
    const submit = screen.getByRole('button', { name: /create your EasyModerator account/i });

    await user.click(submit);

    await waitFor(() => expect(screen.getByText('Email is already registered')).toBeInTheDocument());
    expect(submit).toBeEnabled();
  });

  it('ignores duplicate programmatic submissions while signup is pending', async () => {
    const user = userEvent.setup();
    let resolveSignup!: () => void;
    mockSignup.mockImplementation(() => new Promise<void>((resolve) => {
      resolveSignup = resolve;
    }));
    renderSignup();
    await fillValidFields(user);
    await user.click(screen.getByRole('checkbox', { name: /privacy policy/i }));

    const submit = screen.getByRole('button', { name: /create your EasyModerator account/i });
    const form = submit.closest('form');
    expect(form).not.toBeNull();
    form!.requestSubmit();
    form!.requestSubmit();

    await waitFor(() => expect(mockSignup).toHaveBeenCalledTimes(1));
    expect(submit).toBeDisabled();
    resolveSignup();
    await waitFor(() => expect(submit).toBeEnabled());
  });
});