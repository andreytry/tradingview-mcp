#!/usr/bin/env node
/**
 * Collect the TradingView Strategy Tester report for the two zone strategies across the
 * traded universe and print it as JSON. It writes nothing: dashboard 2 reads gtx.* tables
 * and those inserts are done deliberately, from this output, rather than by a script
 * holding a database key.
 *
 * Why this exists: gtx_dash2_public() filters on the strategy keys reversal-a-v2 and
 * continuation-b-v2, and no row anywhere in gtx.* ever carried those keys, so every panel
 * on dashboard 2 rendered empty.
 *
 * R is not reported by TradingView, so it is reconstructed from the order tape: both
 * strategies exit only through a fixed bracket, so a LIMIT exit banked targetR and a STOP
 * exit cost exactly 1R. That also gives the true order of wins and losses, which is what
 * makes the drawdown in R honest rather than a guess.
 *
 *   node scripts/dash2_backfill.mjs > /tmp/dash2.json
 */
import { readFileSync } from 'node:fs';
import { setSymbol, setTimeframe, getState, manageIndicator, getVisibleRange } from '../src/core/chart.js';
import { addStudyFromSearch, setInputs } from '../src/core/indicators.js';
import { getStrategyResults, getTrades } from '../src/core/data.js';

// The names as they are SAVED in TradingView today. The rename to
// SupplyDemandTrendReversal / SupplyDemandTrendContinuation is not deployed yet; when it
// is, change these two strings and nothing else.
const STRATEGIES = [
  {
    key: 'reversal-a-v2', script: 'Strategy A - Reversal', targetR: 2.0,
    pine: new URL('../pine/strategy_a.pine', import.meta.url),
    config: { legAtr: 0.75, needTF: 2, rejAtr: 1.5, targetR: 2.0, useFVG: true, useBOS: true, useDiv: false },
  },
  {
    key: 'continuation-b-v2', script: 'Strategy B - Trend Continuation', targetR: 3.0,
    pine: new URL('../pine/strategy_b.pine', import.meta.url),
    config: { legAtr: 1.5, needTF: 1, tfA: '5', rsiLongMax: 100, rsiShortMin: 0, targetR: 3.0, useFVG: true, useBOS: true, trendMode: 'off' },
  },
];
const SYMBOLS = [
  { tv: 'CME_MINI:MNQ1!', root: 'MNQ', pv: 2 }, { tv: 'CME_MINI:MES1!', root: 'MES', pv: 5 },
  { tv: 'CBOT_MINI:MYM1!', root: 'MYM', pv: 0.5 }, { tv: 'CME_MINI:M2K1!', root: 'M2K', pv: 5 },
  { tv: 'COMEX_MINI:MGC1!', root: 'MGC', pv: 10 },
];
const TF = '15';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.error(...a);

function inputIndex(pineUrl, name) {
  const names = [...readFileSync(pineUrl, 'utf8').matchAll(/^(\w+)\s*=\s*input\./gm)].map((m) => m[1]);
  const i = names.indexOf(name);
  if (i < 0) throw new Error(`input ${name} not found`);
  return i;
}

/** The tester recomputes asynchronously after a symbol change; poll rather than guess. */
async function reportWhenReady(tries = 14) {
  for (let i = 0; i < tries; i++) {
    const r = await getStrategyResults().catch(() => null);
    if (r?.success && r.metrics && r.metrics.total_trades !== undefined) return r;
    await sleep(1500);
  }
  return null;
}

/**
 * Rebuild each trade from the order tape. Both strategies exit only through a fixed
 * bracket, so a LIMIT exit banked targetR and a STOP exit cost exactly 1R - which also
 * recovers the stop and target the trade was placed with, from the two fills alone.
 *
 * TradingView's order tape carries NO timestamp (only id/type/side/price/qty and a
 * sequence counter), so `t` is the sequence position and `date` is null. Ordering within
 * a symbol is therefore exact; calendar dates are simply not available from the tester
 * and are not invented here.
 */
