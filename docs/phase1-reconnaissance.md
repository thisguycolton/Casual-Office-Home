# Phase 1 — Repository Reconnaissance

Findings from inspecting the four upstream projects (plus the shared collab server and the
related Drive project) **before** designing anything. Every claim carries an evidence tag:

| Tag | Meaning |
| --- | --- |
| **[ran]** | Observed by running the published image / a real browser during this recon |
| **[src]** | Read directly from source code at the pinned commit (not exercised at runtime) |
| **[doc]** | Stated in upstream docs/README only; not independently verified |

Where upstream docs and observed behaviour disagree, observed behaviour wins and the
disagreement is called out.

## 1. What was inspected

| Project | Repo commit | Published artefact |
| --- | --- | --- |
| Docs | `CasualOffice/docs@77e9530` (2026-09-20) | Image `casualoffice/docs:0.0.5` = `:latest`, built from `7b03e11` (2026-07-07). npm `@casualoffice/docs@1.4.2` (MIT) |
| Sheets | `CasualOffice/sheets@87a6390` (2026-08-28) | Image `casualoffice/sheets:latest` (label `0.3.4`, built from `11182a2`). npm `@casualoffice/sheets@0.20.0` (Apache-2.0) |
| Slides | `CasualOffice/slides@2762698` (2026-08-02) | **None.** No Docker Hub image, no npm package |
| PDF | `CasualOffice/pdf@94afefb` (2026-07-31) | **None.** No Docker Hub image, no npm package, no Dockerfile |
| collab (shared server) | `CasualOffice/collab@eb89e3e` (2026-07-10) | **No image** under `casualoffice/collab`; the Docs/Sheets images embed it |
| Drive / "Doc-Hub" (related) | `CasualOffice/drive@b417265` (2026-07-19) | Image `casualoffice/dochub` (0.0.1) |

Image digests pulled: docs `sha256:0f989241…bcf31`, sheets `sha256:4700dd5d…bced56`.
Both images are **~1.9 GB** on disk (matters for a small VPS).

Probe: docs and sheets images were run with `CASUAL_JWT_SECRET` set and `CASUAL_STORAGE=local`;
the WOPI endpoints were exercised with curl, and the editors were driven in headless Chromium
(Playwright).

## 2. Summary matrix

| Capability | Docs | Sheets | Slides | PDF |
| --- | --- | --- | --- | --- |
| Ready-made Docker image | **Yes** (0.0.5) [ran] | **Yes** (0.3.4) [ran] | **No** — build from source [src] | **No** — static SPA, no Dockerfile [src] |
| Build from source works with public repos only | Likely (submodules are public) [not built] | Likely [not built] | Needs `univer-revamp` + `design-book` submodules (public over https) [not built] | Needs `vendor/design-system` submodule [not built] |
| Native format | `.docx` (+`.odt`, `.md`, `.txt`) [doc] | `.xlsx` (+`.ods`, `.csv`, `.tsv`) [doc] | `.pptx` [doc] | `.pdf` |
| Server-side persistence by itself | Via collab host (`local`/`s3`/`postgres`) [ran, with bug §4.1] | Via collab host [ran] | **None** — in-memory relay only [src] | **None** [src] |
| Open a stored file from a token URL | **Does not work in the image** — opens blank "Untitled" [ran] | **Works**, but user must click "Open" on a banner [ran] | No mechanism [src] | `?src=<url>` fetches a PDF [src] |
| Save back to a host | Possible via SDK `FileSource` [src]; not wired in the image [ran] | **Works** — Ctrl+S → `POST /wopi/files/:id/contents` [ran] | No mechanism [src] | No — "Download changes" only [src] |
| Host-owned load/save via npm iframe embed (§7) | **Works** — bytes over `postMessage`, autosave 30 s [ran] | **Works** — snapshot over `postMessage`, host converts to `.xlsx` [ran] | Not available | Not available |
| JWT / WOPI host surface | Yes (collab) [ran] | Yes (collab) [ran] | No [src] | No [src] |
| OIDC / SSO / trusted-header auth | **None** [src] | **None** (OIDC/SAML config is a stub) [doc] | None | None |
| Real-time co-editing | Yes, in image [doc]; not tested | Yes, in image [doc]; not tested | Spike only, single-active-editor [doc] | Planned, via collab [doc] |
| Embeddable SDK | `@casualoffice/docs` (`<CasualEditor fileSource docId>`) [src] | `@casualoffice/sheets` (`<CasualSheets initialData onChange>`) [doc] | None | `packages/pdf-sdk` in repo, not published [src] |
| Maturity stated by upstream | Working editor | "0.x, production-ready for small deployments" | "v0.1.0", co-edit is a spike | **"Planning"** (README) — but `apps/web` has real code |

