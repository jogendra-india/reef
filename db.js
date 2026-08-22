/* IndexedDB: the device's own copy of everything.
 *
 * Shared by the page and the service worker (the SW needs the identity key and
 * the session to decrypt a push payload), so it is a classic script hanging
 * off a global rather than a module.
 *
 * `identity` holds a non-extractable CryptoKey. Structured clone preserves
 * that, which is the whole reason the private half can live here safely.
 */
(function (root) {
  'use strict';

  // Two kinds of database. `reef` holds the device key and the session map —
  // things that span rooms. Every room then gets its own database, so one
  // conversation's history cannot be read while another is open. That is a
  // structural guarantee rather than a filter someone has to remember to
  // apply on every query.
  //
  // The name carries the *seat* as well as the room, because a room has two of
  // them and one device can be used by both. It was keyed on the room alone, so
  // entering the other PIN on the same browser opened the first person's store:
  // their decrypted history, their unsent draft, and every `mine` flag computed
  // for them, which drew their messages as yours. Splitting the name is what
  // makes that impossible rather than merely unlikely.
  const NAME = 'reef';
  const VERSION = 1;
  let roomName = null;

  const STORES = {
    vault: 'vault', // identity keys + session, one row each
    messages: 'messages', // decrypted history, keyed by message id
    outbox: 'outbox', // composed offline, awaiting a working connection
    profiles: 'profiles', // peer handle + emoji, from encrypted system messages
    media: 'media', // decrypted blobs, so a re-open costs nothing
    settings: 'settings',
  };

  let handle = null;

  /* Points the per-room stores at one conversation. Called on unlock and on
   * every switch; the open handle is dropped so the next read reopens against
   * the new room rather than answering from the previous one. */
  function roomDbName(roomId, slot) {
    if (!roomId) return NAME;
    // Without a slot there is nothing to separate the two seats by, so fall back
    // to the old name rather than inventing one and stranding the history.
    return slot ? `${NAME}-${roomId}-s${slot}` : `${NAME}-${roomId}`;
  }

  function useRoom(roomId, slot) {
    const next = roomDbName(roomId, slot);
    if (next === roomName) return;
    roomName = next;
    if (handle) {
      handle.close();
      handle = null;
    }
  }

  function open() {
    if (handle) return Promise.resolve(handle);
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(roomName || NAME, VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORES.vault)) {
          db.createObjectStore(STORES.vault);
        }
        if (!db.objectStoreNames.contains(STORES.messages)) {
          const store = db.createObjectStore(STORES.messages, { keyPath: 'id' });
          store.createIndex('seq', 'seq');
        }
        if (!db.objectStoreNames.contains(STORES.outbox)) {
          db.createObjectStore(STORES.outbox, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(STORES.profiles)) {
          db.createObjectStore(STORES.profiles);
        }
        if (!db.objectStoreNames.contains(STORES.media)) {
          db.createObjectStore(STORES.media);
        }
        if (!db.objectStoreNames.contains(STORES.settings)) {
          db.createObjectStore(STORES.settings);
        }
      };
      request.onsuccess = () => {
        handle = request.result;
        resolve(handle);
      };
      request.onerror = () => reject(request.error);
    });
  }

  function run(store, mode, work) {
    return open().then(
      (db) =>
        new Promise((resolve, reject) => {
          const tx = db.transaction(store, mode);
          const request = work(tx.objectStore(store));
          tx.onerror = () => reject(tx.error);
          if (request) {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          } else {
            tx.oncomplete = () => resolve();
          }
        })
    );
  }

  /* The shared database, opened alongside whichever room is active. It holds
   * the device key pair and the map of room -> token, both of which have to
   * outlive any single conversation. */
  let sharedHandle = null;

  function openShared() {
    if (sharedHandle) return Promise.resolve(sharedHandle);
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(NAME, VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        Object.values(STORES).forEach((name) => {
          if (!db.objectStoreNames.contains(name)) {
            if (name === STORES.messages) {
              db.createObjectStore(name, { keyPath: 'id' }).createIndex('seq', 'seq');
            } else if (name === STORES.outbox) {
              db.createObjectStore(name, { keyPath: 'id' });
            } else {
              db.createObjectStore(name);
            }
          }
        });
      };
      request.onsuccess = () => {
        sharedHandle = request.result;
        resolve(sharedHandle);
      };
      request.onerror = () => reject(request.error);
    });
  }

  function runShared(store, mode, work) {
    return openShared().then(
      (db) =>
        new Promise((resolve, reject) => {
          const tx = db.transaction(store, mode);
          const request = work(tx.objectStore(store));
          tx.onerror = () => reject(tx.error);
          if (request) {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          } else {
            tx.oncomplete = () => resolve();
          }
        })
    );
  }

  const getShared = (key) => runShared(STORES.vault, 'readonly', (s) => s.get(key));
  const putShared = (value, key) =>
    runShared(STORES.vault, 'readwrite', (s) => s.put(value, key));

  const get = (store, key) => run(store, 'readonly', (s) => s.get(key));
  const put = (store, value, key) => run(store, 'readwrite', (s) => s.put(value, key));
  const del = (store, key) => run(store, 'readwrite', (s) => s.delete(key));
  const all = (store) => run(store, 'readonly', (s) => s.getAll());

  /* Stores keyed out-of-line (profiles, settings) need the key alongside the
   * value, and IndexedDB will not give you both in one request. */
  async function entries(store) {
    const [keys, values] = await Promise.all([
      run(store, 'readonly', (s) => s.getAllKeys()),
      run(store, 'readonly', (s) => s.getAll()),
    ]);
    const out = {};
    keys.forEach((key, i) => {
      out[key] = values[i];
    });
    return out;
  }

  async function clearAll() {
    const db = await open();
    await Promise.all(
      Object.values(STORES).map(
        (name) =>
          new Promise((resolve) => {
            const tx = db.transaction(name, 'readwrite');
            tx.objectStore(name).clear();
            tx.oncomplete = resolve;
            tx.onerror = resolve;
          })
      )
    );
  }

  /* Messages are stored decrypted. The device is the trust boundary — it holds
   * the key that would decrypt them anyway, so storing ciphertext here would
   * cost a decrypt on every scroll frame and buy nothing. */
  async function messagesPage(limit) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const out = [];
      const tx = db.transaction(STORES.messages, 'readonly');
      const cursor = tx.objectStore(STORES.messages).index('seq').openCursor(null, 'prev');
      cursor.onsuccess = () => {
        const node = cursor.result;
        if (node && out.length < limit) {
          out.push(node.value);
          node.continue();
        } else {
          resolve(out.reverse());
        }
      };
      cursor.onerror = () => reject(cursor.error);
    });
  }

  async function putMessages(messages) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORES.messages, 'readwrite');
      const store = tx.objectStore(STORES.messages);
      messages.forEach((m) => store.put(m));
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }

  async function highestSeq() {
    const db = await open();
    return new Promise((resolve) => {
      const tx = db.transaction(STORES.messages, 'readonly');
      const cursor = tx.objectStore(STORES.messages).index('seq').openCursor(null, 'prev');
      cursor.onsuccess = () => resolve(cursor.result ? cursor.result.value.seq : 0);
      cursor.onerror = () => resolve(0);
    });
  }

  /* Copies a room's history out of the pre-seat store into this seat's.
   *
   * Renaming the database would otherwise look exactly like losing the
   * conversation. Both seats may adopt it — the rows are the same messages, and
   * each seat needs its own copy anyway — so the old store is left alone rather
   * than moved. It stops being written to from here on, and `wipeEverything`
   * already matches it.
   *
   * Returns the number of messages taken, so the caller knows to re-derive
   * `mine`: the copied flags were computed for whoever wrote them.
   */
  async function adoptLegacyRoom(roomId) {
    if (!roomId || !roomName || roomName === NAME) return 0;
    const legacyName = `${NAME}-${roomId}`;
    if (legacyName === roomName) return 0;

    // Opening a database that does not exist creates it, so ask first where the
    // browser can tell us. Where it cannot, an empty one is harmless.
    if (indexedDB.databases) {
      try {
        const present = await indexedDB.databases();
        if (!present.some((d) => d.name === legacyName)) return 0;
      } catch (e) {
        /* fall through and try to open it */
      }
    }

    // Only ever into an empty store: this runs on every unlock, and a second
    // pass must not resurrect messages that were hidden for me since.
    const already = await run(STORES.messages, 'readonly', (s) => s.count());
    if (already) return 0;

    const legacy = await new Promise((resolve) => {
      const request = indexedDB.open(legacyName, VERSION);
      request.onupgradeneeded = () => {
        // Brand new, so there was nothing to adopt.
        request.transaction.abort();
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = request.onblocked = () => resolve(null);
    });
    if (!legacy) return 0;

    const readAll = (store) =>
      new Promise((resolve) => {
        if (!legacy.objectStoreNames.contains(store)) return resolve([[], []]);
        const tx = legacy.transaction(store, 'readonly');
        const target = tx.objectStore(store);
        const keys = target.getAllKeys();
        const values = target.getAll();
        tx.oncomplete = () => resolve([keys.result || [], values.result || []]);
        tx.onerror = () => resolve([[], []]);
      });

    try {
      const [, messages] = await readAll(STORES.messages);
      if (messages.length) await putMessages(messages);
      // Handles and fish, so the header is right before the first system
      // message of this session arrives.
      const [profileKeys, profileValues] = await readAll(STORES.profiles);
      for (let i = 0; i < profileKeys.length; i++) {
        await put(STORES.profiles, profileValues[i], profileKeys[i]);
      }
      // Deliberately not `settings`: the draft belongs to whoever typed it, and
      // carrying it over is one of the leaks this split exists to close.
      return messages.length;
    } finally {
      legacy.close();
    }
  }

  /* Drops the oldest messages beyond a cap.
   *
   * Safe in a way media is not: the server keeps every message and every
   * envelope indefinitely — only messages given an explicit expiry are ever
   * tombstoned — so a row removed here comes back on the next scroll into that
   * part of the thread. The local store is a cache of what the server can still
   * hand over, not the only copy.
   *
   * Walks the `seq` index, which skips anything still being sent: a message with
   * no seq yet is not in the index, so the outbox cannot be pruned out from
   * under itself.
   */
  async function pruneMessages(keep) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORES.messages, 'readwrite');
      const index = tx.objectStore(STORES.messages).index('seq');
      const counter = index.count();
      let removed = 0;
      counter.onsuccess = () => {
        const excess = counter.result - keep;
        if (excess <= 0) return;
        const cursor = index.openCursor(null, 'next'); // oldest first
        cursor.onsuccess = () => {
          const node = cursor.result;
          if (!node || removed >= excess) return;
          node.delete();
          removed += 1;
          node.continue();
        };
      };
      tx.oncomplete = () => resolve(removed);
      tx.onerror = () => reject(tx.error);
    });
  }

  /* A slice of the thread either side of one message, straight from disk.
   *
   * The thread in memory is only the most recent few hundred, so a reply to
   * something from March cannot be reached through it — but the store usually
   * still has it. Reading a span rather than the single message means it arrives
   * with its neighbours instead of stranded between messages from months later.
   */
  async function messagesAround(seq, span) {
    const db = await open();
    return new Promise((resolve) => {
      const out = [];
      const range = IDBKeyRange.bound(seq - span, seq + span);
      const tx = db.transaction(STORES.messages, 'readonly');
      const cursor = tx.objectStore(STORES.messages).index('seq').openCursor(range);
      cursor.onsuccess = () => {
        const node = cursor.result;
        if (!node) return resolve(out);
        out.push(node.value);
        node.continue();
      };
      cursor.onerror = () => resolve(out);
    });
  }

  /* Every cached blob with its size. The Blobs come back as references rather
   * than bytes, so asking for `.size` costs nothing. */
  async function mediaEntries() {
    const [keys, values] = await Promise.all([
      run(STORES.media, 'readonly', (s) => s.getAllKeys()),
      run(STORES.media, 'readonly', (s) => s.getAll()),
    ]);
    return keys.map((key, i) => ({
      key,
      size: (values[i] && values[i].size) || 0,
    }));
  }

  root.ReefDB = {
    STORES,
    open,
    get,
    put,
    del,
    all,
    entries,
    clearAll,
    adoptLegacyRoom,
    pruneMessages,
    mediaEntries,
    messagesAround,
    messagesPage,
    putMessages,
    highestSeq,
    useRoom,
    // Shared across rooms: one key pair for this browser, and the tokens it
    // holds for each conversation.
    identity: () => getShared('identity'),
    setIdentity: (value) => putShared(value, 'identity'),
    sessions: () => getShared('sessions').then((v) => v || {}),
    setSessions: (value) => putShared(value, 'sessions'),
    /* Drops the tokens and nothing else. What a revoked device needs: it can no
     * longer fetch, but the messages it already holds are still its own. */
    forgetSessions: () => putShared({}, 'sessions'),
    /* Per seat, not per device. It was one shared `me`, on the grounds that you
     * are the same fish everywhere — true across *rooms*, false across the two
     * seats of one room, where it handed the other person's handle and emoji to
     * whoever logged in next and then announced it as theirs. */
    /* How often this person has used each emoji, so the pickers can lead with
     * the ones they actually reach for. Per seat, like the profile: it is a
     * habit of the person, not of the browser. */
    emojiUses: (slot) => getShared(slot ? `emoji-s${slot}` : 'emoji'),
    setEmojiUses: (value, slot) => putShared(value, slot ? `emoji-s${slot}` : 'emoji'),
    profile: (slot) => getShared(slot ? `me-s${slot}` : 'me'),
    setProfile: (value, slot) => putShared(value, slot ? `me-s${slot}` : 'me'),
    // Shared rather than per-room, and deliberately: it is a property of this
    // device, the service worker has to be able to read it with no page open,
    // and muting one conversation while another shouts is not a thing anybody
    // asked for.
    notifications: () => getShared('notifications'),
    setNotifications: (value) => putShared(value, 'notifications'),
    /* Whether this browser is locked.
     *
     * Locking was a screen swap and nothing more, so the next load read the
     * stored token and walked straight back into the conversation — which made
     * both "Lock now" and the five-minute auto-lock decorative, and meant
     * handing someone a locked phone handed them the thread. It has to outlive
     * the page, so it lives beside the tokens it is guarding. */
    locked: () => getShared('locked'),
    setLocked: (value) => putShared(!!value, 'locked'),
    /* How patient this device is about locking itself.
     *
     * Shared rather than per-room, like the bell above and for the same reason:
     * it is a property of the browser, not of a conversation. A phone that
     * leaves the house wants a minute; the laptop nobody else touches wants
     * never, and neither of them is a fact about the person you are talking to.
     *
     * The preset *key* is stored, not the milliseconds behind it, so the table
     * in app.js can be retuned later without every device that already chose
     * "2 minutes" being frozen on whatever two minutes meant that day. Absent
     * means the default, which is what everyone had before this was a setting. */
    lockAfter: () => getShared('lock-after'),
    setLockAfter: (value) => putShared(value, 'lock-after'),
    /* Whether closing the app counts as walking away. Absent means no, so
     * nobody who never opens the setting has their app behave differently
     * tomorrow than it did today. */
    lockOnReopen: () => getShared('lock-on-reopen'),
    setLockOnReopen: (value) => putShared(!!value, 'lock-on-reopen'),
    async wipeEverything() {
      // Signing out has to take the shared vault too, or the next person to
      // use this browser inherits its keys and tokens.
      const names = (await indexedDB.databases?.()) || [];
      if (sharedHandle) sharedHandle.close();
      if (handle) handle.close();
      sharedHandle = handle = null;
      await Promise.all(
        names
          .filter((d) => d.name === NAME || String(d.name).startsWith(NAME + '-'))
          .map(
            (d) =>
              new Promise((resolve) => {
                const request = indexedDB.deleteDatabase(d.name);
                request.onsuccess = request.onerror = request.onblocked = resolve;
              })
          )
      );
    },
  };
})(self);
