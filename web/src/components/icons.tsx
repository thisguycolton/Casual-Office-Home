import type { ReactNode } from 'react';
import type { Kind } from '../api.ts';

type P = { size?: number; className?: string };
const base = (children: ReactNode, { size = 20, className }: P) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>{children}</svg>
);
const mk = (d: ReactNode) => (p: P) => base(d, p);

export const IconHome = mk(<><path d="M3 11l9-8 9 8" /><path d="M5 10v10h14V10" /></>);
export const IconFolder = mk(<path d="M3 6a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2z" />);
export const IconUsers = mk(<><circle cx="9" cy="8" r="3.2" /><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6" /><path d="M16 5a3 3 0 010 6M21 20c0-2.6-1.7-4.8-4-5.6" /></>);
export const IconClock = mk(<><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>);
export const IconStar = mk(<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z" />);
export const IconStarFilled = ({ size = 20, className }: P) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}><path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z" /></svg>
);
export const IconTrash = mk(<><path d="M4 7h16" /><path d="M9 7V4h6v3" /><path d="M6 7l1 13h10l1-13" /><path d="M10 11v6M14 11v6" /></>);
export const IconSettings = mk(<><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z" /></>);
export const IconUser = mk(<><circle cx="12" cy="8" r="4" /><path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8" /></>);
export const IconPlus = mk(<path d="M12 5v14M5 12h14" />);
export const IconSearch = mk(<><circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4" /></>);
export const IconUpload = mk(<><path d="M12 16V4M7 9l5-5 5 5" /><path d="M4 16v3a1 1 0 001 1h14a1 1 0 001-1v-3" /></>);
export const IconDownload = mk(<><path d="M12 4v12M7 11l5 5 5-5" /><path d="M4 20h16" /></>);
export const IconMenu = mk(<path d="M4 6h16M4 12h16M4 18h16" />);
export const IconMore = mk(<><circle cx="12" cy="5" r="1.2" fill="currentColor" /><circle cx="12" cy="12" r="1.2" fill="currentColor" /><circle cx="12" cy="19" r="1.2" fill="currentColor" /></>);
export const IconGrid = mk(<><rect x="4" y="4" width="7" height="7" rx="1" /><rect x="13" y="4" width="7" height="7" rx="1" /><rect x="4" y="13" width="7" height="7" rx="1" /><rect x="13" y="13" width="7" height="7" rx="1" /></>);
export const IconList = mk(<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" />);
export const IconChevron = mk(<path d="M9 6l6 6-6 6" />);
export const IconClose = mk(<path d="M6 6l12 12M18 6L6 18" />);
export const IconInfo = mk(<><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></>);
export const IconShield = mk(<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" />);
export const IconSidebar = mk(<><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></>);
export const IconCheck = mk(<path d="M5 12l5 5 9-10" />);
export const IconRestore = mk(<><path d="M3 12a9 9 0 109-9 9 9 0 00-6.4 2.6L3 8" /><path d="M3 3v5h5" /></>);

const FILE = <><path d="M6 3h8l5 5v13H6z" /><path d="M14 3v5h5" /></>;
const KIND_ICON: Record<Kind, { node: ReactNode; color: string }> = {
  folder: { node: <path d="M3 6a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2z" />, color: 'var(--kind-folder)' },
  document: { node: <>{FILE}<path d="M9 13h6M9 17h6" /></>, color: 'var(--kind-doc)' },
  spreadsheet: { node: <>{FILE}<path d="M9 12h6M9 16h6M12 11v7" /></>, color: 'var(--kind-sheet)' },
  presentation: { node: <>{FILE}<rect x="9" y="12" width="6" height="4" rx="0.5" /></>, color: 'var(--kind-slide)' },
  pdf: { node: <>{FILE}<path d="M9 17c1-3 2-5 3-5s0 3 3 3-5 1-6 2z" /></>, color: 'var(--kind-pdf)' },
  image: { node: <><rect x="4" y="5" width="16" height="14" rx="2" /><circle cx="9" cy="10" r="1.5" /><path d="M20 16l-5-5-8 8" /></>, color: 'var(--kind-image)' },
  text: { node: <>{FILE}<path d="M9 13h6M9 16h4" /></>, color: 'var(--kind-text)' },
  other: { node: FILE, color: 'var(--kind-other)' },
};
export function KindIcon({ kind, size = 22 }: { kind: Kind; size?: number }) {
  const k = KIND_ICON[kind];
  return <span className="kind-icon" style={{ color: k.color }}>{base(k.node, { size })}</span>;
}