## 3. Per-application findings

### 3.1 Docs (`.docx`)
- Stack: React + ProseMirror (Bun toolchain) SPA, served by the Node collab server
  (Hocuspocus + Yjs on Fastify) in one container on port **8080** [src].
- Image runs as non-root user `casual` (uid 999) [ran].
- Env: `PORT`, `HOST`, `CASUAL_FILE_EXT=.docx`, `CASUAL_STORAGE`, `CASUAL_LOCAL_PATH`,
  `CASUAL_JWT_SECRET`, `REDIS_URL`, `CASUAL_REDIS_PREFIX`, `CASUAL_PERSONAL_MODE`,
  `TRUST_PROXY`, `CORS_ORIGINS`, `MAX_UPLOAD_MB`, `RATE_LIMIT_*` [src]. The repo's referenced
  `docs/internal/12-env-vars.md` **does not exist**.
- **Token deep-link does not work in the published image** [ran]: loading
  `/doc/<id>?access_token=<valid JWT>` serves the SPA but the editor shows a blank
  "Untitled" document and issues **zero** WOPI requests. The `WopiFileSource` code exists in
  the SDK package but the demo app the image serves does not call it.
- The iframe `postMessage` embed protocol (`/embed`) is documented as a "design contract"
  but the route is a scaffold ("Iframe embed scaffold ready") [src]. Not usable.
- The reliable integration path is the **SDK**: `<CasualEditor fileSource={…} docId={…}/>`
  loads bytes via `fileSource.open()` and saves via `fileSource.save()` client-side, "no WS
  server" needed [src]. This is exactly how upstream's own Drive embeds it (§3.6).
- Upstream README/CLAUDE.md contain historical text about a removed Go gateway; ignore it.

### 3.2 Sheets (`.xlsx`)
- Stack: React + Univer OSS SPA, Fastify + Hocuspocus server, port **3000**; image starts as
  root then drops privileges via `su-exec` after fixing `/data` ownership [src].
- **Token flow verified end to end** [ran]: `PUT` a real `.xlsx` via
  `POST /wopi/files/:id/contents` → open `/?access_token=<JWT>` → editor calls CheckFileInfo,
  then (after clicking **Open** on the "Pick up where you left off" banner) GetFile → edit →
  Ctrl+S → `POST …/contents`. Stored file grew 4 854 → 7 343 bytes.
- Not tested: whether autosave alone (without Ctrl+S) writes back; round-trip fidelity of
  non-trivial workbooks; co-editing.
- Version mismatch to be aware of: image label `0.3.4` vs npm SDK `0.20.0`.

### 3.3 Slides (`.pptx`)
- Stack: React + Univer Slides (patched via pnpm patches), 125-line `ws` relay + static host,
  port **3000** [src]. No Redis, no DB.
- **No persistence, no WOPI, no JWT, no admin, no auth** — README roadmap says these are
  "post-v0.1"; source confirms nothing exists [src].
- File I/O is browser-side only: open a `.pptx` via file picker, autosave to IndexedDB,
  export `.pptx` (PptxGenJS) / PDF / PNG. **No URL parameter or host hook to load or save
  bytes** [src].
- **No published image.** The Dockerfile `COPY`s two git submodules (`univer-revamp`,
  `design-book`) whose `.gitmodules` URLs are `git@github.com:…` (SSH) though the repos are
  publicly readable over https. Build uses `pnpm install --no-frozen-lockfile` (non-reproducible)
  and was **not** built during recon.
- Fidelity is stated as partial (68/87 probes). Collab is a single-active-editor spike.

### 3.4 PDF
- Static Vite + React SPA (`apps/web`) over `packages/pdf-sdk` and a Rust→WASM core
  (`crates/casual-pdf-core`); PDFium-WASM engine [src]. Deployed upstream to GitHub Pages.
- README says "planning docs only / no code yet" but the repo contains a working-looking app
  (viewer, signing, redaction, page ops, text editing, forms, AI panel) [src]. The README is
  stale; the actual capability level is **unverified** (not run).
- `?src=<url>` makes it `fetch()` a PDF; edits are exported with **"Download changes"** —
  there is no save-back-to-server hook [src]. `?room=`/`?collab=` enable co-editing against a
  collab server [src].
- **No Dockerfile, no image.** Needs a build (pnpm + Rust→WASM artefacts are committed as
  `casual_pdf_core_bg.wasm`) and a static file server.

