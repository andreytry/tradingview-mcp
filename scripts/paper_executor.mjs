#!/usr/bin/env node
/**
 * TradingView Paper Trading executor (workstation side).
 *
 * The backend records every accepted v2 signal as a paper trade in gtx.live_trade. This
 * process turns those rows into REAL positions in TradingView's own Paper Trading account
 * by driving the desktop app's broker session over CDP - the same REST calls the trading
 * panel makes, authenticated by the app's own login, so no credential leaves the app.
 *
 *   open  : row with tv_status NULL, not closed, opened < MAX_AGE_MS ago
 *           -> market order + attached stop/target, sized as the backend sized it
 *   close : row with tv_status 'open' and closed_at set -> flatten that position
 *   stale : row with tv_status NULL that is already closed or too old -> 'skipped'
 *
 * The backend can do the same job itself when TV_PAPER_ACCOUNT/TV_SESSION_COOKIE are set
 * on the box; it wins any race because it acts at signal time, and this executor only
 * touches rows that are still unclaimed GRACE_MS after they were opened.
 *
 * Runs forever; every action and failure is written to gtx.live_trade.tv_* and to stdout.
 */
import { readFileSync } from 'node:fs';
import { evaluateAsync } from '../src/connection.js';

const STRATEGIES = ['reversal-a-v2', 'continuation-b-v2'];
const TV_SYMBOLS = {
  'MNQ1!': 'CME_MINI:MNQ1!', 'MES1!': 'CME_MINI:MES1!', 'M2K1!': 'CME_MINI:M2K1!',
  'MYM1!': 'CBOT_MINI:MYM1!', 'MGC1!': 'COMEX_MINI:MGC1!',
};
const POLL_MS = Number(process.env.POLL_MS || 10_000);
const GRACE_MS = Number(process.env.GRACE_MS || 30_000);      // let the backend mirror first
const MAX_AGE_MS = Number(process.env.MAX_AGE_MS || 15 * 60_000); // never chase a stale entry
const ONCE = process.argv.includes('--once');

function env(key) {
  const m = readFileSync('/root/globextraps/.env', 'utf8').match(new RegExp('^' + key + '=(.*)$', 'm'));
  return m ? m[1].trim() : '';
}
const SUPABASE_URL = env('SUPABASE_URL');
const SUPABASE_KEY = env('SUPABASE_KEY');
if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('SUPABASE_URL/SUPABASE_KEY missing in /root/globextraps/.env');

const say = (event, data = {}) => console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...data }));

