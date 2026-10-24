import type * as Y from 'yjs';

/**
 * Decides, atomically, which single client may seed a shared document from the stored file.
 *
 * Clients cannot safely decide this themselves: two people opening a file at the same instant would both see an
 * "unseeded" room and both write the full content, which Yjs would merge into a duplicated document.
 * Here the server (single-threaded per room) picks one writable candidate and publishes it in the shared `meta` map;
 * every client reads the same answer. If the chosen client vanishes or stalls, the next candidate is chosen.
 */
export interface Candidate { clientId: number; writable: boolean; canSeed: boolean }

export interface ArbiterState { bad: Set<number>; timer: ReturnType<typeof setTimeout> | null }

export const SEED_TIMEOUT_MS = 30_000;

export function arbitrate(meta: Y.Map<unknown>, live: Map<number, Candidate>, state: ArbiterState, transact: (fn: () => void) => void, onStall: () => void, timeoutMs = SEED_TIMEOUT_MS): void {
  if (meta.get('seeded')) { if (state.timer) { clearTimeout(state.timer); state.timer = null; } return; }
  const owner = meta.get('seedOwner') as number | undefined;
  const ownerOk = owner !== undefined && live.get(owner)?.writable === true && !state.bad.has(owner);
  if (ownerOk) return;
  const next = [...live.values()].filter((c) => c.writable && c.canSeed && !state.bad.has(c.clientId)).sort((a, b) => a.clientId - b.clientId)[0];
  if (!next) { if (owner !== undefined) transact(() => meta.delete('seedOwner')); return; }
  transact(() => meta.set('seedOwner', next.clientId));
  if (state.timer) clearTimeout(state.timer);
  state.timer = setTimeout(() => {
    state.timer = null;
    if (!meta.get('seeded') && meta.get('seedOwner') === next.clientId) { state.bad.add(next.clientId); onStall(); }
  }, timeoutMs);
  state.timer.unref?.();
}
