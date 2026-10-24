import { useCallback, useEffect, useMemo, useRef } from 'react';
import { CasualSheets, type CasualSheetsAPI } from '@casualoffice/sheets';
import type { CollabHandle } from '@casualoffice/sheets/collab';
import './univer-css.ts';
import { EMBED_LOCALES } from './sheets-locale.ts';
import { RoomController } from './collab/controller.ts';
import { apiRoomStorage, collabSocketUrl } from './collab/storage.ts';
import type { RoomProps } from './collab/types.ts';

const OPS = 'ops'; // the Sheets bridge's op-log key (@casualoffice/sheets src/collab/bridge.ts LOG_KEY)

/** Univer needs *some* workbook to mount; joiners replace it with the room's snapshot, so it is never shown for long. */
const BLANK = {
  id: 'casual-blank', name: 'Sheet', appVersion: '0.25.0', locale: 'enUS', styles: {},
  sheetOrder: ['sheet-1'],
  sheets: { 'sheet-1': { id: 'sheet-1', name: 'Sheet1', rowCount: 100, columnCount: 26, cellData: {} } },
};

/**
 * Live co-editing for an .xlsx. The Sheets bridge replays an op-log in a Yjs array against each client's workbook, so
 * every client must start from the identical base. We make that base the FIRST log entry: the elected seeder imports
 * the stored file and publishes it as a snapshot record (the same record type the bridge's own compaction produces);
 * everyone else receives it through the SDK's `onSnapshot` and swaps to it before replaying anything else.
 * Until the room is live the grid is read-only, so nobody can type into a base that is about to be replaced.
 */
export function SheetsRoom({ fileId, grant, onStatus, onHandle }: RoomProps) {
  const writable = grant.role === 'editor';
  const storage = useMemo(() => apiRoomStorage(fileId), [fileId]);
  const apiRef = useRef<CasualSheetsAPI | null>(null);
  const collab = useRef<CollabHandle | null>(null);
  const ctl = useRef<RoomController | null>(null);
  const stopped = useRef(false);

  const exportBytes = useCallback(async (): Promise<ArrayBuffer> => (await apiRef.current!.exportXlsx()).arrayBuffer(), []);

  const onReady = useCallback((api: CasualSheetsAPI) => {
    if (apiRef.current) return;
    apiRef.current = api;
    api.setDocumentMode('viewing'); // locked until the room is live
    void import('@casualoffice/sheets/collab').then(({ attachCollab }) => {
      if (stopped.current) return;
      const h = attachCollab(api, {
        room: grant.room, server: collabSocketUrl(grant.path), token: grant.token, role: writable ? 'write' : 'view',
        onSnapshot: (wb) => { api.loadSnapshot(wb); },
      });
      collab.current = h;
      const c = new RoomController({
        doc: h.doc, awareness: h.provider.awareness as never, writable, storage, armOnInput: document,
        onStatus: (s, d) => {
          if (s === 'live' && writable) api.setDocumentMode('editing');
          onStatus(s, d);
        },
        io: {
          async prepareSeed(bytes) {
            const wb = await api.importXlsx(bytes); // loads it locally and returns the snapshot
            return () => {
              h.doc.getArray(OPS).push([{ kind: 'snapshot', c: String(h.doc.clientID), t: Date.now(), wb }]);
            };
          },
          exportBytes,
        },
      });
      ctl.current = c;
      onHandle({ flush: () => c.flush(), exportCopy: exportBytes });
      const sync = () => c.setConnection(h.provider.isConnected, h.provider.synced);
      h.provider.on('synced', sync); h.provider.on('status', sync); sync();
    });
  }, [grant, writable, storage, onStatus, onHandle, exportBytes]);

  useEffect(() => () => {
    stopped.current = true;
    ctl.current?.dispose(); ctl.current = null;
    collab.current?.detach(); collab.current = null;
    onHandle(null);
  }, [onHandle]);

  return (
    <CasualSheets
      initialData={BLANK as never} chrome="full" lazyPlugins locales={EMBED_LOCALES as never}
      ui={{ header: false, toolbar: false, footer: false, contextMenu: true }}
      onReady={onReady}
      style={{ width: '100%', height: '100%' }}
    />
  );
}
