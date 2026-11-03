// pokemonarena/js/identity.js -- a per-browser signing identity for result receipts (ECDSA P-256 via WebCrypto).
//
// Pure ES module (browser + Node 24; needs crypto.subtle, which browsers expose on https and on localhost only).
// This module never touches IndexedDB itself: it is handed a `keys` object (store.js ArenaStore#keys) with
// get(slot) / put(slot, rec) / delete(slot) and a boolean `persistent`. EVERY KEY HAS ITS OWN SLOT, keySlot(profileId, keyId)
// = '<profile id>:<key id>', and nothing here ever overwrites or deletes a slot. That is deliberate: a new key is stored BEFORE
// the profile that names it is saved (compare-and-swap, so the save can lose), and if the old key lived in the same slot a lost
// race would destroy the only copy of the old private key. With separate slots a lost race leaves one unused extra key and
// nothing else.
//
// WHAT THIS IS FOR. A match result is only two peers' say-so. Each side signs the canonical receipt with its key, and
// the other side (and anyone later) can check that THIS key signed THESE bytes. It proves continuity of a key, not a
// person: there is no server, so nothing says who owns a key, and a visitor can create another profile and another key
// at will. Do not present it as an account or as anti-cheat. UI NOTE (IDENTITY_NOTICE below): the identity lives in
// this browser profile only.
//
// KEY HANDLING.
//   * The private key is generated NON-EXTRACTABLE and kept as a CryptoKey object in IndexedDB (structured clone keeps
//     it non-extractable). Script on the page, including this module, can sign with it but can never read its bytes.
//   * The PUBLIC key is exported as a JWK {kty, crv, x, y} and lives in the profile (profile.identity.publicKeyJwk).
//   * EXPORT POLICY: a profile export carries the public JWK and nothing private (profile.js refuses to export or to
//     import anything that looks like a private JWK). The private key therefore does NOT travel: an exported profile
//     imported on another browser has the identity's public half and no way to sign as it.
//   * KEY LOSS IS REPORTED, NEVER PAPERED OVER. identityStatus() answers by DOING a sign + verify round trip:
//       none       the profile has no identity yet                      -> ensureIdentity() may create one
//       ok         the stored private key signs and the profile's public key verifies it
//       no-key     the profile claims an identity but this browser holds no private key (cleared site data, new device,
//                  imported file)                                       -> signing is impossible; rotateIdentity() is explicit
//       mismatch   a private key is stored but it is not the one the profile names (profile replaced / restored)
//       unusable   a private key is stored but signing with it failed
//       invalid    the profile's public JWK is malformed
//       ephemeral  as ok, but storage is memory-only: the key will be gone after this session
//     ensureIdentity() only ever creates a key in state 'none'. In every other state it returns the state and changes
//     nothing; replacing an identity needs rotateIdentity({ acknowledgeLoss: true }), which keeps the retired public key
//     in profile.identity.previousKeys so receipts signed with it stay attributable (the retired PRIVATE key stays in its
//     own slot too; nothing deletes it).
//
// RECEIPTS. A receipt is a plain JSON object { v: 1, kind: <string>, ... } (identity.js does not interpret the rest). A
// signature covers RECEIPT_DOMAIN + canonicalJSON(receipt) as UTF-8, so a signature made for some other purpose over
// the same JSON cannot be replayed as a receipt. The signed document is
//   { receipt, signatures: [ { keyId, publicKeyJwk, sig } ] }     sig = base64url of the 64-byte IEEE P1363 (r || s)
// keyId = first 16 hex digits of SHA-256 over canonical {crv, kty, x, y}. Both players sign the same bytes, so a
// two-party receipt has two entries. ECDSA signatures are malleable ((r, s) and (r, n - s) both verify) and randomised:
// identify a receipt by its canonical bytes (receiptDigest), never by a signature.

import { canonicalJSON } from './stats.js';
import { isPublicJwk, defaultDeps, b64urlEncode, b64urlDecode } from './profile.js';

