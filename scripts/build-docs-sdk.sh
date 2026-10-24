#!/bin/sh
# Builds @casualoffice/docs from source at the pinned commit with our carried patches, and packs it as a tarball.
#
# Why not the npm package? Real-time co-editing needs (a) a guard so the editor never saves before the room has synced
# (present at this commit, absent in the published 1.4.2) and (b) the DOCX<->ProseMirror conversion exported so the
# host can seed a room (patches/docs). The result is a carried build artefact, not an npm dependency.
#
# Usage: scripts/build-docs-sdk.sh <output-dir>      (needs git, node, bun; DOCS_REPO / DOCS_SHA come from editors/pins.env)
set -eu
OUT=$(cd "$(dirname "${1:?usage: build-docs-sdk.sh <output-dir>}")" && pwd)/$(basename "$1")
HERE=$(cd "$(dirname "$0")/.." && pwd)
. "$HERE/editors/pins.env"
SRC=$(mktemp -d); trap 'rm -rf "$SRC"' EXIT
mkdir -p "$OUT"
cd "$SRC"
git init -q . && git remote add origin "$DOCS_REPO"
git fetch -q --depth 1 origin "$DOCS_SHA" && git checkout -q FETCH_HEAD
# Public over https; upstream's .gitmodules uses it already for design-book but be explicit for anything ssh.
sed -i 's#git@github.com:#https://github.com/#' .gitmodules
git submodule update --init --depth 1 docx-editor/vendor/design-system
for p in "$HERE"/patches/docs/*.patch; do git apply --verbose "$p"; done
cd docx-editor
export NODE_OPTIONS="${NODE_OPTIONS:-} --max-old-space-size=6144"   # the type-declaration step runs out of memory at the default heap
bun install --frozen-lockfile
bun run build
cd packages/react
npm pack --silent --pack-destination "$OUT"
ls "$OUT"
