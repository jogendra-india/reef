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
 */

import { webcrypto as crypto } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const API = process.env.REEF_API || 'https://ledgerbal.com/api/reef';

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

  /* One PIN opens every room its holder is seated in, and a device is enrolled
   * per room. Picks the room that has somebody in it, which is what the browser
   * client does and for the same reason: a seeded-but-empty room otherwise wins
   * on being older. */
  async connect() {
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

  /* Everything since the last call. `seq` is a total order from the server, so
   * this is resumable across restarts — it is kept in the state file. */
  async read({ since = this.state.seq, pageSize = 50 } = {}) {
    const query = new URLSearchParams(since ? { since, page_size: pageSize }
                                            : { page_size: pageSize });
    const { results = [] } = await request('/entries/?' + query, { token: this.token });
    const out = [];
    for (const row of results) {
      if (row.seq > (this.state.seq || 0)) this.state.seq = row.seq;
      let text = null;
      if (row.mine) {
        // Ours: no envelope exists for us, so the local copy is the only source.
        text = (this.state.sent || {})[row.id] ?? null;
      } else if (row.envelope) {
        const key = this.pairKeys.get(String(row.sender_device_id));
        if (key) {
          try {
            const body = await open(key, row.envelope, {
              messageId: row.id, senderDeviceId: row.sender_device_id,
              recipientDeviceId: this.deviceId,
            });
            text = body.text ?? null;
          } catch (e) {
            text = null; // sealed for a device since replaced
          }
        }
      }
      out.push({ id: row.id, seq: row.seq, mine: row.mine, at: row.created_at,
                 from: row.sender_device_id, text, deleted: row.deleted });
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
}

/* --- CLI ---------------------------------------------------------------- */

if (import.meta.url === `file://${process.argv[1]}`) {
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
    }
  } else if (command === 'watch') {
    console.log(`watching room ${agent.roomId}`);
    await agent.watch(async (message, self) => {
      console.log(`< ${message.text}`);
      // Replace with whatever the agent should actually do.
      await self.send(`heard: ${message.text}`);
    });
  } else {
    console.error('Commands: whoami | send <text> | read | watch');
    process.exit(2);
  }
}
