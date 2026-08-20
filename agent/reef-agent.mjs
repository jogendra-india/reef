#!/usr/bin/env node
/* A Reef client for something that is not a browser.
 *
 * Reef's server is agnostic about what holds a device key — it only ever sees a
 * public JWK and ciphertext — so an agent is a first-class participant, not a
 * special case. Any pair works: two people, two agents, or one of each. The
 * crypto here is a line-for-line port of crypto.js, because both halves of a
 * conversation must derive the same key or nothing opens.
 *
 * One deliberate difference from the browser. There, the private key is
 * generated non-extractable and lives in IndexedDB so an XSS bug cannot steal
 * it. An agent has no DOM and no XSS, but it does need to survive a restart, so
 * its key is extractable and written to a state file. Treat that file as the
 * credential it is: whoever holds it can read the conversation.
 *
 * Zero dependencies. Node 18+.
 *
 *   node reef-agent.mjs --pin 481357 --state ./alice.json whoami
 *   node reef-agent.mjs --pin 481357 --state ./alice.json send "hello"
 *   node reef-agent.mjs --pin 481357 --state ./alice.json read
 *   node reef-agent.mjs --pin 481357 --state ./alice.json watch
 *
 * `--pin` sits in shell history and `ps aux` for anyone else on the machine
 * to read. Put `REEF_PIN=481357` in `agent/.env` instead (see .env.example)
 * and drop `--pin` entirely — it's picked up automatically.
 */


import { webcrypto as crypto } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import {
  existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, appendFileSync,
  openSync, closeSync, fsyncSync, renameSync, statSync,
} from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { join } from 'node:path';

/* A PIN typed after --pin sits in shell history and in `ps aux` for anyone
 * else on the machine to read. `agent/.env` (gitignored, never committed) is
 * the alternative: `REEF_PIN=<your pin>` there is picked up automatically,
 * nothing to pass on the command line at all. Real environment variables
 * still win over the file, same as every other dotenv convention — this is
 * only a floor, not an override. Co-located with the script, not the cwd, so
 * it's found the same way regardless of where you run the command from. */
(function loadDotEnv() {
  const envPath = fileURLToPath(new URL('.env', import.meta.url));
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
})();

const API = process.env.REEF_API || 'https://ledgerbal.com/api/reef';
const WS_BASE = process.env.REEF_WS || 'wss://ledgerbal.com/ws/reef/';

const PAIR_INFO = 'reef/v1/pair';
const MSG_INFO = 'reef/v1/msg|';
const enc = (s) => new TextEncoder().encode(s);
const b64 = (bytes) => Buffer.from(new Uint8Array(bytes)).toString('base64');
const unb64 = (text) => new Uint8Array(Buffer.from(text, 'base64'));

/* --- crypto: must match crypto.js exactly ------------------------------- */

async function newIdentity() {
  // Extractable, unlike the browser's — an agent has to be able to persist it.
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']
  );
  const priv = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const pub = await crypto.subtle.exportKey('jwk', pair.publicKey);
  // Only the four fields the server and the safety number agree on; browsers
  // disagree about the extras and a fingerprint must not depend on that.
  return { privateJwk: priv, publicJwk: { kty: pub.kty, crv: pub.crv, x: pub.x, y: pub.y } };
}

const importPrivate = (jwk) =>
  crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, false,
                          ['deriveKey', 'deriveBits']);

async function derivePairKey(privateKey, peerJwk, myDeviceId, peerDeviceId) {
  const peerKey = await crypto.subtle.importKey(
    'jwk', { ...peerJwk, ext: true }, { name: 'ECDH', namedCurve: 'P-256' }, false, []
  );
  const shared = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: peerKey }, privateKey, 256
  );
  const base = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveBits']);
  // Sorted, so both sides derive the same key without agreeing who is first.
  const salt = enc([String(myDeviceId), String(peerDeviceId)].sort().join('|'));
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info: enc(PAIR_INFO) }, base, 256
  );
  return crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
}

const messageKey = (pairKey, salt, messageId) =>
  crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: enc(MSG_INFO + messageId) },
    pairKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
  );

// Binds the ciphertext to who sent it, to whom, and as which message — so the
// server cannot reorder envelopes or re-attribute one without breaking the tag.
const aad = (id, from, to) => enc(`${id}|${from}|${to}`);

async function seal(pairKey, body, ids) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await messageKey(pairKey, salt, ids.messageId);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad(ids.messageId, ids.senderDeviceId, ids.recipientDeviceId) },
    key, enc(JSON.stringify(body))
  );
  return { ct: b64(ct), iv: b64(iv), salt: b64(salt) };
}

async function open(pairKey, envelope, ids) {
  const key = await messageKey(pairKey, unb64(envelope.salt), ids.messageId);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: unb64(envelope.iv),
      additionalData: aad(ids.messageId, ids.senderDeviceId, ids.recipientDeviceId) },
    key, unb64(envelope.ct)
  );
  return JSON.parse(new TextDecoder().decode(plain));
}

/* An attachment blob gets its own random AES-256-GCM key, generated by the
 * sender and carried to us inside the (already-sealed) message plaintext —
 * never past the server in the clear. Mirrors crypto.js's openBlob exactly;
 * there is no sealBlob here yet, since sending files isn't implemented, only
 * receiving them. */
async function openBlob(ciphertext, keyB64, ivB64) {
  const key = await crypto.subtle.importKey('raw', unb64(keyB64), { name: 'AES-GCM' }, false, ['decrypt']);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(ivB64) }, key, ciphertext);
  return new Uint8Array(plain);
}

/* --- transport ---------------------------------------------------------- */

async function request(path, { method = 'GET', token, json } = {}) {
  const headers = {};
  if (token) headers.Authorization = 'Token ' + token;
  if (json !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(API + path, {
    method, headers, body: json === undefined ? undefined : JSON.stringify(json),
  });
  if (response.status === 204) return null;
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const err = new Error(body.detail || `${method} ${path} -> ${response.status}`);
    err.status = response.status;
    // The machine-readable half of the error, not just the sentence: a caller
    // deciding whether a failure is worth retrying cannot do it by matching on
    // `detail` text, and everything past `status` was being thrown away.
    err.code = body.code;
    err.body = body;
    throw err;
  }
  return body;
}

