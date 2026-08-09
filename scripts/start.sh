#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
if [[ ! -d node_modules ]]; then
  npm install
fi
if [[ "${1:-}" == "--fixture" ]]; then
  exec npx tsx src/cli.ts serve --fixture
fi
exec npx tsx src/cli.ts serve
