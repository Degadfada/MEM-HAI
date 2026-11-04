#!/usr/bin/env bash
# Compile the core and stage it inside the extension folder so the extension is self-contained.
# The staging itself lives in scripts/stage-extension.mjs, which also runs as a pretest on Windows.
set -euo pipefail
cd "$(dirname "$0")"
rm -rf dist
npx tsc -p .
node scripts/stage-extension.mjs
echo "extension staged in ./extension"