function rTrades(orders, targetR, sym, pointValue) {
  const out = [];
  let seq = 0;
  for (let i = 0; i < orders.length; i++) {
    if (!orders[i].entry) continue;
    const entry = orders[i], exit = orders[i + 1];
    if (!exit || exit.entry) continue;            // still open at the end of the window
    const type = String(exit.type || '').toUpperCase();
    if (type !== 'LIMIT' && type !== 'STOP') continue;
    const long = entry.side === 'buy';
    const r = type === 'LIMIT' ? targetR : -1;
    const risk = Math.abs(exit.price - entry.price) / (type === 'LIMIT' ? targetR : 1);
    const stop = long ? entry.price - risk : entry.price + risk;
    const tp = long ? entry.price + targetR * risk : entry.price - targetR * risk;
    out.push({
      sym, r, res: type === 'LIMIT' ? 'TARGET' : 'STOP', dir: long ? 'LONG' : 'SHORT',
      entry: entry.price, stop: Number(stop.toFixed(4)), tp: Number(tp.toFixed(4)),
      pnl: Number(((long ? exit.price - entry.price : entry.price - exit.price) * pointValue).toFixed(2)),
      t: ++seq, date: null,
    });
  }
  return out;
}
const rSequence = (orders, targetR) => rTrades(orders, targetR, '', 1).map((x) => x.r);

function curve(seq) {
  let cum = 0, peak = 0, dd = 0;
  for (const r of seq) { cum += r; peak = Math.max(peak, cum); dd = Math.min(dd, cum - peak); }
  return { total_r: Number(cum.toFixed(2)), max_dd_r: Number(dd.toFixed(2)) };
}

async function clearZoneStudies() {
  const st = await getState();
  for (const s of st.studies || []) {
    if (/Strategy [AB] -|SupplyDemandTrend/.test(s.name)) await manageIndicator({ action: 'remove', entity_id: s.id });
  }
}

const out = { collected_at: new Date().toISOString(), timeframe: TF, rows: [], trades: [], window: {} };

for (const strat of STRATEGIES) {
  await clearZoneStudies();
  await setTimeframe({ timeframe: TF });
  const added = await addStudyFromSearch({ query: strat.script, match: strat.script });
  const entity_id = added?.entity_id || added?.id;
  if (!entity_id) throw new Error(`could not add ${strat.script}: ${JSON.stringify(added).slice(0, 200)}`);
  const inputs = {};
  for (const [name, value] of Object.entries(strat.config)) inputs['in_' + inputIndex(strat.pine, name)] = value;
  await setInputs({ entity_id, inputs });
  log(`${strat.key}: study added and configured`);

  for (const sym of SYMBOLS) {
    await setSymbol({ symbol: sym.tv });
    await sleep(2500);
    const rep = await reportWhenReady();
    if (!rep) { log(`  ${sym.root}: NO REPORT`); continue; }
    const m = rep.metrics;
    const tape = await getTrades({ max_trades: 500 }).catch(() => null);
    const tr = rTrades(tape?.trades || [], strat.targetR, sym.root, sym.pv);
    out.trades.push(...tr.map((x) => ({ ...x, strategy: strat.key })));
    const seq = tr.map((x) => x.r);
    const { total_r, max_dd_r } = curve(seq);
    const trades = m.total_trades ?? 0;
    const wins = m.winning_trades ?? 0;
    const range = await getVisibleRange().catch(() => null);
    if (range?.bars_range) out.window[sym.root] = range.bars_range;

    out.rows.push({
      strategy: strat.key, symbol: sym.root, reported_for: rep.strategy,
      trades, wins, losses: m.losing_trades ?? 0,
      scored_trades: seq.length,
      win_pct: trades ? Number((100 * wins / trades).toFixed(1)) : null,
      avg_r: seq.length ? Number((total_r / seq.length).toFixed(3)) : null,
      total_r, max_dd_r,
      profit_factor: m.profit_factor != null ? Number(m.profit_factor.toFixed(3)) : null,
      net_profit_usd: m.net_profit != null ? Number(m.net_profit.toFixed(2)) : null,
      max_drawdown_usd: m.max_drawdown != null ? Number(m.max_drawdown.toFixed(2)) : null,
    });
    log(`  ${sym.root.padEnd(4)} trades=${trades} scored=${seq.length} win%=${trades ? (100 * wins / trades).toFixed(1) : '-'} totalR=${total_r} ddR=${max_dd_r} pf=${m.profit_factor?.toFixed(2) ?? '-'}`);
  }
}

console.log(JSON.stringify(out, null, 2));
