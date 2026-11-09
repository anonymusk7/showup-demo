// Host dashboard pure logic: guest tallies and payout projection using the contract's settle math.
import { settleMath } from '../lib/settle.mjs';
import { formatNear } from '../widget/core.mjs';

export const OUTCOME = { CheckedIn: 'attendee', Rsvp: 'no-show if not checked in', Cancelled: 'refunded at cancel' };

export function tally(guests) {
  const t = { Rsvp: 0, CheckedIn: 0, Cancelled: 0, total: guests.length };
  for (const [, s] of guests) { if (!(s in t)) throw new Error(`unknown status ${s}`); t[s]++; }
  return t;
}

/** Payouts if settle ran with the current statuses (exact final payouts once settled). */
export function projectPayouts(info, guests) {
  const deposit = BigInt(info.deposit), t = tally(guests);
  const { each, dust } = settleMath(deposit, t.CheckedIn, t.Rsvp);
  const order = { CheckedIn: 0, Rsvp: 1, Cancelled: 2 };
  const rows = [...guests].sort((a, b) => order[a[1]] - order[b[1]] || a[0].localeCompare(b[0]))
    .map(([account, status]) => ({ account, status, outcome: info.settled && status === 'Rsvp' ? 'no-show: deposit forfeited' : OUTCOME[status], payout: status === 'CheckedIn' ? each : 0n }));
  if (dust > 0n) rows.push({ account: info.host, status: 'host', outcome: t.CheckedIn ? 'rounding dust' : 'no attendees: pool to host', payout: dust });
  const held = deposit * BigInt(t.CheckedIn + t.Rsvp), paid = rows.reduce((s, r) => s + r.payout, 0n);
  return { tally: t, each, dust, held, paid, conserved: held === paid, bonus: t.CheckedIn ? each - deposit : 0n, rows };
}

export const fmtRow = (r) => ({ ...r, payoutNear: formatNear(r.payout, 6) });

// ---- accountant CSV export ----
// NearBlocks API v3 (v1 now answers 410). Explorer links go to NEAR Rocks: the testnet.nearblocks.io UI is behind a Cloudflare challenge.
export const NEARBLOCKS_API = 'https://api-testnet.nearblocks.io/v3';
export const INDEXER_API = NEARBLOCKS_API;
export const explorerTxUrl = (h) => `https://testnet.near.rocks/tx/${h}`;
export const explorerAccountUrl = (a) => `https://testnet.near.rocks/account/${a}`;
export const CSV_COLUMNS = ['event', 'network', 'guest_account', 'status', 'rsvp_time_utc', 'deposit_near', 'deposit_tx',
  'refund_near', 'refund_time_utc', 'refund_tx', 'payout_near', 'payout_time_utc', 'payout_tx', 'explorer_url'];

/** RFC 4180: comma separated, CRLF line ends, fields with , " CR LF quoted and " doubled. Cells that a spreadsheet
 * would run as a formula (OWASP: = + - @, also after leading whitespace, or a leading tab / CR) get a leading apostrophe. */
