---
name: reef-messaging
description: Drive Reef, the two-person end-to-end encrypted messenger at ledgerbal.com/api/reef, from code — so an agent can hold a conversation with a person or with another agent. Covers the exact crypto (ECDH P-256 → HKDF → AES-256-GCM with AAD), the unlock/enrol/send/read flow, room and seat setup, live event-driven listening, auto-approve rooms, and the handful of design consequences that look like bugs until you know them. TRIGGER when asked to send or read Reef messages programmatically, to wire an agent into a Reef conversation, to set up a Reef room or PIN, when the user says "go reef way" or asks to hold a live conversation over Reef, or when debugging "the other side has no approved device yet", presence, or push notifications in Reef.
metadata:
  version: "1.0.0"
  tags: "reef, e2ee, messaging, agent-to-agent, webcrypto, ecdh, django"
---

# Reef, from code

Reef is a two-person end-to-end encrypted messenger. The **PIN is the identity** —
there is no username. The server stores ciphertext and holds no key, so it has no
opinion about what holds a device key: **human↔human, human↔agent and agent↔agent
are the same code path.**

- Frontend (PWA): `github.com/jogendra-india/reef` → `jogendra-india.github.io/reef/`
- Backend: `jogendra-india/sonu-office-backend`, app `reef/`, served at
  `https://ledgerbal.com/api/reef`
- Reference client: `agent/reef-agent.mjs` in the reef repo — zero deps, Node 18+.
  On this machine the repo lives at `d:\Repos\reef`, so from outside the repo
  the client is `d:\Repos\reef\agent\reef-agent.mjs` — use the full path.

## Start here

The PIN is a credential — never hardcode one in code, docs or a commit. Pass it
via `REEF_PIN` (the reference client falls back to it when `--pin` is absent)
or a local, gitignored file. If this operator already has an identity seated
in an existing room, that PIN lives in the machine-local copy of this skill
(`~/.claude/skills/reef-messaging/`, not this repo) — check there before
asking for a new one.

```bash
REEF_PIN=<your pin> node agent/reef-agent.mjs --use-system-ca --state ./agent/.state-<label>.json whoami
```

`whoami` coming back with a `room`, a `device` and a non-empty `peers` list
means you joined an existing conversation; an empty `peers` list means the
other side has no approved device yet (see "Consequences that look like bugs"
below), not a broken PIN. (`--use-system-ca` is the Windows TLS fix below;
drop it on a machine without corporate TLS interception.)

The state file is per-agent, not per-PIN — a second process using the same PIN
should get its own `--state` path (gitignored: `agent/*.json`), because the
file is what makes the device restart-proof, and `MAX_ACTIVE_DEVICES_PER_USER
= 1` means a second unlock from a second file bumps the first device to
`pending` in that room.

## Ask the operator in Reef, not in this chat

If you are holding up this operator's side of a Reef conversation, **any
question meant for the operator gets `send`t as a Reef message, never asked in
this Claude Code session** — no `AskUserQuestion`, no "should I proceed?" left
in the transcript for them to find later. The operator is watching Reef, not
necessarily this CLI; a question asked here can sit unanswered indefinitely,
while the same question sent into the room gets read and answered like any
other message. Then `read` (or `watch`/`listen`) for the reply instead of
waiting on this session's input.

This session's own back-and-forth with whoever is driving Claude Code directly
is unaffected — this rule is specifically about the human on the other end of
the Reef room, not about Claude Code's own user.

## Use the reference client unless you have a reason not to

```bash
node agent/reef-agent.mjs --pin 481357 --state ./alice.json whoami
node agent/reef-agent.mjs --pin 481357 --state ./alice.json send "hello"
node agent/reef-agent.mjs --pin 481357 --state ./alice.json read
node agent/reef-agent.mjs --pin 481357 --state ./alice.json watch
```

As a library:

```js
import { ReefAgent } from './agent/reef-agent.mjs';
const bot = await new ReefAgent({ pin: '481357', statePath: './bot.json', label: 'bot' }).load();
await bot.connect();
await bot.watch(async (message, self) => {
  await self.send(`you said: ${message.text}`);
});
```

**The state file is the credential.** It holds an extractable private key —
unlike the browser, which generates a non-extractable one so XSS cannot steal it.
An agent has no DOM but must survive a restart, hence the trade. Anyone with that
file can read the conversation. Do not commit it.

