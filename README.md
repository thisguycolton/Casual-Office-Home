# Self-Hosted Productivity Suite

A private, self-hosted alternative to Google Workspace built around four open-source
CasualOffice editors (Docs, Sheets, Slides, PDF) behind one login and one file manager.

**Status: Phase 4 in progress — Docs and Sheets are integrated; PDF and Slides are next.** You can sign in, create folders, upload,
rename, move, star, trash/restore, search, sort and browse files in a Google-Drive-style UI.
**Documents and spreadsheets open in the embedded Docs and Sheets editors and save back to your file** (see
[`docs/editors.md`](docs/editors.md) for exactly how, and its limits). **PDF and Slides are not connected yet:** opening them
shows a preview page with a download button, and says so. Single sign-on, collaborative editing and
cross-format compatibility are **not** claimed until verified.

- [`docs/phase1-reconnaissance.md`](docs/phase1-reconnaissance.md) — what the upstream projects really do, and their defects.
- [`docs/editors.md`](docs/editors.md) — how each editor saves, what is verified, and its limits.
- [`docs/architecture.md`](docs/architecture.md) — decisions, topology, per-editor integration contract, phases.
- [`spikes/embed-poc`](spikes/embed-poc/README.md) — reproducible proof of the Docs/Sheets embed route.

## Run it

Requires Docker with Compose v2 and outbound HTTPS during the build.

```sh
cp .env.example .env            # edit SITE_ADDRESS etc.; .env is git-ignored
docker compose --env-file .env --env-file editors/pins.env up -d --build   # build + start
docker compose --env-file .env --env-file editors/pins.env ps              # health
docker compose --env-file .env --env-file editors/pins.env down             # stop (data kept)
```

### First sign-in
Set `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD` (≥12 chars) in `.env` before the first start,
then **remove the password from `.env`** afterwards. Or, with the stack running:
```sh
printf '%s' 'a long passphrase' | docker compose --env-file .env --env-file editors/pins.env exec -T app node dist/cli.js create-admin you@example.com
```
Public registration is **off** (`ALLOW_REGISTRATION=false`); admins add users under *Administration*.
There is no email service: to reset a password an admin generates a one-time link for the user
(or run `... exec -T app node dist/cli.js reset-password user@example.com` with the password on stdin).
`SECURE_COOKIES` defaults to `true`; set it to `false` only for plain-HTTP testing on a non-localhost address.

Local test: leave `SITE_ADDRESS=:80`, open `http://localhost`. Production: set
`SITE_ADDRESS=office.example.com` (DNS pointing at the host, ports 80/443 open) and Caddy obtains
a certificate automatically. Only the proxy publishes ports; the `app` container sits on an
internal network with no route to the internet, runs as non-root with a read-only filesystem.

First build is slow (Slides compiles a large Univer fork; budget ~5 min and ~4 GB RAM).

### Upgrading an upstream editor
Edit `editors/pins.env` (Slides/PDF commit SHAs) or `editors/npm/package.json` (+ regenerate the
lockfile) and rebuild. A carried patch in `patches/<app>/` that no longer applies **fails the
build** — by design. Data lives in the `app-data` volume and survives rebuilds.

### Carried patches
| Patch | Why |
| --- | --- |
| `patches/pdf/0001` | PDF fetched `pdfium.wasm` from cdn.jsdelivr.net at runtime; serve our bundled copy |
| `patches/pdf/0002` | PDF hard-coded `/logo.svg`, 404 under a sub-path |

## Develop and test
```sh
cd app && npm ci && npm run typecheck && npm test      # 45 tests: auth, CSRF, sessions, files, trash, versions, limits, cross-user denial
cd web && npm ci && npm run typecheck && npm test && npm run build
node tests/e2e/ui.cjs                                   # Playwright UI journey against a FRESH running instance (see header comment)
node tests/e2e/editors.cjs                              # create → edit → save → verify bytes → reopen → conflict, for Docs and Sheets (~3 min)
```
Backend: Node 22 + Fastify, SQLite (`node:sqlite`, flagged *experimental* by Node — isolated in `app/src/db.ts`),
migrations in `app/migrations/`, file bytes on the data volume as `blobs/<aa>/<uuid>` (names never touch the filesystem).

## What is enforced on the server
Argon2id passwords; session tokens stored only as hashes; `HttpOnly` + `SameSite=Lax` (+ `Secure`) cookie; every
state-changing request needs a same-origin `Origin` **and** the per-session CSRF token; per-account login throttling
plus per-IP rate limits; every file query is scoped to the owner and returns 404 for anything else (administrators
cannot read other users' files); uploads are streamed, size/quota-limited, magic-byte checked and cleaned up on failure;
uploaded content is never rendered inline except images/PDF/text, always with `nosniff` and a sandboxing CSP.

## Known limitations
- **Shared Files** is a placeholder: there is no sharing feature; files are private to their owner.
- Dragging a *folder* from the desktop to upload is not supported (drop files, or use Upload).
- Copy works for files only (not folders). No email: password resets are admin-issued links.
- Folder moves/renames are not versioned; only file content keeps previous versions (`KEEP_VERSIONS`).
- All four editors still load **Google Fonts** at runtime (UI/icon fonts). Not private/offline-safe yet.
- PDF also fetches optional text-edit fonts from jsdelivr on demand.
- Backup/restore, troubleshooting and upgrade guides arrive in Phase 5.
- Tags `22.23.4-*` (Node) in the Dockerfile were not pulled during development (registry rate
  limit); the build was verified with the equivalent `22-*` tags.