export function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (/^\s*[=+\-@]|^[\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export const toCsv = (columns, rows) => [columns, ...rows.map((r) => columns.map((c) => r[c]))].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';

const nsToIso = (ns) => (ns == null || ns === '' ? '' : new Date(Number(BigInt(String(ns).split('.')[0]) / 1_000_000n)).toISOString());
const methodsOf = (t) => (t.actions || []).filter((a) => /FUNCTION_CALL/i.test(a.action || '')).map((a) => a.method);
const succeeded = (t) => t.outcomes?.status !== false;

/** Index escrow receipts (see fetchEscrowTxns): latest successful rsvp/cancel per guest, and the settle tx.
 * Also takes v3 txn rows, which carry signer_account_id instead of predecessor_account_id. */
export function indexTxns(escrow, txns = []) {
  const byGuest = {}, sorted = [...txns].filter(succeeded).filter((t) => t.receiver_account_id === escrow)
    .sort((a, b) => (BigInt(String(a.block_timestamp).split('.')[0]) < BigInt(String(b.block_timestamp).split('.')[0]) ? -1 : 1));
  let settle = null;
  for (const t of sorted) {
    const g = t.predecessor_account_id ?? t.signer_account_id, ms = methodsOf(t);
    const rec = { hash: t.transaction_hash, ns: t.block_timestamp };
    if (ms.includes('rsvp')) (byGuest[g] ??= {}).rsvp = rec;
    if (ms.includes('cancel')) (byGuest[g] ??= {}).cancel = rec;
    if (ms.includes('settle') && !settle) settle = rec;
  }
  return { byGuest, settle };
}

/**
 * One row per guest (plus the host when it receives dust / the unclaimed pool). Amounts are decimal NEAR.
 * payout_* is filled only once the event is settled; missing tx hashes stay blank.
 */
export function ledgerRows(eventId, info, guests, txns = []) {
  const p = projectPayouts(info, guests), idx = indexTxns(eventId, txns), dep = BigInt(info.deposit);
  const near = (y) => formatNear(y, 24);
  const STATUS = { CheckedIn: 'attended', Rsvp: info.settled ? 'no_show_forfeited' : 'rsvp_not_checked_in', Cancelled: 'cancelled_refunded' };
  return p.rows.map((r) => {
    const t = idx.byGuest[r.account] || {}, isHost = r.status === 'host';
    const paid = info.settled && (r.status === 'CheckedIn' || isHost);
    const row = { event: eventId, network: 'near-testnet', guest_account: r.account, status: isHost ? (r.outcome === 'rounding dust' ? 'host_rounding_dust' : 'host_no_attendees_pool') : STATUS[r.status],
      rsvp_time_utc: isHost ? '' : nsToIso(t.rsvp?.ns), deposit_near: isHost ? '' : near(dep), deposit_tx: t.rsvp?.hash || '',
      refund_near: r.status === 'Cancelled' ? near(dep) : '', refund_time_utc: r.status === 'Cancelled' ? nsToIso(t.cancel?.ns) : '', refund_tx: r.status === 'Cancelled' ? t.cancel?.hash || '' : '',
      payout_near: info.settled ? near(r.payout) : '', payout_time_utc: paid ? nsToIso(idx.settle?.ns) : '', payout_tx: paid ? idx.settle?.hash || '' : '' };
    const best = row.payout_tx || row.refund_tx || row.deposit_tx;
    row.explorer_url = best ? explorerTxUrl(best) : '';
    return row;
  });
}
export const ledgerCsv = (eventId, info, guests, txns) => toCsv(CSV_COLUMNS, ledgerRows(eventId, info, guests, txns));

/**
 * Function-call receipts executed by the escrow, from NearBlocks API v3 /accounts/<escrow>/receipts (cursor paged via meta.next_page).
 * Receipts rather than /txns: a gasless NEP-366 cancel / check_in is a tx signed by the relayer to the guest / host, so it is
 * not listed under the escrow's txns, but its inner receipt (predecessor = guest / host) is. Each receipt is normalized to the
 * row shape indexTxns reads. Returns [] on any failure: tx columns then stay blank.
 */
export async function fetchEscrowTxns(escrow, { fetchImpl = fetch, base = NEARBLOCKS_API, limit = 25, maxPages = 8 } = {}) {
  const all = [], seen = new Set();
  try {
    let next = null;
    for (let page = 1; page <= maxPages; page++) {
      const url = `${base}/accounts/${encodeURIComponent(escrow)}/receipts?limit=${limit}${next ? `&next=${encodeURIComponent(next)}` : ''}`;
      const r = await fetchImpl(url, { headers: { accept: 'application/json' } });
      if (!r.ok) return [];
      const j = await r.json(), data = Array.isArray(j?.data) ? j.data : [];
      for (const x of data) {
        if (x?.receiver_account_id !== escrow) continue;
        const key = `${x.transaction_hash}:${(x.actions || []).map((a) => a.method).join(',')}`;
        if (seen.has(key)) continue;
        seen.add(key);
        all.push({ transaction_hash: x.transaction_hash, predecessor_account_id: x.predecessor_account_id, receiver_account_id: x.receiver_account_id,
          block_timestamp: x.included_in_block_timestamp || x.block?.block_timestamp, actions: x.actions || [], outcomes: { status: x.outcome?.status } });
      }
      next = j?.meta?.next_page;
      if (!next || !data.length) break;
    }
  } catch { return []; /* offline / CORS / rate limit: export without hashes */ }
  return all;
}
