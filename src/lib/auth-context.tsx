"use client";
/**
 * Session state for the portal. Better Auth issues an HTTP-only cookie from the
 * gateway; every call is credentialed. Roles come from the server-side session
 * (/api/me), never from the client — the portal only renders what the session
 * actually holds (permission-tier badging + role-aware nav derive from this).
 */
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, ApiClientError } from "./api";
import type { Me } from "./types";

interface AuthValue {
  me: Me | null;
  loading: boolean;
  refresh: () => Promise<Me | null>;
  signIn: (email: string, password: string) => Promise<{ needs2FA: boolean }>;
  signUp: (name: string, email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthValue>({
  me: null,
  loading: true,
  refresh: async () => null,
  signIn: async () => ({ needs2FA: false }),
  signUp: async () => {},
  signOut: async () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async (): Promise<Me | null> => {
    try {
      const result = await api<Me>("/api/me");
      setMe(result);
      return result;
    } catch (e) {
      if (e instanceof ApiClientError && e.status === 401) setMe(null);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const signIn = useCallback(
    async (email: string, password: string) => {
      const res = await api<{ twoFactorRedirect?: boolean }>("/api/auth/sign-in/email", {
        body: { email, password },
      });
      if (res?.twoFactorRedirect) return { needs2FA: true };
      await refresh();
      return { needs2FA: false };
    },
    [refresh],
  );

  const signUp = useCallback(
    async (name: string, email: string, password: string) => {
      await api("/api/auth/sign-up/email", { body: { name, email, password } });
      await refresh();
    },
    [refresh],
  );

  const signOut = useCallback(async () => {
    await api("/api/auth/sign-out", { method: "POST" });
    setMe(null);
  }, []);

  return (
    <AuthContext.Provider value={{ me, loading, refresh, signIn, signUp, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthValue {
  return useContext(AuthContext);
}

/** True when the session holds the given permission-tier role. */
export function hasRole(me: Me | null, role: string): boolean {
  return !!me && me.roles.includes(role as Me["roles"][number]);
}