export const RECEIPT_DOMAIN = 'pokemonarena-receipt-v1\n';
export const RECEIPT_MAX_BYTES = 4096;
export const ALGORITHM = Object.freeze({ name: 'ECDSA', namedCurve: 'P-256' });
const SIGN_ALG = Object.freeze({ name: 'ECDSA', hash: 'SHA-256' });
export const IDENTITY_NOTICE = 'Your identity is a signing key stored in this browser profile only. It is not an account: '
  + 'clearing site data, switching browser or device, or importing your profile elsewhere leaves you without the key '
  + '(your name and public key still travel; the private key never does). Receipts you signed earlier stay verifiable.';

export const IDENTITY_STATES = Object.freeze(['none', 'ok', 'no-key', 'mismatch', 'unusable', 'invalid', 'ephemeral']);

export class IdentityError extends Error {
  constructor(code, message) { super(message); this.name = 'IdentityError'; this.code = code; }
}

/** Where a key lives in the keys store. */
export const keySlot = (profileId, keyId) => `${profileId}:${keyId}`;
const enc = (s) => new TextEncoder().encode(s);
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const isObj = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
const subtle = () => {
  const s = globalThis.crypto && globalThis.crypto.subtle;
  if (!s) throw new IdentityError('identity.no-webcrypto', 'WebCrypto (crypto.subtle) is not available; it needs https or localhost');
  return s;
};

/** Strictly {kty:'EC', crv:'P-256', x, y}; returns a fresh object or throws IdentityError. A JWK with private members is refused. */
export function normalizePublicJwk(jwk) {
  if (isObj(jwk) && ['d', 'p', 'q', 'dp', 'dq', 'qi', 'k'].some((m) => Object.prototype.hasOwnProperty.call(jwk, m))) throw new IdentityError('identity.private-jwk', 'refusing a JWK that carries private members');
  if (!isPublicJwk(jwk)) throw new IdentityError('identity.jwk', 'not a public P-256 JWK');
  return { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y };
}

/** 16 hex digits naming a public key: SHA-256 over canonical {crv, kty, x, y}. */
export async function keyIdOf(jwk) {
  const j = normalizePublicJwk(jwk);
  const digest = new Uint8Array(await subtle().digest('SHA-256', enc(canonicalJSON({ crv: j.crv, kty: j.kty, x: j.x, y: j.y }))));
  return hex(digest).slice(0, 16);
}

async function importPublic(jwk) {
  return subtle().importKey('jwk', normalizePublicJwk(jwk), ALGORITHM, true, ['verify']);
}

/** A fresh key pair: { privateKey (non-extractable), publicKey, publicKeyJwk, keyId }. */
export async function generateIdentity() {
  const kp = await subtle().generateKey(ALGORITHM, false, ['sign', 'verify']);
  const exported = await subtle().exportKey('jwk', kp.publicKey); // also carries key_ops / ext: take the four members that name the key
  const publicKeyJwk = normalizePublicJwk({ kty: exported.kty, crv: exported.crv, x: exported.x, y: exported.y });
  return { privateKey: kp.privateKey, publicKey: kp.publicKey, publicKeyJwk, keyId: await keyIdOf(publicKeyJwk) };
}

/** Sign / verify one challenge with the stored private key against the profile's public key. Never throws. */
async function roundTrip(privateKey, publicJwk) {
  let sig;
  const challenge = globalThis.crypto.getRandomValues(new Uint8Array(32));
  try { sig = await subtle().sign(SIGN_ALG, privateKey, challenge); } catch (_e) { return 'unusable'; }
  try { return (await subtle().verify(SIGN_ALG, await importPublic(publicJwk), sig, challenge)) ? 'ok' : 'mismatch'; } catch (_e) { return 'invalid'; }
}

/** { state, keyId|null, publicKeyJwk|null } -- see the state table in the file header. Never throws. */
export async function identityStatus(profile, keys) {
  const jwk = profile && profile.identity ? profile.identity.publicKeyJwk : null;
  if (jwk === null || jwk === undefined) return { state: 'none', keyId: null, publicKeyJwk: null };
  let keyId = null;
  try { keyId = await keyIdOf(jwk); } catch (_e) { return { state: 'invalid', keyId: null, publicKeyJwk: null }; }
  let rec;
  try { rec = await keys.get(keySlot(profile.id, keyId)); } catch (_e) { return { state: 'unusable', keyId, publicKeyJwk: jwk }; }
  if (!rec || !rec.privateKey) return { state: 'no-key', keyId, publicKeyJwk: jwk };
  let state = await roundTrip(rec.privateKey, jwk);
  if (state === 'ok' && keys.persistent === false) state = 'ephemeral';
  return { state, keyId, publicKeyJwk: jwk };
}

