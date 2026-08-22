# Boxaide launch video

A Remotion cut for the open-source launch post on X, plus a 1:1 variant and a
poster frame.

```bash
cd video
npm install
npm run music                    # public/soundtrack.wav — synthesised, ~10s
npm run vo                       # public/vo/*.wav + src/vo-durations.json
npm run build                    # out/boxaide-launch-x.mp4   1920x1080, 30fps, 57s
npm run build:square             # out/boxaide-launch-square.mp4   1080x1080
npm run build:silent             # the same cut with no audio at all
npm run still                    # out/poster.png
npm run dev                      # Remotion Studio
```

`out/`, `public/soundtrack.wav` and `public/vo/` are gitignored — regenerate
rather than committing tens of megabytes of media. `npm run build` regenerates
the music first, so a change to the act lengths cannot ship with a stale bed.

The voiceover needs `AI_GATEWAY_API_KEY`. A full regeneration costs about two
cents. Everything else works with no
credentials: before `make-voiceover.mjs` has run, `src/vo-durations.json` is
`{}`, `VO_LINES` is empty, and the cut renders with music only.

## Why it is cut the way it is

X autoplays muted in a small feed rectangle, and rewards completion rate, so:

- **57 seconds, not 90.** Under a minute keeps completion high, and the
  agent beat needed fourteen of them to be legible.
- **1920x1080 H.264 + AAC.** X's own recommendation for landscape, and the
  only codec pairing it accepts without upload errors. The square cut exists
  because a square post takes close to twice the height on a mobile timeline;
  9:16 is deliberately absent, because the product is a three-pane desktop app
  that a vertical crop destroys.
- **Every claim is on screen as type**, 40px or larger, held at least a second.
  The narration never reads a caption aloud — it adds what the screen does not
  say, so muted viewers lose nothing and unmuted viewers gain something.
- **The last frame fades to the first frame's ground**, so X's default loop
  reads as deliberate.
- **Audio is a bonus, never a requirement.** The bed and the narration are
  mixed to be worth unmuting, but every claim is also on screen as type, and
  `build:silent` exists for posting without any audio track at all.

## The eight beats

| # | Beat | Frames | The question it answers |
| --- | --- | --- | --- |
| 1 | hook | 150 | What is this? |
| 2 | inbox | 225 | What does it look like? |
| 3 | ask | 240 | What do I say to it? |
| 4 | agent | 420 | What does it do? |
| 5 | approval | 225 | Can I trust it? |
| 6 | automations | 225 | What happens while I'm away? |
| 7 | local | 165 | Where does my mail live? |
| 8 | cta | 180 | How do I get it? |

That order is the order somebody deciding whether to install this actually
asks. The agent beat is nearly twice any other, because it is the only beat
that shows the product doing the thing the product is for.

Lengths live in `src/timeline.ts`; the music and the voiceover both read that
file, so changing a number moves the arrangement and the narration with it.

There was a ninth beat about ⌘K and keyboard shortcuts. It was cut: nobody
installs a mail client for its shortcuts.

## One idea per beat

The rule that shapes every scene, enforced by `src/ui/beat.tsx`:

- **One line of type per beat.** No kicker above it, no pill below it, no row
  of chips underneath. If a fact cannot survive being folded into that one
  line, it was not important enough for a 45-second video.
- **A fixed caption band and a fixed stage.** The app is centred on the same
  point at the same scale in every beat, so a cut between two app scenes reads
  as the same screen changing rather than a new shot being set up.
- **Something arrives, then it stops.** Every beat is long enough to hold still
  and be read. An earlier cut of this video never stopped moving, pushed in on
  every scene, and was tiring to watch — that is what `beat.tsx` exists to
  prevent.

Two beats do go closer than rest — the approval card and the automation card
are both rendered large and alone, because each is a paragraph of text that is
illegible at rest scale and is the entire argument of its beat.

## Audio

Two stems, both generated, neither licensed:

- `scripts/make-music.mjs` synthesises the bed from scratch — kick, sub, hats,
  claps, an arp and a pad, at 124 BPM in A minor. Risers and impacts land on
  **beat start frames rather than bar lines**, because a hit half a beat off
  the cut is worse than no hit; there are only three, because a hit on every
  scene change is a hit on nothing. The drums drop out entirely under the
  guardrail beat so that claim is heard rather than danced to.
- `scripts/make-voiceover.mjs` generates narration through **Vercel AI
  Gateway**, using `openai/tts-1-hd` with the `onyx` voice.

### Why not the free model

Fish Audio is free on the Gateway through 18 September 2026 and `s1` reads
inline emotion markers, so it was the obvious choice and it is what the first
version used. It cannot narrate: **with no voice reference it picks a different
speaker on every request.** Measured, same sentence, three calls:

| call | median F0 |
| --- | --- |
| 1 | 181.5 Hz |
| 2 | 96.9 Hz |
| 3 | 155.8 Hz |

A woman, a deep man and a mid-range man in one 45-second video. `grok-tts`
keeps the speaker but drifts 16.8 Hz between calls, which is audible across a
cut. `openai/tts-1-hd` + `onyx` drifts 0.6 Hz. Across the nine lines actually
in the cut, the spread is 9.9 Hz — one person.

Run `npm run vo -- --model fish-audio/s1-free` to hear the problem.

### Register

