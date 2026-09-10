// Full per-ticker breakdown for a trades file.
//   node backtest/detail_by_symbol.mjs /tmp/z5.json "ZONES"
import { readFileSync } from 'node:fs';

const rows = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const title = process.argv[3] ?? '';
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => Math.sqrt(a.reduce((s, x) => s + (x - mean(a)) ** 2, 0) / (a.length - 1));
const med = (a) => { const b = [...a].sort((x, y) => x - y); const h = b.length >> 1;
  return b.length % 2 ? b[h] : (b[h - 1] + b[h]) / 2; };

// Longest run of consecutive losses — the streak that actually breaks people, and the
// thing avg R and PF are both blind to.
const maxLossStreak = (a) => { let cur = 0, best = 0;
  for (const x of a) { cur = x < 0 ? cur + 1 : 0; best = Math.max(best, cur); } return best; };
const maxDD = (a) => { let eq = 0, pk = 0, dd = 0;
  for (const x of a) { eq += x; pk = Math.max(pk, eq); dd = Math.min(dd, eq - pk); } return dd; };

const syms = [...new Set(rows.map((r) => r.sym))];
const months = 5.93;  // 6 Mar -> 4 Sep

console.log(`\n${'='.repeat(78)}\n${title}   ${rows.length} trades\n${'='.repeat(78)}`);
const table = [];
for (const sym of syms) {
  const t = rows.filter((r) => r.sym === sym).sort((a, b) => a.entryTime - b.entryTime);
  const r = t.map((x) => x.r);
  const wins = r.filter((x) => x > 0), losses = r.filter((x) => x <= 0);
  const g = wins.reduce((a, b) => a + b, 0), l = -losses.reduce((a, b) => a + b, 0);
  const longs = t.filter((x) => x.dir === 'LONG'), shorts = t.filter((x) => x.dir === 'SHORT');
  const holds = t.filter((x) => x.exitT).map((x) => (x.exitT - x.entryTime) / 60);
  const byRes = {};
  for (const x of t) byRes[x.res] = (byRes[x.res] ?? 0) + 1;
  table.push({
    sym, n: r.length, w: wins.length, lo: losses.length,
    winPct: (wins.length / r.length) * 100,
    avgR: mean(r), medR: med(r),
    avgWin: wins.length ? mean(wins) : 0, avgLoss: losses.length ? mean(losses) : 0,
    pf: l ? g / l : Infinity, totR: r.reduce((a, b) => a + b, 0),
    t: r.length > 1 ? mean(r) / (sd(r) / Math.sqrt(r.length)) : NaN,
    sdR: r.length > 1 ? sd(r) : NaN,
    dd: maxDD(r), streak: maxLossStreak(r),
    best: Math.max(...r), worst: Math.min(...r),
    perMonth: r.length / months,
    longN: longs.length, longAvg: longs.length ? mean(longs.map((x) => x.r)) : NaN,
    shortN: shorts.length, shortAvg: shorts.length ? mean(shorts.map((x) => x.r)) : NaN,
    hold: holds.length ? med(holds) : NaN,
    res: byRes,
  });
}
table.sort((a, b) => b.avgR - a.avgR);

const f = (x, d = 2, w = 7) => (Number.isFinite(x) ? (x >= 0 && d > 0 ? '+' : '') + x.toFixed(d) : '-').padStart(w);
console.log(`\n${'sym'.padEnd(5)}${'n'.padStart(4)}${'W'.padStart(4)}${'L'.padStart(4)}${'win%'.padStart(7)}${'avgR'.padStart(8)}${'medR'.padStart(7)}${'avgWin'.padStart(8)}${'avgLoss'.padStart(8)}${'PF'.padStart(7)}${'totR'.padStart(8)}${'t'.padStart(7)}${'sd'.padStart(6)}`);
for (const x of table)
  console.log(`${x.sym.padEnd(5)}${String(x.n).padStart(4)}${String(x.w).padStart(4)}${String(x.lo).padStart(4)}${x.winPct.toFixed(1).padStart(6)}%${f(x.avgR, 3, 8)}${f(x.medR, 3, 7)}${f(x.avgWin, 2, 8)}${f(x.avgLoss, 2, 8)}${x.pf.toFixed(2).padStart(7)}${f(x.totR, 1, 8)}${f(x.t, 2, 7)}${x.sdR.toFixed(2).padStart(6)}`);

console.log(`\n${'sym'.padEnd(5)}${'maxDD'.padStart(8)}${'lossStk'.padStart(8)}${'best'.padStart(7)}${'worst'.padStart(7)}${'trades/mo'.padStart(10)}${'medHold'.padStart(9)}${'  long (avgR)'.padEnd(16)}${'short (avgR)'}`);
for (const x of table)
  console.log(`${x.sym.padEnd(5)}${f(x.dd, 2, 8)}${String(x.streak).padStart(8)}${f(x.best, 2, 7)}${f(x.worst, 2, 7)}${x.perMonth.toFixed(1).padStart(10)}${(Number.isFinite(x.hold) ? x.hold.toFixed(0) + 'm' : '-').padStart(9)}  ${(x.longN + ' (' + (Number.isFinite(x.longAvg) ? x.longAvg.toFixed(2) : '-') + ')').padEnd(14)}${x.shortN} (${Number.isFinite(x.shortAvg) ? x.shortAvg.toFixed(2) : '-'})`);

console.log(`\n${'sym'.padEnd(5)}  exits`);
for (const x of table)
  console.log(`${x.sym.padEnd(5)}  ${Object.entries(x.res).map(([k, v]) => `${k} ${v}`).join('   ')}`);