### 3.5 Shared collab server (`CasualOffice/collab`)
This is the real backend inside the Docs and Sheets images. Source is public; the `collab/`
submodule in the Docs/Slides repos is empty on a plain clone.

- **Storage host** (`CASUAL_STORAGE=local`): `<root>/<fileId>.<ext>` + `<fileId>.meta.json`
  sidecar; non-atomic write, no fsync [src]. Alternatives: `s3`, `postgres`, `memory`.
- **WOPI-style API** (all [ran]): `GET /wopi/files/:id` (CheckFileInfo),
  `GET|POST /wopi/files/:id/contents`. PutFile honours `X-WOPI-ItemVersion` as If-Match
  → `409 version_mismatch`.
- **JWT** (HS256 only, shared secret `CASUAL_JWT_SECRET` ≥ 16 chars): required claims
  `sub`, `file_id`, `role` (`admin|editor|commenter|viewer`); optional `permissions`,
  `features`, `display_name`, `exp`. Verified [ran]: no token → 401; wrong secret → 401;
  `alg=none` → 401; token for file B on file A → 403; `viewer` PutFile → 403.
- Personal accounts (`CASUAL_PERSONAL_MODE`), share links, admin panel exist but are **not
  needed** if our central app owns identity.

### 3.6 Related: Casual Drive / "Doc-Hub" (`CasualOffice/drive`)
- Rust (Axum-style) file hub, Apache-2.0, **0.0.1**, "documents only" ingest gate,
  AES-256-GCM encryption at rest, immutable hash-chained versions [doc].
- Embeds `@casualoffice/docs@1.4.2` and `@casualoffice/sheets@0.20.0` **via npm SDK** with a
  custom `DriveFileSource` [src]. Has **no Slides support**; PDF is not an npm package.
- Its compose pins `casualoffice/docs:v0.0.5` as a collab gateway and wires
  `CASUAL_JWT_SECRET` = Drive's WOPI HMAC secret [doc].
- Scope differs from this project's requirements (documents-only, no Trash/Starred/arbitrary
  files, immutable-forever history). Useful as a **reference implementation**, not a drop-in.

## 4. Defects and security findings in upstream

### 4.1 Docs image cannot write to `/data` as shipped  [ran]
`PutFile` against `casualoffice/docs:0.0.5` with `CASUAL_STORAGE=local` returns
`500 EACCES: permission denied, mkdir '/data'`. The image runs as uid 999 and neither creates
nor chowns `/data`; its entrypoint does no ownership fix (unlike Sheets). A named volume
mounted at `/data` is root-owned, so it fails too. Needs a workaround (init step to chown, or
override user) — see architecture doc.

### 4.2 `/yjs` WebSocket does not validate the JWT  [src]
`onAuthenticate` (`collab/src/yjs.ts`) consults only `?share=` tokens (personal-mode share
links). With no share token it accepts **any** connection; `?role=edit` (or `write`) grants
write access, any other/absent role is read-only. Room name = whatever the client sends.
So the WOPI JWT protects file *bytes at rest*, but **live rooms are protected only by an
unguessable room id**. If co-editing were enabled and `/yjs` exposed, anyone who learns or
guesses a room name could read and edit it. (Not exercised with a live WS client.)

### 4.3 Unauthenticated endpoints  [ran/src]
- `GET /api/rooms` returns the live room list with no auth [ran].
- `POST /api/mcp-proxy` is an **unauthenticated server-side HTTP proxy** (blocks only
  *literal* private hostnames; DNS names resolving to private IPs are not checked) [src].
- `/api/ai` WebSocket, `/api/admin/*`, `/api/rooms/:id/seed|snapshot` (upload) are all
  reachable by anyone who can reach the container [src].
- CORS reflects any origin unless `CORS_ORIGINS` is set [src]. `TRUST_PROXY=true` is needed
  behind a proxy or rate limiting buckets all users together [src].

### 4.4 Token handling  [src/doc]
Tokens ride in the URL query. Docs' SDK strips `access_token` from the address bar after
capture; Sheets' behaviour was not checked. HS256 with one shared secret means any holder
can mint tokens for any file — the secret must exist only in the central app and the
editor's collab process, never in a browser.

### 4.5 No shared authentication anywhere  [src]
None of the four apps (or collab) supports OIDC, trusted-proxy headers, or any external IdP.
Sheets documents OIDC/SAML as stubs. The only external-identity mechanism is the
host-minted HS256 JWT above. **There is no single sign-on.** The central app must
enforce authentication itself and treat the editors as untrusted-by-default back ends.

