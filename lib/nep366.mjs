// NEP-366 meta transactions without near-api-js: borsh encode/decode of Action, DelegateAction,
// SignedDelegateAction and (signed) Transaction, plus ed25519 signing. Runs in browsers and Node.
// Layouts follow nearcore `core/primitives/src/action/{mod,delegate}.rs` and `transaction.rs`.
import { ed25519, sha256, b58encode, b58decode } from '../widget/vendor/crypto.js';

export const NEP366_TAG = 2 ** 30 + 366; // DelegateAction signatures are over sha256(u32 tag || borsh(DelegateAction))
export const ACTION = ['CreateAccount', 'DeployContract', 'FunctionCall', 'Transfer', 'Stake', 'AddKey', 'DeleteKey', 'DeleteAccount', 'Delegate',
  'DeployGlobalContract', 'UseGlobalContract'];
const te = new TextEncoder(), td = new TextDecoder('utf-8', { fatal: true });

// ---- writer ----
class W {
  constructor() { this.parts = []; this.n = 0; }
  bytes(b) { this.parts.push(b); this.n += b.length; return this; }
  u8(v) { return this.bytes(Uint8Array.of(v)); }
  u32(v) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v, true); return this.bytes(b); }
  uN(v, size) {
    let x = BigInt(v); if (x < 0n || x >= 1n << BigInt(size * 8)) throw new Error(`u${size * 8} out of range`);
    const b = new Uint8Array(size); for (let i = 0; i < size; i++) { b[i] = Number(x & 255n); x >>= 8n; } return this.bytes(b);
  }
  u64(v) { return this.uN(v, 8); }
  u128(v) { return this.uN(v, 16); }
  str(s) { const b = te.encode(s); return this.u32(b.length).bytes(b); }
  vecBytes(b) { return this.u32(b.length).bytes(b); }
  out() { const o = new Uint8Array(this.n); let i = 0; for (const p of this.parts) { o.set(p, i); i += p.length; } return o; }
}
// ---- reader (throws on truncation / trailing bytes) ----
class R {
  constructor(b) { this.b = b; this.i = 0; }
  take(n) { if (this.i + n > this.b.length) throw new Error('borsh: unexpected end of input'); const s = this.b.subarray(this.i, this.i + n); this.i += n; return s; }
  u8() { return this.take(1)[0]; }
  u32() { return new DataView(this.take(4).slice().buffer).getUint32(0, true); }
  uN(size) { const s = this.take(size); let x = 0n; for (let i = size - 1; i >= 0; i--) x = (x << 8n) | BigInt(s[i]); return x; }
  u64() { return this.uN(8); }
  u128() { return this.uN(16); }
  bytes(n) { return this.take(n).slice(); }
  vecBytes() { return this.bytes(this.u32()); }
  str() { return td.decode(this.vecBytes()); }
  vec(fn) { const n = this.u32(); if (n > 1024) throw new Error('borsh: vector too long'); return Array.from({ length: n }, () => fn(this)); }
  done() { if (this.i !== this.b.length) throw new Error('borsh: trailing bytes'); }
}

// ---- keys ----
/** "ed25519:<base58>" -> {keyType:0, data:32 bytes}. Only ed25519 is supported here. */
export function parsePublicKey(pk) {
  if (typeof pk === 'object' && pk?.data) return pk;
  const m = /^ed25519:([1-9A-HJ-NP-Za-km-z]+)$/.exec(String(pk));
  if (!m) throw new Error('expected an ed25519 public key');
  const data = b58decode(m[1]); if (data.length !== 32) throw new Error('bad ed25519 public key length');
  return { keyType: 0, data };
}
export const publicKeyToString = (k) => (k.keyType === 0 ? 'ed25519:' : 'secp256k1:') + b58encode(k.data);
/** "ed25519:<base58 64-byte secret>" (near-credentials / browser keystore format) -> {secret (32-byte seed), publicKey}. */
export function parseSecretKey(sk) {
  const m = /^ed25519:([1-9A-HJ-NP-Za-km-z]+)$/.exec(String(sk));
  if (!m) throw new Error('expected an ed25519 secret key');
  const raw = b58decode(m[1]); if (raw.length !== 64 && raw.length !== 32) throw new Error('bad ed25519 secret key length');
  const secret = raw.slice(0, 32);
  return { secret, publicKey: 'ed25519:' + b58encode(ed25519.getPublicKey(secret)) };
}
const wPk = (w, k) => { const p = parsePublicKey(k); w.u8(p.keyType); return w.bytes(p.data); };
const rPk = (r) => { const keyType = r.u8(); if (keyType === 0) return { keyType, data: r.bytes(32) }; if (keyType === 1) return { keyType, data: r.bytes(64) }; throw new Error(`unknown key type ${keyType}`); };
const rSig = (r) => { const keyType = r.u8(); return { keyType, data: r.bytes(keyType === 0 ? 64 : keyType === 1 ? 65 : (() => { throw new Error(`unknown signature type ${keyType}`); })()) }; };

