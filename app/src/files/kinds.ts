export type Kind = 'folder' | 'document' | 'spreadsheet' | 'presentation' | 'pdf' | 'image' | 'text' | 'other';

interface Entry { kind: Kind; mime: string; magic?: 'zip' | 'pdf' | 'png' | 'jpeg' | 'gif' | 'webp' }

const BY_EXT: Record<string, Entry> = {
  docx: { kind: 'document', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', magic: 'zip' },
  xlsx: { kind: 'spreadsheet', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', magic: 'zip' },
  pptx: { kind: 'presentation', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', magic: 'zip' },
  pdf: { kind: 'pdf', mime: 'application/pdf', magic: 'pdf' },
  png: { kind: 'image', mime: 'image/png', magic: 'png' },
  jpg: { kind: 'image', mime: 'image/jpeg', magic: 'jpeg' },
  jpeg: { kind: 'image', mime: 'image/jpeg', magic: 'jpeg' },
  gif: { kind: 'image', mime: 'image/gif', magic: 'gif' },
  webp: { kind: 'image', mime: 'image/webp', magic: 'webp' },
  txt: { kind: 'text', mime: 'text/plain' },
  md: { kind: 'text', mime: 'text/markdown' },
  csv: { kind: 'text', mime: 'text/csv' },
  json: { kind: 'text', mime: 'application/json' },
};

/** Kinds that have a dedicated editor/viewer in this suite. */
export const EDITOR_FOR: Partial<Record<Kind, 'docs' | 'sheets' | 'slides' | 'pdf'>> = {
  document: 'docs', spreadsheet: 'sheets', presentation: 'slides', pdf: 'pdf',
};

/** Kinds that may be rendered inline in the browser (sandboxed). SVG/HTML are deliberately absent: stored-XSS vectors. */
const INLINE_SAFE = new Set<Kind>(['image', 'pdf', 'text']);
export const canInline = (kind: Kind, mime: string) => INLINE_SAFE.has(kind) && mime !== 'image/svg+xml';

export function classify(filename: string): { kind: Kind; mime: string; ext: string; magic?: Entry['magic'] } {
  const dot = filename.lastIndexOf('.');
  const ext = dot > 0 ? filename.slice(dot + 1).toLowerCase() : '';
  const e = BY_EXT[ext];
  return e ? { ...e, ext } : { kind: 'other', mime: 'application/octet-stream', ext };
}

/** True when the leading bytes are consistent with the claimed format. Unknown formats pass. */
export function magicMatches(magic: Entry['magic'] | undefined, head: Buffer): boolean {
  switch (magic) {
    case undefined: return true;
    case 'zip': return head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
    case 'pdf': return head.subarray(0, 5).toString('latin1') === '%PDF-';
    case 'png': return head.subarray(1, 4).toString('latin1') === 'PNG';
    case 'jpeg': return head[0] === 0xff && head[1] === 0xd8;
    case 'gif': return head.subarray(0, 3).toString('latin1') === 'GIF';
    case 'webp': return head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP';
  }
}
