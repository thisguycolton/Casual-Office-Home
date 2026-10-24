# Spike: embedding Docs and Sheets via their shipped iframe `postMessage` bundles

Throwaway proof-of-concept used to verify the integration route in `docs/architecture.md`.
It is **not** the production host; it exists so the findings can be reproduced.

What it does: a tiny Node server exposes `GET/PUT /api/files/:id` guarded by a fake cookie
(`sid=valid`), serves the npm-shipped `embed.html` bundles, and a host page speaks the
`casual.*` protocol (load → edit → save). Playwright drives it in Chromium.

```sh
# 1. fetch + unpack the pinned SDKs
npm pack @casualoffice/docs@1.4.2 @casualoffice/sheets@0.20.0
mkdir docs sheets && tar -xzf casualoffice-docs-1.4.2.tgz -C docs && tar -xzf casualoffice-sheets-0.20.0.tgz -C sheets

# 2. build the Sheets snapshot->xlsx bridge (ES module + its worker, served at /xlsx/)
cd bridge && npm i && npx esbuild entry.js --bundle --format=esm --platform=browser --outfile=../xlsx/bridge.js
cp node_modules/@casualoffice/sheets/dist/exporter.worker.js ../xlsx/ && cd ..

# 3. run (paths are the unpacked `package/dist/...` dirs)
mkdir store   # put any valid .docx at store/doc1.docx and any .xlsx at store/sheet1.xlsx
DOCS_EMBED_DIR=docs/package/dist/embed SHEETS_EMBED_DIR=sheets/package/dist/embed \
DOCS_FONTS_DIR=docs/package/dist/fonts node server.mjs &
node drive.cjs docs doc1 "TYPED-TEXT"      # Docs autosaves after ~30s
node drive.cjs sheets sheet1 "TYPED-TEXT"  # Sheets: host sends casual.command.save
```

Results are recorded in `docs/phase1-reconnaissance.md` §7.
