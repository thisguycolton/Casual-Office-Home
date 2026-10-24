import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { ApiError, uploadFile } from './api.ts';
import { formatSize } from './format.ts';
import { IconClose, IconCheck } from './components/icons.tsx';

interface Job { id: number; name: string; size: number; loaded: number; state: 'queued' | 'uploading' | 'done' | 'error' | 'cancelled'; error?: string; parentId: string | null; file: File; abort?: () => void }
interface Ctx { enqueue(files: File[], parentId: string | null): void; changeTick: number; bump(): void }
const UploadCtx = createContext<Ctx | null>(null);
export const useUploads = () => { const c = useContext(UploadCtx); if (!c) throw new Error('UploadProvider missing'); return c; };

const CONCURRENCY = 3;

export function UploadProvider({ children }: { children: ReactNode }) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [tick, setTick] = useState(0);
  const [collapsed, setCollapsed] = useState(false);
  const running = useRef(0);
  const nextId = useRef(1);
  const queue = useRef<number[]>([]);
  const jobsRef = useRef<Map<number, Job>>(new Map());

  const patch = useCallback((id: number, p: Partial<Job>) => {
    const j = jobsRef.current.get(id); if (!j) return;
    Object.assign(j, p);
    setJobs([...jobsRef.current.values()]);
  }, []);
  const bump = useCallback(() => setTick((t) => t + 1), []);

  const pump = useCallback(() => {
    while (running.current < CONCURRENCY && queue.current.length) {
      const id = queue.current.shift()!;
      const j = jobsRef.current.get(id);
      if (!j || j.state !== 'queued') continue;
      running.current++;
      const { promise, abort } = uploadFile(j.file, j.parentId, (loaded) => patch(id, { loaded }));
      patch(id, { state: 'uploading', abort });
      promise
        .then(() => { patch(id, { state: 'done', loaded: j.size }); bump(); })
        .catch((e: unknown) => {
          const err = e as ApiError;
          patch(id, err.code === 'aborted' ? { state: 'cancelled' } : { state: 'error', error: err.message });
        })
        .finally(() => { running.current--; pump(); });
    }
  }, [bump, patch]);

  const enqueue = useCallback((files: File[], parentId: string | null) => {
    for (const file of files) {
      const id = nextId.current++;
      jobsRef.current.set(id, { id, name: file.name, size: file.size, loaded: 0, state: 'queued', parentId, file });
      queue.current.push(id);
    }
    setJobs([...jobsRef.current.values()]);
    setCollapsed(false);
    pump();
  }, [pump]);

  const dismiss = () => {
    for (const [id, j] of jobsRef.current) if (j.state === 'done' || j.state === 'error' || j.state === 'cancelled') jobsRef.current.delete(id);
    setJobs([...jobsRef.current.values()]);
  };

  const value = useMemo(() => ({ enqueue, changeTick: tick, bump }), [enqueue, tick, bump]);
  const active = jobs.filter((j) => j.state === 'queued' || j.state === 'uploading').length;
  const failed = jobs.filter((j) => j.state === 'error').length;

  return (
    <UploadCtx.Provider value={value}>
      {children}
      {jobs.length > 0 && (
        <section className="uploads" aria-label="Uploads">
          <header>
            <button className="link" onClick={() => setCollapsed(!collapsed)} aria-expanded={!collapsed}>
              {active ? `Uploading ${active} file${active > 1 ? 's' : ''}…` : failed ? `${failed} upload${failed > 1 ? 's' : ''} failed` : 'Uploads complete'}
            </button>
            <button className="icon-btn" aria-label="Dismiss finished uploads" onClick={dismiss} disabled={active > 0}><IconClose size={16} /></button>
          </header>
          {!collapsed && (
            <ul>
              {jobs.map((j) => (
                <li key={j.id} className={`up-${j.state}`}>
                  <div className="up-name" title={j.name}>{j.name}</div>
                  <div className="up-meta">
                    {j.state === 'uploading' && <><progress max={j.size || 1} value={j.loaded} aria-label={`Uploading ${j.name}`} /><span>{formatSize(j.loaded)} / {formatSize(j.size)}</span></>}
                    {j.state === 'queued' && <span>Waiting…</span>}
                    {j.state === 'done' && <span className="ok"><IconCheck size={14} /> Done</span>}
                    {j.state === 'cancelled' && <span>Cancelled</span>}
                    {j.state === 'error' && <span className="err" role="alert">{j.error}</span>}
                  </div>
                  {(j.state === 'uploading' || j.state === 'queued') && (
                    <button className="icon-btn" aria-label={`Cancel ${j.name}`} onClick={() => { if (j.state === 'queued') patch(j.id, { state: 'cancelled' }); else j.abort?.(); }}><IconClose size={14} /></button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </UploadCtx.Provider>
  );
}
