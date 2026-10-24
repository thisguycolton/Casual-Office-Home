# Architecture proposal (draft — awaiting decisions in §6)

Status: **proposal.** Nothing here is built yet. It is derived from
[`phase1-reconnaissance.md`](./phase1-reconnaissance.md); read that first. Evidence tags
([ran]/[src]/[doc]) are defined there.

## 1. Constraints that shape the design

1. **No SSO exists.** No editor supports OIDC, trusted headers or an external IdP. The only
   hook is a host-minted HS256 JWT on collab's WOPI routes (Docs/Sheets only).
2. **Only 2 of 4 editors have a usable storage contract.** Docs and Sheets sit on the collab
   server (WOPI-style GetFile/PutFile). **Slides and PDF have no load/save hook at all.**
3. **Only 2 of 4 have a published image.** Slides and PDF must be built from source
   (Slides needs two submodules; PDF is a static SPA with no Dockerfile).
4. **The published Docs image cannot deep-link a stored file** and cannot write to `/data`
   as shipped (§4.1 of the recon). Sheets can.
5. **Collab's live-room layer is unauthenticated** (`/yjs`, `/api/rooms`, `/api/mcp-proxy`).
   It must never be directly reachable by users.
6. Upstream's own file manager (Drive) solved the same problem by embedding the editors as
   **npm SDKs** with a custom `FileSource` — not by launching the stock apps.

## 2. Options considered

### Option A — Stock images + collab/WOPI back end (the "four apps side by side" model)
Central app mints a JWT per open, redirects the browser to each editor's own origin; bytes
live in collab's storage (`<fileId>.<ext>`); central app copies bytes in/out.

| + | − |
| --- | --- |
| Reuses published images as-is | **Does not work for Docs** (blank editor) [ran] or **Slides/PDF** (no hook / no image) |
| Sheets round-trips today [ran] | Two copies of every file (central store vs collab store) → sync/conflict problem |
| | Editors on separate origins → login-less editor tabs; token in URL; `/yjs` etc. must be firewalled |
| | Shared JWT secret in two processes |

Verdict: **not viable as the whole answer**; it covers only Sheets cleanly.

### Option B — Central app owns the bytes; editors embedded as SDKs / built bundles (recommended)
One origin, one session cookie. Central app stores every file once. A thin "editor host
page" per type loads the editor and wires it to central-app endpoints
`GET /api/files/:id/content` and `PUT /api/files/:id/content` (cookie auth + CSRF +
ownership check + `If-Match` version). No JWT, no shared secret, no collab server, no
exposed `/yjs`.

| + | − |
| --- | --- |
| Single copy of each file; trash/rename/move/star are pure metadata ops | We must build 4 host pages (but they are small) |
| Real server-side authorization on every byte read/write | Docs/Sheets via npm SDK versions (`@casualoffice/docs` 1.4.2, `sheets` 0.20.0) — pinned, not "latest" |
| No unauthenticated collab surface at all | **Slides & PDF still lack a save-back hook** (see §3) |
| Mirrors upstream Drive's proven approach [src] | **No co-editing** (we'd be honest about it — acceptance criterion 15) |
| Smaller footprint: no 1.9 GB images for Docs/Sheets | Editor UI bundles built by us → we own build reproducibility |

### Option C — Option B + keep collab for optional co-editing
Same as B, plus a collab container whose `/yjs` is exposed **only** behind a proxy-level auth
check. Adds the unauthenticated-surface risk (§4.2/4.3) and a second copy of state. Defer:
revisit after B works; do not claim co-editing until verified.

## 3. The Slides / PDF problem (needs your decision)

| Approach | Effort | Result |
| --- | --- | --- |
| **3a. Manual round-trip** (no upstream changes): "Open in Slides" downloads/loads the `.pptx` in the stock app; user exports and re-uploads as a new version | Lowest | Honest but clunky; two-step save; easy to lose edits |
| **3b. Small carried patch per app** (`patches/*.patch` applied at build): add `?src=` load (PDF already has it) and an `onSave(bytes)` hook posting to our `PUT` endpoint | Medium; patch must be re-based on upgrades | Seamless Open→Edit→Save for all four |
| **3c. Upstream contribution** of the same hook | Medium + depends on maintainers | Cleanest long-term; slowest |

Recommendation: **3b, with 3c attempted**, falling back to 3a per-app if a patch proves
fragile. PDF is the cheapest (already loads `?src=`; needs only a save hook). Slides needs
a load hook *and* a save hook.

## 4. Proposed topology (Option B)

```
Internet ──443──▶ Caddy (TLS, HSTS, only published port; 80→443)
                    │
                    └──▶ app (Node + Fastify)         ← single origin
                          ├─ /            React SPA (file manager)
                          ├─ /api/*       JSON API: auth, files, folders, search, admin
                          ├─ /edit/docs   built @casualoffice/docs host page
                          ├─ /edit/sheets built @casualoffice/sheets host page
                          ├─ /edit/slides built Slides bundle (patched, §3)
                          └─ /edit/pdf    built PDF bundle (patched, §3)
                          │
                          ├─ SQLite (better-sqlite3) on volume  ← metadata only
                          └─ blob store on volume  /data/blobs/<aa>/<uuid>  ← content
```

