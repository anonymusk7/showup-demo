// ShowUp widget core: pure helpers + fetch-injectable RPC/1Click calls. Runs in browsers and Node (tests).
export const RPC_TESTNET = 'https://rpc.testnet.near.org';
export const ONECLICK_BASE = 'https://1click.chaindefuser.com/v0';
// In a page we first try the dev server's same-origin proxy (scripts/serve.mjs, POST /api/1click/quote). 1Click now
// answers CORS (access-control-allow-origin: *, checked 2026-11-09), so on a static host with no proxy (GitHub Pages)
// a 404/405 or network error from the proxy falls back to calling 1Click directly.
export const ONECLICK_PROXY = (() => { try { const u = new URL('/api/1click', import.meta.url); return /^https?:$/.test(u.protocol) ? u.href : null; } catch { return null; } })();
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])$/;
// The proxy only exists on the local dev server; a hosted page (GitHub Pages, any embed) calls 1Click directly.
export const defaultQuoteBase = () => (globalThis.document && ONECLICK_PROXY && LOCAL_HOST.test(new URL(ONECLICK_PROXY).hostname) && ONECLICK_PROXY) || ONECLICK_BASE;
/** Short, human error for a failed quote. 5xx / 52x / HTML bodies / network errors mean 1Click is down. */
export function friendlyQuoteError(err) {
  const m = String(err?.message || err);
  if (/Failed to fetch|NetworkError|fetch failed|ECONN|ENOTFOUND|\b5\d\d\b|<html|<!DOCTYPE/i.test(m))
    return '1Click quotes are unavailable right now (the service looks down). You can still RSVP by paying in NEAR.';
  // 1Click answers 4xx with JSON {message, correlationId, timestamp}: show only the message, never the raw body
  const j = /\{[\s\S]*/.exec(m), msg = (() => { try { return JSON.parse(j[0]).message; } catch { const x = /"message"\s*:\s*"([^"]*)"/.exec(m); return x?.[1]; } })();
  const low = /amount is too low[^0-9]*(\d+)/i.exec(msg || m);
  if (low) return `This deposit is below 1Click's minimum for a cross-chain payment (about ${formatNear(low[1], 4)} NEAR). Pay the deposit in NEAR instead.`;
  const t = msg ? `1Click: ${msg}` : m;
  return t.length > 200 ? t.slice(0, 200) + '…' : t;
}
/** Short, human error for a failed NEAR RPC view (event load, status read). */
export function friendlyRpcError(err) {
  const m = String(err?.message || err || 'unknown error'), n = String(err?.name || '');
  if (/UNKNOWN_ACCOUNT|does not exist|CodeDoesNotExist|MethodNotFound/i.test(m)) return 'This event wasn\'t found on NEAR testnet. Check the event account.';
  if (/^(TimeoutError|AbortError)$/.test(n) || /Failed to fetch|fetch failed|NetworkError|Load failed|ECONN|ENOTFOUND|EAI_AGAIN|time(d)? ?out|aborted|-429|HTTP (429|5\d\d)|malformed RPC/i.test(m))
    return 'Can\'t reach NEAR testnet right now. Check your connection and try again.';
  const t = m.replace(/\s+/g, ' ').trim();
  return t.length > 200 ? t.slice(0, 200) + '…' : t;
}
export const YOCTO = 10n ** 24n;
// 1Click runs on mainnet only, so the preview prices the deposit as wNEAR on mainnet.
export const WNEAR = 'nep141:wrap.near';
export const PREVIEW_RECIPIENT = 'anonymusk.near';
export const ORIGINS = [
  { id: 'usdc-base', label: 'USDC on Base', symbol: 'USDC', asset: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near', refundTo: '0x0000000000000000000000000000000000000001' },
  { id: 'usdc-arb', label: 'USDC on Arbitrum', symbol: 'USDC', asset: 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near', refundTo: '0x0000000000000000000000000000000000000001' },
  { id: 'usdc-sol', label: 'USDC on Solana', symbol: 'USDC', asset: 'nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near', refundTo: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' },
  { id: 'eth-base', label: 'ETH on Base', symbol: 'ETH', asset: 'nep141:base.omft.near', refundTo: '0x0000000000000000000000000000000000000001' },
  { id: 'sol', label: 'SOL on Solana', symbol: 'SOL', asset: 'nep141:sol.omft.near', refundTo: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' },
];

const b64 = (s) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

export function buildViewRequest(accountId, method, args = {}) {
  return { jsonrpc: '2.0', id: 'showup', method: 'query',
    params: { request_type: 'call_function', finality: 'final', account_id: accountId, method_name: method, args_base64: b64(JSON.stringify(args)) } };
}

export function parseViewResponse(json) {
  if (json.error) throw new Error(`RPC error: ${json.error.cause?.name || json.error.name || 'unknown'} ${json.error.data || json.error.message || ''}`.trim());
  if (json.result?.error) throw new Error(`view failed: ${json.result.error}`);
  if (!Array.isArray(json.result?.result)) throw new Error('malformed RPC response');
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(json.result.result)));
}

// rpc.testnet.near.org sometimes answers -429 (rate limit / deprecation notice); fall back to FastNEAR's public testnet RPC.
export const RPC_FALLBACKS = [RPC_TESTNET, 'https://rpc.testnet.fastnear.com'];

/** View call. An explicit `rpc` is used alone; otherwise each RPC_FALLBACKS entry is tried on network error, HTTP error or -429. */
export async function viewCall(accountId, method, args = {}, { rpc, fetchImpl = fetch } = {}) {
  const body = JSON.stringify(buildViewRequest(accountId, method, args));
  let lastErr;
  for (const url of rpc ? [rpc] : RPC_FALLBACKS) {
    try {
      const r = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout?.(8000) });
      if (!r.ok) throw new Error(`RPC HTTP ${r.status}`);
      const json = await r.json();
      if (json.error?.code === -429) throw new Error(`RPC -429 ${json.error.message || ''}`.trim());
      return parseViewResponse(json);
    } catch (e) {
      if (/^(RPC error|view failed|malformed)/.test(e.message)) throw e; // contract-level answer: don't retry elsewhere
      lastErr = e;
    }
  }
  throw lastErr;
}

/** yocto string/bigint -> "1.2345" (truncated, trailing zeros trimmed). */
export function formatNear(yocto, digits = 4) {
  const y = BigInt(yocto), whole = y / YOCTO, frac = (y % YOCTO).toString().padStart(24, '0').slice(0, digits).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

export function phaseOf(info, nowNs) {
  const now = BigInt(nowNs);
  if (info.settled) return 'settled';
  if (now < BigInt(info.cancel_deadline_ns)) return 'open';
  if (now < BigInt(info.checkin_start_ns)) return 'closed';
  if (now <= BigInt(info.checkin_end_ns)) return 'checkin';
  return 'ended';
}

export const PHASE_LABEL = { open: 'RSVP open', closed: 'RSVP closed', checkin: 'Check-in live', ended: 'Ended, awaiting settle', settled: 'Settled' };

export function eventSummary(info, nowNs) {
  const spotsLeft = Math.max(0, info.capacity - info.active), phase = phaseOf(info, nowNs);
  return { host: info.host, deposit: String(info.deposit), depositNear: formatNear(info.deposit), capacity: info.capacity,
    active: info.active, spotsLeft, phase, phaseLabel: PHASE_LABEL[phase], canRsvp: phase === 'open' && spotsLeft > 0,
    cancelDeadline: new Date(Number(BigInt(info.cancel_deadline_ns) / 1_000_000n)).toISOString() };
}

export function buildQuoteRequest({ originAsset, depositYocto, refundTo, recipient = PREVIEW_RECIPIENT, now = Date.now() }) {
  if (!originAsset || !depositYocto || !refundTo) throw new Error('missing quote fields');
  return { dry: true, swapType: 'EXACT_OUTPUT', slippageTolerance: 100, originAsset, depositType: 'ORIGIN_CHAIN',
    destinationAsset: WNEAR, amount: String(depositYocto), refundTo, refundType: 'ORIGIN_CHAIN', recipient,
    recipientType: 'DESTINATION_CHAIN', deadline: new Date(now + 3600e3).toISOString() };
}

/** Dry (no funds, no deposit address) 1Click quote: how much of `origin` buys exactly the deposit in NEAR. */
export async function quoteDeposit(origin, depositYocto, { base = defaultQuoteBase(), fetchImpl = fetch, now } = {}) {
  const body = buildQuoteRequest({ originAsset: origin.asset, depositYocto, refundTo: origin.refundTo, now });
  const post = (b) => fetchImpl(`${b}/quote`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  let r;
  if (base !== ONECLICK_BASE && base === ONECLICK_PROXY) {
    r = await post(base).catch(() => null);
    if (!r || r.status === 404 || r.status === 405) r = await post(ONECLICK_BASE);
  } else r = await post(base);
  if (!r.ok) { const t = await r.text(); throw new Error(`1Click quote failed: ${r.status} ${/<html|<!DOCTYPE/i.test(t) ? '(service unavailable)' : t.slice(0, 300)}`); }
  return r.json();
}

export function summarizeQuote(q, origin) {
  const x = q?.quote;
  if (!x?.amountInFormatted) throw new Error('quote missing amountIn');
  return { pay: `${x.amountInFormatted} ${origin.symbol}`, from: origin.label, usd: x.amountInUsd ? Number(x.amountInUsd).toFixed(2) : null,
    receive: `${x.amountOutFormatted} NEAR`, etaSec: x.timeEstimate ?? null };
}

export const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function rsvpCommand(eventId, depositYocto) {
  return `near contract call-function as-transaction ${eventId} rsvp json-args '{}' prepaid-gas '30.0 Tgas' attached-deposit '${formatNear(depositYocto, 24)} NEAR' sign-as <your-account>.testnet network-config testnet sign-with-keychain send`;
}

// ---- wallet sign-in + QR check-in (pure helpers; DOM glue below) ----
const ACCOUNT_RE = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
export const isAccountId = (s) => typeof s === 'string' && ACCOUNT_RE.test(s);

/** What the guest's main button should do, given the event, their on-chain status and whether a wallet is signed in. */
export function guestAction(s, status, accountId) {
  if (!accountId) return s.canRsvp ? { kind: 'signin', label: 'Sign in with NEAR wallet to RSVP' } : { kind: 'none', label: s.spotsLeft === 0 && s.phase === 'open' ? 'Event full' : s.phaseLabel, disabled: true };
  if (status === 'CheckedIn') return { kind: 'none', label: 'Checked in ✓', disabled: true, note: 'You showed up. Your deposit plus a share of the no-show pool is paid out at settle.' };
  if (status === 'Rsvp') {
    if (s.phase === 'open') return { kind: 'cancel', label: `Cancel RSVP (refund ${s.depositNear} NEAR)`, note: 'You\'re in. Show the QR code at the door to check in.' };
    return { kind: 'none', label: 'RSVPed', disabled: true, note: s.phase === 'checkin' || s.phase === 'closed' ? 'You\'re in. Show the QR code at the door to check in.' : 'This event has ended.' };
  }
  if (s.canRsvp) return { kind: 'rsvp', label: `RSVP: lock ${s.depositNear} NEAR` };
  return { kind: 'none', label: s.spotsLeft === 0 && s.phase === 'open' ? 'Event full' : s.phaseLabel, disabled: true };
}

/** The QR text a guest shows at the door. It identifies the guest; the host still checks the face/name (see README limits). */
export function checkinPayload(eventId, guest) {
  if (!isAccountId(eventId) || !isAccountId(guest)) throw new Error('bad account id');
  return `showup:checkin?event=${eventId}&guest=${guest}`;
}
export function parseCheckinPayload(text, expectEvent) {
  const m = /^showup:checkin\?event=([^&\s]+)&guest=([^&\s]+)$/.exec(String(text).trim());
  if (!m) { if (isAccountId(String(text).trim())) return { event: expectEvent ?? null, guest: String(text).trim() }; throw new Error('not a ShowUp check-in code'); }
  const [, event, guest] = m;
  if (!isAccountId(event) || !isAccountId(guest)) throw new Error('bad account id in code');
  if (expectEvent && event !== expectEvent) throw new Error(`code is for ${event}, not this event`);
  return { event, guest };
}
/** Pre-flight for the door: mirrors the contract's check_in requires so the host sees the reason before signing. */
export function checkinCheck(info, { checker, status, nowNs }) {
  if (!checker) return { ok: false, reason: 'Sign in as the host or a checker first.' };
  if (checker !== info.host && !(info.checkers || []).includes(checker)) return { ok: false, reason: `${checker} is not the host or a checker for this event.` };
  const now = BigInt(nowNs);
  if (now < BigInt(info.checkin_start_ns)) return { ok: false, reason: 'Check-in has not opened yet.' };
  if (now > BigInt(info.checkin_end_ns)) return { ok: false, reason: 'The check-in window is over.' };
  if (status === 'CheckedIn') return { ok: false, reason: 'Already checked in.' };
  if (status !== 'Rsvp') return { ok: false, reason: status === 'Cancelled' ? 'This guest cancelled.' : 'No RSVP for this guest.' };
  return { ok: true };
}
const WALLET_KEYS = ['near-wallet-selector:selectedWalletId', 'near-wallet-selector:recentlySignedInWallets'];
/** Load the 1.8 MB wallet bundle only once someone has used a wallet here or is returning from one. */
export function walletWasUsed(storage, search = '') {
  try { if (WALLET_KEYS.some((k) => { const v = storage?.getItem(k); return v && v !== 'null' && v !== '[]'; })) return true; } catch {}
  return /[?&](account_id|transactionHashes|errorCode)=/.test(search);
}
export const loadPass = () => import(new URL('pass.mjs', import.meta.url).href);
const PASS_KEY = (ev, g) => `showup-pass:${ev}:${g}`;
/** MyNearWallet returns signMessage results in the URL hash: #accountId=…&publicKey=…&signature=… */
export function signedFromHash(hash) {
  const h = new URLSearchParams(String(hash || '').replace(/^#/, ''));
  return h.get('signature') && h.get('publicKey') && h.get('accountId') ? { accountId: h.get('accountId'), publicKey: h.get('publicKey'), signature: h.get('signature') } : null;
}
export const loadWallet = (opts) => import(new URL('vendor/wallet.js', import.meta.url).href).then((m) => m.initWallet(opts));
export const qrDataUrl = (text) => import(new URL('vendor/qr.js', import.meta.url).href).then((m) => m.toDataURL(text));
export const explorerTx = (h) => `https://testnet.near.rocks/tx/${h}`; // the testnet.nearblocks.io UI is Cloudflare-blocked

/**
 * Gasless path (NEP-366): if a relayer is configured and the browser holds the function-call key the wallet added at
 * sign-in (MyNearWallet keeps it in localStorage as `functionCallKey`), sign a DelegateAction with it and let the relayer pay the gas.
 * Returns {hash, gasless: true}, or null when this path is unavailable. Throws if the relayer refused; callers then
 * fall back to a normal wallet-signed transaction.
 */
export async function gaslessCall({ relayer, accountId, receiverId, methodName, args = {}, storage = globalThis.localStorage, rpc, fetchImpl = fetch,
  loadNep366 = () => import(new URL('../lib/nep366.mjs', import.meta.url).href) }) {
  if (!relayer || !accountId) return null;
  const N = await loadNep366();
  const secretKey = N.browserFunctionCallKey(storage, accountId, 'testnet', receiverId);
  if (!secretKey) return null;
  const signed = await N.signedDelegateCall({ senderId: accountId, secretKey, receiverId, methodName, args, fetchImpl, ...(rpc ? { rpc } : {}) });
  const out = await N.relaySignedDelegate(relayer, signed, { fetchImpl });
  return { hash: out.hash, gasless: true };
}

/** Try the gasless relayer first; on any relayer failure (403, 502, 503 outage / out of funds, offline) use the wallet. */
export async function gaslessOrWallet(gasless, viaWallet, warn = (m) => console.warn('ShowUp gasless path unavailable, using the wallet:', m)) {
  const out = await Promise.resolve().then(gasless).catch((e) => { warn(e?.message || String(e)); return null; });
  return out ?? viaWallet();
}

export const ONBOARDING_HINT = 'New to NEAR? Create a free testnet wallet at <a href="https://testnet.mynearwallet.com/" target="_blank" rel="noreferrer">MyNearWallet</a> — testnet NEAR is free from the <a href="https://near-faucet.io/" target="_blank" rel="noreferrer">faucet</a>.';

export function renderCard(eventId, s) {
  const e = escapeHtml;
  const opts = ORIGINS.map((o) => `<option value="${o.id}">${e(o.label)}</option>`).join('');
  const pct = s.capacity ? Math.round((100 * s.active) / s.capacity) : 0;
  const a = guestAction(s, null, null); // first paint is always signed out: clicking opens the wallet sign-in
  return `<div class="card">
  <div class="head"><strong>${e(eventId)}</strong><span class="pill ${s.phase}">${e(s.phaseLabel)}</span></div>
  <dl>
    <div><dt>Deposit</dt><dd data-k="deposit">${e(s.depositNear)} NEAR</dd></div>
    <div><dt>Capacity</dt><dd data-k="capacity">${s.capacity}</dd></div>
    <div><dt>Spots left</dt><dd data-k="spots">${s.spotsLeft}</dd></div>
  </dl>
  <div class="bar" title="${s.active} of ${s.capacity} spots taken"><i style="width:${pct}%"></i></div>
  <p class="fine">Show up and get your deposit back plus a share of the no-shows' deposits. ${s.phase === 'open' ? `You can cancel for a full refund until ${e(s.cancelDeadline.replace('T', ' ').slice(0, 16))} UTC.` : 'RSVPs are closed.'}</p>
  <div class="who" hidden></div>
  <button class="rsvp" ${a.disabled ? 'disabled' : ''}>${e(a.label)}</button>
  ${a.kind === 'signin' ? `<p class="hint">${ONBOARDING_HINT}</p>` : ''}
  <p class="note" hidden></p>
  <div class="qr" hidden></div>
  ${s.canRsvp ? `<details class="cli"><summary>Prefer a terminal?</summary><pre class="cmd"></pre></details>` : ''}
  ${s.canRsvp ? `<div class="pay"><label>Pay from any chain (1Click preview) <select name="origin">${opts}</select></label><div class="quote">…</div></div>` : ''}
</div>`;
}

export const CSS = `:host{all:initial;font:14px/1.45 ui-sans-serif,system-ui,-apple-system,sans-serif;color:#0f172a}
*{box-sizing:border-box}[hidden],.note:empty{display:none!important}
.card{border:1px solid #e2e8f0;border-radius:16px;padding:18px;max-width:390px;background:#fff;box-shadow:0 1px 2px rgb(0 0 0/.04),0 8px 24px -12px rgb(15 23 42/.18)}
.head{display:flex;justify-content:space-between;align-items:flex-start;gap:8px;word-break:break-all}
.pill{font-size:11.5px;font-weight:600;padding:3px 9px;border-radius:99px;background:#f1f5f9;color:#334155;white-space:nowrap}
.pill.open{background:#dcfce7;color:#166534}.pill.checkin{background:#fef3c7;color:#92400e}.pill.settled{background:#e0e7ff;color:#3730a3}
dl{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:14px 0 10px}dl>div{background:#f8fafc;border-radius:10px;padding:8px 10px}
dt{font-size:11.5px;color:#64748b}dd{margin:2px 0 0;font-weight:650;font-size:15px}
.bar{height:6px;border-radius:99px;background:#f1f5f9;overflow:hidden;margin-bottom:10px}.bar i{display:block;height:100%;background:linear-gradient(90deg,#22c55e,#16a34a)}
.fine{font-size:12px;color:#475569;margin:8px 0}
.who{display:flex;justify-content:space-between;align-items:center;font-size:12.5px;background:#f8fafc;border-radius:10px;padding:7px 10px;margin:8px 0}
.who b{word-break:break-all}.who{gap:10px}.who a{color:#475569;cursor:pointer;text-decoration:underline;white-space:nowrap}
button{width:100%;padding:11px;border:0;border-radius:10px;background:#0f172a;color:#fff;font-weight:600;font-size:14px;cursor:pointer;transition:background .15s,transform .05s}
button:hover:not([disabled]){background:#1e293b}button:active:not([disabled]){transform:translateY(1px)}
button.cancel{background:#fff;color:#b91c1c;border:1px solid #fecaca}button.cancel:hover:not([disabled]){background:#fef2f2}
button[disabled]{background:#cbd5e1;color:#475569;cursor:default}
.note{font-size:12.5px;color:#166534;margin:8px 0 0}.note.err{color:#b91c1c}
.hint{font-size:11.5px;color:#64748b;margin:6px 0 0;overflow-wrap:anywhere}.hint a{color:#334155}
button.retry{margin-top:10px}
.qr{text-align:center;margin-top:12px;padding:12px;border:1px dashed #cbd5e1;border-radius:12px}.qr img{width:180px;height:180px;image-rendering:pixelated}.qr small{display:block;color:#64748b;font-size:11.5px;word-break:break-all}
details.cli{margin-top:10px;font-size:12px;color:#475569}summary{cursor:pointer}
.cmd{white-space:pre-wrap;word-break:break-all;font-size:11px;background:#f8fafc;padding:8px;border-radius:8px}
.pay{margin-top:12px;font-size:13px;border-top:1px solid #f1f5f9;padding-top:10px}select{margin-left:4px;font:inherit;padding:2px 4px;border-radius:6px;border:1px solid #cbd5e1}
.quote{margin-top:6px;color:#334155;overflow-wrap:anywhere}.err{color:#b91c1c}`;

/** DOM glue: renders into a shadow root and wires wallet sign-in, RSVP/cancel, the guest QR and the quote selector. */
export async function mountWidget(host, eventId, { rpc, relayer, fetchImpl = fetch } = {}) {
  const root = host.shadowRoot || (host.attachShadow ? host.attachShadow({ mode: 'open' }) : host); // reused on "Try again"
  root.innerHTML = `<style>${CSS}</style><div class="card">Loading ${escapeHtml(eventId)}…</div>`;
  let info;
  try { info = await viewCall(eventId, 'get_info', {}, { rpc, fetchImpl }); }
  catch (err) {
    root.innerHTML = `<style>${CSS}</style><div class="card"><p class="note err">${escapeHtml(friendlyRpcError(err))}</p><button class="retry">Try again</button></div>`;
    root.querySelector('.retry').onclick = () => mountWidget(host, eventId, { rpc, relayer, fetchImpl });
    return null;
  }
  const s = eventSummary(info, BigInt(Date.now()) * 1_000_000n);
  root.innerHTML = `<style>${CSS}</style>${renderCard(eventId, s)}`;
  const $ = (q) => root.querySelector(q);
  const btn = $('.rsvp'), note = $('.note'), who = $('.who'), qr = $('.qr'), hint = $('.hint');
  if ($('.cmd')) $('.cmd').textContent = rsvpCommand(eventId, s.deposit);
  let wallet = null, action = guestAction(s, null, null);

  // s is reused by guestAction, so refresh it in place after a tx changes active / spots left
  async function refreshInfo() {
    const fresh = await viewCall(eventId, 'get_info', {}, { rpc, fetchImpl });
    Object.assign(s, eventSummary(fresh, BigInt(Date.now()) * 1_000_000n));
    const spots = $('[data-k="spots"]'), bar = $('.bar');
    if (spots) spots.textContent = String(s.spotsLeft);
    if (bar) { bar.title = `${s.active} of ${s.capacity} spots taken`; bar.querySelector('i').style.width = `${s.capacity ? Math.round((100 * s.active) / s.capacity) : 0}%`; }
  }
  const say = (msg, err) => { note.hidden = !msg; note.textContent = msg || ''; note.className = err ? 'note err' : 'note'; };
  async function render(accountId) {
    let status = null, statusErr = null;
    if (accountId) { try { status = await viewCall(eventId, 'get_status', { account_id: accountId }, { rpc, fetchImpl }); } catch (e) { statusErr = friendlyRpcError(e); } }
    action = guestAction(s, status, accountId);
    if (hint) hint.hidden = action.kind !== 'signin';
    btn.textContent = action.label; btn.disabled = !!action.disabled; btn.className = `rsvp ${action.kind === 'cancel' ? 'cancel' : ''}`;
    who.hidden = !accountId;
    if (accountId) who.innerHTML = `<span>Signed in as <b>${escapeHtml(accountId)}</b></span><a class="out">Sign out</a>`;
    if (accountId) who.querySelector('.out').onclick = async () => { await wallet?.signOut(); render(null); };
    if (statusErr) say(statusErr, true); else say(action.note);
    qr.hidden = !(status === 'Rsvp' && accountId && s.phase !== 'ended' && s.phase !== 'settled');
    clearInterval(rotor);
    if (!qr.hidden) await showPass(accountId);
  }
  let rotor = null;
  async function showPass(guest) {
    const P = await loadPass(), store = globalThis.localStorage;
    let cert = null;
    try { cert = JSON.parse(store?.getItem(PASS_KEY(eventId, guest)) || 'null'); } catch {}
    const pending = (() => { try { return JSON.parse(store?.getItem(PASS_KEY(eventId, guest) + ':pending') || 'null'); } catch { return null; } })();
    const fromHash = signedFromHash(globalThis.location?.hash);
    if (!cert && pending && fromHash) {
      cert = P.makeCert(pending, { event: eventId, guest }, fromHash, pending.callbackUrl);
      store.setItem(PASS_KEY(eventId, guest), JSON.stringify(cert)); store.removeItem(PASS_KEY(eventId, guest) + ':pending');
      history.replaceState(null, '', location.href.split('#')[0]);
    }
    if (!cert || cert.guest !== guest || Date.now() > cert.expMs) {
      qr.innerHTML = `<button class="rsvp mkpass">Create my signed door pass</button><small>Your wallet signs a message (no transaction, no gas). The QR then changes every ${P.ROTATE_MS / 1000} s, so a screenshot stops working.</small>`;
      qr.querySelector('.mkpass').onclick = async () => {
        try {
          const req = P.newPassRequest({ event: eventId, guest }), callbackUrl = location.href.split('#')[0];
          store.setItem(PASS_KEY(eventId, guest) + ':pending', JSON.stringify({ ephPk: req.ephPk, ephSk: req.ephSk, expMs: req.expMs, nonce: req.nonce, callbackUrl }));
          const signed = await (await ensureWallet()).signMessage({ ...req.request, callbackUrl });
          if (signed) { store.setItem(PASS_KEY(eventId, guest), JSON.stringify(P.makeCert(req, { event: eventId, guest }, signed, callbackUrl))); store.removeItem(PASS_KEY(eventId, guest) + ':pending'); showPass(guest); }
        } catch (e) { say(`pass: ${e.message || e}`, true); }
      };
      return;
    }
    const draw = async () => {
      if (!qr.isConnected && rotor) return clearInterval(rotor);
      qr.innerHTML = `<img alt="Signed check-in pass for ${escapeHtml(guest)}" src="${await qrDataUrl(P.passFrame(cert))}"><small>Signed door pass · ${escapeHtml(guest)} · refreshes every ${P.ROTATE_MS / 1000} s · screenshots expire in ${P.MAX_AGE_MS / 1000} s</small>`;
    };
    await draw(); rotor = setInterval(draw, P.ROTATE_MS);
  }
  async function ensureWallet() {
    wallet ??= await loadWallet({ network: 'testnet', contractId: eventId });
    wallet.onChange((a) => render(a));
    return wallet;
  }
  btn.addEventListener('click', async () => {
    try {
      btn.disabled = true;
      const w = await ensureWallet();
      if (action.kind === 'signin') { w.signIn(); btn.disabled = false; return; }
      say(action.kind === 'rsvp' ? 'Confirm the RSVP in your wallet…' : 'Confirm the cancellation in your wallet…');
      // rsvp attaches the deposit, so only cancel can go through the gasless relayer
      const out = await gaslessOrWallet(() => (action.kind === 'cancel' && relayer
        ? gaslessCall({ relayer, accountId: w.accountId(), receiverId: eventId, methodName: 'cancel', rpc, fetchImpl }) : null),
      () => w.call(eventId, action.kind === 'rsvp' ? 'rsvp' : 'cancel', {}, { deposit: action.kind === 'rsvp' ? s.deposit : '0' }));
      const h = out?.hash ?? out?.transaction?.hash, did = action.kind;
      await refreshInfo().catch(() => {}); // the tx went through; a stale spots count is not worth an error
      await render(w.accountId());
      // render() clears the note when the new state has none (after a cancel), so confirm explicitly and keep the tx link visible
      if (did === 'cancel' && !note.textContent) say(`Cancelled. Your ${s.depositNear} NEAR deposit was refunded.`);
      if (h) { note.hidden = false; note.insertAdjacentHTML('beforeend', ` <a href="${explorerTx(h)}" target="_blank" rel="noreferrer">View tx</a>${out?.gasless ? ' (gasless: the relayer paid the gas)' : ''}`); }
    } catch (e) { say(e.message || String(e), true); btn.disabled = false; }
  });
  if (walletWasUsed(globalThis.localStorage, globalThis.location?.search)) {
    ensureWallet().then((w) => render(w.accountId())).catch((e) => say(`wallet: ${e.message}`, true));
  }
  const sel = root.querySelector('select'), out = root.querySelector('.quote');
  if (!sel) return s;
  const refresh = async () => {
    const origin = ORIGINS.find((o) => o.id === sel.value);
    out.textContent = 'Fetching live dry quote…';
    try {
      const q = summarizeQuote(await quoteDeposit(origin, s.deposit, { fetchImpl }), origin);
      out.innerHTML = `Pay <b>${escapeHtml(q.pay)}</b>${q.usd ? ` (≈ $${q.usd})` : ''} → ${escapeHtml(q.receive)} in ~${q.etaSec ?? '?'}s. <span class="fine">Dry quote, no funds moved. 1Click is mainnet only, so this prices the deposit as mainnet wNEAR.</span>`;
    } catch (err) { out.innerHTML = `<span class="err">${escapeHtml(friendlyQuoteError(err))}</span>`; }
  };
  sel.addEventListener('change', refresh);
  refresh();
  return s;
}