// ---- actions ----
/** Action constructors (plain objects; `type` is the enum variant name). */
export const actions = {
  functionCall: (methodName, args = {}, gas = 30_000_000_000_000n, deposit = 0n) => ({ type: 'FunctionCall', methodName,
    args: args instanceof Uint8Array ? args : te.encode(JSON.stringify(args)), gas: BigInt(gas), deposit: BigInt(deposit) }),
  transfer: (deposit) => ({ type: 'Transfer', deposit: BigInt(deposit) }),
  addFullAccessKey: (publicKey) => ({ type: 'AddKey', publicKey, accessKey: { nonce: 0n, permission: 'FullAccess' } }),
  deleteKey: (publicKey) => ({ type: 'DeleteKey', publicKey }),
  deleteAccount: (beneficiaryId) => ({ type: 'DeleteAccount', beneficiaryId }),
  createAccount: () => ({ type: 'CreateAccount' }),
  deployContract: (code) => ({ type: 'DeployContract', code }),
  stake: (stake, publicKey) => ({ type: 'Stake', stake: BigInt(stake), publicKey }),
  delegate: (signedDelegate) => ({ type: 'Delegate', signedDelegate }),
};

function wAction(w, a) {
  const tag = ACTION.indexOf(a.type);
  if (tag < 0 || tag > 8) throw new Error(`cannot encode action ${a.type}`);
  w.u8(tag);
  switch (a.type) {
    case 'CreateAccount': return;
    case 'DeployContract': return void w.vecBytes(a.code);
    case 'FunctionCall': return void w.str(a.methodName).vecBytes(a.args).u64(a.gas).u128(a.deposit);
    case 'Transfer': return void w.u128(a.deposit);
    case 'Stake': w.u128(a.stake); return void wPk(w, a.publicKey);
    case 'AddKey': {
      wPk(w, a.publicKey); w.u64(a.accessKey.nonce ?? 0n);
      const p = a.accessKey.permission;
      if (p === 'FullAccess') return void w.u8(1);
      w.u8(0);
      if (p.allowance == null) w.u8(0); else w.u8(1).u128(p.allowance);
      w.str(p.receiverId).u32(p.methodNames.length); for (const m of p.methodNames) w.str(m);
      return;
    }
    case 'DeleteKey': return void wPk(w, a.publicKey);
    case 'DeleteAccount': return void w.str(a.beneficiaryId);
    case 'Delegate': return void wSignedDelegate(w, a.signedDelegate);
  }
}
function rAction(r, { nested = false } = {}) {
  const tag = r.u8(), type = ACTION[tag];
  switch (type) {
    case 'CreateAccount': return { type };
    case 'DeployContract': return { type, code: r.vecBytes() };
    case 'FunctionCall': return { type, methodName: r.str(), args: r.vecBytes(), gas: r.u64(), deposit: r.u128() };
    case 'Transfer': return { type, deposit: r.u128() };
    case 'Stake': return { type, stake: r.u128(), publicKey: rPk(r) };
    case 'AddKey': {
      const publicKey = rPk(r), nonce = r.u64(), ptag = r.u8();
      if (ptag === 1) return { type, publicKey, accessKey: { nonce, permission: 'FullAccess' } };
      if (ptag !== 0) throw new Error(`unknown access key permission ${ptag}`);
      const allowance = r.u8() ? r.u128() : null, receiverId = r.str(), methodNames = r.vec((x) => x.str());
      return { type, publicKey, accessKey: { nonce, permission: { allowance, receiverId, methodNames } } };
    }
    case 'DeleteKey': return { type, publicKey: rPk(r) };
    case 'DeleteAccount': return { type, beneficiaryId: r.str() };
    case 'Delegate': if (nested) throw new Error('nested Delegate action is not allowed'); return { type, signedDelegate: rSignedDelegate(r) };
    default: throw new Error(`unsupported action tag ${tag}`);
  }
}

