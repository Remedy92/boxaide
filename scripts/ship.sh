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
#
# Exported, not just assigned. sign-mac.sh reads this variable in a child
# process two levels down (npm run dist:mac -> desktop.mjs -> sign-mac.sh),
# and a plain `:=` assignment does not cross that boundary. Unexported, the
# child saw it unset, skipped notarisation, and the stapler gate below failed
# the build after a full sign-and-pack.
export APPLE_KEYCHAIN_PROFILE="${APPLE_KEYCHAIN_PROFILE:-mailmux-notary}"
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

git fetch --quiet origin master --tags || die "could not fetch origin"

HEAD="$(git rev-parse HEAD)"
ORIGIN="$(git rev-parse origin/master)"
[ "$HEAD" = "$ORIGIN" ] || die "HEAD is not origin/master — pull or push first"

# CI is the only thing that has read this code as a whole, and the push below
# does not consult it: ship.sh commits "Cut" straight onto master, and the
# account running it has bypass rights, so branch protection never gets a
# vote. Ask GitHub directly instead. Every workflow run on the commit being
# released must have finished green before anything is committed, packed or
# uploaded. Checked here, before the twenty-minute sign-and-notarise, so a red
# master costs nothing.
#
# Runs are matched on this commit, not on the branch, so a green run for an
# older master cannot pass a newer one. Only push-triggered workflows appear
# (CI and CodeQL); dependency-review is pull_request-only and never runs on a
# master commit, which is why the gate checks what did run rather than a list
# of names it expects.
SHORT="$(git rev-parse --short HEAD)"
COUNT="$(gh run list --branch master --limit 50 --commit "$HEAD" \
  --json databaseId --jq 'length')" \
  || die "could not read workflow runs for $SHORT"
if [ "$COUNT" -eq 0 ]; then
  die "no workflow run for $SHORT yet; wait for CI to start and finish"
fi
BAD="$(gh run list --branch master --limit 50 --commit "$HEAD" \
  --json workflowName,status,conclusion \
  --jq '.[]
    | select(.status != "completed"
      or (.conclusion != "success" and .conclusion != "skipped"))
    | "  " + .workflowName + ": "
      + (if .status == "completed" then .conclusion else .status end)')" \
  || die "could not read workflow runs for $SHORT"
if [ -n "$BAD" ]; then
  die "master $SHORT is not green:
$BAD
nothing was built or uploaded; fix it and push before shipping"
fi
printf 'ci   %s green (%s runs)\n' "$SHORT" "$COUNT"

TAG="$(gh release view --json tagName --jq .tagName 2>/dev/null || true)"
[ -n "$TAG" ] || die "no GitHub release yet — create the first one by hand"
if ! git rev-parse -q --verify "${TAG}^{commit}" >/dev/null; then
  die "release tag $TAG is not in this clone — fetch tags or pull origin"
fi
SHIPPED="$(git rev-parse "${TAG}^{commit}")"
if [ "$SHIPPED" = "$HEAD" ]; then
  die "already shipped as $TAG"
fi

if [ -z "$VER" ]; then
  VER="$(node scripts/lib/bump-version.mjs --print)"
fi

DMG="apps/desktop/release/boxaide-mac.dmg"
# The auto-updater's feed. `latest-mac.yml` is what a running Boxaide reads to
# learn a version exists; the zip is what Squirrel installs from. A release
# with only the dmg leaves every installed copy on its current version, and
# says nothing about it.
ZIP="apps/desktop/release/boxaide-mac.zip"
FEED="apps/desktop/release/latest-mac.yml"
# The release body is what the app shows under "What is new", so it is written
# for whoever is deciding whether to restart, not for whoever wrote the commit.
# Four things go before it is one:
#   - merges, which name a branch and no change;
#   - the "Cut 0.2.24" commit, which is this script's own bookkeeping;
#   - Dependabot's "Bump lodash from 4.17.20 to 4.17.21", which is true and is
#     not what is new to the person deciding whether to restart;
#   - the "(#84)" a squash-merge appends, which GitHub then expands into an
#     anchor tag in the updater feed.
# What is left is one sentence per change, in the words of the commit subject.
# That makes the subject the release note: write it for a user, in the present
# tense, saying what the app now does. check-subject.mjs below refuses to
# publish a body that broke that rule; AGENTS.md has the whole rule.
NOTES="$(git log --no-merges --format='- %s' "${TAG}..HEAD" \
  | grep -v -E '^- Cut [0-9]+\.[0-9]+\.[0-9]+' \
  | grep -v -E '^- Bump ' \
  | sed -E 's/ *\(#[0-9]+\)$//')"