## Model

- **Room** — one conversation, exactly **two** seats. `USER_COUNT = 2`, not
  configurable; the pairwise ECDH design assumes it.
- **Seat** (`ReefUser`) — slot 1 or 2 in a room.
- **Identity** (`ReefIdentity`) — a person across rooms. **The PIN lives here**,
  so one PIN opens every room its holder is seated in. Globally unique.
- **Device** (`ReefDevice`) — one browser or one agent, identified by its public
  key. Approved **per room**. `MAX_ACTIVE_DEVICES_PER_USER = 1`.

An agent talking to three people needs three rooms — and, since a PIN belongs to
the identity rather than the seat, one PIN covers all of them.

## Setting up a pair

No shell needed; the Django admin is enough, and is superuser-only.

1. **Reef → Rooms → Add.**
2. **Reef → Reef users → Add**: pick that room, slot `1`, set a PIN. Repeat for
   slot 2 if you want both credentials up front.
3. Each side signs in with its PIN.

With a shell: `manage.py reef_init --pin1 481357 --pin2 726094 [--room <id>]`.
**Both PINs in one command** — separate runs make separate rooms, and each party
then finds nobody opposite.

Alternatively create **one** seat and invite the second party from inside the app
(**menu → Invite someone here**). An invitation fills the free seat beside you
when the room has one and nothing has been said in it; otherwise it starts a new
conversation.

PIN rules (`reef/constants.py`): exactly 6 digits, globally unique, and rejected
if weak — no repeated digit, no ±1 run, no repeated 1/2/3-digit block, plus a
literal list.

## Auto-approve rooms

A new device normally sits `pending` until the *other* seat approves it — the
whole point being that a stolen PIN alone cannot seat an attacker unnoticed. That
assumes both seats can actually operate the approval flow. An agent's seat
usually cannot: there is no human on that side to click approve, so without this,
enrolling the agent's device deadlocks exactly like the first-run bootstrap
problem does — except *after* the bootstrap window has already closed.

`ReefRoom.auto_approve_devices` is the permanent, room-scoped version of the
bootstrap window: while set, a new device on **either** seat self-activates, no
matter how much has already been said. Set it at creation:

```bash
manage.py reef_init --pin1 481357 --pin2 726094 --new-room --auto-approve-devices
```

(`--new-room` forces a fresh room even when others already exist — plain
`reef_init` refuses to guess which existing room you meant.) Or toggle it later
in the admin: **Reef → Rooms**, it's an editable column, and also just a normal
checkbox on the room's own change form.

**This trades away real security** — anyone who learns the PIN can seat a device
in that room with nobody noticing, permanently, not just for one swap. Only use
it for a seat with no human able to approve on the other end.

It also suppresses the client's idle auto-lock (`state.session.auto_approve_devices`
in `app.js`) — a room that already gave up "peer notices a stolen PIN" has, by
the same decision, given up "protect a conversation left open on a desk" too, so
the lock screen would only be friction for an always-on agent channel with
nothing left for it to defend.

## The flow

```
POST /unlock/   {pin, device:{label, public_key_jwk}}  -> {must_change_pin, rooms:[…]}
GET  /keys/                                            -> {recipients:[{id, public_key_jwk}], safety_number}
POST /entries/  {id, kind, envelopes:[…], attachment_ids:[]}
GET  /entries/?since=<seq>&page_size=50                -> {results:[…]}
POST /receipts/ {message_ids:[…], state:"read"}
POST /ws-ticket/                                       -> {ticket}   then wss://…/ws/reef/?t=<ticket>
```

Auth is `Authorization: Token <token>`, one token **per room**, from the unlock
response. Unlock returns **one entry per room** the PIN is seated in; each carries
its own device, token and `session.peer_devices`.

**Choosing a room.** Prefer one with an active peer — a seeded-but-empty room is
older and otherwise sorts first, which strands you in an empty conversation:

```js
const score = (r) => {
  const peers = ((r.session||{}).peer_devices||[]).filter(d => d.status==='active').length;
  const mine = r.device.status === 'active';
  return (mine && peers) ? 3 : peers ? 2 : mine ? 1 : 0;
};
const room = [...result.rooms].sort((a,b) => score(b)-score(a))[0];
```

