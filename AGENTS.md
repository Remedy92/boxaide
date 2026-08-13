# Agents

## Ship

A merge to `master` is not a download. The install button is GitHub `releases/latest`. CI does not publish a dmg.

The repo is [sley](https://github.com/Remedy92/sley); this checkout may still be named `mailmux`.

After a land, from the main checkout (`~/Projects/mailmux`), never a worktree:

```
./scripts/ship_status.sh
./scripts/ship.sh
```

`ship.sh` is the only publisher. A hook on `master` only reminds.
