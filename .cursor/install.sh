#!/usr/bin/env bash
# Cloud Agent bootstrap for Hangar.
#
# Idempotent: safe to re-run. The heavy system libraries are skipped when
# already present (e.g. baked into the environment snapshot), so a warm boot
# only refreshes repository dependencies.
set -euo pipefail
cd "$(dirname "$0")/.."

# 1. System libraries for the Tauri desktop build (mirrors CI's Linux deps).
#    Skip the apt round-trip when webkit2gtk is already installed.
if ! pkg-config --exists webkit2gtk-4.1 2>/dev/null; then
  sudo apt-get update
  sudo apt-get install -y --no-install-recommends \
    libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev \
    patchelf build-essential libxdo-dev libssl-dev pkg-config
fi

# 2. Rust toolchain. The locked dependency tree pulls crates that require the
#    2024 edition (Cargo >= 1.85), newer than the image's default toolchain, so
#    install/refresh stable and make it the default.
rustup toolchain install stable --profile minimal --no-self-update
rustup default stable
rustup component add rustfmt clippy

# 3. Node dev dependency (the Tauri CLI). The web agent in server.js is pure
#    Node stdlib and needs nothing installed to run.
npm install

# 4. Warm and verify the Rust workspace build.
cargo build --workspace