[ -n "$NOTES" ] || NOTES="- Fixes and refinements."

# The same rule CI enforced on each pull request title, applied once more to
# what is about to be published. CI cannot see a commit pushed straight to
# master, and this script's own push bypasses branch protection, so without
# this a jargon subject reaches the release body unread. Checked before the
# bump and the twenty-minute notarise: a bad line costs nothing here.
if ! printf '%s\n' "$NOTES" | node scripts/lib/check-subject.mjs; then
  die "the release body is not user-facing copy; reword the commits above"
fi

printf 'ship %s\n' "$VER"
printf 'from %s (%s)\n' "$TAG" "$(git rev-parse --short "$SHIPPED")"
printf 'head %s %s\n' "$(git rev-parse --short HEAD)" "$(git log -1 --format='%s')"
printf 'commits:\n%s\n' "$NOTES"

if [ "$DRY" -eq 1 ]; then
  printf 'dry-run — no bump, no pack, no upload\n'
  exit 0
fi

restore_versions() {
  git checkout -- \
    package.json package-lock.json \
    apps/desktop/package.json apps/desktop/package-lock.json \
    apps/web/package.json apps/web/package-lock.json \
    apps/mcpb/manifest.json
}

COMMITTED=0
cleanup() {
  if [ "$COMMITTED" -eq 0 ]; then
    restore_versions
  fi
}
trap cleanup EXIT INT TERM

node scripts/lib/bump-version.mjs "$VER"

# Pack first. A failed dmg must not leave a "Cut" commit on master.
printf 'building server and UI\n'
if ! npm run build; then
  die "build failed; version files restored"
fi
printf 'packing, signing and notarising the Mac dmg\n'
if ! ( cd apps/desktop && npm run dist:mac ); then
  die "dist:mac failed; version files restored"
fi
for artifact in "$DMG" "$ZIP" "$FEED"; do
  [ -f "$artifact" ] || {
    die "expected $artifact"
  }
done

# The feed states the version the updater will offer. If it disagrees with the
# version being cut, every installed copy either sees nothing or is offered the
# wrong build — and the mistake is only visible days later, on somebody else's
# Mac. Check it here, where the fix is free.
FEED_VER="$(sed -n 's/^version: *//p' "$FEED" | head -1 | tr -d '\r')"
[ "$FEED_VER" = "$VER" ] || {
  die "latest-mac.yml says $FEED_VER, shipping $VER — rebuild the dmg"
}

# dist:mac notarised and stapled. Prove it before anything reaches GitHub;
# a bad dmg on the download page is far more expensive to undo.
if ! xcrun stapler validate "$DMG"; then
  die "$DMG has no notarisation ticket; nothing was committed or uploaded"
fi

git add package.json package-lock.json \
  apps/desktop/package.json apps/desktop/package-lock.json \
  apps/web/package.json apps/web/package-lock.json \
  apps/mcpb/manifest.json
git commit -m "Cut $VER" -m "The download is now this commit."
git tag -a "v$VER" -m "boxaide $VER"
COMMITTED=1
trap - EXIT INT TERM

git push origin master
git push origin "v$VER"

BODY="$(printf '%s\n\n%s\n' "## What is new" "$NOTES")"
BLOCKMAP="${ZIP}.blockmap"
if [ -f "$BLOCKMAP" ]; then
  gh release create "v$VER" \
    --title "Boxaide $VER" \
    --notes "$BODY" \
    --latest \
    "$DMG" "$ZIP" "$FEED" "$BLOCKMAP"
else
  gh release create "v$VER" \
    --title "Boxaide $VER" \
    --notes "$BODY" \
    --latest \
    "$DMG" "$ZIP" "$FEED"
fi

printf 'shipped https://github.com/Remedy92/boxaide/releases/latest/download/boxaide-mac.dmg\n'
printf 'commit  %s\n' "$(git rev-parse --short HEAD)"
./scripts/ship_status.sh
