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

  const FISH = ['🐟', '🐠', '🐡', '🦑', '🐙', '🦀', '🦐', '🐳', '🐬', '🦈', '🪸', '🐚'];
  const DEFAULT_PROFILE = {
    1: { handle: 'Pufferfish', emoji: '🐡' },
    2: { handle: 'Clownfish', emoji: '🐠' },
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
    window: 60,
    replyTo: null,
    editing: null,
    stream: null,
    online: false,
    peerTyping: false,
    peerOnline: false,
    lastSeen: null,
    stickBottom: true,
    unseen: 0,
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
      // The list must stay where the eye left it across an open/close.
      if (state.stickBottom) scrollToBottom(false);
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
      button.addEventListener('click', () => onKey(k));
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
    $('lock-note').textContent = '';
    try {
      await unlockWith(pin);
    } catch (err) {
      entry = '';
      paintDots(true);
      buzz([40, 60, 40]);
      if (err && err.status === 429) {
        const wait = Number(err.retryAfter || 0);
        $('lock-note').textContent = wait
          ? `Try again in ${Math.ceil(wait / 60)} min`
          : 'Try again later';
      } else if (err && err.offline) {
        $('lock-note').textContent = 'No connection';
      }
    } finally {
      lockBusy = false;
    }
  }

  /* ==================================================================== *
   * Identity and unlock
   * ==================================================================== */

  async function ensureIdentity() {
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

    // One PIN, every room that person is seated in. Each comes with its own
    // device and token, because a device is approved room by room.
    const sessions = {};
    result.rooms.forEach((room) => {
      sessions[room.room_id] = {
        token: room.token,
        deviceId: room.device.id,
        status: room.device.status,
        slot: room.session.slot,
      };
    });
    await DB.setSessions(sessions);
    state.sessions = sessions;
    state.mustChangePin = result.must_change_pin;

    const preferred =
      result.rooms.find((r) => r.device.status === 'active') || result.rooms[0];
    entry = '';
    paintDots();
    state.locked = false;
    await enterRoom(preferred.room_id, preferred);
  }

  /* Makes one conversation the active one. Everything room-scoped is torn down
   * and rebuilt, and the local store is re-pointed first, so nothing from the
   * previous room can survive into this one. */
  async function enterRoom(roomId, prefetched) {
    if (state.stream) state.stream.close();
    state.stream = null;
    state.messages = new Map();
    state.profiles = {};
    state.recipients = [];
    state.pairKeys = {};
    state.window = 60;
    state.unseen = 0;
    clearReply();
    cancelEdit();

    DB.useRoom(roomId);
    state.roomId = roomId;

    const session = state.sessions[roomId];
    API.setToken(session.token);

    if (prefetched) {
      state.device = prefetched.device;
      state.session = prefetched.session;
    } else {
      const result = await API.session();
      state.device = result.device;
      state.session = result.session;
    }
    await afterUnlock();
  }

  async function afterUnlock() {
    // A join PIN was sent over someone else's messenger and is probably still
    // sitting in that thread. Nothing else happens until it is replaced.
    if (state.mustChangePin) {
      showScreen('pool');
      return openPinSheet({ forced: true });
    }
    if (state.device.status !== 'active') {
      showScreen('pending');
      pollForApproval();
      return;
    }
    showScreen('pool');
    refreshRequests();
    await loadProfileSettings();
    await hydrateFromLocal();
    await refreshKeys();
    connectStream();
    await syncHistory();
    await flushOutbox();
    subscribePush();
    announceProfile();
  }

  let approvalTimer = null;
  function pollForApproval() {
    clearInterval(approvalTimer);
    approvalTimer = setInterval(async () => {
      try {
        const result = await API.session();
        if (result.device.status === 'active') {
          clearInterval(approvalTimer);
          state.device = result.device;
          state.session = result.session;
          toast('Approved. Welcome in.');
          await afterUnlock();
        } else if (result.device.status === 'revoked') {
          clearInterval(approvalTimer);
          await signOut();
        }
      } catch (e) {
        /* offline; keep waiting */
      }
    }, 4000);
  }

  async function signOut() {
    clearInterval(approvalTimer);
    if (state.stream) state.stream.close();
    await DB.wipeEverything();
    location.reload();
  }

  /* ==================================================================== *
   * Keys
   * ==================================================================== */

  async function refreshKeys() {
    const result = await API.keys();
    state.recipients = result.recipients || [];
    state.session.safety_number = result.safety_number;
    state.pairKeys = {};
    for (const recipient of state.recipients) {
      state.pairKeys[recipient.id] = await C.derivePairKey(
        state.identity.privateKey,
        recipient.public_key_jwk,
        state.device.id,
        recipient.id
      );
    }
    paintHeader();
    paintPeerMissing();
  }

  function pairKeyFor(deviceId) {
    return state.pairKeys[deviceId];
  }

  /* ==================================================================== *
   * History
   * ==================================================================== */

  async function hydrateFromLocal() {
    const [stored, profiles] = await Promise.all([
      DB.messagesPage(400),
      DB.entries(DB.STORES.profiles),
    ]);
    stored.forEach((m) => state.messages.set(m.id, m));
    state.profiles = profiles;
    renderList();
  }

  async function syncHistory() {
    try {
      const since = await DB.highestSeq();
      const result = since
        ? await API.history({ since, page_size: 200 })
        : await API.history({ page_size: 60 });
      await ingest(result.results || []);
    } catch (err) {
      if (!err.offline) console.warn('sync failed', err);
    }
  }

  async function loadOlder() {
    const oldest = [...state.messages.values()].sort((a, b) => a.seq - b.seq)[0];
    if (!oldest) return;
    try {
      const result = await API.history({ cursor: oldest.seq, page_size: 60 });
      await ingest(result.results || [], true);
    } catch (e) {
      /* offline: the local window is all there is */
    }
  }

  async function ingest(rows, prepend) {
    const decoded = [];
    for (const row of rows) {
      const existing = state.messages.get(row.id);
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
        reactions: row.reactions || [],
        receipts: row.receipts || [],
        state: 'sent',
      });
      if (row.envelope && !merged.body) {
        merged.body = await tryOpen(row);
      }
      if (merged.deleted) merged.body = null;
      decoded.push(merged);
    }
    decoded.forEach((m) => {
      applyProfileMessage(m);
      state.messages.set(m.id, m);
    });
    if (decoded.length) await DB.putMessages(decoded);
    if (prepend) state.window += decoded.length;
    renderList(prepend);
    markVisibleRead();
  }

  async function tryOpen(row) {
    const key = pairKeyFor(row.sender_device_id);
    if (!key) return null;
    try {
      return await C.openMessage(key, row.envelope, {
        messageId: row.id,
        senderDeviceId: row.sender_device_id,
        recipientDeviceId: state.device.id,
      });
    } catch (e) {
      // A message sealed for a device that has since been replaced. Showing a
      // placeholder is honest; pretending it never existed is not.
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
    const recipient = state.recipients[0];
    return (
      (recipient && state.profiles[recipient.id]) || { handle: 'Reef', emoji: '🐟' }
    );
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

  const ordered = () =>
    [...state.messages.values()].sort((a, b) => (a.seq || 1e15) - (b.seq || 1e15));

  function renderList(keepAnchor) {
    const scroller = $('scroller');
    const before = scroller.scrollHeight;
    const list = $('list');
    list.innerHTML = '';

    const rows = ordered();
    const visible = rows.slice(Math.max(0, rows.length - state.window));

    let lastDay = null;
    visible.forEach((message, index) => {
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
      list.appendChild(renderRow(message, { grouped, tail }));
    });

    if (keepAnchor) {
      // Prepending without this is why so many such apps jerk when you scroll
      // up: the content grows above the viewport and the browser keeps the
      // same scrollTop.
      scroller.scrollTop += scroller.scrollHeight - before;
    } else if (state.stickBottom) {
      scrollToBottom(false);
    }
    observeUnread();
  }

  function renderRow(message, shape) {
    const row = el('div', 'row' + (message.mine ? ' mine' : '') +
      (shape.tail ? ' tail' : '') + (shape.grouped ? '' : ' gap'));
    row.dataset.id = message.id;

    const bubble = el('div', 'bubble');
    const body = message.body || {};

    if (message.replyTo) {
      const target = state.messages.get(message.replyTo);
      const quote = el('div', 'quote');
      quote.textContent = target && target.body ? preview(target) : 'a message';
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
      const reacts = el('div', 'reacts');
      message.reactions.forEach((reaction) => {
        if (reaction.emoji) reacts.appendChild(el('span', 'react', reaction.emoji));
      });
      if (reacts.children.length) bubble.appendChild(reacts);
    }

    if (message.state === 'failed') {
      bubble.addEventListener('click', () => retrySend(message));
    }
    attachGestures(row, bubble, message);
    row.appendChild(bubble);
    return row;
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
      const read = (message.receipts || []).some((r) => r.read_at);
      const delivered = (message.receipts || []).some((r) => r.delivered_at);
      tick.textContent = delivered || read ? '✓✓' : '✓';
      if (read) tick.classList.add('read');
    }
    return tick;
  }

  function preview(message) {
    const body = message.body || {};
    if (body.text) return body.text.slice(0, 90);
    if (message.attachments && message.attachments.length) return '📎 attachment';
    return 'a message';
  }

  function renderMedia(attachment, file, message) {
    // Video used to be forced through an <img>, which decrypted the blob
    // perfectly and then displayed nothing at all.
    const isVideo = !!file && String(file.mime || '').startsWith('video/');
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
    }
    node.style.minHeight = '120px';
    if (file && file.w && file.h) {
      node.width = file.w;
      node.height = file.h;
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
      node.addEventListener('click', () => node.src && openViewer(node.src, file));
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

  async function paintMedia(node) {
    const file = node._file;
    const attachment = node._attachment;
    if (!file || !attachment) return;
    const cacheKey = attachment.id;
    let url = await DB.get(DB.STORES.media, cacheKey);
    if (!url) {
      try {
        const bytes = await API.fetchBlob(
          attachment.id,
          attachment.has_thumb && !node._full
        );
        const plain = await C.openBlob(
          new Uint8Array(bytes),
          attachment.has_thumb && !node._full ? file.thumbKey : file.key,
          attachment.has_thumb && !node._full ? file.thumbIv : file.iv
        );
        const blob = new Blob([plain], { type: file.mime || 'image/jpeg' });
        url = URL.createObjectURL(blob);
      } catch (e) {
        return;
      }
    }
    node.src = url;
    node.classList.remove('pending');
  }

  function scrollToBottom(smooth) {
    const scroller = $('scroller');
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
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

  function autogrow() {
    const box = $('text');
    box.style.height = 'auto';
    box.style.height = Math.min(box.scrollHeight, 132) + 'px';
    const hasContent = box.value.trim() || pendingFiles.length;
    // With nobody active on the other side there is no envelope to address, so
    // the send would be rejected by the server. It used to render optimistically
    // and then fail quietly, which reads exactly like a message that went
    // through — the worst possible way to lose one.
    $('send').disabled = !hasContent || !state.recipients.length;
  }

  function paintPeerMissing() {
    const strip = $('peer-missing');
    const missing = !state.recipients.length;
    strip.style.display = missing ? 'flex' : 'none';
    $('text').placeholder = missing
      ? 'Nobody to talk to yet'
      : 'Say something…';
    autogrow();
  }

  let typingSent = 0;
  function onTyping() {
    autogrow();
    saveDraft();
    const now = Date.now();
    if (state.stream && now - typingSent > 2000) {
      typingSent = now;
      state.stream.send({ type: 'typing', is_typing: true });
    }
  }

  let draftTimer;
  function saveDraft() {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(
      () => DB.put(DB.STORES.settings, $('text').value, 'draft'),
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
    const text = box.value.trim();
    if (!text && !pendingFiles.length) return;

    if (state.editing) return commitEdit(text);

    const id = uuid();
    const body = { v: 1, type: pendingFiles.length ? 'media' : 'text', text };
    const files = pendingFiles;
    pendingFiles = [];
    box.value = '';
    autogrow();
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
    state.stickBottom = true;
    renderList();
    scrollToBottom(true);
    buzz(10);

    await DB.putMessages([optimistic]);
    await queueOutbox({ id, body, files, replyTo: optimistic.replyTo });
    flushOutbox();
  }

  async function queueOutbox(job) {
    await DB.put(DB.STORES.outbox, job);
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
            renderList();
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
    renderList();
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
      message.seq = result.seq;
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

  async function onFiles(fileList) {
    for (const file of [...fileList]) {
      try {
        const prepared = await prepareImage(file);
        pendingFiles.push(prepared);
        toast(`${pendingFiles.length} attached`);
      } catch (e) {
        toast('Could not read that file');
      }
    }
    autogrow();
  }

  async function prepareImage(file) {
    if (!file.type.startsWith('image/')) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      return { bytes, mime: file.type, name: file.name, size: file.size };
    }
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

  function openViewer(src, file) {
    const viewer = $('viewer');
    [...viewer.querySelectorAll('img,video')].forEach((n) => n.remove());
    const isVideo = !!file && String(file.mime || '').startsWith('video/');
    const node = el(isVideo ? 'video' : 'img');
    if (isVideo) {
      node.controls = true;
      node.playsInline = true;
      node.autoplay = true;
    }
    node.src = src;
    viewer.appendChild(node);
    viewer.classList.add('on');
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

    const cancelHold = () => {
      clearTimeout(holdTimer);
      holdTimer = null;
    };

    row.addEventListener(
      'pointerdown',
      (event) => {
        startX = event.clientX;
        startY = event.clientY;
        axis = null;
        moved = false;
        holdTimer = setTimeout(() => {
          if (!moved) {
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
    row.addEventListener('contextmenu', (event) => event.preventDefault());
  }

  /* ==================================================================== *
   * Sheets
   * ==================================================================== */

  function openSheet(build) {
    const sheet = $('sheet');
    sheet.innerHTML = '';
    sheet.appendChild(el('div', 'grab'));
    build(sheet);
    $('scrim').classList.add('on');
    sheet.classList.add('on');
  }

  function closeSheet() {
    $('sheet').classList.remove('on');
    $('scrim').classList.remove('on');
  }

  const QUICK = ['❤️', '😂', '👍', '🐟', '😮', '🙏'];

  function openMessageSheet(message) {
    openSheet((sheet) => {
      if (!message.deleted) {
        const reacts = el('div', 'quickreacts');
        QUICK.forEach((emoji) => {
          const button = el('button', null, emoji);
          button.addEventListener('click', () => {
            closeSheet();
            sendReaction(message, emoji);
          });
          reacts.appendChild(button);
        });
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
        }
        if (message.mine && withinEditWindow(message)) {
          action('✎', 'Edit', () => startEdit(message));
        }
        if (message.mine) {
          action('🗑', 'Delete for everyone', () => removeMessage(message), true);
        }
      }
      action('👁', 'Hide for me', () => hideLocally(message));
    });
  }

  function withinEditWindow(message) {
    return Date.now() - new Date(message.createdAt).getTime() < 5 * 60 * 1000;
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
      action('🏷', 'My code', openCodeSheet);
      action('✉️', 'Start a conversation', openInviteSheet);
      if (Object.keys(state.sessions).length > 1) {
        action('🔀', 'Switch conversation', openRoomSheet);
      }
      action('🔑', 'Safety number', openSafetySheet);
      action('🐠', 'Change my fish', openProfileSheet);
      action('📱', 'Devices', openDevicesSheet);
      action('🔢', 'Change PIN', () => openPinSheet());
      action('↻', 'Force refresh', forceRefresh);
      action('🔒', 'Lock now', lockNow);
    });
  }

  /* ---- Invitations ---------------------------------------------------- */

  async function refreshRequests() {
    try {
      state.requests = (await API.requests()).invitations || [];
    } catch (e) {
      state.requests = [];
    }
    $('menu').textContent = state.requests.length ? '⋯•' : '⋯';
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
          await API.inviteByCode(input.value);
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
              await API.respondToRequest(invitation.id, action);
              closeSheet();
              await refreshRequests();
              toast(done);
            } catch (e) {
              toast('Could not do that');
            }
          });
          return button;
        };
        row.appendChild(respond('accept', 'var(--accent)', 'Accepted — lock and unlock to see it.'));
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
      const input = el('input');
      input.value = state.me.handle;
      input.maxLength = 24;
      input.style.cssText =
        'width:100%;padding:12px;border-radius:12px;background:var(--bg);border:1px solid var(--line);margin-bottom:10px';
      sheet.appendChild(input);

      const grid = el('div', 'emoji-grid');
      FISH.forEach((emoji) => {
        const button = el('button', null, emoji);
        button.addEventListener('click', () => {
          state.me.emoji = emoji;
          [...grid.children].forEach((c) => (c.style.background = ''));
          button.style.background = 'var(--surface-2)';
        });
        if (emoji === state.me.emoji) button.style.background = 'var(--surface-2)';
        grid.appendChild(button);
      });
      sheet.appendChild(grid);

      const save = el('button', 'act', 'Save');
      save.style.justifyContent = 'center';
      save.addEventListener('click', async () => {
        state.me.handle = input.value.trim() || state.me.handle;
        await DB.setProfile(state.me);
        closeSheet();
        announceProfile();
        toast('Saved');
      });
      sheet.appendChild(save);
    });
  }

  async function openDevicesSheet() {
    let result;
    try {
      result = await API.devices();
    } catch (e) {
      return toast('Offline');
    }
    openSheet((sheet) => {
      sheet.appendChild(el('div', 'sheet-title', 'Everything signed in right now.'));
      const mine = result.devices.filter((d) => d.slot === state.session.slot);
      const theirs = result.devices.filter((d) => d.slot !== state.session.slot);

      const act = (label, color, fn) => {
        const button = el('button', null, label);
        button.style.cssText = `color:${color};font-weight:600;padding:8px 10px`;
        button.addEventListener('click', fn);
        return button;
      };

      const render = (device) => {
        const row = el('div', 'act');
        row.appendChild(el('span', 'ico', device.status === 'pending' ? '⏳' : '📱'));
        const label = el(
          'span',
          null,
          `${device.label || 'Device'} · ${device.is_self ? 'this one' : device.status}`
        );
        label.style.flex = '1';
        row.appendChild(label);

        if (device.status === 'pending' && !device.is_self) {
          row.appendChild(
            act('Approve', 'var(--accent)', async () => {
              await API.approveDevice(device.id);
              closeSheet();
              await refreshKeys();
              toast('Approved. Compare the safety number.');
            })
          );
          // Turning one down was only ever possible from the API. Without it,
          // an unexpected request just sat in the list, and a list of requests
          // you cannot clear is how people end up approving one to be rid of it.
          row.appendChild(
            act('Reject', 'var(--danger)', async () => {
              await API.revokeDevice(device.id);
              closeSheet();
              toast('Turned down.');
            })
          );
        } else if (!device.is_self && device.slot === state.session.slot) {
          row.appendChild(
            act('Sign out', 'var(--danger)', async () => {
              await API.revokeDevice(device.id);
              closeSheet();
              toast('Signed that one out.');
            })
          );
        }
        sheet.appendChild(row);
      };

      if (theirs.some((d) => d.status === 'pending')) {
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

      theirs.forEach(render);
      mine.forEach(render);
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
        input.style.cssText =
          'width:100%;padding:12px;border-radius:12px;background:var(--bg);border:1px solid var(--line);margin-bottom:8px;letter-spacing:.5em;text-align:center';
        sheet.appendChild(input);
      });
      if (forced) current.placeholder = 'The PIN you were sent';
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
      if (forced) {
        // No way past this sheet except through it.
        $('scrim').onclick = null;
      }
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
    $('text').value = (message.body && message.body.text) || '';
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
    $('text').value = '';
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
      renderList();
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
      renderList();
    } catch (e) {
      toast('Could not delete');
    }
  }

  async function hideLocally(message) {
    // Never reaches the server. "Delete for me" that quietly deleted the other
    // person's copy would be a lie.
    state.messages.delete(message.id);
    await DB.del(DB.STORES.messages, message.id);
    renderList();
  }

  async function sendReaction(message, emoji) {
    const payload = {};
    for (const recipient of state.recipients) {
      const key = pairKeyFor(recipient.id);
      if (!key) continue;
      payload[recipient.id] = await C.sealMessage(
        key,
        { emoji },
        {
          messageId: message.id + '#reaction',
          senderDeviceId: state.device.id,
          recipientDeviceId: recipient.id,
        }
      );
    }
    message.reactions = (message.reactions || []).filter(
      (r) => r.device_id !== state.device.id
    );
    message.reactions.push({ device_id: state.device.id, emoji });
    renderList();
    try {
      await API.react(message.id, payload);
    } catch (e) {
      toast('Reaction did not stick');
    }
  }

  /* ==================================================================== *
   * Profile broadcast
   * ==================================================================== */

  async function loadProfileSettings() {
    // Shared across rooms: you are the same fish everywhere.
    const stored = await DB.profile();
    state.me = stored || DEFAULT_PROFILE[state.session.slot] || { handle: 'Fish', emoji: '🐟' };
    const draft = await DB.get(DB.STORES.settings, 'draft');
    if (draft) {
      $('text').value = draft;
      autogrow();
    }
  }

  async function announceProfile() {
    if (!state.recipients.length) return;
    const signature = JSON.stringify(state.me);
    const last = await DB.get(DB.STORES.settings, 'me-announced');
    if (last === signature) return;
    const id = uuid();
    const body = { v: 1, type: 'profile', handle: state.me.handle, emoji: state.me.emoji };
    try {
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
        if (state.online) {
          syncHistory();
          flushOutbox();
        }
      },
      onEvent: handleEvent,
    });
    state.stream.connect();
  }

  let typingTimer;
  async function handleEvent(event) {
    switch (event.type) {
      case 'msg.new':
        await ingest([event.message]);
        if (!event.message.mine) {
          if (!state.stickBottom) {
            state.unseen += 1;
            paintPill();
          }
          buzz(12);
          try {
            await API.receipts([event.message.id], 'delivered');
          } catch (e) {
            /* best effort */
          }
        }
        break;

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
          renderList();
        }
        break;
      }

      case 'msg.delete': {
        const message = state.messages.get(event.id);
        if (message) {
          message.deleted = true;
          message.body = null;
          await DB.putMessages([message]);
          renderList();
        }
        break;
      }

      case 'reaction': {
        const message = state.messages.get(event.message_id);
        if (!message) break;
        message.reactions = (message.reactions || []).filter(
          (r) => r.device_id !== event.device_id
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
              message.reactions.push({ device_id: event.device_id, emoji: body.emoji });
            } catch (e) {
              /* not for us */
            }
          }
        }
        await DB.putMessages([message]);
        renderList();
        break;
      }

      case 'receipt': {
        const message = state.messages.get(event.message_id);
        if (message) {
          message.receipts = (message.receipts || []).filter(
            (r) => r.device_id !== event.device_id
          );
          message.receipts.push({
            device_id: event.device_id,
            delivered_at: event.delivered_at,
            read_at: event.read_at,
          });
          await DB.putMessages([message]);
          renderList();
        }
        break;
      }

      case 'typing':
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

      case 'presence':
        state.peerOnline = event.status === 'online';
        if (!state.peerOnline) state.lastSeen = event.at;
        paintHeader();
        break;

      case 'device.pending':
        toast('A new device wants in — check Devices');
        break;

      case 'device.approved':
      case 'device.revoked':
        await refreshKeys();
        break;
    }
  }

  /* ==================================================================== *
   * Push
   * ==================================================================== */

  async function subscribePush() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
    if (!state.session.vapid_public_key) return;
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') return;
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
    } catch (e) {
      /* notifications are a nicety, never a blocker */
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

  const LOCK_AFTER = 5 * 60 * 1000;

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

  function lockNow() {
    state.locked = true;
    entry = '';
    paintDots();
    $('lock-note').textContent = '';
    showScreen('lock');
  }

  function watchVisibility() {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        state.hiddenAt = Date.now();
        // The app-switcher preview is a screenshot. Blank it.
        $('privacy').classList.add('on');
      } else {
        $('privacy').classList.remove('on');
        if (state.hiddenAt && Date.now() - state.hiddenAt > LOCK_AFTER && !state.locked) {
          lockNow();
        } else {
          markVisibleRead();
          flushOutbox();
        }
        state.hiddenAt = null;
      }
    });
  }

  /* ==================================================================== *
   * Emoji panel
   * ==================================================================== */

  const EMOJI = {
    Reef: ['🐟', '🐠', '🐡', '🦈', '🐙', '🦑', '🦐', '🦀', '🐳', '🐬', '🪸', '🐚', '🌊', '⚓', '🏝️', '🫧'],
    Smileys: ['😀', '😄', '😅', '🤣', '😊', '🙂', '😉', '😍', '🥰', '😘', '😜', '🤪', '🤔', '🤗', '🙃', '😴',
      '😌', '😏', '🥲', '😢', '😭', '😤', '😡', '🥵', '🥶', '😱', '🤯', '😳', '🥺', '😬', '🙄', '😶'],
    Hands: ['👍', '👎', '👌', '🤌', '✌️', '🤞', '🫶', '🙏', '👏', '🙌', '💪', '🤝', '👋', '🤙', '☝️', '✋'],
    Hearts: ['❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '💔', '❣️', '💕', '💞', '💓', '💗', '💖', '✨'],
    Life: ['🔥', '⭐', '🎉', '🎂', '🍕', '☕', '🍺', '🌙', '☀️', '🌈', '⚡', '🌸', '🍀', '🎵', '💤', '🚀'],
  };

  function buildEmoji() {
    const panel = $('emoji');
    panel.innerHTML = '';
    Object.entries(EMOJI).forEach(([group, list]) => {
      panel.appendChild(el('div', 'emoji-head', group));
      const grid = el('div', 'emoji-grid');
      list.forEach((emoji) => {
        const button = el('button', null, emoji);
        button.type = 'button';
        button.addEventListener('click', () => {
          const box = $('text');
          box.value += emoji;
          autogrow();
          saveDraft();
        });
        grid.appendChild(button);
      });
      panel.appendChild(grid);
    });
  }

  /* ==================================================================== *
   * Wiring
   * ==================================================================== */

  function wire() {
    $('text').addEventListener('input', onTyping);
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
    $('emoji-btn').addEventListener('click', () => $('emoji').classList.toggle('on'));
    $('attach').addEventListener('click', () => $('file-input').click());
    $('file-input').addEventListener('change', (event) => {
      onFiles(event.target.files);
      event.target.value = '';
    });
    $('reply-cancel').addEventListener('click', clearReply);
    $('edit-cancel').addEventListener('click', cancelEdit);
    $('menu').addEventListener('click', openMenuSheet);
    $('scrim').addEventListener('click', closeSheet);
    $('viewer-close').addEventListener('click', () => $('viewer').classList.remove('on'));
    $('viewer').addEventListener('click', (event) => {
      if (event.target.id === 'viewer') $('viewer').classList.remove('on');
    });
    // Re-runs unlock with the *same* device id, so the server can reconsider a
    // pending device — which it does while the conversation is still empty and
    // nobody exists yet to approve anyone. Deliberately does not clear
    // IndexedDB: wiping the keypair here would strand an orphan device row and
    // throw away the identity for no reason.
    $('pending-retry').addEventListener('click', () => {
      clearInterval(approvalTimer);
      lockNow();
    });
    $('pending-signout').addEventListener('click', signOut);

    const scroller = $('scroller');
    scroller.addEventListener(
      'scroll',
      () => {
        const distance =
          scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
        state.stickBottom = distance < 120;
        if (state.stickBottom && state.unseen) {
          state.unseen = 0;
          paintPill();
        }
        if (scroller.scrollTop < 600) growWindow();
      },
      { passive: true }
    );

    window.addEventListener('online', () => {
      flushOutbox();
      if (state.stream) state.stream.connect();
    });
  }

  let growing = false;
  async function growWindow() {
    if (growing) return;
    const rows = ordered();
    if (state.window >= rows.length) {
      growing = true;
      await loadOlder();
      growing = false;
      return;
    }
    state.window += 40;
    renderList(true);
  }

  /* ==================================================================== *
   * Boot
   * ==================================================================== */

  async function boot() {
    buildDots();
    buildKeypad();
    buildEmoji();
    wire();
    trackKeyboard();
    watchVisibility();

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    }

    API.onUnauthorized(() => {
      // 401 means the device is gone for good, as opposed to 403 which only
      // means "not approved yet". Wipe rather than sit on dead state.
      signOut();
    });

    const sessions = await DB.sessions();
    const roomIds = Object.keys(sessions);
    if (roomIds.length) {
      state.sessions = sessions;
      await ensureIdentity();
      // Prefer a room this device is actually approved in; a pending one can
      // only show the waiting screen.
      const roomId =
        roomIds.find((id) => sessions[id].status === 'active') || roomIds[0];
      DB.useRoom(roomId);
      state.roomId = roomId;
      API.setToken(sessions[roomId].token);
      try {
        await enterRoom(roomId);
        return;
      } catch (err) {
        if (err.offline) {
          // Offline start: everything needed to read this room is already
          // local, so open it rather than demanding a PIN with no network.
          state.device = { id: sessions[roomId].deviceId, status: 'active' };
          state.session = { slot: sessions[roomId].slot || 1 };
          state.locked = false;
          showScreen('pool');
          await loadProfileSettings();
          await hydrateFromLocal();
          paintHeader();
          return;
        }
      }
    }
    showScreen('lock');
  }

  boot();
})();
