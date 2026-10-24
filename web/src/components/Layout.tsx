import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, NavLink, Outlet, useLocation, useMatch, useNavigate, useSearchParams } from 'react-router-dom';
import { api, type FileItem } from '../api.ts';
import { useAuth } from '../auth.tsx';
import { formatSize } from '../format.ts';
import { useUploads } from '../uploads.tsx';
import { NameDialog } from './Dialogs.tsx';
import {
  IconClock, IconFolder, IconHome, IconMenu, IconPlus, IconSearch, IconSettings, IconShield, IconSidebar, IconStar, IconTrash, IconUpload, IconUser, IconUsers, KindIcon,
} from './icons.tsx';
import { useMenu, useToast } from './ui.tsx';

const NAV = [
  { to: '/', label: 'Home', icon: IconHome, end: true },
  { to: '/files', label: 'My Files', icon: IconFolder },
  { to: '/shared', label: 'Shared Files', icon: IconUsers },
  { to: '/recent', label: 'Recent', icon: IconClock },
  { to: '/starred', label: 'Starred', icon: IconStar },
  { to: '/trash', label: 'Trash', icon: IconTrash },
  { to: '/settings', label: 'Settings', icon: IconSettings },
];

/** Creates a blank file and returns it. Used by the sidebar New menu and the Home buttons. */
export async function createBlank(kind: 'document' | 'spreadsheet' | 'presentation', parentId: string | null): Promise<FileItem> {
  return api<FileItem>('POST', '/api/files/new', { kind, parentId: parentId ?? 'root' });
}

export function useNewActions(parentId: string | null) {
  const nav = useNavigate();
  const toast = useToast();
  const { enqueue, bump } = useUploads();
  const [folderDialog, setFolderDialog] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const make = async (kind: 'document' | 'spreadsheet' | 'presentation') => {
    try { const f = await createBlank(kind, parentId); bump(); nav(`/open/${f.id}`); }
    catch (e) { toast.push('error', (e as Error).message); }
  };
  const node = (<>
    <input ref={fileInput} type="file" multiple hidden onChange={(e) => { if (e.target.files?.length) enqueue([...e.target.files], parentId); e.target.value = ''; }} />
    {folderDialog && <NameDialog title="New folder" label="Folder name" initial="Untitled folder" action="Create" onClose={() => setFolderDialog(false)}
      onSubmit={async (name) => { await api('POST', '/api/folders', { name, parentId: parentId ?? 'root' }); bump(); toast.push('success', 'Folder created'); }} />}
  </>);
  return {
    node,
    newDocument: () => make('document'), newSpreadsheet: () => make('spreadsheet'), newPresentation: () => make('presentation'),
    newFolder: () => setFolderDialog(true), pickFiles: () => fileInput.current?.click(),
  };
}

