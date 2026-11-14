import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ApiError, growthApi, type GrowthSession, type SigninPayload } from '@/api/client';

type AuthStatus =
  | 'loading'
  | 'authenticated'
  | 'unauthenticated'
  | 'two-factor'
  | 'password-change-required'
  | 'bootstrap-pending'
  | 'access-denied'
  | 'session-expired'
  | 'unavailable'
  | 'error';

const PASSWORD_CHANGE_REQUIRED_CODE = 'AUTH_PASSWORD_CHANGE_REQUIRED';
const TEMPORARY_PASSWORD_EXPIRED_CODE = 'AUTH_TEMPORARY_PASSWORD_EXPIRED';
const BOOTSTRAP_PENDING_CODE = 'GROWTH_OS_BOOTSTRAP_PENDING';
const BOOTSTRAP_PASSWORD_CHANGE_REQUIRED_CODE = 'GROWTH_OS_BOOTSTRAP_PASSWORD_CHANGE_REQUIRED';

interface GrowthAuthState {
  status: AuthStatus;
  session: GrowthSession | null;
  error: string | null;
  twoFactorRequired: boolean;
  temporaryPasswordExpiresAt: string | null;
  refreshSession: () => Promise<void>;
  signin: (payload: SigninPayload) => Promise<void>;
  verifyTwoFactor: (token: string) => Promise<void>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  logout: () => Promise<void>;
  reportApiError: (error: unknown) => boolean;
}

const GrowthAuthContext = createContext<GrowthAuthState | undefined>(undefined);

