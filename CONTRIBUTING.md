# Contributing

Open a pull request from a fork. Do not ask for write access.

Only the owner merges to `master`. CI must be green. Contributors do not merge.

Do not run `./scripts/ship.sh`. A merge is not a download. The owner publishes GitHub `releases/latest` from the main checkout.

## Your pull request title is the release note

A merge squashes to one commit, and its subject is your title, word for word.
`ship.sh` builds the GitHub release body from those subjects, and Boxaide
prints that body inside the app under "What is new". Your title is read by
somebody deciding whether to restart.

So write what the app now does, in the present tense, for a person who has
never read this repo: "Archive mail, and give an agent's sweep one undo", not
"refactor sweep handler". A CI check called `subject` refuses a `feat:` prefix,
a diff-word opener (refactor, bump, tweak, wip, misc), a lowercase start, a
trailing full stop, an em dash, and anything over 80 characters. Edit the title and it runs again.

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
