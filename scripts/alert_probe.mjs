#!/usr/bin/env node
/**
 * Create ONE probe alert for a study with given input overrides, wait for the alert
 * server's initial calculation, report active/last_error, then delete the probe.
 * Used to bisect a study_error the alert servers raise but the chart does not.
 *   node scripts/alert_probe.mjs "SupplyDemandTrendReversal" pine/strategy_a.pine '{"showLive":false}'
 */
import { readFileSync } from 'node:fs';
import { getState } from '../src/core/chart.js';
import { setInputs } from '../src/core/indicators.js';
import { createStrategyAlert } from '../src/core/alerts.js';
import { evaluate } from '../src/connection.js';
const [study, pine, overridesJson, symbolArg] = process.argv.slice(2);
const overrides = JSON.parse(overridesJson || '{}');
const symbol = symbolArg || 'CME_MINI:MNQ1!';
const idx = (name) => { const names = [...readFileSync(pine, 'utf8').matchAll(/^(\w+)\s*=\s*input\./gm)].map((m) => m[1]); const i = names.indexOf(name); if (i < 0) throw new Error('no input ' + name); return i; };
const st = await getState();
const s = (st.studies || []).find((x) => x.name === study);
if (!s) throw new Error(study + ' not on chart');
const inputs = {}; for (const [k, v] of Object.entries(overrides)) inputs['in_' + idx(k)] = v;
if (Object.keys(inputs).length) await setInputs({ entity_id: s.id, inputs });
const r = await createStrategyAlert({ symbol, study_name: study, web_hook: 'https://n8n.ai-process.net/webhook/globextraps', resolution: '15', expiration_days: 1 });
if (!r || !r.success) { console.log('create failed', JSON.stringify(r).slice(0, 200)); process.exit(1); }
const id = r.alert_id;
await new Promise((res) => setTimeout(res, 28000));
const st2 = await evaluate(`(function(){var x=new XMLHttpRequest();x.open('GET','https://pricealerts.tradingview.com/list_alerts',false);x.withCredentials=true;x.send();var a=(JSON.parse(x.responseText).r||[]).filter(function(a){return a.alert_id===${id}})[0];return a?{active:a.active,err:a.last_error,stop:a.last_stop_reason}:{missing:true};})()`);
await evaluate(`(function(){var x=new XMLHttpRequest();x.open('POST','https://pricealerts.tradingview.com/delete_alerts',false);x.withCredentials=true;x.setRequestHeader('Content-Type','text/plain;charset=UTF-8');x.send(JSON.stringify({payload:{alert_ids:[${id}]}}));return x.status;})()`);
console.log(JSON.stringify({ study, symbol, overrides, probe_alert: id, ...st2 }));
process.exit(0);
