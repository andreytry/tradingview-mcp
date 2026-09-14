#!/usr/bin/env node
/**
 * Deploy a local .pine file onto its saved TradingView script.
 *
 * Overwriting the WRONG saved script is the expensive mistake here: the Pine editor stays
 * bound to whatever was open last, and a save lands on that script, not the one you meant.
 * So this refuses to write unless the editor reports the script it was asked to open AND
 * the source already in the editor still carries the marker the caller expects. Only then:
 * set source, compile, report errors, save.
 *
 *   node scripts/pine_deploy.mjs "Strategy A - Reversal" pine/strategy_a.pine "STRATEGY A - REVERSAL"
 */
import { readFileSync } from 'node:fs';
import { openScript, getSource, setSource, smartCompile, getErrors, save } from '../src/core/pine.js';

const [name, file, marker] = process.argv.slice(2);
if (!name || !file) {
  console.error('usage: pine_deploy.mjs <saved script name> <file.pine> [expected marker in the CURRENT source]');
  process.exit(2);
}

const opened = await openScript({ name });
if (!opened || opened.success === false) {
  console.error('open failed:', JSON.stringify(opened));
  process.exit(1);
}
console.log(`opened "${opened.name}"  id=${opened.script_id}  lines=${opened.lines}`);
if (opened.name && opened.name !== name) {
  console.error(`REFUSING: asked for "${name}" but the editor opened "${opened.name}"`);
  process.exit(1);
}

const cur = String((await getSource())?.source || '');
if (marker && !cur.includes(marker)) {
  console.error(`REFUSING: the source in the editor does not contain ${JSON.stringify(marker)} - the editor is bound to something else.`);
  console.error('  editor line 2:', (cur.split(/\r?\n/)[1] || '').slice(0, 100));
  process.exit(1);
}
console.log(`binding verified (${cur.length} chars in the editor)`);

const src = readFileSync(new URL('../' + file, import.meta.url), 'utf8');
const set = await setSource({ source: src });
if (!set || set.success === false) {
  console.error('setSource failed:', JSON.stringify(set));
  process.exit(1);
}
console.log(`injected ${src.split('\n').length} lines from ${file}`);

const comp = await smartCompile();
console.log('compile:', JSON.stringify(comp).slice(0, 500));

const errs = await getErrors();
const list = (errs && (errs.errors || errs.messages)) || [];
// TradingView reports advice through the same channel as failures. severity 1-2 is a real
// error; anything higher is a warning (the standing "Pine v5 is outdated" notice is 4) and
// must not block a deploy, or nothing on v5 could ever be saved.
const blocking = (Array.isArray(list) ? list : []).filter((e) => !(e && typeof e === 'object' && Number(e.severity) >= 3));
const advisory = (Array.isArray(list) ? list : []).filter((e) => e && typeof e === 'object' && Number(e.severity) >= 3);
for (const e of advisory) console.log('  warning:', e.message);
if (blocking.length) {
  console.error(`COMPILE ERRORS (${blocking.length}) - NOT saving:`);
  for (const e of blocking.slice(0, 12)) console.error('  -', typeof e === 'string' ? e : JSON.stringify(e));
  process.exit(1);
}
console.log('no blocking compile errors');

const saved = await save();
console.log('save:', JSON.stringify(saved).slice(0, 300));
process.exit(saved && saved.success === false ? 1 : 0);
