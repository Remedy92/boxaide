#!/bin/sh
# Point this clone at scripts/githooks. Shared by every worktree.
set -eu
ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
git config core.hooksPath scripts/githooks
printf 'hooksPath = %s\n' "$(git config --get core.hooksPath)"
