/* Service worker: offline shell, background flush, and push.
 *
 * The push handler is the interesting part. The server has no plaintext and no
 * handle, so its payload is just a message id — this wakes up, reads the
 * device key out of IndexedDB, decrypts locally, and only then decides what
 * the lock screen is allowed to say.
 */
importScripts('./crypto.js', './db.js');

// Bumping this purges every older cache on activate. Do it whenever the shell
// changes in a way a stale client must not keep running.
const CACHE = 'reef-shell-v60';
const BUILD = '2026-08-20b';
const API_BASE = 'https://ledgerbal.com/api/reef';

const SHELL = [
  './',
  './index.html',
  './app.js',
  './api.js',
  './crypto.js',
  './db.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
].map((path) => new URL(path, self.location).href);

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  // API calls are never cached: stale ciphertext is worse than no ciphertext,
  // and the app has its own offline path through IndexedDB.
  if (url.origin !== self.location.origin) return;

  // Network first, cache as the fallback.
  //
  // This used to be stale-while-revalidate, which meant a deploy did not reach
  // anyone until their *second* load — so a shipped fix was not a running fix,
  // and someone could sit on known-broken code indefinitely without any signal
  // that they were. For an app this small the extra round trip is cheap, and
  // offline still works because the cache answers whenever the network cannot.
  event.respondWith(
    caches.open(CACHE).then((cache) =>
      fetch(request)
        .then((response) => {
          if (response && response.ok) cache.put(request, response.clone());
          return response;
        })
        .catch(() => cache.match(request))
    )
  );
});

// Lets the page ask which build it is actually running, so "did my fix deploy?"
// has an answer that does not involve guessing.
self.addEventListener('message', (event) => {
  if (event.data === 'build' && event.source) {
    event.source.postMessage({ type: 'build', build: BUILD });
  }
});

/* --- Push -------------------------------------------------------------- */

self.addEventListener('push', (event) => {
  event.waitUntil(handlePush(event));
});

async function handlePush(event) {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (e) {
    /* keep the generic path */
  }

  // A device asking to join is the one thing worth interrupting for, so it is
  // exempt from both the muting below and the open-window check.
  if (payload.kind === 'security') {
    return self.registration.showNotification('Reef', {
      body: payload.body || 'Something needs your attention.',
      icon: './icon-192.png',
      tag: 'reef-security',
      data: { url: payload.url || './' },
    });
  }

  // Before any of the decisions below, because none of them change the fact.
  // "Delivered" meant "their app was open", since the only thing that confirmed
  // it was the page ingesting the message — so anything that arrived while the
  // other person's phone was locked sat on one tick until they next opened the
  // app, however long that took. The push reaching this worker *is* delivery to
  // the device, which is what the second tick is meant to say.
  await confirmDelivery(payload.id);

  // Turned off in the app. The subscription is dropped when muting, so this
  // should not arrive at all — but a push already in flight would, and honouring
  // the setting here means "off" is never briefly untrue.
  if ((await muted()) === true) return;

  // The page is open and in front of the person. It received this over the
  // WebSocket before this handler ran, so a notification is pure duplication —
  // which is what made one appear while they were reading the conversation. The
  // server also now skips connected devices, so this is the backstop.
  const windows = await self.clients.matchAll({
    type: 'window',
    includeUncontrolled: true,
  });
  if (windows.some((client) => client.visibilityState === 'visible')) return;

  // Free, if the server ever says so itself. Costs one condition and saves the
  // round trip below on every message this person sent.
  if (payload.mine === true) return;

  const generic = {
    title: 'Reef',
    body: '🐟 New ripple',
  };

  /* Anything this person sent themselves, from any of their devices.
   *
   * One PIN seats a person, not a device, so signing in on a phone and a
   * laptop puts both on the same seat — and the server pushes to every
   * subscribed device in the room. The laptop was therefore buzzing about
   * messages its owner had just typed on the phone. A notification is for
   * something the other party did; your own words arriving on your own second
   * screen are not news.
   *
   * `mine` is the server's own per-seat answer, the same field the thread uses
   * to decide which side of the screen a bubble goes on, so this needs no
   * reasoning about device ids and stays right when devices are added or
   * revoked. It is read off the row rather than guessed, which costs a lookup
   * the "hidden" path did not used to make — and buys back the /keys/ fetch
   * that path never needed, since the row is now found once and used by both
   * of the questions below.
   */
  const found = await locate(payload.id);
  if (found && found.row.mine) return;

  // "hidden" is the default, and it needs no decryption at all — the cheapest
  // path is also the most private one.
  if (payload.privacy !== 'sender' && payload.privacy !== 'full') {
    return show(generic, payload);
  }

  try {
    // Nothing found means nothing to open: offline, or a message already past
    // the recent window. The generic line still goes out, exactly as it did
    // when the decryption failed for any other reason.
    const detail = found ? await describe(found) : null;
    if (!detail) return show(generic, payload);
    if (payload.privacy === 'sender') {
      return show({ title: 'Reef', body: `${detail.emoji} ${detail.handle}` }, payload);
    }
    return show(
      { title: `${detail.emoji} ${detail.handle}`, body: detail.text || 'sent something' },
      payload
    );
  } catch (e) {
    // Offline, revoked device, or a message sealed for an older key. Falling
    // back to the generic text is honest and gives nothing away.
    return show(generic, payload);
  }
}

