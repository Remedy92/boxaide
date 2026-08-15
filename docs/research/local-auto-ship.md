# Local auto-ship — close the merge / download gap

**Date:** 2026-08-12  
**Status:** accepted — `scripts/ship.sh`, `scripts/ship_status.sh`, `scripts/githooks/`

## The gap

The install button is a static URL:

```
https://github.com/Remedy92/boxaide/releases/latest/download/boxaide-mac.dmg
```

Pinned in `apps/web/src/app/install/page.tsx` (`RELEASE_BASE`) and `apps/desktop/electron-builder.yml` (`artifactName: boxaide-mac.dmg`). GitHub keeps `/releases/latest` on the newest published release ([GitHub: linking to releases](https://docs.github.com/en/repositories/releasing-projects-on-github/linking-to-releases)).

CI (`.github/workflows/ci.yml`) runs on push and PR to `master`. It typechecks, tests, lints, and builds the web export. It does not pack a dmg, sign, or call `gh release`. Ubuntu runners cannot use the Developer ID in this Mac's login keychain.

So three facts can diverge:

| Fact | Today (2026-08-12) |
|---|---|
| `origin/master` | `a85ba17` (#26, Agent pane names the launched CLI) |
| Latest release | `v0.2.1` → commit of the 0.2.1 cut, dmg published 19:25 UTC |
| What a visitor downloads | that v0.2.1 dmg |

#26 is on master and not in the dmg. That is the failure mode.

## What a ship actually is

A release is a local, ordered pipeline. Nothing in git or Actions runs it.

1. Bump `version` in root / `apps/desktop` / `apps/web` `package.json` (and their lockfiles) and `apps/mcpb/manifest.json`. The `6619fc0` "Cut 0.2.1" commit is exactly those seven files.
2. `npm run build` at the repo root — server, Next export, `web-next/`, `.mcpb`.
3. `npm run dist:mac` in `apps/desktop` — `sync-server.mjs` copies `dist/` + `web-next/` into `apps/desktop/server/`, electron-builder writes an unsigned dmg (`-c.mac.identity=null`), `scripts/sign-mac.sh` codesigns the app inside-out with cert hash `403ADC00F0A6E8A510184F01AA2D670FA1988B54`, rebuilds the dmg from the signed `.app`, signs the dmg.
4. Notarization is required to publish. `ship.sh` runs `notarytool` / `stapler` and refuses a dmg with no ticket.
5. `gh release create vX.Y.Z --latest` uploads `boxaide-mac.dmg`, `boxaide-mac.zip`, and `latest-mac.yml`. The download button follows `--latest`.
6. Pack scripts pass `--publish never` so a `GH_TOKEN` in the environment does not upload an unsigned pack.

This needs: this Mac, an unlocked login keychain, the Developer ID, Node 22, and `gh` authenticated to Remedy92/boxaide. It is minutes, not seconds (`compression: maximum`).

## Options

### 1. One script (`scripts/ship.sh`) — do this

A single command that is the only publisher:

- Refuse unless cwd is the main checkout, branch is `master`, tree is clean, and `origin/master` is an ancestor of HEAD (fresh fetch).
- Refuse if `gh release view --json tagName,targetCommitish` already points at this HEAD.
- Bump patch (or take `0.2.2` as an argument). Commit `Cut X.Y.Z`.
- Run steps 2–5 above. Notarize only if the keychain profile exists.
- Push `master` and the tag. Create the GitHub release with `--latest`.
- Print the download URL and the SHA it now serves.

This is the missing piece. Today the steps live in README comments and muscle memory.

### 2. A hook that packs — do not

[Git hooks](https://git-scm.com/docs/githooks) that look tempting:

| Hook | Fires when | Problem |
|---|---|---|
| `post-merge` | successful `git merge` / `git pull` | Fires on every pull, every branch. A 5–10 min pack inside a hook blocks the shell. Worktrees and other clones have no hook unless `core.hooksPath` is set. |
| `pre-push` | `git push` | If it packs, every master push hangs until the dmg is signed. If the keychain is locked, push fails. |
| `post-commit` | every commit | Worse. |

Hooks also do not run on GitHub's squash merge. The merge of #26 happened on GitHub; the local event was `git pull --ff-only`. A `post-merge` in the main checkout would have fired then — and would have shipped a dmg in the middle of a pull, with no version bump commit yet.

A hook that *runs electron-builder* is the wrong tool.

### 3. A hook that only reports — yes, as a reminder

`core.hooksPath = scripts/githooks` (repo-local, shared). `post-merge` and `post-checkout`:

- If the current branch is `master` **and** this worktree is the main checkout.
- Compare `git rev-parse HEAD` to `gh api repos/Remedy92/boxaide/releases/latest --jq .target_commitish` (or the tag's peeled commit).
- If they differ, print: `download is still v0.2.1 — run ./scripts/ship.sh`.
- Exit 0. Never pack. Never fail the git command.

Same logic as a `scripts/ship_status.sh` you can run by hand. The hook is how you stop forgetting; the script is how you ship.

### 4. Self-hosted Actions runner on this Mac — later, not first

[Self-hosted runners](https://docs.github.com/en/actions/hosting-your-own-runners/managing-self-hosted-runners/about-self-hosted-runners) can run `dist:mac` on push to `master`. Signing on a runner is a known sharp edge: a runner installed as a launchd service often cannot see the login keychain ([actions/runner#3407](https://github.com/actions/runner/issues/3407)). Hosted `macos-*` runners need the cert exported as a `.p12` in Actions secrets ([Installing an Apple certificate on macOS runners](https://docs.github.com/en/actions/use-cases-and-examples/deploying/installing-an-apple-certificate-on-macos-runners-for-xcode-development)).

Even if signing works, every master push (dependabot, "Cut", docs) would publish a latest dmg unless the workflow is gated on a tag or a `ship` label. That is a different product: "push to master is a release." This repo is not that today — 0.2.1 was a dedicated cut commit, then more master commits followed.

### 5. Overwrite the v0.2.1 asset without a new tag — no

`gh release upload --clobber` can replace `boxaide-mac.dmg` on an existing release. The download URL stays the same, but the file no longer matches the tag, the version in About, or the cut commit. Visitors cannot tell what they have. Do not.

## Recommendation

Build **1 + 3**. Do not auto-pack.

- `scripts/ship.sh` is the only thing that may create `--latest`.
- `scripts/ship_status.sh` (and a quiet `post-merge` / `post-checkout` hook) is the only thing that may claim "the download has this commit."
- Land ritual: merge the PR, pull master, read the one-line status, run `ship` when the download should move.

Do not ship on every master update. #26 should ride the next cut, not spawn a 0.2.2 of its own unless you want that. The status script makes the lag visible; the ship script makes the cut one command.

## Decision

Ship only when you run `./scripts/ship.sh`. The hook never packs.