## 5. Licensing  (not legal advice)
- All five repos: **Apache-2.0**. The Docs *editor tree* and `@casualoffice/docs` npm package
  are **MIT** (forked from `eigenpal/docx-editor`); the Docs image label says `NOASSERTION`.
- Sheets/Slides build on **Univer OSS** (Apache-2.0); PDF on **PDFium** (Apache-2.0) and
  **EmbedPDF** (MIT); bundled fonts are OFL.
- No AGPL/GPL dependency was identified by upstream's own policy statements. Redistribution
  (e.g. publishing our own images) must preserve each project's `LICENSE` and `NOTICE`.
- A full dependency licence scan was **not** performed.

## 6. What was NOT verified
- Whether any of the Slides / PDF builds succeed (not attempted).
- Co-editing in any app; `/yjs` exposure (§4.2) with a live WS client.
- Fidelity round-trips beyond one trivial `.docx` and one trivial `.xlsx`.
- Second and later saves in the Docs embed (only the first save was observed).
- PDF app runtime behaviour; the extent to which its feature list is real.
- Docs behaviour at repo HEAD (`77e9530`) vs the published 0.0.5 image — they differ
  (image is from 2026-07-07, HEAD from 2026-09-20). A source build might deep-link correctly.

## 7. Embed-route proof of concept  (all **[ran]**, Chromium via Playwright)

Both npm packages ship a prebuilt iframe bundle (`dist/embed/embed.html` + runtime) that
speaks a `postMessage` protocol (`casual.hello/ready`, `casual.load.request`,
`casual.save.request`, `casual.command.*`). A throwaway host (see
[`spikes/embed-poc`](../spikes/embed-poc/README.md)) served the bundles from its own origin and
answered `load`/`save` from a cookie-guarded `GET/PUT /api/files/:id`.

| Check | `@casualoffice/docs@1.4.2` | `@casualoffice/sheets@0.20.0` |
| --- | --- | --- |
| Opens a stored file via host (no token, no collab server) | ✅ real `.docx` rendered | ✅ real `.xlsx` rendered |
| Host auth failure handled | ✅ editor shows "load failed: unauthorized"; host got 401 | not exercised |
| Edit persists to stored file | ✅ typed text present in saved `document.xml` | ✅ typed value **and** formula `B1+1` present |
| How a save is triggered | **Autosave only, every 30 s while dirty** (`autosaveInterval = 3e4`). Host has **no** save command (`onCommandSave` is not registered) | Ctrl+S inside iframe, host `casual.command.save`, or exit. **No autosave/dirty signal** |
| What the editor sends on save | `.docx` **bytes** (`casual.save.request`, host replies with etag) | A Univer **snapshot (JSON)** via `casual.save.notify`; host must convert |
| Bytes → stored format | none needed | host must call `workbookDataToXlsx` from `@casualoffice/sheets/xlsx` (needs `@univerjs/core@0.25`, `exceljs@4.4.0`, `jszip`, and the `exporter.worker.js` served next to the module) — **works**, 0.9 MB bridge + 2.4 MB worker |
| Bundle size | 3.0 MB (+ fonts) | 25 MB |
| Real-time co-editing inside the embed | **No** — runtime comment: "No collab inside the iframe" | **No** — none wired in runtime |

### 7.1 Defects found in the shipped packages (need a workaround or upstream fix)
1. **Docs 1.4.2 `embed.html` imports `./embed-runtime.js`; the package ships `embed-runtime.mjs`.**
   Served as-is it 404s. We must rename/alias the file.
2. **Docs fonts 404.** The runtime requests `/embed/fonts/*.woff2`; the files ship in a sibling
   `dist/fonts/`. They must be served at that path.
3. **Docs emits `casual.error {code:"parse_failed", "Cannot perform Construct on a detached
   ArrayBuffer"}` right after the first save.** The editor keeps working and the data **was**
   saved, so it is non-fatal — but a host that tears down the iframe on any `casual.error`
   would wrongly destroy a working editor. Cause: the save buffer is in the postMessage
   transfer list and is then reused (inferred from the message, not root-caused).
4. **Docs loses up to 30 s of edits** if the tab closes between autosaves; there is no
   host-side flush. Sheets has no autosave at all — the host must poll `command.save`
   and flush on `visibilitychange`/`pagehide`.
5. **Trust boundary:** the editor decides the host origin from `document.referrer`
   (Docs) — hosting the iframe same-origin keeps this safe; a `Referrer-Policy: no-referrer`
   header would silently break the handshake.
6. The saved `.docx` re-serialises (parts preserved for the sample; one `docProps/core.xml`
   added; compression differs). Only a trivial document was tested, so **fidelity for
   complex documents is unknown**.
