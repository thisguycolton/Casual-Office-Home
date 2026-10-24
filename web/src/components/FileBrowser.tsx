import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, downloadUrl, type FileItem, type Listing } from '../api.ts';
import { formatDate, formatSize, KIND_LABEL, openTarget } from '../format.ts';
import { useUploads } from '../uploads.tsx';
import { ConfirmDialog, DetailsPanel, MoveDialog, NameDialog, ShareDialog } from './Dialogs.tsx';
import {
  IconChevron, IconDownload, IconFolder, IconGrid, IconInfo, IconList, IconMore, IconRestore, IconStar, IconStarFilled, IconTrash, IconUpload, KindIcon,
} from './icons.tsx';
import { Empty, Spinner, useMenu, useToast, type MenuItem } from './ui.tsx';

export type BrowserView = 'folder' | 'recent' | 'starred' | 'trash' | 'shared' | 'search';
type SortKey = 'name' | 'kind' | 'size' | 'updated';
const DRAG_TYPE = 'application/x-casual-ids';

const store = {
  get<T extends string>(k: string, def: T, allowed: readonly T[]): T { try { const v = localStorage.getItem(k) as T | null; return v && allowed.includes(v) ? v : def; } catch { return def; } },
  set(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

const EMPTY_TEXT: Record<BrowserView, { title: string; hint: string }> = {
  folder: { title: 'This folder is empty', hint: 'Drop files here, or use New to create something.' },
  recent: { title: 'Nothing opened recently', hint: 'Files you open will show up here.' },
  starred: { title: 'No starred files', hint: 'Star important files to find them quickly.' },
  trash: { title: 'Trash is empty', hint: 'Deleted items stay here until you remove them for good.' },
  shared: { title: 'Nothing shared with you', hint: 'Files other people share with you appear here.' },
  search: { title: 'No matching files', hint: 'Search matches file and folder names.' },
};

export function FileBrowser({ view, folderId = null, search = '', limit, title, compact }: { view: BrowserView; folderId?: string | null; search?: string; limit?: number; title?: string; compact?: boolean }) {
  const nav = useNavigate();
  const toast = useToast();
  const { enqueue, changeTick, bump } = useUploads();
  const [data, setData] = useState<Listing | null>(null);
  const [error, setError] = useState('');
  const [sort, setSort] = useState<SortKey>(() => store.get('sort', 'name', ['name', 'kind', 'size', 'updated'] as const));
  const [order, setOrder] = useState<'asc' | 'desc'>(() => store.get('order', 'asc', ['asc', 'desc'] as const));
  const [mode, setMode] = useState<'list' | 'grid'>(() => store.get('mode', 'list', ['list', 'grid'] as const));
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchorId, setAnchorId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<null | { kind: 'rename' | 'move' | 'confirm' | 'share'; items: FileItem[]; confirm?: 'trash' | 'permanent' | 'empty' }>(null);
  const [detailsId, setDetailsId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | 'self' | null>(null);
  const menu = useMenu();
  const wrapRef = useRef<HTMLDivElement>(null);
  const dragDepth = useRef(0);

  const q = useMemo(() => {
    const p = new URLSearchParams();
    if (view === 'search') p.set('search', search); else p.set('view', view);
    if (view === 'folder') p.set('parentId', folderId ?? 'root');
    if (view === 'folder' || view === 'starred' || view === 'search') { p.set('sort', sort); p.set('order', order); }
    if (limit) p.set('limit', String(limit));
    return p.toString();
  }, [view, folderId, search, sort, order, limit]);

  const load = useCallback(() => {
    api<Listing>('GET', `/api/files?${q}`).then((d) => { setData(d); setError(''); }).catch((e) => { setError(e.message); setData(null); });
  }, [q]);
  useEffect(() => { load(); }, [load, changeTick]);
  useEffect(() => { setSelected(new Set()); setDetailsId(null); }, [view, folderId, search]);

  const items = data?.items ?? [];
  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const selItems = useMemo(() => [...selected].map((id) => byId.get(id)).filter(Boolean) as FileItem[], [selected, byId]);

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    try { await fn(); if (ok) toast.push('success', ok); bump(); } catch (e) { toast.push('error', (e as Error).message); }
  };

  // ───────── selection ─────────
  const select = (item: FileItem, e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => {
    setSelected((prev) => {
      if (e.shiftKey && anchorId) {
        const a = items.findIndex((i) => i.id === anchorId), b = items.findIndex((i) => i.id === item.id);
        if (a >= 0 && b >= 0) return new Set(items.slice(Math.min(a, b), Math.max(a, b) + 1).map((i) => i.id));
      }
      if (e.ctrlKey || e.metaKey) { const n = new Set(prev); n.has(item.id) ? n.delete(item.id) : n.add(item.id); return n; }
      return new Set([item.id]);
    });
    if (!e.shiftKey) setAnchorId(item.id);
  };
  const open = (item: FileItem) => nav(openTarget(item));

  // ───────── actions ─────────
  const targets = (item: FileItem) => (selected.has(item.id) ? selItems : [item]);
  const trashItems = (its: FileItem[]) => run(async () => { for (const i of its) await api('DELETE', `/api/files/${i.id}`); }, its.length === 1 ? `Moved “${its[0]!.name}” to trash` : `Moved ${its.length} items to trash`);
  const itemMenu = (item: FileItem): MenuItem[] => {
    const its = targets(item); const multi = its.length > 1;
    if (view === 'trash') return [
      { label: 'Restore', icon: <IconRestore size={16} />, onSelect: () => run(async () => { for (const i of its) await api('POST', `/api/files/${i.id}/restore`); }, 'Restored') },
      { label: 'Delete forever…', icon: <IconTrash size={16} />, danger: true, onSelect: () => setDialog({ kind: 'confirm', items: its, confirm: 'permanent' }) },
    ];
    if (view === 'shared') return [
      { label: 'Open', onSelect: () => open(item), disabled: multi },
      { label: 'Download', icon: <IconDownload size={16} />, disabled: multi, onSelect: () => { window.location.href = downloadUrl(item.id); } },
    ];
    return [
      { label: 'Open', onSelect: () => open(item), disabled: multi },
      { label: 'Download', icon: <IconDownload size={16} />, disabled: multi || item.kind === 'folder', onSelect: () => { window.location.href = downloadUrl(item.id); } },
      { separator: true, label: '', onSelect: () => {} },
      { label: its.every((i) => i.starred) ? 'Remove star' : 'Add star', icon: <IconStar size={16} />, onSelect: () => { const s = !its.every((i) => i.starred); run(async () => { for (const i of its) await api('PATCH', `/api/files/${i.id}`, { starred: s }); }); } },
      { label: 'Share…', disabled: multi || item.kind === 'folder', onSelect: () => setDialog({ kind: 'share', items: [item] }) },
      { label: 'Rename', disabled: multi, onSelect: () => setDialog({ kind: 'rename', items: [item] }) },
      { label: 'Move to…', onSelect: () => setDialog({ kind: 'move', items: its }) },
      { label: 'Make a copy', disabled: multi || item.kind === 'folder', onSelect: () => run(() => api('POST', `/api/files/${item.id}/copy`, {}), 'Copy created') },
      { label: 'Details', icon: <IconInfo size={16} />, disabled: multi, onSelect: () => setDetailsId(item.id) },
      { separator: true, label: '', onSelect: () => {} },
      { label: 'Move to trash', icon: <IconTrash size={16} />, danger: true, onSelect: () => trashItems(its) },
    ];
  };
  const showMenu = (item: FileItem, e: MouseEvent | { clientX: number; clientY: number; preventDefault(): void }) => {
    e.preventDefault();
    if (!selected.has(item.id)) { setSelected(new Set([item.id])); setAnchorId(item.id); }
    menu.open(itemMenu(item), { x: e.clientX, y: e.clientY });
  };

  const onKey = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement).closest('input,textarea,[role="dialog"]')) return;
    if (!selItems.length) return;
    if (e.key === 'Enter' && selItems.length === 1) open(selItems[0]!);
    else if (e.key === 'Delete' || e.key === 'Backspace') { if (view === 'trash') setDialog({ kind: 'confirm', items: selItems, confirm: 'permanent' }); else trashItems(selItems); }
    else if (e.key === 'F2' && selItems.length === 1 && view !== 'trash') setDialog({ kind: 'rename', items: [selItems[0]!] });
    else if (e.key === 'Escape') setSelected(new Set());
  };

  // ───────── drag & drop ─────────
  const hasFiles = (e: DragEvent) => e.dataTransfer.types.includes('Files');
  const canDropHere = view === 'folder';
  const onDropFiles = async (e: DragEvent, parent: string | null) => {
    const files: File[] = []; let skipped = 0;
    for (const it of [...e.dataTransfer.items]) {
      const entry = (it as DataTransferItem & { webkitGetAsEntry?: () => { isDirectory: boolean } | null }).webkitGetAsEntry?.();
      if (entry?.isDirectory) { skipped++; continue; }
      const f = it.getAsFile(); if (f) files.push(f);
    }
    if (skipped) toast.push('info', 'Folders can’t be uploaded by drag-and-drop yet — drop individual files.');
    if (files.length) enqueue(files, parent);
  };
  const dragOverFolder = (e: DragEvent, id: string) => {
    if (!canDropHere) return;
    if (hasFiles(e) || e.dataTransfer.types.includes(DRAG_TYPE)) { e.preventDefault(); e.stopPropagation(); setDropTarget(id); }
  };
  const dropOnFolder = (e: DragEvent, folder: FileItem) => {
    if (!canDropHere) return;
    e.preventDefault(); e.stopPropagation(); setDropTarget(null); dragDepth.current = 0;
    if (hasFiles(e)) { onDropFiles(e, folder.id); return; }
    const raw = e.dataTransfer.getData(DRAG_TYPE); if (!raw) return;
    const ids = (JSON.parse(raw) as string[]).filter((id) => id !== folder.id);
    run(async () => { for (const id of ids) await api('PATCH', `/api/files/${id}`, { parentId: folder.id }); }, `Moved ${ids.length} item${ids.length > 1 ? 's' : ''} to “${folder.name}”`);
  };
  const startDrag = (e: DragEvent, item: FileItem) => {
    const ids = selected.has(item.id) ? [...selected] : [item.id];
    e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(ids)); e.dataTransfer.effectAllowed = 'move';
  };

  const toggleSort = (k: SortKey) => {
    const o = sort === k && order === 'asc' ? 'desc' : 'asc';
    setSort(k); setOrder(o); store.set('sort', k); store.set('order', o);
  };
  const setViewMode = (m: 'list' | 'grid') => { setMode(m); store.set('mode', m); };
  const sortable = view === 'folder' || view === 'starred' || view === 'search';

  // ───────── dialog handlers ─────────
  const dialogNode = dialog && (
    dialog.kind === 'rename' ? <NameDialog title="Rename" label="Name" initial={dialog.items[0]!.name} action="Rename" onClose={() => setDialog(null)}
        onSubmit={async (name) => { await api('PATCH', `/api/files/${dialog.items[0]!.id}`, { name }); bump(); }} />
    : dialog.kind === 'share' ? <ShareDialog item={dialog.items[0]!} onClose={() => { setDialog(null); bump(); }} />
    : dialog.kind === 'move' ? <MoveDialog items={dialog.items} onMoved={() => { toast.push('success', 'Moved'); bump(); }} onClose={() => setDialog(null)} />
    : <ConfirmDialog title={dialog.confirm === 'empty' ? 'Empty trash?' : 'Delete forever?'} danger action={dialog.confirm === 'empty' ? 'Empty trash' : 'Delete forever'}
        body={dialog.confirm === 'empty' ? 'Everything in the trash will be permanently deleted. This cannot be undone.' : `${dialog.items.length === 1 ? `“${dialog.items[0]!.name}”` : `${dialog.items.length} items`} will be permanently deleted. This cannot be undone.`}
        onClose={() => setDialog(null)}
        onConfirm={async () => {
          if (dialog.confirm === 'empty') await api('POST', '/api/trash/empty'); else for (const i of dialog.items) await api('DELETE', `/api/files/${i.id}/permanent`);
          setSelected(new Set()); bump();
        }} />
  );

  const crumbs = data?.path ?? [];
  const heading = title ?? (view === 'folder' ? 'My Files' : view === 'recent' ? 'Recent' : view === 'starred' ? 'Starred' : view === 'trash' ? 'Trash' : view === 'shared' ? 'Shared Files' : 'Search results');

  const renderRow = (item: FileItem) => {
    const isSel = selected.has(item.id);
    const isFolder = item.kind === 'folder';
    return (
      <div key={item.id} role="row" aria-selected={isSel} tabIndex={-1}
        className={`row${isSel ? ' selected' : ''}${dropTarget === item.id ? ' drop' : ''}`}
        draggable={view === 'folder'} onDragStart={(e) => startDrag(e, item)}
        onDragOver={isFolder ? (e) => dragOverFolder(e, item.id) : undefined} onDragLeave={() => setDropTarget(null)}
        onDrop={isFolder ? (e) => dropOnFolder(e, item) : undefined}
        onClick={(e) => select(item, e)} onDoubleClick={() => view !== 'trash' && open(item)} onContextMenu={(e) => showMenu(item, e)}>
        <div role="gridcell" className="c-name">
          <input type="checkbox" aria-label={`Select ${item.name}`} checked={isSel} onClick={(e) => e.stopPropagation()} onChange={() => select(item, { ctrlKey: true, metaKey: false, shiftKey: false })} />
          <KindIcon kind={item.kind} />
          {view === 'trash' ? <span className="name">{item.name}</span>
            : <Link className="name" to={openTarget(item)} onClick={(e) => { if (e.ctrlKey || e.metaKey || e.shiftKey) e.preventDefault(); e.stopPropagation(); }}>{item.name}</Link>}
          {item.sharedBy && <span className="muted shared-by"> · {item.sharedBy} · {item.role === 'editor' ? 'can edit' : 'view only'}</span>}
          {item.starred && view !== 'trash' && <span className="star-mark" title="Starred"><IconStarFilled size={14} /></span>}
        </div>
        <div role="gridcell" className="c-kind">{KIND_LABEL[item.kind]}</div>
        <div role="gridcell" className="c-size">{isFolder ? '—' : formatSize(item.size)}</div>
        <div role="gridcell" className="c-date">{formatDate(view === 'trash' && item.trashedAt ? item.trashedAt : view === 'recent' && item.lastOpenedAt ? item.lastOpenedAt : item.updatedAt)}</div>
        <div role="gridcell" className="c-act">
          <button className="icon-btn" aria-label={`Actions for ${item.name}`} aria-haspopup="menu"
            onClick={(e) => { e.stopPropagation(); const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); showMenu(item, { clientX: r.left, clientY: r.bottom, preventDefault() {} }); }}><IconMore size={18} /></button>
        </div>
      </div>
    );
  };

  const renderCard = (item: FileItem) => {
    const isSel = selected.has(item.id);
    const isFolder = item.kind === 'folder';
    return (
      <div key={item.id} className={`card${isSel ? ' selected' : ''}${dropTarget === item.id ? ' drop' : ''}`} tabIndex={-1} draggable={view === 'folder'} onDragStart={(e) => startDrag(e, item)}
        onDragOver={isFolder ? (e) => dragOverFolder(e, item.id) : undefined} onDragLeave={() => setDropTarget(null)} onDrop={isFolder ? (e) => dropOnFolder(e, item) : undefined}
        onClick={(e) => select(item, e)} onDoubleClick={() => view !== 'trash' && open(item)} onContextMenu={(e) => showMenu(item, e)}>
        <div className="card-thumb"><KindIcon kind={item.kind} size={40} /></div>
        <div className="card-foot">
          <KindIcon kind={item.kind} size={16} />
          {view === 'trash' ? <span className="name">{item.name}</span> : <Link className="name" to={openTarget(item)} onClick={(e) => { if (e.ctrlKey || e.metaKey || e.shiftKey) e.preventDefault(); e.stopPropagation(); }}>{item.name}</Link>}
          <button className="icon-btn" aria-label={`Actions for ${item.name}`} aria-haspopup="menu"
            onClick={(e) => { e.stopPropagation(); const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); showMenu(item, { clientX: r.left, clientY: r.bottom, preventDefault() {} }); }}><IconMore size={16} /></button>
        </div>
        <div className="card-meta">{isFolder ? 'Folder' : `${formatSize(item.size)} · ${formatDate(item.updatedAt)}`}{item.starred && <IconStarFilled size={12} />}</div>
      </div>
    );
  };

  return (
    <div className={`browser${detailsId ? ' with-details' : ''}${compact ? ' compact' : ''}`}>
      <div className="browser-main" ref={wrapRef} onKeyDown={onKey} tabIndex={0}
        onDragEnter={(e) => { if (canDropHere && hasFiles(e)) { dragDepth.current++; setDropTarget('self'); } }}
        onDragOver={(e) => { if (canDropHere && hasFiles(e)) e.preventDefault(); }}
        onDragLeave={() => { if (canDropHere && --dragDepth.current <= 0) { dragDepth.current = 0; setDropTarget((t) => (t === 'self' ? null : t)); } }}
        onDrop={(e) => { if (canDropHere && hasFiles(e)) { e.preventDefault(); dragDepth.current = 0; setDropTarget(null); onDropFiles(e, folderId); } }}>
        {dropTarget === 'self' && <div className="drop-overlay" aria-hidden="true"><IconUpload size={32} /> Drop files to upload</div>}

        <div className="browser-head">
          {view === 'folder' && !title ? (
            <nav className="crumbs" aria-label="Breadcrumb">
              <Link to="/files" className={`crumb${folderId === null ? ' current' : ''}`}
                onDragOver={(e) => { if (e.dataTransfer.types.includes(DRAG_TYPE)) { e.preventDefault(); setDropTarget('root'); } }}
                onDragLeave={() => setDropTarget(null)}
                onDrop={(e) => { e.preventDefault(); setDropTarget(null); const raw = e.dataTransfer.getData(DRAG_TYPE); if (raw) run(async () => { for (const id of JSON.parse(raw) as string[]) await api('PATCH', `/api/files/${id}`, { parentId: 'root' }); }, 'Moved to My Files'); }}>My Files</Link>
              {crumbs.map((p, i) => (<span key={p.id}><IconChevron size={14} />
                <Link to={`/files/${p.id}`} className={`crumb${i === crumbs.length - 1 ? ' current' : ''}`} aria-current={i === crumbs.length - 1 ? 'page' : undefined}
                  onDragOver={(e) => { if (e.dataTransfer.types.includes(DRAG_TYPE)) { e.preventDefault(); setDropTarget(p.id); } }} onDragLeave={() => setDropTarget(null)}
                  onDrop={(e) => dropOnFolder(e, { id: p.id, name: p.name } as FileItem)}>{p.name}</Link></span>))}
            </nav>
          ) : <h2 className="browser-title">{heading}{view === 'search' && search && <span className="muted"> for “{search}”</span>}</h2>}
          {!compact && <div className="browser-tools">
            {view === 'trash' && items.length > 0 && <button className="btn" onClick={() => setDialog({ kind: 'confirm', items: [], confirm: 'empty' })}>Empty trash</button>}
            {selItems.length > 0 && view !== 'trash' && (<>
              <span className="muted sel-count">{selItems.length} selected</span>
              <button className="btn" onClick={() => setDialog({ kind: 'move', items: selItems })}>Move</button>
              <button className="btn" onClick={() => trashItems(selItems)}>Trash</button>
            </>)}
            {sortable && mode === 'grid' && (
              <label className="sort-select"><span className="sr-only">Sort by</span>
                <select value={`${sort}:${order}`} onChange={(e) => { const [k, o] = e.target.value.split(':') as [SortKey, 'asc' | 'desc']; setSort(k); setOrder(o); store.set('sort', k); store.set('order', o); }}>
                  <option value="name:asc">Name (A–Z)</option><option value="name:desc">Name (Z–A)</option><option value="updated:desc">Modified (newest)</option>
                  <option value="updated:asc">Modified (oldest)</option><option value="size:desc">Size (largest)</option><option value="size:asc">Size (smallest)</option><option value="kind:asc">Type</option>
                </select></label>
            )}
            <div className="seg" role="group" aria-label="View">
              <button className={mode === 'list' ? 'on' : ''} aria-pressed={mode === 'list'} aria-label="List view" onClick={() => setViewMode('list')}><IconList size={18} /></button>
              <button className={mode === 'grid' ? 'on' : ''} aria-pressed={mode === 'grid'} aria-label="Grid view" onClick={() => setViewMode('grid')}><IconGrid size={18} /></button>
            </div>
          </div>}
        </div>

        {error && <p className="form-error" role="alert">{error} <button className="link" onClick={load}>Retry</button></p>}
        {!data && !error && <Spinner />}
        {data && items.length === 0 && (
          <Empty icon={view === 'folder' ? <IconFolder size={40} /> : view === 'trash' ? <IconTrash size={40} /> : view === 'starred' ? <IconStar size={40} /> : undefined} {...EMPTY_TEXT[view]} />
        )}
        {data && items.length > 0 && mode === 'list' && (
          <div role="grid" aria-label={heading} className="table">
            <div role="row" className="row head">
              <div role="columnheader" className="c-name">{sortable ? <button className="th" onClick={() => toggleSort('name')} aria-sort={sort === 'name' ? (order === 'asc' ? 'ascending' : 'descending') : 'none'}>Name{sort === 'name' && <i>{order === 'asc' ? '↑' : '↓'}</i>}</button> : 'Name'}</div>
              <div role="columnheader" className="c-kind">{sortable ? <button className="th" onClick={() => toggleSort('kind')}>Type{sort === 'kind' && <i>{order === 'asc' ? '↑' : '↓'}</i>}</button> : 'Type'}</div>
              <div role="columnheader" className="c-size">{sortable ? <button className="th" onClick={() => toggleSort('size')}>Size{sort === 'size' && <i>{order === 'asc' ? '↑' : '↓'}</i>}</button> : 'Size'}</div>
              <div role="columnheader" className="c-date">{sortable ? <button className="th" onClick={() => toggleSort('updated')}>Modified{sort === 'updated' && <i>{order === 'asc' ? '↑' : '↓'}</i>}</button> : view === 'trash' ? 'Deleted' : view === 'recent' ? 'Opened' : 'Modified'}</div>
              <div className="c-act" />
            </div>
            {items.map(renderRow)}
          </div>
        )}
        {data && items.length > 0 && mode === 'grid' && <div className="cards">{items.map(renderCard)}</div>}
      </div>
      {detailsId && <DetailsPanel id={detailsId} onClose={() => setDetailsId(null)} onChanged={bump} />}
      {menu.node}{dialogNode}
    </div>
  );
}
