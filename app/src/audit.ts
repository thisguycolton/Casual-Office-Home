import type { Db } from './db.ts';
export function audit(db: Db, userId: string | null, action: string, target?: string, ip?: string): void {
  db.prepare('INSERT INTO audit_log (ts,user_id,action,target,ip) VALUES (?,?,?,?,?)').run(Date.now(), userId, action, target ?? null, ip ?? null);
}
