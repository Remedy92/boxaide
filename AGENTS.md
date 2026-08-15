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

## Cursor Cloud specific instructions

The update script (auto-run on VM start) installs deps for both trees: root
(`npm install`, which compiles the native `better-sqlite3` addon — Node 22+ and
a C/C++ toolchain are already present) and `apps/web` (`npm ci`). This repo is
**not** an npm workspace; the two trees have independent lockfiles by design, so
`apps/web` deps are not hoisted. Do not add a `workspaces` key to root
`package.json`.

Everything is one Node process on `127.0.0.1:8787` with embedded SQLite in
`~/.boxaide` — there is no separate DB/cache/queue and no Docker.

Run for development (commands documented in `README.md` / `CONTRIBUTING.md` / root `package.json`):

- Dev server (fixture demo, no real mail creds needed): `npm run dev -- --fixture`.
  Fixture mode seeds `personal` + `work` demo mailboxes. On loopback the browser
  UI auto-loads the bearer token via `/api/local-bootstrap`, so no manual login.
- Server lint/typecheck: there is no ESLint at the root — `npm run build:server`
  (`tsc`) is the type gate that CI uses. `npm test` runs Vitest (in-memory
  `FixtureProvider`; no running server or live mail needed).
- Web (`apps/web`): `npm run lint` and `npm run build` (Next.js static export).

Non-obvious gotchas:

- The server serves the browser UI at `/` from `web-next/`, which is a generated
  copy of `apps/web/out`. It is **not** produced by `npm run dev`. If `web-next/`
  is missing, `/` returns 500. Populate it once with `npm run web:build && npm run web:sync`
  (or a full `npm run build`). The update script does not build it, since it is a
  build artifact, not a dependency — build it when you need the served UI.
- `npm run dev` alone gives you the API + MCP; the served static UI needs the
  `web-next/` build above. For frontend hot-reload, run the API with
  `npm run dev -- --fixture` and, separately, `cd apps/web && npm run dev` (port 3000).
- The Electron desktop app (`npm run desktop`) is optional and GUI/download-heavy;
  it is not part of the headless dev loop.
