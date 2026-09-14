#!/usr/bin/env node
/**
 * Which timeframe is profitable, measured in TradingView's own Strategy Tester.
 *
 * No external data: this drives the real chart, the real saved Pine, and reads the
 * tester's report - the same thing you see when you open the panel. For each strategy it
 * walks every timeframe across the traded universe and pools the result.
 *
 * R is not reported by TradingView, so it is reconstructed from the order tape: both
 * strategies exit only through a fixed bracket, so a LIMIT exit banked targetR and a STOP
 * exit cost exactly 1R.
 */
import { readFileSync } from 'node:fs';
import { setSymbol, setTimeframe, getState, manageIndicator } from '../src/core/chart.js';
import { addStudyFromSearch, setInputs } from '../src/core/indicators.js';
import { getStrategyResults, getTrades } from '../src/core/data.js';

const TFS = (process.env.TFS || '3,5,15,30,60').split(',');
const STRATEGIES = [
  { key: 'reversal-a-v2', script: 'Strategy A - Reversal', targetR: 2.0,
    pine: new URL('../pine/strategy_a.pine', import.meta.url),
    config: { legAtr: 0.75, needTF: 2, rejAtr: 1.5, targetR: 2.0, useFVG: true, useBOS: true, useDiv: false } },
  { key: 'continuation-b-v2', script: 'Strategy B - Trend Continuation', targetR: 3.0,
    pine: new URL('../pine/strategy_b.pine', import.meta.url),
    config: { legAtr: 1.5, needTF: 1, tfA: '5', rsiLongMax: 100, rsiShortMin: 0, targetR: 3.0, useFVG: true, useBOS: true, trendMode: 'off' } },
];
const SYMBOLS = [
  { tv: 'CME_MINI:MNQ1!', root: 'MNQ' }, { tv: 'CME_MINI:MES1!', root: 'MES' },
  { tv: 'CBOT_MINI:MYM1!', root: 'MYM' }, { tv: 'CME_MINI:M2K1!', root: 'M2K' },
  { tv: 'COMEX_MINI:MGC1!', root: 'MGC' },
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.error(...a);

function inputIndex(pineUrl, name) {
  const names = [...readFileSync(pineUrl, 'utf8').matchAll(/^(\w+)\s*=\s*input\./gm)].map((m) => m[1]);
  const i = names.indexOf(name);
  if (i < 0) throw new Error(`input ${name} not found`);
  return i;
}
async function reportWhenReady(tries = 14) {
  for (let i = 0; i < tries; i++) {
    const r = await getStrategyResults().catch(() => null);
    if (r?.success && r.metrics && r.metrics.total_trades !== undefined) return r.metrics;
    await sleep(1500);
  }
  return null;
}
/** +targetR per LIMIT exit, -1R per STOP exit; anything still open is not scored. */
function rSeq(orders, targetR) {
  const seq = [];
  for (let i = 0; i < orders.length; i++) {
    if (!orders[i].entry) continue;
    const x = orders[i + 1];
    if (!x || x.entry) continue;
    const t = String(x.type || '').toUpperCase();
    if (t === 'LIMIT') seq.push(targetR); else if (t === 'STOP') seq.push(-1);
  }
  return seq;
}
const curve = (s) => { let c = 0, p = 0, d = 0; for (const r of s) { c += r; p = Math.max(p, c); d = Math.min(d, c - p); } return { total: +c.toFixed(2), dd: +d.toFixed(2) }; };

async function clearZoneStudies() {
  const st = await getState();
  for (const s of st.studies || []) {
    if (/Strategy [AB] -|SupplyDemandTrend/.test(s.name)) await manageIndicator({ action: 'remove', entity_id: s.id });
  }
}

const out = [];
for (const strat of STRATEGIES) {
  await clearZoneStudies();
  const added = await addStudyFromSearch({ query: strat.script, match: strat.script });
  const entity_id = added?.entity_id || added?.id;
  if (!entity_id) throw new Error(`could not add ${strat.script}`);
  const inputs = {};
  for (const [n, v] of Object.entries(strat.config)) inputs['in_' + inputIndex(strat.pine, n)] = v;
  await setInputs({ entity_id, inputs });
  log(`\n### ${strat.key} (${strat.script})`);

  for (const tf of TFS) {
    await setTimeframe({ timeframe: tf });
    await sleep(1500);
    let trades = 0, wins = 0, seqAll = [], nets = 0, symLine = [];
    for (const sym of SYMBOLS) {
      await setSymbol({ symbol: sym.tv });
      await sleep(2500);
      const m = await reportWhenReady();
      if (!m) { symLine.push(`${sym.root}:n/a`); continue; }
      const tape = await getTrades({ max_trades: 500 }).catch(() => null);
      const seq = rSeq(tape?.trades || [], strat.targetR);
      const c = curve(seq);
      trades += seq.length; wins += seq.filter((r) => r > 0).length; seqAll.push(...seq);
      nets += m.net_profit || 0;
      symLine.push(`${sym.root}:${seq.length}t/${c.total >= 0 ? '+' : ''}${c.total}R`);
    }
    const c = curve(seqAll);
    const rec = { strategy: strat.key, tf, trades, wins,
      win_pct: trades ? +(100 * wins / trades).toFixed(1) : null,
      total_r: c.total, avg_r: trades ? +(c.total / trades).toFixed(3) : null,
      max_dd_r: c.dd, net_usd: Math.round(nets) };
    out.push(rec);
    log(`  ${String(tf).padStart(3)}m  n=${String(trades).padStart(4)}  win=${String(rec.win_pct).padStart(5)}%  totalR=${String(c.total).padStart(8)}  avgR=${String(rec.avg_r).padStart(7)}  ddR=${String(c.dd).padStart(7)}  net=$${rec.net_usd}   [${symLine.join(' ')}]`);
  }
}
console.log(JSON.stringify(out, null, 2));
