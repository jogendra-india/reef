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
  // things that span rooms. Every room then gets its own `reef-<id>`, so one
  // conversation's history cannot be read while another is open. That is a
  // structural guarantee rather than a filter someone has to remember to
  // apply on every query.
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
  function useRoom(roomId) {
    const next = roomId ? `${NAME}-${roomId}` : NAME;
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

  root.ReefDB = {
    STORES,
    open,
    get,
    put,
    del,
    all,
    entries,
    clearAll,
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
    profile: () => getShared('me'),
    setProfile: (value) => putShared(value, 'me'),
    // Shared rather than per-room, and deliberately: it is a property of this
    // device, the service worker has to be able to read it with no page open,
    // and muting one conversation while another shouts is not a thing anybody
    // asked for.
    notifications: () => getShared('notifications'),
    setNotifications: (value) => putShared(value, 'notifications'),
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
