// Per-symbol table for a trades JSON produced by nested.mjs / run.mjs.
//   node backtest/stats_by_symbol.mjs /tmp/zones_fx.json
//
// t is the plain one-sample t on R-multiples. It answers "is this distinguishable from
// zero", not "is this good" — a small sample can carry a large avg R and still be noise.
import { readFileSync } from 'node:fs';

const rows = JSON.parse(readFileSync(process.argv[2] ?? '/tmp/zones_fx.json', 'utf8'));
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => Math.sqrt(a.reduce((s, x) => s + (x - mean(a)) ** 2, 0) / (a.length - 1));

const bySym = new Map();
for (const r of rows) (bySym.get(r.sym) ?? bySym.set(r.sym, []).get(r.sym)).push(r.r);

const line = (sym, r) => {
  const g = r.filter((x) => x > 0).reduce((a, b) => a + b, 0);
  const l = -r.filter((x) => x < 0).reduce((a, b) => a + b, 0);
  const t = r.length > 1 ? mean(r) / (sd(r) / Math.sqrt(r.length)) : NaN;
  let eq = 0, pk = 0, dd = 0;
  for (const x of r) { eq += x; pk = Math.max(pk, eq); dd = Math.min(dd, eq - pk); }
  const win = (r.filter((x) => x > 0).length / r.length) * 100;
  console.log(
    `${sym.padEnd(6)} ${String(r.length).padStart(4)} ${win.toFixed(1).padStart(5)}% ` +
    `${(mean(r) >= 0 ? '+' : '') + mean(r).toFixed(3)} ${(l ? g / l : Infinity).toFixed(2).padStart(6)} ` +
    `${t.toFixed(2).padStart(6)} ${dd.toFixed(2).padStart(7)}`);
};

console.log(`${'sym'.padEnd(6)} ${'n'.padStart(4)} ${'win%'.padStart(6)} ${'avgR'.padStart(7)} ${'PF'.padStart(6)} ${'t'.padStart(6)} ${'maxDD'.padStart(7)}`);
for (const [sym, r] of [...bySym].sort((a, b) => mean(b[1]) - mean(a[1]))) line(sym, r);
line('ALL', rows.map((r) => r.r));
