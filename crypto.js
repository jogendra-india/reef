/* Reef crypto.
 *
 * Loaded as a classic script by both the page and the service worker, because
 * the SW has to decrypt a message to render a notification and neither side
 * should own a second copy of these primitives.
 *
 * Shape:
 *   identity  ECDH P-256, private half generated non-extractable and stored as
 *             a CryptoKey in IndexedDB — an XSS bug cannot export it
 *   pair key  ECDH(mine, theirs) -> HKDF -> one key per device pair
 *   message   HKDF(pair key, random salt, info=msg id) -> AES-256-GCM
 *
 * The AAD binds the ciphertext to (message id, sender, recipient), so the
 * server cannot re-order envelopes or re-attribute one to a different sender
 * without breaking the tag.
 *
 * safetyNumber() is mirrored byte-for-byte by reef/crypto.py. Changing one
 * without the other silently breaks verification, so both have pinned vectors.
 */
(function (root) {
  'use strict';

  const enc = (s) => new TextEncoder().encode(s);
  const PAIR_INFO = 'reef/v1/pair';
  const MSG_INFO = 'reef/v1/msg|';

  function b64(bytes) {
    let s = '';
    const view = new Uint8Array(bytes);
    for (let i = 0; i < view.length; i++) s += String.fromCharCode(view[i]);
    return btoa(s);
  }

  function unb64(text) {
    const raw = atob(text);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  async function generateIdentity() {
    // extractable:false applies to the private key. The public half is always
    // exportable, which is exactly the split we want.
    return crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      ['deriveKey', 'deriveBits']
    );
  }

  async function exportPublicJwk(publicKey) {
    const jwk = await crypto.subtle.exportKey('jwk', publicKey);
    // Only the four fields the server and the safety number care about. Chrome
    // and Firefox disagree about which extras they emit, and a fingerprint
    // must not depend on that.
    return { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
  }

  async function derivePairKey(privateKey, peerJwk, myDeviceId, peerDeviceId) {
    const peerKey = await crypto.subtle.importKey(
      'jwk',
      { ...peerJwk, ext: true },
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      []
    );
    const shared = await crypto.subtle.deriveBits(
      { name: 'ECDH', public: peerKey },
      privateKey,
      256
    );
    const base = await crypto.subtle.importKey('raw', shared, 'HKDF', false, [
      'deriveBits',
    ]);
    // Sorted, so both devices derive the same key without agreeing on who is
    // "first".
    const salt = enc([String(myDeviceId), String(peerDeviceId)].sort().join('|'));
    const bits = await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt, info: enc(PAIR_INFO) },
      base,
      256
    );
    return crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  }

  async function messageKey(pairKey, salt, messageId) {
    return crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt, info: enc(MSG_INFO + messageId) },
      pairKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  const aadFor = (messageId, senderDeviceId, recipientDeviceId) =>
    enc(`${messageId}|${senderDeviceId}|${recipientDeviceId}`);

  async function sealMessage(pairKey, body, ids) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await messageKey(pairKey, salt, ids.messageId);
    const ct = await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv,
        additionalData: aadFor(ids.messageId, ids.senderDeviceId, ids.recipientDeviceId),
      },
      key,
      enc(JSON.stringify(body))
    );
    return { ct: b64(ct), iv: b64(iv), salt: b64(salt) };
  }

  async function openMessage(pairKey, envelope, ids) {
    const key = await messageKey(pairKey, unb64(envelope.salt), ids.messageId);
    const plain = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: unb64(envelope.iv),
        additionalData: aadFor(
          ids.messageId,
          ids.senderDeviceId,
          ids.recipientDeviceId
        ),
      },
      key,
      unb64(envelope.ct)
    );
    return JSON.parse(new TextDecoder().decode(plain));
  }

  /* Attachments get their own random key. It is exportable on purpose — it has
   * to travel to the other device, and it does so inside the message
   * ciphertext, never past the server in the clear. */
  async function sealBlob(bytes) {
    const key = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    );
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes);
    const raw = await crypto.subtle.exportKey('raw', key);
    return { ciphertext: new Uint8Array(ct), key: b64(raw), iv: b64(iv) };
  }

  async function openBlob(bytes, keyB64, ivB64) {
    const key = await crypto.subtle.importKey(
      'raw',
      unb64(keyB64),
      { name: 'AES-GCM' },
      false,
      ['decrypt']
    );
    return crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(ivB64) }, key, bytes);
  }

  function canonicalKey(jwk) {
    return [jwk.kty || '', jwk.crv || '', jwk.x || '', jwk.y || ''].join('.');
  }

  // Variadic, covering every key in the conversation. Fingerprinting only a
  // pair would leave a second device — an extra phone, a third person, a row
  // inserted straight into the database — invisible to the one check meant to
  // catch exactly that. Mirrors reef/crypto.py.
  async function safetyNumber(...jwks) {
    if (jwks.length < 2) throw new Error('A safety number needs at least two keys.');
    const parts = jwks.map(canonicalKey).sort();
    const digest = new Uint8Array(
      await crypto.subtle.digest('SHA-256', enc(parts.join('|')))
    );
    let hex = '';
    for (let i = 0; i < digest.length; i++) {
      hex += digest[i].toString(16).padStart(2, '0');
    }
    const digits = BigInt('0x' + hex).toString().padStart(78, '0').slice(0, 60);
    return (digits.match(/.{5}/g) || []).join(' ');
  }

  root.ReefCrypto = {
    generateIdentity,
    exportPublicJwk,
    derivePairKey,
    sealMessage,
    openMessage,
    sealBlob,
    openBlob,
    safetyNumber,
    canonicalKey,
    b64,
    unb64,
  };
})(self);