/* --- state on disk -------------------------------------------------------
 *
 * One file per identity, and more than one process writing it. `listen` runs
 * for days off a single load(); every `send` and `read` is a separate
 * short-lived process that loads, changes one thing and exits. So a save()
 * that serialised whatever this process held in memory was not saving a
 * change, it was publishing a whole snapshot — and a long-lived process's
 * snapshot goes stale the moment anything else writes.
 *
 * Observed live: `send` adds an entry to `sent` and writes it; minutes later
 * the listener handles an incoming message, saves its own hours-old map, and
 * every entry added in between is gone. After a few listener restarts across
 * one session the file held six entries from an older conversation and
 * nothing from the current one. Delivery was never affected — the message is
 * on the server before save() is reached — but a device's own sends can only
 * ever come from this cache (nothing on the server is sealed for the sender),
 * so a wiped one is a thread with holes where your own words were.
 *
 * A save is therefore a merge, not a snapshot: re-read the file, fold this
 * process's changes into what is actually there now, write that back. Which
 * fold is right is a per-field question, and that is all mergeState() is.
 *
 * Deliberately not an append-only log. `sent` alone would suit one — its
 * entries are immutable, insert-only and capped — but `session` and `seq` are
 * single current values that get replaced rather than accumulated, so they
 * need a merge whatever `sent` does. Once the merge exists, `sent` is one
 * line of it: the union of two insert-only maps loses nothing an append log
 * would have kept. A second file would buy a slightly narrower race for the
 * cost of a second format to compact, gitignore and keep alongside a file
 * people copy by hand — holding the plaintext of every message sent, at that.
 *
 * The merge alone leaves one window: two processes that both read before
 * either writes both write, and the first one's change is gone again. That
 * looked too narrow to be worth a lock — a few syscalls over a 3 KB file —
 * right up until the test measured it. Twelve `send`s launched together lost
 * entries on every run with the merge in place and nothing serialising it, so
 * the read-merge-write is taken under an advisory lock (see acquireSaveLock)
 * and the whole of save() is synchronous to keep the section it guards as
 * short as it can be.
 */

const SENT_LIMIT = 500;

// Windows denies an open while another process renames its replacement into
// place; the same codes come back from the rename itself. Never permanent.
const BUSY = ['EPERM', 'EACCES', 'EBUSY'];

/* Retrying here is not politeness, it is load-bearing: mistaking a file that
 * is momentarily locked for a file that is not there would have save() merge
 * against nothing and write precisely the clobber this section exists to stop.
 * So null means the file genuinely does not exist, and a lock that outlasts
 * the retries is raised rather than assumed away. */
function readFileWithRetry(path) {
  for (let attempt = 0; ; attempt++) {
    try {
      return readFileSync(path, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      if (attempt >= 10 || !BUSY.includes(e.code)) throw e;
      sleepSync(10);
    }
  }
}

/* The file as it is *now*, to merge into. Content that will not parse is
 * treated as absent rather than fatal: save() is on the listener's
 * incoming-message path, where throwing would take the room down over a file
 * this call is about to rewrite correctly anyway. load() is deliberately
 * stricter — see there. */
function readStateFile(path) {
  const raw = readFileWithRetry(path);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (e) {
    process.stderr.write(`reef: state file ${path} did not parse (${e.message}); rewriting it\n`);
    return null;
  }
}

/* Field by field, because "whose copy wins" is a different question for each.
 *
 *   identity  the device key, written once. Whatever is on disk is what the
 *             server has enrolled, so it is never overwritten — losing it is
 *             the one clobber here that reconnecting cannot undo.
 *   session   token/room/device, replaced wholesale by _unlockFresh(). Only a
 *             process that has just unlocked knows anything the file doesn't;
 *             everyone else leaves it alone. A stale token written over a
 *             fresh one is survivable (the next call 401s and re-unlocks) but
 *             that re-unlock invalidates the token whoever *was* using it
 *             holds, which is the exact churn connect()'s cache exists to end.
 *   seq       a resume cursor into a total order — the high-water mark of what
 *             anything using this identity has consumed — so the higher wins.
 *   sent      insert-only and immutable, so the union is simply correct. The
 *             cap applies to the union, once, rather than each writer trimming
 *             its own partial copy and calling the result the whole map.
 *
 * Anything else on disk — a field some newer version of this file knows about
 * and this process does not — is carried through untouched rather than
 * dropped for being unrecognised.
 */
function mergeState(disk, mine, { sessionIsMine }) {
  const merged = { ...disk, ...mine };
  merged.identity = disk.identity || mine.identity;
  merged.session = sessionIsMine ? mine.session : (disk.session || mine.session);
  merged.seq = Math.max(Number(disk.seq) || 0, Number(mine.seq) || 0);

  const sent = { ...(disk.sent || {}), ...(mine.sent || {}) };
  const ids = Object.keys(sent);
  // Insertion order is chronological for both halves, so the front of the
  // merged list is the oldest — same rule as before, applied to more of it.
  for (const id of ids.slice(0, Math.max(0, ids.length - SENT_LIMIT))) delete sent[id];
  merged.sent = sent;

  return merged;
}

/* A synchronous pause. Atomics.wait is the only sleep Node has that neither
 * yields to the event loop (which would let another save start inside this
 * one) nor spins a core. */
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch (e) {
    /* refused (some embedders forbid blocking); the retry is still worth making */
  }
}

/* Serialises the read-merge-write in save(). Exclusive create is the whole
 * primitive — the same trick claim-message.sh uses with mkdir, no dependency
 * and nothing to install — and the file holds the owner's pid purely so a
 * human looking at a leftover one can see who left it.
 *
 * Advisory on purpose: a lock that cannot be taken is skipped, not raised.
 * Every writer is merging anyway, so proceeding unlocked is at worst the narrow
 * race this closes, whereas refusing to save would lose the change outright —
 * a worse version of the bug being fixed.
 */
