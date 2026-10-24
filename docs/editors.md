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

## Docs (`@casualoffice/docs` 1.4.2, `.docx`)
| | |
| --- | --- |
| Save trigger | The editor autosaves **every 30 s while it considers the document dirty** and sends `.docx` bytes. [ran] |
| Leaving | Host dispatches `pagehide` into the iframe, which the editor treats as "flush now" (upstream behaviour). Edits typed right before Back were saved. [ran] |
| Closing the tab | The editor flushes on `visibilitychange`/`pagehide` itself, but the host must still be alive to store the bytes: best effort, not guaranteed. |
| Opening re-saves once | **The editor re-saves a document ~30 s after opening it even if you changed nothing** (v1→v2 observed). The original bytes are kept as a previous version. Fidelity of that rewrite beyond simple documents is **untested**. |
| Upstream quirk | After the first save the editor emits a non-fatal `parse_failed` error; the host ignores errors after a successful load. |
| Packaging fixes | `embed.html` imports `embed-runtime.js` but the package ships `.mjs`; the Docker build copies it. Fonts are served at `/editors/fonts/`. |

## Sheets (`@casualoffice/sheets` 0.20.0, `.xlsx`)
| | |
| --- | --- |
| Save trigger | The embed has **no autosave and no dirty signal**. The host asks for a snapshot every 5 s, hashes it, and saves only when it changed since the last save (a baseline snapshot is taken ~1.5 s after the editor is ready, so unchanged workbooks are never re-saved). Ctrl+S inside the sheet saves immediately. [ran] |
| Format | The editor sends a Univer *snapshot*; the host converts it with the SDK's `workbookDataToXlsx` (in a web worker, loaded only when a spreadsheet is opened). A cell value and a formula survived the round trip. [ran] |
| Leaving | Host requests a final snapshot and waits (≤ 8 s) before navigating. |
| Fidelity | The SDK documents losses on **import** (charts, drawings, pivots, validation, conditional formatting, comments, hyperlinks, themes); behaviour for complex workbooks on export was **not tested**. Prefer keeping the original file and check complex workbooks before relying on a round trip. |
| Up to 5 s | Between polls an edit exists only in the browser; a crash or tab kill in that window loses it. |

## Not yet integrated
- **PDF** and **Slides**: need carried patches (load + save hooks) — Phase 4 continues. Until then, opening them shows a preview
  page with a download button and says so.

## Known issues common to all editors
- The Docs and Sheets embeds request **Google Fonts** (`fonts.googleapis.com`/`gstatic.com`) at runtime; Slides and PDF do too. Not private/offline-safe yet. [ran]
- No real-time co-editing (neither embed supports it). Two people editing the same file get a conflict on the second save, never silent overwrite.