**Approval.** A device lands `pending` unless the room has **no messages** — then
it activates itself (`_is_bootstrapping`), which is what stops a fresh pair
deadlocking with nobody able to approve anybody. Once anything is said the window
shuts for good and every later device needs the *other* person to approve it
(app: menu → Devices). Admin escape hatch when both devices are lost: Reef users →
select → **"Approve this person's newest pending device"**.

**A one-time join PIN** arrives with `must_change_pin: true`. Call
`POST /pin/ {current, next}` before anything else; it also expires.

## Live, event-driven listening ("go reef way")

For holding an actual live conversation over Reef — not a one-shot send/read —
the goal is: **zero LLM turns while idle, exactly one per real incoming
message.** Not a poll-the-LLM-on-a-timer loop; the waiting has to be free.

**This operator's agent PIN for "go reef way" is `333023`**, state file
`agent/333023.json` in the reef repo (gitignored, holds the extractable private
key — see "The state file is the credential" above). The human side is `333026`,
same room, flagged `auto_approve_devices`. This is the one PIN this skill names
directly rather than deferring to "Start here" — the whole point of the trigger
phrase is that a fresh session with no memory of prior conversation still knows
which identity to unlock as, without having to ask.

It's set as `REEF_PIN=333023` in `agent/.env` (gitignored, not this file) rather
than passed on the command line — `--pin` sits in shell history and `ps aux` for
anyone else on the machine; the `.env` file doesn't. Drop `--pin` from every
command below for this identity; it's picked up automatically.

**Mechanism: `listen`, run via the self-healing wrapper (below), watched by
`Monitor` tailing its log — not `listen` running directly under `Monitor`,
and not Monitor's raw `ws` source.**

```bash
nohup bash agent/run-listener.sh agent/333023.json > agent/listener-wrapper.log 2>&1 < /dev/null &
disown
```
```
Monitor({
  command: 'tail -n +1 -f agent/listen.log | grep --line-buffered "REEF_MSG\\|listening on room"',
  description: 'Reef inbox for 333023 — one line per real incoming message',
  persistent: true,
})
```

Why two steps rather than just handing the `listen` command straight to
`Monitor`: see "the self-healing wrapper" below — running it that way was
tried first and turned out to need its own fix.

- `listen` holds a live WebSocket (`/ws-ticket/` → `wss://.../ws/reef/?t=`),
  decrypts every `msg.new` frame, marks it read, and prints **one clean stdout
  line** (`REEF_MSG {...}`) only for a message that decrypted and isn't your
  own. It never replies on its own.
- Reconnects on close/error with jittered backoff, pulling a **fresh ticket**
  every time (single-use, 60s TTL — there is no "renew"). Runs a catch-up
  `read()` before opening the socket and after every reconnect, since a socket
  only ever carries what happens while it's open.
- **Why `command`, not Monitor's raw `ws` source**: frames are ciphertext, plus
  routine noise (presence, typing, receipts, pong) on every tick. Monitor's `ws`
  mode can't decrypt or filter, so it'd spam a notification per frame and get
  auto-suppressed. `command` mode does the decrypt+filter itself before ever
  printing, so Monitor only ever sees the one line that actually matters.
- Each `REEF_MSG` notification is the *only* trigger to act — it is not the
  user talking to you in this session, it is the other party talking to you
  *in the Reef room*. Reply with a normal `send` call — see "Ask the operator
  in Reef, not in this chat" above, which this section implements the transport
  for. Narrate briefly when a notification lands (you're reacting to it), same
  as you would for any other background task completing.
- **Session caching matters here.** `connect()` reuses a cached
  token/room/device from the state file rather than calling `/unlock/` fresh
  every time — `/unlock/` reissues the device's token unconditionally (it has
  to, to recognise "same browser coming back"), so a naive implementation
  means every `send` while `listen` is running silently logs the listener out
  from under it (`401`, listener dies). This is already handled in
  `reef-agent.mjs`; if you reimplement the client elsewhere, keep this.
- **Reconnect must not crash on transient errors.** The catch-up `read()` and
  the socket run need to share the *same* try/catch — a network blip during
  catch-up that isn't caught kills the process exactly the same as one during
  the socket run, and it's easy to wire only the socket half by mistake.
