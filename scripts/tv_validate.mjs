#!/usr/bin/env node
/**
 * Validate one or more candidate configurations in TradingView's own Strategy Tester.
 *
 * Takes a JSON array of {label, study, pine, timeframe, inputs:{byName}} on argv[2] (a
 * file), writes each config's per-symbol and pooled result. This is the arbiter: the JS
 * grid only proposes, TradingView decides.
 */
import { readFileSync } from 'node:fs';
import { setSymbol, setTimeframe, getState, manageIndicator } from '../src/core/chart.js';
import { addStudyFromSearch, setInputs } from '../src/core/indicators.js';
import { getStrategyResults, getTrades } from '../src/core/data.js';

const cfgs = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const SYMBOLS = [['CME_MINI:MNQ1!','MNQ'],['CME_MINI:MES1!','MES'],['CBOT_MINI:MYM1!','MYM'],['CME_MINI:M2K1!','M2K'],['COMEX_MINI:MGC1!','MGC']];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.error(...a);
const idxOf = (pine, name) => {
  const names = [...readFileSync(pine, 'utf8').matchAll(/^(\w+)\s*=\s*input\./gm)].map((m) => m[1]);
  const i = names.indexOf(name); if (i < 0) throw new Error('no input ' + name); return i;
};
async function ready(tries = 16) {
  for (let i = 0; i < tries; i++) { const r = await getStrategyResults().catch(() => null); if (r?.success && r.metrics?.total_trades !== undefined) return r.metrics; await sleep(1500); }
  return null;
}
function rSeq(orders, targetR) {
  const s = [];
  for (let i = 0; i < orders.length; i++) { if (!orders[i].entry) continue; const x = orders[i+1]; if (!x || x.entry) continue;
    const t = String(x.type || '').toUpperCase(); if (t === 'LIMIT') s.push(targetR); else if (t === 'STOP') s.push(-1); }
  return s;
}
const curve = (s) => { let c=0,p=0,d=0; for (const r of s){ c+=r; p=Math.max(p,c); d=Math.min(d,c-p);} return {total:+c.toFixed(2), dd:+d.toFixed(2)}; };

const out = [];
for (const cfg of cfgs) {
  let st = await getState();
  for (const s of st.studies || []) if (/SupplyDemandTrend|Strategy [AB] -/.test(s.name)) await manageIndicator({ action: 'remove', entity_id: s.id });
  await setTimeframe({ timeframe: String(cfg.timeframe) });
  const added = await addStudyFromSearch({ query: cfg.study, match: cfg.study });
  const entity_id = added?.entity_id; if (!entity_id) throw new Error('could not add ' + cfg.study);
  const inputs = {}; for (const [k, v] of Object.entries(cfg.inputs || {})) inputs['in_' + idxOf(cfg.pine, k)] = v;
  await setInputs({ entity_id, inputs });
  log(`\n### ${cfg.label}  (${cfg.study} @ ${cfg.timeframe}m)  ${JSON.stringify(cfg.inputs)}`);
  let all = [], nets = 0, per = [];
  for (const [tv, root] of SYMBOLS) {
    await setSymbol({ symbol: tv }); await sleep(2800);
    const m = await ready();
    if (!m) { log(`  ${root}: no report`); continue; }
    const seq = rSeq((await getTrades({ max_trades: 500 }).catch(() => null))?.trades || [], cfg.targetR);
    const c = curve(seq); all.push(...seq); nets += m.net_profit || 0;
    const w = seq.filter((r) => r > 0).length;
    per.push({ symbol: root, trades: seq.length, win_pct: seq.length ? +(100*w/seq.length).toFixed(1) : null, total_r: c.total, net_usd: Math.round(m.net_profit || 0), pf: m.profit_factor != null ? +m.profit_factor.toFixed(2) : null });
    log(`  ${root.padEnd(4)} n=${String(seq.length).padStart(3)}  win=${String(seq.length?(100*w/seq.length).toFixed(1):'-').padStart(5)}%  R=${String(c.total).padStart(7)}  $${Math.round(m.net_profit||0)}`);
  }
  const c = curve(all); const w = all.filter((r) => r > 0).length;
  const rec = { label: cfg.label, timeframe: cfg.timeframe, inputs: cfg.inputs, trades: all.length,
    win_pct: all.length ? +(100*w/all.length).toFixed(1) : null, total_r: c.total,
    avg_r: all.length ? +(c.total/all.length).toFixed(3) : null, max_dd_r: c.dd, net_usd: Math.round(nets), per_symbol: per };
  out.push(rec);
  log(`  TOTAL n=${all.length} win=${rec.win_pct}% totalR=${c.total} avgR=${rec.avg_r} ddR=${c.dd} net=$${rec.net_usd}`);
}
console.log(JSON.stringify(out, null, 1));
