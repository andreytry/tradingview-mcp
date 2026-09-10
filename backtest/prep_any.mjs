// Databento ohlcv-1m CSV -> the {SYM}_1m.json / {SYM}_5m.json pair the engines read.
//
// Prices arrive fixed-point (1e-9). Symbols must have been pulled on the VOLUME roll
// (.v.0), not the calendar roll (.c.0): the calendar series is sparse between rolls and
// silently produced a wrong answer on gold once already.
//
// Usage: node backtest/prep_any.mjs 6B 6J 6N ...
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const D = '/root/tradingview-mcp/backtest-data';
const syms = process.argv.slice(2);
if (!syms.length) { console.error('usage: node backtest/prep_any.mjs SYM [SYM...]'); process.exit(1); }

for (const sym of syms) {
  const raw = `${D}/raw/${sym}_1m.csv`;
  if (!existsSync(raw)) { console.error(`${sym}: missing ${raw}`); continue; }
  const lines = readFileSync(raw, 'utf8').trim().split('\n');
  const h = lines[0].split(',');
  const ix = (n) => h.indexOf(n);
  const [iT, iO, iH, iL, iC, iV, iI] =
    ['ts_event', 'open', 'high', 'low', 'close', 'volume', 'instrument_id'].map(ix);

  const m1 = []; const instruments = new Map();
  for (let k = 1; k < lines.length; k++) {
    const p = lines[k].split(',');
    const t = Math.round(Number(p[iT]) / 1e9);
    const o = Number(p[iO]) / 1e9, hi = Number(p[iH]) / 1e9,
          lo = Number(p[iL]) / 1e9, c = Number(p[iC]) / 1e9, v = Number(p[iV]) || 0;
    if (!Number.isFinite(t) || !Number.isFinite(o) || !Number.isFinite(c)) continue;
    m1.push({ t, o, h: hi, l: lo, c, v });
    if (!instruments.has(p[iI])) instruments.set(p[iI], t);
  }
  m1.sort((a, b) => a.t - b.t);

  const m5 = []; let cur = null;
  for (const b of m1) {
    const k = Math.floor(b.t / 300) * 300;
    if (!cur || cur.time !== k) { if (cur) m5.push(cur); cur = { time: k, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v }; }
    else { cur.high = Math.max(cur.high, b.h); cur.low = Math.min(cur.low, b.l); cur.close = b.c; cur.volume += b.v; }
  }
  if (cur) m5.push(cur);

  writeFileSync(`${D}/${sym}_5m.json`, JSON.stringify(m5.map((b, i) => ({ i, ...b }))));
  writeFileSync(`${D}/${sym}_1m.json`, JSON.stringify(m1.map((b) => [b.t, b.o, b.h, b.l, b.c])));

  // A complete 6-month pull is ~175k 1m bars over ~157 days. Far below that means the
  // series has gaps and any statistic computed from it is not trustworthy.
  const days = new Set(m1.map((b) => Math.floor(b.t / 86400))).size;
  const perDay = Math.round(m1.length / days);
  const warn = perDay < 900 ? '  <-- SPARSE, do not trust' : '';
  console.log(`${sym}: ${m1.length} 1m -> ${m5.length} 5m | ${days} days, ${perDay}/day | rolls ${instruments.size}${warn}`);
}