// ---- DelegateAction / SignedDelegateAction ----
function wDelegate(w, d) {
  w.str(d.senderId).str(d.receiverId).u32(d.actions.length);
  for (const a of d.actions) { if (a.type === 'Delegate') throw new Error('nested Delegate action is not allowed'); wAction(w, a); }
  w.u64(d.nonce).u64(d.maxBlockHeight); wPk(w, d.publicKey);
}
const rDelegate = (r) => ({ senderId: r.str(), receiverId: r.str(), actions: r.vec((x) => rAction(x, { nested: true })), nonce: r.u64(), maxBlockHeight: r.u64(), publicKey: rPk(r) });
function wSignedDelegate(w, s) { wDelegate(w, s.delegateAction); w.u8(s.signature.keyType ?? 0).bytes(s.signature.data); }
const rSignedDelegate = (r) => ({ delegateAction: rDelegate(r), signature: rSig(r) });

export const encodeDelegateAction = (d) => { const w = new W(); wDelegate(w, d); return w.out(); };
export const encodeSignedDelegate = (s) => { const w = new W(); wSignedDelegate(w, s); return w.out(); };
export function decodeSignedDelegate(bytes) { const r = new R(bytes); const s = rSignedDelegate(r); r.done(); return s; }
/** The 32 bytes the sender signs: sha256(u32 NEP366_TAG || borsh(DelegateAction)). */
export const delegateHash = (d) => { const w = new W(); w.u32(NEP366_TAG); wDelegate(w, d); return sha256(w.out()); };

export function buildDelegateAction({ senderId, receiverId, actions: acts, nonce, maxBlockHeight, publicKey }) {
  if (!senderId || !receiverId || !acts?.length) throw new Error('senderId, receiverId and actions are required');
  return { senderId, receiverId, actions: acts, nonce: BigInt(nonce), maxBlockHeight: BigInt(maxBlockHeight), publicKey: parsePublicKey(publicKey) };
}
/** Sign with an ed25519 secret ("ed25519:<base58>" or a 32-byte seed). */
export function signDelegateAction(delegateAction, secretKey) {
  const seed = secretKey instanceof Uint8Array ? secretKey : parseSecretKey(secretKey).secret;
  return { delegateAction, signature: { keyType: 0, data: ed25519.sign(delegateHash(delegateAction), seed) } };
}
export function verifySignedDelegate(s) {
  const pk = s.delegateAction.publicKey;
  if (pk.keyType !== 0 || s.signature.keyType !== 0) return false;
  try { return ed25519.verify(s.signature.data, delegateHash(s.delegateAction), pk.data); } catch { return false; }
}

// ---- Transaction (V0) ----
function wTx(w, t) {
  w.str(t.signerId); wPk(w, t.publicKey); w.u64(t.nonce).str(t.receiverId);
  const bh = typeof t.blockHash === 'string' ? b58decode(t.blockHash) : t.blockHash;
  if (bh.length !== 32) throw new Error('block hash must be 32 bytes');
  w.bytes(bh).u32(t.actions.length); for (const a of t.actions) wAction(w, a);
}
export const encodeTransaction = (t) => { const w = new W(); wTx(w, t); return w.out(); };
/** Unsigned borsh Transaction (what MyNearWallet receives in /sign?transactions=). */
export function decodeTransaction(bytes) {
  const r = new R(bytes);
  const t = { signerId: r.str(), publicKey: rPk(r), nonce: r.u64(), receiverId: r.str(), blockHash: r.bytes(32), actions: r.vec((x) => rAction(x)) };
  r.done(); return t;
}
export function decodeSignedTransaction(bytes) {
  const r = new R(bytes);
  const t = { signerId: r.str(), publicKey: rPk(r), nonce: r.u64(), receiverId: r.str(), blockHash: r.bytes(32), actions: r.vec((x) => rAction(x)) };
  const signature = rSig(r); r.done(); return { transaction: t, signature };
}
/** -> { bytes (borsh SignedTransaction), hash (base58 tx hash) } */
export function signTransaction(t, secretKey) {
  const seed = secretKey instanceof Uint8Array ? secretKey : parseSecretKey(secretKey).secret;
  const body = encodeTransaction(t), h = sha256(body), sig = ed25519.sign(h, seed);
  const w = new W(); w.bytes(body).u8(0).bytes(sig);
  return { bytes: w.out(), hash: b58encode(h) };
}

