import type { Kind } from './api.ts';

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function formatDate(ms: number, now = Date.now()): string {
  const d = new Date(ms), n = new Date(now);
  if (d.toDateString() === n.toDateString()) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const sameYear = d.getFullYear() === n.getFullYear();
  return d.toLocaleDateString([], sameYear ? { month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short', day: 'numeric' });
}

export const KIND_LABEL: Record<Kind, string> = {
  folder: 'Folder', document: 'Document', spreadsheet: 'Spreadsheet', presentation: 'Presentation',
  pdf: 'PDF', image: 'Image', text: 'Text', other: 'File',
};

/** Where the user lands when they open an item. */
export function openTarget(item: { id: string; kind: Kind }): string {
  return item.kind === 'folder' ? `/files/${item.id}` : `/open/${item.id}`;
}
