#!/usr/bin/env node
/**
 * Save a local .pine file onto a saved TradingView script BY ID.
 *
 * The Pine editor's save writes to whatever script it was last bound to, and openScript()
 * only injects text - it never rebinds - so a save through the editor can land on the
 * wrong script. pine-facade's save endpoint takes the script id explicitly, so this posts
 * straight to it from the page context (the app's own session, nothing leaves the app)
 * and never touches the editor. The server compiles on save and reports errors back.
 *
 *   node scripts/pine_push_by_id.mjs "USER;42044e..." pine/strategy_a.pine "SupplyDemandTrendReversal"
 */
import { readFileSync } from 'node:fs';
import { evaluateAsync } from '../src/connection.js';

const [id, file, name] = process.argv.slice(2);
if (!id || !file || !name) { console.error('usage: pine_push_by_id.mjs <scriptIdPart> <file.pine> <script name>'); process.exit(2); }
const src = readFileSync(new URL('../' + file, import.meta.url), 'utf8');
const url = `https://pine-facade.tradingview.com/pine-facade/save/next/${encodeURIComponent(id)}?allow_create_new=false&name=${encodeURIComponent(name)}`;

const r = await evaluateAsync(`(async function(){
  var fd = new FormData(); fd.append('source', ${JSON.stringify(src)});
  var res = await fetch(${JSON.stringify(url)}, { method: 'POST', credentials: 'include', body: fd });
  var t = await res.text(); var j = null; try { j = JSON.parse(t); } catch (e) {}
  return { status: res.status, success: j && j.success, error: j && (j.error || j.reason || (j.result && j.result.error)) || null,
           hasIL: !!(j && j.result && j.result.IL), raw: t.slice(0, 300) };
})()`);
console.log(JSON.stringify({ id, name, lines: src.split('\n').length, ...r }, null, 1));
process.exit(r && r.status === 200 && r.success ? 0 : 1);
