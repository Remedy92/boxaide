# Contributing

Open a pull request from a fork. Do not ask for write access.

Only the owner merges to `master`. CI must be green. Do not merge your own PR.

Do not run `./scripts/ship.sh`. A merge is not a download. The owner publishes GitHub `releases/latest` from the main checkout.

## Setup

Node 22 or later.

```bash
npm install
./scripts/start.sh --fixture
```

```bash
npm test
cd apps/web && npm run lint && npm run build
```

Do not put mail passwords, tokens, or a live `.env` in issues or PRs. Report security bugs through [SECURITY.md](SECURITY.md).
