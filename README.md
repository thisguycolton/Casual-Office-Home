# Self-Hosted Productivity Suite

A private, self-hosted alternative to Google Workspace built around four open-source
CasualOffice editors (Docs, Sheets, Slides, PDF) behind one login and one file manager.

**Status: Phase 2 (infrastructure) complete.** The stack builds and runs, and all four editors
are served through the reverse proxy. The file manager, login and editor integration are
**not built yet** (Phases 3–4); `/` is a placeholder page. Single sign-on, collaborative editing
and cross-format compatibility are **not** claimed until verified.

- [`docs/phase1-reconnaissance.md`](docs/phase1-reconnaissance.md) — what the upstream projects really do, and their defects.
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

## Known limitations (Phase 2)
- Slides and PDF still load **Google Fonts** at runtime (UI/icon fonts). Not private/offline-safe yet.
- PDF also fetches optional text-edit fonts from jsdelivr on demand.
- Backup/restore, troubleshooting and upgrade guides arrive in Phase 5.
- Tags `22.23.4-*` (Node) in the Dockerfile were not pulled during development (registry rate
  limit); the build was verified with the equivalent `22-*` tags.