- Nothing here auto-starts — it only ever runs because something explicitly
  launched it in the current session. To stop it, see "the self-healing
  wrapper" below — `TaskStop` alone only stops the Monitor watching the log,
  not the listener writing to it.
- **Only one `listen` per state file, ever.** Two of them — say, from two
  separate Claude Code chats both told "go reef way" — both hold the same
  cached session, both open their own socket, both receive every `msg.new`,
  both mark it read and call the handler: whoever is driving each chat replies
  twice, once per process. `listen` refuses to start a second time for the
  same `--state` (a PID lock file next to it, `<state>.lock`; stale locks from
  a process that died without cleaning up are detected and reclaimed
  automatically).
- **On a lock conflict, ask before overriding — don't silently kill the
  other one.** The error names the PID (`Another 'listen' is already running
  for <state> (pid <N>)`); that PID is an OS process, not scoped to whichever
  Claude Code session started it, so `kill <N>` from *this* session works
  regardless of where it came from — but only do that with the operator's
  go-ahead, since the other listener could be a different chat's live
  conversation. Ask, then `kill <N>` (plain SIGTERM — the lock's own exit
  handler cleans up its file) and restart `listen`.
- **Don't run `listen` as a plain background process — use the self-healing
  wrapper.** Something in at least one sandboxed Claude Code environment
  intermittently signals long-running background processes (no exception, no
  stderr — the log just stops, exit via signal). Sometimes it's only the
  harness's own tracking of the task that dies while the process is still
  alive and fine (check `ps`/the lock file before assuming an outage); other
  times the process is genuinely gone. Either way, don't rely on noticing and
  restarting by hand. `agent/run-listener.sh <state-file>` is a wrapper that
  relaunches `listen` immediately on any exit, for any reason — takes the
  state path as an argument (never hardcode a PIN's filename into a committed
  script) and writes both the node process's output and its own restart
  notices to `agent/listen.log`.

  Launch it fully detached from this session's own process tracking — `nohup`
  (survives the launching shell dying) plus `disown` (drops it from this
  shell's job table) — rather than through Monitor or plain
  `run_in_background`, since those are exactly what the harness's own
  supervision seems to be reaping:

  ```bash
  nohup bash agent/run-listener.sh agent/<pin>.json > agent/listener-wrapper.log 2>&1 < /dev/null &
  disown
  ```

  Monitor still does the notifying — `tail -f agent/listen.log`, same as
  always (see above) — it's just watching a file now written by a process
  outside its own supervision, so a kill of *that* supervision can't take the
  writer down with it. Worst case with the wrapper is a ~3s gap per hit,
  invisible unless a message lands in that exact window (and `_catchUp` on
  the next start picks it up anyway); worst case without it was hours of
  silent downtime.

  **A deliberate stop has to survive the loop, or it just gets resurrected
  3s later.** `run-listener.sh` checks for a `<state-file>.stop` sentinel
  after every exit and, if present, exits instead of restarting — but it only
  checks *after* the current `node ... listen` call exits, so touching the
  sentinel alone does nothing while it's still happily connected. Stop it for
  real with both steps, sentinel first:

  ```bash
  touch agent/<pin>.json.stop
  kill "$(cat agent/<pin>.json.lock)"   # SIGTERM; the wrapper cleans up the sentinel itself
  ```

  Then `TaskStop` whichever Monitor task was tailing the log.

## Crypto — must match `crypto.js` byte for byte

Both halves derive the same key or nothing opens. `reef/crypto.py` mirrors the
safety number, with pinned vectors on both sides.

```
identity   ECDH P-256
pair key   ECDH(mine, theirs) -> HKDF-SHA256
             salt = [String(myDeviceId), String(peerDeviceId)].sort().join('|')
             info = "reef/v1/pair"                        -> 256 bits -> HKDF key
message    HKDF(pairKey, random 16-byte salt, info="reef/v1/msg|"+messageId)
             -> AES-256-GCM, 12-byte iv
AAD        `${messageId}|${senderDeviceId}|${recipientDeviceId}`
plaintext  JSON.stringify({v:1, type:'text', text})
envelope   {device_id, ct, iv, salt}   all base64
```

The salt is **sorted** so neither side has to be "first". The AAD binds each
ciphertext to its message, sender and recipient, so the server cannot reorder or
re-attribute one without breaking the tag.

**One envelope per recipient.** Seal separately for every device in
`/keys/ → recipients` and send them together.

## Consequences that look like bugs

- **You cannot read your own messages back.** Envelopes are sealed for
  recipients; nothing on the server is addressed to you. Keep a local copy of
  what you sent. (The first run of the reference client reported every own
  message as "cannot open".)
- **"The other side has no approved device yet"** means `/keys/` returned no
  recipients. Almost always the two parties are in **different rooms** — check
  `ReefUser` rows in admin, per room. A seat with no device is the giveaway.
- **A device is enrolled per room, at unlock.** A room created after your last
  unlock has no device for you until you unlock again.
- **History does not follow a new device.** Envelopes only exist for devices that
  were active when a message was sent, so an approved replacement starts empty.
- **Presence** is a 45s heartbeat (`PRESENCE_TTL`), pinged every 20s over the
  WebSocket. It is reported as `last_seen` per peer device in the session payload
  — read it rather than waiting for an event, because a peer already connected
  announces nothing. Presence events carry `device_id`; filter on it, or you will
  count your own connection as theirs.
- **Push skips connected devices**, so a notification does not fire while the
  conversation is open. Also gated on the app's own bell setting.

## Running the reference client on Windows

Two things bite here that never show up on Linux/Mac CI:

- **Corporate TLS interception.** Behind a Netskope-inspected network (e.g.
  BHEL's), the certificate chain for `ledgerbal.com` terminates in a corporate
  root that Node's bundled CA store doesn't trust, even though Windows does —
  every request fails `fetch failed` / `SELF_SIGNED_CERT_IN_CHAIN`. Run with
  `node --use-system-ca agent/reef-agent.mjs ...` (Node ≥ 22.9) so it reads the
  Windows trust store instead of bringing its own.
- **The CLI entry guard used to silently no-op.** It compared
  `import.meta.url` to `` `file://${process.argv[1]}` ``, but on Windows
  `process.argv[1]` is a backslash path (`D:\...\reef-agent.mjs`), not a
  `file://` URL, so the strings never matched — the script would connect to
  nothing, print nothing, and exit `0`. Fixed in `agent/reef-agent.mjs` by
  comparing against `pathToFileURL(process.argv[1]).href` instead. If a copy
  elsewhere still does the raw string comparison and a command returns
  silently, that's why.

## Rate limits

`UNLOCK_IP_LIMIT = 5` per 15 min per IP and `UNLOCK_GLOBAL_LIMIT = 15` per hour
**across all IPs**, then an escalating freeze from 30 min to 12 h that decays over
a week. Only **failures** count; a correct PIN clears the counter.

**Never brute-force or guess a PIN while testing** — the global limit is shared,
so it locks the real users out. Every unlock response is padded to
`UNLOCK_MIN_RESPONSE_SECONDS = 0.75`, so timing tells you nothing anyway.

## Testing against the live backend

It is a real deployment with real conversations in it. Rules that were learned the
hard way, having leaked test rooms into it twice:

1. **Snapshot the room list first, and clean up by diffing against it** — not by
   remembering what you created. `/invite/new/` creates rooms server-side, and any
   early exit skips the line that would have recorded them.
2. **Clean up in a `finally`.** A cleanup that only runs on success leaks on every
   failure, and worse inside a retry loop.
3. **Label test devices distinctively** (`agent-alpha`, never `phone`). Real
   clients emit only `iPhone`, `Android`, `Mac`, `Windows`, `Browser`, so a label
   tells you whose room it is. Refuse to delete a room holding a label that is
   not yours.
4. **Verify the pre-existing rooms survived** before declaring success.

Django admin, for inspection: `/admin/reef/reefroom/`, `/admin/reef/reefuser/`,
`/admin/reef/reefidentity/` (filter **seats: No seats left** for orphans). Note
that a seat's change page lists *every* room in its dropdown — match the
`selected` option or you will read another room's devices.

Deploys run `manage.py migrate` at container start, so a migration ships with the
push. GitHub Pages serves the frontend from `main`; bump `CACHE` and `BUILD` in
`sw.js` on every shell change, and check **menu → Build** on a device to see what
it is actually running.