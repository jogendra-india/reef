/* REST + WebSocket client.
 *
 * Everything that leaves this file is already ciphertext — sealing happens in
 * session.js/app.js before it gets here, so there is exactly one place to
 * check that no plaintext escapes.
 */
(function (root) {
  'use strict';

  const API_BASE = 'https://ledgerbal.com/api/reef';
  const WS_BASE = 'wss://ledgerbal.com/ws/reef/';

  let token = null;
  let onUnauthorized = () => {};

  function setToken(value) {
    token = value;
  }

  async function request(path, options = {}) {
    const headers = Object.assign({}, options.headers || {});
    if (token) headers.Authorization = 'Token ' + token;
    if (options.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(options.json);
    }

    let response;
    try {
      response = await fetch(API_BASE + path, {
        method: options.method || 'GET',
        headers,
        body: options.body,
      });
    } catch (err) {
      // Offline, or the server is down. Callers treat this as "try again
      // later" and keep working from IndexedDB.
      const wrapped = new Error('offline');
      wrapped.offline = true;
      throw wrapped;
    }

    if (response.status === 401 && !options.noSignOut) {
      // The device was revoked, or the token is gone. Distinct from 403,
      // which only means "not yet approved".
      //
      // noSignOut exempts the two endpoints where a 401 means "you typed the
      // wrong PIN" rather than "this device is finished". Without it, one typo
      // wiped the keys and the whole local history.
      onUnauthorized();
      const err = new Error('unauthorized');
      err.status = 401;
      throw err;
    }
    if (response.status === 204) return null;
    if (!response.ok) {
      let detail = null;
      try {
        detail = await response.json();
      } catch (e) {
        /* not JSON */
      }
      const err = new Error((detail && detail.detail) || 'request failed');
      err.status = response.status;
      err.data = detail;
      throw err;
    }
    const type = response.headers.get('Content-Type') || '';
    if (type.includes('application/json')) return response.json();
    return response.arrayBuffer();
  }

  const api = {
    API_BASE,
    setToken,
    onUnauthorized: (fn) => {
      onUnauthorized = fn;
    },

    unlock: (body) =>
      request('/unlock/', { method: 'POST', json: body, noSignOut: true }),
    // Only path that never had a session to lose, so a wrong or taken PIN
    // must not trip the "device revoked" handling `unlock` needs noSignOut for.
    register: (body) =>
      request('/register/', { method: 'POST', json: body, noSignOut: true }),
    session: () => request('/session/'),
    changePin: (body) =>
      request('/pin/', { method: 'POST', json: body, noSignOut: true }),
    devices: () => request('/devices/'),
    approveDevice: (id) => request(`/devices/${id}/approve/`, { method: 'POST' }),
    revokeDevice: (id) => request(`/devices/${id}/revoke/`, { method: 'POST' }),
    keys: () => request('/keys/'),

    history: (params) => {
      const query = new URLSearchParams(params || {}).toString();
      return request('/entries/' + (query ? '?' + query : ''));
    },
    send: (body) => request('/entries/', { method: 'POST', json: body }),
    edit: (id, body) => request(`/entries/${id}/`, { method: 'PATCH', json: body }),
    remove: (id) => request(`/entries/${id}/`, { method: 'DELETE' }),
    react: (id, payload) =>
      request(`/entries/${id}/marks/`, { method: 'POST', json: { payload } }),
    receipts: (messageIds, state) =>
      request('/receipts/', {
        method: 'POST',
        json: { message_ids: messageIds, state },
      }),

    uploadBlob: (ciphertext, thumb) => {
      const form = new FormData();
      form.append('blob', new Blob([ciphertext]), 'b.bin');
      if (thumb) form.append('thumb', new Blob([thumb]), 't.bin');
      return request('/blobs/', { method: 'POST', body: form });
    },
    fetchBlob: (id, thumb) =>
      request(`/blobs/${id}/` + (thumb ? '?thumb=1' : '')),

    subscribePush: (body) => request('/push/', { method: 'POST', json: body }),
    wsTicket: () => request('/ws-ticket/', { method: 'POST' }),

    // Invitations. A code is shareable and opens nothing; only a PIN does.
    myCode: () => request('/code/'),
    rotateCode: () => request('/code/', { method: 'POST' }),
    inviteByCode: (code) => request('/invite/', { method: 'POST', json: { code } }),
    inviteNewcomer: () => request('/invite/new/', { method: 'POST', json: {} }),
    requests: () => request('/requests/'),
    respondToRequest: (id, action) =>
      request(`/requests/${id}/${action}/`, { method: 'POST', json: {} }),
  };

  /* --- Live stream ------------------------------------------------------- */

  /* How many pings may go unanswered before the socket is treated as dead.
   *
   * Counted in pings rather than in seconds deliberately. A backgrounded tab has
   * its timers throttled to roughly one a minute, so any wall-clock deadline
   * would condemn a perfectly healthy socket the moment the phone went in a
   * pocket. A ping that got no answer is evidence whenever it was sent. */
  const MISSED_PONGS_DEAD = 2;

  function createStream(handlers) {
    let socket = null;
    let heartbeat = null;
    let backoff = 1000;
    let closed = false;
    let missed = 0;
    let lastFrame = 0;

    async function connect() {
      if (closed || (socket && socket.readyState <= 1)) return;
      let ticket;
      try {
        ticket = (await api.wsTicket()).ticket;
      } catch (err) {
        return retry();
      }

      socket = new WebSocket(WS_BASE + '?t=' + encodeURIComponent(ticket));

      socket.onopen = () => {
        backoff = 1000;
        missed = 0;
        lastFrame = Date.now();
        handlers.onStatus && handlers.onStatus('online');
        /* Doubles as the presence heartbeat: the server treats a device as
         * "swimming" only while these keep arriving.
         *
         * And, now, as the liveness check. Pongs were read and thrown away, so
         * nothing ever noticed a socket that had stopped answering — which is
         * precisely the failure that fires no onclose: a half-open connection
         * left by a sleeping phone, a NAT timeout, a proxy that drops the flow
         * without telling either end. The client sat there calling itself online
         * and receiving nothing until somebody reloaded it. */
        heartbeat = setInterval(() => {
          if (missed >= MISSED_PONGS_DEAD) return giveUp();
          missed++;
          send({ type: 'ping' });
        }, 20000);
      };

      socket.onmessage = (event) => {
        // Any frame at all is proof of life, not only a pong.
        missed = 0;
        lastFrame = Date.now();
        let payload;
        try {
          payload = JSON.parse(event.data);
        } catch (e) {
          return;
        }
        if (payload.type === 'pong') return;
        handlers.onEvent && handlers.onEvent(payload);
      };

      socket.onclose = () => {
        clearInterval(heartbeat);
        handlers.onStatus && handlers.onStatus('offline');
        retry();
      };

      socket.onerror = () => socket && socket.close();
    }

    /* Tears down a socket the browser still considers open but which is plainly
     * carrying nothing, and reconnects.
     *
     * The handlers come off and the reference is dropped *before* close(),
     * because closing a half-open connection can take its time arriving or never
     * arrive at all. Neither a late onclose scheduling a second retry nor
     * connect()'s readyState guard refusing to build a replacement is wanted. */
    function giveUp() {
      const dead = socket;
      socket = null;
      clearInterval(heartbeat);
      missed = 0;
      if (dead) {
        dead.onopen = dead.onmessage = dead.onclose = dead.onerror = null;
        try {
          dead.close();
        } catch (e) {
          /* already gone */
        }
      }
      handlers.onStatus && handlers.onStatus('offline');
      retry();
    }

    function retry() {
      if (closed) return;
      // Capped exponential backoff with jitter, so a server restart does not
      // get hammered by both devices in lockstep.
      const wait = Math.min(backoff, 30000) * (0.7 + Math.random() * 0.6);
      backoff = Math.min(backoff * 2, 30000);
      setTimeout(connect, wait);
    }

    function send(payload) {
      if (socket && socket.readyState === 1) {
        socket.send(JSON.stringify(payload));
        return true;
      }
      return false;
    }

    return {
      connect,
      send,
      /* Checks the socket now instead of waiting for the next heartbeat, and
       * rebuilds it if there is nothing there.
       *
       * For the moment a tab comes back to the front. Its timers have been
       * throttled, so the heartbeat could be most of a minute from firing, and
       * that is exactly when the socket is most likely to have died unnoticed.
       * The five-second deadline is wall-clock, which is safe here in a way it
       * would not be inside the heartbeat: the tab is foreground, the ping has
       * just gone out by hand, and a live socket answers in milliseconds. */
      poke: () => {
        if (closed) return;
        if (!socket || socket.readyState > 1) return connect();
        if (socket.readyState !== 1) return;
        send({ type: 'ping' });
        setTimeout(() => {
          if (socket && socket.readyState === 1 && Date.now() - lastFrame > 5000) {
            giveUp();
          }
        }, 5000);
      },
      close: () => {
        closed = true;
        clearInterval(heartbeat);
        if (socket) socket.close();
      },
      isOpen: () => !!socket && socket.readyState === 1,
    };
  }

  api.createStream = createStream;
  root.ReefAPI = api;
})(self);
