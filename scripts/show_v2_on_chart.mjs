#!/usr/bin/env node
/**
 * Put the two TradingView-tested v2 strategies on the chart with the configuration that is
 * actually armed, so the chart shows WHY a position was taken: each entry draws the supply
 * or demand zone it traded (box.new), and TradingView draws the entry, stop and target.
 *
 * Indicators stay applied when the chart symbol changes, so adding them once covers every
 * traded symbol. Pass symbols to walk through them and report what each one renders.
 *
 *   node scripts/show_v2_on_chart.mjs                 # add + configure, verify current symbol
 *   node scripts/show_v2_on_chart.mjs --walk          # then step through all five symbols
 */
import { readFileSync } from 'node:fs';
import { getState, setSymbol, setTimeframe } from '../src/core/chart.js';
import { addStudyFromSearch, setInputs } from '../src/core/indicators.js';
import { getPineBoxes, getStrategyResults } from '../src/core/data.js';

const SYMBOLS = ['CME_MINI:MNQ1!', 'CME_MINI:MES1!', 'CBOT_MINI:MYM1!', 'CME_MINI:M2K1!', 'COMEX_MINI:MGC1!'];
const TF = '15'; // the timeframe both strategies were tested and armed on

// Same values scripts/arm_v2_alerts.mjs writes before creating the alerts.
const STRATEGIES = [
  { study: 'SupplyDemandTrendReversal', pine: new URL('../pine/strategy_a.pine', import.meta.url),
    config: { legAtr: 0.75, needTF: 2, rejAtr: 1.5, targetR: 2.0, useFVG: true, useBOS: true, useDiv: false, drawZones: true } },
  { study: 'SupplyDemandTrendContinuation', pine: new URL('../pine/strategy_b.pine', import.meta.url),
    config: { legAtr: 1.5, needTF: 1, tfA: '5', rsiLongMax: 100, rsiShortMin: 0, targetR: 3.0, useFVG: true, useBOS: true, trendMode: 'off', drawZones: true } },
];

const inputIndex = (pineUrl, name) => {
  const names = [...readFileSync(pineUrl, 'utf8').matchAll(/^(\w+)\s*=\s*input\./gm)].map((m) => m[1]);
  const i = names.indexOf(name);
  if (i < 0) throw new Error(`input ${name} not found in ${pineUrl}`);
  return i;
};

await setTimeframe({ timeframe: TF });

for (const s of STRATEGIES) {
  let st = await getState();
  if (!(st.studies || []).some((x) => x.name === s.study)) {
    const r = await addStudyFromSearch({ query: s.study, match: s.study });
    console.log(`add ${s.study}: ${r && r.success !== false ? 'ok' : 'FAILED ' + JSON.stringify(r)}`);
    st = await getState();
  } else {
    console.log(`add ${s.study}: already on the chart`);
  }
  const study = (st.studies || []).find((x) => x.name === s.study);
  if (!study) { console.log(`  cannot configure ${s.study}: not found after add`); continue; }
  const inputs = {};
  for (const [name, value] of Object.entries(s.config)) inputs['in_' + inputIndex(s.pine, name)] = value;
  const set = await setInputs({ entity_id: study.id, inputs });
  console.log(`  config ${s.study}: ${set && set.success !== false ? 'ok' : 'FAILED'} (${Object.keys(s.config).join(', ')})`);
}

async function report(label) {
  const out = [];
  for (const s of STRATEGIES) {
    const b = await getPineBoxes({ study_filter: s.study.split(' - ')[0] }).catch((e) => ({ error: e.message }));
    // getPineBoxes returns { studies: [{ name, total_boxes, zones: [...] }] }.
    const zones = (b?.studies || []).reduce((n, x) => n + (x.total_boxes ?? x.zones?.length ?? 0), 0);
    out.push(`${s.study.replace('Strategy ', '')}: ${zones} zone box${zones === 1 ? '' : 'es'}`);
  }
  console.log(`${label.padEnd(18)} ${out.join(' | ')}`);
}

const st = await getState();
await report(st.symbol + ' @' + TF);

if (process.argv.includes('--walk')) {
  for (const sym of SYMBOLS) {
    await setSymbol({ symbol: sym });
    await new Promise((r) => setTimeout(r, 9000)); // let both strategies recompute
    await report(sym);
  }
}