Set **once**, for the whole script, by the `instructions` field in the
generator. The earlier script carried per-line markers — `[calm]`, `[excited]`,
`[serious]` — and changing emotion line by line is what made it sound like an
advert rather than a person explaining something they built.

### Gotcha, undocumented

The Gateway speech endpoint 400s with "Unsupported gateway protocol version"
unless you send `ai-gateway-protocol-version: 0.0.1`. Only that exact value
works; 1, 2 and 3 are all rejected. The AI SDK sets it for you, which is why
the curl example in Vercel's docs omits it.

### Mix

The bed ducks to 32% under each narration line with a 6-frame ramp, driven by
the measured durations in `src/vo-durations.json`. Roughly half the video has
nobody talking, which is deliberate — the beats that matter are the still ones
after a line lands. The generator refuses to let two lines overlap or run past
the beat they describe; the first draft of the script failed both checks.

Peak −4.4 dB in the finished file, so nothing clips.

## Why the UI is rebuilt rather than screen-recorded

`src/ui/` is a hand-built copy of the real app at its real logical size
(1440x900, dark theme). `tokens.ts` is `apps/web/src/app/globals.css` copied
value-for-value; the rail is 228px, the list 360px, a comfortable row 62px, and
the message row is the same `18px minmax(0,1fr) auto` grid the app uses. It was
checked against screenshots of `npm run dev -- --fixture`.

A rebuild rather than a capture because every element has to be animatable per
frame — rows cascading, tool calls streaming, a prompt typing — which a video
file cannot give you. If this and the app ever disagree, this is wrong.

## Verified against the real app

Every rebuilt surface was checked line by line against `apps/web/src` by a
parallel verification pass (five readers plus a synthesis step). It returned 62
findings. The worst, and the one that shaped this cut:

> The agent pane invented a developer-style tool trace — mono MCP tool names,
> an argument column, green ticks and per-step milliseconds — where the real
> product shows plain-English sentences the agent wrote.

The app renders `<li>{step.text}</li>` with a 5px hollow ring on a downward-
fading rail (`agent-run.tsx:243-281`), and the sentences come from a real
`TOOL_WORDS` map — "Reading your inbox", "Writing a draft". The video now does
the same. It is both more accurate and far more legible: "Reading your work
inbox" reads at a glance in a way `messages_list │ work · INBOX · 31` never
does, at any size.

Other findings acted on:

| Was | Is | Evidence |
| --- | --- | --- |
| Agent asserts "due Thursday" | "before Friday" | `src/cli.ts` seeds "before Friday" — the agent was contradicting the mail it had just read |
| Four invented message snippets | the fixture's real bodies | `src/cli.ts:118-172` |
| Approval decline button "Not now" | "Don't" | `agent-approvals.tsx:208` |
| Primary button flips to a green "Sent" | stays "Send it" | approving removes the card and toasts "Done." — there is no confirmation state |
| Approval From "you@work.test (work)" | "work" | `approvals.ts:353` prints the raw account argument |
| Cron `0 8 * * 1-5` → "Weekdays at 08:00" | `0 8 * * *` → "Daily at 08:00 AM" | `describeCron` has no range branch; it would have printed the raw cron twice |
| "Fridays at 17:00" | "Weekly on Friday at 05:00 PM" | `automation.ts:57-66` |
| "Tomorrow at 08:00", "In 12 minutes" | "Today at …" | `formatReaderDate` has no Tomorrow and no relative branch |
| Green status dots on mailboxes and Automations | nothing | `AccountRow` draws nothing for a healthy mailbox |
| A second "New chat" row under CHATS | "No chats yet." | it duplicated the pinned button two rows above |
| Rail footer: Columns / Server / Clock | Settings / density / theme | two of the three implied features that do not live there |
| Reader toolbar missing Archive; open envelope on unread mail | Archive present; closed Mail | `reader-action-bar.tsx` |
| One-line mailbox rows | alias plus account address | `account-row.tsx:106-136` |
| Automations header "2 on · 1 paused" | just the refresh button | no count exists in that view |
| No agent/model row on automation cards | both pills present | every real card binds a run to an agent |
| `unread newer_than:1d` in a search step | plain words | `messages_search` feeds an IMAP TEXT search; Gmail operators match literally and return nothing |

## Claims made in the video, and where each was checked

| Claim | Checked against |
| --- | --- |
| 56 MCP tools | `tools/list` on a running `--fixture` server, 2026-08-22 |
| Tool names in act 3 | `src/mcp/server.ts` |
| "An agent Boxaide launched can never send. It asks." | `APPROVAL_TOOL_NAMES` in `src/agent/approvals.ts`, enforced in `dispatch()` in `src/mcp/server.ts`. Note the wording: the gate applies to *scoped* callers. A caller holding the master bearer token is the user, and still sends directly. |
| `message_send · message_move · meeting_create · meeting_cancel` | the same set |
| Encrypted at rest | `src/crypto/secrets.ts`, used by `src/mail/index-store.ts` and `src/db/store.ts` |
| The two install lines | `COMMAND_LINES` in `apps/web/src/app/install/page.tsx` |
| The three agent prompts in beat 3 | `SUGGESTIONS` in `apps/web/src/components/agent/agent-view.tsx`, verbatim |
| "Automations are created by talking to the agent" | the empty state in `automations-view.tsx`; there is no create form in the app |
| The automation cards' shape | `automation-card.tsx` — including printing the schedule sentence *and* the raw cron |

Re-measure the tool count before re-cutting; it moves.