async function rest(method, path, body, headers = {}) {
  const res = await fetch(SUPABASE_URL + '/rest/v1/' + path, {
    method,
    headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`supabase ${method} ${path.split('?')[0]} http ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

/** Update one row, only while it is still in `fromStatus` (NULL = unclaimed). Returns true if it was ours. */
async function claim(signalId, fromStatus, patch) {
  const filter = fromStatus === null ? 'tv_status=is.null' : 'tv_status=eq.' + fromStatus;
  const rows = await rest('PATCH', `live_trade?signal_id=eq.${encodeURIComponent(signalId)}&${filter}`,
    { ...patch, tv_synced_at: new Date().toISOString() }, { Prefer: 'return=representation' });
  return Array.isArray(rows) && rows.length === 1;
}

// ---- TradingView side (runs inside the desktop app) ----------------------------------
const BROKER = `(function(){
  var api = window.TradingViewApi._chartWidgetCollection._options.externalServices.trading.tradingBrokerService.getCurrentBroker();
  if (!api) throw new Error('no broker connected - open the Trading panel and connect Paper Trading');
  if (!(api._brokerMetainfo && /paper/i.test(api._brokerMetainfo.title))) throw new Error('connected broker is not Paper Trading: ' + (api._brokerMetainfo && api._brokerMetainfo.title));
  var acc = api._brokerConnection._brokerConnection.currentAccountApi();
  return { api: api, rt: acc.placeOrderCapability._restTransport, account: api.currentAccount() };
})()`;

async function tvPlace({ tvSymbol, side, qty, stop, target }) {
  return evaluateAsync(`(async function(){
    try {
      var b = ${BROKER};
      var r = await b.rt.placeOrder({ symbol: ${JSON.stringify(tvSymbol)}, type: 'market', qty: ${Number(qty)},
        side: ${JSON.stringify(side === 'LONG' ? 'buy' : 'sell')}, sl: ${Number(stop)}, tp: ${Number(target)},
        expiration: Math.floor(Date.now() / 1000) + 7 * 86400 });
      var d = (r && r.d && typeof r.d === 'object') ? r.d : r;
      return { ok: true, account: b.account, orderId: d && d.id != null ? String(d.id) : null, symbol: d && d.symbol, raw: JSON.stringify(d).slice(0, 400) };
    } catch (e) { return { ok: false, error: String(e && (e.message || e.errmsg) || e) }; }
  })()`);
}

async function tvClose({ tvSymbol, side, qty }) {
  const root = tvSymbol.replace(/1!$/, ''); // CME_MINI:MNQ matches the resolved contract CME_MINI:MNQU2026
  return evaluateAsync(`(async function(){
    try {
      var b = ${BROKER};
      var ps = await b.api.positions();
      var want = ${side === 'LONG' ? 1 : -1};
      var p = (ps || []).filter(function(x){ return String(x.symbol).indexOf(${JSON.stringify(root)}) === 0 && x.side === want; })[0];
      if (!p) return { ok: false, error: 'no open ' + ${JSON.stringify(side)} + ' position for ' + ${JSON.stringify(root)} + ' in Paper Trading' };
      var q = Math.min(${Number(qty)}, p.qty);
      var r = await b.rt.closePosition(p.symbol, q);
      return { ok: true, closed: p.symbol, qty: q, raw: JSON.stringify(r).slice(0, 300) };
    } catch (e) { return { ok: false, error: String(e && (e.message || e.errmsg) || e) }; }
  })()`);
}

// ---- main loop ----------------------------------------------------------------------
async function tick() {
  const rows = await rest('GET', 'live_trade?select=signal_id,strategy,symbol,side,contracts,stop,target,opened_at,closed_at,tv_status,tv_order_id'
    + `&strategy=in.(${STRATEGIES.join(',')})&is_test=eq.false&or=(tv_status.is.null,tv_status.eq.open)&order=opened_at.desc&limit=50`);
  const now = Date.now();
  for (const r of rows) {
    const age = now - new Date(r.opened_at).getTime();
    const tvSymbol = TV_SYMBOLS[r.symbol];
    if (r.tv_status === null) {
      if (r.closed_at) { await claim(r.signal_id, null, { tv_status: 'skipped', tv_error: 'already closed before mirroring' }); say('skip', { id: r.signal_id, why: 'closed' }); continue; }
      if (age > MAX_AGE_MS) { await claim(r.signal_id, null, { tv_status: 'skipped', tv_error: `stale: opened ${Math.round(age / 60000)} min ago` }); say('skip', { id: r.signal_id, why: 'stale' }); continue; }
      if (age < GRACE_MS) continue; // the backend may still mirror it itself
      if (!tvSymbol) { await claim(r.signal_id, null, { tv_status: 'error', tv_error: 'no TradingView symbol for ' + r.symbol }); continue; }
      if (!(await claim(r.signal_id, null, { tv_status: 'placing' }))) continue; // someone else got it
      const res = await tvPlace({ tvSymbol, side: r.side, qty: r.contracts || 1, stop: Number(r.stop), target: Number(r.target) });
      if (res && res.ok) {
        await claim(r.signal_id, 'placing', { tv_status: 'open', tv_order_id: res.orderId, tv_error: null });
        say('placed', { id: r.signal_id, symbol: tvSymbol, side: r.side, qty: r.contracts, orderId: res.orderId, account: res.account });
      } else {
        await claim(r.signal_id, 'placing', { tv_status: 'error', tv_error: String(res && res.error || 'unknown').slice(0, 500) });
        say('place_failed', { id: r.signal_id, error: res && res.error });
      }
    } else if (r.tv_status === 'open' && r.closed_at) {
      if (!(await claim(r.signal_id, 'open', { tv_status: 'closing' }))) continue;
      const res = await tvClose({ tvSymbol, side: r.side, qty: r.contracts || 1 });
      if (res && res.ok) {
        await claim(r.signal_id, 'closing', { tv_status: 'closed', tv_error: null });
        say('closed', { id: r.signal_id, closed: res.closed, qty: res.qty });
      } else {
        await claim(r.signal_id, 'closing', { tv_status: 'close_error', tv_error: String(res && res.error || 'unknown').slice(0, 500) });
        say('close_failed', { id: r.signal_id, error: res && res.error });
      }
    }
  }
  return rows.length;
}

say('start', { poll_ms: POLL_MS, grace_ms: GRACE_MS, max_age_ms: MAX_AGE_MS, once: ONCE });
for (;;) {
  try { const n = await tick(); if (ONCE) { say('done', { rows: n }); process.exit(0); } }
  catch (e) { say('tick_error', { error: String(e.message || e).slice(0, 300) }); if (ONCE) process.exit(1); }
  await new Promise((r) => setTimeout(r, POLL_MS));
}
