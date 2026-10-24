# Architecture

Status: **Phases 1–3 done** (recon, infrastructure, accounts + file manager). Phase 4 (editor integration) is next.
Derived from [`phase1-reconnaissance.md`](./phase1-reconnaissance.md) — read it first.
Evidence tags **[ran] / [src] / [doc]** are defined there.

## 1. Decisions (confirmed with the project owner)

| # | Decision | Consequence |
| --- | --- | --- |
| D1 | **Embed the editors; the central app owns all bytes** (not four stock containers) | One origin, one session cookie, one copy of each file, no shared JWT secret |
| D2 | **Slides and PDF get write-back via small carried build patches** (try to upstream) | We build those two from source at pinned commits and maintain patches |
| D3 | **Build our own central app** (not Casual Drive/Doc-Hub) | Drive is documents-only, immutable, no Trash/Starred/arbitrary files, no Slides |
| D4 | **Real-time co-editing for Docs/Sheets is in scope** | ⚠ Conflicts with the verified embed route — see §5. Sequenced as a later phase |
| D5 | Default stack (not yet confirmed — shout if you disagree): Node 22 + Fastify + React/Vite + SQLite | Two containers, no extra services |

## 2. Why embed, not stock images (evidence)

- Only Sheets round-trips through the stock image; Docs' image opens a blank doc from a token
  URL and cannot write to `/data`; Slides/PDF have no image [ran].
- Both npm packages ship a prebuilt iframe bundle that loads and saves through the *host*
  via `postMessage`. A proof of concept ([`spikes/embed-poc`](../spikes/embed-poc/README.md))
  loaded a real `.docx` and `.xlsx` through a cookie-authenticated endpoint, edited them in
  Chromium, and the stored files contained the edits (and the Sheets formula survived)
  [ran — recon §7].
- Upstream's own file manager embeds the same two packages the same way [src].
- This removes the unauthenticated collab surface (`/yjs`, `/api/rooms`, `/api/mcp-proxy`,
  `/api/ai`, `/api/admin`) entirely, and removes ~3.9 GB of container images.

## 3. Topology

```
Internet ──443──▶ Caddy (TLS, HSTS; the only published ports 80/443)
                    └──▶ app  (Node 22 + Fastify)              single origin
                          /               React SPA — file manager
                          /api/*          JSON API: auth, files, folders, search, admin
                          /editors/docs   npm @casualoffice/docs embed bundle (pinned)
                          /editors/sheets npm @casualoffice/sheets embed bundle (pinned)
                          /editors/slides Slides build (patched, §4)
                          /editors/pdf    PDF build (patched, §4)
                          │
                          ├─ SQLite (WAL) on volume   metadata only
                          └─ blobs on volume          /data/blobs/<aa>/<uuid>
```

- **2 containers (`proxy`, `app`).** The editors are client-side static bundles, so the brief's
  "separate containers for the four applications" is deliberately **not** followed: running
  four idle containers would add cost and attack surface for no capability. This departure is
  intentional and should be confirmed.
- SQLite fits a small VPS and avoids a second stateful service; Postgres is a later drop-in.
- Editors run in **sandboxed same-origin iframes** served from `/editors/*` with a strict CSP
  (`frame-ancestors 'self'`); the host page is the only message peer.

### 3.1 Per-editor integration contract

| Editor | Source | Editor → host | Host must |
| --- | --- | --- | --- |
| **Docs** | npm `@casualoffice/docs@1.4.2` embed | `.docx` bytes via `save.request` (autosave **30 s**) | Serve `embed-runtime.mjs` under the name `embed.html` imports; serve `dist/fonts/` at `/editors/fonts/`; treat `casual.error` after a successful load as non-fatal; flush on unload is **not possible** (no host save command) → accept ≤30 s loss window or patch (see §4) |
| **Sheets** | npm `@casualoffice/sheets@0.20.0` embed | Univer snapshot via `save.notify` (only on Ctrl+S / `command.save` / exit) | Poll `command.save` (interval + `pagehide`), convert with `workbookDataToXlsx` (bundle `@univerjs/core@0.25`, `exceljs@4.4.0`, `jszip` + exporter worker), PUT bytes |
| **Slides** | Build `CasualOffice/slides` at pinned SHA + patch | patch adds `load(src)` + `onSave(bytes)` | Provide authenticated content endpoints |
| **PDF** | Build `CasualOffice/pdf` at pinned SHA (+ patch) | already loads `?src=`; patch adds `onSave(bytes)` | same |

The host page implements one small `EditorHost` interface (`load`, `save`, `flush`, `dispose`)
with one adapter per editor, so any editor can be upgraded or replaced in isolation.

## 4. Slides / PDF carried patches (D2)

