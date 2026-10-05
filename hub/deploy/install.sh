#!/usr/bin/env bash
# One-time server setup for ipfx-hub on Ubuntu 24.04 arm64 (run as root). Secrets live only in
# /etc/ipfx-hub.env (mode 600), never in this repository.
set -euo pipefail
if ! /usr/local/bin/node --version 2>/dev/null | grep -q "^v22"; then
  cd /tmp
  BASE="https://nodejs.org/dist/latest-v22.x"
  curl -fsSLO "$BASE/SHASUMS256.txt"
  TARBALL=$(grep -oE "node-v22\.[0-9]+\.[0-9]+-linux-arm64\.tar\.xz" SHASUMS256.txt | head -1)
  curl -fsSLO "$BASE/$TARBALL"
  grep " $TARBALL\$" SHASUMS256.txt | sha256sum -c -
  tar -xJf "$TARBALL" -C /usr/local --strip-components=1
fi
if ! command -v caddy >/dev/null; then
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gnupg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update && apt-get install -y caddy
fi
id ipfxhub >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin ipfxhub
mkdir -p /opt/ipfx-hub
