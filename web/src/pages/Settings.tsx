import { useEffect, useState, type FormEvent } from 'react';
import { api, type User } from '../api.ts';
import { useAuth } from '../auth.tsx';
import { formatSize } from '../format.ts';
import { useToast } from '../components/ui.tsx';

export type Theme = 'system' | 'light' | 'dark';
export function applyTheme(t: Theme) {
  if (t === 'system') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', t);
}
export const savedTheme = (): Theme => { try { const v = localStorage.getItem('theme'); return v === 'light' || v === 'dark' ? v : 'system'; } catch { return 'system'; } };

export function SettingsPage() {
  const toast = useToast();
  const [theme, setTheme] = useState<Theme>(savedTheme);
  const [usage, setUsage] = useState<{ used: number; quota: number } | null>(null);
  const [cur, setCur] = useState(''); const [next, setNext] = useState(''); const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  useEffect(() => { api('GET', '/api/storage').then(setUsage).catch(() => {}); }, []);
  const pick = (t: Theme) => { setTheme(t); applyTheme(t); try { t === 'system' ? localStorage.removeItem('theme') : localStorage.setItem('theme', t); } catch { /* ignore */ } };
  const change = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setErr('');
    try { await api('POST', '/api/auth/change-password', { currentPassword: cur, newPassword: next }); setCur(''); setNext(''); toast.push('success', 'Password changed. Other devices were signed out.'); }
    catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="page narrow">
      <h1>Settings</h1>
      <section className="panel"><h2>Appearance</h2>
        <div className="seg seg-text" role="radiogroup" aria-label="Theme">
          {(['system', 'light', 'dark'] as Theme[]).map((t) => <button key={t} role="radio" aria-checked={theme === t} className={theme === t ? 'on' : ''} onClick={() => pick(t)}>{t[0]!.toUpperCase() + t.slice(1)}</button>)}
        </div>
      </section>
      <section className="panel"><h2>Storage</h2>
        {usage ? <p>{formatSize(usage.used)} used{usage.quota > 0 ? ` of ${formatSize(usage.quota)}` : ' · no quota set'}</p> : <p className="muted">Loading…</p>}
        {usage && usage.quota > 0 && <progress max={usage.quota} value={usage.used} aria-label="Storage used" />}
        <p className="muted small">Includes previous versions kept so a bad save can be undone.</p>
      </section>
      <section className="panel"><h2>Change password</h2>
        <form onSubmit={change}>
          <label className="field"><span>Current password</span><input type="password" value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" required /></label>
          <label className="field"><span>New password</span><input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" required minLength={12} /><small className="muted">At least 12 characters.</small></label>
          {err && <p className="form-error" role="alert">{err}</p>}
          <button className="btn btn-primary" disabled={busy}>Change password</button>
        </form>
      </section>
    </div>
  );
}

export function ProfilePage() {
  const { user, setUser, logout } = useAuth();
  const toast = useToast();
  const [name, setName] = useState(user?.displayName ?? '');
  const save = async (e: FormEvent) => {
    e.preventDefault();
    try { const r = await api<{ user: User }>('PATCH', '/api/auth/profile', { displayName: name }); setUser(r.user); toast.push('success', 'Profile updated'); }
    catch (x) { toast.push('error', (x as Error).message); }
  };
  return (
    <div className="page narrow">
      <h1>User profile</h1>
      <section className="panel">
        <form onSubmit={save}>
          <label className="field"><span>Display name</span><input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required /></label>
          <label className="field"><span>Email</span><input value={user?.email ?? ''} disabled /></label>
          <label className="field"><span>Role</span><input value={user?.role === 'admin' ? 'Administrator' : 'User'} disabled /></label>
          <button className="btn btn-primary">Save</button>
        </form>
      </section>
      <section className="panel"><h2>Session</h2><button className="btn" onClick={() => logout()}>Sign out</button></section>
    </div>
  );
}
