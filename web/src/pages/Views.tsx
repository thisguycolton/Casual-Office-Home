import { useParams, useSearchParams } from 'react-router-dom';
import { FileBrowser, type BrowserView } from '../components/FileBrowser.tsx';

export function FilesPage() {
  const { folderId } = useParams();
  return <div className="page"><FileBrowser key={folderId ?? 'root'} view="folder" folderId={folderId ?? null} /></div>;
}
export const ViewPage = ({ view }: { view: BrowserView }) => <div className="page"><FileBrowser view={view} /></div>;
export function SearchPage() {
  const [p] = useSearchParams();
  return <div className="page"><FileBrowser view="search" search={p.get('q') ?? ''} /></div>;
}
