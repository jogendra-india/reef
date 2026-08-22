/* Reef — the whole UI.
 *
 * No framework. This screen is mostly targeted DOM updates over an
 * append-only list, which vanilla does more directly than a virtual DOM would,
 * and it means nothing is fetched from a CDN — in an end-to-end encrypted app,
 * a third-party script tag is a key-exfiltration path.
 */
(function () {
  'use strict';

  const C = self.ReefCrypto;
  const DB = self.ReefDB;
  const API = self.ReefAPI;

  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const uuid = () =>
    (crypto.randomUUID && crypto.randomUUID()) ||
    'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });

  // Android only. iOS Safari has no vibration API, so nothing may depend on it.
  const buzz = (ms) => navigator.vibrate && navigator.vibrate(ms);

  let toastTimer;
  function toast(message) {
    const node = $('toast');
    node.textContent = message;
    node.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => node.classList.remove('on'), 2600);
  }

  /* ==================================================================== *
   * Debug log
   * ==================================================================== *
   *
   * On by default, and printed straight to the console, because the thing it
   * exists for happens by surprise: a scroll to the top of the thread that
   * replaces the whole screen with "N earlier messages cannot be opened on
   * this device". Nobody can reproduce that on demand, so anything that has to
   * be switched on first would only ever be switched on after the one moment
   * worth recording. Every line is a short tag and a small object, so a
   * session that never hits it costs a few dozen lines and nothing else.
   *
   * Nothing here logs message text, a handle, or key material — only ids,
   * seqs and counts — because the console is the one place in an
   * end-to-end-encrypted app where plaintext would be pasted into a bug
   * report.
   *
   * In the console:
   *   reef.dump()  — the whole ring buffer as text, to paste
   *   reef.copy()  — the same, onto the clipboard
   *   reef.now()   — what the window and the store look like right now
   */
  const LOG_KEEP = 500;
  const logRing = [];
  const logStart = Date.now();

  const sinceBoot = () => ((Date.now() - logStart) / 1000).toFixed(2) + 's';
  // Enough of a uuid to line two log lines up against each other, not enough to
  // be worth redacting.
  const short = (id) => String(id || '').slice(0, 8);

  /* Routine lines are kept, not printed.
   *
   * Printing everything was right while the sealed-history bug was still being
   * chased and wrong the moment it was understood: a normal session scrolled
   * hundreds of lines past, which buries anything that matters and is no way
   * to leave an app running. The ring still holds all of it, so `reef.dump()`
   * and the Storage sheet's copy button answer exactly as they did — the
   * console is simply no longer shouted at. Only the states that should never
   * happen still print, and those should now be silent for good. */
  function record(level, tag, detail) {
    let text;
    try {
      text = detail === undefined ? '' : JSON.stringify(detail);
    } catch (e) {
      text = '[unserialisable]';
    }
    logRing.push(`${sinceBoot()} ${level === 'warn' ? '! ' : ''}${tag} ${text}`);
    if (logRing.length > LOG_KEEP) logRing.shift();
    if (level !== 'warn') return;
    console.warn(`[reef ${sinceBoot()}] ${tag}`, detail === undefined ? '' : detail);
  }

  const log = (tag, detail) => record('log', tag, detail);
  // For the states that should never happen — the only thing still printed.
  const logBad = (tag, detail) => record('warn', tag, detail);

  /* Gets the buffer off the device. There is no console on a phone, and this
   * app is mostly used from one — which is the whole reason the lines are kept
   * in a ring rather than only printed. Reached from Storage in the menu. */
  async function copyDebugLog() {
    const text = logRing.join('\n');
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      /* no async clipboard: an insecure origin, or permission refused */
    }
    try {
      // The old way, which still works in the places the one above does not.
      const box = el('textarea');
      box.value = text;
      box.style.cssText = 'position:fixed;top:-1000px;opacity:0';
      document.body.appendChild(box);
      box.select();
      const copied = document.execCommand('copy');
      box.remove();
      return copied;
    } catch (e) {
      return false;
    }
  }

  self.reef = Object.assign(self.reef || {}, {
    dump() {
      const text = logRing.join('\n');
      console.log(text);
      return text;
    },
    copy: copyDebugLog,
    now: () => viewReport('asked'),
  });

  /* Each fish carries its own name, because picking one is how most people name
   * themselves here — the handle was a separate box you had to notice and edit,
   * so everybody stayed "Pufferfish" while wearing a shark.
   *
   * Unicode has no goldfish. 🐠 is the gold-and-orange one, so it wears the
   * name; the striped "Clownfish" it used to be called was the less accurate of
   * the two readings anyway.
   *
   * Three rows of eight in the picker's 8-column grid. A handful are recent
   * additions to Unicode — 🪼 and 🌊-era glyphs aside, 🦭 🦪 🦞 🦦 🧽 all
   * postdate 2018 — so a genuinely old phone may draw one as a box. It is
   * cosmetic: the emoji travels as text either way, and the name beside it says
   * what it was meant to be. */
  const FISH = [
    ['🐠', 'Goldfish'],
    ['🐡', 'Pufferfish'],
    ['🐟', 'Minnow'],
    ['🦈', 'Shark'],
    ['🐬', 'Dolphin'],
    ['🐳', 'Whale'],
    ['🐋', 'Humpback'],
    ['🦭', 'Seal'],
    ['🦦', 'Otter'],
    ['🐧', 'Penguin'],
    ['🐢', 'Turtle'],
    ['🐊', 'Crocodile'],
    ['🐙', 'Octopus'],
    ['🦑', 'Squid'],
    ['🪼', 'Jellyfish'],
    ['🦐', 'Shrimp'],
    ['🦞', 'Lobster'],
    ['🦀', 'Crab'],
    ['🦪', 'Oyster'],
    ['🐚', 'Shell'],
    ['🪸', 'Coral'],
    ['🧽', 'Sponge'],
    ['🦠', 'Plankton'],
    ['🌊', 'Wave'],
  ];
  const fishName = (emoji) => (FISH.find(([e]) => e === emoji) || [])[1];
  /* A handle that is still the name of some fish has never been typed over, so
   * it should follow the next fish picked. Type anything of your own and it
   * stops following — which is the "until I change it" part. */
  const isFishName = (handle) => FISH.some(([, name]) => name === handle);

  const DEFAULT_PROFILE = {
    1: { handle: 'Pufferfish', emoji: '🐡' },
    2: { handle: 'Goldfish', emoji: '🐠' },
  };

  const state = {
    session: null,
    device: null,
    identity: null,
    recipients: [],
    pairKeys: {},
    messages: new Map(),
    profiles: {},
    me: { handle: 'Fish', emoji: '🐟' },
    // How much of the thread is rendered. See viewBounds.
    view: { tail: 0, count: 60 },
    replyTo: null,
    editing: null,
    stream: null,
    online: false,
    peerTyping: false,
    peerOnline: false,
    // Which of the peer's devices are currently heartbeating. A flag was not
    // enough: presence arrives per device, and a single boolean cannot tell
    // "the peer left" from "some device somewhere sent an event".
    peerLive: [],
    lastSeen: null,
    stickBottom: true,
    unseen: 0,
    // Multi-select. A Set rather than a count: toggling has to know which
    // messages, not just how many, and the bulk bar's own eligibility check
    // reads every one of them.
    selecting: false,
    selection: new Set(),
    // null until the socket's opening frame settles it: true if the far end
    // sends hello and relays presence beats, false if it turned out to be an
    // older server. See expectHello.
    serverBeats: null,
    // Id of the one message whose text is currently selectable by hand, if any.
    // See startTextPick — row gestures stand down for as long as it is set.
    picking: null,
    devices: [],
    pendingDevices: [],
    // Mirrors the stored setting so the menu can label the bell without an await.
    notifications: true,
    // Which row of LOCK_PRESETS this device is on, and whether reopening the
    // app asks for the PIN. Mirrored here so the timers and the sheet can read
    // them synchronously. The literal rather than LOCK_DEFAULT: this object is
    // built at the top of the file, and the table is declared further down.
    lockAfter: '2m',
    lockOnReopen: false,
    // Whether the browser has promised not to evict this origin. The keypair
    // lives in IndexedDB and cannot be re-created, so this is the difference
    // between being signed out and becoming a different device.
    storagePersisted: null,
    // Set when this load had to generate a keypair, which means the vault was
    // empty: a wipe, or an eviction.
    freshIdentity: false,
    build: null,
    hiddenAt: null,
    locked: true,
    // One PIN opens every room its holder is seated in, so the client keeps a
    // token per room and one of them is active at a time.
    sessions: {},
    roomId: null,
    requests: [],
    mustChangePin: false,
  };

  /* ==================================================================== *
   * Viewport: the keyboard problem
   * ==================================================================== */

  function trackKeyboard() {
    const vv = window.visualViewport;
    if (!vv) return;
    const sync = () => {
      const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      document.documentElement.style.setProperty('--kb', kb + 'px');
      // The list must stay where the eye left it across an open/close. Not
      // scrollToBottom: that also clears the unread count, so opening the
      // keyboard used to throw away "3 new ripples" without showing them.
      if (state.stickBottom) pinToBottom();
    };
    vv.addEventListener('resize', sync);
    vv.addEventListener('scroll', sync);
    sync();
  }

  function showScreen(name) {
    ['lock', 'pending', 'pool'].forEach((id) =>
      $(id).classList.toggle('on', id === name)
    );
  }

  /* ==================================================================== *
   * Lock screen
   * ==================================================================== */

  // Six digits, matching reef/constants.py. Four would be 10,000 combinations,
  // which the server's throttle stretches to roughly three months of nonstop
  // guessing; six turns the same attack into decades.
  const PIN_LENGTH = 6;

  // A box sized for six digits, not for the sheet it sits in. `width:100%`
  // read as generous on a phone and absurd once the sheet itself was capped
  // on a wide screen — a PIN entry stretched nearly as wide as the dialog.
  const PIN_INPUT_STYLE =
    'width:11em;max-width:100%;display:block;margin:0 auto 8px;padding:12px;' +
    'border-radius:12px;background:var(--bg);border:1px solid var(--line);' +
    'letter-spacing:.5em;text-align:center';

  let entry = '';
  let lockBusy = false;

  function buildDots() {
    const dots = $('dots');
    dots.innerHTML = '';
    for (let i = 0; i < PIN_LENGTH; i++) dots.appendChild(el('i', 'dot'));
  }

  function paintDots(wrong) {
    const dots = $('dots');
    [...dots.children].forEach((d, i) => d.classList.toggle('full', i < entry.length));
    if (wrong) {
      dots.classList.add('wrong');
      setTimeout(() => dots.classList.remove('wrong'), 420);
    }
  }

  function buildKeypad() {
    const pad = $('keypad');
    pad.innerHTML = '';
    const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'];
    keys.forEach((k) => {
      if (k === '') return pad.appendChild(el('div', 'key blank'));
      const button = el('button', 'key' + (k === '⌫' ? ' util' : ''), k);
      button.type = 'button';

      // pointerdown, not click. `click` fires when the finger lifts, and iOS
      // Safari never applies :active to a button, so a click-driven pad shows
      // nothing at all while it is being pressed — which is what made entering
      // a PIN feel slow. The press state is a class for the same reason.
      button.addEventListener('pointerdown', () => {
        button._fromPointer = true;
        button.classList.add('down');
        onKey(k);
      });
      const up = () => button.classList.remove('down');
      ['pointerup', 'pointercancel', 'pointerleave'].forEach((type) =>
        button.addEventListener(type, up)
      );
      // Still bound, so Enter and Space on a focused key work. The flag stops
      // a tap counting twice, since pointerdown always precedes the click.
      button.addEventListener('click', () => {
        if (button._fromPointer) {
          button._fromPointer = false;
          return;
        }
        onKey(k);
      });

      pad.appendChild(button);
    });
  }

  async function onKey(k) {
    if (lockBusy) return;
    buzz(8);
    if (k === '⌫') {
      entry = entry.slice(0, -1);
      return paintDots();
    }
    if (entry.length >= PIN_LENGTH) return;
    entry += k;
    paintDots();
    // The last digit submits. There is no Enter key and no Done button — one
    // less thing on a screen that deliberately says nothing.
    if (entry.length === PIN_LENGTH) await submitPin(entry);
  }

  async function submitPin(pin) {
    lockBusy = true;
    // The pad is frozen for the length of a round trip, and the server hashes
    // the PIN deliberately slowly. Without this the sixth digit looks like a
    // hang.
    $('lock-note').textContent = 'Checking…';
    try {
      await unlockWith(pin);
      $('lock-note').textContent = '';
    } catch (err) {
      entry = '';
      paintDots(true);
      buzz([40, 60, 40]);
      $('lock-note').textContent = lockError(err);
    } finally {
      lockBusy = false;
    }
  }

  /* Every failure used to shake the dots and say nothing, so a server error and
   * a wrong PIN were indistinguishable — and so was signing in correctly with
   * nobody to talk to yet. */
  function lockError(err) {
    if (!err) return 'That did not work';
    if (err.offline) return 'No connection';
    if (err.noRooms) return 'Signed in, but you are not in a conversation yet';
    if (err.status === 429) {
      const wait = Number(err.retryAfter || 0);
      return wait ? `Try again in ${Math.ceil(wait / 60)} min` : 'Try again later';
    }
    if (err.status === 400 || err.status === 401 || err.status === 403) {
      return 'Wrong PIN';
    }
    return 'Something went wrong — try again';
  }

  /* ==================================================================== *
   * Identity and unlock
   * ==================================================================== */

  /* Asks the browser not to throw this origin away.
   *
   * Without a persistence grant, IndexedDB is best-effort storage: Chrome on
   * Android evicts it under pressure, and the system's own "free up space"
   * flows take it too. What lives in there is the keypair, and the private
   * half is deliberately non-extractable — there is no copy and no way to make
   * one — so losing the vault does not sign this device out, it makes the
   * browser a *stranger*. The next PIN generates a new key, the server matches
   * browsers by public key and sees one it has never met, and what should have
   * been "signing in again" enrols a new device with a new id and no history.
   *
   * Chrome grants this to an installed PWA or a site with enough engagement,
   * and it is a no-op once granted. Nothing depends on the answer, so a refusal
   * is recorded for the storage sheet rather than acted on.
   */
  async function keepStorage() {
    try {
      if (!navigator.storage || !navigator.storage.persist) return null;
      const already = navigator.storage.persisted
        ? await navigator.storage.persisted()
        : false;
      state.storagePersisted = already || (await navigator.storage.persist());
      return state.storagePersisted;
    } catch (e) {
      return null; // not offered here; the vault is as safe as the browser makes it
    }
  }

  async function ensureIdentity() {
    // Before the read, not after: asking once the key is already gone is too
    // late to be the thing that kept it.
    await keepStorage();
    let identity = await DB.identity();
    if (!identity) {
      const pair = await C.generateIdentity();
      identity = {
        privateKey: pair.privateKey,
        publicJwk: await C.exportPublicJwk(pair.publicKey),
      };
      // The private key is non-extractable; structured clone into IndexedDB
      // keeps it that way, so it survives a restart without ever being
      // exportable by script.
      await DB.setIdentity(identity);
      // Worth saying out loud on the waiting screen. A browser with no stored
      // key is not this device signing in again — it is a new one, which is
      // why approval is being asked for and why the thread will not come back
      // with it. Silently, this looked like the app losing messages.
      state.freshIdentity = true;
    }
    state.identity = identity;
    return identity;
  }

  function deviceLabel() {
    const ua = navigator.userAgent;
    if (/iPhone|iPad/.test(ua)) return 'iPhone';
    if (/Android/.test(ua)) return 'Android';
    if (/Mac/.test(ua)) return 'Mac';
    if (/Windows/.test(ua)) return 'Windows';
    return 'Browser';
  }

  async function unlockWith(pin) {
    await ensureIdentity();
    // The server matches this browser by its public key, so there is no
    // device id to remember — and nothing to get wrong after a cache clear.
    const body = {
      pin,
      device: { label: deviceLabel(), public_key_jwk: state.identity.publicJwk },
    };

    let result;
    try {
      result = await API.unlock(body);
    } catch (err) {
      if (err.status === 429) err.retryAfter = 900;
      throw err;
    }
    await enterFromResult(result);
  }

  /* Creates a brand-new room with this browser as its only seat, then opens it
   * exactly as unlockWith would. There is no admin and no invite code before
   * this call — nobody else to ask — so the PIN is the one credential this app
   * ever lets somebody choose for themselves rather than being handed. */
  async function registerWith(pin) {
    await ensureIdentity();
    const body = {
      pin,
      device: { label: deviceLabel(), public_key_jwk: state.identity.publicJwk },
    };
    let result;
    try {
      result = await API.register(body);
    } catch (err) {
      if (err.status === 429) err.retryAfter = 900;
      throw err;
    }
    await enterFromResult(result);
  }

  /* The tail shared by unlockWith and registerWith: both end up with the same
   * shape — a `rooms` list, one entry per conversation this credential now
   * opens — and everything from here on (which one to show, marking the
   * device unlocked) has nothing to do with how it was obtained. */
  async function enterFromResult(result) {
    // Checked before anything is stored. An empty list used to fall through to
    // `preferred.room_id` on undefined, and the resulting TypeError was caught
    // by submitPin — so a correct PIN reported itself as wrong.
    if (!result.rooms || !result.rooms.length) {
      const err = new Error('no rooms');
      err.noRooms = true;
      throw err;
    }

    // One PIN, every room that person is seated in. Each comes with its own
    // device and token, because a device is approved room by room.
    const sessions = {};
    result.rooms.forEach((room) => {
      sessions[room.room_id] = {
        token: room.token,
        deviceId: room.device.id,
        status: room.device.status,
        slot: room.session.slot,
        // Kept alongside the token because boot() needs it before it has asked
        // /session/ anything — and, offline, before it can ask at all. A room
        // that skips device approval also skips every lock timer, so without a
        // stored copy of this flag the lock-on-reopen check at boot would put a
        // PIN screen in front of exactly the rooms that opted out of one.
        autoApprove: !!room.session.auto_approve_devices,
      };
    });
    await DB.setSessions(sessions);
    state.sessions = sessions;
    state.mustChangePin = result.must_change_pin;

    const preferred = pickRoom(result.rooms);
    entry = '';
    paintDots();
    state.locked = false;
    // The PIN is what lifts the lock, and the only thing that does. Cleared
    // here rather than on arrival in the room, so a room that fails to open
    // does not leave the app locked against a PIN the server just accepted.
    await DB.setLocked(false).catch(() => {});
    markUnlockedThisTab();
    await enterRoom(preferred.room_id, preferred);
  }

  /* Records that this tab, specifically, made it past the lock screen.
   *
   * Read by boot() as `sameSession` for the lock-on-reopen setting: a fresh
   * tab has never called this, so it relocks; a tab that already has, calling
   * it again on every later refresh is a no-op, which is what makes a plain
   * reload not count as "closing the app" once you are already in. Called
   * from here (the PIN was just accepted) and from boot()'s own direct-resume
   * branch (no PIN was needed at all) — the two ways a tab actually ends up
   * unlocked. */
  function markUnlockedThisTab() {
    try {
      sessionStorage.setItem('reef-unlocked', '1');
    } catch (e) {
      /* private mode: next load just relocks again, which is the safe way to
       * fail. */
    }
  }

  /* Keeps the stored copy of a room's auto-approve flag honest.
   *
   * An admin can turn it on for a room that was ordinary when this device last
   * unlocked, and the stale `false` left behind is the one that hurts: it is
   * what boot() reads to decide whether to demand a PIN, and demanding one from
   * an unattended agent seat is how a channel goes quiet with nobody to notice.
   * Called wherever a fresh session lands, which is every point the server gets
   * a chance to tell us it changed. */
  async function rememberAutoApprove() {
    const stored = state.sessions[state.roomId];
    if (!stored || !state.session) return;
    const flag = !!state.session.auto_approve_devices;
    if (stored.autoApprove === flag) return;
    stored.autoApprove = flag;
    await DB.setSessions(state.sessions).catch(() => {});
  }

  /* Which conversation to open when a PIN opens several.
   *
   * This used to be "the first room where this device is active, else the first
   * room", which sounds right and is how you end up staring at an empty
   * conversation. A room seeded by hand, or the half-empty one an invite leaves
   * behind, has an active device and nobody in it — and being older, it sorts
   * first. The room with the other person in it lost every time, and the only
   * way out was to know that "Switch conversation" existed.
   *
   * So: somewhere with a person beats somewhere without one, and among those,
   * one this device can already read beats one still waiting for approval. */
  function pickRoom(rooms) {
    const peersIn = (room) =>
      (((room.session || {}).peer_devices) || []).filter(
        (d) => d.status === 'active'
      ).length;
    const rank = (room) => {
      const mine = room.device.status === 'active';
      if (mine && peersIn(room)) return 3;
      if (peersIn(room)) return 2; // someone is there; this device needs letting in
      if (mine) return 1; // ours to read, but empty
      return 0;
    };
    // Stable, so rooms of equal rank keep the server's order — oldest first.
    return [...rooms].sort((a, b) => rank(b) - rank(a))[0];
  }

  /* Makes one conversation the active one. Everything room-scoped is torn down
   * and rebuilt, and the local store is re-pointed first, so nothing from the
   * previous room can survive into this one. */
  async function enterRoom(roomId, prefetched) {
    if (state.stream) state.stream.close();
    state.stream = null;
    stopRoomTimers();
    state.messages = new Map();
    // The DOM, not only the state. Clearing state.messages here meant the
    // *next* renderList() would draw the right room — but showScreen('pool')
    // below runs long before that, and reveals whatever #list already
    // contained. On a browser signed into two seats, "whatever it already
    // contained" was the other seat's conversation: real bubbles, briefly on
    // screen, replaced only once refreshKeys/hydrateFromLocal finally
    // finished their round trips. Same reasoning for the header text, which
    // no code here repaints until refreshKeys does, several awaits later —
    // the other person's name showing for that window is the same leak in a
    // smaller box.
    $('list').innerHTML = '';
    $('peer-name').textContent = 'Reef';
    $('peer-avatar').textContent = '🐟';
    $('peer-state').textContent = '';
    // A selection is a set of ids in *this* room; carrying it into another
    // one is at best meaningless and at worst a bulk action landing on
    // whichever unrelated messages happen to share those ids.
    state.selecting = false;
    state.selection = new Set();
    updateSelectBar();
    state.profiles = {};
    state.recipients = [];
    state.pairKeys = {};
    state.view = { tail: 0, count: 60 };
    invalidateOrder();
    state.unseen = 0;
    state.devices = [];
    state.pendingDevices = [];
    state.peerLive = [];
    state.peerOnline = false;
    state.lastSeen = null;
    deliveredSent.clear();
    // A result set belongs to the conversation it was found in, and the search
    // store is room-scoped, so both go with the room.
    closeSearch();
    clearMatches();
    // Attachments belong to the conversation they were picked for.
    clearStaged();
    paintDeviceBanner();
    clearReply();
    cancelEdit();

    const session = state.sessions[roomId];
    // Seat, not just room: one browser can be used by both people in a
    // conversation, and they must not share a store.
    DB.useRoom(roomId, session.slot);
    state.roomId = roomId;
    API.setToken(session.token);

    if (prefetched) {
      state.device = prefetched.device;
      state.session = prefetched.session;
    } else {
      const result = await API.session();
      state.device = result.device;
      state.session = result.session;
    }
    await rememberAutoApprove();
    await afterUnlock();
  }

  async function afterUnlock() {
    // A join PIN was sent over someone else's messenger and is probably still
    // sitting in that thread. Nothing else happens until it is replaced.
    //
    // Read from the session as well as from the unlock, and that is the whole
    // bug: `state.mustChangePin` was set in unlockWith and nowhere else, so it
    // was undefined on every load that resumed a stored session. A seat that
    // stayed signed in was therefore never once asked, and could sit on its
    // one-time join PIN indefinitely — right up to the day it expired and
    // stopped opening the conversation at all.
    const session = state.session || {};
    if (state.mustChangePin || session.must_change_pin) {
      showScreen('pool');
      return openPinSheet({
        forced: true,
        expiresAt: session.join_pin_expires_at || null,
      });
    }
    if (state.device.status !== 'active') {
      $('pending-note').textContent = state.freshIdentity
        ? 'This browser had no saved key, so it is joining as a new device — ' +
          'not the one you signed in on before. The other person has to let it ' +
          'in, and the messages that were on it do not come back with it.'
        : 'The other person needs to approve this device before anything ' +
          'appears here.';
      showScreen('pending');
      pollForApproval();
      return;
    }
    showScreen('pool');
    // The conversation is on screen now, so the idle clock applies.
    idleReset();
    refreshRequests();
    // A device waiting for approval only ever announced itself through a live
    // WebSocket event. Anyone who was not looking at the screen at that moment
    // — app closed, backgrounded, reconnecting — never learned about it. Asking
    // on the way in means a request that arrived overnight is still visible.
    //
    // The socket's hello frame carries this too, and arrives seconds later. This
    // call stays because it does not depend on a socket: where WebSocket is
    // blocked outright, it is the only thing that ever populates the list, and
    // the app has to stay usable there.
    refreshDevices();
    await loadProfileSettings();
    await refreshKeys();
    // After refreshKeys, because re-deriving `mine` on the copied rows needs to
    // know which devices are ours; before hydrate, so the thread is painted once,
    // already correct.
    await adoptLegacyHistory();
    await hydrateFromLocal();
    // Before the stream, so the header is right from the first paint rather than
    // waiting for an event that may never come.
    seedPresence();
    connectStream();
    await syncHistory();
    await flushOutbox();
    subscribePush();
    announceProfile();
    // Last, and unawaited: housekeeping must never delay the conversation.
    tidyLocalStore();
  }

  /* Waiting to be let in.
   *
   * This asked /session/ every four seconds — the last poll left, and the one
   * that could not simply move to the room's socket, because a device waiting for
   * approval has no business on it. It does have its own device group though, and
   * that carries the two things it is waiting for: its own approval and its own
   * refusal. So it can wait on the socket like everything else.
   *
   * The poll stays as a fallback, at a fifth of the rate, for a network that
   * blocks WebSocket outright. Twenty seconds is slow enough to cost nothing and
   * quick enough that nobody watching the screen wonders whether it is stuck.
   */
  const APPROVAL_POLL = 20000;
  let approvalTimer = null;
  let approvalStream = null;

  function stopWaitingForApproval() {
    clearInterval(approvalTimer);
    approvalTimer = null;
    if (approvalStream) approvalStream.close();
    approvalStream = null;
  }

  /* The socket only ever says "look again" — the answer comes from /session/,
   * which is the same check the poll made and already handles every outcome. An
   * event that merely triggers it cannot be wrong about what happened, and this
   * device's own status is not something to take on trust from a frame. */
  async function checkApproval() {
    try {
      const result = await API.session();
      if (result.device.status === 'active') {
        stopWaitingForApproval();
        state.device = result.device;
        state.session = result.session;
        await rememberAutoApprove();
        toast('Approved. Welcome in.');
        await afterUnlock();
      } else if (result.device.status === 'revoked') {
        stopWaitingForApproval();
        // Turned down. This device may have been active before and still hold
        // messages, and being refused entry is no reason to destroy them.
        await signOut({ keepHistory: true });
      }
    } catch (e) {
      /* offline; keep waiting */
    }
  }

  function pollForApproval() {
    stopWaitingForApproval();
    approvalStream = API.createStream({
      onStatus: () => {},
      onEvent: (event) => {
        if (event.type === 'device.approved' || event.type === 'device.revoked') {
          checkApproval();
        }
      },
    });
    approvalStream.connect();
    approvalTimer = setInterval(checkApproval, APPROVAL_POLL);
  }

  /* Two different things, previously conflated.
   *
   * "Start over on this device" means erase it, and does. Being signed out
   * *remotely* — which is what happens to the old device when a replacement is
   * approved — used to run the same wipe, so a device you had not touched lost
   * every message it held. That was never a security gain: messages are stored
   * decrypted because the device is the trust boundary, so anybody holding the
   * device could already read them. All revocation should take is the ability to
   * fetch more.
   *
   * So the credentials go and the history stays. Sign in again on that device —
   * after the other person approves it, since the room now has messages — and the
   * thread is where you left it. */
  async function signOut({ keepHistory = false } = {}) {
    stopWaitingForApproval();
    stopRoomTimers();
    if (state.stream) state.stream.close();
    if (keepHistory) {
      await DB.forgetSessions();
    } else {
      await DB.wipeEverything();
    }
    location.reload();
  }

  /* ==================================================================== *
   * Keys
   * ==================================================================== */

  /* True for exactly as long as the pair keys are being rebuilt. Read only by
   * the log: if a message ever turns unreadable during that window, this is
   * what says so, and it is the difference between "the key is gone" and "the
   * key was two awaits away". */
  let keysRefreshing = false;

  async function refreshKeys() {
    keysRefreshing = true;
    log('keys.refresh');
    try {
      await refreshKeysInner();
    } finally {
      keysRefreshing = false;
      log('keys.ready', {
        recipients: state.recipients.map((r) => String(r.id)),
        derived: Object.keys(state.pairKeys),
      });
    }
  }

  async function refreshKeysInner() {
    const result = await API.keys();
    state.recipients = result.recipients || [];
    state.session.safety_number = result.safety_number;
    // Built up separately and swapped in as one assignment, not cleared then
    // refilled in place. `derivePairKey` awaits WebCrypto, so clearing first
    // left a real gap — several event-loop turns wide — where any decrypt
    // running concurrently (a scroll pulling in older history, a message
    // arriving) read pairKeys as empty for a peer it already had a perfectly
    // good key for, and wrote that message to disk as permanently
    // undecryptable. Recent messages get re-ingested constantly and shrug
    // that off; a page loaded once by scrolling up never comes through
    // ingest again, so the placeholder stuck for good. The old key stays
    // valid for every already-known peer for the entire duration of this
    // function now, so there is no gap for them to be caught in.
    const nextKeys = {};
    for (const recipient of state.recipients) {
      nextKeys[recipient.id] = await C.derivePairKey(
        state.identity.privateKey,
        recipient.public_key_jwk,
        state.device.id,
        recipient.id
      );
    }
    state.pairKeys = nextKeys;
    paintHeader();
    paintPeerMissing();
    // Whoever just appeared has to be told who you are, and this is the one
    // function every route to a changed recipient list passes through — unlock,
    // a device event, the divergence check in refreshDevices. Guarded and
    // deduplicated internally, so calling it freely is safe.
    announceProfile();
  }

  function pairKeyFor(deviceId) {
    return state.pairKeys[deviceId];
  }

  /* `recipients` is the list to *seal for*, and it deliberately includes this
   * person's own other devices — your laptop has to be able to read what you
   * sent from your phone. It is therefore the wrong list for every question that
   * means "the other person": whether there is anybody to talk to, whose name is
   * in the header, who just came online, whose reaction that is.
   *
   * Slot is what separates them, and it rides along on every device the server
   * describes. */
  const peerRecipients = () =>
    state.recipients.filter(
      (r) => !state.session || r.slot !== state.session.slot
    );

  const isOwnDevice = (deviceId) => {
    const id = String(deviceId);
    if (id === String(state.device.id)) return true;
    return state.recipients.some(
      (r) => String(r.id) === id && state.session && r.slot === state.session.slot
    );
  };

  /* ==================================================================== *
   * History
   * ==================================================================== */

  /* Takes over a conversation stored before the per-seat split.
   *
   * The store used to be named for the room alone, so renaming it would read as
   * losing the thread. The rows are copied across once, and their `mine` flags
   * re-derived: they were computed for whichever seat wrote them, and on the
   * other seat every one of them is backwards.
   *
   * Only the last 400 are corrected locally — the same window hydrate reads —
   * because `isOwnDevice` cannot speak for a device that has since been revoked
   * and is no longer in `recipients`. Anything the server still lists gets the
   * authoritative answer from the next sync anyway.
   */
  async function adoptLegacyHistory() {
    let taken = 0;
    try {
      taken = await DB.adoptLegacyRoom(state.roomId);
    } catch (e) {
      return; // nothing to adopt, or it could not be opened
    }
    if (!taken) return;

    // Offline, or before the key list has arrived, `isOwnDevice` cannot answer —
    // and guessing would put messages on the wrong side. The copied flags are
    // already right for the overwhelmingly common case of one person per device,
    // and the next sync settles the rest, so leave them be.
    if (!state.recipients || !state.recipients.length) return;

    try {
      const stored = await DB.messagesPage(400);
      const fixed = stored.filter((message) => {
        const ours = isOwnDevice(message.senderDeviceId);
        if (message.mine === ours) return false;
        message.mine = ours;
        return true;
      });
      if (fixed.length) await DB.putMessages(fixed);
    } catch (e) {
      /* the sync will correct what it can reach */
    }
  }

  /* Keeps the device's own copy from growing without limit.
   *
   * Two very different risks, so two rules.
   *
   * Messages are a cache. The server keeps every message and envelope for good —
   * only ones given an explicit expiry are tombstoned — so dropping the oldest
   * costs a round trip the next time somebody scrolls that far, and nothing else.
   *
   * Media is not a cache. The server deletes blobs after ninety days, so a photo
   * older than that exists nowhere else, and evicting it would be the app quietly
   * destroying the only copy. Only blobs the server could still hand back are
   * ever dropped, largest first; the irreplaceable ones stay however old they
   * get. That means storage is bounded in practice rather than in theory, which
   * is the right way round for a messenger with no backup.
   */
  const LOCAL_MESSAGE_CAP = 5000;
  const MEDIA_BUDGET = 150 * 1024 * 1024;
  const SERVER_BLOB_DAYS = 90;

  async function tidyLocalStore() {
    try {
      await DB.pruneMessages(LOCAL_MESSAGE_CAP);
    } catch (e) {
      /* nothing to prune, or the store is busy */
    }

    try {
      const media = await DB.mediaEntries();
      let held = media.reduce((sum, entry) => sum + entry.size, 0);
      if (held <= MEDIA_BUDGET) return;

      // Attachments the server would still serve. Anything not in here — too old,
      // or belonging to a message already pruned — is left alone, because there
      // is no way to get it back.
      const cutoff = Date.now() - SERVER_BLOB_DAYS * 86400000;
      const replaceable = new Set();
      for (const message of await DB.messagesPage(LOCAL_MESSAGE_CAP)) {
        if (!message.createdAt) continue;
        if (new Date(message.createdAt).getTime() < cutoff) continue;
        for (const attachment of message.attachments || []) {
          replaceable.add(String(attachment.id));
        }
      }

      const evictable = media
        .filter((entry) => replaceable.has(String(entry.key).split(':')[0]))
        .sort((a, b) => b.size - a.size);

      for (const entry of evictable) {
        if (held <= MEDIA_BUDGET) break;
        await DB.del(DB.STORES.media, entry.key);
        held -= entry.size;
      }
    } catch (e) {
      /* leave it rather than risk deleting the wrong thing */
    }
  }

  async function hydrateFromLocal() {
    const [stored, profiles] = await Promise.all([
      DB.messagesPage(400),
      DB.entries(DB.STORES.profiles),
    ]);
    stored.forEach((m) => state.messages.set(m.id, m));
    invalidateOrder();
    state.profiles = profiles;
    // The baseline. If the store already holds sealed rows at boot, whatever
    // made them so happened in an earlier session and was written to disk.
    log('hydrate', {
      stored: stored.length,
      sealedOnDisk: stored.filter(unreadable).length,
      thread: ordered().length,
    });
    renderList();
  }

  async function syncHistory() {
    try {
      const since = await DB.highestSeq();
      // Two different questions, and `since` can only answer one of them.
      //
      // The cursor brings messages this device has not seen. But a receipt does
      // not move a message's seq, so a tick answered while this device was away
      // is on the wrong side of the cursor forever — which is the single tick
      // that never becomes a double no matter how long you wait. The only way to
      // see it is to re-read the tail and take the server's word for it.
      const [fresh, tail] = await Promise.all([
        since
          ? API.history({ since, page_size: 200 })
          : API.history({ page_size: 60 }),
        since ? API.history({ page_size: 40 }) : null,
      ]);
      log('sync', {
        since,
        fresh: (fresh.results || []).length,
        tail: tail ? (tail.results || []).length : null,
      });
      await ingest(fresh.results || []);
      if (tail) await ingest(tail.results || []);
    } catch (err) {
      log('sync.failed', { error: String((err && err.message) || err), offline: !!err.offline });
      if (!err.offline) console.warn('sync failed', err);
    }
  }

  /* Set once the server answers a page request with nothing.
   *
   * Without it, a thread whose oldest stretch draws as one collapsed line can
   * never fill the scroller, so scrollTop stays at the top, so every scroll
   * event asks for another page — of a history that ran out some time ago. */
  let reachedOldest = false;

  async function loadOlder() {
    // chronological() sorts a message still being sent to the end, which is what
    // this wants: its seq is null, and `cursor=null` asks the server for the
    // wrong page entirely.
    const oldest = chronological()[0];
    if (!oldest || !oldest.seq) {
      log('loadOlder.skip', { reason: oldest ? 'no-seq' : 'empty' });
      return;
    }
    try {
      const result = await API.history({ cursor: oldest.seq, page_size: 60 });
      const got = result.results || [];
      log('loadOlder.page', {
        cursor: oldest.seq,
        got: got.length,
        // How much of the page the server sent as an envelope this device can
        // even attempt — a page of rows with no envelope for us can only ever
        // render sealed.
        withEnvelope: got.filter((r) => !!r.envelope).length,
        seqs: got.length ? `${got[0].seq}..${got[got.length - 1].seq}` : null,
      });
      if (!got.length) reachedOldest = true;
      await ingest(got, true);
    } catch (e) {
      log('loadOlder.failed', { error: String((e && e.message) || e), offline: !!e.offline });
    }
  }

  async function ingest(rows, prepend) {
    const decoded = [];
    const viewBefore = Object.assign({}, state.view);
    // Rows that arrive unopenable, and — separately, and much worse — rows that
    // were readable on this device a moment ago and are about to be written
    // back over as a placeholder.
    let sealedIn = 0;
    const clobbered = [];
    // Counted here rather than only on the live socket event, because the
    // live event was the only path that ever counted anything. A message
    // that arrived while the socket was reconnecting — which is routine,
    // not rare — came in through here instead, on the same reconnect that
    // calls syncHistory, and landed silently: rendered, but with no pill and
    // no clue that anything had changed, if the reader was scrolled up.
    let freshUnseen = 0;
    for (const row of rows) {
      const isNewToThisDevice = !state.messages.has(row.id);
      let existing = state.messages.get(row.id);
      if (!existing) {
        // Not in memory is not the same as not on this device. hydrateFromLocal
        // loads the most recent 400, so scrolling further back re-fetches rows
        // whose plaintext is already stored here — and the placeholder below
        // would then overwrite a perfectly good local copy, permanently, via
        // putMessages. Your own messages are the worst case: the server holds no
        // envelope addressed to you, so the local copy is the only one there is.
        try {
          existing = await DB.get(DB.STORES.messages, row.id);
        } catch (e) {
          /* no local copy */
        }
      }
      const wasReadable = !!(existing && !unreadable(existing));
      const merged = Object.assign({}, existing || {}, {
        id: row.id,
        seq: row.seq,
        kind: row.kind,
        mine: row.mine,
        senderDeviceId: row.sender_device_id,
        replyTo: row.reply_to,
        createdAt: row.created_at,
        editedAt: row.edited_at,
        deleted: row.deleted,
        attachments: row.attachments || [],
        // Falling back to what is already held rather than to empty. A row that
        // arrives without these — an endpoint that omits them, a trimmed
        // payload — used to wipe receipts and reactions learned live, which on a
        // reconnect turned a pair of ticks back into one.
        reactions: mergeReactions(await decryptReactions(row, existing), existing),
        receipts: row.receipts || (existing && existing.receipts) || [],
        state: 'sent',
      });
      // The placeholder body is truthy, so `!merged.body` alone meant a message
      // that failed to open once was never tried again — not even after
      // refreshKeys produced the pair key it was waiting for.
      if (row.envelope && (!merged.body || merged.body.undecryptable)) {
        merged.body = await tryOpen(row);
      }
      // No envelope for this device at all — every message sent before it
      // existed. tryOpen never sees these, because there is nothing to attempt,
      // so the body stayed undefined and renderRow drew a bubble containing a
      // timestamp and nothing else. On a replacement device that was the entire
      // history rendered as dozens of blank rows.
      /* No envelope for this device at all, which is a different thing from a
       * decrypt that failed — and permanent in a way that one is not.
       *
       * An envelope is sealed per recipient device at the moment of sending,
       * so a device that joined later was never a recipient of anything older
       * than itself and never will be. There is no key escrow and no history
       * transfer here: those messages cannot be read on this device, today or
       * ever. Recording which of the two it was stops healRun spending a
       * round trip re-asking for an envelope that was never created. */
      if (!merged.body && !merged.deleted) {
        merged.body = { undecryptable: true, noEnvelope: !row.envelope };
      }
      if (merged.deleted) merged.body = null;
      if (unreadable(merged)) {
        sealedIn++;
        // This one is the bug, not a symptom: a message this device could read
        // is going back to disk as unopenable, and putMessages makes that
        // permanent. If the console shows these, the sealed run on screen was
        // manufactured locally rather than fetched that way.
        if (wasReadable) {
          clobbered.push({
            id: short(row.id),
            seq: row.seq,
            sender: String(row.sender_device_id),
            hadEnvelope: !!row.envelope,
          });
        }
      }
      decoded.push(merged);
      // Not on a history page load — those are pages the reader asked for by
      // scrolling, the opposite of something they missed — and not the
      // reader's own message, and not a profile change dressed as a message.
      if (!prepend && isNewToThisDevice && !row.mine && !isSystem(merged)) {
        freshUnseen++;
      }
    }
    /* Counted before anything is added, and deliberately not from
     * `decoded.length`. Both branches below move the window by however much the
     * *thread* grew, which is not the same as the number of rows that arrived:
     * ordered() drops system messages and anything hidden for this device, so a
     * page carrying a few profile announcements grows the thread by less than
     * its own length. This used to read the order cache while it was still
     * stale to get a "before" figure, which happened to work only because a
     * render had always warmed it first. */
    const lengthBefore = ordered().length;
    decoded.forEach((m) => {
      applyProfileMessage(m);
      state.messages.set(m.id, m);
    });
    if (decoded.length) await DB.putMessages(decoded);
    if (decoded.length) invalidateOrder();
    const added = ordered().length - lengthBefore;

    if (prepend) {
      // Reveal what was just loaded: the window is end-relative, so a prepend
      // alone would leave the visible set unchanged.
      //
      // Over-widening here looks harmless, since trimView caps it immediately —
      // but it pays for the excess out of `tail`, sliding the window further
      // back than the reader actually scrolled. Across a few pages that walks
      // it off the front of the thread and renders nothing at all.
      state.view.count += added;
      trimView();
    } else if (state.view.tail) {
      // Scrolled back into history, and something new has arrived at the far
      // end. `tail` counts from the newest, so leaving it alone would slide the
      // window forward under the reader — one older message dropped and one
      // newer gained, for every message the other person sends.
      if (added > 0) state.view.tail += added;
    }
    log('ingest', {
      rows: rows.length,
      prepend: !!prepend,
      added,
      sealedIn,
      thread: ordered().length,
      held: state.messages.size,
      view: `${viewBefore.count}/${viewBefore.tail} → ${state.view.count}/${state.view.tail}`,
      keysRefreshing,
    });
    if (clobbered.length) {
      logBad('ingest.overwrote-readable', {
        count: clobbered.length,
        first: clobbered.slice(0, 8),
        keysRefreshing,
        have: Object.keys(state.pairKeys),
      });
    }
    renderList(prepend);
    markVisibleRead();
    confirmDelivery(decoded);
    // Guarded on stickBottom exactly as the pill itself is: a cold start with
    // a whole history to load is "new to this device" for every row in it,
    // and stickBottom still being true at that point (nobody has scrolled
    // anywhere yet) is what keeps that from reading as hundreds of ripples.
    if (freshUnseen && !state.stickBottom) {
      state.unseen += freshUnseen;
      paintPill();
    }
  }

  // Ids this device has already told the server about, so a re-read of the tail
  // does not re-send the same confirmation on every reconnect.
  const deliveredSent = new Set();

  /* Confirms receipt of anything that arrived, however it arrived.
   *
   * This used to live in the msg.new handler alone, so a message was only ever
   * confirmed if it landed while the socket happened to be open and this screen
   * happened to be running. Everything picked up by a history sync — the app was
   * closed, backgrounded, mid-reconnect — was never acknowledged at all, and the
   * sender sat on one tick for a message sitting right there on the other
   * person's phone. */
  function confirmDelivery(messages) {
    if (!state.device || state.device.status !== 'active') return;
    const mine = String(state.device.id);
    const ids = messages
      .filter(
        (m) =>
          !m.mine &&
          !isSystem(m) &&
          !deliveredSent.has(m.id) &&
          !(m.receipts || []).some(
            (r) => String(r.device_id) === mine && r.delivered_at
          )
      )
      .map((m) => m.id);
    if (!ids.length) return;
    ids.forEach((id) => deliveredSent.add(id));
    API.receipts(ids, 'delivered').catch(() => {
      // Offline, most likely. Forget them again so the next sync retries rather
      // than leaving the sender on one tick permanently.
      ids.forEach((id) => deliveredSent.delete(id));
    });
  }

  /* Reactions the server can tell me about, plus the one it cannot.
   *
   * A reaction is sealed for each *recipient*, so nothing in it is addressed to
   * the device that sent it — the server therefore reports my own reaction as
   * absent, and that empty list used to overwrite the one on screen. Mine is
   * remembered locally, exactly as the text of a message I sent is.
   *
   * Only *this* device's reaction is kept that way. One sent from my phone
   * reaches my laptop through the server like anybody else's, so holding those
   * locally too would mean a stale copy that nothing could ever clear.
   */
  // Up to three per person. The body used to be a single emoji; both shapes are
  // read, because messages reacted to before this exist and are not going to
  // rewrite themselves.
  const MAX_REACTIONS = 3;
  const emojiOf = (reaction) =>
    (reaction && reaction.emojis) ||
    (reaction && reaction.emoji ? [reaction.emoji] : []);

  const myReactionList = (message) =>
    emojiOf(
      (message.reactions || []).find(
        (r) => state.device && String(r.device_id) === String(state.device.id)
      )
    );

  /* Turns the ciphertext the history hands back into emoji.
   *
   * Reactions were only ever decrypted in the live WebSocket handler, so one
   * that arrived while this device was away — or simply survived a reload —
   * came back as {device_id, ct, iv, salt}, was dropped by the renderer for
   * having no emoji, and was then written over the decrypted copy on disk. The
   * other person's reactions disappeared on refresh for that reason, quite
   * separately from the sender's own.
   */
  async function decryptReactions(row, existing) {
    const out = [];
    for (const reaction of row.reactions || []) {
      const id = String(reaction.device_id);
      // Already opened once — keep it rather than paying for it again, and
      // rather than losing it if the key has since gone.
      const known = ((existing && existing.reactions) || []).find(
        (r) => String(r.device_id) === id && emojiOf(r).length
      );
      if (known) {
        out.push(known);
        continue;
      }
      if (!reaction.ct) {
        if (emojiOf(reaction).length) out.push(reaction);
        continue;
      }
      const key = pairKeyFor(reaction.device_id);
      if (!key) continue;
      try {
        const body = await C.openMessage(key, reaction, {
          messageId: row.id + '#reaction',
          senderDeviceId: reaction.device_id,
          recipientDeviceId: state.device.id,
        });
        const emojis = emojiOf(body);
        if (emojis.length) out.push({ device_id: reaction.device_id, emojis });
      } catch (e) {
        /* sealed for a device since replaced */
      }
    }
    return out;
  }

  function mergeReactions(fromServer, existing) {
    const here = (r) => state.device && String(r.device_id) === String(state.device.id);
    const theirs = (fromServer || []).filter((r) => !here(r));
    const mine = (((existing && existing.reactions) || [])).filter(here);
    return [...theirs, ...mine];
  }

  async function tryOpen(row) {
    const key = pairKeyFor(row.sender_device_id);
    if (!key) {
      // The interesting case is a sender this device *does* otherwise know:
      // that is a key that went missing rather than one that never existed.
      log('open.no-key', {
        id: short(row.id),
        seq: row.seq,
        sender: String(row.sender_device_id),
        have: Object.keys(state.pairKeys),
        knownRecipient: state.recipients.some(
          (r) => String(r.id) === String(row.sender_device_id)
        ),
        keysRefreshing,
      });
      return null;
    }
    try {
      return await C.openMessage(key, row.envelope, {
        messageId: row.id,
        senderDeviceId: row.sender_device_id,
        recipientDeviceId: state.device.id,
      });
    } catch (e) {
      // A message sealed for a device that has since been replaced. Showing a
      // placeholder is honest; pretending it never existed is not.
      log('open.failed', {
        id: short(row.id),
        seq: row.seq,
        sender: String(row.sender_device_id),
        error: String((e && e.message) || e),
        keysRefreshing,
      });
      return { undecryptable: true };
    }
  }

  function applyProfileMessage(message) {
    if (!message.body || message.body.type !== 'profile') return;
    const profile = { handle: message.body.handle, emoji: message.body.emoji };
    state.profiles[message.senderDeviceId] = profile;
    DB.put(DB.STORES.profiles, profile, message.senderDeviceId);
    paintHeader();
  }

  /* ==================================================================== *
   * Rendering
   * ==================================================================== */

  const DAY = { weekday: 'short', day: 'numeric', month: 'short' };

  function dayLabel(iso) {
    const date = new Date(iso);
    const today = new Date();
    const yesterday = new Date(Date.now() - 86400000);
    if (date.toDateString() === today.toDateString()) return 'Today';
    if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
    return date.toLocaleDateString(undefined, DAY);
  }

  const clock = (iso) =>
    new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

  function peerProfile() {
    const recipient = peerRecipients()[0];
    return (
      (recipient && state.profiles[recipient.id]) || { handle: 'Reef', emoji: '🐟' }
    );
  }

  /* The server heartbeats a device into a cache entry that expires after 45s,
   * and reports the result as `last_seen` on every peer device in the session
   * payload. This client never read it, and that is the whole of the bug where
   * only one side ever showed as swimming.
   *
   * Presence was learned exclusively from live events, and an event only fires
   * when a device connects or disconnects. The peer who was *already* connected
   * announced nothing, so whoever loaded second saw them as "gone deep"
   * forever — while the one already sitting there received the newcomer's
   * announce and showed them as swimming. Refreshing swapped which side was
   * blind, which is exactly how it looked: only ever one of them online. */
  const PRESENCE_TTL = 45000;

  /* One expiry timer per peer device, reset by every beat that device sends.
   *
   * Presence has to be able to lapse on its own. A browser killed outright never
   * sends the disconnect that would clear it, so silence is the only evidence
   * there will ever be — and silence is not an event. This used to be covered by
   * re-asking the server every thirty seconds; now the server relays each ping
   * to the room, and running the clock locally against those beats costs nothing
   * and needs no timer of its own between them. */
  const presenceTimers = new Map();

  /* `beatAt` is when *this* client saw the beat. For a live event that is now,
   * which keeps the countdown immune to any clock difference between the two
   * ends. Only a seeded snapshot has to trust the server's own timestamp, having
   * nothing better to go on. */
  function markPeerLive(id, lastSeenIso, beatAt) {
    const remaining = PRESENCE_TTL - (Date.now() - beatAt);
    if (remaining <= 0) return dropPeerLive(id, lastSeenIso);
    clearTimeout(presenceTimers.get(id));
    // Nothing to count down against on a server that does not relay beats. See
    // expectHello: there, presence lives and dies by connect and disconnect
    // alone, exactly as it did before, and the poll covers the rest.
    if (state.serverBeats !== false) {
      presenceTimers.set(id, setTimeout(() => dropPeerLive(id, lastSeenIso), remaining));
    }
    if (!state.peerLive.includes(id)) state.peerLive = [...state.peerLive, id];
    state.peerOnline = true;
    paintHeader();
  }

  function dropPeerLive(id, lastSeenIso) {
    clearTimeout(presenceTimers.get(id));
    presenceTimers.delete(id);
    state.peerLive = state.peerLive.filter((live) => live !== id);
    state.peerOnline = state.peerLive.length > 0;
    // The last moment they were known to be there, which is the beat that just
    // ran out — not now, when all that happened is that nothing arrived.
    if (lastSeenIso && !state.peerOnline) state.lastSeen = lastSeenIso;
    paintHeader();
  }

  function seedPresence() {
    const peers = (state.session && state.session.peer_devices) || [];
    const fresh = peers.filter(
      (d) =>
        d.status === 'active' &&
        d.last_seen &&
        Date.now() - new Date(d.last_seen).getTime() < PRESENCE_TTL
    );
    const live = new Set(fresh.map((d) => String(d.id)));
    // A snapshot replaces what was known rather than adding to it: a device
    // absent from it has gone, and waiting for its own timer to notice would
    // leave it shown as swimming for up to another full window.
    state.peerLive.filter((id) => !live.has(id)).forEach((id) => dropPeerLive(id, null));
    fresh.forEach((d) =>
      markPeerLive(String(d.id), d.last_seen, new Date(d.last_seen).getTime())
    );
    if (!state.peerOnline) {
      const seen = peers
        .map((d) => d.last_seen)
        .filter(Boolean)
        .sort();
      if (seen.length) state.lastSeen = seen[seen.length - 1];
    }
    paintHeader();
  }

  /* The session, re-asked. No longer on a timer — the socket's opening frame
   * carries this, so the only caller left is the fallback that runs when no
   * socket can be established at all. */
  async function refreshPresence() {
    try {
      const result = await API.session();
      state.session = Object.assign({}, state.session, result.session);
      state.device = result.device || state.device;
      await rememberAutoApprove();
      seedPresence();
    } catch (e) {
      /* offline; the header already says so */
    }
  }

  function paintHeader() {
    const profile = peerProfile();
    $('peer-avatar').textContent = profile.emoji || '🐟';
    $('peer-name').textContent = profile.handle || 'Reef';
    const line = $('peer-state');
    if (state.peerTyping) {
      line.textContent = 'blowing bubbles…';
      line.className = 'live';
    } else if (state.peerOnline) {
      line.textContent = 'swimming';
      line.className = 'live';
    } else if (!state.online) {
      line.textContent = 'reconnecting…';
      line.className = '';
    } else {
      line.textContent = state.lastSeen
        ? 'gone deep · ' + clock(state.lastSeen)
        : 'gone deep';
      line.className = '';
    }
  }

  /* Nothing readable and nothing to show: no text, no attachment, not deleted.
   * A deleted message has its own honest line, so it is not this. */
  function unreadable(message) {
    if (message.deleted) return false;
    const body = message.body || {};
    if (body.undecryptable) return true;
    return !body.text && !(message.attachments || []).length;
  }

  /* Retries a run of messages that currently read as unreadable, by asking
   * the server for that seq range again. The envelope is never deleted
   * server-side, so this is a real second chance rather than theatre — it
   * is the only way back for a message whose one and only ingest landed
   * while a key was briefly missing, since the plaintext attempt is not
   * something this device kept a copy of to retry from.
   *
   * Keyed by the run's own seq range so the same broken stretch is not
   * re-requested on every render; a stretch that is genuinely gone (no
   * envelope ever existed for it) just fails the same way again once and
   * is then left alone for the rest of this session. */
  const healTried = new Set();
  async function healRun(run) {
    /* Kept per message rather than per range.
     *
     * The key used to be the run's own seq range, and the range changes every
     * time the window widens — so scrolling up re-requested the same broken
     * stretch on every render, two hundred rows at a time, and the dedupe
     * never once fired. Message ids do not move, so this asks for any given
     * message exactly once per session however the run around it grows.
     *
     * Messages the server holds no envelope for are dropped here too: there
     * is nothing to fetch a second time, and asking again cannot change that. */
    const fresh = run.filter(
      (m) => m.seq && !healTried.has(m.id) && !(m.body && m.body.noEnvelope)
    );
    if (!fresh.length) return;
    const first = fresh[0];
    const last = fresh[fresh.length - 1];
    const key = first.seq + ':' + last.seq;
    fresh.forEach((m) => healTried.add(m.id));
    log('heal.start', { range: key, rows: fresh.length, ofRun: run.length });
    let since = first.seq - 1;
    let fetchedAny = false;
    try {
      while (since < last.seq) {
        const page = await API.history({ since, page_size: 200 });
        const rows = page.results || [];
        if (!rows.length) break;
        fetchedAny = true;
        await ingest(rows, false);
        since = rows[rows.length - 1].seq;
      }
    } catch (e) {
      // Offline, or a blip — worth trying again later, so the attempt is
      // forgotten rather than counted against these messages for the session.
      fresh.forEach((m) => healTried.delete(m.id));
      log('heal.failed', { range: key, error: String((e && e.message) || e) });
      return;
    }
    // Whether the second chance took. Still-sealed after a re-fetch means the
    // envelope really is not readable here, rather than a page that landed
    // badly the first time.
    log('heal.done', {
      range: key,
      fetchedAny,
      stillSealed: fresh.filter((m) => unreadable(state.messages.get(m.id) || m)).length,
      of: fresh.length,
    });
    if (fetchedAny) renderList(true);
  }

  /* Same retry, swept across everything currently held rather than only what
   * is on screen — for a manual nudge, or a one-off pass over local history. */
  async function healUnreadable() {
    const rows = ordered();
    let i = 0;
    while (i < rows.length) {
      if (!unreadable(rows[i])) {
        i++;
        continue;
      }
      let last = i;
      while (last + 1 < rows.length && unreadable(rows[last + 1])) last++;
      await healRun(rows.slice(i, last + 1));
      i = last + 1;
    }
  }

  /* Housekeeping, not conversation: the profile announcement that carries a
   * handle and a fish travels as an ordinary encrypted message so the server
   * never learns either.
   *
   * It has no text and no attachment, which is exactly what `unreadable` looks
   * for — so every announcement drew "One earlier message cannot be opened on
   * this device" in the middle of the thread. Your own were guaranteed to: an
   * envelope is sealed per recipient and never for yourself, so the copy that
   * comes back from the server is one you genuinely hold no key for. Changing
   * your fish therefore always produced that line, on both sides. */
  const isSystem = (message) =>
    message.kind === 'system' ||
    !!(message.body && message.body.type === 'profile');

  /* The sorted thread, cached.
   *
   * Both of these ran on every render — a full sort of every message held, to
   * answer a scroll event or repaint one tick. Renders vastly outnumber changes
   * to the set, so the answer is kept until something actually changes it. */
  let orderCache = null;
  let chronoCache = null;

  function invalidateOrder() {
    orderCache = null;
    chronoCache = null;
  }

  const chronological = () => {
    if (!chronoCache) {
      chronoCache = [...state.messages.values()].sort(
        (a, b) => (a.seq || 1e15) - (b.seq || 1e15)
      );
    }
    return chronoCache;
  };

  const ordered = () => {
    if (!orderCache) {
      orderCache = chronological().filter((m) => !isSystem(m) && !m.hiddenForMe);
    }
    return orderCache;
  };

  /* ==================================================================== *
   * The rendered window
   * ==================================================================== *
   *
   * At most MAX_DRAWN rows are ever in the DOM. renderList rebuilds every
   * visible row from scratch, so an unbounded window meant a long scroll back
   * made every later repaint — a tick, a reaction — proportionally slower, and
   * it only ever grew within a session.
   *
   * Measured from the *end*, not as absolute indices: loading older messages
   * puts them at the front of the sorted array and shifts every index, whereas
   * "how many from the newest" survives that untouched.
   *
   *   end   = length - tail
   *   start = end - count
   *
   * The cap counts *rows drawn*, not messages held, and the difference is not
   * academic. A run of unreadable messages collapses to a single line however
   * long it is, so on a device that joined late — and therefore holds no
   * envelope for anything older than itself — two hundred messages can draw as
   * one line. Capping on message count and paying the excess out of `tail`
   * then slid the window's newest edge backwards over the handful of messages
   * that *were* readable, and the screen went blank but for that one line. The
   * DOM is the only thing the cap was ever protecting, so the DOM is what it
   * measures. The window's length stays bounded by the local store either way.
   */
  const MAX_DRAWN = 200;
  const PAGE_ROWS = 40;

  /* How many *messages* a window spans when it is positioned outright rather
   * than grown — jumping to a search hit, or back to the foot of the thread.
   * Distinct from MAX_DRAWN, which bounds what reaches the DOM; this bounds
   * what a single deliberate move takes in, and drawing it can only cost less. */
  const WINDOW_SPAN = 200;

  /* What a window costs to draw: one per readable message, one per unbroken
   * run of unreadable ones. Mirrors renderList's own loop, which is the only
   * definition of "a row" that matters here. */
  function drawCost(rows, start, end) {
    let cost = 0;
    for (let i = start; i < end; i++) {
      if (unreadable(rows[i])) {
        while (i + 1 < end && unreadable(rows[i + 1])) i++;
      }
      cost++;
    }
    return cost;
  }

  function viewBounds(rows) {
    /* `tail` can only be as far back as leaves a full window in front of it.
     *
     * Nothing enforced that. trimView turns any excess `count` into `tail`,
     * which is right while there is still thread at the front to reveal and
     * wrong once `start` has reached 0 — and scrolling up keeps widening either
     * way. So `tail` walked past the beginning: first the window rendered short
     * of its own count, then `end` reached zero and it rendered nothing at all,
     * over a thread that was completely intact the whole time.
     *
     * The blank screen had no way out of itself, which is why only a reload
     * cleared it. An empty list has nothing to scroll, so no scroll event
     * fires, so growNewer — the one thing that ever shrinks `tail` — is never
     * called.
     *
     * Clamped here rather than at the overshoot because this is the single
     * place every render passes through, whatever route it took. Written back,
     * so growNewer counts down from a real number rather than spending its
     * first several pages working off an excess the reader never asked for. */
    const room = Math.max(0, rows.length - state.view.count);
    if (state.view.tail > room) {
      // Reached only when something overshot `tail`, which is the old route to
      // a window that had walked off the front of the thread. Logged rather
      // than silently corrected so an overshoot still leaves a trace.
      logBad('view.tail-clamped', {
        tail: state.view.tail,
        room,
        count: state.view.count,
        thread: rows.length,
      });
      state.view.tail = room;
    }
    const end = Math.max(0, rows.length - state.view.tail);
    return { start: Math.max(0, end - state.view.count), end };
  }

  /* What the window and the store look like at this instant, for the log and
   * for `reef.now()`. Cheap enough to call on every render. */
  function viewReport(why) {
    const rows = ordered();
    const chrono = chronological();
    const { start, end } = viewBounds(rows);
    const report = {
      why,
      thread: rows.length,
      held: state.messages.size,
      window: `${start}..${end}`,
      count: state.view.count,
      tail: state.view.tail,
      sealedInWindow: rows.slice(start, end).filter(unreadable).length,
      sealedInThread: rows.filter(unreadable).length,
      // What the window costs the DOM, which is the number the cap is on.
      drawn: drawCost(rows, start, end),
      reachedOldest,
      stickBottom: state.stickBottom,
      keys: Object.keys(state.pairKeys).length,
      keysRefreshing,
      online: state.online,
      seqs: chrono.length
        ? `${(chrono[0] || {}).seq}..${(chrono[chrono.length - 1] || {}).seq}`
        : null,
    };
    if (why === 'asked') console.log('[reef] now', report);
    return report;
  }

  /* Holds the window at its cap by dropping from the newest end, which keeps
   * `start` exactly where widening put it.
   *
   * Walks forward from `start` totting up drawn rows and stops at the budget,
   * so the cost is one pass however far back the window reaches. A window that
   * draws as a handful of lines is left entirely alone — which is the whole
   * point, and the reason the readable tail no longer falls off the bottom. */
  function trimView() {
    const rows = ordered();
    const end = Math.max(0, rows.length - state.view.tail);
    const start = Math.max(0, end - state.view.count);

    let cost = 0;
    let cut = start;
    while (cut < end && cost < MAX_DRAWN) {
      if (unreadable(rows[cut])) {
        while (cut + 1 < end && unreadable(rows[cut + 1])) cut++;
      }
      cost++;
      cut++;
    }
    if (cut >= end) return;

    state.view.tail += end - cut;
    state.view.count = Math.max(0, cut - start);
  }

  // See the end of renderList: what the sealed runs looked like last time, so
  // an unchanged one is not logged again.
  let lastSealedSig = null;

  function renderList(keepAnchor) {
    const scroller = $('scroller');
    const list = $('list');

    // Every row here is about to be rebuilt, the selected bubble included, so
    // anything mid-pick is already over — the flag has to go with it or row
    // gestures stay switched off over a selection that is no longer on screen.
    if (state.picking) endTextPick();

    /* Which message is at the top edge, and exactly where.
     *
     * The old compensation was `scrollTop += scrollHeight - before`, which works
     * only while content is added *above*. A capped window also drops rows from
     * the other end, and then the height delta is the sum of both changes and
     * says nothing useful. Putting a known row back where it was is exact
     * either way. */
    let anchorId = null;
    let anchorTop = 0;
    if (keepAnchor) {
      const edge = scroller.getBoundingClientRect().top;
      const held = [...list.children].find(
        (node) => node.dataset && node.dataset.id &&
                  node.getBoundingClientRect().bottom > edge
      );
      if (held) {
        anchorId = held.dataset.id;
        anchorTop = held.getBoundingClientRect().top;
      }
    }

    list.innerHTML = '';

    const rows = ordered();
    const { start, end } = viewBounds(rows);
    const visible = rows.slice(start, end);

    // Counted through the loop below so the log describes what was actually
    // put on screen, not what was intended.
    let sealedRuns = 0;
    let sealedRows = 0;
    let realRows = 0;

    let lastDay = null;
    for (let index = 0; index < visible.length; index++) {
      const message = visible[index];

      // A device only ever holds envelopes addressed to it, so a replacement
      // starts with a whole history it cannot open. Fifty identical "can't open
      // it" bubbles say the same thing fifty times and bury anything readable,
      // so a run becomes one line. Kept out of the day-divider logic below,
      // because the run can span days and a divider per day would defeat it.
      if (unreadable(message)) {
        let last = index;
        while (last + 1 < visible.length && unreadable(visible[last + 1])) last++;
        const count = last - index + 1;
        const sealed = el(
          'div',
          'sealed',
          count === 1
            ? 'One earlier message cannot be opened on this device'
            : `${count} earlier messages cannot be opened on this device`
        );
        /* Anchorable, like any other row. This line stands in for a whole run,
         * and without an id the scroll compensation below could not hold on to
         * it — which mattered most in the one case where it was the *only*
         * thing on screen. A window landing entirely inside an unopenable
         * stretch collapses to this single line, the anchor search then found
         * nothing, scrollTop was left pinned near the top, and every further
         * scroll event grew the window again without ever moving the view. The
         * window walked off the front of the thread from one flick.
         *
         * Keyed to the run's *last* message, not its first. Runs grow upwards
         * — scrolling back reveals older messages, which join the front of the
         * same run — so the first message changes on every widening and the id
         * changed with it. The anchor search then looked for a row that no
         * longer existed under that name, scrollTop stayed pinned at 0, and
         * the next scroll event widened the window again: the runaway above,
         * driven by the one line that was supposed to survive it. The last
         * message of a run does not move. */
        sealed.dataset.id = visible[last].id;
        list.appendChild(sealed);
        // The server keeps every envelope forever, so a run that reads as
        // broken is not necessarily gone for good — it may just be the one
        // history page that got ingested while a key was briefly missing
        // (refreshKeys mid-flight, a device swap). Recent pages get re-synced
        // constantly and shrug that off on their own; a page loaded once by
        // scrolling here never comes through again on its own. Scrolling to
        // it is the only signal this range still matters, so that is the
        // trigger to ask the server for it again.
        sealedRuns++;
        sealedRows += count;
        healRun(visible.slice(index, last + 1));
        index = last;
        lastDay = null; // the next real message re-states its day
        continue;
      }

      const day = dayLabel(message.createdAt);
      if (day !== lastDay) {
        list.appendChild(el('div', 'day', day));
        lastDay = day;
      }
      const next = visible[index + 1];
      const previous = visible[index - 1];
      // Consecutive messages from the same sender inside three minutes read as
      // one utterance, so they collapse: tight gaps, one tail.
      const grouped =
        previous &&
        previous.mine === message.mine &&
        new Date(message.createdAt) - new Date(previous.createdAt) < 180000;
      const tail =
        !next ||
        next.mine !== message.mine ||
        new Date(next.createdAt) - new Date(message.createdAt) >= 180000;
      realRows++;
      list.appendChild(renderRow(message, { grouped, tail }));
    }

    /* The reported bug, stated as a condition: the window holds messages, and
     * every one of them drew as a sealed line. That is the screen where the
     * thread "disappears" and is replaced by a single count, so it is logged
     * loudly and with everything needed to tell which of the two ways it got
     * there — a window that slid onto an unopenable stretch of real history,
     * or a stretch that was readable until this session made it unopenable. */
    /* Only when the shape of it changes. A sealed run that is simply sitting
     * there gets redrawn by every tick and every reaction, and logging each of
     * those would push the lines that explain how it got there out of the far
     * end of the ring — which are the only ones worth having. */
    const sealedSig = sealedRuns
      ? `${sealedRuns}/${sealedRows}/${realRows}/${start}..${end}`
      : null;
    if (sealedSig && sealedSig !== lastSealedSig) {
      if (!realRows) {
        logBad('render.all-sealed', {
          report: viewReport('all-sealed'),
          sealedRows,
          sealedRuns,
          anchorId: short(anchorId),
          // Which stretch of history the window had landed on when it collapsed.
          seqs: `${(visible[0] || {}).seq}..${(visible[visible.length - 1] || {}).seq}`,
        });
      } else {
        log('render.sealed-run', { sealedRuns, sealedRows, realRows, window: `${start}..${end}` });
      }
    }
    lastSealedSig = sealedSig;

    if (anchorId) {
      // Without this the thread jerks as you scroll up: content grows above the
      // viewport and the browser keeps the same scrollTop.
      const back = list.querySelector(`[data-id="${CSS.escape(anchorId)}"]`);
      if (back) {
        scroller.scrollTop += back.getBoundingClientRect().top - anchorTop;
      } else {
        // The row the view was held by is no longer rendered, so scrollTop is
        // left wherever it was — near the top, which fires another scroll
        // event, which widens the window again. This is the runaway.
        logBad('render.anchor-lost', {
          anchorId: short(anchorId),
          window: `${start}..${end}`,
          scrollTop: Math.round(scroller.scrollTop),
        });
      }
    } else if (state.stickBottom) {
      scrollToBottom(false);
    }
    observeUnread();
  }

  function renderRow(message, shape) {
    const row = el('div', 'row' + (message.mine ? ' mine' : '') +
      (shape.tail ? ' tail' : '') + (shape.grouped ? '' : ' gap'));
    row.dataset.id = message.id;
    // Kept so refreshRow can rebuild this one row without recomputing how it
    // groups against its neighbours.
    row._shape = shape;

    const bubble = el('div', 'bubble');
    const body = message.body || {};

    if (message.replyTo) {
      const target = state.messages.get(message.replyTo);
      const quote = el('button', 'quote');
      quote.type = 'button';
      quote.textContent = target && target.body ? preview(target) : 'a message';
      // The quote said what was replied to and then would not take you there,
      // which is the one thing anybody taps it for.
      quote.addEventListener('click', (event) => {
        event.stopPropagation();
        goToMessage(message.replyTo);
      });
      bubble.appendChild(quote);
    }

    if (message.deleted) {
      bubble.classList.add('gone');
      bubble.appendChild(el('div', 'txt', 'This ripple was taken back'));
    } else if (body.undecryptable) {
      bubble.classList.add('gone');
      bubble.appendChild(el('div', 'txt', 'Sent to an older device — can’t open it'));
    } else {
      (message.attachments || []).forEach((attachment) => {
        const file = (body.files || []).find((f) => f.id === attachment.id);
        bubble.appendChild(renderMedia(attachment, file, message));
      });
      if (body.text) {
        const emojiOnly = /^(\p{Extended_Pictographic}|️|‍|\s){1,8}$/u.test(
          body.text
        );
        if (emojiOnly && !message.attachments.length) bubble.classList.add('jumbo');
        bubble.appendChild(el('div', 'txt', body.text));
      }
    }

    const meta = el('div', 'meta');
    if (message.editedAt) meta.appendChild(el('span', null, 'edited'));
    meta.appendChild(el('span', null, clock(message.createdAt)));
    if (message.mine) meta.appendChild(renderTick(message));
    bubble.appendChild(meta);

    if (message.reactions && message.reactions.length) {
      // A pill each, hung off the bottom edge of the bubble rather than placed
      // inside it — in the flow they took a line of their own and grew the
      // bubble, so reacting visibly resized the message. One boundary per
      // reactor, because a single pill around both said two people had reacted
      // and nothing about which was which.
      const reacts = el('div', 'reacts');
      message.reactions.forEach((reaction) => {
        const emojis = emojiOf(reaction);
        if (!emojis.length) return;
        // One pill per person holding all of theirs, so three emoji from one
        // person read as one person rather than as three.
        const own = isOwnDevice(reaction.device_id);
        reacts.appendChild(
          el('span', 'react' + (own ? ' own' : ''), emojis.join(' '))
        );
      });
      if (reacts.children.length) {
        reacts.title = 'Who reacted';
        reacts.addEventListener('click', (event) => {
          event.stopPropagation();
          openInfoSheet(message);
        });
        bubble.appendChild(reacts);
        // The pill overhangs the bubble, so the row has to leave room for it or
        // it lands on top of the next message.
        row.classList.add('reacted');
      }
    }

    if (message.state === 'failed') {
      bubble.addEventListener('click', () => retrySend(message));
    }
    attachGestures(row, bubble, message);
    if (state.selecting) {
      // DOM order, not CSS, puts this on the outer edge either way: a
      // .mine row is justify-content:flex-end, so a box appended *after*
      // the bubble packs to its right — the wall side. A peer row is
      // flex-start, so a box inserted *before* packs to its left — the
      // same wall side from the other end. Getting this from layout order
      // means it never has to know which side is "outer" itself.
      const box = el('span', 'checkbox');
      if (state.selection.has(message.id)) box.classList.add('checked');
      if (message.mine) {
        row.appendChild(bubble);
        row.appendChild(box);
      } else {
        row.appendChild(box);
        row.appendChild(bubble);
      }
    } else {
      row.appendChild(bubble);
    }
    return row;
  }

  /* One row, in place.
   *
   * A tick or a reaction changes one bubble, but the only tool for it was
   * renderList — which empties #list and rebuilds every visible row, each with
   * fresh gesture listeners and observers. Two people reading each other's
   * messages generate a stream of these, and the whole thread was thrown away
   * and rebuilt on each one. Grouping cannot change here, so the stored shape
   * is reused; anything that moves a message still goes through renderList. */
  function refreshRow(message) {
    const rows = $('list').children;
    for (let i = 0; i < rows.length; i++) {
      // A collapsed run carries the id of its first message so the scroll
      // anchor can hold on to it, but it stands for many messages and is not a
      // row. Swapping it for a single bubble would drop the rest of the run off
      // the screen, so leave it to the full render below, which is the only
      // thing that can work out what the run should now look like.
      if (rows[i].classList.contains('sealed')) continue;
      if (rows[i].dataset && rows[i].dataset.id === message.id) {
        rows[i].replaceWith(
          renderRow(message, rows[i]._shape || { grouped: false, tail: true })
        );
        return;
      }
    }
    // Not on screen — outside the window, or the day divider moved. Fall back.
    renderList();
  }

  function renderTick(message) {
    const tick = el('span', 'tick');
    if (message.state === 'pending') {
      tick.textContent = '🕗';
    } else if (message.state === 'failed') {
      // Loud on purpose. A quiet failure looks identical to a delivered
      // message, and the sender walks away believing it arrived.
      tick.textContent = '⚠ not sent — tap to retry';
      tick.style.cssText = 'color:var(--danger);font-weight:600;letter-spacing:0';
    } else {
      // Only the other person's receipts are an answer to "have they seen it".
      // A revoked peer device is not in `recipients` any more but its receipt
      // still counts, which is why this asks whether the device is *ours*
      // rather than whether it is a current peer.
      const theirs = (message.receipts || []).filter(
        (r) => !isOwnDevice(r.device_id)
      );
      const read = theirs.some((r) => r.read_at);
      const delivered = theirs.some((r) => r.delivered_at);
      tick.textContent = delivered || read ? '✓✓' : '✓';
      if (read) tick.classList.add('read');
    }
    return tick;
  }

  function preview(message) {
    const body = message.body || {};
    if (body.text) return body.text.slice(0, 90);
    const files = body.files || [];
    if (files.length) {
      // Name it. "📎 attachment" told you nothing about which one you were
      // replying to.
      const first = files[0];
      const mime = String(first.mime || '');
      const icon = mime.startsWith('image/')
        ? '📷'
        : mime.startsWith('video/')
          ? '🎬'
          : fileIcon(mime);
      const label = mime.startsWith('image/') ? 'Photo' : first.name || 'file';
      return files.length > 1 ? `${icon} ${label} +${files.length - 1}` : `${icon} ${label}`;
    }
    if (message.attachments && message.attachments.length) return '📎 attachment';
    return 'a message';
  }

  const FILE_ICONS = [
    [/pdf/, '📕'],
    [/zip|rar|7z|tar|gzip/, '🗜'],
    [/sheet|excel|csv/, '📊'],
    [/word|document|rtf$/, '📝'],
    [/presentation|powerpoint/, '📈'],
    [/^audio\//, '🎵'],
    [/^text\//, '📄'],
    [/json|xml|javascript|x-sh|x-python/, '⌨️'],
  ];
  const fileIcon = (mime) => {
    const found = FILE_ICONS.find(([pattern]) => pattern.test(mime || ''));
    return found ? found[1] : '📎';
  };

  /* Anything that is not a picture or a video. Rendering these through an <img>
   * decrypted the blob perfectly and then showed a broken image, so they get a
   * row that says what they are and hands the file over on tap. */
  function renderFile(attachment, file) {
    const node = el('button', 'file');
    node.type = 'button';
    node.appendChild(el('span', 'ico', fileIcon(file.mime)));
    const stack = el('div', 'grow');
    stack.appendChild(el('b', null, file.name || 'file'));
    const detail = [fileSize(file.size), (file.mime || '').split('/').pop()]
      .filter(Boolean)
      .join(' · ');
    stack.appendChild(el('span', null, detail || 'file'));
    node.appendChild(stack);
    node.appendChild(el('span', 'ico', '⬇'));

    node.addEventListener('click', async (event) => {
      event.stopPropagation();
      node.disabled = true;
      try {
        // Decrypted here and handed to the browser as a download — the bytes
        // never exist in the clear anywhere else.
        const url = await mediaUrl(attachment, file, true);
        const link = el('a');
        link.href = url;
        link.download = file.name || 'file';
        document.body.appendChild(link);
        link.click();
        link.remove();
      } catch (e) {
        toast('Could not open that file');
      } finally {
        node.disabled = false;
      }
    });
    return node;
  }

  function renderMedia(attachment, file, message) {
    // Video used to be forced through an <img>, which decrypted the blob
    // perfectly and then displayed nothing at all.
    const mime = String((file && file.mime) || '');
    const isVideo = mime.startsWith('video/');
    // Only pictures and video belong in an <img>/<video>. Everything else — a
    // PDF, a spreadsheet, an archive — used to be forced through one and drew a
    // broken image.
    if (file && !isVideo && !mime.startsWith('image/')) {
      return renderFile(attachment, file);
    }
    const node = el(isVideo ? 'video' : 'img', 'media pending');
    if (isVideo) {
      node.controls = true;
      node.playsInline = true;
      node.preload = 'metadata';
      // A video has no usable thumbnail here, so it decrypts in full.
      node._full = true;
    } else {
      node.alt = '';
      node.loading = 'lazy';
      // Decrypted perfectly and still unrenderable: HEIC is the usual reason, and
      // an iPhone hands that over whenever a photo comes from Files rather than
      // the camera roll. A row that hands the file over beats a broken image, and
      // this catches every other cause of one for free.
      node.addEventListener('error', () => {
        if (node._swapped || !node.src) return;
        node._swapped = true;
        node.replaceWith(renderFile(attachment, file));
      });
    }
    if (file && file.w && file.h) {
      // The attributes reserve the right space before the blob decrypts; the
      // explicit ratio holds the shape even while the box is still empty. Both
      // rely on `height:auto` in the stylesheet — without it the height
      // attribute pins the box and the picture stretches.
      node.width = file.w;
      node.height = file.h;
      node.style.aspectRatio = `${file.w} / ${file.h}`;
    } else {
      // No dimensions to work from, so reserve a little room and let the image
      // settle once it loads.
      node.classList.add('sizeless');
    }
    if (file) {
      // Decrypt only once it is close to the viewport — a long scroll should
      // not chew through every blob in the history.
      mediaObserver.observe(node);
      node._file = file;
      node._attachment = attachment;
      node._message = message;
    }
    if (!isVideo) {
      // The attachment, not node.src. Handing over the src meant handing over
      // the *thumbnail* — 320px upscaled to fill the screen.
      node.addEventListener('click', () => openViewer(attachment, file));
    }
    return node;
  }

  const mediaObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach(async (entry) => {
        if (!entry.isIntersecting) return;
        mediaObserver.unobserve(entry.target);
        await paintMedia(entry.target);
      });
    },
    { rootMargin: '400px' }
  );

  /* Decrypts one attachment and hands back a URL for it.
   *
   * Thumbnail and full size are cached under separate keys. They used to share
   * `attachment.id`, so whichever loaded first answered for both — which is
   * also why opening a picture could never show more detail than the thumbnail
   * already on screen.
   *
   * The cache holds Blobs, not object URLs. A `blob:` URL belongs to the
   * document that made it and is dead the moment the page reloads, so the old
   * cache handed back strings that pointed at nothing and the image simply
   * never appeared. Anything not a Blob is treated as a miss, which quietly
   * retires those entries. */
  async function mediaUrl(attachment, file, wantFull) {
    const useThumb = !wantFull && !!attachment.has_thumb;
    const cacheKey = attachment.id + (useThumb ? ':thumb' : ':full');
    let blob = await DB.get(DB.STORES.media, cacheKey);
    if (!(blob instanceof Blob)) {
      const bytes = await API.fetchBlob(attachment.id, useThumb);
      const plain = await C.openBlob(
        new Uint8Array(bytes),
        useThumb ? file.thumbKey : file.key,
        useThumb ? file.thumbIv : file.iv
      );
      blob = new Blob([plain], { type: file.mime || 'image/jpeg' });
      await DB.put(DB.STORES.media, blob, cacheKey);
    }
    return URL.createObjectURL(blob);
  }

  async function paintMedia(node) {
    const file = node._file;
    const attachment = node._attachment;
    if (!file || !attachment) return;
    try {
      node.src = await mediaUrl(attachment, file, !!node._full);
      node.classList.remove('pending');
    } catch (e) {
      /* offline, or sealed for a key this device does not have */
    }
  }

  /* Movement only. Nothing here counts as "the reader has caught up". */
  function pinToBottom(smooth) {
    const scroller = $('scroller');
    scroller.scrollTo({
      top: scroller.scrollHeight,
      behavior: smooth ? 'smooth' : 'auto',
    });
  }

  function scrollToBottom(smooth) {
    // Scrolled far enough back that the newest messages are no longer rendered:
    // pinning to the foot of the DOM would stop at whatever the window ends on.
    if (state.view.tail) {
      state.view.tail = 0;
      state.view.count = Math.min(WINDOW_SPAN, Math.max(60, state.view.count));
      renderList();
    }
    pinToBottom(smooth);
    state.unseen = 0;
    paintPill();
  }

  function paintPill() {
    const host = $('new-pill-host');
    host.innerHTML = '';
    if (state.unseen > 0 && !state.stickBottom) {
      const pill = el(
        'button',
        'pill',
        `${state.unseen} new ripple${state.unseen > 1 ? 's' : ''} ↓`
      );
      pill.addEventListener('click', () => scrollToBottom(true));
      host.appendChild(pill);
    }
  }

  /* ==================================================================== *
   * Read receipts
   * ==================================================================== */

  let pendingReads = new Set();
  let readTimer = null;

  const readObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const message = state.messages.get(entry.target.dataset.id);
        if (message && !message.mine && !message.readSent) {
          message.readSent = true;
          pendingReads.add(message.id);
          scheduleReadFlush();
        }
        readObserver.unobserve(entry.target);
      });
    },
    { threshold: 0.6 }
  );

  function observeUnread() {
    document.querySelectorAll('#list .row:not(.mine)').forEach((row) => {
      const message = state.messages.get(row.dataset.id);
      if (message && !message.readSent) readObserver.observe(row);
    });
  }

  function scheduleReadFlush() {
    clearTimeout(readTimer);
    readTimer = setTimeout(async () => {
      const ids = [...pendingReads];
      pendingReads = new Set();
      if (!ids.length) return;
      try {
        await API.receipts(ids, 'read');
      } catch (e) {
        ids.forEach((id) => pendingReads.add(id));
      }
    }, 500);
  }

  function markVisibleRead() {
    if (document.visibilityState === 'visible') observeUnread();
  }

  /* ==================================================================== *
   * Composing
   * ==================================================================== */

  // #text is contenteditable, not a <textarea> — .value doesn't exist. Read
  // through .innerText, not .textContent: textContent ignores <br> entirely
  // (line breaks vanish), while innerText is the layout-aware rendering that
  // turns them back into '\n', matching what a textarea's .value gave us.
  const textOf = (box) => box.innerText;
  const setTextOf = (box, text) => {
    box.innerText = text;
  };

  function autogrow() {
    const box = $('text');
    // Growth up to max-height is plain CSS now (see index.html) — a
    // contenteditable div's intrinsic height already tracks its content,
    // unlike a textarea's, so there is nothing left to measure here.
    const hasContent = textOf(box).trim() || pendingFiles.length;
    // With nobody active on the other side there is no envelope to address, so
    // the send would be rejected by the server. It used to render optimistically
    // and then fail quietly, which reads exactly like a message that went
    // through — the worst possible way to lose one.
    $('send').disabled = !hasContent || !state.recipients.length;
  }

  function paintPeerMissing() {
    const strip = $('peer-missing');
    // Your own second device is not somebody to talk to.
    const missing = !peerRecipients().length;
    strip.style.display = missing ? 'flex' : 'none';
    if (missing) {
      // Saying only "nothing can be sent" left nothing to do about it. When a
      // conversation with somebody in it is one tap away, say so — this is the
      // exact state a leftover half-empty room produces.
      const elsewhere = Object.keys(state.sessions).length > 1;
      $('peer-missing-text').textContent = elsewhere
        ? 'Nobody is in this conversation. You have another one — tap to switch.'
        : 'The other side has no approved device yet — nothing can be sent.';
      strip.style.cursor = elsewhere ? 'pointer' : '';
      strip.onclick = elsewhere ? openRoomSheet : null;
    }
    $('text').dataset.placeholder = missing
      ? 'Nobody to talk to yet'
      : 'Say something…';
    autogrow();
  }

  let typingSent = 0;
  function onTyping() {
    autogrow();
    saveDraft();
    if (!state.stream) return;
    // Clearing the box says so. Only `true` was ever sent, so the other side
    // sat on "blowing bubbles…" until its own four-second timeout expired.
    if (!textOf($('text')).trim()) return stopTyping();
    const now = Date.now();
    if (now - typingSent > 2000) {
      typingSent = now;
      state.stream.send({ type: 'typing', is_typing: true });
    }
  }

  function stopTyping() {
    if (!typingSent) return;
    typingSent = 0;
    if (state.stream) state.stream.send({ type: 'typing', is_typing: false });
  }

  let draftTimer;
  function saveDraft() {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(
      () => DB.put(DB.STORES.settings, textOf($('text')), 'draft'),
      300
    );
  }

  async function sealFor(body, messageId) {
    const envelopes = [];
    for (const recipient of state.recipients) {
      const key = pairKeyFor(recipient.id);
      if (!key) continue;
      const sealed = await C.sealMessage(key, body, {
        messageId,
        senderDeviceId: state.device.id,
        recipientDeviceId: recipient.id,
      });
      envelopes.push({ device_id: recipient.id, ...sealed });
    }
    return envelopes;
  }

  let pendingFiles = [];

  async function onSend() {
    const box = $('text');
    const text = textOf(box).trim();
    if (!text && !pendingFiles.length) return;

    if (state.editing) return commitEdit(text);

    const id = uuid();
    const body = { v: 1, type: pendingFiles.length ? 'media' : 'text', text };
    const files = pendingFiles;
    clearStaged();
    setTextOf(box, '');
    autogrow();
    stopTyping();
    DB.del(DB.STORES.settings, 'draft');
    const replyTo = state.replyTo;
    clearReply();

    const optimistic = {
      id,
      seq: null,
      kind: files.length ? 'media' : 'text',
      mine: true,
      senderDeviceId: state.device.id,
      replyTo: replyTo ? replyTo.id : null,
      createdAt: new Date().toISOString(),
      body,
      attachments: [],
      reactions: [],
      receipts: [],
      state: 'pending',
    };
    // On screen before the network is even consulted. The composer never waits
    // for a round trip.
    state.messages.set(id, optimistic);
    invalidateOrder();
    state.stickBottom = true;
    renderList();
    scrollToBottom(true);
    buzz(10);

    await DB.putMessages([optimistic]);
    await queueOutbox({ id, body, files, replyTo: optimistic.replyTo });
    flushOutbox();
  }

  async function queueOutbox(job) {
    // flushOutbox sorts on this. It was never written, so a batch composed
    // offline went out in whatever order IndexedDB happened to return the
    // uuid keys in.
    await DB.put(DB.STORES.outbox, Object.assign({ queuedAt: Date.now() }, job));
  }

  let flushing = false;
  async function flushOutbox() {
    if (flushing || !state.device || state.device.status !== 'active') return;
    flushing = true;
    try {
      const jobs = await DB.all(DB.STORES.outbox);
      for (const job of jobs.sort((a, b) => (a.queuedAt || 0) - (b.queuedAt || 0))) {
        if (job.blocked) continue; // failed before; waits for an explicit retry
        try {
          await deliver(job);
          await DB.del(DB.STORES.outbox, job.id);
        } catch (err) {
          if (err.offline) break; // still offline; keep the rest queued
          // Kept rather than dropped, so a retry still has the attachment
          // bytes. Deleting it here meant a failed photo could never be sent
          // again — the file had already been read and thrown away.
          job.blocked = true;
          await DB.put(DB.STORES.outbox, job);
          const message = state.messages.get(job.id);
          if (message) {
            message.state = 'failed';
            await DB.putMessages([message]);
            refreshRow(message);
          }
        }
      }
    } finally {
      flushing = false;
    }
  }

  async function retrySend(message) {
    const job = await DB.get(DB.STORES.outbox, message.id);
    if (!job) return toast('That one cannot be resent');
    if (!state.recipients.length) return toast('Nobody to send it to yet');
    job.blocked = false;
    await DB.put(DB.STORES.outbox, job);
    message.state = 'pending';
    refreshRow(message);
    flushOutbox();
  }

  async function deliver(job) {
    const body = Object.assign({}, job.body);
    const attachmentIds = [];

    for (const file of job.files || []) {
      const uploaded = await uploadFile(file);
      attachmentIds.push(uploaded.id);
      body.files = body.files || [];
      body.files.push(uploaded.descriptor);
    }

    const envelopes = await sealFor(body, job.id);
    const result = await API.send({
      id: job.id,
      kind: body.type === 'media' ? 'media' : body.type === 'voice' ? 'voice' : 'text',
      reply_to: job.replyTo || null,
      envelopes,
      attachment_ids: attachmentIds,
    });

    const message = state.messages.get(job.id);
    if (message) {
      // A real seq moves it in the sorted order, so the cache is stale.
      message.seq = result.seq;
      invalidateOrder();
      message.state = 'sent';
      message.body = body;
      message.attachments = result.attachments || [];
      await DB.putMessages([message]);
      renderList();
    }
  }

  async function uploadFile(file) {
    const sealed = await C.sealBlob(file.bytes);
    let thumbSealed = null;
    if (file.thumbBytes) thumbSealed = await C.sealBlob(file.thumbBytes);
    const uploaded = await API.uploadBlob(
      sealed.ciphertext,
      thumbSealed ? thumbSealed.ciphertext : null
    );
    return {
      id: uploaded.id,
      descriptor: {
        id: uploaded.id,
        key: sealed.key,
        iv: sealed.iv,
        thumbKey: thumbSealed ? thumbSealed.key : null,
        thumbIv: thumbSealed ? thumbSealed.iv : null,
        mime: file.mime,
        name: file.name,
        w: file.w,
        h: file.h,
        size: file.size,
      },
    };
  }

  /* ==================================================================== *
   * Media capture
   * ==================================================================== */

  // Mirrors MAX_ATTACHMENT_BYTES on the server, less a little room: encryption
  // adds an authentication tag, so the ciphertext is a touch larger than what
  // goes in. Catching it here gives a sentence naming the file instead of a 413
  // after a long upload.
  const MAX_ATTACHMENT = 25 * 1024 * 1024 - 8192;

  const fileSize = (bytes) => {
    if (!bytes) return '';
    const units = ['B', 'KB', 'MB', 'GB'];
    let n = bytes;
    let unit = 0;
    while (n >= 1024 && unit < units.length - 1) {
      n /= 1024;
      unit++;
    }
    return `${n < 10 && unit > 0 ? n.toFixed(1) : Math.round(n)} ${units[unit]}`;
  };

  /* What is attached but not yet sent.
   *
   * Attaching used to produce a toast and then nothing, so there was no way to
   * tell whether a file had actually been picked, which one, or how to change
   * your mind short of sending and deleting.
   *
   * The thumbnail is the one already made for the upload, so previewing costs
   * nothing extra. Object URLs are cached on the staged entry and revoked when it
   * goes, since a picture picked and dropped ten times should not leak ten of
   * them. */
  function paintStaged() {
    const strip = $('staged');
    strip.innerHTML = '';
    strip.classList.toggle('on', pendingFiles.length > 0);

    pendingFiles.forEach((file, index) => {
      const chip = el('div', 'stage');

      const isImage = String(file.mime || '').startsWith('image/');
      if (isImage) {
        if (!file.previewUrl) {
          const bytes = file.thumbBytes || file.bytes;
          file.previewUrl = URL.createObjectURL(new Blob([bytes], { type: file.mime }));
        }
        const shot = el('img');
        shot.src = file.previewUrl;
        shot.alt = '';
        chip.appendChild(shot);
      } else {
        chip.appendChild(el('span', 'ico', fileIcon(file.mime)));
      }

      const stack = el('div', 'grow');
      stack.appendChild(el('b', null, file.name || 'file'));
      stack.appendChild(el('span', null, fileSize(file.size || file.bytes.length)));
      chip.appendChild(stack);

      const drop = el('button', 'drop', '✕');
      drop.type = 'button';
      drop.setAttribute('aria-label', `Remove ${file.name || 'attachment'}`);
      drop.addEventListener('click', () => {
        const [removed] = pendingFiles.splice(index, 1);
        if (removed && removed.previewUrl) URL.revokeObjectURL(removed.previewUrl);
        paintStaged();
        autogrow();
      });
      chip.appendChild(drop);

      strip.appendChild(chip);
    });
  }

  /* Called once the files have gone, or been abandoned. */
  function clearStaged() {
    pendingFiles.forEach((file) => {
      if (file.previewUrl) URL.revokeObjectURL(file.previewUrl);
    });
    pendingFiles = [];
    paintStaged();
  }

  async function onFiles(fileList) {
    for (const file of [...fileList]) {
      // Checked on the original: an image is re-encoded smaller below, so
      // judging it before that would refuse photos the server would have taken.
      if (!file.type.startsWith('image/') && file.size > MAX_ATTACHMENT) {
        toast(`${file.name} is too big — ${fileSize(file.size)}, limit is 25 MB`);
        continue;
      }
      try {
        const prepared = await prepareAttachment(file);
        if (prepared.bytes.length > MAX_ATTACHMENT) {
          toast(`${file.name} is too big even after resizing`);
          continue;
        }
        pendingFiles.push(prepared);
      } catch (e) {
        toast(`Could not read ${file.name || 'that file'}`);
      }
    }
    // The strip says what is attached, so a toast counting them is redundant.
    paintStaged();
    autogrow();
  }

  async function asIs(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    return {
      bytes,
      mime: file.type || 'application/octet-stream',
      name: file.name || 'file',
      size: file.size,
    };
  }

  async function prepareAttachment(file) {
    // Anything that is not an image travels as-is: no canvas, no thumbnail, and
    // its real name and type kept so the other side can save it as itself.
    if (!file.type.startsWith('image/')) return asIs(file);

    // An image the browser cannot decode still deserves to be sent. iPhones hand
    // over HEIC when a photo comes from Files rather than the camera roll, and
    // createImageBitmap refuses it on some versions of Safari — which used to
    // drop the file entirely and leave only a toast behind. Sending the original
    // bytes loses the resize and the EXIF strip, so it is second choice, not
    // first.
    try {
      return await resizedImage(file);
    } catch (e) {
      if (file.size > MAX_ATTACHMENT) throw e; // too big to send unresized
      return asIs(file);
    }
  }

  async function resizedImage(file) {
    const bitmap = await createImageBitmap(file);
    // Re-encoding through a canvas resizes and strips EXIF in one step. The
    // server cannot do either — it only ever sees ciphertext.
    const full = await drawScaled(bitmap, 1920);
    const thumb = await drawScaled(bitmap, 320);
    bitmap.close && bitmap.close();
    return {
      bytes: new Uint8Array(await full.blob.arrayBuffer()),
      thumbBytes: new Uint8Array(await thumb.blob.arrayBuffer()),
      mime: 'image/jpeg',
      name: file.name,
      w: full.w,
      h: full.h,
      size: full.blob.size,
    };
  }

  function drawScaled(bitmap, max) {
    const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
    const w = Math.round(bitmap.width * scale);
    const h = Math.round(bitmap.height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
    return new Promise((resolve) =>
      canvas.toBlob((blob) => resolve({ blob, w, h }), 'image/jpeg', 0.82)
    );
  }

  /* Pinch, drag and double-tap inside the viewer.
   *
   * The viewer is `touch-action:none`, which is what stops a pinch from scrolling
   * the thread underneath — and also what stopped it from zooming anything. So
   * the gesture is driven here rather than left to the browser, which has the
   * side benefit of working the same on a trackpad, a mouse wheel and a phone.
   *
   * Panning is clamped to the picture's own edges, because a photo that can be
   * flung off-screen and lost is worse than one that cannot be moved at all. */
  function attachZoom(viewer, node) {
    const MAX = 6;
    let scale = 1;
    let tx = 0;
    let ty = 0;
    const points = new Map();
    let from = null; // gesture start: distance, midpoint, scale, offset
    let dragged = false;
    let lastTap = 0;

    const paint = () => {
      node.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
      node.style.cursor = scale > 1 ? 'grab' : '';
    };

    // offsetWidth is the laid-out size, unaffected by the transform, so the
    // bounds do not drift as the picture is scaled.
    const contain = () => {
      scale = Math.min(MAX, Math.max(1, scale));
      if (scale === 1) {
        tx = 0;
        ty = 0;
        return;
      }
      const slackX = Math.max(0, (node.offsetWidth * scale - window.innerWidth) / 2);
      const slackY = Math.max(0, (node.offsetHeight * scale - window.innerHeight) / 2);
      tx = Math.min(slackX, Math.max(-slackX, tx));
      ty = Math.min(slackY, Math.max(-slackY, ty));
    };

    /* Zoom about a point, so the pixel under the fingers stays under them. */
    const zoomAt = (next, cx, cy) => {
      next = Math.min(MAX, Math.max(1, next));
      const originX = cx - window.innerWidth / 2;
      const originY = cy - window.innerHeight / 2;
      const ratio = next / scale;
      tx = originX - (originX - tx) * ratio;
      ty = originY - (originY - ty) * ratio;
      scale = next;
      contain();
      paint();
    };

    const mid = () => {
      const all = [...points.values()];
      return {
        x: all.reduce((s, p) => s + p.x, 0) / all.length,
        y: all.reduce((s, p) => s + p.y, 0) / all.length,
      };
    };
    const spread = () => {
      const [a, b] = [...points.values()];
      return Math.hypot(a.x - b.x, a.y - b.y);
    };

    viewer.addEventListener('pointerdown', (event) => {
      points.set(event.pointerId, { x: event.clientX, y: event.clientY });
      dragged = false;
      from = {
        dist: points.size === 2 ? spread() : 0,
        mid: mid(),
        scale,
        tx,
        ty,
      };
    });

    viewer.addEventListener('pointermove', (event) => {
      if (!points.has(event.pointerId) || !from) return;
      points.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const here = mid();

      if (points.size >= 2 && from.dist) {
        const next = from.scale * (spread() / from.dist);
        tx = from.tx + (here.x - from.mid.x);
        ty = from.ty + (here.y - from.mid.y);
        scale = next;
        dragged = true;
        contain();
        paint();
        return;
      }

      if (scale > 1) {
        tx = from.tx + (here.x - from.mid.x);
        ty = from.ty + (here.y - from.mid.y);
        if (Math.abs(here.x - from.mid.x) > 4 || Math.abs(here.y - from.mid.y) > 4) {
          dragged = true;
        }
        contain();
        paint();
      }
    });

    const release = (event) => {
      points.delete(event.pointerId);
      if (points.size === 1) {
        // Going from two fingers to one: re-anchor, or the picture jumps.
        from = { dist: 0, mid: mid(), scale, tx, ty };
        return;
      }
      if (points.size) return;
      from = null;

      if (dragged) {
        // Suppress the click this gesture is about to produce, so finishing a
        // pan over the backdrop does not also close the viewer.
        viewer._swallowClick = true;
        return;
      }

      const now = Date.now();
      if (now - lastTap < 300) {
        lastTap = 0;
        viewer._swallowClick = true;
        zoomAt(scale > 1 ? 1 : 2.5, event.clientX, event.clientY);
        return;
      }
      lastTap = now;
    };

    viewer.addEventListener('pointerup', release);
    viewer.addEventListener('pointercancel', release);

    // Trackpad pinch arrives as a wheel event with ctrlKey set; a plain wheel is
    // a mouse. Both should zoom here — there is nothing else to scroll.
    viewer.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault();
        zoomAt(scale * Math.exp(-event.deltaY / 300), event.clientX, event.clientY);
      },
      { passive: false }
    );

    node.addEventListener('dblclick', (event) => {
      event.preventDefault();
      zoomAt(scale > 1 ? 1 : 2.5, event.clientX, event.clientY);
    });

    paint();
  }

  // Bumped on every open, so a slow full-size decrypt cannot land in a viewer
  // that has since moved on to a different picture.
  let viewerOpen = 0;

  /* The one way out, whichever control asked for it — the ✕, the backdrop,
   * Escape, or the hardware back button. It was four inline
   * `classList.remove('on')` calls, and a history entry has to be spent
   * exactly once however the picture was dismissed. */
  function closeViewer() {
    const viewer = $('viewer');
    if (!viewer.classList.contains('on')) return;
    viewer.classList.remove('on');
    // A video left playing behind a closed viewer keeps talking. The node is
    // removed on the next open, but that may be a long way off.
    [...viewer.querySelectorAll('video')].forEach((node) => node.pause());
    overlayClosed();
  }

  async function openViewer(attachment, file) {
    const viewer = $('viewer');
    [...viewer.querySelectorAll('img,video')].forEach((n) => n.remove());
    const isVideo = !!file && String(file.mime || '').startsWith('video/');
    const node = el(isVideo ? 'video' : 'img');
    if (isVideo) {
      node.controls = true;
      node.playsInline = true;
      node.autoplay = true;
    }
    viewer.appendChild(node);
    if (!viewer.classList.contains('on')) overlayOpened('viewer');
    viewer.classList.add('on');
    if (!isVideo) attachZoom(viewer, node);
    const mine = ++viewerOpen;

    // The thumbnail first when there is one, because it is already local and
    // puts something on screen immediately rather than a black rectangle.
    if (!isVideo && attachment.has_thumb) {
      try {
        const quick = await mediaUrl(attachment, file, false);
        if (mine === viewerOpen) node.src = quick;
      } catch (e) {
        /* the full size below is the one that matters */
      }
    }

    try {
      // Full resolution — the entire reason for opening it.
      const url = await mediaUrl(attachment, file, true);
      if (mine === viewerOpen) node.src = url;
    } catch (e) {
      if (mine === viewerOpen && !node.src) {
        closeViewer();
        toast('Could not open that at full size');
      }
    }
  }

  /* ==================================================================== *
   * Gestures
   * ==================================================================== */

  function attachGestures(row, bubble, message) {
    let startX = 0;
    let startY = 0;
    let axis = null;
    let holdTimer = null;
    let moved = false;
    // One sheet per gesture. On Android a long press fires contextmenu *and*
    // trips the hold timer, and both want to open it.
    let opened = false;
    /* Which pointer is actually pressed, if any.
     *
     * pointermove fires on plain hover with a mouse, and there was nothing here
     * saying "only while held". startX begins at 0, so moving the cursor over a
     * message gave dx = clientX — several hundred pixels — which clamped to the
     * full 64px of swipe travel and slid the bubble sideways. It also passed the
     * 48px threshold, so _armed was set and the next click silently opened a
     * reply to whatever had been hovered. Touch never showed it: there,
     * pointermove only happens while a finger is down. */
    let holding = null;

    const cancelHold = () => {
      clearTimeout(holdTimer);
      holdTimer = null;
    };

    // While selecting, a tap toggles this row and nothing else — the long
    // press and the reply swipe both belong to the single-message sheet,
    // which selection mode is a replacement for, not a companion to.
    row.addEventListener('click', () => {
      if (state.picking) return;
      if (state.selecting) toggleSelect(message.id);
    });

    row.addEventListener(
      'pointerdown',
      (event) => {
        // A press while text is being picked belongs to the selection handles.
        if (state.picking) return;
        if (state.selecting) return;
        // A right-click is the context menu, not the start of a swipe.
        if (event.pointerType === 'mouse' && event.button !== 0) return;
        holding = event.pointerId;
        startX = event.clientX;
        startY = event.clientY;
        axis = null;
        moved = false;
        opened = false;
        holdTimer = setTimeout(() => {
          if (!moved && !opened) {
            opened = true;
            buzz(14);
            openMessageSheet(message);
          }
        }, 480);
      },
      { passive: true }
    );

    row.addEventListener(
      'pointermove',
      (event) => {
        if (holding === null || event.pointerId !== holding) return;
        const dx = event.clientX - startX;
        const dy = event.clientY - startY;
        if (Math.abs(dx) > 10 || Math.abs(dy) > 10) moved = true;
        if (moved) cancelHold();
        if (!axis && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) {
          // Lock the axis on the first real movement, or a reply swipe fights
          // the vertical scroll the whole way.
          axis = Math.abs(dx) > Math.abs(dy) * 1.5 ? 'x' : 'y';
        }
        if (axis === 'x' && dx > 0 && !message.deleted) {
          const travel = Math.min(dx, 64);
          bubble.style.transform = `translateX(${travel}px)`;
          bubble.style.transition = 'none';
          if (travel >= 48 && !bubble._armed) {
            bubble._armed = true;
            buzz(12);
          }
        }
      },
      { passive: true }
    );

    const release = () => {
      holding = null;
      cancelHold();
      bubble.style.transition = '';
      bubble.style.transform = '';
      if (bubble._armed) {
        bubble._armed = false;
        setReply(message);
      }
    };
    row.addEventListener('pointerup', release, { passive: true });
    row.addEventListener('pointercancel', release, { passive: true });
    row.addEventListener('contextmenu', (event) => {
      // Deliberately *not* suppressed while text is being picked: the browser's
      // own menu is the right one there, because it offers Copy for the
      // selection the reader just made. Ours has no equivalent.
      if (state.picking) return;
      // The native menu is still suppressed — it offers "Copy image", "Save
      // as", "Search the web for…", none of which belong here. But suppressing
      // it and putting nothing in its place left a desktop browser with no
      // route to reply, edit, delete or react at all: every one of those lived
      // behind a 480ms press-and-hold, which is a phone gesture nobody performs
      // with a mouse. Right-click now opens the same sheet a long press does.
      event.preventDefault();
      if (state.selecting) return toggleSelect(message.id);
      cancelHold();
      if (opened) return;
      opened = true;
      openMessageSheet(message);
    });
  }

  /* ==================================================================== *
   * Copying part of a message
   * ==================================================================== *
   *
   * A bubble sets user-select:none, and has to: a long press is how the message
   * sheet opens, and the OS text-selection UI would claim that gesture instead.
   * The cost was that the sheet's Copy could only ever take the whole message.
   *
   * So selection is turned back on for the one bubble the reader picked, seeded
   * with the full text so the handles come up already placed, and narrowing it
   * is left to them — after which the copy is the platform's own, not ours.
   * Nothing here touches the clipboard.
   *
   * Row gestures stand down for as long as it lasts. A handle dragged across a
   * bubble still answering pointermove would fight the reply swipe, and a
   * finger held still over one would reopen the sheet on top of the selection.
   */
  let pickExit = null;

  function endTextPick() {
    if (pickExit) {
      document.removeEventListener('pointerdown', pickExit, true);
      pickExit = null;
    }
    if (!state.picking) return;
    const bubble = $('list').querySelector('.bubble.picking');
    if (bubble) bubble.classList.remove('picking');
    state.picking = null;
  }

  function startTextPick(message) {
    endTextPick();
    const row = $('list').querySelector(`[data-id="${CSS.escape(message.id)}"]`);
    const bubble = row && row.querySelector('.bubble');
    const text = bubble && bubble.querySelector('.txt');
    if (!text) return;
    state.picking = message.id;
    bubble.classList.add('picking');

    const range = document.createRange();
    range.selectNodeContents(text);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);

    // Anything outside this bubble ends it. Capture phase, so it runs ahead of
    // the row handlers it exists to re-enable — and a press on the bubble
    // itself is excluded, since dragging a handle lands there.
    pickExit = (event) => {
      if (bubble.contains(event.target)) return;
      endTextPick();
    };
    document.addEventListener('pointerdown', pickExit, true);
    toast('Drag the handles, then copy');
  }

  /* ==================================================================== *
   * Sheets
   * ==================================================================== */

  // A locked sheet cannot be dismissed by tapping the scrim. It has to be a
  // flag the scrim handler reads: the previous attempt cleared $('scrim').onclick,
  // which does nothing to a listener added with addEventListener, so the one
  // sheet with no way out had one after all.
  let sheetLocked = false;

  /* ==================================================================== *
   * Overlays and the back button
   * ==================================================================== *
   *
   * On Android, back is the same gesture as "close this" everywhere else on
   * the phone. Installed to the Home Screen there was nothing on the history
   * stack to spend, so pressing it over an open photo did not close the photo
   * — it left the conversation altogether, which for a PWA means a cold start
   * back to the lock screen. The way out of that is to give back something of
   * ours to consume: each overlay pushes one entry when it opens and spends it
   * again when it closes, whichever way it was closed.
   *
   * The two flags keep the two stacks — ours and the browser's — from
   * chasing each other. `spending` marks the pop we asked for ourselves, so
   * the handler ignores it rather than closing a second overlay; `viaBack`
   * marks the opposite case, where the browser has already dropped the entry
   * and closing must not try to drop another. Without the first, dismissing a
   * photo opened from a sheet closed the sheet along with it.
   */
  let overlayDepth = 0;
  let spending = false;
  let viaBack = false;

  /* Spending an entry waits a tick.
   *
   * Half the menu closes the sheet and opens another one in the same breath,
   * and a `history.back()` racing a `pushState` in a single turn leaves the
   * two stacks out of step — the traversal is queued, the push is not. A tick
   * is long enough for the pair to cancel out instead: the entry the closing
   * overlay was about to spend is handed straight to the one replacing it, and
   * neither touches the history stack at all. */
  let owed = 0;
  let spendTimer = null;

  function scheduleSpend() {
    if (spendTimer) return;
    spendTimer = setTimeout(() => {
      spendTimer = null;
      const count = owed;
      owed = 0;
      if (!count) return;
      spending = true;
      history.go(-count);
    }, 0);
  }

  function overlayOpened(name) {
    overlayDepth++;
    // An entry is already sitting there unspent — take that one over.
    if (owed) {
      owed--;
      return;
    }
    try {
      history.pushState({ reefOverlay: name, depth: overlayDepth }, '');
    } catch (e) {
      // No history to push (a sandboxed frame). The buttons still work and
      // back behaves exactly as it did before any of this.
      overlayDepth--;
    }
  }

  function overlayClosed() {
    if (!overlayDepth) return;
    overlayDepth--;
    if (viaBack) return; // the browser popped it already
    owed++;
    scheduleSpend();
  }

  window.addEventListener('popstate', () => {
    if (spending) {
      spending = false;
      return;
    }
    if (!overlayDepth) return; // not ours: let the browser do as it likes
    viaBack = true;
    try {
      // Topmost first. The viewer sits above the sheet, so when both are open
      // it is the one in front of you and the one back should answer.
      if ($('viewer').classList.contains('on')) {
        closeViewer();
      } else if ($('sheet').classList.contains('on')) {
        // A locked sheet is one the app is insisting on — approving a device,
        // changing a PIN. Back does not dismiss it, so the entry it just spent
        // goes straight back, or the *next* press would leave the app.
        //
        // Pushed directly rather than through overlayOpened: nothing opened
        // here, and the depth already counts this sheet. Going through it
        // added a second count that never came off, and every later close was
        // then one short.
        if (sheetLocked) {
          try {
            history.pushState({ reefOverlay: 'sheet' }, '');
          } catch (e) {
            /* nothing to restore it to */
          }
        } else {
          closeSheet();
        }
      } else {
        // Nothing on screen to close, so the books were out by one. Straighten
        // them rather than leave an entry to swallow a later back press.
        overlayDepth--;
      }
    } finally {
      viaBack = false;
    }
  });

  function openSheet(build, options) {
    sheetLocked = !!(options && options.locked);
    const sheet = $('sheet');
    sheet.innerHTML = '';
    /* The handle closes the sheet.
     *
     * Tapping the scrim was the only way out, and a sheet tall enough to fill
     * the screen leaves no scrim to tap — so the devices list, which is the
     * longest sheet there is, became a dialog with no exit at all. Capping its
     * height gives the scrim back; this gives the way out somewhere obvious to
     * live, at the one part of a sheet that is always on screen. */
    const handle = el('button', 'grabrow');
    handle.type = 'button';
    handle.setAttribute('aria-label', 'Close');
    handle.appendChild(el('div', 'grab'));
    handle.addEventListener('click', () => {
      if (!sheetLocked) closeSheet();
    });
    sheet.appendChild(handle);
    // A sheet always opens at its own beginning, whatever the last one left
    // behind — the element is reused, and so is its scroll position.
    sheet.scrollTop = 0;
    build(sheet);
    $('scrim').classList.add('on');
    // Only when it was not already up: openSheet is called straight over an
    // open sheet in a few places — a menu item that leads to another sheet —
    // and that replaces the one on screen rather than stacking a second.
    if (!sheet.classList.contains('on')) overlayOpened('sheet');
    sheet.classList.add('on');
  }

  function closeSheet() {
    if (!$('sheet').classList.contains('on')) return;
    sheetLocked = false;
    $('sheet').classList.remove('on');
    $('scrim').classList.remove('on');
    overlayClosed();
  }

  // Where the quick row starts before anybody has used the app. Once there is a
  // tally it leads, so the six on offer are the six you actually send.
  const QUICK_DEFAULT = ['❤️', '😂', '👍', '🐟', '😮', '🙏'];
  const quickReacts = () => topEmoji(6, QUICK_DEFAULT);


  /* The whole emoji catalogue, for a reaction.
   *
   * The six quick ones cover most of it and stay one tap away, but they were
   * also the *only* ones — so the composer could send any emoji in the app and a
   * reaction could be one of six. Literally the same picker the composer draws,
   * built by buildEmojiPicker, so there is one catalogue and one search rather
   * than two of each quietly drifting apart. */
  function openReactionPicker(message) {
    const current = myReactionList(message);
    openSheet((sheet) => {
      sheet.appendChild(el('div', 'sheet-title', 'React with anything.'));
      const panel = el('div', 'picker');
      sheet.appendChild(panel);
      buildEmojiPicker(panel, {
        // Plain emoji characters throughout — that is what a reaction *is* on
        // the wire and in IndexedDB, so the mark on an already-chosen one is
        // still a string compare and not a lookup through some id scheme.
        picked: (emoji) => current.includes(emoji),
        pick: (emoji) => {
          closeSheet();
          toggleReaction(message, emoji);
        },
      });
    });
  }

  function openMessageSheet(message) {
    openSheet((sheet) => {
      if (!message.deleted) {
        const current = myReactionList(message);
        const reacts = el('div', 'quickreacts');
        quickReacts().forEach((emoji) => {
          const button = el('button', null, emoji);
          button.type = 'button';
          if (current.includes(emoji)) button.classList.add('picked');
          button.addEventListener('click', () => {
            closeSheet();
            toggleReaction(message, emoji);
          });
          reacts.appendChild(button);
        });
        // The way out of the six. Marked when the reaction already on this
        // message is not one of them, so it never looks like nothing is chosen.
        const more = el('button', 'more', '＋');
        more.type = 'button';
        more.setAttribute('aria-label', 'More reactions');
        if (current.some((e) => quickReacts().indexOf(e) < 0)) more.classList.add('picked');
        more.addEventListener('click', () => openReactionPicker(message));
        reacts.appendChild(more);
        sheet.appendChild(reacts);
      }

      const action = (icon, label, fn, bad) => {
        const button = el('button', 'act' + (bad ? ' bad' : ''));
        button.appendChild(el('span', 'ico', icon));
        button.appendChild(el('span', null, label));
        button.addEventListener('click', () => {
          closeSheet();
          fn();
        });
        sheet.appendChild(button);
      };

      if (!message.deleted) {
        action('↩', 'Reply', () => setReply(message));
        if (message.body && message.body.text) {
          action('⧉', 'Copy', () => {
            navigator.clipboard.writeText(message.body.text);
            toast('Copied');
          });
          // The whole message is one tap; a phrase out of the middle of it was
          // not possible at all until this.
          action('⌶', 'Select text', () => startTextPick(message));
        }
        if (message.mine && withinEditWindow(message)) {
          action('✎', 'Edit', () => startEdit(message));
        }
        if (message.mine && withinDeleteWindow(message)) {
          action('🗑', 'Delete for everyone', () => removeMessage(message), true);
        }
      }
      action('ℹ', 'Details', () => openInfoSheet(message));
      action('👁', 'Hide for me', () => hideLocally(message));
      action('☑', 'Select', () => enterSelectMode(message));
    });
  }

  /* ==================================================================== *
   * Multi-select
   * ==================================================================== */

  function enterSelectMode(message) {
    state.selecting = true;
    state.selection = new Set([message.id]);
    renderList();
    updateSelectBar();
  }

  function exitSelectMode() {
    state.selecting = false;
    state.selection = new Set();
    renderList();
    updateSelectBar();
  }

  function toggleSelect(id) {
    if (state.selection.has(id)) state.selection.delete(id);
    else state.selection.add(id);
    // Deselecting the last one is the same as cancelling — there is nothing
    // left to act on, and a bar offering actions for zero messages is a bar
    // with nothing honest to say.
    if (!state.selection.size) return exitSelectMode();
    refreshRow(state.messages.get(id));
    updateSelectBar();
  }

  /* What the bar shows: how many, and which actions still make sense for
   * every one of them. "Hide for me" always does — it is unconditional even
   * one at a time. "Delete for everyone" is offered only when every single
   * selected message would individually qualify for it; two eligible messages
   * mixed in with three that are not is not a partial delete, it is a
   * confusing one, so the bar does not offer it at all rather than doing three
   * of the five and reporting back which. */
  function updateSelectBar() {
    const bar = $('select-bar');
    $('inputrow').style.display = state.selecting ? 'none' : 'flex';
    if (!state.selecting) {
      bar.style.display = 'none';
      return;
    }
    bar.style.display = 'flex';
    const n = state.selection.size;
    $('select-count').textContent = `${n} selected`;
    const selected = [...state.selection]
      .map((id) => state.messages.get(id))
      .filter(Boolean);
    const canDeleteAll =
      selected.length > 0 &&
      selected.every((m) => m.mine && !m.deleted && withinDeleteWindow(m));
    $('select-delete').style.display = canDeleteAll ? '' : 'none';
  }

  async function bulkHideForMe() {
    // Flagged and kept, not deleted — see hideLocally for why: a row removed
    // outright comes back on the next history sync, since the server was
    // never told and hands it over again.
    const changed = [];
    for (const id of state.selection) {
      const message = state.messages.get(id);
      if (!message) continue;
      message.hiddenForMe = true;
      changed.push(message);
    }
    if (changed.length) await DB.putMessages(changed);
    invalidateOrder();
    // Ends the mode rather than only re-rendering: with the messages gone
    // from view, there is nothing left selected to act on again.
    exitSelectMode();
  }

  async function bulkDeleteForEveryone() {
    const changed = [];
    for (const id of state.selection) {
      const message = state.messages.get(id);
      if (!message) continue;
      try {
        await API.remove(id);
        message.deleted = true;
        message.body = null;
        changed.push(message);
      } catch (e) {
        // One failing — the window closing mid-selection, a dropped
        // connection — must not silently swallow the rest; it also must not
        // abort them, since whichever already succeeded should stay deleted.
        toast((e.data && e.data.detail) || 'Could not delete one of them');
      }
    }
    if (changed.length) await DB.putMessages(changed);
    exitSelectMode();
  }

  const stamp = (iso) =>
    new Date(iso).toLocaleString(undefined, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: 'numeric',
      minute: '2-digit',
    });

  /* Turns a device id into a person.
   *
   * Handles and fish never touch the server — they arrive as encrypted system
   * messages — so this is the only place that can name anybody, and it has to
   * cope with a device that has not announced itself yet, or one that has since
   * been replaced. */
  function whoIs(deviceId) {
    const id = String(deviceId);
    if (id === String(state.device.id)) return 'You';
    const profile = state.profiles[deviceId] || state.profiles[id];
    if (profile && profile.handle) {
      return `${profile.emoji || ''} ${profile.handle}`.trim();
    }
    if (isOwnDevice(id)) return 'Another of your devices';
    if (state.recipients.some((r) => String(r.id) === id)) {
      const peer = peerProfile();
      return peer.handle && peer.handle !== 'Reef' ? peer.handle : 'The other person';
    }
    return 'A device no longer here';
  }

  /* Everything the client knows about one message, which until now it kept to
   * itself: the receipts were collapsed into one tick and the reactions into
   * bare emoji, so "have they read it" and "who reacted" had no answer. */
  function openInfoSheet(message) {
    openSheet((sheet) => {
      sheet.appendChild(el('div', 'sheet-title', 'When it went, and who has seen it.'));

      const line = (label, value) => {
        const row = el('div', 'act');
        row.style.pointerEvents = 'none';
        row.appendChild(el('span', null, label));
        const right = el('span', null, value);
        right.style.cssText = 'flex:1;text-align:right;color:var(--muted)';
        row.appendChild(right);
        sheet.appendChild(row);
      };

      line('Sent', stamp(message.createdAt));
      if (message.editedAt) line('Edited', stamp(message.editedAt));
      if (message.deleted) line('Taken back', 'yes');

      if (message.mine) {
        const receipts = (message.receipts || []).filter((r) => r.device_id);
        if (!receipts.length) {
          line('Delivered', message.state === 'sent' ? 'not yet' : 'still sending');
        }
        receipts.forEach((receipt) => {
          const name = whoIs(receipt.device_id);
          line(`Delivered · ${name}`, receipt.delivered_at ? stamp(receipt.delivered_at) : 'not yet');
          line(`Read · ${name}`, receipt.read_at ? stamp(receipt.read_at) : 'not yet');
        });
      }

      const reactions = (message.reactions || []).filter((r) => emojiOf(r).length);
      if (reactions.length) {
        sheet.appendChild(el('div', 'sheet-title', 'Reactions'));
        reactions.forEach((reaction) => {
          line(whoIs(reaction.device_id), emojiOf(reaction).join(' '));
        });
      }
    });
  }

  function withinEditWindow(message) {
    return Date.now() - new Date(message.createdAt).getTime() < 5 * 60 * 1000;
  }

  // Mirrors the server's DELETE_EVERYONE_WINDOW. Checked here too so the
  // option is not even offered on something the server would refuse — the
  // alternative is a menu item that looks available and answers with an
  // error every time, past two days, forever.
  function withinDeleteWindow(message) {
    return Date.now() - new Date(message.createdAt).getTime() < 2 * 24 * 60 * 60 * 1000;
  }

  function openMenuSheet() {
    openSheet((sheet) => {
      const action = (icon, label, fn) => {
        const button = el('button', 'act');
        button.appendChild(el('span', 'ico', icon));
        button.appendChild(el('span', null, label));
        button.addEventListener('click', () => {
          closeSheet();
          fn();
        });
        sheet.appendChild(button);
      };
      const waiting = state.requests.length;
      if (waiting) {
        action('📨', `Requests (${waiting})`, openRequestsSheet);
      }
      // Used to be its own header button. That slot went to Lock now instead —
      // reached for in a hurry, where finding a message is not — so search
      // moved here rather than off the menu entirely.
      action('🔍', 'Search', openSearch);
      action('🏷', 'My code', openCodeSheet);
      // "Start a conversation" was ambiguous about whether it joined this one or
      // began another. It now depends on where you are: an empty seat here gets
      // filled, and only a full room starts something separate. The label says
      // which.
      action(
        '✉️',
        peerRecipients().length ? 'Start a new conversation' : 'Invite someone here',
        openInviteSheet
      );
      if (Object.keys(state.sessions).length > 1) {
        action('🔀', 'Switch conversation', openRoomSheet);
      }
      action(state.notifications ? '🔔' : '🔕',
             state.notifications ? 'Notifications on' : 'Notifications off',
             async () => {
               await setNotifications(!state.notifications);
               state.notifications = await notificationsActive();
             });
      action('🔑', 'Safety number', openSafetySheet);
      action('🐠', 'Change my fish', openProfileSheet);
      action('📱', 'Devices', openDevicesSheet);
      action('🔢', 'Change PIN', () => openPinSheet());
      action('💾', 'Storage', openStorageSheet);
      action('↻', 'Force refresh', forceRefresh);
      // A room that skips device approval has already opted out of every lock
      // timer — idleReset and watchVisibility both refuse to fire in one — so
      // offering "Lock after 5 minutes" there would be a promise the app has
      // deliberately stopped making. Locking by hand is a different thing: that
      // is something you just did, not something being guaranteed for later, so
      // it stays on the menu either way.
      if (state.session && state.session.auto_approve_devices) {
        action('🔒', 'Lock now', lockNow);
      } else {
        action('🔒', 'Lock', openLockSheet);
      }
      if (state.build) {
        // Answers "did my fix actually deploy?" without guessing.
        const stamp = el('div', 'sheet-title', 'Build ' + state.build);
        stamp.style.cssText += ';text-align:center;padding-top:8px';
        sheet.appendChild(stamp);
      }
    });
  }

  /* When this device asks for the PIN again.
   *
   * Two minutes on a desk and five away were fine for a phone in a pocket and
   * wrong for everything else: the laptop in a locked room retyped a PIN all
   * day, and the phone that gets handed around wanted a minute. Both timers are
   * one setting because two of them is a quiz — "lock after" is the question
   * anybody actually has, and the away threshold that follows from it is
   * bookkeeping.
   *
   * Re-rendered by reopening itself, which is how the checkmark moves. openSheet
   * replaces an open sheet rather than stacking one, so this costs nothing. */
  function openLockSheet() {
    // Defensive. The sheet can outlive the room it was opened from — a switch
    // through openRoomSheet, or a hello frame arriving with a session that says
    // the room turned auto-approve while you were reading it — and controls that
    // are guaranteed to do nothing are worse than no controls.
    if (state.session && state.session.auto_approve_devices) {
      return toast('This conversation does not use the lock');
    }
    const chosen = LOCK_PRESETS[state.lockAfter] ? state.lockAfter : LOCK_DEFAULT;
    openSheet((sheet) => {
      // `picked` gets the same background-plus-ring treatment as an emoji
      // reaction already wearing your fish. A lone checkmark character in the
      // icon slot turned out too quiet to read as "this one, not that one" at
      // a glance — the exact thing that ring was already built to fix once.
      const row = (icon, label, sub, fn, picked) => {
        const button = el('button', 'act' + (picked ? ' picked' : ''));
        button.appendChild(el('span', 'ico', icon));
        if (sub) {
          const stack = el('div', 'stack');
          stack.appendChild(el('b', null, label));
          stack.appendChild(el('span', 'sub', sub));
          button.appendChild(stack);
        } else {
          button.appendChild(el('span', null, label));
        }
        button.addEventListener('click', fn);
        sheet.appendChild(button);
      };

      sheet.appendChild(
        el(
          'div',
          'sheet-title',
          'How long this device waits before asking for your PIN again. Only ' +
            'this browser — your other devices keep their own answer.'
        )
      );
      Object.keys(LOCK_PRESETS).forEach((key) => {
        const isChosen = key === chosen;
        row(
          isChosen ? '✓' : '',
          LOCK_PRESETS[key].label,
          null,
          async () => {
            await setLockAfter(key);
            openLockSheet();
          },
          isChosen
        );
      });

      sheet.appendChild(
        el(
          'div',
          'sheet-title',
          'Closing the app is not the same as leaving it open. Say what should ' +
            'happen when you come back to it.'
        )
      );
      // Same ring-plus-background as the presets above, not just the padlock
      // flipping — a lone emoji swap next to unchanged black text read as "did
      // that tap even do anything?" the same way the presets' bare checkmark
      // did, and for the same reason: state.lockOnReopen is true here means
      // the setting is *on*, so it gets the same "this one is active" mark.
      row(
        state.lockOnReopen ? '🔒' : '🔓',
        state.lockOnReopen
          ? 'Ask for your PIN after closing the app'
          : 'Stay open after closing the app',
        'Refreshing the page does not count as closing it.',
        async () => {
          await setLockOnReopen(!state.lockOnReopen);
          openLockSheet();
        },
        state.lockOnReopen
      );

      // Still here, because it used to be the whole of this menu entry and
      // burying it two taps deeper would be a loss on its own.
      row('🔒', 'Lock now', null, () => {
        closeSheet();
        lockNow();
      });
    });
  }

  /* What this device is holding. Silent housekeeping is fine until somebody
   * wonders where their disk went, so it is at least inspectable — and the one
   * thing that is never dropped automatically is named, because "why is this
   * still 400MB" has an answer. */
  async function openStorageSheet() {
    let media = [];
    let messages = 0;
    try {
      media = await DB.mediaEntries();
      messages = (await DB.messagesPage(LOCAL_MESSAGE_CAP + 1)).length;
    } catch (e) {
      /* shown as zero */
    }
    const held = media.reduce((sum, entry) => sum + entry.size, 0);
    let quota = null;
    try {
      if (navigator.storage && navigator.storage.estimate) {
        quota = await navigator.storage.estimate();
      }
    } catch (e) {
      /* not offered by this browser */
    }

    openSheet((sheet) => {
      sheet.appendChild(
        el('div', 'sheet-title', 'What this device is keeping for this conversation.')
      );
      const line = (label, value) => {
        const row = el('div', 'act');
        row.style.pointerEvents = 'none';
        row.appendChild(el('span', null, label));
        const right = el('span', null, value);
        right.style.cssText = 'flex:1;text-align:right;color:var(--muted)';
        row.appendChild(right);
        sheet.appendChild(row);
      };

      line('Messages', `${messages}${messages > LOCAL_MESSAGE_CAP ? '+' : ''}`);
      line('Photos and files', `${media.length} · ${fileSize(held)}`);
      if (quota && quota.usage) {
        line('This site altogether', fileSize(quota.usage));
      }
      // The one number here that is not about space. Unpersisted, the browser
      // may evict this origin, and evicting it takes the keypair — which reads
      // as the app losing every message and asking to be approved again.
      if (state.storagePersisted !== null) {
        line(
          'Protected from cleanup',
          state.storagePersisted ? 'Yes' : 'No — install the app'
        );
      }

      sheet.appendChild(
        el(
          'div',
          'sheet-title',
          `Beyond ${LOCAL_MESSAGE_CAP} messages the oldest are dropped and fetched ` +
            'again if you scroll back to them. Photos are only dropped while the ' +
            'server could still send them — after ' + SERVER_BLOB_DAYS + ' days this ' +
            'device holds the only copy, so those are kept whatever the size.'
        )
      );

      /* The debug log, for when the thread does something it should not — most
       * of all a scroll back that leaves nothing on screen but a count of
       * messages that cannot be opened. Nothing readable goes in it: ids,
       * seqs and counts only. */
      const copy = el('button', 'act');
      copy.appendChild(el('span', 'ico', '🐞'));
      copy.appendChild(el('span', null, 'Copy debug log'));
      copy.addEventListener('click', async () => {
        // Recorded before the copy, so the buffer says what the screen looked
        // like at the moment somebody thought it was worth sending.
        log('log.copied', viewReport('copied'));
        const copied = await copyDebugLog();
        toast(copied ? 'Debug log copied' : 'Could not copy it');
      });
      sheet.appendChild(copy);
    });
  }

  /* ---- Invitations ---------------------------------------------------- */

  /* Records a room the server has just seated this browser in.
   *
   * Starting a conversation creates a new room, and this client only ever
   * learned about a room from an unlock response — so the room you had just
   * created was invisible to you until you re-entered your PIN. The server now
   * enrols the calling device and hands back that room's token, which is
   * everything needed to treat it like any other conversation immediately. */
  async function adoptRoom(result) {
    if (!result || !result.room_id || !result.token) return false;
    state.sessions[result.room_id] = {
      token: result.token,
      deviceId: result.device && result.device.id,
      status: (result.device && result.device.status) || 'active',
      slot: result.slot || 1,
    };
    await DB.setSessions(state.sessions);
    return true;
  }

  async function refreshRequests() {
    try {
      state.requests = (await API.requests()).invitations || [];
    } catch (e) {
      state.requests = [];
    }
    paintBadge();
  }

  /* Both kinds of "someone is waiting on you" share the one dot, so they share
   * the one function that draws it. Setting it from two places meant whichever
   * refresh finished last erased the other. */
  function paintBadge() {
    const waiting = state.requests.length + state.pendingDevices.length;
    $('menu').textContent = waiting ? '⋯•' : '⋯';
  }

  async function refreshDevices() {
    try {
      await applyDevices((await API.devices()).devices || []);
    } catch (e) {
      /* offline; whatever was last known stays on screen */
    }
  }

  /* Everything that follows from knowing the room's devices, wherever the list
   * came from. The socket's opening frame carries the same list, and used to
   * have no way to feed it through here — so the REST call was the only route
   * and a timer was the only thing keeping it current. */
  async function applyDevices(devices) {
    state.devices = devices;
    // Only the other person's pending devices are actionable here — this side
    // cannot let its own second phone in, by design.
    state.pendingDevices = state.devices.filter(
      (d) => d.status === 'pending' && !d.is_self && d.slot !== state.session.slot
    );
    paintBadge();
    paintDeviceBanner();

    // The derived keys are the thing the composer actually depends on, and they
    // were only ever rebuilt on unlock or on a device event. A device that let
    // itself in — the first one into a room with no messages — sent no event, so
    // this side could sit with an empty recipient list insisting the other side
    // had nobody, while they were plainly there. Comparing the two lists catches
    // it however the device arrived, and however the event went missing.
    const peersNow = state.devices
      .filter((d) => d.status === 'active' && d.slot !== state.session.slot)
      .map((d) => String(d.id))
      .sort()
      .join(',');
    const peersKnown = peerRecipients()
      .map((r) => String(r.id))
      .sort()
      .join(',');
    if (peersNow !== peersKnown) {
      try {
        await refreshKeys();
      } catch (e) {
        /* offline; the next pass will try again */
      }
    }
  }

  /* REST, on a timer, for as long as no socket can be built at all.
   *
   * The device list and the session used to be polled every sixty and thirty
   * seconds whatever the socket was doing. They are in the socket's opening
   * frame now, so a healthy client makes neither call — but "healthy" cannot be
   * assumed. A network that blocks WebSocket outright leaves a client with no
   * route to any of this, and it worked before, so it has to keep working.
   *
   * Armed only once the socket has been down long enough to look like more than
   * a blip, and disarmed the moment one connects. Nothing runs in the ordinary
   * case, which is the whole point. */
  const FALLBACK_AFTER = 60000;
  const FALLBACK_EVERY = 60000;
  let fallbackArmTimer = null;
  let fallbackTimer = null;

  function armFallback() {
    if (fallbackTimer) return;
    fallbackTimer = setInterval(async () => {
      await refreshDevices();
      await refreshPresence();
    }, FALLBACK_EVERY);
  }

  function disarmFallback() {
    clearTimeout(fallbackArmTimer);
    fallbackArmTimer = null;
    clearInterval(fallbackTimer);
    fallbackTimer = null;
  }

  function watchSocketOutage(online) {
    if (online) return disarmFallback();
    if (fallbackTimer || fallbackArmTimer) return;
    fallbackArmTimer = setTimeout(armFallback, FALLBACK_AFTER);
  }

  /* Everything room-scoped that is waiting on a clock, stopped together.
   *
   * The presence timers belong here as much as the fallback does: each one is
   * holding a device id from the room being left, and left running it would
   * repaint the header for a peer who is not in the conversation now on screen.
   * The old pair of polling intervals were torn down at each of these three
   * points, and their replacements have to be. */
  function stopRoomTimers() {
    disarmFallback();
    clearTimeout(helloTimer);
    helloTimer = null;
    presenceTimers.forEach((timer) => clearTimeout(timer));
    presenceTimers.clear();
    state.peerLive = [];
    state.peerOnline = false;
  }

  /* Whether the server on the far end of this socket is one that sends an
   * opening frame and relays presence beats.
   *
   * It cannot be assumed, and the deploy order must not have to be arranged
   * around it. This client is a static bundle; the server behind it ships
   * separately, and either can land first. A client that took the new behaviour
   * for granted and got an old server would have no device list beyond the one
   * fetched at unlock, and would start expiring presence against beats that were
   * never going to arrive — marking the other person gone 45 seconds after
   * connecting, while they sat there.
   *
   * So the socket is given a moment to say hello. If it does not, this reverts
   * to exactly the polling the hello frame replaced. Nothing needs coordinating;
   * whichever side is newer, the pair behaves. */
  const HELLO_GRACE = 5000;
  let helloTimer = null;

  function expectHello() {
    clearTimeout(helloTimer);
    state.serverBeats = null;
    helloTimer = setTimeout(() => {
      helloTimer = null;
      state.serverBeats = false;
      // No snapshot is coming, so ask for one, and keep asking.
      refreshDevices();
      armFallback();
      // The countdowns started by this connection's presence announcements have
      // nothing to count against on a server that does not beat.
      presenceTimers.forEach((timer) => clearTimeout(timer));
      presenceTimers.clear();
    }, HELLO_GRACE);
  }

  function paintDeviceBanner() {
    const count = state.pendingDevices.length;
    $('device-banner').classList.toggle('on', count > 0);
    if (!count) return;
    $('device-banner-text').textContent =
      count === 1
        ? 'A new device is waiting for you to let it in'
        : `${count} new devices are waiting for you to let them in`;
  }

  async function openCodeSheet() {
    let code;
    try {
      code = (await API.myCode()).code;
    } catch (e) {
      return toast('Offline');
    }
    openSheet((sheet) => {
      sheet.appendChild(
        el(
          'div',
          'sheet-title',
          'Give this to someone so they can ask you for a conversation. ' +
            'It is not a PIN — on its own it opens nothing.'
        )
      );
      const box = el('div', 'mono', code);
      box.style.cssText += ';text-align:center;font-size:22px;letter-spacing:.18em';
      sheet.appendChild(box);

      const row = el('div');
      row.style.cssText = 'display:flex;gap:8px;margin-top:10px';
      const wide = 'flex:1;justify-content:center';

      const copy = el('button', 'act', 'Copy');
      copy.style.cssText = wide;
      copy.addEventListener('click', () => {
        navigator.clipboard.writeText(code);
        toast('Copied');
      });
      row.appendChild(copy);

      if (navigator.share) {
        const share = el('button', 'act', 'Share');
        share.style.cssText = wide;
        share.addEventListener('click', () =>
          navigator.share({ text: code }).catch(() => {})
        );
        row.appendChild(share);
      }
      sheet.appendChild(row);

      const rotate = el('button', 'act bad', 'Replace this code');
      rotate.style.justifyContent = 'center';
      rotate.addEventListener('click', async () => {
        await API.rotateCode();
        closeSheet();
        // Worth saying, because it is the reason to use it: this stops new
        // requests without touching anything already going.
        toast('New code. Conversations you already have are unaffected.');
      });
      sheet.appendChild(rotate);
    });
  }

  function openInviteSheet() {
    openSheet((sheet) => {
      // Say up front where the person will land. The server fills the free seat
      // in this room when there is one and nothing has been said yet, and only
      // starts a separate conversation otherwise.
      const here = !peerRecipients().length;
      const lede = el(
        'div',
        'sheet-title',
        here
          ? 'Nobody else is in this conversation yet, so whoever you invite ' +
            'joins you here.'
          : 'This starts a separate conversation. The one you are in now is ' +
            'untouched.'
      );
      lede.style.color = 'var(--text)';
      sheet.appendChild(lede);

      sheet.appendChild(
        el('div', 'sheet-title', 'Someone already using Reef — enter their code.')
      );
      const input = el('input');
      input.placeholder = 'ABCD2345';
      input.autocapitalize = 'characters';
      input.maxLength = 12;
      input.style.cssText =
        'width:100%;padding:12px;border-radius:12px;background:var(--bg);' +
        'border:1px solid var(--line);margin-bottom:8px;text-align:center;' +
        'letter-spacing:.18em;text-transform:uppercase;font-family:ui-monospace,monospace';
      sheet.appendChild(input);

      const send = el('button', 'act', 'Send request');
      send.style.justifyContent = 'center';
      send.addEventListener('click', async () => {
        try {
          // The server seats this browser in the pending room, so the
          // conversation is reachable from "Switch conversation" the moment they
          // accept — no second trip through the PIN.
          await adoptRoom(await API.inviteByCode(input.value));
          closeSheet();
          toast('Sent. It appears once they accept.');
        } catch (err) {
          toast(err.status === 404 ? 'No such code' : (err.message || 'Failed'));
        }
      });
      sheet.appendChild(send);

      sheet.appendChild(
        el(
          'div',
          'sheet-title',
          'Someone not using Reef at all — send them a one-time PIN instead.'
        )
      );
      const newcomer = el('button', 'act', 'Invite someone new');
      newcomer.style.justifyContent = 'center';
      newcomer.addEventListener('click', async () => {
        try {
          const result = await API.inviteNewcomer();
          await adoptRoom(result);
          closeSheet();
          showJoinPin(result);
        } catch (e) {
          toast('Could not create the invitation');
        }
      });
      sheet.appendChild(newcomer);
    });
  }

  function showJoinPin(result) {
    openSheet((sheet) => {
      sheet.appendChild(
        el(
          'div',
          'sheet-title',
          `Send them this. It works once, expires in ${result.expires_in_hours} hours, ` +
            'and stops working as soon as they pick a PIN of their own. ' +
            'You will not be shown it again.'
        )
      );
      const box = el('div', 'mono', result.join_pin);
      box.style.cssText += ';text-align:center;font-size:30px;letter-spacing:.3em';
      sheet.appendChild(box);

      const copy = el('button', 'act', 'Copy');
      copy.style.justifyContent = 'center';
      copy.addEventListener('click', () => {
        navigator.clipboard.writeText(result.join_pin);
        toast('Copied');
      });
      sheet.appendChild(copy);

      if (result.same_room) {
        // The free seat in this very room was filled, so there is nowhere to go.
        sheet.appendChild(
          el(
            'div',
            'sheet-title',
            'They join this conversation — they appear here as soon as they ' +
              'have entered it.'
          )
        );
      } else if (result.room_id && state.sessions[result.room_id]) {
        sheet.appendChild(
          el(
            'div',
            'sheet-title',
            'This is a new conversation. Wait for them in it — they appear as ' +
              'soon as they have joined.'
          )
        );
        const go = el('button', 'act', 'Go to that conversation');
        go.style.cssText += ';justify-content:center;color:var(--accent)';
        go.addEventListener('click', async () => {
          closeSheet();
          try {
            await enterRoom(result.room_id);
          } catch (e) {
            toast('Could not open it — enter your PIN again');
          }
        });
        sheet.appendChild(go);
      }
    });
  }

  function openRequestsSheet() {
    openSheet((sheet) => {
      sheet.appendChild(
        el('div', 'sheet-title', 'People asking to start a conversation with you.')
      );
      state.requests.forEach((invitation) => {
        const row = el('div', 'act');
        row.appendChild(el('span', 'ico', '📨'));
        const label = el('span', null, invitation.from_code);
        label.style.cssText = 'flex:1;font-family:ui-monospace,monospace';
        row.appendChild(label);

        const respond = (action, colour, done) => {
          const button = el('button', null, action === 'accept' ? 'Accept' : 'Decline');
          button.style.cssText = `color:${colour};font-weight:600;padding:8px 10px`;
          button.addEventListener('click', async () => {
            try {
              // Accepting enrols this browser in the room, so it can be opened
              // straight away rather than after another unlock.
              const outcome = await API.respondToRequest(invitation.id, action);
              const joined = action === 'accept' && (await adoptRoom(outcome));
              closeSheet();
              await refreshRequests();
              toast(done);
              if (joined) await enterRoom(outcome.room_id);
            } catch (e) {
              toast('Could not do that');
            }
          });
          return button;
        };
        // No longer "lock and unlock to see it" — accepting enrols this device,
        // so the conversation opens directly.
        row.appendChild(respond('accept', 'var(--accent)', 'Accepted.'));
        row.appendChild(respond('decline', 'var(--danger)', 'Declined.'));
        sheet.appendChild(row);
      });
    });
  }

  function openRoomSheet() {
    openSheet((sheet) => {
      sheet.appendChild(el('div', 'sheet-title', 'Your conversations.'));
      Object.entries(state.sessions).forEach(([roomId, session]) => {
        const row = el('div', 'act');
        const known = state.profiles;
        row.appendChild(el('span', 'ico', roomId === state.roomId ? '🟢' : '🐟'));
        const label = el(
          'span',
          null,
          roomId === state.roomId
            ? `${peerProfile().handle} · here`
            : session.status === 'active'
              ? 'Conversation'
              : 'Waiting for approval'
        );
        label.style.flex = '1';
        row.appendChild(label);
        if (roomId !== state.roomId) {
          row.addEventListener('click', async () => {
            closeSheet();
            await enterRoom(roomId);
          });
        }
        sheet.appendChild(row);
      });
    });
  }

  function openSafetySheet() {
    openSheet((sheet) => {
      sheet.appendChild(
        el(
          'div',
          'sheet-title',
          'Read these out to each other. If they ever differ, a new device is on the conversation.'
        )
      );
      sheet.appendChild(
        el('div', 'mono', state.session.safety_number || 'Not established yet')
      );
    });
  }

  function openProfileSheet() {
    openSheet((sheet) => {
      sheet.appendChild(el('div', 'sheet-title', 'How you appear to the other side.'));

      // Nothing is committed until Save. state.me used to be mutated on the tap,
      // so dismissing the sheet left this device wearing a fish it had never
      // announced — and the other side still seeing the old one.
      let emoji = state.me.emoji;
      let follows = !state.me.handle || isFishName(state.me.handle);

      // The one thing that was missing: seeing the pair you are choosing. The
      // fish is picked in one place, the name typed in another, and neither
      // showed the result.
      const card = el('div', 'sheet-title');
      card.style.cssText += ';text-align:center;font-size:17px;color:var(--text)';
      sheet.appendChild(card);

      const input = el('input');
      input.value = state.me.handle;
      input.maxLength = 24;
      input.style.cssText =
        'width:100%;padding:12px;border-radius:12px;background:var(--bg);border:1px solid var(--line);margin-bottom:10px';
      const paint = () => {
        card.textContent = `${emoji} ${input.value.trim() || fishName(emoji) || 'Fish'}`;
      };
      input.addEventListener('input', () => {
        follows = isFishName(input.value.trim()) || !input.value.trim();
        paint();
      });
      sheet.appendChild(input);

      const grid = el('div', 'emoji-grid');
      FISH.forEach(([fish, name]) => {
        const button = el('button', null, fish);
        button.type = 'button';
        button.title = name;
        button.setAttribute('aria-label', name);
        button.addEventListener('click', () => {
          emoji = fish;
          // The whole point: the fish names you, right up until you name
          // yourself.
          if (follows) input.value = name;
          [...grid.children].forEach((c) => c.classList.remove('picked'));
          button.classList.add('picked');
          paint();
        });
        if (fish === emoji) button.classList.add('picked');
        grid.appendChild(button);
      });
      sheet.appendChild(grid);
      paint();

      const save = el('button', 'act', 'Save');
      save.style.justifyContent = 'center';
      save.addEventListener('click', async () => {
        state.me = {
          handle: input.value.trim() || fishName(emoji) || 'Fish',
          emoji,
        };
        await DB.setProfile(state.me, state.session.slot);
        closeSheet();
        announceProfile();
        toast('Saved');
      });
      sheet.appendChild(save);
    });
  }

  const DEVICE_STATUS = {
    active: 'signed in',
    pending: 'waiting to be let in',
    revoked: 'signed out',
  };

  async function openDevicesSheet() {
    let devices;
    try {
      devices = (await API.devices()).devices || [];
    } catch (e) {
      return toast('Offline');
    }
    state.devices = devices;
    state.pendingDevices = devices.filter(
      (d) => d.status === 'pending' && !d.is_self && d.slot !== state.session.slot
    );
    paintBadge();
    paintDeviceBanner();

    const mine = devices.filter((d) => d.slot === state.session.slot);
    const theirs = devices.filter((d) => d.slot !== state.session.slot);
    const peerHandle = peerProfile().handle;
    const theirTitle =
      peerHandle && peerHandle !== 'Reef'
        ? `${peerHandle}’s devices`
        : 'The other person’s devices';

    openSheet((sheet) => {
      sheet.appendChild(el('div', 'sheet-title', 'Everything signed in right now.'));

      const act = (label, color, fn) => {
        const button = el('button', null, label);
        button.style.cssText = `color:${color};font-weight:600;padding:8px 10px`;
        button.addEventListener('click', fn);
        return button;
      };

      /* Every one of these used to be an un-caught await. A rejected approval
       * left the sheet open with no toast and no error, which looks exactly
       * like a button that does nothing. */
      const guard = (fn, done) => async () => {
        try {
          await fn();
          closeSheet();
          toast(done);
          await refreshDevices();
          await refreshKeys();
        } catch (err) {
          toast(err && err.offline ? 'Offline — try again' : 'Could not do that');
        }
      };

      // The id is the only field certain to differ between two phones with the
      // same name. The timestamps are shown when the server sends them.
      const subtitle = (device) => {
        const bits = [device.is_self ? 'this device' : null];
        bits.push(DEVICE_STATUS[device.status] || device.status);
        bits.push('#' + device.id);
        // dayLabel says "Today", which is the one thing you already knew. When
        // you are deciding which of two similar devices to sign out, the time is
        // the whole of the useful information.
        if (device.created_at) bits.push('added ' + stamp(device.created_at));
        if (device.last_seen_at) bits.push('last seen ' + stamp(device.last_seen_at));
        return bits.filter(Boolean).join(' · ');
      };

      const render = (device) => {
        const row = el('div', 'act');
        row.appendChild(el('span', 'ico', device.status === 'pending' ? '⏳' : '📱'));

        const stack = el('div', 'stack');
        stack.appendChild(el('b', null, device.label || 'Device'));
        stack.appendChild(el('span', 'sub', subtitle(device)));
        row.appendChild(stack);

        const theirPending =
          device.status === 'pending' && !device.is_self && device.slot !== state.session.slot;

        if (theirPending) {
          row.appendChild(
            act(
              'Approve',
              'var(--accent)',
              guard(
                () => API.approveDevice(device.id),
                'Approved. Compare the safety number.'
              )
            )
          );
          // Turning one down was only ever possible from the API. Without it,
          // an unexpected request just sat in the list, and a list of requests
          // you cannot clear is how people end up approving one to be rid of it.
          row.appendChild(
            act(
              'Reject',
              'var(--danger)',
              guard(() => API.revokeDevice(device.id), 'Turned down.')
            )
          );
        } else if (!device.is_self && device.slot === state.session.slot) {
          // Approve is deliberately absent here: a device is let in by the
          // *other* person, so offering it on your own slot only produced a
          // button that failed at the server.
          row.appendChild(
            act(
              'Sign out',
              'var(--danger)',
              guard(() => API.revokeDevice(device.id), 'Signed that one out.')
            )
          );
        }
        sheet.appendChild(row);
      };

      const heading = (text) => {
        const node = el('div', 'sheet-title', text);
        node.style.cssText += ';margin-top:8px;color:var(--text);font-weight:600';
        sheet.appendChild(node);
      };

      if (state.pendingDevices.length) {
        const warn = el(
          'div',
          'sheet-title',
          '⚠ Only approve a device the other person is setting up right now, ' +
            'while you are talking to them. Approving one you did not expect ' +
            'lets it read everything sent from now on.'
        );
        warn.style.color = 'var(--danger)';
        sheet.appendChild(warn);
      }

      // Ownership was previously conveyed by list order alone — theirs first,
      // yours second, under one heading. Nothing on screen said which was
      // which, which is the one thing this list exists to make clear.
      if (theirs.length) {
        heading(theirTitle);
        theirs.forEach(render);
      }
      if (mine.length) {
        const active = mine.filter((d) => d.status === 'active').length;
        heading('Your devices');
        // Several at once is allowed, so say how many are in use and what
        // happens at the limit — otherwise signing in somewhere new looks like
        // it might silently evict something.
        const note = el(
          'div',
          'sheet-title',
          active >= 3
            ? `${active} signed in, which is the limit — the one you have not ` +
              'opened for longest makes way for the next.'
            : `${active} signed in. Up to 3 at once; sign one out here when you ` +
              'are done with it.'
        );
        sheet.appendChild(note);
        mine.forEach(render);
      }
    });
  }

  function openPinSheet(options) {
    const forced = options && options.forced;
    openSheet((sheet) => {
      sheet.appendChild(
        el(
          'div',
          'sheet-title',
          forced
            ? 'You joined with a one-time PIN that was sent to you over ' +
              'something else, so it is still sitting in that conversation. ' +
              'Pick your own before going any further.'
            : 'Changing this keeps every message — your keys live on the ' +
              'device, not behind the PIN.'
        )
      );
      const current = el('input');
      const next = el('input');
      [current, next].forEach((input, i) => {
        input.type = 'tel';
        input.inputMode = 'numeric';
        input.maxLength = PIN_LENGTH;
        input.placeholder = i ? 'New PIN' : 'Current PIN';
        input.style.cssText = PIN_INPUT_STYLE;
        sheet.appendChild(input);
      });
      if (forced) current.placeholder = 'The PIN you were sent';
      // A join PIN has a shelf life, and running out of it is not a soft
      // failure: `resolve_by_pin` skips an expired one, so the PIN pad simply
      // says "wrong PIN" forever after. Say the date while it can still be
      // acted on.
      if (forced && options.expiresAt) {
        const gone = Date.parse(options.expiresAt) < Date.now();
        const warn = el(
          'div',
          'sheet-title',
          gone
            ? 'That one-time PIN has already expired — it will not open this ' +
              'conversation again. This device is still signed in, so setting ' +
              'a new PIN here is the way back. Do it before signing out.'
            : 'It stops working ' +
              stamp(options.expiresAt) +
              '. After that it opens nothing, and a device already signed in ' +
              'is the only way back into this seat.'
        );
        warn.style.color = 'var(--danger)';
        sheet.appendChild(warn);
      }
      const save = el('button', 'act', forced ? 'Set my PIN' : 'Change PIN');
      save.style.justifyContent = 'center';
      save.addEventListener('click', async () => {
        try {
          await API.changePin({ current: current.value, next: next.value });
          closeSheet();
          if (forced) {
            // The old PIN is dead now, so the tokens issued under it are
            // re-fetched by signing in again with the new one.
            state.mustChangePin = false;
            // Reached from the lock screen, where "sign in again" means the
            // pad still has nothing to open — this device already proved who
            // it is via the token that authenticated the change itself, so
            // finish the job rather than hand them a keypad and ask for the
            // PIN they just chose.
            if (options.onChanged) return options.onChanged(next.value);
            toast('Done. Sign in with your new PIN.');
            return lockNow();
          }
          toast('PIN changed');
        } catch (err) {
          toast(
            (err.data && err.data.next && err.data.next[0]) || 'Could not change it'
          );
        }
      });
      sheet.appendChild(save);
    }, { locked: forced });
  }

  /* The one place this app lets somebody choose a credential rather than being
   * handed one. Every other seat exists because an admin or an already-seated
   * person made it; the very first person on a fresh deployment has neither,
   * so this is that missing step — a new, empty room with this browser as its
   * only seat. Reached from a link on the lock screen rather than the keypad,
   * since a keypad with nothing behind it yet is not something to guess at. */
  function openRegisterSheet() {
    let busy = false;
    openSheet((sheet) => {
      sheet.appendChild(
        el(
          'div',
          'sheet-title',
          'Choose a PIN and this becomes your own conversation, ready for you ' +
            'to invite the person you want to talk to. Nobody else needs to ' +
            'do anything first.'
        )
      );
      const pin = el('input');
      const confirm = el('input');
      [pin, confirm].forEach((input, i) => {
        // Masked, like the credential it is choosing — this is the one PIN
        // sheet where somebody is composing a brand-new secret rather than
        // typing back one they already know, so getting a look at it before
        // committing is worth a tap rather than a given.
        input.type = 'password';
        input.autocomplete = 'off';
        input.inputMode = 'numeric';
        input.maxLength = PIN_LENGTH;
        input.placeholder = i ? 'Confirm PIN' : 'Choose a PIN';
        input.style.cssText = PIN_INPUT_STYLE;
        sheet.appendChild(input);
      });

      const revealRow = el('div');
      revealRow.style.cssText = 'text-align:center;margin:-4px 0 10px';
      const reveal = el('button', null, 'Show');
      reveal.style.cssText = 'color:var(--accent);font-weight:600;padding:6px 10px';
      let revealed = false;
      reveal.addEventListener('click', () => {
        revealed = !revealed;
        // Toggling `type`, not `inputMode` — the numeric keypad on a phone has
        // nothing to do with whether the digits typed into it are masked.
        pin.type = confirm.type = revealed ? 'text' : 'password';
        reveal.textContent = revealed ? 'Hide' : 'Show';
      });
      revealRow.appendChild(reveal);
      sheet.appendChild(revealRow);

      const error = el('div', 'sheet-title');
      error.style.color = 'var(--danger)';
      sheet.appendChild(error);

      const create = el('button', 'act', 'Create account');
      create.style.justifyContent = 'center';
      create.addEventListener('click', async () => {
        if (busy) return;
        if (pin.value !== confirm.value) {
          error.textContent = 'Those two do not match.';
          return;
        }
        busy = true;
        error.textContent = '';
        create.textContent = 'Creating…';
        try {
          await registerWith(pin.value);
          closeSheet();
          toast('Account created. Invite someone from the menu when ready.');
        } catch (err) {
          error.textContent =
            (err.data && err.data.pin && err.data.pin[0]) ||
            (err.data && err.data.device && String(err.data.device[0] || err.data.device)) ||
            (err.offline && 'No connection') ||
            'Could not create that — try again';
        } finally {
          busy = false;
          create.textContent = 'Create account';
        }
      });
      sheet.appendChild(create);
    });
  }

  /* ==================================================================== *
   * Message actions
   * ==================================================================== */

  function setReply(message) {
    state.replyTo = message;
    $('reply-strip').style.display = 'flex';
    $('reply-text').textContent = preview(message);
    $('text').focus();
    buzz(10);
  }

  function clearReply() {
    state.replyTo = null;
    $('reply-strip').style.display = 'none';
  }

  function startEdit(message) {
    state.editing = message;
    $('edit-strip').style.display = 'flex';
    setTextOf($('text'), (message.body && message.body.text) || '');
    autogrow();
    $('text').focus();
    tickEditCountdown();
  }

  let editTimer;
  function tickEditCountdown() {
    clearInterval(editTimer);
    const paint = () => {
      if (!state.editing) return clearInterval(editTimer);
      const left = 300000 - (Date.now() - new Date(state.editing.createdAt).getTime());
      if (left <= 0) {
        toast('Edit window closed');
        return cancelEdit();
      }
      $('edit-note').textContent =
        `Editing · ${Math.floor(left / 60000)}:${String(Math.floor((left % 60000) / 1000)).padStart(2, '0')} left`;
    };
    paint();
    editTimer = setInterval(paint, 1000);
  }

  function cancelEdit() {
    clearInterval(editTimer);
    state.editing = null;
    $('edit-strip').style.display = 'none';
    setTextOf($('text'), '');
    autogrow();
  }

  async function commitEdit(text) {
    const message = state.editing;
    cancelEdit();
    if (!message) return;
    const body = Object.assign({}, message.body, { text });
    try {
      const envelopes = await sealFor(body, message.id);
      const result = await API.edit(message.id, { envelopes });
      message.body = body;
      message.editedAt = result.edited_at;
      await DB.putMessages([message]);
      refreshRow(message);
    } catch (err) {
      toast(err.status === 409 ? 'Edit window closed' : 'Could not edit');
    }
  }

  async function removeMessage(message) {
    try {
      await API.remove(message.id);
      message.deleted = true;
      message.body = null;
      await DB.putMessages([message]);
      refreshRow(message);
    } catch (e) {
      // The client-side window check above is what usually stops this from
      // being reached at all, but it reads a local clock and the server's
      // is what actually decides — so its own reason, when it gives one,
      // is worth showing rather than papering over with a generic failure.
      toast((e.data && e.data.detail) || 'Could not delete');
    }
  }

  async function hideLocally(message) {
    // Never reaches the server. "Delete for me" that quietly deleted the other
    // person's copy would be a lie.
    //
    // A flag kept on the row, not a row removed from the store. Deleting it
    // outright looked hidden right up until the next syncHistory — the
    // history endpoint has no idea this device ever hid anything, so it
    // handed the same message straight back, and ingest, finding no
    // `existing` copy to tell it otherwise, treated it as new and put it
    // back. The flag survives that: ingest's merge starts from whatever is
    // already on file and only overwrites the fields it explicitly names,
    // so hiddenForMe rides along through every future re-fetch.
    message.hiddenForMe = true;
    await DB.putMessages([message]);
    invalidateOrder();
    renderList();
  }

  /* Adds or removes one emoji from my reaction to a message.
   *
   * A person gets up to three. The server never sees any of them — the payload
   * is opaque ciphertext keyed by recipient device — so carrying a list rather
   * than a single emoji needed nothing of it: the row it keeps is still one per
   * sender per message, which is exactly what the unique constraint wants.
   *
   * Tapping one you already have takes it off, and taking off the last one
   * clears the reaction entirely, which an empty payload tells the server to do.
   */
  async function toggleReaction(message, emoji) {
    const current = myReactionList(message);
    let emojis;
    if (current.includes(emoji)) {
      emojis = current.filter((e) => e !== emoji);
    } else if (current.length >= MAX_REACTIONS) {
      return toast(`Three at most — tap one of yours to take it off`);
    } else {
      emojis = [...current, emoji];
      noteEmoji(emoji);
    }

    const payload = {};
    if (emojis.length) {
      for (const recipient of state.recipients) {
        const key = pairKeyFor(recipient.id);
        if (!key) continue;
        payload[recipient.id] = await C.sealMessage(
          key,
          { emojis },
          {
            messageId: message.id + '#reaction',
            senderDeviceId: state.device.id,
            recipientDeviceId: recipient.id,
          }
        );
      }
    }

    // Kept so a failed send can put it back, rather than leaving a reaction on
    // screen that the other person will never see.
    const before = (message.reactions || []).slice();
    message.reactions = (message.reactions || []).filter(
      (r) => String(r.device_id) !== String(state.device.id)
    );
    if (emojis.length) {
      message.reactions.push({ device_id: state.device.id, emojis });
    }
    refreshRow(message);

    /* Written to the store, not merely to the object on screen. The reaction
     * lived in memory and nowhere else, so a refresh reloaded the message from
     * disk without it — and since nothing in a reaction is addressed to its
     * sender, the server could not supply it either. */
    await DB.putMessages([message]).catch(() => {});

    try {
      await API.react(message.id, payload);
    } catch (e) {
      message.reactions = before;
      await DB.putMessages([message]).catch(() => {});
      refreshRow(message);
      toast('Reaction did not stick');
    }
  }


  /* ==================================================================== *
   * Profile broadcast
   * ==================================================================== */

  async function loadProfileSettings() {
    state.notifications = await notificationsActive();
    await loadLockSettings();
    await loadEmojiUses();
    // Shared across rooms: you are the same fish everywhere.
    const stored = await DB.profile(state.session.slot);
    state.me = stored || DEFAULT_PROFILE[state.session.slot] || { handle: 'Fish', emoji: '🐟' };
    const draft = await DB.get(DB.STORES.settings, 'draft');
    if (draft) {
      setTextOf($('text'), draft);
      autogrow();
    }
  }

  async function announceProfile() {
    try {
      if (!state.recipients.length) return;
      // Who was told, as well as what. The signature used to be the profile
      // alone, so a device that joined after the last announcement never heard
      // one — it saw "Reef" in the header and a nameless peer in Details, and
      // nothing short of renaming yourself would fix it. Re-announcing when the
      // recipient list changes costs one small message and is the only moment
      // the new device can be reached.
      const signature = JSON.stringify([
        state.me,
        state.recipients.map((r) => String(r.id)).sort(),
      ]);
      const last = await DB.get(DB.STORES.settings, 'me-announced');
      if (last === signature) return;
      const id = uuid();
      const body = {
        v: 1,
        type: 'profile',
        handle: state.me.handle,
        emoji: state.me.emoji,
      };
      const envelopes = await sealFor(body, id);
      await API.send({ id, kind: 'system', envelopes, attachment_ids: [] });
      await DB.put(DB.STORES.settings, signature, 'me-announced');
    } catch (e) {
      /* it will go out next time */
    }
  }

  /* ==================================================================== *
   * Live stream
   * ==================================================================== */

  function connectStream() {
    if (state.stream) state.stream.close();
    state.stream = API.createStream({
      onStatus: (status) => {
        state.online = status === 'online';
        paintHeader();
        watchSocketOutage(state.online);
        if (state.online) {
          // Every reconnection is a fresh chance for the far end to identify
          // itself, since it may have been redeployed while this was down.
          expectHello();
          syncHistory();
          flushOutbox();
          // The peer's state used to be re-asked for here, because any announce
          // made while this socket was down is gone. The hello frame carries it
          // now, and arrives unprompted a moment after this.
        } else {
          // Our own socket is down; we know nothing about them any more.
          state.peerLive = [];
          state.peerOnline = false;
        }
      },
      onEvent: handleEvent,
    });
    state.stream.connect();
  }

  let typingTimer;
  async function handleEvent(event) {
    switch (event.type) {
      /* The opening frame, and the whole reason nothing polls any more.
       *
       * It carries what the two timers used to fetch — the device list, the
       * session, who is swimming — so every reconnect is a full resync. Anything
       * missed while the socket was down is delivered on the way back in, which
       * is a stronger guarantee than a thirty-second poll ever gave, and the
       * watchdog in createStream is what makes sure a reconnect actually
       * happens. */
      case 'hello': {
        clearTimeout(helloTimer);
        helloTimer = null;
        // Proof the far end beats, so presence may be expired against those
        // beats and the polling fallback is not needed.
        state.serverBeats = true;
        disarmFallback();
        state.device = event.device || state.device;
        if (event.session) {
          state.session = Object.assign({}, state.session, event.session);
          await rememberAutoApprove();
        }
        if (event.devices) await applyDevices(event.devices);
        seedPresence();
        break;
      }

      // The delivered receipt is no longer sent from here. ingest confirms
      // everything it takes in, which covers this *and* the history sync that
      // used to acknowledge nothing.
      case 'msg.new': {
        await ingest([event.message]);
        // The unseen count and the pill are ingest's job now, shared with
        // syncHistory's own catch-up — this stays for the one thing that is
        // still specific to a live arrival: a haptic buzz regardless of
        // scroll position. A profile announcement is not a ripple, so it gets
        // neither; changing your fish used to tell the other person they had
        // a new message.
        const arrived = state.messages.get(event.message.id);
        if (!event.message.mine && !(arrived && isSystem(arrived))) {
          buzz(12);
        }
        break;
      }

      case 'msg.edit': {
        const message = state.messages.get(event.id);
        if (message) {
          message.editedAt = event.edited_at;
          message.body = await tryOpen({
            id: event.id,
            sender_device_id: message.senderDeviceId,
            envelope: event.envelope,
          });
          await DB.putMessages([message]);
          refreshRow(message);
        }
        break;
      }

      case 'msg.delete': {
        const message = state.messages.get(event.id);
        if (message) {
          message.deleted = true;
          message.body = null;
          await DB.putMessages([message]);
          refreshRow(message);
        }
        break;
      }

      case 'reaction': {
        const message = state.messages.get(event.message_id);
        if (!message) break;
        message.reactions = (message.reactions || []).filter(
          (r) => String(r.device_id) !== String(event.device_id)
        );
        if (!event.cleared) {
          const key = pairKeyFor(event.device_id);
          if (key) {
            try {
              const body = await C.openMessage(key, event, {
                messageId: event.message_id + '#reaction',
                senderDeviceId: event.device_id,
                recipientDeviceId: state.device.id,
              });
              const emojis = emojiOf(body);
              if (emojis.length) {
                message.reactions.push({ device_id: event.device_id, emojis });
              }
            } catch (e) {
              /* not for us */
            }
          }
        }
        await DB.putMessages([message]);
        refreshRow(message);
        break;
      }

      case 'receipt': {
        const message = state.messages.get(event.message_id);
        if (message) {
          const who = String(event.device_id);
          // Merged, not replaced, and compared as strings. A "read" event
          // carries no delivered_at, so replacing wholesale threw away the
          // delivery this device had already been told about — and an id that
          // arrived as a number one time and a string the next produced two
          // entries for the same device.
          const known =
            (message.receipts || []).find((r) => String(r.device_id) === who) || {};
          message.receipts = (message.receipts || []).filter(
            (r) => String(r.device_id) !== who
          );
          message.receipts.push({
            device_id: event.device_id,
            delivered_at: event.delivered_at || known.delivered_at || null,
            read_at: event.read_at || known.read_at || null,
          });
          await DB.putMessages([message]);
          refreshRow(message);
        }
        break;
      }

      case 'typing': {
        // The server drops the echo to the device that sent it, which was enough
        // while a person had one device. Your laptop's typing still reaches your
        // phone, where it read as the other person composing a reply.
        const who = String(event.device_id || '');
        if (!who || !peerRecipients().some((r) => String(r.id) === who)) break;
        state.peerTyping = event.is_typing;
        paintHeader();
        clearTimeout(typingTimer);
        if (event.is_typing) {
          typingTimer = setTimeout(() => {
            state.peerTyping = false;
            paintHeader();
          }, 4000);
        }
        break;
      }

      case 'presence': {
        // The announce goes to the whole room, this device included, and it was
        // applied without looking at whose it was — so a client showed the peer
        // as swimming on the strength of its own connection.
        const who = String(event.device_id || '');
        if (!who || who === String(state.device.id)) break;
        if (!peerRecipients().some((r) => String(r.id) === who)) break;

        // Arrives on connect, on disconnect, and now on every heartbeat, which
        // is what lets the countdown in markPeerLive stand in for the poll that
        // used to ask whether they were still there.
        if (event.status === 'online') markPeerLive(who, event.at, Date.now());
        else dropPeerLive(who, event.at);
        break;
      }

      // The toast is the nudge, not the record. refreshDevices puts a dot on
      // the menu and a banner over the thread, both of which survive the 2.6
      // seconds the toast lasts.
      case 'device.pending':
        await refreshDevices();
        toast('A new device wants in — check Devices');
        break;

      case 'device.approved':
      case 'device.revoked':
        await refreshDevices();
        await refreshKeys();
        break;
    }
  }

  /* ==================================================================== *
   * Push
   * ==================================================================== */

  /* Off means off: the subscription itself is dropped rather than a flag being
   * set somewhere the server might ignore. Nothing can then be delivered to this
   * device while the app is closed, which is the state the setting is for. The
   * endpoint dies with it and the server retires it on the next 410. */
  async function setNotifications(on) {
    await DB.setNotifications(on ? 'on' : 'off');
    if (on) {
      // The one place that may prompt, because this is a tap. It reports what
      // actually happened rather than announcing success either way — and puts
      // the setting back if it did not, so the bell never claims to be on while
      // nothing is subscribed.
      const ready = await subscribePush({ ask: true });
      if (ready) toast('Notifications on');
      else await DB.setNotifications('off');
      return ready;
    }
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) await subscription.unsubscribe();
    } catch (e) {
      /* nothing subscribed, or no push support: already silent */
    }
    toast('Notifications off — nothing will arrive while the app is closed');
  }

  // The stored preference: what the bell was last set to.
  const notificationsOn = async () => (await DB.notifications()) !== 'off';

  /* Whether notifications are actually going to arrive, which is the preference
   * *and* the browser's permission. The bell read the preference alone, so a
   * fresh device — where nothing has been granted and nothing is subscribed —
   * showed "Notifications on". */
  const notificationsActive = async () =>
    (await notificationsOn()) &&
    typeof Notification !== 'undefined' &&
    Notification.permission === 'granted';

  let pushBusy = false;

  /* Registers this device for push.
   *
   * `ask` is the whole design. requestPermission() used to run on every unlock,
   * so the browser's dialog reappeared each time — and a prompt nobody asked for
   * gets dismissed rather than answered, which leaves the permission at
   * "default" and lets it be asked again, until Chrome decides the repeated
   * dismissals mean no. That is the "it comes back, and only works on the third
   * try" loop.
   *
   * So it is only ever asked from a tap on the bell. An unlock re-subscribes
   * silently when permission has already been granted, and does nothing at all
   * otherwise. */
  async function subscribePush({ ask = false } = {}) {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      if (ask) toast('This browser cannot do notifications');
      return false;
    }
    if (!state.session || !state.session.vapid_public_key) return false;
    if (!(await notificationsOn())) return false;
    // Two of these at once means two dialogs, and the second one arrives after
    // the first has been answered — which is what made it look like Allow had
    // not worked.
    if (pushBusy) return false;
    pushBusy = true;

    try {
      if (Notification.permission === 'denied') {
        if (ask) {
          toast('Notifications are blocked for this site — allow them in the browser');
        }
        return false;
      }
      if (Notification.permission !== 'granted') {
        if (!ask) return false;
        if ((await Notification.requestPermission()) !== 'granted') {
          toast('Notifications not allowed');
          return false;
        }
      }

      const registration = await navigator.serviceWorker.ready;
      const existing = await registration.pushManager.getSubscription();
      const subscription =
        existing ||
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(state.session.vapid_public_key),
        }));
      const json = subscription.toJSON();
      await API.subscribePush({
        endpoint: subscription.endpoint,
        p256dh: json.keys.p256dh,
        auth: json.keys.auth,
        privacy: (await DB.get(DB.STORES.settings, 'privacy')) || 'hidden',
      });
      return true;
    } catch (e) {
      // Swallowed silently before, so a subscription that failed after the
      // permission was granted looked exactly like one that had worked.
      if (ask) toast('Could not turn notifications on — try once more');
      return false;
    } finally {
      pushBusy = false;
    }
  }

  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
  }

  /* ==================================================================== *
   * Auto-lock and the privacy screen
   * ==================================================================== */

  /* The five answers to "lock after".
   *
   * Two clocks, one choice. `idle` is on-screen idleness and `away` is how long
   * the app may sit in the background before coming back locked — and `away` is
   * looser on purpose, because switching to the camera to send a photo is not
   * the same as leaving the phone on a table. The old hardcoded pair was two
   * minutes and five, so '2m' is the default and nothing changes for anybody
   * who never opens the sheet.
   *
   * Keyed by what gets stored, so retuning any number here does not orphan the
   * devices that already chose it. Insertion order is display order.
   */
  const LOCK_PRESETS = {
    '1m': { label: '1 minute', idle: 60 * 1000, away: 60 * 1000 },
    '2m': { label: '2 minutes', idle: 2 * 60 * 1000, away: 5 * 60 * 1000 },
    '5m': { label: '5 minutes', idle: 5 * 60 * 1000, away: 10 * 60 * 1000 },
    '15m': { label: '15 minutes', idle: 15 * 60 * 1000, away: 30 * 60 * 1000 },
    // Infinity rather than a very large number: both timers test for it by name
    // and never arm at all, so nothing is left ticking to be wrong about.
    never: { label: 'Never', idle: Infinity, away: Infinity },
  };
  const LOCK_DEFAULT = '2m';
  // Falls back rather than trusting the stored key: a preset removed in a later
  // build must not leave a device with no lock at all.
  const lockPreset = () => LOCK_PRESETS[state.lockAfter] || LOCK_PRESETS[LOCK_DEFAULT];

  async function setLockAfter(key) {
    if (!LOCK_PRESETS[key]) return;
    state.lockAfter = key;
    await DB.setLockAfter(key).catch(() => {});
    // Immediately, not when the old one expires. Going from fifteen minutes to
    // one and then watching the app sit there for another fourteen looks like
    // the setting was ignored — and going the other way locks the sheet you are
    // still reading out from under you.
    idleReset();
  }

  async function setLockOnReopen(on) {
    state.lockOnReopen = !!on;
    await DB.setLockOnReopen(state.lockOnReopen).catch(() => {});
  }

  /* Both preferences, out of the vault and into state.
   *
   * Called from loadProfileSettings with the rest of them, and separately from
   * boot — the reopen decision is made before any room is entered, and
   * loadProfileSettings runs from inside enterRoom, which is several awaits too
   * late to be asked whether this load should have shown a PIN screen. */
  async function loadLockSettings() {
    const stored = await DB.lockAfter().catch(() => null);
    state.lockAfter = LOCK_PRESETS[stored] ? stored : LOCK_DEFAULT;
    state.lockOnReopen = !!(await DB.lockOnReopen().catch(() => false));
    // afterUnlock starts the idle clock before this has finished reading, so
    // the first timer of the session is armed on the default. Re-arm it on what
    // was actually stored; it is a no-op while the app is locked or hidden.
    idleReset();
  }

  async function forceRefresh() {
    // Escape hatch for a client stuck on an old build. Drops every cache and
    // unregisters the worker, so the next load comes entirely from the network.
    // Messages and keys live in IndexedDB and are untouched.
    try {
      if ('caches' in self) {
        const names = await caches.keys();
        await Promise.all(names.map((n) => caches.delete(n)));
      }
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map((r) => r.unregister()));
      }
    } catch (e) {
      /* nothing useful to do; the reload is the point */
    }
    location.reload();
  }

  /* Whether the PIN this device is locked behind can still open anything.
   *
   * A join PIN is checked once, at the exact moment it is typed into
   * `/unlock/` — nowhere else, on purpose, so a stranger probing PINs never
   * learns "that one exists but expired" versus "wrong". But this device
   * already proved who it is before it locked: it is still holding a live,
   * unrevoked token. For *that* token, telling it its own PIN has gone stale
   * leaks nothing to anybody else — it is telling a session about itself.
   *
   * Without this, the only way back once the PIN died was locking the phone
   * at all: the pad always re-derives through `/unlock/`, so a stored session
   * that was never signed out still hit the same dead end retyping the exact
   * PIN it unlocked with five minutes earlier. The fix that lets a PIN be
   * changed after it expires is worth nothing if nobody is ever told to use
   * it before they need it.
   */
  async function offerPinResetFromLock() {
    let sessions;
    try {
      sessions = await DB.sessions();
    } catch (e) {
      return;
    }
    for (const roomId of Object.keys(sessions)) {
      const session = sessions[roomId];
      if (!session || !session.token) continue;
      API.setToken(session.token);
      let result;
      try {
        result = await API.session();
      } catch (e) {
        continue; // offline, or this room's token no longer works — try the next
      }
      const info = result && result.session;
      if (!info || !info.must_change_pin) continue;
      // Found one. A PIN is per-identity, not per-room, so fixing it through
      // whichever room noticed is enough — every room this identity holds
      // comes back the moment `unlockWith` runs on the new PIN.
      $('lock-note').textContent =
        'This device is signed in, but the one-time PIN it was set up with ' +
        'needs replacing before it can unlock again.';
      return openPinSheet({
        forced: true,
        expiresAt: info.join_pin_expires_at,
        onChanged: (newPin) => unlockWith(newPin),
      });
    }
  }

  async function lockNow() {
    state.locked = true;
    idleStop();
    // Written before the screen changes, so a reload racing the tap still finds
    // it locked. The live socket goes too: a locked app has no business
    // heartbeating presence or taking delivery of anything.
    await DB.setLocked(true).catch(() => {});
    stopRoomTimers();
    if (state.stream) state.stream.close();
    state.stream = null;
    // Both sit above the lock screen in the stacking order, so leaving either
    // open would show the conversation through it.
    closeSearch();
    clearMatches();
    entry = '';
    paintDots();
    $('lock-note').textContent = '';
    noteOfflineLock();
    showScreen('lock');
    offerPinResetFromLock();
  }

  /* Says so when the PIN cannot be checked at all.
   *
   * There is no offline PIN check and deliberately never will be one: unlocking
   * re-derives through /unlock/, so on a plane the six correct digits come back
   * "No connection" and the app looks broken rather than merely locked. The
   * timers are not softened for it — an airplane-mode bypass is not a lock —
   * but the screen can at least say which of the two it is. */
  const OFFLINE_LOCK_NOTE = 'You will need a connection to unlock this device.';

  function noteOfflineLock() {
    if (navigator.onLine !== false) return;
    $('lock-note').textContent = OFFLINE_LOCK_NOTE;
  }

  /* Locks a conversation left open and untouched.
   *
   * Auto-lock only ever triggered on *returning* from somewhere else, so a
   * conversation left open on a desk stayed open indefinitely — the case where
   * somebody walks past and reads it.
   *
   * It counts only while the screen is actually in front of you: the timer stops
   * when the tab is hidden and starts again from zero on return, so switching
   * away is not itself a reason to lock.
   *
   * Deliberately only genuine input resets it. Scroll events fire from
   * `scrollToBottom` too, so a talkative peer would otherwise hold the session
   * open with nobody present.
   *
   * How long is LOCK_PRESETS' business now, and this is re-read on every reset
   * rather than captured once — the setting can change mid-session, and a timer
   * armed with the old number would outlive the choice that replaced it.
   */
  let idleTimer = null;

  function idleReset() {
    clearTimeout(idleTimer);
    // A room that skips peer approval for devices has, by the same
    // administrative decision, opted out of the idle lock too — it exists to
    // protect a conversation left open on a desk, which is not the shape of
    // an always-on agent channel.
    if (state.locked || document.visibilityState !== 'visible' ||
        (state.session && state.session.auto_approve_devices)) return;
    const after = lockPreset().idle;
    // "Never" is not a very long timeout: setTimeout clamps to a 32-bit delay
    // and would fire almost immediately on Infinity, which is the exact
    // opposite of what was asked for.
    if (!isFinite(after)) return;
    idleTimer = setTimeout(() => {
      if (!state.locked) lockNow();
    }, after);
  }

  function idleStop() {
    clearTimeout(idleTimer);
    idleTimer = null;
  }

  function watchIdle() {
    ['pointerdown', 'keydown', 'wheel', 'touchstart', 'input'].forEach((type) =>
      document.addEventListener(type, idleReset, { passive: true, capture: true })
    );
    idleReset();
  }

  function watchVisibility() {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        state.hiddenAt = Date.now();
        // Away is not idle: the clock stops rather than running down while you
        // are somewhere else.
        idleStop();
        // The app-switcher preview is a screenshot. Blank it.
        $('privacy').classList.add('on');
      } else {
        $('privacy').classList.remove('on');
        const skipsIdleLock = state.session && state.session.auto_approve_devices;
        const away = lockPreset().away;
        if (isFinite(away) && state.hiddenAt && Date.now() - state.hiddenAt > away &&
            !state.locked && !skipsIdleLock) {
          lockNow();
        } else {
          markVisibleRead();
          flushOutbox();
          // Coming back to the front is when the socket is most likely to have
          // died without saying so — timers were throttled the whole time it was
          // away, so the heartbeat that would notice may be most of a minute
          // off. Ask now rather than wait for it.
          if (state.stream) state.stream.poke();
          // Back on screen, so the idle clock starts again from zero.
          idleReset();
        }
        state.hiddenAt = null;
      }
    });
  }

  /* ==================================================================== *
   * Emoji panel
   * ==================================================================== */

  /* Which emoji this person actually reaches for.
   *
   * The catalogue is fixed and alphabetical-by-theme, so the one you send twenty
   * times a day sits wherever it happened to be listed. Counting use lets both
   * pickers lead with it, and the quick-react row stop being six constants
   * chosen before anybody had used the app.
   *
   * Counts are a local habit and never leave the device — nothing here is sent
   * anywhere, which also means the server learns nothing about what you like.
   */
  let emojiUses = {};
  let emojiSaveTimer = null;

  async function loadEmojiUses() {
    try {
      emojiUses = (await DB.emojiUses(state.session.slot)) || {};
    } catch (e) {
      emojiUses = {};
    }
  }

  function noteEmoji(emoji) {
    if (!emoji) return;
    emojiUses[emoji] = (emojiUses[emoji] || 0) + 1;
    // Tapping through a picker fires several of these; one write afterwards is
    // enough.
    clearTimeout(emojiSaveTimer);
    emojiSaveTimer = setTimeout(
      () => DB.setEmojiUses(emojiUses, state.session.slot).catch(() => {}),
      400
    );
  }

  /* Most used first, ties broken by the catalogue's own order so the list does
   * not shuffle between renders. */
  function topEmoji(count, fallback) {
    const known = Object.entries(emojiUses)
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([emoji]) => emoji);
    const out = [];
    for (const emoji of [...known, ...(fallback || [])]) {
      if (out.length >= count) break;
      if (!out.includes(emoji)) out.push(emoji);
    }
    return out;
  }

  /* ==================================================================== *
   * The emoji picker
   * ==================================================================== *
   *
   * One drawer, drawn into two places: the panel under the composer and the
   * sheet you get from ＋ on a message. Same catalogue, same search, same tab
   * you left it on — they used to be two nearly-identical loops, and the day
   * one of them grew a feature was the day they stopped being the same thing.
   *
   * The catalogue itself lives in emoji-data.js. It is ~1,400 glyphs now
   * rather than the ninety-six this app shipped with, which is what forced the
   * rest of the design below: ninety-six can all be in the DOM at once and
   * nobody notices, fourteen hundred cannot. */

  /* emoji-data.js is in the service worker's shell list and is a <script> tag
   * above this one, so in practice it is always here. The fallback is not
   * hypothetical though: a client can end up on a half-updated shell — new
   * app.js, cached index.html with no tag for the new file — and a bare
   * `ReefEmoji.categories` there is a ReferenceError at boot, i.e. an app that
   * will not start because its emoji list is missing. This costs it a picker
   * instead. */
  const CATALOGUE = (self.ReefEmoji && self.ReefEmoji.categories) || [];
  const EMOJI_INDEX = (self.ReefEmoji && self.ReefEmoji.index) || [];
  const EMOJI_NAME = new Map(EMOJI_INDEX.map((item) => [item.char, item.name]));

  // Enough to fill the visible grid several times over without ever being the
  // reason a keystroke feels slow. Typing "a" matches a few hundred names, and
  // nobody scrolls to the two hundredth result of "a" — they type a second
  // letter.
  const EMOJI_HITS = 120;

  /* Which tab the picker was left on. Deliberately shared by both surfaces and
   * kept across opens: picking 🥭 from Food, sending it, and going back for 🍇
   * meant scrolling to Food again every single time. */
  let emojiTab = 0;

  /* The catalogue with the person's own most-used at the head of it. Built on
   * each open rather than once at boot, or it would show the tally as it stood
   * when the app started — which is to say, before everything you sent today. */
  function emojiTabs() {
    const favourites = topEmoji(32, []);
    if (!favourites.length) return CATALOGUE;
    return [
      {
        name: 'Most used',
        icon: '🕘',
        items: favourites.map((char) => ({ char, name: EMOJI_NAME.get(char) || '' })),
      },
      ...CATALOGUE,
    ];
  }

  /* Name match, ordered by where in the name it hit.
   *
   * The rank is the whole point of this. "cat" is in the name of 🐱, and it is
   * also inside "identification" and "location" — 🪪 and 📍 are honest matches
   * and worth keeping findable, but they cannot be among the first things
   * offered to somebody who just typed the name of an animal. So: start of the
   * name beats the start of a later word, which beats buried inside a word.
   *
   * sort() is stable in every engine this runs on, so within a rank the
   * catalogue's own order holds and the grid does not reshuffle itself under
   * the thumb between one keystroke and the next. */
  function searchEmoji(query) {
    const ranked = [];
    for (const item of EMOJI_INDEX) {
      const at = item.name.indexOf(query);
      if (at < 0) continue;
      ranked.push({ item, rank: at === 0 ? 0 : item.name[at - 1] === ' ' ? 1 : 2 });
    }
    ranked.sort((a, b) => a.rank - b.rank);
    return ranked.slice(0, EMOJI_HITS).map((hit) => hit.item);
  }

  /* Draws the whole picker — search box, tab strip, grid — into `container`.
   *
   * options.pick(emoji)    what to do with a tap
   * options.picked(emoji)  optional, marks the ones already on a message
   */
  function buildEmojiPicker(container, options) {
    container.innerHTML = '';
    const tabs = emojiTabs();
    if (emojiTab >= tabs.length) emojiTab = 0;

    const query = el('input', 'emoji-q');
    query.type = 'search';
    query.placeholder = 'Search emoji…';
    query.autocomplete = 'off';
    query.spellcheck = false;
    query.setAttribute('autocorrect', 'off');
    query.setAttribute('aria-label', 'Search emoji');
    // Not focused on open. The panel exists so you can *browse*, and stealing
    // focus would raise the keyboard over the grid you came to look at.

    const strip = el('div', 'emoji-tabs');
    const scroll = el('div', 'emoji-scroll');

    /* One listener on the scroller, not one per button.
     *
     * The old picker bound a closure to each of its ninety-six buttons, which
     * was free. At two hundred-odd buttons per category, rebuilt on every tab
     * tap and every keystroke, it is two hundred closures and two hundred
     * listener registrations thrown away a moment later — the cost is in the
     * churn, not the count. The emoji is on the button, so the event already
     * carries everything the handler needs. */
    scroll.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-emoji]');
      if (!button) return;
      options.pick(button.dataset.emoji);
    });

    const drawGrid = (items) => {
      const grid = el('div', 'emoji-grid');
      // Into a fragment first: appending each button to a grid that is already
      // on screen is a layout pass per emoji, and at this size that is the
      // difference between the panel appearing and the panel arriving.
      const batch = document.createDocumentFragment();
      items.forEach((item) => {
        const button = el('button', null, item.char);
        button.type = 'button';
        button.dataset.emoji = item.char;
        if (item.name) button.title = item.name;
        if (options.picked && options.picked(item.char)) button.classList.add('picked');
        batch.appendChild(button);
      });
      grid.appendChild(batch);
      return grid;
    };

    /* Only ever one category in the DOM at a time. Every category at once is
     * fourteen hundred buttons, and a panel that takes a visible beat to open
     * is a panel you stop reaching for. */
    const render = () => {
      const text = query.value.trim().toLowerCase();
      strip.classList.toggle('dim', !!text);
      scroll.innerHTML = '';
      scroll.scrollTop = 0;
      if (text) {
        const hits = searchEmoji(text);
        if (!hits.length) {
          scroll.appendChild(el('div', 'emoji-head', 'Nothing matches that'));
          return;
        }
        scroll.appendChild(
          el('div', 'emoji-head', hits.length >= EMOJI_HITS ? 'Closest matches' : 'Matches')
        );
        scroll.appendChild(drawGrid(hits));
        return;
      }
      const tab = tabs[emojiTab];
      if (!tab) return;
      scroll.appendChild(el('div', 'emoji-head', tab.name));
      scroll.appendChild(drawGrid(tab.items));
    };

    tabs.forEach((tab, i) => {
      const button = el('button', i === emojiTab ? 'on' : null, tab.icon);
      button.type = 'button';
      button.title = tab.name;
      button.setAttribute('aria-label', tab.name);
      button.addEventListener('click', () => {
        emojiTab = i;
        // A tab tap is a request to see that tab, so it has to drop whatever
        // is in the search box — otherwise the strip highlights Food and the
        // grid goes on showing the results for "heart".
        query.value = '';
        Array.from(strip.children).forEach((node, j) => node.classList.toggle('on', j === i));
        render();
      });
      strip.appendChild(button);
    });

    // No debounce. The message search has one because it walks every message
    // on the device; this walks fourteen hundred short strings and caps what it
    // draws, so a keystroke is cheaper than the timer would be.
    query.addEventListener('input', render);
    query.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || !query.value) return;
      // Escape empties the box before it does anything else — in the sheet the
      // next Escape closes the sheet, and losing the whole picker when you
      // meant to clear four letters is a long way back.
      event.stopPropagation();
      query.value = '';
      render();
    });

    container.appendChild(query);
    container.appendChild(strip);
    container.appendChild(scroll);
    render();

    /* The strip is a sideways scroller and the tab we are showing is remembered
     * across opens, so reopening on Flags drew the strip at its left-hand end
     * with the one lit tab somewhere off the right — which reads as no tab lit
     * at all, under a grid of flags. Set scrollLeft directly rather than call
     * scrollIntoView, which is entitled to scroll every ancestor too and does:
     * in the sheet it dragged the sheet itself. */
    const active = strip.children[emojiTab];
    if (active) strip.scrollLeft = active.offsetLeft - (strip.clientWidth - active.offsetWidth) / 2;
  }

  function buildEmoji() {
    buildEmojiPicker($('emoji'), {
      pick: (emoji) => {
        const box = $('text');
        setTextOf(box, textOf(box) + emoji);
        noteEmoji(emoji);
        autogrow();
        saveDraft();
      },
    });
  }

  /* ==================================================================== *
   * Search
   * ==================================================================== *
   *
   * Entirely local, and not as a shortcut: the server holds ciphertext and no
   * key, so there is no word of this it could index even if it wanted to. What
   * this device has decrypted and stored is the whole of the corpus.
   *
   * It reads IndexedDB rather than `state.messages`, which is deliberate — the
   * thread keeps only the most recent few hundred in memory, and a search that
   * silently stopped at the edge of the scrollback would be worse than none:
   * "no results" would be indistinguishable from "not loaded yet". */

  // Every message on this device, read once when search opens. Held only for
  // the life of the panel, so a long conversation is not pinned in memory.
  let searchRows = null;
  let searchTimer = null;
  const SEARCH_LIMIT = 200;

  // The last result set, kept alive *after* the panel closes. Without this,
  // finding the seventeenth mention of something meant going back to the list
  // and starting again for every one of them. Chronological, so ↑ is reliably
  // "further back" and the counter reads the same way round as the thread.
  let matches = [];
  let matchAt = -1;
  let matchQuery = '';
  let searchHits = [];
  let searchQuery = '';

  /* What a message offers up to a search: what was said, plus the names of
   * anything attached. A file you sent is often the only thing you remember
   * about the message that carried it. */
  function searchableText(message) {
    if (message.deleted || isSystem(message)) return '';
    const body = message.body || {};
    if (body.undecryptable) return '';
    const names = (body.files || []).map((f) => f.name || '').join(' ');
    return `${body.text || ''} ${names}`.trim();
  }

  async function openSearch() {
    const panel = $('search');
    panel.classList.add('on');
    $('search-input').value = '';
    $('search-results').innerHTML = '';
    $('search-note').textContent = 'Reading this device…';
    try {
      searchRows = (await DB.all(DB.STORES.messages)) || [];
    } catch (e) {
      // The store is scoped to the open room, so falling back to memory keeps
      // search working rather than failing shut.
      searchRows = [...state.messages.values()];
    }
    const count = searchRows.filter((m) => searchableText(m)).length;
    $('search-note').textContent = `${count} message${count === 1 ? '' : 's'} on this device.`;
    $('search-input').focus();
  }

  function closeSearch() {
    $('search').classList.remove('on');
    $('search-input').blur();
    clearTimeout(searchTimer);
    // Read before this runs by jumpTo, which is the only caller that needs it.
    searchRows = null;
    searchHits = [];
    searchQuery = '';
  }

  function runSearch(raw) {
    const query = raw.trim().toLowerCase();
    const results = $('search-results');
    results.innerHTML = '';
    if (!query) {
      const total = (searchRows || []).filter((m) => searchableText(m)).length;
      $('search-note').textContent = `${total} message${total === 1 ? '' : 's'} on this device.`;
      return;
    }

    const hits = [];
    for (const message of searchRows || []) {
      const text = searchableText(message);
      if (text && text.toLowerCase().includes(query)) hits.push({ message, text });
    }
    // Held chronologically, because that is the order the thread will be walked
    // in. The list below reverses a copy — newest first is right for reading
    // results, and wrong for stepping through them.
    hits.sort((a, b) => (a.message.seq || 0) - (b.message.seq || 0));
    searchHits = hits;
    searchQuery = query;

    if (!hits.length) {
      $('search-note').textContent = 'Nothing matches that.';
      return;
    }
    const shown = [...hits].reverse().slice(0, SEARCH_LIMIT);
    $('search-note').textContent =
      hits.length > shown.length
        ? `${hits.length} matches — newest ${shown.length} listed, all ${hits.length} walkable.`
        : `${hits.length} match${hits.length === 1 ? '' : 'es'}.`;

    shown.forEach(({ message, text }) => {
      const row = el('button', 'hit');
      row.type = 'button';
      const who = el('div', 'hit-who');
      who.appendChild(el('b', null, message.mine ? 'You' : whoIs(message.senderDeviceId)));
      who.appendChild(el('span', null, stamp(message.createdAt)));
      row.appendChild(who);
      row.appendChild(snippet(text, query));
      row.addEventListener('click', () => jumpTo(message.id));
      results.appendChild(row);
    });
  }

  /* The match in its context, with the query marked.
   *
   * Assembled from text nodes and <mark> elements rather than an innerHTML
   * string. In an end-to-end encrypted messenger a message body is the most
   * hostile input there is — it arrives from another device and nothing in
   * between has looked at it — so it never becomes markup. */
  function snippet(text, query) {
    const at = text.toLowerCase().indexOf(query);
    const from = Math.max(0, at - 40);
    const clipped =
      (from ? '…' : '') +
      text.slice(from, from + 180) +
      (from + 180 < text.length ? '…' : '');

    const node = el('div', 'hit-text');
    const lower = clipped.toLowerCase();
    let index = 0;
    for (;;) {
      const found = lower.indexOf(query, index);
      if (found < 0) break;
      if (found > index) {
        node.appendChild(document.createTextNode(clipped.slice(index, found)));
      }
      node.appendChild(el('mark', null, clipped.slice(found, found + query.length)));
      index = found + query.length;
    }
    node.appendChild(document.createTextNode(clipped.slice(index)));
    return node;
  }

  /* Opens the thread at a result, and keeps the rest of the set to hand.
   *
   * A hit is very often older than the window the thread is holding, so the
   * rows read out of IndexedDB are merged in first — without overwriting
   * anything already in memory, which may carry a state the stored copy does
   * not. */
  function jumpTo(id) {
    (searchRows || []).forEach((m) => {
      if (!state.messages.has(m.id)) {
        state.messages.set(m.id, m);
        invalidateOrder();
      }
    });
    matches = searchHits.map((h) => h.message.id);
    matchQuery = searchQuery;
    matchAt = Math.max(0, matches.indexOf(id));
    closeSearch();
    goToMatch();
  }

  /* Centres the window on one message.
   *
   * This used to widen the window until it reached back far enough, which for a
   * match from March meant rendering March to today — the thing the cap exists
   * to prevent. Moving the window costs the same whatever the distance. */
  function revealMessage(id) {
    const rows = ordered();
    const index = rows.findIndex((m) => m.id === id);
    if (index < 0) return null;
    state.view.count = WINDOW_SPAN;
    // Centred where there is room on both sides. The upper clamp is what keeps a
    // window full: without it, a match near the oldest message pushed `end` below
    // the cap and rendered a stunted window with the match jammed against the
    // top of it.
    const centred = rows.length - index - Math.ceil(WINDOW_SPAN / 2);
    state.view.tail = Math.max(0, Math.min(centred, Math.max(0, rows.length - WINDOW_SPAN)));
    state.stickBottom = false;
    renderList();
    return (
      [...$('list').children].find((n) => n.dataset && n.dataset.id === id) || null
    );
  }

  /* Scrolls to one message and marks it, wherever it is in the thread.
   *
   * Shares revealMessage with search, so a reply from months ago costs a moved
   * window rather than rendering everything since. The mark is cleared on the
   * next jump rather than by a timer: a flash would be over before a smooth
   * scroll across a long thread had finished. */
  async function goToMessage(id) {
    if (!id) return;
    const previous = $('list').querySelector('.bubble.found');
    if (previous) previous.classList.remove('found');

    // Already on screen — or at least already rendered — needs nothing
    // revealed. revealMessage recentres a 200-row window on the target
    // regardless of whether the current one already holds it, which is why
    // replying to a message one screen up scrolled as far as one from March:
    // the window underneath it was rebuilt into an unrelated position before
    // scrollIntoView ever ran, so the "short hop" it then made was short
    // relative to that new position, not to where the reader actually was.
    let row = [...$('list').children].find((n) => n.dataset && n.dataset.id === id);
    if (!row) row = revealMessage(id);
    if (!row) {
      // Not in memory, which is not the same as not here: the thread holds only
      // the most recent few hundred, and a reply can point at something far
      // older that the store still has. Its neighbours come too, or it would
      // arrive stranded between messages from months later.
      row = await pullFromStore(id);
    }
    if (!row) {
      // Genuinely beyond this device — pruned, or from before it was approved.
      return toast('That message is not on this device');
    }
    row.scrollIntoView({ block: 'center', behavior: 'smooth' });
    const bubble = row.querySelector('.bubble');
    if (bubble) bubble.classList.add('found');
    buzz(8);
  }

  /* Lifts one message and its neighbours off disk into the thread, then reveals
   * it. Returns null when the store does not have it either. */
  async function pullFromStore(id) {
    try {
      const anchor = await DB.get(DB.STORES.messages, id);
      if (!anchor || !anchor.seq) return null;
      const nearby = await DB.messagesAround(anchor.seq, 60);
      let added = 0;
      for (const message of nearby.length ? nearby : [anchor]) {
        if (!state.messages.has(message.id)) {
          state.messages.set(message.id, message);
          added += 1;
        }
      }
      if (added) invalidateOrder();
      return revealMessage(id);
    } catch (e) {
      return null;
    }
  }

  function goToMatch() {
    if (matchAt < 0 || matchAt >= matches.length) return clearMatches();
    // The outline is persistent rather than a flash: it marks where you are in
    // the set, and a flash would have faded by the time the scroll settled.
    const previous = $('list').querySelector('.bubble.found');
    if (previous) previous.classList.remove('found');

    const row = revealMessage(matches[matchAt]);
    paintMatchBar();
    if (!row) return toast('That message is not here any more');
    row.scrollIntoView({ block: 'center', behavior: 'smooth' });
    const bubble = row.querySelector('.bubble');
    if (bubble) bubble.classList.add('found');
  }

  function stepMatch(delta) {
    if (!matches.length) return;
    const next = matchAt + delta;
    if (next < 0 || next >= matches.length) return;
    matchAt = next;
    buzz(8);
    goToMatch();
  }

  function paintMatchBar() {
    const bar = $('match-bar');
    if (!matches.length) {
      bar.style.display = 'none';
      return;
    }
    bar.style.display = 'flex';
    $('match-note').textContent =
      `${matchAt + 1} of ${matches.length} · “${matchQuery}”`;
    // Ends of the set are disabled rather than wrapping. Silently looping back
    // to the top reads as "it did nothing" the first time it happens.
    $('match-prev').disabled = matchAt <= 0;
    $('match-next').disabled = matchAt >= matches.length - 1;
  }

  function clearMatches() {
    matches = [];
    matchAt = -1;
    matchQuery = '';
    const marked = $('list').querySelector('.bubble.found');
    if (marked) marked.classList.remove('found');
    paintMatchBar();
  }

  /* ==================================================================== *
   * Wiring
   * ==================================================================== */

  /* $(id).addEventListener(...), except a missing id skips its own binding
   * instead of throwing — which, unhandled, would abort every binding still
   * to come in whichever function called this, not just the one that was
   * actually missing. */
  function bindSafely(id, type, handler) {
    const target = $(id);
    if (!target) return;
    target.addEventListener(type, handler);
  }

  function wire() {
    $('text').addEventListener('input', onTyping);
    $('text').addEventListener('blur', stopTyping);
    $('text').addEventListener('focus', () => {
      $('emoji').classList.remove('on');
      setTimeout(() => state.stickBottom && scrollToBottom(false), 250);
    });
    $('text').addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey && window.innerWidth > 720) {
        event.preventDefault();
        onSend();
      }
    });
    $('send').addEventListener('click', onSend);
    $('emoji-btn').addEventListener('click', () => {
      const panel = $('emoji');
      const opening = !panel.classList.contains('on');
      /* Drawn on the way in rather than once at boot.
       *
       * Two reasons, and the second only became one when the catalogue grew.
       * The panel leads with your most used, and a tally read at startup is
       * yesterday's tally — the panel spent a whole session offering the six
       * you liked last week. And building it here keeps a few hundred buttons
       * off the boot path, which now matters: the app used to build ninety-six
       * of them before the lock screen had even drawn.
       *
       * Shown first, then built — the picker measures the tab strip to scroll
       * the live tab into view, and a display:none panel measures zero. */
      panel.classList.toggle('on', opening);
      if (opening) buildEmoji();
    });
    $('attach').addEventListener('click', () => $('file-input').click());
    $('file-input').addEventListener('change', (event) => {
      onFiles(event.target.files);
      event.target.value = '';
    });
    // Pasting a screenshot or a copied file. Bound to the document rather than
    // the textarea: a file copied in the OS gets pasted with Ctrl+V on arrival,
    // without clicking into the box first, and a listener on #text only ever
    // hears it while #text has focus — which is why binding it there did
    // nothing. clipboardData.files is empty for text, so an ordinary paste
    // falls through untouched wherever it lands.
    document.addEventListener('paste', (event) => {
      if (!$('pool').classList.contains('on')) return;
      const files = event.clipboardData && event.clipboardData.files;
      if (files && files.length) {
        event.preventDefault();
        return onFiles(files);
      }
      // #text is contenteditable="true" rather than "plaintext-only" (see
      // index.html) so an IME's media-insertion commit isn't silently
      // rejected, which means nothing upstream strips formatting for us — a
      // paste from a formatted source would otherwise carry its fonts/colors
      // straight in. Force plain text here instead. Scoped to #text
      // specifically so a paste into #search-input, say, is left to its
      // native handling.
      if (event.target === $('text') && event.clipboardData) {
        event.preventDefault();
        document.execCommand('insertText', false, event.clipboardData.getData('text/plain'));
      }
    });
    // Drag-and-drop, also on the document rather than #pool. A drop that lands
    // even slightly outside the thread would otherwise hit the browser default
    // and navigate the tab to the dropped file, losing whatever was composed —
    // so every file drop is swallowed here, and only acted on over the chat.
    // dragenter/dragleave fire once per element crossed, so a depth counter is
    // what distinguishes moving between children from leaving altogether.
    (() => {
      const overlay = $('drag-overlay');
      let dragDepth = 0;
      const carriesFiles = (event) =>
        !!event.dataTransfer && [...event.dataTransfer.types].includes('Files');
      const onChat = () => $('pool').classList.contains('on');
      document.addEventListener('dragenter', (event) => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        dragDepth++;
        if (onChat()) overlay.classList.add('on');
      });
      // Without preventDefault here the drop event never fires at all.
      document.addEventListener('dragover', (event) => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
      });
      document.addEventListener('dragleave', (event) => {
        if (!carriesFiles(event)) return;
        dragDepth = Math.max(0, dragDepth - 1);
        if (dragDepth === 0) overlay.classList.remove('on');
      });
      document.addEventListener('drop', (event) => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        dragDepth = 0;
        overlay.classList.remove('on');
        if (onChat()) onFiles(event.dataTransfer.files);
      });
    })();
    $('reply-cancel').addEventListener('click', clearReply);
    $('edit-cancel').addEventListener('click', cancelEdit);
    $('select-cancel').addEventListener('click', exitSelectMode);
    $('select-hide').addEventListener('click', bulkHideForMe);
    $('select-delete').addEventListener('click', bulkDeleteForEveryone);

    // Search moved into the menu (below) — a header button is prime real
    // estate, and locking is something you reach for in a hurry, which
    // finding a conversation from is not.
    //
    // bindSafely rather than $(id).addEventListener from here on: this whole
    // cluster is menu, search and the viewer — none of them foundational, all
    // of them added or renamed at different times — and $(id) on a stale or
    // renamed id returns null, whose .addEventListener throws and silently
    // aborts every binding still to come in this function. That is exactly
    // how a rename in one file landing a beat behind the other (a deploy where
    // index.html and app.js were briefly out of sync — see sw.js) took the
    // menu button down along with the one that was actually renamed: #menu
    // was wired several lines after the element that no longer existed.
    bindSafely('lock-btn', 'click', lockNow);
    bindSafely('search-close', 'click', closeSearch);
    bindSafely('search-input', 'input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => runSearch($('search-input').value), 140);
    });
    bindSafely('search-input', 'keydown', (event) => {
      if (event.key === 'Escape') return closeSearch();
      if (event.key !== 'Enter') return;
      event.preventDefault();
      // Enter goes straight to the newest match — the one the list puts first,
      // and nine times in ten the one being looked for.
      clearTimeout(searchTimer);
      runSearch($('search-input').value);
      if (searchHits.length) jumpTo(searchHits[searchHits.length - 1].message.id);
    });
    bindSafely('match-prev', 'click', () => stepMatch(-1));
    bindSafely('match-next', 'click', () => stepMatch(1));
    bindSafely('match-close', 'click', clearMatches);
    bindSafely('menu', 'click', openMenuSheet);
    bindSafely('device-banner', 'click', openDevicesSheet);
    bindSafely('scrim', 'click', () => {
      if (!sheetLocked) closeSheet();
    });
    bindSafely('viewer-close', 'click', closeViewer);
    bindSafely('viewer', 'click', (event) => {
      // A pinch or a pan ends in a click. Closing on it would mean the viewer
      // shut itself the moment you finished moving the picture.
      if ($('viewer')._swallowClick) {
        $('viewer')._swallowClick = false;
        return;
      }
      if (event.target.id === 'viewer') closeViewer();
    });
    // The other way out, for a keyboard. The viewer first: it sits above the
    // sheet, so it is the thing in front of you when both are open. Bound to
    // document, so nothing here can be missing — kept safe anyway since it
    // reaches into #viewer and #sheet, and one of those going away should
    // still leave the other's shortcut working.
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      try {
        if ($('viewer').classList.contains('on')) return closeViewer();
        if ($('sheet').classList.contains('on') && !sheetLocked) closeSheet();
      } catch (e) {
        /* one of the two is missing; the other still gets a chance next key */
      }
    });
    $('lock-register').addEventListener('click', openRegisterSheet);
    // Re-runs unlock with the *same* device id, so the server can reconsider a
    // pending device — which it does while the conversation is still empty and
    // nobody exists yet to approve anyone. Deliberately does not clear
    // IndexedDB: wiping the keypair here would strand an orphan device row and
    // throw away the identity for no reason.
    $('pending-retry').addEventListener('click', () => {
      stopWaitingForApproval();
      lockNow();
    });
    /* Erasing is right for "this browser is not mine any more" and wrong for
     * "I am stuck on this screen" — and the second is much the commoner reason
     * to be reading it. They were one unguarded tap apart, and the tap takes
     * the keypair: the server matches this browser by its public key, so the
     * next PIN generates a fresh one and enrols as a *new device*, pending all
     * over again, while the room databases it just deleted took every message
     * this device held. That is the "why did it register a new device and lose
     * my history" report. Ask which of the two it is, and say what it costs. */
    $('pending-signout').addEventListener('click', () => {
      openSheet((sheet) => {
        sheet.appendChild(el('div', 'sheet-title', 'Erase this device?'));
        const note = el(
          'div',
          'sheet-title',
          'This deletes every message stored here and this browser’s key. ' +
            'Signing in again joins as a brand new device, which the other ' +
            'person has to approve — and the history does not come back. ' +
            'Only do this if you are giving the device away.'
        );
        note.style.color = 'var(--danger)';
        sheet.appendChild(note);

        const choice = (label, color, fn) => {
          const button = el('button', 'act', label);
          button.style.cssText = `justify-content:center;color:${color};font-weight:600`;
          button.addEventListener('click', fn);
          sheet.appendChild(button);
        };
        choice('Erase it', 'var(--danger)', () => {
          closeSheet();
          signOut();
        });
        choice('Keep waiting', 'var(--muted)', closeSheet);
      });
    });

    // The pad was tappable and nothing else, so on a laptop typing the PIN on
    // the number row did nothing at all.
    document.addEventListener('keydown', (event) => {
      if (!$('lock').classList.contains('on')) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      // `#lock` stays "on" underneath a sheet — the register sheet's own PIN
      // inputs are opened right on top of it. Without this, every digit typed
      // into "Choose a PIN" was preventDefault()-ed here first: it never
      // reached the input, and landed in the lock screen's dots instead —
      // typing appeared to go to the wrong box because it was.
      const target = document.activeElement;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) {
        return;
      }
      if (/^[0-9]$/.test(event.key)) {
        event.preventDefault();
        onKey(event.key);
      } else if (event.key === 'Backspace') {
        event.preventDefault();
        onKey('⌫');
      }
    });

    const scroller = $('scroller');
    scroller.addEventListener(
      'scroll',
      () => {
        const distance =
          scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
        // The foot of a trimmed window is not the foot of the conversation, so
        // sticking to the bottom means both.
        state.stickBottom = !state.view.tail && distance < 120;
        if (state.stickBottom && state.unseen) {
          state.unseen = 0;
          paintPill();
        }
        if (scroller.scrollTop < 600) growOlder();
        else if (distance < 600 && state.view.tail) growNewer();
      },
      { passive: true }
    );

    window.addEventListener('online', () => {
      flushOutbox();
      if (state.stream) state.stream.connect();
      // The note explaining why the PIN cannot be checked outlives the reason
      // for it otherwise, and stale advice on a lock screen is worse than none.
      if ($('lock-note').textContent === OFFLINE_LOCK_NOTE) {
        $('lock-note').textContent = '';
      }
    });
  }

  let growing = false;
  /* Older, on scrolling up. Once the window reaches the oldest message held, the
   * next page comes from the server. */
  async function growOlder() {
    if (growing) return;
    growing = true;
    try {
      const rows = ordered();
      if (viewBounds(rows).start === 0) {
        // The whole thread is on screen and the server has none left to give.
        if (reachedOldest) return;
        log('growOlder.fetch', { thread: rows.length, count: state.view.count, tail: state.view.tail });
        await loadOlder();
        return;
      }
      state.view.count += PAGE_ROWS;
      trimView();
      log('growOlder.widen', {
        thread: rows.length,
        count: state.view.count,
        tail: state.view.tail,
      });
      renderList(true);
    } finally {
      /* The guard now covers widening too, and is released a frame later rather
       * than at once. Only the server fetch was ever guarded, so a touch fling
       * — which emits scroll events far faster than the layout reacting to them
       * can settle — widened the window dozens of times before the reader saw
       * any of it, arriving hundreds of messages back from a single flick. One
       * page per frame keeps the growth tied to what is actually on screen. */
      requestAnimationFrame(() => {
        growing = false;
      });
    }
  }

  /* Newer, on scrolling back down. Only reachable when the cap has pushed the
   * window off the end of the thread — otherwise there is nothing newer to show. */
  function growNewer() {
    if (!state.view.tail) return;
    state.view.tail = Math.max(0, state.view.tail - PAGE_ROWS);
    log('growNewer', { count: state.view.count, tail: state.view.tail });
    renderList(true);
  }

  /* ==================================================================== *
   * Boot
   * ==================================================================== */

  async function boot() {
    /* Whether *this tab* has ever actually gotten past the lock screen.
     *
     * sessionStorage is per tab and dies with it, so this is the closest thing
     * to "was the app already open". The key is only ever written once this
     * tab genuinely reaches an unlocked room — see markUnlockedThisTab, called
     * from both the direct-resume branch below and from enterFromResult (the
     * PIN-accepted path) — never here at the top, unconditionally, which is
     * what this used to do and why it didn't work: reading it that early wrote
     * it too, so a relock screen was itself enough to mark the tab "unlocked",
     * and reloading that same lock screen read its own mark back and walked
     * straight past itself. Read before anything else because a great deal
     * below reloads the page. */
    let sameSession = false;
    try {
      sameSession = sessionStorage.getItem('reef-unlocked') === '1';
    } catch (e) {
      // Storage blocked entirely, which private mode does. Every load then
      // reads as a fresh open — erring towards asking for the PIN, which is
      // the direction to be wrong in.
    }

    buildDots();
    buildKeypad();
    // buildEmoji() is not here any more — the picker is drawn the first time
    // the ☺ is tapped, so its "most used" is the tally as it stands then and
    // not as it stood at boot.
    wire();
    trackKeyboard();
    watchVisibility();
    watchIdle();

    if ('serviceWorker' in navigator) {
      /* Take the new shell as soon as there is one.
       *
       * The worker already calls skipWaiting and clients.claim, so a new build
       * installs and takes over straight away — but that decides who answers
       * the *next* request, not what the page is currently running. An app
       * left open, or reopened from the launcher without a hard refresh, went
       * on running the shell it parsed however many builds ago, and every fix
       * sat there unused until somebody thought to pull down. Which is not a
       * thing to ask of the person the fix is for.
       *
       * Guarded on there having been a controller already: the first
       * registration on a fresh install fires this too, and reloading a page
       * that has only just started is a loop. */
      const hadController = !!navigator.serviceWorker.controller;
      let takingOver = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!hadController || takingOver) return;
        takingOver = true;
        location.reload();
      });
      // An open tab never asks again on its own, so a phone that lives in the
      // app switcher for a week would never see any of this. Coming back to
      // the foreground is the natural moment to check.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') return;
        navigator.serviceWorker
          .getRegistration()
          .then((reg) => reg && reg.update())
          .catch(() => {});
      });
      navigator.serviceWorker.register('./sw.js').catch(() => {});
      // Neither of the worker's two messages had anyone listening. Background
      // sync posted flush-outbox into the void, and the build stamp it answers
      // with was never asked for — so "which build am I running?" had no answer
      // on the one screen that could show it.
      navigator.serviceWorker.addEventListener('message', (event) => {
        const data = event.data;
        if (data && data.type === 'flush-outbox') flushOutbox();
        else if (data && data.type === 'build') state.build = data.build;
      });
      navigator.serviceWorker.ready
        .then((registration) => {
          const worker = registration.active || navigator.serviceWorker.controller;
          if (worker) worker.postMessage('build');
        })
        .catch(() => {});
    }

    API.onUnauthorized(() => {
      // 401 means the device is gone for good, as opposed to 403 which only
      // means "not approved yet". Wipe rather than sit on dead state.
      //
      // Say why, though. This fires when a replacement device is approved —
      // one active device per person, so the old one is retired — and the
      // wipe-and-reload that followed looked like the app had lost the
      // conversation for no reason. sessionStorage survives the reload and is
      // not what gets wiped, which IndexedDB is.
      try {
        sessionStorage.setItem(
          'reef-signed-out',
          'This device was signed out. Your messages are still here — enter ' +
            'your PIN to use it again.'
        );
      } catch (e) {
        /* private mode: the reload will just be silent */
      }
      signOut({ keepHistory: true });
    });

    const sessions = await DB.sessions();
    const roomIds = Object.keys(sessions);
    // Prefer a room this device is actually approved in; a pending one can
    // only show the waiting screen. Decided up here rather than inside the
    // branch, because the reopen check below needs to know which room it would
    // be resuming into before it can say whether to resume at all.
    const roomId =
      roomIds.find((id) => sessions[id].status === 'active') || roomIds[0];
    // A lock has to survive the page. Otherwise "Lock now" and the five-minute
    // auto-lock only hid the screen, and pull-to-refresh — or simply reopening
    // the PWA — put the conversation straight back on it.
    const wasLocked = await DB.locked().catch(() => false);
    // Read here and not from loadProfileSettings, which does not run until a
    // room is open — by then the decision this makes has already been made.
    await loadLockSettings();
    /* The other half of "lock when reopened".
     *
     * Deliberately not written to the vault: that flag is shared by every tab
     * and outlives the page, and this is a fact about *this* page load only.
     * Persisting it would let a second tab opened at lunchtime lock the first
     * one that somebody is in the middle of typing into.
     *
     * Skipped in an auto-approve room, which has opted out of the whole lock,
     * from a copy of the flag cached beside the token — state.session does not
     * exist yet here, and asking the server for it needs a network that a cold
     * start on a train does not have. Getting this wrong strands an agent seat
     * behind a PIN prompt with nobody there to type it. */
    const relock =
      !sameSession && state.lockOnReopen && !(sessions[roomId] || {}).autoApprove;
    if (roomIds.length && !wasLocked && !relock) {
      state.sessions = sessions;
      // Nothing set this on the way in, only unlockWith did — so after any
      // refresh the app ran with locked still true, and watchVisibility's
      // `!state.locked` guard meant auto-lock could never fire again.
      state.locked = false;
      await ensureIdentity();
      DB.useRoom(roomId, sessions[roomId].slot);
      state.roomId = roomId;
      API.setToken(sessions[roomId].token);
      try {
        await enterRoom(roomId);
        markUnlockedThisTab();
        return;
      } catch (err) {
        if (err.offline) {
          // Offline start: everything needed to read this room is already
          // local, so open it rather than demanding a PIN with no network.
          state.device = { id: sessions[roomId].deviceId, status: 'active' };
          // The cached flag earns its keep here too. This stub used to carry
          // only the seat, so an auto-approve room started offline had every
          // lock timer running against it — the one kind of room where they are
          // meant never to fire — and locked itself while there was no network
          // to unlock with.
          state.session = {
            slot: sessions[roomId].slot || 1,
            auto_approve_devices: !!sessions[roomId].autoApprove,
          };
          state.locked = false;
          markUnlockedThisTab();
          showScreen('pool');
          await loadProfileSettings();
          // Also here, and not only in afterUnlock. The very first load after
          // the per-seat split may well be an offline one, and without this the
          // new store is empty and the whole conversation reads as gone — the
          // old rows are still on disk, but nobody is looking at them.
          await adoptLegacyHistory();
          await hydrateFromLocal();
          paintHeader();
          return;
        }
      }
    }
    showScreen('lock');
    // Before explainSignOut, which has something more specific to say when it
    // has anything at all.
    noteOfflineLock();
    explainSignOut();
    offerPinResetFromLock();
  }

  /* Carried across the reload that a revoked device triggers, so the lock screen
   * can say what happened instead of just appearing. */
  function explainSignOut() {
    try {
      const reason = sessionStorage.getItem('reef-signed-out');
      if (!reason) return;
      sessionStorage.removeItem('reef-signed-out');
      $('lock-note').textContent = reason;
    } catch (e) {
      /* nothing to say */
    }
  }

  boot();
})();
