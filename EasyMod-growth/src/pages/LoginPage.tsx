import { FormEvent, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { LogIn } from 'lucide-react';
import { useGrowthAuth } from '@/auth/GrowthAuthProvider';
import { GrowthUnavailablePage } from '@/pages/GrowthUnavailablePage';

export function LoginPage() {
  const auth = useGrowthAuth();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [otp, setOtp] = useState('');
  const [submitting, setSubmitting] = useState(false);

  if (auth.status === 'authenticated') {
    const redirectTo = typeof location.state === 'object' && location.state && 'from' in location.state
      ? String(location.state.from)
      : '/';
    return <Navigate to={redirectTo} replace />;
  }
  if (auth.status === 'bootstrap-pending') {
    return <Navigate to="/bootstrap-pending" replace />;
  }
  if (auth.status === 'unavailable') return <GrowthUnavailablePage />;
  if (auth.status === 'password-change-required') return <Navigate to="/change-password" replace />;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    try {
      await auth.signin({ email, password });
    } finally {
      setSubmitting(false);
    }
  }

  async function onVerify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    try {
      await auth.verifyTwoFactor(otp);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="login-screen">
      <section className="login-panel" aria-labelledby="login-title">
        <div className="login-header">
          <div className="brand-mark" aria-hidden="true">G</div>
          <div>
            <p className="eyebrow">Internal only</p>
            <h1 id="login-title">Growth OS</h1>
          </div>
        </div>

        {auth.status === 'access-denied' ? (
          <p className="form-error" role="alert">This account is not authorized for Growth OS. Sign in with another account.</p>
        ) : null}

        {auth.twoFactorRequired ? (
          <form className="login-form" onSubmit={onVerify}>
            <p className="state-copy">Enter the six-digit code from your authenticator app to finish signing in.</p>
            <label>
              Verification code
              <input value={otp} onChange={(event) => setOtp(event.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" minLength={6} maxLength={6} required />
            </label>
            {auth.error ? <p className="form-error">{auth.error}</p> : null}
            <button className="primary-button" type="submit" disabled={submitting}>
              <LogIn aria-hidden="true" />
              <span>{submitting ? 'Verifying' : 'Verify and sign in'}</span>
            </button>
          </form>
        ) : (
          <form className="login-form" onSubmit={onSubmit}>
            <label>
              Email
              <input value={email} onChange={(event) => setEmail(event.target.value)} type="email" autoComplete="email" required />
            </label>
            <label>
              Password
              <input value={password} onChange={(event) => setPassword(event.target.value)} type="password" autoComplete="current-password" required />
            </label>
            {auth.error ? <p className="form-error">{auth.error}</p> : null}
            {typeof location.state === 'object' && location.state && 'passwordChanged' in location.state && location.state.passwordChanged ? (
              <p className="state-copy" role="status">Password changed. Sign in with your new password.</p>
            ) : null}
            <button className="primary-button" type="submit" disabled={submitting}>
              <LogIn aria-hidden="true" />
              <span>{submitting ? 'Signing in' : 'Sign in'}</span>
            </button>
          </form>
        )}
      </section>
    </main>
  );
}
