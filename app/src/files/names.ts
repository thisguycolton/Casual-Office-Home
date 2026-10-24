import { badRequest } from '../errors.ts';

// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[\/\\\u0000-\u001f\u007f]/;
const MAX_BYTES = 255;

/** Validates and normalises a user-supplied file or folder name. Names are labels only: they never reach the filesystem. */
export function validateName(raw: unknown): string {
  if (typeof raw !== 'string') throw badRequest('invalid_name', 'Name must be a string');
  const name = raw.normalize('NFC').trim();
  if (!name) throw badRequest('invalid_name', 'Name must not be empty');
  if (name === '.' || name === '..') throw badRequest('invalid_name', 'Name is reserved');
  if (FORBIDDEN.test(name)) throw badRequest('invalid_name', 'Name contains forbidden characters');
  if (Buffer.byteLength(name, 'utf8') > MAX_BYTES) throw badRequest('invalid_name', 'Name is too long');
  return name;
}

/** "report.docx" -> "report (2).docx" */
export function numberedName(name: string, n: number): string {
  const dot = name.lastIndexOf('.');
  if (dot > 0) return `${name.slice(0, dot)} (${n})${name.slice(dot)}`;
  return `${name} (${n})`;
}

/** Escapes LIKE wildcards for use with `ESCAPE '\'`. */
export function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}
