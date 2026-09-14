#!/usr/bin/env node
/**
 * Arm TradingView alerts for the two TradingView-tested v2 strategies.
 *
 * For each strategy already on the chart: write the validated configuration onto the
 * chart instance, then create one strategy alert per symbol that fires the script's own
 * alert() JSON (OPEN and CLOSE) to the n8n bridge, which forwards to the execution backend.
 */
import { readFileSync } from 'node:fs';
import { getState } from '../src/core/chart.js';
import { setInputs } from '../src/core/indicators.js';
import { createStrategyAlert } from '../src/core/alerts.js';

const WEBHOOK = 'https://n8n.ai-process.net/webhook/globextraps';
const SYMBOLS = ['COMEX_MINI:MGC1!', 'CME_MINI:MES1!', 'CBOT_MINI:MYM1!', 'CME_MINI:M2K1!', 'CME_MINI:MNQ1!'];
// The validated configuration is written onto the chart instance explicitly, keyed by
// input NAME and resolved to its index from the Pine source. An alert snapshots the
// instance's inputs at creation time, so this - not the saved script's defaults - is what
// gets armed. Values are the TradingView-tested v2 settings (15m, 31 Mar - 11 Sep 2026).
const STRATEGIES = [
  {
    study: 'SupplyDemandTrendReversal', pine: new URL('../pine/strategy_a.pine', import.meta.url),
    config: { legAtr: 0.75, needTF: 2, rejAtr: 1.5, targetR: 2.0, useFVG: true, useBOS: true, useDiv: false },
  },
  {
    study: 'SupplyDemandTrendContinuation', pine: new URL('../pine/strategy_b.pine', import.meta.url),
    config: { legAtr: 1.5, needTF: 1, tfA: '5', rsiLongMax: 100, rsiShortMin: 0, targetR: 3.0, useFVG: true, useBOS: true, trendMode: 'off' },
  },
];

function env(path, key) {
  const m = readFileSync(path, 'utf8').match(new RegExp('^' + key + '=(.*)$', 'm'));
  return m ? m[1].trim() : '';
}

/** Pine numbers inputs by declaration order; find the index rather than hard-coding it. */
function inputIndex(pineUrl, name) {
  const names = [...readFileSync(pineUrl, 'utf8').matchAll(/^(\w+)\s*=\s*input\./gm)].map((m) => m[1]);
  const i = names.indexOf(name);
  if (i < 0) throw new Error(`input ${name} not found in ${pineUrl}`);
  return i;
}

// No secret: the alert payload no longer carries one and the backend gates none.

// ONLY="SupplyDemandTrendReversal" arms one strategy; re-running for a strategy that already
// has live alerts would create duplicates, since alerts are not keyed by anything.
const only = process.env.ONLY ? process.env.ONLY.split(',').map((x) => x.trim()) : null;

const st = await getState();
const results = [];
for (const s of STRATEGIES) {
  if (only && !only.includes(s.study)) { console.log(`SKIP ${s.study}: not in ONLY`); continue; }
  const study = (st.studies || []).find((x) => x.name === s.study);
  if (!study) { console.log(`SKIP ${s.study}: not on the chart`); continue; }
  const inputs = {};
  for (const [name, value] of Object.entries(s.config)) inputs['in_' + inputIndex(s.pine, name)] = value;
  inputs['in_' + inputIndex(s.pine, 'sendAlerts')] = true;
  const set = await setInputs({ entity_id: study.id, inputs });
  console.log(`${s.study}: inputs set ok=${!!(set && set.success !== false)}`);
  for (const sym of SYMBOLS) {
    const r = await createStrategyAlert({ symbol: sym, study_name: s.study, web_hook: WEBHOOK, resolution: '15', expiration_days: 60 });
    const ok = !!(r && r.success);
    results.push({ study: s.study, sym, ok, id: r && (r.alert_id || r.id), err: ok ? undefined : (r && r.error) });
    console.log(`  ${sym.padEnd(18)} ${ok ? 'ARMED id=' + (r.alert_id || r.id || '?') : 'FAILED ' + (r && r.error)}`);
  }
}
const armed = results.filter((r) => r.ok).length;
console.log(`armed ${armed}/${results.length}`);
process.exit(armed === results.length && armed > 0 ? 0 : 1);
