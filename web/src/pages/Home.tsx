import { useState, type FormEvent } from 'react';
import { useNavigate, useOutletContext } from 'react-router-dom';
import { FileBrowser } from '../components/FileBrowser.tsx';
import { IconSearch, IconUpload, KindIcon } from '../components/icons.tsx';
import type { useNewActions } from '../components/Layout.tsx';
import { useAuth } from '../auth.tsx';

export function HomePage() {
  const nav = useNavigate();
  const { user } = useAuth();
  const a = useOutletContext<ReturnType<typeof useNewActions>>();
  const [q, setQ] = useState('');
  const submit = (e: FormEvent) => { e.preventDefault(); if (q.trim()) nav(`/search?q=${encodeURIComponent(q.trim())}`); };
  return (
    <div className="page home">
      <h1 className="greeting">Welcome, {user?.displayName}</h1>
      <form className="hero-search" role="search" onSubmit={submit}>
        <IconSearch size={22} />
        <input type="search" placeholder="Search your files by name" aria-label="Search your files by name" value={q} onChange={(e) => setQ(e.target.value)} maxLength={100} />
      </form>
      <div className="quick" role="group" aria-label="Create">
        <button className="quick-btn" onClick={a.newDocument}><KindIcon kind="document" size={28} /><span>New document</span></button>
        <button className="quick-btn" onClick={a.newSpreadsheet}><KindIcon kind="spreadsheet" size={28} /><span>New spreadsheet</span></button>
        <button className="quick-btn" onClick={a.newPresentation}><KindIcon kind="presentation" size={28} /><span>New presentation</span></button>
        <button className="quick-btn" onClick={a.pickFiles}><IconUpload size={28} /><span>Upload files</span></button>
      </div>
      <section aria-labelledby="h-recent"><FileBrowser view="recent" limit={8} title="Recent" compact /></section>
      <section aria-labelledby="h-starred"><FileBrowser view="starred" limit={8} title="Starred" compact /></section>
      <section aria-labelledby="h-files"><FileBrowser view="folder" folderId={null} title="My Files" /></section>
    </div>
  );
}
