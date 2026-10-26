#!/usr/bin/env bash
# Installs or updates both Sailpartner plugins into the local Signal K server.
# Run on the Raspberry Pi as user pi, from anywhere:
#   bash ~/sailpartner/scripts/install-on-pi.sh
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SK_DIR="${SIGNALK_DIR:-$HOME/.signalk}"

if [ ! -d "$SK_DIR" ]; then
  echo "Signal K directory $SK_DIR not found. Install Signal K first (OpenPlotter Signal K Installer)." >&2
  exit 1
fi

echo "== Updating repository"
git -C "$REPO" pull --ff-only || echo "(no git remote or local changes — continuing with the files as they are)"

# The packed plugins stay in a fixed folder: ~/.signalk/package.json refers to them,
# and Signal K's App Store re-runs npm install with that file.
PKG_DIR="$SK_DIR/sailpartner-packages"
mkdir -p "$PKG_DIR"
rm -f "$PKG_DIR"/*.tgz

for pkg in signalk-baltic-warnings sailpartner; do
  echo "== Packing $pkg"
  (cd "$REPO/packages/$pkg" && npm pack --silent --pack-destination "$PKG_DIR" >/dev/null)
done

echo "== Installing into $SK_DIR"
(cd "$SK_DIR" && npm install --no-audit --no-fund "$PKG_DIR"/signalk-baltic-warnings-*.tgz "$PKG_DIR"/sailpartner-*.tgz)

echo "== Restarting Signal K"
if systemctl list-unit-files | grep -q '^signalk\.service'; then
  sudo systemctl restart signalk
  echo "Signal K restarted."
else
  echo "No signalk systemd service found — restart the Signal K server yourself."
fi

echo
echo "Done. Next:"
echo "  1. Enable 'Baltic Warnings' and 'Sailpartner' in Signal K: Server -> Plugin Config"
echo "  2. Open http://localhost:3000/sailpartner/"
