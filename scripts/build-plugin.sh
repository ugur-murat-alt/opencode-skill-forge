#!/usr/bin/env bash
# Builds the OpenCode V2 plugin (wrapper entry) into dist/plugin.js.
#
# The published skill-forge core is preserved byte-for-byte as
# dist/skillforge-core.js and imported by the wrapper, so skill-subsystem
# behaviour stays identical while wrapper code remains maintainable TypeScript.
set -euo pipefail
cd "$(dirname "$0")/.."

# Never seed the core from dist/plugin.js: that file may already be a wrapper,
# which would recursively register another wrapper generation.
if [[ ! -f dist/skillforge-core.js ]]; then
  echo "error: preserved dist/skillforge-core.js is missing" >&2
  exit 1
fi

# Ship the agent config beside the bundle.
cp spr-agent.jsonc dist/ 2>/dev/null || true
cp prompt-editor-agent.jsonc dist/ 2>/dev/null || true

# Keep the preserved core external so rebuilding the wrapper cannot silently
# replace or rebundle its byte-for-byte runtime artifact.
core_path="$(pwd)/dist/skillforge-core.js"
bun build src/index.ts \
  --outfile=dist/plugin.js \
  --target=bun \
  --format=esm \
  --external="$core_path"

echo "built dist/plugin.js"
