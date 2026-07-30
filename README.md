# Reef

A two-person end-to-end encrypted messenger. Unlock with a 6-digit PIN — the
PIN is the identity, so there is no username to type.

**Live:** https://jogendra-india.github.io/reef/

## What it does

- 6-digit PIN unlock; the backend works out *who* logged in from the PIN alone
- End-to-end encrypted messages, photos and reactions — the server stores
  ciphertext and holds no key
- A new device gets in only after the *other* person approves it
- Edit within 5 minutes, delete for everyone, hide for me, reply, react
- Typing indicator, presence, delivery and read ticks
- Works offline: history reads from IndexedDB and anything composed while
  offline queues in an outbox and sends itself on reconnect
- Push notifications that the service worker decrypts locally, defaulting to
  showing nothing on a locked screen
- Installs as a PWA; nothing in the title, icon, URL or manifest suggests a
  messenger

## Stack

One HTML file plus four plain scripts and a service worker. No framework, no
build step, and — deliberately — **no CDN**. In an end-to-end encrypted app a
third-party script tag is a key-exfiltration path, so everything ships from
this origin.

| File | Job |
|---|---|
| `index.html` | Shell and all styles |
| `crypto.js` | ECDH P-256 → HKDF → AES-256-GCM, and the safety number |
| `db.js` | IndexedDB: keys, history, outbox, profiles, media |
| `api.js` | REST client and the reconnecting WebSocket |
| `app.js` | The UI |
| `sw.js` | Offline shell, background flush, push decryption |

The API endpoint it talks to is configured at the top of `api.js`.

## Crypto, briefly

Each device generates an ECDH P-256 key pair with the private half
**non-extractable**, stored as a `CryptoKey` in IndexedDB — script cannot
export it, so an XSS bug cannot steal it. A key per device pair comes from
ECDH + HKDF, and each message gets its own AES-256-GCM key derived with a fresh
random salt. The additional-authenticated-data binds every ciphertext to its
message id, sender and recipient, so the server cannot re-order or re-attribute
one without breaking the tag.

The PIN never touches key material. It is an access credential, which is why
changing it re-wraps nothing and loses no history.

Compare the **safety number** (menu → Safety number) out loud with the other
person. It is the only thing that reveals a device added behind your back, so
it is worth doing once, and again whenever either of you replaces a phone.

## Setup

On the backend, once:

```bash
python manage.py migrate reef
python manage.py reef_init --pin1 481357 --pin2 726094   # pick your own
```

Both PINs in **one** command — that is what seats the two people in the same
room. Two separate runs give two separate conversations, and each person then
finds nobody on the other side.

No shell on the deploy? The same thing from Django admin, as a superuser:
**Reef → Rooms → Add**, then **Reef → Reef users → Add** twice against that
room, slot 1 and slot 2, a PIN each.

Then each person opens the site and enters their PIN. The first device in a room
that has no messages yet lets itself in; once anything has been said, every new
device needs the other person to approve it from **menu → Devices**.

Inviting from inside the app — **menu → Start a conversation** — always creates
a *new* room for that pair, so a room seeded above and never used stays empty.
Delete it from **Reef → Rooms** rather than leaving a conversation with nobody
in it.

## Known limits

- **History does not follow a new device.** Envelopes only exist for devices
  that were active when a message was sent, so an approved replacement starts
  from an empty thread. Transfer is planned, not built.
- **Web push on iOS needs the app on the Home Screen** (iOS 16.4+). In a normal
  Safari tab there are no notifications at all.
- **No haptics on iOS** — the vibration API does not exist there.
- **Search is local.** The server cannot index what it cannot read.
- The server still sees metadata: who, when, and how big.
