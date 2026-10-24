import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '../api.ts';
import { useAuth } from '../auth.tsx';
import { ConfirmDialog } from '../components/Dialogs.tsx';
import { Modal, Spinner, useToast } from '../components/ui.tsx';
import { formatSize } from '../format.ts';

interface AdminUser { id: string; email: string; displayName: string; role: 'user' | 'admin'; disabled: boolean; storageUsed: number; fileCount: number }

export function AdminPage() {
  const { user: me } = useAuth();
  const toast = useToast();
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [err, setErr] = useState('');
  const [creating, setCreating] = useState(false);
  const [del, setDel] = useState<AdminUser | null>(null);
  const [token, setToken] = useState<{ email: string; url: string; expiresAt: number } | null>(null);
  const load = useCallback(() => { api<{ users: AdminUser[] }>('GET', '/api/admin/users').then((r) => setUsers(r.users)).catch((e) => setErr(e.message)); }, []);
  useEffect(() => { load(); }, [load]);
  const act = async (fn: () => Promise<unknown>, ok?: string) => { try { await fn(); if (ok) toast.push('success', ok); load(); } catch (e) { toast.push('error', (e as Error).message); } };

  if (err) return <div className="page"><p className="form-error" role="alert">{err}</p></div>;
  if (!users) return <div className="page"><Spinner /></div>;
  return (
    <div className="page">
      <div className="page-head"><h1>Administration</h1><button className="btn btn-primary" onClick={() => setCreating(true)}>Add user</button></div>
      <p className="muted">Administrators manage accounts but cannot read other users’ files.</p>
      <div className="table-scroll"><table className="data">
        <thead><tr><th>User</th><th>Role</th><th>Files</th><th>Storage</th><th>Status</th><th><span className="sr-only">Actions</span></th></tr></thead>
        <tbody>{users.map((u) => (
          <tr key={u.id}>
            <td><strong>{u.displayName}</strong><br /><span className="muted">{u.email}</span></td>
            <td>{u.role === 'admin' ? 'Administrator' : 'User'}</td><td>{u.fileCount}</td><td>{formatSize(u.storageUsed)}</td>
            <td>{u.disabled ? <span className="badge off">Disabled</span> : <span className="badge on">Active</span>}</td>
            <td className="actions">
              <button className="btn btn-sm" onClick={() => act(() => api('PATCH', `/api/admin/users/${u.id}`, { disabled: !u.disabled }), u.disabled ? 'User enabled' : 'User disabled')} disabled={u.id === me?.id}>{u.disabled ? 'Enable' : 'Disable'}</button>
              <button className="btn btn-sm" onClick={() => act(() => api('PATCH', `/api/admin/users/${u.id}`, { role: u.role === 'admin' ? 'user' : 'admin' }), 'Role updated')} disabled={u.id === me?.id}>{u.role === 'admin' ? 'Make user' : 'Make admin'}</button>
              <button className="btn btn-sm" onClick={async () => { try { const r = await api<{ token: string; expiresAt: number }>('POST', `/api/admin/users/${u.id}/reset-token`); setToken({ email: u.email, url: `${location.origin}/reset?token=${r.token}`, expiresAt: r.expiresAt }); } catch (e) { toast.push('error', (e as Error).message); } }}>Reset link</button>
              <button className="btn btn-sm btn-danger" onClick={() => setDel(u)} disabled={u.id === me?.id}>Delete</button>
            </td>
          </tr>))}
        </tbody></table></div>
      {creating && <CreateUser onClose={() => setCreating(false)} onDone={() => { setCreating(false); load(); toast.push('success', 'User created'); }} />}
      {del && <ConfirmDialog title="Delete user?" danger action="Delete user and files" body={`${del.email} and all ${del.fileCount} of their files will be permanently deleted.`} onClose={() => setDel(null)} onConfirm={async () => { await api('DELETE', `/api/admin/users/${del.id}`); load(); }} />}
      {token && <Modal title={`Reset link for ${token.email}`} onClose={() => setToken(null)}>
        <p>Send this link to the user. It works once and expires at {new Date(token.expiresAt).toLocaleTimeString()}. It will not be shown again.</p>
        <input readOnly value={token.url} onFocus={(e) => e.currentTarget.select()} aria-label="Reset link" />
        <div className="modal-actions"><button className="btn" onClick={() => navigator.clipboard?.writeText(token.url).then(() => toast.push('success', 'Copied'))}>Copy</button><button className="btn btn-primary" onClick={() => setToken(null)}>Done</button></div>
      </Modal>}
    </div>
  );
}

function CreateUser({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [email, setEmail] = useState(''); const [name, setName] = useState(''); const [pw, setPw] = useState(''); const [role, setRole] = useState('user'); const [err, setErr] = useState('');
  const submit = async (e: FormEvent) => { e.preventDefault(); setErr(''); try { await api('POST', '/api/admin/users', { email, displayName: name || undefined, password: pw, role }); onDone(); } catch (x) { setErr((x as Error).message); } };
  return (
    <Modal title="Add user" onClose={onClose}>
      <form onSubmit={submit}>
        <label className="field"><span>Email</span><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
        <label className="field"><span>Name</span><input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} /></label>
        <label className="field"><span>Initial password</span><input type="password" value={pw} onChange={(e) => setPw(e.target.value)} required minLength={12} autoComplete="new-password" /></label>
        <label className="field"><span>Role</span><select value={role} onChange={(e) => setRole(e.target.value)}><option value="user">User</option><option value="admin">Administrator</option></select></label>
        {err && <p className="form-error" role="alert">{err}</p>}
        <div className="modal-actions"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary">Create</button></div>
      </form>
    </Modal>
  );
}
