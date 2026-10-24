import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

// ───────── toasts ─────────
interface Toast { id: number; kind: 'info' | 'error' | 'success'; text: string }
const ToastCtx = createContext<{ push: (kind: Toast['kind'], text: string) => void }>({ push: () => {} });
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((kind: Toast['kind'], text: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 7000 : 4000);
  }, []);
  return (
    <ToastCtx.Provider value={{ push }}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => <div key={t.id} className={`toast toast-${t.kind}`}>{t.text}</div>)}
      </div>
    </ToastCtx.Provider>
  );
}

// ───────── modal ─────────
export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('input,button,select')?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); prev?.focus?.(); };
  }, [onClose]);
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`modal${wide ? ' modal-wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId} ref={ref}>
        <h2 id={titleId}>{title}</h2>
        {children}
      </div>
    </div>, document.body);
}

// ───────── popup menu ─────────
export interface MenuItem { label: string; onSelect: () => void; danger?: boolean; disabled?: boolean; icon?: ReactNode; separator?: boolean }
export function Menu({ items, anchor, onClose }: { items: MenuItem[]; anchor: { x: number; y: number }; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(anchor);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ x: Math.max(8, Math.min(anchor.x, window.innerWidth - r.width - 8)), y: Math.max(8, Math.min(anchor.y, window.innerHeight - r.height - 8)) });
    el.querySelector<HTMLElement>('button:not([disabled])')?.focus();
    const down = (e: MouseEvent) => { if (!el.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const btns = [...el.querySelectorAll<HTMLElement>('button:not([disabled])')];
        const i = btns.indexOf(document.activeElement as HTMLElement);
        btns[(i + (e.key === 'ArrowDown' ? 1 : -1) + btns.length) % btns.length]?.focus();
      }
    };
    document.addEventListener('mousedown', down); document.addEventListener('keydown', key);
    window.addEventListener('scroll', onClose, true); window.addEventListener('resize', onClose);
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key); window.removeEventListener('scroll', onClose, true); window.removeEventListener('resize', onClose); };
  }, [anchor, onClose]);
  return createPortal(
    <div className="menu" role="menu" ref={ref} style={{ left: pos.x, top: pos.y }}>
      {items.map((it, i) => it.separator
        ? <hr key={i} />
        : <button key={i} role="menuitem" className={it.danger ? 'danger' : ''} disabled={it.disabled} onClick={() => { onClose(); it.onSelect(); }}>
            {it.icon}<span>{it.label}</span>
          </button>)}
    </div>, document.body);
}

export function useMenu() {
  const [state, setState] = useState<{ items: MenuItem[]; anchor: { x: number; y: number } } | null>(null);
  const close = useCallback(() => setState(null), []);
  const open = useCallback((items: MenuItem[], anchor: { x: number; y: number }) => setState({ items, anchor }), []);
  const node = state ? <Menu items={state.items} anchor={state.anchor} onClose={close} /> : null;
  return { open, node };
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return <div className="spinner" role="status" aria-label={label} />;
}
export function Empty({ icon, title, hint, children }: { icon?: ReactNode; title: string; hint?: string; children?: ReactNode }) {
  return <div className="empty">{icon}<h3>{title}</h3>{hint && <p>{hint}</p>}{children}</div>;
}
