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
import { evaluate } from '../src/connection.js';

const cfgs = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const SYMBOLS = [['CME_MINI:MNQ1!','MNQ'],['CME_MINI:MES1!','MES'],['CBOT_MINI:MYM1!','MYM'],['CME_MINI:M2K1!','M2K'],['COMEX_MINI:MGC1!','MGC']];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.error(...a);
const idxOf = (pine, name) => {
  const names = [...readFileSync(pine, 'utf8').matchAll(/^(\w+)\s*=\s*input\./gm)].map((m) => m[1]);
  const i = names.indexOf(name); if (i < 0) throw new Error('no input ' + name); return i;
};
const HAS_PERF = `(function(){try{var chart=window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
  var srcs=chart.model().model().dataSources();
  for(var i=0;i<srcs.length;i++){var s=srcs[i];if(typeof s.reportData!=='function')continue;
    var rd=s.reportData();if(rd&&typeof rd.value==='function')rd=rd.value();
    if(rd&&rd.performance)return true;}return false;}catch(e){return false}})()`;
/**
 * After a bulk setInputs the strategy recomputes and its report is briefly absent, so
 * getStrategyResults() returns nothing. Wait for reportData().performance to come back
 * before reading metrics. The old 16 x 1.5s budget expired mid-recompute and every
 * symbol reported "no report".
 */
async function ready(tries = 60) {
  for (let i = 0; i < tries; i++) {
    if (await evaluate(HAS_PERF).catch(() => false)) {
      const r = await getStrategyResults().catch(() => null);
      if (r?.success && r.metrics?.total_trades !== undefined) return r.metrics;
    }
    await sleep(2000);
  }
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
const mounted = new Map();   // study name -> entity_id, added once and reused
for (const cfg of cfgs) {
  await setTimeframe({ timeframe: String(cfg.timeframe) });
  let entity_id = mounted.get(cfg.study);
  if (!entity_id) {
    // A clean chart is required: leftover studies (including rows a fuzzy search click
    // added by mistake) stop the tester computing a report at all.
    const st = await getState();
    for (const s of st.studies || []) await manageIndicator({ action: 'remove', entity_id: s.id });
    await sleep(2000);
    const added = await addStudyFromSearch({ query: cfg.study, match: cfg.study });
    entity_id = added?.entity_id;
    if (!entity_id) throw new Error('could not add ' + cfg.study);
    if (added.added_from_search !== cfg.study) throw new Error(`search clicked "${added.added_from_search}", wanted "${cfg.study}"`);
    mounted.set(cfg.study, entity_id);
    await sleep(4000);
  }
  const inputs = {}; for (const [k, v] of Object.entries(cfg.inputs || {})) inputs['in_' + idxOf(cfg.pine, k)] = v;
  // Write ONLY what differs. Sending the whole input set at once leaves the strategy in a
  // state where TradingView never recomputes its report: every symbol then reads as
  // "no report", which looks like a timeout and is not one - no poll length fixes it.
  // Measured on MNQ 5m: bare mount computes in 4s, a full 12-input write never returns,
  // a single changed key recomputes in 5s.
  const current = await evaluate(`(function(){var c=window.TradingViewApi.chart(0);
    var st=c.getAllStudies().filter(function(s){return s.name===${JSON.stringify(cfg.study)}})[0];
    if(!st)return null;var o={};c.getStudyById(st.id).getInputValues().forEach(function(v){o[v.id]=v.value});return o;})()`).catch(() => null);
  if (current) for (const k of Object.keys(inputs)) if (current[k] === inputs[k]) delete inputs[k];
  // Guard: tfA is read with request.security_lower_tf, so it must stay at or below the
  // chart timeframe. Writing a higher one silently stops the study computing.
  try {
    const tfaKey = 'in_' + idxOf(cfg.pine, 'tfA');
    if (inputs[tfaKey] !== undefined && Number(inputs[tfaKey]) > Number(cfg.timeframe)) {
      throw new Error(`tfA=${inputs[tfaKey]} exceeds the ${cfg.timeframe}m chart; request.security_lower_tf cannot serve it`);
    }
  } catch (e) { if (/exceeds the/.test(e.message)) throw e; }
  if (Object.keys(inputs).length) {
    await setInputs({ entity_id, inputs });
    for (let i = 0; i < 40; i++) { if (await evaluate(HAS_PERF).catch(() => false)) break; await sleep(2000); }
  }
  log(`\n### ${cfg.label}  (${cfg.study} @ ${cfg.timeframe}m)  ${JSON.stringify(cfg.inputs)}`);
  log(`  changed inputs written: ${JSON.stringify(inputs)}`);
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
