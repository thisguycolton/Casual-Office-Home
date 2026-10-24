import type { Config } from '../config.ts';
import { signToken, type CollabRole } from './token.ts';

/** Talks to the internal collab service: mints room tokens and revokes access. Inert when co-editing is not configured. */
export class CollabClient {
  private readonly cfg: Config;
  constructor(cfg: Config) { this.cfg = cfg; }
  get enabled(): boolean { return this.cfg.collabSecret !== ''; }

  mint(user: { id: string; displayName: string }, fileId: string, role: CollabRole): { token: string; expiresAt: number } {
    const exp = Math.floor((Date.now() + this.cfg.collabTokenTtlMs) / 1000);
    return { token: signToken(this.cfg.collabSecret, { sub: user.id, name: user.displayName, file_id: fileId, role, exp, purpose: 'room' }), expiresAt: exp * 1000 };
  }

  /**
   * Immediately disconnect a user (or everyone) from a file's live room. Best effort: a failure is logged, never thrown,
   * because the durable control is the app's own authorization; this only ends sessions that are already open.
   */
  async kick(fileId: string | null, userId?: string): Promise<void> {
    if (!this.enabled) return;
    try {
      const token = signToken(this.cfg.collabSecret, { sub: 'app', name: 'app', file_id: fileId ?? '-', role: 'editor', exp: Math.floor(Date.now() / 1000) + 60, purpose: 'kick' });
      await fetch(`${this.cfg.collabInternalUrl}/internal/kick`, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ file_id: fileId ?? undefined, user_id: userId }), signal: AbortSignal.timeout(3000),
      });
    } catch (err) { console.warn('[collab] revoke failed (open sessions may linger until reconnect):', (err as Error).message); }
  }
}
