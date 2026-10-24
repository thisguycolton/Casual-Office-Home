import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { downloadUrl, fetchCollabGrant, getCsrf, type CollabGrant, type FileDetails } from '../api.ts';
import { useAuth } from '../auth.tsx';
import { KindIcon } from '../components/icons.tsx';
import { useToast } from '../components/ui.tsx';
import { EditorSession, type SaveState } from './session.ts';
import type { RoomHandle } from './collab/types.ts';
import type { RoomStatus } from './collab/controller.ts';

// The full editors are large (Univer, ProseMirror, ExcelJS); only load the one a file needs.
const DocsRoom = lazy(() => import('./DocsRoom.tsx').then((m) => ({ default: m.DocsRoom })));
const SheetsRoom = lazy(() => import('./SheetsRoom.tsx').then((m) => ({ default: m.SheetsRoom })));

const STATUS: Record<SaveState, string> = {
  loading: 'Opening…', ready: 'Ready', saving: 'Saving…', saved: 'All changes saved', error: 'Couldn’t save — will retry', conflict: 'Not saved — file changed elsewhere', 'failed-to-load': 'Couldn’t open this file',
};

async function toXlsx(snapshot: unknown): Promise<ArrayBuffer> {
  // Loaded on demand: keeps ExcelJS out of the main bundle.
  const { workbookDataToXlsx } = await import('@casualoffice/sheets/xlsx');
  return (await workbookDataToXlsx(snapshot as never)).arrayBuffer();
}

/** Picks live co-editing when the server offers it, otherwise the single-user embedded editor. */
export function EditorFrame({ file }: { file: FileDetails }) {
  const [grant, setGrant] = useState<CollabGrant | null | undefined>(undefined);
  const [err, setErr] = useState('');
  useEffect(() => {
    let live = true;
    fetchCollabGrant(file.id).then((g) => live && setGrant(g)).catch((e) => live && setErr(e.message));
    return () => { live = false; };
  }, [file.id]);
  if (err) return <div className="page"><p className="form-error" role="alert">{err}</p><Link to="/files">Back to My Files</Link></div>;
  if (grant === undefined) return <div className="editor-overlay"><div className="page"><span className="muted">Opening…</span></div></div>;
  if (grant) return <LiveEditor file={file} grant={grant} />;
  return <EmbedEditor file={file} />;
}

const LIVE_STATUS: Record<RoomStatus, string> = {
  connecting: 'Connecting…', waiting: 'Waiting for the document…', seeding: 'Opening…', live: 'Live — changes are shared and saved automatically',
  offline: 'Offline — reconnecting…', conflict: 'Not saved — file changed elsewhere', error: 'Couldn’t open this file',
};