/**
 * Create the profile's identity if (and only if) it has none. Returns { profile, created, status }.
 * `profile` is a modified COPY; the caller saves it (with the usual compare-and-swap). The new key is stored in its own slot
 * first, so if two tabs race, each keeps its own key, one profile save wins, and the loser reloads the winner's profile and
 * finds the winner's key in the same keys store.
 */
export async function ensureIdentity(profile, keys, deps) {
  const status = await identityStatus(profile, keys);
  if (status.state !== 'none') return { profile, created: false, status };
  const now = (deps && deps.now ? deps.now : defaultDeps().now)();
  const id = await generateIdentity();
  await keys.put(keySlot(profile.id, id.keyId), { profileId: profile.id, keyId: id.keyId, privateKey: id.privateKey, publicKeyJwk: id.publicKeyJwk, createdAt: now });
  const next = JSON.parse(JSON.stringify(profile));
  next.identity = { ...next.identity, publicKeyJwk: id.publicKeyJwk };
  return { profile: next, created: true, status: await identityStatus(next, keys) };
}

/**
 * Replace the identity with a fresh key. Explicit by design: `acknowledgeLoss` must be true, and the retired public key
 * is kept in identity.previousKeys. Returns { profile (a modified copy), retired, status }.
 */
export async function rotateIdentity(profile, keys, { acknowledgeLoss, reason = 'rotated', now } = {}) {
  if (acknowledgeLoss !== true) throw new IdentityError('identity.ack-required', 'rotating an identity abandons the old key; pass acknowledgeLoss: true');
  const t = now === undefined ? defaultDeps().now() : now;
  const id = await generateIdentity();
  await keys.put(keySlot(profile.id, id.keyId), { profileId: profile.id, keyId: id.keyId, privateKey: id.privateKey, publicKeyJwk: id.publicKeyJwk, createdAt: t }); // a NEW slot: the old key is not touched
  const next = JSON.parse(JSON.stringify(profile));
  const old = next.identity.publicKeyJwk;
  next.identity = { ...next.identity, publicKeyJwk: id.publicKeyJwk, previousKeys: next.identity.previousKeys.slice() };
  if (old) {
    next.identity.previousKeys.push({ publicKeyJwk: normalizePublicJwk(old), retiredAt: t, reason: String(reason).slice(0, 40) });
    if (next.identity.previousKeys.length > 16) next.identity.previousKeys = next.identity.previousKeys.slice(-16);
  }
  return { profile: next, retired: old ? await keyIdOf(old) : null, status: await identityStatus(next, keys) };
}

// ---------------------------------------------------------------------------------------------
// receipts
// ---------------------------------------------------------------------------------------------

/** Problems of a receipt object ([] = signable). */
export function receiptProblems(receipt) {
  const p = [];
  if (!isObj(receipt)) return ['the receipt must be a plain object'];
  if (receipt.v !== 1) p.push('v must be 1');
  if (typeof receipt.kind !== 'string' || receipt.kind === '' || receipt.kind.length > 64) p.push('kind must be a short non-empty string');
  let canon = null;
  try { canon = canonicalJSON(receipt); } catch (e) { p.push('the receipt is not canonical JSON: ' + e.message); }
  if (canon !== null && enc(canon).length > RECEIPT_MAX_BYTES) p.push(`the receipt is larger than ${RECEIPT_MAX_BYTES} bytes`);
  return p;
}
/** The exact bytes a signature covers. */
export function receiptBytes(receipt) {
  const bad = receiptProblems(receipt);
  if (bad.length) throw new IdentityError('identity.receipt', bad.join('; '));
  return enc(RECEIPT_DOMAIN + canonicalJSON(receipt));
}
/** Hex SHA-256 of the signed bytes: the stable name of a receipt (use this, not a signature). */
export async function receiptDigest(receipt) {
  return hex(new Uint8Array(await subtle().digest('SHA-256', receiptBytes(receipt))));
}

