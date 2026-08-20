# Agents

## Ship

A merge to `master` is not a download. The install button is GitHub `releases/latest`. CI does not publish a release.

The repo is [boxaide](https://github.com/Remedy92/boxaide).

After a land, from the main checkout (`~/Projects/boxaide`), never a worktree:

```
./scripts/ship_status.sh
./scripts/ship.sh
```

`ship.sh` is the only publisher. A hook on `master` only reminds.

### The release note is the commit subject

`ship.sh` builds the release body from the commit subjects since the last tag,
minus merges, minus its own "Cut 0.2.24", minus the `(#84)` a squash-merge
appends. Boxaide then shows that body under "What is new", flattened to plain
text by `src/update/notes.ts` — GitHub hands the updater rendered HTML, so
nothing may be printed raw.

So a commit subject on `master` is user-facing copy. Write it in the present
tense, saying what the app now does, in words somebody who does not read this
repo would understand. "Archive mail, and give an agent's sweep one undo", not
"refactor sweep handler". Nothing else is written for the release; there is no
second place to fix it later.

That rule is checked, by `scripts/lib/check-subject.mjs` and nothing else. It
is called three times:

- **CI, on the pull request title** (`.github/workflows/release-note.yml`). A
  squash-merge writes that title to `master` word for word, so this is the only
  gate that runs before the words are user-facing. It re-runs when the title is
  edited.
- **`ship.sh`**, over the notes it computed, before the bump and the notarise.
  It catches a commit pushed straight to `master`, which CI never sees.
- **The `commit-msg` hook**, for a local commit, where `npm run ship:hooks`
  has been run. Weakest of the three: it never sees a pull request title.

It refuses a commit-type prefix (`feat:`), a diff-word opener (refactor, bump,
tweak, wip, cleanup, update, misc), a lowercase start, a trailing full stop, an
em dash, and anything over 80 characters. Merges, reverts, `fixup!` and
`Cut 0.2.26` are exempt because they never reach the notes. So is Dependabot:
its title is not ours to write, CI skips it, and `ship.sh` drops every
"Bump ..." line from the release body, where a dependency range was never
"what is new" to the person reading it.

It cannot check whether the sentence is true of what shipped. That is still on
whoever writes it.

A release now carries three files, not one: `boxaide-mac.dmg` for a visitor,
plus `boxaide-mac.zip` and `latest-mac.yml` for the in-app updater. All three
come out of `apps/desktop/scripts/sign-mac.sh`, after signing, and `ship.sh` refuses to
publish unless `latest-mac.yml` names the version being cut. A release with
only the dmg leaves every installed copy on its current version, silently.