- **Containers: 2** (`proxy`, `app`). No Redis, no collab, no Postgres, no MinIO. The four
  editors are static bundles served by `app`, not containers. (Requirement "separate
  containers for the four applications wherever appropriate": for Docs/Sheets/Slides/PDF
  this is **not** appropriate under Option B because they are client-side apps; we should
  say so rather than run idle containers.)
- If you prefer to keep stock Sheets as a container (Option A for Sheets only), it adds a
  1.96 GB image, a shared secret, a second copy of every `.xlsx`, and a firewalled collab
  surface — for no capability Option B lacks.
- **Database:** SQLite (single writer, WAL, volume-backed) fits "small VPS" and avoids a
  second stateful service. Postgres is a drop-in later if multi-instance is ever needed.
- **Blob store:** content-addressed by stable UUID (never by filename), atomic
  write-temp-then-rename, `fsync`, size limit, MIME sniff vs extension, per-user quota hook.

### Data model (sketch)
`users(id, email, password_hash, role, disabled, created_at)` ·
`files(id uuid, owner_id, parent_id, name, kind, mime, storage_key, size, version, sha256,
starred, trashed_at, created_at, updated_at, last_opened_at)` — folders are rows with
`kind='folder'` and null `storage_key` ·
`sessions` · `password_resets` · `audit_log`. File **versions** are an `If-Match` counter
plus optional previous-blob retention (a simple "keep last N" policy protects against a bad
editor save — recommended given upstream round-trip fidelity is partial).

### Authentication / authorization
- Argon2id (or bcrypt) password hashes; server-side sessions in SQLite; `HttpOnly`,
  `Secure`, `SameSite=Lax` cookie; double-submit CSRF token on mutating routes; login /
  reset rate limits; registration toggle `ALLOW_REGISTRATION`; first user (or
  `BOOTSTRAP_ADMIN_*` env) becomes admin; no default passwords.
- Every file endpoint resolves `owner_id == session.user` (or admin where explicitly
  allowed) **in the handler**, never in the UI. Deny returns 404 to avoid existence leaks.
- Editor pages load only from our origin; editor bytes only via the authenticated endpoints.
- **SSO status: none, and we will not claim it.** One login (to the central app) covers all
  editors *because they are embedded in it*, not because of identity federation — which is
  an honest, verifiable property.

### Format behaviour (defined, per requirement 3)
| Kind | Open | Notes |
| --- | --- | --- |
| `.docx` | Docs | `.odt/.md/.txt` import via Docs' own converter — stored as-is, converted copies are *new* files, never silent overwrites |
| `.xlsx` | Sheets | `.ods/.csv/.tsv` same rule |
| `.pptx` | Slides | Fidelity partial (68/87 probes upstream) — warn on first save |
| `.pdf` | PDF viewer/editor | Edits export a new PDF; original retained as previous version |
| images / text | Built-in preview | |
| other | Download only | clear "no editor for this type" panel |

Legacy `.doc/.xls/.ppt` are **not** supported by any editor [doc] → download only.

## 5. Security posture
- Only `proxy` publishes ports (80/443). `app` is `expose`-only on an internal network.
- Collab is **not deployed** (Option B), eliminating §4.2/4.3 by construction. If Option C is
  ever adopted: block `/api/mcp-proxy`, `/api/ai`, `/api/admin`, `/api/rooms*`; gate `/yjs`
  with proxy `forward_auth`.
- CSP (no inline script except hashed), `frame-ancestors 'none'`, `X-Content-Type-Options`,
  uploaded content served with `Content-Disposition: attachment` + sandboxed preview origin
  or strict `sandbox` CSP to prevent stored XSS from SVG/HTML uploads.
- Docker: non-root user, read-only root FS where possible, `no-new-privileges`, healthchecks,
  pinned image tags (never `:latest`), `restart: unless-stopped`, resource limits.
- Secrets only via `.env` (git-ignored) / Docker secrets; `.env.example` has none.

## 6. Decisions needed

1. **Integration model** — Option B (recommended) vs A (Sheets as stock container) vs C.
2. **Slides/PDF write-back** — 3a manual, 3b carried patches (recommended), or 3c upstream-only.
3. **Co-editing** — out of scope for v1 (recommended; we make no claim), or in scope
   (requires Option C and an authenticated `/yjs`).
4. **Adopt vs build** — build our own central app as specified (recommended: Drive is
   documents-only, immutable, no Trash/Starred/arbitrary files, no Slides), or evaluate
   adopting/forking Casual Drive.
5. **Stack default** — Node 22 + Fastify + React/Vite + SQLite (proposed; say if you prefer
   Postgres, or another language).

## 7. Phases (unchanged from the brief, now with entry gates)

| Phase | Deliverable | Gate |
| --- | --- | --- |
| 1 | Recon + this document | ✅ done, pending decisions above |
| 2 | `compose.yaml` (proxy + app), `.env.example`, health checks, volumes; editors built as static bundles | Fresh `docker compose up`; data survives recreate; **prove each editor bundle builds** |
| 3 | Auth, schema + migrations, file/folder API, uploads, trash/star/search, tests | Authz tests incl. cross-user denial |
| 4 | Editor host pages one at a time: Sheets → Docs → PDF → Slides | Create → edit → save → reopen, per type, in a real browser |
| 5 | UI polish, previews, backup/restore + upgrade docs, troubleshooting | Acceptance list from the brief |

Build risk is front-loaded into Phase 2: Slides (submodules, non-frozen lockfile, large
Univer fork) and PDF (Rust→WASM artefacts) have **never been built by us**.