function show(content, payload) {
  return self.registration.showNotification(content.title, {
    body: content.body,
    icon: './icon-192.png',
    badge: './icon-192.png',
    tag: 'reef-message',
    renotify: true,
    vibrate: [60, 40, 60],
    data: { url: (payload && payload.url) || './' },
  });
}

/* Tells the server the message reached this device.
 *
 * The payload carries a message id and nothing else — not which conversation it
 * belongs to — and working that out would mean fetching and decrypting, which
 * the cheapest and most private notification path deliberately never does. So it
 * is offered to every room this person holds a token for: the endpoint scopes by
 * the token's own room and ignores a message that is not in it, and it ignores
 * anything this person sent, so the wrong rooms are a no-op rather than a leak.
 */
async function confirmDelivery(messageId) {
  if (!messageId) return;
  let sessions = {};
  try {
    sessions = (await self.ReefDB.sessions()) || {};
  } catch (e) {
    return;
  }
  await Promise.all(
    Object.values(sessions)
      .filter((session) => session && session.token)
      .map((session) =>
        fetch(API_BASE + '/receipts/', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Token ' + session.token,
          },
          body: JSON.stringify({ message_ids: [messageId], state: 'delivered' }),
        }).catch(() => {
          // Offline, or a revoked token. The page confirms it on next open.
        })
      )
  );
}

/* Reads the notification setting out of the shared store, which is where it
 * lives precisely so this worker can see it without a page open. */
async function muted() {
  try {
    return (await self.ReefDB.notifications()) === 'off';
  } catch (e) {
    return false; // never swallow a message because the setting could not be read
  }
}

/* Which room this message is in, and the row itself.
 *
 * The payload is a message id and nothing else, and one PIN can seat someone in
 * several rooms, so the room has to be found by asking each of them. Only the
 * row is fetched here — whether this person sent it is answered straight off
 * it, and opening it is a separate job that most notifications never need. */
async function locate(messageId) {
  if (!messageId) return null;
  let sessions = {};
  try {
    sessions = (await self.ReefDB.sessions()) || {};
  } catch (e) {
    return null;
  }
  for (const [roomId, session] of Object.entries(sessions)) {
    if (!session || !session.token) continue;
    try {
      // Wider than the decryption path used to ask for. A row that falls off
      // the end of this list cannot be checked, and the notification then goes
      // out anyway — so the window has to cover a burst of messages sent in
      // one go, which is precisely when the wrong ones used to arrive.
      const response = await fetch(API_BASE + '/entries/?page_size=25', {
        headers: { Authorization: 'Token ' + session.token },
      });
      if (!response.ok) continue;
      const list = await response.json();
      const row = (list.results || []).find((m) => m.id === messageId);
      if (row) return { roomId, session, row };
    } catch (e) {
      /* wrong room, or offline: try the next */
    }
  }
  return null;
}

/* Opens a located row far enough to name who sent it and what they said.
 *
 * ReefDB has no session() — it never did. That call threw on every push, the
 * throw was swallowed by handlePush, and every notification silently came out
 * as the generic "New ripple" no matter what privacy setting was chosen. */
async function describe(found) {
  const { roomId, session, row } = found;
  if (!row.envelope) return null;

  const identity = await self.ReefDB.identity();
  if (!identity) return null;

  const response = await fetch(API_BASE + '/keys/', {
    headers: { Authorization: 'Token ' + session.token },
  });
  if (!response.ok) return null;
  const keys = await response.json();

  const sender = (keys.recipients || []).find((r) => r.id === row.sender_device_id);
  if (!sender) return null;

  const pairKey = await self.ReefCrypto.derivePairKey(
    identity.privateKey,
    sender.public_key_jwk,
    session.deviceId,
    sender.id
  );
  const body = await self.ReefCrypto.openMessage(pairKey, row.envelope, {
    messageId: row.id,
    senderDeviceId: row.sender_device_id,
    recipientDeviceId: session.deviceId,
  });

  // Profiles are per-room, and the worker has never pointed the store at one —
  // so this read went to the shared database, which does not hold them, and
  // every notification was from "Someone". The slot comes along too, or this
  // would open the seat-less name and find nothing again.
  self.ReefDB.useRoom(roomId, session.slot);
  const profile =
    (await self.ReefDB.get(self.ReefDB.STORES.profiles, sender.id)) || {};
  return {
    handle: profile.handle || 'Someone',
    emoji: profile.emoji || '🐟',
    text: body.text || (body.type === 'media' ? '📷 Photo' : ''),
  };
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || './';
  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clientList) => {
        for (const client of clientList) {
          if ('focus' in client) return client.focus();
        }
        if (self.clients.openWindow) return self.clients.openWindow(target);
      })
  );
});

/* --- Background sync --------------------------------------------------- */

self.addEventListener('sync', (event) => {
  if (event.tag !== 'reef-outbox') return;
  // Chrome/Android only. Everywhere else the page flushes on reconnect, which
  // is why the outbox never depends on this firing.
  event.waitUntil(
    self.clients.matchAll().then((clientList) => {
      clientList.forEach((client) => client.postMessage({ type: 'flush-outbox' }));
    })
  );
});
