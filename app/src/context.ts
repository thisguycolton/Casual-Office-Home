import '@fastify/cookie';
import '@fastify/rate-limit';
import type { Config } from './config.ts';
import type { Db } from './db.ts';
import type { BlobStore } from './files/blobs.ts';

/** Everything handlers need. Built once in server.ts and attached to the Fastify instance. */
export interface Ctx { config: Config; db: Db; blobs: BlobStore }

export interface User {
  id: string;
  email: string;
  displayName: string;
  role: 'user' | 'admin';
  disabled: boolean;
}
export interface AuthInfo { user: User; csrfToken: string; sessionHash: string }

declare module 'fastify' {
  interface FastifyInstance { ctx: Ctx }
  interface FastifyRequest { auth: AuthInfo | null }
}