const SAVE_LOCK_STALE_MS = 5000;
// Long enough that a lock left by a process that died inside save() always
// becomes steal-eligible before a waiter gives up and writes unlocked.
const SAVE_LOCK_WAIT_MS = SAVE_LOCK_STALE_MS + 1000;
const noop = () => {};

/* Wrong in the safe direction, deliberately: stealing a lock somebody is
 * actually holding puts two writers in the critical section, which is the one
 * thing this is here to prevent, so age is the only evidence accepted.
 *
 * The obvious extra check — is the pid in the file still alive — is not here
 * on purpose. It was, and it was the single largest source of lost updates in
 * the test: `process.kill(pid, 0)` came back ESRCH for processes that were
 * demonstrably alive and mid-save (locks 0.2ms to 18ms old), every such false
 * verdict put a second writer inside the section, and every run with one lost
 * an entry. A liveness probe that is wrong in that direction is worse than no
 * probe at all, and all it bought was recovering from a crash-during-save
 * sooner than the timeout below already does.
 *
 * Age comes from the file's own mtime rather than a timestamp written inside
 * it, because there is a moment between "created" and "written" when the
 * content is still empty, and reading that as an unparseable timestamp is a
 * false positive on exactly the contended path where it matters. */
function saveLockIsStale(lockPath) {
  try {
    // A save holds this for tens of milliseconds — the fsync dominates — and
    // its slowest possible path, every read and rename retry exhausted, is
    // still inside a second. Anything this old was abandoned mid-save.
    return Date.now() - statSync(lockPath).mtimeMs >= SAVE_LOCK_STALE_MS;
  } catch (e) {
    return false; // already gone, or momentarily unreadable: not ours to steal
  }
}

function acquireSaveLock(statePath) {
  const lockPath = statePath + '.save.lock';
  const mine = `${process.pid} ${Date.now()}`;
  const deadline = Date.now() + SAVE_LOCK_WAIT_MS;
  do {
    let fd;
    try {
      fd = openSync(lockPath, 'wx');
      writeFileSync(fd, mine);
      closeSync(fd);
      return () => {
        try {
          // Only if it is still ours: a stale-lock steal may have replaced it,
          // and unlinking the replacement would drop somebody else's guard.
          if (readFileWithRetry(lockPath) === mine) unlinkSync(lockPath);
        } catch (e) {
          /* already gone */
        }
      };
    } catch (e) {
      if (fd !== undefined) closeSync(fd);
      /* EEXIST is "somebody holds it". EPERM/EACCES is the *same* thing on
       * Windows, where a file whose last handle has closed but whose delete
       * has not yet completed refuses to be re-created — held, in other words,
       * for another millisecond. Treating that as "no lock is available here"
       * skipped the lock entirely, and under real contention that is the
       * common case, not a rare one. */
      if (e.code !== 'EEXIST' && !BUSY.includes(e.code)) return noop; // odd filesystem: carry on unlocked
      if (e.code === 'EEXIST' && saveLockIsStale(lockPath)) {
        try {
          unlinkSync(lockPath);
        } catch (stale) {
          /* somebody else cleared it first */
        }
        continue;
      }
      sleepSync(5);
    }
  } while (Date.now() < deadline);
  return noop;
}

/* A half-written state file is the same class of loss as a clobbered one and
 * harder to see: load() cannot tell truncated from corrupt, and the file holds
 * the device key. So write a sibling and rename over the target — rename
 * replaces atomically on both platforms (MOVEFILE_REPLACE_EXISTING on
 * Windows), leaving a reader with the old file or the new one and never half
 * of either — and fsync first, so a crash cannot leave the rename pointing at
 * bytes that never landed. */
function writeJsonAtomic(path, value) {
  const tmp = `${path}.tmp-${process.pid}`;
  const data = JSON.stringify(value, null, 2);
  let fd;
  try {
    fd = openSync(tmp, 'w');
    writeFileSync(fd, data);
    try {
      fsyncSync(fd);
    } catch (e) {
      /* not every filesystem implements it; the rename is still atomic */
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
  }

  /* Windows refuses the rename outright while anything else holds the target
   * open — another reef process reading it, or the virus scanner that opened
   * it because we just wrote one. That clears in milliseconds, so it is a
   * retry, not a failed save. */
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(tmp, path);
      return;
    } catch (e) {
      if (attempt >= 10 || !BUSY.includes(e.code)) {
        try {
          unlinkSync(tmp);
        } catch (cleanup) {
          /* nothing left to clean up */
        }
        throw e;
      }
      sleepSync(10);
    }
  }
}

/* --- the agent ---------------------------------------------------------- */

export class ReefAgent {
  constructor({ pin, statePath, label = 'agent' }) {
    Object.assign(this, { pin, statePath, label });
    // Set by _unlockFresh(), and the only thing that entitles this process to
    // write `session` back to the file. See mergeState().
    this._sessionIsMine = false;
  }

