/**
 * Operator CLI. Run inside the container:
 *   docker compose exec -T app node dist/cli.js create-admin you@example.com   < password.txt
 *   docker compose exec -T app node dist/cli.js reset-password you@example.com < password.txt
 *   docker compose exec -T app node dist/cli.js list-users
 * Passwords are read from stdin (first line) so they never appear in argv or shell history.
 */
import { loadConfig } from './config.ts';
import { openDb } from './db.ts';
import { checkPasswordPolicy, hashPassword } from './auth/passwords.ts';
import { destroyUserSessions } from './auth/sessions.ts';
import { createUser, findByEmail, validateEmail } from './auth/users.ts';

async function readPassword(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8').split(/\r?\n/)[0] ?? '';
}

export async function main(argv: string[]): Promise<number> {
  const [cmd, emailArg] = argv;
  const config = loadConfig();
  const db = openDb(config.dbPath, config.migrationsDir);
  try {
    if (cmd === 'list-users') {
      for (const r of db.prepare('SELECT email, role, disabled FROM users ORDER BY created_at').all() as { email: string; role: string; disabled: number }[]) {
        console.log(`${r.email}\t${r.role}${r.disabled ? '\tdisabled' : ''}`);
      }
      return 0;
    }
    if (cmd === 'create-admin' || cmd === 'reset-password') {
      if (!emailArg) throw new Error(`usage: ${cmd} <email>   (password on stdin)`);
      const email = validateEmail(emailArg);
      const password = checkPasswordPolicy(await readPassword());
      if (cmd === 'create-admin') {
        await createUser(db, { email, password, role: 'admin', displayName: 'Administrator' });
        console.log(`created administrator ${email}`);
      } else {
        const u = findByEmail(db, email);
        if (!u) throw new Error(`no such user: ${email}`);
        db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(await hashPassword(password), Date.now(), u.id);
        destroyUserSessions(db, u.id);
        console.log(`password reset for ${email}; all sessions revoked`);
      }
      return 0;
    }
    console.error('commands: create-admin <email> | reset-password <email> | list-users');
    return 2;
  } catch (err) {
    console.error(`error: ${(err as Error).message}`);
    return 1;
  } finally { db.close(); }
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(await main(process.argv.slice(2)));
