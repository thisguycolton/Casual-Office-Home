import type { RoomStatus } from './controller.ts';

/** What a live editor component hands back to its frame so the frame can show status and flush on leave. */
export interface RoomHandle {
  flush(): Promise<void>;
  /** The room's current content as a file, for "save my version as a copy" after a conflict. */
  exportCopy(): Promise<ArrayBuffer>;
}
export interface RoomProps {
  fileId: string;
  fileName: string;
  grant: import('../../api.ts').CollabGrant;
  userName: string;
  userId: string;
  onStatus(s: RoomStatus, detail?: string): void;
  onHandle(h: RoomHandle | null): void;
  /** The editor's own Share button; the host decides what sharing means. */
  onShare?(): void;
}
