import { useCallback, useEffect, useMemo, useRef } from 'react';
import { CasualEditor, type CollabState } from '@casualoffice/docs';
import {
  DocumentAgent, fromProseDoc, injectReplyRangeMarkers, injectTCReplyRangeMarkers, parseDocx, proseSchema,
  setEndnotePlainText, setFootnotePlainText, toProseDoc,
} from '@casualoffice/docs/core';
import { prosemirrorToYXmlFragment, yXmlFragmentToProseMirrorRootNode } from 'y-prosemirror';
import '@casualoffice/docs/styles.css';
import { RoomController } from './collab/controller.ts';
import { apiRoomStorage, collabSocketUrl, colorFor } from './collab/storage.ts';
import type { RoomProps } from './collab/types.ts';

const FRAGMENT = 'prosemirror';
type AnyComment = { id: number } & Record<string, unknown>;

/**
 * Live co-editing for a .docx. The room (a Yjs document on the collab service) is the working copy; the stored file is
 * only read to seed an empty room and rewritten by the single elected leader (see collab/controller.ts).
 *
 * Saving does NOT use the editor's own export: with `externalContent` the editor never loads the original package
 * (styles, numbering, headers/footers, theme…), so its export would silently drop them. Instead the leader re-parses the
 * stored file and replaces only what the room owns — body, comments, footnote/endnote text — then repacks, the same
 * pieces and order the editor's single-user save uses.
 */
export function DocsRoom({ fileId, fileName, grant, userName, userId, onStatus, onHandle }: RoomProps) {
  const writable = grant.role === 'editor';
  const storage = useMemo(() => apiRoomStorage(fileId), [fileId]);
  const ctl = useRef<RoomController | null>(null);
  const state = useRef<CollabState | null>(null);
  const last = useRef({ connected: false, synced: false });

  const exportBytes = useCallback(async (): Promise<ArrayBuffer> => {
    const s = state.current!;
    const doc = s.metaMap.doc!;
    const { bytes } = await storage.read();
    const agent = await DocumentAgent.fromBuffer(bytes);
    const base = agent.getDocument();
    const pm = yXmlFragmentToProseMirrorRootNode(doc.getXmlFragment(FRAGMENT), proseSchema);
    base.package.document.content = fromProseDoc(pm, base).package.document.content;

    const comments: AnyComment[] = [];
    s.commentsMap.forEach((v) => { if (v && typeof v === 'object') comments.push(v as AnyComment); });
    comments.sort((a, b) => a.id - b.id);
    base.package.document.comments = comments as never;
    injectReplyRangeMarkers(base.package.document.content, comments as never);
    injectTCReplyRangeMarkers(base.package.document.content, comments as never);

    s.footnotesMap.forEach((text, id) => { const fn = base.package.footnotes?.find((f) => f.id === Number(id)); if (fn) { setFootnotePlainText(fn, text); fn.edited = true; } });
    s.endnotesMap.forEach((text, id) => { const en = base.package.endnotes?.find((e) => e.id === Number(id)); if (en) { setEndnotePlainText(en, text); en.edited = true; } });
    const props: Record<string, string> = {};
    s.propsMap.forEach((v, k) => { props[k] = v; });
    if (Object.keys(props).length) base.package.properties = { ...(base.package.properties ?? {}), ...props } as never;

    return agent.toBuffer();
  }, [storage]);

  const onCollabState = useCallback((s: CollabState) => {
    state.current = s;
    const doc = s.metaMap.doc!;
    if (!ctl.current) {
      ctl.current = new RoomController({
        doc, awareness: s.awareness as never, writable, storage, onStatus, armOnInput: document,
        io: {
          async prepareSeed(bytes) {
            const parsed = await parseDocx(bytes);
            const pm = toProseDoc(parsed);
            const comments = (parsed.package.document.comments ?? []) as unknown as AnyComment[];
            return () => {
              const frag = doc.getXmlFragment(FRAGMENT);
              if (frag.length) frag.delete(0, frag.length); // anything already there is an empty-editor placeholder
              prosemirrorToYXmlFragment(pm as never, frag);
              for (const c of comments) s.commentsMap.set(String(c.id), c as never);
            };
          },
          exportBytes,
        },
      });
      onHandle({ flush: () => ctl.current!.flush(), exportCopy: exportBytes });
    }
    const connected = s.status === 'connected';
    if (last.current.connected !== connected || last.current.synced !== s.synced) {
      last.current = { connected, synced: s.synced };
      ctl.current.setConnection(connected, s.synced);
    }
  }, [writable, storage, onStatus, onHandle, exportBytes]);

  useEffect(() => () => { ctl.current?.dispose(); ctl.current = null; onHandle(null); }, [onHandle]);

  // The editor must not run its own autosave in a room: only the leader writes, and only through the controller.
  const fileSource = useMemo(() => ({
    kind: 'personal' as const, label: 'Casual Office',
    async list() { return []; },
    async open() { return { bytes: new ArrayBuffer(0), name: fileName }; },
    async save(id: string | null) { return { id: id ?? fileId, etag: '' }; },
    async rename() {}, async delete() {}, watchRecent() { return () => {}; },
    async rememberLastOpened() {}, async lastOpened() { return null; },
  }), [fileId, fileName]);

  return (
    <CasualEditor
      fileSource={fileSource as never} docId={fileId}
      documentMode={writable ? 'editing' : 'viewing'}
      collab={{ server: collabSocketUrl(grant.path), room: grant.room, token: grant.token, user: { name: userName, color: colorFor(userId) } }}
      onCollabState={onCollabState}
    />
  );
}
