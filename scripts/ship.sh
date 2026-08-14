#!/bin/sh
# Cut a version, pack the Mac dmg, and make it GitHub latest.
#
# This is the only publisher. CI does not sign or upload. A git hook must
# never call this — it only points here.
#
#   ./scripts/ship.sh           next patch
#   ./scripts/ship.sh 0.2.2     that version
#   ./scripts/ship.sh --dry-run print the plan, write nothing
set -eu

ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

DRY=0
VER=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    --help|-h)
      printf '%s\n' "usage: ./scripts/ship.sh [--dry-run] [x.y.z]"
      exit 0
      ;;
    -*)
      printf '%s\n' "unknown flag: $arg" >&2
      exit 2
      ;;
    *)
      if [ -n "$VER" ]; then
        printf '%s\n' "unexpected argument: $arg" >&2
        exit 2
      fi
      VER="$arg"
      ;;
  esac
done

die() {
  printf '%s\n' "$*" >&2
  exit 2
}

command -v git >/dev/null || die "git is not on PATH"
command -v gh >/dev/null || die "gh is not on PATH"
command -v node >/dev/null || die "node is not on PATH"
command -v npm >/dev/null || die "npm is not on PATH"
command -v xcrun >/dev/null || die "xcrun is not on PATH"

# A signed but un-notarised dmg installs nowhere. macOS says "Apple could not
# verify Boxaide is free of malware" and offers no Open button. Refuse to
# publish one. Mint the profile once with (profile name is historical):
#   xcrun notarytool store-credentials mailmux-notary \
#     --apple-id <apple-id> --team-id 22DPQ7YCAS
# Profile name is historical (created as mailmux-notary). Apple will not
# rename a stored notary item; minting boxaide-notary needs the Apple ID
# password in an interactive `notarytool store-credentials`.
: "${APPLE_KEYCHAIN_PROFILE:=mailmux-notary}"
xcrun notarytool history --keychain-profile "$APPLE_KEYCHAIN_PROFILE" \
  >/dev/null 2>&1 || die "notary profile $APPLE_KEYCHAIN_PROFILE does not work"

GIT_DIR="$(git rev-parse --git-dir)"
GIT_COMMON="$(git rev-parse --git-common-dir)"
if [ "$GIT_DIR" != "$GIT_COMMON" ]; then
  die "ship from the main checkout, not a worktree"
fi

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[ "$BRANCH" = "master" ] || die "ship from master (this branch is $BRANCH)"

if [ -n "$(git status --porcelain)" ]; then
  die "working tree is dirty"
fi

git fetch --quiet origin --tags || die "could not fetch origin"

HEAD="$(git rev-parse HEAD)"
ORIGIN="$(git rev-parse origin/master)"
[ "$HEAD" = "$ORIGIN" ] || die "HEAD is not origin/master — pull or push first"

TAG="$(gh release view --json tagName --jq .tagName 2>/dev/null || true)"
[ -n "$TAG" ] || die "no GitHub release yet — create the first one by hand"
SHIPPED="$(git rev-parse "${TAG}^{commit}")"
if [ "$SHIPPED" = "$HEAD" ]; then
  die "already shipped as $TAG"
fi

if [ -z "$VER" ]; then
  VER="$(node scripts/lib/bump-version.mjs --print)"
fi

DMG="apps/desktop/release/boxaide-mac.dmg"
NOTES="$(git log --format='- %s' "${TAG}..HEAD")"

printf 'ship %s\n' "$VER"
printf 'from %s (%s)\n' "$TAG" "$(git rev-parse --short "$SHIPPED")"
printf 'head %s %s\n' "$(git rev-parse --short HEAD)" "$(git log -1 --format='%s')"
printf 'commits:\n%s\n' "$NOTES"

if [ "$DRY" -eq 1 ]; then
  printf 'dry-run — no bump, no pack, no upload\n'
  exit 0
fi

node scripts/lib/bump-version.mjs "$VER"

restore_versions() {
  git checkout -- \
    package.json package-lock.json \
    apps/desktop/package.json apps/desktop/package-lock.json \
    apps/web/package.json apps/web/package-lock.json \
    apps/mcpb/manifest.json
}

# Pack first. A failed dmg must not leave a "Cut" commit on master.
printf 'building server and UI\n'
if ! npm run build; then
  restore_versions
  die "build failed; version files restored"
fi
printf 'packing, signing and notarising the Mac dmg\n'
if ! ( cd apps/desktop && npm run dist:mac ); then
  restore_versions
  die "dist:mac failed; version files restored"
fi
[ -f "$DMG" ] || {
  restore_versions
  die "expected $DMG"
}

# dist:mac notarised and stapled. Prove it before anything reaches GitHub;
# a bad dmg on the download page is far more expensive to undo.
if ! xcrun stapler validate "$DMG"; then
  restore_versions
  die "$DMG has no notarisation ticket; nothing was committed or uploaded"
fi

git add package.json package-lock.json \
  apps/desktop/package.json apps/desktop/package-lock.json \
  apps/web/package.json apps/web/package-lock.json \
  apps/mcpb/manifest.json
git commit -m "Cut $VER" -m "The download is now this commit."
git tag -a "v$VER" -m "boxaide $VER"

git push origin master
git push origin "v$VER"

BODY="$(printf '%s\n\n%s\n' "## What is new" "$NOTES")"
gh release create "v$VER" \
  --title "Boxaide $VER" \
  --notes "$BODY" \
  --latest \
  "$DMG"

printf 'shipped https://github.com/Remedy92/boxaide/releases/latest/download/boxaide-mac.dmg\n'
printf 'commit  %s\n' "$(git rev-parse --short HEAD)"
./scripts/ship_status.sh
