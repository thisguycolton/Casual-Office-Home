import { ApiError, getCsrf } from '../../api.ts';
import type { RoomStorage } from './controller.ts';

/** The room's view of the stored file: always through the authenticated, version-checked API. */
export function apiRoomStorage(fileId: string): RoomStorage {
  return {
    async read() {
      const r = await fetch(`/api/files/${fileId}/content`, { credentials: 'same-origin' });
      if (!r.ok) throw new ApiError(r.status, 'load_failed', r.status === 404 ? 'File not found' : `Could not load file (${r.status})`);
      return { bytes: await r.arrayBuffer(), version: Number(r.headers.get('x-file-version') ?? 0) };
    },
    async write(bytes, ifMatch) {
      const r = await fetch(`/api/files/${fileId}/content`, {
        method: 'PUT', credentials: 'same-origin',
        headers: { 'content-type': 'application/octet-stream', 'if-match': String(ifMatch), 'x-csrf-token': getCsrf() },
        body: bytes,
      });
      if (r.status === 409) return 'conflict';
      if (!r.ok) throw new ApiError(r.status, 'save_failed', `Save failed (${r.status})`);
      return { version: Number((await r.json()).version) };
    },
  };
}

export function collabSocketUrl(path: string): string {
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${path}`;
}

const COLORS = ['#e11d48', '#2563eb', '#16a34a', '#d97706', '#9333ea', '#0891b2'];
export const colorFor = (s: string): string => COLORS[[...s].reduce((a, c) => a + c.charCodeAt(0), 0) % COLORS.length]!;
