import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api.ts';
import { useAuth } from '../auth.tsx';

export function LoginPage() {
  const { login, register } = useAuth();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [allowReg, setAllowReg] = useState(false);
  const [email, setEmail] = useState(''); const [password, setPassword] = useState(''); const [name, setName] = useState('');
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => { api<{ allowRegistration: boolean }>('GET', '/api/auth/config').then((c) => setAllowReg(c.allowRegistration)).catch(() => {}); }, []);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setErr('');
    try { mode === 'login' ? await login(email, password) : await register(email, password, name); }
    catch (x) { setErr((x as Error).message); setBusy(false); }
  };
  return (
    <div className="auth-page">
      <form className="auth-card" onSubmit={submit}>
        <div className="brand-big"><span className="logo" aria-hidden="true" /> Casual Office</div>
        <h1>{mode === 'login' ? 'Sign in' : 'Create account'}</h1>
        {mode === 'register' && <label className="field"><span>Name</span><input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" maxLength={80} /></label>}
        <label className="field"><span>Email</span><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required autoFocus /></label>
        <label className="field"><span>Password</span><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required minLength={mode === 'register' ? 12 : undefined} />
          {mode === 'register' && <small className="muted">At least 12 characters.</small>}</label>
        {err && <p className="form-error" role="alert">{err}</p>}
        <button className="btn btn-primary wide" disabled={busy}>{mode === 'login' ? 'Sign in' : 'Create account'}</button>
        {allowReg && <p className="muted center">{mode === 'login' ? <>No account? <button type="button" className="link" onClick={() => setMode('register')}>Create one</button></> : <>Have an account? <button type="button" className="link" onClick={() => setMode('login')}>Sign in</button></>}</p>}
        <p className="muted center small">Forgot your password? Ask an administrator for a reset link.</p>
      </form>
    </div>
  );
}

export function ResetPage() {
  const [params] = useSearchParams(); const nav = useNavigate();
  const [token, setToken] = useState(params.get('token') ?? ''); const [pw, setPw] = useState(''); const [err, setErr] = useState(''); const [done, setDone] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setErr('');
    try { await api('POST', '/api/auth/reset', { token: token.trim(), password: pw }); setDone(true); setTimeout(() => nav('/'), 1500); } catch (x) { setErr((x as Error).message); }
  };
  return (
    <div className="auth-page">
      <form className="auth-card" onSubmit={submit}>
        <div className="brand-big"><span className="logo" aria-hidden="true" /> Casual Office</div>
        <h1>Reset password</h1>
        {done ? <p role="status">Password updated. Redirecting to sign in…</p> : <>
          <label className="field"><span>Reset token</span><input value={token} onChange={(e) => setToken(e.target.value)} required autoComplete="off" /></label>
          <label className="field"><span>New password</span><input type="password" value={pw} onChange={(e) => setPw(e.target.value)} required minLength={12} autoComplete="new-password" /><small className="muted">At least 12 characters.</small></label>
          {err && <p className="form-error" role="alert">{err}</p>}
          <button className="btn btn-primary wide">Set new password</button>
          <p className="center"><Link to="/">Back to sign in</Link></p>
        </>}
      </form>
    </div>
  );
}
