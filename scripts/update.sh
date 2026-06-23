#!/usr/bin/env bash
#
# VingsForge in-app auto-updater.
#
# Pulls the latest commits, rebuilds the Node sidecar + Tauri bundle, and installs
# the freshly built .deb. Invoked by the host's UpdateAPI.run() as:
#
#     bash scripts/update.sh <repoDir>
#
# <repoDir> is the absolute path to the VingsForge git checkout. It is passed as a
# single argument (never interpolated into a shell string by the caller). Every
# step is logged to stdout so the host can stream progress to the UI.
#
set -euo pipefail

REPO_DIR="${1:?usage: update.sh <repoDir>}"
DEPLOY_DIR="/tmp/vf-sidecar-deploy"

log() { printf '==> %s\n' "$*"; }

log "repo: ${REPO_DIR}"
cd "${REPO_DIR}"

log "git pull --ff-only"
git pull --ff-only

log "pnpm install"
pnpm install

log "build sidecar"
pnpm --filter @vingsforge/sidecar build

log "deploy sidecar (prod, hoisted) -> ${DEPLOY_DIR}"
pnpm --filter @vingsforge/sidecar deploy --prod --legacy --node-linker=hoisted "${DEPLOY_DIR}"

log "refresh bundled sidecar"
rm -rf apps/desktop/src-tauri/sidecar
cp -r "${DEPLOY_DIR}" apps/desktop/src-tauri/sidecar
rm -rf apps/desktop/src-tauri/sidecar/node_modules/.bin

log "tauri build"
cd apps/desktop
pnpm tauri build

log "locate built .deb"
DEB_GLOB=("${REPO_DIR}"/apps/desktop/src-tauri/target/release/bundle/deb/VingsForge_*_amd64.deb)
DEB="${DEB_GLOB[0]}"
if [[ ! -f "${DEB}" ]]; then
  log "ERROR: no .deb found at ${REPO_DIR}/apps/desktop/src-tauri/target/release/bundle/deb/"
  exit 1
fi

log "install ${DEB}"
sudo apt-get install -y "${DEB}"

log "done"
