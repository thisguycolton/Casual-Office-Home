import { useEffect, useState, type FormEvent } from 'react';
import { api, type FileDetails, type FileItem, type Listing } from '../api.ts';
import { formatDate, formatSize, KIND_LABEL } from '../format.ts';
import { IconChevron, IconFolder } from './icons.tsx';
import { Modal, Spinner, useToast } from './ui.tsx';

export function NameDialog({ title, label, initial, action, onSubmit, onClose }: {
  title: string; label: string; initial: string; action: string; onSubmit: (name: string) => Promise<void>; onClose: () => void;
}) {
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { /* select base name only */
    const el = document.getElementById('name-input') as HTMLInputElement | null;
    if (el) { const dot = initial.lastIndexOf('.'); el.setSelectionRange(0, dot > 0 ? dot : initial.length); }
  }, [initial]);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); if (busy) return; setBusy(true); setErr('');
    try { await onSubmit(name); onClose(); } catch (x) { setErr((x as Error).message); setBusy(false); }
  };
  return (
    <Modal title={title} onClose={onClose}>
      <form onSubmit={submit}>
        <label className="field"><span>{label}</span>
          <input id="name-input" value={name} onChange={(e) => setName(e.target.value)} maxLength={255} autoComplete="off" required />
        </label>
        {err && <p className="form-error" role="alert">{err}</p>}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy || !name.trim()}>{action}</button>
        </div>
      </form>
    </Modal>
  );
}

export function ConfirmDialog({ title, body, action, danger, onConfirm, onClose }: {
  title: string; body: string; action: string; danger?: boolean; onConfirm: () => Promise<void>; onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  return (
    <Modal title={title} onClose={onClose}>
      <p>{body}</p>
      {err && <p className="form-error" role="alert">{err}</p>}
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} disabled={busy}
          onClick={async () => { setBusy(true); try { await onConfirm(); onClose(); } catch (x) { setErr((x as Error).message); setBusy(false); } }}>{action}</button>
      </div>
    </Modal>
  );
}

/** Folder picker used for "Move to…". Drills down one level at a time. */
export function MoveDialog({ items, onMoved, onClose }: { items: FileItem[]; onMoved: () => void; onClose: () => void }) {
  const [folderId, setFolderId] = useState<string | null>(null);
  const [listing, setListing] = useState<Listing | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const exclude = new Set(items.map((i) => i.id));
  useEffect(() => {
    let live = true; setListing(null);
    api<Listing>('GET', `/api/files?parentId=${folderId ?? 'root'}&sort=name`).then((l) => live && setListing(l)).catch((e) => live && setErr(e.message));
    return () => { live = false; };
  }, [folderId]);
  const move = async () => {
    setBusy(true); setErr('');
    try { for (const it of items) await api('PATCH', `/api/files/${it.id}`, { parentId: folderId ?? 'root' }); onMoved(); onClose(); }
    catch (x) { setErr((x as Error).message); setBusy(false); }
  };
  const folders = listing?.items.filter((i) => i.kind === 'folder' && !exclude.has(i.id)) ?? [];
  return (
    <Modal title={items.length === 1 ? `Move “${items[0]!.name}”` : `Move ${items.length} items`} onClose={onClose}>
      <nav className="crumbs" aria-label="Destination">
        <button className="link" onClick={() => setFolderId(null)}>My Files</button>
        {listing?.path?.map((p) => <span key={p.id}><IconChevron size={14} /><button className="link" onClick={() => setFolderId(p.id)}>{p.name}</button></span>)}
      </nav>
      <div className="picker" role="listbox" aria-label="Folders">
        {!listing && !err && <Spinner />}
        {listing && folders.length === 0 && <p className="muted">No subfolders here.</p>}
        {folders.map((f) => <button key={f.id} role="option" aria-selected="false" className="picker-row" onClick={() => setFolderId(f.id)}><IconFolder size={18} /> {f.name}<IconChevron size={14} /></button>)}
      </div>
      {err && <p className="form-error" role="alert">{err}</p>}
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={move} disabled={busy || !listing}>Move here</button>
      </div>
    </Modal>
  );
}

export function DetailsPanel({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const [d, setD] = useState<FileDetails | null>(null);
  const [err, setErr] = useState('');
  const toast = useToast();
  const load = () => api<FileDetails>('GET', `/api/files/${id}`).then(setD).catch((e) => setErr(e.message));
  useEffect(() => { setD(null); setErr(''); load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [id]);
  const restore = async (v: number) => {
    try { await api('POST', `/api/files/${id}/versions/${v}/restore`); toast.push('success', `Restored version ${v}`); onChanged(); load(); }
    catch (e) { toast.push('error', (e as Error).message); }
  };
  return (
    <aside className="details" aria-label="Details">
      <header><h2>Details</h2><button className="icon-btn" aria-label="Close details" onClick={onClose}>✕</button></header>
      {err && <p className="form-error">{err}</p>}
      {!d && !err && <Spinner />}
      {d && (
        <dl>
          <dt>Name</dt><dd>{d.name}</dd>
          <dt>Type</dt><dd>{KIND_LABEL[d.kind]}{d.kind !== 'folder' && <span className="muted"> · {d.mime}</span>}</dd>
          {d.kind !== 'folder' && <><dt>Size</dt><dd>{formatSize(d.size)}</dd></>}
          <dt>Location</dt><dd>{['My Files', ...d.path.map((p) => p.name)].join(' / ')}</dd>
          <dt>Modified</dt><dd>{new Date(d.updatedAt).toLocaleString()}</dd>
          <dt>Created</dt><dd>{new Date(d.createdAt).toLocaleString()}</dd>
          {d.lastOpenedAt && <><dt>Last opened</dt><dd>{new Date(d.lastOpenedAt).toLocaleString()}</dd></>}
          {d.kind !== 'folder' && <><dt>Version</dt><dd>{d.version}</dd></>}
          {d.sha256 && <><dt>SHA-256</dt><dd className="mono">{d.sha256}</dd></>}
          {d.versions.length > 0 && (<>
            <dt>Previous versions</dt>
            <dd><ul className="versions">{d.versions.map((v) => (
              <li key={v.version}><span>v{v.version} · {formatDate(v.createdAt)} · {formatSize(v.size)}</span> <button className="link" onClick={() => restore(v.version)}>Restore</button></li>
            ))}</ul></dd>
          </>)}
        </dl>
      )}
    </aside>
  );
}
