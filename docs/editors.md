# Editor integration: behaviour and limits

How each editor is wired in, verified by `tests/e2e/editors.cjs` against the production stack (Caddy → app).
Evidence tags as in the recon doc: **[ran]** observed in a real browser, **[src]** read from source.

## Common design
- Editors run in a same-origin iframe from `/editors/<name>/`. They never see storage, tokens or other users: the host page
  (`web/src/editors/session.ts`) answers their `postMessage` requests using the signed-in user's cookie and CSRF token.
- Every write is `PUT /api/files/:id/content` with `If-Match: <version>`. Writes are serialized, so two saves can never race.
- **Conflicts never overwrite.** If the file changed elsewhere (409), saving stops, a banner appears, and the user can
  *Save my version as a copy* (into the same folder) or *Reload latest*. [ran]
- Version history keeps a checkpoint of the replaced content at most every `VERSION_INTERVAL_MIN` (default 10) minutes,
  up to `KEEP_VERSIONS`, so autosaving editors cannot flush the useful history in minutes. [ran, unit-tested]
- Leaving with *← Back* flushes pending edits first; Back returns to the folder you came from. [ran]

## Docs — live co-editing (`.docx`) — **verified**
When `COLLAB_JWT_SECRET` is set (compose requires it), a `.docx` opens in a live room instead of the iframe. Verified by
`tests/e2e/collab-docs.cjs` (three real browsers against the real app + collab service). [ran]

| | |
| --- | --- |
| Who can join | The owner and people the file is shared with (editor / viewer). `POST /api/files/:id/collab` mints a short-lived token bound to this file and role; the collab service is on the internal network and only reachable through the authenticated `/collab` tunnel. Viewers are read-only **on the server**, not just in the UI. |
| Opening | The room starts empty; the server picks exactly one writable client to seed it from the stored file. Two people opening at the same instant produce one copy of the content. [ran] |
| Live editing | Typing, formatting and comments flow both ways within seconds; a viewer sees the same content and cannot change it. [ran] |
| Saving | One elected client (lowest id among editors) writes the file, ~4 s after the first change and no more than every 10 s, with `If-Match`. Leadership passes on if that person leaves. The leader **re-parses the stored file and replaces only the body, comments and footnote/endnote text**, so styles, numbering, headers/footers and theme are preserved (the editor's own export would drop them in a room). [ran: header, footer, comment, styles, numbering survived] |
| Not saved when nothing changed | Opening a file never re-saves it: nothing counts as an edit until you actually type/click. [ran] |
| Conflicts | If the file is changed outside the room (e.g. a new upload), saving stops and a banner offers *Save the live version as a copy*. [unit-tested; banner not browser-tested] |
| Nobody else is editing | A viewer who opens a file nobody has open sees the last saved version, read-only. |
| Known limits | Footnote/endnote **text edits** in a live room are written back, but tracked changes, text boxes and other rich content were **not tested** in rooms. Leaving the editor logs a harmless upstream `matchesNode` error. Tokens last 8 h; a longer session needs a reload. Closing the tab can lose up to ~4 s of the leader's edits. Unsharing someone ends their live session immediately. |
| Build | The npm package lacks a guard needed for safe rooms, so the Docs SDK is built from a pinned commit with a small carried patch (`scripts/build-docs-sdk.sh`, `patches/docs/`). Its Docker build has not been run in this environment (registry access from the build sandbox was unreliable); the script itself was run to completion. |

## Docs — single-user iframe (used only when co-editing is not configured)
| | |
| --- | --- |
| Save trigger | The editor autosaves **every 30 s while it considers the document dirty** and sends `.docx` bytes. [ran] |
| Leaving | Host dispatches `pagehide` into the iframe, which the editor treats as "flush now" (upstream behaviour). Edits typed right before Back were saved. [ran] |
| Closing the tab | The editor flushes on `visibilitychange`/`pagehide` itself, but the host must still be alive to store the bytes: best effort, not guaranteed. |
| Opening re-saves once | **The editor re-saves a document ~30 s after opening it even if you changed nothing** (v1→v2 observed). The original bytes are kept as a previous version. Fidelity of that rewrite beyond simple documents is **untested**. |
| Upstream quirk | After the first save the editor emits a non-fatal `parse_failed` error; the host ignores errors after a successful load. |
| Packaging fixes | `embed.html` imports `embed-runtime.js` but the package ships `.mjs`; the Docker build copies it. Fonts are served at `/editors/fonts/`. |

## Sheets (`@casualoffice/sheets` 0.20.0, `.xlsx`) — single-user only
**Live co-editing for Sheets is not offered.** A full attempt was built and investigated: seeding and cell sync worked, but the
SDK's collaboration bridge logs the formula engine's own value write-backs as shared edits; when a second client replays them,
Univer treats them as overwrites and **clears formulas for everyone** (observed: `SUM(B2:B3)` became the constant 42 as soon as
a second person joined). The likely fix is for the bridge to skip `onlyLocal` mutations; that needs an upstream change or a
carried patch and a fresh verification. Until then spreadsheets use the single-user editor below, and the server refuses to mint
room tokens for them.

| | |
| --- | --- |
| Save trigger | The embed has **no autosave and no dirty signal**. The host asks for a snapshot every 5 s, hashes it, and saves only when it changed since the last save (a baseline snapshot is taken ~1.5 s after the editor is ready, so unchanged workbooks are never re-saved). Ctrl+S inside the sheet saves immediately. [ran] |
| Format | The editor sends a Univer *snapshot*; the host converts it with the SDK's `workbookDataToXlsx` (in a web worker, loaded only when a spreadsheet is opened). A cell value and a formula survived the round trip. [ran] |
| Leaving | Host requests a final snapshot and waits (≤ 8 s) before navigating. |
| Fidelity | The SDK documents losses on **import** (charts, drawings, pivots, validation, conditional formatting, comments, hyperlinks, themes); behaviour for complex workbooks on export was **not tested**. Prefer keeping the original file and check complex workbooks before relying on a round trip. |
| Up to 5 s | Between polls an edit exists only in the browser; a crash or tab kill in that window loses it. |

## Markdown (`.md`)
Docs only opens `.docx`. A Markdown file shows a read-only preview with an **Open in Docs** button, which converts it in the browser into a *new* `.docx` next to it (`notes.md` → `notes.docx`, or `notes (2).docx`) and opens that in live Docs. The `.md` is never modified, and edits in Docs do not flow back to it. Supported: headings, bold/italic/strike, inline code, links, lists (nested), code blocks, quotes, tables, rules. Images become their alt text. [ran: tests/e2e/markdown.cjs, unit-tested]

## Not yet integrated
- **PDF** and **Slides**: need carried patches (load + save hooks) — Phase 4 continues. Until then, opening them shows a preview
  page with a download button and says so.

## Known issues common to all editors
- The Docs and Sheets embeds request **Google Fonts** (`fonts.googleapis.com`/`gstatic.com`) at runtime; Slides and PDF do too. Not private/offline-safe yet. [ran]
- Co-editing exists for **Docs only**. Sheets, Slides and PDF are single-user: two people editing the same file get a conflict on the second save, never a silent overwrite.
- The full Docs editor also requests Google Fonts; under our CSP those requests are blocked (text falls back to local fonts). Self-hosting the fonts is still to do.
