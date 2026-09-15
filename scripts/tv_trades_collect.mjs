#!/usr/bin/env node
/**
 * Pull every trade from TradingView's own Strategy Tester report (reportData().trades)
 * for both zone strategies across the traded universe at the armed timeframe, with the
 * real entry/exit timestamps, prices and USD P&L the tester computed. Prints JSON.
 */
import { readFileSync } from 'node:fs';
import { setSymbol, setTimeframe, getState, manageIndicator } from '../src/core/chart.js';
import { addStudyFromSearch, setInputs } from '../src/core/indicators.js';
import { evaluate } from '../src/connection.js';
const TF = process.env.TF || '15';
const STRATEGIES = [
  { key: 'reversal', script: 'SupplyDemandTrendReversal', targetR: 2 },
  { key: 'continuation', script: 'SupplyDemandTrendContinuation', targetR: 3,
    inputs: { needTF: Number(process.env.B_NEEDTF || 1), maxTouches: Number(process.env.B_TOUCHES || 1) } },
];
const SYMBOLS = [['CME_MINI:MNQ1!','MNQ'],['CME_MINI:MES1!','MES'],['CBOT_MINI:MYM1!','MYM'],['CME_MINI:M2K1!','M2K'],['COMEX_MINI:MGC1!','MGC']];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const READ = `(function(){var chart=window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;var srcs=chart.model().model().dataSources();for(var i=0;i<srcs.length;i++){var s=srcs[i];if(typeof s.reportData!=='function')continue;var rd=s.reportData();if(rd&&typeof rd.value==='function')rd=rd.value();if(!rd||!rd.performance)continue;var name='';try{name=s.metaInfo().description}catch(e){}return{study:name,range:rd.settings&&rd.settings.dateRange,trades:(rd.trades||[]).map(function(t){return{entryMs:t.e.tm,exitMs:t.x?t.x.tm:null,entry:t.e.p,exit:t.x?t.x.p:null,side:/-L$/.test(t.e.c)?'LONG':'SHORT',usd:t.tp&&t.tp.v,commission:t.cm,open:!t.x}})};}return null;})()`;
async function reportWhenReady() { for (let i = 0; i < 16; i++) { const r = await evaluate(READ).catch(() => null); if (r && r.trades) return r; await sleep(1500); } return null; }
const out = { collected_at: new Date().toISOString(), timeframe: TF, runs: {} };
const onlyKey = process.env.ONLY_KEY;
for (const strat of STRATEGIES) {
  if (onlyKey && strat.key !== onlyKey) continue;
  let st = await getState();
  for (const s of st.studies || []) if (/SupplyDemandTrend|Strategy [AB] -/.test(s.name)) await manageIndicator({ action: 'remove', entity_id: s.id });
  await setTimeframe({ timeframe: TF });
  const added = await addStudyFromSearch({ query: strat.script, match: strat.script });
  if (!added || added.error) throw new Error('add failed ' + strat.script);
  if (strat.inputs) {
    const src = readFileSync(new URL('../pine/strategy_b.pine', import.meta.url), 'utf8');
    const names = [...src.matchAll(/^(\w+)\s*=\s*input\./gm)].map((m) => m[1]);
    const cur = await evaluate(`(function(){var c=window.TradingViewApi.chart(0);
      var st=c.getAllStudies().filter(function(s){return s.name===${JSON.stringify(strat.script)}})[0];
      if(!st)return null;var o={};c.getStudyById(st.id).getInputValues().forEach(function(v){o[v.id]=v.value});return o;})()`).catch(() => null);
    const w = {};
    for (const [k, v] of Object.entries(strat.inputs)) { const id = 'in_' + names.indexOf(k); if (!cur || cur[id] !== v) w[id] = v; }
    if (Object.keys(w).length) { await setInputs({ entity_id: added.entity_id, inputs: w }); console.error(`  inputs -> ${JSON.stringify(w)}`); await sleep(6000); }
  }
  const trades = []; let range = null;
  for (const [tv, root] of SYMBOLS) {
    await setSymbol({ symbol: tv }); await sleep(3000);
    const rep = await reportWhenReady();
    if (!rep) { console.error(`${strat.key} ${root}: no report`); continue; }
    if (rep.study !== strat.script) { console.error(`${strat.key} ${root}: report is for ${rep.study}, skipping`); continue; }
    range = range || rep.range;
    for (const t of rep.trades) {
      if (t.open) continue;
      const long = t.side === 'LONG';
      const pts = long ? t.exit - t.entry : t.entry - t.exit;
      const win = pts > 0;
      const r = win ? strat.targetR : -1;
      const risk = win ? Math.abs(pts) / strat.targetR : Math.abs(pts);
      const stop = long ? t.entry - risk : t.entry + risk;
      const tp = long ? t.entry + strat.targetR * risk : t.entry - strat.targetR * risk;
      trades.push({ sym: root, r, pnl: +Number(t.usd).toFixed(2), t: Math.floor(t.entryMs / 1000), exitT: Math.floor(t.exitMs / 1000),
        date: new Date(t.entryMs).toISOString().slice(0, 10), dir: t.side, entry: t.entry, stop: +stop.toFixed(4), tp: +tp.toFixed(4),
        res: win ? 'TARGET' : 'STOP', tf: TF });
    }
    console.error(`${strat.key} ${root}: ${rep.trades.length} trades (${rep.trades.filter(t=>t.open).length} open)  range=${JSON.stringify(rep.range)}`);
  }
  trades.sort((a, b) => a.t - b.t);
  out.runs[strat.key] = { script: strat.script, range, trades };
}
console.log(JSON.stringify(out));
