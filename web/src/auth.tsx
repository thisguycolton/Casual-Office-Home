import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, setCsrf, setUnauthenticatedHandler, type User } from './api.ts';

interface AuthState { user: User | null; loading: boolean; login(email: string, password: string): Promise<void>; register(email: string, password: string, displayName: string): Promise<void>; logout(): Promise<void>; setUser(u: User): void }
const Ctx = createContext<AuthState | null>(null);
export const useAuth = () => { const c = useContext(Ctx); if (!c) throw new Error('AuthProvider missing'); return c; };

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setUnauthenticatedHandler(() => { setCsrf(''); setUser(null); });
    api<{ user: User; csrfToken: string }>('GET', '/api/auth/me')
      .then((r) => { setCsrf(r.csrfToken); setUser(r.user); })
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const r = await api<{ user: User; csrfToken: string }>('POST', '/api/auth/login', { email, password });
    setCsrf(r.csrfToken); setUser(r.user);
  }, []);
  const register = useCallback(async (email: string, password: string, displayName: string) => {
    const r = await api<{ user: User; csrfToken: string }>('POST', '/api/auth/register', { email, password, displayName });
    setCsrf(r.csrfToken); setUser(r.user);
  }, []);
  const logout = useCallback(async () => {
    await api('POST', '/api/auth/logout').catch(() => {});
    setCsrf(''); setUser(null);
  }, []);

  return <Ctx.Provider value={{ user, loading, login, register, logout, setUser }}>{children}</Ctx.Provider>;
}