// ---- base64 + JSON-friendly view ----
export const toBase64 = (u8) => { let s = ''; for (const c of u8) s += String.fromCharCode(c); return btoa(s); };
export const fromBase64 = (s) => { if (typeof s !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(s)) throw new Error('not base64'); return Uint8Array.from(atob(s), (c) => c.charCodeAt(0)); };
export const encodeSignedDelegateBase64 = (s) => toBase64(encodeSignedDelegate(s));
export const decodeSignedDelegateBase64 = (s) => decodeSignedDelegate(fromBase64(s));

// ---- client helper: build + sign + POST to a relayer ----
async function rpcQuery(rpc, params, fetchImpl) {
  const r = await fetchImpl(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'showup', ...params }) });
  const j = await r.json();
  if (j.error || j.result?.error) throw new Error(`RPC: ${JSON.stringify(j.error?.cause ?? j.error ?? j.result.error).slice(0, 200)}`);
  return j.result;
}
/**
 * Builds and signs a SignedDelegateAction for one zero-deposit function call.
 * nonce = access key nonce + 1, maxBlockHeight = final head + ttlBlocks (≈1 block/s on testnet).
 */
export async function signedDelegateCall({ senderId, secretKey, receiverId, methodName, args = {}, gas = 30_000_000_000_000n,
  ttlBlocks = 120, rpc = 'https://rpc.testnet.fastnear.com', fetchImpl = fetch }) {
  const { publicKey } = parseSecretKey(secretKey);
  const ak = await rpcQuery(rpc, { method: 'query', params: { request_type: 'view_access_key', finality: 'final', account_id: senderId, public_key: publicKey } }, fetchImpl);
  const head = await rpcQuery(rpc, { method: 'block', params: { finality: 'final' } }, fetchImpl);
  const da = buildDelegateAction({ senderId, receiverId, publicKey, nonce: BigInt(ak.nonce) + 1n,
    maxBlockHeight: BigInt(head.header.height) + BigInt(ttlBlocks), actions: [actions.functionCall(methodName, args, gas, 0n)] });
  return signDelegateAction(da, secretKey);
}
/** POST {signed_delegate: base64} to `${relayerUrl}/relay`. Resolves to {hash, ...}; rejects with the relayer's reason. */
export async function relaySignedDelegate(relayerUrl, signed, { fetchImpl = fetch } = {}) {
  const r = await fetchImpl(relayerUrl.replace(/\/$/, '') + '/relay', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ signed_delegate: encodeSignedDelegateBase64(signed) }) });
  let j; try { j = await r.json(); } catch { j = {}; }
  if (!r.ok || !j.hash || j.ok === false) throw new Error(`relayer: ${j.error || j.reason || `HTTP ${r.status}`}`);
  return j;
}
/**
 * The function-call key the wallet added at sign-in, if this browser holds it.
 * Wallet Selector 10's MyNearWallet keeps it as localStorage `functionCallKey` = {privateKey, contractId, methods} next to
 * `signedAccountId` (and migrates/removes the legacy near-api-js keystore entry on load); older near-api-js wallets keep
 * `near-api-js:keystore:<account>:<network>`. With `receiverId`, a key scoped to another contract is ignored.
 */
export function browserFunctionCallKey(storage, accountId, network = 'testnet', receiverId) {
  try {
    const v = storage?.getItem(`near-api-js:keystore:${accountId}:${network}`);
    if (v && /^ed25519:/.test(v)) return v;
    const fk = JSON.parse(storage?.getItem('functionCallKey') || 'null');
    if (fk && typeof fk.privateKey === 'string' && /^ed25519:/.test(fk.privateKey) && storage.getItem('signedAccountId') === accountId
      && (!receiverId || fk.contractId === receiverId)) return fk.privateKey;
  } catch {}
  return null;
}
