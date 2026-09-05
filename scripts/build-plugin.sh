#!/usr/bin/env sh
# Compatibility entry only. The maintained build is platform-neutral Node ESM.
set -eu
exec node "$(dirname "$0")/build.mjs" "$@"