export function GrowthAuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [session, setSession] = useState<GrowthSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tempToken, setTempToken] = useState<string | null>(null);
  const [temporaryPasswordExpiresAt, setTemporaryPasswordExpiresAt] = useState<string | null>(null);

  const resolveForbidden = useCallback((err: ApiError) => {
    if (err.code === BOOTSTRAP_PENDING_CODE) return 'bootstrap-pending' as const;
    if (err.code === BOOTSTRAP_PASSWORD_CHANGE_REQUIRED_CODE) {
      return 'password-change-required' as const;
    }
    if (err.code === PASSWORD_CHANGE_REQUIRED_CODE) return 'password-change-required' as const;
    return 'access-denied' as const;
  }, []);

  const refreshSession = useCallback(async () => {
    const hadSession = Boolean(session);
    setStatus('loading');
    setError(null);

    try {
      let nextSession: GrowthSession;
      try {
        nextSession = await growthApi.getSession();
      } catch (err) {
        // A valid refresh cookie can recover an expired access cookie. Retry
        // exactly once so a stale session never becomes a frontend-only
        // authorization decision.
        if (!(err instanceof ApiError) || err.status !== 401) throw err;
        await growthApi.refresh();
        nextSession = await growthApi.getSession();
      }
      setSession(nextSession);
      setStatus('authenticated');
    } catch (err) {
      setSession(null);
      setTempToken(null);
      if (err instanceof ApiError && err.status === 401) {
        setTemporaryPasswordExpiresAt(null);
        setStatus(hadSession ? 'session-expired' : 'unauthenticated');
        return;
      }
      if (err instanceof ApiError && err.status === 403) {
        setStatus(resolveForbidden(err));
        return;
      }
      if (err instanceof ApiError && err.status === 503) {
        setStatus('unavailable');
        setError(err.message);
        return;
      }
      setError(err instanceof Error ? err.message : 'Unable to load Growth OS.');
      setStatus('error');
    }
  }, [session, resolveForbidden]);

  const reportApiError = useCallback((requestError: unknown) => {
    if (!(requestError instanceof ApiError)) return false;
    if (requestError.code === 'CSRF_INVALID') return false;
    if (requestError.status === 401) {
      void refreshSession();
      return true;
    }
    if (requestError.status === 403) {
      setStatus(resolveForbidden(requestError));
      return true;
    }
    if (requestError.status === 503) {
      setError(requestError.message);
      setStatus('unavailable');
      return true;
    }
    return false;
  }, [refreshSession, resolveForbidden]);

  // Session bootstrap is intentionally mount-only; refreshSession changes
  // after the session is established and must not create a refresh loop.
  /* eslint-disable react-hooks/exhaustive-deps */
  useEffect(() => {
    void refreshSession();
  }, []);
  /* eslint-enable react-hooks/exhaustive-deps */

  const signin = useCallback(async (payload: SigninPayload) => {
    setStatus('loading');
    setError(null);
    try {
      const signinResult = await growthApi.signin(payload);
      if (signinResult.requires2fa && signinResult.tempToken) {
        setTempToken(signinResult.tempToken);
        setTemporaryPasswordExpiresAt(signinResult.temporaryPasswordExpiresAt ?? null);
        setStatus('two-factor');
        return;
      }
      if (signinResult.requiresPasswordChange) {
        setTempToken(null);
        setTemporaryPasswordExpiresAt(signinResult.temporaryPasswordExpiresAt ?? null);
        setStatus('password-change-required');
        return;
      }
      setTempToken(null);
      setTemporaryPasswordExpiresAt(null);
      const nextSession = await growthApi.getSession();
      setSession(nextSession);
      setStatus('authenticated');
    } catch (err) {
      setSession(null);
      setTempToken(null);
      if (err instanceof ApiError && err.status === 403) {
        setStatus(resolveForbidden(err));
        return;
      }
      if (err instanceof ApiError && err.status === 503) {
        setStatus('unavailable');
        setError(err.message);
        return;
      }
      setStatus('unauthenticated');
      setError(err instanceof Error ? err.message : 'Sign in failed.');
      throw err;
    }
  }, [resolveForbidden]);

  const verifyTwoFactor = useCallback(async (token: string) => {
    if (!tempToken) {
      setStatus('unauthenticated');
      setError('Your verification session expired. Sign in again.');
      return;
    }
    setStatus('loading');
    setError(null);
    try {
      const verifyResult = await growthApi.verifyTwoFactor(tempToken, token);
      setTempToken(null);
      if (verifyResult.requiresPasswordChange) {
        setTemporaryPasswordExpiresAt(verifyResult.temporaryPasswordExpiresAt ?? null);
        setSession(null);
        setStatus('password-change-required');
        return;
      }
      setTemporaryPasswordExpiresAt(null);
      const nextSession = await growthApi.getSession();
      setSession(nextSession);
      setStatus('authenticated');
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setStatus(resolveForbidden(err));
        return;
      }
      setStatus('two-factor');
      setError(err instanceof Error ? err.message : 'Verification failed.');
      throw err;
    }
  }, [tempToken, resolveForbidden]);

  const changePassword = useCallback(async (currentPassword: string, newPassword: string) => {
    setStatus('loading');
    setError(null);
    try {
      await growthApi.changePassword(currentPassword, newPassword);
      setSession(null);
      setTempToken(null);
      setTemporaryPasswordExpiresAt(null);
      setStatus('unauthenticated');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Password change failed.');
      setStatus(err instanceof ApiError && err.code === TEMPORARY_PASSWORD_EXPIRED_CODE
        ? 'unauthenticated'
        : 'password-change-required');
      throw err;
    }
  }, []);

  const logout = useCallback(async () => {
    setError(null);
    try {
      window.sessionStorage.removeItem('growth-os.capture-payload.v1');
    } catch {
      // Capture cleanup is best-effort when browser storage is unavailable.
    }
    try {
      await growthApi.logout();
      setSession(null);
      setTempToken(null);
      setStatus('unauthenticated');
    } catch (err) {
      // Keep the authenticated state when server-side revocation fails. The
      // user sees the error and can retry instead of believing the cookie was
      // revoked when it was not.
      setError(err instanceof Error ? err.message : 'Unable to complete sign out. Please retry.');
      setStatus('authenticated');
    }
  }, []);

  const value = useMemo(() => ({
    status,
    session,
    error,
    twoFactorRequired: status === 'two-factor',
    temporaryPasswordExpiresAt,
    refreshSession,
    signin,
    verifyTwoFactor,
    changePassword,
    logout,
    reportApiError,
  }), [status, session, error, temporaryPasswordExpiresAt, refreshSession, signin, verifyTwoFactor, changePassword, logout, reportApiError]);

  return (
    <GrowthAuthContext.Provider value={value}>
      {children}
    </GrowthAuthContext.Provider>
  );
}

export function useGrowthAuth() {
  const context = useContext(GrowthAuthContext);
  if (!context) {
    throw new Error('useGrowthAuth must be used within GrowthAuthProvider');
  }
  return context;
}