Patches live in `patches/<app>/*.patch`, applied by the editor Dockerfile stage against a
**pinned commit**; a CI check fails if a patch no longer applies. Minimum surface:
`?src=<same-origin-url>` (load) and a `postMessage`/callback `save(bytes)` hook, mirroring the
Docs/Sheets envelope so all four share one host protocol. Upstream PRs are attempted in
parallel. Fallback per app if a patch proves fragile: manual export → re-upload as a new
version (documented, not hidden).
Known build risks (never built by us yet): Slides needs two submodules whose `.gitmodules` use
SSH URLs (repos are public over https) and installs with `--no-frozen-lockfile`; PDF needs
its design-system submodule and ships prebuilt WASM artefacts.

## 5. Co-editing (D4) — conflict with the embed route

Verified: **neither embed bundle has any collaboration** [ran/src]. Real-time co-editing needs
the non-embed SDK path (`CasualEditor collab={…}`, `@casualoffice/sheets/collab`) plus the
Hocuspocus/Yjs collab server, which today is unauthenticated at `/yjs` (any client that names
a room can join; `?role=edit` grants write) [src]. Delivering it safely requires:

1. A carried patch to `collab` so `onAuthenticate` verifies a per-file, short-lived JWT minted
   by our app (and binds `documentName` to the token's `file_id`) — URL-only checks are not
   enough because Hocuspocus carries the room name inside the protocol, not the URL.
2. Collab on an internal-only network; `/yjs` reachable only through our authenticated proxy;
   `/api/mcp-proxy`, `/api/ai`, `/api/admin`, `/api/rooms*` not routed.
3. A single-writer rule for persisting `.docx/.xlsx` bytes from a live room (otherwise every
   client autosaves and the last writer wins), plus conflict handling with `If-Match`.
4. A rebuilt host page using the full SDK (≈40 Univer peer deps for Sheets) instead of the
   prebuilt embed bundle.

**Sequencing:** ship single-editor Docs/Sheets via the verified embed route first
(Phases 2–5), then co-editing as **Phase 6** with its own gate. Until Phase 6 passes, the
product makes **no collaboration claim** (acceptance criterion 15).

## 6. Data model, auth, formats

- `users(id, email, password_hash, role, disabled, created_at)` ·
  `files(id uuid, owner_id, parent_id, name, kind, mime, storage_key, size, version, sha256,
  starred, trashed_at, created_at, updated_at, last_opened_at)` (folders: `kind='folder'`,
  null `storage_key`) · `sessions` · `password_resets` · `audit_log`.
- Content stored by UUID (never by filename), atomic temp-write + rename + fsync, size limit,
  magic-byte vs extension check. Keep the last *N* blob versions per file: upstream
  round-trips are lossy for complex files, so a bad save must be recoverable.
- **Auth:** Argon2id; server-side sessions; `HttpOnly; Secure; SameSite=Lax` cookie; CSRF
  token on mutating routes; login/reset rate limits; `ALLOW_REGISTRATION` toggle; first
  user or `BOOTSTRAP_ADMIN_*` becomes admin; no default passwords. Every file handler checks
  `owner_id` server-side; other users' files return 404.
- **SSO:** none exists in any editor, and none is claimed. One login covers all editors
  because they are embedded in our origin — not because of identity federation.
- **Formats:** `.docx`→Docs, `.xlsx`→Sheets, `.pptx`→Slides, `.pdf`→PDF, images/text→
  built-in preview, everything else (incl. legacy `.doc/.xls/.ppt`)→download-only panel.
  Format conversions (e.g. `.odt`, `.csv`) create a **new** file; never overwrite silently.
  Slides fidelity is partial upstream (68/87 probes) → warn before first save.

## 7. Security posture
- Only `proxy` publishes ports. `app` is internal. Pinned image tags; non-root; `no-new-privileges`;
  healthchecks; `restart: unless-stopped`; resource limits.
- CSP, `frame-ancestors`, `nosniff`; uploads served `Content-Disposition: attachment`, and
  previews sandboxed (SVG/HTML upload ⇒ stored-XSS vector).
- Secrets only via `.env` / Docker secrets; `.env.example` has none.

## 8. Phases and gates

| Phase | Deliverable | Gate |
| --- | --- | --- |
| 1 | Recon + this document | ✅ |
| 2 | `compose.yaml`, `.env.example`, Dockerfile(s), health checks, volumes; **all four editor bundles built and served** | ✅ Verified: stack up, each editor loads over the proxy, data survives recreate |
| 3 | Auth, schema + migrations, files/folders API, uploads, trash/star/search, UI, tests | ✅ 44 backend tests incl. cross-user denial; browser journey passes; persistence verified through the proxy |
| 4 | Editor host pages: Sheets → Docs → PDF → Slides | Create → edit → save → reopen, per type, in a real browser |
| 5 | UI polish, previews, backup/restore + upgrade docs, troubleshooting | Brief's acceptance list (minus co-editing) |
| 6 | Co-editing for Docs/Sheets (§5) | Authenticated `/yjs`, two-browser edit test, save-ownership rule |
