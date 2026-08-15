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

A release now carries three files, not one: `boxaide-mac.dmg` for a visitor,
plus `boxaide-mac.zip` and `latest-mac.yml` for the in-app updater. All three
come out of `apps/desktop/scripts/sign-mac.sh`, after signing, and `ship.sh` refuses to
publish unless `latest-mac.yml` names the version being cut. A release with
only the dmg leaves every installed copy on its current version, silently.
