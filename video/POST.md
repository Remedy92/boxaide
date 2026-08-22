# The X post

Attach `out/boxaide-launch-x.mp4` (57s, music and narration). Set
`out/poster.png` as the thumbnail if X offers the choice — a scroll-past still
then carries the name and the licence.

`out/boxaide-launch-x-silent.mp4` is the same cut with no audio, if you would
rather post it mute. Nothing in the video depends on sound.

Post the video with the main tweet, not in a reply. The first line has to work
with the sound off and the video paused.

---

## Main post

> Every AI inbox wants your mailbox.
>
> I built one that doesn't. Boxaide is now open source.
>
> A self-hosted inbox for any IMAP/SMTP account — Gmail, Fastmail, Outlook,
> your own box — and 56 MCP tools so Claude Code, Codex or Cursor can read,
> search and draft your mail. On your machine. No account, no subscription.
>
> An agent it launches can never send. It asks.
>
> MIT → github.com/Remedy92/boxaide

280-char check: the body above runs long for a non-Premium account. The short
cut, if you need one:

> Every AI inbox wants your mailbox. I built one that doesn't.
>
> Boxaide: a self-hosted inbox for any IMAP/SMTP account, with 56 MCP tools so
> your agent can read, search and draft your mail — on your machine.
>
> An agent it launches can never send. It asks.
>
> MIT → github.com/Remedy92/boxaide

---

## The thread, if you want one

**2/** The whole thing runs on 127.0.0.1. Boxaide talks to your mail server
over plain IMAP/SMTP and stores what it needs in SQLite on your disk, encrypted
at rest. There is no Boxaide server to send your mail to, because there is no
Boxaide server.

**3/** Your agent connects over MCP and gets 56 tools: list and search mail,
read a message, create and edit drafts, file into folders, plus CRM contacts, a
deal pipeline, scheduled automations, an outbox and calendar.

**4/** The one thing it cannot do is send. `message_send`, `message_move`,
`meeting_create` and `meeting_cancel` are queued instead of run — the call is
recorded and put in front of you with the actual body, and you send it or drop
it. That check sits in the server ahead of every dispatch, not in a system
prompt an agent can talk its way around.

**5/** Also in there: ⌘K for everything, drag-and-drop into folders, undo on
archive and delete, a CRM built from your own mail, and a Claude Desktop
extension.

**6/** Two commands:
```
git clone https://github.com/Remedy92/boxaide.git
cd boxaide && npm install && npm run dev
```
Add `--fixture` to poke at it with demo mail before connecting a real account.

MIT. Issues and PRs welcome → github.com/Remedy92/boxaide

---

## Notes on the copy

- No hashtags. They cost reach on X now and read as marketing on a dev launch.
- The repo link is in the main post rather than a reply. The link penalty is
  not what it was, and a launch post whose CTA is one reply down loses people.
- The video runs 57 seconds. Under a minute keeps completion rate up, which
  is what X actually ranks on.
- "56 MCP tools" is a measured number, not a round one. Re-run `tools/list`
  before posting if the tool surface has moved since 2026-08-22.
- "An agent it launches can never send" is the precise claim. Do not shorten it
  to "agents can never send": a caller holding your master bearer token is you,
  and sends directly.
