#!/usr/bin/env bash
#
# VingsForge in-app auto-updater (Omarchy / Arch Linux).
#
# Pulls the latest commits, rebuilds the Node sidecar + Tauri bundle, and installs
# the freshly built AppImage. Invoked by the host's UpdateAPI.run() as:
#
#     bash scripts/update.sh <repoDir>
#
# <repoDir> is the absolute path to the VingsForge git checkout. It is passed as a
# single argument (never interpolated into a shell string by the caller). Every
# step is logged to stdout so the host can stream progress to the UI.
#
# Omarchy is Arch-based (no apt / no .deb), so we ship the distro-agnostic
# AppImage: it is dropped into ~/.local/bin and registered with a .desktop entry
# under ~/.local/share/applications (picked up by walker / the app launcher).
# No sudo, no system package manager.
#
set -euo pipefail

REPO_DIR="${1:?usage: update.sh <repoDir>}"
DEPLOY_DIR="/tmp/vf-sidecar-deploy"

# XDG install targets (per-user, no root needed).
BIN_DIR="${XDG_BIN_HOME:-${HOME}/.local/bin}"
APP_DIR="${XDG_DATA_HOME:-${HOME}/.local/share}/applications"
INSTALL_PATH="${BIN_DIR}/VingsForge.AppImage"
DESKTOP_PATH="${APP_DIR}/vingsforge.desktop"

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

log "locate built AppImage"
APPIMAGE_GLOB=("${REPO_DIR}"/apps/desktop/src-tauri/target/release/bundle/appimage/VingsForge_*.AppImage)
APPIMAGE="${APPIMAGE_GLOB[0]}"
if [[ ! -f "${APPIMAGE}" ]]; then
  log "ERROR: no AppImage found at ${REPO_DIR}/apps/desktop/src-tauri/target/release/bundle/appimage/"
  exit 1
fi

log "install ${APPIMAGE} -> ${INSTALL_PATH}"
mkdir -p "${BIN_DIR}" "${APP_DIR}"
install -m 0755 "${APPIMAGE}" "${INSTALL_PATH}"

log "write desktop entry -> ${DESKTOP_PATH}"
# WEBKIT_DISABLE_* keeps WebKitGTK from rendering a blank window under Hyprland
# (Wayland); harmless on X11. We launch through `env` so the launcher honours it.
cat > "${DESKTOP_PATH}" <<EOF
[Desktop Entry]
Type=Application
Name=VingsForge
Comment=Claude-powered coding agent
Exec=env WEBKIT_DISABLE_DMABUF_RENDERER=1 WEBKIT_DISABLE_COMPOSITING_MODE=1 ${INSTALL_PATH}
Icon=vingsforge
Terminal=false
Categories=Development;
EOF

# Refresh the desktop database so walker / the launcher sees the entry now.
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "${APP_DIR}" >/dev/null 2>&1 || true
fi

log "done"
