// Signed, rotating check-in passes, so a screenshot can't be reused at the door.
//
// 1. Once per event the guest's NEAR wallet signs a NEP-413 message (no tx, no gas) that binds
//    event + guest + an ephemeral ed25519 key generated in the browser + an expiry. This is the "cert".
// 2. The page then shows a QR that changes every ROTATE_MS. Each frame carries the cert plus a fresh
//    timestamp signed by the ephemeral key. The private half of that key never leaves the guest's browser.
// 3. The door checks: the wallet signature (NEP-413), that the wallet key is a FULL-ACCESS key of the guest
//    on-chain (view_access_key), cert not expired, frame signed by the cert's ephemeral key, frame
//    at most MAX_AGE_MS old, and frame not seen before. A screenshot is stale in 30 s and single-use.
import { ed25519, sha256, b58encode, b58decode } from './vendor/crypto.js';

export const ROTATE_MS = 10_000, MAX_AGE_MS = 30_000, SKEW_MS = 5_000;
export const CERT_TTL_MS = 24 * 3600_000;
const NEP413_TAG = 2147483648 + 413;
const te = new TextEncoder();

const b64u = (u8) => btoa(String.fromCharCode(...u8)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = (s) => Uint8Array.from(atob(String(s).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
export const b64ToBytes = unb64;
const cat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
const u32 = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; };
const bstr = (s) => { const b = te.encode(s); return cat(u32(b.length), b); };

/** sha256 of the NEP-413 borsh payload: the 32 bytes a wallet signs for signMessage. */
export function nep413Hash({ message, nonce, recipient, callbackUrl = null }) {
  if (nonce.length !== 32) throw new Error('nonce must be 32 bytes');
  return sha256(cat(u32(NEP413_TAG), bstr(message), nonce, bstr(recipient), callbackUrl == null ? Uint8Array.of(0) : cat(Uint8Array.of(1), bstr(callbackUrl))));
}
export const certMessage = ({ event, guest, ephPk, expMs }) => `ShowUp check-in pass\nevent: ${event}\nguest: ${guest}\nkey: ${ephPk}\nexpires: ${new Date(expMs).toISOString()}`;
const frameBytes = (event, guest, t) => te.encode(`showup-pass:${event}:${guest}:${t}`);

/** Guest side: a fresh ephemeral key + the NEP-413 request to hand to the wallet. */
export function newPassRequest({ event, guest, nowMs = Date.now(), random = (n) => crypto.getRandomValues(new Uint8Array(n)) }) {
  const ephSk = random(32), ephPk = 'ed25519:' + b58encode(ed25519.getPublicKey(ephSk));
  const expMs = nowMs + CERT_TTL_MS, nonce = random(32);
  return { ephSk: b64u(ephSk), ephPk, expMs, nonce: b64u(nonce), request: { message: certMessage({ event, guest, ephPk, expMs }), recipient: event, nonce } };
}
/** Combine the wallet's answer ({accountId, publicKey, signature(base64)}) into a stored cert. */
export function makeCert(req, { event, guest }, signed, callbackUrl = null) {
  if (signed.accountId !== guest) throw new Error(`wallet signed as ${signed.accountId}, expected ${guest}`);
  return { event, guest, ephPk: req.ephPk, ephSk: req.ephSk, expMs: req.expMs, nonce: req.nonce, walletPk: signed.publicKey,
    walletSig: b64u(unb64(signed.signature.replace(/-/g, '+').replace(/_/g, '/'))), callbackUrl };
}
/** One QR frame (changes every ROTATE_MS). */
export function passFrame(cert, nowMs = Date.now()) {
  const t = Math.floor(nowMs / 1000) * 1000;
  const s = ed25519.sign(frameBytes(cert.event, cert.guest, t), unb64(cert.ephSk));
  const q = new URLSearchParams({ v: '2', e: cert.event, g: cert.guest, k: cert.ephPk.slice(8), x: String(cert.expMs), n: cert.nonce,
    p: cert.walletPk.slice(8), w: cert.walletSig, t: String(t), s: b64u(s) });
  if (cert.callbackUrl) q.set('u', cert.callbackUrl);
  return `showup:pass?${q}`;
}
export const isPass = (text) => String(text).trim().startsWith('showup:pass?');

export function parsePass(text) {
  if (!isPass(text)) throw new Error('not a signed ShowUp pass');
  const q = new URLSearchParams(String(text).trim().slice('showup:pass?'.length));
  const need = ['v', 'e', 'g', 'k', 'x', 'n', 'p', 'w', 't', 's'];
  for (const k of need) if (!q.get(k)) throw new Error(`pass is missing ${k}`);
  if (q.get('v') !== '2') throw new Error('unsupported pass version');
  return { event: q.get('e'), guest: q.get('g'), ephPk: 'ed25519:' + q.get('k'), expMs: Number(q.get('x')), nonce: q.get('n'),
    walletPk: 'ed25519:' + q.get('p'), walletSig: q.get('w'), t: Number(q.get('t')), s: q.get('s'), callbackUrl: q.get('u') };
}

/**
 * Door side. `accessKey(account, publicKey)` returns the on-chain permission ('FullAccess' | {FunctionCall} | null).
 * `seen` is a Set shared by the door (replay cache). Returns {ok, guest, reason, ageMs}.
 */
export async function verifyPass(text, { event, nowMs = Date.now(), accessKey, seen }) {
  let p;
  try { p = parsePass(text); } catch (e) { return { ok: false, reason: e.message }; }
  const fail = (reason) => ({ ok: false, guest: p.guest, reason });
  if (p.event !== event) return fail(`pass is for ${p.event}, not this event`);
  let walletOk = false, frameOk = false;
  try {
    const msg = certMessage({ event: p.event, guest: p.guest, ephPk: p.ephPk, expMs: p.expMs });
    // Some wallets put callbackUrl in the signed payload (MyNearWallet), others don't: accept either.
    for (const callbackUrl of p.callbackUrl ? [p.callbackUrl, null] : [null]) {
      const h = nep413Hash({ message: msg, nonce: unb64(p.nonce), recipient: p.event, callbackUrl });
      if ((walletOk = ed25519.verify(unb64(p.walletSig), h, b58decode(p.walletPk.slice(8))))) break;
    }
  } catch { walletOk = false; }
  if (!walletOk) return fail('wallet signature on the pass is invalid');
  if (nowMs > p.expMs) return fail('pass expired, ask the guest to refresh it');
  try { frameOk = ed25519.verify(unb64(p.s), frameBytes(p.event, p.guest, p.t), b58decode(p.ephPk.slice(8))); } catch { frameOk = false; }
  if (!frameOk) return fail('rotating code signature is invalid');
  const ageMs = nowMs - p.t;
  if (ageMs > MAX_AGE_MS) return { ...fail(`code is ${Math.round(ageMs / 1000)} s old: likely a screenshot. Ask for the live screen.`), ageMs };
  if (ageMs < -SKEW_MS) return fail('code is from the future (clock skew?)');
  const id = `${p.guest}|${p.s}`;
  if (seen?.has(id)) return fail('this exact code was already scanned (replay)');
  let perm;
  try { perm = await accessKey(p.guest, p.walletPk); } catch (e) { return fail(e.message); }
  if (perm == null) return fail(`${p.walletPk.slice(0, 16)}… is not a key of ${p.guest} on-chain`);
  if (perm !== 'FullAccess') return fail('pass was signed with a function-call key, not the guest\'s wallet key');
  seen?.add(id);
  return { ok: true, guest: p.guest, ageMs, walletPk: p.walletPk };
}

/** view_access_key over JSON-RPC (tries each endpoint) → 'FullAccess' | {FunctionCall} | null (unknown key). */
export const rpcAccessKey = (rpcs, fetchImpl = fetch) => async (account_id, public_key) => {
  let err;
  for (const rpc of [rpcs].flat()) {
    try {
      const r = await fetchImpl(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout?.(8000),
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: { request_type: 'view_access_key', finality: 'final', account_id, public_key } }) });
      const j = await r.json();
      const msg = JSON.stringify(j.error ?? j.result?.error ?? '');
      if (/UNKNOWN_ACCESS_KEY|does not exist|UNKNOWN_ACCOUNT/i.test(msg)) return null;
      if (j.error || j.result?.error) throw new Error(msg.slice(0, 120));
      return j.result.permission;
    } catch (e) { err = e; }
  }
  throw new Error(`could not read access key: ${err?.message}`);
};