  async load() {
    const raw = readFileWithRetry(this.statePath);

    if (raw === null) {
      /* No file at all: mint an identity. Created exclusively so two cold
       * starts racing each other cannot both win — the loser adopts the
       * winner's key instead of enrolling a second device that nobody asked
       * for and the other side would have to approve. */
      this.state = { identity: await newIdentity(), seq: 0, sent: {} };
      try {
        writeFileSync(this.statePath, JSON.stringify(this.state, null, 2), { flag: 'wx' });
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        // Lost the race. The winner may still be mid-write, and this is the one
        // write here that cannot go through writeJsonAtomic() (the exclusive
        // create is the whole point of it), so give it a moment to finish
        // rather than reading half a key.
        let winner = null;
        for (let attempt = 0; attempt < 20 && !(winner && winner.identity); attempt++) {
          if (attempt) sleepSync(10);
          const text = readFileWithRetry(this.statePath);
          try {
            winner = text ? JSON.parse(text) : null;
          } catch (parseError) {
            winner = null; // still being written; that is what the retry is for
          }
        }
        if (!winner || !winner.identity) {
          throw new Error(`${this.statePath} appeared while starting up but has no identity in it.`);
        }
        this.state = winner;
      }
    } else {
      let parsed = null;
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        parsed = null;
      }
      if (!parsed || typeof parsed !== 'object') {
        /* Fatal on purpose. This shared a branch with "no file at all" before,
         * so a file that would not parse produced a brand new identity that
         * was then written straight over it — turning a damaged state file
         * into a destroyed device key, which is the one loss here nothing can
         * undo: the room knows the old public key, the replacement device is
         * unapproved, and the only local copy of everything sent went with it.
         * Every write goes through writeJsonAtomic() now, so a truncated file
         * should not be reachable; if one turns up, it is worth a look before
         * anything overwrites it. */
        throw new Error(
          `${this.statePath} exists but does not parse as a state object. It holds ` +
          `this device's key, so nothing here will overwrite it — inspect it, and ` +
          `only delete it if it is truly unrecoverable (that enrols a new device, ` +
          `which the other side then has to approve).`
        );
      }
      this.state = parsed;
      if (!this.state.identity) {
        this.state.identity = await newIdentity();
        await this.save();
      }
    }

