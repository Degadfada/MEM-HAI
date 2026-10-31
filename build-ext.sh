#!/usr/bin/env bash
# Build the core and stage it inside the extension folder so the extension is self-contained.
set -euo pipefail
cd "$(dirname "$0")"
rm -rf dist extension/core extension/hook
npx tsc -p .
cp -r dist extension/core
mkdir -p extension/hook && cp hooks/claude-code-hook.mjs extension/hook/
echo '{"type":"module"}' > extension/core/package.json
echo "extension staged in ./extension"