/** One signature entry { keyId, publicKeyJwk, sig } by this profile's key. Throws unless identityStatus is ok / ephemeral. */
export async function signReceipt(profile, keys, receipt) {
  const bytes = receiptBytes(receipt);
  const st = await identityStatus(profile, keys);
  if (st.state !== 'ok' && st.state !== 'ephemeral') throw new IdentityError('identity.cannot-sign', `cannot sign: identity state is "${st.state}"`);
  const rec = await keys.get(keySlot(profile.id, st.keyId));
  const sig = new Uint8Array(await subtle().sign(SIGN_ALG, rec.privateKey, bytes));
  return { keyId: st.keyId, publicKeyJwk: st.publicKeyJwk, sig: b64urlEncode(sig) };
}

/** { receipt, signatures:[entry...] } -- a copy; entries are appended in order. */
export function makeReceiptDoc(receipt, entries = []) {
  const bad = receiptProblems(receipt);
  if (bad.length) throw new IdentityError('identity.receipt', bad.join('; '));
  return { receipt: JSON.parse(JSON.stringify(receipt)), signatures: entries.map((e) => ({ keyId: e.keyId, publicKeyJwk: { ...e.publicKeyJwk }, sig: e.sig })) };
}

/**
 * Verify a signed receipt document. Never throws. Returns
 *   { ok, reasons: [string], signatures: [{ keyId, ok, reason|null }] , digest|null }
 * ok requires: at least opts.minSignatures (default 1) entries, every entry valid, no repeated key, and every key id in
 * opts.requireKeyIds present among the valid entries. Each entry is checked: its JWK is a public P-256 key, its keyId is
 * the id of that JWK, and the signature verifies over receiptBytes(receipt).
 */
export async function verifyReceipt(doc, opts = {}) {
  const reasons = [];
  const results = [];
  if (!isObj(doc) || !isObj(doc.receipt) || !Array.isArray(doc.signatures)) return { ok: false, reasons: ['not a receipt document'], signatures: [], digest: null };
  let bytes;
  try { bytes = receiptBytes(doc.receipt); } catch (e) { return { ok: false, reasons: [e.message], signatures: [], digest: null }; }
  if (doc.signatures.length > 8) return { ok: false, reasons: ['too many signatures'], signatures: [], digest: null };
  const seen = new Set();
  for (const s of doc.signatures) {
    const r = { keyId: isObj(s) && typeof s.keyId === 'string' ? s.keyId : null, ok: false, reason: null };
    results.push(r);
    try {
      if (!isObj(s)) throw new Error('entry is not an object');
      const jwk = normalizePublicJwk(s.publicKeyJwk);
      if ((await keyIdOf(jwk)) !== s.keyId) throw new Error('keyId does not match the public key');
      if (seen.has(s.keyId)) throw new Error('this key signed twice');
      seen.add(s.keyId);
      const sig = typeof s.sig === 'string' ? b64urlDecode(s.sig) : null;
      if (!sig || sig.length !== 64) throw new Error('signature is not 64 canonical bytes');
      if (!(await subtle().verify(SIGN_ALG, await importPublic(jwk), sig, bytes))) throw new Error('signature does not verify');
      r.ok = true;
    } catch (e) { r.reason = e instanceof Error ? e.message : String(e); }
  }
  const valid = results.filter((r) => r.ok);
  for (const r of results) if (!r.ok) reasons.push(`signature by ${r.keyId || '?'}: ${r.reason}`);
  const min = opts.minSignatures === undefined ? 1 : opts.minSignatures;
  if (valid.length < min) reasons.push(`need at least ${min} valid signature(s), have ${valid.length}`);
  for (const id of opts.requireKeyIds || []) if (!valid.some((r) => r.keyId === id)) reasons.push(`no valid signature by required key ${id}`);
  let digest = null;
  try { digest = await receiptDigest(doc.receipt); } catch (_e) { /* receipt already rejected above */ }
  return { ok: reasons.length === 0, reasons, signatures: results, digest };
}