export function Layout() {
  const { user, logout } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const [params] = useSearchParams();
  const { changeTick } = useUploads();
  const folderMatch = useMatch('/files/:folderId');
  const parentId = folderMatch?.params.folderId ?? null;
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem('sidebar') === 'collapsed'; } catch { return false; } });
  const [drawer, setDrawer] = useState(false);
  const [q, setQ] = useState(params.get('q') ?? '');
  const [usage, setUsage] = useState<{ used: number; quota: number } | null>(null);
  const actions = useNewActions(parentId);
  const menu = useMenu();
  const userMenu = useMenu();

  useEffect(() => { setDrawer(false); }, [loc.pathname]);
  useEffect(() => { if (loc.pathname !== '/search') setQ(''); }, [loc.pathname]);
  useEffect(() => { api<{ used: number; quota: number }>('GET', '/api/storage').then(setUsage).catch(() => {}); }, [changeTick]);
  const toggle = () => { const n = !collapsed; setCollapsed(n); try { localStorage.setItem('sidebar', n ? 'collapsed' : 'expanded'); } catch { /* ignore */ } };
  const submit = (e: FormEvent) => { e.preventDefault(); const t = q.trim(); if (t) nav(`/search?q=${encodeURIComponent(t)}`); };

  const openNew = (e: { currentTarget: Element }) => {
    const r = e.currentTarget.getBoundingClientRect();
    menu.open([
      { label: 'New document', icon: <KindIcon kind="document" size={18} />, onSelect: actions.newDocument },
      { label: 'New spreadsheet', icon: <KindIcon kind="spreadsheet" size={18} />, onSelect: actions.newSpreadsheet },
      { label: 'New presentation', icon: <KindIcon kind="presentation" size={18} />, onSelect: actions.newPresentation },
      { separator: true, label: '', onSelect: () => {} },
      { label: 'New folder', icon: <KindIcon kind="folder" size={18} />, onSelect: actions.newFolder },
      { label: 'Upload files', icon: <IconUpload size={18} />, onSelect: actions.pickFiles },
    ], { x: r.left, y: r.bottom + 4 });
  };

  const pct = usage && usage.quota > 0 ? Math.min(100, (usage.used / usage.quota) * 100) : 0;
  return (
    <div className={`shell${collapsed ? ' collapsed' : ''}${drawer ? ' drawer-open' : ''}`}>
      <a className="skip" href="#main">Skip to content</a>
      <aside className="sidebar" aria-label="Primary">
        <div className="brand"><Link to="/"><span className="logo" aria-hidden="true" /><span className="brand-name">Casual Office</span></Link></div>
        <button className="btn btn-primary new-btn" onClick={openNew} aria-haspopup="menu"><IconPlus size={18} /><span>New</span></button>
        <nav>
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} title={collapsed ? n.label : undefined} className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
              <n.icon size={20} /><span>{n.label}</span>
            </NavLink>
          ))}
          {user?.role === 'admin' && <NavLink to="/admin" title={collapsed ? 'Administration' : undefined} className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}><IconShield size={20} /><span>Administration</span></NavLink>}
        </nav>
        <div className="sidebar-foot">
          {usage && <div className="storage" title="Storage used">
            {usage.quota > 0 && <progress max={100} value={pct} aria-label="Storage used" />}
            <span>{formatSize(usage.used)}{usage.quota > 0 ? ` of ${formatSize(usage.quota)}` : ' used'}</span>
          </div>}
          <NavLink to="/profile" className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`} title={collapsed ? 'User profile' : undefined}>
            <IconUser size={20} /><span className="who">{user?.displayName}</span>
          </NavLink>
        </div>
      </aside>
      {drawer && <div className="scrim" onClick={() => setDrawer(false)} aria-hidden="true" />}
      <div className="main-col">
        <header className="topbar">
          <button className="icon-btn only-mobile" aria-label="Open navigation" onClick={() => setDrawer(true)}><IconMenu /></button>
          <button className="icon-btn only-desktop" aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} aria-pressed={collapsed} onClick={toggle}><IconSidebar /></button>
          <form className="search" role="search" onSubmit={submit}>
            <IconSearch size={18} />
            <input type="search" placeholder="Search files by name" aria-label="Search files by name" value={q} onChange={(e) => setQ(e.target.value)} maxLength={100} />
          </form>
          <button className="btn btn-primary only-mobile-inline" onClick={openNew} aria-haspopup="menu" aria-label="New"><IconPlus size={18} /></button>
          <button className="avatar" aria-label="Account menu" aria-haspopup="menu" onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            userMenu.open([
              { label: user?.email ?? '', disabled: true, onSelect: () => {} },
              { separator: true, label: '', onSelect: () => {} },
              { label: 'User profile', onSelect: () => nav('/profile') },
              { label: 'Settings', onSelect: () => nav('/settings') },
              { label: 'Sign out', danger: true, onSelect: () => { logout(); } },
            ], { x: r.right - 200, y: r.bottom + 4 });
          }}>{(user?.displayName ?? '?').slice(0, 1).toUpperCase()}</button>
        </header>
        <main id="main" tabIndex={-1}><Outlet context={actions} /></main>
      </div>
      {menu.node}{userMenu.node}{actions.node}
    </div>
  );
}
