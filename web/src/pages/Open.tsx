import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, downloadUrl, inlineUrl, type FileDetails } from '../api.ts';
import { KindIcon, IconDownload, IconChevron } from '../components/icons.tsx';
import { Spinner } from '../components/ui.tsx';
import { EditorFrame } from '../editors/EditorFrame.tsx';
import { formatSize, KIND_LABEL } from '../format.ts';

const EDITOR_NAME = { docs: 'Casual Docs', sheets: 'Casual Sheets', slides: 'Casual Slides', pdf: 'Casual PDF' } as const;
const MAX_TEXT_PREVIEW = 1024 * 1024;

export function OpenPage() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const [d, setD] = useState<FileDetails | null>(null);
  const [err, setErr] = useState('');
  const [text, setText] = useState<string | null>(null);

  useEffect(() => {
    let live = true; setD(null); setText(null); setErr('');
    api<FileDetails>('GET', `/api/files/${id}`).then(async (f) => {
      if (!live) return;
      if (f.kind === 'folder') { nav(`/files/${f.id}`, { replace: true }); return; }
      setD(f); api('POST', `/api/files/${id}/open`).catch(() => {});
      if (f.kind === 'text' && f.size <= MAX_TEXT_PREVIEW) {
        const r = await fetch(inlineUrl(id), { credentials: 'same-origin' });
        if (live && r.ok) setText(await r.text());
      }
    }).catch((e) => live && setErr(e.message));
    return () => { live = false; };
  }, [id, nav]);

  if (err) return <div className="page"><p className="form-error" role="alert">{err}</p><Link to="/files">Back to My Files</Link></div>;
  if (!d) return <div className="page"><Spinner /></div>;
  // Docs and Sheets open in the embedded editor; other kinds fall through to the preview below.
  if (d.editor === 'docs' || d.editor === 'sheets') return <EditorFrame key={d.id} file={d} />;
  // `path` lists the file's ancestors (not the file itself).
  const back = d.path.length > 0 ? `/files/${d.path[d.path.length - 1]!.id}` : '/files';
  return (
    <div className="page open-page">
      <nav className="crumbs" aria-label="Breadcrumb">
        <Link to="/files" className="crumb">My Files</Link>
        {d.path.map((p) => <span key={p.id}><IconChevron size={14} /><Link className="crumb" to={`/files/${p.id}`}>{p.name}</Link></span>)}
        <span><IconChevron size={14} /><span className="crumb current" aria-current="page">{d.name}</span></span>
      </nav>
      <header className="open-head">
        <KindIcon kind={d.kind} size={32} />
        <div><h1>{d.name}</h1><p className="muted">{KIND_LABEL[d.kind]} · {formatSize(d.size)}</p></div>
        <div className="open-actions">
          <Link className="btn" to={back}>Back to folder</Link>
          <a className="btn btn-primary" href={downloadUrl(d.id)}><IconDownload size={16} /> Download</a>
        </div>
      </header>
      {d.kind === 'image' && <div className="preview"><img src={inlineUrl(d.id)} alt={d.name} /></div>}
      {d.kind === 'text' && (text !== null ? <pre className="preview text-preview">{text}</pre>
        : <p className="muted">{d.size > MAX_TEXT_PREVIEW ? 'This text file is too large to preview. Download it to view it.' : 'Loading preview…'}</p>)}
      {(d.editor === 'slides' || d.editor === 'pdf') && (
        <div className="notice" role="status">
          <strong>{EDITOR_NAME[d.editor]} will open this file here.</strong>
          <p>The editor integration is not wired up yet, so for now you can download the file. Nothing about this file has been changed.</p>
        </div>
      )}
      {!d.editor && d.kind === 'other' && <div className="notice"><strong>No preview or editor for this file type.</strong><p>You can download it.</p></div>}
    </div>
  );
}
