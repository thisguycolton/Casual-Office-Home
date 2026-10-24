export interface User { id: string; email: string; displayName: string; role: 'user' | 'admin' }
export type Kind = 'folder' | 'document' | 'spreadsheet' | 'presentation' | 'pdf' | 'image' | 'text' | 'other';
export interface FileItem {
  id: string; name: string; kind: Kind; mime: string; parentId: string | null; size: number; version: number;
  starred: boolean; trashedAt: number | null; createdAt: number; updatedAt: number; lastOpenedAt: number | null;
  editor: 'docs' | 'sheets' | 'slides' | 'pdf' | null;
}
export interface FileDetails extends FileItem { sha256: string | null; path: { id: string; name: string }[]; versions: { version: number; size: number; createdAt: number }[] }
export interface Listing { items: FileItem[]; folder?: FileItem | null; path?: { id: string; name: string }[]; sharingImplemented?: boolean }

export class ApiError extends Error {
  status: number; code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}

let csrf = '';
export const setCsrf = (t: string) => { csrf = t; };
export const getCsrf = () => csrf;
let onUnauthenticated: () => void = () => {};
export const setUnauthenticatedHandler = (fn: () => void) => { onUnauthenticated = fn; };

async function parse(res: Response): Promise<any> {
  const text = await res.text();
  let body: any; try { body = text ? JSON.parse(text) : {}; } catch { body = {}; }
  if (!res.ok) {
    if (res.status === 401 && body.error === 'unauthenticated') onUnauthenticated();
    throw new ApiError(res.status, body.error ?? 'error', body.message ?? `Request failed (${res.status})`);
  }
  return body;
}

export async function api<T = any>(method: string, url: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && csrf) headers['x-csrf-token'] = csrf;
  return parse(await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' }));
}

/** Upload one file with byte-level progress (fetch cannot report upload progress, XHR can). */
export function uploadFile(file: File, parentId: string | null, onProgress: (loaded: number, total: number) => void): { promise: Promise<FileItem>; abort: () => void } {
  const xhr = new XMLHttpRequest();
  const q = new URLSearchParams({ name: file.name });
  if (parentId) q.set('parentId', parentId);
  const promise = new Promise<FileItem>((resolve, reject) => {
    xhr.open('POST', `/api/files?${q}`);
    xhr.setRequestHeader('x-csrf-token', csrf);
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded, e.total); };
    xhr.onload = () => {
      let body: any = {}; try { body = JSON.parse(xhr.responseText); } catch { /* ignore */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body);
      else {
        if (xhr.status === 401) onUnauthenticated();
        reject(new ApiError(xhr.status, body.error ?? 'error', body.message ?? `Upload failed (${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new ApiError(0, 'network', 'Network error during upload'));
    xhr.onabort = () => reject(new ApiError(0, 'aborted', 'Upload cancelled'));
    xhr.send(file);
  });
  return { promise, abort: () => xhr.abort() };
}

export const downloadUrl = (id: string) => `/api/files/${id}/content`;
export const inlineUrl = (id: string) => `/api/files/${id}/content?inline=1`;