/** Full-screen chrome around a live co-editing room (Docs or Sheets). */
function LiveEditor({ file, grant }: { file: FileDetails; grant: CollabGrant }) {
  const nav = useNavigate();
  const toast = useToast();
  const { user } = useAuth();
  const handle = useRef<RoomHandle | null>(null);
  const [status, setStatus] = useState<RoomStatus>('connecting');
  const [detail, setDetail] = useState('');
  const [leaving, setLeaving] = useState(false);
  const [staticView, setStaticView] = useState(false);
  const viewer = grant.role === 'viewer';
  const backTo = file.path.length ? `/files/${file.path[file.path.length - 1]!.id}` : '/files';
  const onStatus = useCallback((s: RoomStatus, d?: string) => { setStatus(s); setDetail(d ?? ''); }, []);
  const onHandle = useCallback((h: RoomHandle | null) => { handle.current = h; }, []);

  // A viewer can only watch a room somebody has already opened. If nobody has, show the last saved version instead.
  useEffect(() => {
    if (!viewer || status === 'live') return;
    const t = setTimeout(() => setStaticView(true), 6000);
    return () => clearTimeout(t);
  }, [viewer, status]);

  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => { if (status === 'conflict') { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [status]);

  const leave = async (to: string) => {
    setLeaving(true);
    try { await handle.current?.flush(); } finally { nav(to); }
  };
  const copy = async () => {
    try {
      const bytes = await handle.current!.exportCopy();
      const dot = file.name.lastIndexOf('.');
      const name = `${dot > 0 ? file.name.slice(0, dot) : file.name} (conflicted copy)${dot > 0 ? file.name.slice(dot) : ''}`;
      const q = new URLSearchParams({ name }); if (file.parentId) q.set('parentId', file.parentId);
      const r = await fetch(`/api/files?${q}`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/octet-stream', 'x-csrf-token': getCsrf() }, body: bytes });
      if (!r.ok) throw new Error('Could not save a copy');
      toast.push('success', `Your changes were saved as “${(await r.json()).name}”`); nav(backTo);
    } catch (e) { toast.push('error', (e as Error).message); }
  };

  if (staticView) return <EmbedEditor file={file} readOnly note="Nobody is editing this file right now, so you’re seeing the last saved version." />;

  const props = { fileId: file.id, fileName: file.name, grant, userName: user?.displayName ?? 'Someone', userId: user?.id ?? '', onStatus, onHandle };
  return (
    <div className="editor-overlay">
      <header className="editor-bar">
        <Link to={backTo} className="btn" onClick={(e) => { e.preventDefault(); void leave(backTo); }}>← Back</Link>
        <KindIcon kind={file.kind} size={22} />
        <h1 title={file.name}>{file.name}</h1>
        {viewer && <span className="badge">View only</span>}
        <span className={`save-status s-${status}`} role="status" aria-live="polite">{leaving ? 'Saving before closing…' : LIVE_STATUS[status]}</span>
        <a className="btn" href={downloadUrl(file.id)}>Download</a>
      </header>
      {status === 'conflict' && (
        <div className="editor-banner" role="alert">
          <strong>This file was changed somewhere else, so the live session’s edits can no longer be saved over it.</strong>
          <button className="btn" onClick={copy}>Save the live version as a copy</button>
          <button className="btn" onClick={() => location.reload()}>Reload latest</button>
        </div>
      )}
      {status === 'error' && <div className="editor-banner" role="alert"><strong>{detail || 'This file could not be opened.'}</strong> <a className="btn" href={downloadUrl(file.id)}>Download instead</a></div>}
      <div className="editor-live">
        <Suspense fallback={<span className="muted">Loading editor…</span>}>
          {file.editor === 'sheets' ? <SheetsRoom {...props} /> : <DocsRoom {...props} />}
        </Suspense>
      </div>
    </div>
  );
}

/** Single-user editor in a sandboxed iframe. Bytes flow only through the authenticated API. */
function EmbedEditor({ file, readOnly = false, note }: { file: FileDetails; readOnly?: boolean; note?: string }) {
  const nav = useNavigate();
  const toast = useToast();
  const frame = useRef<HTMLIFrameElement>(null);
  const session = useRef<EditorSession | null>(null);
  const [state, setState] = useState<SaveState>('loading');
  const [detail, setDetail] = useState('');
  const [leaving, setLeaving] = useState(false);
  const app = file.editor === 'sheets' ? 'sheet' : 'docs';
  const backTo = file.path.length ? `/files/${file.path[file.path.length - 1]!.id}` : '/files';
  const src = useMemo(() => `/editors/${file.editor}/embed.html?app=${app}&docId=${encodeURIComponent(file.id)}&viewMode=${readOnly ? 'preview' : 'editor'}`, [file.editor, file.id, app, readOnly]);

  useEffect(() => {
    const s = new EditorSession({
      app, fileId: file.id, fileName: file.name, parentId: file.parentId, frame: frame.current!,
      csrf: getCsrf, toXlsx: app === 'sheet' ? toXlsx : undefined,
      onState: (st, d) => { setState(st); setDetail(d ?? ''); },
    });
    session.current = s;
    return () => { s.dispose(); session.current = null; };
  }, [app, file.id, file.name, file.parentId]);

  // Warn if the tab is closed while a save is in flight or has failed.
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => { if (['saving', 'error', 'conflict'].includes(state)) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [state]);

  const leave = async (to: string) => {
    setLeaving(true);
    try { await session.current?.flush(); } finally { nav(to); }
  };
  const copy = async () => {
    try { const n = await session.current!.saveAsCopy(); toast.push('success', `Your changes were saved as “${n}”`); nav(backTo); }
    catch (e) { toast.push('error', (e as Error).message); }
  };

  return (
    <div className="editor-overlay">
      <header className="editor-bar">
        <Link to={backTo} className="btn" onClick={(e) => { e.preventDefault(); void leave(backTo); }}>← Back</Link>
        <KindIcon kind={file.kind} size={22} />
        <h1 title={file.name}>{file.name}</h1>
        <span className={`save-status s-${state}`} role="status" aria-live="polite">{leaving ? 'Saving before closing…' : STATUS[state]}</span>
        <a className="btn" href={downloadUrl(file.id)}>Download</a>
      </header>
      {note && <div className="editor-banner" role="status"><strong>{note}</strong></div>}
      {state === 'conflict' && (
        <div className="editor-banner" role="alert">
          <strong>This file was changed somewhere else, so your latest edits were not saved over it.</strong>
          <button className="btn" onClick={copy}>Save my version as a copy</button>
          <button className="btn" onClick={() => location.reload()}>Reload latest</button>
        </div>
      )}
      {state === 'failed-to-load' && <div className="editor-banner" role="alert"><strong>{detail || 'This file could not be opened.'}</strong> <a className="btn" href={downloadUrl(file.id)}>Download instead</a></div>}
      <iframe ref={frame} className="editor-frame" src={src} title={`${file.name} — editor`} allow="clipboard-read; clipboard-write" />
    </div>
  );
}
