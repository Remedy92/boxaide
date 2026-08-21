#!/bin/sh
# Is origin/master what a visitor downloads?
#
# The install button is GitHub releases/latest. CI does not publish a release.
# This script is the only claim that the download has a given commit.
#
#   ./scripts/ship_status.sh        exit 0 if shipped, 1 if not, 2 on error
#   ./scripts/ship_status.sh --hook  same print, always exit 0 (for git hooks)
set -eu

HOOK=0
if [ "${1:-}" = "--hook" ]; then
  HOOK=1
  shift
fi

ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

say() {
  if [ "$HOOK" -eq 1 ]; then
    printf 'boxaide: %s\n' "$*"
  else
    printf '%s\n' "$*"
  fi
}

fail() {
  say "$*"
  if [ "$HOOK" -eq 1 ]; then
    exit 0
  fi
  exit 2
}

command -v git >/dev/null || fail "git is not on PATH"
command -v gh >/dev/null || fail "gh is not on PATH"

# Named, not guessed: with a contributor's fork added as a second remote, gh
# picks a repository on its own and this script would report that fork's latest
# release as the download. Same reason as ship.sh, same derivation.
REPO="$(git remote get-url origin 2>/dev/null |
  sed -e 's#^git@github\.com:#https://github.com/#' \
      -e 's#^https://github\.com/##' -e 's#\.git$##')"
[ -n "$REPO" ] || fail "no origin remote — cannot tell which repo publishes"

# Tags and origin/master must be current, or a stale status looks like a ship.
if ! git fetch --quiet origin --tags; then
  fail "could not fetch origin"
fi

TAG="$(gh release view -R "$REPO" --json tagName --jq .tagName 2>/dev/null || true)"
if [ -z "$TAG" ]; then
  fail "no GitHub release — the download button 404s"
fi

if ! git rev-parse -q --verify "${TAG}^{commit}" >/dev/null; then
  fail "release tag $TAG is not in this clone"
fi

SHIPPED="$(git rev-parse "${TAG}^{commit}")"
MASTER="$(git rev-parse origin/master)"
SHIPPED_SUBJ="$(git log -1 --format='%s' "$SHIPPED")"
MASTER_SUBJ="$(git log -1 --format='%s' "$MASTER")"

say "download  $TAG  $(git rev-parse --short "$SHIPPED")  $SHIPPED_SUBJ"
say "master    $(git rev-parse --short "$MASTER")  $MASTER_SUBJ"

if [ "$SHIPPED" = "$MASTER" ]; then
  say "shipped"
  exit 0
fi

# A tag on master that has no release is a ship that died on the upload: the
# "Cut" commit and the tag are public, the dmg never went up. Running ship.sh
# then cuts a further version over a build that was already signed and
# notarised, so name the tag and ask for the upload instead.
STRANDED="$(git tag --points-at "$MASTER" 2>/dev/null | head -1)"
if [ -n "$STRANDED" ]; then
  say "not shipped — $STRANDED is tagged and pushed but has no release."
  say "             finish that upload; do NOT run ship.sh, it would cut another version"
else
  say "not shipped — run ./scripts/ship.sh"
fi
if [ "$HOOK" -eq 1 ]; then
  exit 0
fi
exit 1