    this.privateKey = await importPrivate(this.state.identity.privateJwk);
    return this;
  }

  /* Synchronous throughout, on purpose: read, merge and write are one critical
   * section and the shorter it is, the smaller the window in which another
   * process's write can land inside it. Async fs calls would also let two
   * saves *within* this process interleave — the listener has that, since a
   * socket message and a catch-up read both save. Still declared async so
   * every existing `await this.save()` keeps working unchanged. */
  async save() {
    const release = acquireSaveLock(this.statePath);
    let merged;
    try {
      const disk = readStateFile(this.statePath) || {};
      merged = mergeState(disk, this.state, { sessionIsMine: this._sessionIsMine });
      writeJsonAtomic(this.statePath, merged);
    } finally {
      release();
    }
    this._sessionIsMine = false;

    /* Adopt back only what is purely additive. `sent` is a union, so taking
     * the merged copy can only gain entries, which is the point — a `read` in
     * this process now shows sends another process made. `seq` is deliberately
     * not adopted: the merged value is how far *anything* has consumed, and
     * pulling this process's cursor forward to it would skip rows this one has
     * not delivered yet. */
    this.state.sent = merged.sent;
  }

  /* `/unlock/` reissues this device's token every time it is called — it has
   * to, since the same public key is how it recognises "the same browser
   * coming back" rather than a new device. That is fine for one browser tab,
   * but here it means a second short-lived call (a `send` while `listen` is
   * still running) silently logs the first one out from under it: same state
   * file, same device, same PIN, but a fresh token that invalidates whichever
   * one was issued last. So the token is cached and reused across separate
   * process invocations, and `/unlock/` is only called again when there is
   * no cached session or the cached one turns out to be stale. */
  async connect() {
    const cached = this.state.session;
    if (cached && cached.pin === this.pin) {
      this.token = cached.token;
      this.roomId = cached.roomId;
      this.deviceId = cached.deviceId;
      this.status = 'active';
      try {
        await this.refreshKeys();
        return this;
      } catch (e) {
        // Anything other than "this token is no good any more" is a real
        // outage (offline, server down) — re-unlocking would not fix that
        // and would just mask it as something else.
        if (e.status !== 401) throw e;
      }
    }
    return this._unlockFresh();
  }

  /* One PIN opens every room its holder is seated in, and a device is enrolled
   * per room. Picks the room that has somebody in it, which is what the browser
   * client does and for the same reason: a seeded-but-empty room otherwise wins
   * on being older. */
  async _unlockFresh() {
    const result = await request('/unlock/', {
      method: 'POST',
      json: { pin: this.pin, device: { label: this.label, public_key_jwk: this.state.identity.publicJwk } },
    });
    if (!result.rooms || !result.rooms.length) throw new Error('That PIN is in no room.');
    if (result.must_change_pin) {
      throw new Error('This is a one-time join PIN. Call changePin() before anything else.');
    }
    const score = (room) => {
      const peers = ((room.session || {}).peer_devices || [])
        .filter((d) => d.status === 'active').length;
      const mine = room.device.status === 'active';
      return (mine && peers) ? 3 : peers ? 2 : mine ? 1 : 0;
    };
    const room = [...result.rooms].sort((a, b) => score(b) - score(a))[0];

    this.token = room.token;
    this.roomId = room.room_id;
    this.deviceId = room.device.id;
    this.status = room.device.status;
    if (this.status !== 'active') {
      // The first device into a room with no messages activates itself; after
      // anything is said, the other side has to approve it.
      throw new Error('This device is waiting to be approved by the other side.');
    }
    await this.refreshKeys();
    this.state.session = {
      pin: this.pin, token: this.token, roomId: this.roomId, deviceId: this.deviceId,
    };
    // The token was issued seconds ago, so this process holds the newest one
    // there is — the only situation in which a writer should replace the
    // session on disk rather than preserve whatever is already there.
    this._sessionIsMine = true;
    await this.save();
    return this;
  }

  async changePin(next) {
    await request('/pin/', { method: 'POST', token: this.token, json: { current: this.pin, next } });
    this.pin = next;
  }

  async refreshKeys() {
    const { recipients = [], safety_number } = await request('/keys/', { token: this.token });
    this.safetyNumber = safety_number;
    this.pairKeys = new Map();
    for (const r of recipients) {
      this.pairKeys.set(String(r.id),
        await derivePairKey(this.privateKey, r.public_key_jwk, this.deviceId, r.id));
    }
    this.recipients = recipients;
    return recipients;
  }

  async send(text, extra = {}) {
    if (!this.recipients.length) throw new Error('Nobody is in this conversation yet.');
    const id = crypto.randomUUID();
    const body = { v: 1, type: 'text', text, ...extra };

    const sealAll = async () => {
      const envelopes = [];
      for (const r of this.recipients) {
        envelopes.push({
          device_id: r.id,
          ...(await seal(this.pairKeys.get(String(r.id)), body, {
            messageId: id, senderDeviceId: this.deviceId, recipientDeviceId: r.id,
          })),
        });
      }
      // The id is the idempotency key: retrying a send cannot duplicate it,
      // which is what makes the retry below safe even if the first attempt
      // reached the server.
      return request('/entries/', {
        method: 'POST', token: this.token,
        json: { id, kind: 'text', reply_to: null, envelopes, attachment_ids: [] },
      });
    };

    let result;
    try {
      result = await sealAll();
    } catch (e) {
      /* The server insists the envelope set exactly matches the room's current
       * active devices, so a cached recipient list stops being valid the moment
       * anyone's phone joins or is retired — and every send fails until the list
       * is refetched. Nothing announced that, so the message just would not go:
       * observed live as "Envelopes must cover exactly the active recipients."
       * on every attempt from a device that had been up for minutes. Refetch and
       * re-seal once; a second failure is a real one. */
      if (e.code !== 'recipients_changed') throw e;
      await this.refreshKeys();
      if (!this.recipients.length) throw new Error('Nobody is in this conversation yet.');
      result = await sealAll();
    }

    // An envelope is sealed for each *recipient*, so nothing on the server is
    // addressed to the sender — reading your own message back is not possible
    // and never will be. The browser keeps its copy in IndexedDB; this keeps a
    // bounded one here, so `read` shows a thread rather than a row of failures.
    // Bounding it is mergeState()'s job, not this one's: a process trimming its
    // own copy to 500 and writing that is how the map used to lose entries it
    // had never seen in the first place.
    this.state.sent = this.state.sent || {};
    this.state.sent[id] = text;
    await this.save();
    return result;
  }

  /* Shared by `read` (a page from the REST history) and the WS listener (one
   * row at a time, live) — same row shape either way, same decrypt rule.
   * Returns `{ text, attachments }`; attachments is a list of local file
   * paths, already downloaded and decrypted here, so nothing downstream ever
   * has to touch ciphertext or blob ids directly. */
  async _contentFor(row) {
    /* `mine` is true for the whole *seat*, not just this device, so it cannot
     * stand in for "there is no envelope for me". A second device on the same
     * seat is a recipient like any other — `recipient_devices()` seals for it
     * precisely so the other phone can read what was sent — and taking the
     * local-copy branch on `mine` alone threw that envelope away and rendered
     * the message blank. Only this device's own sends have no envelope, and the
     * presence of `row.envelope` says so more reliably than any flag. */
    if (!row.envelope) {
      // Nothing addressed to us: our own send (local copy is the only source),
      // or a message from before this device existed (nothing to show).
      return { text: (this.state.sent || {})[row.id] ?? null, attachments: [] };
    }
    let key = this.pairKeys.get(String(row.sender_device_id));
    if (!key) {
      /* `pairKeys` is only ever populated at connect() -- a long-lived
       * `listen` process never calls refreshKeys() again on its own, so a
       * device that becomes active on the other seat *after* we connected
       * (a new phone, a browser re-enrolling) is invisible to us until
       * something forces a refresh. Observed live: a message from such a
       * device silently vanished with no error and no log line, because the
       * caller only sees `text: null` and treats that as "nothing to show"
       * -- indistinguishable from a message that legitimately isn't for us.
       * One retry here is enough: it's the same "stale cache" situation
       * send()'s recipient-mismatch retry already handles for our own
       * sends, just triggered by reading instead of writing. */
      await this.refreshKeys();
      key = this.pairKeys.get(String(row.sender_device_id));
      if (!key) return { text: null, attachments: [] };
    }
    let body;
    try {
      body = await open(key, row.envelope, {
        messageId: row.id, senderDeviceId: row.sender_device_id,
        recipientDeviceId: this.deviceId,
      });
    } catch (e) {
      return { text: null, attachments: [] }; // sealed for a device since replaced
    }
    const attachments = Array.isArray(body.files) && body.files.length
      ? await this._downloadAttachments(row.id, body.files)
      : [];
    return { text: body.text ?? null, attachments };
  }

  /* One message can carry several files (a multi-photo send); a file that
   * fails to fetch or decrypt is skipped rather than losing the whole
   * message — a partial delivery is still more useful than none. */
  async _downloadAttachments(messageId, files) {
    const dir = fileURLToPath(new URL('attachments/', import.meta.url));
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const paths = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      if (!f || !f.id || !f.key || !f.iv) continue;
      try {
        const ciphertext = await this._downloadBlob(f.id);
        const plain = await openBlob(ciphertext, f.key, f.iv);
        const ext = (f.mime && f.mime.split('/')[1]) || (f.name || '').split('.').pop() || 'bin';
        const filePath = join(dir, `${messageId}-${i}.${ext}`);
        await writeFile(filePath, Buffer.from(plain));
        paths.push(filePath);
      } catch (e) {
        process.stderr.write(`reef: failed to fetch attachment ${f.id}: ${e.message}\n`);
      }
    }
    return paths;
  }

  async _downloadBlob(id) {
    const response = await fetch(`${API}/blobs/${id}/`, {
      headers: { Authorization: 'Token ' + this.token },
    });
    if (!response.ok) throw new Error(`GET /blobs/${id}/ -> ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }

  /* Everything since the last call. `seq` is a total order from the server, so
   * this is resumable across restarts — it is kept in the state file. */
  async read({ since = this.state.seq, pageSize = 50 } = {}) {
    const query = new URLSearchParams(since ? { since, page_size: pageSize }
                                            : { page_size: pageSize });
    const { results = [] } = await request('/entries/?' + query, { token: this.token });
    const out = [];
    for (const row of results) {
      if (row.seq > (this.state.seq || 0)) this.state.seq = row.seq;
      const { text, attachments } = await this._contentFor(row);
      out.push({ id: row.id, seq: row.seq, mine: row.mine, at: row.created_at,
                 from: row.sender_device_id, text, attachments, deleted: row.deleted });
    }
    await this.save();
    return out;
  }

  async markRead(ids) {
    if (!ids.length) return;
    await request('/receipts/', { method: 'POST', token: this.token,
                                  json: { message_ids: ids, state: 'read' } });
  }

  /* Polling, not WebSocket, on purpose: it needs no extra dependency, survives
   * a dropped connection without reconnect logic, and an agent that answers
   * within a second or two is indistinguishable from one that answers instantly.
   * The stream is there if you want it — POST /ws-ticket/ then connect to
   * wss://<host>/ws/reef/?t=<ticket>. */
  async watch(handler, { every = 2000 } = {}) {
    for (;;) {
      try {
        const fresh = (await this.read()).filter((m) => !m.mine && m.text !== null);
        if (fresh.length) {
          await this.markRead(fresh.map((m) => m.id));
          for (const message of fresh) await handler(message, this);
        }
      } catch (e) {
        if (e.status === 401) throw e; // revoked: no amount of retrying helps
        process.stderr.write(`reef: ${e.message}\n`);
      }
      await new Promise((r) => setTimeout(r, every));
    }
  }

  /* Push instead of poll: one request only when something actually happens,
   * rather than one every `every` ms regardless. The ticket is single-use
   * and dies in 60s (`ReefWsTicketView`), so a fresh one is pulled for every
   * connect, including every reconnect after a drop — there is no "renew".
   *
   * `catch_up` runs once up front and on every reconnect, because a socket
   * only ever carries what happens *while it's open* — anything that arrived
   * during a drop, or before this call started, is invisible to it otherwise.
   */
  async listenLive(handler) {
    let backoff = 1000;
    for (;;) {
      try {
        await this._catchUp(handler);
        await this._runSocket(handler);
        backoff = 1000; // a clean open-then-close is not a failure to back off from
      } catch (e) {
        if (e.status === 401) throw e; // revoked: no amount of retrying helps
        process.stderr.write(`reef: ${e.message}\n`);
      }
      const wait = Math.min(backoff, 30000) * (0.7 + Math.random() * 0.6);
      backoff = Math.min(backoff * 2, 30000);
      await new Promise((r) => setTimeout(r, wait));
    }
  }

  async _catchUp(handler) {
    const fresh = (await this.read()).filter((m) => !m.mine && m.text !== null);
    if (fresh.length) {
      await this.markRead(fresh.map((m) => m.id));
      for (const message of fresh) await handler(message, this);
    }
  }

  /* One socket, until it closes or errors. Resolves normally on a clean
   * close so the caller can decide whether/how to reconnect. */
  async _runSocket(handler) {
    /* Fetched outside the Promise on purpose. This used to be
     * `new Promise(async (resolve, reject) => …)`, whose executor returns a
     * promise nobody holds: anything throwing outside the executor's own
     * try/catch — the `new WebSocket(…)` line, the handler wiring — rejected
     * that invisible promise and called neither resolve nor reject, so the
     * outer one never settled. With no timer and no live handle left, the loop
     * in listenLive could not reach its backoff sleep, the event loop drained,
     * and Node exited 13 (unsettled top-level await) rather than reconnecting.
     * A plain async method rejects through the normal path instead. */
    const { ticket } = await request('/ws-ticket/', { method: 'POST', token: this.token });

    return new Promise((resolve, reject) => {
      let socket = null;
      let heartbeat = null;
      let missed = 0;
      let opened = false;
      let settled = false;

      /* Every exit routes through here, so the heartbeat and the connect
       * deadline can never outlive the socket they belong to, and a late
       * second event cannot re-settle an already-settled promise. */
      const settle = (err) => {
        if (settled) return;
        settled = true;
        clearInterval(heartbeat);
        clearTimeout(connectDeadline);
        if (err) reject(err);
        else resolve();
      };

      /* A socket that never reaches onopen does not always reach onclose
       * either. The heartbeat only exists after onopen, so without a deadline
       * here that case is the same indefinite hang as above — waiting on a
       * connection that will never arrive, with nothing left to reconnect it. */
      const connectDeadline = setTimeout(() => {
        if (opened) return;
        try {
          socket?.close();
        } catch (e) {
          /* nothing to close */
        }
        settle(new Error('ws connect timed out'));
      }, 30000);

      try {
        socket = new WebSocket(`${WS_BASE}?t=${encodeURIComponent(ticket)}`);
      } catch (e) {
        return settle(e);
      }

      /* Tears down a socket that is open as far as this process is concerned but
       * is carrying nothing, so onclose fires and the caller reconnects.
       *
       * Without this the only failure the agent could see was a socket that
       * closed properly. A half-open connection — the far side gone, no FIN ever
       * delivered — left it sitting there connected and deaf, and the wrapper
       * script could not help: the process is alive and the loop only restarts
       * on exit. Messages simply stopped arriving, indefinitely. */
      const giveUp = () => {
        clearInterval(heartbeat);
        try {
          socket.close();
        } catch (e) {
          /* already going down */
        }
      };

      socket.onopen = () => {
        opened = true;
        missed = 0;
        heartbeat = setInterval(() => {
          // Printed every tick, before anything else, regardless of ping
          // outcome: this is what lets an external watchdog (run-listener.sh)
          // tell a frozen event loop from a merely quiet room. The ping/pong
          // check below only works if the event loop is running at all to
          // execute it — if the whole process gets suspended (observed: hours
          // of total silence, socket included, from a child that never exited
          // and so was never restarted), nothing inside this process can
          // notice its own freeze. A line here on a fixed cadence, watched
          // for staleness from outside, can.
          console.log(`${new Date().toISOString()} heartbeat`);
          // Two unanswered pings, counted rather than timed: the same reasoning
          // as the browser client, where a throttled timer makes any wall-clock
          // deadline lie about a healthy socket.
          if (missed >= 2) return giveUp();
          missed++;
          try {
            socket.send(JSON.stringify({ type: 'ping' }));
          } catch (e) {
            /* socket already going down; onclose will fire */
          }
        }, 20000);
      };

      socket.onmessage = async (event) => {
        // Any frame is proof of life, not only a pong.
        missed = 0;
        let payload;
        try {
          payload = JSON.parse(event.data);
        } catch (e) {
          return;
        }
        if (payload.type !== 'msg.new') return;
        const row = payload.message;
        if (row.mine) return;
        /* This body is async and nothing awaits it, so an throw here becomes an
         * unhandled rejection — fatal in Node >=15, and fatal *around* the
         * reconnect loop rather than inside it, so listenLive never sees it.
         * Treat a failure as a bad socket instead: close it, let the catch-up
         * read on reconnect re-deliver the message it belongs to. */
        try {
          if (row.seq > (this.state.seq || 0)) this.state.seq = row.seq;
          const { text, attachments } = await this._contentFor(row);
          if (text === null) return; // undecryptable, or a system/profile row
          await this.save();
          await this.markRead([row.id]);
          await handler({
            id: row.id, seq: row.seq, mine: false, at: row.created_at,
            from: row.sender_device_id, text, attachments, deleted: row.deleted,
          }, this);
        } catch (e) {
          process.stderr.write(`reef: dropping socket after handler error: ${e.message}\n`);
          giveUp();
        }
      };

      socket.onerror = () => {
        try {
          socket.close();
        } catch (e) {
          /* already closing */
        }
      };

      socket.onclose = () => settle();
    });
  }
}

/* --- exclusive lock for `listen` ----------------------------------------
 *
 * Two `listen` processes on the same state file both hold a valid cached
 * session (same device, same token) and would both open their own socket —
 * the server has no reason to refuse either. Every `msg.new` then reaches
 * both, both mark it read (harmless), and both call the handler: whoever is
 * driving each one replies twice, once per process. This is not hypothetical
 * — it is exactly what "two Claude Code sessions both say 'go reef way'"
 * produces with no guard at all.
 *
 * A PID lock file next to the state file is enough: `listen` refuses to
 * start if another `listen` for the same state file is already alive, and
 * cleans a stale lock left by a process that died without removing it.
 */
/* A lock conflict is the one failure here that retrying can never fix: the
 * other listener is alive and staying alive, so a supervisor that treats this
 * like a crash restarts into the same refusal every few seconds forever. That
 * happened live — a second chat launched its own `run-listener.sh`, and the
 * resulting loop wrote a stack trace to listen.log every 3s, which is exactly
 * the flood that gets a monitor auto-suppressed and costs the *working*
 * session its crash visibility. Given its own exit code so the wrapper can
 * tell "someone else has this" from "I died, restart me". */
export const LOCK_CONFLICT_EXIT = 12;

function lockPathFor(statePath) {
  return statePath + '.lock';
}

function acquireLock(statePath) {
  const lockPath = lockPathFor(statePath);
  if (existsSync(lockPath)) {
    const pid = Number(readFileSync(lockPath, 'utf8').trim());
    const alive = pid && (() => {
      try {
        process.kill(pid, 0); // signal 0: existence check, does not actually signal
        return true;
      } catch (e) {
        return false; // ESRCH: no such process — the lock is stale
      }
    })();
    if (alive) {
      // Thrown rather than exited, so importing this as a library still gets an
      // error to handle; the CLI's fatal handler turns the tag into the code.
      const conflict = new Error(
        `Another 'listen' is already running for ${statePath} (pid ${pid}). ` +
        `Two listeners on the same identity double-act on every message — stop ` +
        `that one first (or use a different --state) rather than running both.`
      );
      conflict.exitCode = LOCK_CONFLICT_EXIT;
      throw conflict;
    }
  }
  writeFileSync(lockPath, String(process.pid));
  const release = () => {
    try {
      if (Number(readFileSync(lockPath, 'utf8').trim()) === process.pid) unlinkSync(lockPath);
    } catch (e) {
      /* already gone */
    }
  };
  process.on('exit', release);
  process.on('SIGINT', () => process.exit(130));
  process.on('SIGTERM', () => process.exit(143));
}

/* --- session-addressed delivery -----------------------------------------
 *
 * `listen.log` was a broadcast bus. One listener process writes it, but any
 * number of readers tail it, so a second chat session told "go reef way"
 * started getting notified about a conversation the first one was already
 * holding: every session woke an LLM turn for every message, and which one
 * actually replied was decided by whichever `claim-message.sh` call happened
 * to land first. Claiming keeps the *reply* single, but only after every
 * session has already been woken, and "whoever raced fastest" is the wrong
 * answer anyway — the session the operator is currently looking at should be
 * the one that answers.
 *
 * So each message is addressed when it is written instead of being sorted out
 * afterwards. Exactly one session owns the conversation; its id lives in
 * `<state>.owner`, last writer wins, which is what lets a freshly opened chat
 * take over. Each incoming message is appended to that owner's own file under
 * `agent/inbox/`, so only the owner's tail ever sees it — nothing else has to
 * agree, or race, or be told to stand down.
 *
 * stdout (hence `listen.log`) keeps only an audit line naming the message id
 * and the inbox it went to, deliberately *without* the REEF_MSG token: a
 * monitor still running from an older session, grepping listen.log for
 * REEF_MSG, therefore goes quiet as soon as this ships instead of needing that
 * session to be restarted. It also keeps message text out of the shared log.
 */
const INBOX_DIR = fileURLToPath(new URL('inbox/', import.meta.url));
const UNOWNED_INBOX = 'unowned';

export function ownerPathFor(statePath) {
  return statePath + '.owner';
}

/* An owner id arrives from a file on disk and becomes a filename, so it is
 * whitelisted rather than trusted: anything outside the usual id characters is
 * a corrupt (or hostile) owner file, and is treated as nobody owning the room
 * rather than as a path to write to. */
function sanitizeOwner(raw) {
  const owner = String(raw || '').trim();
  return /^[A-Za-z0-9._-]{1,128}$/.test(owner) ? owner : UNOWNED_INBOX;
}

export function currentOwner(statePath) {
  try {
    const path = ownerPathFor(statePath);
    return existsSync(path) ? sanitizeOwner(readFileSync(path, 'utf8')) : UNOWNED_INBOX;
  } catch (e) {
    return UNOWNED_INBOX;
  }
}

/* Returns the owner it delivered to, for the caller's audit line. A failed
 * write must not take the listener down — the socket and the room are fine,
 * only this one append isn't — so it degrades to stderr and carries on. */
export function deliverToInbox(statePath, line) {
  const owner = currentOwner(statePath);
  try {
    if (!existsSync(INBOX_DIR)) mkdirSync(INBOX_DIR, { recursive: true });
    appendFileSync(join(INBOX_DIR, `${owner}.log`), line + '\n');
  } catch (e) {
    process.stderr.write(`reef: could not write inbox for ${owner}: ${e.message}\n`);
  }
  return owner;
}

/* --- CLI ---------------------------------------------------------------- */

/* Compared against a raw `file://${...}` template before — correct on
 * Linux/Mac, but process.argv[1] is a backslash path on Windows
 * (`D:\...\reef-agent.mjs`), which never matches that string. The guard
 * silently failed closed: no error, no output, exit 0, having done nothing.
 * pathToFileURL normalises either way. */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  /* The wrapper restarts on any exit, so a crash was never fatal for long —
   * but exit 13 (unsettled await) and a bare unhandled rejection both leave
   * nothing in the log saying what died, which is how a listener that had been
   * crash-looping for hours looked identical to a quiet room. Make any such
   * failure say so and exit non-zero deliberately; the wrapper takes it from
   * there. Installed only for the CLI, so importing this as a library does not
   * silently hijack the host process's error handling. */
  const fatal = (kind) => (e) => {
    // A tagged exitCode means the failure is deterministic and the caller is
    // meant to act on which one it was (see LOCK_CONFLICT_EXIT); everything
    // else is a plain 1 for "died, restarting is reasonable". A lock conflict
    // also prints just its message: the stack is noise for a condition whose
    // fix is "stop the other listener", and it was being written to the shared
    // log every 3s.
    if (e && e.exitCode === LOCK_CONFLICT_EXIT) {
      process.stderr.write(`reef: ${e.message}\n`);
      process.exit(e.exitCode);
    }
    process.stderr.write(`reef: fatal ${kind}: ${(e && e.stack) || e}\n`);
    process.exit(1);
  };
  process.on('unhandledRejection', fatal('unhandled rejection'));
  process.on('uncaughtException', fatal('uncaught exception'));

  const args = process.argv.slice(2);
  const flag = (name, fallback) => {
    const i = args.indexOf('--' + name);
    return i === -1 ? fallback : args[i + 1];
  };
  const positional = args.filter((a, i) =>
    !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
  const [command, ...rest] = positional;

  const agent = new ReefAgent({
    pin: flag('pin') || process.env.REEF_PIN,
    statePath: flag('state', './reef-agent.json'),
    label: flag('label', 'agent'),
  });
  if (!agent.pin) {
    console.error('Need --pin (or REEF_PIN).');
    process.exit(2);
  }

  await agent.load();
  await agent.connect();

  if (command === 'whoami') {
    console.log(JSON.stringify({
      room: agent.roomId, device: agent.deviceId,
      peers: agent.recipients.map((r) => r.id),
      safety_number: agent.safetyNumber,
    }, null, 2));
  } else if (command === 'send') {
    // Argv has no way to carry a real newline — a multi-line reply arrives as
    // the literal two characters `\n`, and without this it goes out (and
    // renders) exactly like that instead of a line break.
    const text = rest.join(' ').replace(/\\n/g, '\n').replace(/\\t/g, '\t');
    await agent.send(text);
    console.log('sent');
  } else if (command === 'read') {
    for (const m of await agent.read()) {
      const text = m.text ?? (m.mine ? '(sent before this state file existed)'
                                     : '(sealed for a device since replaced)');
      console.log(`${m.at} ${m.mine ? '>' : '<'} ${text}`);
      for (const path of m.attachments || []) console.log(`  attachment: ${path}`);
    }
  } else if (command === 'watch') {
    console.log(`watching room ${agent.roomId}`);
    await agent.watch(async (message, self) => {
      console.log(`< ${message.text}`);
      // Replace with whatever the agent should actually do.
      await self.send(`heard: ${message.text}`);
    });
  } else if (command === 'listen') {
    // Push, not poll, and never replies on its own — this is the half meant
    // to sit behind Monitor: one clean line per real incoming message, and
    // nothing else, so the decision to wake an LLM turn is "did a line
    // print", not a schedule. Replying is a separate, deliberate `send` call
    // from whoever reads that line.
    //
    // That line goes to the owning session's inbox file rather than stdout
    // (see "session-addressed delivery" above), so only the session that
    // currently owns the conversation is woken by it. stdout keeps the audit
    // trail: which message went to which inbox, no message text.
    //
    // Locked so a second `listen` on the same --state refuses to start
    // instead of silently double-acting on every message alongside the
    // first one.
    acquireLock(agent.statePath);
    console.log(`listening on room ${agent.roomId}`);
    await agent.listenLive(async (message) => {
      const payload = JSON.stringify({ id: message.id, from: message.from, at: message.at, text: message.text, attachments: message.attachments || [] });
      const owner = deliverToInbox(agent.statePath, `REEF_MSG ${payload}`);
      console.log(`msg ${message.id} -> inbox ${owner}`);
    });
  } else {
    console.error('Commands: whoami | send <text> | read | watch | listen');
    process.exit(2);
  }
}
