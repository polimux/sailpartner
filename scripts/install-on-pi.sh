#!/usr/bin/env bash
# Kept for older instructions — the installer is now scripts/install.js and
# runs everywhere Node.js does (Windows, macOS, Linux, Raspberry Pi).
exec node "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/install.js" "$@"
