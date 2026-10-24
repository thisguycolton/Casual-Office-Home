# syntax=docker/dockerfile:1.7
#
# One image: the central app + the four editors as static bundles.
# Stages are independent so a change to the app does not rebuild the (slow) editors.
#
# Upstream editor versions are passed as build args from editors/pins.env (see compose.yaml).

ARG NODE_VERSION=22.23.4-alpine
ARG NODE_BUILD_IMAGE=22.23.4-bookworm

# ───────── PDF editor: build from source at a pinned commit + our patches ─────────
FROM node:${NODE_BUILD_IMAGE} AS editor-pdf
# The full (non-slim) image already ships git + CA certificates; no apt needed.
RUN corepack enable
ARG PDF_REPO
ARG PDF_SHA
WORKDIR /src
RUN git init -q . && git remote add origin "$PDF_REPO" \
    && git fetch -q --depth 1 origin "$PDF_SHA" && git checkout -q FETCH_HEAD \
    && sed -i 's#git@github.com:#https://github.com/#' .gitmodules \
    && git submodule update --init --depth 1
COPY patches/pdf /patches
RUN for p in /patches/*.patch; do git apply --verbose "$p"; done
RUN pnpm install --frozen-lockfile
ENV PAGES_BASE=/editors/pdf/
RUN pnpm build:web

# ───────── Slides editor: build from source at a pinned commit + our patches ─────────
FROM node:${NODE_BUILD_IMAGE} AS editor-slides
# The full (non-slim) image already ships git + CA certificates; no apt needed.
RUN corepack enable
ARG SLIDES_REPO
ARG SLIDES_SHA
WORKDIR /src
RUN git init -q . && git remote add origin "$SLIDES_REPO" \
    && git fetch -q --depth 1 origin "$SLIDES_SHA" && git checkout -q FETCH_HEAD \
    && sed -i 's#git@github.com:#https://github.com/#' .gitmodules \
    && git submodule update --init --depth 1 univer-revamp design-book
COPY patches/slides /patches
RUN for p in /patches/*.patch; do [ -e "$p" ] && git apply --verbose "$p"; done; true
RUN pnpm install --frozen-lockfile
ENV PAGES_BASE=/editors/slides/ NODE_OPTIONS=--max-old-space-size=4096
RUN pnpm build:web

# ───────── Docs + Sheets: prebuilt iframe bundles from the pinned npm packages ─────────
FROM node:${NODE_BUILD_IMAGE} AS editor-npm
WORKDIR /npm
COPY editors/npm/package.json editors/npm/package-lock.json ./
RUN npm ci --legacy-peer-deps --ignore-scripts --no-audit --no-fund
RUN mkdir -p /out/docs /out/sheets /out/fonts \
    && cp -r node_modules/@casualoffice/docs/dist/embed/. /out/docs/ \
    # Upstream bug: embed.html imports ./embed-runtime.js but the package ships .mjs.
    && cp /out/docs/embed-runtime.mjs /out/docs/embed-runtime.js \
    && cp -r node_modules/@casualoffice/docs/dist/fonts/. /out/fonts/ \
    && cp -r node_modules/@casualoffice/sheets/dist/embed/. /out/sheets/

# ───────── Docs SDK: built from source at a pinned commit + our patches (needed for co-editing) ─────────
FROM node:${NODE_BUILD_IMAGE} AS docs-sdk
ARG DOCS_REPO
ARG DOCS_SHA
ARG BUN_VERSION=1.4.4
RUN npm install -g bun@${BUN_VERSION}
COPY scripts/build-docs-sdk.sh /work/scripts/build-docs-sdk.sh
COPY patches/docs /work/patches/docs
RUN printf 'DOCS_REPO=%s\nDOCS_SHA=%s\n' "$DOCS_REPO" "$DOCS_SHA" > /work/pins.env \
    && mkdir -p /work/editors && cp /work/pins.env /work/editors/pins.env \
    && /work/scripts/build-docs-sdk.sh /out

# ───────── Central web UI ─────────
FROM node:${NODE_VERSION} AS web-build
WORKDIR /web
COPY web/package.json web/package-lock.json web/.npmrc ./
RUN npm ci --no-audit --no-fund
COPY --from=docs-sdk /out/*.tgz /tmp/docs-sdk/
RUN npm install --no-save --no-package-lock --no-audit --no-fund /tmp/docs-sdk/*.tgz
COPY web/tsconfig.json web/vite.config.ts web/index.html ./
COPY web/src ./src
RUN npm run build

# ───────── Central app ─────────
FROM node:${NODE_VERSION} AS app-build
WORKDIR /app
COPY app/package.json app/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY app/tsconfig.json ./
COPY app/src ./src
RUN npm run build && npm prune --omit=dev

FROM node:${NODE_VERSION} AS runtime
ENV NODE_ENV=production APP_ROOT=/app DATA_DIR=/data PORT=3000
WORKDIR /app
COPY --from=app-build /app/node_modules ./node_modules
COPY --from=app-build /app/dist ./dist
COPY app/package.json ./
COPY app/migrations ./migrations
COPY app/templates ./templates
COPY --from=web-build /web/dist ./public
COPY --from=editor-pdf /src/apps/web/dist ./editors/pdf
COPY --from=editor-slides /src/apps/web/dist ./editors/slides
COPY --from=editor-npm /out/docs ./editors/docs
COPY --from=editor-npm /out/sheets ./editors/sheets
COPY --from=editor-npm /out/fonts ./editors/fonts
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
