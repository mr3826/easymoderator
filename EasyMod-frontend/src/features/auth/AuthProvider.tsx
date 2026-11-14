import { eventBus, EventTypes as EVENTS } from '../../app/lib/events';
import { createContext, useContext, useState, useEffect, type ReactNode } from "react";
import type { SigninRequest, SignupRequest } from "@/api/types";
import { authService, AuthState } from "../../app/lib/auth";
import { httpClient } from "../../shared/lib/http/client";
import { toast } from "sonner";

interface AuthContextProps extends AuthState {
  signin: (credentials: SigninRequest) => Promise<void>;
  signup: (userData: SignupRequest) => Promise<void>;
  switchShop: (shopId: string) => Promise<void>;
  logout: () => Promise<void>;
  verifyTwoFactor: (code: string) => Promise<void>;
}

const AuthContext = createContext<AuthContextProps | undefined>(undefined);

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [state, setState] = useState<AuthState>(authService.getState());

  useEffect(() => {
    // Subscribe to authService state changes.
    // The subscribe() call also delivers the terminal state from ensureInitialized()
    // through the same listener path — the extra .then(setState) below was redundant
    // and caused a guaranteed double render on every mount.
    const unsubscribe = authService.subscribe(setState);

    // Handle 401s emitted by the HTTP client.
    // Rules:
    //  1. If the user just authenticated concurrently (page-load /me race), ignore the
    //     stale event — the interceptor fires this before signin() finishes.
    //  2. If already on /signin, do nothing — no reload, no loop.
    //  3. Otherwise redirect. Do NOT call authService.logout() here: POST /api/auth/logout
    //     requires authentication, so an unauthenticated call returns 401, which re-fires
    //     this event and creates an infinite logout loop. The full-page reload from
    //     window.location.href clears all in-memory state automatically.
    const PUBLIC_PATHS = ['/', '/signin', '/signup', '/pricing', '/privacy-policy', '/terms', '/forgot-password', '/reset-password'];
    const handleUnauthorized = () => {
      if (authService.getState().isAuthenticated) return;
      const path = window.location.pathname;
      if (PUBLIC_PATHS.some(p => path === p || path.startsWith(p + '/'))) return;
      window.location.href = '/signin';
    };
    window.addEventListener('auth:unauthorized', handleUnauthorized);

    // Re-initialize the CSRF token whenever the backend signals that the current
    // token is invalid (e.g., after a server restart or session rotation). Without
    // this handler the user would receive a 403 on the next mutation with no
    // recovery path — they'd have to reload the page manually.
    const handleCsrfInvalid = () => {
      httpClient.initCsrfToken().then(() => {
        toast.info('Session refreshed, please retry.');
      }).catch(() => {
        // CSRF re-init failed — silently ignore; the next mutation will retry
      });
    };
    window.addEventListener('csrf:invalid', handleCsrfInvalid);

    return () => {
      unsubscribe();
      window.removeEventListener('auth:unauthorized', handleUnauthorized);
      window.removeEventListener('csrf:invalid', handleCsrfInvalid);
    };
  }, []);

  const signin = async (credentials: SigninRequest) => {
    await authService.signin(credentials);
  };

  const signup = async (userData: SignupRequest) => {
    await authService.signup(userData);
  };

  const switchShop = async (shopId: string) => {
    await authService.switchShop(shopId);
    eventBus.emit(EVENTS.SHOP_SWITCHED, { shopId });
  };

  const logout = async () => {
    await authService.logout();
  };

  const verifyTwoFactor = async (code: string) => {
    await authService.verifyTwoFactor(code);
  };

  return (
    <AuthContext.Provider value={{ ...state, signin, signup, switchShop, logout, verifyTwoFactor }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
};

/**
 * Auth state for components that may render outside AuthProvider (e.g. the
 * public claim provider on a marketing page or in an isolated unit test).
 * Returns null instead of throwing; callers treat null as unauthenticated.
 */
export const useOptionalAuth = (): AuthContextProps | null => (
  useContext(AuthContext) ?? null
);
