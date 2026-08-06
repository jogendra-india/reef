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
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { join } from 'node:path';

/* A PIN typed after --pin sits in shell history and in `ps aux` for anyone
 * else on the machine to read. `agent/.env` (gitignored, never committed) is
 * the alternative: `REEF_PIN=333023` there is picked up automatically,
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
    throw err;
  }
  return body;
}

/* --- the agent ---------------------------------------------------------- */

export class ReefAgent {
  constructor({ pin, statePath, label = 'agent' }) {
    Object.assign(this, { pin, statePath, label });
  }

  async load() {
    try {
      this.state = JSON.parse(await readFile(this.statePath, 'utf8'));
    } catch (e) {
      this.state = { identity: await newIdentity(), seq: 0 };
      await this.save();
    }
    this.privateKey = await importPrivate(this.state.identity.privateJwk);
    return this;
  }

  save() {
    return writeFile(this.statePath, JSON.stringify(this.state, null, 2));
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
    const envelopes = [];
    for (const r of this.recipients) {
      envelopes.push({
        device_id: r.id,
        ...(await seal(this.pairKeys.get(String(r.id)), body, {
          messageId: id, senderDeviceId: this.deviceId, recipientDeviceId: r.id,
        })),
      });
    }
    // The id is the idempotency key: retrying a send cannot duplicate it.
    const result = await request('/entries/', {
      method: 'POST', token: this.token,
      json: { id, kind: 'text', reply_to: null, envelopes, attachment_ids: [] },
    });

    // An envelope is sealed for each *recipient*, so nothing on the server is
    // addressed to the sender — reading your own message back is not possible
    // and never will be. The browser keeps its copy in IndexedDB; this keeps a
    // bounded one here, so `read` shows a thread rather than a row of failures.
    this.state.sent = this.state.sent || {};
    this.state.sent[id] = text;
    const ids = Object.keys(this.state.sent);
    if (ids.length > 500) delete this.state.sent[ids[0]];
    await this.save();
    return result;
  }

  /* Shared by `read` (a page from the REST history) and the WS listener (one
   * row at a time, live) — same row shape either way, same decrypt rule.
   * Returns `{ text, attachments }`; attachments is a list of local file
   * paths, already downloaded and decrypted here, so nothing downstream ever
   * has to touch ciphertext or blob ids directly. */
  async _contentFor(row) {
    if (row.mine) {
      // Ours: no envelope exists for us, so the local copy is the only source.
      return { text: (this.state.sent || {})[row.id] ?? null, attachments: [] };
    }
    if (!row.envelope) return { text: null, attachments: [] };
    const key = this.pairKeys.get(String(row.sender_device_id));
    if (!key) return { text: null, attachments: [] };
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
      throw new Error(
        `Another 'listen' is already running for ${statePath} (pid ${pid}). ` +
        `Two listeners on the same identity double-act on every message — stop ` +
        `that one first (or use a different --state) rather than running both.`
      );
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
    await agent.send(rest.join(' '));
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
    // to sit behind Monitor: one clean stdout line per real incoming
    // message, and nothing else, so the decision to wake an LLM turn is "did
    // a line print", not a schedule. Replying is a separate, deliberate
    // `send` call from whoever reads that line.
    //
    // Locked so a second `listen` on the same --state refuses to start
    // instead of silently double-acting on every message alongside the
    // first one.
    acquireLock(agent.statePath);
    console.log(`listening on room ${agent.roomId}`);
    await agent.listenLive(async (message) => {
      console.log(`REEF_MSG ${JSON.stringify({ id: message.id, from: message.from, at: message.at, text: message.text, attachments: message.attachments || [] })}`);
    });
  } else {
    console.error('Commands: whoami | send <text> | read | watch | listen');
    process.exit(2);
  }
}
